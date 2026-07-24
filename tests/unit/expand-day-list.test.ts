import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandDayList } from '../../src/lib/sp-api/sales-traffic.js';

const iso = (d: Date) => d.toISOString().slice(0, 10);

test('expandDayList — oldest-first spans the inclusive window in order', () => {
  const days = expandDayList(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-05T23:59:59Z'), false);
  assert.deepEqual(days.map(iso), ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
});

test('expandDayList — newest-first reverses the same set', () => {
  const days = expandDayList(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-05T23:59:59Z'), true);
  assert.deepEqual(days.map(iso), ['2026-01-05', '2026-01-04', '2026-01-03', '2026-01-02', '2026-01-01']);
});

test('expandDayList — both orders cover exactly the same days', () => {
  const from = new Date('2025-07-01T00:00:00Z');
  const to = new Date('2026-06-30T23:59:59Z');
  const oldest = expandDayList(from, to, false).map(iso).sort();
  const newest = expandDayList(from, to, true).map(iso).sort();
  assert.deepEqual(oldest, newest);
  assert.equal(oldest.length, 365);
});

test('expandDayList — single-day window', () => {
  const day = new Date('2026-03-15T00:00:00Z');
  assert.deepEqual(expandDayList(day, day, false).map(iso), ['2026-03-15']);
  assert.deepEqual(expandDayList(day, day, true).map(iso), ['2026-03-15']);
});
