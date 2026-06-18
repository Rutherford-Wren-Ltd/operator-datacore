// ============================================================================
// finances-direction.test.ts
//
// Fixtures for finances.ts `direction()` — sign → credit/debit mapping.
// Part of Tier 4 #3 from project review (2026-06-15). The direction column
// drives every cash-flow rollup downstream; a silent flip (off-by-one zero
// handling, sign inversion, NaN seepage) would mean fees count as credits
// or vice versa, corrupting analytics.cash_position_current AND every
// /wbr cash section forever.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { direction } from '../../src/lib/sp-api/finances.js';

describe('finances.direction', () => {
  it('positive values are credits', () => {
    assert.equal(direction(1), 'credit');
    assert.equal(direction(0.01), 'credit');
    assert.equal(direction(1_000_000), 'credit');
  });

  it('negative values are debits', () => {
    assert.equal(direction(-1), 'debit');
    assert.equal(direction(-0.01), 'debit');
    assert.equal(direction(-1_000_000), 'debit');
  });

  it('zero is a credit (Amazon convention — zero-amount events are no-op credits, not refunds)', () => {
    // Inverting this would silently re-categorise every $0 line item as a
    // debit, which would mostly be fine for analytics but is a meaningful
    // semantic shift worth pinning down.
    assert.equal(direction(0), 'credit');
    assert.equal(direction(-0), 'credit');  // -0 === 0 in JS comparison
  });

  it('very small positive values are credits (no rounding to zero)', () => {
    assert.equal(direction(0.001), 'credit');
    assert.equal(direction(Number.MIN_VALUE), 'credit');
  });

  it('Infinity is a credit (degenerate but no crash)', () => {
    // We never expect Infinity in real Amazon data, but the function should
    // not throw — degenerate inputs land in some buckets cleanly.
    assert.equal(direction(Number.POSITIVE_INFINITY), 'credit');
    assert.equal(direction(Number.NEGATIVE_INFINITY), 'debit');
  });
});
