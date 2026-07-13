// ============================================================================
// Sales & Traffic Report — the canonical revenue source.
//
// Report type: GET_SALES_AND_TRAFFIC_REPORT (Brand Analytics)
// Response format: JSON
//
// Important detail: this report's response has TWO top-level arrays:
//   - salesAndTrafficByDate (one row per day in window, aggregated over ASINs)
//   - salesAndTrafficByAsin (one row per ASIN, aggregated over the window)
//
// To get DAILY × ASIN granularity, you must request ONE REPORT PER DAY.
// We do that, with a concurrency limit, respecting Reports API rate limits
// (0.0167 req/s for createReport with burst of 15).
// ============================================================================

import pLimit from 'p-limit';
import { Client as PgClient } from 'pg';
import { SpApiClient } from './client.js';
import { runReport, ReportCancelledError } from './reports.js';
import { getPgClient } from '../supabase.js';

export interface SalesTrafficByAsinRow {
  parentAsin: string;
  childAsin: string;
  sku: string | null;
  salesByAsin: {
    orderedProductSales: { amount: number; currencyCode: string };
    orderedProductSalesB2B?: { amount: number; currencyCode: string };
    unitsOrdered: number;
    unitsOrderedB2B?: number;
    totalOrderItems: number;
    totalOrderItemsB2B?: number;
  };
  trafficByAsin: {
    browserSessions?: number;
    browserSessionsB2B?: number;
    mobileAppSessions?: number;
    mobileAppSessionsB2B?: number;
    sessions?: number;
    sessionsB2B?: number;
    browserPageViews?: number;
    browserPageViewsB2B?: number;
    mobileAppPageViews?: number;
    mobileAppPageViewsB2B?: number;
    pageViews?: number;
    pageViewsB2B?: number;
    buyBoxPercentage?: number;
    buyBoxPercentageB2B?: number;
    unitSessionPercentage?: number;
    unitSessionPercentageB2B?: number;
  };
}

export interface SalesTrafficResponse {
  reportSpecification: unknown;
  salesAndTrafficByDate?: unknown[];
  salesAndTrafficByAsin?: SalesTrafficByAsinRow[];
}

export interface RunSalesTrafficOptions {
  spClient: SpApiClient;
  pg: PgClient;
  connectionId: string;
  syncRunId: string;
  marketplaceId: string;
  reportDate: Date; // single day
}

/**
 * Run one Sales & Traffic Report for a single (marketplace, day), land the
 * raw payload, then upsert into brain.sales_traffic_daily.
 */
export async function ingestSalesTrafficDay(opts: RunSalesTrafficOptions): Promise<{
  rowsUpserted: number;
}> {
  // Define the day window in UTC. The Sales & Traffic Report is delivered in
  // the marketplace's accounting timezone; for US that's PT. For backfill we
  // request a single calendar day and accept Amazon's TZ.
  const dayStart = new Date(Date.UTC(
    opts.reportDate.getUTCFullYear(),
    opts.reportDate.getUTCMonth(),
    opts.reportDate.getUTCDate(),
    0, 0, 0,
  ));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

  const result = await runReport(opts.spClient, {
    reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
    marketplaceIds: [opts.marketplaceId],
    dataStartTime: dayStart,
    dataEndTime: dayEnd,
    reportOptions: {
      asinGranularity: 'CHILD',
      dateGranularity: 'DAY',
    },
  });

  const parsed = JSON.parse(result.rawText) as SalesTrafficResponse;
  const asinRows = parsed.salesAndTrafficByAsin ?? [];

  // 1. Land raw payload
  const rawInsert = await opts.pg.query<{ raw_id: number }>(
    `INSERT INTO raw.sp_api_report
      (connection_id, sync_run_id, report_type, report_id, document_id, marketplace_ids,
       data_start_time, data_end_time, processing_status, payload, payload_bytes, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT (report_type, report_id) DO UPDATE
       SET payload = EXCLUDED.payload, processing_status = EXCLUDED.processing_status,
           parsed_at = NULL
     RETURNING raw_id`,
    [
      opts.connectionId,
      opts.syncRunId,
      'GET_SALES_AND_TRAFFIC_REPORT',
      result.meta.reportId,
      result.meta.reportDocumentId ?? null,
      [opts.marketplaceId],
      dayStart.toISOString(),
      dayEnd.toISOString(),
      result.meta.processingStatus,
      JSON.stringify(parsed),
      Buffer.byteLength(result.rawText, 'utf8'),
    ],
  );
  const rawId = rawInsert.rows[0]!.raw_id;

  // 2. Upsert into brain.sales_traffic_daily
  const metricDate = dayStart.toISOString().slice(0, 10);
  let rowsUpserted = 0;

  for (const row of asinRows) {
    const sales = row.salesByAsin;
    const traffic = row.trafficByAsin;
    const currency = sales.orderedProductSales?.currencyCode ?? 'USD';

    // Tier 1 #2 from project review (2026-06-15) — detect Amazon shape
    // anomalies that the surrounding `?? 0` coercions would otherwise silently
    // hide. We don't change the row's behaviour here (the schema is still
    // NOT NULL DEFAULT 0 on the metric columns, and ASINs with truly zero
    // activity legitimately omit fields) — just log to meta.sync_log so we
    // have audit evidence of frequency. Once we see real volume, the right
    // follow-up is dropping NOT NULL on the metric columns and switching the
    // parameter list below to `?? null` so missing data is queryable.
    const anomalies: string[] = [];
    if (sales.orderedProductSales === undefined && (sales.unitsOrdered ?? 0) > 0) {
      anomalies.push('orderedProductSales-missing-with-units>0');
    }
    if (sales.orderedProductSales === undefined && sales.unitsOrdered === undefined) {
      anomalies.push('sales-block-empty');
    }
    if (traffic.sessions === undefined && traffic.pageViews === undefined) {
      anomalies.push('traffic-block-empty');
    }
    if (anomalies.length > 0) {
      await opts.pg.query(
        `INSERT INTO meta.sync_log (sync_run_id, level, message, payload)
         VALUES ($1, 'warn', $2, $3)`,
        [
          opts.syncRunId,
          `Sales/Traffic shape anomaly for ASIN ${row.childAsin} on ${metricDate}: ${anomalies.join(', ')}`,
          JSON.stringify({
            marketplace_id: opts.marketplaceId,
            metric_date: metricDate,
            child_asin: row.childAsin,
            parent_asin: row.parentAsin,
            anomalies,
            sales_keys: Object.keys(sales ?? {}),
            traffic_keys: Object.keys(traffic ?? {}),
          }),
        ],
      );
    }

    await opts.pg.query(
      `INSERT INTO brain.sales_traffic_daily (
        marketplace_id, metric_date, parent_asin, child_asin, sku, currency_code,
        ordered_product_sales, ordered_product_sales_b2b,
        units_ordered, units_ordered_b2b, total_order_items, total_order_items_b2b,
        sessions, sessions_b2b, browser_sessions, browser_sessions_b2b,
        mobile_app_sessions, mobile_app_sessions_b2b,
        page_views, page_views_b2b, browser_page_views, browser_page_views_b2b,
        mobile_app_page_views, mobile_app_page_views_b2b,
        buy_box_percentage, buy_box_percentage_b2b,
        unit_session_percentage, unit_session_percentage_b2b,
        raw_id, ingested_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23, $24,
        $25, $26, $27, $28,
        $29, NOW(), NOW()
      )
      ON CONFLICT (marketplace_id, metric_date, child_asin) DO UPDATE SET
        parent_asin                  = EXCLUDED.parent_asin,
        sku                          = EXCLUDED.sku,
        currency_code                = EXCLUDED.currency_code,
        ordered_product_sales        = EXCLUDED.ordered_product_sales,
        ordered_product_sales_b2b    = EXCLUDED.ordered_product_sales_b2b,
        units_ordered                = EXCLUDED.units_ordered,
        units_ordered_b2b            = EXCLUDED.units_ordered_b2b,
        total_order_items            = EXCLUDED.total_order_items,
        total_order_items_b2b        = EXCLUDED.total_order_items_b2b,
        sessions                     = EXCLUDED.sessions,
        sessions_b2b                 = EXCLUDED.sessions_b2b,
        browser_sessions             = EXCLUDED.browser_sessions,
        browser_sessions_b2b         = EXCLUDED.browser_sessions_b2b,
        mobile_app_sessions          = EXCLUDED.mobile_app_sessions,
        mobile_app_sessions_b2b      = EXCLUDED.mobile_app_sessions_b2b,
        page_views                   = EXCLUDED.page_views,
        page_views_b2b               = EXCLUDED.page_views_b2b,
        browser_page_views           = EXCLUDED.browser_page_views,
        browser_page_views_b2b       = EXCLUDED.browser_page_views_b2b,
        mobile_app_page_views        = EXCLUDED.mobile_app_page_views,
        mobile_app_page_views_b2b    = EXCLUDED.mobile_app_page_views_b2b,
        buy_box_percentage           = EXCLUDED.buy_box_percentage,
        buy_box_percentage_b2b       = EXCLUDED.buy_box_percentage_b2b,
        unit_session_percentage      = EXCLUDED.unit_session_percentage,
        unit_session_percentage_b2b  = EXCLUDED.unit_session_percentage_b2b,
        raw_id                       = EXCLUDED.raw_id,
        updated_at                   = NOW()`,
      [
        opts.marketplaceId,
        metricDate,
        row.parentAsin,
        row.childAsin,
        row.sku || null,
        currency,
        sales.orderedProductSales?.amount ?? 0,
        sales.orderedProductSalesB2B?.amount ?? 0,
        sales.unitsOrdered ?? 0,
        sales.unitsOrderedB2B ?? 0,
        sales.totalOrderItems ?? 0,
        sales.totalOrderItemsB2B ?? 0,
        traffic.sessions ?? 0,
        traffic.sessionsB2B ?? 0,
        traffic.browserSessions ?? 0,
        traffic.browserSessionsB2B ?? 0,
        traffic.mobileAppSessions ?? 0,
        traffic.mobileAppSessionsB2B ?? 0,
        traffic.pageViews ?? 0,
        traffic.pageViewsB2B ?? 0,
        traffic.browserPageViews ?? 0,
        traffic.browserPageViewsB2B ?? 0,
        traffic.mobileAppPageViews ?? 0,
        traffic.mobileAppPageViewsB2B ?? 0,
        // Amazon returns these as percentages (0-100); we store as 0.0-1.0
        traffic.buyBoxPercentage !== undefined ? traffic.buyBoxPercentage / 100 : null,
        traffic.buyBoxPercentageB2B !== undefined ? traffic.buyBoxPercentageB2B / 100 : null,
        traffic.unitSessionPercentage !== undefined ? traffic.unitSessionPercentage / 100 : null,
        traffic.unitSessionPercentageB2B !== undefined ? traffic.unitSessionPercentageB2B / 100 : null,
        rawId,
      ],
    );
    rowsUpserted++;
  }

  // 3. Mark raw as parsed
  await opts.pg.query(
    'UPDATE raw.sp_api_report SET parsed_at = NOW() WHERE raw_id = $1',
    [rawId],
  );

  return { rowsUpserted };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Amazon's permanent SP-API limit for GET_SALES_AND_TRAFFIC_REPORT (confirmed
// 2026-05-26): 1 createReport call per 15 minutes, app-wide. These floors are
// enforced regardless of the values the caller passes — passing lower values
// only earns a warning.
const SALES_TRAFFIC_MIN_DELAY_MS = 15 * 60 * 1000;
const SALES_TRAFFIC_MAX_CONCURRENCY = 1;

/**
 * Backfill Sales & Traffic for a window of days, across one or more marketplaces.
 *
 * Rate-limit handling is non-negotiable: concurrency is clamped to 1 and the
 * per-task delay to 15 min, because higher values violate Amazon's permanent
 * 1/15-min limit on createReport for this report type. If the caller passes
 * less-conservative values, a warning is logged and the floor wins.
 *
 * Pass `existingKeys` (formatted as `${marketplaceId}|${YYYY-MM-DD}`) to skip
 * (marketplace, day) pairs that are already present in brain.sales_traffic_daily.
 */
export async function backfillSalesTraffic(opts: {
  spClient: SpApiClient;
  pg: PgClient;
  connectionId: string;
  syncRunId: string;
  marketplaceIds: string[];
  fromDate: Date;
  toDate: Date;
  concurrency?: number;
  delayMs?: number;
  existingKeys?: Set<string>;
  onProgress?: (info: {
    day: string;
    marketplace: string;
    rows: number;
    done: number;
    total: number;
    /**
     * TRUE when Amazon returned processingStatus=CANCELLED for this (day,
     * marketplace). The day has no data and was skipped; `rows` is 0 in
     * this case. Typically signals "outside the report's retention horizon"
     * or "no sales in this period" rather than a real error — the run
     * continues to the next day.
     */
    cancelled?: boolean;
  }) => void;
}): Promise<{
  totalDays: number;
  totalRows: number;
  tasksRun: number;
  /** Days Amazon CANCELLED — usually retention-edge or no-sales days. */
  tasksCancelled: number;
  tasksSkipped: number;
  /**
   * The active pg client at the end of the run. May not be the same instance
   * the caller passed in: if a keepalive ping failed mid-run, the original was
   * closed and replaced with a fresh client. Callers that hold a long-lived pg
   * reference should reassign to this so any further queries / end() target
   * the live connection.
   */
  pg: PgClient;
}> {
  const requestedConcurrency = opts.concurrency ?? SALES_TRAFFIC_MAX_CONCURRENCY;
  const requestedDelay = opts.delayMs ?? SALES_TRAFFIC_MIN_DELAY_MS;
  const effectiveConcurrency = Math.min(requestedConcurrency, SALES_TRAFFIC_MAX_CONCURRENCY);
  const effectiveDelay = Math.max(requestedDelay, SALES_TRAFFIC_MIN_DELAY_MS);

  if (requestedConcurrency > SALES_TRAFFIC_MAX_CONCURRENCY) {
    console.warn(
      `[sales-traffic] concurrency=${requestedConcurrency} requested but Amazon's permanent ` +
      `1/15-min createReport limit forces 1. Clamping.`,
    );
  }
  if (requestedDelay < SALES_TRAFFIC_MIN_DELAY_MS) {
    console.warn(
      `[sales-traffic] delayMs=${requestedDelay} requested but Amazon's permanent ` +
      `1/15-min createReport limit forces >= ${SALES_TRAFFIC_MIN_DELAY_MS}. Raising.`,
    );
  }

  const days: Date[] = [];
  for (
    let d = new Date(Date.UTC(opts.fromDate.getUTCFullYear(), opts.fromDate.getUTCMonth(), opts.fromDate.getUTCDate()));
    d.getTime() <= opts.toDate.getTime();
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    days.push(new Date(d));
  }

  const allTasks: Array<{ day: Date; marketplaceId: string }> = [];
  for (const day of days) {
    for (const marketplaceId of opts.marketplaceIds) {
      allTasks.push({ day, marketplaceId });
    }
  }

  const tasks = opts.existingKeys
    ? allTasks.filter((t) => !opts.existingKeys!.has(`${t.marketplaceId}|${t.day.toISOString().slice(0, 10)}`))
    : allTasks;
  const tasksSkipped = allTasks.length - tasks.length;

  if (tasks.length === 0) {
    return { totalDays: days.length, totalRows: 0, tasksRun: 0, tasksCancelled: 0, tasksSkipped, pg: opts.pg };
  }

  const limit = pLimit(effectiveConcurrency);
  let totalRows = 0;
  let done = 0;
  let tasksCancelled = 0;

  // The pg connection is held open across 15-minute idle sleeps between calls.
  // Supabase's pooler kills idle connections, so without a keepalive the run
  // crashes mid-wave on whichever sleep cycle the pooler decides to evict
  // (observed 2026-05-27 at ~16 of 92 days). `activePg` is local + mutable so
  // we can transparently swap in a fresh client when the keepalive ping fails.
  let activePg: PgClient = opts.pg;

  await Promise.all(
    tasks.map((t) =>
      limit(async () => {
        try {
          const { rowsUpserted } = await ingestSalesTrafficDay({
            spClient: opts.spClient,
            pg: activePg,
            connectionId: opts.connectionId,
            syncRunId: opts.syncRunId,
            marketplaceId: t.marketplaceId,
            reportDate: t.day,
          });
          totalRows += rowsUpserted;
          done++;
          opts.onProgress?.({
            day: t.day.toISOString().slice(0, 10),
            marketplace: t.marketplaceId,
            rows: rowsUpserted,
            done,
            total: tasks.length,
          });
        } catch (err) {
          // Amazon's CANCELLED status means "no data for this window" — most
          // commonly retention-edge dates (>24mo back) or marketplaces not
          // enrolled in Brand Analytics for that period. Skip the day and
          // continue so a single dead day doesn't kill a 90-day backfill.
          // Anything else (FATAL, network, pg error) is a real problem; let
          // it bubble to abort the run.
          if (err instanceof ReportCancelledError) {
            tasksCancelled++;
            done++;
            // Persist a no-data marker so --skip-existing skips this
            // (marketplace, day) on future runs instead of re-spending a 15-min
            // createReport rediscovering the same empty date (retention-edge or
            // no-Brand-Analytics day). asin='-' is a day-level sentinel (S&T is
            // not per-ASIN). Best-effort: a marker write must never abort the run.
            try {
              await activePg.query(
                `INSERT INTO meta.report_fatal_marker
                   (object, marketplace_id, asin, period_type, period_start, reason)
                 VALUES ('sales_traffic_report', $1, '-', 'DAY', $2, 'cancelled')
                 ON CONFLICT (object, marketplace_id, asin, period_type, period_start) DO UPDATE
                   SET last_seen_at = NOW(),
                       fail_count   = meta.report_fatal_marker.fail_count + 1`,
                [t.marketplaceId, t.day.toISOString().slice(0, 10)],
              );
            } catch (markErr) {
              const m = markErr instanceof Error ? markErr.message : String(markErr);
              console.warn(`[sales-traffic] no-data marker write failed for ${t.marketplaceId} ${t.day.toISOString().slice(0, 10)}: ${m}`);
            }
            opts.onProgress?.({
              day: t.day.toISOString().slice(0, 10),
              marketplace: t.marketplaceId,
              rows: 0,
              done,
              total: tasks.length,
              cancelled: true,
            });
          } else {
            throw err;
          }
        }
        if (done < tasks.length) {
          activePg = await sleepWithKeepalive(effectiveDelay, activePg);
        }
      }),
    ),
  );

  return { totalDays: days.length, totalRows, tasksRun: tasks.length - tasksCancelled, tasksCancelled, tasksSkipped, pg: activePg };
}

/**
 * Sleep for `totalMs`, pinging `pg` every ~60 seconds to keep the connection
 * warm. If a ping fails (Supabase's pooler evicted us, network blip, etc.) the
 * client is replaced with a fresh one and we continue. Returns the
 * possibly-new pg client so the caller can swap its reference.
 *
 * Concurrency is hard-clamped to 1 for this report type, so there's only ever
 * one pg user at a time — the mutable swap is safe.
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
      console.warn(`[sales-traffic] keepalive ping failed (${msg}); reconnecting`);
      try { await active.end(); } catch { /* old client already dead */ }
      active = await getPgClient();
    }
  }
  return active;
}
