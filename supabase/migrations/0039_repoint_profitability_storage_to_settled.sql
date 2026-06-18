-- ============================================================================
-- 0039_repoint_profitability_storage_to_settled.sql
-- Repoint analytics.product_profitability_30d storage to SETTLED-ALLOCATED.
--
-- Why: the storage_base in this view came from brain.fba_storage_fees, which on
-- this account captures only ~3% of real inventory (see 0038 header). Result:
-- CM3 understated storage ~60x and overstated portfolio margin by ~GBP 17k-equiv
-- per month; 54 SKUs that read profitable are actually loss-making once real
-- storage loads. This migration sources storage_base from
-- analytics.storage_settled_by_asin (settlement total allocated per-ASIN by
-- physical volume share), which reconciles to the bank by construction.
--
-- What changes vs the prior definition (0033 -> 0034 -> 0036):
--   * storage_monthly CTE now reads analytics.storage_settled_by_asin instead of
--     brain.fba_storage_fees. The allocated figure is native currency, so it is
--     FX-converted to GBP here exactly as before.
--   * storage_source label 'per_fnsku' -> 'account_allocated' (a value /sku-audit
--     and /wbr already understand; it degrades confidence to 'medium' rather than
--     claiming per-FNSKU precision, and is NOT 'missing' so scoring is allowed).
--   * aged_surcharge is held at 0 here. The old source carried no aged rows
--     either (it was a false 0), so this is no regression. Per-SKU aged is added
--     once GET_FBA_INVENTORY_AGED_DATA is ingested (later migration), allocated
--     by aged-unit share inside storage_settled_by_asin.
--   * unitvol CTE (US volumetric inbound fallback) is intentionally left reading
--     brain.fba_storage_fees: it uses item VOLUME, not the unreliable fee, and is
--     only a last-resort inbound proxy. Out of scope here.
--
-- Everything else (revenue/fees/ads/returns/duty/inbound/CM ladder/confidence)
-- is byte-identical to the prior live definition.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW analytics.product_profitability_30d AS
 WITH params AS (
         SELECT (CURRENT_DATE - '30 days'::interval)::date AS win_start,
            CURRENT_DATE AS win_end,
            'GBP'::character(3) AS reporting_ccy
        ), fx_map AS (
         SELECT 'GBP'::text AS ccy,
            1.0 AS rate
        UNION ALL
         SELECT l.base_currency,
            l.rate
           FROM ( SELECT DISTINCT ON (fx_rates.base_currency) fx_rates.base_currency,
                    fx_rates.rate
                   FROM meta.fx_rates
                  WHERE fx_rates.quote_currency = 'GBP'::bpchar AND fx_rates.rate_date <= CURRENT_DATE
                  ORDER BY fx_rates.base_currency, fx_rates.rate_date DESC) l
        ), sku_asin AS (
         SELECT DISTINCT product_cost_crosswalk.marketplace_id,
            product_cost_crosswalk.seller_sku,
            product_cost_crosswalk.asin
           FROM analytics.product_cost_crosswalk
        ), attrs AS (
         SELECT product_cost_crosswalk.marketplace_id,
            product_cost_crosswalk.asin,
            max(product_cost_crosswalk.cogs_landed) AS cogs_landed,
            max(product_cost_crosswalk.cogs_currency) AS cogs_currency,
            max(product_cost_crosswalk.brand) AS brand,
            max(product_cost_crosswalk.units_per_case) AS units_per_case,
            max(product_cost_crosswalk.units_per_case_source) AS units_per_case_source,
            max(product_cost_crosswalk.us_inbound_box_cost_gbp) AS us_inbound_box_cost_gbp,
            max(product_cost_crosswalk.us_inbound_per_unit_gbp) AS us_inbound_per_unit_gbp,
            max(product_cost_crosswalk.us_inbound_method) AS us_inbound_method,
            bool_or(product_cost_crosswalk.fnsku_fanout) AS fnsku_fanout
           FROM analytics.product_cost_crosswalk
          GROUP BY product_cost_crosswalk.marketplace_id, product_cost_crosswalk.asin
        ), unitvol AS (
         SELECT COALESCE(cw.asin, sf.asin) AS asin,
            sum(sf.storage_volume *
                CASE
                    WHEN sf.marketplace_id = ANY (ARRAY['ATVPDKIKX0DER'::text, 'A2EUQ1WTGCTBG2'::text, 'A1AM78C64UM0Y8'::text]) THEN 0.0283168
                    ELSE 1::numeric
                END) / NULLIF(sum(sf.average_quantity_on_hand), 0::numeric) AS unit_vol_m3
           FROM brain.fba_storage_fees sf
             LEFT JOIN ( SELECT DISTINCT product_cost_crosswalk.marketplace_id,
                    product_cost_crosswalk.fnsku,
                    product_cost_crosswalk.asin
                   FROM analytics.product_cost_crosswalk) cw ON cw.marketplace_id = sf.marketplace_id AND cw.fnsku = sf.fnsku
          WHERE sf.fee_type = 'monthly_storage'::text AND sf.average_quantity_on_hand > 0::numeric AND sf.storage_volume > 0::numeric
          GROUP BY (COALESCE(cw.asin, sf.asin))
        ), fe AS (
         SELECT cw.marketplace_id,
            cw.asin,
            count(*) FILTER (WHERE f.event_type = 'ShipmentEvent'::text AND f.fee_description = 'Principal'::text) AS units_settled,
            COALESCE(sum(f.amount * fx.rate) FILTER (WHERE f.event_type = 'ShipmentEvent'::text AND (f.fee_description = ANY (ARRAY['Principal'::text, 'ShippingCharge'::text]))), 0::numeric) AS revenue_ex_vat,
            COALESCE(sum(f.amount * fx.rate) FILTER (WHERE f.event_type = 'ShipmentEvent'::text AND f.fee_description = 'Commission'::text), 0::numeric) AS referral_fees,
            COALESCE(sum(f.amount * fx.rate) FILTER (WHERE f.event_type = 'ShipmentEvent'::text AND f.fee_description = 'FBAPerUnitFulfillmentFee'::text), 0::numeric) AS fba_fulfilment,
            COALESCE(sum(f.amount * fx.rate) FILTER (WHERE f.event_type = 'ShipmentEvent'::text AND f.fee_description ~~* '%ClosingFee%'::text), 0::numeric) AS closing_fees,
            COALESCE(sum(f.amount * fx.rate) FILTER (WHERE f.event_type = 'ShipmentEvent'::text AND (f.fee_description = ANY (ARRAY['DigitalServicesFee'::text, 'DigitalServicesFeeFBA'::text, 'ShippingChargeback'::text]))), 0::numeric) AS other_amazon_fees,
            COALESCE(sum(f.amount * fx.rate) FILTER (WHERE f.event_type = 'ShipmentEvent'::text AND f.fee_description = 'PromotionMetaDataDefinitionValue'::text), 0::numeric) AS promo_total,
            COALESCE(sum(
                CASE
                    WHEN f.direction = 'credit'::text THEN f.amount
                    ELSE - f.amount
                END * fx.rate) FILTER (WHERE f.event_type = 'RefundEvent'::text AND (f.fee_description <> ALL (ARRAY['Tax'::text, 'ShippingTax'::text]))), 0::numeric) AS refund_net,
            bool_or(fx.rate IS NULL) AS any_unconverted
           FROM brain.financial_events f
             JOIN sku_asin cw ON cw.marketplace_id = f.marketplace_id AND cw.seller_sku = f.sku
             LEFT JOIN fx_map fx ON fx.ccy = TRIM(BOTH FROM f.currency_code)
          WHERE (f.event_type = ANY (ARRAY['ShipmentEvent'::text, 'RefundEvent'::text])) AND f.posted_date >= (( SELECT params.win_start
                   FROM params)) AND f.posted_date < (( SELECT params.win_end
                   FROM params))
          GROUP BY cw.marketplace_id, cw.asin
        ), ads AS (
         SELECT a.marketplace_id,
            a.child_asin AS asin,
            COALESCE(sum(a.total_cost * fx.rate), 0::numeric) AS ads_total
           FROM analytics.ads_per_asin_daily a
             LEFT JOIN fx_map fx ON fx.ccy = TRIM(BOTH FROM a.currency_code)
          WHERE a.metric_date >= (( SELECT params.win_start
                   FROM params)) AND a.metric_date < (( SELECT params.win_end
                   FROM params))
          GROUP BY a.marketplace_id, a.child_asin
        ), ret AS (
         SELECT cw.marketplace_id,
            COALESCE(cw.asin, r.asin) AS asin,
            sum(r.quantity) FILTER (WHERE r.detailed_disposition !~* 'sellable'::text) AS nonsellable_units
           FROM brain.fba_returns r
             LEFT JOIN ( SELECT DISTINCT product_cost_crosswalk.marketplace_id,
                    product_cost_crosswalk.fnsku,
                    product_cost_crosswalk.asin
                   FROM analytics.product_cost_crosswalk) cw ON cw.fnsku = r.fnsku
          WHERE r.return_date >= (( SELECT params.win_start
                   FROM params)) AND r.return_date < (( SELECT params.win_end
                   FROM params)) AND cw.marketplace_id IS NOT NULL AND COALESCE(cw.asin, r.asin) IS NOT NULL
          GROUP BY cw.marketplace_id, (COALESCE(cw.asin, r.asin))
        ), storage_monthly AS (
         -- REPOINTED (0039): settled-allocated storage from analytics.storage_settled_by_asin
         -- (settlement total distributed per-ASIN by physical volume share; reconciles to the
         -- bank by construction). Native currency -> GBP via fx_map, exactly as the old source.
         SELECT s.asin,
            s.marketplace_id,
            s.charge_month,
            COALESCE(s.storage_base_allocated * fx.rate, 0::numeric) AS storage_base,
            0::numeric AS aged_surcharge
           FROM analytics.storage_settled_by_asin s
             LEFT JOIN fx_map fx ON fx.ccy = TRIM(BOTH FROM s.currency_code)
        ), storage_latest AS (
         SELECT DISTINCT ON (storage_monthly.marketplace_id, storage_monthly.asin) storage_monthly.marketplace_id,
            storage_monthly.asin,
            storage_monthly.charge_month,
            storage_monthly.storage_base,
            storage_monthly.aged_surcharge,
                CASE
                    WHEN storage_monthly.charge_month >= (date_trunc('month'::text, CURRENT_DATE::timestamp with time zone) - '1 mon'::interval)::date THEN 'account_allocated'::text
                    ELSE 'modelled_from_prev_month'::text
                END AS storage_source
           FROM storage_monthly
          WHERE storage_monthly.asin IS NOT NULL
          ORDER BY storage_monthly.marketplace_id, storage_monthly.asin, storage_monthly.charge_month DESC
        ), st AS (
         SELECT sales_traffic_daily.marketplace_id,
            sales_traffic_daily.child_asin AS asin,
            sum(sales_traffic_daily.units_ordered) AS units_ordered_st
           FROM brain.sales_traffic_daily
          WHERE sales_traffic_daily.metric_date >= (( SELECT params.win_start
                   FROM params)) AND sales_traffic_daily.metric_date < (( SELECT params.win_end
                   FROM params))
          GROUP BY sales_traffic_daily.marketplace_id, sales_traffic_daily.child_asin
        ), fob AS (
         SELECT DISTINCT ON (sm.asin) sm.asin,
            COALESCE(pol.comp_fob * COALESCE(fxf.rate, 1::numeric), sm.cogs_landed) AS us_fob_gbp,
                CASE
                    WHEN pol.comp_fob IS NOT NULL THEN 'po_fob'::text
                    ELSE 'cogs_proxy'::text
                END AS fob_source
           FROM brain.sku_master sm
             LEFT JOIN brain.purchase_order_lines pol ON pol.ean = sm.ean AND pol.comp_fob IS NOT NULL
             LEFT JOIN fx_map fxf ON fxf.ccy = TRIM(BOTH FROM pol.landed_cost_currency)
          WHERE sm.asin IS NOT NULL
          ORDER BY sm.asin, (pol.comp_fob IS NOT NULL) DESC, pol.updated_at DESC NULLS LAST
        ), route AS (
         SELECT DISTINCT sm.asin,
            true AS is_direct_awd
           FROM brain.sku_master sm
             JOIN brain.purchase_order_lines pol ON pol.ean = sm.ean AND pol.destination = 'usa_awd'::text
          WHERE sm.asin IS NOT NULL
        ), calc AS (
         SELECT fe.marketplace_id,
            fe.asin,
            fe.units_settled,
            fe.revenue_ex_vat,
            fe.referral_fees,
            fe.fba_fulfilment,
            fe.closing_fees,
            fe.other_amazon_fees,
            fe.promo_total,
            fe.refund_net,
            fe.any_unconverted,
            a.brand,
            a.cogs_landed,
            a.cogs_currency,
            a.units_per_case,
            a.units_per_case_source,
            a.fnsku_fanout,
            ads.ads_total,
            ret.nonsellable_units,
            sl.storage_base,
            sl.aged_surcharge,
            sl.storage_source,
            st.units_ordered_st,
            uv.unit_vol_m3,
            ifr.cost_per_box,
            ifr.max_box_volume_m3,
            a.us_inbound_per_unit_gbp,
            a.us_inbound_method,
            ifr.cost_per_box * COALESCE(bfx.rate, 1::numeric) AS box_cost_gbp,
            COALESCE(cfx.rate, 1::numeric) AS cogs_rate,
            d.duty_pct,
            d.duty_per_unit_gbp,
            d.duty_source,
            fb.us_fob_gbp,
            fb.fob_source,
            COALESCE(rt.is_direct_awd, false) AS is_direct_awd,
            m.country_code,
            m.country_name
           FROM fe
             LEFT JOIN attrs a ON a.marketplace_id = fe.marketplace_id AND a.asin = fe.asin
             LEFT JOIN ads ON ads.marketplace_id = fe.marketplace_id AND ads.asin = fe.asin
             LEFT JOIN ret ON ret.marketplace_id = fe.marketplace_id AND ret.asin = fe.asin
             LEFT JOIN storage_latest sl ON sl.marketplace_id = fe.marketplace_id AND sl.asin = fe.asin
             LEFT JOIN st ON st.marketplace_id = fe.marketplace_id AND st.asin = fe.asin
             LEFT JOIN unitvol uv ON uv.asin = fe.asin
             LEFT JOIN analytics.sku_us_duty d ON d.asin = fe.asin
             LEFT JOIN fob fb ON fb.asin = fe.asin
             LEFT JOIN route rt ON rt.asin = fe.asin
             LEFT JOIN meta.marketplace m ON m.marketplace_id = fe.marketplace_id
             LEFT JOIN brain.inbound_freight_rate ifr ON ifr.marketplace_id = fe.marketplace_id
             LEFT JOIN fx_map bfx ON bfx.ccy = TRIM(BOTH FROM ifr.currency_code)
             LEFT JOIN fx_map cfx ON cfx.ccy = TRIM(BOTH FROM a.cogs_currency)
        ), final AS (
         SELECT calc.marketplace_id,
            calc.asin,
            calc.units_settled,
            calc.revenue_ex_vat,
            calc.referral_fees,
            calc.fba_fulfilment,
            calc.closing_fees,
            calc.other_amazon_fees,
            calc.promo_total,
            calc.refund_net,
            calc.any_unconverted,
            calc.brand,
            calc.cogs_landed,
            calc.cogs_currency,
            calc.units_per_case,
            calc.units_per_case_source,
            calc.fnsku_fanout,
            calc.ads_total,
            calc.nonsellable_units,
            calc.storage_base,
            calc.aged_surcharge,
            calc.storage_source,
            calc.units_ordered_st,
            calc.unit_vol_m3,
            calc.cost_per_box,
            calc.max_box_volume_m3,
            calc.us_inbound_per_unit_gbp,
            calc.us_inbound_method,
            calc.box_cost_gbp,
            calc.cogs_rate,
            calc.duty_pct,
            calc.duty_per_unit_gbp,
            calc.duty_source,
            calc.us_fob_gbp,
            calc.fob_source,
            calc.is_direct_awd,
            calc.country_code,
            calc.country_name,
            calc.units_settled::numeric * calc.cogs_landed * calc.cogs_rate AS cogs_total_calc,
                CASE
                    WHEN calc.marketplace_id = 'ATVPDKIKX0DER'::text THEN COALESCE(calc.duty_per_unit_gbp, 0::numeric)
                    ELSE 0::numeric
                END AS import_duty_per_unit,
                CASE
                    WHEN calc.marketplace_id = 'ATVPDKIKX0DER'::text AND calc.is_direct_awd THEN 0::numeric
                    WHEN calc.marketplace_id = 'ATVPDKIKX0DER'::text THEN calc.us_inbound_per_unit_gbp
                    WHEN calc.units_per_case > 0 THEN calc.box_cost_gbp / calc.units_per_case::numeric
                    WHEN calc.unit_vol_m3 > 0::numeric AND calc.max_box_volume_m3 > 0::numeric THEN calc.box_cost_gbp / GREATEST(floor(calc.max_box_volume_m3 * 0.75 / calc.unit_vol_m3), 1::numeric)
                    ELSE NULL::numeric
                END AS inbound_per_unit,
                CASE
                    WHEN calc.marketplace_id = 'ATVPDKIKX0DER'::text AND calc.is_direct_awd THEN 'in_landed'::text
                    WHEN calc.marketplace_id = 'ATVPDKIKX0DER'::text THEN
                    CASE
                        WHEN calc.us_inbound_method = ANY (ARRAY['carton'::text, 'item_x_case'::text]) THEN 'case_qty'::text
                        WHEN calc.us_inbound_method = 'volumetric_item'::text THEN 'volumetric_fallback'::text
                        ELSE 'missing'::text
                    END
                    WHEN calc.units_per_case > 0 THEN 'case_qty'::text
                    WHEN calc.unit_vol_m3 > 0::numeric THEN 'volumetric_fallback'::text
                    ELSE 'missing'::text
                END AS inbound_source
           FROM calc
        )
 SELECT marketplace_id,
    country_code,
    country_name,
    asin,
    brand,
    ( SELECT params.win_start
           FROM params) AS period_start,
    ( SELECT params.win_end
           FROM params) AS period_end,
    'GBP'::character(3) AS currency,
    units_settled,
    units_ordered_st,
    units_per_case,
    units_per_case_source,
    round(revenue_ex_vat, 2) AS revenue_ex_vat,
    round(COALESCE(cogs_total_calc, 0::numeric), 2) AS cogs_total,
    round(COALESCE(units_settled::numeric * inbound_per_unit, 0::numeric), 2) AS inbound_total,
    inbound_source,
    round(COALESCE(units_settled::numeric * import_duty_per_unit, 0::numeric), 2) AS import_duty,
        CASE
            WHEN marketplace_id = 'ATVPDKIKX0DER'::text THEN round(COALESCE(duty_pct, 0::numeric), 4)
            ELSE 0::numeric
        END AS import_duty_pct,
        CASE
            WHEN marketplace_id = 'ATVPDKIKX0DER'::text THEN COALESCE(duty_source, 'default'::text)
            ELSE 'na'::text
        END AS duty_source,
    round(referral_fees, 2) AS referral_fees,
    round(fba_fulfilment, 2) AS fba_fulfilment,
    round(closing_fees, 2) AS closing_fees,
    round(other_amazon_fees, 2) AS other_amazon_fees,
    round(promo_total, 2) AS promo_total,
    round(COALESCE(ads_total, 0::numeric), 2) AS ads_total,
    round(refund_net, 2) AS refund_net,
    round(COALESCE(storage_base, 0::numeric), 2) AS storage_base,
    round(COALESCE(aged_surcharge, 0::numeric), 2) AS aged_surcharge,
    round(COALESCE(nonsellable_units, 0::bigint)::numeric * COALESCE(cogs_landed, 0::numeric) * cogs_rate, 2) AS returns_cogs_clawback,
    round(revenue_ex_vat - COALESCE(cogs_total_calc, 0::numeric) - COALESCE(units_settled::numeric * inbound_per_unit, 0::numeric) - COALESCE(units_settled::numeric * import_duty_per_unit, 0::numeric), 2) AS cm1,
    round(revenue_ex_vat - COALESCE(cogs_total_calc, 0::numeric) - COALESCE(units_settled::numeric * inbound_per_unit, 0::numeric) - COALESCE(units_settled::numeric * import_duty_per_unit, 0::numeric) - referral_fees - fba_fulfilment - closing_fees - other_amazon_fees - promo_total, 2) AS cm2,
    round(revenue_ex_vat - COALESCE(cogs_total_calc, 0::numeric) - COALESCE(units_settled::numeric * inbound_per_unit, 0::numeric) - COALESCE(units_settled::numeric * import_duty_per_unit, 0::numeric) - referral_fees - fba_fulfilment - closing_fees - other_amazon_fees - promo_total - COALESCE(ads_total, 0::numeric) + refund_net - COALESCE(storage_base, 0::numeric) - COALESCE(aged_surcharge, 0::numeric) - COALESCE(nonsellable_units, 0::bigint)::numeric * COALESCE(cogs_landed, 0::numeric) * cogs_rate, 2) AS cm3,
        CASE
            WHEN revenue_ex_vat > 0::numeric THEN round(100.0 * (revenue_ex_vat - COALESCE(cogs_total_calc, 0::numeric) - COALESCE(units_settled::numeric * inbound_per_unit, 0::numeric) - COALESCE(units_settled::numeric * import_duty_per_unit, 0::numeric) - referral_fees - fba_fulfilment - closing_fees - other_amazon_fees - promo_total - COALESCE(ads_total, 0::numeric) + refund_net - COALESCE(storage_base, 0::numeric) - COALESCE(aged_surcharge, 0::numeric) - COALESCE(nonsellable_units, 0::bigint)::numeric * COALESCE(cogs_landed, 0::numeric) * cogs_rate) / revenue_ex_vat, 1)
            ELSE NULL::numeric
        END AS cm3_margin_pct,
    COALESCE(storage_source, 'missing'::text) AS storage_source,
    fnsku_fanout,
    ((((((((((
        CASE
            WHEN cogs_landed IS NULL THEN 'cogs:missing'::text
            ELSE 'cogs:ok'::text
        END || ';inbound:'::text) || inbound_source) || ';duty:'::text) ||
        CASE
            WHEN marketplace_id = 'ATVPDKIKX0DER'::text THEN COALESCE(duty_source, 'default'::text)
            ELSE 'na'::text
        END) ||
        CASE
            WHEN marketplace_id = 'ATVPDKIKX0DER'::text AND is_direct_awd THEN ';freight:awd_pending'::text
            ELSE ''::text
        END) || ';storage:'::text) || COALESCE(storage_source, 'missing'::text)) || ';coverage:'::text) ||
        CASE
            WHEN units_ordered_st > 0 AND units_settled::numeric < (0.7 * units_ordered_st::numeric) THEN 'partial'::text
            ELSE 'ok'::text
        END) || ';fx:'::text) ||
        CASE
            WHEN any_unconverted THEN 'partial'::text
            ELSE 'ok'::text
        END AS cost_completeness,
        CASE
            WHEN cogs_landed IS NULL OR COALESCE(storage_source, 'missing'::text) = 'missing'::text OR inbound_source = 'missing'::text OR any_unconverted THEN 'low'::text
            WHEN units_ordered_st > 0 AND units_settled::numeric < (0.7 * units_ordered_st::numeric) THEN 'low'::text
            WHEN inbound_source = 'case_qty'::text AND storage_source = 'per_fnsku'::text AND NOT (marketplace_id = 'ATVPDKIKX0DER'::text AND COALESCE(duty_source, 'default'::text) = 'default'::text) THEN 'high'::text
            ELSE 'medium'::text
        END AS confidence,
    EXTRACT(epoch FROM now() - (( SELECT max(financial_events.ingested_at) AS max
           FROM brain.financial_events))) / 3600.0 AS lake_age_hours
   FROM final;

COMMIT;
