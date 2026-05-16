// ============================================================================
// Amazon Ads API base client.
//
// The Ads API and SP-API both authenticate via LWA against api.amazon.com,
// so getLwaAccessToken is reused from sp-api/auth.ts (its cache is keyed by
// clientId+refreshToken — Ads tokens never collide with SP-API tokens).
//
// Every Ads API request needs two auth headers:
//   - Authorization: Bearer <lwa_access_token>
//   - Amazon-Advertising-API-ClientId: <lwa_client_id>
//
// Scoped requests (anything beyond /v2/profiles) also need:
//   - Amazon-Advertising-API-Scope: <profile_id>
// ============================================================================

import pRetry, { AbortError } from 'p-retry';
import { getLwaAccessToken } from '../sp-api/auth.js';
import { ADS_API_ENDPOINTS, type AdsApiRegion } from './endpoints.js';

export interface AdsApiClientOptions {
  region: AdsApiRegion;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Required for any request beyond /v2/profiles. */
  profileId?: string;
  /** Override the regional endpoint (e.g. sandbox). Optional. */
  endpoint?: string;
}

export interface AdsApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number | string[] | undefined>;
  body?: unknown;
  /** Per-request profile override; falls back to client default. */
  profileId?: string;
  /** Override Accept header for endpoints that need a versioned content type. */
  accept?: string;
  /** Override Content-Type header (Reports v3 needs a versioned MIME type). */
  contentType?: string;
}

export interface AdsApiResponse<T> {
  status: number;
  payload: T;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_THROTTLE_WAIT_MS = 120_000;

export class AdsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseText: string,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AdsApiError';
  }
}

export class AdsApiClient {
  private readonly baseUrl: string;
  constructor(private readonly opts: AdsApiClientOptions) {
    this.baseUrl = opts.endpoint ?? ADS_API_ENDPOINTS[opts.region];
  }

  async request<T>(req: AdsApiRequest): Promise<AdsApiResponse<T>> {
    return pRetry(
      async () => this.requestOnce<T>(req),
      {
        retries: 5,
        minTimeout: 1_000,
        factor: 2,
        maxTimeout: 30_000,
        onFailedAttempt: async (err) => {
          if (err instanceof AdsApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
            throw new AbortError(err.message);
          }
          if (err instanceof AdsApiError && err.status === 429 && err.retryAfterMs) {
            const waitMs = Math.min(err.retryAfterMs, MAX_THROTTLE_WAIT_MS);
            console.error(`  Ads API 429 throttled — waiting ${Math.round(waitMs / 1000)}s before retry`);
            await sleep(waitMs);
          }
        },
      },
    );
  }

  private async requestOnce<T>(req: AdsApiRequest): Promise<AdsApiResponse<T>> {
    const token = await getLwaAccessToken({
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      refreshToken: this.opts.refreshToken,
    });

    const url = new URL(this.baseUrl + req.path);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item));
        } else {
          url.searchParams.append(k, String(v));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': this.opts.clientId,
      'Content-Type': req.contentType ?? 'application/json',
      Accept: req.accept ?? 'application/json',
      'User-Agent': 'operator-datacore/0.1 (Language=TypeScript)',
    };
    const scope = req.profileId ?? this.opts.profileId;
    if (scope) headers['Amazon-Advertising-API-Scope'] = scope;

    const init: RequestInit = { method: req.method, headers };
    if (req.body !== undefined) init.body = JSON.stringify(req.body);

    const res = await fetch(url.toString(), init);
    const text = await res.text();

    if (!res.ok) {
      throw new AdsApiError(
        res.status,
        text,
        `Ads API ${req.method} ${req.path} → ${res.status}: ${text.slice(0, 500)}`,
        res.status === 429 ? throttleWaitMs(res.headers) : undefined,
      );
    }

    let payload: T;
    try {
      payload = text ? (JSON.parse(text) as T) : (undefined as unknown as T);
    } catch {
      payload = text as unknown as T;
    }
    return { status: res.status, payload };
  }
}

function throttleWaitMs(headers: Headers): number {
  const retryAfter = parseInt(headers.get('retry-after') ?? '', 10);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1_000;
  return 30_000;
}
