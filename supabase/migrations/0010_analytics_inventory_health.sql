-- ============================================================================
-- 0010_analytics_inventory_health.sql
-- Inventory views for the analytics schema.
--
-- What's added:
--   analytics.fba_inventory_latest  — most recent snapshot row per (marketplace, sku).
--   analytics.inventory_health      — joins inventory_latest to sales velocity
--                                     to compute days-on-hand per SKU.
--
-- Why: brain.fba_inventory_snapshot stores one row per (date, marketplace, sku)
-- — useful for trend queries but cumbersome for "what's the current state?".
-- These views surface that current state plus computed days-on-hand, so
-- /sku-audit and /restock-memo can read a single straightforward query
-- instead of building latest-row + velocity logic in the skill.
--
-- For Miia / Jo on the Supabase MCP, this is the "show me current inventory"
-- query they want, pre-baked.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- analytics.fba_inventory_latest
-- Most recent snapshot per (marketplace_id, sku).
--
-- Note: brain.fba_inventory_snapshot filters out zero-inventory SKUs at
-- ingest (PR #24), so this view only returns SKUs that have actual
-- inventory or are inbound. "Empty" SKUs are implicit by absence.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.fba_inventory_latest AS
SELECT DISTINCT ON (marketplace_id, sku)
    snapshot_date,
    marketplace_id,
    sku,
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
    afn_inbound_working_quantity + afn_inbound_shipped_quantity + afn_inbound_receiving_quantity AS afn_inbound_total,
    ingested_at
FROM brain.fba_inventory_snapshot
ORDER BY marketplace_id, sku, snapshot_date DESC;

COMMENT ON VIEW analytics.fba_inventory_latest IS
'Most recent snapshot per (marketplace_id, sku). Excludes zero-inventory SKUs (filtered at ingest). The afn_inbound_total column is a convenience sum of the three inbound buckets.';

-- ----------------------------------------------------------------------------
-- analytics.inventory_health
-- Latest inventory + 30-day sales velocity → days-on-hand per SKU.
--
-- Velocity logic: simple 30-day average of units_ordered grouped by
-- (marketplace_id, child_asin). This is intentionally NOT weighted by
-- recency — operators wanting "what would I order today" should look
-- at this. Operators wanting "where is demand trending" should query
-- brain.sales_traffic_daily directly.
--
-- Edge cases (NULL means "can't compute, not zero"):
--   - units_per_day NULL or 0 → days_on_hand NULL. Either no sales in
--     30d (new SKU or paused) or no rows in brain.sales_traffic_daily
--     for that child_asin (data lake gap).
--   - SKU has inventory but no matching child_asin sales row → days_on_hand
--     NULL too. Treat as "needs investigation" not "out of stock".
--
-- Inbound is NOT included in days_on_hand_fulfillable. That's intentionally
-- conservative — inbound takes weeks to land, so a SKU with 30 days of
-- live inventory and 60 days of inbound is still only 30 days of cover
-- for the purposes of a restock decision today.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.inventory_health AS
WITH velocity AS (
    -- Last 30 completed days of units sold per (marketplace, child_asin).
    -- Excludes today (always D-1 in S&T anyway).
    SELECT
        marketplace_id,
        child_asin,
        SUM(units_ordered) AS units_30d,
        (SUM(units_ordered)::numeric / 30.0) AS units_per_day
    FROM brain.sales_traffic_daily
    WHERE metric_date >= CURRENT_DATE - INTERVAL '30 days'
      AND metric_date < CURRENT_DATE
    GROUP BY marketplace_id, child_asin
)
SELECT
    inv.snapshot_date,
    inv.marketplace_id,
    m.country_code,
    m.country_name,
    inv.sku,
    inv.asin,
    inv.product_name,
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
    END AS days_on_hand_with_inbound
FROM analytics.fba_inventory_latest inv
LEFT JOIN meta.marketplace m ON m.marketplace_id = inv.marketplace_id
LEFT JOIN velocity v
    ON v.marketplace_id = inv.marketplace_id
   AND v.child_asin = inv.asin;

COMMENT ON VIEW analytics.inventory_health IS
'Latest inventory per SKU joined to 30-day sales velocity. days_on_hand_fulfillable is the conservative read (excludes inbound and reserved); days_on_hand_with_inbound is the optimistic read. NULL means velocity data unavailable, not zero.';

INSERT INTO meta.migration_history (filename) VALUES ('0010_analytics_inventory_health.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
