-- ============================================================================
-- 0037 — meta.sync_freshness view + one-off zombie sync_run cleanup
--
-- Surfaces the most recent successful run per ingest object, the time since,
-- and a `fresh` flag derived from a per-object cadence expectation. Powers the
-- "dead man's switch" alert wired into the daily-sync workflow (see the
-- "Verify sync freshness" step at the end of .github/workflows/daily-sync.yml).
--
-- Also includes a one-off UPDATE to mark abandoned `running` sync_run rows as
-- `failed`. These accumulated pre-PR #94 / #98 when SQP backfill crashes
-- bypassed the sync_run-finalisation update; ~28 rows as of 2026-06-18.
-- The UPDATE is idempotent — re-running it does nothing because the WHERE
-- clause requires finished_at IS NULL, which won't be true after the first run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (a) Backfill: mark long-running orphaned `running` rows as `failed`.
-- Any row that's been "running" for >6h with no finished_at is a crash
-- artefact — Amazon SP-API reports never legitimately take that long; even
-- a 17-month SQP backfill is hundreds of short individual calls, not one
-- multi-hour transaction.
-- ---------------------------------------------------------------------------
UPDATE meta.sync_run
SET
  status        = 'failed',
  finished_at   = NOW(),
  error_message = COALESCE(error_message, '')
                  || 'Auto-marked failed by migration 0037: orphaned >6h with no finished_at, likely a pre-PR #94/#98 SQP/sales-traffic CLI crash that exited before the sync_run-finalisation UPDATE.'
WHERE status = 'running'
  AND finished_at IS NULL
  AND started_at < NOW() - INTERVAL '6 hours';

-- ---------------------------------------------------------------------------
-- (b) View: meta.sync_freshness
-- One row per (object, source) showing latest activity. The `fresh` column
-- compares hours_since_last_success against an inline cadence expectation
-- baked into the view — adjust the CASE branch as new objects come online.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW meta.sync_freshness AS
WITH per_object AS (
  SELECT
    object,
    source,
    MAX(finished_at) FILTER (WHERE status = 'success')              AS last_success_at,
    MAX(started_at)                                                  AS last_run_started_at,
    (ARRAY_AGG(status ORDER BY started_at DESC NULLS LAST))[1]      AS last_run_status,
    COUNT(*) FILTER (
      WHERE status = 'failed' AND started_at > NOW() - INTERVAL '24 hours'
    )                                                                AS failures_last_24h,
    COUNT(*) FILTER (
      WHERE status = 'success' AND started_at > NOW() - INTERVAL '7 days'
    )                                                                AS successes_last_7d
  FROM meta.sync_run
  WHERE object IS NOT NULL
  GROUP BY object, source
)
SELECT
  object,
  source,
  last_success_at,
  last_run_started_at,
  last_run_status,
  failures_last_24h,
  successes_last_7d,
  -- Per-object expected cadence in hours. Used by verify-sync-freshness CLI
  -- to decide whether an object is stale enough to fire the alert. Keep this
  -- list in sync with the CLI's CADENCE_HOURS map.
  CASE object
    WHEN 'orders_report'                       THEN 25      -- daily + small safety
    WHEN 'sales_traffic_report'                THEN 25
    WHEN 'financial_events'                    THEN 25
    WHEN 'settlement_report'                   THEN 25
    WHEN 'fba_inventory_snapshot'              THEN 8 * 24  -- weekly
    WHEN 'fba_storage_fees'                    THEN 35 * 24 -- monthly (early/mid month)
    WHEN 'fba_returns'                         THEN 8 * 24  -- weekly
    WHEN 'fba_item_dimensions'                 THEN 35 * 24 -- monthly
    WHEN 'restock_engine'                      THEN 8 * 24  -- weekly
    WHEN 'master_import'                       THEN NULL    -- operator-driven, ignore
    WHEN 'purchase_orders'                     THEN NULL    -- operator-driven, ignore
    WHEN 'search_query_performance_report'     THEN NULL    -- backfill / intermittent
    ELSE NULL                                               -- unknown = not alerted
  END AS expected_max_hours_since_success,
  ROUND(
    EXTRACT(EPOCH FROM (NOW() - last_success_at)) / 3600.0,
    1
  ) AS hours_since_last_success
FROM per_object
ORDER BY object, source;

COMMENT ON VIEW meta.sync_freshness IS
  'Dead-man''s-switch view: one row per (object, source) showing latest activity + a per-object cadence expectation. The verify-sync-freshness CLI fails CI when any object''s hours_since_last_success exceeds expected_max_hours_since_success. Per-object cadences are intentionally inline in the CASE so a new ingest object explicitly opts in to alerting — silent is better than false-positive.';
