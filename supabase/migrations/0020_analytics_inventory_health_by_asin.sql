-- ============================================================================
-- 0020_analytics_inventory_health_by_asin.sql
-- Add an ASIN-level inventory view with correct rate-metric grain; remove the
-- per-row days_on_hand_* footgun from analytics.inventory_health.
--
-- The bug this fixes:
--   analytics.inventory_health (per-row) computes days_on_hand_fulfillable as
--   `afn_fulfillable_quantity / units_per_day`, where the numerator is per-row
--   stock (one row per FNSKU after migration 0019, one row per SKU before it)
--   and the denominator is per-ASIN velocity (sales_traffic_daily reports at
--   the ASIN grain). For any ASIN with multiple rows — Used-condition variants,
--   parallel pools, alias listings — the ratio is structurally meaningless.
--
--   Live consequence (2026-05-26): a Used-condition row with 1 unit and a
--   shared 4.7-units/day velocity produced days_on_hand = 0.21 days = "5
--   hours". A query ordering by days_on_hand ASC surfaced 5 UK ASINs as
--   "OOS imminent — raise prices now" when they actually had 8-129 days
--   of cover at the ASIN-aggregate level. Worst case (Hedgehog
--   B0CX9FCC59): reported 5 hours; real 129 days.
--
--   The "max per ASIN" workaround proposed in chat would only have masked
--   this case by accident: it gives the right answer when each ASIN has
--   one NewItem FNSKU, but undercounts when an ASIN has multiple genuine
--   bins (e.g. MD Garden Sharpener UK has FNSKU B0F9YZ46ND at 838 plus
--   FNSKU X002BF8P7P at 215 — "max" returns 838, missing 215).
--
-- What this adds / changes:
--   analytics.inventory_health_by_asin  — NEW. One row per (marketplace, ASIN).
--                                          NewItem condition only (Used has its
--                                          own price and velocity, must never be
--                                          mixed into rate calcs). Aggregates
--                                          across distinct FNSKUs.
--                                          days_on_hand_* finally meaningful.
--   analytics.inventory_health          — REPLACE. Per-(marketplace, FNSKU,
--                                          condition) — unchanged grain — but
--                                          the days_on_hand_* columns are
--                                          REMOVED. Consumers wanting rate
--                                          metrics must use the by-asin view.
--                                          Per-row units_30d / units_per_day
--                                          are retained as informational (they
--                                          come from per-ASIN velocity and are
--                                          identical across rows of an ASIN).
--
-- analytics.fba_inventory_per_fnsku (from 0019) is the source of truth for
-- the per-FNSKU grain — ops/receiving/supplier work that needs to see each
-- physical bin separately should keep using it. The new by-asin view is
-- additive, not replacing it.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- analytics.inventory_health_by_asin
-- One row per (snapshot_date, marketplace_id, asin), NewItem condition only.
--
-- Why NewItem only:
--   units_per_day comes from sales_traffic_daily which aggregates across all
--   conditions of an ASIN, but virtually all RW sales are NewItem. Mixing
--   Used stock into the numerator would double the apparent on-hand for
--   ASINs with a Used variant and a small velocity, masking restock needs.
--   The per-FNSKU view (analytics.fba_inventory_per_fnsku) and the per-row
--   inventory_health both retain Used rows for ops work that needs them.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.inventory_health_by_asin AS
WITH velocity AS (
    SELECT
        marketplace_id,
        child_asin                           AS asin,
        SUM(units_ordered)                   AS units_30d,
        (SUM(units_ordered)::numeric / 30.0) AS units_per_day
    FROM brain.sales_traffic_daily
    WHERE metric_date >= CURRENT_DATE - INTERVAL '30 days'
      AND metric_date <  CURRENT_DATE
    GROUP BY marketplace_id, child_asin
),
inv AS (
    SELECT
        snapshot_date,
        marketplace_id,
        asin,
        MIN(product_name)                AS product_name,
        COUNT(*)                         AS fnsku_count,
        SUM(sku_count)                   AS sku_alias_count,
        SUM(afn_fulfillable_quantity)    AS afn_fulfillable_quantity,
        SUM(afn_reserved_quantity)       AS afn_reserved_quantity,
        SUM(afn_unsellable_quantity)     AS afn_unsellable_quantity,
        SUM(afn_inbound_total)           AS afn_inbound_total,
        SUM(afn_total_quantity)          AS afn_total_quantity,
        MAX(ingested_at)                 AS ingested_at
    FROM analytics.fba_inventory_per_fnsku
    WHERE condition = 'NewItem'
      AND asin IS NOT NULL
    GROUP BY snapshot_date, marketplace_id, asin
)
SELECT
    inv.snapshot_date,
    inv.marketplace_id,
    m.country_code,
    m.country_name,
    inv.asin,
    inv.product_name,
    inv.fnsku_count,
    inv.sku_alias_count,
    inv.afn_fulfillable_quantity,
    inv.afn_reserved_quantity,
    inv.afn_unsellable_quantity,
    inv.afn_inbound_total,
    inv.afn_total_quantity,
    v.units_30d,
    v.units_per_day,
    CASE
        WHEN COALESCE(v.units_per_day, 0) = 0 THEN NULL
        ELSE ROUND((inv.afn_fulfillable_quantity::numeric / v.units_per_day), 1)
    END AS days_on_hand_fulfillable,
    CASE
        WHEN COALESCE(v.units_per_day, 0) = 0 THEN NULL
        ELSE ROUND((inv.afn_total_quantity::numeric / v.units_per_day), 1)
    END AS days_on_hand_total,
    CASE
        WHEN COALESCE(v.units_per_day, 0) = 0 THEN NULL
        ELSE ROUND(((inv.afn_fulfillable_quantity + inv.afn_inbound_total)::numeric / v.units_per_day), 1)
    END AS days_on_hand_with_inbound,
    inv.ingested_at,
    EXTRACT(EPOCH FROM (NOW() - inv.ingested_at)) / 3600.0 AS lake_age_hours
FROM inv
LEFT JOIN meta.marketplace m ON m.marketplace_id = inv.marketplace_id
LEFT JOIN velocity     v     ON v.marketplace_id = inv.marketplace_id AND v.asin = inv.asin;

COMMENT ON VIEW analytics.inventory_health_by_asin IS
'One row per (snapshot_date, marketplace_id, asin) — NewItem condition only. Aggregates fulfillable / reserved / inbound across distinct FNSKUs per ASIN. The only view in the lake where days_on_hand_* is computed at the correct grain (ASIN-aggregate stock / ASIN velocity). Use this for restock decisions, price-action triggers, OOS-imminent reports, anything that ranks by rate metrics. For per-bin / per-condition / per-SKU work (ops, receiving, supplier reconciliation, audit of which alias listings exist) use analytics.fba_inventory_per_fnsku or analytics.inventory_health (per-row).';

-- ----------------------------------------------------------------------------
-- analytics.inventory_health (REPLACE — remove days_on_hand_* footgun)
-- Same per-row grain as in 0019, but the per-row days_on_hand_* columns are
-- gone. They were the bug surface: per-row stock divided by per-ASIN velocity
-- produced "5 hours to OOS" for ASINs with 129 days of cover.
--
-- Consumers wanting days_on_hand must use inventory_health_by_asin. Three
-- known consumers updated in this same PR: generate-pos CLI,
-- /restock-memo skill, /sku-audit skill.
--
-- DROP + CREATE because column shape changes (columns removed). Verified at
-- 2026-05-26 that nothing else depends on this view in the DB.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS analytics.inventory_health;
CREATE VIEW analytics.inventory_health AS
WITH velocity AS (
    SELECT
        marketplace_id,
        child_asin                           AS asin,
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
    inv.ingested_at,
    EXTRACT(EPOCH FROM (NOW() - inv.ingested_at)) / 3600.0 AS lake_age_hours
FROM analytics.fba_inventory_per_fnsku inv
LEFT JOIN meta.marketplace m ON m.marketplace_id = inv.marketplace_id
LEFT JOIN velocity     v     ON v.marketplace_id = inv.marketplace_id AND v.asin = inv.asin;

COMMENT ON VIEW analytics.inventory_health IS
'Per (marketplace, fnsku, condition) inventory state. units_30d and units_per_day are per-ASIN (identical across rows of the same ASIN — informational). days_on_hand_* columns are deliberately ABSENT: per-row stock divided by per-ASIN velocity is structurally meaningless for any ASIN with multiple rows. Use analytics.inventory_health_by_asin for rate metrics (days_on_hand, sell-through, weeks-of-cover).';

INSERT INTO meta.migration_history (filename) VALUES ('0020_analytics_inventory_health_by_asin.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
