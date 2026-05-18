#!/usr/bin/env tsx
// ============================================================================
// inventory-snapshot.ts
// Pulls a current FBA inventory snapshot via SP-API getInventorySummaries
// and upserts into brain.fba_inventory_snapshot.
//
// Usage:
//   npm run inventory-snapshot                # primary region from .env
//   npm run inventory-snapshot -- --region na # explicit region override
// ============================================================================

import { parseArgs } from 'node:util';
import { loadEnvForAmazonShared, getSpApiRegionConfig, type SpApiRegion } from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { snapshotFbaInventory } from '../lib/sp-api/inventory.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      region: { type: 'string' },
    },
  });

  const env = loadEnvForAmazonShared();
  const region: SpApiRegion = (values.region as SpApiRegion | undefined) ?? env.SP_API_REGION;
  if (region !== 'na' && region !== 'eu' && region !== 'fe') {
    throw new Error(`--region must be one of: na, eu, fe. Got "${region}".`);
  }
  const regionConfig = getSpApiRegionConfig(region, env);

  console.log('operator-datacore — FBA inventory snapshot');
  console.log('-------------------------------------------');
  console.log(`  Region:        ${regionConfig.region}`);
  console.log(`  Marketplaces:  ${regionConfig.marketplaceIds.join(', ')}`);
  console.log('');

  const spClient = new SpApiClient({
    region: regionConfig.region,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: regionConfig.refreshToken,
  });
  const pg = await getPgClient();

  try {
    const { rows: connRows } = await pg.query<{ connection_id: string }>(
      `INSERT INTO meta.connection (source, label, region, marketplace_ids, status)
       VALUES ('amazon_sp_api', $1, $2, $3, 'active')
       ON CONFLICT (source, label) DO UPDATE
         SET region = EXCLUDED.region, marketplace_ids = EXCLUDED.marketplace_ids,
             last_health_check_at = NOW(), last_health_check_ok = TRUE,
             updated_at = NOW()
       RETURNING connection_id`,
      [`amazon-${regionConfig.region}`, regionConfig.region, regionConfig.marketplaceIds],
    );
    const connectionId = connRows[0]!.connection_id;

    // mode='incremental' — meta.sync_run check constraint accepts
    // backfill | incremental | manual | verification.
    const { rows: runRows } = await pg.query<{ sync_run_id: string }>(
      `INSERT INTO meta.sync_run (connection_id, source, object, mode, window_start, window_end)
       VALUES ($1, 'amazon_sp_api', 'fba_inventory_snapshot', 'incremental', NOW(), NOW())
       RETURNING sync_run_id`,
      [connectionId],
    );
    const syncRunId = runRows[0]!.sync_run_id;

    const startedAt = Date.now();
    let totalRows = 0;

    for (const marketplaceId of regionConfig.marketplaceIds) {
      console.log(`Marketplace ${marketplaceId}:`);
      const result = await snapshotFbaInventory({
        spClient,
        pg,
        marketplaceId,
        onPage: (info) => {
          console.log(`  page ${info.page}: ${info.rowsFetched} SKUs (cumulative ${info.cumulativeRows})`);
        },
      });
      totalRows += result.totalRows;
      console.log(`  done: ${result.totalRows} SKUs across ${result.pages} page(s) for snapshot_date ${result.snapshotDate}`);
    }

    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);

    await pg.query(
      `UPDATE meta.sync_run
         SET finished_at = NOW(), status = 'success',
             rows_fetched = $2, rows_upserted = $2
       WHERE sync_run_id = $1`,
      [syncRunId, totalRows],
    );

    console.log('');
    console.log(`Done in ${durationSec}s. ${totalRows} SKU snapshots upserted into brain.fba_inventory_snapshot.`);
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
