import { gunzipSync, createGunzip } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { SpApiClient } from './client.js';

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
 * End-to-end Reports API helper:
 *   1. createReport → reportId
 *   2. poll getReport until DONE (or CANCELLED/FATAL)
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
  let meta: GetReportResp;
  let waitMs = 5_000;
  const maxWaitMs = 60_000;

  for (let i = 0; i < 60; i++) {
    const got = await client.request<GetReportResp>({
      method: 'GET',
      path: `/reports/2021-06-30/reports/${reportId}`,
    });
    meta = got.payload;
    if (meta.processingStatus === 'DONE') break;
    if (meta.processingStatus === 'CANCELLED' || meta.processingStatus === 'FATAL') {
      throw new Error(`Report ${reportId} ended with status ${meta.processingStatus}`);
    }
    await sleep(Math.min(waitMs, maxWaitMs));
    waitMs = Math.min(waitMs * 1.5, maxWaitMs);
  }

  if (meta!.processingStatus !== 'DONE' || !meta!.reportDocumentId) {
    throw new Error(`Report ${reportId} did not complete in time. Status: ${meta!.processingStatus}`);
  }

  const doc = await client.request<GetReportDocumentResp>({
    method: 'GET',
    path: `/reports/2021-06-30/documents/${meta!.reportDocumentId}`,
  });

  const fetched = await fetch(doc.payload.url);
  if (!fetched.ok) {
    throw new Error(`Report document fetch failed (${fetched.status}): ${await fetched.text()}`);
  }
  const buf = Buffer.from(await fetched.arrayBuffer());
  const rawText =
    doc.payload.compressionAlgorithm === 'GZIP' ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');

  return { meta: meta!, rawText };
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
  let meta: GetReportResp;
  let waitMs = 5_000;
  const maxWaitMs = 60_000;

  for (let i = 0; i < 60; i++) {
    const got = await client.request<GetReportResp>({
      method: 'GET',
      path: `/reports/2021-06-30/reports/${reportId}`,
    });
    meta = got.payload;
    if (meta.processingStatus === 'DONE') break;
    if (meta.processingStatus === 'CANCELLED' || meta.processingStatus === 'FATAL') {
      throw new Error(`Report ${reportId} ended with status ${meta.processingStatus}`);
    }
    await sleep(Math.min(waitMs, maxWaitMs));
    waitMs = Math.min(waitMs * 1.5, maxWaitMs);
  }

  if (meta!.processingStatus !== 'DONE' || !meta!.reportDocumentId) {
    throw new Error(`Report ${reportId} did not complete in time. Status: ${meta!.processingStatus}`);
  }

  const doc = await client.request<GetReportDocumentResp>({
    method: 'GET',
    path: `/reports/2021-06-30/documents/${meta!.reportDocumentId}`,
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

  return { meta: meta!, bytesWritten: statSync(filePath).size };
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
  let meta: GetReportResp;
  let waitMs = 5_000;
  const maxWaitMs = 60_000;

  for (let i = 0; i < 60; i++) {
    const got = await client.request<GetReportResp>({
      method: 'GET',
      path: `/reports/2021-06-30/reports/${reportId}`,
    });
    meta = got.payload;
    if (meta.processingStatus === 'DONE') break;
    if (meta.processingStatus === 'CANCELLED' || meta.processingStatus === 'FATAL') {
      throw new Error(`Report ${reportId} ended with status ${meta.processingStatus}`);
    }
    await sleep(Math.min(waitMs, maxWaitMs));
    waitMs = Math.min(waitMs * 1.5, maxWaitMs);
  }

  if (meta!.processingStatus !== 'DONE' || !meta!.reportDocumentId) {
    throw new Error(`Report ${reportId} did not complete in time. Status: ${meta!.processingStatus}`);
  }

  const doc = await client.request<GetReportDocumentResp>({
    method: 'GET',
    path: `/reports/2021-06-30/documents/${meta!.reportDocumentId}`,
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

  return { meta: meta!, stream };
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
