#!/usr/bin/env tsx
// ============================================================================
// forecast.ts
// Refresh the data-lake-driven demand forecast (Phase 11 v1).
//
// Wraps the SQL function brain.refresh_demand_forecast_modeled() with a
// human-friendly summary and timing. The function itself is idempotent
// within a calendar day; the pg_cron job 'operator-datacore-forecast-refresh'
// runs nightly at 02:30 UTC, so this CLI is for on-demand refreshes (after a
// large historical backfill lands, or to test changes).
//
// Usage:
//   npm run forecast                            # default horizon (12 months)
//   npm run forecast -- --horizon 6             # 6 months out
//   npm run forecast -- --dry-run               # prints diff vs current, rolls back
//
// What lands: rows in brain.demand_forecast with source='data_lake_v1' and
// is_current=TRUE. analytics.demand_forecast_current — the view /restock-memo
// and generate-pos read — picks the model over the manual spreadsheet
// transparently. No consumer code changes.
// ============================================================================

import { parseArgs } from 'node:util';
import { getPgClient } from '../lib/supabase.js';

interface RefreshRow {
  rows_inserted: number;
  distinct_skus: number;
  snapshot_date: string;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      horizon:   { type: 'string', default: '12' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const horizon = parseInt(values.horizon!, 10);
  if (!Number.isFinite(horizon) || horizon < 1 || horizon > 24) {
    throw new Error('--horizon must be 1-24.');
  }
  const dryRun = values['dry-run'] ?? false;

  console.log('operator-datacore — demand-forecast refresh (data_lake_v1)');
  console.log('---------------------------------------------------------');
  console.log(`  Horizon:  ${horizon} months`);
  console.log(`  Dry run:  ${dryRun}`);
  console.log('');

  const pg = await getPgClient();
  try {
    const startedAt = Date.now();

    // Capture the pre-state for a delta summary.
    const { rows: beforeRows } = await pg.query<{ rows: number; distinct_ean: number }>(
      `SELECT COUNT(*)::int               AS rows,
              COUNT(DISTINCT ean)::int    AS distinct_ean
         FROM brain.demand_forecast
        WHERE source = 'data_lake_v1' AND is_current`,
    );
    const before = beforeRows[0]!;

    if (dryRun) {
      console.log('--dry-run: running refresh inside a transaction and rolling back.');
      console.log('');
      await pg.query('BEGIN');
    }

    const { rows } = await pg.query<RefreshRow>(
      'SELECT * FROM brain.refresh_demand_forecast_modeled($1)',
      [horizon],
    );
    const result = rows[0]!;

    // Post-state.
    const { rows: afterRows } = await pg.query<{ rows: number; distinct_ean: number }>(
      `SELECT COUNT(*)::int               AS rows,
              COUNT(DISTINCT ean)::int    AS distinct_ean
         FROM brain.demand_forecast
        WHERE source = 'data_lake_v1' AND is_current`,
    );
    const after = afterRows[0]!;

    const { rows: marketRows } = await pg.query<{ market: string; rows: number; total_units: string }>(
      `SELECT market, COUNT(*)::int AS rows, COALESCE(SUM(units_forecast), 0)::text AS total_units
         FROM brain.demand_forecast
        WHERE source = 'data_lake_v1' AND is_current
        GROUP BY market ORDER BY market`,
    );

    const { rows: fallbackRows } = await pg.query<{ method: string; rows: number }>(
      `SELECT CASE WHEN source_ref ~ 'last_year=null' THEN 'flat_velocity'
                   ELSE 'last_year_x_trend' END AS method,
              COUNT(*)::int AS rows
         FROM brain.demand_forecast
        WHERE source = 'data_lake_v1' AND is_current
        GROUP BY 1 ORDER BY 2 DESC`,
    );

    if (dryRun) {
      await pg.query('ROLLBACK');
      console.log('Rolled back. No rows changed in the database.');
      console.log('');
    }

    console.log(`Snapshot date: ${result.snapshot_date}`);
    console.log(`Rows inserted/updated: ${result.rows_inserted.toLocaleString()}`);
    console.log(`Distinct SKUs covered: ${result.distinct_skus.toLocaleString()}`);
    console.log(`  before: ${before.rows.toLocaleString()} rows / ${before.distinct_ean.toLocaleString()} SKUs`);
    console.log(`  after:  ${after.rows.toLocaleString()} rows / ${after.distinct_ean.toLocaleString()} SKUs`);
    console.log('');
    console.log('By market:');
    for (const m of marketRows) {
      console.log(`  ${m.market.padEnd(4)} ${String(m.rows).padStart(6)} rows  ${Number(m.total_units).toFixed(0).padStart(10)} units forecast (sum across horizon)`);
    }
    console.log('');
    console.log('By method:');
    for (const m of fallbackRows) {
      console.log(`  ${m.method.padEnd(20)} ${String(m.rows).padStart(6)} rows`);
    }
    console.log('');
    console.log(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
    console.log('');
    console.log('Consumers read this via analytics.demand_forecast_current — the view picks');
    console.log('data_lake_v1 over operator_tool per (ean, market, month) automatically.');
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
