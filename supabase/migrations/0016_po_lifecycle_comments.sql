-- ============================================================================
-- 0016_po_lifecycle_comments.sql
-- Documents the purchase-order lifecycle semantics on brain.purchase_orders.
--
-- Why: PO management v1.5 left the meaning of order_date and status implicit.
-- Reviewing a real draft PO (PO22365) made the lifecycle load-bearing:
--   - A PO is drafted during forecast/stock review weeks or months before it
--     is sent to the supplier. order_date is the *placed* date — NULL until
--     then — and the import-purchase-orders CLI only treats a PO's costs as
--     authoritative (writing brain.sku_landed_cost) once status is past draft.
--
-- Comments only — no structural change.
-- ============================================================================

BEGIN;

COMMENT ON COLUMN brain.purchase_orders.order_date IS
'Date the PO was placed / sent to the supplier. NULL while the PO is a draft (in preparation). Doubles as the as_of_date for brain.sku_landed_cost — a PO with no order_date contributes no landed cost.';

COMMENT ON COLUMN brain.purchase_orders.status IS
'PO lifecycle: draft (in preparation — estimated costs/quantities, not yet sent to the supplier) -> placed (sent to the supplier; order_date set) -> confirmed -> in_production -> shipped -> at_destination -> received -> closed; cancelled is terminal from any state. brain.sku_landed_cost is populated only from POs past draft (and not cancelled) — a draft PO''s line costs are estimates and never become authoritative COGS. brain.po_committed_inventory counts placed/confirmed/in_production/shipped/at_destination.';

INSERT INTO meta.migration_history (filename) VALUES ('0016_po_lifecycle_comments.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
