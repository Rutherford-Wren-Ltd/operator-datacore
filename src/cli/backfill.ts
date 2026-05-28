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
//   npm run backfill -- --region eu --marketplaces UK --from 2024-10-01 --to 2024-12-31 --skip-existing
//   npm run backfill -- --skip-existing  # skip (marketplace, day) pairs already in lake
//
// --marketplaces accepts comma-separated short codes (UK, US, DE, …) or raw
// marketplace IDs, and must stay inside the chosen --region (cross-region runs
// require their own refresh token, so issue one CLI invocation per region).
//
// SP-API rate limits (confirmed by Amazon 2026-05-26): the createReport quota
// for GET_SALES_AND_TRAFFIC_REPORT is permanently 1 call per 15 minutes,
// app-wide. backfillSalesTraffic enforces this with a hard floor; --concurrency
// and --delay CLI flags cannot weaken it. Plan accordingly: a 24-month UK+US
// backfill is ~14 days of clock time.
// ============================================================================

import { parseArgs } from 'node:util';
import { loadEnvForAmazonShared, getSpApiRegionConfig, type SpApiRegion } from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { backfillSalesTraffic } from '../lib/sp-api/sales-traffic.js';

// Short-code aliases for the marketplace IDs Amazon assigns. Operator types
// `--marketplaces UK,US`; we resolve to the canonical IDs. Raw IDs are also
// accepted and pass through unchanged.
const MARKETPLACE_ALIASES: Record<string, string> = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  UK: 'A1F83G8C2ARO7P',
  GB: 'A1F83G8C2ARO7P',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  IT: 'APJ6JRA9NG5V4',
  ES: 'A1RKKUPIHCS9HS',
  NL: 'A1805IZSGTT6HS',
  SE: 'A2NODRKZP88ZB9',
  PL: 'A1C3SOZRARQ6R3',
  TR: 'A33AVAJ2PDY3EV',
  JP: 'A1VC38T7YXB528',
};

function resolveMarketplaceFilter(raw: string | undefined): string[] | null {
  if (!raw) return null;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((tok) => {
    const upper = tok.toUpperCase();
    return MARKETPLACE_ALIASES[upper] ?? tok;
  });
}

interface ParsedArgs {
  source: string;
  report: string;
  months: number;
  from: Date | null;
  to: Date | null;
  concurrency: number;
  delayMs: number;
  region: SpApiRegion | null;
  marketplaceFilter: string[] | null;
  skipExisting: boolean;
}

function parseCliArgs(): ParsedArgs {
  const { values } = parseArgs({
    options: {
      source: { type: 'string', default: 'amazon' },
      report: { type: 'string', default: 'sales-traffic' },
      months: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      // For sales-traffic these CLI values are clamped by backfillSalesTraffic to
      // honour the permanent 1/15-min limit. Defaults reflect that ceiling so a
      // bare `npm run backfill` is already safe.
      concurrency: { type: 'string', default: '1' },
      delay: { type: 'string', default: '900000' },
      region: { type: 'string' },
      marketplaces: { type: 'string' },
      'skip-existing': { type: 'boolean', default: false },
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

  return {
    source: values.source!,
    report: values.report!,
    months,
    from,
    to,
    concurrency,
    delayMs,
    region,
    marketplaceFilter: resolveMarketplaceFilter(values.marketplaces),
    skipExisting: values['skip-existing'] ?? false,
  };
}

async function loadExistingKeys(
  pg: import('pg').Client,
  marketplaceIds: string[],
  fromDate: Date,
  toDate: Date,
): Promise<Set<string>> {
  // Cast metric_date to text in SQL so node-postgres never parses it through
  // its DATE → JS Date converter. That converter builds the Date at LOCAL
  // midnight, which then shifts back a day when we call .toISOString() in
  // any non-UTC timezone (BST = -1 day, UTC+1 = -1 day, etc.). The text cast
  // bypasses the trap entirely; the comparison is now string-vs-string with
  // the day-based task keys built in UTC below.
  const { rows } = await pg.query<{ marketplace_id: string; metric_date: string }>(
    `SELECT DISTINCT marketplace_id, to_char(metric_date, 'YYYY-MM-DD') AS metric_date
       FROM brain.sales_traffic_daily
      WHERE marketplace_id = ANY($1)
        AND metric_date BETWEEN $2 AND $3`,
    [marketplaceIds, fromDate.toISOString().slice(0, 10), toDate.toISOString().slice(0, 10)],
  );
  const keys = new Set<string>();
  for (const r of rows) {
    keys.add(`${r.marketplace_id}|${r.metric_date}`);
  }
  return keys;
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

  const env = loadEnvForAmazonShared();
  const region: SpApiRegion = args.region ?? env.SP_API_REGION;
  const regionConfig = getSpApiRegionConfig(region, env);
  let marketplaceIds = regionConfig.marketplaceIds;

  if (args.marketplaceFilter) {
    const outOfRegion = args.marketplaceFilter.filter((id) => !marketplaceIds.includes(id));
    if (outOfRegion.length > 0) {
      throw new Error(
        `--marketplaces requested ${outOfRegion.join(', ')} which are not configured for region ` +
        `'${region}'. Region ${region} has: ${marketplaceIds.join(', ')}. ` +
        `Cross-region runs must be issued separately (each region uses its own SP-API refresh token).`,
      );
    }
    marketplaceIds = args.marketplaceFilter;
  }

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
  console.log(`  Concurrency:   ${args.concurrency}  (clamped to 1 for sales-traffic)`);
  console.log(`  Delay:         ${args.delayMs}ms  (clamped to >= 900000 for sales-traffic)`);
  console.log(`  Skip existing: ${args.skipExisting}`);
  console.log('');

  const spClient = new SpApiClient({
    region: regionConfig.region,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: regionConfig.refreshToken,
  });
  // `pg` is reassigned if backfillSalesTraffic's keepalive had to reconnect
  // mid-run (Supabase pooler eviction or network blip). Anything we touch
  // post-backfill — the sync_run UPDATE, the finally end() — uses this var.
  let pg = await getPgClient();

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

    // 3. Optionally load already-ingested (marketplace, day) keys to skip
    let existingKeys: Set<string> | undefined;
    if (args.skipExisting) {
      existingKeys = await loadExistingKeys(pg, marketplaceIds, fromDate, toDate);
      console.log(`  Skip set:      ${existingKeys.size} (marketplace, day) pairs already present`);
      console.log('');
    }

    // 4. Run the backfill
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
      ...(existingKeys ? { existingKeys } : {}),
      onProgress: (info) => {
        const pct = ((info.done / info.total) * 100).toFixed(1).padStart(5);
        console.log(`  [${pct}%] ${info.day} ${info.marketplace.padEnd(15)} → ${info.rows} ASIN rows`);
      },
    });

    const durationMin = ((Date.now() - startedAt) / 60_000).toFixed(1);

    // Swap to the (possibly reconnected) client backfillSalesTraffic ended up
    // using. Without this the sync_run UPDATE below would target a dead client
    // if the original was evicted mid-run.
    pg = result.pg;

    await pg.query(
      `UPDATE meta.sync_run
         SET finished_at = NOW(), status = 'success',
             rows_fetched = $2, rows_upserted = $2
       WHERE sync_run_id = $1`,
      [syncRunId, result.totalRows],
    );

    console.log('');
    console.log(
      `Done in ${durationMin} min. ${result.tasksRun} call(s) made, ${result.tasksSkipped} skipped, ` +
      `${result.totalRows} ASIN rows upserted across ${marketplaceIds.length} marketplace(s).`,
    );
    console.log('Next: run  npm run verify  to compare against Seller Central.');
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
