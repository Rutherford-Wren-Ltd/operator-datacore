-- ============================================================================
-- 0025_ops_brand_dimension.sql
-- Phase 5 — carry the brand dimension into the ops.* rollups.
--
-- brain.sku_master already has `brand NOT NULL` (migration 0011); this
-- migration carries that label down into the operational rollups so per-brand
-- reporting works without re-deriving the join every time.
--
-- Design calls:
--
-- 1. ops.amazon_daily_summary stays marketplace-level (one row per
--    marketplace × day). That's a stable contract for dashboards / skills
--    that already read it. We don't widen the PK here — it would be a
--    breaking change for any consumer that assumed one-row-per-day.
--
-- 2. A new rollup table ops.amazon_daily_by_brand lands the per-brand cut.
--    PK (marketplace_id, metric_date, brand). One row per
--    (marketplace, day, brand). Sum across brands → marketplace total.
--
-- 3. ops.amazon_daily_by_asin gets a denormalised brand column. Not in the
--    PK (still one row per child_asin per day per marketplace) — just a
--    lookup convenience so ASIN-grain queries don't need to re-JOIN
--    sku_master.
--
-- 4. ASINs not in brain.sku_master (third-party listings, unmapped
--    historical ASINs, etc) land as brand='unknown' — never NULL. Makes
--    "rows we couldn't classify" countable in a single query.
--
-- 5. Same-ASIN-mapped-to-multiple-brand-rows edge case: pick the first by
--    sku_master row order (the natural-key index makes this stable across
--    runs). RW's data has very few same-ASIN-across-brands cases (less
--    than 1% of rows in production as of 2026-06-01) and they're a data
--    cleanup item, not a model question.
--
-- 6. ops.refresh_amazon_daily() now populates the new by-brand rollup and
--    backfills the brand column on by-asin. Idempotent re-run as before.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. ops.amazon_daily_by_asin — add brand column (denormalised; not in PK).
-- ----------------------------------------------------------------------------
ALTER TABLE ops.amazon_daily_by_asin
    ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS idx_ops_amz_asin_brand
    ON ops.amazon_daily_by_asin (brand, metric_date DESC);

COMMENT ON COLUMN ops.amazon_daily_by_asin.brand IS
'Denormalised from brain.sku_master at refresh time. ''unknown'' when the child_asin isn''t in sku_master (third-party listing, unmapped historical, etc). Not part of the PK — one row per (marketplace, day, child_asin) still holds.';

-- ----------------------------------------------------------------------------
-- 2. ops.amazon_daily_by_brand — new rollup table at brand grain.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.amazon_daily_by_brand (
    marketplace_id                  TEXT NOT NULL,
    metric_date                     DATE NOT NULL,
    brand                           TEXT NOT NULL,
    currency_code                   CHAR(3) NOT NULL,
    -- Revenue
    ordered_product_sales           NUMERIC(18, 2) NOT NULL DEFAULT 0,
    ordered_product_sales_b2b       NUMERIC(18, 2) NOT NULL DEFAULT 0,
    -- Units
    units_ordered                   INTEGER NOT NULL DEFAULT 0,
    units_ordered_b2b               INTEGER NOT NULL DEFAULT 0,
    -- Traffic
    sessions                        INTEGER NOT NULL DEFAULT 0,
    sessions_b2b                    INTEGER NOT NULL DEFAULT 0,
    page_views                      INTEGER NOT NULL DEFAULT 0,
    page_views_b2b                  INTEGER NOT NULL DEFAULT 0,
    -- Conversion (weighted by sessions)
    weighted_unit_session_pct       NUMERIC(7, 4),
    -- Context counts
    distinct_asins                  INTEGER NOT NULL DEFAULT 0,
    distinct_skus                   INTEGER NOT NULL DEFAULT 0,
    -- Bookkeeping
    computed_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (marketplace_id, metric_date, brand)
);

CREATE INDEX IF NOT EXISTS idx_ops_amz_brand_date
    ON ops.amazon_daily_by_brand (metric_date DESC, brand);
CREATE INDEX IF NOT EXISTS idx_ops_amz_brand_revenue
    ON ops.amazon_daily_by_brand (metric_date DESC, ordered_product_sales DESC);

COMMENT ON TABLE ops.amazon_daily_by_brand IS
'One row per (marketplace, completed day, brand). Computed from brain.sales_traffic_daily LEFT JOIN brain.sku_master on child_asin. ''unknown'' brand collects ASINs without a sku_master row — keep an eye on that bucket, it''s usually a data gap worth fixing in masters. Sum across brands for a given (marketplace, day) = the row in ops.amazon_daily_summary for that pair.';

-- ----------------------------------------------------------------------------
-- 3. ops.refresh_amazon_daily() — populate brand on by-asin + the by-brand
--    rollup. Existing summary/by-asin upsert paths unchanged in shape.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.refresh_amazon_daily(
    p_from_date DATE DEFAULT NULL,
    p_to_date   DATE DEFAULT NULL
) RETURNS TABLE (rollup_table TEXT, rows_affected BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
    v_from         DATE;
    v_to           DATE;
    v_summary_rows BIGINT;
    v_asin_rows    BIGINT;
    v_brand_rows   BIGINT;
BEGIN
    -- Default window: last 60 completed days. Caller can override.
    v_from := COALESCE(p_from_date, CURRENT_DATE - INTERVAL '60 days');
    v_to   := COALESCE(p_to_date,   CURRENT_DATE - INTERVAL '1 day');

    -- HARD GUARD: never roll up CURRENT_DATE.
    IF v_to >= CURRENT_DATE THEN
        v_to := CURRENT_DATE - INTERVAL '1 day';
    END IF;

    -- ASIN → brand lookup pattern. ~293 rows in sku_master; the planner
    -- inlines this nicely as a hash join in each downstream INSERT. If
    -- sku_master has multiple rows for one ASIN (variants across brands —
    -- rare), MAX gives a deterministic pick. Defined once here as a comment
    -- for clarity; each INSERT below repeats the pattern inline.

    -- 3a. Marketplace summary (unchanged shape).
    INSERT INTO ops.amazon_daily_summary (
        marketplace_id, metric_date, currency_code,
        ordered_product_sales, ordered_product_sales_b2b,
        units_ordered, units_ordered_b2b,
        sessions, sessions_b2b,
        page_views, page_views_b2b,
        weighted_unit_session_pct,
        distinct_asins, distinct_skus,
        computed_at
    )
    SELECT
        marketplace_id,
        metric_date,
        currency_code,
        SUM(ordered_product_sales),
        SUM(ordered_product_sales_b2b),
        SUM(units_ordered),
        SUM(units_ordered_b2b),
        SUM(sessions),
        SUM(sessions_b2b),
        SUM(page_views),
        SUM(page_views_b2b),
        CASE WHEN SUM(sessions) > 0
             THEN SUM(units_ordered)::NUMERIC / NULLIF(SUM(sessions), 0)
             ELSE NULL END,
        COUNT(DISTINCT child_asin),
        COUNT(DISTINCT sku),
        NOW()
    FROM brain.sales_traffic_daily
    WHERE metric_date BETWEEN v_from AND v_to
      AND metric_date < CURRENT_DATE
    GROUP BY marketplace_id, metric_date, currency_code
    ON CONFLICT (marketplace_id, metric_date) DO UPDATE SET
        currency_code              = EXCLUDED.currency_code,
        ordered_product_sales      = EXCLUDED.ordered_product_sales,
        ordered_product_sales_b2b  = EXCLUDED.ordered_product_sales_b2b,
        units_ordered              = EXCLUDED.units_ordered,
        units_ordered_b2b          = EXCLUDED.units_ordered_b2b,
        sessions                   = EXCLUDED.sessions,
        sessions_b2b               = EXCLUDED.sessions_b2b,
        page_views                 = EXCLUDED.page_views,
        page_views_b2b             = EXCLUDED.page_views_b2b,
        weighted_unit_session_pct  = EXCLUDED.weighted_unit_session_pct,
        distinct_asins             = EXCLUDED.distinct_asins,
        distinct_skus              = EXCLUDED.distinct_skus,
        computed_at                = NOW();
    GET DIAGNOSTICS v_summary_rows = ROW_COUNT;

    -- 3b. ASIN-level (now with brand denormalised).
    INSERT INTO ops.amazon_daily_by_asin (
        marketplace_id, metric_date, parent_asin, child_asin, currency_code,
        ordered_product_sales, units_ordered, sessions, page_views,
        unit_session_percentage, buy_box_percentage, brand, computed_at
    )
    SELECT
        std.marketplace_id, std.metric_date, std.parent_asin, std.child_asin, std.currency_code,
        SUM(std.ordered_product_sales),
        SUM(std.units_ordered),
        SUM(std.sessions),
        SUM(std.page_views),
        AVG(std.unit_session_percentage),
        AVG(std.buy_box_percentage),
        COALESCE(MAX(ab.brand), 'unknown') AS brand,
        NOW()
    FROM brain.sales_traffic_daily std
    LEFT JOIN (
        SELECT asin, MAX(brand) AS brand
        FROM brain.sku_master
        WHERE asin IS NOT NULL
        GROUP BY asin
    ) ab ON ab.asin = std.child_asin
    WHERE std.metric_date BETWEEN v_from AND v_to
      AND std.metric_date < CURRENT_DATE
    GROUP BY std.marketplace_id, std.metric_date, std.parent_asin, std.child_asin, std.currency_code
    ON CONFLICT (marketplace_id, metric_date, child_asin) DO UPDATE SET
        parent_asin              = EXCLUDED.parent_asin,
        currency_code            = EXCLUDED.currency_code,
        ordered_product_sales    = EXCLUDED.ordered_product_sales,
        units_ordered            = EXCLUDED.units_ordered,
        sessions                 = EXCLUDED.sessions,
        page_views               = EXCLUDED.page_views,
        unit_session_percentage  = EXCLUDED.unit_session_percentage,
        buy_box_percentage       = EXCLUDED.buy_box_percentage,
        brand                    = EXCLUDED.brand,
        computed_at              = NOW();
    GET DIAGNOSTICS v_asin_rows = ROW_COUNT;

    -- 3c. By-brand rollup (new).
    INSERT INTO ops.amazon_daily_by_brand (
        marketplace_id, metric_date, brand, currency_code,
        ordered_product_sales, ordered_product_sales_b2b,
        units_ordered, units_ordered_b2b,
        sessions, sessions_b2b,
        page_views, page_views_b2b,
        weighted_unit_session_pct,
        distinct_asins, distinct_skus,
        computed_at
    )
    SELECT
        std.marketplace_id,
        std.metric_date,
        COALESCE(ab.brand, 'unknown') AS brand,
        std.currency_code,
        SUM(std.ordered_product_sales),
        SUM(std.ordered_product_sales_b2b),
        SUM(std.units_ordered),
        SUM(std.units_ordered_b2b),
        SUM(std.sessions),
        SUM(std.sessions_b2b),
        SUM(std.page_views),
        SUM(std.page_views_b2b),
        CASE WHEN SUM(std.sessions) > 0
             THEN SUM(std.units_ordered)::NUMERIC / NULLIF(SUM(std.sessions), 0)
             ELSE NULL END,
        COUNT(DISTINCT std.child_asin),
        COUNT(DISTINCT std.sku),
        NOW()
    FROM brain.sales_traffic_daily std
    LEFT JOIN (
        SELECT asin, MAX(brand) AS brand
        FROM brain.sku_master
        WHERE asin IS NOT NULL
        GROUP BY asin
    ) ab ON ab.asin = std.child_asin
    WHERE std.metric_date BETWEEN v_from AND v_to
      AND std.metric_date < CURRENT_DATE
    GROUP BY std.marketplace_id, std.metric_date, std.currency_code,
             COALESCE(ab.brand, 'unknown')
    ON CONFLICT (marketplace_id, metric_date, brand) DO UPDATE SET
        currency_code              = EXCLUDED.currency_code,
        ordered_product_sales      = EXCLUDED.ordered_product_sales,
        ordered_product_sales_b2b  = EXCLUDED.ordered_product_sales_b2b,
        units_ordered              = EXCLUDED.units_ordered,
        units_ordered_b2b          = EXCLUDED.units_ordered_b2b,
        sessions                   = EXCLUDED.sessions,
        sessions_b2b               = EXCLUDED.sessions_b2b,
        page_views                 = EXCLUDED.page_views,
        page_views_b2b             = EXCLUDED.page_views_b2b,
        weighted_unit_session_pct  = EXCLUDED.weighted_unit_session_pct,
        distinct_asins             = EXCLUDED.distinct_asins,
        distinct_skus              = EXCLUDED.distinct_skus,
        computed_at                = NOW();
    GET DIAGNOSTICS v_brand_rows = ROW_COUNT;

    RETURN QUERY VALUES
        ('ops.amazon_daily_summary'::TEXT,  v_summary_rows),
        ('ops.amazon_daily_by_asin'::TEXT,  v_asin_rows),
        ('ops.amazon_daily_by_brand'::TEXT, v_brand_rows);
END;
$$;

COMMENT ON FUNCTION ops.refresh_amazon_daily(DATE, DATE) IS
'Idempotent rollup of brain.sales_traffic_daily into ops tables (summary, by_asin, by_brand). Always filters metric_date < CURRENT_DATE. Joins brain.sku_master for brand; unmatched ASINs land as ''unknown''.';

-- ----------------------------------------------------------------------------
-- 4. analytics.amazon_daily_by_brand — PostgREST-exposed view for dashboards.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.amazon_daily_by_brand AS
SELECT
    marketplace_id,
    metric_date,
    brand,
    currency_code,
    ordered_product_sales,
    ordered_product_sales_b2b,
    units_ordered,
    units_ordered_b2b,
    sessions,
    page_views,
    weighted_unit_session_pct,
    distinct_asins,
    distinct_skus
FROM ops.amazon_daily_by_brand;

COMMENT ON VIEW analytics.amazon_daily_by_brand IS
'PostgREST-exposed read of ops.amazon_daily_by_brand. One row per (marketplace, completed day, brand). brand=''unknown'' = ASINs without a sku_master row.';

-- ----------------------------------------------------------------------------
-- 5. Immediate backfill of brand on existing rows in by-asin.
--    The brand column was just added with DEFAULT='unknown'; this rewrites it
--    from the sku_master lookup so historical rows are immediately accurate.
--    Next ops.refresh_amazon_daily() run also covers this, but doing it here
--    means the migration leaves the table in a usable state without waiting
--    for the next rollup.
-- ----------------------------------------------------------------------------
UPDATE ops.amazon_daily_by_asin pa
   SET brand = COALESCE(ab.brand, 'unknown')
  FROM (
      SELECT asin, MAX(brand) AS brand
      FROM brain.sku_master
      WHERE asin IS NOT NULL
      GROUP BY asin
  ) ab
 WHERE pa.child_asin = ab.asin
   AND pa.brand IS DISTINCT FROM COALESCE(ab.brand, 'unknown');

INSERT INTO meta.migration_history (filename)
VALUES ('0025_ops_brand_dimension.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
