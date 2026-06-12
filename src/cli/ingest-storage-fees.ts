#!/usr/bin/env tsx
// ============================================================================
// ingest-storage-fees.ts
// Pulls the per-FNSKU FBA storage charges report
// (GET_FBA_STORAGE_FEE_CHARGES_DATA) into brain.fba_storage_fees, per region.
//
// This is the per-SKU storage cost the lake was missing. Without it, CM3 is
// overstated for overstocked SKUs (storage only existed as account-level
// ServiceFeeEvent rows with no SKU attribution).
//
// Cadence: MONTHLY. Amazon generates the report for a recent closed month; it
// is not arbitrarily date-rangeable, so there is no deep historical backfill —
// each run pulls the latest available month(s). Run it in the first ~week of
// each month (and a mid-month pass for aged/LTSF).
//
// Usage:
//   npm run ingest-storage-fees                      # all configured regions
//   npm run ingest-storage-fees -- --region eu       # UK/EU only
//   npm run ingest-storage-fees -- --marketplace-id A1F83G8C2ARO7P
//   npm run ingest-storage-fees -- --dry-run         # resolve config, no fetch
// ============================================================================

import { parseArgs } from 'node:util';
import {
  loadEnvForAmazonShared, getSpApiRegionConfig, getConfiguredSpApiRegions,
  type SpApiRegion,
} from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { ingestStorageFees } from '../lib/sp-api/storage-fees.js';

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

  console.log('operator-datacore — FBA Storage Fees ingest');
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
  const asOfMonth = new Date();
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
         VALUES ($1, 'amazon_sp_api', 'fba_storage_fees', 'incremental', $2, NOW())
         RETURNING sync_run_id`,
        [connectionId, new Date(Date.UTC(asOfMonth.getUTCFullYear(), asOfMonth.getUTCMonth() - 1, 1)).toISOString()],
      );
      const syncRunId = runRows[0]!.sync_run_id;

      // Storage report is per-marketplace; iterate the region's marketplaces.
      for (const marketplaceId of marketplaceIds) {
        try {
          const res = await ingestStorageFees({
            spClient, pg, connectionId, syncRunId,
            marketplaceIds: [marketplaceId],
            asOfMonth,
          });
          totalUpserted += res.rowsUpserted;
          console.log(
            `  ${region.toUpperCase()} ${marketplaceId.padEnd(15)} ${res.reportStatus.padEnd(8)} ` +
            `${String(res.rowsUpserted).padStart(5)} rows  months=[${res.monthsSeen.join(', ')}]`,
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
    console.log(`Done. ${totalUpserted} storage-fee row(s) upserted into brain.fba_storage_fees.`);
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
