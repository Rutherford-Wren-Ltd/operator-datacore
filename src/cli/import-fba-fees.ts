#!/usr/bin/env tsx
// ============================================================================
// import-fba-fees.ts
// Pulls the per-unit FBA fulfilment fee for every catalogue ASIN via SP-API
// getMyFeesEstimates and writes it to brain.sku_master.fba_fee — the figure
// that closes the CM3 calculation (the restock engine's margin gate, /sku-audit).
//
// Usage:
//   npm run import-fba-fees                              # UK marketplace (default)
//   npm run import-fba-fees -- --marketplace ATVPDKIKX0DER   # US
//   npm run import-fba-fees -- --dry-run                 # hit the API, no DB write
//
// fba_fee is one value per SKU in brain.sku_master — the fee in the SKU's
// reference marketplace. RW's COGS currency is GBP, so the UK marketplace is
// the default. The masters CSV import (import-masters) no longer overwrites a
// non-NULL fba_fee with a blank cell, so this CLI and a manual CSV value
// coexist — see migration note in import-masters.ts.
// ============================================================================

import { parseArgs } from 'node:util';
import { loadEnvForAmazonShared, getSpApiRegionConfig, type SpApiRegion } from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { SpApiClient, SpApiError } from '../lib/sp-api/client.js';
import { fetchFbaFulfilmentFees } from '../lib/sp-api/fees.js';

// Marketplace -> SP-API region + listing currency. Covers RW's nine
// marketplaces (Emporium UK/DE/FR/IT/ES + Muldale NL/SE/PL/TR) plus NA/JP.
const MARKETPLACES: Record<string, { region: SpApiRegion; currency: string; label: string }> = {
  A1F83G8C2ARO7P: { region: 'eu', currency: 'GBP', label: 'UK' },
  A1PA6795UKMFR9: { region: 'eu', currency: 'EUR', label: 'DE' },
  A13V1IB3VIYZZH: { region: 'eu', currency: 'EUR', label: 'FR' },
  APJ6JRA9NG5V4:  { region: 'eu', currency: 'EUR', label: 'IT' },
  A1RKKUPIHCS9HS: { region: 'eu', currency: 'EUR', label: 'ES' },
  A1805IZSGTT6HS: { region: 'eu', currency: 'EUR', label: 'NL' },
  A2NODRKZP88ZB9: { region: 'eu', currency: 'SEK', label: 'SE' },
  A1C3SOZRARQ6R3: { region: 'eu', currency: 'PLN', label: 'PL' },
  A33AVAJ2PDY3EV: { region: 'eu', currency: 'TRY', label: 'TR' },
  ATVPDKIKX0DER:  { region: 'na', currency: 'USD', label: 'US' },
  A2EUQ1WTGCTBG2: { region: 'na', currency: 'CAD', label: 'CA' },
  A1AM78C64UM0Y8: { region: 'na', currency: 'MXN', label: 'MX' },
  A1VC38T7YXB528: { region: 'fe', currency: 'JPY', label: 'JP' },
};
const DEFAULT_MARKETPLACE = 'A1F83G8C2ARO7P';   // UK — RW's COGS currency is GBP

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      marketplace: { type: 'string' },
      'dry-run':   { type: 'boolean', default: false },
    },
  });

  const marketplaceId = values.marketplace ?? DEFAULT_MARKETPLACE;
  const dryRun = !!values['dry-run'];
  const mkt = MARKETPLACES[marketplaceId];
  if (!mkt) {
    console.error(`Error: unknown --marketplace "${marketplaceId}".`);
    console.error(`Known: ${Object.keys(MARKETPLACES).join(', ')}`);
    process.exit(1);
  }

  console.log('operator-datacore — import FBA fulfilment fees');
  console.log('-----------------------------------------------');
  console.log(`  Marketplace:  ${marketplaceId} (${mkt.label})`);
  console.log(`  Region:       ${mkt.region}   Currency: ${mkt.currency}`);
  console.log(`  Dry-run:      ${dryRun}`);
  console.log('');

  const env = loadEnvForAmazonShared();
  const regionConfig = getSpApiRegionConfig(mkt.region, env);
  const spClient = new SpApiClient({
    region: mkt.region,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: regionConfig.refreshToken,
  });

  const pg = await getPgClient();
  try {
    const { rows } = await pg.query<{ asin: string }>(
      'SELECT DISTINCT asin FROM brain.sku_master WHERE asin IS NOT NULL ORDER BY asin',
    );
    const asins = rows.map((r) => r.asin);
    if (asins.length === 0) {
      console.log('No ASINs in brain.sku_master — nothing to do. Run import-masters first.');
      return;
    }
    console.log(`${asins.length} distinct ASIN(s) to estimate.`);
    console.log('');

    let result;
    try {
      result = await fetchFbaFulfilmentFees({
        spClient,
        marketplaceId,
        currencyCode: mkt.currency,
        asins,
        onBatch: (i) => console.log(
          `  ${i.pass > 0 ? `retry ${i.pass} ` : ''}batch ${i.batch}/${i.totalBatches}: `
          + `${i.ok} ok, ${i.failed} failed`),
      });
    } catch (err) {
      if (err instanceof SpApiError && err.status === 403) {
        console.error('');
        console.error('SP-API 403 — the Product Fees API role is not granted to this app.');
        console.error('Grant it in Seller Central → Apps & Services → Develop Apps → your app →');
        console.error('edit app → add the "Pricing" role, then re-authorise the app. Then re-run.');
        process.exit(1);
      }
      throw err;
    }

    console.log('');
    console.log(`Estimated ${result.fees.size} FBA fee(s); ${result.failures.length} failure(s).`);

    if (dryRun) {
      console.log('');
      console.log('--dry-run — no database writes. Sample of estimated fees:');
      let n = 0;
      for (const [asin, fee] of result.fees) {
        if (n >= 15) break;
        console.log(`  ${asin}   ${mkt.currency} ${fee.toFixed(2)}`);
        n += 1;
      }
      if (result.failures.length) {
        console.log('');
        console.log(`${result.failures.length} failure(s):`);
        for (const f of result.failures.slice(0, 20)) console.log(`  ${f.asin}: ${f.reason}`);
        if (result.failures.length > 20) console.log(`  ... and ${result.failures.length - 20} more`);
      }
      return;
    }

    // --- Bookkeeping + write -------------------------------------------------
    const { rows: connRows } = await pg.query<{ connection_id: string }>(
      `INSERT INTO meta.connection (source, label, region, marketplace_ids, status)
       VALUES ('amazon_sp_api', $1, $2, $3, 'active')
       ON CONFLICT (source, label) DO UPDATE
         SET region = EXCLUDED.region, marketplace_ids = EXCLUDED.marketplace_ids,
             last_health_check_at = NOW(), last_health_check_ok = TRUE, updated_at = NOW()
       RETURNING connection_id`,
      [`amazon-${mkt.region}`, mkt.region, [marketplaceId]],
    );
    const { rows: runRows } = await pg.query<{ sync_run_id: string }>(
      `INSERT INTO meta.sync_run (connection_id, source, object, mode, window_start, window_end)
       VALUES ($1, 'amazon_sp_api', 'fba_fees', 'manual', NOW(), NOW())
       RETURNING sync_run_id`,
      [connRows[0]!.connection_id],
    );
    const syncRunId = runRows[0]!.sync_run_id;
    const startedAt = Date.now();

    let updated = 0;
    await pg.query('BEGIN');
    for (const [asin, fee] of result.fees) {
      const r = await pg.query(
        'UPDATE brain.sku_master SET fba_fee = $1, updated_at = NOW() WHERE asin = $2',
        [fee, asin],
      );
      updated += r.rowCount ?? 0;
    }
    for (const f of result.failures) {
      await pg.query(
        `INSERT INTO meta.sync_log (sync_run_id, level, message, payload)
         VALUES ($1, 'warn', $2, $3)`,
        [syncRunId, `FBA fee estimate failed for ASIN ${f.asin}: ${f.reason}`,
          JSON.stringify({ asin: f.asin, reason: f.reason })],
      );
    }
    await pg.query('COMMIT');

    // meta.sync_run.duration_ms is a GENERATED column — never write it.
    await pg.query(
      `UPDATE meta.sync_run
         SET finished_at = NOW(), status = 'success', rows_fetched = $2, rows_upserted = $3
       WHERE sync_run_id = $1`,
      [syncRunId, result.fees.size, updated],
    );

    console.log('');
    console.log(`Done. Wrote fba_fee to ${updated} brain.sku_master row(s) `
      + `(${result.fees.size} ASIN(s) priced).`);
    if (result.failures.length) {
      console.log(`${result.failures.length} failure(s) logged to meta.sync_log.`);
    }
    console.log(`\nsync_run_id ${syncRunId} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {});
    console.error('import-fba-fees failed:', err);
    process.exit(1);
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
