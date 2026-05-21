// ============================================================================
// Product Fees — per-ASIN FBA fulfilment fee via SP-API getMyFeesEstimates.
//
// Endpoint: POST /products/fees/v0/feesEstimate  (the batch operation, up to
// 20 items per call).
//
// What it returns: for each ASIN, the per-unit FBA *fulfilment* fee — the
// 'FBAFees' line of the fee estimate. That is what brain.sku_master.fba_fee
// holds, and what closes the CM3 calculation.
//
// On price: getMyFeesEstimates requires a ListingPrice (it also computes the
// price-dependent referral fee). The FBA fulfilment fee is size/weight-based,
// NOT price-based, so a nominal price is used — only the FBAFees component is
// read, and it does not move with price.
//
// On reliability: getMyFeesEstimates intermittently returns "internal service
// failure" for whole batches under load. That is transient — the run does
// retry passes over just the failed ASINs before giving up on them.
// ============================================================================

import type { SpApiClient } from './client.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// getMyFeesEstimates accepts at most 20 items per call. The Product Fees API
// restore rate is ~1 req/s — pace one batch per ~1.5s.
const BATCH_SIZE = 20;
const INTER_BATCH_DELAY_MS = 1_500;
// Pause before a retry pass, to let a load-shedding API recover.
const RETRY_PASS_DELAY_MS = 5_000;
const DEFAULT_MAX_RETRY_PASSES = 3;

interface Money { CurrencyCode?: string; Amount?: number; }
interface FeeDetail { FeeType?: string; FeeAmount?: Money; FinalFee?: Money; }
interface FeesEstimate { FeeDetailList?: FeeDetail[]; TotalFeesEstimate?: Money; }
interface FeesEstimateResult {
  Status?: string;
  FeesEstimateIdentifier?: { IdValue?: string };
  FeesEstimate?: FeesEstimate;
  Error?: { Code?: string; Message?: string };
}

interface Failure { asin: string; reason: string }

export interface FbaFeeResult {
  /** ASIN -> per-unit FBA fulfilment fee, in the marketplace currency. */
  fees: Map<string, number>;
  failures: Failure[];
}

export interface FbaFeeOptions {
  spClient: SpApiClient;
  marketplaceId: string;
  currencyCode: string;
  asins: string[];
  /** Nominal listing price for the request — the FBA fee does not depend on it. */
  nominalPrice?: number;
  /** Retry passes over transiently-failed ASINs. Default 3. */
  maxRetryPasses?: number;
  onBatch?: (info: {
    pass: number; batch: number; totalBatches: number; ok: number; failed: number;
  }) => void;
}

// A failure worth retrying. A missing FBAFees line, or a client error on a bad
// ASIN, will not fix itself — those are permanent. "internal service failure"
// and a missing result row are Amazon-side and transient.
function isTransient(reason: string): boolean {
  return /internal service failure|no result returned/i.test(reason);
}

/** One pass of getMyFeesEstimates over a list of ASINs, batched 20 at a time. */
async function runPass(
  opts: FbaFeeOptions, asins: string[], pass: number,
): Promise<{ fees: Map<string, number>; failures: Failure[] }> {
  const price = opts.nominalPrice ?? 20;
  const fees = new Map<string, number>();
  const failures: Failure[] = [];
  const totalBatches = Math.ceil(asins.length / BATCH_SIZE);

  for (let b = 0; b * BATCH_SIZE < asins.length; b++) {
    const chunk = asins.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    const body = chunk.map((asin) => ({
      IdType: 'ASIN',
      IdValue: asin,
      FeesEstimateRequest: {
        MarketplaceId: opts.marketplaceId,
        IsAmazonFulfilled: true,
        PriceToEstimateFees: {
          ListingPrice: { CurrencyCode: opts.currencyCode, Amount: price },
        },
        Identifier: `fba-fee-${asin}`,
      },
    }));

    const res = await opts.spClient.request<unknown>({
      method: 'POST',
      path: '/products/fees/v0/feesEstimate',
      body,
    });

    // The batch operation may return a bare array or a {payload:[...]} wrapper.
    const raw = res.payload as { payload?: FeesEstimateResult[] } | FeesEstimateResult[] | null;
    const results: FeesEstimateResult[] = Array.isArray(raw) ? raw : raw?.payload ?? [];

    let ok = 0;
    let failed = 0;
    const seen = new Set<string>();
    for (const r of results) {
      const asin = r.FeesEstimateIdentifier?.IdValue;
      if (!asin) continue;
      seen.add(asin);
      if (r.Status !== 'Success' || !r.FeesEstimate) {
        failures.push({ asin, reason: r.Error?.Message ?? `status ${r.Status ?? 'unknown'}` });
        failed += 1;
        continue;
      }
      const fba = r.FeesEstimate.FeeDetailList?.find((d) => d.FeeType === 'FBAFees');
      const amount = fba?.FinalFee?.Amount ?? fba?.FeeAmount?.Amount;
      if (amount === undefined || amount === null || !Number.isFinite(amount)) {
        failures.push({ asin, reason: 'no FBAFees component in the fee estimate' });
        failed += 1;
        continue;
      }
      fees.set(asin, amount);
      ok += 1;
    }
    // Any ASIN in the chunk with no result row returned at all.
    for (const asin of chunk) {
      if (!seen.has(asin)) {
        failures.push({ asin, reason: 'no result returned for this ASIN' });
        failed += 1;
      }
    }

    opts.onBatch?.({ pass, batch: b + 1, totalBatches, ok, failed });
    if ((b + 1) * BATCH_SIZE < asins.length) await sleep(INTER_BATCH_DELAY_MS);
  }
  return { fees, failures };
}

/**
 * Estimates the per-unit FBA fulfilment fee for each ASIN via the SP-API
 * getMyFeesEstimates batch operation. ASINs are de-duplicated; results are
 * matched back by the ASIN echoed in FeesEstimateIdentifier.IdValue.
 *
 * Transient failures ("internal service failure", missing result row) are
 * retried over up to `maxRetryPasses` further passes; an ASIN that errors
 * permanently (no FBAFees line, bad request) is recorded in `failures`.
 */
export async function fetchFbaFulfilmentFees(opts: FbaFeeOptions): Promise<FbaFeeResult> {
  const maxRetryPasses = opts.maxRetryPasses ?? DEFAULT_MAX_RETRY_PASSES;
  const fees = new Map<string, number>();
  const permanent: Failure[] = [];
  let pending = [...new Set(opts.asins.filter(Boolean))];

  for (let pass = 0; pending.length > 0; pass += 1) {
    if (pass > 0) await sleep(RETRY_PASS_DELAY_MS);
    const r = await runPass(opts, pending, pass);
    for (const [asin, fee] of r.fees) fees.set(asin, fee);

    const retry: string[] = [];
    for (const f of r.failures) {
      if (pass < maxRetryPasses && isTransient(f.reason)) retry.push(f.asin);
      else permanent.push(f);
    }
    pending = retry;
  }

  return { fees, failures: permanent };
}
