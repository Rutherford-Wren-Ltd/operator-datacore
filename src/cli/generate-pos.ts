#!/usr/bin/env tsx
// ============================================================================
// generate-pos.ts — the restock engine
//
// Scans the active catalogue, runs /restock-memo's availability-vs-forecast
// decision math per SKU, and writes draft purchase orders (one per supplier)
// into brain.purchase_orders for the team to review. Also emits a markdown
// review report into the Obsidian vault.
//
// These are DRAFT POs — never placed orders. The team reviews the report,
// assigns physical destinations, allocates real PO numbers, and promotes each
// PO they approve. Un-promoted engine drafts are expired (archived, not deleted)
// and regenerated on the next run, so do not edit a draft in place — promote it
// first; an un-promoted edit survives as an 'expired' row but won't be acted on.
//
// Usage:
//   npm run generate-pos
//   npm run generate-pos -- --dry-run
//   npm run generate-pos -- --weeks 16 --report-path ../some/where.md
//
// The gap math is region-correct: UK/EU and NA shortfalls are computed
// separately and floored at zero before summing, so a surplus in one region
// can never cancel a real shortage in the other. The PO line is still one per
// SKU (the proposed total); the per-region breakdown is in the report.
// ============================================================================

import { parseArgs } from 'node:util';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getPgClient } from '../lib/supabase.js';

// --- Policy constants -------------------------------------------------------

// SKUs the engine reorders for. discontinued / on_hold / unknown are skipped
// (listed in the report) — a discontinued SKU should not get a fresh PO.
const ELIGIBLE_STATUSES = new Set(['active', 'seasonal', 'new_launch']);
// Launch SKUs have no meaningful trailing margin yet — exempt from the gate.
const MARGIN_EXEMPT_STATUSES = new Set(['new_launch']);

const SAFETY_DAYS = 28;   // /restock-memo §6: +4 weeks safety
const CYCLE_DAYS = 28;    // /restock-memo §6: +4 weeks reorder cycle

// Marketplace country -> demand region. Only GB/US carry stock today; the rest
// are listed so the mapping is correct if EU/CA/MX inventory starts flowing.
const UK_EU_COUNTRIES = new Set(['GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'PL', 'TR']);
const NA_COUNTRIES = new Set(['US', 'CA', 'MX']);

// Forecast market -> demand region. 'ukw' (UK website / MFN) is informational
// only — its fulfilment route is unresolved, so it is not in the reorder gap.
const FORECAST_REGION: Record<string, 'uk_eu' | 'na' | null> = {
  uk: 'uk_eu', eu: 'uk_eu', usa: 'na', ukw: null,
};

const TREND_UP = 1.2;     // 7d run-rate / 30d run-rate thresholds
const TREND_DOWN = 0.8;

// --- Date helpers (all UTC, to keep month maths timezone-clean) -------------

const DAY = 86_400_000;
function ymdToUtc(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}
function utcToYmd(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}
function firstOfMonth(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function addMonths(t: number, n: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
}
function daysInMonth(t: number): number {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

// Demand over [windowStart, windowStart + windowDays), pro-rated month by month
// from a monthly forecast. Pro-rating assumes flat intra-month demand — only
// the partial first/last months are affected.
function demandOverWindow(
  monthly: Map<string, number>, windowStartT: number, windowDays: number,
): number {
  const windowEnd = windowStartT + windowDays * DAY;
  let total = 0;
  let cur = firstOfMonth(windowStartT);
  while (cur < windowEnd) {
    const monthEnd = addMonths(cur, 1);
    const dim = daysInMonth(cur);
    const overlapStart = Math.max(cur, windowStartT);
    const overlapEnd = Math.min(monthEnd, windowEnd);
    const overlapDays = Math.max(0, (overlapEnd - overlapStart) / DAY);
    total += (monthly.get(utcToYmd(cur)) ?? 0) * overlapDays / dim;
    cur = monthEnd;
  }
  return total;
}

// --- Misc helpers -----------------------------------------------------------

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const fmt = (n: number): string => Math.round(n).toLocaleString('en-GB');
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

// --- Types ------------------------------------------------------------------

interface TermsRow {
  ean: string; asin: string | null; brand: string | null; sku_status: string;
  cogs_landed: number | null; cogs_currency: string | null; fba_fee: number | null;
  effective_moq: number | null; effective_lead_time_days: number | null;
  supplier_id: string | null; supplier_name: string | null;
  supplier_invoice_currency: string | null; seller_sku: string | null;
}
interface InvRow {
  marketplace_id: string; country_code: string; asin: string; product_name: string | null;
  afn_fulfillable_quantity: number; afn_reserved_quantity: number;
  afn_inbound_total: number; units_per_day: number;
}
interface SalesRow {
  asin: string; currency_code: string;
  units_30d: number; units_7d: number; sales_30d: number;
}
interface Warning { message: string; payload: Record<string, unknown>; }

interface SkuResult {
  ean: string; asin: string | null; title: string; brand: string;
  sku_status: string; supplier_id: string; supplier_name: string;
  moq: number; leadTime: number; windowDays: number;
  demandUkEu: number; demandNa: number; ukwDemand: number;
  supplyUkEu: number; supplyNa: number; committedGlobal: number;
  gapUkEu: number; gapNa: number; netGap: number; proposedQty: number;
  demandBasis: 'forecast' | 'velocity'; forecastSnapshot: string | null;
  velocity30d: number; trend: string;
  cogsLanded: number | null; cogsCurrency: string | null; fbaFee: number | null;
  asp: number | null; marginMetric: number | null;
  marginStatus: 'pass' | 'gated' | 'skipped' | 'exempt'; marginKind: 'cm3' | 'proxy' | null;
  dupPool: boolean;
}
interface Skipped { ean: string; title: string; reason: string; }

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run':       { type: 'boolean', default: false },
      'report-path':   { type: 'string' },
      'weeks':         { type: 'string' },
      'cm3-threshold': { type: 'string', default: '0.10' },
      'margin-floor':  { type: 'string', default: '0.15' },
    },
  });

  const dryRun = !!values['dry-run'];
  const cm3Threshold = Number(values['cm3-threshold']);
  const marginFloor = Number(values['margin-floor']);
  const weeksOverride = values['weeks'] !== undefined ? Number(values['weeks']) : null;

  for (const [name, v] of [
    ['--cm3-threshold', cm3Threshold], ['--margin-floor', marginFloor],
  ] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      console.error(`Error: ${name} must be a fraction between 0 and 1.`);
      process.exit(1);
    }
  }
  if (weeksOverride !== null && (!Number.isFinite(weeksOverride) || weeksOverride <= 0)) {
    console.error('Error: --weeks must be a positive number.');
    process.exit(1);
  }

  const runDate = new Date().toISOString().slice(0, 10);
  const windowStartT = ymdToUtc(runDate);

  console.log('operator-datacore — restock engine (generate-pos)');
  console.log('-------------------------------------------------');
  console.log(`  Run date:       ${runDate}`);
  console.log(`  Dry-run:        ${dryRun}`);
  console.log(`  CM3 threshold:  ${pct(cm3Threshold)}   Margin floor: ${pct(marginFloor)}`);
  console.log(`  Cover window:   ${weeksOverride !== null
    ? `${weeksOverride} weeks (flat)` : 'lead time + 8 weeks (per SKU)'}`);
  console.log('');

  const pg = await getPgClient();
  const warnings: Warning[] = [];
  try {
    // --- Read everything --------------------------------------------------
    const terms = (await pg.query<TermsRow>(
      `SELECT ean, asin, brand, sku_status,
              cogs_landed::float8 AS cogs_landed, btrim(cogs_currency) AS cogs_currency,
              fba_fee::float8 AS fba_fee, effective_moq, effective_lead_time_days,
              supplier_id, supplier_name,
              btrim(supplier_invoice_currency) AS supplier_invoice_currency, seller_sku
       FROM brain.sku_effective_terms`,
    )).rows;

    // Reads the ASIN-aggregated view (migration 0020). One row per
    // (marketplace, asin), NewItem-only, fulfillable already summed across
    // distinct FNSKUs. The per-region aggregation below sums across
    // marketplaces inside each region (UK_EU = UK+DE+FR+IT+ES, NA = US).
    const inv = (await pg.query<InvRow>(
      `SELECT marketplace_id, btrim(country_code) AS country_code, asin, product_name,
              afn_fulfillable_quantity, afn_reserved_quantity, afn_inbound_total,
              units_per_day::float8 AS units_per_day
       FROM analytics.inventory_health_by_asin
       WHERE snapshot_date = (SELECT max(snapshot_date) FROM analytics.inventory_health_by_asin)`,
    )).rows;

    const forecast = (await pg.query<{
      ean: string; market: string; forecast_month: string;
      units_forecast: number; snapshot_date: string;
    }>(
      `SELECT ean, market, to_char(forecast_month,'YYYY-MM-DD') AS forecast_month,
              units_forecast::float8 AS units_forecast,
              to_char(snapshot_date,'YYYY-MM-DD') AS snapshot_date
       FROM analytics.demand_forecast_current`,
    )).rows;

    const committed = (await pg.query<{
      asin: string; serves_region: string; committed_clean_units: number;
    }>(
      `SELECT asin, serves_region, committed_clean_units::float8 AS committed_clean_units
       FROM brain.po_committed_inventory`,
    )).rows;

    const sales = (await pg.query<SalesRow>(
      `WITH m AS (SELECT max(metric_date) AS md FROM brain.sales_traffic_daily)
       SELECT child_asin AS asin, btrim(currency_code) AS currency_code,
              COALESCE(SUM(units_ordered),0)::float8 AS units_30d,
              COALESCE(SUM(units_ordered) FILTER (
                WHERE metric_date > (SELECT md FROM m) - INTERVAL '7 days'),0)::float8 AS units_7d,
              COALESCE(SUM(ordered_product_sales),0)::float8 AS sales_30d
       FROM brain.sales_traffic_daily, m
       WHERE child_asin IS NOT NULL
         AND metric_date > m.md - INTERVAL '30 days'
       GROUP BY child_asin, btrim(currency_code)`,
    )).rows;

    const existingRx = new Map<string, string>();
    for (const r of (await pg.query<{ po_number: string; status: string }>(
      "SELECT po_number, status FROM brain.purchase_orders WHERE po_number LIKE 'RX-%'",
    )).rows) existingRx.set(r.po_number, r.status);

    // --- Index the reference data ----------------------------------------
    const titleByAsin = new Map<string, string>();
    const invByAsinRegion = new Map<string, { fulfInbound: number }>();
    const velByAsinRegion = new Map<string, number>();   // per-marketplace upd, summed
    const seenVelKey = new Set<string>();                // (asin|region|marketplace) dedup
    const dupPoolAsins = new Set<string>();
    const poolSig = new Map<string, Set<string>>();      // (asin|region) -> fulfillable:reserved sigs
    for (const r of inv) {
      const region = UK_EU_COUNTRIES.has(r.country_code) ? 'uk_eu'
        : NA_COUNTRIES.has(r.country_code) ? 'na' : null;
      if (!region) continue;
      if (r.product_name && !titleByAsin.has(r.asin)) titleByAsin.set(r.asin, r.product_name);
      const key = `${r.asin}|${region}`;
      const agg = invByAsinRegion.get(key) ?? { fulfInbound: 0 };
      agg.fulfInbound += num(r.afn_fulfillable_quantity) + num(r.afn_inbound_total);
      invByAsinRegion.set(key, agg);
      // Velocity: units_per_day is identical across SKU-alias rows of the same
      // (asin, marketplace) — count it once per marketplace.
      const velKey = `${r.asin}|${region}|${r.marketplace_id}`;
      if (!seenVelKey.has(velKey)) {
        seenVelKey.add(velKey);
        velByAsinRegion.set(key, (velByAsinRegion.get(key) ?? 0) + num(r.units_per_day));
      }
      // Duplicate-pool: 2+ rows in a region with identical fulfillable+reserved.
      if (num(r.afn_fulfillable_quantity) > 0) {
        const sig = `${r.afn_fulfillable_quantity}:${r.afn_reserved_quantity}`;
        const sigs = poolSig.get(key) ?? new Set<string>();
        if (sigs.has(sig)) dupPoolAsins.add(r.asin);
        sigs.add(sig);
        poolSig.set(key, sigs);
      }
    }

    // Forecast: per EAN, per region, a month -> units map; plus ukw separately.
    const fcByEan = new Map<string, {
      region: Map<'uk_eu' | 'na', Map<string, number>>; ukw: Map<string, number>;
      snapshot: string;
    }>();
    for (const f of forecast) {
      const region = FORECAST_REGION[f.market];
      let e = fcByEan.get(f.ean);
      if (!e) {
        e = { region: new Map(), ukw: new Map(), snapshot: f.snapshot_date };
        fcByEan.set(f.ean, e);
      }
      if (region) {
        const rm = e.region.get(region) ?? new Map<string, number>();
        rm.set(f.forecast_month, (rm.get(f.forecast_month) ?? 0) + num(f.units_forecast));
        e.region.set(region, rm);
      } else if (f.market === 'ukw') {
        e.ukw.set(f.forecast_month, (e.ukw.get(f.forecast_month) ?? 0) + num(f.units_forecast));
      }
    }

    const committedByAsin = new Map<string, Map<string, number>>();
    for (const c of committed) {
      const m = committedByAsin.get(c.asin) ?? new Map<string, number>();
      m.set(c.serves_region, (m.get(c.serves_region) ?? 0) + num(c.committed_clean_units));
      committedByAsin.set(c.asin, m);
    }

    // Sales: per asin -> currency -> {units30, units7, sales30}.
    const salesByAsin = new Map<string, Map<string, SalesRow>>();
    for (const s of sales) {
      const m = salesByAsin.get(s.asin) ?? new Map<string, SalesRow>();
      m.set(s.currency_code, s);
      salesByAsin.set(s.asin, m);
    }

    // --- Classify the catalogue + compute per eligible SKU ----------------
    const results: SkuResult[] = [];
    const skipped: Skipped[] = [];
    const missingLeadTime: string[] = [];
    for (const t of terms) {
      const title = (t.asin && titleByAsin.get(t.asin))
        || `${t.brand ?? ''} ${t.seller_sku ?? t.asin ?? t.ean}`.trim();
      if (!ELIGIBLE_STATUSES.has(t.sku_status)) {
        skipped.push({ ean: t.ean, title, reason: `status '${t.sku_status}'` });
        continue;
      }
      if (!t.supplier_id) {
        skipped.push({ ean: t.ean, title, reason: 'no supplier' });
        continue;
      }
      if (t.effective_moq === null) {
        skipped.push({ ean: t.ean, title, reason: 'no MOQ' });
        continue;
      }
      if (t.effective_lead_time_days === null) {
        skipped.push({ ean: t.ean, title, reason: 'no lead time' });
        missingLeadTime.push(t.ean);
        continue;
      }

      const leadTime = t.effective_lead_time_days;
      const windowDays = weeksOverride !== null
        ? Math.round(weeksOverride * 7)
        : leadTime + SAFETY_DAYS + CYCLE_DAYS;

      // Demand — forecast if the SKU has any uk/eu/usa rows, else flat velocity.
      const fc = fcByEan.get(t.ean);
      const hasForecast = !!fc && (fc.region.get('uk_eu')?.size || fc.region.get('na')?.size);
      let demandUkEu = 0, demandNa = 0, ukwDemand = 0;
      let demandBasis: 'forecast' | 'velocity' = 'velocity';
      let forecastSnapshot: string | null = null;
      if (hasForecast && fc) {
        demandBasis = 'forecast';
        forecastSnapshot = fc.snapshot;
        demandUkEu = demandOverWindow(fc.region.get('uk_eu') ?? new Map(), windowStartT, windowDays);
        demandNa = demandOverWindow(fc.region.get('na') ?? new Map(), windowStartT, windowDays);
        ukwDemand = demandOverWindow(fc.ukw, windowStartT, windowDays);
      } else if (t.asin) {
        demandUkEu = (velByAsinRegion.get(`${t.asin}|uk_eu`) ?? 0) * windowDays;
        demandNa = (velByAsinRegion.get(`${t.asin}|na`) ?? 0) * windowDays;
      }

      // Supply per region = on-hand + Amazon inbound + clean committed POs.
      const cm = t.asin ? committedByAsin.get(t.asin) : undefined;
      const supplyUkEu = (t.asin ? invByAsinRegion.get(`${t.asin}|uk_eu`)?.fulfInbound ?? 0 : 0)
        + (cm?.get('uk_eu') ?? 0);
      const supplyNa = (t.asin ? invByAsinRegion.get(`${t.asin}|na`)?.fulfInbound ?? 0 : 0)
        + (cm?.get('na') ?? 0);
      const committedGlobal = cm?.get('global') ?? 0;

      // Region-correct gap — each region floored at zero BEFORE summing, so a
      // surplus in one region cannot cancel a shortage in the other.
      const gapUkEu = Math.max(demandUkEu - supplyUkEu, 0);
      const gapNa = Math.max(demandNa - supplyNa, 0);
      const netGap = Math.max(gapUkEu + gapNa - committedGlobal, 0);
      const moq = t.effective_moq;
      const proposedQty = netGap <= 0 ? 0
        : moq > 0 ? Math.ceil(netGap / moq) * moq : Math.ceil(netGap);

      // Performance: 30d velocity + 7d-vs-30d trend, from sales_traffic_daily.
      const sm = t.asin ? salesByAsin.get(t.asin) : undefined;
      let units30 = 0, units7 = 0;
      if (sm) for (const s of sm.values()) { units30 += s.units_30d; units7 += s.units_7d; }
      const velocity30d = units30 / 30;
      const rate30 = units30 / 30, rate7 = units7 / 7;
      const trend = rate30 <= 0 ? 'n/a'
        : rate7 / rate30 >= TREND_UP ? 'up'
        : rate7 / rate30 <= TREND_DOWN ? 'down' : 'flat';

      // Margin gate — always on. fba_fee present -> real CM3; else gross-margin
      // proxy. Either needs an ASP in the same currency as cogs_landed.
      const aspRow = sm && t.cogs_currency ? sm.get(t.cogs_currency) : undefined;
      const asp = aspRow && aspRow.units_30d > 0 ? aspRow.sales_30d / aspRow.units_30d : null;
      let marginStatus: SkuResult['marginStatus'] = 'pass';
      let marginKind: SkuResult['marginKind'] = null;
      let marginMetric: number | null = null;
      if (MARGIN_EXEMPT_STATUSES.has(t.sku_status)) {
        marginStatus = 'exempt';
      } else if (asp === null || t.cogs_landed === null) {
        marginStatus = 'skipped';
      } else if (t.fba_fee !== null) {
        marginKind = 'cm3';
        marginMetric = (asp - t.cogs_landed - t.fba_fee) / asp;
        marginStatus = marginMetric < cm3Threshold ? 'gated' : 'pass';
      } else {
        marginKind = 'proxy';
        marginMetric = (asp - t.cogs_landed) / asp;
        marginStatus = marginMetric < marginFloor ? 'gated' : 'pass';
      }

      results.push({
        ean: t.ean, asin: t.asin, title, brand: t.brand ?? '', sku_status: t.sku_status,
        supplier_id: t.supplier_id, supplier_name: t.supplier_name ?? t.supplier_id,
        moq, leadTime, windowDays, demandUkEu, demandNa, ukwDemand,
        supplyUkEu, supplyNa, committedGlobal, gapUkEu, gapNa, netGap, proposedQty,
        demandBasis, forecastSnapshot, velocity30d, trend,
        cogsLanded: t.cogs_landed, cogsCurrency: t.cogs_currency, fbaFee: t.fba_fee,
        asp, marginMetric, marginStatus, marginKind,
        dupPool: !!(t.asin && dupPoolAsins.has(t.asin)),
      });
    }

    // --- Partition ---------------------------------------------------------
    const triggering = results.filter((r) => r.netGap > 0);
    const proposed = triggering.filter((r) => r.marginStatus !== 'gated');
    const marginGated = triggering.filter((r) => r.marginStatus === 'gated');
    const fallbackCount = proposed.filter((r) => r.demandBasis === 'velocity').length;

    // Group proposed SKUs by supplier -> one draft PO each.
    const bySupplier = new Map<string, SkuResult[]>();
    for (const r of proposed) {
      (bySupplier.get(r.supplier_id) ?? bySupplier.set(r.supplier_id, []).get(r.supplier_id)!)
        .push(r);
    }

    // Collect warnings worth a sync_log row.
    if (missingLeadTime.length) {
      warnings.push({
        message: `${missingLeadTime.length} eligible SKU(s) skipped — missing effective_lead_time_days`,
        payload: { eans: missingLeadTime },
      });
    }
    for (const s of skipped.filter((x) => x.reason === 'no supplier' || x.reason === 'no MOQ')) {
      warnings.push({ message: `${s.ean} skipped — ${s.reason}`, payload: { ean: s.ean } });
    }
    const dupPoolHits = [...new Set(proposed.filter((r) => r.dupPool).map((r) => r.ean))];
    if (dupPoolHits.length) {
      warnings.push({
        message: `${dupPoolHits.length} proposed SKU(s) have a duplicate-pool inventory signature — verify supply is not double-counted`,
        payload: { eans: dupPoolHits },
      });
    }

    console.log(`Catalogue: ${terms.length} SKUs — ${results.length} evaluated, `
      + `${skipped.length} skipped.`);
    console.log(`Triggering a reorder: ${triggering.length}  `
      + `(${proposed.length} proposed, ${marginGated.length} margin-gated)`);
    console.log(`Draft POs: ${bySupplier.size} supplier(s).  `
      + `Forecast fallback (flat velocity): ${fallbackCount} SKU(s).`);
    console.log('');

    // Sanity gate for the PR1 dry-run check.
    if (results.length > 0 && triggering.length / results.length > 0.7) {
      console.log('WARNING: more than 70% of the evaluated catalogue is triggering a '
        + 'reorder — check the inventory snapshot and committed-PO reads before trusting this run.');
      console.log('');
    }

    // --- Bookkeeping + write (skipped entirely under --dry-run) -----------
    let syncRunId: string | null = null;
    let linesWritten = 0;
    const poNumberBySupplier = new Map<string, string>();

    if (!dryRun && bySupplier.size > 0) {
      const { rows: connRows } = await pg.query<{ connection_id: string }>(
        `INSERT INTO meta.connection (source, label, status)
         VALUES ('operator_local', 'restock-engine', 'active')
         ON CONFLICT (source, label) DO UPDATE
           SET updated_at = NOW(), last_health_check_at = NOW(), last_health_check_ok = TRUE
         RETURNING connection_id`,
      );
      const { rows: runRows } = await pg.query<{ sync_run_id: string }>(
        `INSERT INTO meta.sync_run (connection_id, source, object, mode)
         VALUES ($1, 'operator_local', 'restock_engine', 'manual')
         RETURNING sync_run_id`,
        [connRows[0]!.connection_id],
      );
      syncRunId = runRows[0]!.sync_run_id;
      const runFrag = syncRunId.replace(/-/g, '').slice(0, 8);
      const startedAt = Date.now();

      try {
        await pg.query('BEGIN');
        await pg.query(`SET LOCAL app.change_source = 'restock_engine:${syncRunId}'`);

        // Idempotency: expire (don't delete) the engine's own still-draft POs,
        // so any operator context on an un-promoted draft survives as an audit
        // trail instead of vanishing every run. POs the operator promoted out of
        // draft are real now — left untouched (WHERE status = 'draft'). We also
        // suffix the archived po_number with a timestamp: po_number is UNIQUE, so
        // freeing the clean base number (e.g. RX-SUP-016) lets this run's fresh
        // draft reuse it without a collision.
        await pg.query(
          `UPDATE brain.purchase_orders
              SET status    = 'expired',
                  po_number = po_number || '-exp-'
                              || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS')
            WHERE source_system = 'restock_engine' AND status = 'draft'`,
        );

        const suppliers = [...bySupplier.entries()]
          .sort((a, b) => a[1][0]!.supplier_name.localeCompare(b[1][0]!.supplier_name));
        for (const [supplierId, skus] of suppliers) {
          // Provisional PO number — stable per supplier; suffixed only if a
          // non-draft PO already claims it (operator promoted without renaming).
          let poNumber = `RX-${supplierId}`;
          const clash = existingRx.get(poNumber);
          if (clash && clash !== 'draft') poNumber = `${poNumber}-${runFrag}`;
          poNumberBySupplier.set(supplierId, poNumber);

          const currency = skus.find((s) => s.cogsCurrency)?.cogsCurrency ?? 'GBP';
          const supplierCcy = terms.find((t) => t.supplier_id === supplierId
            && t.supplier_invoice_currency)?.supplier_invoice_currency ?? currency;

          // Pre-compute the line split so the PO summary note is accurate.
          // Each SKU produces 1 or 2 lines depending on which regions have a
          // non-zero gap.
          const splits = skus.map((r) => ({ r, split: splitQty(r) }));
          const totalLines = splits.reduce((sum, s) =>
            sum + (s.split.ukEu > 0 ? 1 : 0) + (s.split.na > 0 ? 1 : 0), 0);

          const { rows: poRows } = await pg.query<{ po_id: string }>(
            `INSERT INTO brain.purchase_orders
               (po_number, supplier_id, status, currency, source_system, source_ref, notes)
             VALUES ($1, $2, 'draft', $3, 'restock_engine', $4, $5)
             RETURNING po_id`,
            [poNumber, supplierId, supplierCcy, syncRunId,
              `Auto-generated by generate-pos on ${runDate} (run ${syncRunId}). `
              + `${skus.length} SKU(s), ${totalLines} line(s) — region-split (uk_eu/na). `
              + 'Review destinations (defaults: uk_eu→fba_direct, na→usa_awd), allocate '
              + 'a real PO number, then promote out of draft.'],
          );
          const poId = poRows[0]!.po_id;

          let lineNo = 0;
          for (const { r, split } of [...splits].sort(
            (a, b) => b.r.netGap - a.r.netGap,
          )) {
            if (split.ukEu > 0) {
              lineNo += 1;
              await pg.query(
                `INSERT INTO brain.purchase_order_lines
                   (po_id, line_no, line_type, ean, asin, description,
                    destination, serves_region, qty_ordered, qty_received, line_status, notes)
                 VALUES ($1, $2, 'product', $3, $4, $5,
                         $6, 'uk_eu', $7, 0, 'open', $8)`,
                [poId, lineNo, r.ean, r.asin, r.title.slice(0, 200),
                  defaultDestination('uk_eu'), split.ukEu,
                  regionLineNote(r, 'uk_eu', split.ukEu)],
              );
              linesWritten += 1;
            }
            if (split.na > 0) {
              lineNo += 1;
              await pg.query(
                `INSERT INTO brain.purchase_order_lines
                   (po_id, line_no, line_type, ean, asin, description,
                    destination, serves_region, qty_ordered, qty_received, line_status, notes)
                 VALUES ($1, $2, 'product', $3, $4, $5,
                         $6, 'na', $7, 0, 'open', $8)`,
                [poId, lineNo, r.ean, r.asin, r.title.slice(0, 200),
                  defaultDestination('na'), split.na,
                  regionLineNote(r, 'na', split.na)],
              );
              linesWritten += 1;
            }
          }
        }

        for (const w of warnings) {
          await pg.query(
            `INSERT INTO meta.sync_log (sync_run_id, level, message, payload)
             VALUES ($1, 'warn', $2, $3)`,
            [syncRunId, w.message, JSON.stringify(w.payload)],
          );
        }
        await pg.query('COMMIT');
      } catch (err) {
        await pg.query('ROLLBACK').catch(() => {});
        throw err;
      }

      // meta.sync_run.duration_ms is a GENERATED column — never write it.
      await pg.query(
        `UPDATE meta.sync_run
           SET finished_at = NOW(), status = 'success', rows_fetched = $2, rows_upserted = $3
         WHERE sync_run_id = $1`,
        [syncRunId, results.length, linesWritten],
      );
      console.log(`Wrote ${linesWritten} draft PO line(s) across ${bySupplier.size} `
        + `PO(s).  sync_run_id ${syncRunId} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    } else if (!dryRun) {
      console.log('No SKU triggered a reorder — no draft POs written.');
    }

    // --- Write the review report (both modes) -----------------------------
    const reportPath = values['report-path']
      ? path.resolve(values['report-path'])
      : path.resolve(process.cwd(),
        '../../knowledge-vault/RW-AI-OS-Obsidian/wiki/restock',
        `${runDate}-reorder-proposals.md`);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, buildReport({
      runDate, dryRun, syncRunId, weeksOverride, cm3Threshold, marginFloor,
      evaluated: results.length, skipped, triggering, proposed, marginGated,
      bySupplier, poNumberBySupplier, fallbackCount, dupPoolHits, missingLeadTime,
    }), 'utf8');
    console.log(`Report written: ${reportPath}`);

    if (dryRun) {
      console.log('');
      console.log('--dry-run — no database writes. The report above is a preview.');
    }
  } catch (err) {
    console.error('generate-pos failed:', err);
    process.exit(1);
  } finally {
    await pg.end();
  }
}

// Per-line notes string — the per-region breakdown the operator splits from.
/**
 * Split the SKU's proposedQty across regions in proportion to each region's
 * gap. Excess units from MOQ rounding (proposedQty > netGap) land on the
 * larger-gap region. Returns whole-unit counts that sum to exactly
 * `r.proposedQty`.
 *
 * Either ukEu or na may be 0 — caller iterates non-zero pieces.
 */
function splitQty(r: SkuResult): { ukEu: number; na: number } {
  if (r.gapUkEu === 0) return { ukEu: 0, na: r.proposedQty };
  if (r.gapNa === 0)   return { ukEu: r.proposedQty, na: 0 };
  // Both regions have a gap. Round-down the smaller-gap region; the larger
  // gets the remainder (so MOQ excess lands where it does more work).
  if (r.gapUkEu >= r.gapNa) {
    const na = Math.floor((r.gapNa / r.netGap) * r.proposedQty);
    return { ukEu: r.proposedQty - na, na };
  }
  const ukEu = Math.floor((r.gapUkEu / r.netGap) * r.proposedQty);
  return { ukEu, na: r.proposedQty - ukEu };
}

/**
 * Default landing destination per region. v2 chooses the dominant historical
 * pattern (read from placed POs 2026-06-01): UK/EU lines → fba_direct (45/65
 * UK lines), NA lines → usa_awd (the only NA option). Operator overrides at
 * review — flip a UK line to uk_3pl_lemonpath if 3PL landing is preferred.
 */
function defaultDestination(region: 'uk_eu' | 'na'): string {
  return region === 'uk_eu' ? 'fba_direct' : 'usa_awd';
}

/**
 * Region-specific note for a per-region PO line. Leads with this line's
 * gap + qty, then the cross-region context (sibling region, aggregate
 * MOQ math) and the shared demand/margin info.
 */
function regionLineNote(r: SkuResult, region: 'uk_eu' | 'na', qty: number): string {
  const basis = r.demandBasis === 'forecast'
    ? `forecast snapshot ${r.forecastSnapshot}`
    : 'flat 30d velocity (no forecast rows)';
  const margin = r.marginStatus === 'exempt' ? 'margin gate exempt (launch)'
    : r.marginStatus === 'skipped' ? 'margin check skipped (no same-currency ASP)'
    : r.marginKind === 'cm3' ? `CM3 ${pct(r.marginMetric ?? 0)}`
    : `gross-margin proxy ${pct(r.marginMetric ?? 0)} (CM3 unavailable — fba_fee not loaded)`;
  const cross = region === 'uk_eu'
    ? `Sibling NA gap ${fmt(r.gapNa)}`
    : `Sibling UK/EU gap ${fmt(r.gapUkEu)}`;
  const self = region === 'uk_eu'
    ? `UK/EU line: ${fmt(qty)} units. UK/EU gap ${fmt(r.gapUkEu)} (demand ${fmt(r.demandUkEu)} / supply ${fmt(r.supplyUkEu)}).`
    : `NA line: ${fmt(qty)} units. NA gap ${fmt(r.gapNa)} (demand ${fmt(r.demandNa)} / supply ${fmt(r.supplyNa)}).`;
  return `${self} ${cross}; aggregate net ${fmt(r.netGap)} -> ${fmt(r.proposedQty)} (MOQ ${fmt(r.moq)}). `
    + `Demand: ${basis}. Velocity ${r.velocity30d.toFixed(1)}/day, trend ${r.trend}. ${margin}.`
    + (r.dupPool ? ' WARNING: duplicate-pool inventory signature — verify supply.' : '');
}

interface ReportInput {
  runDate: string; dryRun: boolean; syncRunId: string | null;
  weeksOverride: number | null; cm3Threshold: number; marginFloor: number;
  evaluated: number; skipped: Skipped[];
  triggering: SkuResult[]; proposed: SkuResult[]; marginGated: SkuResult[];
  bySupplier: Map<string, SkuResult[]>; poNumberBySupplier: Map<string, string>;
  fallbackCount: number; dupPoolHits: string[]; missingLeadTime: string[];
}

function buildReport(d: ReportInput): string {
  const L: string[] = [];
  L.push('---');
  L.push('type: restock-run');
  L.push(`date: ${d.runDate}`);
  L.push('status: for-review');
  L.push('generated_by: generate-pos');
  L.push('tags: [restock, auto-po, for-review]');
  L.push('---');
  L.push('');
  L.push(`# Reorder proposals — ${d.runDate}`);
  L.push('');
  L.push('Generated by the restock engine (`npm run generate-pos`). These are **draft POs '
    + 'for review** — not placed orders. Each SKU lands as **one or two lines** — one for '
    + 'UK/EU and one for NA, depending on which region has a gap. Default destinations are '
    + 'pre-filled (`uk_eu`→`fba_direct`, `na`→`usa_awd`); flip a UK line to '
    + '`uk_3pl_lemonpath` at review if 3PL landing is preferred. Allocate a real PO '
    + 'number and promote each PO you approve. Un-promoted engine drafts are expired '
    + '(archived) and regenerated on the next run — promote a draft before editing it.');
  L.push('');
  if (d.dryRun) {
    L.push('> **DRY RUN** — no draft POs were written to the database. This report is a preview.');
    L.push('');
  }

  const suppliers = [...d.bySupplier.entries()]
    .sort((a, b) => a[1][0]!.supplier_name.localeCompare(b[1][0]!.supplier_name));

  // Estimated value, grouped by cogs currency.
  const valueByCcy = new Map<string, number>();
  for (const r of d.proposed) {
    if (r.cogsLanded === null || !r.cogsCurrency) continue;
    valueByCcy.set(r.cogsCurrency,
      (valueByCcy.get(r.cogsCurrency) ?? 0) + r.proposedQty * r.cogsLanded);
  }
  const valueStr = valueByCcy.size
    ? [...valueByCcy].map(([c, v]) => `${c} ${fmt(v)}`).join(' + ')
    : 'n/a';
  const snapshots = [...new Set(d.proposed
    .filter((r) => r.demandBasis === 'forecast').map((r) => r.forecastSnapshot))];

  L.push('## Summary');
  L.push('');
  L.push(`- SKUs evaluated: **${d.evaluated}**`);
  L.push(`- Triggering a reorder: **${d.triggering.length}** `
    + `→ **${d.proposed.length}** proposed across **${suppliers.length}** draft PO(s)`);
  L.push(`- Margin-gated (not proposed): **${d.marginGated.length}**`);
  L.push(`- Skipped (ineligible): **${d.skipped.length}**`);
  L.push(`- Forecast snapshot: ${snapshots.join(', ') || 'n/a'} `
    + `(${d.fallbackCount} SKU(s) on flat-velocity fallback)`);
  L.push(`- Estimated value (rough, from cogs_landed): **${valueStr}**`);
  L.push(`- Cover window: ${d.weeksOverride !== null
    ? `${d.weeksOverride} weeks (flat)` : 'lead time + 8 weeks, per SKU'}; `
    + `margin gate: CM3 < ${pct(d.cm3Threshold)} or proxy < ${pct(d.marginFloor)}`);
  L.push('');
  L.push('> Demand pro-rating assumes flat intra-month demand — a cover window running into '
    + 'a high-season month slightly under-weights its tail. The per-SKU total pools no '
    + 'regions: UK/EU and NA gaps are computed separately and floored at zero before summing.');
  L.push('');

  if (suppliers.length === 0) {
    L.push('No SKU triggered a reorder this run.');
    L.push('');
  }

  for (const [supplierId, skus] of suppliers) {
    const poNumber = d.poNumberBySupplier.get(supplierId) ?? `RX-${supplierId}`;
    const name = skus[0]!.supplier_name;
    L.push(`## ${poNumber} — ${name}`);
    L.push('');
    L.push('| SKU | UK/EU need (dem/avail) | NA need (dem/avail) | Net gap | Proposed | '
      + '30d vel | Trend | Margin | Demand basis |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of [...skus].sort((a, b) => b.netGap - a.netGap)) {
      const margin = r.marginStatus === 'exempt' ? 'exempt (launch)'
        : r.marginStatus === 'skipped' ? 'n/a'
        : r.marginKind === 'cm3' ? `CM3 ${pct(r.marginMetric ?? 0)}`
        : `proxy ${pct(r.marginMetric ?? 0)}`;
      const basis = r.demandBasis === 'forecast'
        ? `forecast ${r.forecastSnapshot}`
        : 'flat velocity (no forecast)';
      const skuLabel = `${r.title}<br>\`${r.ean}\`${r.dupPool ? ' ⚠ dup-pool' : ''}`;
      L.push(`| ${skuLabel} `
        + `| ${fmt(r.gapUkEu)} (${fmt(r.demandUkEu)}/${fmt(r.supplyUkEu)}) `
        + `| ${fmt(r.gapNa)} (${fmt(r.demandNa)}/${fmt(r.supplyNa)}) `
        + `| ${fmt(r.netGap)} | **${fmt(r.proposedQty)}** | ${r.velocity30d.toFixed(1)} `
        + `| ${r.trend} | ${margin} | ${basis} |`);
    }
    const ukw = skus.filter((r) => r.ukwDemand > 0);
    if (ukw.length) {
      L.push('');
      L.push(`> ${ukw.length} SKU(s) also have UK-website (ukw) demand over the window, `
        + 'not included in the gap — fulfilment route unresolved: '
        + ukw.map((r) => `${r.ean} (${fmt(r.ukwDemand)})`).join(', ') + '.');
    }
    L.push('');
  }

  if (d.marginGated.length) {
    L.push('## Margin-gated — needed but not proposed');
    L.push('');
    L.push('These SKUs are short on stock but failed the margin gate. Review pricing or '
      + 'costs before reordering.');
    L.push('');
    L.push('| SKU | Net gap | Margin | ASP basis |');
    L.push('|---|---|---|---|');
    for (const r of [...d.marginGated].sort((a, b) => b.netGap - a.netGap)) {
      const margin = r.marginKind === 'cm3'
        ? `CM3 ${pct(r.marginMetric ?? 0)}` : `proxy ${pct(r.marginMetric ?? 0)}`;
      L.push(`| ${r.title} \`${r.ean}\` | ${fmt(r.netGap)} | ${margin} `
        + `| ${r.cogsCurrency ?? '?'} ASP ${r.asp !== null ? fmt(r.asp) : 'n/a'} |`);
    }
    L.push('');
  }

  if (d.skipped.length) {
    L.push('## Skipped — not evaluated');
    L.push('');
    const byReason = new Map<string, Skipped[]>();
    for (const s of d.skipped) {
      (byReason.get(s.reason) ?? byReason.set(s.reason, []).get(s.reason)!).push(s);
    }
    for (const [reason, list] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
      L.push(`- **${reason}** — ${list.length} SKU(s)`
        + (reason === 'no lead time' || reason === 'no supplier' || reason === 'no MOQ'
          ? ` (data gap — fix the supplier/SKU row): ${list.map((s) => s.ean).join(', ')}`
          : ''));
    }
    L.push('');
  }

  L.push('## How to action this');
  L.push('');
  L.push('1. Review each draft PO above against your judgement.');
  L.push('2. For a PO you approve: each line already carries a `serves_region` '
    + '(`uk_eu` or `na`) and a default `destination` (`fba_direct` for UK lines, '
    + '`usa_awd` for NA lines). Override the destination on any UK line you would '
    + 'rather land at `uk_3pl_lemonpath`. Rename `po_number` to the real PO number, '
    + 'then promote with `npm run set-po-status`.');
  L.push('3. Anything you do **not** want regenerated next run must be promoted out of '
    + '`draft` first — un-promoted engine drafts are expired (archived to an `expired` '
    + 'row) and rebuilt every run.');
  L.push('');
  L.push(`_Run ${d.syncRunId ?? '(dry-run)'} · generate-pos · operator-datacore_`);
  L.push('');
  return L.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
