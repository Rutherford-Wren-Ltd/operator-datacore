#!/usr/bin/env tsx
// ============================================================================
// ads-probe.ts
// Verifies Amazon Ads API credentials by calling GET /v2/profiles.
//
// What this proves if it passes:
//   - LWA Client ID + Secret are valid (token exchange succeeds)
//   - Refresh token is valid (not expired, not revoked)
//   - The Ads API access role is actually granted on the LWA app
//   - The configured profile ID (if any) matches a profile this account
//     can access in the chosen region
//
// Usage:
//   npm run ads-probe                  # primary region from ADS_API_REGION
//   npm run ads-probe -- --region NA   # explicit region override (NA|EU|FE)
// ============================================================================

import { parseArgs } from 'node:util';
import {
  loadEnvForAdsShared,
  getAdsApiRegionConfig,
  type AdsApiRegion,
} from '../lib/env.js';
import { AdsApiClient, AdsApiError } from '../lib/ads-api/client.js';
import { getProfiles } from '../lib/ads-api/profiles.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      region: { type: 'string' },
    },
  });

  const env = loadEnvForAdsShared();
  const region: AdsApiRegion = (values.region as AdsApiRegion | undefined) ?? env.ADS_API_REGION;
  if (region !== 'NA' && region !== 'EU' && region !== 'FE') {
    throw new Error(`--region must be one of: NA, EU, FE. Got "${region}".`);
  }
  const config = getAdsApiRegionConfig(region, env);

  console.log('operator-datacore — Amazon Ads API probe');
  console.log('-----------------------------------------');
  console.log(`  Region:        ${config.region}`);
  console.log(`  Endpoint:      ${config.endpoint}`);
  console.log(`  Configured profile: ${config.profileId ?? '(not set)'}`);
  console.log('');

  const client = new AdsApiClient({
    region: config.region,
    clientId: env.ADS_API_CLIENT_ID,
    clientSecret: env.ADS_API_CLIENT_SECRET,
    refreshToken: config.refreshToken,
    endpoint: config.endpoint,
    ...(config.profileId ? { profileId: config.profileId } : {}),
  });

  let profiles;
  try {
    profiles = await getProfiles(client);
  } catch (err) {
    if (err instanceof AdsApiError) {
      console.error(`FAILED — Ads API returned ${err.status}`);
      console.error('');
      console.error('Response:');
      console.error('  ' + err.responseText.slice(0, 1000));
      console.error('');
      if (err.status === 401) {
        console.error('Likely cause: refresh token expired or revoked, or Client ID/Secret mismatch.');
        console.error('Fix: re-run the OAuth flow in docs/runbooks/connect-amazon-ads.md (Step 3).');
      } else if (err.status === 403) {
        console.error('Likely cause: this LWA app does not have the Advertising API role granted.');
        console.error('Fix: log into the LWA app at developer.amazon.com/loginwithamazon and confirm the');
        console.error('     advertising scopes are attached. May also need to re-consent.');
      }
      process.exit(1);
    }
    throw err;
  }

  console.log(`Found ${profiles.length} profile(s):`);
  console.log('');
  for (const p of profiles) {
    console.log(`  profileId:    ${p.profileId}`);
    console.log(`  account:      ${p.accountInfo.name} (${p.accountInfo.type})`);
    console.log(`  marketplace:  ${p.accountInfo.marketplaceStringId}`);
    console.log(`  country:      ${p.countryCode}`);
    console.log(`  currency:     ${p.currencyCode}`);
    console.log(`  timezone:     ${p.timezone}`);
    console.log('');
  }

  if (config.profileId) {
    const configuredId = String(config.profileId);
    const match = profiles.find((p) => String(p.profileId) === configuredId);
    if (match) {
      console.log(`OK — ADS_${config.region === env.ADS_API_REGION ? '' : config.region + '_'}PROFILE_ID (${configuredId}) matches "${match.accountInfo.name}".`);
    } else {
      console.error(`WARNING — configured profile (${configuredId}) is not in the returned list for region ${config.region}.`);
      console.error('         The API call worked, but the configured profile is wrong for this region.');
      console.error('         Pick one of the profileIds above and update .env.');
      process.exit(1);
    }
  } else {
    console.log(`NOTE — no profile configured for region ${config.region}. Pick one of the profileIds above`);
    console.log(`       and add it to .env as ADS_API_${config.region}_PROFILE_ID`);
    console.log(`       (or as ADS_PROFILE_ID if this is your primary region).`);
  }

  console.log('');
  console.log(`Probe passed for region ${config.region}. Credentials are good.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
