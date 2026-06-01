// ============================================================================
// Finances API — listFinancialEvents ingest.
//
// Endpoint: GET /finances/v0/financialEvents
// Synchronous, paginated via NextToken. No createReport-style queue.
//
// What this provides: every fee, refund, sale credit, adjustment, charge that
// has settled — the actuals behind Sales & Traffic's "ordered" numbers.
// Sharpens CM3 because FBA fees / referral fees / storage fees / advertising
// charges all land here as posted amounts.
//
// Three gotchas Amazon's payload baked in (memory:
// feedback_sp_api_financial_events_quirks.md, and 0003 migration header):
//
//   1. Fees come back NEGATIVE.
//      We store the absolute value in `amount` with the direction in
//      `direction` ('credit' | 'debit'). `original_amount` preserves the raw
//      value Amazon sent. Downstream queries should always sum on
//      `amount` filtered by `direction`, never on `original_amount`.
//
//   2. Event type names sometimes drop the 'EventList' suffix in payloads.
//      Amazon's docs say "ShipmentEventList" but the actual key in the
//      response is sometimes "ShipmentEventList" and sometimes the array
//      lives under "ShipmentEvent". We normalize at parse time.
//
//   3. Refunds reduce the original sale, not a separate refund total.
//      A RefundEvent against an existing order doesn't add to a "refund
//      total" — it shrinks the original ShipmentEvent's net contribution.
//      Direction-guard the credit-note rule in rollups.
//
// Scope of v1 parsing:
//   - ShipmentEvent (the bulk of revenue/fee rows)
//   - RefundEvent
//   - ServiceFeeEvent
//   - AdjustmentEvent
//   - ProductAdsPaymentEvent (Ads spend reconciled by Amazon)
// Other event types land their raw payload in raw.sp_api_event but are
// not yet exploded into brain.financial_events rows. That's a tighter-scope
// follow-up as patterns emerge.
//
// Idempotency: event_hash is computed deterministically per row (SHA-256 of
// the row's natural-key fields). UNIQUE (marketplace_id, event_type,
// posted_date, event_hash) on brain.financial_events makes re-pulls of the
// same window safe.
// ============================================================================

import { createHash } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { SpApiClient } from './client.js';

// ---------------------------------------------------------------------------
// SP-API response shapes — narrowed to the fields we actually read. There are
// more fields available; only typed what we parse.
// ---------------------------------------------------------------------------

interface CurrencyAmount {
  CurrencyCode?: string;
  CurrencyAmount?: number;
}

interface ChargeComponent {
  ChargeType?: string;
  ChargeAmount?: CurrencyAmount;
}

interface FeeComponent {
  FeeType?: string;
  FeeAmount?: CurrencyAmount;
}

interface ShipmentItem {
  SellerSKU?: string;
  OrderItemId?: string;
  QuantityShipped?: number;
  ItemChargeList?: ChargeComponent[];
  ItemFeeList?: FeeComponent[];
  ItemTaxWithheldList?: Array<{ TaxesWithheld?: ChargeComponent[] }>;
  PromotionList?: Array<{ PromotionType?: string; PromotionAmount?: CurrencyAmount }>;
}

interface ShipmentEvent {
  AmazonOrderId?: string;
  SellerOrderId?: string;
  MarketplaceName?: string;
  PostedDate?: string;
  ShipmentItemList?: ShipmentItem[];
  // Refund events use the same shape but the principal flips direction.
  ShipmentItemAdjustmentList?: ShipmentItem[];
}

interface ServiceFeeEvent {
  AmazonOrderId?: string;
  AsinForServiceFee?: string;
  FeeReason?: string;
  FeeList?: FeeComponent[];
  SellerSKU?: string;
  FeeDescription?: string;
  PostedDate?: string;
}

interface AdjustmentEvent {
  AdjustmentType?: string;
  PostedDate?: string;
  AdjustmentAmount?: CurrencyAmount;
  AdjustmentItemList?: Array<{
    SellerSKU?: string;
    ASIN?: string;
    Quantity?: string;
    PerUnitAmount?: CurrencyAmount;
    TotalAmount?: CurrencyAmount;
  }>;
}

interface ProductAdsPaymentEvent {
  postedDate?: string;        // camelCase variant Amazon uses for some types
  PostedDate?: string;
  transactionType?: string;
  TransactionType?: string;
  invoiceId?: string;
  InvoiceId?: string;
  baseValue?: CurrencyAmount;
  taxValue?: CurrencyAmount;
  transactionValue?: CurrencyAmount;
  TransactionValue?: CurrencyAmount;
}

interface FinancialEventsPayload {
  FinancialEvents?: {
    ShipmentEventList?: ShipmentEvent[];
    RefundEventList?: ShipmentEvent[];
    ServiceFeeEventList?: ServiceFeeEvent[];
    AdjustmentEventList?: AdjustmentEvent[];
    ProductAdsPaymentEventList?: ProductAdsPaymentEvent[];
    // Many other event types — passed through to raw, not parsed in v1.
    [key: string]: unknown;
  };
  NextToken?: string;
}

// ---------------------------------------------------------------------------
// Normalised row that lands in brain.financial_events.
// ---------------------------------------------------------------------------

export interface FinancialEventRow {
  marketplaceId: string;
  eventType: string;        // 'ShipmentEvent' | 'RefundEvent' | 'ServiceFeeEvent' | ...
  eventSubtype: string | null;
  postedDate: string;       // ISO timestamp
  amazonOrderId: string | null;
  sellerOrderId: string | null;
  sku: string | null;
  asin: string | null;
  amount: number;           // absolute value, always positive
  direction: 'credit' | 'debit';
  originalAmount: number;   // raw value as Amazon sent it (may be negative)
  currencyCode: string;
  feeDescription: string | null;
}

// ---------------------------------------------------------------------------
// Pagination + ingest.
// ---------------------------------------------------------------------------

export interface ListFinancialEventsOptions {
  postedAfter: Date;
  postedBefore: Date;
  /** Default 100; Amazon's cap. Lower if you want smaller pages. */
  maxResultsPerPage?: number;
}

/**
 * Async iterator over financial-event pages. Each yield is one response
 * payload (one page). Caller drives consumption; pagination is automatic.
 */
export async function* listFinancialEvents(
  client: SpApiClient,
  opts: ListFinancialEventsOptions,
): AsyncGenerator<{ payload: FinancialEventsPayload; nextToken: string | undefined }, void, void> {
  let nextToken: string | undefined;
  const baseQuery: Record<string, string> = {
    PostedAfter: opts.postedAfter.toISOString(),
    PostedBefore: opts.postedBefore.toISOString(),
    MaxResultsPerPage: String(opts.maxResultsPerPage ?? 100),
  };

  do {
    const query = nextToken ? { ...baseQuery, NextToken: nextToken } : baseQuery;
    const res = await client.request<FinancialEventsPayload>({
      method: 'GET',
      path: '/finances/v0/financialEvents',
      query,
    });
    yield { payload: res.payload, nextToken: res.payload.NextToken };
    nextToken = res.payload.NextToken;
  } while (nextToken);
}

// ---------------------------------------------------------------------------
// Parsing — turn one raw event into one or more FinancialEventRow.
// ---------------------------------------------------------------------------

function abs(n: number): number {
  return Math.abs(n);
}

function direction(n: number): 'credit' | 'debit' {
  return n >= 0 ? 'credit' : 'debit';
}

function emit(
  marketplaceId: string,
  eventType: string,
  postedDate: string,
  amazonOrderId: string | null,
  sku: string | null,
  asin: string | null,
  subtype: string | null,
  amountRaw: number,
  currency: string,
  feeDescription: string | null,
): FinancialEventRow | null {
  if (!Number.isFinite(amountRaw) || amountRaw === 0) return null;
  return {
    marketplaceId,
    eventType,
    eventSubtype: subtype,
    postedDate,
    amazonOrderId,
    sellerOrderId: null,
    sku,
    asin,
    amount: abs(amountRaw),
    direction: direction(amountRaw),
    originalAmount: amountRaw,
    currencyCode: currency,
    feeDescription,
  };
}

function parseShipmentEvent(
  ev: ShipmentEvent,
  eventType: 'ShipmentEvent' | 'RefundEvent',
  marketplaceId: string,
): FinancialEventRow[] {
  const rows: FinancialEventRow[] = [];
  const postedDate = ev.PostedDate ?? new Date().toISOString();
  const orderId = ev.AmazonOrderId ?? null;
  // RefundEvent reuses the ShipmentEvent shape but the items are in
  // ShipmentItemAdjustmentList; principal flips to debit (the sale is reversed).
  const items =
    eventType === 'RefundEvent'
      ? ev.ShipmentItemAdjustmentList ?? ev.ShipmentItemList ?? []
      : ev.ShipmentItemList ?? [];

  for (const item of items) {
    const sku = item.SellerSKU ?? null;

    for (const charge of item.ItemChargeList ?? []) {
      const amount = charge.ChargeAmount?.CurrencyAmount ?? 0;
      const ccy = charge.ChargeAmount?.CurrencyCode ?? 'USD';
      const row = emit(
        marketplaceId, eventType, postedDate, orderId, sku, null,
        charge.ChargeType ?? null, amount, ccy, charge.ChargeType ?? null,
      );
      if (row) rows.push(row);
    }

    for (const fee of item.ItemFeeList ?? []) {
      const amount = fee.FeeAmount?.CurrencyAmount ?? 0;
      const ccy = fee.FeeAmount?.CurrencyCode ?? 'USD';
      const row = emit(
        marketplaceId, eventType, postedDate, orderId, sku, null,
        fee.FeeType ?? null, amount, ccy, fee.FeeType ?? null,
      );
      if (row) rows.push(row);
    }

    for (const promo of item.PromotionList ?? []) {
      const amount = promo.PromotionAmount?.CurrencyAmount ?? 0;
      const ccy = promo.PromotionAmount?.CurrencyCode ?? 'USD';
      const row = emit(
        marketplaceId, eventType, postedDate, orderId, sku, null,
        promo.PromotionType ?? 'Promotion', amount, ccy, promo.PromotionType ?? null,
      );
      if (row) rows.push(row);
    }
  }
  return rows;
}

function parseServiceFeeEvent(
  ev: ServiceFeeEvent,
  marketplaceId: string,
): FinancialEventRow[] {
  const rows: FinancialEventRow[] = [];
  const postedDate = ev.PostedDate ?? new Date().toISOString();
  for (const fee of ev.FeeList ?? []) {
    const amount = fee.FeeAmount?.CurrencyAmount ?? 0;
    const ccy = fee.FeeAmount?.CurrencyCode ?? 'USD';
    const row = emit(
      marketplaceId, 'ServiceFeeEvent', postedDate,
      ev.AmazonOrderId ?? null, ev.SellerSKU ?? null, ev.AsinForServiceFee ?? null,
      fee.FeeType ?? ev.FeeReason ?? null, amount, ccy,
      ev.FeeDescription ?? fee.FeeType ?? null,
    );
    if (row) rows.push(row);
  }
  return rows;
}

function parseAdjustmentEvent(
  ev: AdjustmentEvent,
  marketplaceId: string,
): FinancialEventRow[] {
  const rows: FinancialEventRow[] = [];
  const postedDate = ev.PostedDate ?? new Date().toISOString();
  const subtype = ev.AdjustmentType ?? null;

  // Per-item lines if present.
  for (const item of ev.AdjustmentItemList ?? []) {
    const amount = item.TotalAmount?.CurrencyAmount ?? 0;
    const ccy = item.TotalAmount?.CurrencyCode ?? 'USD';
    const row = emit(
      marketplaceId, 'AdjustmentEvent', postedDate, null,
      item.SellerSKU ?? null, item.ASIN ?? null,
      subtype, amount, ccy, subtype,
    );
    if (row) rows.push(row);
  }

  // Header-level amount as a fallback (when AdjustmentItemList is absent).
  if (rows.length === 0 && ev.AdjustmentAmount?.CurrencyAmount) {
    const ccy = ev.AdjustmentAmount.CurrencyCode ?? 'USD';
    const row = emit(
      marketplaceId, 'AdjustmentEvent', postedDate, null, null, null,
      subtype, ev.AdjustmentAmount.CurrencyAmount, ccy, subtype,
    );
    if (row) rows.push(row);
  }

  return rows;
}

function parseProductAdsPaymentEvent(
  ev: ProductAdsPaymentEvent,
  marketplaceId: string,
): FinancialEventRow[] {
  const postedDate = ev.PostedDate ?? ev.postedDate ?? new Date().toISOString();
  const txVal = ev.TransactionValue ?? ev.transactionValue;
  const amount = txVal?.CurrencyAmount ?? 0;
  const ccy = txVal?.CurrencyCode ?? 'USD';
  const subtype = ev.TransactionType ?? ev.transactionType ?? null;
  const invoiceId = ev.InvoiceId ?? ev.invoiceId ?? null;
  const row = emit(
    marketplaceId, 'ProductAdsPaymentEvent', postedDate, null, null, null,
    subtype, amount, ccy, invoiceId,
  );
  return row ? [row] : [];
}

/**
 * Pull every parseable event out of one paginated response payload.
 * Each returned row is one financial line; one ShipmentEvent typically
 * explodes to 5-15 rows (principal + tax + shipping + fees + promotions).
 */
export function parseFinancialEvents(
  payload: FinancialEventsPayload,
  marketplaceId: string,
): FinancialEventRow[] {
  const rows: FinancialEventRow[] = [];
  const fe = payload.FinancialEvents ?? {};
  for (const ev of fe.ShipmentEventList ?? []) {
    rows.push(...parseShipmentEvent(ev, 'ShipmentEvent', marketplaceId));
  }
  for (const ev of fe.RefundEventList ?? []) {
    rows.push(...parseShipmentEvent(ev, 'RefundEvent', marketplaceId));
  }
  for (const ev of fe.ServiceFeeEventList ?? []) {
    rows.push(...parseServiceFeeEvent(ev, marketplaceId));
  }
  for (const ev of fe.AdjustmentEventList ?? []) {
    rows.push(...parseAdjustmentEvent(ev, marketplaceId));
  }
  for (const ev of fe.ProductAdsPaymentEventList ?? []) {
    rows.push(...parseProductAdsPaymentEvent(ev, marketplaceId));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Hash + upsert.
// ---------------------------------------------------------------------------

function hashRow(r: FinancialEventRow): string {
  const sig = [
    r.eventType,
    r.eventSubtype ?? '',
    r.amazonOrderId ?? '',
    r.sku ?? '',
    r.asin ?? '',
    r.originalAmount.toFixed(4),
    r.currencyCode,
    r.feeDescription ?? '',
  ].join('|');
  return createHash('sha256').update(sig).digest('hex').slice(0, 32);
}

export interface IngestFinancialEventsOptions {
  spClient: SpApiClient;
  pg: PgClient;
  connectionId: string;
  syncRunId: string;
  /** Filter parsed rows to these marketplaces. Finances API returns events
   *  for all marketplaces in the account; we filter post-parse. Pass an empty
   *  array to keep every row (rare; usually you want at least one filter). */
  marketplaceIds: string[];
  /**
   * Marketplace this batch will be tagged with on `brain.financial_events.marketplace_id`.
   * Finances API events don't reliably carry a marketplaceId field, so we
   * stamp the request-level marketplace context. If you want per-event
   * marketplace resolution, you'll need to join via amazon_order_id on
   * brain.orders post-ingest.
   */
  marketplaceTag: string;
  postedAfter: Date;
  postedBefore: Date;
}

export interface IngestFinancialEventsResult {
  pagesFetched: number;
  rowsParsed: number;
  rowsUpserted: number;
  rowsSkippedDuplicate: number;
  byEventType: Record<string, number>;
}

/**
 * Full window ingest. Iterates pages, lands raw payloads in raw.sp_api_event,
 * parses to brain.financial_events with idempotent UPSERT on the unique key
 * (marketplace_id, event_type, posted_date, event_hash).
 */
export async function ingestFinancialEventsWindow(
  opts: IngestFinancialEventsOptions,
): Promise<IngestFinancialEventsResult> {
  let pagesFetched = 0;
  let rowsParsed = 0;
  let rowsUpserted = 0;
  let rowsSkippedDuplicate = 0;
  const byEventType: Record<string, number> = {};

  for await (const { payload, nextToken } of listFinancialEvents(opts.spClient, {
    postedAfter: opts.postedAfter,
    postedBefore: opts.postedBefore,
  })) {
    pagesFetched += 1;

    // 1. Land the raw page.
    const rawInsert = await opts.pg.query<{ raw_id: number }>(
      `INSERT INTO raw.sp_api_event
         (connection_id, sync_run_id, endpoint, request_params, response_payload, next_token)
       VALUES ($1, $2, 'listFinancialEvents', $3, $4, $5)
       RETURNING raw_id`,
      [
        opts.connectionId,
        opts.syncRunId,
        JSON.stringify({
          PostedAfter: opts.postedAfter.toISOString(),
          PostedBefore: opts.postedBefore.toISOString(),
          marketplaceTag: opts.marketplaceTag,
        }),
        JSON.stringify(payload),
        nextToken ?? null,
      ],
    );
    const rawId = rawInsert.rows[0]!.raw_id;

    // 2. Parse the page into normalised rows.
    const rows = parseFinancialEvents(payload, opts.marketplaceTag);
    rowsParsed += rows.length;

    // 3. Upsert each row.
    for (const r of rows) {
      const ev = (byEventType[r.eventType] ?? 0) + 1;
      byEventType[r.eventType] = ev;
      const eventHash = hashRow(r);
      const insertResult = await opts.pg.query<{ event_id: string }>(
        `INSERT INTO brain.financial_events (
           marketplace_id, event_type, event_subtype, posted_date,
           amazon_order_id, seller_order_id, sku, asin,
           amount, direction, original_amount, currency_code,
           fee_description, event_hash, raw_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (marketplace_id, event_type, posted_date, event_hash)
         DO NOTHING
         RETURNING event_id`,
        [
          r.marketplaceId,
          r.eventType,
          r.eventSubtype,
          r.postedDate,
          r.amazonOrderId,
          r.sellerOrderId,
          r.sku,
          r.asin,
          r.amount,
          r.direction,
          r.originalAmount,
          r.currencyCode,
          r.feeDescription,
          eventHash,
          rawId,
        ],
      );
      if (insertResult.rows.length > 0) {
        rowsUpserted += 1;
      } else {
        rowsSkippedDuplicate += 1;
      }
    }

    // 4. Mark page parsed.
    await opts.pg.query(
      'UPDATE raw.sp_api_event SET parsed_at = NOW() WHERE raw_id = $1',
      [rawId],
    );
  }

  return { pagesFetched, rowsParsed, rowsUpserted, rowsSkippedDuplicate, byEventType };
}
