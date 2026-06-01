// ============================================================================
// Orders Report — order header + item lines ingest.
//
// Report type: GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL
// Response format: TSV (kebab-case columns)
//
// What this is for: order-level analysis (AOV, fulfillment channel mix,
// ship-to country distribution, cancellation rates, B2B vs Consumer split,
// Prime mix, replacement-order tracking). NOT for revenue — the canonical
// revenue source is GET_SALES_AND_TRAFFIC_REPORT (see docs/canonical-reports.md).
//
// Reasonable backfill window: 30 days at a time. The flat-file orders report
// is sized comfortably for that, and the BY_LAST_UPDATE variant is the right
// choice for daily sync (catches status changes — cancellations, refunds,
// returns) without missing late-updated orders.
//
// Granularity: TSV is one row per (order, item). Some columns are order-level
// (repeat across rows for the same amazon-order-id); some are item-level.
// We split that into two upserts per row: brain.orders header + brain.order_items.
//
// PII handling: the report strips PII (buyer name, email, full address) — only
// ship-city / state / postal / country come through. We deliberately don't
// store anything PII-adjacent beyond that.
//
// order_item_id synthesis: the TSV doesn't include Amazon's internal
// OrderItemId (that's an Orders API construct). We synthesize as
// `sku||'|'||asin` — Amazon collapses same-SKU lines in this report, so the
// pair is unique per (order, item) row in practice. Rows where BOTH sku and
// asin are null are skipped with a warning (rare in RW data).
// ============================================================================

import { Client as PgClient } from 'pg';
import { SpApiClient } from './client.js';
import { runReport, parseTsv } from './reports.js';

// Boolean columns in the TSV come as 'true' / 'false' / '' (empty for unknown).
// pg expects true | false | null.
function parseBool(v: string | undefined): boolean | null {
  if (v === undefined || v === '') return null;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === '0') return false;
  return null;
}

function parseInt0(v: string | undefined): number {
  if (v === undefined || v === '') return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function parseNumeric(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseTimestamp(v: string | undefined): string | null {
  if (v === undefined || v === '') return null;
  // Amazon TSV uses ISO 8601 strings; pass through verbatim. Postgres handles
  // 'YYYY-MM-DDTHH:MM:SSZ' and other ISO variants natively.
  return v;
}

export interface IngestOrdersWindowOptions {
  spClient: SpApiClient;
  pg: PgClient;
  connectionId: string;
  syncRunId: string;
  marketplaceId: string;
  /** Inclusive. */
  fromDate: Date;
  /** Inclusive (set to 23:59:59 at the call site). */
  toDate: Date;
}

export interface IngestOrdersResult {
  ordersUpserted: number;
  itemsUpserted: number;
  rowsSkipped: number;
  reportId: string;
  rawId: number;
}

/**
 * Pull one Orders Report for (marketplace, fromDate..toDate), land the raw
 * payload, and upsert order headers + item lines.
 *
 * Idempotent: re-running the same window replaces the affected rows. Order
 * status changes (Pending → Shipped → Cancelled etc.) flow naturally because
 * `BY_LAST_UPDATE_GENERAL` returns any order updated in the window.
 */
export async function ingestOrdersWindow(opts: IngestOrdersWindowOptions): Promise<IngestOrdersResult> {
  const result = await runReport(opts.spClient, {
    reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
    marketplaceIds: [opts.marketplaceId],
    dataStartTime: opts.fromDate,
    dataEndTime: opts.toDate,
  });

  const rows = parseTsv(result.rawText);

  // 1. Land raw payload (truncated payload — the report can be MB-sized; we
  //    store metadata + a sample, with payload_bytes for sizing reference).
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
      'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
      result.meta.reportId,
      result.meta.reportDocumentId ?? null,
      [opts.marketplaceId],
      opts.fromDate.toISOString(),
      opts.toDate.toISOString(),
      result.meta.processingStatus,
      Buffer.byteLength(result.rawText, 'utf8'),
    ],
  );
  const rawId = rawInsert.rows[0]!.raw_id;

  let ordersUpserted = 0;
  let itemsUpserted = 0;
  let rowsSkipped = 0;
  const seenOrders = new Set<string>();

  for (const row of rows) {
    const orderId = row['amazon-order-id'];
    if (!orderId) { rowsSkipped++; continue; }

    const sku = row.sku || null;
    const asin = row.asin || null;
    // Synthesize a stable order_item_id. The pair (sku, asin) is unique
    // per (order, item) row in this report — Amazon collapses same-SKU
    // lines into one row with summed qty.
    if (!sku && !asin) { rowsSkipped++; continue; }
    const orderItemId = `${sku ?? ''}|${asin ?? ''}`;

    // ----- Order header (one-per-order; safe to upsert per row — the order
    // -----  fields repeat across item rows in the report, so all writes for
    // -----  the same order are identical).
    if (!seenOrders.has(orderId)) {
      seenOrders.add(orderId);
      await opts.pg.query(
        `INSERT INTO brain.orders (
          marketplace_id, amazon_order_id, merchant_order_id,
          purchase_date, last_updated_date, order_status,
          fulfillment_channel, sales_channel, order_channel, ship_service_level,
          is_business_order, is_prime, is_premium_order, is_global_express_enabled,
          is_replacement_order, is_sold_by_ab,
          earliest_ship_date, latest_ship_date,
          earliest_delivery_date, latest_delivery_date,
          ship_country, ship_state_province, ship_city, ship_postal_code,
          raw_id, ingested_at, updated_at
        ) VALUES (
          $1, $2, $3,
          $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16,
          $17, $18,
          $19, $20,
          $21, $22, $23, $24,
          $25, NOW(), NOW()
        )
        ON CONFLICT (marketplace_id, amazon_order_id) DO UPDATE SET
          merchant_order_id          = EXCLUDED.merchant_order_id,
          purchase_date              = EXCLUDED.purchase_date,
          last_updated_date          = EXCLUDED.last_updated_date,
          order_status               = EXCLUDED.order_status,
          fulfillment_channel        = EXCLUDED.fulfillment_channel,
          sales_channel              = EXCLUDED.sales_channel,
          order_channel              = EXCLUDED.order_channel,
          ship_service_level         = EXCLUDED.ship_service_level,
          is_business_order          = EXCLUDED.is_business_order,
          is_prime                   = EXCLUDED.is_prime,
          is_premium_order           = EXCLUDED.is_premium_order,
          is_global_express_enabled  = EXCLUDED.is_global_express_enabled,
          is_replacement_order       = EXCLUDED.is_replacement_order,
          is_sold_by_ab              = EXCLUDED.is_sold_by_ab,
          earliest_ship_date         = EXCLUDED.earliest_ship_date,
          latest_ship_date           = EXCLUDED.latest_ship_date,
          earliest_delivery_date     = EXCLUDED.earliest_delivery_date,
          latest_delivery_date       = EXCLUDED.latest_delivery_date,
          ship_country               = EXCLUDED.ship_country,
          ship_state_province        = EXCLUDED.ship_state_province,
          ship_city                  = EXCLUDED.ship_city,
          ship_postal_code           = EXCLUDED.ship_postal_code,
          raw_id                     = EXCLUDED.raw_id,
          updated_at                 = NOW()`,
        [
          opts.marketplaceId,
          orderId,
          row['merchant-order-id'] || null,
          parseTimestamp(row['purchase-date']),
          parseTimestamp(row['last-updated-date']),
          row['order-status'] || null,
          row['fulfillment-channel'] || null,
          row['sales-channel'] || null,
          row['order-channel'] || null,
          row['ship-service-level'] || null,
          parseBool(row['is-business-order']),
          parseBool(row['is-prime']),
          parseBool(row['is-premium-order']),
          parseBool(row['is-global-express-enabled']),
          parseBool(row['is-replacement-order']),
          parseBool(row['is-iba']),
          parseTimestamp(row['earliest-ship-date']),
          parseTimestamp(row['latest-ship-date']),
          parseTimestamp(row['earliest-delivery-date']),
          parseTimestamp(row['latest-delivery-date']),
          row['ship-country'] || null,
          row['ship-state'] || null,
          row['ship-city'] || null,
          row['ship-postal-code'] || null,
          rawId,
        ],
      );
      ordersUpserted += 1;
    }

    // ----- Item line -----
    await opts.pg.query(
      `INSERT INTO brain.order_items (
        amazon_order_id, order_item_id, asin, sku, product_name,
        quantity, quantity_shipped,
        item_price, item_tax, shipping_price, shipping_tax,
        gift_wrap_price, gift_wrap_tax,
        item_promotion_discount, ship_promotion_discount,
        currency_code, raw_id, ingested_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, 0,
        $7, $8, $9, $10,
        $11, $12,
        $13, $14,
        $15, $16, NOW()
      )
      ON CONFLICT (amazon_order_id, order_item_id) DO UPDATE SET
        asin                      = EXCLUDED.asin,
        sku                       = EXCLUDED.sku,
        product_name              = EXCLUDED.product_name,
        quantity                  = EXCLUDED.quantity,
        item_price                = EXCLUDED.item_price,
        item_tax                  = EXCLUDED.item_tax,
        shipping_price            = EXCLUDED.shipping_price,
        shipping_tax              = EXCLUDED.shipping_tax,
        gift_wrap_price           = EXCLUDED.gift_wrap_price,
        gift_wrap_tax             = EXCLUDED.gift_wrap_tax,
        item_promotion_discount   = EXCLUDED.item_promotion_discount,
        ship_promotion_discount   = EXCLUDED.ship_promotion_discount,
        currency_code             = EXCLUDED.currency_code,
        raw_id                    = EXCLUDED.raw_id,
        ingested_at               = NOW()`,
      [
        orderId,
        orderItemId,
        asin,
        sku,
        row['product-name'] || null,
        parseInt0(row.quantity),
        parseNumeric(row['item-price']),
        parseNumeric(row['item-tax']),
        parseNumeric(row['shipping-price']),
        parseNumeric(row['shipping-tax']),
        parseNumeric(row['gift-wrap-price']),
        parseNumeric(row['gift-wrap-tax']),
        parseNumeric(row['item-promotion-discount']),
        parseNumeric(row['ship-promotion-discount']),
        row.currency || null,
        rawId,
      ],
    );
    itemsUpserted += 1;
  }

  await opts.pg.query(
    'UPDATE raw.sp_api_report SET parsed_at = NOW() WHERE raw_id = $1',
    [rawId],
  );

  return {
    ordersUpserted,
    itemsUpserted,
    rowsSkipped,
    reportId: result.meta.reportId,
    rawId,
  };
}
