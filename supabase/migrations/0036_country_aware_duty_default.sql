-- ============================================================================
-- 0036_country_aware_duty_default.sql
-- Make the no-HS duty fallback country-aware. Before: any unclassified US SKU
-- fell to the China '*' default (~60%), over-charging known non-China goods
-- (e.g. Dayes-UK crumpet rings billed 60% when UK-origin pays only the base
-- rate). After: when there is no HS match but origin is KNOWN and NON-China,
-- default to a low base placeholder; China and UNKNOWN origin stay at the
-- conservative '*' default. duty_source remains 'default' (flagged, confidence
-- capped) until a real HS code lands via the UPS catalogue.
--
-- non_cn_default_pct (0.05) is a deliberately modest base-rate placeholder for
-- non-China origin without a classified HS code; it is an estimate, not exact.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW analytics.sku_us_duty_costed AS
WITH cls AS (
    SELECT DISTINCT ON (sm.asin) sm.asin, sm.ean, sm.hs_code_us, sm.country_of_origin,
           sm.customs_value_usd, sm.cogs_landed
    FROM brain.sku_master sm WHERE sm.asin IS NOT NULL
    ORDER BY sm.asin, (sm.hs_code_us IS NOT NULL) DESC, sm.ean
),
fx AS (
    SELECT rate FROM meta.fx_rates
    WHERE base_currency='USD' AND quote_currency=(SELECT upper(reporting_currency) FROM meta.config LIMIT 1)
    ORDER BY rate_date DESC LIMIT 1
),
dflt AS (SELECT total_pct FROM brain.us_import_duty_rate WHERE hs_code='*' ORDER BY effective_from DESC LIMIT 1),
layered AS (
    SELECT asin, SUM(remaining_units) AS ru, SUM(remaining_units*duty_per_unit_gbp) AS rd
    FROM analytics.sku_us_duty_layer_open GROUP BY asin
),
resolved AS (
    SELECT c.*,
        analytics.fn_us_duty_rate(c.hs_code_us, c.country_of_origin, CURRENT_DATE) AS hs_rate,
        -- no-HS fallback: known non-China origin -> low base placeholder; China /
        -- unknown -> the conservative '*' default.
        CASE WHEN c.country_of_origin IS NOT NULL AND c.country_of_origin <> 'CN'
             THEN 0.05 ELSE COALESCE((SELECT total_pct FROM dflt), 0.602) END AS fallback_pct,
        COALESCE(c.customs_value_usd * COALESCE((SELECT rate FROM fx),1), c.cogs_landed) AS duty_base_gbp
    FROM cls c
)
SELECT r.asin, r.ean, r.hs_code_us, r.country_of_origin, r.hs_rate,
    COALESCE(r.hs_rate, r.fallback_pct) AS duty_pct,
    r.duty_base_gbp,
    CASE WHEN l.ru > 0 THEN l.rd / l.ru
         ELSE COALESCE(r.hs_rate, r.fallback_pct) * r.duty_base_gbp END AS duty_per_unit_gbp,
    CASE WHEN l.ru > 0 THEN 'layered'
         WHEN r.hs_rate IS NOT NULL THEN 'estimated'
         ELSE 'default' END AS duty_source
FROM resolved r LEFT JOIN layered l ON l.asin = r.asin;

COMMENT ON VIEW analytics.sku_us_duty_costed IS
'Per-ASIN US duty/unit (GBP). Weighted moving average over open import layers when present; else current country-aware rate (fn_us_duty_rate) x customs value; else a country-aware default (known non-China origin -> low base placeholder; China/unknown -> the brain.us_import_duty_rate ''*'' default). duty_source: layered | estimated | default.';

INSERT INTO meta.migration_history (filename)
VALUES ('0036_country_aware_duty_default.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
