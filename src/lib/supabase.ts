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
  });
  const started = Date.now();
  await client.connect();
  const host = new URL(env.SUPABASE_DB_URL.replace(/^postgres(ql)?:/, 'http:')).host;
  console.log(`[pg] connected to ${host} in ${Date.now() - started}ms`);
  return client;
}
