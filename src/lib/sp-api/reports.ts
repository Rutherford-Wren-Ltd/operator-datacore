import { gunzipSync, createGunzip } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { SpApiClient } from './client.js';

/**
 * Thrown when Amazon ends a report with processingStatus=CANCELLED. This is
 * a distinct condition from FATAL (which is "your request is malformed") —
 * CANCELLED typically means "no data available for this window" (e.g. a date
 * past the report's retention horizon, a marketplace not enrolled in Brand
 * Analytics, an account that didn't sell in that period). Callers iterating
 * over days / marketplaces / ASINs should catch this specifically and skip
 * the failing tuple rather than aborting the whole run.
 */
export class ReportCancelledError extends Error {
  readonly reportId: string;
  constructor(reportId: string) {
    super(`Report ${reportId} ended with status CANCELLED`);
    this.name = 'ReportCancelledError';
    this.reportId = reportId;
  }
}

/**
 * Thrown when Amazon ends a report with processingStatus=FATAL. The docs frame
 * this as "request malformed", but empirically for SQP it also fires when the
 * (ASIN, marketplace, period) tuple has no data — typically because the ASIN
 * launched after the requested period, or Amazon hasn't yet published the most
 * recent month/week. Callers iterating over tuples should catch + skip rather
 * than aborting the whole run; the FATAL tuple is structurally unreachable and
 * retrying won't help. Confirmed empirically 2026-06-12 backfilling top-20
 * Wrenbury/Hemswell/Muldale ASINs (see [[sqp-backfill-fatal-on-prelaunch]]).
 */
export class ReportFatalError extends Error {
  readonly reportId: string;
  constructor(reportId: string) {
    super(`Report ${reportId} ended with status FATAL`);
    this.name = 'ReportFatalError';
    this.reportId = reportId;
  }
}

interface CreateReportResp {
  reportId: string;
}
interface GetReportResp {
  reportId: string;
  reportType: string;
  dataStartTime?: string;
  dataEndTime?: string;
  marketplaceIds?: string[];
  reportDocumentId?: string;
  processingStatus: 'IN_QUEUE' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED' | 'FATAL';
  processingStartTime?: string;
  processingEndTime?: string;
}
interface GetReportDocumentResp {
  reportDocumentId: string;
  url: string;
  compressionAlgorithm?: 'GZIP';
}

export interface RunReportOpts {
  reportType: string;
  marketplaceIds: string[];
  dataStartTime?: Date;
  dataEndTime?: Date;
  reportOptions?: Record<string, string>;
}

export interface ReportResult {
  meta: GetReportResp;
  rawText: string;
}

/**
 * Poll the Reports API until processingStatus reaches DONE, with hard timeout
 * + periodic stderr logs so a stuck report doesn't sit silent for an hour.
 *
 * Tier 2 from project review (2026-06-15) — the previous polling shape was
 * `for (let i = 0; i < 60; i++) await sleep(min(waitMs, 60_000))` with waitMs
 * growing 1.5×; in steady state it spent ~53 iterations × 60s = ~53 min in
 * silent waiting before throwing a generic timeout. Operator had no way to
 * tell a slow report apart from a stuck pipeline. The new shape:
 *
 *   - hard cap: 30 min (configurable per caller; raise for known-slow reports)
 *   - periodic log: every 5 min so progress is visible in CI / oncall console
 *   - same exponential backoff inside the cap (5s → 60s)
 *
 * Throws ReportCancelledError / ReportFatalError on those statuses (caller
 * decides whether to treat them as fatal). Throws a plain Error with elapsed
 * time + last status when the timeout cap is hit.
 */
async function pollReportUntilDone(
  client: SpApiClient,
  opts: {
    reportId: string;
    reportType: string;
    /** Hard wall-clock cap; default 30 min. */
    maxWaitMs?: number;
    /** Log cadence for "still IN_PROGRESS after Xm" stderr line; default 5 min. */
    logEveryMs?: number;
  },
): Promise<GetReportResp> {
  const maxWaitMs = opts.maxWaitMs ?? 30 * 60_000;
  const logEveryMs = opts.logEveryMs ?? 5 * 60_000;
  const startedAt = Date.now();
  let nextLogAt = startedAt + logEveryMs;
  let waitMs = 5_000;
  const intervalCapMs = 60_000;
  let meta: GetReportResp | undefined;

  while (Date.now() - startedAt < maxWaitMs) {
    const got = await client.request<GetReportResp>({
      method: 'GET',
      path: `/reports/2021-06-30/reports/${opts.reportId}`,
    });
    meta = got.payload;
    if (meta.processingStatus === 'DONE') return meta;
    if (meta.processingStatus === 'CANCELLED') throw new ReportCancelledError(opts.reportId);
    if (meta.processingStatus === 'FATAL') throw new ReportFatalError(opts.reportId);

    if (Date.now() >= nextLogAt) {
      const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
      console.error(`[reports] ${opts.reportType} report ${opts.reportId} still ${meta.processingStatus} after ${elapsedMin}m (cap ${maxWaitMs / 60_000}m)`);
      nextLogAt = Date.now() + logEveryMs;
    }

    await sleep(Math.min(waitMs, intervalCapMs));
    waitMs = Math.min(waitMs * 1.5, intervalCapMs);
  }

  throw new Error(
    `Report ${opts.reportId} (${opts.reportType}) did not complete within ${maxWaitMs / 60_000}m. Last status: ${meta?.processingStatus ?? 'unknown'}`,
  );
}

/**
 * End-to-end Reports API helper:
 *   1. createReport → reportId
 *   2. poll getReport until DONE (or CANCELLED/FATAL) — via pollReportUntilDone above
 *   3. getReportDocument → presigned URL
 *   4. fetch + decompress (if gzipped) → return raw text
 *
 * Caller is responsible for parsing the raw text (most reports are TSV).
 *
 * Reference: https://developer-docs.amazon.com/sp-api/docs/reports-api-v2021-06-30-use-case-guide
 */
export async function runReport(client: SpApiClient, opts: RunReportOpts): Promise<ReportResult> {
  const create = await client.request<CreateReportResp>({
    method: 'POST',
    path: '/reports/2021-06-30/reports',
    body: {
      reportType: opts.reportType,
      marketplaceIds: opts.marketplaceIds,
      dataStartTime: opts.dataStartTime?.toISOString(),
      dataEndTime: opts.dataEndTime?.toISOString(),
      reportOptions: opts.reportOptions,
    },
  });

  const reportId = create.payload.reportId;
  const meta = await pollReportUntilDone(client, { reportId, reportType: opts.reportType });

  if (!meta.reportDocumentId) {
    throw new Error(`Report ${reportId} reached DONE but has no reportDocumentId`);
  }

  const doc = await client.request<GetReportDocumentResp>({
    method: 'GET',
    path: `/reports/2021-06-30/documents/${meta.reportDocumentId}`,
  });

  const fetched = await fetch(doc.payload.url);
  if (!fetched.ok) {
    throw new Error(`Report document fetch failed (${fetched.status}): ${await fetched.text()}`);
  }
  const buf = Buffer.from(await fetched.arrayBuffer());
  const rawText =
    doc.payload.compressionAlgorithm === 'GZIP' ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');

  return { meta, rawText };
}

/**
 * createReport + poll + getDocument, then download the report body to a
 * given file path (streaming, decompressed). Returns the file path and the
 * report metadata. Use this when the response could be too large to fit
 * in memory — caller can then read/parse the file in chunks or just
 * `readFileSync` it if size is manageable.
 *
 * Background: the SQP reports for some ASINs have been crashing the
 * buffer-everything path in runReport, even when the diagnostic showed
 * earlier responses were small. This is the safe path for SQP.
 */
export async function downloadReportToFile(
  client: SpApiClient,
  opts: RunReportOpts,
  filePath: string,
): Promise<{ meta: GetReportResp; bytesWritten: number }> {
  const create = await client.request<CreateReportResp>({
    method: 'POST',
    path: '/reports/2021-06-30/reports',
    body: {
      reportType: opts.reportType,
      marketplaceIds: opts.marketplaceIds,
      dataStartTime: opts.dataStartTime?.toISOString(),
      dataEndTime: opts.dataEndTime?.toISOString(),
      reportOptions: opts.reportOptions,
    },
  });

  const reportId = create.payload.reportId;
  const meta = await pollReportUntilDone(client, { reportId, reportType: opts.reportType });

  if (!meta.reportDocumentId) {
    throw new Error(`Report ${reportId} reached DONE but has no reportDocumentId`);
  }

  const doc = await client.request<GetReportDocumentResp>({
    method: 'GET',
    path: `/reports/2021-06-30/documents/${meta.reportDocumentId}`,
  });

  const fetched = await fetch(doc.payload.url);
  if (!fetched.ok || !fetched.body) {
    throw new Error(`Report document fetch failed (${fetched.status})`);
  }

  // Stream → optional gunzip → write to disk. Never buffers the whole body.
  const { pipeline } = await import('node:stream/promises');
  const { createWriteStream } = await import('node:fs');
  const { statSync } = await import('node:fs');
  const nodeStream = Readable.fromWeb(fetched.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  if (doc.payload.compressionAlgorithm === 'GZIP') {
    await pipeline(nodeStream, createGunzip(), createWriteStream(filePath));
  } else {
    await pipeline(nodeStream, createWriteStream(filePath));
  }

  return { meta, bytesWritten: statSync(filePath).size };
}

/**
 * Streaming variant of runReport — same createReport + poll + getDocument
 * dance, but returns a Node Readable that yields the (decompressed) report
 * body as bytes flow in, instead of buffering everything into a single
 * string in memory.
 *
 * Use this for reports whose response is large enough that buffering causes
 * OOM (e.g. Brand Analytics Search Query Performance — RW's first 1-month
 * test hit >8GB heap with the buffered runReport before the JSON could
 * even be parsed). Caller is responsible for streaming-parse on top of the
 * returned stream — typically via `stream-json`.
 *
 * Returned `stream` is a Node Readable; you can `.pipe()` it through more
 * Transforms or consume it via async iteration.
 */
export async function streamReport(client: SpApiClient, opts: RunReportOpts): Promise<{
  meta: GetReportResp;
  stream: NodeJS.ReadableStream;
}> {
  const create = await client.request<CreateReportResp>({
    method: 'POST',
    path: '/reports/2021-06-30/reports',
    body: {
      reportType: opts.reportType,
      marketplaceIds: opts.marketplaceIds,
      dataStartTime: opts.dataStartTime?.toISOString(),
      dataEndTime: opts.dataEndTime?.toISOString(),
      reportOptions: opts.reportOptions,
    },
  });

  const reportId = create.payload.reportId;
  const meta = await pollReportUntilDone(client, { reportId, reportType: opts.reportType });

  if (!meta.reportDocumentId) {
    throw new Error(`Report ${reportId} reached DONE but has no reportDocumentId`);
  }

  const doc = await client.request<GetReportDocumentResp>({
    method: 'GET',
    path: `/reports/2021-06-30/documents/${meta.reportDocumentId}`,
  });

  const fetched = await fetch(doc.payload.url);
  if (!fetched.ok) {
    throw new Error(`Report document fetch failed (${fetched.status}): ${await fetched.text()}`);
  }
  if (!fetched.body) {
    throw new Error(`Report document fetch returned no body (${doc.payload.reportDocumentId})`);
  }

  // WHATWG ReadableStream → Node Readable, then gunzip if needed.
  const nodeStream = Readable.fromWeb(fetched.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  const stream: NodeJS.ReadableStream =
    doc.payload.compressionAlgorithm === 'GZIP' ? nodeStream.pipe(createGunzip()) : nodeStream;

  return { meta, stream };
}

/**
 * List existing reports of given type(s), without submitting a new one.
 *
 * Use for reports that Amazon AUTO-GENERATES on a schedule (settlements,
 * tax). We don't call createReport — we just discover what Amazon's
 * already produced and download each by document ID.
 *
 * Pagination via `nextToken`; this helper paginates until exhausted.
 *
 * Reference: GET /reports/2021-06-30/reports
 */
export interface ListReportsOpts {
  reportTypes: string[];
  marketplaceIds?: string[];
  /** Filter by Amazon's data window. `dataStartTime` is the report's
   *  `dataStartTime`, not when Amazon created the report. */
  createdSince?: Date;
  createdUntil?: Date;
  processingStatuses?: Array<'IN_QUEUE' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED' | 'FATAL'>;
  pageSize?: number;
}

export interface ListedReport {
  reportId: string;
  reportType: string;
  reportDocumentId?: string;
  marketplaceIds?: string[];
  processingStatus: 'IN_QUEUE' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED' | 'FATAL';
  dataStartTime?: string;
  dataEndTime?: string;
  createdTime?: string;
  processingStartTime?: string;
  processingEndTime?: string;
}

export async function listReports(client: SpApiClient, opts: ListReportsOpts): Promise<ListedReport[]> {
  const query: Record<string, string> = {
    reportTypes: opts.reportTypes.join(','),
    pageSize: String(opts.pageSize ?? 100),
  };
  if (opts.marketplaceIds && opts.marketplaceIds.length > 0) {
    query.marketplaceIds = opts.marketplaceIds.join(',');
  }
  if (opts.createdSince) query.createdSince = opts.createdSince.toISOString();
  if (opts.createdUntil) query.createdUntil = opts.createdUntil.toISOString();
  if (opts.processingStatuses && opts.processingStatuses.length > 0) {
    query.processingStatuses = opts.processingStatuses.join(',');
  }

  const all: ListedReport[] = [];
  let nextToken: string | undefined = undefined;
  for (let page = 0; page < 50; page++) {
    const q: Record<string, string> = { ...query };
    if (nextToken) {
      // Per Amazon docs: only nextToken may be sent on follow-up calls.
      Object.keys(q).forEach((k) => delete q[k]);
      q.nextToken = nextToken;
    }
    const qs = new URLSearchParams(q).toString();
    const got = await client.request<{ reports: ListedReport[]; nextToken?: string }>({
      method: 'GET',
      path: `/reports/2021-06-30/reports?${qs}`,
    });
    all.push(...(got.payload.reports ?? []));
    nextToken = got.payload.nextToken;
    if (!nextToken) break;
  }
  return all;
}

/**
 * Fetch a single report document by documentId, decompress if gzipped, and
 * return the raw text. Use after `listReports` to read an auto-generated
 * report.
 */
export async function fetchReportDocument(client: SpApiClient, reportDocumentId: string): Promise<string> {
  const doc = await client.request<GetReportDocumentResp>({
    method: 'GET',
    path: `/reports/2021-06-30/documents/${reportDocumentId}`,
  });
  const fetched = await fetch(doc.payload.url);
  if (!fetched.ok) {
    throw new Error(`Report document fetch failed (${fetched.status}): ${await fetched.text()}`);
  }
  const buf = Buffer.from(await fetched.arrayBuffer());
  return doc.payload.compressionAlgorithm === 'GZIP' ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
}

/**
 * Parse a TSV report (Amazon's default for most flat-file reports) into an
 * array of objects keyed by header column name. Trims, handles \r\n.
 */
export function parseTsv(rawText: string): Array<Record<string, string>> {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0]!.split('\t').map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split('\t');
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = (cells[j] ?? '').trim();
    }
    rows.push(row);
  }
  return rows;
}
