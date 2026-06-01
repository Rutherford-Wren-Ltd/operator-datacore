-- ============================================================================
-- 0024_brain_demand_forecast_modeled.sql
-- Phase 11 v1 — SQL-only data-lake-driven demand forecast.
--
-- Replaces (over time) the interim manual spreadsheet ('operator_tool')
-- with a baseline forecast computed directly from brain.sales_traffic_daily.
-- Lands rows into the SAME brain.demand_forecast table — the source column
-- was scaffolded in 0017 for exactly this. analytics.demand_forecast_current
-- becomes a "best available" picker that prefers the model when it exists
-- and falls back to the manual snapshot otherwise. No consumer code changes
-- (/restock-memo, generate-pos already read analytics.demand_forecast_current).
--
-- Method (v1, deliberately simple):
--
--   forecast(asin, market, month_M) =
--     CASE
--       WHEN last_year_same_month(asin, market, M) IS NOT NULL THEN
--           last_year_same_month × trend_factor(asin, market)
--       WHEN recent_28d_velocity(asin, market) > 0 THEN
--           recent_28d_velocity × (days_in_month / 28)
--       ELSE NULL                                                  -- skip
--     END
--
--   trend_factor = recent_28d_units / same_28d_a_year_ago_units
--                  (clamped to [0.25, 4.0]; NULL → 1.0)
--
-- Why this method:
--   - Transparent (the CASE explains itself).
--   - Anchors to a real Christmas if we have one (W1+W2 landed Q4 2024).
--   - The trend overlay catches a SKU that's growing or fading vs last year.
--   - The clamp prevents a single anomalous week from x10-ing the next
--     12 months of forecasts.
--   - The flat-velocity fallback keeps new SKUs (no last year) in the system.
--
-- Out of scope for v1:
--   - Proper seasonality decomposition (needs >=2 Christmases — get there
--     once W3-W6 lands 2024-Q1 through 2025-full-year)
--   - Promo-aware adjustments
--   - Inventory-availability-aware adjustment ("could the SKU even have sold
--     last year?")
--   - 'eu' and 'ukw' markets (v1 ships 'uk' + 'usa' only; 'eu' is the whole-EU
--     pool in the manual tool, and most RW SKUs that sell into 'eu' need the
--     daily-sync of DE/FR/IT/ES/NL/SE/PL/TR to fire first — separate work)
--
-- Refresh cadence: nightly via pg_cron (scheduled below). On-demand:
--   SELECT brain.refresh_demand_forecast_modeled();
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Extend the source CHECK to allow the model.
-- ----------------------------------------------------------------------------
ALTER TABLE brain.demand_forecast DROP CONSTRAINT demand_forecast_source_check;
ALTER TABLE brain.demand_forecast ADD CONSTRAINT demand_forecast_source_check
    CHECK (source IN ('operator_tool', 'data_lake_v1'));

COMMENT ON COLUMN brain.demand_forecast.source IS
'Who produced the forecast. ''operator_tool'' = RW''s manual forecasting spreadsheet (interim). ''data_lake_v1'' = the SQL-baseline model added in migration 0024 (last-year-same-month × trend-factor; flat-velocity fallback). Both can coexist; analytics.demand_forecast_current picks the best available per (ean, market, forecast_month).';

-- ----------------------------------------------------------------------------
-- 2. Helper: map marketplace_id → market string used by demand_forecast.
--    The manual spreadsheet uses 'uk' / 'usa' / 'eu' / 'ukw'. v1 of the model
--    only produces 'uk' and 'usa' rows — see header.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION brain._marketplace_to_market(p_marketplace_id TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE p_marketplace_id
        WHEN 'A1F83G8C2ARO7P' THEN 'uk'    -- UK
        WHEN 'ATVPDKIKX0DER' THEN 'usa'   -- US
        -- Other marketplaces map to NULL in v1; the refresh function filters
        -- them out so they never become 'eu' guesses with one-marketplace data.
        ELSE NULL
    END;
$$;

COMMENT ON FUNCTION brain._marketplace_to_market(TEXT) IS
'Maps SP-API marketplace_id to the market string used by brain.demand_forecast. v1 only resolves uk + usa — the eu market is a whole-EU pool in the manual tool, which requires multi-marketplace S&T data we do not yet have. Extend when DE/FR/IT/ES/NL/SE/PL/TR daily-sync goes live.';

-- ----------------------------------------------------------------------------
-- 3. The refresh function. Transactional — fully replaces the prior
--    'data_lake_v1' snapshot in one go (demote prior → insert new).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION brain.refresh_demand_forecast_modeled(
    p_horizon_months INT DEFAULT 12
)
RETURNS TABLE (
    rows_inserted   INTEGER,
    distinct_skus   INTEGER,
    snapshot_date   DATE
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_today          DATE := CURRENT_DATE;
    v_first_month    DATE := date_trunc('month', CURRENT_DATE)::date + INTERVAL '1 month';
    v_rows_inserted  INTEGER;
    v_distinct_skus  INTEGER;
BEGIN
    -- Demote any existing 'data_lake_v1' snapshot for today (or all prior
    -- snapshots if this is the first run today).
    UPDATE brain.demand_forecast
       SET is_current = FALSE, updated_at = NOW()
     WHERE source = 'data_lake_v1' AND is_current;

    -- Compute the new snapshot.
    WITH
    monthly_sales AS (
        SELECT
            marketplace_id,
            child_asin,
            date_trunc('month', metric_date)::date AS month,
            SUM(units_ordered)::numeric AS units
        FROM brain.sales_traffic_daily
        WHERE child_asin IS NOT NULL
        GROUP BY marketplace_id, child_asin, date_trunc('month', metric_date)
    ),
    trend_28d AS (
        SELECT
            marketplace_id,
            child_asin,
            SUM(CASE WHEN metric_date BETWEEN v_today - INTERVAL '28 days'
                                          AND v_today - INTERVAL '1 day'
                     THEN units_ordered ELSE 0 END)::numeric AS recent_28d,
            SUM(CASE WHEN metric_date BETWEEN v_today - INTERVAL '393 days'
                                          AND v_today - INTERVAL '366 days'
                     THEN units_ordered ELSE 0 END)::numeric AS year_ago_28d
        FROM brain.sales_traffic_daily
        WHERE child_asin IS NOT NULL
          AND metric_date >= v_today - INTERVAL '400 days'
        GROUP BY marketplace_id, child_asin
    ),
    trend_factor AS (
        SELECT
            marketplace_id,
            child_asin,
            recent_28d,
            year_ago_28d,
            CASE
                WHEN year_ago_28d > 0 THEN
                    -- Clamp to [0.25, 4.0] to prevent a single anomalous week
                    -- from x10-ing the next 12 months of forecasts.
                    GREATEST(0.25, LEAST(4.0, recent_28d / year_ago_28d))
                ELSE 1.0
            END AS factor
        FROM trend_28d
    ),
    horizon AS (
        SELECT generate_series(0, p_horizon_months - 1) AS k
    ),
    forecast_months AS (
        SELECT (v_first_month + (k * INTERVAL '1 month'))::date AS forecast_month
        FROM horizon
    ),
    last_year_lookup AS (
        -- For each (marketplace, asin, forecast_month), the units sold in
        -- the same calendar month one year prior.
        SELECT
            ms.marketplace_id,
            ms.child_asin,
            fm.forecast_month,
            (SELECT units FROM monthly_sales ms2
              WHERE ms2.marketplace_id = ms.marketplace_id
                AND ms2.child_asin = ms.child_asin
                AND ms2.month = (fm.forecast_month - INTERVAL '1 year')::date
              LIMIT 1) AS last_year_units
        FROM (
            -- Universe of (marketplace, asin) candidates: anything with sales
            -- in the last 60 days OR a year ago.
            SELECT DISTINCT marketplace_id, child_asin
            FROM brain.sales_traffic_daily
            WHERE child_asin IS NOT NULL
              AND (metric_date >= v_today - INTERVAL '60 days'
                   OR metric_date BETWEEN v_today - INTERVAL '395 days'
                                      AND v_today - INTERVAL '335 days')
        ) ms
        CROSS JOIN forecast_months fm
    ),
    sku_map AS (
        SELECT DISTINCT asin AS child_asin, ean
        FROM brain.sku_master
        WHERE asin IS NOT NULL
    ),
    forecast_rows AS (
        SELECT
            ly.marketplace_id,
            ly.child_asin,
            ly.forecast_month,
            ly.last_year_units,
            COALESCE(tf.factor, 1.0) AS factor,
            COALESCE(tf.recent_28d, 0) AS recent_28d,
            CASE
                WHEN ly.last_year_units IS NOT NULL THEN
                    GREATEST(0,
                        ROUND(ly.last_year_units * COALESCE(tf.factor, 1.0), 3))
                WHEN COALESCE(tf.recent_28d, 0) > 0 THEN
                    GREATEST(0,
                        ROUND(tf.recent_28d
                              * (EXTRACT(DAY FROM (ly.forecast_month + INTERVAL '1 month' - INTERVAL '1 day'))::numeric / 28),
                              3))
                ELSE NULL
            END AS units_forecast
        FROM last_year_lookup ly
        LEFT JOIN trend_factor tf
               ON tf.marketplace_id = ly.marketplace_id
              AND tf.child_asin = ly.child_asin
    )
    INSERT INTO brain.demand_forecast (
        snapshot_date, source, is_current,
        ean, asin, market, forecast_month, units_forecast, source_ref
    )
    SELECT
        v_today                                       AS snapshot_date,
        'data_lake_v1'                                AS source,
        TRUE                                          AS is_current,
        sm.ean                                        AS ean,
        fr.child_asin                                 AS asin,
        brain._marketplace_to_market(fr.marketplace_id) AS market,
        fr.forecast_month                             AS forecast_month,
        fr.units_forecast                             AS units_forecast,
        format('data_lake_v1 last_year=%s factor=%s recent_28d=%s',
               COALESCE(fr.last_year_units::text, 'null'),
               fr.factor::text, fr.recent_28d::text)  AS source_ref
    FROM forecast_rows fr
    JOIN sku_map sm USING (child_asin)
    WHERE fr.units_forecast IS NOT NULL
      AND fr.units_forecast > 0
      AND brain._marketplace_to_market(fr.marketplace_id) IS NOT NULL
    ON CONFLICT (snapshot_date, source, ean, market, forecast_month)
       DO UPDATE SET units_forecast = EXCLUDED.units_forecast,
                     asin           = EXCLUDED.asin,
                     source_ref     = EXCLUDED.source_ref,
                     updated_at     = NOW(),
                     is_current     = TRUE;

    GET DIAGNOSTICS v_rows_inserted = ROW_COUNT;

    SELECT COUNT(DISTINCT ean)
      INTO v_distinct_skus
      FROM brain.demand_forecast
     WHERE source = 'data_lake_v1' AND is_current;

    RETURN QUERY SELECT v_rows_inserted, v_distinct_skus, v_today;
END;
$$;

COMMENT ON FUNCTION brain.refresh_demand_forecast_modeled(INT) IS
'Recompute the data-lake-driven demand forecast and write a new snapshot. Demotes the prior data_lake_v1 snapshot first, inserts the new rows with is_current=TRUE, leaves operator_tool rows untouched. Idempotent within a calendar day (re-runs replace the same snapshot_date). Returns (rows_inserted, distinct_skus, snapshot_date).';

-- ----------------------------------------------------------------------------
-- 4. Update analytics.demand_forecast_current to prefer the model when it
--    exists, fall back to operator_tool otherwise. Consumers don't change.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.demand_forecast_current AS
WITH ranked AS (
    SELECT
        ean, asin, market, forecast_month, units_forecast, snapshot_date, source,
        ROW_NUMBER() OVER (
            PARTITION BY ean, market, forecast_month
            ORDER BY CASE source
                       WHEN 'data_lake_v1'  THEN 1
                       WHEN 'operator_tool' THEN 2
                       ELSE 9
                     END
        ) AS pref
    FROM brain.demand_forecast
    WHERE is_current
)
SELECT ean, asin, market, forecast_month, units_forecast, snapshot_date, source
FROM ranked
WHERE pref = 1;

COMMENT ON VIEW analytics.demand_forecast_current IS
'The best-available demand forecast — one row per (ean, market, forecast_month). Prefers source=data_lake_v1 (the SQL model added in migration 0024) and falls back to source=operator_tool (the manual spreadsheet) when the model has nothing for that cell. /restock-memo and generate-pos read this — they get the model''s output transparently once it covers a SKU.';

-- ----------------------------------------------------------------------------
-- 5. Schedule nightly refresh via pg_cron.
--    02:30 UTC = after the daily-sync (15:00 UTC pulls S&T) and the 14:30 UTC
--    rollup. Forecast reads from sales_traffic_daily, so it should run after
--    the day's data has fully landed and rolled up.
-- ----------------------------------------------------------------------------
SELECT cron.schedule(
    'operator-datacore-forecast-refresh',
    '30 2 * * *',
    $$SELECT brain.refresh_demand_forecast_modeled();$$
);

COMMENT ON FUNCTION brain._marketplace_to_market(TEXT) IS
'Maps SP-API marketplace_id to the market string used by brain.demand_forecast. v1 only resolves uk + usa — extend as more marketplaces come online.';

INSERT INTO meta.migration_history (filename)
VALUES ('0024_brain_demand_forecast_modeled.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
