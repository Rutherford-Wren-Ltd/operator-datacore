#!/usr/bin/env tsx
// ============================================================================
// build-duty-layers.ts
// Builds immutable per-batch duty cost layers (brain.sku_duty_layer) from US-
// bound PO lines. Each layer "books" the duty on its import date as a locked
// cost, so cost of sale (weighted moving average over open layers, see
// analytics.sku_us_duty_costed) reflects the rate the stock actually paid — not
// today's rate.
//
//   import_date = COALESCE(actual_arrival, expected_arrival, actual_ship, order)
//   units       = COALESCE(NULLIF(qty_received,0), qty_ordered)
//   customs_gbp = customs_value_usd x FX(USD->GBP at import_date)   [historical FX]
//   duty/unit   = actual paid (comp_import_duty -> GBP)  OR  modelled
//                 fn_us_duty_rate(hs, origin, import_date) x customs_gbp
//   basis       = actual | modelled
//
// Layers with basis='actual' are immutable; 'modelled' layers refresh on re-run
// (as arrivals/receipts get logged). Keyed by source_po_line_id.
//
// Usage:  npm run build-duty-layers [-- --dry-run]
// ============================================================================

import { parseArgs } from 'node:util';
import { getPgClient } from '../lib/supabase.js';

const BUILD_SQL = `
WITH src AS (
  SELECT pol.po_line_id, pol.ean,
    COALESCE(po.actual_arrival_date, po.expected_arrival_date, po.actual_ship_date, po.order_date) AS import_date,
    COALESCE(NULLIF(pol.qty_received,0), pol.qty_ordered) AS units,
    pol.comp_import_duty, pol.landed_cost_currency,
    sm.hs_code_us, sm.country_of_origin, sm.customs_value_usd
  FROM brain.purchase_order_lines pol
  JOIN brain.purchase_orders po ON po.po_id = pol.po_id
  LEFT JOIN brain.sku_master sm ON sm.ean = pol.ean
  WHERE pol.serves_region='na' AND pol.line_type='product' AND pol.ean IS NOT NULL
),
priced AS (
  SELECT s.*,
    (SELECT rate FROM meta.fx_rates WHERE base_currency='USD' AND quote_currency='GBP'
       AND rate_date <= s.import_date ORDER BY rate_date DESC LIMIT 1) AS usd_gbp
  FROM src s WHERE s.import_date IS NOT NULL AND s.units > 0
)
INSERT INTO brain.sku_duty_layer
  (ean, region, import_date, units, customs_value_gbp, hs_code, origin, duty_rate_locked, duty_per_unit_gbp, basis, source_po_line_id)
SELECT p.ean, 'na', p.import_date, p.units,
  p.customs_value_usd * COALESCE(p.usd_gbp,1) AS customs_value_gbp,
  p.hs_code_us, p.country_of_origin,
  analytics.fn_us_duty_rate(p.hs_code_us, p.country_of_origin, p.import_date) AS duty_rate_locked,
  CASE WHEN p.comp_import_duty IS NOT NULL
       THEN p.comp_import_duty * (CASE WHEN p.landed_cost_currency='USD' THEN COALESCE(p.usd_gbp,1) ELSE 1 END)
       ELSE COALESCE(analytics.fn_us_duty_rate(p.hs_code_us, p.country_of_origin, p.import_date), 0)
            * p.customs_value_usd * COALESCE(p.usd_gbp,1) END AS duty_per_unit_gbp,
  CASE WHEN p.comp_import_duty IS NOT NULL THEN 'actual' ELSE 'modelled' END AS basis,
  p.po_line_id
FROM priced p
ON CONFLICT (source_po_line_id) DO UPDATE SET
  import_date=EXCLUDED.import_date, units=EXCLUDED.units, customs_value_gbp=EXCLUDED.customs_value_gbp,
  hs_code=EXCLUDED.hs_code, origin=EXCLUDED.origin, duty_rate_locked=EXCLUDED.duty_rate_locked,
  duty_per_unit_gbp=EXCLUDED.duty_per_unit_gbp, basis=EXCLUDED.basis
WHERE brain.sku_duty_layer.basis = 'modelled';  -- never overwrite a locked actual
`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
  console.log('operator-datacore — build US duty cost layers from POs');
  const pg = await getPgClient();
  try {
    if (values['dry-run']) {
      const { rows } = await pg.query(
        `SELECT COUNT(*) n, COUNT(*) FILTER (WHERE comp_import_duty IS NOT NULL) actual
         FROM brain.purchase_order_lines WHERE serves_region='na' AND line_type='product' AND ean IS NOT NULL`,
      );
      console.log(`  dry-run: ${rows[0].n} US PO line(s) would form layers (${rows[0].actual} with actual duty).`);
    } else {
      const res = await pg.query(BUILD_SQL);
      console.log(`  layers upserted: ${res.rowCount}`);
      const { rows } = await pg.query(
        `SELECT basis, COUNT(*) n, SUM(units) units FROM brain.sku_duty_layer GROUP BY basis ORDER BY basis`,
      );
      for (const r of rows) console.log(`    ${r.basis}: ${r.n} layer(s), ${r.units} units`);
    }
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
