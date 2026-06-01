# Finances ingest — `brain.financial_events`

`ingest-finances` pulls SP-API `listFinancialEvents` into `brain.financial_events`.
These are the **settled** amounts: every fee, refund, sale credit, adjustment,
ad-spend reconciliation that posted in the window.

> **Not a revenue source.** Canonical revenue stays in
> `brain.sales_traffic_daily` (see [canonical-reports.md](../canonical-reports.md)
> and the Dr Bo 30-40% under-count incident). This data sharpens **CM3** —
> the actual fees behind a sale, not the estimates.

## The 30-second version

```powershell
npm run ingest-finances                       # yesterday only
npm run ingest-finances -- --days 7           # last 7 days of posted events
npm run ingest-finances -- --from 2025-01-01 --to 2025-01-31
npm run ingest-finances -- --region na        # NA region instead of primary
npm run ingest-finances -- --dry-run
```

## Three things to know about Amazon's payload

(these are baked into the parser; you only need them if you're querying the
raw lake or extending the parser):

1. **Fees come back NEGATIVE.** The parser stores absolute value in `amount`
   with the direction in `direction` (`'credit'` | `'debit'`). `original_amount`
   preserves Amazon's raw sign. **Always sum on `amount` filtered by
   `direction`** — never on `original_amount`.
2. **Event-list keys vary.** Amazon's docs say `ShipmentEventList` but the
   payload sometimes uses bare `ShipmentEvent`. The parser handles both.
3. **Refunds shrink the original sale**, they don't accumulate to a separate
   refund total. A RefundEvent against an order doesn't add to a "refund
   total"; it reduces the original ShipmentEvent's net contribution.

## What v1 parses

| Event type | Source list in payload | What lands |
|---|---|---|
| `ShipmentEvent` | `FinancialEvents.ShipmentEventList` | One row per `ItemChargeList` / `ItemFeeList` / `PromotionList` entry per shipment item. Principal, tax, shipping, fees, promo discounts. |
| `RefundEvent` | `FinancialEvents.RefundEventList` | Same structure as ShipmentEvent; principal direction flips (debit). |
| `ServiceFeeEvent` | `FinancialEvents.ServiceFeeEventList` | One row per fee in `FeeList`. FBA storage, etc. |
| `AdjustmentEvent` | `FinancialEvents.AdjustmentEventList` | Per-item rows from `AdjustmentItemList`; header amount as fallback. |
| `ProductAdsPaymentEvent` | `FinancialEvents.ProductAdsPaymentEventList` | One row per ad-spend reconciliation. |

Other event types (CouponPaymentEvent, ChargebackEvent, LoanServicingEvent,
SAFETReimbursementEvent, ...) land their raw payload in `raw.sp_api_event` but
are not yet exploded into `brain.financial_events` rows. That's a tighter-scope
follow-up when patterns emerge — the raw is preserved either way.

## Idempotency

`brain.financial_events` has `UNIQUE (marketplace_id, event_type, posted_date,
event_hash)`. `event_hash` is a deterministic SHA-256 of the row's natural-key
fields (event_type, subtype, order_id, sku, asin, original_amount, currency,
fee_description). Re-pulling the same window produces zero new rows; the
upsert does `ON CONFLICT DO NOTHING`.

## Marketplace tagging

The Finances API **doesn't filter by marketplace on the request side** — it
returns events for the whole account. We stamp every row with the
`--marketplace-tag` value (defaults to the region's primary marketplace).
For per-event marketplace resolution post-ingest, JOIN to `brain.orders`
by `amazon_order_id`.

## Verification queries

```sql
-- Recent activity by event type
SELECT event_type, direction,
       COUNT(*) AS rows,
       SUM(amount) AS gross,
       MIN(posted_date) AS earliest, MAX(posted_date) AS latest
FROM brain.financial_events
WHERE posted_date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY event_type, direction
ORDER BY event_type, direction;

-- Per-order net (sale credits - all debits) for a known order
SELECT amazon_order_id,
       SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END) AS net,
       currency_code,
       array_agg(DISTINCT event_type)    AS event_types,
       array_agg(DISTINCT event_subtype) AS subtypes
FROM brain.financial_events
WHERE amazon_order_id = '206-1234567-1234567'   -- change this
GROUP BY amazon_order_id, currency_code;

-- FBA fee total for the last 30 days
SELECT event_subtype, SUM(amount) AS total
FROM brain.financial_events
WHERE event_type = 'ShipmentEvent'
  AND direction = 'debit'
  AND event_subtype LIKE 'FBA%'
  AND posted_date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY event_subtype
ORDER BY total DESC;

-- Refunds joined to original orders (uses brain.refund_events view)
SELECT amazon_order_id, posted_date, original_purchase_date,
       SUM(amount) AS refund_amount, currency_code
FROM brain.refund_events
WHERE posted_date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY amazon_order_id, posted_date, original_purchase_date, currency_code
ORDER BY refund_amount DESC
LIMIT 20;
```

## Gotchas

- **`marketplace_id` is stamped per-request, not per-event.** If you pull a
  window with `--marketplace-tag UK` but your account also sold on US in
  that window, the US events still land with marketplace_id='A1F83G8C2ARO7P'.
  Filter via JOIN on `brain.orders` if you need true per-event marketplace.
- **`amazon_order_id` is NULL on non-order events.** ServiceFeeEvents
  (storage fees, etc.) typically don't carry an order id; the row's `sku`
  and `asin` may still be set.
- **`posted_date` is the financial-posting date**, not the order date.
  An order placed 2025-01-10 might post in 2025-01-12's events. Always join
  via `amazon_order_id` if you need order-date semantics.
- **Pagination is on PostedDate, not natural ordering.** Pages are NOT
  guaranteed in date order. Don't try to short-circuit on "last seen date";
  drink the full window.
- **No daily-sync hook yet.** This CLI is operator-run. A weekly /
  daily-sync wiring is a Phase 7 follow-up.

## Backfill horizon

Amazon's Finances API documents ~2 years of retention but the actual cliff
varies. If the call 400s for an older window, narrow it. Re-runs are
idempotent so progressively widening is safe.
