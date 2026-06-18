-- ============================================================================
-- 0041_analytics_storage_reconciliation.sql
-- Monthly QC gate: settled storage (truth) vs per-ASIN allocation.
--
-- analytics.storage_settled_by_asin distributes the settled BASE storage total
-- per-ASIN, so for the home-currency rows it reconciles to settlement by
-- construction (variance ~ 0). The point of this view is therefore to catch what
-- that guarantee does NOT cover:
--   * settlement storage in marketplaces/currencies we did NOT map (e.g. stray
--     CAD/EUR-on-US rows) -> surfaced as unallocated rows so nothing is silently
--     dropped;
--   * the aged/long-term surcharge total (settled_aged) that is not yet allocated
--     per-ASIN (pending the FBA inventory-age ingest) -> visible here;
--   * AWD storage (STARStorageFee / AmazonUpstreamStorageTransportationFee),
--     reported separately because it is a different warehouse, not FBA storage.
--
-- /storage-review reads this for its confidence header: a 'warn'/'fail' band or a
-- material unallocated/aged figure means suppress absolute CM3 / liquidation
-- costing for that month (mirrors the /sku-audit refuse-to-score guardrail).
--
-- charge_month = date_trunc('month', posted_date) - 1 month (storage for month M
-- settles in M+1), matching analytics.storage_settled_by_asin.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW analytics.storage_reconciliation AS
WITH fe_storage AS (
    SELECT
        marketplace_id,
        currency_code,
        (date_trunc('month', posted_date) - INTERVAL '1 month')::date AS charge_month,
        SUM(amount) FILTER (WHERE event_subtype = 'FBAStorageFee'        AND fee_description = 'FBAStorageFee')        AS settled_base,
        SUM(amount) FILTER (WHERE event_subtype = 'FBALongTermStorageFee' AND fee_description = 'FBALongTermStorageFee') AS settled_aged,
        SUM(amount) FILTER (WHERE event_subtype IN ('STARStorageFee', 'AmazonUpstreamStorageTransportationFee'))        AS awd_storage
    FROM brain.financial_events
    WHERE event_subtype IN ('FBAStorageFee', 'FBALongTermStorageFee',
                            'STARStorageFee', 'AmazonUpstreamStorageTransportationFee')
    GROUP BY marketplace_id, currency_code,
             (date_trunc('month', posted_date) - INTERVAL '1 month')::date
),
alloc AS (
    SELECT marketplace_id, currency_code, charge_month,
           SUM(storage_base_allocated) AS allocated_base
    FROM analytics.storage_settled_by_asin
    GROUP BY marketplace_id, currency_code, charge_month
)
SELECT
    f.marketplace_id,
    f.charge_month,
    f.currency_code,
    ROUND(COALESCE(f.settled_base, 0)::numeric, 2)               AS settled_base,
    ROUND(COALESCE(f.settled_aged, 0)::numeric, 2)               AS settled_aged,
    ROUND(COALESCE(a.allocated_base, 0)::numeric, 2)             AS allocated_base,
    ROUND((COALESCE(a.allocated_base, 0) - COALESCE(f.settled_base, 0))::numeric, 2) AS base_variance_abs,
    CASE WHEN COALESCE(f.settled_base, 0) <> 0
         THEN ROUND((100.0 * (COALESCE(a.allocated_base, 0) - f.settled_base) / f.settled_base)::numeric, 2)
    END                                                          AS base_variance_pct,
    ROUND(COALESCE(f.awd_storage, 0)::numeric, 2)                AS awd_storage,
    (COALESCE(f.settled_base, 0) <> 0 AND a.allocated_base IS NULL) AS base_unallocated,
    CASE
        WHEN COALESCE(f.settled_base, 0) = 0                                       THEN 'no_settlement'
        WHEN a.allocated_base IS NULL                                             THEN 'unallocated'
        WHEN ABS(COALESCE(a.allocated_base, 0) - f.settled_base) <= 0.05 * f.settled_base THEN 'pass'
        WHEN ABS(COALESCE(a.allocated_base, 0) - f.settled_base) <= 0.15 * f.settled_base THEN 'warn'
        ELSE 'fail'
    END                                                          AS confidence
FROM fe_storage f
LEFT JOIN alloc a
       ON a.marketplace_id = f.marketplace_id
      AND a.currency_code  = f.currency_code
      AND a.charge_month   = f.charge_month;

COMMENT ON VIEW analytics.storage_reconciliation IS
'Monthly QC: settled storage (brain.financial_events, camelCase path) vs analytics.storage_settled_by_asin allocation, per (marketplace, charge_month, currency). Home-currency rows reconcile by construction; this surfaces unallocated stray-currency storage, the not-yet-allocated aged surcharge, and AWD storage. confidence in {pass,warn,fail,unallocated,no_settlement}; /storage-review suppresses absolute CM3/liquidation costing on warn/fail.';

COMMIT;
