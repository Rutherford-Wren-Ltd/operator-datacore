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

  const pg = await getPgClient();
  let computed = 0, skipped = 0, flaggedOverweight = 0;
  try {
    const { rows } = await pg.query<{ ean: string; l: string | null; w: string | null; h: string | null; wt: string | null }>(
      `SELECT ean, carton_length_cm AS l, carton_width_cm AS w, carton_height_cm AS h, carton_weight_kg AS wt
         FROM brain.sku_master`,
    );
    for (const r of rows) {
      const l = r.l ? Number(r.l) : 0, w = r.w ? Number(r.w) : 0, h = r.h ? Number(r.h) : 0, wt = r.wt ? Number(r.wt) : 0;
      const dimW = (l > 0 && w > 0 && h > 0) ? (l * w * h) / rc.divisor : 0;
      const billed = Math.max(wt, dimW);
      if (billed <= 0) { skipped++; continue; }       // no carton data -> leave null (view falls back)
      if (billed > 29.5) flaggedOverweight++;          // card's max_pkg_weight flag
      const cost = rateFor(billed, rc);
      if (values['dry-run']) { computed++; continue; }
      await pg.query(
        `UPDATE brain.sku_master SET us_inbound_box_cost_gbp = $2::numeric, us_inbound_billed_weight_kg = $3::numeric, updated_at = NOW() WHERE ean = $1`,
        [r.ean, cost.toFixed(4), billed.toFixed(3)],
      );
      computed++;
    }
    console.log(`\nUS box cost computed for ${computed} SKU(s); ${skipped} skipped (no carton data); ${flaggedOverweight} over 29.5kg/pkg (check dim audit).`);
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
