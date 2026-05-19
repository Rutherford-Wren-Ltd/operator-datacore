-- ============================================================================
-- 0012_meta_connection_allow_operator_local.sql
-- Extends meta.connection.source allowed values to include 'operator_local'.
--
-- Why: every other source in meta.connection represents an external data feed
-- (Amazon SP-API, Amazon Ads, TikTok Shop, Shopify, Google Workspace). The
-- new master-import CLI (Phase 3 piece 2, PR #33) is operator-initiated —
-- the operator points it at local CSVs exported from supplier-master.xlsx +
-- sku-master.xlsx and bulk-loads brain.supplier_master + brain.sku_master.
-- That's a legitimate source category but doesn't fit any of the existing
-- enum values.
--
-- The fix: add 'operator_local' as an allowed source. Future operator-driven
-- bulk imports (e.g. wholesale catalogs, retail POS exports, ad-hoc CSV
-- backfills) can reuse this source value with distinct labels.
-- ============================================================================

BEGIN;

ALTER TABLE meta.connection
  DROP CONSTRAINT IF EXISTS connection_source_check;

ALTER TABLE meta.connection
  ADD CONSTRAINT connection_source_check
  CHECK (source = ANY (ARRAY[
    'amazon_sp_api'::text,
    'amazon_ads'::text,
    'tiktok_shop'::text,
    'shopify'::text,
    'google_workspace'::text,
    'operator_local'::text
  ]));

COMMENT ON CONSTRAINT connection_source_check ON meta.connection IS
'Allowed source categories. External feeds (amazon_*, tiktok_shop, shopify, google_workspace) plus operator_local for operator-initiated bulk imports from local files (master imports, ad-hoc backfills).';

INSERT INTO meta.migration_history (filename) VALUES ('0012_meta_connection_allow_operator_local.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
