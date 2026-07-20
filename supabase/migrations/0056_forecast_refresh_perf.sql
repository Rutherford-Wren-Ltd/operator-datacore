-- ============================================================================
-- 0056_forecast_refresh_perf.sql
-- Fix: brain.refresh_demand_forecast_modeled() has failed on the nightly
--   pg_cron job (operator-datacore-forecast-refresh, 02:30 UTC) since
--   2026-06-06 with:
--     ERROR: canceling statement due to statement timeout
--   45 consecutive failures; last success 2026-06-05. The newest usable
--   snapshot is therefore stale, and generate-pos falls back to the older
--   long-horizon snapshot, so restock demand runs off 8-week-old numbers.
--
-- Root cause: the `last_year_lookup` CTE used a CORRELATED SCALAR SUBQUERY
--   against the `monthly_sales` CTE, evaluated once per (marketplace, ASIN)
--   x forecast_month. `monthly_sales` aggregates the WHOLE of
--   brain.sales_traffic_daily. As the lake grew (UK+US to 24 months, DE/FR/
--   IT/ES added), the per-row re-scan cost crossed the statement timeout.
--
-- Fix (two parts, semantics unchanged):
--   1. Replace the correlated scalar subquery with a LEFT JOIN on
--      monthly_sales keyed by (marketplace, ASIN, year-ago month). Since
--      monthly_sales holds exactly one row per (marketplace, ASIN, month),
--      the join is one-to-one and identical to the old LIMIT 1 subquery,
--      but the planner runs it as a single hash join instead of N re-scans.
--   2. Bound `monthly_sales` to the last 15 months. Its only consumer is the
--      year-ago lookup, whose referenced months span ~this month back to ~11
--      months ago; 15 months is a safe margin. This shrinks the CTE the join
--      probes against.
--   Plus a belt-and-braces `SET statement_timeout = '600s'` on the function so
--   a future slow run is not silently killed by the cron role's short default.
--
-- The rest of the function body is unchanged from 0028.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION brain.refresh_demand_forecast_modeled(
    p_horizon_months INT DEFAULT 12
)
RETURNS TABLE (
    rows_inserted   INTEGER,
    distinct_skus   INTEGER,
    snapshot_date   DATE
)
LANGUAGE plpgsql
SET statement_timeout = '600s'
AS $$
#variable_conflict use_column
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
          -- Only the last ~15 months are ever probed by the year-ago join
          -- below; bounding here keeps the CTE small as the lake grows.
          AND metric_date >= (date_trunc('month', v_today) - INTERVAL '15 months')::date
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
    active_skus AS (
        SELECT DISTINCT marketplace_id, child_asin
        FROM brain.sales_traffic_daily
        WHERE child_asin IS NOT NULL
          AND (metric_date >= v_today - INTERVAL '60 days'
               OR metric_date BETWEEN v_today - INTERVAL '395 days'
                                  AND v_today - INTERVAL '335 days')
    ),
    last_year_lookup AS (
        -- Was a correlated scalar subquery per (marketplace, ASIN) x month;
        -- now a one-to-one LEFT JOIN on the year-ago month. monthly_sales has
        -- a single row per (marketplace, ASIN, month), so this is identical.
        SELECT
            ms.marketplace_id,
            ms.child_asin,
            fm.forecast_month,
            lym.units AS last_year_units
        FROM active_skus ms
        CROSS JOIN forecast_months fm
        LEFT JOIN monthly_sales lym
               ON lym.marketplace_id = ms.marketplace_id
              AND lym.child_asin     = ms.child_asin
              AND lym.month          = (fm.forecast_month - INTERVAL '1 year')::date
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
        v_today,
        'data_lake_v1',
        TRUE,
        sm.ean,
        fr.child_asin,
        brain._marketplace_to_market(fr.marketplace_id),
        fr.forecast_month,
        fr.units_forecast,
        format('data_lake_v1 last_year=%s factor=%s recent_28d=%s',
               COALESCE(fr.last_year_units::text, 'null'),
               fr.factor::text, fr.recent_28d::text)
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
'Recompute the data-lake-driven demand forecast and write a new snapshot. Demotes the prior data_lake_v1 snapshot first, inserts the new rows with is_current=TRUE, leaves operator_tool rows untouched. Idempotent within a calendar day. Returns (rows_inserted, distinct_skus, snapshot_date). Uses #variable_conflict use_column to disambiguate the snapshot_date column. 0056: year-ago lookup is a hash join (was a correlated subquery), monthly_sales bounded to 15 months, statement_timeout raised to 600s to survive lake growth.';

INSERT INTO meta.migration_history (filename)
VALUES ('0056_forecast_refresh_perf.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
