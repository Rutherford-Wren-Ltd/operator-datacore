#!/usr/bin/env tsx
// ============================================================================
// ingest-finances.ts
// Pulls SP-API Finances listFinancialEvents into brain.financial_events.
//
// What this is for: posted/settled fees, refunds, sale credits, adjustments,
// ad-spend reconciliations. The actuals behind Sales & Traffic's "ordered"
// numbers. Sharpens CM3 because FBA / referral / storage / advertising fees
// all land here as posted amounts.
//
// What this is NOT for: revenue. Canonical revenue stays in
// brain.sales_traffic_daily (see docs/canonical-reports.md and the Dr Bo
// 30-40% under-count incident).
//
// Usage:
//   npm run ingest-finances                       # last 1 day
//   npm run ingest-finances -- --days 7
//   npm run ingest-finances -- --from 2025-01-01 --to 2025-01-31
//   npm run ingest-finances -- --region na --marketplace-tag A1F83G8C2ARO7P
//   npm run ingest-finances -- --dry-run
//
// Marketplace tagging: the Finances API doesn't filter by marketplace on the
// request side — it returns events for the whole account. We stamp every
// row with the --marketplace-tag value (defaults to the region's primary
// marketplace). For per-event marketplace resolution, post-ingest analytics
// can JOIN brain.orders by amazon_order_id.
// ============================================================================

import { parseArgs } from 'node:util';
import { loadEnvForAmazonShared, getSpApiRegionConfig, type SpApiRegion } from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { ingestFinancialEventsWindow } from '../lib/sp-api/finances.js';
import { MARKETPLACE_ALIASES } from '../lib/marketplaces.js';
import { withSyncRun } from '../lib/sync-run.js';

// Single-value variant of resolveMarketplaceFilter — ingest-finances takes a
// single --marketplace-tag flag, not a comma-separated list. Different
// signature so it's kept local; relies on the shared alias map.
function resolveMarketplaceTag(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const upper = raw.toUpperCase();
  return MARKETPLACE_ALIASES[upper] ?? raw;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from:                 { type: 'string' },
      to:                   { type: 'string' },
      days:                 { type: 'string' },
      region:               { type: 'string' },
      'marketplace-tag':    { type: 'string' },
      'dry-run':            { type: 'boolean', default: false },
    },
  });

  const from = values.from ? new Date(values.from + 'T00:00:00Z') : null;
  const to   = values.to   ? new Date(values.to   + 'T23:59:59Z') : null;
  if ((from && !to) || (!from && to)) {
    throw new Error('--from and --to must be used together.');
  }
  const days = values.days ? parseInt(values.days, 10) : null;
  if (days !== null && (!Number.isFinite(days) || days < 1)) {
    throw new Error('--days must be a positive integer.');
  }
  if (from && days !== null) {
    throw new Error('Use either --from/--to OR --days, not both.');
  }

  const env = loadEnvForAmazonShared();
  let region: SpApiRegion = env.SP_API_REGION;
  if (values.region !== undefined) {
    if (values.region !== 'na' && values.region !== 'eu' && values.region !== 'fe') {
      throw new Error(`--region must be one of: na, eu, fe. Got "${values.region}".`);
    }
    region = values.region;
  }
  const regionConfig = getSpApiRegionConfig(region, env);
  const marketplaceTag = resolveMarketplaceTag(values['marketplace-tag'], regionConfig.marketplaceIds[0]!);

  // Resolve window
  let fromDate: Date;
  let toDate: Date;
  if (from && to) {
    fromDate = from;
    toDate = to;
  } else {
    const now = new Date();
    toDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 23, 59, 59));
    const n = days ?? 1;
    fromDate = new Date(toDate.getTime() - (n - 1) * 86_400_000);
    fromDate.setUTCHours(0, 0, 0, 0);
  }

  // Amazon's Finances API rejects PostedAfter older than ~2 years; the UI
  // says "up to 2 years back" but the actual cliff varies. The runbook
  // covers the operator response if the call 400s for older windows.

  console.log('operator-datacore — Amazon Finances ingest');
  console.log('-------------------------------------------');
  console.log(`  Region:           ${regionConfig.region}`);
  console.log(`  Marketplace tag:  ${marketplaceTag} (stamped on every row)`);
  console.log(`  Posted window:    ${fromDate.toISOString()} → ${toDate.toISOString()}`);
  console.log(`  Dry run:          ${values['dry-run']}`);
  console.log('');

  if (values['dry-run']) {
    console.log('--dry-run set — banner only, no API calls fired.');
    return;
  }

  const spClient = new SpApiClient({
    region: regionConfig.region,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: regionConfig.refreshToken,
  });

  const pg = await getPgClient();
  try {
    const { rows: connRows } = await pg.query<{ connection_id: string }>(
      `INSERT INTO meta.connection (source, label, region, marketplace_ids, status)
       VALUES ('amazon_sp_api', $1, $2, $3, 'active')
       ON CONFLICT (source, label) DO UPDATE
         SET region = EXCLUDED.region, marketplace_ids = EXCLUDED.marketplace_ids,
             last_health_check_at = NOW(), last_health_check_ok = TRUE,
             updated_at = NOW()
       RETURNING connection_id`,
      [`amazon-${regionConfig.region}`, regionConfig.region, regionConfig.marketplaceIds],
    );
    const connectionId = connRows[0]!.connection_id;

    // withSyncRun (PR #102) finalises the sync_run row on both success AND
    // failure paths — preventing the 'running'-forever zombies migration 0037
    // had to clean up retroactively.
    await withSyncRun(pg, {
      connectionId,
      source: 'amazon_sp_api',
      object: 'financial_events',
      mode: 'backfill',
      windowStart: fromDate,
      windowEnd: toDate,
    }, async (run) => {
      const startedAt = Date.now();
      const result = await ingestFinancialEventsWindow({
        spClient,
        pg,
        connectionId,
        syncRunId: run.syncRunId,
        marketplaceIds: [marketplaceTag],
        marketplaceTag,
        postedAfter: fromDate,
        postedBefore: toDate,
      });

      run.setRowsFetched(result.rowsParsed);
      run.setRowsUpserted(result.rowsUpserted);

      const durationMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
      console.log('');
      console.log(
        `Done in ${durationMin} min. ${result.pagesFetched} page(s), ` +
        `${result.rowsParsed} row(s) parsed, ${result.rowsUpserted} upserted, ` +
        `${result.rowsSkippedDuplicate} skipped (already present).`,
      );
      console.log('');
      console.log('By event type:');
      for (const [et, n] of Object.entries(result.byEventType).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${et.padEnd(28)} ${String(n).padStart(6)} row(s)`);
      }
    });
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
