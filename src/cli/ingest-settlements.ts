#!/usr/bin/env tsx
// ============================================================================
// ingest-settlements.ts
// Pulls Amazon's auto-generated GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2
// reports into brain.settlements + brain.settlement_lines.
//
// What this is for: settled actuals at the bank-deposit level. Amazon
// auto-generates one report per settlement cycle (~14 days). We can't request
// these — we can only list and ingest what Amazon has already produced.
//
// Pairs with brain.financial_events (#75 — listFinancialEvents):
//   - financial_events:  per-event posted as-they-happen, real-time
//   - settlements:       fortnightly cycle reconciled to bank deposit
//
// Both live in the lake; the right one depends on the question.
//
// Usage:
//   npm run ingest-settlements                                 # last 180 days
//   npm run ingest-settlements -- --since 2025-01-01
//   npm run ingest-settlements -- --region na --marketplaces US
//   npm run ingest-settlements -- --dry-run
//
// Idempotency: re-runs are safe. The connector skips any settlement whose
// raw.sp_api_report row already has parsed_at set; and brain.settlement_lines
// has a deterministic line_hash that makes line-level upserts a no-op on
// re-pull.
// ============================================================================

import { parseArgs } from 'node:util';
import { loadEnvForAmazonShared, getSpApiRegionConfig, type SpApiRegion } from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { ingestAvailableSettlements } from '../lib/sp-api/settlements.js';

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

function resolveMarketplaceFilter(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((tok) => {
    const upper = tok.toUpperCase();
    return MARKETPLACE_ALIASES[upper] ?? tok;
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      since:         { type: 'string' },
      region:        { type: 'string' },
      marketplaces:  { type: 'string' },
      'dry-run':     { type: 'boolean', default: false },
    },
  });

  const since = values.since ? new Date(values.since + 'T00:00:00Z') : null;

  const env = loadEnvForAmazonShared();
  let region: SpApiRegion = env.SP_API_REGION;
  if (values.region !== undefined) {
    if (values.region !== 'na' && values.region !== 'eu' && values.region !== 'fe') {
      throw new Error(`--region must be one of: na, eu, fe. Got "${values.region}".`);
    }
    region = values.region;
  }
  const regionConfig = getSpApiRegionConfig(region, env);
  const marketplaceFilter = resolveMarketplaceFilter(values.marketplaces);

  console.log('operator-datacore — Amazon Settlements ingest');
  console.log('----------------------------------------------');
  console.log(`  Region:           ${regionConfig.region}`);
  console.log(`  Marketplace filter:  ${marketplaceFilter.length ? marketplaceFilter.join(', ') : '(none — accept all)'}`);
  console.log(`  Created since:    ${since ? since.toISOString().slice(0, 10) : '180 days back (default)'}`);
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

    const { rows: runRows } = await pg.query<{ sync_run_id: string }>(
      `INSERT INTO meta.sync_run (connection_id, source, object, mode, window_start, window_end)
       VALUES ($1, 'amazon_sp_api', 'settlement_report', 'backfill', $2, $3)
       RETURNING sync_run_id`,
      [connectionId, since?.toISOString() ?? null, new Date().toISOString()],
    );
    const syncRunId = runRows[0]!.sync_run_id;

    const startedAt = Date.now();
    const result = await ingestAvailableSettlements({
      spClient,
      pg,
      connectionId,
      syncRunId,
      ...(since ? { since } : {}),
      marketplaceIds: marketplaceFilter,
    });

    await pg.query(
      `UPDATE meta.sync_run
         SET finished_at = NOW(),
             status      = $2,
             rows_fetched = $3,
             rows_upserted = $4
       WHERE sync_run_id = $1`,
      [
        syncRunId,
        result.failures.length === 0 ? 'success' : 'partial',
        result.linesInserted,
        result.linesInserted,
      ],
    );

    const durationMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
    console.log('');
    console.log(
      `Done in ${durationMin} min. ${result.reportsListed} report(s) listed, ` +
      `${result.reportsIngested} ingested, ${result.reportsSkipped} skipped (already present), ` +
      `${result.failures.length} failed.`,
    );
    console.log(`  Settlements upserted: ${result.settlementsUpserted}`);
    console.log(`  Lines inserted:       ${result.linesInserted}`);

    if (result.failures.length > 0) {
      console.error('');
      console.error(`${result.failures.length} report(s) failed:`);
      for (const f of result.failures) {
        console.error(`  ${f.reportId}: ${f.error}`);
      }
      process.exitCode = 1;
    }
  } finally {
    try { await pg.end(); } catch { /* */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
