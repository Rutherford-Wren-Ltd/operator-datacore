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
//   npm run backfill-search-query -- --period-type MONTH --from 2025-01-01 --to 2026-04-30 --skip-existing
//   npm run backfill-search-query -- --period-type MONTH --months 1 --asins B0CX9FCC59
//   npm run backfill-search-query -- --period-type MONTH --months 12 --top-n 50
//   npm run backfill-search-query -- --period-type MONTH --months 17 --brands Wrenbury,Hemswell
//
// ASIN scope (Amazon now requires `asin` per call — confirmed 2026-05-30):
//   --asins B0X,B0Y,...   explicit list (overrides everything below)
//   --top-n N             top N by 30-day units from brain.sales_traffic_daily
//   --brands B1,B2        all active sku_master rows with matching brand
//   (none of the above)   all active sku_master ASINs (default)
//
// Period boundaries are auto-aligned: --from / --to are widened outward to
// the nearest period boundary (WEEK = Sun-Sat, MONTH = calendar, QUARTER =
// calendar Q1-Q4) before requesting from Amazon.
//
// SP-API rate limits: documented 1 req / 45s for SQP createReport. The
// library floor is 60s to leave headroom.
//
// Total call count = periods × marketplaces × ASINs. A 17-month UK backfill
// across 200 ASINs is ~3,400 calls × 60s ≈ 57 hours wall-clock.
// ============================================================================

import { parseArgs } from 'node:util';
import { loadEnvForAmazonShared, getSpApiRegionConfig, type SpApiRegion } from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { checkpoint } from '../lib/checkpoint.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { backfillSqp, listPeriods, type SqpPeriodType } from '../lib/sp-api/search-query.js';
import { resolveMarketplaceFilter } from '../lib/marketplaces.js';

interface ParsedArgs {
  periodType: SqpPeriodType;
  from: Date | null;
  to: Date | null;
  count: number | null;        // --weeks / --months / --quarters
  region: SpApiRegion | null;
  marketplaceFilter: string[] | null;
  asinsFilter: string[] | null;     // explicit --asins B0X,B0Y,...
  brandsFilter: string[] | null;    // --brands Wrenbury,Hemswell — picks active ASINs from sku_master
  topN: number | null;              // --top-n 50 — picks top N ASINs by recent units sold from sales_traffic
  delayMs: number;
  skipExisting: boolean;
  retryFatals: boolean;
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
      asins:         { type: 'string' },                       // explicit list
      brands:        { type: 'string' },                       // pick from sku_master by brand(s)
      'top-n':       { type: 'string' },                       // pick top-N by 30d units
      delay:         { type: 'string', default: '60000' },
      'skip-existing': { type: 'boolean', default: false },
      // --retry-fatals: bypass the meta.report_fatal_marker filter (migration
      // 0046). Default behaviour is to skip (asin, marketplace, period) tuples
      // Amazon previously returned FATAL/CANCELLED for — saves ~60s/call on
      // tuples that are structurally unreachable (pre-launch periods, US
      // monthly reports Amazon hasn't published yet). Pass this flag when you
      // want to re-attempt those tuples (e.g. an ASIN that was previously
      // pre-launch may now have data). Operator can also DELETE specific
      // markers via SQL for finer-grained re-attempts.
      'retry-fatals': { type: 'boolean', default: false },
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

  const asinsFilter = values.asins
    ? values.asins.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const brandsFilter = values.brands
    ? values.brands.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const topN = values['top-n'] ? parseInt(values['top-n'], 10) : null;
  if (topN !== null && (!Number.isFinite(topN) || topN < 1)) {
    throw new Error(`--top-n must be a positive integer.`);
  }

  return {
    periodType,
    from,
    to,
    count,
    region,
    marketplaceFilter: resolveMarketplaceFilter(values.marketplaces),
    asinsFilter,
    brandsFilter,
    topN,
    delayMs: parseInt(values.delay!, 10),
    skipExisting: values['skip-existing'] ?? false,
    retryFatals: values['retry-fatals'] ?? false,
    dryRun: values['dry-run'] ?? false,
  };
}

/**
 * Resolve the list of ASINs to backfill. Three sources, in precedence order:
 *
 *   1. --asins B0X,B0Y,...      (explicit list)
 *   2. --top-n N                 (top-N by 30-day units from brain.sales_traffic_daily, per marketplace)
 *   3. --brands Wrenbury,...    (active ASINs from brain.sku_master with matching brand)
 *
 * If none of the above is set, default to all active ASINs in sku_master.
 */
async function resolveAsins(
  pg: import('pg').Client,
  args: ParsedArgs,
  marketplaceIds: string[],
): Promise<string[]> {
  if (args.asinsFilter) return args.asinsFilter;

  if (args.topN !== null) {
    const { rows } = await pg.query<{ asin: string }>(
      `SELECT child_asin AS asin
         FROM brain.sales_traffic_daily
        WHERE marketplace_id = ANY($1)
          AND metric_date >= CURRENT_DATE - INTERVAL '30 days'
          AND metric_date <  CURRENT_DATE
          AND child_asin IS NOT NULL
        GROUP BY child_asin
        ORDER BY SUM(units_ordered) DESC NULLS LAST
        LIMIT $2`,
      [marketplaceIds, args.topN],
    );
    return rows.map((r) => r.asin);
  }

  // Default + --brands path: from sku_master where status is reorderable.
  const brandsClause = args.brandsFilter
    ? `AND brand = ANY($1)`
    : ``;
  const params = args.brandsFilter ? [args.brandsFilter] : [];
  const { rows } = await pg.query<{ asin: string }>(
    `SELECT DISTINCT asin
       FROM brain.sku_master
      WHERE status IN ('active', 'seasonal', 'new_launch')
        AND asin IS NOT NULL
        ${brandsClause}`,
    params,
  );
  return rows.map((r) => r.asin);
}

async function loadExistingKeys(
  pg: import('pg').Client,
  periodType: SqpPeriodType,
  marketplaceIds: string[],
  asins: string[],
  fromDate: Date,
  toDate: Date,
): Promise<Set<string>> {
  // Query brain.search_query_performance directly — it has marketplace_id +
  // asin in the PK after migration 0023. A (period, marketplace, asin)
  // counts as "done" if any rows exist for it. to_char on the date column
  // dodges the node-pg DATE/timezone shift fix from #48.
  const { rows } = await pg.query<{ marketplace_id: string; asin: string; period_start: string }>(
    `SELECT DISTINCT marketplace_id, asin,
            to_char(period_start, 'YYYY-MM-DD') AS period_start
       FROM brain.search_query_performance
      WHERE period_type = $1
        AND marketplace_id = ANY($2)
        AND asin = ANY($3)
        AND period_start BETWEEN $4 AND $5`,
    [
      periodType,
      marketplaceIds,
      asins,
      fromDate.toISOString().slice(0, 10),
      toDate.toISOString().slice(0, 10),
    ],
  );
  const keys = new Set<string>();
  for (const r of rows) {
    keys.add(`${periodType}|${r.period_start}|${r.marketplace_id}|${r.asin}`);
  }
  return keys;
}

/**
 * Load the set of (period, marketplace, asin) tuples Amazon has previously
 * returned FATAL/CANCELLED for, so the backfill can skip them. Migration 0046
 * created meta.report_fatal_marker; this query is the read side. Operator can
 * bypass via --retry-fatals; this function isn't called in that case.
 */
async function loadFatalMarkers(
  pg: import('pg').Client,
  periodType: SqpPeriodType,
  marketplaceIds: string[],
  asins: string[],
  fromDate: Date,
  toDate: Date,
): Promise<Set<string>> {
  const { rows } = await pg.query<{ marketplace_id: string; asin: string; period_start: string }>(
    `SELECT marketplace_id, asin,
            to_char(period_start, 'YYYY-MM-DD') AS period_start
       FROM meta.report_fatal_marker
      WHERE object = 'search_query_performance_report'
        AND period_type = $1
        AND marketplace_id = ANY($2)
        AND asin = ANY($3)
        AND period_start BETWEEN $4 AND $5`,
    [
      periodType,
      marketplaceIds,
      asins,
      fromDate.toISOString().slice(0, 10),
      toDate.toISOString().slice(0, 10),
    ],
  );
  const keys = new Set<string>();
  for (const r of rows) {
    keys.add(`${periodType}|${r.period_start}|${r.marketplace_id}|${r.asin}`);
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
  checkpoint('main:start');
  const args = parseCliArgs();
  checkpoint('parseCliArgs done');

  const env = loadEnvForAmazonShared();
  checkpoint('env loaded');
  const region: SpApiRegion = args.region ?? env.SP_API_REGION;
  const regionConfig = getSpApiRegionConfig(region, env);
  let marketplaceIds = regionConfig.marketplaceIds;
  checkpoint('region resolved');

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
  checkpoint('period window resolved');

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

  const spClient = new SpApiClient({
    region: regionConfig.region,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: regionConfig.refreshToken,
  });
  checkpoint('SpApiClient constructed');
  checkpoint('before getPgClient');
  let pg = await getPgClient();
  checkpoint('after getPgClient');

  // Resolve the ASIN set (requires pg for sku_master / sales_traffic lookups).
  checkpoint('before resolveAsins');
  const asins = await resolveAsins(pg, args, marketplaceIds);
  checkpoint('after resolveAsins');
  if (asins.length === 0) {
    throw new Error(
      'No ASINs resolved. Specify --asins, --brands, --top-n, or ensure brain.sku_master has active rows.',
    );
  }
  console.log(`  ASIN count:    ${asins.length}` + (
    args.asinsFilter ? ' (--asins explicit list)' :
    args.topN !== null ? ` (--top-n ${args.topN} by 30d units)` :
    args.brandsFilter ? ` (--brands ${args.brandsFilter.join('/')})` :
    ' (all active in brain.sku_master)'
  ));
  if (asins.length <= 20) {
    console.log(`    asins:       ${asins.join(', ')}`);
  } else {
    console.log(`    first 5:     ${asins.slice(0, 5).join(', ')}, ...`);
    console.log(`    last 5:      ${asins.slice(-5).join(', ')}`);
  }
  const totalTasks = periods.length * marketplaceIds.length * asins.length;
  const estDuration = (totalTasks * args.delayMs / 1000 / 60 / 60).toFixed(1);
  console.log(`  Total calls:   ${totalTasks.toLocaleString()} (= ${periods.length} periods × ${marketplaceIds.length} markets × ${asins.length} ASINs)`);
  console.log(`  Est. duration: ~${estDuration} hours wall-clock at ${args.delayMs}ms/call`);
  console.log('');

  if (args.dryRun) {
    console.log('--dry-run set — would request the calls outlined above. No API calls fired.');
    try { await pg.end(); } catch { /* */ }
    return;
  }

  try {
    checkpoint('before meta.connection upsert');
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
    checkpoint('after meta.connection upsert');

    checkpoint('before meta.sync_run insert');
    const { rows: runRows } = await pg.query<{ sync_run_id: string }>(
      `INSERT INTO meta.sync_run (connection_id, source, object, mode, window_start, window_end)
       VALUES ($1, 'amazon_sp_api', 'search_query_performance_report', 'backfill', $2, $3)
       RETURNING sync_run_id`,
      [connectionId, fromDate.toISOString(), toDate.toISOString()],
    );
    const syncRunId = runRows[0]!.sync_run_id;
    checkpoint('after meta.sync_run insert');

    let existingKeys: Set<string> | undefined;
    if (args.skipExisting) {
      existingKeys = await loadExistingKeys(pg, args.periodType, marketplaceIds, asins, fromDate, toDate);
      console.log(`  Skip set:      ${existingKeys.size} (period, marketplace, ASIN) tuple(s) already present`);
    }

    // Load known-FATAL markers (migration 0046) unless --retry-fatals. Merged
    // into the same existingKeys skip set the backfill loop already honours,
    // so the marker set acts like "these tuples returned no data before, save
    // ~60s/call by not asking again". --retry-fatals leaves the markers alone
    // (the search-query side still writes a fresh marker if Amazon FATALs
    // again, with fail_count incremented).
    if (!args.retryFatals) {
      const fatalKeys = await loadFatalMarkers(pg, args.periodType, marketplaceIds, asins, fromDate, toDate);
      if (fatalKeys.size > 0) {
        console.log(`  Fatal markers: ${fatalKeys.size} (period, marketplace, ASIN) tuple(s) previously returned FATAL/CANCELLED — skipping (pass --retry-fatals to recheck)`);
        if (!existingKeys) existingKeys = new Set<string>();
        for (const k of fatalKeys) existingKeys.add(k);
      }
    } else {
      console.log(`  Retry fatals:  --retry-fatals set — known-FATAL tuples will be re-attempted`);
    }
    console.log('');

    checkpoint('before backfillSqp');
    const startedAt = Date.now();
    const result = await backfillSqp({
      spClient,
      pg,
      connectionId,
      syncRunId,
      marketplaceIds,
      asins,
      periodType: args.periodType,
      fromDate,
      toDate,
      delayMs: args.delayMs,
      ...(existingKeys ? { existingKeys } : {}),
      onProgress: (info) => {
        const pct = ((info.done / info.total) * 100).toFixed(1).padStart(5);
        console.log(`  [${pct}%] ${info.periodStart} → ${info.periodEnd} ${info.marketplace.padEnd(15)} ${info.asin} → ${info.rows} rows`);
      },
    });

    const durationMin = ((Date.now() - startedAt) / 60_000).toFixed(1);

    pg = result.pg;
    checkpoint('after backfillSqp');

    await pg.query(
      `UPDATE meta.sync_run
         SET finished_at = NOW(), status = 'success',
             rows_fetched = $2, rows_upserted = $2
       WHERE sync_run_id = $1`,
      [syncRunId, result.totalRows],
    );

    console.log('');
    console.log(
      `Done in ${durationMin} min. ${result.tasksRun} call(s) made, ${result.tasksSkipped} skipped (--skip-existing), ` +
      `${result.tasksNoData} (asin, period) tuple(s) returned no data (FATAL/CANCELLED — logged to meta.sync_log), ` +
      `${result.totalRows} rows upserted across ${marketplaceIds.length} marketplace(s), ${result.periodCount} period(s), ${result.asinCount} ASIN(s).`,
    );
    if (result.tasksFailed > 0) {
      console.warn(
        `  ${result.tasksFailed} task(s) still failed after one retry (usually a transient Amazon report-queue backlog). ` +
        `Re-run the same command with --skip-existing to pick them up.`,
      );
    }
  } finally {
    try { await pg.end(); } catch { /* may already be ended by recent eviction */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
