-- ============================================================================
-- 0026_enable_rls_lockdown.sql
-- Enable Row Level Security on every table in raw/brain/ops/meta as
-- defense-in-depth, with the right policies to keep the existing access
-- paths working.
--
-- Why now: the Xero data Miia landed (bank txns, invoices, audit findings)
-- raises the cost of any accidental exposure. The Supabase advisory flagged
-- 52 tables with RLS disabled. Today, anon/authenticated are already
-- blocked at the schema-USAGE level — but a single future migration that
-- accidentally `GRANT USAGE ON SCHEMA brain TO anon` would expose
-- everything. RLS makes that blast radius row-level instead of catastrophic.
--
-- The roles + their access paths (verified 2026-06-02):
--
--   service_role         — bypasses RLS (rolbypassrls=true).
--                          Used by: every ingest CLI (SUPABASE_SERVICE_ROLE_KEY),
--                          Supabase MCP, Claude Code MCP. UNAFFECTED.
--
--   operator_readwrite   — direct psql sessions; USAGE on brain/ops/meta/
--                          analytics. We add a FOR ALL policy on every table
--                          in raw/brain/ops/meta so this role keeps full
--                          read/write access. Without this policy, RLS would
--                          block it.
--
--   operator_readonly    — direct psql sessions; USAGE on analytics only.
--                          Reads analytics.* views, which are owned by
--                          postgres (superuser, BYPASSRLS). The view layer
--                          bypasses RLS on the underlying tables, so
--                          operator_readonly continues to work. We do NOT
--                          grant operator_readonly direct policies on
--                          brain/raw/ops/meta — that would leak raw data
--                          past the analytics abstraction.
--
--   anon / authenticated — no schema USAGE on raw/brain/ops/meta/analytics.
--                          Cannot reach the tables today. RLS adds a second
--                          layer of blocking. We do not grant either role
--                          any policy — they get nothing.
--
-- Future tables: this migration uses a DO loop to apply RLS + the
-- operator_readwrite policy to every table currently in raw/brain/ops/meta.
-- New tables added in later migrations should explicitly enable RLS and
-- create the policy (or use a future migration that re-runs this loop).
-- The check-migrations CLI should be extended to flag tables without RLS.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  s TEXT;
  t TEXT;
  policy_count INT := 0;
  rls_count INT := 0;
BEGIN
  FOR s IN SELECT unnest(ARRAY['raw', 'brain', 'ops', 'meta']) LOOP
    FOR t IN
      SELECT tablename FROM pg_tables
      WHERE schemaname = s
      ORDER BY tablename
    LOOP
      -- Enable RLS (idempotent — ENABLE is a no-op if already on).
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', s, t);
      rls_count := rls_count + 1;

      -- Replace any prior policy with the same name to keep this migration
      -- idempotent if re-run after a partial failure.
      EXECUTE format(
        'DROP POLICY IF EXISTS operator_readwrite_all ON %I.%I',
        s, t
      );
      EXECUTE format(
        'CREATE POLICY operator_readwrite_all ON %I.%I '
        'FOR ALL TO operator_readwrite '
        'USING (true) WITH CHECK (true)',
        s, t
      );
      policy_count := policy_count + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Enabled RLS on % table(s); created % operator_readwrite policies',
    rls_count, policy_count;
END $$;

-- ----------------------------------------------------------------------------
-- Verify: no table in raw/brain/ops/meta should be RLS-disabled after this.
-- The DO block above covers everything currently in the schemas; this is a
-- belt-and-braces check that the migration actually achieved its intent.
-- Will raise an exception if any table is still missing RLS — that exception
-- rolls back the transaction (BEGIN/COMMIT around the migration).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  bad_table RECORD;
  bad_count INT;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM pg_tables t
  JOIN pg_class c   ON c.relname = t.tablename
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
  WHERE t.schemaname IN ('raw', 'brain', 'ops', 'meta')
    AND NOT c.relrowsecurity;

  IF bad_count > 0 THEN
    RAISE EXCEPTION 'After migration: % table(s) in raw/brain/ops/meta still have RLS disabled', bad_count;
  END IF;
END $$;

INSERT INTO meta.migration_history (filename)
VALUES ('0026_enable_rls_lockdown.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
