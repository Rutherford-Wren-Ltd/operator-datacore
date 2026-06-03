-- ============================================================================
-- 0030_analytics_ads_per_brand_daily.sql
-- Brand-grain rollup of the per-ASIN unified ads view (#82 / 0029).
--
-- Completes the brand triple alongside:
--   - ops.amazon_daily_by_brand          (sales, #74 / 0025)
--   - analytics.inventory_health_by_brand (inventory, #79 / 0027)
--
-- One row per (marketplace_id × brand × metric_date × currency_code).
-- ASINs not in brain.sku_master fall into brand='unknown' (same convention).
--
-- TACoS at brand grain: this view exposes ad cost only. For TACoS
-- (ad_cost / total_revenue), the consumer joins ops.amazon_daily_by_brand
-- on (marketplace_id, brand, metric_date). ACoS at brand grain
-- (ad_cost / ad-attributed sales) is meaningful inside this view and
-- precomputed in acos_14d_pct.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW analytics.ads_per_brand_daily AS
SELECT
    ads.marketplace_id,
    COALESCE(sm.brand, 'unknown') AS brand,
    ads.metric_date,
    ads.currency_code,
    COUNT(DISTINCT ads.child_asin) AS asins,

    -- Per-product breakdown
    SUM(ads.sp_cost)               AS sp_cost,
    SUM(ads.sp_sales_7d)           AS sp_sales_7d,
    SUM(ads.sp_sales_14d)          AS sp_sales_14d,
    SUM(ads.sd_cost)               AS sd_cost,
    SUM(ads.sd_sales_14d)          AS sd_sales_14d,
    SUM(ads.sb_allocated_cost)     AS sb_allocated_cost,
    SUM(ads.sb_sales_14d)          AS sb_sales_14d,

    -- Unified totals (14-day attribution for cross-product comparability)
    SUM(ads.total_cost)            AS total_cost,
    SUM(ads.total_sales_14d)       AS total_sales_14d,
    CASE
        WHEN SUM(ads.total_sales_14d) > 0
        THEN ROUND(100 * SUM(ads.total_cost)::numeric / SUM(ads.total_sales_14d), 2)
        ELSE NULL
    END                            AS acos_14d_pct,

    SUM(ads.total_impressions)     AS total_impressions,
    SUM(ads.total_clicks)          AS total_clicks
FROM analytics.ads_per_asin_daily ads
LEFT JOIN (
    -- One row per ASIN. MAX over duplicates handles same-ASIN-multi-row
    -- (variants across brands — rare). Same pattern as ops.refresh_amazon_daily
    -- and analytics.inventory_health_by_brand.
    SELECT asin, MAX(brand) AS brand
    FROM brain.sku_master
    WHERE asin IS NOT NULL
    GROUP BY asin
) sm ON sm.asin = ads.child_asin
GROUP BY
    ads.marketplace_id,
    COALESCE(sm.brand, 'unknown'),
    ads.metric_date,
    ads.currency_code;

COMMENT ON VIEW analytics.ads_per_brand_daily IS
'Brand-grain rollup of analytics.ads_per_asin_daily. One row per (marketplace × brand × day × currency). Sums SP+SD+SB cost and 14d-attributed sales across the brand''s ASINs and recomputes ACoS at the brand level. For TACoS (ad_cost / total_revenue), JOIN ops.amazon_daily_by_brand on (marketplace_id, brand, metric_date). brand=''unknown'' = ASINs without a sku_master row.';

INSERT INTO meta.migration_history (filename)
VALUES ('0030_analytics_ads_per_brand_daily.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
