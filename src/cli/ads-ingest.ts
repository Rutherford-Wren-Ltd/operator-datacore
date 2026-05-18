#!/usr/bin/env tsx
// ============================================================================
// ads-ingest.ts
// Pulls Amazon Ads advertised-product reports and upserts into:
//   - brain.ads_sp_daily (Sponsored Products)
//   - brain.ads_sd_daily (Sponsored Display)
//
// Defaults to yesterday's data (Ads reports for "today" are not ready until
// late evening; sticking to D-1 avoids partial-day rows).
//
// Usage:
//   npm run ads-ingest                          # yesterday, SP + SD, primary region
//   npm run ads-ingest -- --region NA           # primary-region default, NA override
//   npm run ads-ingest -- --days 7              # last 7 days, SP + SD
//   npm run ads-ingest -- --date 2026-05-14     # one specific date
//   npm run ads-ingest -- --products SP         # SP only
//   npm run ads-ingest -- --products SD         # SD only
//
// SP and SD reports for the same date are kicked off in parallel — each
// spends 5-15 min waiting on Amazon's report queue, and they sit on
// separate quota buckets, so running concurrently roughly halves wall time.
// ============================================================================

import { parseArgs } from 'node:util';
import {
  loadEnvForAdsShared,
  getAdsApiRegionConfig,
  type AdsApiRegion,
} from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { AdsApiClient } from '../lib/ads-api/client.js';
import { getProfiles } from '../lib/ads-api/profiles.js';
import { ingestSpDaily } from '../lib/ads-api/sp-ingest.js';
import { ingestSdDaily } from '../lib/ads-api/sd-ingest.js';

type AdProductKey = 'SP' | 'SD';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      date: { type: 'string' },
      days: { type: 'string' },
      products: { type: 'string' },
      region: { type: 'string' },
    },
  });

  const env = loadEnvForAdsShared();
  const region: AdsApiRegion = (values.region as AdsApiRegion | undefined) ?? env.ADS_API_REGION;
  if (region !== 'NA' && region !== 'EU' && region !== 'FE') {
    throw new Error(`--region must be one of: NA, EU, FE. Got "${region}".`);
  }
  const config = getAdsApiRegionConfig(region, env);
  if (!config.profileId) {
    throw new Error(
      `No Ads profile configured for region ${region}. Run "npm run ads-probe -- --region ${region}" to discover profiles, then set ADS_API_${region}_PROFILE_ID in .env.`,
    );
  }

  const dates = resolveDates(values.date, values.days);
  const products = resolveProducts(values.products);

  console.log('operator-datacore — Amazon Ads ingest');
  console.log('--------------------------------------');
  console.log(`  Region:        ${config.region}`);
  console.log(`  Endpoint:      ${config.endpoint}`);
  console.log(`  Profile ID:    ${config.profileId}`);
  console.log(`  Products:      ${products.join(', ')}`);
  console.log(`  Dates:         ${dates[0]}${dates.length > 1 ? ` … ${dates[dates.length - 1]} (${dates.length} day${dates.length === 1 ? '' : 's'})` : ''}`);
  console.log('');

  const adsClient = new AdsApiClient({
    region: config.region,
    clientId: env.ADS_API_CLIENT_ID,
    clientSecret: env.ADS_API_CLIENT_SECRET,
    refreshToken: config.refreshToken,
    profileId: config.profileId,
    endpoint: config.endpoint,
  });

  const profiles = await getProfiles(adsClient);
  const profile = profiles.find((p) => String(p.profileId) === String(config.profileId));
  if (!profile) {
    throw new Error(
      `Profile ${config.profileId} not in /v2/profiles response for region ${region}. Run "npm run ads-probe -- --region ${region}" to see valid IDs.`,
    );
  }
  console.log(`  Account:       ${profile.accountInfo.name} (${profile.countryCode}, ${profile.currencyCode})`);
  console.log('');

  const pg = await getPgClient();

  try {
    const startedAt = Date.now();
    const totals: Record<AdProductKey, number> = { SP: 0, SD: 0 };

    for (const date of dates) {
      console.log(`Date ${date}:`);
      const pollLogger = (label: string) => ({
        onPoll: ({ attempt, status, elapsedMs }: { attempt: number; status: string; elapsedMs: number }) => {
          console.log(`  [${label}] poll ${attempt}: status=${status} (${Math.round(elapsedMs / 1000)}s elapsed)`);
        },
      });

      const jobs: Array<Promise<{ product: AdProductKey; rows: number; reportId: string }>> = [];
      if (products.includes('SP')) {
        jobs.push(
          ingestSpDaily({
            adsClient,
            pg,
            profileId: config.profileId,
            startDate: date,
            endDate: date,
            currencyCode: profile.currencyCode,
            poll: pollLogger('SP'),
          }).then((r) => ({ product: 'SP' as AdProductKey, rows: r.rowsUpserted, reportId: r.reportId })),
        );
      }
      if (products.includes('SD')) {
        jobs.push(
          ingestSdDaily({
            adsClient,
            pg,
            profileId: config.profileId,
            startDate: date,
            endDate: date,
            currencyCode: profile.currencyCode,
            poll: pollLogger('SD'),
          }).then((r) => ({ product: 'SD' as AdProductKey, rows: r.rowsUpserted, reportId: r.reportId })),
        );
      }

      const results = await Promise.all(jobs);
      for (const r of results) {
        console.log(`  [${r.product}] done: ${r.rows} row(s) upserted (reportId ${r.reportId})`);
        totals[r.product] += r.rows;
      }
    }

    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log('');
    console.log(`Done in ${durationSec}s.`);
    for (const p of products) {
      console.log(`  ${p}: ${totals[p]} row(s) total → brain.ads_${p.toLowerCase()}_daily`);
    }
    console.log('Next: /sku-audit will produce a real TACoS score for advertised ASINs.');
  } finally {
    await pg.end();
  }
}

function resolveDates(date: string | undefined, days: string | undefined): string[] {
  if (date) return [date];

  const n = days ? Math.max(1, Math.min(30, parseInt(days, 10))) : 1;
  const out: string[] = [];
  const now = new Date();
  for (let i = 1; i <= n; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function resolveProducts(products: string | undefined): AdProductKey[] {
  if (!products) return ['SP', 'SD'];
  const parsed = products
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is AdProductKey => s === 'SP' || s === 'SD');
  if (parsed.length === 0) {
    throw new Error(`--products must be a comma-separated list of: SP, SD. Got "${products}".`);
  }
  return parsed;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
