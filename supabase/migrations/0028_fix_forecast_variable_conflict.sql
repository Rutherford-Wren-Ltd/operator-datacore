-- ============================================================================
-- 0028_fix_forecast_variable_conflict.sql
-- Fix: brain.refresh_demand_forecast_modeled() failed with
--   ERROR: column reference "snapshot_date" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--
-- Root cause: the function's RETURNS TABLE clause declares an output column
-- named `snapshot_date`, which PL/pgSQL treats as an in-scope variable. The
-- INSERT...ON CONFLICT (snapshot_date, source, ean, market, forecast_month)
-- inside the function body then has two candidate resolutions for
-- `snapshot_date` and refuses to compile.
--
-- Fix: add `#variable_conflict use_column` directive so PL/pgSQL prefers the
-- table column over the output variable when the names collide. The function
-- body is otherwise unchanged from migration 0024.
--
-- Reference:
-- https://www.postgresql.org/docs/current/plpgsql-implementation.html#PLPGSQL-VAR-SUBST
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
    last_year_lookup AS (
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
'Recompute the data-lake-driven demand forecast and write a new snapshot. Demotes the prior data_lake_v1 snapshot first, inserts the new rows with is_current=TRUE, leaves operator_tool rows untouched. Idempotent within a calendar day. Returns (rows_inserted, distinct_skus, snapshot_date). Uses #variable_conflict use_column to disambiguate the snapshot_date column from the output variable of the same name.';

INSERT INTO meta.migration_history (filename)
VALUES ('0028_fix_forecast_variable_conflict.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
