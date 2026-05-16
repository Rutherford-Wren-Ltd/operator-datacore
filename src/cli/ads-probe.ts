#!/usr/bin/env tsx
// ============================================================================
// ads-probe.ts
// Verifies Amazon Ads API credentials by calling GET /v2/profiles.
//
// What this proves if it passes:
//   - LWA Client ID + Secret are valid (token exchange succeeds)
//   - Refresh token is valid (not expired, not revoked)
//   - The Ads API access role is actually granted on the LWA app
//   - The Profile ID in .env matches a profile this account can access
//
// Usage:
//   npm run ads-probe
// ============================================================================

import { loadEnvForAds } from '../lib/env.js';
import { AdsApiClient, AdsApiError } from '../lib/ads-api/client.js';
import { getProfiles } from '../lib/ads-api/profiles.js';

async function main(): Promise<void> {
  const env = loadEnvForAds();

  console.log('operator-datacore — Amazon Ads API probe');
  console.log('-----------------------------------------');
  console.log(`  Region:        ${env.ADS_API_REGION}`);
  console.log(`  Endpoint:      ${env.ADS_API_ENDPOINT ?? '(derived from region)'}`);
  console.log(`  Configured profile: ${env.ADS_PROFILE_ID ?? '(not set)'}`);
  console.log('');

  const client = new AdsApiClient({
    region: env.ADS_API_REGION,
    clientId: env.ADS_API_CLIENT_ID,
    clientSecret: env.ADS_API_CLIENT_SECRET,
    refreshToken: env.ADS_API_REFRESH_TOKEN,
    ...(env.ADS_API_ENDPOINT ? { endpoint: env.ADS_API_ENDPOINT } : {}),
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

  if (env.ADS_PROFILE_ID) {
    const configuredId = String(env.ADS_PROFILE_ID);
    const match = profiles.find((p) => String(p.profileId) === configuredId);
    if (match) {
      console.log(`OK — ADS_PROFILE_ID (${configuredId}) matches "${match.accountInfo.name}".`);
    } else {
      console.error(`WARNING — ADS_PROFILE_ID (${configuredId}) is not in the returned list.`);
      console.error('         The API call worked, but the configured profile is wrong.');
      console.error('         Pick one of the profileIds above and update .env.');
      process.exit(1);
    }
  } else {
    console.log('NOTE — ADS_PROFILE_ID is not set. Pick one of the profileIds above and add it to .env.');
  }

  console.log('');
  console.log('Probe passed. Credentials are good. Safe to build the SP/SB/SD report ingest libs.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
