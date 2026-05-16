#!/usr/bin/env tsx
// ============================================================================
// ads-exchange-code.ts
// Two-phase Amazon Ads API OAuth helper, reading the LWA app's Client ID and
// Secret from .env so they never need to be typed (or echoed to a shell).
//
// Phase 1 — print authorisation URL:
//   npm run ads-exchange-code
//   → prints a https://www.amazon.com/ap/oa?... URL. Open it in a browser,
//     authorise the app, then look at the URL bar after Amazon redirects to
//     http://localhost:3000/callback?code=... (the page will fail to load —
//     that's fine; the code is in the URL bar).
//
// Phase 2 — exchange the code for a refresh token:
//   npm run ads-exchange-code -- --code "ANxxxxxxxxxxxxxxx"
//   → prints the refresh token. Paste it into .env as ADS_API_REFRESH_TOKEN.
//
// The auth code expires 5 minutes after Amazon issues it. Move fast.
// ============================================================================

import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/env.js';
import { LWA_TOKEN_URL } from '../lib/sp-api/endpoints.js';

const REDIRECT_URI = 'http://localhost:3000/callback';
const SCOPE = 'advertising::campaign_management';
const AUTH_URL_BASE = 'https://www.amazon.com/ap/oa';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.ADS_API_CLIENT_ID || !env.ADS_API_CLIENT_SECRET) {
    console.error('ADS_API_CLIENT_ID and ADS_API_CLIENT_SECRET must be set in .env first.');
    console.error('See docs/runbooks/connect-amazon-ads.md, Step 2.');
    process.exit(1);
  }

  const { values } = parseArgs({
    options: {
      code: { type: 'string' },
      'redirect-uri': { type: 'string', default: REDIRECT_URI },
    },
  });

  const redirectUri = values['redirect-uri']!;

  if (!values.code) {
    const url = new URL(AUTH_URL_BASE);
    url.searchParams.set('client_id', env.ADS_API_CLIENT_ID);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);

    console.log('');
    console.log('Amazon Ads API — OAuth Phase 1: get an authorisation code');
    console.log('---------------------------------------------------------');
    console.log('');
    console.log('1. Confirm this exact URL is in your LWA app\'s "Allowed Return URLs":');
    console.log(`     ${redirectUri}`);
    console.log('   (developer.amazon.com/loginwithamazon → your app → Web Settings)');
    console.log('');
    console.log('2. Open this authorisation URL in a browser:');
    console.log('');
    console.log(`   ${url.toString()}`);
    console.log('');
    console.log('3. Sign in as the seller, click "Allow".');
    console.log('   Amazon redirects to http://localhost:3000/callback?code=ANxxxxx&scope=...');
    console.log('   The page will fail to load — that is expected. The code is in the URL bar.');
    console.log('');
    console.log('4. Copy ONLY the code value (the bit between "code=" and "&scope="), then run:');
    console.log('');
    console.log('     npm run ads-exchange-code -- --code "ANxxxxxxxxxxxxxxx"');
    console.log('');
    console.log('Auth codes expire 5 minutes after issue. Move quickly.');
    return;
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: values.code,
    redirect_uri: redirectUri,
    client_id: env.ADS_API_CLIENT_ID,
    client_secret: env.ADS_API_CLIENT_SECRET,
  });

  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`Exchange failed (${res.status}): ${text}`);
    console.error('');
    console.error('Common causes:');
    console.error('  - Auth code expired (5-minute lifetime). Re-run with no args to get a new URL.');
    console.error('  - Auth code already used (single-use). Re-run with no args.');
    console.error(`  - Redirect URI mismatch — must equal what your LWA app has under "Allowed Return URLs" (${redirectUri}).`);
    console.error('  - Client ID / Secret typo in .env.');
    process.exit(1);
  }

  const data = JSON.parse(text) as TokenResponse;

  console.log('');
  console.log('Refresh token (paste into .env as ADS_API_REFRESH_TOKEN):');
  console.log('');
  console.log(`  ${data.refresh_token}`);
  console.log('');
  console.log(`Token issued. Valid for ~12 months.`);
  console.log(`Set a calendar reminder for ${monthsFromNow(11)} to rotate.`);
  console.log('');
  console.log('Next: paste it into .env, then run "npm run ads-probe" to confirm it works and list your profile IDs.');
  console.log('');
}

function monthsFromNow(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
