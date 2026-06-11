#!/usr/bin/env tsx
// ============================================================================
// compute-us-inbound.ts
// Computes the US inbound (3PL->FBA) box cost per SKU from the UPS rate card
// and the SKU's carton dimensions/weight, and writes it to
// brain.sku_master.us_inbound_box_cost_gbp. The profitability view then uses
// box cost / units_per_case for US inbound (UK stays flat DPD).
//
// Rate card: ups_rate_card_zone3.csv (UPS Worldwide Expedited, GB->US Zone 3),
// sections in a `section` column. We use:
//   - freight_rate : net discounted GBP per weight band (value_post_dec21 used
//                    on/after the rate_change_date cutover, else value_pre_dec21)
//   - volumetric_divisor : L*W*H / divisor = dimensional weight (kg)
//   - mrpp : minimum revenue per package (floor)
// Per the card's own rules: billed weight = MAX(actual, dim); round UP to the
// next kg; first band >= that; above 100kg use the 100kg rate + per-kg excess;
// final = MAX(rate, MRPP). Peak/fuel surcharges are seasonal/variable and are
// NOT included in this estimate (flagged; add later if needed).
//
// Usage:
//   npm run compute-us-inbound -- --rate-card /path/ups_rate_card_zone3.csv
//   npm run compute-us-inbound -- --import-dir /path/to/imports
//   npm run compute-us-inbound -- ... --dry-run
// ============================================================================

import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getPgClient } from '../lib/supabase.js';

function splitCSV(line: string): string[] {
  const out: string[] = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

interface RateCard {
  bands: Array<{ kg: number; rate: number }>;   // sorted ascending
  perKgOver100: number;
  divisor: number;
  mrpp: number;
}

function loadRateCard(csvPath: string): RateCard {
  const lines = readFileSync(csvPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const hdr = splitCSV(lines[0]!).map((h) => h.toLowerCase());
  const ci = (name: string) => hdr.indexOf(name);
  const [iSec, iKey, iPre, iPost] = [ci('section'), ci('key'), ci('value_pre_dec21'), ci('value_post_dec21')];

  // cutover: today on/after 2025-12-21 -> post rates. Read the date from the card.
  let cutover = '2025-12-21';
  const today = new Date().toISOString().slice(0, 10);
  const bands: Array<{ kg: number; rate: number }> = [];
  let perKgOver100 = 0, divisor = 5000, mrpp = 0;
  // first pass: find cutover
  for (const ln of lines.slice(1)) { const r = splitCSV(ln); if (r[iSec] === 'rate_change_date') cutover = r[iPre] || cutover; }
  const usePost = today >= cutover;
  const val = (r: string[]) => parseFloat((usePost ? r[iPost] : r[iPre]) || r[iPre] || '');

  for (const ln of lines.slice(1)) {
    const r = splitCSV(ln);
    const sec = r[iSec], key = r[iKey];
    if (sec === 'freight_rate') {
      const m = key?.match(/^(\d+)kg$/);
      if (m) { const v = val(r); if (Number.isFinite(v)) bands.push({ kg: parseInt(m[1]!, 10), rate: v }); }
      else if (key === 'per_kg_over_100') { const v = val(r); if (Number.isFinite(v)) perKgOver100 = v; }
    } else if (sec === 'volumetric_divisor') { const v = val(r); if (Number.isFinite(v)) divisor = v; }
    else if (sec === 'mrpp') { const v = val(r); if (Number.isFinite(v)) mrpp = v; }
  }
  bands.sort((a, b) => a.kg - b.kg);
  if (bands.length === 0) throw new Error('No freight_rate bands parsed from rate card.');
  console.log(`  rate card: ${bands.length} bands, divisor ${divisor}, MRPP £${mrpp}, rates ${usePost ? 'post' : 'pre'}-${cutover}`);
  return { bands, perKgOver100, divisor, mrpp };
}

function rateFor(billedKg: number, rc: RateCard): number {
  const bw = Math.max(1, Math.ceil(billedKg));
  let rate: number;
  if (bw <= rc.bands[rc.bands.length - 1]!.kg) {
    rate = (rc.bands.find((b) => b.kg >= bw) ?? rc.bands[rc.bands.length - 1]!).rate;
  } else {
    const top = rc.bands[rc.bands.length - 1]!; // 100kg
    rate = top.rate + rc.perKgOver100 * (bw - top.kg);
  }
  return Math.max(rate, rc.mrpp);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { 'rate-card': { type: 'string' }, 'import-dir': { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  });
  const cardPath = values['rate-card']
    ?? (values['import-dir'] ? path.join(values['import-dir'], 'ups_rate_card_zone3.csv') : undefined)
    ?? (process.env.IMPORT_DIR ? path.join(process.env.IMPORT_DIR, 'ups_rate_card_zone3.csv') : undefined);
  if (!cardPath || !existsSync(cardPath)) throw new Error(`UPS rate card not found (pass --rate-card or --import-dir). Looked at: ${cardPath}`);

  console.log('operator-datacore — US inbound cost from UPS rate card');
  console.log('-----------------------------------------------------');
  const rc = loadRateCard(cardPath);

  // Max Amazon box (64x46x46cm / 22kg) + a packing-efficiency factor: a box never
  // fills to its nominal cuboid volume (void fill, irregular shapes).
  const MAX_BOX_VOL_M3 = 0.135424, MAX_BOX_WT_KG = 22, PACK = 0.75;
  const DIV = rc.divisor; // cm^3 per kg (5000)
  // dimensional weight (kg) of n items of volM3 each: m^3 -> cm^3 (x1e6) / divisor
  const dimWt = (volM3: number, n: number) => (volM3 * n * 1e6) / DIV;

  const pg = await getPgClient();
  const byMethod = { carton: 0, item_x_case: 0, volumetric_item: 0, none: 0 } as Record<'carton'|'item_x_case'|'volumetric_item'|'none', number>;
  try {
    const { rows } = await pg.query<{
      ean: string; upc: string | null; cl: string | null; cw: string | null; ch: string | null; cwt: string | null;
      iwt: string | null; ivol: string | null;
    }>(
      `SELECT sm.ean, sm.units_per_case AS upc,
              sm.carton_length_cm AS cl, sm.carton_width_cm AS cw, sm.carton_height_cm AS ch, sm.carton_weight_kg AS cwt,
              d.item_weight_kg AS iwt, d.item_volume_m3 AS ivol
         FROM brain.sku_master sm
         LEFT JOIN (
           SELECT asin, AVG(item_weight_kg) AS item_weight_kg, AVG(item_volume_m3) AS item_volume_m3
           FROM brain.fba_item_dimensions WHERE asin IS NOT NULL AND item_volume_m3 > 0
           GROUP BY asin
         ) d ON d.asin = sm.asin`,
    );
    for (const r of rows) {
      const upc = r.upc ? Number(r.upc) : 0;
      const cl = Number(r.cl) || 0, cw = Number(r.cw) || 0, ch = Number(r.ch) || 0, cwt = Number(r.cwt) || 0;
      const iwt = Number(r.iwt) || 0, ivol = Number(r.ivol) || 0;

      let method: 'carton' | 'item_x_case' | 'volumetric_item' | null = null;
      let perUnit = 0, billed = 0;
      if (upc > 0 && cl > 0 && cw > 0 && ch > 0 && cwt > 0) {
        // 1. operator carton dims+weight (authoritative)
        billed = Math.max(cwt, (cl * cw * ch) / DIV);
        perUnit = rateFor(billed, rc) / upc; method = 'carton';
      } else if (upc > 0 && iwt > 0 && ivol > 0) {
        // 2. estimate the carton from item dims x known case qty
        billed = Math.max(iwt * upc, dimWt(ivol, upc));
        perUnit = rateFor(billed, rc) / upc; method = 'item_x_case';
      } else if (iwt > 0 && ivol > 0) {
        // 3. no case qty: how many fit in the max box, weight- AND volume-limited
        const unitsFit = Math.max(1, Math.floor(Math.min((MAX_BOX_VOL_M3 * PACK) / ivol, MAX_BOX_WT_KG / iwt)));
        billed = Math.max(iwt * unitsFit, dimWt(ivol, unitsFit));
        perUnit = rateFor(billed, rc) / unitsFit; method = 'volumetric_item';
      }
      if (!method) { byMethod.none++; continue; }
      byMethod[method]!++;
      if (values['dry-run']) continue;
      await pg.query(
        `UPDATE brain.sku_master SET us_inbound_per_unit_gbp=$2::numeric, us_inbound_method=$3,
           us_inbound_billed_weight_kg=$4::numeric, updated_at=NOW() WHERE ean=$1`,
        [r.ean, perUnit.toFixed(4), method, billed.toFixed(3)],
      );
    }
    console.log('\nUS inbound per unit computed by method:');
    console.log(`  carton (operator dims):     ${byMethod.carton}`);
    console.log(`  item x case (storage dims): ${byMethod.item_x_case}`);
    console.log(`  volumetric max-box fit:     ${byMethod.volumetric_item}`);
    console.log(`  no data (skipped):          ${byMethod.none}`);
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
