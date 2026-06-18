-- ============================================================================
-- 0042_analytics_storage_cost_by_asin.sql
-- One-stop read surface for /storage-review: per-ASIN storage, age, cover,
-- margin tipping-point and capital-at-risk.
--
-- Spine is analytics.inventory_health_by_asin (EVERY in-stock ASIN) so that
-- zero-sales dead stock - the worst overstock, which product_profitability_30d
-- drops because it has no settled sales - is still surfaced. Left-joined to:
--   * analytics.storage_settled_by_asin  -> allocated storage (native -> GBP)
--   * analytics.product_profitability_30d -> CM3, margin %, storage_source, conf
--   * brain.fba_inventory_age             -> physical age buckets + aged-fee est
--   * analytics.product_cost_crosswalk    -> COGS for capital-tied-up
--
-- All money is GBP (reporting currency), to match the authoritative CM3 source;
-- cm3_pre_storage is computed from the storage actually inside CM3 so it isolates
-- storage's exact margin effect. Flags:
--   is_storage_loss_maker = CM3 < 0 but CM3-before-storage >= 0
--   exit_trigger          = CM3 < 0 OR cover > 365d (incl. zero-velocity = inf)
-- Aged columns light up once brain.fba_inventory_age is populated (ingest-
-- inventory-age); until then they are 0/NULL and the rest of the view is intact.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW analytics.storage_cost_by_asin AS
WITH fx_map AS (
    SELECT 'GBP'::text AS ccy, 1.0 AS rate
    UNION ALL
    SELECT l.base_currency, l.rate
    FROM ( SELECT DISTINCT ON (fx_rates.base_currency) fx_rates.base_currency, fx_rates.rate
           FROM meta.fx_rates
           WHERE fx_rates.quote_currency = 'GBP'::bpchar AND fx_rates.rate_date <= CURRENT_DATE
           ORDER BY fx_rates.base_currency, fx_rates.rate_date DESC) l
),
-- Latest charge-month storage per ASIN, native -> GBP.
stor AS (
    SELECT DISTINCT ON (s.marketplace_id, s.asin)
        s.marketplace_id, s.asin, s.charge_month,
        COALESCE(s.storage_base_allocated * fx.rate, 0::numeric) AS storage_base_gbp
    FROM analytics.storage_settled_by_asin s
    LEFT JOIN fx_map fx ON fx.ccy = TRIM(BOTH FROM s.currency_code)
    ORDER BY s.marketplace_id, s.asin, s.charge_month DESC
),
-- Latest age snapshot per marketplace, aggregated to ASIN.
latest_age AS (
    SELECT marketplace_id, MAX(snapshot_date) AS snapshot_date
    FROM brain.fba_inventory_age GROUP BY marketplace_id
),
age AS (
    SELECT
        a.marketplace_id, a.asin,
        MAX(a.snapshot_date) AS age_snapshot_date,
        SUM(COALESCE(a.inv_age_271_365, 0) + COALESCE(a.inv_age_365_plus, 0)) AS units_aged_271_plus,
        SUM(COALESCE(a.inv_age_365_plus, 0))                                  AS units_aged_365_plus,
        SUM(a.estimated_aged_surcharge * COALESCE(fx.rate, 1::numeric))       AS aged_surcharge_est_gbp
    FROM brain.fba_inventory_age a
    JOIN latest_age la ON la.marketplace_id = a.marketplace_id AND la.snapshot_date = a.snapshot_date
    LEFT JOIN fx_map fx ON fx.ccy = TRIM(BOTH FROM a.currency_code)
    WHERE a.asin IS NOT NULL
    GROUP BY a.marketplace_id, a.asin
),
cogs AS (
    SELECT marketplace_id, asin,
           MAX(cogs_landed) AS cogs_landed,
           MAX(cogs_currency) AS cogs_currency,
           MAX(brand) AS brand
    FROM analytics.product_cost_crosswalk
    GROUP BY marketplace_id, asin
)
SELECT
    ih.marketplace_id,
    ih.country_code,
    ih.country_name,
    ih.asin,
    ih.product_name,
    c.brand,
    -- stock
    ih.afn_fulfillable_quantity,
    ih.afn_reserved_quantity,
    ih.afn_total_quantity,
    ih.afn_inbound_total,
    -- velocity / cover
    ih.units_30d,
    ih.units_per_day,
    ih.days_on_hand_fulfillable AS days_of_cover,
    -- physical age (from fba_inventory_age; 0 until ingested)
    COALESCE(ag.units_aged_271_plus, 0) AS units_aged_271_plus,
    COALESCE(ag.units_aged_365_plus, 0) AS units_aged_365_plus,
    ag.age_snapshot_date,
    -- storage cost (GBP)
    ROUND(COALESCE(st.storage_base_gbp, 0)::numeric, 2)         AS storage_base_gbp,
    ROUND(COALESCE(p.aged_surcharge, 0)::numeric, 2)            AS aged_surcharge_in_cm3_gbp,
    ROUND(COALESCE(ag.aged_surcharge_est_gbp, 0)::numeric, 2)   AS aged_surcharge_est_gbp,
    st.charge_month,
    -- margin (GBP) from the authoritative view
    p.cm3,
    p.cm3_margin_pct,
    p.storage_source,
    p.confidence,
    ROUND((p.cm3 + COALESCE(p.storage_base, 0) + COALESCE(p.aged_surcharge, 0))::numeric, 2) AS cm3_pre_storage,
    -- capital tied up (GBP) = on-hand fulfillable x landed cost
    ROUND((ih.afn_fulfillable_quantity * c.cogs_landed * COALESCE(cfx.rate, 1::numeric))::numeric, 2) AS capital_tied_up_gbp,
    -- flags
    (p.cm3 IS NOT NULL AND p.cm3 < 0
        AND (p.cm3 + COALESCE(p.storage_base, 0) + COALESCE(p.aged_surcharge, 0)) >= 0) AS is_storage_loss_maker,
    (COALESCE(p.cm3, 0) < 0 OR ih.days_on_hand_fulfillable > 365 OR ih.days_on_hand_fulfillable IS NULL) AS exit_trigger
FROM analytics.inventory_health_by_asin ih
LEFT JOIN stor st ON st.marketplace_id = ih.marketplace_id AND st.asin = ih.asin
LEFT JOIN age  ag ON ag.marketplace_id = ih.marketplace_id AND ag.asin = ih.asin
LEFT JOIN analytics.product_profitability_30d p ON p.marketplace_id = ih.marketplace_id AND p.asin = ih.asin
LEFT JOIN cogs c ON c.marketplace_id = ih.marketplace_id AND c.asin = ih.asin
LEFT JOIN fx_map cfx ON cfx.ccy = TRIM(BOTH FROM c.cogs_currency);

COMMENT ON VIEW analytics.storage_cost_by_asin IS
'Per-ASIN storage + age + cover + CM3 tipping-point + capital-at-risk, GBP. Spine = inventory_health_by_asin (all in-stock ASINs incl zero-sales dead stock). is_storage_loss_maker = CM3<0 but CM3-pre-storage>=0; exit_trigger = CM3<0 OR cover>365d. Read surface for /storage-review. Aged columns populate once brain.fba_inventory_age is ingested.';

COMMIT;
