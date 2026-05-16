// ============================================================================
// Amazon Ads Reporting v3 — async report primitive.
//
// Flow:
//   1. POST /reporting/reports                  → reportId (status=PENDING)
//   2. GET  /reporting/reports/{reportId}       → poll until COMPLETED
//   3. GET  <url field from completed response> → presigned S3 download (gzip)
//
// The whole pipeline takes 1–10 minutes typically. Reports v3 supersedes v2;
// v2 endpoints still work but Amazon is steering everyone to v3 because the
// column model is unified across SP/SB/SD and the create/poll/download shape
// is consistent.
//
// Reference:
// https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/get-started
// ============================================================================

import { gunzipSync } from 'node:zlib';
import { AdsApiError, type AdsApiClient } from './client.js';

const CREATE_CONTENT_TYPE = 'application/vnd.createasyncreportrequest.v3+json';
const REPORT_ACCEPT = 'application/vnd.createasyncreportresponse.v3+json';

export type AdProduct =
  | 'SPONSORED_PRODUCTS'
  | 'SPONSORED_BRANDS'
  | 'SPONSORED_DISPLAY';

export type ReportStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface ReportConfiguration {
  adProduct: AdProduct;
  /** What dimensions the report rolls up to. e.g. ["advertiser"] or ["campaign"]. */
  groupBy: string[];
  /** Columns to include in the output. Validated server-side. */
  columns: string[];
  /** Report type, e.g. "spAdvertisedProduct", "sbCampaigns", "sdAdvertisedProduct". */
  reportTypeId: string;
  /** Granularity of the time dimension. */
  timeUnit: 'DAILY' | 'SUMMARY';
  /** Output format. We always use GZIP_JSON for parseability + bandwidth. */
  format: 'GZIP_JSON';
  /** Optional server-side filters. */
  filters?: Array<{ field: string; values: string[] }>;
}

export interface CreateReportRequest {
  /** Free-form name for the report; visible in the Amazon Ads dashboard. */
  name: string;
  /** Inclusive date range. ISO YYYY-MM-DD. Single-day reports use the same value. */
  startDate: string;
  endDate: string;
  configuration: ReportConfiguration;
}

export interface CreateReportResponse {
  reportId: string;
  status: ReportStatus;
  /** Other fields exist (configuration, etc.) but we don't need them. */
}

export interface GetReportResponse {
  reportId: string;
  status: ReportStatus;
  /** Set when status === COMPLETED. Presigned S3 URL with a short TTL. */
  url?: string;
  /** Failure detail when status === FAILED. */
  failureReason?: string;
  /** When the report finished. ISO datetime. */
  endTime?: string;
}

/**
 * POST /reporting/reports — queues a report job for the given configuration.
 * Returns immediately with reportId; the actual data is not yet ready.
 */
export async function createReport(
  client: AdsApiClient,
  req: CreateReportRequest,
): Promise<CreateReportResponse> {
  const res = await client.request<CreateReportResponse>({
    method: 'POST',
    path: '/reporting/reports',
    body: req,
    contentType: CREATE_CONTENT_TYPE,
    accept: REPORT_ACCEPT,
  });
  return res.payload;
}

/**
 * GET /reporting/reports/{reportId} — single status check.
 */
export async function getReport(
  client: AdsApiClient,
  reportId: string,
): Promise<GetReportResponse> {
  const res = await client.request<GetReportResponse>({
    method: 'GET',
    path: `/reporting/reports/${reportId}`,
    accept: REPORT_ACCEPT,
  });
  return res.payload;
}

export interface PollOptions {
  /** Initial wait before first poll. Defaults to 20s — most reports take longer than that. */
  initialWaitMs?: number;
  /** Wait between polls. Defaults to 15s. */
  intervalMs?: number;
  /** Hard cap on total wait. Defaults to 30 minutes — Amazon's report queue
   *  occasionally takes 14+ minutes even for one-day reports, so 15 was too
   *  tight in practice. */
  timeoutMs?: number;
  onPoll?: (info: { attempt: number; status: ReportStatus; elapsedMs: number }) => void;
}

/**
 * Poll a report until it reaches a terminal state (COMPLETED or FAILED), or
 * timeout. Throws on FAILED or timeout.
 */
export async function pollReport(
  client: AdsApiClient,
  reportId: string,
  opts: PollOptions = {},
): Promise<GetReportResponse> {
  const initialWaitMs = opts.initialWaitMs ?? 20_000;
  const intervalMs = opts.intervalMs ?? 15_000;
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const startedAt = Date.now();

  await sleep(initialWaitMs);

  let attempt = 0;
  for (;;) {
    attempt += 1;
    const elapsedMs = Date.now() - startedAt;
    const result = await getReport(client, reportId);
    opts.onPoll?.({ attempt, status: result.status, elapsedMs });

    if (result.status === 'COMPLETED') {
      if (!result.url) {
        throw new Error(
          `Report ${reportId} returned status=COMPLETED but no download URL — unexpected Ads API response.`,
        );
      }
      return result;
    }
    if (result.status === 'FAILED') {
      throw new Error(
        `Report ${reportId} FAILED: ${result.failureReason ?? '(no reason given)'}`,
      );
    }
    if (Date.now() - startedAt + intervalMs > timeoutMs) {
      throw new Error(
        `Report ${reportId} not COMPLETED after ${Math.round(timeoutMs / 1000)}s (last status: ${result.status}). Re-run later or raise --timeout.`,
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * Download a completed report from its presigned S3 URL and gunzip.
 * Returns the parsed JSON rows. The URL is short-lived; callers should
 * download promptly after polling completion.
 */
export async function downloadReport<TRow = Record<string, unknown>>(
  url: string,
): Promise<TRow[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new AdsApiError(
      res.status,
      await res.text(),
      `Ads report download → ${res.status}: presigned URL may have expired.`,
    );
  }
  const compressed = Buffer.from(await res.arrayBuffer());
  const decompressed = gunzipSync(compressed).toString('utf8');
  return JSON.parse(decompressed) as TRow[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
