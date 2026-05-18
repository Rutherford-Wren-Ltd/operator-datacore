#!/usr/bin/env tsx
// ============================================================================
// upload-secrets.ts
// Reads `.env`, validates the shape of known secrets, then pipes them to
// `gh secret set <NAME>` via stdin. The structural fix for the bug class
// that bit us multiple times during NA onboarding:
//   - surrounding quotes (dotenv strips them locally; gh secret set --body
//     does not, so the GitHub Secret ends up quoted while local env "works")
//   - asymmetric quotes (only leading or only trailing)
//   - wrong-region tokens pasted into wrong slot (e.g. SP-API token used
//     as ADS_API_REFRESH_TOKEN — same Atzr| prefix, different LWA app)
//   - truncated tokens (length way off the expected range)
//   - trailing whitespace
//
// Compared to the ad-hoc PowerShell `foreach { gh secret set ... }` loop
// we've been using, this CLI:
//   - cleans quotes/whitespace before upload (same logic env.ts applies on
//     load — single source of truth)
//   - shape-validates per secret family (length + prefix)
//   - never puts the secret value on the command line (piped via stdin,
//     not --body) — so values do NOT show up in process listings or shell
//     history
//   - dry-run mode shows what WOULD upload without touching GH
//
// Usage:
//   npm run upload-secrets                          # all known secrets in .env
//   npm run upload-secrets -- --dry-run             # validate only, no upload
//   npm run upload-secrets -- --keys SP_API_REFRESH_TOKEN,ADS_API_NA_REFRESH_TOKEN
//   npm run upload-secrets -- --repo Org/Other      # different repo (default: gh detects)
// ============================================================================

import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

interface Validator {
  /** Description of what shape is expected. Shown on failure. */
  expected: string;
  /** Returns null on pass, error message string on fail. */
  validate: (value: string) => string | null;
}

const ATZR_PREFIX = 'Atzr|';
const APP_CLIENT_PREFIX = 'amzn1.application-oa2-client.';
const APP_SECRET_PREFIX = 'amzn1.oa2-cs.v1.';

// Shape validators per secret. Lenient where we don't have a strong claim
// (e.g. exact length); strict where we have one (e.g. fixed prefix).
const REGISTRY: Record<string, Validator> = {
  // Supabase
  SUPABASE_URL: {
    expected: 'https URL ending in supabase.co',
    validate: (v) => (v.startsWith('https://') && v.includes('supabase.co') ? null : 'must be an https URL on supabase.co'),
  },
  SUPABASE_ANON_KEY: {
    expected: 'JWT-shaped token (~150-250 chars, three .-separated segments)',
    validate: (v) => (v.length >= 100 && v.split('.').length === 3 ? null : 'must look like a JWT (header.payload.signature)'),
  },
  SUPABASE_SERVICE_ROLE_KEY: {
    expected: 'JWT-shaped token (~150-250 chars, three .-separated segments)',
    validate: (v) => (v.length >= 100 && v.split('.').length === 3 ? null : 'must look like a JWT (header.payload.signature)'),
  },
  SUPABASE_DB_URL: {
    expected: 'postgres:// URL on a supabase host',
    validate: (v) => (v.startsWith('postgres://') || v.startsWith('postgresql://') ? null : 'must start with postgres:// or postgresql://'),
  },

  // SP-API
  SP_API_LWA_CLIENT_ID: {
    expected: `${APP_CLIENT_PREFIX}<32 hex>`,
    validate: (v) => (v.startsWith(APP_CLIENT_PREFIX) ? null : `must start with "${APP_CLIENT_PREFIX}"`),
  },
  SP_API_LWA_CLIENT_SECRET: {
    expected: `${APP_SECRET_PREFIX}<base64-ish>`,
    validate: (v) => (v.startsWith(APP_SECRET_PREFIX) ? null : `must start with "${APP_SECRET_PREFIX}"`),
  },
  SP_API_REFRESH_TOKEN: {
    expected: `${ATZR_PREFIX}... (typically 300-700 chars)`,
    validate: (v) => atzrRefreshTokenValidator(v),
  },
  SP_API_NA_REFRESH_TOKEN: {
    expected: `${ATZR_PREFIX}... (typically 300-700 chars)`,
    validate: (v) => atzrRefreshTokenValidator(v),
  },
  SP_API_REGION: {
    expected: 'one of: na, eu, fe',
    validate: (v) => (['na', 'eu', 'fe'].includes(v.toLowerCase()) ? null : 'must be na, eu, or fe'),
  },
  SP_API_MARKETPLACE_IDS: {
    expected: 'comma-separated marketplace IDs (e.g. ATVPDKIKX0DER,A1F83G8C2ARO7P)',
    validate: marketplaceIdsValidator,
  },
  SP_API_NA_MARKETPLACE_IDS: {
    expected: 'comma-separated marketplace IDs',
    validate: marketplaceIdsValidator,
  },

  // Ads API
  ADS_API_CLIENT_ID: {
    expected: `${APP_CLIENT_PREFIX}<hex>`,
    validate: (v) => (v.startsWith(APP_CLIENT_PREFIX) ? null : `must start with "${APP_CLIENT_PREFIX}"`),
  },
  ADS_API_CLIENT_SECRET: {
    expected: `${APP_SECRET_PREFIX}<base64-ish>`,
    validate: (v) => (v.startsWith(APP_SECRET_PREFIX) ? null : `must start with "${APP_SECRET_PREFIX}"`),
  },
  ADS_API_REFRESH_TOKEN: {
    expected: `${ATZR_PREFIX}... (Ads tokens are typically 500-600 chars)`,
    validate: (v) => atzrRefreshTokenValidator(v),
  },
  ADS_API_NA_REFRESH_TOKEN: {
    expected: `${ATZR_PREFIX}... (Ads tokens are typically 500-600 chars)`,
    validate: (v) => atzrRefreshTokenValidator(v),
  },
  ADS_PROFILE_ID: {
    expected: 'numeric profile ID (13-16 digits)',
    validate: profileIdsValidator(false),
  },
  ADS_PROFILE_IDS: {
    expected: 'comma-separated numeric profile IDs',
    validate: profileIdsValidator(true),
  },
  ADS_API_NA_PROFILE_ID: {
    expected: 'numeric profile ID (13-16 digits)',
    validate: profileIdsValidator(false),
  },
  ADS_API_NA_PROFILE_IDS: {
    expected: 'comma-separated numeric profile IDs',
    validate: profileIdsValidator(true),
  },
  ADS_API_REGION: {
    expected: 'one of: NA, EU, FE',
    validate: (v) => (['NA', 'EU', 'FE'].includes(v.toUpperCase()) ? null : 'must be NA, EU, or FE'),
  },
  ADS_API_ENDPOINT: {
    expected: 'https URL on advertising-api[-eu|-fe].amazon.com',
    validate: (v) => (/^https:\/\/advertising-api(-eu|-fe)?\.amazon\.com$/.test(v) ? null : 'must be an Amazon Ads API regional URL'),
  },
};

function atzrRefreshTokenValidator(v: string): string | null {
  if (!v.startsWith(ATZR_PREFIX)) return `must start with "${ATZR_PREFIX}"`;
  if (v.length < 100) return `length ${v.length} is suspiciously short for an Atzr refresh token (expected 300-700)`;
  if (v.length > 2000) return `length ${v.length} is suspiciously long`;
  return null;
}

function marketplaceIdsValidator(v: string): string | null {
  const ids = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return 'must contain at least one marketplace ID';
  for (const id of ids) {
    if (!/^A[A-Z0-9]{8,14}$/.test(id)) {
      return `marketplace ID "${id}" doesn't look like an Amazon marketplace ID (e.g. ATVPDKIKX0DER, 13 chars, starts with A, alphanumeric uppercase)`;
    }
  }
  return null;
}

function profileIdsValidator(plural: boolean): (v: string) => string | null {
  return (v) => {
    const ids = plural ? v.split(',').map((s) => s.trim()).filter(Boolean) : [v];
    if (ids.length === 0) return 'must contain at least one profile ID';
    for (const id of ids) {
      if (!/^\d{8,20}$/.test(id)) {
        return `profile ID "${id}" must be 8-20 digits`;
      }
    }
    return null;
  };
}

/**
 * Apply the same quote/whitespace cleaning that env.ts does at load time,
 * so what we upload matches what runtime sees.
 *
 * Returns { cleaned, warnings: string[] } so callers can see what we did.
 */
function cleanValue(raw: string): { cleaned: string; warnings: string[] } {
  const warnings: string[] = [];
  let v = raw;
  if (v.trim() !== v) {
    warnings.push('stripped surrounding whitespace');
    v = v.trim();
  }
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    v = v.slice(1, -1);
  } else if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") {
    v = v.slice(1, -1);
  } else {
    if (v.length >= 1 && (v[0] === '"' || v[0] === "'")) {
      warnings.push('stripped lone leading quote (.env was malformed)');
      v = v.slice(1);
    }
    if (v.length >= 1 && (v[v.length - 1] === '"' || v[v.length - 1] === "'")) {
      warnings.push('stripped lone trailing quote (.env was malformed)');
      v = v.slice(0, -1);
    }
  }
  return { cleaned: v, warnings };
}

interface SecretEntry {
  key: string;
  raw: string;
  cleaned: string;
  warnings: string[];
  validation: 'ok' | 'fail' | 'unknown';
  validationError?: string;
  expected?: string;
}

function loadEnvFile(path: string): Map<string, string> {
  const env = new Map<string, string>();
  if (!existsSync(path)) {
    throw new Error(`No .env file at ${path}. Are you running from operator-datacore/?`);
  }
  const content = readFileSync(path, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    // Strip trailing inline comment ` # foo` (only if preceded by whitespace)
    const commentMatch = value.match(/^(.*?)\s+#.*$/);
    env.set(key, commentMatch ? commentMatch[1]! : value);
  }
  return env;
}

function uploadSecret(key: string, value: string, repoFlag: string[]): { ok: boolean; stderr: string } {
  const result = spawnSync('gh', ['secret', 'set', key, ...repoFlag], {
    input: value,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error) return { ok: false, stderr: result.error.message };
  if (result.status !== 0) return { ok: false, stderr: result.stderr ?? '(unknown)' };
  return { ok: true, stderr: '' };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      keys: { type: 'string' },
      repo: { type: 'string' },
    },
  });

  const dryRun = values['dry-run'] ?? false;
  const repoFlag = values.repo ? ['--repo', values.repo] : [];

  const requestedKeys: string[] | null = values.keys
    ? values.keys.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  const env = loadEnvFile('.env');
  const entries: SecretEntry[] = [];

  // If --keys is given, validate exactly that list. Otherwise iterate the
  // registry and only upload secrets actually present in .env.
  const keysToConsider = requestedKeys ?? Object.keys(REGISTRY);
  for (const key of keysToConsider) {
    const raw = env.get(key);
    if (raw === undefined || raw === '') continue; // not in .env — skip silently
    const { cleaned, warnings } = cleanValue(raw);
    const validator = REGISTRY[key];
    let validation: SecretEntry['validation'] = 'unknown';
    let validationError: string | undefined;
    if (!validator) {
      validation = 'unknown';
    } else {
      const err = validator.validate(cleaned);
      validation = err ? 'fail' : 'ok';
      if (err) validationError = err;
    }
    const entry: SecretEntry = { key, raw, cleaned, warnings, validation };
    if (validationError !== undefined) entry.validationError = validationError;
    if (validator?.expected !== undefined) entry.expected = validator.expected;
    entries.push(entry);
  }

  if (entries.length === 0) {
    console.error('No matching secrets in .env. Nothing to do.');
    process.exit(0);
  }

  console.log(`operator-datacore — upload-secrets ${dryRun ? '(dry run)' : ''}`);
  console.log('---------------------------------------------------------');
  console.log('');

  let okCount = 0;
  let failCount = 0;
  let uploadedCount = 0;

  for (const e of entries) {
    const tag = e.validation === 'ok' ? 'OK  '
              : e.validation === 'fail' ? 'FAIL'
              : 'UNKN';
    console.log(`  [${tag}]  ${e.key}  length=${e.cleaned.length}`);
    for (const w of e.warnings) console.log(`         warning: ${w}`);
    if (e.validationError) console.log(`         error: ${e.validationError}  (expected ${e.expected})`);

    if (e.validation === 'fail') {
      failCount += 1;
      continue;
    }
    okCount += 1;

    if (!dryRun) {
      const { ok, stderr } = uploadSecret(e.key, e.cleaned, repoFlag);
      if (ok) {
        console.log(`         uploaded`);
        uploadedCount += 1;
      } else {
        console.error(`         upload FAILED: ${stderr.trim().split('\n')[0]}`);
        failCount += 1;
      }
    }
  }

  console.log('');
  if (dryRun) {
    console.log(`Dry run: ${okCount} would upload, ${failCount} would be skipped due to shape errors.`);
    console.log(`Re-run without --dry-run to actually upload, or fix the errors above and re-run.`);
  } else {
    console.log(`Done: ${uploadedCount} uploaded, ${failCount} failed.`);
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
