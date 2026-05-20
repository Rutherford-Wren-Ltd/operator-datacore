-- ============================================================================
-- 0014_analytics_purchase_orders.sql
-- BI views over the purchase-order tables from 0013.
--
-- What's added:
--   analytics.open_purchase_orders — open POs, native + reporting currency.
--   analytics.trade_payables       — outstanding amount per open PO; feeds the
--                                    monthly-close "Trade payables" line.
--   analytics.po_over_receipts     — lines received over the ordered quantity,
--                                    for operator review.
--
-- Why a separate migration from 0013: analytics is the PostgREST-exposed schema
-- (see 0009). Keeping its surface changes isolated from the brain.* table
-- definitions makes each reviewable on its own.
--
-- Currency: follows the cfg CTE + analytics.fx_lookup pattern from 0008. Native
-- amounts are in the PO's own currency; reporting amounts convert to
-- meta.config.reporting_currency.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- analytics.open_purchase_orders
-- Every PO not yet received/closed/cancelled, supplier name joined, totals in
-- both native and reporting currency.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.open_purchase_orders AS
WITH cfg AS (
    SELECT reporting_currency FROM meta.config WHERE id = 1
)
SELECT
    p.po_id,
    p.po_number,
    p.supplier_id,
    s.name                              AS supplier_name,
    p.status,
    p.destination,
    p.serves_region,
    p.currency,
    p.order_date,
    p.expected_ship_date,
    p.expected_arrival_date,
    p.total_value                       AS total_native,
    p.total_value
        * analytics.fx_lookup(COALESCE(p.order_date, CURRENT_DATE), p.currency, cfg.reporting_currency)
                                        AS total_reporting,
    p.payment_status,
    p.deposit_amount,
    p.balance_amount,
    cfg.reporting_currency
FROM brain.purchase_orders p
JOIN brain.supplier_master s ON s.supplier_id = p.supplier_id
CROSS JOIN cfg
WHERE p.status NOT IN ('received', 'closed', 'cancelled');

COMMENT ON VIEW analytics.open_purchase_orders IS
'Every purchase order not yet received, closed or cancelled. total_reporting converts the PO''s native total to meta.config.reporting_currency at the order-date FX rate.';

-- ----------------------------------------------------------------------------
-- analytics.trade_payables
-- Outstanding amount per open PO — the queryable source for the monthly-close
-- "Trade payables" line.
--
-- v1 reality: deposit_paid_at / balance_paid_at are always NULL (no Xero pull
-- yet), so outstanding == total_value for every open PO. That is still a real,
-- queryable payables figure — better than hand-transcription. When the read-only
-- Xero pull lands and sets the paid_at columns, this view becomes precise with
-- no change. Xero remains the money source of truth; reconcile against it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.trade_payables AS
WITH cfg AS (
    SELECT reporting_currency FROM meta.config WHERE id = 1
),
po AS (
    SELECT
        p.*,
        (COALESCE(p.total_value, 0)
           - CASE WHEN p.deposit_paid_at IS NOT NULL THEN COALESCE(p.deposit_amount, 0) ELSE 0 END
           - CASE WHEN p.balance_paid_at IS NOT NULL THEN COALESCE(p.balance_amount, 0) ELSE 0 END
        ) AS outstanding_native
    FROM brain.purchase_orders p
    WHERE p.status <> 'cancelled'
      AND p.payment_status <> 'paid_in_full'
)
SELECT
    po.po_id,
    po.po_number,
    po.supplier_id,
    s.name                              AS supplier_name,
    po.status,
    po.payment_status,
    po.currency,
    po.outstanding_native,
    po.outstanding_native
        * analytics.fx_lookup(CURRENT_DATE, po.currency, cfg.reporting_currency)
                                        AS outstanding_reporting,
    po.expected_arrival_date,
    cfg.reporting_currency
FROM po
JOIN brain.supplier_master s ON s.supplier_id = po.supplier_id
CROSS JOIN cfg;

COMMENT ON VIEW analytics.trade_payables IS
'Outstanding amount owed per open PO. Feeds the monthly-close Trade payables line: SELECT SUM(outstanding_reporting) FROM analytics.trade_payables. In v1 (no Xero pull) outstanding == total_value. Xero stays the money source of truth — reconcile against its AP aged report.';

-- ----------------------------------------------------------------------------
-- analytics.po_over_receipts
-- PO lines where more units arrived than were ordered (factory over-ship).
-- brain.purchase_order_lines deliberately does not constrain this; surface it
-- here for the operator to reconcile rather than rejecting the import.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.po_over_receipts AS
SELECT
    p.po_number,
    p.supplier_id,
    s.name                              AS supplier_name,
    p.status,
    l.line_no,
    l.ean,
    l.asin,
    l.description,
    l.qty_ordered,
    l.qty_received,
    (l.qty_received - l.qty_ordered)    AS over_received_units
FROM brain.purchase_order_lines l
JOIN brain.purchase_orders p ON p.po_id = l.po_id
JOIN brain.supplier_master s ON s.supplier_id = p.supplier_id
WHERE l.qty_received > l.qty_ordered;

COMMENT ON VIEW analytics.po_over_receipts IS
'PO lines where qty_received exceeds qty_ordered (factory over-ship). The line tables allow this on purpose; this view is the review queue for reconciling the discrepancy.';

-- ----------------------------------------------------------------------------
-- Record this migration
-- ----------------------------------------------------------------------------
INSERT INTO meta.migration_history (filename) VALUES ('0014_analytics_purchase_orders.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
