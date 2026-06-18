-- ============================================================================
-- 0040_brain_fba_inventory_age.sql
-- Per-FNSKU FBA inventory AGE buckets + aged-inventory surcharge estimate.
--
-- Why: nothing in the lake exposes how physically OLD inventory is, yet the
-- aged-inventory surcharge (271+ days) is a real, growing cost on overstock
-- (settlement shows FBALongTermStorageFee ~$1.9k US / £472 UK per month, none of
-- which the per-FNSKU storage report captured). days_on_hand from
-- analytics.inventory_health_by_asin is velocity-derived COVER, not physical age;
-- a SKU can have huge cover but be physically new (fresh shipment), or low cover
-- but old. Aged-fee visibility and the "what is about to be surcharged" slow-mover
-- view both need true age.
--
-- Source report: GET_FBA_INVENTORY_AGED_DATA (a.k.a. "FBA Inventory Age" /
-- aged-inventory-surcharge report). Per-SKU, per-marketplace, TSV. Carries unit
-- counts by age bucket plus Amazon's own estimated storage cost and estimated
-- aged-inventory surcharge for next charge. Ingested by
-- `npm run ingest-inventory-age` (src/cli/ingest-inventory-age.ts).
--
-- This table is BOTH the per-SKU physical-age source for /storage-review and the
-- correct basis to allocate the settled aged surcharge per-ASIN (by units in the
-- 271+ buckets) inside analytics.storage_settled_by_asin once populated.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS brain.fba_inventory_age (
    snapshot_date            DATE        NOT NULL,
    marketplace_id           TEXT        NOT NULL,
    fnsku                    TEXT        NOT NULL,
    asin                     TEXT,
    canonical_sku            TEXT,
    product_name             TEXT,
    condition                TEXT,
    qty_available            INTEGER,                 -- total sellable units on hand

    -- Physical age buckets (unit counts), as reported by Amazon.
    inv_age_0_90             INTEGER,
    inv_age_91_180           INTEGER,
    inv_age_181_270          INTEGER,
    inv_age_271_365          INTEGER,
    inv_age_365_plus         INTEGER,

    -- Amazon's own estimates for the upcoming charge.
    estimated_storage_cost   NUMERIC(18,4),           -- next-month estimated monthly storage
    estimated_aged_surcharge NUMERIC(18,4),           -- next-month estimated aged-inventory surcharge (sum of AIS buckets)
    qty_to_be_charged_aged   INTEGER,                 -- units that will incur the aged surcharge

    currency_code            CHAR(3),
    report_type              TEXT        NOT NULL,
    raw_id                   BIGINT,
    ingested_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Idempotent re-ingest: one row per (snapshot_date, marketplace_id, fnsku).
    PRIMARY KEY (snapshot_date, marketplace_id, fnsku)
);

CREATE INDEX IF NOT EXISTS idx_fba_inventory_age_mkt_date
    ON brain.fba_inventory_age (marketplace_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_fba_inventory_age_asin
    ON brain.fba_inventory_age (asin) WHERE asin IS NOT NULL;

COMMENT ON TABLE brain.fba_inventory_age IS
'Per-FNSKU FBA inventory age buckets (0-90 .. 365+ days) and Amazon-estimated storage + aged-inventory surcharge, from GET_FBA_INVENTORY_AGED_DATA. The per-SKU physical-age + aged-fee source the lake was missing; feeds /storage-review and the aged-surcharge allocation. Populated by `npm run ingest-inventory-age`.';

COMMIT;
