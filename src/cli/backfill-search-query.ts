#!/usr/bin/env tsx
// ============================================================================
// backfill-search-query.ts
// Pulls Brand Analytics Search Query Performance reports into
// brain.search_query_performance.
//
// SQP retention is much longer than the Ads API (17 months for monthly
// reports) — this is the right source for year-over-year keyword / query
// analysis that the Ads API cannot reach.
//
// Usage:
//   npm run backfill-search-query -- --period-type MONTH --months 17
//   npm run backfill-search-query -- --period-type WEEK --weeks 26
//   npm run backfill-search-query -- --period-type QUARTER --quarters 8
//   npm run backfill-search-query -- --period-type MONTH --from 2025-01-01 --to 2026-04-30 --skip-existing
//   npm run backfill-search-query -- --period-type MONTH --months 17 --region eu --marketplaces UK
//
// Period boundaries are auto-aligned: --from / --to are widened outward to
// the nearest period boundary (WEEK = Sun-Sat, MONTH = calendar, QUARTER =
// calendar Q1-Q4) before requesting from Amazon.
//
// SP-API rate limits: documented 1 req / 45s for SQP createReport. The
// library floor is 60s to leave headroom. --delay can raise it further;
// it cannot go below.
//
// Granularity choice:
//   - WEEK   : Sunday-Saturday weeks. 26-week (6mo) backfill is a good
//              starting window for trailing trend analysis.
//   - MONTH  : Calendar months. 17 months is the documented Amazon ceiling
//              for monthly reports — use this for YoY.
//   - QUARTER: Calendar quarters. Useful for high-level rollups.
// ============================================================================

import { parseArgs } from 'node:util';
import { loadEnvForAmazonShared, getSpApiRegionConfig, type SpApiRegion } from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { backfillSqp, listPeriods, type SqpPeriodType } from '../lib/sp-api/search-query.js';

// Marketplace short codes — shared with sales-traffic backfill.
const MARKETPLACE_ALIASES: Record<string, string> = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  UK: 'A1F83G8C2ARO7P',
  GB: 'A1F83G8C2ARO7P',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  IT: 'APJ6JRA9NG5V4',
  ES: 'A1RKKUPIHCS9HS',
  NL: 'A1805IZSGTT6HS',
  SE: 'A2NODRKZP88ZB9',
  PL: 'A1C3SOZRARQ6R3',
  TR: 'A33AVAJ2PDY3EV',
  JP: 'A1VC38T7YXB528',
};

function resolveMarketplaceFilter(raw: string | undefined): string[] | null {
  if (!raw) return null;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((tok) => {
    const upper = tok.toUpperCase();
    return MARKETPLACE_ALIASES[upper] ?? tok;
  });
}

interface ParsedArgs {
  periodType: SqpPeriodType;
  from: Date | null;
  to: Date | null;
  count: number | null;        // --weeks / --months / --quarters
  region: SpApiRegion | null;
  marketplaceFilter: string[] | null;
  delayMs: number;
  skipExisting: boolean;
  dryRun: boolean;
}

function parseCliArgs(): ParsedArgs {
  const { values } = parseArgs({
    options: {
      'period-type': { type: 'string' },
      from:          { type: 'string' },
      to:            { type: 'string' },
      weeks:         { type: 'string' },
      months:        { type: 'string' },
      quarters:      { type: 'string' },
      region:        { type: 'string' },
      marketplaces:  { type: 'string' },
      delay:         { type: 'string', default: '60000' },
      'skip-existing': { type: 'boolean', default: false },
      'dry-run':     { type: 'boolean', default: false },
    },
  });

  const pt = (values['period-type'] ?? 'MONTH').toUpperCase();
  if (pt !== 'WEEK' && pt !== 'MONTH' && pt !== 'QUARTER') {
    throw new Error(`--period-type must be one of: WEEK, MONTH, QUARTER. Got "${values['period-type']}".`);
  }
  const periodType = pt as SqpPeriodType;

  // Count flags are period-type-specific; pick the one that matches.
  const countFlag =
    periodType === 'WEEK'    ? values.weeks    :
    periodType === 'MONTH'   ? values.months   :
                               values.quarters;
  const count = countFlag ? parseInt(countFlag, 10) : null;
  if (count !== null && (!Number.isFinite(count) || count < 1)) {
    throw new Error(`--weeks / --months / --quarters must be a positive integer.`);
  }

  const from = values.from ? new Date(values.from + 'T00:00:00Z') : null;
  const to = values.to ? new Date(values.to + 'T23:59:59Z') : null;
  if ((from && !to) || (!from && to)) {
    throw new Error('--from and --to must be used together.');
  }
  if (from && count !== null) {
    throw new Error('Use either --from/--to OR --weeks/--months/--quarters, not both.');
  }

  let region: SpApiRegion | null = null;
  if (values.region !== undefined) {
    if (values.region !== 'na' && values.region !== 'eu' && values.region !== 'fe') {
      throw new Error(`--region must be one of: na, eu, fe. Got "${values.region}".`);
    }
    region = values.region;
  }

  return {
    periodType,
    from,
    to,
    count,
    region,
    marketplaceFilter: resolveMarketplaceFilter(values.marketplaces),
    delayMs: parseInt(values.delay!, 10),
    skipExisting: values['skip-existing'] ?? false,
    dryRun: values['dry-run'] ?? false,
  };
}

async function loadExistingKeys(
  pg: import('pg').Client,
  periodType: SqpPeriodType,
  marketplaceIds: string[],
  fromDate: Date,
  toDate: Date,
): Promise<Set<string>> {
  // raw.sp_api_report is where we record one row per Amazon report request.
  // brain.search_query_performance is per (period × asin × query); a period
  // counts as "done" if any rows exist for it in the period bucket. The raw
  // table also covers periods that returned zero rows (a brand with no
  // queries that week — rare but possible).
  //
  // Use raw.sp_api_report keyed by report_type + marketplace + data window.
  // Cast timestamps to text (YYYY-MM-DD) to avoid the node-pg DATE/timezone
  // shift that bit sales-traffic in #48.
  const { rows } = await pg.query<{ marketplace_id: string; period_start: string }>(
    `SELECT DISTINCT
            (marketplace_ids[1])                          AS marketplace_id,
            to_char(data_start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS period_start
       FROM raw.sp_api_report
      WHERE report_type = 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT'
        AND processing_status = 'DONE'
        AND (marketplace_ids[1]) = ANY($1)
        AND data_start_time >= $2::timestamptz
        AND data_start_time <= $3::timestamptz`,
    [marketplaceIds, fromDate.toISOString(), toDate.toISOString()],
  );
  const keys = new Set<string>();
  for (const r of rows) {
    keys.add(`${periodType}|${r.period_start}|${r.marketplace_id}`);
  }
  return keys;
}

function backwardCountWindow(periodType: SqpPeriodType, count: number): { from: Date; to: Date } {
  // End: yesterday (Brand Analytics reports for "today" aren't ready).
  const now = new Date();
  const toDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 23, 59, 59));

  // Start: count periods back from toDate, then let listPeriods() align the
  // window correctly. We over-shoot one period back to be safe — listPeriods
  // will produce the exact set.
  let fromDate: Date;
  if (periodType === 'WEEK') {
    fromDate = new Date(toDate.getTime() - count * 7 * 86_400_000);
  } else if (periodType === 'MONTH') {
    fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - count, 1));
  } else {
    fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - count * 3, 1));
  }
  return { from: fromDate, to: toDate };
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

  // Resolve window
  let fromDate: Date;
  let toDate: Date;
  if (args.from && args.to) {
    fromDate = args.from;
    toDate = args.to;
  } else {
    const count = args.count ?? (args.periodType === 'MONTH' ? 17 : args.periodType === 'WEEK' ? 26 : 8);
    const w = backwardCountWindow(args.periodType, count);
    fromDate = w.from;
    toDate = w.to;
  }

  const periods = listPeriods(args.periodType, fromDate, toDate);

  console.log('operator-datacore — Brand Analytics SQP backfill');
  console.log('-------------------------------------------------');
  console.log(`  Region:        ${regionConfig.region}`);
  console.log(`  Marketplaces:  ${marketplaceIds.join(', ')}`);
  console.log(`  Period type:   ${args.periodType}`);
  console.log(`  Window:        ${fromDate.toISOString().slice(0, 10)} → ${toDate.toISOString().slice(0, 10)}`);
  console.log(`  Periods:       ${periods.length} (aligned to boundary)`);
  console.log(`    first        ${periods[0]?.start.toISOString().slice(0, 10)} → ${periods[0]?.end.toISOString().slice(0, 10)}`);
  console.log(`    last         ${periods[periods.length - 1]?.start.toISOString().slice(0, 10)} → ${periods[periods.length - 1]?.end.toISOString().slice(0, 10)}`);
  console.log(`  Delay:         ${args.delayMs}ms (floor 60000ms)`);
  console.log(`  Skip existing: ${args.skipExisting}`);
  console.log(`  Dry run:       ${args.dryRun}`);
  console.log('');

  if (args.dryRun) {
    console.log('--dry-run set — would request the periods listed above. No API calls fired.');
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

    const { rows: runRows } = await pg.query<{ sync_run_id: string }>(
      `INSERT INTO meta.sync_run (connection_id, source, object, mode, window_start, window_end)
       VALUES ($1, 'amazon_sp_api', 'search_query_performance_report', 'backfill', $2, $3)
       RETURNING sync_run_id`,
      [connectionId, fromDate.toISOString(), toDate.toISOString()],
    );
    const syncRunId = runRows[0]!.sync_run_id;

    let existingKeys: Set<string> | undefined;
    if (args.skipExisting) {
      existingKeys = await loadExistingKeys(pg, args.periodType, marketplaceIds, fromDate, toDate);
      console.log(`  Skip set:      ${existingKeys.size} period(s) already present`);
      console.log('');
    }

    const startedAt = Date.now();
    const result = await backfillSqp({
      spClient,
      pg,
      connectionId,
      syncRunId,
      marketplaceIds,
      periodType: args.periodType,
      fromDate,
      toDate,
      delayMs: args.delayMs,
      ...(existingKeys ? { existingKeys } : {}),
      onProgress: (info) => {
        const pct = ((info.done / info.total) * 100).toFixed(1).padStart(5);
        console.log(`  [${pct}%] ${info.periodStart} → ${info.periodEnd} ${info.marketplace.padEnd(15)} → ${info.rows} rows`);
      },
    });

    const durationMin = ((Date.now() - startedAt) / 60_000).toFixed(1);

    pg = result.pg;

    await pg.query(
      `UPDATE meta.sync_run
         SET finished_at = NOW(), status = 'success',
             rows_fetched = $2, rows_upserted = $2
       WHERE sync_run_id = $1`,
      [syncRunId, result.totalRows],
    );

    console.log('');
    console.log(
      `Done in ${durationMin} min. ${result.tasksRun} call(s) made, ${result.tasksSkipped} skipped, ` +
      `${result.totalRows} rows upserted across ${marketplaceIds.length} marketplace(s) and ${result.periodCount} period(s).`,
    );
  } finally {
    try { await pg.end(); } catch { /* may already be ended by recent eviction */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
