#!/usr/bin/env tsx
// ============================================================================
// ingest-inventory-age.ts
// Pulls the FBA inventory-age report (GET_FBA_INVENTORY_AGED_DATA) into
// brain.fba_inventory_age, per region. Per-FNSKU physical age buckets plus
// Amazon's estimated storage + aged-inventory surcharge - the lake's only
// physical-age and per-SKU aged-fee source.
//
// Cadence: WEEKLY is plenty (age moves slowly). It is a point-in-time snapshot,
// stamped by snapshot_date.
//
// Usage:
//   npm run ingest-inventory-age                      # all configured regions
//   npm run ingest-inventory-age -- --region na       # US only
//   npm run ingest-inventory-age -- --marketplace-id ATVPDKIKX0DER
//   npm run ingest-inventory-age -- --dry-run         # resolve config, no fetch
// ============================================================================

import { parseArgs } from 'node:util';
import {
  loadEnvForAmazonShared, getSpApiRegionConfig, getConfiguredSpApiRegions,
  type SpApiRegion,
} from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { ingestInventoryAge } from '../lib/sp-api/inventory-age.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      region:           { type: 'string' },
      'marketplace-id': { type: 'string' },
      'dry-run':        { type: 'boolean', default: false },
    },
  });

  const env = loadEnvForAmazonShared();

  let regions: SpApiRegion[];
  if (values.region !== undefined) {
    if (values.region !== 'na' && values.region !== 'eu' && values.region !== 'fe') {
      throw new Error(`--region must be one of: na, eu, fe. Got "${values.region}".`);
    }
    regions = [values.region];
  } else {
    regions = getConfiguredSpApiRegions(env);
  }
  if (regions.length === 0) {
    throw new Error('No SP-API regions configured. Set SP_API_REFRESH_TOKEN (+SP_API_REGION) and/or SP_API_<REGION>_REFRESH_TOKEN.');
  }

  console.log('operator-datacore — FBA Inventory Age ingest');
  console.log('-------------------------------------------');
  console.log(`  Regions:  ${regions.join(', ')}`);
  console.log(`  Dry run:  ${values['dry-run']}`);
  console.log('');

  if (values['dry-run']) {
    for (const region of regions) {
      const rc = getSpApiRegionConfig(region, env);
      const mkts = values['marketplace-id'] ? [values['marketplace-id']] : rc.marketplaceIds;
      console.log(`  would pull ${region.toUpperCase()} marketplaces: ${mkts.join(', ')}`);
    }
    return;
  }

  const pg = await getPgClient();
  const asOf = new Date();
  let totalUpserted = 0;
  try {
    for (const region of regions) {
      const rc = getSpApiRegionConfig(region, env);
      const marketplaceIds = values['marketplace-id'] ? [values['marketplace-id']] : rc.marketplaceIds;

      const spClient = new SpApiClient({
        region: rc.region,
        clientId: env.SP_API_LWA_CLIENT_ID,
        clientSecret: env.SP_API_LWA_CLIENT_SECRET,
        refreshToken: rc.refreshToken,
      });

      const { rows: connRows } = await pg.query<{ connection_id: string }>(
        `INSERT INTO meta.connection (source, label, region, marketplace_ids, status)
         VALUES ('amazon_sp_api', $1, $2, $3, 'active')
         ON CONFLICT (source, label) DO UPDATE
           SET region = EXCLUDED.region, marketplace_ids = EXCLUDED.marketplace_ids,
               last_health_check_at = NOW(), last_health_check_ok = TRUE, updated_at = NOW()
         RETURNING connection_id`,
        [`amazon-${rc.region}`, rc.region, rc.marketplaceIds],
      );
      const connectionId = connRows[0]!.connection_id;

      const { rows: runRows } = await pg.query<{ sync_run_id: string }>(
        `INSERT INTO meta.sync_run (connection_id, source, object, mode, window_start, window_end)
         VALUES ($1, 'amazon_sp_api', 'fba_inventory_age', 'incremental', $2, NOW())
         RETURNING sync_run_id`,
        [connectionId, asOf.toISOString()],
      );
      const syncRunId = runRows[0]!.sync_run_id;

      // Inventory-age report is per-marketplace; iterate the region's marketplaces.
      for (const marketplaceId of marketplaceIds) {
        try {
          const res = await ingestInventoryAge({
            spClient, pg, connectionId, syncRunId,
            marketplaceIds: [marketplaceId],
            asOf,
          });
          totalUpserted += res.rowsUpserted;
          console.log(
            `  ${region.toUpperCase()} ${marketplaceId.padEnd(15)} ${res.reportStatus.padEnd(8)} ` +
            `${String(res.rowsUpserted).padStart(5)} rows  snapshots=[${res.snapshotsSeen.join(', ')}]`,
          );
        } catch (err) {
          console.error(`  ${region.toUpperCase()} ${marketplaceId}: ${err instanceof Error ? err.message : String(err)}`);
          await pg.query(
            `UPDATE meta.sync_run SET finished_at = NOW(), status = 'failed', error_message = $2 WHERE sync_run_id = $1`,
            [syncRunId, err instanceof Error ? err.message : String(err)],
          );
          throw err;
        }
      }

      await pg.query(
        `UPDATE meta.sync_run SET finished_at = NOW(), status = 'success', rows_upserted = $2 WHERE sync_run_id = $1`,
        [syncRunId, totalUpserted],
      );
    }
    console.log('');
    console.log(`Done. ${totalUpserted} inventory-age row(s) upserted into brain.fba_inventory_age.`);
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
