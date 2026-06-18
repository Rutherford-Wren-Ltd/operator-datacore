-- ============================================================================
-- 0038_analytics_storage_settled_by_asin.sql
-- Per-ASIN monthly FBA storage, allocated from SETTLED ACTUALS.
--
-- Why this exists: the per-FNSKU report (GET_FBA_STORAGE_FEE_CHARGES_DATA ->
-- brain.fba_storage_fees) that 0033 used for storage_base is unreliable on this
-- account. Forensics (2026-06): the report Amazon returns covers only ~350-390
-- FNSKUs and ~618 US units, i.e. roughly 3% of real inventory, summing to
-- £251 / $74.70 against SETTLED storage of £3,180 / $17,810 for the same month.
-- The raw payload is complete (0.9-1.8 MB, DONE) and the TSV parser is sound, so
-- the shortfall is the report CONTENT, not our ingest. Both its £ and its
-- quantities are therefore unusable as a per-SKU basis.
--
-- Fix (operator-approved 2026-06): treat SETTLEMENT as the source of truth for
-- the storage TOTAL (brain.financial_events FBAStorageFee, which reconciles to
-- the bank) and ALLOCATE that total per-ASIN by physical volume share
-- (trusted on-hand units x packaged item volume). This reconciles to settlement
-- by construction. Validated 2026-06: allocated_total = settled_total to the
-- penny (UK £3,180.55, US $17,809.84).
--
-- Settlement gotchas handled here:
--   * The same storage charge appears under two fee_description variants
--     ('FBAStorageFee' camelCase vs 'FBA Inventory Storage Fee' spaced) - the
--     same money double-represented. We take the camelCase path ONLY.
--   * AWD storage (STARStorageFee, AmazonUpstreamStorageTransportationFee) is a
--     separate warehouse bucket and is excluded here.
--   * Storage for charge-month M settles ~7th-15th of M+1, so
--     charge_month = date_trunc('month', posted_date) - 1 month.
--   * financial_events.marketplace_id is stamped per request-region, so we pin
--     each marketplace to its home currency (US->USD, UK->GBP) to avoid the
--     stray CAD/EUR-on-US noise rows.
--
-- Scope of v1: BASE monthly storage only. Aged / long-term surcharge is
-- allocated separately by aged-unit share once GET_FBA_INVENTORY_AGED_DATA is
-- ingested (brain.fba_inventory_age, a later migration). The allocation basis is
-- CURRENT inventory_health_by_asin: correct for the most recent settled month;
-- older months would need a per-month inventory snapshot basis (TODO).
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW analytics.storage_settled_by_asin AS
WITH mkt_ccy(marketplace_id, currency_code) AS (
    -- Pin each marketplace to its home settlement currency.
    VALUES ('ATVPDKIKX0DER', 'USD'),
           ('A1F83G8C2ARO7P', 'GBP')
),
settled AS (
    -- Settled BASE monthly storage per (marketplace, charge_month), native ccy,
    -- deduped to the camelCase fee_description path, AWD excluded by subtype.
    SELECT
        fe.marketplace_id,
        mc.currency_code,
        (date_trunc('month', fe.posted_date) - INTERVAL '1 month')::date AS charge_month,
        SUM(fe.amount) AS base_total
    FROM brain.financial_events fe
    JOIN mkt_ccy mc
      ON mc.marketplace_id = fe.marketplace_id
     AND mc.currency_code  = fe.currency_code
    WHERE fe.event_subtype   = 'FBAStorageFee'
      AND fe.fee_description  = 'FBAStorageFee'
    GROUP BY fe.marketplace_id, mc.currency_code,
             (date_trunc('month', fe.posted_date) - INTERVAL '1 month')::date
),
dims AS (
    -- One packaged volume per ASIN (the report carries one row per FNSKU; an
    -- ASIN can map to several FNSKUs of the same physical item).
    SELECT marketplace_id, asin, MAX(item_volume_m3) AS item_volume_m3
    FROM brain.fba_item_dimensions
    GROUP BY marketplace_id, asin
),
basis AS (
    -- Physical storage basis per ASIN: units physically in the FC (exclude
    -- inbound, which is not yet stored) x packaged volume.
    SELECT
        ih.marketplace_id,
        ih.asin,
        ih.product_name,
        GREATEST(COALESCE(ih.afn_total_quantity, 0) - COALESCE(ih.afn_inbound_total, 0), 0) AS fc_units,
        GREATEST(COALESCE(ih.afn_total_quantity, 0) - COALESCE(ih.afn_inbound_total, 0), 0)
            * COALESCE(dm.item_volume_m3, 0) AS volume_basis_m3
    FROM analytics.inventory_health_by_asin ih
    LEFT JOIN dims dm
      ON dm.asin = ih.asin AND dm.marketplace_id = ih.marketplace_id
),
tot AS (
    SELECT marketplace_id, SUM(volume_basis_m3) AS basis_sum
    FROM basis GROUP BY marketplace_id
)
SELECT
    s.charge_month,
    b.marketplace_id,
    b.asin,
    b.product_name,
    s.currency_code,
    b.fc_units,
    ROUND(b.volume_basis_m3::numeric, 6)                                          AS volume_basis_m3,
    ROUND((s.base_total * b.volume_basis_m3 / NULLIF(t.basis_sum, 0))::numeric, 4) AS storage_base_allocated,
    ROUND(s.base_total::numeric, 2)                                               AS marketplace_settled_base,
    'volume_share'::text                                                          AS allocation_method,
    (t.basis_sum = 0 OR b.volume_basis_m3 = 0)                                    AS basis_missing
FROM settled s
JOIN basis b ON b.marketplace_id = s.marketplace_id
JOIN tot   t ON t.marketplace_id = s.marketplace_id;

COMMENT ON VIEW analytics.storage_settled_by_asin IS
'Per-ASIN monthly FBA BASE storage, allocated from settled actuals (brain.financial_events FBAStorageFee, camelCase path, AWD excluded) by physical volume share (on-hand FC units x packaged item volume). Reconciles to settlement by construction. Replaces the unreliable brain.fba_storage_fees report basis (which covered ~3% of real inventory). Aged/long-term surcharge handled separately once the FBA inventory-age report is ingested. Basis = current inventory; accurate for the most recent settled month. See migration 0038 header.';

COMMIT;
