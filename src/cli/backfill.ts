#!/usr/bin/env tsx
// ============================================================================
// backfill.ts
// Pulls historical Sales & Traffic data from SP-API into brain.sales_traffic_daily.
//
// Usage:
//   npm run backfill                     # last 30 days, all configured marketplaces
//   npm run backfill -- --months 6
//   npm run backfill -- --from 2024-01-01 --to 2024-03-31
//   npm run backfill -- --source amazon --report sales-traffic --months 24
//   npm run backfill -- --concurrency 1 --delay 30000   # gentler on the rate limit
//
// SP-API rate limits: the Sales & Traffic createReport quota is low (~1/min).
// --concurrency caps how many run at once; --delay adds a pause (ms) after each
// day so we stay under quota. Raise --delay if you hit 429 QuotaExceeded.
// ============================================================================

import { parseArgs } from 'node:util';
import { loadEnvForAmazon, getSpApiRegionConfig, type SpApiRegion } from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { backfillSalesTraffic } from '../lib/sp-api/sales-traffic.js';

interface ParsedArgs {
  source: string;
  report: string;
  months: number;
  from: Date | null;
  to: Date | null;
  concurrency: number;
  delayMs: number;
  region: SpApiRegion | null;
}

function parseCliArgs(): ParsedArgs {
  const { values } = parseArgs({
    options: {
      source: { type: 'string', default: 'amazon' },
      report: { type: 'string', default: 'sales-traffic' },
      months: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      concurrency: { type: 'string', default: '3' },
      delay: { type: 'string', default: '2000' },
      region: { type: 'string' },
    },
  });

  const months = values.months ? parseInt(values.months, 10) : 1;
  const from = values.from ? new Date(values.from + 'T00:00:00Z') : null;
  const to = values.to ? new Date(values.to + 'T23:59:59Z') : null;
  const concurrency = parseInt(values.concurrency!, 10);
  const delayMs = parseInt(values.delay!, 10);
  let region: SpApiRegion | null = null;
  if (values.region !== undefined) {
    if (values.region !== 'na' && values.region !== 'eu' && values.region !== 'fe') {
      throw new Error(`--region must be one of: na, eu, fe. Got "${values.region}".`);
    }
    region = values.region;
  }

  return { source: values.source!, report: values.report!, months, from, to, concurrency, delayMs, region };
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  if (args.source !== 'amazon') {
    console.error(`Source "${args.source}" is scaffolded but not active in v1. See docs/runbooks/connect-${args.source}.md`);
    process.exit(2);
  }
  if (args.report !== 'sales-traffic') {
    console.error(`Report "${args.report}" is scaffolded but not active in v1. See docs/canonical-reports.md`);
    process.exit(2);
  }

  const env = loadEnvForAmazon();
  const region: SpApiRegion = args.region ?? env.SP_API_REGION;
  const regionConfig = getSpApiRegionConfig(region, env);
  const marketplaceIds = regionConfig.marketplaceIds;

  // Window: --from/--to take precedence over --months
  let fromDate: Date;
  let toDate: Date;
  if (args.from && args.to) {
    fromDate = args.from;
    toDate = args.to;
  } else {
    // Default: from N months ago, to yesterday (skip CURRENT_DATE per house rule)
    const now = new Date();
    toDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 23, 59, 59));
    const monthsBack = args.months;
    fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, now.getUTCDate(), 0, 0, 0));
  }

  console.log('operator-datacore — Sales & Traffic backfill');
  console.log('---------------------------------------------');
  console.log(`  Region:        ${regionConfig.region}`);
  console.log(`  Marketplaces:  ${marketplaceIds.join(', ')}`);
  console.log(`  Window:        ${fromDate.toISOString().slice(0, 10)} → ${toDate.toISOString().slice(0, 10)}`);
  console.log(`  Concurrency:   ${args.concurrency}`);
  console.log(`  Delay:         ${args.delayMs}ms between days`);
  console.log('');

  const spClient = new SpApiClient({
    region: regionConfig.region,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: regionConfig.refreshToken,
  });
  const pg = await getPgClient();

  try {
    // 1. Ensure a connection row exists
    const { rows: connRows } = await pg.query<{ connection_id: string }>(
      `INSERT INTO meta.connection (source, label, region, marketplace_ids, status)
       VALUES ('amazon_sp_api', $1, $2, $3, 'active')
       ON CONFLICT (source, label) DO UPDATE
         SET region = EXCLUDED.region, marketplace_ids = EXCLUDED.marketplace_ids,
             last_health_check_at = NOW(), last_health_check_ok = TRUE,
             updated_at = NOW()
       RETURNING connection_id`,
      [`amazon-${regionConfig.region}`, regionConfig.region, marketplaceIds],
    );
    const connectionId = connRows[0]!.connection_id;

    // 2. Open a sync run
    const { rows: runRows } = await pg.query<{ sync_run_id: string }>(
      `INSERT INTO meta.sync_run (connection_id, source, object, mode, window_start, window_end)
       VALUES ($1, 'amazon_sp_api', 'sales_traffic_report', 'backfill', $2, $3)
       RETURNING sync_run_id`,
      [connectionId, fromDate.toISOString(), toDate.toISOString()],
    );
    const syncRunId = runRows[0]!.sync_run_id;

    // 3. Run the backfill
    const startedAt = Date.now();
    const result = await backfillSalesTraffic({
      spClient,
      pg,
      connectionId,
      syncRunId,
      marketplaceIds,
      fromDate,
      toDate,
      concurrency: args.concurrency,
      delayMs: args.delayMs,
      onProgress: (info) => {
        const pct = ((info.done / info.total) * 100).toFixed(1).padStart(5);
        console.log(`  [${pct}%] ${info.day} ${info.marketplace.padEnd(15)} → ${info.rows} ASIN rows`);
      },
    });

    const durationMin = ((Date.now() - startedAt) / 60_000).toFixed(1);

    await pg.query(
      `UPDATE meta.sync_run
         SET finished_at = NOW(), status = 'success',
             rows_fetched = $2, rows_upserted = $2
       WHERE sync_run_id = $1`,
      [syncRunId, result.totalRows],
    );

    console.log('');
    console.log(`Done in ${durationMin} min. ${result.totalDays} days × ${marketplaceIds.length} marketplaces, ${result.totalRows} ASIN rows upserted.`);
    console.log('Next: run  npm run verify  to compare against Seller Central.');
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
