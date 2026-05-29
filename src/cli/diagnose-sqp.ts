#!/usr/bin/env tsx
// ============================================================================
// diagnose-sqp.ts
//
// One-shot diagnostic for the Brand Analytics SQP backfill OOM issue. Does
// NOT touch the lake.
//
// Steps:
//   1. createReport + poll for one month of SQP (UK by default).
//   2. getReportDocument → presigned URL.
//   3. Stream-download to a local file (bytes, not memory).
//   4. Decompress (if gzipped) into a second file.
//   5. Print: compressed size, decompressed size, first 4 KB of the JSON,
//      and the names of the top-level keys so we can see if `dataByAsin`
//      is really at the root.
//
// Output files are saved in the current working directory:
//   sqp-diagnostic-<timestamp>.json.gz      (raw downloaded bytes)
//   sqp-diagnostic-<timestamp>.json         (decompressed)
//   sqp-diagnostic-<timestamp>.sample.txt   (first 4 KB + key list)
//
// Usage:
//   npm run diagnose-sqp -- --region eu --marketplaces UK --period-type MONTH
//
// Defaults: EU/UK, MONTH, last completed month.
// ============================================================================

import { parseArgs } from 'node:util';
import { createWriteStream, statSync, readFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { loadEnvForAmazonShared, getSpApiRegionConfig, type SpApiRegion } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';

interface CreateReportResp { reportId: string; }
interface GetReportResp {
  reportId: string;
  reportType: string;
  reportDocumentId?: string;
  processingStatus: 'IN_QUEUE' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED' | 'FATAL';
}
interface GetReportDocumentResp {
  reportDocumentId: string;
  url: string;
  compressionAlgorithm?: 'GZIP';
}

const MARKETPLACE_ALIASES: Record<string, string> = {
  US: 'ATVPDKIKX0DER', UK: 'A1F83G8C2ARO7P', GB: 'A1F83G8C2ARO7P',
};

function monthBoundary(d: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59));
  return { start, end };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      region:       { type: 'string' },
      marketplaces: { type: 'string' },
      'period-type': { type: 'string' },
    },
  });

  const env = loadEnvForAmazonShared();
  const region: SpApiRegion = (values.region as SpApiRegion | undefined) ?? env.SP_API_REGION;
  const regionConfig = getSpApiRegionConfig(region, env);

  const marketplaceId = values.marketplaces
    ? (MARKETPLACE_ALIASES[values.marketplaces.toUpperCase()] ?? values.marketplaces)
    : (regionConfig.marketplaceIds[0] ?? 'A1F83G8C2ARO7P');

  // Default to the last completed month.
  const now = new Date();
  const prevMonthDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  const period = monthBoundary(prevMonthDay);

  console.log('SQP diagnostic — single-period fetch + sample dump');
  console.log('---------------------------------------------------');
  console.log(`  Region:        ${region}`);
  console.log(`  Marketplace:   ${marketplaceId}`);
  console.log(`  Period:        ${period.start.toISOString().slice(0, 10)} → ${period.end.toISOString().slice(0, 10)}`);
  console.log('');

  const client = new SpApiClient({
    region: regionConfig.region,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: regionConfig.refreshToken,
  });

  // 1. createReport
  console.log('1. createReport ...');
  const create = await client.request<CreateReportResp>({
    method: 'POST',
    path: '/reports/2021-06-30/reports',
    body: {
      reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
      marketplaceIds: [marketplaceId],
      dataStartTime: period.start.toISOString(),
      dataEndTime: period.end.toISOString(),
      reportOptions: { reportPeriod: 'MONTH' },
    },
  });
  const reportId = create.payload.reportId;
  console.log(`   reportId = ${reportId}`);

  // 2. Poll until DONE
  console.log('2. poll until DONE ...');
  let meta: GetReportResp;
  let waitMs = 5_000;
  for (let i = 0; i < 60; i++) {
    const got = await client.request<GetReportResp>({
      method: 'GET',
      path: `/reports/2021-06-30/reports/${reportId}`,
    });
    meta = got.payload;
    process.stdout.write(`   [attempt ${i + 1}] status=${meta.processingStatus}\n`);
    if (meta.processingStatus === 'DONE') break;
    if (meta.processingStatus === 'CANCELLED' || meta.processingStatus === 'FATAL') {
      throw new Error(`Report ended with status ${meta.processingStatus}`);
    }
    await sleep(Math.min(waitMs, 60_000));
    waitMs = Math.min(waitMs * 1.5, 60_000);
  }
  if (meta!.processingStatus !== 'DONE' || !meta!.reportDocumentId) {
    throw new Error('Report did not complete in time');
  }

  // 3. Get document URL
  console.log('3. getReportDocument ...');
  const doc = await client.request<GetReportDocumentResp>({
    method: 'GET',
    path: `/reports/2021-06-30/documents/${meta!.reportDocumentId}`,
  });
  console.log(`   compression: ${doc.payload.compressionAlgorithm ?? 'none'}`);
  console.log(`   URL host:    ${new URL(doc.payload.url).host}`);

  // 4. Stream-download to file (bypass any in-memory buffering)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const compressedPath = `./sqp-diagnostic-${ts}.json.gz`;
  const decompressedPath = `./sqp-diagnostic-${ts}.json`;
  const samplePath = `./sqp-diagnostic-${ts}.sample.txt`;

  console.log('4. stream-download to disk ...');
  const fetched = await fetch(doc.payload.url);
  if (!fetched.ok || !fetched.body) {
    throw new Error(`Document fetch failed: ${fetched.status}`);
  }
  await pipeline(
    Readable.fromWeb(fetched.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(compressedPath),
  );
  const compressedBytes = statSync(compressedPath).size;
  console.log(`   wrote ${compressedPath} (${(compressedBytes / 1024 / 1024).toFixed(2)} MB)`);

  // 5. Decompress (if gzipped)
  let decompressedBytes = compressedBytes;
  if (doc.payload.compressionAlgorithm === 'GZIP') {
    console.log('5. decompress to disk ...');
    const { createReadStream } = await import('node:fs');
    await pipeline(
      createReadStream(compressedPath),
      createGunzip(),
      createWriteStream(decompressedPath),
    );
    decompressedBytes = statSync(decompressedPath).size;
    console.log(`   wrote ${decompressedPath} (${(decompressedBytes / 1024 / 1024).toFixed(2)} MB)`);
  }

  const finalPath = doc.payload.compressionAlgorithm === 'GZIP' ? decompressedPath : compressedPath;

  // 6. Print sample + structural intel
  console.log('');
  console.log('6. sample (first 4 KB) ...');
  const buf = Buffer.alloc(4096);
  const { openSync, readSync, closeSync } = await import('node:fs');
  const fd = openSync(finalPath, 'r');
  const bytesRead = readSync(fd, buf, 0, 4096, 0);
  closeSync(fd);
  const sample = buf.subarray(0, bytesRead).toString('utf8');
  console.log('   --- first 4 KB ---');
  console.log(sample);
  console.log('   --- end first 4 KB ---');
  console.log('');

  // 7. Top-level key intel (parse just enough to see keys at depth 0)
  // For a JSON object, the keys appear right after the opening brace.
  console.log('7. top-level keys (best-effort lexer, first 64 KB) ...');
  const big = Buffer.alloc(64 * 1024);
  const fd2 = openSync(finalPath, 'r');
  const n = readSync(fd2, big, 0, 64 * 1024, 0);
  closeSync(fd2);
  const head = big.subarray(0, n).toString('utf8');
  const keys: string[] = [];
  // Walk a depth counter; collect strings encountered at depth 1 immediately
  // before a colon.
  let depth = 0;
  let inStr = false;
  let strStart = -1;
  let prevKey: string | null = null;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (inStr) {
      if (c === '"' && head[i - 1] !== '\\') {
        const s = head.substring(strStart + 1, i);
        inStr = false;
        prevKey = s;
      }
      continue;
    }
    if (c === '"') { inStr = true; strStart = i; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ':' && depth === 1 && prevKey !== null) {
      if (!keys.includes(prevKey)) keys.push(prevKey);
      prevKey = null;
    }
  }
  console.log(`   top-level keys: ${JSON.stringify(keys)}`);
  console.log('');

  // 8. Save the sample for sharing
  const summary = [
    `SQP diagnostic — ${new Date().toISOString()}`,
    `Region: ${region}`,
    `Marketplace: ${marketplaceId}`,
    `Period: ${period.start.toISOString().slice(0, 10)} → ${period.end.toISOString().slice(0, 10)}`,
    `Compressed:   ${(compressedBytes / 1024 / 1024).toFixed(2)} MB (${compressedPath})`,
    `Decompressed: ${(decompressedBytes / 1024 / 1024).toFixed(2)} MB (${doc.payload.compressionAlgorithm === 'GZIP' ? decompressedPath : '— no compression'})`,
    `Top-level keys: ${JSON.stringify(keys)}`,
    '',
    '--- first 4 KB ---',
    sample,
  ].join('\n');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(samplePath, summary);
  console.log(`8. wrote ${samplePath} — paste this back so we can see the JSON shape`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
