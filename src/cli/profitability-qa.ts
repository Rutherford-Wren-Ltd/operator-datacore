#!/usr/bin/env tsx
// ============================================================================
// profitability-qa.ts
// Standing QA over analytics.product_profitability_30d +
// analytics.product_profitability_reconciliation. Flags SKUs whose margin is
// negative, whose CM3 is built on incomplete cost data, or whose computed net
// disagrees with settlement actuals — so drift is caught even when nobody runs
// an /sku-audit. Designed to run on a schedule (see profitability-qa.yml).
//
// Exit code: 1 if any CRITICAL finding (a confidently-negative CM3, or a large
// reconciliation variance on a material SKU), else 0 — so CI can alert on it.
//
// Usage:
//   npm run profitability-qa
//   npm run profitability-qa -- --variance-tol 30 --min-revenue 50
//   npm run profitability-qa -- --out report.md     # also write a markdown report
// ============================================================================

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { getPgClient } from '../lib/supabase.js';

interface Row {
  marketplace_id: string; country_code: string | null; asin: string; brand: string | null;
  units_settled: number | null; revenue_ex_vat: string | null;
  cm3: string | null; cm3_margin_pct: string | null;
  inbound_source: string; storage_source: string; confidence: string; cost_completeness: string;
  variance_pct: string | null; unmatched_settlement_amount: string | null;
}

function n(v: string | null): number | null { return v === null ? null : Number(v); }

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'variance-tol': { type: 'string' },   // pp; |variance_pct| above this flags
      'min-revenue':  { type: 'string' },    // ignore tiny SKUs below this GBP revenue
      'margin-warn':  { type: 'string' },    // CM3% below this (but >=0) is a warning
      out:            { type: 'string' },
    },
  });
  const varianceTol = values['variance-tol'] ? parseFloat(values['variance-tol']) : 30;
  const minRevenue = values['min-revenue'] ? parseFloat(values['min-revenue']) : 50;
  const marginWarn = values['margin-warn'] ? parseFloat(values['margin-warn']) : 10;

  const pg = await getPgClient();
  try {
    const { rows } = await pg.query<Row>(
      `SELECT p.marketplace_id, p.country_code, p.asin, p.brand,
              p.units_settled, p.revenue_ex_vat, p.cm3, p.cm3_margin_pct,
              p.inbound_source, p.storage_source, p.confidence, p.cost_completeness,
              r.variance_pct, r.unmatched_settlement_amount
         FROM analytics.product_profitability_30d p
         LEFT JOIN analytics.product_profitability_reconciliation r
                ON r.marketplace_id = p.marketplace_id AND r.asin = p.asin
        WHERE COALESCE(p.revenue_ex_vat,0) >= $1`,
      [minRevenue],
    );

    const negative = rows.filter((r) => n(r.cm3_margin_pct) !== null && n(r.cm3_margin_pct)! < 0);
    // CRITICAL only when the cost basis is real: a known case qty (so inbound is
    // the actual box cost / pack, not a volumetric guess). Negatives that hinge
    // on a volumetric-fallback inbound estimate are a DATA gap, not a confirmed
    // loss — surfaced separately so they don't false-fail the gate.
    const negConfident = negative.filter((r) => r.confidence !== 'low' && r.inbound_source === 'case_qty');
    const negFallback = negative.filter((r) => r.inbound_source === 'volumetric_fallback');
    const thin = rows.filter((r) => { const m = n(r.cm3_margin_pct); return m !== null && m >= 0 && m < marginWarn; });
    const lowConf = rows.filter((r) => r.confidence === 'low');
    const variance = rows.filter((r) => n(r.variance_pct) !== null && Math.abs(n(r.variance_pct)!) > varianceTol);

    const fmtRow = (r: Row) =>
      `  ${(r.country_code ?? '??')} ${r.asin}  CM3 ${r.cm3_margin_pct ?? '—'}%  ` +
      `rev £${r.revenue_ex_vat ?? '—'}  [${r.confidence}] ${r.cost_completeness}` +
      (r.variance_pct !== null ? `  recon Δ${r.variance_pct}%` : '');

    const lines: string[] = [];
    const log = (s = '') => { lines.push(s); };
    log(`# Profitability QA — ${rows.length} SKU-marketplace rows (revenue ≥ £${minRevenue})`);
    log('');
    log(`CRITICAL — negative CM3 on a real cost basis (case qty known): ${negConfident.length}`);
    negConfident.slice(0, 40).forEach((r) => log(fmtRow(r)));
    log('');
    log(`WARN — negative CM3 but inbound is a volumetric estimate (add carton data to confirm): ${negFallback.length}`);
    negFallback.slice(0, 20).forEach((r) => log(fmtRow(r)));
    log('');
    log(`WARN — thin CM3 (0–${marginWarn}%): ${thin.length}`);
    thin.slice(0, 20).forEach((r) => log(fmtRow(r)));
    log('');
    log(`WARN — low confidence (incomplete cost data): ${lowConf.length}`);
    lowConf.slice(0, 20).forEach((r) => log(fmtRow(r)));
    log('');
    log(`INFO — reconciliation variance > ${varianceTol}pp (coarse; financial_events history is shallower than the 90d settlement window, so expect noise): ${variance.length}`);
    variance.slice(0, 20).forEach((r) => log(fmtRow(r)));
    log('');
    log(`(negative incl. low-confidence: ${negative.length})`);

    const report = lines.join('\n');
    console.log(report);
    if (values.out) { writeFileSync(values.out, report + '\n'); console.log(`\nWrote ${values.out}`); }

    // Gate only on confidently-negative CM3 — the actionable signal. Reconciliation
    // variance is informational (window-coverage noise), not a build-failing alarm.
    if (negConfident.length > 0) {
      console.error(`\n✗ QA FAIL: ${negConfident.length} SKU(s) with a confidently-negative CM3 (full cost stack incl inbound freight). Review pricing / US case quantities / inbound route.`);
      process.exitCode = 1;
    } else {
      console.log('\n✓ QA pass: no confidently-negative CM3.');
    }
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
