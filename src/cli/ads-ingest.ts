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
//   npm run ads-ingest                            # yesterday, SP + SD (default), primary region
//   npm run ads-ingest -- --region NA             # primary-region default, NA override
//   npm run ads-ingest -- --days 7                # last 7 days, SP + SD
//   npm run ads-ingest -- --date 2026-05-14       # one specific date
//   npm run ads-ingest -- --from 2024-01-01 --to 2024-12-31 --skip-existing
//                                                 # historical backfill, idempotent re-runs
//   npm run ads-ingest -- --products SP           # SP only
//   npm run ads-ingest -- --products SP,SD,SB     # opt SB into a run
//   npm run ads-ingest -- --concurrency 3         # 3 profiles in parallel per date (default 1)
//
// Sponsored Brands (SB) is OPT-IN via --products SP,SD,SB. The default
// stays SP+SD so the existing daily-sync schedule keeps the same
// concurrent-report footprint until SB has been validated against
// production profiles. Once verified, daily-sync.yml + ads-attribution-ripen.yml
// can be updated to explicitly include SB.
//
// Backfill mode (--from/--to):
//   - Hard-capped at 1100 days (~3 years) to avoid an accidental decade-long run.
//   - Combine with --skip-existing to make re-runs idempotent: any (profile, date)
//     pair that already has rows in brain.ads_sp_daily or brain.ads_sd_daily is
//     dropped from the worklist. Use this for crash recovery or topping up gaps.
//
// Concurrency:
//   - SP + SD + SB for one (profile, date) always run in parallel —
//     separate report types, separate quota buckets on Amazon's side.
//   - Across profiles, the default is sequential (--concurrency 1) because
//     Amazon's createReport rate limits and concurrent-report ceilings
//     are PER LWA APP, not per profile. Running 9 profiles' worth of
//     reports at once = up to 27 concurrent reports per app (3 products
//     × 9 profiles), which risks 429s on most accounts.
//   - --concurrency 2 is usually safe for accounts that have been on
//     the Ads API for a while. New apps with default quotas should stay
//     at 1 until they have usage history.
//   - Within each batch of N profiles, SP+SD+SB still run in parallel —
//     effective concurrency is 3N concurrent reports.
// ============================================================================

import { parseArgs } from 'node:util';
import {
  loadEnvForAdsShared,
  getAdsApiRegionConfig,
  type AdsApiRegion,
} from '../lib/env.js';
import { getPgClient } from '../lib/supabase.js';
import type { Client as PgClient } from 'pg';
import { AdsApiClient } from '../lib/ads-api/client.js';
import { getProfiles, type AdsProfile } from '../lib/ads-api/profiles.js';
import { ingestSpDaily } from '../lib/ads-api/sp-ingest.js';
import { ingestSdDaily } from '../lib/ads-api/sd-ingest.js';
import { ingestSbDaily } from '../lib/ads-api/sb-ingest.js';

type AdProductKey = 'SP' | 'SD' | 'SB';

interface ProfileDateSuccess {
  ok: true;
  profile: AdsProfile;
  date: string;
  byProduct: Record<AdProductKey, { rows: number; reportId: string } | undefined>;
}

interface ProfileDateFailure {
  ok: false;
  profile: AdsProfile;
  date: string;
  error: Error;
}

type ProfileDateOutcome = ProfileDateSuccess | ProfileDateFailure;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      date: { type: 'string' },
      days: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      products: { type: 'string' },
      region: { type: 'string' },
      concurrency: { type: 'string' },
      'pace-ms': { type: 'string' },
      'skip-existing': { type: 'boolean', default: false },
    },
  });
  const skipExisting = values['skip-existing'] ?? false;
  const paceMs = resolvePaceMs(values['pace-ms']);

  const env = loadEnvForAdsShared();
  const region: AdsApiRegion = (values.region as AdsApiRegion | undefined) ?? env.ADS_API_REGION;
  if (region !== 'NA' && region !== 'EU' && region !== 'FE') {
    throw new Error(`--region must be one of: NA, EU, FE. Got "${region}".`);
  }
  const config = getAdsApiRegionConfig(region, env);
  if (config.profileIds.length === 0) {
    throw new Error(
      `No Ads profile(s) configured for region ${region}. Run "npm run ads-probe -- --region ${region}" to discover, then set ADS_API_${region}_PROFILE_ID (single) or ADS_API_${region}_PROFILE_IDS (comma-separated) in .env.`,
    );
  }

  const dates = resolveDates(values.date, values.days, values.from, values.to);
  const products = resolveProducts(values.products);
  const concurrency = resolveConcurrency(values.concurrency);

  console.log('operator-datacore — Amazon Ads ingest');
  console.log('--------------------------------------');
  console.log(`  Region:        ${config.region}`);
  console.log(`  Endpoint:      ${config.endpoint}`);
  console.log(`  Profile(s):    ${config.profileIds.join(', ')} (${config.profileIds.length} profile${config.profileIds.length === 1 ? '' : 's'})`);
  console.log(`  Products:      ${products.join(', ')}`);
  console.log(`  Dates:         ${dates[0]}${dates.length > 1 ? ` … ${dates[dates.length - 1]} (${dates.length} day${dates.length === 1 ? '' : 's'})` : ''}`);
  console.log(`  Concurrency:   ${concurrency} profile${concurrency === 1 ? '' : 's'} in parallel per date`);
  console.log(`  Pace:          ${paceMs}ms between dates`);
  console.log(`  Skip existing: ${skipExisting}`);
  console.log('');

  // Initial client used for the /v2/profiles enumeration. Per-profile
  // clients with their scope set are created inside the loop below.
  const discoveryClient = new AdsApiClient({
    region: config.region,
    clientId: env.ADS_API_CLIENT_ID,
    clientSecret: env.ADS_API_CLIENT_SECRET,
    refreshToken: config.refreshToken,
    endpoint: config.endpoint,
  });
  const allProfiles = await getProfiles(discoveryClient);
  const matchedProfiles = config.profileIds
    .map((id) => allProfiles.find((p) => String(p.profileId) === String(id)))
    .filter((p): p is NonNullable<typeof p> => p !== undefined);
  if (matchedProfiles.length !== config.profileIds.length) {
    const missing = config.profileIds.filter((id) => !allProfiles.some((p) => String(p.profileId) === String(id)));
    throw new Error(
      `Profile(s) ${missing.join(', ')} not in /v2/profiles response for region ${region}. Run "npm run ads-probe -- --region ${region}" to see valid IDs.`,
    );
  }

  // `activePg` is the live pg client. It may be swapped under us by the
  // keepalive heartbeat below if Supabase's pooler evicts the connection
  // during a long-running backfill (~9 min per profile-date, most of which
  // is spent polling Amazon with the pg connection idle). Every reference
  // below goes through `activePg` rather than a stable `pg` const, so the
  // swap takes effect on the next query.
  let activePg = await getPgClient();

  // Heartbeat: ping the active pg client every ~60s. If it throws, the
  // connection is dead — close it (best-effort) and replace with a fresh
  // one. Concurrency note: the heartbeat and the main flow share one pg
  // connection; node-postgres serialises queries on a single client, so
  // a heartbeat ping that fires while an upsert is in progress just queues
  // behind it. No race.
  //
  // setInterval doesn't await previous ticks; if a ping is in flight when
  // the next tick fires, we'd queue a second ping. The serialisation above
  // makes that benign (queued ping just becomes a no-op once the first
  // completes), and reconnection is idempotent (multiple .end()s on a
  // dead client throw, swallowed by the catch).
  const KEEPALIVE_INTERVAL_MS = 60_000;
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        await activePg.query('SELECT 1');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ads-ingest] keepalive ping failed (${msg}); reconnecting`);
        try { await activePg.end(); } catch { /* old client already dead */ }
        activePg = await getPgClient();
      }
    })();
  }, KEEPALIVE_INTERVAL_MS);

  try {
    const startedAt = Date.now();
    const totals: Record<AdProductKey, number> = { SP: 0, SD: 0, SB: 0 };
    const failures: ProfileDateFailure[] = [];
    let successCount = 0;
    let skippedCount = 0;

    // For --skip-existing, build a set of (profile_id, date) pairs where ALL
    // requested products already have rows in the lake. Pairs that are only
    // partially present (e.g. SP filled, SD missing from an earlier failed
    // run) stay on the worklist — the upsert below is idempotent for the
    // already-present product, so re-running them is wasteful but not wrong.
    const completedPairs = skipExisting
      ? await loadCompletedPairs(
          activePg,
          matchedProfiles.map((p) => String(p.profileId)),
          dates[0]!,
          dates[dates.length - 1]!,
          products,
        )
      : new Set<string>();
    if (skipExisting) {
      console.log(`  Skip set:      ${completedPairs.size} (profile, date) pairs already complete for all requested products`);
      console.log('');
    }

    // For each date, batch profiles into groups of `concurrency` and run
    // each batch in parallel. Within each batched profile, SP + SD still
    // run in parallel — effective concurrent reports per batch is 2 × N.
    //
    // ingestProfileDate never throws — failures are returned as outcomes
    // so one profile's failure doesn't take down the rest of the batch.
    // A failure summary is printed at end and exit code reflects whether
    // any profile-dates failed.
    for (const [dateIdx, date] of dates.entries()) {
      const profilesToRun = matchedProfiles.filter(
        (p) => !completedPairs.has(`${p.profileId}|${date}`),
      );
      const skippedThisDate = matchedProfiles.length - profilesToRun.length;
      if (skippedThisDate > 0) {
        skippedCount += skippedThisDate;
      }
      if (profilesToRun.length === 0) {
        // Every profile is already complete for this date — quietly skip.
        continue;
      }

      console.log(`Date ${date}${skippedThisDate > 0 ? ` (${skippedThisDate} profile${skippedThisDate === 1 ? '' : 's'} skipped — already complete)` : ''}:`);

      for (let i = 0; i < profilesToRun.length; i += concurrency) {
        const batch = profilesToRun.slice(i, i + concurrency);
        const batchLabel = profilesToRun.length > concurrency
          ? `  batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(profilesToRun.length / concurrency)}: ${batch.length} profile${batch.length === 1 ? '' : 's'} in parallel`
          : null;
        if (batchLabel) console.log(batchLabel);

        const outcomes = await Promise.all(
          batch.map((profile) =>
            ingestProfileDate({
              profile,
              date,
              env,
              config,
              products,
              pg: activePg,
            }),
          ),
        );

        for (const outcome of outcomes) {
          const profileLabel = `${outcome.profile.profileId} — ${outcome.profile.accountInfo.name} (${outcome.profile.countryCode})`;
          if (outcome.ok) {
            console.log(`  Profile ${profileLabel}:`);
            successCount += 1;
            for (const product of products) {
              const r = outcome.byProduct[product];
              if (r) {
                console.log(`    [${product}] ${r.rows} row(s) upserted (reportId ${r.reportId})`);
                totals[product] += r.rows;
              }
            }
          } else {
            console.error(`  Profile ${profileLabel}: FAILED — ${outcome.error.message.split('\n')[0]}`);
            failures.push(outcome);
          }
        }
      }
      console.log('');

      // Space consecutive dates apart to stay under Amazon's sustained
      // report-generation limit (see resolvePaceMs). No pause after the last
      // date, and none when paceMs is 0 (the daily-sync default).
      if (paceMs > 0 && dateIdx < dates.length - 1) {
        await sleep(paceMs);
      }
    }

    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `Done in ${durationSec}s. ${successCount} profile-date(s) succeeded, ` +
      `${skippedCount} skipped, ${failures.length} failed.`,
    );
    for (const p of products) {
      console.log(`  ${p}: ${totals[p]} row(s) total → brain.ads_${p.toLowerCase()}_daily`);
    }

    if (failures.length > 0) {
      console.error('');
      console.error(`${failures.length} profile-date(s) failed (rows from successful profile-dates ARE in the lake; failures will retry on the next sync):`);
      for (const f of failures) {
        console.error(`  ${f.profile.profileId} (${f.profile.accountInfo.name}, ${f.profile.countryCode}) [${f.date}]:`);
        console.error(`    ${f.error.message.split('\n').slice(0, 3).join('\n    ')}`);
      }
      console.log('Next: /sku-audit will produce a real TACoS score for advertised ASINs that DID land successfully.');
      // Exit non-zero so the workflow shows red and the operator gets a
      // failure notification — but only after the successful profile-dates
      // have already committed their rows.
      process.exitCode = 1;
      return;
    }

    console.log('Next: /sku-audit will produce a real TACoS score for advertised ASINs.');
  } finally {
    clearInterval(heartbeat);
    try { await activePg.end(); } catch { /* may already be ended by a recent eviction */ }
  }
}

interface IngestProfileDateOpts {
  profile: AdsProfile;
  date: string;
  env: {
    ADS_API_CLIENT_ID: string;
    ADS_API_CLIENT_SECRET: string;
  };
  config: { region: AdsApiRegion; refreshToken: string; endpoint: string };
  products: AdProductKey[];
  pg: PgClient;
}

/**
 * Run SP + SD ingest in parallel for one (profile, date). Returns an
 * outcome union — never throws. The caller uses the discriminator
 * (`outcome.ok`) to decide how to aggregate.
 *
 * Why this never throws: with multiple profiles batched in parallel,
 * one profile's failure would otherwise short-circuit the whole batch
 * and red the entire workflow run — even though the OTHER profiles in
 * the batch (and earlier batches' profiles) already wrote their rows
 * successfully. We want isolated failure: capture the error, keep
 * going, summarise at end.
 */
async function ingestProfileDate(opts: IngestProfileDateOpts): Promise<ProfileDateOutcome> {
  const { profile, date, env, config, products, pg } = opts;
  const profileId = String(profile.profileId);

  try {
    const scopedClient = new AdsApiClient({
      region: config.region,
      clientId: env.ADS_API_CLIENT_ID,
      clientSecret: env.ADS_API_CLIENT_SECRET,
      refreshToken: config.refreshToken,
      endpoint: config.endpoint,
      profileId,
    });

    const pollLogger = (label: string) => ({
      onPoll: ({ attempt, status, elapsedMs }: { attempt: number; status: string; elapsedMs: number }) => {
        console.log(
          `    [${profileId} ${date} ${label}] poll ${attempt}: status=${status} (${Math.round(elapsedMs / 1000)}s)`,
        );
      },
    });

    const byProduct: ProfileDateSuccess['byProduct'] = { SP: undefined, SD: undefined, SB: undefined };
    const jobs: Array<Promise<void>> = [];
    if (products.includes('SP')) {
      jobs.push(
        ingestSpDaily({
          adsClient: scopedClient,
          pg,
          profileId,
          startDate: date,
          endDate: date,
          currencyCode: profile.currencyCode,
          poll: pollLogger('SP'),
        }).then((r) => {
          byProduct.SP = { rows: r.rowsUpserted, reportId: r.reportId };
        }),
      );
    }
    if (products.includes('SD')) {
      jobs.push(
        ingestSdDaily({
          adsClient: scopedClient,
          pg,
          profileId,
          startDate: date,
          endDate: date,
          currencyCode: profile.currencyCode,
          poll: pollLogger('SD'),
        }).then((r) => {
          byProduct.SD = { rows: r.rowsUpserted, reportId: r.reportId };
        }),
      );
    }
    if (products.includes('SB')) {
      jobs.push(
        ingestSbDaily({
          adsClient: scopedClient,
          pg,
          profileId,
          startDate: date,
          endDate: date,
          currencyCode: profile.currencyCode,
          poll: pollLogger('SB'),
        }).then((r) => {
          byProduct.SB = { rows: r.rowsUpserted, reportId: r.reportId };
        }),
      );
    }
    await Promise.all(jobs);
    return { ok: true, profile, date, byProduct };
  } catch (err) {
    return {
      ok: false,
      profile,
      date,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BACKFILL_DAYS = 1100;  // ~3 years, generous ceiling

/**
 * Find (profile_id, date) pairs that already have rows for EVERY requested
 * product. A pair is "complete" only if all requested products show data;
 * pairs that have e.g. SP rows but missing SD rows stay on the worklist so a
 * partial earlier run can be topped up.
 *
 * The metric_date is read via `to_char(..., 'YYYY-MM-DD')` to avoid the
 * node-postgres DATE → local-midnight Date trap that caused the
 * sales-traffic --skip-existing bug (operator-datacore #48).
 */
async function loadCompletedPairs(
  pg: PgClient,
  profileIds: string[],
  fromDate: string,
  toDate: string,
  products: AdProductKey[],
): Promise<Set<string>> {
  // Query each product table separately so partial-completion stays visible.
  // Table names are derived from a controlled enum, not user input — safe.
  const productSets: Set<string>[] = [];
  for (const product of products) {
    const table =
      product === 'SP' ? 'brain.ads_sp_daily' :
      product === 'SD' ? 'brain.ads_sd_daily' :
                          'brain.ads_sb_daily';
    const { rows } = await pg.query<{ profile_id: string; metric_date: string }>(
      `SELECT DISTINCT profile_id, to_char(metric_date, 'YYYY-MM-DD') AS metric_date
         FROM ${table}
        WHERE profile_id = ANY($1)
          AND metric_date BETWEEN $2 AND $3`,
      [profileIds, fromDate, toDate],
    );
    productSets.push(new Set(rows.map((r) => `${r.profile_id}|${r.metric_date}`)));
  }
  if (productSets.length === 0) return new Set();
  // A pair is complete only when it appears in every product's set.
  const [first, ...rest] = productSets;
  const completed = new Set<string>();
  for (const key of first!) {
    if (rest.every((s) => s.has(key))) completed.add(key);
  }
  return completed;
}

function resolveDates(
  date: string | undefined,
  days: string | undefined,
  from: string | undefined,
  to: string | undefined,
): string[] {
  // Mutual exclusion: pick exactly one of --date, --days, or --from/--to.
  const modes = [
    date    ? '--date'        : null,
    days    ? '--days'        : null,
    (from || to) ? '--from/--to' : null,
  ].filter(Boolean) as string[];
  if (modes.length > 1) {
    throw new Error(`Pick one of: ${modes.join(', ')}. Got all of: ${modes.join(' + ')}.`);
  }

  // --from/--to: explicit historical window, no upper cap on `--days`.
  if (from || to) {
    if (!from || !to) {
      throw new Error('--from and --to must be used together.');
    }
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
      throw new Error(`--from and --to must be YYYY-MM-DD. Got "${from}" and "${to}".`);
    }
    const fromT = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
    const toT   = Date.UTC(+to.slice(0, 4),   +to.slice(5, 7) - 1,   +to.slice(8, 10));
    if (toT < fromT) {
      throw new Error(`--to (${to}) is before --from (${from}).`);
    }
    const ms = toT - fromT + 86_400_000;
    const total = Math.round(ms / 86_400_000);
    if (total > MAX_BACKFILL_DAYS) {
      throw new Error(
        `Backfill range is ${total} days; capped at ${MAX_BACKFILL_DAYS}. ` +
        `Split into smaller windows or raise MAX_BACKFILL_DAYS in src/cli/ads-ingest.ts.`,
      );
    }
    const out: string[] = [];
    for (let t = fromT; t <= toT; t += 86_400_000) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }

  if (date) return [date];

  // --days: trailing N days ending yesterday. Same 30-day cap as before —
  // the larger backfill case is --from/--to, not --days.
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
  // Default keeps SP+SD only — SB is opt-in (see CLI header note).
  if (!products) return ['SP', 'SD'];
  const parsed = products
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is AdProductKey => s === 'SP' || s === 'SD' || s === 'SB');
  if (parsed.length === 0) {
    throw new Error(`--products must be a comma-separated list of: SP, SD, SB. Got "${products}".`);
  }
  return parsed;
}

/**
 * Resolve and validate --concurrency. Hard-caps at 5 to avoid blowing past
 * typical Ads API concurrent-report ceilings. With SP + SD + SB defaulting
 * on, each batched profile adds up to 3 concurrent reports — so 5 profiles
 * = up to 15 concurrent reports. Already in the territory where a default
 * Ads API quota will start 429ing; raise only if your account quota allows.
 */
function resolveConcurrency(value: string | undefined): number {
  if (!value) return 1;
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 1) {
    throw new Error(`--concurrency must be a positive integer. Got "${value}".`);
  }
  if (n > 5) {
    throw new Error(
      `--concurrency capped at 5 to avoid 429s. Got ${n}. ` +
      `If your account has a generously increased Ads API quota and you've tested at higher values, raise this cap in src/cli/ads-ingest.ts:resolveConcurrency.`,
    );
  }
  return n;
}

/**
 * Resolve --pace-ms: milliseconds to wait between consecutive dates in the
 * worklist. Default 0 (no pause — unchanged behaviour for daily-sync, which
 * only ever pulls a day or two). The multi-date ripen re-pull fires
 * SP+SD+SB report POSTs per date; without spacing, a 7-day run bursts ~21
 * report creations and trips Amazon's SUSTAINED report-generation limit
 * (the per-request 429 retry recovers a single spike, not an exhausted
 * window). Pacing dates apart keeps the run under the sustained ceiling.
 */
function resolvePaceMs(value: string | undefined): number {
  if (!value) return 0;
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`--pace-ms must be a non-negative integer. Got "${value}".`);
  }
  return n;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
