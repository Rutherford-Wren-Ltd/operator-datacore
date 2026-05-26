# Useful queries

A starter cookbook of SQL queries you can paste into Supabase SQL Editor (or run from Claude Code) once `brain.sales_traffic_daily` has data.

Every query below uses the canonical `brain.*` and `analytics.*` schemas. None reconstruct revenue from Orders Report (don't, ever).

---

## Health checks

### How fresh is my data?

```sql
SELECT
  marketplace_id,
  MIN(metric_date)        AS oldest_date,
  MAX(metric_date)        AS newest_date,
  COUNT(DISTINCT metric_date) AS days_covered,
  COUNT(*)                AS asin_rows
FROM brain.sales_traffic_daily
GROUP BY marketplace_id
ORDER BY marketplace_id;
```

### Did the daily rollup run today?

```sql
SELECT
  metric_date,
  marketplace_id,
  computed_at,
  ordered_product_sales
FROM ops.amazon_daily_summary
WHERE metric_date >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY metric_date DESC, marketplace_id;
```

### Last 10 sync runs

```sql
SELECT
  started_at,
  source,
  object,
  mode,
  status,
  rows_upserted,
  duration_ms
FROM meta.sync_run
ORDER BY started_at DESC
LIMIT 10;
```

### Sync errors in the last week

```sql
SELECT
  sr.started_at,
  sr.source,
  sr.object,
  sl.level,
  sl.message,
  sl.payload
FROM meta.sync_log sl
JOIN meta.sync_run sr ON sr.sync_run_id = sl.sync_run_id
WHERE sl.level IN ('warn', 'error')
  AND sl.logged_at >= NOW() - INTERVAL '7 days'
ORDER BY sl.logged_at DESC;
```

---

## Revenue and traffic

### Revenue this week vs. last week

```sql
WITH weeks AS (
  SELECT
    CASE
      WHEN metric_date >= CURRENT_DATE - INTERVAL '7 days' THEN 'this_week'
      WHEN metric_date >= CURRENT_DATE - INTERVAL '14 days' THEN 'last_week'
    END AS week,
    marketplace_id,
    ordered_product_sales,
    units_ordered,
    sessions
  FROM brain.sales_traffic_daily
  WHERE metric_date >= CURRENT_DATE - INTERVAL '14 days'
    AND metric_date < CURRENT_DATE
)
SELECT
  marketplace_id,
  week,
  SUM(ordered_product_sales) AS revenue,
  SUM(units_ordered)         AS units,
  SUM(sessions)              AS sessions
FROM weeks
WHERE week IS NOT NULL
GROUP BY marketplace_id, week
ORDER BY marketplace_id, week;
```

### Top 20 ASINs by revenue, last 30 completed days

```sql
SELECT
  child_asin,
  parent_asin,
  MAX(sku) AS sku,
  SUM(ordered_product_sales)::numeric(18, 2) AS revenue_30d,
  SUM(units_ordered)                          AS units_30d,
  SUM(sessions)                               AS sessions_30d,
  ROUND(AVG(unit_session_percentage)::numeric * 100, 2) AS avg_conversion_pct
FROM brain.sales_traffic_daily
WHERE metric_date >= CURRENT_DATE - INTERVAL '30 days'
  AND metric_date < CURRENT_DATE
GROUP BY child_asin, parent_asin
ORDER BY revenue_30d DESC
LIMIT 20;
```

### Daily revenue trend, last 90 days

```sql
SELECT
  metric_date,
  SUM(ordered_product_sales)::numeric(18, 2) AS revenue,
  SUM(units_ordered)                          AS units,
  SUM(sessions)                               AS sessions
FROM brain.sales_traffic_daily
WHERE metric_date >= CURRENT_DATE - INTERVAL '90 days'
  AND metric_date < CURRENT_DATE
GROUP BY metric_date
ORDER BY metric_date;
```

### Year-over-year (this month vs. same month last year)

```sql
WITH months AS (
  SELECT
    CASE
      WHEN metric_date >= DATE_TRUNC('month', CURRENT_DATE) THEN 'this_month'
      WHEN metric_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 year'
       AND metric_date <  DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 year' + INTERVAL '1 month'
       THEN 'same_month_last_year'
    END AS period,
    ordered_product_sales,
    units_ordered
  FROM brain.sales_traffic_daily
  WHERE metric_date < CURRENT_DATE
)
SELECT
  period,
  SUM(ordered_product_sales)::numeric(18, 2) AS revenue,
  SUM(units_ordered)                          AS units
FROM months
WHERE period IS NOT NULL
GROUP BY period
ORDER BY period DESC;
```

---

## Conversion and traffic mix

### Worst-converting ASINs (high traffic, low purchase rate)

These are your priority listings to optimise. High traffic means people care; low conversion means something on the page is killing the sale.

```sql
SELECT
  child_asin,
  MAX(sku) AS sku,
  SUM(sessions) AS sessions_30d,
  SUM(units_ordered) AS units_30d,
  ROUND(SUM(units_ordered)::numeric / NULLIF(SUM(sessions), 0) * 100, 2) AS conversion_pct
FROM brain.sales_traffic_daily
WHERE metric_date >= CURRENT_DATE - INTERVAL '30 days'
  AND metric_date < CURRENT_DATE
GROUP BY child_asin
HAVING SUM(sessions) >= 100
ORDER BY conversion_pct ASC NULLS LAST
LIMIT 20;
```

### Buy box loss — ASINs where you lost the buy box recently

```sql
SELECT
  child_asin,
  metric_date,
  ROUND(buy_box_percentage::numeric * 100, 1) AS buy_box_pct,
  ordered_product_sales,
  sessions
FROM brain.sales_traffic_daily
WHERE metric_date >= CURRENT_DATE - INTERVAL '14 days'
  AND metric_date < CURRENT_DATE
  AND buy_box_percentage < 0.95
  AND sessions > 0
ORDER BY metric_date DESC, buy_box_percentage ASC
LIMIT 30;
```

### Mobile vs. browser traffic split

```sql
SELECT
  metric_date,
  SUM(browser_sessions)    AS browser,
  SUM(mobile_app_sessions) AS mobile_app,
  ROUND(
    SUM(mobile_app_sessions)::numeric
      / NULLIF(SUM(browser_sessions + mobile_app_sessions), 0)
      * 100, 1
  ) AS mobile_share_pct
FROM brain.sales_traffic_daily
WHERE metric_date >= CURRENT_DATE - INTERVAL '60 days'
  AND metric_date < CURRENT_DATE
GROUP BY metric_date
ORDER BY metric_date DESC
LIMIT 30;
```

---

## B2B vs. B2C

### B2B revenue share

```sql
SELECT
  marketplace_id,
  SUM(ordered_product_sales)     AS b2c_revenue,
  SUM(ordered_product_sales_b2b) AS b2b_revenue,
  ROUND(
    SUM(ordered_product_sales_b2b)::numeric
      / NULLIF(SUM(ordered_product_sales + ordered_product_sales_b2b), 0)
      * 100, 1
  ) AS b2b_share_pct
FROM brain.sales_traffic_daily
WHERE metric_date >= CURRENT_DATE - INTERVAL '90 days'
  AND metric_date < CURRENT_DATE
GROUP BY marketplace_id;
```

---

## Cross-marketplace (uses analytics.* with FX conversion)

### Total revenue across all marketplaces, in your reporting currency

Requires `meta.fx_rates` to have rates for the marketplaces you're combining. v1 ships with USD=USD only — extend via the FX homework runbook.

```sql
SELECT
  metric_date,
  SUM(revenue_native)    AS revenue_native_mixed,
  SUM(revenue_reporting) AS revenue_reporting,
  reporting_currency
FROM analytics.amazon_daily
WHERE metric_date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY metric_date, reporting_currency
ORDER BY metric_date DESC;
```

### Top ASINs across all marketplaces

```sql
SELECT *
FROM analytics.amazon_top_asins
ORDER BY revenue_reporting_30d DESC NULLS LAST
LIMIT 20;
```

---

## Verification

### Single date drill-down (compare to Seller Central)

Pick any specific date you want to verify. Open Seller Central → Reports → Business Reports → Sales and Traffic by Date for the same date and compare.

```sql
SELECT
  marketplace_id,
  currency_code,
  SUM(ordered_product_sales)     AS revenue_b2c,
  SUM(ordered_product_sales_b2b) AS revenue_b2b,
  SUM(ordered_product_sales) + SUM(ordered_product_sales_b2b) AS revenue_total,
  SUM(units_ordered)             AS units_b2c,
  SUM(units_ordered_b2b)         AS units_b2b,
  SUM(sessions)                  AS sessions
FROM brain.sales_traffic_daily
WHERE metric_date = '2026-04-30'   -- change this
GROUP BY marketplace_id, currency_code
ORDER BY marketplace_id;
```

---

## Inventory health

### What's the current state for one SKU?

```sql
SELECT *
FROM analytics.fba_inventory_latest
WHERE sku = 'MD05GTS';   -- change this
```

Returns the most recent snapshot row. Only SKUs with actual or inbound inventory appear here (zero-inventory SKUs are filtered at ingest).

### Days-of-cover for one ASIN

All rate-metric queries use `analytics.inventory_health_by_asin` (one row per
marketplace × ASIN, NewItem condition, fulfillable summed across FNSKUs). The
per-row `analytics.inventory_health` deliberately drops `days_on_hand_*` — per-row
stock over per-ASIN velocity is meaningless when an ASIN has multiple bins.

```sql
SELECT
  asin,
  country_code,
  afn_fulfillable_quantity,
  afn_inbound_total,
  units_per_day,
  days_on_hand_fulfillable,    -- conservative read (ignores inbound)
  days_on_hand_with_inbound,   -- optimistic read
  fnsku_count, sku_alias_count -- > 1 flags phantom / multi-bin ASINs
FROM analytics.inventory_health_by_asin
WHERE asin = 'B0F9YZ46ND';   -- change this
```

`days_on_hand_*` is `NULL` when there's no 30-day sales velocity (new ASIN, paused, or data lake gap). That's intentional — distinguishes "needs investigation" from "out of stock."

### ASINs at risk — under 30 days of cover, sorted by urgency

```sql
SELECT
  country_code,
  asin,
  product_name,
  afn_fulfillable_quantity,
  units_per_day,
  days_on_hand_fulfillable
FROM analytics.inventory_health_by_asin
WHERE days_on_hand_fulfillable IS NOT NULL
  AND days_on_hand_fulfillable < 30
ORDER BY days_on_hand_fulfillable ASC;
```

The threshold is operator-specific — bump to 60 / 90 for ASINs with long lead times.

### Overstock — ASINs with more than 180 days of cover

```sql
SELECT
  country_code,
  asin,
  product_name,
  afn_total_quantity,
  units_per_day,
  days_on_hand_total
FROM analytics.inventory_health_by_asin
WHERE days_on_hand_total > 180
ORDER BY days_on_hand_total DESC;
```

Useful for spotting capital tied up in slow-moving stock.

### Per-SKU / per-bin inventory (forensic / ops use)

When you need to see every SKU listing or every FC bin for an ASIN (e.g. to find
phantom listings, audit Used-condition stock, or reconcile against a Seller Central
manage-inventory screen):

```sql
SELECT
  sku, fnsku, asin, condition,
  afn_fulfillable_quantity, afn_reserved_quantity, afn_inbound_total,
  sku_count, all_skus
FROM analytics.inventory_health    -- per (marketplace, fnsku, condition)
WHERE asin = 'B0F9YZ46ND';
```

`sku_count > 1` on a row means that FNSKU bin is reported under multiple SKU aliases
(`all_skus` lists them) — typically phantom listings from a SKU rename. Per-row
`days_on_hand_*` columns are intentionally absent.

---

## Audit / debugging

### How many raw payloads have been ingested but not parsed?

```sql
SELECT
  report_type,
  COUNT(*) FILTER (WHERE parsed_at IS NULL)  AS unparsed,
  COUNT(*) FILTER (WHERE parsed_at IS NOT NULL) AS parsed
FROM raw.sp_api_report
GROUP BY report_type;
```

### Find the raw payload behind any brain row

```sql
SELECT
  std.metric_date,
  std.child_asin,
  std.ordered_product_sales,
  raw.report_id,
  raw.fetched_at,
  raw.payload->'reportSpecification' AS report_spec
FROM brain.sales_traffic_daily std
JOIN raw.sp_api_report raw ON raw.raw_id = std.raw_id
WHERE std.child_asin = 'B0XXXXXXX'   -- change this
ORDER BY std.metric_date DESC
LIMIT 10;
```

---

## Plug into Claude Code

Once `operator-datacore` is paired with [`amazon-operator-stack`](https://github.com/ShubhashSharma/amazon-operator-stack), you can ask Claude things like:

> "Show me the worst-converting ASINs from the last 30 days, with at least 100 sessions, ordered by conversion rate ascending."

> "Compare revenue this month to the same month last year, by marketplace."

> "Pull the raw Sales & Traffic payload behind ASIN B0XXXXXXX on 2026-04-15."

Claude reads the schema, generates the SQL, runs it, and shows you the result. The queries above are just for when you want to write them yourself.
