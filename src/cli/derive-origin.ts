#!/usr/bin/env tsx
// ============================================================================
// derive-origin.ts
// Sets brain.sku_master.country_of_origin from each SKU's PO supplier country,
// for SKUs the UPS catalogue hasn't classified. US country of origin is the
// manufacturing country of the US-bound (na/usa_awd) shipment, so we prefer the
// `na`-route supplier; this drives whether China 301/reciprocal overlays apply.
//
// INTERIM / proxy: supplier country = origin holds for private-label (the
// supplier IS the maker, e.g. Han Kuan=China, Dayes UK=UK, Dayes CN=China). For
// THIRD-PARTY brands a UK *supplier* may be a distributor of China-made goods —
// confirm those via the authoritative UPS catalogue (import-catalogue, which
// overrides this value on next run). Only fills where country_of_origin IS NULL.
//
// Usage:  npm run derive-origin [-- --dry-run]
// ============================================================================

import { parseArgs } from 'node:util';
import { getPgClient } from '../lib/supabase.js';

const NA_SUPPLIER_CTE = `
  na_supplier AS (
    SELECT DISTINCT ON (sm.ean) sm.ean,
      CASE lower(trim(s.country))
        WHEN 'china' THEN 'CN' WHEN 'uk' THEN 'GB' WHEN 'united kingdom' THEN 'GB'
        WHEN 'india' THEN 'IN' WHEN 'turkey' THEN 'TR' WHEN 'vietnam' THEN 'VN'
        WHEN 'portugal' THEN 'PT' WHEN 'france' THEN 'FR' WHEN 'south korea' THEN 'KR'
        WHEN 'brazil' THEN 'BR' WHEN 'taiwan' THEN 'TW' ELSE NULL END AS origin
    FROM brain.sku_master sm
    JOIN brain.purchase_order_lines pol ON pol.ean=sm.ean AND pol.line_type='product'
    JOIN brain.purchase_orders po ON po.po_id=pol.po_id
    LEFT JOIN brain.supplier_master s ON s.supplier_id=po.supplier_id
    WHERE s.country IS NOT NULL
    ORDER BY sm.ean, (pol.serves_region='na') DESC, po.order_date DESC NULLS LAST
  )`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
  console.log('operator-datacore — derive country_of_origin from PO supplier country');
  const pg = await getPgClient();
  try {
    if (values['dry-run']) {
      const { rows } = await pg.query(
        `WITH ${NA_SUPPLIER_CTE}
         SELECT ns.origin, COUNT(*) skus
         FROM na_supplier ns JOIN brain.sku_master sm ON sm.ean=ns.ean AND sm.country_of_origin IS NULL
         WHERE ns.origin IS NOT NULL GROUP BY ns.origin ORDER BY skus DESC`,
      );
      console.log('  would set:'); for (const r of rows) console.log(`    ${r.origin}: ${r.skus}`);
    } else {
      const res = await pg.query(
        `WITH ${NA_SUPPLIER_CTE}
         UPDATE brain.sku_master sm
         SET country_of_origin = na_supplier.origin,
             hs_code_source = COALESCE(sm.hs_code_source,'po_supplier_origin'),
             updated_at = NOW()
         FROM na_supplier
         WHERE sm.ean = na_supplier.ean AND na_supplier.origin IS NOT NULL AND sm.country_of_origin IS NULL`,
      );
      console.log(`  country_of_origin set on ${res.rowCount} SKU(s) (catalogue values untouched).`);
    }
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
