#!/usr/bin/env tsx
// ============================================================================
// sync-tariff-rates.ts
// The "FX-like" dynamic feed for US tariffs. Pulls the BASE MFN/general duty
// rate per HS code from the USITC HTS REST API (hts.usitc.gov — free, official)
// and upserts effective-dated rows into brain.hts_base_rate. Combined at query
// time with brain.tariff_overlay (China 301 / 2025 reciprocal) by
// analytics.fn_us_duty_rate.
//
// Scope: the distinct hs_code_us already on brain.sku_master (from the UPS
// catalogue), grouped by 4-digit heading -> one API call per heading, then a
// local longest-prefix match. Effective-dated, never mutates history; run
// weekly so annual/quarterly HTS revisions flow in as new effective_from rows.
//
// Caveat: only ad-valorem ("%"/"Free") general rates are synced. Specific duties
// ($/kg, cents/unit) are skipped (logged) — they need manual handling. The
// policy overlays (301/reciprocal) are NOT scraped here; they live in
// brain.tariff_overlay and are trued up to UPS/broker actuals.
//
// Usage:
//   npm run sync-tariff-rates                 # all catalogue codes
//   npm run sync-tariff-rates -- --dry-run
// ============================================================================

import { parseArgs } from 'node:util';
import { getPgClient } from '../lib/supabase.js';

const HTS_API = 'https://hts.usitc.gov/reststop/exportList';
const onlyDigits = (s: string) => (s || '').replace(/[^0-9]/g, '');

function parseRate(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  if (t === 'free') return 0;
  const m = t.match(/([0-9.]+)\s*%/);
  if (m) return parseFloat(m[1]!) / 100;
  return null; // specific duty ($/kg etc.) — not ad valorem
}

interface HtsRow { htsno: string; general: string }

async function fetchHeading(heading4: string): Promise<HtsRow[]> {
  const to = String(Number(heading4) + 1).padStart(4, '0');
  const url = `${HTS_API}?from=${heading4}&to=${to}&format=JSON&styles=false`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`USITC ${heading4}: HTTP ${res.status}`);
  return (await res.json()) as HtsRow[];
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
  console.log('operator-datacore — US tariff base-rate sync (USITC HTS)');

  const pg = await getPgClient();
  try {
    const { rows: codeRows } = await pg.query<{ hs_code_us: string }>(
      `SELECT DISTINCT hs_code_us FROM brain.sku_master WHERE hs_code_us IS NOT NULL AND hs_code_us <> ''`,
    );
    const codes = codeRows.map((r) => r.hs_code_us).filter((c) => onlyDigits(c).length >= 4);
    const headings = Array.from(new Set(codes.map((c) => onlyDigits(c).slice(0, 4)))).sort();
    console.log(`  ${codes.length} distinct catalogue codes across ${headings.length} headings`);

    let upserted = 0, skipped = 0; const skippedCodes: string[] = [];
    for (const h4 of headings) {
      let htsRows: HtsRow[];
      try { htsRows = await fetchHeading(h4); }
      catch (e) { console.warn(`  ! heading ${h4}: ${(e as Error).message}`); continue; }
      // index rows by normalised htsno with a parseable ad-valorem general rate
      const rated = htsRows
        .map((r) => ({ d: onlyDigits(r.htsno), rate: parseRate(r.general) }))
        .filter((r) => r.d.length > 0 && r.rate !== null);

      for (const code of codes.filter((c) => onlyDigits(c).slice(0, 4) === h4)) {
        const tgt = onlyDigits(code);
        // longest stored prefix that is a prefix of the SKU code
        let best: { d: string; rate: number } | null = null;
        for (const r of rated) if (tgt.startsWith(r.d) && (!best || r.d.length > best.d.length)) best = r as { d: string; rate: number };
        if (!best) { skipped++; skippedCodes.push(code); continue; }
        if (values['dry-run']) { upserted++; continue; }
        await pg.query(
          `INSERT INTO brain.hts_base_rate (hs10, general_rate_pct, effective_from, source, ingested_at)
           VALUES ($1,$2,CURRENT_DATE,'usitc_hts',NOW())
           ON CONFLICT (hs10, effective_from) DO UPDATE SET general_rate_pct=EXCLUDED.general_rate_pct, source='usitc_hts', ingested_at=NOW()`,
          [code, best.rate.toFixed(4)],
        );
        upserted++;
      }
      await new Promise((r) => setTimeout(r, 250)); // be polite to USITC
    }
    console.log(`\nBase rates upserted: ${upserted}; skipped (no ad-valorem general rate): ${skipped}`);
    if (skippedCodes.length) console.log(`  specific-duty / unmatched codes: ${skippedCodes.slice(0, 15).join(', ')}${skippedCodes.length > 15 ? ' …' : ''}`);
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
