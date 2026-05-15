#!/usr/bin/env tsx
// ============================================================================
// inventory-snapshot.ts
// Pulls a current FBA inventory snapshot via SP-API getInventorySummaries
// and upserts into brain.fba_inventory_snapshot.
//
// Usage:
//   npm run inventory-snapshot
// ============================================================================

import { loadEnvForAmazon, getMarketplaceIds } from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { snapshotFbaInventory } from '../lib/sp-api/inventory.js';

async function main(): Promise<void> {
  const env = loadEnvForAmazon();
  const marketplaceIds = getMarketplaceIds(env);

  console.log('operator-datacore — FBA inventory snapshot');
  console.log('-------------------------------------------');
  console.log(`  Region:        ${env.SP_API_REGION}`);
  console.log(`  Marketplaces:  ${marketplaceIds.join(', ')}`);
  console.log('');

  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });
  const pg = await getPgClient();

  try {
    // 1. Ensure a connection row exists
    const { rows: connRows } = await pg.query<{ connection_id: string }>(
      `INSERT INTO meta.connection (source, label, region, marketplace_ids, status)
       VALUES ('amazon_sp_api', $1, $2, $3, 'active')
       ON CONFLICT (source, label) DO UPDATE
         SET region = EXCLUDED.region, marketplace_ids = EXCLUDED.marketplace_ids,
             last_health_check_at = NOW(), last_health_check_ok = TRUE,
             updated_at = NOW()
       RETURNING connection_id`,
      [`amazon-${env.SP_API_REGION}`, env.SP_API_REGION, marketplaceIds],
    );
    const connectionId = connRows[0]!.connection_id;

    // 2. Open a sync run (mode='incremental' — meta.sync_run check constraint
    // accepts backfill | incremental | manual | verification; a daily inventory
    // snapshot is conceptually one increment of inventory state over time)
    const { rows: runRows } = await pg.query<{ sync_run_id: string }>(
      `INSERT INTO meta.sync_run (connection_id, source, object, mode, window_start, window_end)
       VALUES ($1, 'amazon_sp_api', 'fba_inventory_snapshot', 'incremental', NOW(), NOW())
       RETURNING sync_run_id`,
      [connectionId],
    );
    const syncRunId = runRows[0]!.sync_run_id;

    // 3. Run the snapshot per marketplace
    const startedAt = Date.now();
    let totalRows = 0;

    for (const marketplaceId of marketplaceIds) {
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
    console.log('Next: /sku-audit will now produce a real days-on-hand score; /restock-memo becomes usable.');
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
