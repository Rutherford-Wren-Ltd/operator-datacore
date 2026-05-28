# Canonical reports — the metric ownership map

The single most important rule in operator-datacore: **every metric reads from the SP-API report that owns it canonically.** No reconstruction. No "let's just calculate it from the Orders Report and a price list." This rule prevents 30-40% revenue under-counting. We learned it the hard way.

This document is the source-of-truth map. The same map is also stored in `meta.report_catalog` (queryable from SQL).

---

## Why no reconstruction

Each Amazon report is its own canonical accounting:

- **Orders Report** tells you what was *placed*.
- **Finances API** tells you what was *settled*.
- **Sales & Traffic Report** tells you what Amazon *shows the seller as revenue*.

These are not the same number. The deltas are not constant. They're a moving function of returns, cancellations, B2B pricing tiers, multi-channel orders, currency adjustments, gift wrap, promotional rebates, and Amazon's internal accounting calendar.

When you reconstruct revenue from `Orders + price + custom maths`, you are silently reproducing Amazon's accounting *minus* every adjustment they apply downstream, and the gap compounds over weeks.

A real client (Dr Bo, May 2026): a dashboard built on Orders-Report-derived revenue ran 30-40% under Seller Central for twelve days. Switching to direct read of `GET_SALES_AND_TRAFFIC_REPORT.ordered_product_sales` collapsed the gap to **$0.00**. The lesson: pick the report Amazon uses, store it verbatim, and report from it. Don't fight Amazon's accounting. You'll lose.

---

## Amazon SP-API ownership map

| Metric | Canonical report / endpoint | Lands in | Granularity | Lag | Active in v1? |
|---|---|---|---|---|---|
| **Revenue, units, sessions, page views, buy box, conversion** | `GET_SALES_AND_TRAFFIC_REPORT` | `brain.sales_traffic_daily` | Day × child ASIN | 24-48h | **YES** |
| Order-level detail (date, qty, status, ship-to country) | `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL` | `brain.orders` + `brain.order_items` | Order line | 30-60 min | scaffolded |
| Fees (referral, FBA, storage, etc.) | `Finances API → listFinancialEvents` | `brain.financial_events` | Event | 24-48h | scaffolded |
| Refunds (financial side) | `Finances API → listFinancialEvents` (RefundEvent type) | `brain.refund_events` (view) | Event | 24-48h | scaffolded |
| Refunds (physical side) | `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA` | `brain.fba_returns` | Return | 24h | scaffolded |
| Payouts to bank | `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` | `brain.settlements` + `brain.settlement_lines` | Settlement | 14-day rolling | scaffolded |
| FBA inventory snapshot | `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA` | `brain.fba_inventory_snapshot` | Day × SKU | 6h | scaffolded |
| FBA reserved inventory (3 buckets) | `GET_RESERVED_INVENTORY_DATA` | `brain.fba_reserved_inventory` | Snapshot × SKU | 15-60 min | scaffolded |
| Inventory ledger movements | `GET_LEDGER_DETAIL_VIEW_DATA` | `brain.inventory_ledger_detail` | Movement | 24h | scaffolded |
| Catalog (titles, images, ASIN ↔ SKU) | `Catalog Items API → getCatalogItem` | `brain.catalog_items` | On-demand | realtime | scaffolded |
| Listings (your offers) | `Listings Items API → getListingsItem` | `brain.listings_items` | Per SKU | realtime | scaffolded |
| Search query performance | `GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT` | `brain.search_query_performance` | Period × ASIN × query | 1 week | **active** (CLI: `npm run backfill-search-query`; daily-sync hook is a Phase 7 follow-up) |
| Subscribe & Save | `Replenishment API → listOffers` | `brain.subscribe_save_offers` | Offer × day | 24h | scaffolded |
| Sponsored Products spend | **Amazon Ads API v3** → `spAdvertisedProduct` report | `brain.ads_sp_daily` | Day × campaign × ad group × target | 24-48h | scaffolded |
| Sponsored Brands spend | **Amazon Ads API v3** → `sbPurchasedProduct` | `brain.ads_sb_daily` | Day | 24-48h | scaffolded |
| Sponsored Display spend | **Amazon Ads API v3** → `sdAdvertisedProduct` | `brain.ads_sd_daily` | Day | 24-48h | scaffolded |

**Notes:**

- Reviews / Q&A: no first-party SP-API endpoint. Out of scope.
- Reports vs. endpoints: Reports are async (request → poll → fetch). Endpoints are sync (request → response). Different rate limits.
- **Settlement reports cannot be requested.** Amazon auto-generates them every ~14 days. The connector polls `getReports` and ingests as they appear.

---

## Specific gotchas baked into the schema

These are the exact gotchas that cost previous client engagements days of debugging. Each is documented in code as well.

### Sales & Traffic
- The response has TWO top-level arrays: `salesAndTrafficByDate` and `salesAndTrafficByAsin`. To get DAY × ASIN granularity you must request **one report per day**.
- Buy box percentage and conversion rate come back as percentages (0-100). We store as fractions (0.0-1.0) for consistency.

### Financial Events (`listFinancialEvents`)
- Fees come back as **negative**. Parser flips signs and stores absolute value in `amount`, with `direction='credit'|'debit'`. Original raw value preserved in `original_amount`.
- Event type names sometimes drop the `EventList` suffix in payloads (e.g. `Shipment Event` not `ShipmentEventList`). Normalise at parse time.
- **Refunds reduce gross sales (Box 1), not net total (Box 4).** Direction-guard the credit-note rule explicitly in rollups.
- Long windows (>14 days) truncate silently. **Chunk to 7-day windows.**
- Deferred events appear weeks later. Re-pull windows that overlap the previous 30 days.

### Orders Report
- Use `BY_LAST_UPDATE_GENERAL` for ingestion (catches status changes). Use `BY_ORDER_DATE_GENERAL` for cohort analysis.
- PII (buyer name, email, full address) is **stripped** in the report. For PII you need the Orders API + Restricted Data Token. operator-datacore deliberately doesn't store PII in v1.

### Settlement
- The XML and v1 flat-file variants are deprecated. Only use `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`.
- One settlement spans 2 weeks. Settlement lines link to orders by `amazon_order_id` but **not all lines have an order ID** (transfers, adjustments, fees-not-tied-to-orders).

### FBA Inventory
- The Manage Inventory snapshot is not equal to "available" everywhere. Pair with the inventory ledger for reconciliation.
- Reserved inventory has three buckets (customer orders, FC transfers, FC processing). **Don't sum them into one.**

### Brand Analytics
- 17-month lookback for monthly Search Query Performance. Older isn't accessible.
- One period per call. You can't span quarters.

### Ads API v3
- Separate OAuth flow from SP-API. Separate refresh tokens.
- 95-day lookback ceiling. Anything older has to come from your own historical exports.
- Reports revise for up to 14 days post-period. Re-pull recent windows.
