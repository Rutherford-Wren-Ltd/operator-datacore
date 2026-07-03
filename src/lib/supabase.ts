import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Client as PgClient } from 'pg';
import { loadEnv } from './env.js';

let cachedClient: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const env = loadEnv();
  cachedClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });
  return cachedClient;
}

export async function getPgClient(): Promise<PgClient> {
  const env = loadEnv();
  const client = new PgClient({
    connectionString: env.SUPABASE_DB_URL,
    ssl: env.SUPABASE_DB_URL.includes('localhost') ? undefined : { rejectUnauthorized: false },
    // Fail-fast on a stuck connect (default is wait-forever). Catches the
    // pooler-exhaustion / DNS-hang case loudly instead of silently. Statement
    // timeout caps any individual query at 5 minutes — enough for big upserts,
    // short enough that an accidental table scan doesn't lock up a process.
    connectionTimeoutMillis: 10_000,
    statement_timeout: 300_000,
    // Long paced backfills leave this connection idle for minutes at a time —
    // Sales & Traffic sits idle 15 min between report calls (Amazon's 1/15-min
    // createReport floor). Without TCP keepalive the Supabase pooler / NAT drops
    // the idle socket, surfacing as an unhandled "Connection terminated
    // unexpectedly" mid-run (observed 2026-07-03 on the EU S&T catch-up, which
    // died at day 4 of 30). Keepalive probes hold the socket open across the gaps.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  // node-postgres emits an 'error' event on the Client when the socket dies
  // unexpectedly — e.g. the Supabase pooler evicting an idle connection during
  // a long paced backfill (Sales & Traffic idles 15 min between report calls).
  // With NO listener, Node treats it as an unhandled 'error' and crashes the
  // whole process ("Connection terminated unexpectedly"), which defeats the
  // sleepWithKeepalive reconnect path in sales-traffic.ts (observed 2026-07-03,
  // died at day 4 of 30). Swallow it here (log once); the next keepalive ping
  // sees the dead client and transparently reconnects via getPgClient().
  client.on('error', (err: Error) => {
    console.warn(`[pg] connection error (will reconnect on next use): ${err.message}`);
  });

  const started = Date.now();
  await client.connect();
  const host = new URL(env.SUPABASE_DB_URL.replace(/^postgres(ql)?:/, 'http:')).host;
  console.log(`[pg] connected to ${host} in ${Date.now() - started}ms`);
  return client;
}
