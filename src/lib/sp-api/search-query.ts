// ============================================================================
// Brand Analytics — Search Query Performance Report
//
// Report type: GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT
// Response format: JSON
//
// Key facts (see [[amazon-brand-analytics]] memory):
//
//   - 17-month lookback for monthly reports — much longer than the 65-95 day
//     Ads API retention. This is the right tool for YoY query analysis.
//
//   - `asin` reportOption is REQUIRED (confirmed 2026-05-30 via the
//     diagnostic CLI's error doc). One createReport = one
//     (period, marketplace, ASIN) tuple. There is no "all ASINs at once"
//     mode any more.
//
//   - Per-ASIN responses are small (~50-500 KB) — no streaming-parse needed.
//     Original streaming refactor (#56) was solving a problem the per-ASIN
//     requirement made moot; this file is the cleanup.
//
//   - One PERIOD per call (week / month / quarter). dataStartTime and
//     dataEndTime must align to the period boundary or Amazon 400s.
//
//   - Period types: WEEK (Sun-Sat), MONTH (calendar), QUARTER (calendar
//     Q1-Q4).
//
//   - Brand Analytics access requires Brand Registry enrolment + the
//     "Brand Analytics" SP-API role. RW has both.
//
//   - Shares come back as percentages (0-100). We store as fractions
//     (0.0-1.0) for consistency with brain.sales_traffic_daily — same
//     convention as buy-box percentage etc.
// ============================================================================

import { Client as PgClient } from 'pg';
import { readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpApiClient } from './client.js';
import { downloadReportToFile } from './reports.js';
import { getPgClient } from '../supabase.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type SqpPeriodType = 'WEEK' | 'MONTH' | 'QUARTER';

// Conservative default pacing. Amazon's documented quota for SQP
// createReport is 0.0222 req/s (= 1 per 45s) with burst 10. 60s sits
// comfortably under that.
const SQP_MIN_DELAY_MS = 60_000;

interface SearchQueryAsinRow {
  asin?: string;
  startDate?: string;
  endDate?: string;
  searchQueryData?: {
    searchQuery?: string;
    searchQueryScore?: number;
    searchQueryVolume?: number;
  };
  impressionData?: {
    totalQueryImpressionCount?: number;
    asinImpressionCount?: number;
    asinImpressionShare?: number;
  };
  clickData?: {
    totalClickCount?: number;
    asinClickCount?: number;
    asinClickShare?: number;
  };
  cartAddData?: {
    totalCartAddCount?: number;
    asinCartAddCount?: number;
    asinCartAddShare?: number;
  };
  purchaseData?: {
    totalPurchaseCount?: number;
    asinPurchaseCount?: number;
    asinPurchaseShare?: number;
  };
}

interface SqpReportResponse {
  reportSpecification?: unknown;
  dataByAsin?: SearchQueryAsinRow[];
}

// Shares come back as 0-100 percentages; convert to 0.0-1.0 fractions for
// storage consistency with brain.sales_traffic_daily.
const pctToFrac = (n: number | null | undefined): number | null =>
  (n === null || n === undefined) ? null : n / 100;

export interface IngestSqpPeriodOptions {
  spClient: SpApiClient;
  pg: PgClient;
  connectionId: string;
  syncRunId: string;
  marketplaceId: string;
  asin: string;             // required as of 2026-05-30 — Amazon's API rejects without it
  periodType: SqpPeriodType;
  periodStart: Date;        // inclusive, aligned to period boundary
  periodEnd: Date;          // inclusive (23:59:59 at the call site)
}

/**
 * Pull one period's SQP report for ONE (marketplace, ASIN), land the raw
 * payload, upsert per-query rows into brain.search_query_performance.
 *
 * Download path: createReport + poll + streaming download to a temp file
 * (decompressed). Reading + JSON.parse from disk avoids holding two copies
 * of the report body in memory at the same time. SQP responses can be
 * larger than expected for some periods (~hundreds of MB observed during
 * the 2026-05-31 1-ASIN test); the on-disk path is robust regardless of
 * size.
 */
export async function ingestSqpPeriod(opts: IngestSqpPeriodOptions): Promise<{
  rowsUpserted: number;
}> {
  // Choose a temp file path. Use a per-call random suffix to avoid
  // collisions if two CLI processes happen to overlap.
  const tmpRoot = join(tmpdir(), 'operator-datacore-sqp');
  try { mkdirSync(tmpRoot, { recursive: true }); } catch { /* exists */ }
  const tmpPath = join(tmpRoot, `sqp-${opts.marketplaceId}-${opts.asin}-${opts.periodStart.toISOString().slice(0,10)}-${Date.now()}.json`);

  let meta: { reportId: string; reportDocumentId?: string; processingStatus: string };
  let bytesWritten: number;
  try {
    const downloadResult = await downloadReportToFile(opts.spClient, {
      reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
      marketplaceIds: [opts.marketplaceId],
      dataStartTime: opts.periodStart,
      dataEndTime: opts.periodEnd,
      reportOptions: {
        reportPeriod: opts.periodType,
        asin: opts.asin,
      },
    }, tmpPath);
    meta = downloadResult.meta;
    bytesWritten = downloadResult.bytesWritten;

    // Parse from disk. readFileSync is fine for hundreds-of-MB files;
    // it's the redundant in-memory copies in the old runReport path
    // that were the problem.
    const rawText = readFileSync(tmpPath, 'utf8');
    const parsed = JSON.parse(rawText) as SqpReportResponse;
    const rows = parsed.dataByAsin ?? [];

    // 1. Land metadata in raw.sp_api_report — payload as an empty stub
    //    since the real document is on disk for the duration of this call,
    //    and could be huge. The reportDocumentId is preserved so the
    //    original is re-fetchable via Amazon if needed.
    const rawInsert = await opts.pg.query<{ raw_id: number }>(
      `INSERT INTO raw.sp_api_report
        (connection_id, sync_run_id, report_type, report_id, document_id, marketplace_ids,
         data_start_time, data_end_time, processing_status, payload, payload_bytes, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb, $10, NOW())
       ON CONFLICT (report_type, report_id) DO UPDATE
         SET processing_status = EXCLUDED.processing_status, parsed_at = NULL
       RETURNING raw_id`,
      [
        opts.connectionId,
        opts.syncRunId,
        'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
        meta.reportId,
        meta.reportDocumentId ?? null,
        [opts.marketplaceId],
        opts.periodStart.toISOString(),
        opts.periodEnd.toISOString(),
        meta.processingStatus,
        bytesWritten,
      ],
    );
    const rawId = rawInsert.rows[0]!.raw_id;

    return await ingestParsedRows(opts, parsed, rows, rawId);
  } finally {
    // Clean up the temp file regardless of outcome.
    try { unlinkSync(tmpPath); } catch { /* doesn't exist */ }
  }
}

async function ingestParsedRows(
  opts: IngestSqpPeriodOptions,
  _parsed: SqpReportResponse,
  rows: SearchQueryAsinRow[],
  rawId: number,
): Promise<{ rowsUpserted: number }> {

  // 2. Batched UPSERT — typical row count per (ASIN, month) is 50-200, so
  //    one batch covers most cases. Still chunk at 500 to be safe.
  const BATCH_SIZE = 500;
  let rowsUpserted = 0;
  const validRows: Array<{
    asin: string; query: string; startStr: string; endStr: string;
    score: number | null; volume: number | null;
    impressions: number | null; clicks: number | null;
    cartAdds: number | null; purchases: number | null;
    impressionShare: number | null; clickShare: number | null;
    cartAddShare: number | null; purchaseShare: number | null;
  }> = [];

  for (const r of rows) {
    const asin = r.asin;
    const sqd = r.searchQueryData ?? {};
    const query = sqd.searchQuery;
    if (!asin || !query) continue;

    validRows.push({
      asin,
      query,
      startStr: r.startDate ?? opts.periodStart.toISOString().slice(0, 10),
      endStr:   r.endDate   ?? opts.periodEnd.toISOString().slice(0, 10),
      score:           sqd.searchQueryScore ?? null,
      volume:          sqd.searchQueryVolume ?? null,
      impressions:     r.impressionData?.totalQueryImpressionCount ?? null,
      clicks:          r.clickData?.totalClickCount ?? null,
      cartAdds:        r.cartAddData?.totalCartAddCount ?? null,
      purchases:       r.purchaseData?.totalPurchaseCount ?? null,
      impressionShare: pctToFrac(r.impressionData?.asinImpressionShare),
      clickShare:      pctToFrac(r.clickData?.asinClickShare),
      cartAddShare:    pctToFrac(r.cartAddData?.asinCartAddShare),
      purchaseShare:   pctToFrac(r.purchaseData?.asinPurchaseShare),
    });
  }

  for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
    const batch = validRows.slice(i, i + BATCH_SIZE);
    const params: unknown[] = [];
    const valuesClauses: string[] = [];
    for (const v of batch) {
      const idx = params.length;
      params.push(
        opts.periodType, v.startStr, v.endStr, opts.marketplaceId, v.asin, v.query,
        v.score, v.volume,
        v.impressions, v.clicks, v.cartAdds, v.purchases,
        v.impressionShare, v.clickShare, v.cartAddShare, v.purchaseShare,
        rawId,
      );
      const ph = Array.from({ length: 17 }, (_, k) => `$${idx + k + 1}`);
      valuesClauses.push(`(${ph.join(',')}, NOW())`);
    }
    await opts.pg.query(
      `INSERT INTO brain.search_query_performance (
          period_type, period_start, period_end, marketplace_id, asin, search_query,
          search_query_score, search_query_volume,
          impressions, clicks, cart_adds, purchases,
          impression_share, click_share, cart_add_share, purchase_share,
          raw_id, ingested_at
       ) VALUES ${valuesClauses.join(',')}
       ON CONFLICT (period_type, period_start, marketplace_id, asin, search_query) DO UPDATE SET
         period_end           = EXCLUDED.period_end,
         search_query_score   = EXCLUDED.search_query_score,
         search_query_volume  = EXCLUDED.search_query_volume,
         impressions          = EXCLUDED.impressions,
         clicks               = EXCLUDED.clicks,
         cart_adds            = EXCLUDED.cart_adds,
         purchases            = EXCLUDED.purchases,
         impression_share     = EXCLUDED.impression_share,
         click_share          = EXCLUDED.click_share,
         cart_add_share       = EXCLUDED.cart_add_share,
         purchase_share       = EXCLUDED.purchase_share,
         raw_id               = EXCLUDED.raw_id,
         ingested_at          = NOW()`,
      params,
    );
    rowsUpserted += batch.length;
  }

  await opts.pg.query(
    'UPDATE raw.sp_api_report SET parsed_at = NOW() WHERE raw_id = $1',
    [rawId],
  );

  return { rowsUpserted };
}

// ----------------------------------------------------------------------------
// Period helpers — align dates to Amazon's boundary expectations.
// ----------------------------------------------------------------------------

export function monthPeriod(d: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59));
  return { start, end };
}

export function quarterPeriod(d: Date): { start: Date; end: Date } {
  const qStartMonth = Math.floor(d.getUTCMonth() / 3) * 3;
  const start = new Date(Date.UTC(d.getUTCFullYear(), qStartMonth, 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), qStartMonth + 3, 0, 23, 59, 59));
  return { start, end };
}

export function weekPeriod(d: Date): { start: Date; end: Date } {
  const day = d.getUTCDay();
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  const end = new Date(start.getTime() + 6 * 86_400_000 + (86_400_000 - 1));
  return { start, end };
}

export function listPeriods(periodType: SqpPeriodType, fromDate: Date, toDate: Date): Array<{ start: Date; end: Date }> {
  const align = periodType === 'WEEK' ? weekPeriod
              : periodType === 'MONTH' ? monthPeriod
              : quarterPeriod;
  const periods: Array<{ start: Date; end: Date }> = [];
  let cursor = align(fromDate);
  while (cursor.start <= toDate) {
    periods.push(cursor);
    const nextStart = new Date(cursor.end.getTime() + 1);
    cursor = align(nextStart);
  }
  return periods;
}

// ----------------------------------------------------------------------------
// Backfill — iterate (period × marketplace × ASIN) with keepalive.
// ----------------------------------------------------------------------------

export interface BackfillSqpOptions {
  spClient: SpApiClient;
  pg: PgClient;
  connectionId: string;
  syncRunId: string;
  marketplaceIds: string[];
  asins: string[];                   // required — see header notes
  periodType: SqpPeriodType;
  fromDate: Date;
  toDate: Date;
  /** Override the 60s minimum pace. Floor is enforced. */
  delayMs?: number;
  /** Set of `${periodType}|${periodStartYYYY-MM-DD}|${marketplaceId}|${asin}` keys to skip. */
  existingKeys?: Set<string>;
  onProgress?: (info: {
    periodStart: string;
    periodEnd: string;
    marketplace: string;
    asin: string;
    rows: number;
    done: number;
    total: number;
  }) => void;
}

export async function backfillSqp(opts: BackfillSqpOptions): Promise<{
  periodCount: number;
  asinCount: number;
  tasksRun: number;
  tasksSkipped: number;
  totalRows: number;
  pg: PgClient;
}> {
  const requestedDelay = opts.delayMs ?? SQP_MIN_DELAY_MS;
  const effectiveDelay = Math.max(requestedDelay, SQP_MIN_DELAY_MS);
  if (requestedDelay < SQP_MIN_DELAY_MS) {
    console.warn(
      `[sqp] delayMs=${requestedDelay} requested but the SQP createReport ` +
      `quota documents ~1 req/45s. Floor is ${SQP_MIN_DELAY_MS}ms. Raising.`,
    );
  }

  const periods = listPeriods(opts.periodType, opts.fromDate, opts.toDate);

  type Task = { periodStartIso: string; marketplaceId: string; asin: string };
  const allTasks: Task[] = [];
  for (const p of periods) {
    const periodStartIso = p.start.toISOString().slice(0, 10);
    for (const marketplaceId of opts.marketplaceIds) {
      for (const asin of opts.asins) {
        allTasks.push({ periodStartIso, marketplaceId, asin });
      }
    }
  }

  const tasks = opts.existingKeys
    ? allTasks.filter((t) => !opts.existingKeys!.has(`${opts.periodType}|${t.periodStartIso}|${t.marketplaceId}|${t.asin}`))
    : allTasks;
  const tasksSkipped = allTasks.length - tasks.length;

  if (tasks.length === 0) {
    return { periodCount: periods.length, asinCount: opts.asins.length, tasksRun: 0, tasksSkipped, totalRows: 0, pg: opts.pg };
  }

  let activePg: PgClient = opts.pg;
  let totalRows = 0;
  let done = 0;

  for (const t of tasks) {
    const period = periods.find((p) => p.start.toISOString().slice(0, 10) === t.periodStartIso)!;

    const { rowsUpserted } = await ingestSqpPeriod({
      spClient: opts.spClient,
      pg: activePg,
      connectionId: opts.connectionId,
      syncRunId: opts.syncRunId,
      marketplaceId: t.marketplaceId,
      asin: t.asin,
      periodType: opts.periodType,
      periodStart: period.start,
      periodEnd: period.end,
    });

    totalRows += rowsUpserted;
    done++;
    opts.onProgress?.({
      periodStart: period.start.toISOString().slice(0, 10),
      periodEnd: period.end.toISOString().slice(0, 10),
      marketplace: t.marketplaceId,
      asin: t.asin,
      rows: rowsUpserted,
      done,
      total: tasks.length,
    });

    if (done < tasks.length) {
      activePg = await sleepWithKeepalive(effectiveDelay, activePg);
    }
  }

  return {
    periodCount: periods.length,
    asinCount: opts.asins.length,
    tasksRun: tasks.length,
    tasksSkipped,
    totalRows,
    pg: activePg,
  };
}

/**
 * Sleep for totalMs, pinging pg every ~60s; reconnect on failure. Same
 * pattern as sales-traffic's helper (#49).
 */
async function sleepWithKeepalive(totalMs: number, pg: PgClient): Promise<PgClient> {
  const PING_INTERVAL_MS = 60_000;
  const start = Date.now();
  let active = pg;
  while (Date.now() - start < totalMs) {
    const remaining = totalMs - (Date.now() - start);
    await sleep(Math.min(PING_INTERVAL_MS, remaining));
    if (Date.now() - start >= totalMs) break;
    try {
      await active.query('SELECT 1');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sqp] keepalive ping failed (${msg}); reconnecting`);
      try { await active.end(); } catch { /* old client already dead */ }
      active = await getPgClient();
    }
  }
  return active;
}
