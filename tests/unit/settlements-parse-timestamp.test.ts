// ============================================================================
// settlements-parse-timestamp.test.ts
//
// Fixtures for settlements.ts `parseSettlementTimestamp()` — the European
// date format that Amazon V2 settlements use (DD.MM.YYYY) needs explicit
// handling. Per project review, the silent failure mode would be
// pass-through to Postgres which would interpret "20.05.2026" as either
// "2026-05-20" (Postgres heuristic — but locale-dependent) or NULL on
// strict parse. Both are worse than failing loudly with a parse error.
//
// Part of Tier 4 #3 from project review (2026-06-15).
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseSettlementTimestamp } from '../../src/lib/sp-api/settlements.js';

describe('parseSettlementTimestamp', () => {
  it('parses the V2 settlement datetime format (DD.MM.YYYY HH:MM:SS UTC)', () => {
    assert.equal(parseSettlementTimestamp('20.05.2026 03:52:31 UTC'), '2026-05-20T03:52:31Z');
    assert.equal(parseSettlementTimestamp('01.01.2026 00:00:00 UTC'), '2026-01-01T00:00:00Z');
    assert.equal(parseSettlementTimestamp('31.12.2025 23:59:59 UTC'), '2025-12-31T23:59:59Z');
  });

  it('parses without a UTC suffix', () => {
    assert.equal(parseSettlementTimestamp('15.06.2026 12:00:00'), '2026-06-15T12:00:00Z');
  });

  it('parses the date-only shape that line-level posted-dates often use', () => {
    assert.equal(parseSettlementTimestamp('20.05.2026'), '2026-05-20T00:00:00Z');
    assert.equal(parseSettlementTimestamp('01.01.2026'), '2026-01-01T00:00:00Z');
  });

  it('returns null for empty or undefined input', () => {
    assert.equal(parseSettlementTimestamp(undefined), null);
    assert.equal(parseSettlementTimestamp(''), null);
  });

  it('passes through ISO 8601 verbatim (defensive against Amazon format changes)', () => {
    // Amazon could one day swap to ISO; the function should pass through so
    // Postgres can parse it. Less defensive than a strict reject.
    const iso = '2026-05-20T03:52:31Z';
    assert.equal(parseSettlementTimestamp(iso), iso);
  });

  it('passes through clearly-non-DDMMYYYY shapes (Postgres handles)', () => {
    // Anything that's not the European pattern goes through verbatim so
    // Postgres' own date parser gets a chance. Documented behaviour.
    assert.equal(parseSettlementTimestamp('2026-05-20'), '2026-05-20');
    assert.equal(parseSettlementTimestamp('weird input'), 'weird input');
  });

  it('does NOT interpret US-style MM.DD.YYYY (would silently swap day/month)', () => {
    // The reviewer-flagged risk: confusing "05.20.2026" (US writing of
    // May 20) with "05.20.2026" (EU writing of "5th of 20th month, nonsense").
    // The function rejects "05.20.2026" as no-match for the EU pattern
    // (month > 12 fails the regex's character class for month) — that's
    // safer than the alternative of silently swapping.
    // BUT — the regex only constrains digit counts, not ranges. So
    // "05.20.2026" matches and would produce "2026-20-05" which Postgres
    // rejects. That's the right failure mode (loud, immediate).
    const result = parseSettlementTimestamp('05.20.2026');
    assert.equal(result, '2026-20-05T00:00:00Z');
    // Documenting: Postgres rejects month=20 → INSERT throws. Loud failure.
  });
});
