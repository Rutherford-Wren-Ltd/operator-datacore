#!/usr/bin/env tsx
// ============================================================================
// check-migrations.ts
// Validates that every migration file applies cleanly inside a single
// transaction, then rolls back. Leaves your database untouched.
//
// Skips gracefully if SUPABASE_DB_URL is not set so this is safe to run in CI.
//
// Usage:
//   npm run check:migrations
// ============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as PgClient } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'supabase', 'migrations');

async function main(): Promise<void> {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.log('SUPABASE_DB_URL not set — skipping migration check (this is fine in CI).');
    return;
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => statSync(join(MIGRATIONS_DIR, f)).isFile())
    .sort();

  console.log(`Checking ${files.length} migrations against ${maskUrl(dbUrl)} ...`);

  const pg = new PgClient({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });
  await pg.connect();

  try {
    await pg.query('BEGIN');
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const start = Date.now();
      try {
        await pg.query(sql);
        console.log(`  ✓ ${file}  (${Date.now() - start}ms)`);
      } catch (err) {
        const e = err as Error;
        console.error(`  ✗ ${file}`);
        console.error(`    ${e.message}`);
        await pg.query('ROLLBACK').catch(() => {});
        process.exit(1);
      }
    }
    // Post-apply state checks. These run INSIDE the rollback transaction so
    // they validate the state of the database AFTER the full migration set
    // has been applied. Catches drift introduced by a new migration (e.g. a
    // new table created without RLS) before the migration lands in main.
    await verifyRlsPosture(pg);

    // Always roll back — this is a check, not a real apply.
    await pg.query('ROLLBACK');
    console.log('All migrations parsed cleanly. Rolled back; your database is untouched.');
  } finally {
    await pg.end();
  }
}

function maskUrl(url: string): string {
  return url.replace(/\/\/[^:]+:[^@]+@/, '//***:***@');
}

/**
 * Every table in raw/brain/ops/meta must have RLS enabled after the full
 * migration set applies. Defense-in-depth — anon/authenticated are already
 * blocked at the schema-USAGE level today, but RLS adds the row-level
 * check so a future migration that accidentally grants schema USAGE
 * doesn't expose every row. See 0026_enable_rls_lockdown.sql.
 */
async function verifyRlsPosture(pg: PgClient): Promise<void> {
  const { rows } = await pg.query<{ schemaname: string; tablename: string }>(
    `SELECT t.schemaname, t.tablename
       FROM pg_tables t
       JOIN pg_class c   ON c.relname = t.tablename
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
      WHERE t.schemaname IN ('raw', 'brain', 'ops', 'meta')
        AND NOT c.relrowsecurity
      ORDER BY t.schemaname, t.tablename`,
  );
  if (rows.length > 0) {
    console.error('');
    console.error(`✗ ${rows.length} table(s) without RLS in raw/brain/ops/meta:`);
    for (const r of rows) {
      console.error(`    ${r.schemaname}.${r.tablename}`);
    }
    console.error('');
    console.error('Every table in raw/brain/ops/meta must have RLS enabled. See ' +
      '0026_enable_rls_lockdown.sql for the pattern: ALTER TABLE x ENABLE ROW LEVEL ' +
      'SECURITY + CREATE POLICY operator_readwrite_all FOR ALL TO operator_readwrite.');
    await pg.query('ROLLBACK').catch(() => {});
    process.exit(1);
  }
  console.log(`  ✓ RLS posture: all tables in raw/brain/ops/meta have RLS enabled`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
