#!/usr/bin/env tsx
// ============================================================================
// verify-sync-freshness.ts
// Dead-man's-switch alert for the daily-sync pipeline.
//
// Reads meta.sync_freshness (migration 0037) and exits non-zero if any
// alertable object's hours_since_last_success exceeds the inline per-object
// cadence baked into the view. Runs as the final step of daily-sync.yml so
// the GitHub Actions email-on-failure becomes the single high-signal alert
// replacing the previous noisy per-step failures.
//
// Usage:
//   npm run verify-sync-freshness                  # alert on stale rows
//   npm run verify-sync-freshness -- --dry-run     # report-only, never exits 1
//
// Output is JSON-ish stderr lines + a summary banner. Designed to be readable
// in the GH Actions log without parsing.
// ============================================================================

import { parseArgs } from 'node:util';
import { getPgClient } from '../lib/supabase.js';

interface FreshnessRow {
  object: string;
  source: string | null;
  last_success_at: string | null;
  last_run_started_at: string | null;
  last_run_status: string | null;
  failures_last_24h: number;
  successes_last_7d: number;
  expected_max_hours_since_success: number | null;
  hours_since_last_success: string | null;  // pg returns numeric as string
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const dryRun = !!values['dry-run'];

  const pg = await getPgClient();
  try {
    const { rows } = await pg.query<FreshnessRow>(`
      SELECT object, source, last_success_at::text, last_run_started_at::text,
             last_run_status, failures_last_24h, successes_last_7d,
             expected_max_hours_since_success, hours_since_last_success::text
        FROM meta.sync_freshness
       ORDER BY
         (expected_max_hours_since_success IS NULL),
         hours_since_last_success DESC NULLS FIRST
    `);

    console.log('operator-datacore — sync-freshness check');
    console.log('----------------------------------------');
    console.log(`  Objects tracked: ${rows.length}`);
    console.log('');

    const stale: FreshnessRow[] = [];
    const fresh: FreshnessRow[] = [];
    const unalertable: FreshnessRow[] = [];

    for (const r of rows) {
      const cap = r.expected_max_hours_since_success;
      if (cap === null) { unalertable.push(r); continue; }
      const hrs = r.hours_since_last_success === null ? Infinity : parseFloat(r.hours_since_last_success);
      if (!isFinite(hrs) || hrs > cap) stale.push(r);
      else fresh.push(r);
    }

    if (stale.length > 0) {
      console.log(`STALE — ${stale.length} object(s) over their cadence:`);
      for (const r of stale) {
        const hrs = r.hours_since_last_success ?? '(never)';
        const last = r.last_success_at ?? '(never)';
        console.log(`  ✗ ${r.object.padEnd(38)} ${String(hrs).padStart(8)}h since last success (cap ${r.expected_max_hours_since_success}h) — last ok ${last}, last run ${r.last_run_status ?? '?'}, ${r.failures_last_24h} failure(s) in 24h`);
      }
      console.log('');
    }

    if (fresh.length > 0) {
      console.log(`FRESH — ${fresh.length} object(s) within their cadence:`);
      for (const r of fresh) {
        console.log(`  ✓ ${r.object.padEnd(38)} ${String(r.hours_since_last_success).padStart(8)}h since last success (cap ${r.expected_max_hours_since_success}h)`);
      }
      console.log('');
    }

    if (unalertable.length > 0) {
      console.log(`UNALERTED — ${unalertable.length} object(s) with no cadence configured (operator-driven or intermittent):`);
      for (const r of unalertable) {
        console.log(`  · ${r.object.padEnd(38)} last ok ${r.last_success_at ?? '(never)'}`);
      }
      console.log('');
    }

    if (stale.length > 0 && !dryRun) {
      console.error(`FAIL: ${stale.length} sync object(s) over cadence. See above for details.`);
      process.exit(1);
    }
    if (stale.length > 0 && dryRun) {
      console.log(`--dry-run set — would exit 1 (${stale.length} stale object(s)). Returning 0 anyway.`);
    } else {
      console.log('OK: all alertable sync objects are within cadence.');
    }
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
