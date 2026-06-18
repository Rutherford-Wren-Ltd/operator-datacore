// ============================================================================
// V2 Settlement Report — settlement header + transaction lines ingest.
//
// Report type: GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2
// Response format: TSV
//
// What this is for: Amazon's bi-weekly bank pay-out reconciliation. The
// authoritative "money landing in our account" record — used by the
// analytics.cash_position_current view and any cash-flow rollup.
//
// Critical difference from other reports: Amazon AUTO-GENERATES settlement
// reports on its own schedule (~every 14 days per marketplace). We do NOT
// call createReport — we listReports to discover what Amazon's produced and
// download each one whose reportId we haven't seen before. This is also why
// the CLI uses --since (createdSince filter) instead of --from/--to.
//
// Flat-file shape: the V2 TSV has ONE header row at the top (settlement
// metadata only, transaction columns blank) followed by N transaction rows
// (settlement metadata REPEATED, plus transaction columns populated). We
// split this into:
//   brain.settlements        ← from the header row
//   brain.settlement_lines   ← from the transaction rows
//
// Idempotency:
//   - settlement_id is Amazon-issued, used as the PK on brain.settlements.
//     On re-ingest of an existing settlement we no-op via ON CONFLICT.
//   - settlement_lines uses a deterministic line_hash composed of the
//     settlement_id + ordering columns. This handles the corner case where
//     Amazon re-issues a settlement document with corrections.
//   - raw.sp_api_report serves as a "have we seen this report id" gate
//     so we skip the document fetch entirely for already-processed reports.
// ============================================================================

import { createHash } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { SpApiClient } from './client.js';
import { listReports, fetchReportDocument, parseTsv, type ListedReport } from './reports.js';

// Settlement reports older than 90 days are typically retained, but Amazon's
// support has variable answers on the exact cliff. 180 is the default we use
// on first run.
const SETTLEMENT_REPORT_TYPE = 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2';

/**
 * Number-format locale for a settlement report. UK = `1,234.56` (comma
 * thousands, dot decimal); EU = `1.234,56` (dot thousands, comma decimal).
 * 'unknown' means the report's currency wasn't mapped — parser falls back
 * to last-separator heuristic with a warning.
 */
export type NumericLocale = 'uk' | 'eu' | 'unknown';

/**
 * Map a settlement's currencyCode to the expected number-format locale.
 * Exported for the test fixtures. Add new currencies as RW expands.
 *
 * GBP/USD/CAD/MXN/AUD/SGD/JPY/etc use UK-style (comma thousands, dot decimal).
 * EUR and other CE-European currencies use EU-style (dot thousands, comma
 * decimal — empirically confirmed for EUR settlements,
 * [[amazon-sp-api-format-quirks]]).
 */
export function localeForCurrency(currency: string | null | undefined): NumericLocale {
  if (!currency) return 'unknown';
  const c = currency.toUpperCase();
  if (['GBP', 'USD', 'CAD', 'MXN', 'AUD', 'SGD', 'INR', 'JPY', 'BRL', 'AED', 'EGP'].includes(c)) return 'uk';
  if (['EUR', 'SEK', 'PLN', 'NOK', 'DKK', 'CZK', 'HUF', 'RON', 'BGN', 'HRK', 'TRY'].includes(c)) return 'eu';
  return 'unknown';
}

/**
 * Parse a settlement-report numeric, using the report's currency-derived
 * locale to disambiguate the previously-corruption-prone cases.
 *
 * Old heuristic-only parser silently corrupted the ambiguous "1,234" case:
 * in a UK report that's £1234, in an EU report it's €1.234, and the old
 * code unconditionally treated comma as decimal — so any UK comma-thousands
 * value silently lost 1000×. Flagged by project review 2026-06-15 as
 * Tier 1 #1.
 *
 * Rules:
 *   - Dot-only / no separator: direct parse, locale-independent.
 *   - Both separators: last separator is decimal (true in both UK and EU
 *     formats — the difference is which character is thousands). Locale
 *     used only for a consistency warning when the value's shape
 *     contradicts the declared locale.
 *   - Comma-only: locale decides. With 'uk', comma is thousands. With 'eu',
 *     comma is decimal. With 'unknown', fall back to the old
 *     "comma = decimal" heuristic AND emit a console.warn so it surfaces
 *     in the daily-sync log — operator can then add the currency to
 *     localeForCurrency() to remove the warning.
 *
 * Returns null for empty / unparseable input. Never returns NaN.
 */
export function parseNumeric(
  v: string | undefined | null,
  locale: NumericLocale = 'unknown',
): number | null {
  if (v === undefined || v === null || v === '') return null;

  const hasDot = v.includes('.');
  const hasComma = v.includes(',');

  if (hasDot && hasComma) {
    const looksEu = v.lastIndexOf(',') > v.lastIndexOf('.');
    if (locale !== 'unknown' && ((looksEu && locale === 'uk') || (!looksEu && locale === 'eu'))) {
      console.warn(
        `[settlements] mixed-separator value "${v}" looks ${looksEu ? 'EU' : 'UK'}-format ` +
        `but report locale is ${locale.toUpperCase()} — parsing per the value's apparent format, ` +
        `but worth investigating.`,
      );
    }
    const n = looksEu
      ? Number(v.replace(/\./g, '').replace(',', '.'))
      : Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  if (hasComma) {
    if (locale === 'eu') {
      const n = Number(v.replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    }
    if (locale === 'uk') {
      // In UK reports comma is always thousands. The old code's
      // "treat comma as decimal" was the silent-corruption source.
      const n = Number(v.replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    console.warn(
      `[settlements] comma-only value "${v}" with unknown locale — defaulting to ` +
      `"comma is decimal" (legacy behaviour). Add the currency to localeForCurrency() ` +
      `to remove this warning.`,
    );
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Settlement reports use the European date format `DD.MM.YYYY HH:MM:SS UTC`
 * (e.g. "20.05.2026 03:52:31 UTC"). This is distinct from the ISO 8601 used
 * elsewhere in SP-API — we have to parse it explicitly. Output is the ISO
 * 8601 form Postgres consumes (`YYYY-MM-DDTHH:MM:SSZ`).
 *
 * Falls through to verbatim pass-through for ISO 8601 inputs so the function
 * is safe if Amazon ever changes the format mid-cycle.
 */
function parseSettlementTimestamp(v: string | undefined): string | null {
  if (v === undefined || v === '') return null;
  // Datetime: "20.05.2026 03:52:31 UTC" (with optional trailing zone label)
  const dt = v.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:\s+UTC)?$/);
  if (dt) {
    const [, dd, mm, yyyy, hh, mi, ss] = dt;
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
  }
  // Date only: "20.05.2026" — line-level posted-date often has no time.
  const d = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (d) {
    const [, dd, mm, yyyy] = d;
    return `${yyyy}-${mm}-${dd}T00:00:00Z`;
  }
  return v; // Pass through anything else (already ISO, or shape Postgres can parse).
}

function hashLine(parts: Array<string | number | null | undefined>): string {
  const joined = parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('|');
  return createHash('sha256').update(joined).digest('hex').slice(0, 32);
}

export interface IngestSettlementsOpts {
  spClient: SpApiClient;
  pg: PgClient;
  connectionId: string;
  syncRunId: string;
  marketplaceIds: string[];
  /** Inclusive. Default 180 days back. */
  createdSince: Date;
}

export interface IngestSettlementsResult {
  reportsDiscovered: number;
  reportsSkippedAlreadyIngested: number;
  reportsParsed: number;
  settlementsUpserted: number;
  linesUpserted: number;
  /** Per-report processing summary for the CLI banner. */
  perReport: Array<{
    reportId: string;
    settlementId: string | null;
    marketplaceId: string | null;
    depositDate: string | null;
    totalAmount: number | null;
    currencyCode: string | null;
    lines: number;
  }>;
}

/**
 * Discover and ingest all settlement reports created since `createdSince`.
 *
 * For each report:
 *  1. Skip if `raw.sp_api_report` already has it (idempotency).
 *  2. Fetch the document, parse TSV.
 *  3. Extract the header row (transaction-type blank, settlement-id set)
 *     → upsert brain.settlements.
 *  4. Extract transaction rows → batch upsert brain.settlement_lines with
 *     deterministic line_hash.
 *
 * Idempotent — re-running re-discovers but skips already-ingested reports.
 */
export async function ingestSettlementsWindow(opts: IngestSettlementsOpts): Promise<IngestSettlementsResult> {
  const result: IngestSettlementsResult = {
    reportsDiscovered: 0,
    reportsSkippedAlreadyIngested: 0,
    reportsParsed: 0,
    settlementsUpserted: 0,
    linesUpserted: 0,
    perReport: [],
  };

  // List available reports. Filter to DONE only — IN_QUEUE/IN_PROGRESS would
  // 404 on document fetch; CANCELLED/FATAL have no document.
  const reports: ListedReport[] = await listReports(opts.spClient, {
    reportTypes: [SETTLEMENT_REPORT_TYPE],
    marketplaceIds: opts.marketplaceIds,
    createdSince: opts.createdSince,
    processingStatuses: ['DONE'],
    pageSize: 100,
  });
  result.reportsDiscovered = reports.length;

  for (const report of reports) {
    if (!report.reportDocumentId) continue; // Should be impossible with DONE filter but defensive.

    // Idempotency check: have we already processed this report?
    const existing = await opts.pg.query<{ raw_id: number; parsed_at: string | null }>(
      `SELECT raw_id, parsed_at FROM raw.sp_api_report
        WHERE report_type = $1 AND report_id = $2
        LIMIT 1`,
      [SETTLEMENT_REPORT_TYPE, report.reportId],
    );
    if (existing.rows.length > 0 && existing.rows[0]!.parsed_at !== null) {
      result.reportsSkippedAlreadyIngested += 1;
      continue;
    }

    // Fetch + parse
    const rawText = await fetchReportDocument(opts.spClient, report.reportDocumentId);
    const rows = parseTsv(rawText);
    if (rows.length === 0) continue;

    // Land raw payload (size only, not the bytes themselves)
    const rawInsert = await opts.pg.query<{ raw_id: number }>(
      `INSERT INTO raw.sp_api_report
        (connection_id, sync_run_id, report_type, report_id, document_id, marketplace_ids,
         data_start_time, data_end_time, processing_status, payload, payload_bytes, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb, $10, NOW())
       ON CONFLICT (report_type, report_id) DO UPDATE
         SET document_id = EXCLUDED.document_id,
             processing_status = EXCLUDED.processing_status,
             payload_bytes = EXCLUDED.payload_bytes,
             parsed_at = NULL
       RETURNING raw_id`,
      [
        opts.connectionId,
        opts.syncRunId,
        SETTLEMENT_REPORT_TYPE,
        report.reportId,
        report.reportDocumentId,
        report.marketplaceIds ?? opts.marketplaceIds,
        report.dataStartTime ?? null,
        report.dataEndTime ?? null,
        report.processingStatus,
        Buffer.byteLength(rawText, 'utf8'),
      ],
    );
    const rawId = rawInsert.rows[0]!.raw_id;

    // Identify the header row: V2 flat file has the settlement-id populated
    // on every row, but the header row has transaction-type empty.
    const headerRow = rows.find((r) => r['settlement-id'] && !r['transaction-type']);
    if (!headerRow) {
      // Either a malformed report or an empty settlement (no transactions).
      // Persist what we can from the first row and continue.
      result.perReport.push({
        reportId: report.reportId,
        settlementId: null,
        marketplaceId: null,
        depositDate: null,
        totalAmount: null,
        currencyCode: null,
        lines: 0,
      });
      await opts.pg.query('UPDATE raw.sp_api_report SET parsed_at = NOW() WHERE raw_id = $1', [rawId]);
      continue;
    }

    const settlementId = headerRow['settlement-id']!;
    const settlementMarketplace =
      report.marketplaceIds?.[0] ?? opts.marketplaceIds[0]!;
    const currency = (headerRow.currency || '').toUpperCase().slice(0, 3);
    // Locale for number parsing — derives from currency so EUR rows get
    // EU-format treatment, GBP/USD/etc get UK-format. See parseNumeric +
    // localeForCurrency above. The 'unknown' fallback emits a console.warn
    // when a comma-only value can't be safely disambiguated.
    const reportLocale = localeForCurrency(currency);

    // Header upsert
    await opts.pg.query(
      `INSERT INTO brain.settlements (
        settlement_id, marketplace_id,
        settlement_start_date, settlement_end_date, deposit_date,
        total_amount, currency_code, raw_id, ingested_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (settlement_id) DO UPDATE SET
        marketplace_id         = EXCLUDED.marketplace_id,
        settlement_start_date  = EXCLUDED.settlement_start_date,
        settlement_end_date    = EXCLUDED.settlement_end_date,
        deposit_date           = EXCLUDED.deposit_date,
        total_amount           = EXCLUDED.total_amount,
        currency_code          = EXCLUDED.currency_code,
        raw_id                 = EXCLUDED.raw_id,
        ingested_at            = NOW()`,
      [
        settlementId,
        settlementMarketplace,
        parseSettlementTimestamp(headerRow['settlement-start-date']),
        parseSettlementTimestamp(headerRow['settlement-end-date']),
        parseSettlementTimestamp(headerRow['deposit-date']),
        parseNumeric(headerRow['total-amount'], reportLocale) ?? 0,
        currency || 'GBP', // CHAR(3) NOT NULL — fall back if Amazon ever omits.
        rawId,
      ],
    );
    result.settlementsUpserted += 1;

    // Transaction line upserts.
    // We dedupe within the batch on line_hash because Amazon occasionally
    // emits two transactionally-identical rows (e.g. same fee/order/amount
    // twice in the same settlement) — those are real economic events that
    // *should* be counted, but they collide on a naive (settlement_id,
    // line_hash) PK. We include the line index in the hash material to
    // disambiguate.
    let linesThisReport = 0;
    let lineIndex = 0;
    for (const row of rows) {
      if (!row['settlement-id'] || !row['transaction-type']) continue;
      const txType = row['transaction-type'];
      const postedDate = parseSettlementTimestamp(row['posted-date']);
      const orderId = row['order-id'] || null;
      const sku = row.sku || null;
      const description = row['amount-description'] || null;
      // Per-line currency can differ from the settlement header currency
      // (rare — e.g. cross-border fees). Use the line's own locale.
      const lineCurrency = (row.currency || currency || '').toUpperCase().slice(0, 3);
      const lineLocale = lineCurrency === currency ? reportLocale : localeForCurrency(lineCurrency);
      const amount = parseNumeric(row.amount, lineLocale);

      const lineHash = hashLine([
        settlementId,
        txType,
        postedDate,
        orderId,
        sku,
        description,
        amount,
        row['amount-type'],
        lineIndex,
      ]);

      await opts.pg.query(
        `INSERT INTO brain.settlement_lines (
          settlement_id, line_hash, transaction_type, posted_date,
          amazon_order_id, sku, description, amount, currency_code, raw_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (settlement_id, line_hash) DO UPDATE SET
          transaction_type = EXCLUDED.transaction_type,
          posted_date      = EXCLUDED.posted_date,
          amazon_order_id  = EXCLUDED.amazon_order_id,
          sku              = EXCLUDED.sku,
          description      = EXCLUDED.description,
          amount           = EXCLUDED.amount,
          currency_code    = EXCLUDED.currency_code,
          raw_id           = EXCLUDED.raw_id`,
        [
          settlementId,
          lineHash,
          txType,
          postedDate,
          orderId,
          sku,
          description,
          amount,
          lineCurrency || null,
          rawId,
        ],
      );
      linesThisReport += 1;
      lineIndex += 1;
    }
    result.linesUpserted += linesThisReport;
    result.reportsParsed += 1;
    result.perReport.push({
      reportId: report.reportId,
      settlementId,
      marketplaceId: settlementMarketplace,
      depositDate: parseSettlementTimestamp(headerRow['deposit-date']),
      totalAmount: parseNumeric(headerRow['total-amount'], reportLocale),
      currencyCode: currency,
      lines: linesThisReport,
    });

    await opts.pg.query('UPDATE raw.sp_api_report SET parsed_at = NOW() WHERE raw_id = $1', [rawId]);
  }

  return result;
}
