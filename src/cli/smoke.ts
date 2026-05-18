#!/usr/bin/env tsx
// ============================================================================
// smoke.ts
// Confirms each piece of the stack is healthy WITHOUT pulling any data.
//   1. .env loads and validates
//   2. Supabase connection works
//   3. Migrations are applied
//   4. SP-API LWA token exchange works (if credentials present)
//   5. SP-API returns a marketplace list (cheapest possible call)
// ============================================================================

import { loadEnv, getMarketplaceIds } from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { getLwaAccessToken } from '../lib/sp-api/auth.js';

interface Check {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

async function main(): Promise<void> {
  console.log('operator-datacore — smoke test');
  console.log('-------------------------------\n');
  const checks: Check[] = [];

  // 1. .env
  let env: ReturnType<typeof loadEnv>;
  try {
    env = loadEnv();
    checks.push({ name: '.env loads & validates', status: 'pass', detail: 'OK' });
  } catch (err) {
    checks.push({ name: '.env loads & validates', status: 'fail', detail: (err as Error).message });
    print(checks);
    process.exit(1);
  }

  // 2. Supabase
  try {
    const pg = await getPgClient();
    const { rows } = await pg.query<{ now: string }>('SELECT NOW()::text AS now');
    await pg.end();
    checks.push({ name: 'Supabase Postgres reachable', status: 'pass', detail: `server time ${rows[0]!.now}` });
  } catch (err) {
    checks.push({ name: 'Supabase Postgres reachable', status: 'fail', detail: (err as Error).message });
  }

  // 3. Migrations applied
  try {
    const pg = await getPgClient();
    const { rows } = await pg.query<{ filename: string }>(
      'SELECT filename FROM meta.migration_history ORDER BY id',
    );
    await pg.end();
    checks.push({
      name: 'Migrations applied',
      status: rows.length >= 9 ? 'pass' : 'fail',
      detail: `${rows.length} migrations recorded${rows.length < 9 ? ' — run `npm run migrate`' : ''}`,
    });
  } catch (err) {
    checks.push({
      name: 'Migrations applied',
      status: 'fail',
      detail: 'meta.migration_history not found — run `npm run migrate` first',
    });
  }

  // 4. SP-API LWA
  if (env.SP_API_LWA_CLIENT_ID && env.SP_API_LWA_CLIENT_SECRET && env.SP_API_REFRESH_TOKEN) {
    try {
      const token = await getLwaAccessToken({
        clientId: env.SP_API_LWA_CLIENT_ID,
        clientSecret: env.SP_API_LWA_CLIENT_SECRET,
        refreshToken: env.SP_API_REFRESH_TOKEN,
      });
      checks.push({ name: 'SP-API LWA token exchange', status: 'pass', detail: `token len ${token.length}` });
    } catch (err) {
      checks.push({ name: 'SP-API LWA token exchange', status: 'fail', detail: (err as Error).message });
    }

    // 5. SP-API marketplaces.
    //
    // The /sellers/v1/marketplaceParticipations response shape is:
    //   { payload: [ { marketplace: { id, name, ... }, participation: {...} } ] }
    // i.e. payload is an ARRAY, not an object with a .marketplaces property.
    // (Earlier versions of this file parsed `payload.marketplaces` and
    // always reported "(empty)" regardless of token health — silently
    // returning a false negative that cost ~1 hour of debugging on
    // 2026-05-18.)
    try {
      const client = new SpApiClient({
        region: env.SP_API_REGION,
        clientId: env.SP_API_LWA_CLIENT_ID,
        clientSecret: env.SP_API_LWA_CLIENT_SECRET,
        refreshToken: env.SP_API_REFRESH_TOKEN,
      });
      const res = await client.request<{
        payload?: Array<{
          marketplace: { id: string; name?: string; countryCode?: string };
          participation: { isParticipating: boolean };
        }>;
      }>({
        method: 'GET',
        path: '/sellers/v1/marketplaceParticipations',
      });
      const ids = (res.payload.payload ?? [])
        .filter((p) => p.participation?.isParticipating !== false)
        .map((p) => `${p.marketplace.id}${p.marketplace.name ? ` (${p.marketplace.name})` : ''}`);
      checks.push({
        name: 'SP-API marketplace participation',
        status: 'pass',
        detail: ids.length ? ids.join(', ') : '(empty)',
      });
    } catch (err) {
      checks.push({ name: 'SP-API marketplace participation', status: 'fail', detail: (err as Error).message });
    }
  } else {
    checks.push({ name: 'SP-API LWA token exchange', status: 'skip', detail: 'credentials missing in .env' });
  }

  // Configured marketplaces echo
  checks.push({
    name: 'Configured marketplaces (.env)',
    status: 'pass',
    detail: getMarketplaceIds(env).join(', '),
  });

  print(checks);
  const anyFail = checks.some((c) => c.status === 'fail');
  process.exit(anyFail ? 1 : 0);
}

function print(checks: Check[]): void {
  const ICONS = { pass: 'OK  ', fail: 'FAIL', skip: 'SKIP' } as const;
  for (const c of checks) {
    console.log(`  [${ICONS[c.status]}]  ${c.name.padEnd(40)} ${c.detail}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
