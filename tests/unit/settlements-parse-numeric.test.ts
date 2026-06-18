// ============================================================================
// settlements-parse-numeric.test.ts
//
// First foundational unit test for the operator-datacore CLI (Tier 4 #3 from
// project review 2026-06-15). Covers parseNumeric + localeForCurrency in
// src/lib/sp-api/settlements.ts — the silent-money-corruption surface the
// review flagged as Tier 1 #1.
//
// Uses Node's built-in test runner (no jest/vitest dep). Run via:
//   npm test
//
// Add more fixtures here as new locale edge-cases are discovered. The CLI
// suppresses console.warn output during tests via the t.mock.method calls,
// so the "unknown locale" warning paths don't pollute test output.
// ============================================================================

import { describe, it, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { parseNumeric, localeForCurrency } from '../../src/lib/sp-api/settlements.js';

// ---------------------------------------------------------------------------
// Suppress console.warn for test runs. parseNumeric warns on the legacy
// "unknown locale + comma-only" path; those warnings are part of the
// production-facing UX, not the test's signal.
// ---------------------------------------------------------------------------
let warnSpy: ReturnType<typeof mock.method>;
before(() => {
  warnSpy = mock.method(console, 'warn', () => {});
});
after(() => {
  warnSpy.mock.restore();
});

describe('localeForCurrency', () => {
  it('returns uk for comma-thousands currencies', () => {
    assert.equal(localeForCurrency('GBP'), 'uk');
    assert.equal(localeForCurrency('USD'), 'uk');
    assert.equal(localeForCurrency('CAD'), 'uk');
    assert.equal(localeForCurrency('MXN'), 'uk');
    assert.equal(localeForCurrency('AUD'), 'uk');
    assert.equal(localeForCurrency('JPY'), 'uk');
  });

  it('returns eu for comma-decimal currencies', () => {
    assert.equal(localeForCurrency('EUR'), 'eu');
    assert.equal(localeForCurrency('SEK'), 'eu');
    assert.equal(localeForCurrency('PLN'), 'eu');
    assert.equal(localeForCurrency('TRY'), 'eu');
  });

  it('is case-insensitive', () => {
    assert.equal(localeForCurrency('gbp'), 'uk');
    assert.equal(localeForCurrency('eur'), 'eu');
  });

  it('returns unknown for null / empty / unmapped', () => {
    assert.equal(localeForCurrency(null), 'unknown');
    assert.equal(localeForCurrency(undefined), 'unknown');
    assert.equal(localeForCurrency(''), 'unknown');
    assert.equal(localeForCurrency('XYZ'), 'unknown');
  });
});

describe('parseNumeric — unambiguous', () => {
  it('handles empty / null / undefined as null', () => {
    assert.equal(parseNumeric(undefined), null);
    assert.equal(parseNumeric(null), null);
    assert.equal(parseNumeric(''), null);
  });

  it('parses integers locale-independently', () => {
    assert.equal(parseNumeric('1234', 'uk'), 1234);
    assert.equal(parseNumeric('1234', 'eu'), 1234);
    assert.equal(parseNumeric('1234', 'unknown'), 1234);
    assert.equal(parseNumeric('0', 'uk'), 0);
    assert.equal(parseNumeric('-42', 'eu'), -42);
  });

  it('parses dot-only as locale-independent decimal', () => {
    assert.equal(parseNumeric('1234.56', 'uk'), 1234.56);
    assert.equal(parseNumeric('1234.56', 'eu'), 1234.56);
    assert.equal(parseNumeric('0.05', 'uk'), 0.05);
    assert.equal(parseNumeric('-1.23', 'eu'), -1.23);
  });

  it('returns null for garbage', () => {
    assert.equal(parseNumeric('not a number', 'uk'), null);
    assert.equal(parseNumeric('n/a', 'eu'), null);
    assert.equal(parseNumeric('--', 'unknown'), null);
  });
});

describe('parseNumeric — mixed separators (both . and ,)', () => {
  it('parses UK-format mixed: last separator is dot decimal', () => {
    assert.equal(parseNumeric('1,234.56', 'uk'), 1234.56);
    assert.equal(parseNumeric('1,234,567.89', 'uk'), 1234567.89);
  });

  it('parses EU-format mixed: last separator is comma decimal', () => {
    assert.equal(parseNumeric('1.234,56', 'eu'), 1234.56);
    assert.equal(parseNumeric('1.234.567,89', 'eu'), 1234567.89);
  });

  it('parses mixed shape correctly even when locale not provided', () => {
    // The last-separator heuristic works without a locale hint for the
    // mixed case — only the comma-only case needs the hint.
    assert.equal(parseNumeric('1,234.56', 'unknown'), 1234.56);
    assert.equal(parseNumeric('1.234,56', 'unknown'), 1234.56);
  });

  it('warns when value shape contradicts declared locale', () => {
    // EU-looking value declared as UK locale — still parses per the value's
    // shape (the value wins) but should emit a warning.
    const before = warnSpy.mock.callCount();
    assert.equal(parseNumeric('1.234,56', 'uk'), 1234.56);
    assert.ok(warnSpy.mock.callCount() > before, 'expected console.warn for shape/locale mismatch');
  });
});

describe('parseNumeric — comma-only (the silent-corruption case)', () => {
  // The PR fix specifically addresses this case. Pre-fix code treated comma
  // as decimal unconditionally — fine for EU, silently 1000× wrong for UK
  // when the value is something like "1,234" meaning £1234.

  it('UK locale: comma is thousands, never decimal', () => {
    assert.equal(parseNumeric('1,234', 'uk'), 1234);
    assert.equal(parseNumeric('1,234,567', 'uk'), 1234567);
    // The reviewer-flagged silent-corruption case: pre-fix returned 1.234.
    assert.notEqual(parseNumeric('1,234', 'uk'), 1.234);
  });

  it('EU locale: comma is decimal', () => {
    assert.equal(parseNumeric('1,234', 'eu'), 1.234);
    assert.equal(parseNumeric('0,05', 'eu'), 0.05);
    assert.equal(parseNumeric('-12,99', 'eu'), -12.99);
  });

  it('unknown locale: falls back to legacy "comma is decimal" + warns', () => {
    const before = warnSpy.mock.callCount();
    assert.equal(parseNumeric('1,234', 'unknown'), 1.234);
    assert.ok(warnSpy.mock.callCount() > before, 'expected console.warn for unknown-locale fallback');
  });
});

describe('parseNumeric — call-site integration shapes (what Amazon actually emits)', () => {
  // The 6 locale-combo fixtures the project review explicitly asked for.
  // Each row is (raw amazon value, currency, expected parsed value).
  const fixtures: Array<[string, string, number]> = [
    ['1234',     'GBP', 1234],     // UK integer
    ['1234',     'EUR', 1234],     // EU integer (no separators → same)
    ['1234.56',  'GBP', 1234.56],  // UK simple decimal
    ['1234,56',  'EUR', 1234.56],  // EU simple decimal
    ['1,234.56', 'GBP', 1234.56],  // UK thousands+decimal
    ['1.234,56', 'EUR', 1234.56],  // EU thousands+decimal
  ];

  for (const [raw, currency, expected] of fixtures) {
    it(`"${raw}" with currency ${currency} → ${expected}`, () => {
      const locale = localeForCurrency(currency);
      assert.equal(parseNumeric(raw, locale), expected);
    });
  }
});
