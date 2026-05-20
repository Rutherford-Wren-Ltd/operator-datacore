-- ============================================================================
-- 0017_brain_demand_forecast.sql
-- Demand forecast ingestion: brain.demand_forecast holds RW's monthly per-SKU
-- per-market demand forecast.
--
-- Why: /restock-memo forecasts demand as flat trailing-30-day velocity — no
-- seasonality. RW runs a forecasting tool (a monthly spreadsheet); its export
-- is loaded here so restock decisions, and a later auto-PO generator, can use a
-- real seasonal forward forecast.
--
-- Each import is a dated SNAPSHOT — re-importing keeps history, so forecast
-- revisions and (later) variance-vs-forecast are both recoverable. The latest
-- snapshot per source carries is_current = TRUE.
--
-- The forecasting tool is interim — a manually maintained spreadsheet. The
-- `source` column exists so a future data-lake-driven forecast can populate
-- this same table without a restructure.
-- ============================================================================

BEGIN;

CREATE TABLE brain.demand_forecast (
    forecast_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The forecast version: the date this snapshot was imported.
    snapshot_date   DATE NOT NULL,
    -- Who produced the forecast. 'operator_tool' = RW's manual forecasting
    -- spreadsheet. A future data-lake model adds its own value via migration.
    source          TEXT NOT NULL DEFAULT 'operator_tool',
    -- TRUE on the rows of the latest snapshot for this source — the importer
    -- demotes the prior snapshot on each load. analytics.demand_forecast_current
    -- filters on this.
    is_current      BOOLEAN NOT NULL DEFAULT TRUE,
    -- ean is a soft reference to brain.sku_master(ean) — no hard FK; the
    -- importer warns on unknown EANs rather than rejecting the import (as the
    -- PO lines do). asin is backfilled from sku_master where the EAN resolves.
    ean             TEXT NOT NULL,
    asin            TEXT,
    -- Demand geography. 'eu' is the whole-EU pool — the tool's "DE" column
    -- aggregates all EU marketplaces, it is not Germany alone. 'ukw' is UK
    -- website / MFN sales, distinct from 'uk' (Amazon UK).
    market          TEXT NOT NULL,
    -- First day of the forecast month.
    forecast_month  DATE NOT NULL,
    -- NUMERIC, not INTEGER: the forecasting tool produces fractional figures
    -- (notably in the UKW column), and rounding each cell would lose real
    -- accuracy once summed over a planning window. Stored exactly; the
    -- consumer rounds the final order quantity.
    units_forecast  NUMERIC(12, 3) NOT NULL CHECK (units_forecast >= 0),
    -- The workbook file the snapshot came from, for audit.
    source_ref      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT demand_forecast_natural_key
        UNIQUE (snapshot_date, source, ean, market, forecast_month),
    CONSTRAINT demand_forecast_source_check
        CHECK (source IN ('operator_tool')),
    CONSTRAINT demand_forecast_market_check
        CHECK (market IN ('uk', 'usa', 'eu', 'ukw')),
    CONSTRAINT demand_forecast_month_first_check
        CHECK (forecast_month = date_trunc('month', forecast_month)::date)
);

-- The /restock-memo read path: latest-snapshot forecast for a SKU + market.
CREATE INDEX idx_demand_forecast_current
    ON brain.demand_forecast (ean, market, forecast_month)
    WHERE is_current;

CREATE TRIGGER trg_demand_forecast_updated_at
    BEFORE UPDATE ON brain.demand_forecast
    FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at();

COMMENT ON TABLE brain.demand_forecast IS
'Monthly per-SKU per-market demand forecast, one dated snapshot per import. Loaded by the import-forecast CLI from RW''s forecasting tool. Only positive forecasts are stored — a missing (ean, market, month) row means a forecast of 0. The forecasting tool is interim (a manual spreadsheet); see wiki/decisions/2026-05-20-forecasting-approach-interim.md.';

COMMENT ON COLUMN brain.demand_forecast.snapshot_date IS
'The forecast version — the date this snapshot was imported. Re-importing a snapshot_date replaces it; a new date adds a snapshot and becomes is_current.';

COMMENT ON COLUMN brain.demand_forecast.source IS
'Who produced the forecast. ''operator_tool'' = RW''s manual forecasting spreadsheet. The CHECK is extended via migration when a data-lake forecast model is added.';

COMMENT ON COLUMN brain.demand_forecast.is_current IS
'TRUE on the latest snapshot for this source. The importer sets it FALSE on the prior snapshot and TRUE on the new one, in one transaction.';

COMMENT ON COLUMN brain.demand_forecast.market IS
'Demand geography: uk (Amazon UK) | usa | eu | ukw. ''eu'' is the whole-EU pool — the tool''s "DE" column aggregates all EU marketplaces, not Germany alone. ''ukw'' is UK website / MFN sales (added to the tool from Sep 2025), distinct from Amazon UK.';

-- analytics.demand_forecast_current — the latest forecast snapshot, PostgREST-
-- exposed. What /restock-memo and dashboards read.
CREATE OR REPLACE VIEW analytics.demand_forecast_current AS
SELECT ean, asin, market, forecast_month, units_forecast, snapshot_date
FROM brain.demand_forecast
WHERE is_current;

COMMENT ON VIEW analytics.demand_forecast_current IS
'The current (latest-snapshot) demand forecast — one row per (ean, market, forecast_month) with units_forecast. A boolean is_current filter, not a per-cell latest pick, so a newer snapshot that drops a cell to 0 correctly wins.';

INSERT INTO meta.migration_history (filename) VALUES ('0017_brain_demand_forecast.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
