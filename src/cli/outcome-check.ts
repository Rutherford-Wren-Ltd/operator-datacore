#!/usr/bin/env tsx
// ============================================================================
// outcome-check.ts
// Closes the propose -> approve -> ship -> VERIFY loop.
//
// Skills draft recommendations; the operator logs them to ops.decision_log at
// sign-off and sets shipped_at when the action goes live. This CLI, run weekly,
// looks at decisions that shipped long enough ago to be measurable and records
// what happened to the SKU afterwards — so we can finally tell whether a
// recommendation helped, not just that it was made.
//
// IMPORTANT — what this measures. It compares a pre-ship window against a
// post-ship window on the SKU's own daily sales (brain.sales_traffic_daily),
// and for ppc-audit decisions also its ad efficiency (analytics.ads_per_asin_daily).
// This is OBSERVED MOVEMENT, not causal attribution: season, price, stock and
// competitors all move too. The outcome_note carries the raw numbers so a human
// reads the verdict as "what happened after", not "what the recommendation caused".
// Contribution (CM3) is deliberately NOT used: product_profitability_30d is a
// current-state 30-day snapshot with no history, so a pre/post CM3 read is
// impossible. Units + revenue (and TACoS for PPC) have true daily history.
//
// Writes ops.decision_log.outcome_status / outcome_note / outcome_checked_at.
// Idempotent: only rows with outcome_status='pending' are touched, and writing
// an outcome flips them off 'pending', so re-runs are no-ops.
//
// Usage:
//   npm run outcome-check              # verify all due decisions
//   npm run outcome-check -- --dry-run # print, write nothing
//   npm run outcome-check -- --window-days=14 --min-age-days=21
// ============================================================================

import { parseArgs } from 'node:util';
import { getPgClient } from '../lib/supabase.js';

interface PendingDecision {
  id: string;
  skill: string;
  asin: string | null;
  marketplace_id: string | null;
  subject: string;
  shipped_at: Date;
}

type Outcome = 'improved' | 'no_change' | 'worsened' | 'n/a';

// A ±10% swing is the band outside which we call it a real move. Inside it, the
// SKU did roughly what it was doing before — "no_change".
const MOVE_THRESHOLD = 0.10;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'window-days': { type: 'string', default: '14' },
      'min-age-days': { type: 'string', default: '21' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const windowDays = Number(values['window-days']);
  const minAgeDays = Number(values['min-age-days']);
  const dryRun = values['dry-run'] as boolean;

  if (!Number.isFinite(windowDays) || windowDays < 1) throw new Error('--window-days must be >= 1');
  if (!Number.isFinite(minAgeDays) || minAgeDays < windowDays) {
    throw new Error('--min-age-days must be >= --window-days (the post-window must have fully elapsed)');
  }

  const pg = await getPgClient();
  try {
    const { rows: pending } = await pg.query<PendingDecision>(
      `SELECT id, skill, asin, marketplace_id, subject, shipped_at
         FROM ops.decision_log
        WHERE outcome_status = 'pending'
          AND shipped_at IS NOT NULL
          AND shipped_at <= NOW() - ($1 || ' days')::interval
        ORDER BY shipped_at ASC`,
      [String(minAgeDays)],
    );

    if (pending.length === 0) {
      console.log('No decisions due for outcome-check (none shipped >= '
        + `${minAgeDays} days ago with a pending outcome).`);
      return;
    }
    console.log(`Checking ${pending.length} shipped decision(s), ${windowDays}d pre/post windows...\n`);

    const tally: Record<Outcome, number> = { improved: 0, no_change: 0, worsened: 0, 'n/a': 0 };

    for (const d of pending) {
      const { status, note } = await measure(pg, d, windowDays);
      tally[status] += 1;
      console.log(`  [${status.toUpperCase()}] ${d.skill} ${d.asin ?? '—'} ${d.marketplace_id ?? ''} — ${note}`);
      if (!dryRun) {
        await pg.query(
          `UPDATE ops.decision_log
              SET outcome_status = $2, outcome_note = $3, outcome_checked_at = NOW()
            WHERE id = $1`,
          [d.id, status, note],
        );
      }
    }

    console.log(`\n${dryRun ? '[dry-run] ' : ''}Done. `
      + `improved=${tally.improved} no_change=${tally.no_change} `
      + `worsened=${tally.worsened} n/a=${tally['n/a']}.`);
  } finally {
    await pg.end();
  }
}

// Compare pre-ship vs post-ship windows for one decision. Revenue+units is the
// universal signal; PPC decisions additionally read TACoS (ad efficiency), which
// is the metric that skill actually targets.
async function measure(
  pg: Awaited<ReturnType<typeof getPgClient>>,
  d: PendingDecision,
  windowDays: number,
): Promise<{ status: Outcome; note: string }> {
  if (!d.asin || !d.marketplace_id) {
    return { status: 'n/a', note: 'no asin/marketplace on the decision row — cannot measure.' };
  }

  const sales = await pg.query<{ pre_rev: string; post_rev: string; pre_u: string; post_u: string; ccy: string | null }>(
    `SELECT
        COALESCE(SUM(ordered_product_sales) FILTER (WHERE metric_date >= $3::date - ($4||' days')::interval AND metric_date <  $3::date), 0) AS pre_rev,
        COALESCE(SUM(ordered_product_sales) FILTER (WHERE metric_date >  $3::date AND metric_date <= $3::date + ($4||' days')::interval), 0) AS post_rev,
        COALESCE(SUM(units_ordered)         FILTER (WHERE metric_date >= $3::date - ($4||' days')::interval AND metric_date <  $3::date), 0) AS pre_u,
        COALESCE(SUM(units_ordered)         FILTER (WHERE metric_date >  $3::date AND metric_date <= $3::date + ($4||' days')::interval), 0) AS post_u,
        MAX(currency_code) AS ccy
       FROM brain.sales_traffic_daily
      WHERE child_asin = $1 AND marketplace_id = $2
        AND metric_date >= $3::date - ($4||' days')::interval
        AND metric_date <= $3::date + ($4||' days')::interval`,
    [d.asin, d.marketplace_id, d.shipped_at, String(windowDays)],
  );
  const s = sales.rows[0]!;
  const preRev = Number(s.pre_rev), postRev = Number(s.post_rev);
  const preU = Number(s.pre_u), postU = Number(s.post_u);
  const ccy = s.ccy ?? '';

  if (preRev === 0 && preU === 0) {
    return { status: 'n/a', note: `no pre-window sales for ${d.asin} (new SKU or a data gap) — nothing to compare against.` };
  }

  const revDelta = preRev === 0 ? null : (postRev - preRev) / preRev;
  const unitDelta = preU === 0 ? null : (postU - preU) / preU;

  // PPC decisions: the targeted metric is TACoS/ACoS, not revenue. Read ad
  // efficiency pre/post; a fall is the intended direction.
  let tacosNote = '';
  let ppcStatus: Outcome | null = null;
  if (d.skill === 'ppc-audit') {
    const ads = await pg.query<{ pre_cost: string; post_cost: string; pre_sales: string; post_sales: string }>(
      `SELECT
          COALESCE(SUM(total_cost)      FILTER (WHERE metric_date >= $3::date - ($4||' days')::interval AND metric_date <  $3::date), 0) AS pre_cost,
          COALESCE(SUM(total_cost)      FILTER (WHERE metric_date >  $3::date AND metric_date <= $3::date + ($4||' days')::interval), 0) AS post_cost,
          COALESCE(SUM(total_sales_14d) FILTER (WHERE metric_date >= $3::date - ($4||' days')::interval AND metric_date <  $3::date), 0) AS pre_sales,
          COALESCE(SUM(total_sales_14d) FILTER (WHERE metric_date >  $3::date AND metric_date <= $3::date + ($4||' days')::interval), 0) AS post_sales
         FROM analytics.ads_per_asin_daily
        WHERE child_asin = $1 AND marketplace_id = $2
          AND metric_date >= $3::date - ($4||' days')::interval
          AND metric_date <= $3::date + ($4||' days')::interval`,
      [d.asin, d.marketplace_id, d.shipped_at, String(windowDays)],
    ).catch(() => null);
    if (ads && ads.rows[0]) {
      const a = ads.rows[0];
      const preAcos = Number(a.pre_sales) > 0 ? Number(a.pre_cost) / Number(a.pre_sales) : null;
      const postAcos = Number(a.post_sales) > 0 ? Number(a.post_cost) / Number(a.post_sales) : null;
      if (preAcos !== null && postAcos !== null) {
        const acosDelta = (postAcos - preAcos) / preAcos;
        tacosNote = ` ACoS ${(preAcos * 100).toFixed(1)}%->${(postAcos * 100).toFixed(1)}%`;
        ppcStatus = acosDelta < -MOVE_THRESHOLD ? 'improved' : acosDelta > MOVE_THRESHOLD ? 'worsened' : 'no_change';
      }
    }
  }

  // Verdict: PPC uses ad efficiency if we could read it; everything else uses
  // revenue movement. Fall back to units if revenue was flat but units moved.
  const primary = ppcStatus ?? classify(revDelta ?? unitDelta);
  const revStr = revDelta === null ? 'n/a' : `${revDelta >= 0 ? '+' : ''}${(revDelta * 100).toFixed(0)}%`;
  const unitStr = unitDelta === null ? 'n/a' : `${unitDelta >= 0 ? '+' : ''}${(unitDelta * 100).toFixed(0)}%`;
  const note = `observed post-ship (not attribution): rev ${ccy} ${preRev.toFixed(0)}->${postRev.toFixed(0)} (${revStr}), `
    + `units ${preU}->${postU} (${unitStr})${tacosNote}. ${windowDays}d windows around ${d.shipped_at.toISOString().slice(0, 10)}.`;
  return { status: primary, note };
}

function classify(delta: number | null): Outcome {
  if (delta === null) return 'n/a';
  if (delta > MOVE_THRESHOLD) return 'improved';
  if (delta < -MOVE_THRESHOLD) return 'worsened';
  return 'no_change';
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
