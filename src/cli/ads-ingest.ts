#!/usr/bin/env tsx
// ============================================================================
// ads-ingest.ts
// Pulls Sponsored Products advertised-product reports from the Amazon Ads
// API and upserts into brain.ads_sp_daily.
//
// Defaults to yesterday's data (Ads reports for "today" are not ready until
// late evening; sticking to D-1 avoids partial-day rows).
//
// Usage:
//   npm run ads-ingest                # yesterday
//   npm run ads-ingest -- --days 7    # last 7 days (one report per day)
//   npm run ads-ingest -- --date 2026-05-14   # one specific date
// ============================================================================

import { parseArgs } from 'node:util';
import { loadEnvForAds } from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { AdsApiClient } from '../lib/ads-api/client.js';
import { getProfiles } from '../lib/ads-api/profiles.js';
import { ingestSpDaily } from '../lib/ads-api/sp-ingest.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      date: { type: 'string' },
      days: { type: 'string' },
    },
  });

  const env = loadEnvForAds();
  if (!env.ADS_PROFILE_ID) {
    throw new Error(
      'ADS_PROFILE_ID is not set in .env. Run "npm run ads-probe" to see available profile IDs.',
    );
  }

  const dates = resolveDates(values.date, values.days);

  console.log('operator-datacore — Amazon Ads SP ingest');
  console.log('-----------------------------------------');
  console.log(`  Region:        ${env.ADS_API_REGION}`);
  console.log(`  Profile ID:    ${env.ADS_PROFILE_ID}`);
  console.log(`  Dates:         ${dates[0]}${dates.length > 1 ? ` … ${dates[dates.length - 1]} (${dates.length} day${dates.length === 1 ? '' : 's'})` : ''}`);
  console.log('');

  const adsClient = new AdsApiClient({
    region: env.ADS_API_REGION,
    clientId: env.ADS_API_CLIENT_ID,
    clientSecret: env.ADS_API_CLIENT_SECRET,
    refreshToken: env.ADS_API_REFRESH_TOKEN,
    profileId: env.ADS_PROFILE_ID,
    ...(env.ADS_API_ENDPOINT ? { endpoint: env.ADS_API_ENDPOINT } : {}),
  });

  // Currency is per-profile (UK = GBP, DE = EUR, etc). Resolve via /v2/profiles
  // rather than env so the CLI works for any profile without config changes.
  const profiles = await getProfiles(adsClient);
  const profile = profiles.find((p) => String(p.profileId) === String(env.ADS_PROFILE_ID));
  if (!profile) {
    throw new Error(
      `ADS_PROFILE_ID ${env.ADS_PROFILE_ID} not in /v2/profiles response. Run "npm run ads-probe" to see valid IDs.`,
    );
  }
  console.log(`  Account:       ${profile.accountInfo.name} (${profile.countryCode}, ${profile.currencyCode})`);
  console.log('');

  const pg = await getPgClient();

  try {
    const startedAt = Date.now();
    let totalRows = 0;

    for (const date of dates) {
      console.log(`Date ${date}:`);
      const result = await ingestSpDaily({
        adsClient,
        pg,
        profileId: env.ADS_PROFILE_ID,
        startDate: date,
        endDate: date,
        currencyCode: profile.currencyCode,
        poll: {
          onPoll: ({ attempt, status, elapsedMs }) => {
            console.log(`  poll ${attempt}: status=${status} (${Math.round(elapsedMs / 1000)}s elapsed)`);
          },
        },
      });
      totalRows += result.rowsUpserted;
      console.log(`  done: ${result.rowsUpserted} row(s) upserted (reportId ${result.reportId})`);
    }

    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log('');
    console.log(`Done in ${durationSec}s. ${totalRows} SP-daily row(s) total.`);
    console.log('Next: /sku-audit will now produce a real TACoS score for advertised ASINs.');
  } finally {
    await pg.end();
  }
}

/**
 * Resolve the list of YYYY-MM-DD dates to pull. Most recent day first is fine
 * for backfill; iteration order doesn't matter to the upsert.
 *
 * "Yesterday" means UTC yesterday — Ads reports use UTC, and matching that
 * avoids off-by-one when the workflow runs at 15:00 UTC.
 */
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
