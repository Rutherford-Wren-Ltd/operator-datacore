-- ============================================================================
-- 0046 — meta.report_fatal_marker: persistent record of FATAL/CANCELLED
-- (asin, marketplace, period) tuples so subsequent backfills can skip them
-- without spending another minute per tuple discovering Amazon still has no
-- data.
--
-- Why: PR #94 made SQP backfills catch FATAL/CANCELLED per-tuple and continue
-- without crashing; PR #98 added in-run retry for transient failures. Across
-- separate runs though, a tuple Amazon previously returned FATAL for (typically
-- a pre-launch period or a not-yet-published recent month) gets re-tried on
-- every subsequent run — burning ~60s per call to discover the same nothing.
-- This table records each (object, marketplace, asin, period) tuple Amazon
-- has flagged as having no data so the backfill CLI can skip it by default
-- (operator opts back in with --retry-fatals when they want to recheck a
-- previously-pre-launch ASIN whose data may have caught up).
--
-- Idempotent. Re-running this migration after rows exist does nothing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS meta.report_fatal_marker (
  object         TEXT       NOT NULL,
  marketplace_id TEXT       NOT NULL,
  asin           TEXT       NOT NULL,
  period_type    TEXT       NOT NULL,
  period_start   DATE       NOT NULL,
  reason         TEXT       NOT NULL CHECK (reason IN ('fatal', 'cancelled')),
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fail_count     INTEGER    NOT NULL DEFAULT 1,
  PRIMARY KEY (object, marketplace_id, asin, period_type, period_start)
);

COMMENT ON TABLE meta.report_fatal_marker IS
  'Persistent record of (object, marketplace, asin, period) tuples Amazon has returned FATAL/CANCELLED for. backfill-search-query CLI skips these by default; pass --retry-fatals to re-attempt (use when an ASIN that was previously pre-launch may now have data).';

CREATE INDEX IF NOT EXISTS idx_report_fatal_marker_by_object_market
  ON meta.report_fatal_marker (object, marketplace_id);
