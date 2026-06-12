-- ============================================================================
-- 0035_fba_item_dimensions.sql
-- Per-item packaged dimensions + weight, captured from the FBA storage charges
-- report (GET_FBA_STORAGE_FEE_CHARGES_DATA), which carries longest/median/
-- shortest side, unit weight, item volume and Amazon's product_size_tier for
-- every FBA SKU. We were discarding these columns; this is the start of the
-- product-dimensions knowledge base.
--
-- NOTE: these are the PACKAGED-product dimensions (the unit as stored in FBA,
-- incl. retail packaging) — exactly what's needed for inbound freight costing
-- (you ship packaged units). True bare-product dimensions are a separate,
-- future data source.
--
-- Used by compute-us-inbound to derive a US inbound cost without manual carton
-- data: billed weight = max(unit_weight x units_per_case, volumetric) -> UPS;
-- and a weight-AND-volume-limited max-box fit when case qty is unknown.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS brain.fba_item_dimensions (
    marketplace_id     TEXT NOT NULL,
    fnsku              TEXT NOT NULL,
    asin               TEXT,
    product_name       TEXT,
    longest_side_cm    NUMERIC(10,3),
    median_side_cm     NUMERIC(10,3),
    shortest_side_cm   NUMERIC(10,3),
    item_weight_kg     NUMERIC(10,4),
    item_volume_m3     NUMERIC(12,6),
    product_size_tier  TEXT,
    snapshot_month     DATE,
    ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (marketplace_id, fnsku)
);

CREATE INDEX IF NOT EXISTS idx_fba_item_dimensions_asin
    ON brain.fba_item_dimensions (asin) WHERE asin IS NOT NULL;

COMMENT ON TABLE brain.fba_item_dimensions IS
'Per-FNSKU PACKAGED-product dimensions + weight from GET_FBA_STORAGE_FEE_CHARGES_DATA. Packaged (as stored in FBA), not bare product. Feeds compute-us-inbound (billed weight -> UPS rate) so US inbound needs no manual carton data. One row per (marketplace, fnsku), latest snapshot.';

INSERT INTO meta.migration_history (filename)
VALUES ('0035_fba_item_dimensions.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
