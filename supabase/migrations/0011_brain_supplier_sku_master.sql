-- ============================================================================
-- 0011_brain_supplier_sku_master.sql
-- Source-of-truth tables for supplier commercial terms and per-SKU metadata.
--
-- What's added:
--   brain.supplier_master  — one row per supplier (commercial terms, country,
--                            payment, incoterms, currency, lead time, MOQ).
--   brain.sku_master       — one row per RW SKU (ASIN + EAN + brand + supplier
--                            link + COGS + status + variant lineage).
--
-- Why: today the vault duplicates two Excel files (supplier-master.xlsx +
-- sku-master.xlsx) into ~300 markdown pages. Every master update means a
-- vault re-sync; drift between Excel and vault is the maintenance problem
-- Phase 3 is designed to kill. Moving the masters into Supabase makes them
-- queryable, joinable to brain.* operational tables (sales_traffic_daily,
-- fba_inventory_snapshot, ads_sp_daily), and reachable by skills + analytics
-- views.
--
-- Scope of this migration: schema only. The CLI that imports from the
-- Excel masters and the write-path for PO updates land in subsequent PRs.
-- Once the importer runs, vault pages can shift from "source" to "view"
-- and the trusted-actions playbook reflects that.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- brain.supplier_master
-- One row per supplier. supplier_id mirrors the SUP-NNN codes in
-- supplier-master.xlsx; that's the operator's lingua franca and the importer
-- key. Name is not unique (e.g. Maiktoli appears twice in the source — same
-- factory, two different shipping ports; each gets its own row).
-- ----------------------------------------------------------------------------
CREATE TABLE brain.supplier_master (
    supplier_id        TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    country            TEXT,
    city               TEXT,
    factory_or_trader  TEXT,
    moq                INTEGER,
    lead_time_days     INTEGER,
    payment_terms      TEXT,
    incoterms          TEXT,
    currency           CHAR(3),
    since_month        TEXT,
    status             TEXT NOT NULL DEFAULT 'active',
    notes              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT supplier_master_status_check
        CHECK (status IN ('active', 'paused', 'dormant', 'dropped')),
    CONSTRAINT supplier_master_factory_or_trader_check
        CHECK (factory_or_trader IS NULL OR factory_or_trader IN ('factory', 'trader', 'hybrid', 'agent')),
    CONSTRAINT supplier_master_since_month_format_check
        CHECK (since_month IS NULL OR since_month ~ '^\d{4}-\d{2}$')
);

CREATE INDEX idx_supplier_master_name    ON brain.supplier_master(name);
CREATE INDEX idx_supplier_master_country ON brain.supplier_master(country);
CREATE INDEX idx_supplier_master_status  ON brain.supplier_master(status);

COMMENT ON TABLE brain.supplier_master IS
'Source of truth for supplier commercial terms. Replaces supplier-master.xlsx + 16 vault pages. Importer (next PR) keeps this fresh from the Excel master; long-term, PO write-path makes Xero / accounting the upstream.';

COMMENT ON COLUMN brain.supplier_master.supplier_id IS
'Operator-friendly code matching supplier-master.xlsx (SUP-001, SUP-002 …). Stable across renames; used as the FK target.';

COMMENT ON COLUMN brain.supplier_master.name IS
'Display name. Not unique — same supplier may have multiple rows when they ship from multiple ports (e.g. Maiktoli has Nhava Sheva + Tuticorin entries).';

COMMENT ON COLUMN brain.supplier_master.moq IS
'Default MOQ at the supplier level. Per-SKU MOQs (brain.sku_master.moq) override this when present.';

COMMENT ON COLUMN brain.supplier_master.lead_time_days IS
'PO-confirmed to FBA-receipt typical lead time. Per-SKU lead times (brain.sku_master.lead_time_days) override when present.';

COMMENT ON COLUMN brain.supplier_master.currency IS
'Supplier invoice currency (ISO 4217). May differ from cogs_currency on the SKU side — cogs_landed is the GBP-converted post-FX-and-freight cost.';

COMMENT ON COLUMN brain.supplier_master.status IS
'active = currently transacting | paused = no active POs but kept warm | dormant = inactive but reusable | dropped = relationship ended.';

-- ----------------------------------------------------------------------------
-- brain.sku_master
-- One row per RW SKU (whether or not it has an Amazon ASIN — some entries
-- are EAN-only barcoded items that have not yet launched). The synthetic
-- UUID PK lets EAN-only and ASIN-bearing rows coexist; EAN is the universal
-- identifier (UNIQUE), ASIN is the primary join key against brain.* tables.
-- ----------------------------------------------------------------------------
CREATE TABLE brain.sku_master (
    sku_master_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asin               TEXT,
    seller_sku         TEXT,
    ean                TEXT NOT NULL UNIQUE,
    brand              TEXT NOT NULL,
    supplier_id        TEXT REFERENCES brain.supplier_master(supplier_id)
                       ON DELETE SET NULL ON UPDATE CASCADE,
    moq                INTEGER,
    lead_time_days     INTEGER,
    cogs_landed        NUMERIC(12, 4),
    cogs_currency      CHAR(3) DEFAULT 'GBP',
    fba_fee            NUMERIC(12, 4),
    launched           DATE,
    status             TEXT NOT NULL DEFAULT 'active',
    marketplace        TEXT,
    parent_asin        TEXT,
    notes              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT sku_master_status_check
        CHECK (status IN ('active', 'seasonal', 'on_hold', 'new_launch', 'discontinued', 'unknown'))
);

CREATE INDEX idx_sku_master_asin        ON brain.sku_master(asin)        WHERE asin        IS NOT NULL;
CREATE INDEX idx_sku_master_seller_sku  ON brain.sku_master(seller_sku)  WHERE seller_sku  IS NOT NULL;
CREATE INDEX idx_sku_master_supplier    ON brain.sku_master(supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX idx_sku_master_parent_asin ON brain.sku_master(parent_asin) WHERE parent_asin IS NOT NULL;
CREATE INDEX idx_sku_master_brand       ON brain.sku_master(brand);
CREATE INDEX idx_sku_master_status      ON brain.sku_master(status);

COMMENT ON TABLE brain.sku_master IS
'Source of truth for per-SKU metadata: ASIN, EAN, brand, supplier link, COGS, status, variant lineage. Replaces sku-master.xlsx + 299 vault SKU pages. EAN is universal (every SKU has one); ASIN is optional (some rows are EAN-only — barcoded but not yet listed). Importer (next PR) keeps this fresh from the Excel master; daily-sync data lakes (sales_traffic_daily, fba_inventory_snapshot, ads_*) join on asin.';

COMMENT ON COLUMN brain.sku_master.ean IS
'Universal barcode. Always present. UNIQUE — duplicate EANs in source data force a deliberate operator decision rather than silently merging.';

COMMENT ON COLUMN brain.sku_master.asin IS
'Amazon Standard Identification Number. NULL for EAN-only items (barcoded but unlisted). Primary join key against brain.sales_traffic_daily, brain.fba_inventory_snapshot, brain.ads_sp_daily, brain.ads_sd_daily, brain.ads_sb_daily.';

COMMENT ON COLUMN brain.sku_master.seller_sku IS
'The long-form Amazon seller SKU (e.g. ''MD-Garden-Sharpener-MD05GTS-FBA-EAN''). One ASIN can have multiple seller_skus (renames + parallel pools); brain.fba_inventory_snapshot is keyed by seller_sku, so this column is the join bridge from snapshot rows to ASIN-level master rows.';

COMMENT ON COLUMN brain.sku_master.cogs_landed IS
'Landed cost per unit in cogs_currency (default GBP). After FX, freight, duty. NOT the supplier invoice price — that lives in supplier_master.currency context, multiplied by quantity and adjusted for landed factors externally.';

COMMENT ON COLUMN brain.sku_master.cogs_currency IS
'Currency of cogs_landed (ISO 4217). Defaults to GBP since that''s our reporting currency. May be USD for US-listed SKUs if we want to preserve the native-currency view.';

COMMENT ON COLUMN brain.sku_master.fba_fee IS
'Per-unit FBA fulfilment fee in cogs_currency. NULL until populated from Seller Central''s Manage FBA Inventory or via SP-API getMyFeesEstimate. Closes the CM3 calculation when filled.';

COMMENT ON COLUMN brain.sku_master.moq IS
'Per-SKU minimum order quantity. NULL means inherit from brain.supplier_master.moq for this SKU''s supplier.';

COMMENT ON COLUMN brain.sku_master.lead_time_days IS
'Per-SKU lead time override. NULL means inherit from brain.supplier_master.lead_time_days.';

COMMENT ON COLUMN brain.sku_master.status IS
'active = currently selling | seasonal = sold periodically | on_hold = paused intentionally | new_launch = pre-launch / launching | discontinued = no longer sold | unknown = imported without a status field.';

COMMENT ON COLUMN brain.sku_master.parent_asin IS
'For variant ASINs, points at the parent. Self-referential — does not enforce FK because the parent may not yet exist in the master at insert time.';

-- ----------------------------------------------------------------------------
-- View: convenience join giving the "effective" terms for a SKU (per-SKU
-- overrides + supplier defaults coalesced). Used by /restock-memo and
-- /sku-audit in subsequent skill updates.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW brain.sku_effective_terms AS
SELECT
    sm.sku_master_id,
    sm.asin,
    sm.seller_sku,
    sm.ean,
    sm.brand,
    sm.status                                                  AS sku_status,
    sm.parent_asin,
    sm.cogs_landed,
    sm.cogs_currency,
    sm.fba_fee,
    sm.launched,
    sm.marketplace,
    -- Effective MOQ / lead time: per-SKU overrides supplier default.
    COALESCE(sm.moq, sup.moq)                                  AS effective_moq,
    COALESCE(sm.lead_time_days, sup.lead_time_days)            AS effective_lead_time_days,
    sup.supplier_id,
    sup.name                                                   AS supplier_name,
    sup.country                                                AS supplier_country,
    sup.city                                                   AS supplier_city,
    sup.payment_terms,
    sup.incoterms,
    sup.currency                                               AS supplier_invoice_currency,
    sup.status                                                 AS supplier_status
FROM brain.sku_master sm
LEFT JOIN brain.supplier_master sup ON sup.supplier_id = sm.supplier_id;

COMMENT ON VIEW brain.sku_effective_terms IS
'One row per SKU with supplier-defaulted MOQ / lead time pre-coalesced. Skills should read from this view rather than re-joining and re-COALESCEing every time.';

INSERT INTO meta.migration_history (filename) VALUES ('0011_brain_supplier_sku_master.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
