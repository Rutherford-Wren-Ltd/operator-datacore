-- ============================================================================
-- 0015_brain_purchase_orders_v2.sql
-- Purchase-order revision v1.5: destination-split lines, landed-cost component
-- breakdown, and per-(SKU, region) landed cost.
--
-- Why: PO management v1 (migrations 0013/0014) modelled a PO line as one row
-- per (PO, SKU) with destination on the PO header. Reviewing a real in-flight
-- order — PO22365, Han Kuan Enterprises — showed that is wrong for RW:
--
--   1. Every line splits across destinations. WB01XJM6: 2,875 ordered =
--      919 to the UK 3PL + 1,956 to USA AWD. The split is per line, and the
--      split quantities are what each region's restock must count.
--   2. Landed cost is destination-specific. The same SKU lands at GBP 2.84 in
--      the UK and USD 7.39 in the USA — different currency, and the USA figure
--      carries 60.2% import duty plus bond / Amazon-location / AZUS-storage
--      fees the UK leg has none of. A single unit_cost cannot hold this.
--   3. Packaging is invoiced separately (a lower duty bracket), so it must be
--      its own line on the PO — but its cost folds into the product for COGS.
--
-- v1's PO tables hold no production data (the importer was only ever dry-run),
-- so this migration restructures cleanly — there is no data to migrate.
--
-- What changes:
--   brain.purchase_orders      — destination + serves_region columns removed
--                                (they move to the line).
--   brain.purchase_order_lines — dropped and recreated: one row per
--                                (PO, SKU, destination), a line_type
--                                (product | packaging), and the full
--                                landed-cost component breakdown.
--   brain.po_committed_inventory — recreated against the new line model.
--   brain.sku_landed_cost      — NEW: landed cost per (SKU, region), the COGS
--                                figure brain uses, sourced from PO lines.
--   analytics PO views         — recreated against the new model.
--
-- analytics views are recreated in THIS migration (not a separate file): the
-- line-table drop cascades them, so they must come back inside the same
-- transaction or the database is briefly left without them.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Drop the views that depend on the PO tables (recreated further down).
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS analytics.open_purchase_orders;
DROP VIEW IF EXISTS analytics.trade_payables;
DROP VIEW IF EXISTS analytics.po_over_receipts;
DROP VIEW IF EXISTS brain.po_committed_inventory;

-- ----------------------------------------------------------------------------
-- 2. brain.purchase_orders — destination + serves_region move to the line.
--    The header keeps PO-level facts only.
-- ----------------------------------------------------------------------------
ALTER TABLE brain.purchase_orders DROP COLUMN destination;
ALTER TABLE brain.purchase_orders DROP COLUMN serves_region;

COMMENT ON COLUMN brain.purchase_orders.currency IS
'The payment / supplier-invoice currency — the currency deposit_amount, balance_amount and payment_terms are stated in. Distinct from a line''s landed_cost_currency, which is the currency that destination''s landed cost is computed in.';

COMMENT ON COLUMN brain.purchase_orders.total_value IS
'Operator-stated PO total in `currency`. Advisory, for reconciliation only. Lines span destinations and currencies; the authoritative converted total is analytics.open_purchase_orders, which sums the lines and FX-converts.';

-- ----------------------------------------------------------------------------
-- 3. brain.purchase_order_lines — drop and recreate at the new grain:
--    one row per (PO, SKU, destination), plus separate packaging lines.
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS brain.purchase_order_lines CASCADE;

CREATE TABLE brain.purchase_order_lines (
    po_line_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_id             UUID NOT NULL REFERENCES brain.purchase_orders(po_id) ON DELETE CASCADE,
    line_no           INTEGER NOT NULL,
    line_type         TEXT NOT NULL DEFAULT 'product',
    -- A packaging line links to the product line whose cost it folds into.
    packages_line_id  UUID REFERENCES brain.purchase_order_lines(po_line_id) ON DELETE SET NULL,
    -- SKU identity. ean is a soft reference to brain.sku_master(ean) — no hard
    -- FK; the importer warns on unknown EANs rather than rejecting the import.
    ean               TEXT,
    asin              TEXT,
    supplier_sku      TEXT,
    description       TEXT,
    -- Where this slice of the line physically lands, and which demand region
    -- it can fulfil. serves_region is what restock math groups on.
    destination       TEXT NOT NULL,
    serves_region     TEXT NOT NULL,
    -- Quantities. No qty_received <= qty_ordered constraint: factory
    -- over-ships are real and surface in analytics.po_over_receipts.
    qty_ordered       INTEGER NOT NULL CHECK (qty_ordered >= 0),
    qty_received      INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
    line_status       TEXT NOT NULL DEFAULT 'open',
    -- Landed-cost component breakdown, per unit. The importer fills these and
    -- writes landed_cost = sum of the non-NULL components. NUMERIC(14,6)
    -- because apportioned per-shipment charges are tiny fractions.
    comp_fob                  NUMERIC(14, 6),
    comp_lcl                  NUMERIC(14, 6),
    comp_import_duty          NUMERIC(14, 6),
    import_duty_rate          NUMERIC(6, 4),
    comp_qa                   NUMERIC(14, 6),
    comp_china_3pl            NUMERIC(14, 6),
    comp_freight_dock         NUMERIC(14, 6),
    comp_photos               NUMERIC(14, 6),
    comp_bond_fee             NUMERIC(14, 6),
    comp_amz_location_fee     NUMERIC(14, 6),
    comp_azus_storage         NUMERIC(14, 6),
    comp_packaging_allocated  NUMERIC(14, 6),
    landed_cost               NUMERIC(14, 6),
    landed_cost_currency      CHAR(3),
    notes             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT po_lines_line_no_unique UNIQUE (po_id, line_no),
    -- The true natural key: a SKU can have a product line and a packaging line
    -- for the same destination, so line_type is part of the key.
    CONSTRAINT po_lines_natural_key UNIQUE (po_id, ean, destination, line_type),
    CONSTRAINT po_lines_line_type_check CHECK (line_type IN ('product', 'packaging')),
    CONSTRAINT po_lines_destination_check CHECK (destination IN (
        'fba_direct', 'uk_3pl_lemonpath', 'usa_awd', 'rw_held')),
    CONSTRAINT po_lines_serves_region_check CHECK (serves_region IN (
        'uk_eu', 'na', 'global')),
    CONSTRAINT po_lines_line_status_check CHECK (line_status IN (
        'open', 'partial', 'received', 'cancelled')),
    CONSTRAINT po_lines_identifies_something CHECK (
        ean IS NOT NULL OR supplier_sku IS NOT NULL OR description IS NOT NULL),
    -- Only a packaging line may link to a product line.
    CONSTRAINT po_lines_packages_only_packaging CHECK (
        line_type = 'packaging' OR packages_line_id IS NULL)
);

CREATE INDEX idx_po_lines_po        ON brain.purchase_order_lines (po_id);
CREATE INDEX idx_po_lines_ean       ON brain.purchase_order_lines (ean)  WHERE ean IS NOT NULL;
CREATE INDEX idx_po_lines_committed ON brain.purchase_order_lines (ean, serves_region)
    WHERE line_type = 'product' AND line_status IN ('open', 'partial');
CREATE INDEX idx_po_lines_packages  ON brain.purchase_order_lines (packages_line_id)
    WHERE packages_line_id IS NOT NULL;

CREATE TRIGGER trg_purchase_order_lines_updated_at
    BEFORE UPDATE ON brain.purchase_order_lines
    FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at();

COMMENT ON TABLE brain.purchase_order_lines IS
'Purchase-order lines, one row per (PO, SKU, destination). A SKU ordered on a PO and split UK/USA is two rows. Packaging is its own line_type=''packaging'' row (separately invoiced for a lower duty bracket) whose cost the importer folds into the linked product line''s comp_packaging_allocated.';

COMMENT ON COLUMN brain.purchase_order_lines.line_type IS
'product = sellable goods. packaging = a separately-invoiced packaging line; not sellable inventory, excluded from brain.po_committed_inventory; its cost folds into the product line it points at via packages_line_id.';

COMMENT ON COLUMN brain.purchase_order_lines.packages_line_id IS
'On a packaging line, the product line whose comp_packaging_allocated absorbs this line''s cost. NULL on product lines.';

COMMENT ON COLUMN brain.purchase_order_lines.destination IS
'Where this slice of stock physically lands first: fba_direct | uk_3pl_lemonpath | usa_awd | rw_held.';

COMMENT ON COLUMN brain.purchase_order_lines.serves_region IS
'Which demand region this slice can fulfil: uk_eu | na | global. What /restock-memo and brain.po_committed_inventory group on — a uk_3pl_lemonpath line must not offset a US gap.';

COMMENT ON COLUMN brain.purchase_order_lines.qty_received IS
'Units receipted. May exceed qty_ordered (factory over-ship) — intentionally not constrained; surfaced in analytics.po_over_receipts.';

COMMENT ON COLUMN brain.purchase_order_lines.import_duty_rate IS
'The duty rate applied for this destination, stored for customs audit (e.g. 0.0000 UK, 0.6020 USA bakeware, 0.3500 packaging). comp_import_duty is the resulting per-unit duty amount.';

COMMENT ON COLUMN brain.purchase_order_lines.comp_packaging_allocated IS
'Per-unit packaging cost folded in from the linked packaging line. NULL/0 on packaging lines themselves. Included in landed_cost.';

COMMENT ON COLUMN brain.purchase_order_lines.landed_cost IS
'Per-unit landed cost = sum of the non-NULL comp_* components (incl. comp_packaging_allocated). Importer-written, not generated, so the importer can reconcile it against the source workbook and warn on drift.';

COMMENT ON COLUMN brain.purchase_order_lines.landed_cost_currency IS
'Currency landed_cost is computed in — typically GBP for a UK destination, USD for USA. Distinct from the header payment currency.';

-- ----------------------------------------------------------------------------
-- 4. brain.sku_landed_cost — landed cost per (SKU, region).
--    The COGS figure brain uses, sourced from the most recent PO line.
-- ----------------------------------------------------------------------------
CREATE TABLE brain.sku_landed_cost (
    ean                   TEXT NOT NULL,
    region                TEXT NOT NULL,
    landed_cost           NUMERIC(14, 6) NOT NULL,
    landed_cost_currency  CHAR(3) NOT NULL,
    as_of_date            DATE NOT NULL,
    source_po_id          UUID REFERENCES brain.purchase_orders(po_id) ON DELETE SET NULL,
    source_po_line_id     UUID REFERENCES brain.purchase_order_lines(po_line_id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ean, region),
    CONSTRAINT sku_landed_cost_region_check CHECK (region IN ('uk_eu', 'na', 'global'))
);

CREATE TRIGGER trg_sku_landed_cost_updated_at
    BEFORE UPDATE ON brain.sku_landed_cost
    FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at();

COMMENT ON TABLE brain.sku_landed_cost IS
'Landed cost per (SKU EAN, demand region). The COGS figure brain treats as authoritative. Populated by the import-purchase-orders CLI from product PO lines (landed_cost, packaging already folded in). One SKU sold UK + USA has two rows. The importer upserts with an as_of_date guard so a newer PO always wins.';

COMMENT ON COLUMN brain.sku_landed_cost.as_of_date IS
'The order_date of the source PO. The importer only overwrites an existing row when the incoming as_of_date is greater than or equal to the stored one, so re-importing an old PO never regresses the figure.';

-- ----------------------------------------------------------------------------
-- 5. brain.sku_master.cogs_landed — demote to fallback.
-- ----------------------------------------------------------------------------
COMMENT ON COLUMN brain.sku_master.cogs_landed IS
'DEPRECATED as the authoritative landed cost. Use brain.sku_landed_cost per (ean, region) — landed cost is destination-specific. Retained as a single-value fallback for SKUs with no PO history.';

-- ----------------------------------------------------------------------------
-- 6. brain.po_committed_inventory — recreated against the new line model.
--    destination / serves_region now come from the line; packaging excluded.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW brain.po_committed_inventory AS
SELECT
    COALESCE(l.asin, sm.asin)                                    AS asin,
    l.serves_region,
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
WHERE l.line_type = 'product'
  AND p.status IN ('placed', 'confirmed', 'in_production', 'shipped', 'at_destination')
  AND l.line_status IN ('open', 'partial')
GROUP BY COALESCE(l.asin, sm.asin), l.serves_region;

COMMENT ON VIEW brain.po_committed_inventory IS
'Open-PO units per ASIN per serves_region (read from the line). Product lines only — packaging is not sellable inventory. committed_clean_units (PO status placed/confirmed/in_production) is safe for /restock-memo to subtract from a gap; committed_in_transit_units (shipped/at_destination) may overlap Amazon afn_inbound_* and is shown for review, never auto-subtracted.';

-- ----------------------------------------------------------------------------
-- 7. analytics views — recreated against the new model.
-- ----------------------------------------------------------------------------

-- analytics.open_purchase_orders — one row per open product line, landed value
-- in native + reporting currency. Packaging excluded (its cost is already in
-- the product line's landed_cost). Sum line_value_reporting per po_id for a
-- PO total.
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
    p.order_date,
    p.expected_arrival_date,
    l.po_line_id,
    l.line_no,
    l.ean,
    l.asin,
    l.description,
    l.destination,
    l.serves_region,
    l.qty_ordered,
    l.qty_received,
    l.landed_cost,
    l.landed_cost_currency,
    (l.qty_ordered * l.landed_cost)     AS line_value_native,
    (l.qty_ordered * l.landed_cost)
        * analytics.fx_lookup(COALESCE(p.order_date, CURRENT_DATE),
                              l.landed_cost_currency, cfg.reporting_currency)
                                        AS line_value_reporting,
    cfg.reporting_currency
FROM brain.purchase_orders p
JOIN brain.purchase_order_lines l ON l.po_id = p.po_id
JOIN brain.supplier_master s ON s.supplier_id = p.supplier_id
CROSS JOIN cfg
WHERE p.status NOT IN ('received', 'closed', 'cancelled')
  AND l.line_type = 'product';

COMMENT ON VIEW analytics.open_purchase_orders IS
'One row per open product PO line, with landed value in native and reporting currency. Packaging lines excluded (their cost is folded into the product line''s landed_cost). Sum line_value_reporting grouped by po_id for a PO-level total.';

-- analytics.trade_payables — outstanding amount owed per open PO. Header-level:
-- deposit_amount / balance_amount are the supplier-invoice obligation (which
-- already includes packaging — packaging being a separate customs line does
-- not change who the money is owed to).
CREATE OR REPLACE VIEW analytics.trade_payables AS
WITH cfg AS (
    SELECT reporting_currency FROM meta.config WHERE id = 1
),
po AS (
    SELECT
        p.po_id, p.po_number, p.supplier_id, p.status, p.payment_status,
        p.currency, p.expected_arrival_date,
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
'Outstanding amount owed to suppliers per open PO, from the header invoice figures (total_value minus paid deposit/balance). Feeds the monthly-close Trade payables line. In v1.5 the paid_at columns are NULL (no Xero pull), so outstanding == total_value. Xero stays the money source of truth.';

-- analytics.po_over_receipts — line-level over-receipts (factory over-ship).
CREATE OR REPLACE VIEW analytics.po_over_receipts AS
SELECT
    p.po_number,
    p.supplier_id,
    s.name                              AS supplier_name,
    p.status,
    l.line_no,
    l.line_type,
    l.ean,
    l.asin,
    l.description,
    l.destination,
    l.qty_ordered,
    l.qty_received,
    (l.qty_received - l.qty_ordered)    AS over_received_units
FROM brain.purchase_order_lines l
JOIN brain.purchase_orders p ON p.po_id = l.po_id
JOIN brain.supplier_master s ON s.supplier_id = p.supplier_id
WHERE l.qty_received > l.qty_ordered;

COMMENT ON VIEW analytics.po_over_receipts IS
'PO lines where qty_received exceeds qty_ordered (factory over-ship). The line table allows this on purpose; this view is the review queue.';

-- analytics.sku_landed_cost — thin PostgREST-exposed pass-through.
CREATE OR REPLACE VIEW analytics.sku_landed_cost AS
SELECT ean, region, landed_cost, landed_cost_currency, as_of_date, source_po_id
FROM brain.sku_landed_cost;

COMMENT ON VIEW analytics.sku_landed_cost IS
'PostgREST-exposed pass-through over brain.sku_landed_cost — landed cost per (SKU, region) for dashboards.';

-- ----------------------------------------------------------------------------
-- Record this migration
-- ----------------------------------------------------------------------------
INSERT INTO meta.migration_history (filename) VALUES ('0015_brain_purchase_orders_v2.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
