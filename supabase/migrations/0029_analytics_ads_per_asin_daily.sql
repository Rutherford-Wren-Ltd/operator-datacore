-- ============================================================================
-- 0029_analytics_ads_per_asin_daily.sql
-- Unified per-ASIN ads view across SP + SD + SB.
--
-- Today /sku-audit, /wbr, and any TACoS computation has to UNION the three
-- ads_*_daily tables manually. Doing it once at the view layer gives:
--   - One consumer surface for "what's an ASIN's total ad spend / attributed
--     sales / TACoS in a window"
--   - Consistent 14-day attribution window across SP + SD + SB (SD and SB
--     only expose 14d; SP also exposes 7d / 30d but we standardise on 14d
--     for cross-product comparability; SP's 7d stays available as a column
--     for callers who need the canonical "industry standard" attribution)
--   - SB campaign-level cost spread across purchased ASINs by sales share
--     (the canonical per-ASIN SB TACoS pattern documented in 0003 and #68)
--
-- Grain: one row per (marketplace_id, child_asin, metric_date, currency_code).
--
-- Profile → marketplace mapping: today this is hardcoded inline via a VALUES
-- list (UK + US, the two active regions). When EU profiles come online or a
-- third RW seller account is added, switch to a `meta.ads_profile_marketplace`
-- table maintained by `npm run ads-probe` so the view doesn't need editing.
--
-- SB cost allocation: for each (date, marketplace, campaign) we sum the
-- per-purchased-ASIN sales_14d, then allocate the campaign-level cost to
-- each ASIN as `campaign_cost × (asin_sales / campaign_total_sales)`. When
-- a campaign has cost but no purchased-ASIN sales for the day, that cost
-- stays unallocated (doesn't flow to any ASIN). This is mathematically
-- right — we don't have signal to pick which ASIN to charge it to.
--
-- See: `infrastructure/operator-datacore/src/lib/ads-api/sb-ingest.ts` (the
-- ingest that produces the two row types this view joins), and the
-- canonical-reports note about SB needing the join for per-ASIN TACoS.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW analytics.ads_per_asin_daily AS
WITH
profile_market AS (
    -- Profile → marketplace mapping. Hardcoded for now; see header for the
    -- meta-table path.
    SELECT * FROM (VALUES
        ('567327329024034', 'A1F83G8C2ARO7P'),  -- UK
        ('863565062493280', 'ATVPDKIKX0DER')    -- US
    ) AS m(profile_id, marketplace_id)
),
sp_per_asin AS (
    SELECT
        pm.marketplace_id,
        sp.asin                 AS child_asin,
        sp.metric_date,
        sp.currency_code,
        SUM(sp.cost)            AS sp_cost,
        SUM(sp.sales_7d)        AS sp_sales_7d,
        SUM(sp.sales_14d)       AS sp_sales_14d,
        SUM(sp.impressions)     AS sp_impressions,
        SUM(sp.clicks)          AS sp_clicks
    FROM brain.ads_sp_daily sp
    JOIN profile_market pm ON pm.profile_id = sp.profile_id
    WHERE sp.asin IS NOT NULL
    GROUP BY pm.marketplace_id, sp.asin, sp.metric_date, sp.currency_code
),
sd_per_asin AS (
    SELECT
        pm.marketplace_id,
        sd.asin                 AS child_asin,
        sd.metric_date,
        sd.currency_code,
        SUM(sd.cost)            AS sd_cost,
        SUM(sd.sales_14d)       AS sd_sales_14d,
        SUM(sd.impressions)     AS sd_impressions,
        SUM(sd.clicks)          AS sd_clicks
    FROM brain.ads_sd_daily sd
    JOIN profile_market pm ON pm.profile_id = sd.profile_id
    WHERE sd.asin IS NOT NULL
    GROUP BY pm.marketplace_id, sd.asin, sd.metric_date, sd.currency_code
),
sb_asin_sales AS (
    -- Per-purchased-ASIN SB sales rows (entity_key != 'campaign').
    SELECT
        pm.marketplace_id,
        sb.asin                 AS child_asin,
        sb.metric_date,
        sb.currency_code,
        sb.campaign_id,
        SUM(sb.sales_14d)       AS asin_sales_14d
    FROM brain.ads_sb_daily sb
    JOIN profile_market pm ON pm.profile_id = sb.profile_id
    WHERE sb.entity_key != 'campaign'
      AND sb.asin IS NOT NULL
    GROUP BY pm.marketplace_id, sb.asin, sb.metric_date, sb.currency_code, sb.campaign_id
),
sb_campaign_totals AS (
    -- Per-campaign sales total used to compute each ASIN's share.
    SELECT
        marketplace_id,
        metric_date,
        currency_code,
        campaign_id,
        SUM(asin_sales_14d) AS campaign_total_sales
    FROM sb_asin_sales
    GROUP BY marketplace_id, metric_date, currency_code, campaign_id
),
sb_campaign_costs AS (
    -- Campaign-level cost rows from sb_daily (entity_key = 'campaign').
    SELECT
        pm.marketplace_id,
        sb.metric_date,
        sb.currency_code,
        sb.campaign_id,
        SUM(sb.cost)            AS campaign_cost,
        SUM(sb.impressions)     AS campaign_impressions,
        SUM(sb.clicks)          AS campaign_clicks
    FROM brain.ads_sb_daily sb
    JOIN profile_market pm ON pm.profile_id = sb.profile_id
    WHERE sb.entity_key = 'campaign'
    GROUP BY pm.marketplace_id, sb.metric_date, sb.currency_code, sb.campaign_id
),
sb_per_asin AS (
    -- Allocate campaign cost to ASIN by sales share. Campaigns with cost
    -- but no purchased-ASIN sales contribute 0 here — that cost stays
    -- unallocated and shows up only when querying brain.ads_sb_daily
    -- directly with entity_key='campaign'.
    SELECT
        s.marketplace_id,
        s.child_asin,
        s.metric_date,
        s.currency_code,
        SUM(
            CASE
                WHEN ct.campaign_total_sales > 0
                THEN cc.campaign_cost * s.asin_sales_14d / ct.campaign_total_sales
                ELSE 0
            END
        )                       AS sb_allocated_cost,
        SUM(s.asin_sales_14d)   AS sb_sales_14d,
        SUM(
            CASE
                WHEN ct.campaign_total_sales > 0
                THEN cc.campaign_impressions * s.asin_sales_14d / ct.campaign_total_sales
                ELSE 0
            END
        )                       AS sb_allocated_impressions,
        SUM(
            CASE
                WHEN ct.campaign_total_sales > 0
                THEN cc.campaign_clicks * s.asin_sales_14d / ct.campaign_total_sales
                ELSE 0
            END
        )                       AS sb_allocated_clicks
    FROM sb_asin_sales s
    JOIN sb_campaign_totals ct USING (marketplace_id, metric_date, currency_code, campaign_id)
    JOIN sb_campaign_costs  cc USING (marketplace_id, metric_date, currency_code, campaign_id)
    GROUP BY s.marketplace_id, s.child_asin, s.metric_date, s.currency_code
)
SELECT
    -- Universe of (marketplace × ASIN × date × currency) tuples: union all
    -- three sources, then coalesce metrics per source. FULL OUTER JOIN
    -- handles ASINs that have some products' data but not others.
    COALESCE(sp.marketplace_id, sd.marketplace_id, sb.marketplace_id) AS marketplace_id,
    COALESCE(sp.child_asin, sd.child_asin, sb.child_asin)             AS child_asin,
    COALESCE(sp.metric_date, sd.metric_date, sb.metric_date)          AS metric_date,
    COALESCE(sp.currency_code, sd.currency_code, sb.currency_code)    AS currency_code,

    -- Per-product breakdown (NULL when that product has no row for the cell)
    sp.sp_cost,
    sp.sp_sales_7d,
    sp.sp_sales_14d,
    sp.sp_impressions,
    sp.sp_clicks,

    sd.sd_cost,
    sd.sd_sales_14d,
    sd.sd_impressions,
    sd.sd_clicks,

    sb.sb_allocated_cost,
    sb.sb_sales_14d,
    sb.sb_allocated_impressions,
    sb.sb_allocated_clicks,

    -- Unified totals (14d window for cross-product comparability)
    (COALESCE(sp.sp_cost, 0) + COALESCE(sd.sd_cost, 0) + COALESCE(sb.sb_allocated_cost, 0))
        AS total_cost,
    (COALESCE(sp.sp_sales_14d, 0) + COALESCE(sd.sd_sales_14d, 0) + COALESCE(sb.sb_sales_14d, 0))
        AS total_sales_14d,
    -- ACoS = cost / attributed sales. Null when no attributed sales (can't
    -- divide by zero, and it's not meaningful anyway).
    CASE
        WHEN (COALESCE(sp.sp_sales_14d, 0) + COALESCE(sd.sd_sales_14d, 0) + COALESCE(sb.sb_sales_14d, 0)) > 0
        THEN ROUND(
            100 * (COALESCE(sp.sp_cost, 0) + COALESCE(sd.sd_cost, 0) + COALESCE(sb.sb_allocated_cost, 0))::numeric
              / (COALESCE(sp.sp_sales_14d, 0) + COALESCE(sd.sd_sales_14d, 0) + COALESCE(sb.sb_sales_14d, 0)),
            2)
        ELSE NULL
    END                                                               AS acos_14d_pct,
    (COALESCE(sp.sp_impressions, 0) + COALESCE(sd.sd_impressions, 0) + COALESCE(sb.sb_allocated_impressions, 0))
        AS total_impressions,
    (COALESCE(sp.sp_clicks, 0) + COALESCE(sd.sd_clicks, 0) + COALESCE(sb.sb_allocated_clicks, 0))
        AS total_clicks

FROM sp_per_asin sp
FULL OUTER JOIN sd_per_asin sd USING (marketplace_id, child_asin, metric_date, currency_code)
FULL OUTER JOIN sb_per_asin sb USING (marketplace_id, child_asin, metric_date, currency_code);

COMMENT ON VIEW analytics.ads_per_asin_daily IS
'Unified ads metrics per (marketplace × child_asin × day). Sums SP+SD direct cost and SB campaign cost allocated to purchased ASINs by sales share. Standardised on 14-day attribution for cross-product comparability; SP sales_7d also exposed as a column. Use this as the consumer surface instead of UNIONing the brain.ads_*_daily tables. SB allocated columns are NULL/0 until SB data lands via daily ripen or manual --products SP,SD,SB run.';

INSERT INTO meta.migration_history (filename)
VALUES ('0029_analytics_ads_per_asin_daily.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
