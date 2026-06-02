-- ============================================================================
-- 0027_analytics_inventory_health_by_brand.sql
-- Brand-grain inventory rollup. Companion to ops.amazon_daily_by_brand
-- (migration 0025) so consumers have BOTH sales-by-brand AND
-- inventory-by-brand cuts available without re-JOINing sku_master.
--
-- One row per (marketplace_id × country_code × brand × status).
-- Sums fulfillable + reserved + inbound + 30d units; computes weighted
-- days-cover at the brand grain. ASINs not in sku_master surface as
-- brand='unknown' / status='unknown' (same convention as the by-brand
-- rollup table).
--
-- Why a view, not a materialised table:
--   - analytics.inventory_health_by_asin is already a view (migration 0020),
--     refreshed implicitly when its underlying source (the daily FBA snapshot)
--     lands. A view-of-a-view stays automatically fresh.
--   - The aggregation is cheap (one JOIN to sku_master, GROUP BY) — no need
--     to materialise. If query volume rises this can become a materialised
--     view in a future migration without changing consumers.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW analytics.inventory_health_by_brand AS
SELECT
    ih.marketplace_id,
    ih.country_code,
    COALESCE(sm.brand,  'unknown') AS brand,
    COALESCE(sm.status, 'unknown') AS status,
    COUNT(DISTINCT ih.asin)        AS asins,
    SUM(ih.afn_fulfillable_quantity) AS fulfillable_units,
    SUM(ih.afn_reserved_quantity)    AS reserved_units,
    SUM(ih.afn_inbound_total)        AS inbound_units,
    SUM(ih.units_30d)                AS units_30d,
    -- Weighted days-cover at the brand grain: total fulfillable / total
    -- velocity. Null when total velocity is zero (the cohort isn't selling).
    CASE
        WHEN SUM(ih.units_30d) > 0
        THEN ROUND(SUM(ih.afn_fulfillable_quantity) / (SUM(ih.units_30d) / 30.0), 1)
        ELSE NULL
    END                            AS days_cover_at_30d_rate,
    MAX(ih.lake_age_hours)         AS lake_age_hours,
    MAX(ih.snapshot_date)          AS snapshot_date
FROM analytics.inventory_health_by_asin ih
LEFT JOIN (
    -- One row per ASIN. MAX over duplicates handles same-ASIN-multi-row
    -- (variants across brands — rare). Same pattern as ops.refresh_amazon_daily.
    SELECT asin,
           MAX(brand)  AS brand,
           MAX(status) AS status
    FROM brain.sku_master
    WHERE asin IS NOT NULL
    GROUP BY asin
) sm USING (asin)
GROUP BY
    ih.marketplace_id,
    ih.country_code,
    COALESCE(sm.brand,  'unknown'),
    COALESCE(sm.status, 'unknown');

COMMENT ON VIEW analytics.inventory_health_by_brand IS
'Brand-grain inventory rollup. One row per (marketplace, country, brand, status). Aggregates fulfillable / reserved / inbound / units_30d across ASINs and computes weighted days-cover at the brand level. brand=''unknown'' = ASINs without a sku_master row; status=''unknown'' = same. Companion to ops.amazon_daily_by_brand for sales-side rollups (#74 / migration 0025).';

INSERT INTO meta.migration_history (filename)
VALUES ('0027_analytics_inventory_health_by_brand.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
