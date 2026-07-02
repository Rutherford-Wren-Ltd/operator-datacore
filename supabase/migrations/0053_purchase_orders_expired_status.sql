-- ============================================================================
-- 0053_purchase_orders_expired_status.sql
-- Add 'expired' to the purchase_orders status set.
--
-- Why: the restock engine (generate-pos) previously DELETEd its own unpromoted
-- draft POs at the start of each run and regenerated them. Any operator context
-- on an un-promoted draft (notes, an adjusted quantity, a half-decision) was
-- lost silently every Monday. The engine now EXPIRES those drafts instead —
-- the row and its lines survive as an audit trail of what was proposed. This
-- migration just widens the CHECK constraint; the CLI change is in the same PR.
--
-- 'expired' is a terminal, non-committing status: none of the committed-supply
-- views (brain.po_committed_inventory etc.) include it in their status IN-lists,
-- so expired drafts are never counted as incoming stock.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD.
--
-- NB numbering: sits above 0052 (skill support layer, PR #110, pending). Renumber
-- on merge if it collides; the DROP/ADD is safe to re-apply.
-- ============================================================================

BEGIN;

ALTER TABLE brain.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_status_check;

ALTER TABLE brain.purchase_orders
  ADD CONSTRAINT purchase_orders_status_check CHECK (status IN (
    'draft', 'placed', 'confirmed', 'in_production',
    'shipped', 'at_destination', 'received', 'closed', 'cancelled',
    'expired'));

COMMENT ON CONSTRAINT purchase_orders_status_check ON brain.purchase_orders IS
  'Allowed PO statuses. ''expired'' = an unpromoted restock-engine draft superseded by a later run; terminal, never counted as committed supply. Added 0053.';

COMMIT;
