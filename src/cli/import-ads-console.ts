#!/usr/bin/env tsx
// ============================================================================
// import-ads-console.ts
// Import campaign-level Amazon Ads history from a manual Ads Console CSV
// export. Lands rows in brain.ads_campaign_history_imported.
//
// Why this exists:
//   The Ads API only retains advertised-product reports for 65-95 days
//   (see [[amazon-ads-api-retention]]). The Ads Console web UI export
//   gives campaign-level data going back ~2 years (SP/SD) or ~1 year (SB),
//   filling the long-tail window the API can't reach. Less granular than
//   brain.ads_sp_daily (no per-ASIN), but enough for YoY ACoS / TACoS /
//   spend-trend analysis.
//
// Usage:
//   npm run import-ads-console -- \
//     --file "C:/path/to/SP-Campaign-Report.csv" \
//     --profile-id 567327329024034 \
//     --profile-label "Emporium Cookshop & Homewares (UK)" \
//     --region EU \
//     --ad-product SP \
//     --batch-id 2026-05-28-uk-sp-24mo
//
// One CSV per invocation. Run once per (profile × ad-product) combination.
// The --batch-id ties multiple invocations together for audit / re-import.
//
// Add --dry-run to inspect what would land without writing.
// ============================================================================

import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { getPgClient } from '../lib/supabase.js';

type AdProduct = 'SP' | 'SD' | 'SB';

interface CountryMapping {
  profileId: string;
  profileLabel: string | null;
  region: string | null;
}

interface ParsedArgs {
  file: string;
  // Single-profile mode (one file per profile):
  profileId: string | null;
  profileLabel: string | null;
  region: string | null;
  // Multi-country mode (one file containing rows from many profiles):
  countryMap: Map<string, CountryMapping> | null;
  adProduct: AdProduct;
  batchId: string;
  dryRun: boolean;
}

/**
 * Parse --country-map "United Kingdom:567...:EU,United States:863...:NA".
 *
 * Country name comes first (Amazon Ads Console exports use the full name
 * verbatim, e.g. "United Kingdom" not "GB"). Profile id and region follow,
 * colon-separated. Country entries are comma-separated.
 *
 * Country names are matched case-insensitively to be forgiving — Amazon
 * has been inconsistent across exports ("United Kingdom" vs "United
 * kingdom" historically).
 */
function parseCountryMap(raw: string): Map<string, CountryMapping> {
  const map = new Map<string, CountryMapping>();
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const parts = entry.split(':');
    if (parts.length < 2 || parts.length > 3) {
      throw new Error(
        `--country-map entry "${entry}" is malformed. Expected "CountryName:profileId" or "CountryName:profileId:Region".`,
      );
    }
    const [country, profileId, region] = parts;
    if (!country || !profileId) {
      throw new Error(`--country-map entry "${entry}" has empty country or profileId.`);
    }
    map.set(country.toLowerCase(), {
      profileId: profileId.trim(),
      profileLabel: null,
      region: region?.trim() || null,
    });
  }
  if (map.size === 0) throw new Error('--country-map is empty.');
  return map;
}

function parseCliArgs(): ParsedArgs {
  const { values } = parseArgs({
    options: {
      file:            { type: 'string' },
      'profile-id':    { type: 'string' },
      'profile-label': { type: 'string' },
      region:          { type: 'string' },
      'country-map':   { type: 'string' },
      'ad-product':    { type: 'string' },
      'batch-id':      { type: 'string' },
      'dry-run':       { type: 'boolean', default: false },
    },
  });

  if (!values.file)         throw new Error('--file is required (path to the Ads Console CSV export)');
  if (!values['ad-product']) throw new Error('--ad-product is required (SP | SD | SB)');
  if (!values['batch-id'])   throw new Error('--batch-id is required (free-form tag for this import; e.g. 2026-05-28-uk-sp-24mo)');

  const hasProfile = !!values['profile-id'];
  const hasCountryMap = !!values['country-map'];
  if (hasProfile && hasCountryMap) {
    throw new Error('Use either --profile-id (single-profile export) or --country-map (multi-country export), not both.');
  }
  if (!hasProfile && !hasCountryMap) {
    throw new Error('Either --profile-id or --country-map is required.');
  }

  const ap = values['ad-product'].toUpperCase();
  if (ap !== 'SP' && ap !== 'SD' && ap !== 'SB') {
    throw new Error(`--ad-product must be one of: SP, SD, SB. Got "${values['ad-product']}".`);
  }
  if (!existsSync(values.file)) throw new Error(`File not found: ${values.file}`);

  return {
    file: values.file,
    profileId: values['profile-id'] ?? null,
    profileLabel: values['profile-label'] ?? null,
    region: values.region ?? null,
    countryMap: hasCountryMap ? parseCountryMap(values['country-map']!) : null,
    adProduct: ap,
    batchId: values['batch-id'],
    dryRun: values['dry-run'] ?? false,
  };
}

// ----------------------------------------------------------------------------
// CSV parsing — handles BOM, quoted fields with commas / escaped quotes.
// Copied/adapted from import-masters.ts to keep the import-CLI family
// consistent.
// ----------------------------------------------------------------------------
function parseCSVLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseCSV(content: string): { header: string[]; rows: string[][] } {
  // eslint-disable-next-line no-irregular-whitespace
  const stripped = content.replace(/^﻿/, '');
  const lines = stripped.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) throw new Error('CSV is empty');
  return { header: parseCSVLine(lines[0]!), rows: lines.slice(1).map(parseCSVLine) };
}

// ----------------------------------------------------------------------------
// Header normalisation: Amazon Ads Console uses headers like "7-Day Total
// Orders (#)" — we lowercase, replace non-alphanumerics with underscores,
// collapse repeated underscores, and trim ends. The result is what lands
// as JSONB keys in raw_csv, and what we look up in TYPED_COLUMN_ALIASES.
// ----------------------------------------------------------------------------
function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Map of typed column → list of normalised header aliases the Console
// uses. Order matters within each list (first match wins). Reports from
// SP / SD / SB differ in attribution windows, so we accept multiple
// variants — sales / orders / units in particular have 7-day vs 14-day
// flavours depending on product.
const TYPED_COLUMN_ALIASES = {
  metric_date:      ['date', 'day', 'start_date'],
  country:          ['country', 'country_code', 'marketplace'],
  campaign_id:      ['campaign_id'],
  campaign_name:    ['campaign_name', 'campaign'],
  campaign_status:  ['campaign_status', 'state', 'status'],
  portfolio_name:   ['portfolio_name', 'portfolio'],
  targeting_type:   ['targeting_type', 'targeting'],
  bidding_strategy: ['bidding_strategy', 'bid_strategy'],
  currency_code:    ['currency', 'currency_code'],
  impressions:      ['impressions'],
  clicks:           ['clicks'],
  spend:            ['spend', 'total_spend', 'cost', 'ad_spend'],
  orders: [
    '7_day_total_orders',
    '14_day_total_orders',
    '7_day_total_orders_number',     // some exports include the (#) literally
    '14_day_total_orders_number',
    'total_orders',
    'orders',
  ],
  sales: [
    '7_day_total_sales',
    '14_day_total_sales',
    'total_sales',
    'sales',
  ],
  units: [
    '7_day_total_units',
    '14_day_total_units',
    '7_day_total_units_number',
    '14_day_total_units_number',
    'total_units',
    'units',
    'units_sold',
  ],
} as const;

type TypedColumn = keyof typeof TYPED_COLUMN_ALIASES;

/**
 * Build a map from typed column name to the actual normalised CSV header
 * that should populate it. Logs unmatched typed columns as warnings so
 * the operator can see what's missing in their export.
 */
function buildHeaderMap(headers: string[]): {
  typed: Partial<Record<TypedColumn, string>>;
  warnings: string[];
} {
  const present = new Set(headers);
  const typed: Partial<Record<TypedColumn, string>> = {};
  const warnings: string[] = [];

  for (const [typedCol, aliases] of Object.entries(TYPED_COLUMN_ALIASES)) {
    const match = aliases.find((a) => present.has(a));
    if (match) {
      typed[typedCol as TypedColumn] = match;
    } else if (typedCol === 'metric_date' || typedCol === 'campaign_name') {
      // Hard-required columns. Anything else is informational.
      throw new Error(
        `CSV is missing a required column for "${typedCol}". Tried: ${aliases.join(', ')}. ` +
        `Detected headers: ${headers.join(', ')}.`,
      );
    } else {
      warnings.push(
        `[warn] No header matched typed column "${typedCol}". Searched: ${aliases.join(', ')}. ` +
        `This field will be NULL for every row.`,
      );
    }
  }
  return { typed, warnings };
}

// ----------------------------------------------------------------------------
// Field parsing — Amazon Ads Console values are messy. Currency cells have
// symbols ("£123.45"), integers have thousands separators ("1,234"), empty
// cells mean NULL.
// ----------------------------------------------------------------------------
const MONTH_NAMES: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function parseDate(raw: string): string | null {
  if (!raw) return null;
  // ISO (2024-12-31).
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // US slash (12/31/2024).
  const usMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, m, d, y] = usMatch;
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }
  // Long form ("Jun 01, 2023" or "Jun 1, 2023") — what Amazon Ads
  // Console emits for Sponsored Products campaign exports.
  const longMatch = raw.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (longMatch) {
    const [, monthStr, d, y] = longMatch;
    const mNum = MONTH_NAMES[monthStr!.toLowerCase()];
    if (mNum) return `${y}-${mNum}-${d!.padStart(2, '0')}`;
  }
  // Fall through: let Postgres complain if it's something else.
  return raw;
}

function parseNumber(raw: string): number | null {
  if (!raw) return null;
  // Strip currency symbols, percent signs, thousands separators.
  const cleaned = raw.replace(/[£$€¥,%\s]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseInteger(raw: string): number | null {
  const n = parseNumber(raw);
  if (n === null) return null;
  return Math.round(n);
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseCliArgs();

  console.log('operator-datacore — Ads Console import');
  console.log('---------------------------------------');
  console.log(`  File:          ${args.file}`);
  if (args.countryMap) {
    console.log(`  Mode:          multi-country (per-row resolution via Country column)`);
    console.log(`  Country map:   ${args.countryMap.size} country/countries configured`);
    for (const [country, m] of args.countryMap) {
      console.log(`    "${country}" → profile ${m.profileId} (region ${m.region ?? '(unset)'})`);
    }
  } else {
    console.log(`  Mode:          single-profile`);
    console.log(`  Profile id:    ${args.profileId}`);
    console.log(`  Profile label: ${args.profileLabel ?? '(none)'}`);
    console.log(`  Region:        ${args.region ?? '(unset)'}`);
  }
  console.log(`  Ad product:    ${args.adProduct}`);
  console.log(`  Batch id:      ${args.batchId}`);
  console.log(`  Dry run:       ${args.dryRun}`);
  console.log('');

  const raw = readFileSync(args.file, 'utf8');
  const { header, rows } = parseCSV(raw);
  const normalised = header.map(normaliseHeader);

  console.log(`Detected ${header.length} columns:`);
  header.forEach((h, i) => console.log(`  ${(i + 1).toString().padStart(2)}. "${h}" → ${normalised[i]}`));
  console.log('');

  const { typed, warnings } = buildHeaderMap(normalised);
  if (warnings.length > 0) {
    for (const w of warnings) console.warn(w);
    console.log('');
  }
  if (args.countryMap && !typed.country) {
    throw new Error(
      `--country-map set, but CSV has no header matching the country column ` +
      `(searched: country, country_code, marketplace). ` +
      `Either drop --country-map and import per-file, or check the export.`,
    );
  }
  console.log('Typed-column mapping:');
  for (const [k, v] of Object.entries(typed)) {
    console.log(`  ${k.padEnd(18)} ← ${v}`);
  }
  console.log('');

  // Build typed row + raw_csv (JSONB) per input row. profile_id /
  // profile_label / region land per-row so the multi-country case carries
  // distinct values without changing the SQL shape downstream.
  interface Prepared {
    metric_date: string;
    profile_id: string;
    profile_label: string | null;
    region: string | null;
    campaign_name: string;
    campaign_id: string | null;
    campaign_status: string | null;
    portfolio_name: string | null;
    targeting_type: string | null;
    bidding_strategy: string | null;
    currency_code: string | null;
    impressions: number | null;
    clicks: number | null;
    spend: number | null;
    orders: number | null;
    sales: number | null;
    units: number | null;
    raw_csv: Record<string, string>;
  }

  const prepared: Prepared[] = [];
  const errors: Array<{ rowNum: number; message: string }> = [];
  const unmappedCountries = new Map<string, number>();  // country → row count

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx]!;
    if (row.length === 1 && row[0] === '') continue;  // skip blank line

    const lookup = (typedCol: TypedColumn): string => {
      const alias = typed[typedCol];
      if (!alias) return '';
      const colIdx = normalised.indexOf(alias);
      if (colIdx < 0) return '';
      return row[colIdx] ?? '';
    };

    const rawCsv: Record<string, string> = {};
    normalised.forEach((h, i) => { rawCsv[h] = row[i] ?? ''; });

    const dateRaw = lookup('metric_date');
    const date = parseDate(dateRaw);
    const campaignName = lookup('campaign_name');

    if (!date) {
      errors.push({ rowNum: rowIdx + 2, message: `empty/invalid date: "${dateRaw}"` });
      continue;
    }
    if (!campaignName) {
      errors.push({ rowNum: rowIdx + 2, message: `empty campaign_name` });
      continue;
    }

    // Resolve profile per row.
    let profileId: string;
    let profileLabel: string | null;
    let region: string | null;
    if (args.countryMap) {
      const country = lookup('country');
      const mapping = country ? args.countryMap.get(country.toLowerCase()) : undefined;
      if (!mapping) {
        // Drop the row from the worklist but tally the country so the
        // operator can see what was skipped.
        const key = country || '(empty)';
        unmappedCountries.set(key, (unmappedCountries.get(key) ?? 0) + 1);
        continue;
      }
      profileId = mapping.profileId;
      profileLabel = mapping.profileLabel;
      region = mapping.region;
    } else {
      profileId = args.profileId!;
      profileLabel = args.profileLabel;
      region = args.region;
    }

    prepared.push({
      metric_date: date,
      profile_id: profileId,
      profile_label: profileLabel,
      region,
      campaign_name: campaignName,
      campaign_id:      lookup('campaign_id') || null,
      campaign_status:  lookup('campaign_status') || null,
      portfolio_name:   lookup('portfolio_name') || null,
      targeting_type:   lookup('targeting_type') || null,
      bidding_strategy: lookup('bidding_strategy') || null,
      currency_code:    lookup('currency_code') || null,
      impressions: parseInteger(lookup('impressions')),
      clicks:      parseInteger(lookup('clicks')),
      spend:       parseNumber(lookup('spend')),
      orders:      parseInteger(lookup('orders')),
      sales:       parseNumber(lookup('sales')),
      units:       parseInteger(lookup('units')),
      raw_csv: rawCsv,
    });
  }

  if (unmappedCountries.size > 0) {
    console.warn(`[warn] Skipped rows for countries not in --country-map:`);
    for (const [c, count] of [...unmappedCountries.entries()].sort((a, b) => b[1] - a[1])) {
      console.warn(`    "${c}" — ${count} row(s)`);
    }
    console.warn(`  Add these countries to --country-map if you want them imported.`);
    console.log('');
  }

  console.log(`Parsed ${prepared.length} valid row(s) out of ${rows.length}; ${errors.length} skipped.`);
  if (errors.length > 0) {
    console.log('First 5 skipped rows:');
    for (const e of errors.slice(0, 5)) console.log(`  row ${e.rowNum}: ${e.message}`);
  }
  console.log('');

  // Date range summary
  if (prepared.length > 0) {
    const dates = prepared.map((p) => p.metric_date).sort();
    console.log(`Date range: ${dates[0]} → ${dates[dates.length - 1]} (${new Set(dates).size} distinct days)`);
    const campaigns = new Set(prepared.map((p) => p.campaign_name));
    console.log(`Campaigns:  ${campaigns.size}`);
    const totalSpend = prepared.reduce((s, p) => s + (p.spend ?? 0), 0);
    const totalSales = prepared.reduce((s, p) => s + (p.sales ?? 0), 0);
    console.log(`Spend sum:  ${totalSpend.toFixed(2)} ${prepared[0]!.currency_code ?? ''}`);
    console.log(`Sales sum:  ${totalSales.toFixed(2)} ${prepared[0]!.currency_code ?? ''}`);
    console.log('');
  }

  if (args.dryRun) {
    console.log('--dry-run set — nothing written. Re-run without --dry-run to commit.');
    return;
  }
  if (prepared.length === 0) {
    console.log('No valid rows to import.');
    return;
  }

  const pg = await getPgClient();
  try {
    const sourceFile = basename(args.file);
    // Batched multi-VALUES INSERT. 21 params per row × 1000 rows = 21,000
    // params per batch; well under Postgres's 65,535 limit. Round-trip
    // count drops by 1000× vs the per-row INSERT; for a 1M row import
    // that's ~3-5 min instead of ~10 hours over Supabase latency.
    const BATCH_SIZE = 1000;
    const PROGRESS_EVERY = 10;  // log every Nth batch
    const startedAt = Date.now();
    let upserts = 0;

    for (let batchIdx = 0; batchIdx < prepared.length; batchIdx += BATCH_SIZE) {
      const batch = prepared.slice(batchIdx, batchIdx + BATCH_SIZE);
      const params: unknown[] = [];
      const valuesClauses: string[] = [];
      for (const p of batch) {
        const i = params.length;
        params.push(
          p.metric_date, p.profile_id, p.profile_label, p.region, args.adProduct,
          p.portfolio_name, p.campaign_id, p.campaign_name, p.campaign_status,
          p.targeting_type, p.bidding_strategy, p.currency_code,
          p.impressions, p.clicks, p.spend, p.orders, p.sales, p.units,
          JSON.stringify(p.raw_csv), args.batchId, sourceFile,
        );
        const placeholders = Array.from({ length: 21 }, (_, k) => `$${i + k + 1}`);
        // Index 18 (zero-based) is raw_csv → ::jsonb cast.
        placeholders[18] = `${placeholders[18]}::jsonb`;
        valuesClauses.push(`(${placeholders.join(',')})`);
      }

      await pg.query(
        `INSERT INTO brain.ads_campaign_history_imported (
            metric_date, profile_id, profile_label, region, ad_product,
            portfolio_name, campaign_id, campaign_name, campaign_status,
            targeting_type, bidding_strategy, currency_code,
            impressions, clicks, spend, orders, sales, units,
            raw_csv, import_batch_id, source_file
         ) VALUES ${valuesClauses.join(',')}
         ON CONFLICT (metric_date, profile_id, ad_product, campaign_name) DO UPDATE SET
            profile_label    = EXCLUDED.profile_label,
            region           = EXCLUDED.region,
            portfolio_name   = EXCLUDED.portfolio_name,
            campaign_id      = COALESCE(EXCLUDED.campaign_id, brain.ads_campaign_history_imported.campaign_id),
            campaign_status  = EXCLUDED.campaign_status,
            targeting_type   = EXCLUDED.targeting_type,
            bidding_strategy = EXCLUDED.bidding_strategy,
            currency_code    = EXCLUDED.currency_code,
            impressions      = EXCLUDED.impressions,
            clicks           = EXCLUDED.clicks,
            spend            = EXCLUDED.spend,
            orders           = EXCLUDED.orders,
            sales            = EXCLUDED.sales,
            units            = EXCLUDED.units,
            raw_csv          = EXCLUDED.raw_csv,
            import_batch_id  = EXCLUDED.import_batch_id,
            source_file      = EXCLUDED.source_file,
            imported_at      = NOW()`,
        params,
      );

      upserts += batch.length;
      const batchNum = Math.floor(batchIdx / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(prepared.length / BATCH_SIZE);
      if (batchNum % PROGRESS_EVERY === 0 || batchNum === totalBatches) {
        const pct = ((upserts / prepared.length) * 100).toFixed(1).padStart(5);
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
        const rate = Math.round(upserts / Math.max(1, (Date.now() - startedAt) / 1000));
        console.log(`  [${pct}%] batch ${batchNum}/${totalBatches} — ${upserts.toLocaleString()} rows upserted (${rate.toLocaleString()} rows/s, ${elapsed}s elapsed)`);
      }
    }
    const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log('');
    console.log(`Done in ${totalSec}s. ${upserts.toLocaleString()} row(s) upserted into brain.ads_campaign_history_imported (batch_id ${args.batchId}).`);
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
