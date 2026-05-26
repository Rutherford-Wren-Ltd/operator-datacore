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
import { runReport } from './reports.js';

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
  onProgress?: (info: { day: string; marketplace: string; rows: number; done: number; total: number }) => void;
}): Promise<{ totalDays: number; totalRows: number; tasksRun: number; tasksSkipped: number }> {
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
    return { totalDays: days.length, totalRows: 0, tasksRun: 0, tasksSkipped };
  }

  const limit = pLimit(effectiveConcurrency);
  let totalRows = 0;
  let done = 0;

  await Promise.all(
    tasks.map((t) =>
      limit(async () => {
        const { rowsUpserted } = await ingestSalesTrafficDay({
          spClient: opts.spClient,
          pg: opts.pg,
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
        if (done < tasks.length) {
          await sleep(effectiveDelay);
        }
      }),
    ),
  );

  return { totalDays: days.length, totalRows, tasksRun: tasks.length, tasksSkipped };
}
