# Orders ingest — order headers + item lines

`ingest-orders` pulls Amazon's Orders Report into `brain.orders` and
`brain.order_items`. It is the source for order-level analysis: AOV,
fulfillment-channel mix (AFN vs MFN), ship-to country distribution,
cancellation rates, Prime / B2B split, replacement-order tracking.

> **Not a revenue source.** Canonical revenue lives in
> `brain.sales_traffic_daily` (from `GET_SALES_AND_TRAFFIC_REPORT`).
> See [canonical-reports.md](../canonical-reports.md) for why — reconstructing
> revenue from `Orders + price + custom maths` silently under-counts by
> 30-40% (Dr Bo, May 2026 incident).

## The 30-second version

```powershell
npm run ingest-orders                                    # yesterday's updates, primary region
npm run ingest-orders -- --days 7                        # last 7 days of updates
npm run ingest-orders -- --from 2025-01-01 --to 2025-12-31  # historical window
npm run ingest-orders -- --region na --marketplaces US
npm run ingest-orders -- --skip-existing                 # idempotent re-runs
npm run ingest-orders -- --dry-run                       # banner only, no API
```

## Why `BY_LAST_UPDATE_GENERAL`

This variant returns any order **updated** in the window, so status flips
(Pending → Shipped → Cancelled, refunds, returns) land naturally. The
`BY_ORDER_DATE_GENERAL` variant is the right choice only for cohort analysis
(orders placed in a window) — daily sync wants update-based.

## Chunking

Large windows are split into `<=--chunk-days` (default 30) per marketplace.
This keeps each individual report sized comfortably and the Reports API
quota happy. Each chunk is one createReport call.

For a 12-month UK + US backfill: `2 marketplaces × ceil(365/30) = 26 calls
× ~2-3 min each ≈ 1.5h wall-clock`. Re-run with `--skip-existing` to
recover from a mid-flight failure.

## Idempotency

Re-running the same window replaces affected rows in both tables:

- **`brain.orders`** — header upsert keyed on `(marketplace_id, amazon_order_id)`.
  Status changes (Cancelled, etc.) flow through cleanly.
- **`brain.order_items`** — item upsert keyed on `(amazon_order_id, order_item_id)`,
  where `order_item_id` is synthesized as `sku||'|'||asin` (the TSV doesn't
  carry Amazon's internal `OrderItemId` — that's an Orders API construct).

`--skip-existing` checks `raw.sp_api_report` for completed chunks at the
exact window boundaries and drops matching chunks from the worklist.

## Verification

```sql
-- Order header count + status mix for the last 7 days
SELECT order_status, fulfillment_channel, COUNT(*) AS orders
FROM brain.orders
WHERE purchase_date >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY order_status, fulfillment_channel
ORDER BY orders DESC;

-- Item-level: AOV by marketplace
SELECT o.marketplace_id,
       COUNT(DISTINCT o.amazon_order_id)                                 AS orders,
       ROUND(SUM(oi.item_price * oi.quantity) / COUNT(DISTINCT o.amazon_order_id), 2) AS aov
FROM brain.orders o
JOIN brain.order_items oi USING (amazon_order_id)
WHERE o.purchase_date >= CURRENT_DATE - INTERVAL '30 days'
  AND o.order_status NOT IN ('Cancelled', 'Pending')
GROUP BY o.marketplace_id;

-- Ship-to country mix for the last 30 days (UK marketplace)
SELECT ship_country, COUNT(*) AS orders
FROM brain.orders
WHERE marketplace_id = 'A1F83G8C2ARO7P'
  AND purchase_date >= CURRENT_DATE - INTERVAL '30 days'
  AND ship_country IS NOT NULL
GROUP BY ship_country
ORDER BY orders DESC
LIMIT 20;
```

## Gotchas

- **PII is stripped** by Amazon in this report — no buyer name / email /
  full address. Only ship-city / state / postal / country come through.
  If you need PII it requires the Orders API + Restricted Data Token and
  a separate PII-aware schema (deliberately not in v1).
- **Synthetic `order_item_id`.** The TSV doesn't include Amazon's internal
  OrderItemId — we synthesize as `sku||'|'||asin`. Stable across re-runs.
  Rows where BOTH sku and asin are null are skipped with a warning (rare
  in RW data).
- **One row per (order, item).** Amazon collapses same-SKU duplicates into
  one row with summed `quantity`. An order with two different SKUs lands
  as two `order_items` rows for the same `amazon_order_id`.
- **`order_status` is what Amazon currently shows.** A Cancelled order
  re-appearing in tomorrow's run with status flipped is normal — the
  upsert keeps the latest.
- **No daily-sync hook yet.** This CLI is operator-run. A weekly /
  daily-sync wiring is a Phase 7 follow-up.
