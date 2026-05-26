-- ============================================================================
-- 0019_analytics_inventory_dedupe_by_fnsku.sql
-- Dedupe FBA inventory by FNSKU so analytics rollups stop double-counting
-- shared FC bins.
--
-- The problem:
--   Amazon's getInventorySummaries returns ONE ROW PER (SKU, marketplace),
--   but multiple SKUs CAN map to the same FNSKU (the FC barcode that
--   identifies a physical bin). When that happens, the API faithfully
--   reports the same bin contents under each SKU — so naive ASIN-level
--   sums double-count the same physical units.
--
--   Discovered 2026-05-26 by spot-check against Seller Central:
--     • UK overstates total fulfillable by ~36% (9,779 phantom units of
--       27,471) — 51 of 326 FNSKUs have duplicate SKU rows.
--     • US overstates by ~12% (2,429 of 19,585) — 10 of 278 FNSKUs.
--     • Example: MD-Toast-Rack-Silver (B0BKLCS81X UK) has 4 SKUs all
--       reporting 230 units / FNSKU B0BKLCS81X — that's one 230-unit bin
--       counted 4×.
--
--   Many of the duplicates are "phantom" SKUs from deleted Seller Central
--   listings that the inventory API still surfaces because they share an
--   FNSKU with an active SKU. By deduping at the analytics layer, the
--   skills (/restock-memo, /sku-audit) and operator queries get the right
--   number without anyone needing to remember the rule.
--
-- What this adds:
--   analytics.fba_inventory_per_fnsku  — one row per (marketplace, fnsku,
--                                        condition); SKU list aggregated.
--                                        Picks a canonical SKU per group
--                                        (alphabetically first).
--   analytics.inventory_health         — REPLACED to read from the new
--                                        per-FNSKU view. Adds a
--                                        lake_age_hours column so consumers
--                                        can see staleness at a glance.
--
-- analytics.fba_inventory_latest is KEPT unchanged for forensic / per-SKU
-- debugging — it deliberately retains the duplicates so an operator can
-- see what Amazon's API actually returned.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- analytics.fba_inventory_latest (REPLACE — fix stale-row carryover)
-- Previously: "most recent row per (marketplace_id, sku)". With the PR #24
-- skip-if-zero filter at ingest time, that semantic carries pre-PR-24 SKU
-- rows forward forever once those SKUs stopped reporting inventory — the
-- view today returns ~21,000 UK rows when the latest snapshot is ~400.
--
-- New semantics: rows from the latest snapshot_date per marketplace.
-- A SKU that's absent from the latest snapshot is interpreted as
-- "Amazon no longer reports inventory for this SKU", consistent with the
-- skip-if-zero filter's intent.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.fba_inventory_latest AS
WITH latest_per_market AS (
    SELECT marketplace_id, MAX(snapshot_date) AS d
    FROM brain.fba_inventory_snapshot
    GROUP BY marketplace_id
)
SELECT
    inv.snapshot_date,
    inv.marketplace_id,
    inv.sku,
    inv.fnsku,
    inv.asin,
    inv.product_name,
    inv.condition,
    inv.afn_listing_exists,
    inv.afn_warehouse_quantity,
    inv.afn_fulfillable_quantity,
    inv.afn_unsellable_quantity,
    inv.afn_reserved_quantity,
    inv.afn_total_quantity,
    inv.afn_inbound_working_quantity,
    inv.afn_inbound_shipped_quantity,
    inv.afn_inbound_receiving_quantity,
    inv.afn_researching_quantity,
    inv.afn_inbound_working_quantity + inv.afn_inbound_shipped_quantity + inv.afn_inbound_receiving_quantity AS afn_inbound_total,
    inv.ingested_at
FROM brain.fba_inventory_snapshot inv
JOIN latest_per_market lpm
  ON inv.marketplace_id = lpm.marketplace_id
 AND inv.snapshot_date  = lpm.d;

COMMENT ON VIEW analytics.fba_inventory_latest IS
'Rows from the latest snapshot per marketplace. SKUs absent from the latest snapshot are absent here — interpret as "Amazon no longer reports inventory for that SKU" (skip-if-zero filter from PR #24). Use analytics.fba_inventory_per_fnsku for ASIN-level rollups; this view still carries duplicate-FNSKU SKU rows for forensic / per-SKU work.';

-- ----------------------------------------------------------------------------
-- analytics.fba_inventory_per_fnsku
-- One row per (marketplace_id, fnsku, condition) from the latest snapshot.
-- For groups with multiple SKUs mapping to the same FNSKU, the inventory
-- numbers are identical (Amazon returns the bin contents per SKU mapping),
-- so we pick one row and aggregate the SKU list.
--
-- A NULL fnsku is preserved as-is (each NULL-fnsku row remains its own
-- group, keyed by sku) so rows without an FNSKU don't accidentally collapse
-- together.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.fba_inventory_per_fnsku AS
WITH grouped AS (
    SELECT
        marketplace_id,
        COALESCE(fnsku, 'NULL:' || sku) AS dedupe_key,
        condition,
        ARRAY_AGG(sku ORDER BY sku) AS all_skus,
        COUNT(*)                    AS sku_count
    FROM analytics.fba_inventory_latest
    GROUP BY marketplace_id, COALESCE(fnsku, 'NULL:' || sku), condition
),
canonical AS (
    SELECT DISTINCT ON (
        marketplace_id,
        COALESCE(fnsku, 'NULL:' || sku),
        condition
    )
        marketplace_id,
        COALESCE(fnsku, 'NULL:' || sku) AS dedupe_key,
        snapshot_date,
        sku                              AS canonical_sku,
        fnsku,
        asin,
        product_name,
        condition,
        afn_listing_exists,
        afn_warehouse_quantity,
        afn_fulfillable_quantity,
        afn_unsellable_quantity,
        afn_reserved_quantity,
        afn_total_quantity,
        afn_inbound_working_quantity,
        afn_inbound_shipped_quantity,
        afn_inbound_receiving_quantity,
        afn_researching_quantity,
        afn_inbound_total,
        ingested_at
    FROM analytics.fba_inventory_latest
    ORDER BY
        marketplace_id,
        COALESCE(fnsku, 'NULL:' || sku),
        condition,
        sku
)
SELECT
    c.snapshot_date,
    c.marketplace_id,
    c.fnsku,
    c.canonical_sku,
    c.asin,
    c.product_name,
    c.condition,
    c.afn_listing_exists,
    c.afn_warehouse_quantity,
    c.afn_fulfillable_quantity,
    c.afn_unsellable_quantity,
    c.afn_reserved_quantity,
    c.afn_total_quantity,
    c.afn_inbound_working_quantity,
    c.afn_inbound_shipped_quantity,
    c.afn_inbound_receiving_quantity,
    c.afn_researching_quantity,
    c.afn_inbound_total,
    g.sku_count,
    g.all_skus,
    c.ingested_at
FROM canonical c
JOIN grouped g
  ON g.marketplace_id = c.marketplace_id
 AND g.dedupe_key     = c.dedupe_key
 AND ((g.condition IS NULL AND c.condition IS NULL) OR g.condition = c.condition);

COMMENT ON VIEW analytics.fba_inventory_per_fnsku IS
'One row per (marketplace_id, fnsku, condition). Collapses the duplicate SKU rows that Amazon returns when multiple SKUs share an FNSKU bin. sku_count > 1 means there are phantom/duplicate SKU listings; all_skus lists every SKU that mapped to this bin.';

-- ----------------------------------------------------------------------------
-- analytics.inventory_health (REPLACE)
-- Now reads from fba_inventory_per_fnsku so days-on-hand math uses
-- deduped fulfillable. Adds lake_age_hours so consumers can decide whether
-- to call the live SP-API instead of trusting the cached snapshot.
--
-- DROP + CREATE rather than CREATE OR REPLACE because the column shape
-- changes (sku_count / all_skus / fnsku / condition / ingested_at /
-- lake_age_hours added). Verified no dependent objects exist at
-- 2026-05-26 — pg_depend lookup returned empty.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS analytics.inventory_health;
CREATE VIEW analytics.inventory_health AS
WITH velocity AS (
    SELECT
        marketplace_id,
        child_asin,
        SUM(units_ordered)                   AS units_30d,
        (SUM(units_ordered)::numeric / 30.0) AS units_per_day
    FROM brain.sales_traffic_daily
    WHERE metric_date >= CURRENT_DATE - INTERVAL '30 days'
      AND metric_date <  CURRENT_DATE
    GROUP BY marketplace_id, child_asin
)
SELECT
    inv.snapshot_date,
    inv.marketplace_id,
    m.country_code,
    m.country_name,
    inv.canonical_sku                                       AS sku,
    inv.sku_count,
    inv.all_skus,
    inv.fnsku,
    inv.asin,
    inv.product_name,
    inv.condition,
    inv.afn_fulfillable_quantity,
    inv.afn_reserved_quantity,
    inv.afn_unsellable_quantity,
    inv.afn_inbound_total,
    inv.afn_total_quantity,
    v.units_30d,
    v.units_per_day,
    CASE
        WHEN v.units_per_day IS NULL OR v.units_per_day = 0 THEN NULL
        ELSE ROUND((inv.afn_fulfillable_quantity::numeric / v.units_per_day), 1)
    END AS days_on_hand_fulfillable,
    CASE
        WHEN v.units_per_day IS NULL OR v.units_per_day = 0 THEN NULL
        ELSE ROUND((inv.afn_total_quantity::numeric / v.units_per_day), 1)
    END AS days_on_hand_total,
    CASE
        WHEN v.units_per_day IS NULL OR v.units_per_day = 0 THEN NULL
        ELSE ROUND(((inv.afn_fulfillable_quantity + inv.afn_inbound_total)::numeric / v.units_per_day), 1)
    END AS days_on_hand_with_inbound,
    inv.ingested_at,
    EXTRACT(EPOCH FROM (NOW() - inv.ingested_at)) / 3600.0  AS lake_age_hours
FROM analytics.fba_inventory_per_fnsku inv
LEFT JOIN meta.marketplace m ON m.marketplace_id = inv.marketplace_id
LEFT JOIN velocity v
    ON v.marketplace_id = inv.marketplace_id
   AND v.child_asin     = inv.asin;

COMMENT ON VIEW analytics.inventory_health IS
'Latest inventory per (marketplace, fnsku, condition) — deduplicated, no longer per-SKU. sku is the canonical SKU; sku_count and all_skus expose phantom-listing groups. lake_age_hours indicates how stale the snapshot is (daily-sync runs ~15:00 UTC; for sub-day freshness, call the live SP-API via amazon-operator-stack MCP).';

INSERT INTO meta.migration_history (filename) VALUES ('0019_analytics_inventory_dedupe_by_fnsku.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
