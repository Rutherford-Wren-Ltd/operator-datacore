#!/usr/bin/env tsx
// ============================================================================
// ingest-orders.ts
// Pulls the Orders Report (BY_LAST_UPDATE_GENERAL) into brain.orders +
// brain.order_items. Order-level analysis (AOV, fulfillment mix, ship-to
// country, cancellation rate, Prime / B2B split). NOT a revenue source —
// canonical revenue stays in brain.sales_traffic_daily.
//
// Usage:
//   npm run ingest-orders                                    # yesterday's updates, primary region
//   npm run ingest-orders -- --days 7                        # last 7 days of updates
//   npm run ingest-orders -- --from 2025-01-01 --to 2025-12-31  # historical window
//   npm run ingest-orders -- --region na --marketplaces US
//   npm run ingest-orders -- --skip-existing                 # idempotent re-runs
//   npm run ingest-orders -- --dry-run                       # banner only, no API
//
// Why BY_LAST_UPDATE_GENERAL (vs BY_ORDER_DATE_GENERAL):
//   This variant returns any order *updated* in the window, so status flips
//   (Pending → Shipped → Cancelled, refunds, returns) land naturally. The
//   BY_ORDER_DATE variant is the right choice only for cohort analysis
//   (orders placed in a window) — daily sync wants update-based.
//
// Chunking: large windows are split into <=30-day chunks per marketplace to
// keep the report small and the Reports API quota happy. Defaults below.
// ============================================================================

import { parseArgs } from 'node:util';
import { loadEnvForAmazonShared, getSpApiRegionConfig, type SpApiRegion } from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { ingestOrdersWindow } from '../lib/sp-api/orders.js';
import { resolveMarketplaceFilter } from '../lib/marketplaces.js';
import { withSyncRun } from '../lib/sync-run.js';

const CHUNK_DAYS_DEFAULT = 30;

interface ParsedArgs {
  from: Date | null;
  to: Date | null;
  days: number | null;
  region: SpApiRegion | null;
  marketplaceFilter: string[] | null;
  chunkDays: number;
  skipExisting: boolean;
  dryRun: boolean;
}

function parseCliArgs(): ParsedArgs {
  const { values } = parseArgs({
    options: {
      from:           { type: 'string' },
      to:             { type: 'string' },
      days:           { type: 'string' },
      region:         { type: 'string' },
      marketplaces:   { type: 'string' },
      'chunk-days':   { type: 'string', default: String(CHUNK_DAYS_DEFAULT) },
      'skip-existing': { type: 'boolean', default: false },
      'dry-run':      { type: 'boolean', default: false },
    },
  });

  const from = values.from ? new Date(values.from + 'T00:00:00Z') : null;
  const to   = values.to   ? new Date(values.to   + 'T23:59:59Z') : null;
  if ((from && !to) || (!from && to)) {
    throw new Error('--from and --to must be used together.');
  }
  const days = values.days ? parseInt(values.days, 10) : null;
  if (days !== null && (!Number.isFinite(days) || days < 1)) {
    throw new Error('--days must be a positive integer.');
  }
  if (from && days !== null) {
    throw new Error('Use either --from/--to OR --days, not both.');
  }

  let region: SpApiRegion | null = null;
  if (values.region !== undefined) {
    if (values.region !== 'na' && values.region !== 'eu' && values.region !== 'fe') {
      throw new Error(`--region must be one of: na, eu, fe. Got "${values.region}".`);
    }
    region = values.region;
  }

  const chunkDays = parseInt(values['chunk-days']!, 10);
  if (!Number.isFinite(chunkDays) || chunkDays < 1 || chunkDays > 60) {
    throw new Error('--chunk-days must be 1-60.');
  }

  return {
    from,
    to,
    days,
    region,
    marketplaceFilter: resolveMarketplaceFilter(values.marketplaces),
    chunkDays,
    skipExisting: values['skip-existing'] ?? false,
    dryRun: values['dry-run'] ?? false,
  };
}

function defaultTrailingWindow(days: number): { from: Date; to: Date } {
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 23, 59, 59));
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  from.setUTCHours(0, 0, 0, 0);
  return { from, to };
}

function listChunks(from: Date, to: Date, chunkDays: number): Array<{ start: Date; end: Date }> {
  const chunks: Array<{ start: Date; end: Date }> = [];
  let cursor = new Date(from);
  while (cursor <= to) {
    const endProvisional = new Date(cursor.getTime() + (chunkDays * 86_400_000) - 1);
    const end = endProvisional > to ? to : endProvisional;
    chunks.push({ start: new Date(cursor), end: new Date(end) });
    cursor = new Date(end.getTime() + 1);
  }
  return chunks;
}

async function loadCompletedChunks(
  pg: import('pg').Client,
  marketplaceIds: string[],
  chunks: Array<{ start: Date; end: Date }>,
): Promise<Set<string>> {
  // A (marketplace, chunk) is "done" if raw.sp_api_report has a row covering
  // exactly that window. Cheap, deterministic; doesn't peek at row counts.
  const { rows } = await pg.query<{ marketplace_id: string; data_start_time: string; data_end_time: string }>(
    `SELECT DISTINCT
            UNNEST(marketplace_ids)           AS marketplace_id,
            to_char(data_start_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS data_start_time,
            to_char(data_end_time,   'YYYY-MM-DD"T"HH24:MI:SS') AS data_end_time
       FROM raw.sp_api_report
      WHERE report_type = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL'
        AND processing_status = 'DONE'`,
    [],
  );
  const done = new Set<string>();
  for (const r of rows) {
    if (!marketplaceIds.includes(r.marketplace_id)) continue;
    for (const c of chunks) {
      const startMatch = c.start.toISOString().slice(0, 19) === r.data_start_time;
      const endMatch   = c.end.toISOString().slice(0, 19)   === r.data_end_time;
      if (startMatch && endMatch) {
        done.add(`${r.marketplace_id}|${c.start.toISOString().slice(0, 10)}|${c.end.toISOString().slice(0, 10)}`);
      }
    }
  }
  return done;
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  const env = loadEnvForAmazonShared();
  const region: SpApiRegion = args.region ?? env.SP_API_REGION;
  const regionConfig = getSpApiRegionConfig(region, env);
  let marketplaceIds = regionConfig.marketplaceIds;

  if (args.marketplaceFilter) {
    const outOfRegion = args.marketplaceFilter.filter((id) => !marketplaceIds.includes(id));
    if (outOfRegion.length > 0) {
      throw new Error(
        `--marketplaces requested ${outOfRegion.join(', ')} which are not configured for region ` +
        `'${region}'. Region ${region} has: ${marketplaceIds.join(', ')}.`,
      );
    }
    marketplaceIds = args.marketplaceFilter;
  }

  // Window resolution
  let fromDate: Date;
  let toDate: Date;
  if (args.from && args.to) {
    fromDate = args.from;
    toDate = args.to;
  } else {
    const w = defaultTrailingWindow(args.days ?? 1);
    fromDate = w.from;
    toDate = w.to;
  }

  const chunks = listChunks(fromDate, toDate, args.chunkDays);

  console.log('operator-datacore — Amazon Orders ingest');
  console.log('-----------------------------------------');
  console.log(`  Region:        ${regionConfig.region}`);
  console.log(`  Marketplaces:  ${marketplaceIds.join(', ')}`);
  console.log(`  Window:        ${fromDate.toISOString().slice(0, 10)} → ${toDate.toISOString().slice(0, 10)}`);
  console.log(`  Chunks:        ${chunks.length} × <=${args.chunkDays} days`);
  console.log(`  Skip existing: ${args.skipExisting}`);
  console.log(`  Dry run:       ${args.dryRun}`);
  console.log('');

  if (args.dryRun) {
    console.log('--dry-run set — banner only, no API calls fired.');
    return;
  }

  const spClient = new SpApiClient({
    region: regionConfig.region,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: regionConfig.refreshToken,
  });

  let pg = await getPgClient();
  try {
    const { rows: connRows } = await pg.query<{ connection_id: string }>(
      `INSERT INTO meta.connection (source, label, region, marketplace_ids, status)
       VALUES ('amazon_sp_api', $1, $2, $3, 'active')
       ON CONFLICT (source, label) DO UPDATE
         SET region = EXCLUDED.region, marketplace_ids = EXCLUDED.marketplace_ids,
             last_health_check_at = NOW(), last_health_check_ok = TRUE,
             updated_at = NOW()
       RETURNING connection_id`,
      [`amazon-${regionConfig.region}`, regionConfig.region, marketplaceIds],
    );
    const connectionId = connRows[0]!.connection_id;

    // withSyncRun (PR #102) finalises the sync_run row on both success AND
    // failure paths. The setStatus('partial') call below handles the existing
    // per-chunk failure-tolerant semantics: chunks fail individually, the
    // run completes, status reflects whether any failed.
    await withSyncRun(pg, {
      connectionId,
      source: 'amazon_sp_api',
      object: 'orders_report',
      mode: 'backfill',
      windowStart: fromDate,
      windowEnd: toDate,
    }, async (run) => {
      const completed = args.skipExisting
        ? await loadCompletedChunks(pg, marketplaceIds, chunks)
        : new Set<string>();
      if (args.skipExisting) {
        console.log(`  Skip set:      ${completed.size} (marketplace, chunk) pair(s) already in lake`);
        console.log('');
      }

      const startedAt = Date.now();
      let totalOrders = 0;
      let totalItems = 0;
      let totalSkipped = 0;
      let chunksRun = 0;
      let chunksSkipped = 0;
      const failures: Array<{ marketplace: string; chunk: string; error: string }> = [];

      for (const mp of marketplaceIds) {
        for (const c of chunks) {
          const key = `${mp}|${c.start.toISOString().slice(0, 10)}|${c.end.toISOString().slice(0, 10)}`;
          if (completed.has(key)) {
            chunksSkipped += 1;
            continue;
          }
          const label = `${mp} ${c.start.toISOString().slice(0, 10)} → ${c.end.toISOString().slice(0, 10)}`;
          try {
            const r = await ingestOrdersWindow({
              spClient, pg,
              connectionId, syncRunId: run.syncRunId,
              marketplaceId: mp,
              fromDate: c.start,
              toDate: c.end,
            });
            totalOrders += r.ordersUpserted;
            totalItems += r.itemsUpserted;
            totalSkipped += r.rowsSkipped;
            chunksRun += 1;
            console.log(`  [${chunksRun}/${chunks.length * marketplaceIds.length - chunksSkipped}] ${label} → ${r.ordersUpserted} order(s), ${r.itemsUpserted} item(s)${r.rowsSkipped ? `, ${r.rowsSkipped} row(s) skipped (no SKU/ASIN)` : ''}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message.split('\n')[0]! : String(err);
            console.error(`  [FAIL] ${label}: ${msg}`);
            failures.push({ marketplace: mp, chunk: `${c.start.toISOString().slice(0, 10)}→${c.end.toISOString().slice(0, 10)}`, error: msg });
          }
        }
      }

      run.setRowsFetched(totalOrders + totalItems);
      run.setRowsUpserted(totalOrders + totalItems);
      if (failures.length > 0) run.setStatus('partial');

      const durationMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
      console.log('');
      console.log(
        `Done in ${durationMin} min. ${chunksRun} chunk(s) run, ${chunksSkipped} skipped, ` +
        `${failures.length} failed. ${totalOrders} order(s), ${totalItems} item(s) upserted` +
        (totalSkipped ? `, ${totalSkipped} row(s) skipped (no SKU/ASIN).` : '.'),
      );

      if (failures.length > 0) {
        console.error('');
        console.error(`${failures.length} chunk(s) failed:`);
        for (const f of failures) {
          console.error(`  ${f.marketplace} ${f.chunk}: ${f.error}`);
        }
        process.exitCode = 1;
      }
    });
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
