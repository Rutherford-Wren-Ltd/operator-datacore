-- ============================================================================
-- 0047_storage_cost_aged_allocation.sql
-- Populate per-ASIN aged surcharge in analytics.storage_cost_by_asin by
-- allocating the SETTLED aged total, instead of Amazon's per-SKU estimate.
--
-- Why: the FBA inventory-age report's estimated_aged_surcharge column comes back
-- null on this account (header-alias gap), so aged showed as units only. But we
-- have the trusted aged TOTAL from settlement (brain.financial_events
-- FBALongTermStorageFee: ~$1,912.91 US / £471.96 UK) and the per-SKU 271+ aged
-- unit counts (brain.fba_inventory_age). So allocate the settled aged total by
-- each ASIN's share of 271+ aged units — the same settlement-as-truth pattern as
-- base storage (0038). Reconciles to settlement by construction (validated:
-- UK £471.96, US £1,445.53 GBP allocated = settled).
--
-- Only the `aged_surcharge_est_gbp` column changes (now settlement-allocated, not
-- a report estimate); column name kept for a clean CREATE OR REPLACE. Everything
-- else is identical to 0042.
--
-- NOTE: CM3 in product_profitability_30d still excludes aged (≈£2k/mo across the
-- portfolio). Folding aged into CM3 is a separate change to that view; this
-- migration only gives /storage-review per-SKU aged £ visibility.
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
        SUM(COALESCE(a.inv_age_365_plus, 0))                                  AS units_aged_365_plus
    FROM brain.fba_inventory_age a
    JOIN latest_age la ON la.marketplace_id = a.marketplace_id AND la.snapshot_date = a.snapshot_date
    WHERE a.asin IS NOT NULL
    GROUP BY a.marketplace_id, a.asin
),
-- Total 271+ aged units per marketplace (allocation denominator).
aged_tot AS (
    SELECT marketplace_id, SUM(units_aged_271_plus) AS tot FROM age GROUP BY marketplace_id
),
-- Settled aged surcharge total per marketplace (truth), latest charge month,
-- camelCase path, home currency only. charge_month = posting month - 1.
settled_aged_raw AS (
    SELECT fe.marketplace_id, mc.currency_code,
           (date_trunc('month', fe.posted_date) - INTERVAL '1 month')::date AS charge_month,
           SUM(fe.amount) AS aged_total
    FROM brain.financial_events fe
    JOIN (VALUES ('ATVPDKIKX0DER','USD'), ('A1F83G8C2ARO7P','GBP')) mc(marketplace_id, currency_code)
      ON mc.marketplace_id = fe.marketplace_id AND mc.currency_code = fe.currency_code
    WHERE fe.event_subtype  = 'FBALongTermStorageFee'
      AND fe.fee_description = 'FBALongTermStorageFee'
    GROUP BY fe.marketplace_id, mc.currency_code,
             (date_trunc('month', fe.posted_date) - INTERVAL '1 month')::date
),
settled_aged AS (
    SELECT DISTINCT ON (marketplace_id) marketplace_id, currency_code, aged_total
    FROM settled_aged_raw
    ORDER BY marketplace_id, charge_month DESC
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
    -- physical age
    COALESCE(ag.units_aged_271_plus, 0) AS units_aged_271_plus,
    COALESCE(ag.units_aged_365_plus, 0) AS units_aged_365_plus,
    ag.age_snapshot_date,
    -- storage cost (GBP)
    ROUND(COALESCE(st.storage_base_gbp, 0)::numeric, 2)         AS storage_base_gbp,
    ROUND(COALESCE(p.aged_surcharge, 0)::numeric, 2)            AS aged_surcharge_in_cm3_gbp,
    -- aged surcharge (GBP), settlement-allocated by 271+ aged-unit share
    ROUND(COALESCE(sa.aged_total * safx.rate * ag.units_aged_271_plus / NULLIF(at.tot, 0), 0)::numeric, 2) AS aged_surcharge_est_gbp,
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
LEFT JOIN aged_tot at ON at.marketplace_id = ih.marketplace_id
LEFT JOIN settled_aged sa ON sa.marketplace_id = ih.marketplace_id
LEFT JOIN fx_map safx ON safx.ccy = TRIM(BOTH FROM sa.currency_code)
LEFT JOIN analytics.product_profitability_30d p ON p.marketplace_id = ih.marketplace_id AND p.asin = ih.asin
LEFT JOIN cogs c ON c.marketplace_id = ih.marketplace_id AND c.asin = ih.asin
LEFT JOIN fx_map cfx ON cfx.ccy = TRIM(BOTH FROM c.cogs_currency);

COMMENT ON VIEW analytics.storage_cost_by_asin IS
'Per-ASIN storage + age + cover + CM3 tipping-point + capital-at-risk, GBP. Spine = inventory_health_by_asin (all in-stock ASINs incl zero-sales dead stock). aged_surcharge_est_gbp is the SETTLED aged total allocated by 271+ aged-unit share (reconciles to settlement; not Amazon''s per-SKU estimate). is_storage_loss_maker = CM3<0 but CM3-pre-storage>=0; exit_trigger = CM3<0 OR cover>365d. Read surface for /storage-review. NB CM3 still excludes aged surcharge (separate change).';

COMMIT;
