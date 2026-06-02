# RLS posture — Row Level Security on `raw` / `brain` / `ops` / `meta`

Defense-in-depth security posture for the data lake. Every table in
`raw`, `brain`, `ops`, and `meta` has Row Level Security enabled with
policies sized to keep the existing access paths working.

## The model

| Role | Where it comes from | Access pattern after migration 0026 |
|---|---|---|
| **`service_role`** | Supabase `SUPABASE_SERVICE_ROLE_KEY` | **Bypasses RLS entirely** (`rolbypassrls=true`). Used by every ingest CLI, the Supabase MCP, Claude Code's MCP. Unaffected. |
| **`operator_readwrite`** | Direct psql via `SUPABASE_DB_URL` | Has schema USAGE on `brain` / `ops` / `meta` / `analytics`. RLS policy `operator_readwrite_all` grants FOR ALL on every table in `raw`/`brain`/`ops`/`meta`. Unaffected. |
| **`operator_readonly`** | Direct psql via scoped credentials | Has schema USAGE on `analytics` only. Reads via `analytics.*` views, which are owned by `postgres` (superuser, BYPASSRLS). Views bypass RLS on the underlying tables — unaffected. |
| **`anon`** | Supabase `SUPABASE_ANON_KEY` (browser / SDK) | No schema USAGE on any lake schema today. RLS adds a second layer of blocking. **Cannot read any lake data.** |
| **`authenticated`** | Supabase JWT-issued role | Same as `anon`: no schema USAGE, RLS blocks at the row level too. |

**Why this matters now**: Miia's Xero data (bank txns, invoices, cashflow
forecast, audit findings) raised the cost of any accidental exposure. The
Supabase advisory flagged 52 tables with RLS off. Today they're protected
by schema-USAGE gating, but that's a single point of failure — one
accidental `GRANT USAGE ON SCHEMA brain TO anon` in a future migration
would expose every row. RLS makes that blast radius row-level instead of
catastrophic.

## Pattern for new tables

Every new table in `raw` / `brain` / `ops` / `meta` must enable RLS and
create the `operator_readwrite_all` policy. The `check-migrations` CLI
verifies this on every run and fails the check if any table is missing.

```sql
-- At the end of any migration that creates a new table in
-- raw/brain/ops/meta:
ALTER TABLE brain.your_new_table ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_readwrite_all ON brain.your_new_table
    FOR ALL TO operator_readwrite
    USING (true) WITH CHECK (true);
```

For `analytics` views (PostgREST-exposed surfaces): no change needed —
views are owned by `postgres` which bypasses RLS, so they keep working
for any role that has schema USAGE on `analytics`.

## Verifying the posture

```sql
-- Tables in raw/brain/ops/meta without RLS — should return 0 rows
SELECT t.schemaname, t.tablename
FROM pg_tables t
JOIN pg_class c   ON c.relname = t.tablename
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
WHERE t.schemaname IN ('raw', 'brain', 'ops', 'meta')
  AND NOT c.relrowsecurity
ORDER BY t.schemaname, t.tablename;

-- Policies on a specific table — should show operator_readwrite_all
SELECT polname, polroles, polcmd
FROM pg_policy
WHERE polrelid = 'brain.sales_traffic_daily'::regclass;
```

Or run `npm run check:migrations` from the operator-datacore directory —
the RLS verification is integrated into the existing migration-parse check.

## Future: adding anon-readable views

If a public-facing dashboard ever needs anon-key access to a specific
metric (e.g. a public-facing "live revenue counter"), the pattern is:

1. Create the view in `analytics.*`
2. `GRANT USAGE ON SCHEMA analytics TO anon` (if not already)
3. `GRANT SELECT ON analytics.your_view TO anon`
4. Confirm the view owner is `postgres` so RLS on underlying tables
   doesn't block the read

Or, more granular: add a `SELECT` policy on specific underlying tables
that restricts which rows anon can see. This is the right pattern for
anything tenant-scoped or row-filtered.

## Rollback path

If something breaks unexpectedly after applying 0026 — e.g. a dashboard
that was implicitly relying on anon access — the migration can be
reversed:

```sql
-- Disable RLS again (does NOT delete data or policies)
DO $$
DECLARE s TEXT; t TEXT;
BEGIN
  FOR s IN SELECT unnest(ARRAY['raw', 'brain', 'ops', 'meta']) LOOP
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = s LOOP
      EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', s, t);
    END LOOP;
  END LOOP;
END $$;
```

But: if you find yourself running this, first check whether the breakage
is actually an anon-access surface that should *stay* fixed by adding a
specific policy, rather than disabling RLS broadly.

## Open follow-ups

- **scoped-roles audit**: confirm `operator_readwrite` is actually used
  by any direct psql session today; if not, the policies still work but
  are inert and the role can be revisited.
- **Tenant scoping**: not relevant today (single-tenant), but if RW ever
  needs to expose per-brand data to outside parties, the pattern is
  `CREATE POLICY brand_filter ON x FOR SELECT TO some_role USING (brand = current_setting('rw.brand'))`.
- **Function-level security**: `brain.refresh_demand_forecast_modeled()`
  and `ops.refresh_amazon_daily()` run as the calling role today. If we
  ever want operator_readwrite to call them, they may need
  SECURITY DEFINER + careful grant management.
