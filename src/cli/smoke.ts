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

import { parseArgs } from 'node:util';
import { loadEnv, getSpApiRegionConfig, type SpApiRegion } from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { getLwaAccessToken } from '../lib/sp-api/auth.js';

interface Check {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      region: { type: 'string' },
    },
  });
  let regionOverride: SpApiRegion | undefined;
  if (values.region !== undefined) {
    if (values.region !== 'na' && values.region !== 'eu' && values.region !== 'fe') {
      throw new Error(`--region must be one of: na, eu, fe. Got "${values.region}".`);
    }
    regionOverride = values.region;
  }

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

  // 4 + 5. SP-API checks, per region (defaults to primary; --region flag overrides).
  const region: SpApiRegion = regionOverride ?? env.SP_API_REGION;
  let regionConfig: ReturnType<typeof getSpApiRegionConfig> | null = null;
  try {
    regionConfig = getSpApiRegionConfig(region, env);
  } catch (err) {
    checks.push({ name: `SP-API region resolve (${region})`, status: 'skip', detail: (err as Error).message });
  }

  if (regionConfig && env.SP_API_LWA_CLIENT_ID && env.SP_API_LWA_CLIENT_SECRET) {
    // 4. LWA
    try {
      const token = await getLwaAccessToken({
        clientId: env.SP_API_LWA_CLIENT_ID,
        clientSecret: env.SP_API_LWA_CLIENT_SECRET,
        refreshToken: regionConfig.refreshToken,
      });
      checks.push({ name: `SP-API LWA token exchange (${region})`, status: 'pass', detail: `token len ${token.length}` });
    } catch (err) {
      checks.push({ name: `SP-API LWA token exchange (${region})`, status: 'fail', detail: (err as Error).message });
    }

    // 5. marketplaceParticipations — cheapest possible authenticated SP-API call
    try {
      const client = new SpApiClient({
        region: regionConfig.region,
        clientId: env.SP_API_LWA_CLIENT_ID,
        clientSecret: env.SP_API_LWA_CLIENT_SECRET,
        refreshToken: regionConfig.refreshToken,
      });
      const res = await client.request<{ payload?: { marketplaces?: Array<{ id: string; name?: string }> } }>(
        {
          method: 'GET',
          path: '/sellers/v1/marketplaceParticipations',
        },
      );
      const ids = res.payload.payload?.marketplaces?.map((m) => `${m.id}${m.name ? ` (${m.name})` : ''}`) ?? [];
      checks.push({
        name: `SP-API marketplace participation (${region})`,
        status: 'pass',
        detail: ids.length ? ids.join(', ') : '(empty)',
      });
    } catch (err) {
      checks.push({ name: `SP-API marketplace participation (${region})`, status: 'fail', detail: (err as Error).message });
    }
  } else if (!env.SP_API_LWA_CLIENT_ID || !env.SP_API_LWA_CLIENT_SECRET) {
    checks.push({ name: 'SP-API LWA token exchange', status: 'skip', detail: 'shared LWA credentials missing in .env' });
  }

  // Configured marketplaces echo
  if (regionConfig) {
    checks.push({
      name: `Configured marketplaces (${region})`,
      status: 'pass',
      detail: regionConfig.marketplaceIds.join(', '),
    });
  }

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
