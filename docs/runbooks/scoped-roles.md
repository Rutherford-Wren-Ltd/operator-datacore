# Runbook — scoped operator roles

RW-AI-OS gives each operator a Postgres role scoped to exactly what their job
needs — nobody uses `service_role` for daily work. This is Phase 1, step 2 of
`seller-sessions-2026/implementation-plan.md`.

## The two roles

| Role | For | Schema access | Notes |
|---|---|---|---|
| `operator_readonly` | Jo (Ops role, Cowork) | `SELECT` on `analytics` **only** | The `analytics.*` views are plain views owned by `postgres` (not `security_invoker`), so they reach into `ops`/`meta`/`brain` on the view owner's privileges. Jo gets every revenue/traffic/ASIN number without any direct access to the source schemas. |
| `operator_readwrite` | Miia (Code role) | `SELECT, INSERT, UPDATE` on `brain`, `ops`, `meta`; `SELECT` on `analytics` | No `DELETE`. No access to `raw`. Sequence `USAGE` on `brain`/`meta` so inserts on serial columns work. |

Neither role can `LOGIN` — they are permission *templates*. At invite time the
Supabase **Owner** (Miia) creates the actual login user and runs
`GRANT operator_readonly TO <user>` (or `operator_readwrite`).

`raw.*` is never granted to anyone — it stays internal, as do direct `brain.*`
grants for the read-only role.

## Apply (idempotent — safe to re-run)

Run as the migration/superuser role (the `SUPABASE_DB_URL` connection), so the
`ALTER DEFAULT PRIVILEGES` lines also cover objects future migrations create.

```sql
-- operator_readonly: analytics consumption layer only (Jo / Cowork)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'operator_readonly') THEN
    CREATE ROLE operator_readonly NOLOGIN;
  END IF;
END $$;
GRANT USAGE  ON SCHEMA analytics TO operator_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO operator_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO operator_readonly;

-- operator_readwrite: source + rollup + meta read/write (Miia / Code role)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'operator_readwrite') THEN
    CREATE ROLE operator_readwrite NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA brain, ops, meta, analytics TO operator_readwrite;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA brain, ops, meta TO operator_readwrite;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO operator_readwrite;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA brain, meta TO operator_readwrite;
ALTER DEFAULT PRIVILEGES IN SCHEMA brain, ops, meta GRANT SELECT, INSERT, UPDATE ON TABLES TO operator_readwrite;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO operator_readwrite;
ALTER DEFAULT PRIVILEGES IN SCHEMA brain, meta GRANT USAGE ON SEQUENCES TO operator_readwrite;
```

## Verify

```sql
-- expect: operator_readonly  -> analytics only
-- expect: operator_readwrite -> brain/ops/meta/analytics, NOT raw
SELECT 'operator_readonly'  AS role, s AS schema, has_schema_privilege('operator_readonly',  s, 'USAGE') AS usage
FROM unnest(ARRAY['raw','brain','ops','meta','analytics']) s
UNION ALL
SELECT 'operator_readwrite', s, has_schema_privilege('operator_readwrite', s, 'USAGE')
FROM unnest(ARRAY['raw','brain','ops','meta','analytics']) s
ORDER BY role, schema;

-- table-level spot checks
SELECT has_table_privilege('operator_readonly', 'analytics.amazon_daily',      'SELECT') AS ro_reads_analytics,   -- true
       has_table_privilege('operator_readonly', 'brain.sales_traffic_daily',   'SELECT') AS ro_reads_brain,       -- false
       has_table_privilege('operator_readwrite','brain.sales_traffic_daily',   'INSERT') AS rw_writes_brain,      -- true
       has_table_privilege('operator_readwrite','brain.sales_traffic_daily',   'DELETE') AS rw_deletes_brain;     -- false
```

First applied 2026-05-14 against the Wrenbury Supabase project.
