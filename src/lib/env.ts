import { config } from 'dotenv';
import { z } from 'zod';

config();

// Treat empty-string env vars (e.g. `FOO=` left as a TODO placeholder in .env)
// as if they were unset, so `.optional()` actually means "may be unset".
const emptyToUndef = (schema: z.ZodTypeAny) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

/**
 * Repair env values that have surrounding whitespace or stray quote characters.
 *
 * Why this exists: dotenv strips PAIRED surrounding quotes when loading .env,
 * but PowerShell / shell scripts reading .env directly do not. The mismatch
 * means a value can look fine via `npm run X` (dotenv-cleaned) but fail when
 * the same .env is read another way and uploaded to (e.g.) GitHub Secrets.
 * Asymmetric quotes — only one of leading/trailing — also defeat dotenv's
 * paired-stripping logic and silently produce a broken value at the LWA
 * endpoint with an `invalid_client` / `invalid_grant` error.
 *
 * Repair strategy:
 *   - Trim leading/trailing whitespace.
 *   - Strip paired surrounding double or single quotes silently (this is the
 *     standard dotenv behaviour — re-applying it here covers env vars that
 *     came from somewhere other than dotenv, e.g. GitHub Secrets).
 *   - If only ONE side has a quote after pair-stripping, strip it AND emit
 *     a loud warning. Asymmetric quotes are almost always a malformed .env
 *     and the operator needs to know.
 *
 * Anything weirder than that we leave to zod to fail noisily on.
 */
function repairEnvValue(key: string, raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null) return raw;
  let v = raw;
  const trimmed = v.trim();
  if (trimmed !== v) {
    console.warn(`[env] ${key}: stripped surrounding whitespace`);
    v = trimmed;
  }
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    v = v.slice(1, -1);
  } else if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") {
    v = v.slice(1, -1);
  } else {
    if (v.length >= 1 && (v[0] === '"' || v[0] === "'")) {
      console.warn(`[env] ${key}: stripped a lone leading quote — your .env is probably malformed`);
      v = v.slice(1);
    }
    if (v.length >= 1 && (v[v.length - 1] === '"' || v[v.length - 1] === "'")) {
      console.warn(`[env] ${key}: stripped a lone trailing quote — your .env is probably malformed`);
      v = v.slice(0, -1);
    }
  }
  return v;
}

const Schema = z.object({
  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_DB_URL: z.string().url(),

  // Amazon SP-API
  SP_API_LWA_CLIENT_ID: z.string().min(1).optional(),
  SP_API_LWA_CLIENT_SECRET: z.string().min(1).optional(),
  SP_API_REFRESH_TOKEN: z.string().min(1).optional(),
  SP_API_REGION: z.enum(['na', 'eu', 'fe']).default('na'),
  SP_API_MARKETPLACE_IDS: z.string().default('ATVPDKIKX0DER'),

  // Amazon Ads API (separate LWA app from SP-API above)
  ADS_API_CLIENT_ID: emptyToUndef(z.string().min(1).optional()),
  ADS_API_CLIENT_SECRET: emptyToUndef(z.string().min(1).optional()),
  ADS_API_REFRESH_TOKEN: emptyToUndef(z.string().min(1).optional()),
  ADS_PROFILE_ID: emptyToUndef(z.string().min(1).optional()),
  ADS_API_REGION: emptyToUndef(z.enum(['NA', 'EU', 'FE']).default('EU')),
  ADS_API_ENDPOINT: emptyToUndef(z.string().url().optional()),

  // Behaviour
  BACKFILL_MONTHS: z.coerce.number().int().min(1).max(36).default(24),
  REPORTING_CURRENCY: z.string().length(3).default('USD'),
  ROLLUP_TIMEZONE: z.string().default('America/Los_Angeles'),

  // TikTok / Shopify / Google all optional in v1
  TIKTOK_APP_KEY: z.string().optional(),
  TIKTOK_APP_SECRET: z.string().optional(),
  TIKTOK_SHOP_CIPHER: z.string().optional(),
  TIKTOK_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_STORE_DOMAIN: z.string().optional(),
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default('2025-04'),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_DRIVE_FOLDER_IDS: z.string().optional(),
});

export type Env = z.infer<typeof Schema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  // Run every value through repairEnvValue before zod parsing so quote /
  // whitespace artefacts in .env (or in GitHub Secrets) don't slip through.
  const repaired: Record<string, string | undefined> = {};
  for (const key of Object.keys(Schema.shape)) {
    repaired[key] = repairEnvValue(key, process.env[key]);
  }
  const parsed = Schema.safeParse(repaired);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Environment validation failed.\n\nFix these in your .env file:\n${issues}\n\nSee .env.example for what each value should look like.`,
    );
  }
  cached = parsed.data;
  return cached;
}

export function loadEnvForAmazon(): Env & {
  SP_API_LWA_CLIENT_ID: string;
  SP_API_LWA_CLIENT_SECRET: string;
  SP_API_REFRESH_TOKEN: string;
} {
  const env = loadEnv();
  if (!env.SP_API_LWA_CLIENT_ID || !env.SP_API_LWA_CLIENT_SECRET || !env.SP_API_REFRESH_TOKEN) {
    throw new Error(
      'Amazon SP-API credentials missing. Set SP_API_LWA_CLIENT_ID, SP_API_LWA_CLIENT_SECRET, SP_API_REFRESH_TOKEN in .env. See docs/runbooks/connect-amazon.md.',
    );
  }
  return env as Env & {
    SP_API_LWA_CLIENT_ID: string;
    SP_API_LWA_CLIENT_SECRET: string;
    SP_API_REFRESH_TOKEN: string;
  };
}

export function getMarketplaceIds(env: Env = loadEnv()): string[] {
  return env.SP_API_MARKETPLACE_IDS.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadEnvForAds(): Env & {
  ADS_API_CLIENT_ID: string;
  ADS_API_CLIENT_SECRET: string;
  ADS_API_REFRESH_TOKEN: string;
} {
  const env = loadEnv();
  if (!env.ADS_API_CLIENT_ID || !env.ADS_API_CLIENT_SECRET || !env.ADS_API_REFRESH_TOKEN) {
    throw new Error(
      'Amazon Ads API credentials missing. Set ADS_API_CLIENT_ID, ADS_API_CLIENT_SECRET, ADS_API_REFRESH_TOKEN in .env. See docs/runbooks/connect-amazon-ads.md.',
    );
  }
  return env as Env & {
    ADS_API_CLIENT_ID: string;
    ADS_API_CLIENT_SECRET: string;
    ADS_API_REFRESH_TOKEN: string;
  };
}
