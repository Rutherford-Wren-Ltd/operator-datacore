#!/usr/bin/env tsx
// ============================================================================
// sync-fx-rates.ts
// Populate meta.fx_rates with daily rates from each non-reporting currency to
// REPORTING_CURRENCY, so multi-currency analytics views (notably
// analytics.product_profitability_30d._rc / cm3_rc) can roll cross-brand
// figures into one currency.
//
// Why this exists: meta.fx_rates ships seeded ONLY with USD->USD=1.0. A UK
// (GBP) + US (USD) operator has no GBP->USD rate, so any reporting-currency
// column is NULL. This fills GBP/EUR (and any other configured-marketplace
// currency) -> REPORTING_CURRENCY.
//
// Source: frankfurter.app (European Central Bank reference rates, free, no
// key, working-day granularity). Stored as base_currency=native,
// quote_currency=reporting, rate = reporting per 1 native (so
// amount_native * rate = amount_reporting).
//
// Usage:
//   npm run sync-fx-rates                 # last 120 days
//   npm run sync-fx-rates -- --days 400   # wider backfill
// ============================================================================

import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';

interface FrankfurterTimeseries {
  base: string;
  rates: Record<string, Record<string, number>>;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { days: { type: 'string' } } });
  const days = values.days ? parseInt(values.days, 10) : 120;
  if (!Number.isFinite(days) || days < 1) throw new Error('--days must be a positive integer.');

  const env = loadEnv();
  const reporting = env.REPORTING_CURRENCY.toUpperCase();

  const end = new Date();
  const start = new Date(Date.now() - days * 86_400_000);

  const pg = await getPgClient();
  try {
    // Currencies to convert: every native currency of a marketplace this lake
    // actually has data for, minus the reporting currency itself.
    const { rows: ccyRows } = await pg.query<{ native_currency: string }>(
      `SELECT DISTINCT m.native_currency
         FROM meta.marketplace m
        WHERE m.marketplace_id IN (
              SELECT DISTINCT marketplace_id FROM brain.financial_events
              UNION
              SELECT DISTINCT marketplace_id FROM brain.sales_traffic_daily
        )
          AND m.native_currency <> $1`,
      [reporting],
    );
    const bases = ccyRows.map((r) => r.native_currency);
    if (bases.length === 0) {
      console.log(`No non-${reporting} currencies in use. Nothing to fetch.`);
      return;
    }

    console.log('operator-datacore — FX rates sync');
    console.log('---------------------------------');
    console.log(`  Reporting currency: ${reporting}`);
    console.log(`  Bases:              ${bases.join(', ')}`);
    console.log(`  Window:             ${isoDate(start)} .. ${isoDate(end)}`);
    console.log('');

    let upserted = 0;
    for (const base of bases) {
      const url = `https://api.frankfurter.app/${isoDate(start)}..${isoDate(end)}?from=${base}&to=${reporting}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`Frankfurter fetch failed for ${base}->${reporting} (${resp.status}): ${await resp.text()}`);
      }
      const data = (await resp.json()) as FrankfurterTimeseries;
      const dates = Object.keys(data.rates ?? {}).sort();
      let n = 0;
      for (const date of dates) {
        const rate = data.rates[date]?.[reporting];
        if (rate === undefined) continue;
        await pg.query(
          `INSERT INTO meta.fx_rates (rate_date, base_currency, quote_currency, rate, source, fetched_at)
           VALUES ($1, $2, $3, $4, 'frankfurter.app', NOW())
           ON CONFLICT (rate_date, base_currency, quote_currency) DO UPDATE
             SET rate = EXCLUDED.rate, source = EXCLUDED.source, fetched_at = NOW()`,
          [date, base, reporting, rate],
        );
        n += 1;
      }
      upserted += n;
      console.log(`  ${base} -> ${reporting}: ${n} daily rate(s)`);
    }
    console.log('');
    console.log(`Done. ${upserted} FX rate(s) upserted into meta.fx_rates.`);
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
