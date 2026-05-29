// ============================================================================
// Brand Analytics — Search Query Performance Report
//
// Report type: GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT
// Response format: JSON
//
// Key facts (see [[amazon-brand-analytics]] memory):
//   - 17-month lookback for monthly reports — much longer than the 65-95 day
//     Ads API retention. This is the right tool for YoY query analysis.
//   - One PERIOD per call (week / month / quarter). dataStartTime and
//     dataEndTime must align to the period boundary or Amazon 400s.
//   - Period types: WEEK (Sun-Sat), MONTH (calendar), QUARTER (calendar Q1-Q4).
//   - Covers all your brand's ASINs in one report — no need to chunk by ASIN
//     unless a single period's response is too large (not seen in practice).
//   - Brand Analytics access requires Brand Registry enrolment + the
//     "Brand Analytics" SP-API role. RW has both (already pulling
//     Sales & Traffic, which is also a Brand Analytics report).
// ============================================================================

import { Client as PgClient } from 'pg';
// stream-json v3 — lowercase paths; .asStream() variants are Node Duplexes.
import parserStream from 'stream-json';
import pick from 'stream-json/filters/pick.js';
import streamArray from 'stream-json/streamers/stream-array.js';
import { SpApiClient } from './client.js';
import { streamReport } from './reports.js';
import { getPgClient } from '../supabase.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type SqpPeriodType = 'WEEK' | 'MONTH' | 'QUARTER';

// Conservative default pacing — tighter than sales-traffic's 15 min cap but
// not so aggressive that we earn a quota review. Amazon's documented quota
// for SQP createReport is 0.0222 req/s (= 1 per 45s) with burst 10. The
// 60-second floor here sits comfortably under that.
const SQP_MIN_DELAY_MS = 60_000;

interface SearchQueryAsinRow {
  // The actual response shape from Amazon's SQP report. Field names are
  // verbose and nested by category — see Amazon's documented JSON schema.
  // Anything missing from a row is parsed as null at upsert time.
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

export interface IngestSqpPeriodOptions {
  spClient: SpApiClient;
  pg: PgClient;
  connectionId: string;
  syncRunId: string;
  marketplaceId: string;
  periodType: SqpPeriodType;
  periodStart: Date;        // inclusive, aligned to period boundary
  periodEnd: Date;          // inclusive (we set hours = 23:59:59 at the call site)
}

/**
 * Pull one period's SQP report for one marketplace, stream-parse it, and
 * upsert per-(ASIN, query) rows into brain.search_query_performance.
 *
 * Streaming because Amazon's SQP response can run to hundreds of MB of JSON
 * for an active brand at MONTH grain — RW's first 1-month test crashed at
 * 8GB heap with the original buffer-everything approach. We pipe the gzipped
 * stream → gunzip → stream-json → row-by-row upsert, so peak memory is
 * bounded by the upsert batch size, not by the report size.
 *
 * raw.sp_api_report carries metadata only (no payload). The full document
 * is re-fetchable via the reportDocumentId if needed for replay; storing a
 * gigabyte JSONB per period isn't worth the cost.
 */
export async function ingestSqpPeriod(opts: IngestSqpPeriodOptions): Promise<{
  rowsUpserted: number;
}> {
  const { meta, stream } = await streamReport(opts.spClient, {
    reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
    marketplaceIds: [opts.marketplaceId],
    dataStartTime: opts.periodStart,
    dataEndTime: opts.periodEnd,
    reportOptions: {
      reportPeriod: opts.periodType,
    },
  });

  // 1. Land metadata in raw.sp_api_report — empty payload, since the real
  //    document is too big to JSONB.
  const rawInsert = await opts.pg.query<{ raw_id: number }>(
    `INSERT INTO raw.sp_api_report
      (connection_id, sync_run_id, report_type, report_id, document_id, marketplace_ids,
       data_start_time, data_end_time, processing_status, payload, payload_bytes, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb, 0, NOW())
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
    ],
  );
  const rawId = rawInsert.rows[0]!.raw_id;

  // 2. Stream-parse the JSON and upsert in batches of 500.
  //
  // stream-json's Pick + StreamArray yields one element of `dataByAsin`
  // at a time as `{ key, value }`. We accumulate up to BATCH_SIZE rows
  // and flush via a single multi-VALUES UPSERT.
  const BATCH_SIZE = 500;
  type Row = {
    periodType: SqpPeriodType;
    startStr: string;
    endStr: string;
    asin: string;
    query: string;
    score: number | null;
    volume: number | null;
    impressions: number | null;
    clicks: number | null;
    cartAdds: number | null;
    purchases: number | null;
    impressionShare: number | null;
    clickShare: number | null;
    cartAddShare: number | null;
    purchaseShare: number | null;
    rawId: number;
  };
  const batch: Row[] = [];
  let rowsUpserted = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const params: unknown[] = [];
    const valuesClauses: string[] = [];
    for (const r of batch) {
      const i = params.length;
      params.push(
        r.periodType, r.startStr, r.endStr, r.asin, r.query,
        r.score, r.volume,
        r.impressions, r.clicks, r.cartAdds, r.purchases,
        r.impressionShare, r.clickShare, r.cartAddShare, r.purchaseShare,
        r.rawId,
      );
      const placeholders = Array.from({ length: 16 }, (_, k) => `$${i + k + 1}`);
      valuesClauses.push(`(${placeholders.join(',')}, NOW())`);
    }
    await opts.pg.query(
      `INSERT INTO brain.search_query_performance (
          period_type, period_start, period_end, asin, search_query,
          search_query_score, search_query_volume,
          impressions, clicks, cart_adds, purchases,
          impression_share, click_share, cart_add_share, purchase_share,
          raw_id, ingested_at
       ) VALUES ${valuesClauses.join(',')}
       ON CONFLICT (period_type, period_start, asin, search_query) DO UPDATE SET
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
    batch.length = 0;
  };

  // Build the streaming pipeline:
  //   gunzipped JSON bytes → tokens → pick `dataByAsin` → array elements
  const pipeline = stream
    .pipe(parserStream())
    .pipe(pick.asStream({ filter: 'dataByAsin' }))
    .pipe(streamArray.asStream());

  for await (const chunk of pipeline as AsyncIterable<{ value: SearchQueryAsinRow }>) {
    const r = chunk.value;
    const asin = r.asin;
    const sqd = r.searchQueryData ?? {};
    const query = sqd.searchQuery;
    if (!asin || !query) continue;

    // Period boundaries: prefer the row's own startDate/endDate if present;
    // fall back to the call's window. Always YYYY-MM-DD.
    const startStr = r.startDate ?? opts.periodStart.toISOString().slice(0, 10);
    const endStr = r.endDate ?? opts.periodEnd.toISOString().slice(0, 10);

    batch.push({
      periodType: opts.periodType,
      startStr, endStr, asin, query,
      score:           sqd.searchQueryScore ?? null,
      volume:          sqd.searchQueryVolume ?? null,
      impressions:     r.impressionData?.totalQueryImpressionCount ?? null,
      clicks:          r.clickData?.totalClickCount ?? null,
      cartAdds:        r.cartAddData?.totalCartAddCount ?? null,
      purchases:       r.purchaseData?.totalPurchaseCount ?? null,
      impressionShare: r.impressionData?.asinImpressionShare ?? null,
      clickShare:      r.clickData?.asinClickShare ?? null,
      cartAddShare:    r.cartAddData?.asinCartAddShare ?? null,
      purchaseShare:   r.purchaseData?.asinPurchaseShare ?? null,
      rawId,
    });

    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  await opts.pg.query(
    'UPDATE raw.sp_api_report SET parsed_at = NOW() WHERE raw_id = $1',
    [rawId],
  );

  return { rowsUpserted };
}

// ----------------------------------------------------------------------------
// Period helpers — align dates to Amazon's boundary expectations.
// ----------------------------------------------------------------------------

/**
 * Return the calendar-month period [start, end] containing `d` (UTC).
 */
export function monthPeriod(d: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59));
  return { start, end };
}

/**
 * Return the calendar-quarter period [start, end] containing `d` (UTC).
 */
export function quarterPeriod(d: Date): { start: Date; end: Date } {
  const qStartMonth = Math.floor(d.getUTCMonth() / 3) * 3;
  const start = new Date(Date.UTC(d.getUTCFullYear(), qStartMonth, 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), qStartMonth + 3, 0, 23, 59, 59));
  return { start, end };
}

/**
 * Return the Brand Analytics week period [Sunday, Saturday] containing `d`
 * (UTC). Amazon's reporting week is Sun-Sat.
 */
export function weekPeriod(d: Date): { start: Date; end: Date } {
  const day = d.getUTCDay();  // 0=Sun, 6=Sat
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  const end = new Date(start.getTime() + 6 * 86_400_000 + (86_400_000 - 1));
  return { start, end };
}

/**
 * Build the list of (alignment-correct) periods from fromDate to toDate.
 * Returns periods in chronological order.
 */
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
// Backfill — iterate periods × marketplaces with keepalive.
// ----------------------------------------------------------------------------

interface SqpBackfillKey {
  periodType: SqpPeriodType;
  periodStart: string;  // YYYY-MM-DD
  marketplaceId: string;
}

export interface BackfillSqpOptions {
  spClient: SpApiClient;
  pg: PgClient;
  connectionId: string;
  syncRunId: string;
  marketplaceIds: string[];
  periodType: SqpPeriodType;
  fromDate: Date;
  toDate: Date;
  /** Override the 60s minimum pace. Floor is enforced. */
  delayMs?: number;
  /** Set of `${periodType}|${periodStartYYYY-MM-DD}|${marketplaceId}` keys to skip. */
  existingKeys?: Set<string>;
  onProgress?: (info: {
    periodStart: string;
    periodEnd: string;
    marketplace: string;
    rows: number;
    done: number;
    total: number;
  }) => void;
}

export async function backfillSqp(opts: BackfillSqpOptions): Promise<{
  periodCount: number;
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

  const allTasks: SqpBackfillKey[] = [];
  for (const p of periods) {
    for (const marketplaceId of opts.marketplaceIds) {
      allTasks.push({
        periodType: opts.periodType,
        periodStart: p.start.toISOString().slice(0, 10),
        marketplaceId,
      });
    }
  }

  const tasks = opts.existingKeys
    ? allTasks.filter((t) => !opts.existingKeys!.has(`${t.periodType}|${t.periodStart}|${t.marketplaceId}`))
    : allTasks;
  const tasksSkipped = allTasks.length - tasks.length;

  if (tasks.length === 0) {
    return { periodCount: periods.length, tasksRun: 0, tasksSkipped, totalRows: 0, pg: opts.pg };
  }

  // Keepalive: same pattern as sales-traffic.ts (PR #49).
  let activePg: PgClient = opts.pg;
  let totalRows = 0;
  let done = 0;

  for (const t of tasks) {
    const period = periods.find((p) => p.start.toISOString().slice(0, 10) === t.periodStart)!;

    const { rowsUpserted } = await ingestSqpPeriod({
      spClient: opts.spClient,
      pg: activePg,
      connectionId: opts.connectionId,
      syncRunId: opts.syncRunId,
      marketplaceId: t.marketplaceId,
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
      rows: rowsUpserted,
      done,
      total: tasks.length,
    });

    if (done < tasks.length) {
      activePg = await sleepWithKeepalive(effectiveDelay, activePg);
    }
  }

  return { periodCount: periods.length, tasksRun: tasks.length, tasksSkipped, totalRows, pg: activePg };
}

/**
 * Sleep for totalMs, pinging pg every ~60s; reconnect on failure. Same as
 * sales-traffic's helper (#49) — kept inline rather than shared so each
 * report's library is self-contained and easy to reason about.
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
