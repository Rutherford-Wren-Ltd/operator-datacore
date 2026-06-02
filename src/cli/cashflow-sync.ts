#!/usr/bin/env tsx
// ============================================================================
// cashflow-sync.ts
// Upsert the automated cashflow mirror into brain.cashflow_forecast.
//
// Reads the DB-ready sidecar that scripts/cashflow/generate.py emits
// (--out-json), which holds one object per (week, currency) with cash_in,
// cash_out and net. Writes three rows per (week, currency), one per
// forecast_type, into brain.cashflow_forecast.
//
// This is the "write to DB" half of the automated cashflow: the GitHub Actions
// CI builds the mirror + sidecar (no secrets), then n8n runs THIS against the
// committed sidecar (n8n owns SUPABASE_DB_URL). The financial-controller skill
// reads brain.cashflow_forecast; it never rebuilds the forecast.
//
// Idempotent: ON CONFLICT (week_start, forecast_type, currency_code) updates
// the forecast in place. actual_amount is left untouched (actuals are closed
// separately); variance is refreshed only where an actual already exists.
//
// Usage:
//   npm run cashflow-sync -- --in cashflow-inputs/cashflow-forecast.json
// ============================================================================

import { readFileSync } from 'node:fs';
import { getPgClient } from '../lib/supabase.js';

interface WeekRow {
  week_start: string;
  week_end: string;
  currency: string;
  cash_in: number;
  cash_out: number;
  net: number;
  running_balance: number;
  extended: boolean;
}

interface Payload {
  generated: string;
  window: { start: string; end: string };
  openings: Record<string, number>;
  weeks: WeekRow[];
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const UPSERT = `
  INSERT INTO brain.cashflow_forecast
    (week_start, week_end, forecast_type, forecast_amount, currency_code, notes, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, now())
  ON CONFLICT (week_start, forecast_type, currency_code)
  DO UPDATE SET
    week_end        = EXCLUDED.week_end,
    forecast_amount = EXCLUDED.forecast_amount,
    notes           = EXCLUDED.notes,
    -- keep variance consistent if this week has already been closed with an actual
    variance        = CASE
                        WHEN brain.cashflow_forecast.actual_amount IS NOT NULL
                        THEN brain.cashflow_forecast.actual_amount - EXCLUDED.forecast_amount
                        ELSE brain.cashflow_forecast.variance
                      END,
    updated_at      = now()
`;

async function main(): Promise<void> {
  const inPath = arg('in', 'cashflow-inputs/cashflow-forecast.json')!;
  const payload = JSON.parse(readFileSync(inPath, 'utf8')) as Payload;

  if (!Array.isArray(payload.weeks) || payload.weeks.length === 0) {
    throw new Error(`${inPath}: no weeks in payload, refusing to write an empty forecast`);
  }

  const pg = await getPgClient();
  let rows = 0;
  try {
    await pg.query('BEGIN');
    for (const w of payload.weeks) {
      const note = w.extended
        ? 'auto-mirror; extended week (revenue placeholder, rev TBD)'
        : 'auto-mirror';
      const series: Array<[string, number]> = [
        ['cash_in', w.cash_in],
        ['cash_out', w.cash_out],
        ['net', w.net],
      ];
      for (const [forecastType, amount] of series) {
        await pg.query(UPSERT, [
          w.week_start,
          w.week_end,
          forecastType,
          amount,
          w.currency,
          note,
        ]);
        rows++;
      }
    }
    await pg.query('COMMIT');
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await pg.end();
  }

  console.log(
    `cashflow-sync: upserted ${rows} rows ` +
      `(${payload.weeks.length} week-ccy x 3 types) from ${inPath} ` +
      `[mirror generated ${payload.generated}, window ${payload.window.start}..${payload.window.end}]`,
  );
}

main().catch((err) => {
  console.error('cashflow-sync failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
