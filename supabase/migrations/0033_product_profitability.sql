-- ============================================================================
-- 0033_product_profitability.sql
-- Accurate per-product profitability (true CM3) from SETTLED ACTUALS + storage.
--
-- Why this exists: /sku-audit reported a UK SKU at +55% margin that Helium 10
-- showed as loss-making. Root cause: margin was a simplified contribution
-- (ASP - assumed 15% referral - master fba_fee - COGS) that ignored VAT and,
-- decisively, STORAGE. FBA storage / long-term-storage land in
-- brain.financial_events only as account-level ServiceFeeEvent rows with NO
-- SKU attribution, and nothing computed a real per-product CM3. The vault's
-- own concept doc (wiki/concepts/cm1-cm2-cm3.md) defines CM3 to INCLUDE
-- storage, so the reported number was not a CM3 at all.
--
-- This migration adds:
--   brain.fba_storage_fees                       NEW TABLE  (per-FNSKU storage)
--   analytics.product_cost_crosswalk             VIEW  (SKU<->FNSKU<->ASIN + COGS)
--   analytics.product_pnl_daily                  VIEW  (daily actual fees, no storage)
--   analytics.product_profitability_30d          VIEW  (headline CM ladder + storage)
--   analytics.product_profitability_reconciliation VIEW (computed vs settled net)
--
-- CM ladder (vault definition):
--   CM1 = revenue_ex_vat - COGS
--   CM2 = CM1 - channel fees (referral + FBA fulfilment + closing + DST + promo)
--   CM3 = CM2 - ads - refunds - storage(base + aged) - returns COGS clawback
--
-- Revenue/fee actuals come from brain.financial_events ShipmentEvent /
-- RefundEvent rows (which DO carry seller `sku`). Empirically confirmed on
-- this account that `Principal` is VAT-EXCLUSIVE and `Tax` is the add-on VAT
-- (Tax ~= 20% of Principal+ShippingCharge), so output VAT is pass-through and
-- excluded from both revenue and cost.
--
-- amount in financial_events is always a POSITIVE magnitude; sign lives in
-- `direction` ('credit'|'debit'). ShipmentEvent fee components are all debits,
-- so we sum their magnitude directly as a positive cost.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- brain.fba_storage_fees
-- Per-FNSKU monthly storage charges from GET_FBA_STORAGE_FEE_CHARGES_DATA
-- (monthly_storage) and aged/long-term surcharges from
-- GET_FBA_INVENTORY_AGED_DATA (aged_surcharge / long_term_storage). One row
-- per (charge_month, marketplace_id, fnsku, fee_type). estimated_fee is the
-- positive fee magnitude already in marketplace currency.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brain.fba_storage_fees (
    charge_month             DATE        NOT NULL,   -- first day of the charged month
    marketplace_id           TEXT        NOT NULL,
    fnsku                    TEXT        NOT NULL,
    asin                     TEXT,                   -- as reported by Amazon (may be null/stale)
    canonical_sku            TEXT,                   -- resolved at ingest, best-effort
    product_name             TEXT,
    fee_type                 TEXT        NOT NULL,   -- 'monthly_storage'|'long_term_storage'|'aged_surcharge'|'disposal'
    average_quantity_on_hand NUMERIC,
    storage_volume           NUMERIC,                -- cubic units as reported
    estimated_fee            NUMERIC(18,4) NOT NULL, -- positive magnitude
    currency_code            CHAR(3)     NOT NULL,
    report_type              TEXT        NOT NULL,   -- provenance: which SP-API report produced the row
    raw_id                   BIGINT,
    ingested_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (charge_month, marketplace_id, fnsku, fee_type)
);

CREATE INDEX IF NOT EXISTS idx_fba_storage_fees_mkt_month
    ON brain.fba_storage_fees (marketplace_id, charge_month DESC);
CREATE INDEX IF NOT EXISTS idx_fba_storage_fees_fnsku
    ON brain.fba_storage_fees (fnsku);
CREATE INDEX IF NOT EXISTS idx_fba_storage_fees_asin
    ON brain.fba_storage_fees (asin) WHERE asin IS NOT NULL;

COMMENT ON TABLE brain.fba_storage_fees IS
'Per-FNSKU monthly FBA storage + aged/long-term surcharges. The per-SKU storage source the lake was missing; fee_type splits baseline monthly_storage from aged_surcharge/long_term_storage. Populated by `npm run ingest-storage-fees`.';

-- ----------------------------------------------------------------------------
-- analytics.product_cost_crosswalk
-- Exploded SKU <-> FNSKU <-> ASIN map with COGS, one row per
-- (marketplace_id, fnsku, seller_sku). Joinable to financial_events on
-- (marketplace_id, sku) and to fba_storage_fees on (marketplace_id, fnsku).
-- Latest snapshot only (mapping drift on historical months is a known,
-- accepted limitation for RW's stable SKU set).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.product_cost_crosswalk AS
WITH latest AS (
    SELECT marketplace_id, fnsku, canonical_sku, all_skus, asin, sku_count
    FROM analytics.fba_inventory_per_fnsku
    WHERE asin IS NOT NULL
      AND snapshot_date = (SELECT MAX(snapshot_date) FROM analytics.fba_inventory_per_fnsku)
)
SELECT
    l.marketplace_id,
    l.asin,
    l.fnsku,
    l.canonical_sku,
    sku_x.seller_sku,
    l.all_skus,
    l.sku_count,
    (l.sku_count > 1)        AS fnsku_fanout,
    sm.ean,
    sm.brand,
    sm.cogs_landed,
    sm.cogs_currency,
    sm.fba_fee
FROM latest l
CROSS JOIN LATERAL unnest(l.all_skus) AS sku_x(seller_sku)
LEFT JOIN brain.sku_master sm ON sm.asin = l.asin;

COMMENT ON VIEW analytics.product_cost_crosswalk IS
'Exploded SKU<->FNSKU<->ASIN map (latest inventory snapshot) with COGS from brain.sku_master. fnsku_fanout=TRUE means one FNSKU maps to multiple seller SKUs (storage/fee attribution to a single ASIN is then approximate). Latest-snapshot only: do not use to attribute very old months.';

-- ----------------------------------------------------------------------------
-- analytics.product_pnl_daily
-- Daily actual revenue + per-order fees per (marketplace, asin, day, currency)
-- from settled financial_events. Storage is NOT day-sliced (monthly fee can't
-- be honestly attributed to a day) - see product_profitability_30d for the
-- storage-loaded CM3. This view is the daily ops grain for trend/sparklines.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.product_pnl_daily AS
WITH sku_asin AS (
    SELECT DISTINCT marketplace_id, seller_sku, asin FROM analytics.product_cost_crosswalk
)
SELECT
    cw.marketplace_id,
    cw.asin,
    f.posted_date::date                                                                   AS metric_date,
    f.currency_code,
    SUM(f.amount) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description IN ('Principal','ShippingCharge'))      AS revenue_ex_vat,
    COUNT(*)      FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description='Principal')                            AS units_settled,
    SUM(f.amount) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description='Commission')                          AS referral_fees,
    SUM(f.amount) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description='FBAPerUnitFulfillmentFee')            AS fba_fulfilment,
    SUM(f.amount) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description ILIKE '%ClosingFee%')                  AS closing_fees,
    SUM(f.amount) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description IN ('DigitalServicesFee','DigitalServicesFeeFBA','ShippingChargeback')) AS other_amazon_fees,
    SUM(f.amount) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description='PromotionMetaDataDefinitionValue')    AS promo_total,
    SUM(f.amount) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description IN ('Tax','ShippingTax'))              AS output_vat_passthrough,
    SUM(CASE WHEN f.event_type='RefundEvent' AND f.fee_description NOT IN ('Tax','ShippingTax')
             THEN CASE WHEN f.direction='credit' THEN f.amount ELSE -f.amount END ELSE 0 END)                             AS refund_net
FROM brain.financial_events f
JOIN sku_asin cw ON cw.marketplace_id = f.marketplace_id AND cw.seller_sku = f.sku
WHERE f.event_type IN ('ShipmentEvent','RefundEvent')
GROUP BY cw.marketplace_id, cw.asin, f.posted_date::date, f.currency_code;

COMMENT ON VIEW analytics.product_pnl_daily IS
'Daily settled revenue + per-order actual fees per (marketplace, asin, day). revenue_ex_vat = Principal + ShippingCharge (both VAT-exclusive on this account); output VAT is pass-through and excluded. Storage is deliberately absent here - use analytics.product_profitability_30d for storage-loaded CM3.';

-- ----------------------------------------------------------------------------
-- analytics.product_profitability_30d
-- Headline per-(marketplace, asin) CM ladder over the trailing 30 days, built
-- from settled actuals + per-FNSKU storage. This replaces the simplified
-- ASP-minus-assumptions formula in /sku-audit, /wbr, /restock-memo.
--
-- Storage allocation: storage is billed monthly, so a 30d window carries ~one
-- month of it. We take the most recent available month's per-ASIN storage as
-- the 30d storage figure and flag its source:
--   per_fnsku                = the just-closed month is loaded (high confidence)
--   modelled_from_prev_month = only older month(s) exist; using the latest as
--                              a proxy for the open/partial current month
--   missing                  = no per-FNSKU storage for this ASIN at all
-- A rolling window that treated current-month storage as zero would silently
-- understate cost exactly when inventory spikes (the overstock case) - so we
-- never zero it when a prior month can model it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.product_profitability_30d AS
WITH params AS (
    SELECT (CURRENT_DATE - INTERVAL '30 days')::date AS win_start,
           CURRENT_DATE                              AS win_end,
           'GBP'::char(3)                            AS reporting_ccy  -- mirrors env REPORTING_CURRENCY (GBP)
),
sku_asin AS (
    SELECT DISTINCT marketplace_id, seller_sku, asin FROM analytics.product_cost_crosswalk
),
attrs AS (
    SELECT marketplace_id, asin,
           MAX(cogs_landed)   AS cogs_landed,
           MAX(cogs_currency) AS cogs_currency,
           MAX(brand)         AS brand,
           bool_or(fnsku_fanout) AS fnsku_fanout
    FROM analytics.product_cost_crosswalk
    GROUP BY marketplace_id, asin
),
fe AS (
    SELECT
        cw.marketplace_id,
        cw.asin,
        MIN(f.currency_code) AS currency_code,
        SUM(f.amount) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description IN ('Principal','ShippingCharge'))   AS revenue_ex_vat,
        COUNT(*)      FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description='Principal')                         AS units_settled,
        COALESCE(SUM(f.amount) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description='Commission'),0)           AS referral_fees,
        COALESCE(SUM(f.amount) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description='FBAPerUnitFulfillmentFee'),0) AS fba_fulfilment,
        COALESCE(SUM(f.amount) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description ILIKE '%ClosingFee%'),0)    AS closing_fees,
        COALESCE(SUM(f.amount) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description IN ('DigitalServicesFee','DigitalServicesFeeFBA','ShippingChargeback')),0) AS other_amazon_fees,
        COALESCE(SUM(f.amount) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description='PromotionMetaDataDefinitionValue'),0) AS promo_total,
        COALESCE(SUM(CASE WHEN f.event_type='RefundEvent' AND f.fee_description NOT IN ('Tax','ShippingTax')
                 THEN CASE WHEN f.direction='credit' THEN f.amount ELSE -f.amount END ELSE 0 END),0)                       AS refund_net
    FROM brain.financial_events f
    JOIN sku_asin cw ON cw.marketplace_id = f.marketplace_id AND cw.seller_sku = f.sku
    WHERE f.event_type IN ('ShipmentEvent','RefundEvent')
      AND f.posted_date >= (SELECT win_start FROM params)
      AND f.posted_date <  (SELECT win_end   FROM params)
    GROUP BY cw.marketplace_id, cw.asin
),
ads AS (
    SELECT marketplace_id, child_asin AS asin, COALESCE(SUM(total_cost),0) AS ads_total
    FROM analytics.ads_per_asin_daily
    WHERE metric_date >= (SELECT win_start FROM params)
      AND metric_date <  (SELECT win_end   FROM params)
    GROUP BY marketplace_id, child_asin
),
ret AS (
    -- brain.fba_returns carries no marketplace_id; map it via the crosswalk on
    -- fnsku to land each return on its (marketplace, asin).
    SELECT cw.marketplace_id, COALESCE(cw.asin, r.asin) AS asin,
           SUM(r.quantity) FILTER (WHERE r.detailed_disposition !~* 'sellable') AS nonsellable_units
    FROM brain.fba_returns r
    LEFT JOIN (SELECT DISTINCT marketplace_id, fnsku, asin FROM analytics.product_cost_crosswalk) cw
           ON cw.fnsku = r.fnsku
    WHERE r.return_date >= (SELECT win_start FROM params)
      AND r.return_date <  (SELECT win_end   FROM params)
      AND cw.marketplace_id IS NOT NULL
      AND COALESCE(cw.asin, r.asin) IS NOT NULL
    GROUP BY cw.marketplace_id, COALESCE(cw.asin, r.asin)
),
storage_monthly AS (
    SELECT
        COALESCE(cw.asin, sf.asin) AS asin,
        sf.marketplace_id,
        sf.charge_month,
        MIN(sf.currency_code) AS currency_code,
        COALESCE(SUM(sf.estimated_fee) FILTER (WHERE sf.fee_type='monthly_storage'),0)                              AS storage_base,
        COALESCE(SUM(sf.estimated_fee) FILTER (WHERE sf.fee_type IN ('long_term_storage','aged_surcharge')),0)      AS aged_surcharge
    FROM brain.fba_storage_fees sf
    LEFT JOIN (SELECT DISTINCT marketplace_id, fnsku, asin FROM analytics.product_cost_crosswalk) cw
           ON cw.marketplace_id = sf.marketplace_id AND cw.fnsku = sf.fnsku
    GROUP BY COALESCE(cw.asin, sf.asin), sf.marketplace_id, sf.charge_month
),
storage_latest AS (
    SELECT DISTINCT ON (marketplace_id, asin)
        marketplace_id, asin, charge_month, storage_base, aged_surcharge,
        CASE WHEN charge_month >= (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date
             THEN 'per_fnsku' ELSE 'modelled_from_prev_month' END AS storage_source
    FROM storage_monthly
    WHERE asin IS NOT NULL
    ORDER BY marketplace_id, asin, charge_month DESC
)
SELECT
    fe.marketplace_id,
    m.country_code,
    m.country_name,
    fe.asin,
    a.brand,
    (SELECT win_start FROM params)                                       AS period_start,
    (SELECT win_end   FROM params)                                       AS period_end,
    fe.currency_code,
    (SELECT reporting_ccy FROM params)                                   AS reporting_currency,

    fe.units_settled,
    st.units_ordered_st,
    ROUND(fe.revenue_ex_vat, 2)                                          AS revenue_ex_vat,
    ROUND(COALESCE(fe.units_settled,0) * COALESCE(a.cogs_landed,0), 2)   AS cogs_total,
    ROUND(fe.referral_fees, 2)                                           AS referral_fees,
    ROUND(fe.fba_fulfilment, 2)                                          AS fba_fulfilment,
    ROUND(fe.closing_fees, 2)                                            AS closing_fees,
    ROUND(fe.other_amazon_fees, 2)                                       AS other_amazon_fees,
    ROUND(fe.promo_total, 2)                                             AS promo_total,
    ROUND(COALESCE(ads.ads_total,0), 2)                                  AS ads_total,
    ROUND(fe.refund_net, 2)                                              AS refund_net,
    ROUND(COALESCE(sl.storage_base,0), 2)                                AS storage_base,
    ROUND(COALESCE(sl.aged_surcharge,0), 2)                              AS aged_surcharge,
    ROUND(COALESCE(ret.nonsellable_units,0) * COALESCE(a.cogs_landed,0), 2) AS returns_cogs_clawback,

    -- CM ladder (vault definition)
    ROUND(fe.revenue_ex_vat - COALESCE(fe.units_settled,0)*COALESCE(a.cogs_landed,0), 2) AS cm1,
    ROUND(fe.revenue_ex_vat - COALESCE(fe.units_settled,0)*COALESCE(a.cogs_landed,0)
          - fe.referral_fees - fe.fba_fulfilment - fe.closing_fees - fe.other_amazon_fees - fe.promo_total, 2) AS cm2,
    ROUND(fe.revenue_ex_vat - COALESCE(fe.units_settled,0)*COALESCE(a.cogs_landed,0)
          - fe.referral_fees - fe.fba_fulfilment - fe.closing_fees - fe.other_amazon_fees - fe.promo_total
          - COALESCE(ads.ads_total,0) + fe.refund_net
          - COALESCE(sl.storage_base,0) - COALESCE(sl.aged_surcharge,0)
          - COALESCE(ret.nonsellable_units,0)*COALESCE(a.cogs_landed,0), 2) AS cm3,
    CASE WHEN fe.revenue_ex_vat > 0 THEN ROUND(100.0 * (
          fe.revenue_ex_vat - COALESCE(fe.units_settled,0)*COALESCE(a.cogs_landed,0)
          - fe.referral_fees - fe.fba_fulfilment - fe.closing_fees - fe.other_amazon_fees - fe.promo_total
          - COALESCE(ads.ads_total,0) + fe.refund_net
          - COALESCE(sl.storage_base,0) - COALESCE(sl.aged_surcharge,0)
          - COALESCE(ret.nonsellable_units,0)*COALESCE(a.cogs_landed,0)
        ) / fe.revenue_ex_vat, 1) END                                    AS cm3_margin_pct,

    -- reporting-currency mirror of CM3 (NULL when no FX rate exists)
    CASE WHEN fx.rate IS NOT NULL THEN ROUND((
          fe.revenue_ex_vat - COALESCE(fe.units_settled,0)*COALESCE(a.cogs_landed,0)
          - fe.referral_fees - fe.fba_fulfilment - fe.closing_fees - fe.other_amazon_fees - fe.promo_total
          - COALESCE(ads.ads_total,0) + fe.refund_net
          - COALESCE(sl.storage_base,0) - COALESCE(sl.aged_surcharge,0)
          - COALESCE(ret.nonsellable_units,0)*COALESCE(a.cogs_landed,0)
        ) * fx.rate, 2) END                                              AS cm3_rc,

    COALESCE(sl.storage_source, 'missing')                               AS storage_source,
    a.fnsku_fanout,
    CASE WHEN a.cogs_landed IS NULL THEN 'cogs:missing'
         ELSE 'cogs:ok' END
      || ';storage:' || COALESCE(sl.storage_source,'missing')
      || ';fx:' || CASE WHEN fx.rate IS NULL THEN 'missing' ELSE 'ok' END AS cost_completeness,
    CASE
        WHEN a.cogs_landed IS NULL OR COALESCE(sl.storage_source,'missing')='missing' THEN 'low'
        WHEN sl.storage_source='per_fnsku' AND fx.rate IS NOT NULL THEN 'high'
        ELSE 'medium'
    END                                                                  AS confidence,
    EXTRACT(EPOCH FROM (NOW() - (SELECT MAX(ingested_at) FROM brain.financial_events))) / 3600.0 AS lake_age_hours
FROM fe
LEFT JOIN attrs a       ON a.marketplace_id = fe.marketplace_id AND a.asin = fe.asin
LEFT JOIN ads           ON ads.marketplace_id = fe.marketplace_id AND ads.asin = fe.asin
LEFT JOIN ret           ON ret.marketplace_id = fe.marketplace_id AND ret.asin = fe.asin
LEFT JOIN storage_latest sl ON sl.marketplace_id = fe.marketplace_id AND sl.asin = fe.asin
LEFT JOIN (
    SELECT marketplace_id, child_asin AS asin,
           SUM(units_ordered) AS units_ordered_st
    FROM brain.sales_traffic_daily
    WHERE metric_date >= (SELECT win_start FROM params)
      AND metric_date <  (SELECT win_end   FROM params)
    GROUP BY marketplace_id, child_asin
) st ON st.marketplace_id = fe.marketplace_id AND st.asin = fe.asin
LEFT JOIN meta.marketplace m ON m.marketplace_id = fe.marketplace_id
LEFT JOIN LATERAL (
    -- Same-currency rows convert at 1.0 (no GBP->GBP row is seeded); otherwise
    -- take the latest rate <= period end. NULL rate => cm3_rc NULL, confidence drops.
    SELECT CASE
             WHEN COALESCE(fe.currency_code, m.native_currency) = (SELECT reporting_ccy FROM params) THEN 1.0
             ELSE (
               SELECT r.rate FROM meta.fx_rates r
               WHERE r.base_currency  = COALESCE(fe.currency_code, m.native_currency)
                 AND r.quote_currency = (SELECT reporting_ccy FROM params)
                 AND r.rate_date     <= (SELECT win_end FROM params)
               ORDER BY r.rate_date DESC
               LIMIT 1
             )
           END AS rate
) fx ON TRUE;

COMMENT ON VIEW analytics.product_profitability_30d IS
'Headline per-(marketplace, asin) CM1/CM2/CM3 over the trailing 30 days, from SETTLED actuals (brain.financial_events: real referral/FBA/promo, VAT excluded as pass-through) + per-FNSKU storage (brain.fba_storage_fees) + ads + returns COGS clawback. CM3 follows the vault definition (includes storage). storage_source flags per_fnsku|modelled_from_prev_month|missing; confidence reflects storage + cogs + fx completeness. THIS is the margin source of truth for /sku-audit, /wbr, /restock-memo - never the old ASP-minus-assumptions formula. units_settled counts settled order-item lines (qty>1 slightly understates; flagged).';

-- ----------------------------------------------------------------------------
-- analytics.product_profitability_reconciliation
-- The detector: computed net (from financial_events, product-attributable)
-- vs actual settled net (from settlement_lines) per (marketplace, asin) over
-- a trailing 90d window. A large variance means the computed margin is wrong.
-- Non-product / global settlement lines (no sku) are excluded from the
-- per-ASIN comparison and surfaced separately as unmatched.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.product_profitability_reconciliation AS
WITH win AS (
    SELECT (CURRENT_DATE - INTERVAL '90 days')::date AS s, CURRENT_DATE AS e
),
sku_asin AS (
    SELECT DISTINCT marketplace_id, seller_sku, asin FROM analytics.product_cost_crosswalk
),
computed AS (
    SELECT cw.marketplace_id, cw.asin,
           SUM(CASE WHEN f.direction='credit' THEN f.amount ELSE -f.amount END) AS computed_net
    FROM brain.financial_events f
    JOIN sku_asin cw ON cw.marketplace_id=f.marketplace_id AND cw.seller_sku=f.sku
    WHERE f.event_type IN ('ShipmentEvent','RefundEvent','AdjustmentEvent')
      AND f.posted_date >= (SELECT s FROM win) AND f.posted_date < (SELECT e FROM win)
    GROUP BY cw.marketplace_id, cw.asin
),
settled AS (
    SELECT s.marketplace_id, cw.asin,
           SUM(sl.amount) AS settled_net
    FROM brain.settlement_lines sl
    JOIN brain.settlements s ON s.settlement_id = sl.settlement_id
    JOIN sku_asin cw ON cw.marketplace_id=s.marketplace_id AND cw.seller_sku=sl.sku
    WHERE sl.sku IS NOT NULL
      AND sl.posted_date >= (SELECT s FROM win) AND sl.posted_date < (SELECT e FROM win)
    GROUP BY s.marketplace_id, cw.asin
),
unmatched AS (
    -- Global / non-product settlement lines (no sku): storage, subscription,
    -- inbound transport, etc. Surfaced per marketplace so they never count
    -- against any single ASIN's variance.
    SELECT s.marketplace_id, SUM(sl.amount) AS unmatched_settlement_amount
    FROM brain.settlement_lines sl
    JOIN brain.settlements s ON s.settlement_id = sl.settlement_id
    WHERE sl.sku IS NULL
      AND sl.posted_date >= (SELECT s FROM win) AND sl.posted_date < (SELECT e FROM win)
    GROUP BY s.marketplace_id
)
SELECT
    COALESCE(c.marketplace_id, se.marketplace_id) AS marketplace_id,
    COALESCE(c.asin, se.asin)                     AS asin,
    (SELECT s FROM win)                           AS period_start,
    (SELECT e FROM win)                           AS period_end,
    ROUND(COALESCE(c.computed_net,0), 2)          AS computed_net,
    ROUND(COALESCE(se.settled_net,0), 2)          AS settled_net,
    ROUND(COALESCE(se.settled_net,0) - COALESCE(c.computed_net,0), 2) AS variance_abs,
    CASE WHEN COALESCE(se.settled_net,0) <> 0
         THEN ROUND(100.0 * (COALESCE(se.settled_net,0) - COALESCE(c.computed_net,0)) / ABS(se.settled_net), 1)
         END                                      AS variance_pct,
    ROUND(COALESCE(u.unmatched_settlement_amount,0), 2) AS unmatched_settlement_amount
FROM computed c
FULL OUTER JOIN settled se USING (marketplace_id, asin)
LEFT JOIN unmatched u ON u.marketplace_id = COALESCE(c.marketplace_id, se.marketplace_id);

COMMENT ON VIEW analytics.product_profitability_reconciliation IS
'Drift detector: computed net (financial_events product-attributable) vs actual settled net (settlement_lines by sku) per (marketplace, asin) over trailing 90d. variance_pct beyond tolerance (e.g. 5pp) means the computed CM3 is suspect. Global/no-sku settlement lines are excluded from the per-ASIN comparison and shown as unmatched_settlement_amount per marketplace. Approximate by design (posted vs settled timing differs) - a coarse alarm, not a ledger.';

INSERT INTO meta.migration_history (filename)
VALUES ('0033_product_profitability.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
