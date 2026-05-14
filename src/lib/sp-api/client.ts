import pRetry, { AbortError } from 'p-retry';
import { getLwaAccessToken } from './auth.js';
import { SP_API_ENDPOINTS, SpApiRegion } from './endpoints.js';

export interface SpApiClientOptions {
  region: SpApiRegion;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface SpApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  query?: Record<string, string | number | string[] | undefined>;
  body?: unknown;
}

export interface SpApiResponse<T> {
  status: number;
  payload: T;
  rateLimit?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Hard cap on a single 429 wait — one stuck request shouldn't hang for minutes. */
const MAX_THROTTLE_WAIT_MS = 120_000;

export class SpApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseText: string,
    message: string,
    /** For 429s: how long the rate-limit headers say to wait before retrying. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SpApiError';
  }
}

export class SpApiClient {
  private readonly baseUrl: string;
  constructor(private readonly opts: SpApiClientOptions) {
    this.baseUrl = SP_API_ENDPOINTS[opts.region];
  }

  async request<T>(req: SpApiRequest): Promise<SpApiResponse<T>> {
    return pRetry(
      async () => this.requestOnce<T>(req),
      {
        retries: 5,
        minTimeout: 1_000,
        factor: 2,
        maxTimeout: 30_000,
        onFailedAttempt: async (err) => {
          if (err instanceof SpApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
            // Permanent client errors (auth, malformed) — don't retry.
            throw new AbortError(err.message);
          }
          // SP-API's createReport quota is a small burst bucket with a slow
          // refill; pRetry's exponential backoff (~31s total) is far too
          // short to clear it. When a 429 carries a rate-limit signal, wait
          // that long here — pRetry's own backoff and next attempt follow.
          if (err instanceof SpApiError && err.status === 429 && err.retryAfterMs) {
            const waitMs = Math.min(err.retryAfterMs, MAX_THROTTLE_WAIT_MS);
            console.error(`  SP-API 429 throttled — waiting ${Math.round(waitMs / 1000)}s for quota before retry`);
            await sleep(waitMs);
          }
        },
      },
    );
  }

  private async requestOnce<T>(req: SpApiRequest): Promise<SpApiResponse<T>> {
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

    const init: RequestInit = {
      method: req.method,
      headers: {
        'x-amz-access-token': token,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'operator-datacore/0.1 (Language=TypeScript)',
      },
    };
    if (req.body !== undefined) init.body = JSON.stringify(req.body);
    const res = await fetch(url.toString(), init);

    const rateLimit = parseFloat(res.headers.get('x-amzn-ratelimit-limit') ?? '');
    const text = await res.text();

    if (!res.ok) {
      throw new SpApiError(
        res.status,
        text,
        `SP-API ${req.method} ${req.path} → ${res.status}: ${text.slice(0, 500)}`,
        res.status === 429 ? throttleWaitMs(res.headers, rateLimit) : undefined,
      );
    }

    let payload: T;
    try {
      payload = text ? (JSON.parse(text) as T) : (undefined as unknown as T);
    } catch {
      payload = text as unknown as T;
    }

    const out: SpApiResponse<T> = { status: res.status, payload };
    if (Number.isFinite(rateLimit)) out.rateLimit = rateLimit;
    return out;
  }
}

/**
 * How long to wait after a 429, derived from the response headers.
 * Prefers an explicit Retry-After (seconds); otherwise uses
 * x-amzn-RateLimit-Limit (the requests/second restore rate) — getting one
 * token back takes 1/rate seconds. Falls back to 60s if neither is usable.
 */
function throttleWaitMs(headers: Headers, rateLimit: number): number {
  const retryAfter = parseInt(headers.get('retry-after') ?? '', 10);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1_000;
  if (Number.isFinite(rateLimit) && rateLimit > 0) return Math.ceil(1_000 / rateLimit);
  return 60_000;
}
