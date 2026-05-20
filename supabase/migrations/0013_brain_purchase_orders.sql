-- ============================================================================
-- 0013_brain_purchase_orders.sql
-- Purchase-order capture + lifecycle tracking. The native PO system of record.
--
-- What's added:
--   brain.purchase_orders               — one row per PO (header).
--   brain.purchase_order_lines          — one row per SKU per PO.
--   brain.purchase_order_status_history — append-only audit of status changes.
--   brain.po_committed_inventory        — view: open-PO units per ASIN per
--                                         demand region, split clean vs in-transit.
--
-- Why: RW creates POs by hand in Google Drive spreadsheets and emails them to
-- suppliers. Once a PO is placed, nothing tracks it. /restock-memo sees only
-- Amazon's afn_inbound_* (stock already shipped TO Amazon) — a PO placed with a
-- supplier, or stock sitting at the UK 3PL or USA AWD, is invisible, so restock
-- runs can double-order. Finance keys the monthly-close "Trade payables" line
-- from Xero by hand. This migration makes POs queryable, native, and feeds both
-- /restock-memo and the monthly-close.
--
-- Scope: schema only. The CSV importer is a separate PR; the read-only Xero
-- pull that populates payment status is a later phase (the xero_* columns are
-- pre-wired NULL placeholders for it).
--
-- PO data is operator-entered canonical reference data — like brain.supplier_master
-- and brain.sku_master added in 0011 — so brain.* is its home. It is NOT a
-- computed rollup (that would be ops.*) and NOT wiring (meta.*).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- brain.purchase_orders
-- One row per purchase order. po_number is the operator-facing identifier and
-- the importer's idempotency key.
--
-- Two location concepts, deliberately separate:
--   destination    — where the stock physically lands first (for lead-time and
--                    ops context). The data lake does not yet model inventory at
--                    the 3PL or AWD; this column is the hook for when it does.
--   serves_region  — which demand region the stock can actually fulfil. This is
--                    what /restock-memo filters on: a uk_3pl_lemonpath PO must
--                    never offset a US ASIN stockout. Operator-set and explicit
--                    rather than derived from destination, because an fba_direct
--                    shipment can target any marketplace.
-- ----------------------------------------------------------------------------
CREATE TABLE brain.purchase_orders (
    po_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_number             TEXT NOT NULL UNIQUE,
    supplier_id           TEXT NOT NULL REFERENCES brain.supplier_master(supplier_id),
    status                TEXT NOT NULL DEFAULT 'draft',
    destination           TEXT NOT NULL,
    serves_region         TEXT NOT NULL,
    currency              CHAR(3) NOT NULL,
    order_date            DATE,
    expected_ship_date    DATE,
    actual_ship_date      DATE,
    expected_arrival_date DATE,
    actual_arrival_date   DATE,
    payment_terms         TEXT,
    total_value           NUMERIC(18, 2),
    deposit_amount        NUMERIC(18, 2),
    balance_amount        NUMERIC(18, 2),
    payment_status        TEXT NOT NULL DEFAULT 'unpaid',
    -- Xero linkage — NULL in v1, populated by the future read-only Xero pull.
    deposit_paid_at       DATE,
    balance_paid_at       DATE,
    xero_bill_id          TEXT,
    xero_last_synced_at   TIMESTAMPTZ,
    -- Provenance — the brain.* analogue of raw_id for an operator-entered table.
    source_system         TEXT NOT NULL DEFAULT 'operator_csv',
    source_ref            TEXT,
    notes                 TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT purchase_orders_status_check CHECK (status IN (
        'draft', 'placed', 'confirmed', 'in_production',
        'shipped', 'at_destination', 'received', 'closed', 'cancelled')),
    CONSTRAINT purchase_orders_destination_check CHECK (destination IN (
        'fba_direct', 'uk_3pl_lemonpath', 'usa_awd', 'rw_held')),
    CONSTRAINT purchase_orders_serves_region_check CHECK (serves_region IN (
        'uk_eu', 'na', 'global')),
    CONSTRAINT purchase_orders_payment_status_check CHECK (payment_status IN (
        'unpaid', 'deposit_paid', 'paid_in_full', 'not_applicable')),
    CONSTRAINT purchase_orders_source_system_check CHECK (source_system IN (
        'operator_csv', 'xero', 'manual'))
);

CREATE INDEX idx_po_supplier ON brain.purchase_orders (supplier_id);
CREATE INDEX idx_po_status   ON brain.purchase_orders (status);
CREATE INDEX idx_po_open     ON brain.purchase_orders (status)
    WHERE status NOT IN ('received', 'closed', 'cancelled');
CREATE INDEX idx_po_expected_arrival ON brain.purchase_orders (expected_arrival_date)
    WHERE status NOT IN ('received', 'closed', 'cancelled');

COMMENT ON TABLE brain.purchase_orders IS
'Purchase-order headers. The native PO system of record. One row per PO; po_number is the operator-facing id and the CSV importer''s idempotency key. Replaces ad-hoc Google Drive PO spreadsheets.';

COMMENT ON COLUMN brain.purchase_orders.status IS
'Lifecycle: draft (not yet sent) | placed (sent, awaiting ack) | confirmed (supplier accepted) | in_production | shipped (left factory) | at_destination (arrived at 3PL/AWD/FBA dock, not yet receipted) | received (goods receipted) | closed (received + reconciled + paid) | cancelled. The placed..at_destination span is "committed"; see brain.po_committed_inventory.';

COMMENT ON COLUMN brain.purchase_orders.destination IS
'Where the PO stock physically lands first: fba_direct | uk_3pl_lemonpath | usa_awd | rw_held. Ops/lead-time context. NOT used to decide which demand a PO can serve — that is serves_region.';

COMMENT ON COLUMN brain.purchase_orders.serves_region IS
'Which demand region this PO can fulfil: uk_eu | na | global. /restock-memo filters committed stock on this — a uk_3pl_lemonpath PO must not offset a US gap. Operator-set explicitly, not derived from destination (fba_direct can target any marketplace).';

COMMENT ON COLUMN brain.purchase_orders.payment_terms IS
'Free-text snapshot of terms at PO time (e.g. "20% deposit / 80% 30 days after shipment"). WILL go stale as supplier terms drift — the future read-only Xero pull is the real payment-status source.';

COMMENT ON COLUMN brain.purchase_orders.xero_bill_id IS
'Xero ACCPAY invoice GUID. NULL in v1. Populated by the future read-only Xero pull (v1.5) — no schema change needed when it lands.';

COMMENT ON COLUMN brain.purchase_orders.source_system IS
'operator_csv (the import-purchase-orders CLI) | xero (future pull) | manual (direct SQL edit).';

-- ----------------------------------------------------------------------------
-- brain.purchase_order_lines
-- One row per SKU per PO.
--
-- ean is the SKU truth key but is a SOFT reference, not a hard FK: a PO sheet
-- exported from Google Drive may carry an EAN not yet in brain.sku_master (293
-- rows is not the full catalogue). A hard FK would reject the whole import. The
-- importer warns instead (writes a meta.sync_log row). asin is a denormalised
-- nullable snapshot — not a FK, because sku_master.asin is nullable and one EAN
-- can map to multiple marketplace ASINs.
--
-- There is deliberately NO CHECK (qty_received <= qty_ordered): factories
-- over-ship, and the constraint would force the operator to falsify the source
-- sheet. Over-receipts are allowed and surfaced in analytics.po_over_receipts.
-- ----------------------------------------------------------------------------
CREATE TABLE brain.purchase_order_lines (
    po_line_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_id         UUID NOT NULL REFERENCES brain.purchase_orders(po_id) ON DELETE CASCADE,
    line_no       INTEGER NOT NULL,
    ean           TEXT,
    asin          TEXT,
    supplier_sku  TEXT,
    description   TEXT,
    qty_ordered   INTEGER NOT NULL CHECK (qty_ordered >= 0),
    qty_received  INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
    unit_cost     NUMERIC(18, 4),
    line_status   TEXT NOT NULL DEFAULT 'open',
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT po_lines_line_no_unique UNIQUE (po_id, line_no),
    CONSTRAINT po_lines_identifies_something CHECK (
        ean IS NOT NULL OR supplier_sku IS NOT NULL OR description IS NOT NULL),
    CONSTRAINT po_lines_line_status_check CHECK (line_status IN (
        'open', 'partial', 'received', 'cancelled'))
);

CREATE INDEX idx_po_lines_po    ON brain.purchase_order_lines (po_id);
CREATE INDEX idx_po_lines_ean   ON brain.purchase_order_lines (ean)  WHERE ean  IS NOT NULL;
CREATE INDEX idx_po_lines_asin  ON brain.purchase_order_lines (asin) WHERE asin IS NOT NULL;
CREATE INDEX idx_po_lines_open  ON brain.purchase_order_lines (ean)
    WHERE line_status IN ('open', 'partial');

COMMENT ON TABLE brain.purchase_order_lines IS
'Purchase-order line items, one per SKU per PO. ean is a SOFT reference to brain.sku_master(ean) — no hard FK, the importer warns on unknown EANs rather than rejecting the import. No qty_received <= qty_ordered constraint: over-receipts are real and surfaced in analytics.po_over_receipts.';

COMMENT ON COLUMN brain.purchase_order_lines.ean IS
'The SKU truth key. Soft reference to brain.sku_master(ean); not a FK. The importer logs a meta.sync_log warning when an EAN is not in sku_master.';

COMMENT ON COLUMN brain.purchase_order_lines.asin IS
'Denormalised ASIN snapshot, nullable. Not a FK. brain.po_committed_inventory resolves ean -> asin through sku_master at query time; this column is a convenience / fallback.';

COMMENT ON COLUMN brain.purchase_order_lines.qty_received IS
'Units actually receipted. May exceed qty_ordered (factory over-ship) — intentionally not constrained. See analytics.po_over_receipts.';

-- ----------------------------------------------------------------------------
-- brain.purchase_order_status_history
-- Append-only audit of every PO status transition. Finance relies on PO state;
-- a placed -> received jump with no record of when is unacceptable. Written by
-- the trigger below.
-- ----------------------------------------------------------------------------
CREATE TABLE brain.purchase_order_status_history (
    history_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_id          UUID NOT NULL REFERENCES brain.purchase_orders(po_id) ON DELETE CASCADE,
    from_status    TEXT,
    to_status      TEXT NOT NULL,
    changed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    change_source  TEXT
);

CREATE INDEX idx_po_status_history_po ON brain.purchase_order_status_history (po_id, changed_at DESC);

COMMENT ON TABLE brain.purchase_order_status_history IS
'Append-only audit trail of PO status transitions. One row per change, written by trg_po_status_history. change_source is the import sync_run id when available, else the DB role.';

-- ----------------------------------------------------------------------------
-- Triggers
-- ----------------------------------------------------------------------------

-- updated_at maintenance (reuses meta.set_updated_at from 0001).
CREATE TRIGGER trg_purchase_orders_updated_at
    BEFORE UPDATE ON brain.purchase_orders
    FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at();

CREATE TRIGGER trg_purchase_order_lines_updated_at
    BEFORE UPDATE ON brain.purchase_order_lines
    FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at();

-- Status-change audit. change_source prefers a session-set label
-- (app.change_source — the importer sets 'import:<sync_run_id>' per transaction),
-- falling back to the connected DB role.
CREATE OR REPLACE FUNCTION brain.log_purchase_order_status_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO brain.purchase_order_status_history (po_id, from_status, to_status, change_source)
    VALUES (
        NEW.po_id,
        OLD.status,
        NEW.status,
        COALESCE(current_setting('app.change_source', true), current_user)
    );
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION brain.log_purchase_order_status_change() IS
'Appends a brain.purchase_order_status_history row on a PO status change. Bound to trg_po_status_history with a WHEN guard so it fires only on an actual status transition.';

CREATE TRIGGER trg_po_status_history
    AFTER UPDATE ON brain.purchase_orders
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION brain.log_purchase_order_status_change();

-- ----------------------------------------------------------------------------
-- brain.po_committed_inventory
-- Open-PO units per ASIN per demand region, split into two confidence buckets.
-- This is what /restock-memo reads.
--
--   committed_clean_units      — units on POs at status placed/confirmed/
--                                in_production. Definitely not yet at Amazon;
--                                safe for /restock-memo to subtract from the gap.
--   committed_in_transit_units — units on POs at status shipped/at_destination.
--                                These MAY already overlap Amazon afn_inbound_*
--                                once receipted into FBA. Shown to the operator,
--                                NEVER auto-subtracted. This is the double-count
--                                guard — permanent for FBA-direct brands like
--                                Hemswell Crystal, not just a migration artefact.
--
-- draft is excluded (not committed). received/closed/cancelled are excluded
-- (already counted by afn_inbound_*, or dead). Units net off qty_received so a
-- partially-received PO contributes only its outstanding units.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW brain.po_committed_inventory AS
SELECT
    COALESCE(l.asin, sm.asin)                                    AS asin,
    p.serves_region,
    SUM(CASE WHEN p.status IN ('placed', 'confirmed', 'in_production')
             THEN GREATEST(l.qty_ordered - l.qty_received, 0)
             ELSE 0 END)                                         AS committed_clean_units,
    SUM(CASE WHEN p.status IN ('shipped', 'at_destination')
             THEN GREATEST(l.qty_ordered - l.qty_received, 0)
             ELSE 0 END)                                         AS committed_in_transit_units,
    COUNT(DISTINCT p.po_id)                                      AS open_po_count,
    MIN(p.expected_arrival_date)                                 AS earliest_expected_arrival
FROM brain.purchase_order_lines l
JOIN brain.purchase_orders p ON p.po_id = l.po_id
LEFT JOIN brain.sku_master  sm ON sm.ean = l.ean
WHERE p.status IN ('placed', 'confirmed', 'in_production', 'shipped', 'at_destination')
  AND l.line_status IN ('open', 'partial')
GROUP BY COALESCE(l.asin, sm.asin), p.serves_region;

COMMENT ON VIEW brain.po_committed_inventory IS
'Open-PO units per ASIN per serves_region. committed_clean_units (PO status placed/confirmed/in_production) is safe to subtract from a restock gap. committed_in_transit_units (shipped/at_destination) may overlap Amazon afn_inbound_* and is shown for human review, never auto-subtracted. Rows with a NULL asin are lines whose EAN did not resolve in sku_master — investigate via the import warnings.';

-- ----------------------------------------------------------------------------
-- Record this migration
-- ----------------------------------------------------------------------------
INSERT INTO meta.migration_history (filename) VALUES ('0013_brain_purchase_orders.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
