-- ============================================================================
-- 0034_inbound_freight_and_gbp_cm.sql
-- Inbound (3PL -> FBA) freight cost per unit, plus a GBP rework of the CM
-- ladder.
--
-- Inbound model (two tiers):
--   1. CASE QTY (primary): when a SKU ships in clean master cartons we know the
--      pack-out. inbound/unit = box cost / units_per_case. units_per_case comes
--      from sku-packaging.csv via `npm run import-packaging` (NOT calculated).
--      Box cost: UK GBP4.20 (DPD), US GBP60.
--   2. VOLUMETRIC (fallback): SKUs that arrive loose and are reworked at inbound
--      have no master carton (#N/A in the packaging file). For these we cost the
--      inbound as a share of the largest box we can send to Amazon
--      (64 x 46 x 46 cm = 0.135424 m^3, 22 kg): units_per_max_box =
--      floor(max_box_volume / unit_volume), inbound/unit = box cost /
--      units_per_max_box. unit_volume comes from the FBA storage report (the one
--      real per-unit volume we hold), NA cubic-feet normalised to m^3.
--
-- GBP rework: the NA marketplace (ATVPDKIKX0DER) settles remote-fulfilment
-- orders in USD/CAD/GBP, so the 0033 view's per-marketplace MIN(currency) + raw
-- SUM mixed currencies and corrupted US figures. Every revenue/fee/ad/storage/
-- cogs line is now FX-converted to GBP (meta.fx_rates) before summing, and the
-- GBP box cost slots in cleanly. Run `npm run sync-fx-rates` first (it now
-- covers every currency in use, incl CAD).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- brain.inbound_freight_rate — per-marketplace box cost + the max Amazon box.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brain.inbound_freight_rate (
    marketplace_id    TEXT PRIMARY KEY,
    cost_per_box      NUMERIC(12,4) NOT NULL,
    currency_code     CHAR(3)       NOT NULL,
    max_box_volume_m3 NUMERIC(12,6) NOT NULL,  -- largest box we can send to Amazon
    max_box_weight_kg NUMERIC(8,3)  NOT NULL,
    notes             TEXT,
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- max box 64 x 46 x 46 cm = 0.135424 m^3, 22 kg (operator-stated Amazon limit).
INSERT INTO brain.inbound_freight_rate
    (marketplace_id, cost_per_box, currency_code, max_box_volume_m3, max_box_weight_kg, notes) VALUES
    ('A1F83G8C2ARO7P', 4.20,  'GBP', 0.135424, 22, 'UK DPD average box; max Amazon box 64x46x46cm/22kg'),
    ('ATVPDKIKX0DER',  60.00, 'GBP', 0.135424, 22, 'US average box (UK 3PL origin); max Amazon box 64x46x46cm/22kg')
ON CONFLICT (marketplace_id) DO UPDATE
    SET cost_per_box = EXCLUDED.cost_per_box, currency_code = EXCLUDED.currency_code,
        max_box_volume_m3 = EXCLUDED.max_box_volume_m3, max_box_weight_kg = EXCLUDED.max_box_weight_kg,
        notes = EXCLUDED.notes, updated_at = NOW();

COMMENT ON TABLE brain.inbound_freight_rate IS
'3PL->FBA inbound box cost per marketplace + the max Amazon box dims. Tier 1: inbound/unit = cost_per_box / units_per_case. Tier 2 (no case qty): cost_per_box / floor(max_box_volume_m3 / unit_volume).';

-- ----------------------------------------------------------------------------
-- sku_master: packaging columns (populated by import-packaging from the CSV).
-- ----------------------------------------------------------------------------
ALTER TABLE brain.sku_master ADD COLUMN IF NOT EXISTS units_per_case        INTEGER;
ALTER TABLE brain.sku_master ADD COLUMN IF NOT EXISTS units_per_case_source TEXT;
ALTER TABLE brain.sku_master ADD COLUMN IF NOT EXISTS carton_length_cm      NUMERIC(8,2);
ALTER TABLE brain.sku_master ADD COLUMN IF NOT EXISTS carton_width_cm       NUMERIC(8,2);
ALTER TABLE brain.sku_master ADD COLUMN IF NOT EXISTS carton_height_cm      NUMERIC(8,2);
ALTER TABLE brain.sku_master ADD COLUMN IF NOT EXISTS carton_weight_kg      NUMERIC(8,3);
-- US inbound box cost computed from the UPS rate card (compute-us-inbound CLI):
-- billed weight (max actual vs L*W*H/5000) -> freight band -> MRPP floor. GBP.
ALTER TABLE brain.sku_master ADD COLUMN IF NOT EXISTS us_inbound_box_cost_gbp     NUMERIC(12,4);
ALTER TABLE brain.sku_master ADD COLUMN IF NOT EXISTS us_inbound_billed_weight_kg NUMERIC(8,3);
-- Per-unit US inbound cost + the method used (compute-us-inbound): 'carton'
-- (operator carton dims), 'item_x_case' (storage item dims x known case qty),
-- 'volumetric_item' (weight+volume-limited max-box fit). Priced via UPS.
ALTER TABLE brain.sku_master ADD COLUMN IF NOT EXISTS us_inbound_per_unit_gbp     NUMERIC(12,4);
ALTER TABLE brain.sku_master ADD COLUMN IF NOT EXISTS us_inbound_method           TEXT;
-- HS / commodity codes for duty resolution (import-hs-codes CLI).
ALTER TABLE brain.sku_master ADD COLUMN IF NOT EXISTS hs_code_us                  TEXT;
ALTER TABLE brain.sku_master ADD COLUMN IF NOT EXISTS hs_code_uk                  TEXT;
ALTER TABLE brain.sku_master ADD COLUMN IF NOT EXISTS hs_code_source              TEXT;

-- ----------------------------------------------------------------------------
-- brain.us_import_duty_rate — HS-code -> US import duty (base + Section 301 +
-- reciprocal). total_pct is authoritative. The '*' row is the catch-all default
-- applied when a SKU has no HS match. Operator-maintained (import-duty-rates).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brain.us_import_duty_rate (
    hs_code           TEXT          NOT NULL,   -- HS/HTS prefix; '*' = default
    base_pct          NUMERIC(6,4),
    section_301_pct   NUMERIC(6,4),
    reciprocal_pct    NUMERIC(6,4),
    total_pct         NUMERIC(6,4)  NOT NULL,
    effective_from    DATE          NOT NULL DEFAULT '2025-01-01',
    notes             TEXT,
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (hs_code, effective_from)
);
INSERT INTO brain.us_import_duty_rate (hs_code, total_pct, effective_from, notes) VALUES
    ('*',       0.6020, '2025-01-01', 'Default fallback US duty (China-origin); edit to your blended rate'),
    ('7323.94', 0.6020, '2025-01-01', 'Steel kitchenware/bakeware China — base+301+reciprocal (from PO costings)')
ON CONFLICT (hs_code, effective_from) DO UPDATE
    SET total_pct = EXCLUDED.total_pct, notes = EXCLUDED.notes, updated_at = NOW();

COMMENT ON TABLE brain.us_import_duty_rate IS
'HS-code -> US import duty %. Longest-prefix match (10-digit -> chapter); hs_code=''*'' is the default fallback. total_pct authoritative; base/301/reciprocal for transparency + what-if.';

COMMENT ON COLUMN brain.sku_master.units_per_case IS
'Units per master carton, from sku-packaging.csv (authoritative; NOT derived). NULL = SKU has no clean master carton (reworked at inbound) -> volumetric fallback.';

-- ----------------------------------------------------------------------------
-- analytics.product_cost_crosswalk — add packaging passthrough.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.product_cost_crosswalk AS
WITH latest AS (
    SELECT marketplace_id, fnsku, canonical_sku, all_skus, asin, sku_count
    FROM analytics.fba_inventory_per_fnsku
    WHERE asin IS NOT NULL
      AND snapshot_date = (SELECT MAX(snapshot_date) FROM analytics.fba_inventory_per_fnsku)
)
SELECT
    l.marketplace_id, l.asin, l.fnsku, l.canonical_sku, sku_x.seller_sku,
    l.all_skus, l.sku_count, (l.sku_count > 1) AS fnsku_fanout,
    sm.ean, sm.brand, sm.cogs_landed, sm.cogs_currency, sm.fba_fee,
    sm.units_per_case, sm.units_per_case_source, sm.us_inbound_box_cost_gbp,
    sm.us_inbound_per_unit_gbp, sm.us_inbound_method
FROM latest l
CROSS JOIN LATERAL unnest(l.all_skus) AS sku_x(seller_sku)
LEFT JOIN brain.sku_master sm ON sm.asin = l.asin;

COMMENT ON VIEW analytics.product_cost_crosswalk IS
'Exploded SKU<->FNSKU<->ASIN map (latest snapshot) with COGS + units_per_case from brain.sku_master. Latest-snapshot only.';

-- ----------------------------------------------------------------------------
-- analytics.product_profitability_30d — GBP CM ladder + inbound freight.
-- DROP+CREATE: column shape changes vs 0033.
-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- analytics.sku_us_duty — per-ASIN US duty rate: longest HS-prefix match
-- effective today, else the '*' default. duty_source flags hs vs default.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.sku_us_duty AS
WITH base AS (
    SELECT DISTINCT ON (sm.asin) sm.asin, sm.ean, sm.hs_code_us
    FROM brain.sku_master sm
    WHERE sm.asin IS NOT NULL
    ORDER BY sm.asin, (sm.hs_code_us IS NOT NULL) DESC, sm.ean
)
SELECT b.asin, b.ean, b.hs_code_us,
    COALESCE(m.total_pct, dflt.total_pct, 0.60) AS duty_pct,
    CASE WHEN m.total_pct IS NOT NULL THEN 'hs' ELSE 'default' END AS duty_source
FROM base b
LEFT JOIN LATERAL (
    SELECT r.total_pct FROM brain.us_import_duty_rate r
    WHERE r.hs_code <> '*' AND b.hs_code_us LIKE r.hs_code || '%' AND r.effective_from <= CURRENT_DATE
    ORDER BY LENGTH(r.hs_code) DESC, r.effective_from DESC LIMIT 1
) m ON TRUE
LEFT JOIN LATERAL (
    SELECT total_pct FROM brain.us_import_duty_rate WHERE hs_code='*' AND effective_from <= CURRENT_DATE
    ORDER BY effective_from DESC LIMIT 1
) dflt ON TRUE;

COMMENT ON VIEW analytics.sku_us_duty IS
'Per-ASIN US import duty rate. Longest HS-prefix match in brain.us_import_duty_rate effective today; falls back to the ''*'' default row (duty_source=default). Joined into product_profitability_30d as the US import_duty line.';

DROP VIEW IF EXISTS analytics.product_profitability_30d;
CREATE VIEW analytics.product_profitability_30d AS
WITH params AS (
    SELECT (CURRENT_DATE - INTERVAL '30 days')::date AS win_start,
           CURRENT_DATE AS win_end, 'GBP'::char(3) AS reporting_ccy
),
fx_map AS (
    SELECT 'GBP'::text AS ccy, 1.0::numeric AS rate
    UNION ALL
    SELECT base_currency, rate FROM (
        SELECT DISTINCT ON (base_currency) base_currency, rate
        FROM meta.fx_rates
        WHERE quote_currency = 'GBP' AND rate_date <= CURRENT_DATE
        ORDER BY base_currency, rate_date DESC
    ) l
),
sku_asin AS (SELECT DISTINCT marketplace_id, seller_sku, asin FROM analytics.product_cost_crosswalk),
attrs AS (
    SELECT marketplace_id, asin,
           MAX(cogs_landed) AS cogs_landed, MAX(cogs_currency) AS cogs_currency,
           MAX(brand) AS brand, MAX(units_per_case) AS units_per_case,
           MAX(units_per_case_source) AS units_per_case_source,
           MAX(us_inbound_box_cost_gbp) AS us_inbound_box_cost_gbp,
           MAX(us_inbound_per_unit_gbp) AS us_inbound_per_unit_gbp,
           MAX(us_inbound_method) AS us_inbound_method,
           bool_or(fnsku_fanout) AS fnsku_fanout
    FROM analytics.product_cost_crosswalk GROUP BY marketplace_id, asin
),
-- per-unit volume (m^3) from the storage report; NA cubic-feet normalised.
unitvol AS (
    SELECT COALESCE(cw.asin, sf.asin) AS asin,
           SUM(sf.storage_volume * CASE WHEN sf.marketplace_id IN ('ATVPDKIKX0DER','A2EUQ1WTGCTBG2','A1AM78C64UM0Y8')
                                        THEN 0.0283168 ELSE 1 END)
             / NULLIF(SUM(sf.average_quantity_on_hand),0) AS unit_vol_m3
    FROM brain.fba_storage_fees sf
    LEFT JOIN (SELECT DISTINCT marketplace_id, fnsku, asin FROM analytics.product_cost_crosswalk) cw
           ON cw.marketplace_id = sf.marketplace_id AND cw.fnsku = sf.fnsku
    WHERE sf.fee_type = 'monthly_storage' AND sf.average_quantity_on_hand > 0 AND sf.storage_volume > 0
    GROUP BY COALESCE(cw.asin, sf.asin)
),
fe AS (
    SELECT cw.marketplace_id, cw.asin,
        COUNT(*) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description='Principal') AS units_settled,
        COALESCE(SUM(f.amount*fx.rate) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description IN ('Principal','ShippingCharge')),0) AS revenue_ex_vat,
        COALESCE(SUM(f.amount*fx.rate) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description='Commission'),0)            AS referral_fees,
        COALESCE(SUM(f.amount*fx.rate) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description='FBAPerUnitFulfillmentFee'),0) AS fba_fulfilment,
        COALESCE(SUM(f.amount*fx.rate) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description ILIKE '%ClosingFee%'),0)     AS closing_fees,
        COALESCE(SUM(f.amount*fx.rate) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description IN ('DigitalServicesFee','DigitalServicesFeeFBA','ShippingChargeback')),0) AS other_amazon_fees,
        COALESCE(SUM(f.amount*fx.rate) FILTER (WHERE f.event_type='ShipmentEvent' AND f.fee_description='PromotionMetaDataDefinitionValue'),0) AS promo_total,
        COALESCE(SUM((CASE WHEN f.direction='credit' THEN f.amount ELSE -f.amount END)*fx.rate) FILTER (WHERE f.event_type='RefundEvent' AND f.fee_description NOT IN ('Tax','ShippingTax')),0) AS refund_net,
        bool_or(fx.rate IS NULL) AS any_unconverted
    FROM brain.financial_events f
    JOIN sku_asin cw ON cw.marketplace_id = f.marketplace_id AND cw.seller_sku = f.sku
    LEFT JOIN fx_map fx ON fx.ccy = TRIM(f.currency_code)
    WHERE f.event_type IN ('ShipmentEvent','RefundEvent')
      AND f.posted_date >= (SELECT win_start FROM params) AND f.posted_date < (SELECT win_end FROM params)
    GROUP BY cw.marketplace_id, cw.asin
),
ads AS (
    SELECT a.marketplace_id, a.child_asin AS asin, COALESCE(SUM(a.total_cost*fx.rate),0) AS ads_total
    FROM analytics.ads_per_asin_daily a
    LEFT JOIN fx_map fx ON fx.ccy = TRIM(a.currency_code)
    WHERE a.metric_date >= (SELECT win_start FROM params) AND a.metric_date < (SELECT win_end FROM params)
    GROUP BY a.marketplace_id, a.child_asin
),
ret AS (
    SELECT cw.marketplace_id, COALESCE(cw.asin, r.asin) AS asin,
           SUM(r.quantity) FILTER (WHERE r.detailed_disposition !~* 'sellable') AS nonsellable_units
    FROM brain.fba_returns r
    LEFT JOIN (SELECT DISTINCT marketplace_id, fnsku, asin FROM analytics.product_cost_crosswalk) cw ON cw.fnsku = r.fnsku
    WHERE r.return_date >= (SELECT win_start FROM params) AND r.return_date < (SELECT win_end FROM params)
      AND cw.marketplace_id IS NOT NULL AND COALESCE(cw.asin, r.asin) IS NOT NULL
    GROUP BY cw.marketplace_id, COALESCE(cw.asin, r.asin)
),
storage_monthly AS (
    SELECT COALESCE(cw.asin, sf.asin) AS asin, sf.marketplace_id, sf.charge_month,
        COALESCE(SUM(sf.estimated_fee*fx.rate) FILTER (WHERE sf.fee_type='monthly_storage'),0)                         AS storage_base,
        COALESCE(SUM(sf.estimated_fee*fx.rate) FILTER (WHERE sf.fee_type IN ('long_term_storage','aged_surcharge')),0) AS aged_surcharge
    FROM brain.fba_storage_fees sf
    LEFT JOIN (SELECT DISTINCT marketplace_id, fnsku, asin FROM analytics.product_cost_crosswalk) cw
           ON cw.marketplace_id = sf.marketplace_id AND cw.fnsku = sf.fnsku
    LEFT JOIN fx_map fx ON fx.ccy = TRIM(sf.currency_code)
    GROUP BY COALESCE(cw.asin, sf.asin), sf.marketplace_id, sf.charge_month
),
storage_latest AS (
    SELECT DISTINCT ON (marketplace_id, asin) marketplace_id, asin, charge_month, storage_base, aged_surcharge,
        CASE WHEN charge_month >= (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date
             THEN 'per_fnsku' ELSE 'modelled_from_prev_month' END AS storage_source
    FROM storage_monthly WHERE asin IS NOT NULL
    ORDER BY marketplace_id, asin, charge_month DESC
),
st AS (
    SELECT marketplace_id, child_asin AS asin, SUM(units_ordered) AS units_ordered_st
    FROM brain.sales_traffic_daily
    WHERE metric_date >= (SELECT win_start FROM params) AND metric_date < (SELECT win_end FROM params)
    GROUP BY marketplace_id, child_asin
),
-- Duty base: factory-gate FOB (true base), from the latest PO comp_fob (USD->GBP);
-- fallback to cogs_landed flagged as a proxy (it includes UK freight, so it
-- knowingly over-states duty — an upper bound, not exact).
fob AS (
    SELECT DISTINCT ON (sm.asin) sm.asin,
        COALESCE(pol.comp_fob * COALESCE(fxf.rate,1), sm.cogs_landed) AS us_fob_gbp,
        CASE WHEN pol.comp_fob IS NOT NULL THEN 'po_fob' ELSE 'cogs_proxy' END AS fob_source
    FROM brain.sku_master sm
    LEFT JOIN brain.purchase_order_lines pol ON pol.ean = sm.ean AND pol.comp_fob IS NOT NULL
    LEFT JOIN fx_map fxf ON fxf.ccy = TRIM(pol.landed_cost_currency)
    WHERE sm.asin IS NOT NULL
    ORDER BY sm.asin, (pol.comp_fob IS NOT NULL) DESC, pol.updated_at DESC NULLS LAST
),
-- Route: direct China->US (AWD) vs UK->US re-export. Direct-AWD freight is in the
-- PO na landing (not yet wired) -> v1 drops the wrong-route UPS inbound for them.
route AS (
    SELECT DISTINCT sm.asin, TRUE AS is_direct_awd
    FROM brain.sku_master sm
    JOIN brain.purchase_order_lines pol ON pol.ean = sm.ean AND pol.destination = 'usa_awd'
    WHERE sm.asin IS NOT NULL
),
calc AS (
    SELECT
        fe.*, a.brand, a.cogs_landed, a.cogs_currency, a.units_per_case, a.units_per_case_source, a.fnsku_fanout,
        ads.ads_total, ret.nonsellable_units, sl.storage_base, sl.aged_surcharge, sl.storage_source,
        st.units_ordered_st, uv.unit_vol_m3,
        ifr.cost_per_box, ifr.max_box_volume_m3,
        a.us_inbound_per_unit_gbp, a.us_inbound_method,
        -- UK = flat DPD box cost; US inbound is the precomputed per-unit
        -- (us_inbound_per_unit_gbp: UPS-priced from carton/item dims).
        (ifr.cost_per_box * COALESCE(bfx.rate,1)) AS box_cost_gbp,
        COALESCE(cfx.rate,1) AS cogs_rate,
        d.duty_pct, d.duty_source, fb.us_fob_gbp, fb.fob_source,
        COALESCE(rt.is_direct_awd, FALSE) AS is_direct_awd,
        m.country_code, m.country_name
    FROM fe
    LEFT JOIN attrs a       ON a.marketplace_id=fe.marketplace_id AND a.asin=fe.asin
    LEFT JOIN ads           ON ads.marketplace_id=fe.marketplace_id AND ads.asin=fe.asin
    LEFT JOIN ret           ON ret.marketplace_id=fe.marketplace_id AND ret.asin=fe.asin
    LEFT JOIN storage_latest sl ON sl.marketplace_id=fe.marketplace_id AND sl.asin=fe.asin
    LEFT JOIN st            ON st.marketplace_id=fe.marketplace_id AND st.asin=fe.asin
    LEFT JOIN unitvol uv    ON uv.asin=fe.asin
    LEFT JOIN analytics.sku_us_duty d ON d.asin=fe.asin
    LEFT JOIN fob fb        ON fb.asin=fe.asin
    LEFT JOIN route rt      ON rt.asin=fe.asin
    LEFT JOIN meta.marketplace m ON m.marketplace_id=fe.marketplace_id
    LEFT JOIN brain.inbound_freight_rate ifr ON ifr.marketplace_id=fe.marketplace_id
    LEFT JOIN fx_map bfx ON bfx.ccy=TRIM(ifr.currency_code)
    LEFT JOIN fx_map cfx ON cfx.ccy=TRIM(a.cogs_currency)
),
final AS (
    SELECT *,
        (units_settled * cogs_landed * cogs_rate) AS cogs_total_calc,
        -- US import duty = FOB x duty_pct (UK has none). Discrete landed-cost line.
        CASE WHEN marketplace_id = 'ATVPDKIKX0DER' THEN COALESCE(us_fob_gbp,0) * COALESCE(duty_pct,0) ELSE 0 END AS import_duty_per_unit,
        CASE
            -- Direct-AWD US: China->US freight is in the (pending) AWD landing, NOT
            -- UK->US UPS — drop the wrong-route proxy rather than stack it on duty.
            WHEN marketplace_id = 'ATVPDKIKX0DER' AND is_direct_awd THEN 0
            -- US re-export inbound: precomputed per-unit (UPS-priced). UK uses the flat box.
            WHEN marketplace_id = 'ATVPDKIKX0DER' THEN us_inbound_per_unit_gbp
            WHEN units_per_case > 0 THEN box_cost_gbp / units_per_case
            WHEN unit_vol_m3 > 0 AND max_box_volume_m3 > 0 THEN box_cost_gbp / GREATEST(FLOOR(max_box_volume_m3 * 0.75 / unit_vol_m3), 1)
            ELSE NULL
        END AS inbound_per_unit,
        CASE
            WHEN marketplace_id = 'ATVPDKIKX0DER' AND is_direct_awd THEN 'in_landed'
            WHEN marketplace_id = 'ATVPDKIKX0DER' THEN
                 CASE WHEN us_inbound_method IN ('carton','item_x_case') THEN 'case_qty'
                      WHEN us_inbound_method = 'volumetric_item'         THEN 'volumetric_fallback'
                      ELSE 'missing' END
            WHEN units_per_case > 0 THEN 'case_qty'
            WHEN unit_vol_m3 > 0 THEN 'volumetric_fallback'
            ELSE 'missing'
        END AS inbound_source
    FROM calc
)
SELECT
    marketplace_id, country_code, country_name, asin, brand,
    (SELECT win_start FROM params) AS period_start, (SELECT win_end FROM params) AS period_end,
    'GBP'::char(3) AS currency,
    units_settled, units_ordered_st, units_per_case, units_per_case_source,
    ROUND(revenue_ex_vat,2) AS revenue_ex_vat,
    ROUND(COALESCE(cogs_total_calc,0),2) AS cogs_total,
    ROUND(COALESCE(units_settled * inbound_per_unit,0),2) AS inbound_total,
    inbound_source,
    ROUND(COALESCE(units_settled * import_duty_per_unit,0),2) AS import_duty,
    CASE WHEN marketplace_id='ATVPDKIKX0DER' THEN ROUND(COALESCE(duty_pct,0),4) ELSE 0 END AS import_duty_pct,
    CASE WHEN marketplace_id='ATVPDKIKX0DER' THEN COALESCE(duty_source,'default') ELSE 'na' END AS duty_source,
    ROUND(referral_fees,2) AS referral_fees,
    ROUND(fba_fulfilment,2) AS fba_fulfilment,
    ROUND(closing_fees,2) AS closing_fees,
    ROUND(other_amazon_fees,2) AS other_amazon_fees,
    ROUND(promo_total,2) AS promo_total,
    ROUND(COALESCE(ads_total,0),2) AS ads_total,
    ROUND(refund_net,2) AS refund_net,
    ROUND(COALESCE(storage_base,0),2) AS storage_base,
    ROUND(COALESCE(aged_surcharge,0),2) AS aged_surcharge,
    ROUND(COALESCE(nonsellable_units,0)*COALESCE(cogs_landed,0)*cogs_rate,2) AS returns_cogs_clawback,
    ROUND(revenue_ex_vat - COALESCE(cogs_total_calc,0) - COALESCE(units_settled*inbound_per_unit,0) - COALESCE(units_settled*import_duty_per_unit,0),2) AS cm1,
    ROUND(revenue_ex_vat - COALESCE(cogs_total_calc,0) - COALESCE(units_settled*inbound_per_unit,0) - COALESCE(units_settled*import_duty_per_unit,0)
          - referral_fees - fba_fulfilment - closing_fees - other_amazon_fees - promo_total,2) AS cm2,
    ROUND(revenue_ex_vat - COALESCE(cogs_total_calc,0) - COALESCE(units_settled*inbound_per_unit,0) - COALESCE(units_settled*import_duty_per_unit,0)
          - referral_fees - fba_fulfilment - closing_fees - other_amazon_fees - promo_total
          - COALESCE(ads_total,0) + refund_net - COALESCE(storage_base,0) - COALESCE(aged_surcharge,0)
          - COALESCE(nonsellable_units,0)*COALESCE(cogs_landed,0)*cogs_rate,2) AS cm3,
    CASE WHEN revenue_ex_vat > 0 THEN ROUND(100.0*(
          revenue_ex_vat - COALESCE(cogs_total_calc,0) - COALESCE(units_settled*inbound_per_unit,0) - COALESCE(units_settled*import_duty_per_unit,0)
          - referral_fees - fba_fulfilment - closing_fees - other_amazon_fees - promo_total
          - COALESCE(ads_total,0) + refund_net - COALESCE(storage_base,0) - COALESCE(aged_surcharge,0)
          - COALESCE(nonsellable_units,0)*COALESCE(cogs_landed,0)*cogs_rate
        )/revenue_ex_vat,1) END AS cm3_margin_pct,
    COALESCE(storage_source,'missing') AS storage_source,
    fnsku_fanout,
    (CASE WHEN cogs_landed IS NULL THEN 'cogs:missing' ELSE 'cogs:ok' END)
      || ';inbound:' || inbound_source
      || ';duty:' || CASE WHEN marketplace_id='ATVPDKIKX0DER' THEN COALESCE(duty_source,'default') ELSE 'na' END
      || CASE WHEN marketplace_id='ATVPDKIKX0DER' AND is_direct_awd THEN ';freight:awd_pending' ELSE '' END
      || ';storage:' || COALESCE(storage_source,'missing')
      || ';coverage:' || CASE WHEN units_ordered_st > 0 AND units_settled < 0.7 * units_ordered_st THEN 'partial' ELSE 'ok' END
      || ';fx:' || CASE WHEN any_unconverted THEN 'partial' ELSE 'ok' END AS cost_completeness,
    CASE
        WHEN cogs_landed IS NULL OR COALESCE(storage_source,'missing')='missing' OR inbound_source='missing' OR any_unconverted THEN 'low'
        -- Settled-coverage guard: when far fewer units settled than were ORDERED
        -- (sales_traffic), the financial_events window is incomplete, so revenue is
        -- understated and every ratio (esp ads %) is distorted -> not trustworthy.
        WHEN units_ordered_st > 0 AND units_settled < 0.7 * units_ordered_st THEN 'low'
        -- US on the DEFAULT duty rate (no HS code) is an estimate -> never high.
        WHEN inbound_source='case_qty' AND storage_source='per_fnsku'
             AND NOT (marketplace_id='ATVPDKIKX0DER' AND COALESCE(duty_source,'default')='default') THEN 'high'
        ELSE 'medium'
    END AS confidence,
    EXTRACT(EPOCH FROM (NOW() - (SELECT MAX(ingested_at) FROM brain.financial_events)))/3600.0 AS lake_age_hours
FROM final;

COMMENT ON VIEW analytics.product_profitability_30d IS
'Per-(marketplace, asin) CM1/CM2/CM3 over trailing 30d, all in GBP (every line FX-converted via meta.fx_rates before summing - fixes the NA USD/CAD/GBP mix). CM1 nets landed COGS + inbound freight + US import duty. import_duty = FOB x duty_pct (US only, from analytics.sku_us_duty; duty_source hs|default). Direct-AWD US SKUs drop the UK->US UPS inbound (freight:awd_pending). confidence is never high on a default duty rate.';

-- ----------------------------------------------------------------------------
-- analytics.us_tariff_exposure — per-(asin) US import-duty exposure for managing
-- tariff risk: monthly duty £, the rate + source, and a +10pp what-if.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.us_tariff_exposure AS
SELECT p.asin, p.brand, p.units_settled, p.revenue_ex_vat,
    p.import_duty AS import_duty_gbp_30d, p.import_duty_pct, p.duty_source,
    d.hs_code_us,
    ROUND(p.import_duty * (p.import_duty_pct + 0.10) / NULLIF(p.import_duty_pct,0), 2) AS import_duty_at_plus_10pp,
    p.cm3, p.cm3_margin_pct
FROM analytics.product_profitability_30d p
LEFT JOIN analytics.sku_us_duty d ON d.asin = p.asin
WHERE p.marketplace_id = 'ATVPDKIKX0DER' AND p.revenue_ex_vat > 0
ORDER BY p.import_duty DESC;

COMMENT ON VIEW analytics.us_tariff_exposure IS
'Per-ASIN US import-duty exposure (trailing 30d): duty £, rate, source (hs|default), HS code, a +10pp what-if, and resulting CM3. For managing tariff risk as US rates move and for prioritising HS-code fill (duty_source=default).';

-- ----------------------------------------------------------------------------
-- analytics.product_profitability_reconciliation — GBP rework.
-- 0033's version summed financial_events / settlement_lines in native currency,
-- so the NA USD/CAD/GBP mix inflated US variance into noise. Convert both sides
-- to GBP via meta.fx_rates so the variance is meaningful (and the QA job's
-- variance flag stops false-firing on every US SKU).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.product_profitability_reconciliation AS
WITH win AS (SELECT (CURRENT_DATE - INTERVAL '90 days')::date AS s, CURRENT_DATE AS e),
fx_map AS (
    SELECT 'GBP'::text AS ccy, 1.0::numeric AS rate
    UNION ALL
    SELECT base_currency, rate FROM (
        SELECT DISTINCT ON (base_currency) base_currency, rate
        FROM meta.fx_rates WHERE quote_currency='GBP' AND rate_date <= CURRENT_DATE
        ORDER BY base_currency, rate_date DESC
    ) l
),
sku_asin AS (SELECT DISTINCT marketplace_id, seller_sku, asin FROM analytics.product_cost_crosswalk),
computed AS (
    SELECT cw.marketplace_id, cw.asin,
           SUM((CASE WHEN f.direction='credit' THEN f.amount ELSE -f.amount END) * COALESCE(fx.rate,1)) AS computed_net
    FROM brain.financial_events f
    JOIN sku_asin cw ON cw.marketplace_id=f.marketplace_id AND cw.seller_sku=f.sku
    LEFT JOIN fx_map fx ON fx.ccy = TRIM(f.currency_code)
    WHERE f.event_type IN ('ShipmentEvent','RefundEvent','AdjustmentEvent')
      AND f.posted_date >= (SELECT s FROM win) AND f.posted_date < (SELECT e FROM win)
    GROUP BY cw.marketplace_id, cw.asin
),
settled AS (
    SELECT s.marketplace_id, cw.asin, SUM(sl.amount * COALESCE(fx.rate,1)) AS settled_net
    FROM brain.settlement_lines sl
    JOIN brain.settlements s ON s.settlement_id = sl.settlement_id
    JOIN sku_asin cw ON cw.marketplace_id=s.marketplace_id AND cw.seller_sku=sl.sku
    LEFT JOIN fx_map fx ON fx.ccy = TRIM(sl.currency_code)
    WHERE sl.sku IS NOT NULL
      AND sl.posted_date >= (SELECT s FROM win) AND sl.posted_date < (SELECT e FROM win)
    GROUP BY s.marketplace_id, cw.asin
),
unmatched AS (
    SELECT s.marketplace_id, SUM(sl.amount * COALESCE(fx.rate,1)) AS unmatched_settlement_amount
    FROM brain.settlement_lines sl
    JOIN brain.settlements s ON s.settlement_id = sl.settlement_id
    LEFT JOIN fx_map fx ON fx.ccy = TRIM(sl.currency_code)
    WHERE sl.sku IS NULL
      AND sl.posted_date >= (SELECT s FROM win) AND sl.posted_date < (SELECT e FROM win)
    GROUP BY s.marketplace_id
)
SELECT
    COALESCE(c.marketplace_id, se.marketplace_id) AS marketplace_id,
    COALESCE(c.asin, se.asin)                     AS asin,
    (SELECT s FROM win) AS period_start, (SELECT e FROM win) AS period_end,
    ROUND(COALESCE(c.computed_net,0),2)           AS computed_net,
    ROUND(COALESCE(se.settled_net,0),2)           AS settled_net,
    ROUND(COALESCE(se.settled_net,0) - COALESCE(c.computed_net,0),2) AS variance_abs,
    CASE WHEN COALESCE(se.settled_net,0) <> 0
         THEN ROUND(100.0*(COALESCE(se.settled_net,0)-COALESCE(c.computed_net,0))/ABS(se.settled_net),1) END AS variance_pct,
    ROUND(COALESCE(u.unmatched_settlement_amount,0),2) AS unmatched_settlement_amount
FROM computed c
FULL OUTER JOIN settled se USING (marketplace_id, asin)
LEFT JOIN unmatched u ON u.marketplace_id = COALESCE(c.marketplace_id, se.marketplace_id);

COMMENT ON VIEW analytics.product_profitability_reconciliation IS
'Drift detector: computed net (financial_events, product-attributable) vs settled net (settlement_lines by sku) per (marketplace, asin) over trailing 90d, both converted to GBP via meta.fx_rates (fixes the NA currency mix). Non-product/no-sku settlement lines are excluded from the per-ASIN comparison and shown as unmatched_settlement_amount. Approximate (posted vs settled timing differs) - a coarse alarm, not a ledger.';

INSERT INTO meta.migration_history (filename)
VALUES ('0034_inbound_freight_and_gbp_cm.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
