-- ============================================================================
-- 0055 — turn on the freshness cadence for Search Query Performance (SQP)
--
-- Background: migration 0037 created meta.sync_freshness with a per-object
-- cadence baked into a CASE. SQP was left at NULL ("backfill / intermittent")
-- because at the time it was only ever pulled by hand. That NULL means the
-- dead-man's-switch never alerts on SQP, so the table can silently fall
-- behind. It did: as of 2026-07-15 the newest SQP period was May 2026 while
-- the last successful pull ran on 2 July, and nothing flagged the ~13-day gap.
--
-- SQP now runs on a schedule (.github/workflows/sqp-sync.yml: WEEK every
-- Wednesday, MONTH on the 8th). With a weekly successful run guaranteed, an
-- 8-day cap matches the other weekly objects (fba_returns, restock_engine)
-- and the "8d weekly" convention already documented on analytics.freshness_gate
-- (migration 0052). If a whole week goes by with no successful SQP run, the
-- daily-sync "Verify sync freshness" step (verify-sync-freshness CLI) now goes
-- red instead of staying silently green.
--
-- Idempotent: CREATE OR REPLACE VIEW. Only the SQP CASE branch changes versus
-- 0037; every column is identical so the downstream analytics.freshness_gate
-- view (0052), which selects FROM this view, keeps working unchanged.
-- ============================================================================

BEGIN;

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
    WHEN 'search_query_performance_report'     THEN 8 * 24  -- weekly (sqp-sync.yml: WEEK Wed, MONTH 8th)
    ELSE NULL                                               -- unknown = not alerted
  END AS expected_max_hours_since_success,
  ROUND(
    EXTRACT(EPOCH FROM (NOW() - last_success_at)) / 3600.0,
    1
  ) AS hours_since_last_success
FROM per_object
ORDER BY object, source;

COMMENT ON VIEW meta.sync_freshness IS
  'Dead-man''s-switch view: one row per (object, source) showing latest activity + a per-object cadence expectation. The verify-sync-freshness CLI fails CI when any object''s hours_since_last_success exceeds expected_max_hours_since_success. Per-object cadences are intentionally inline in the CASE so a new ingest object explicitly opts in to alerting — silent is better than false-positive. search_query_performance_report opted in at 8d (weekly) in migration 0055 once sqp-sync.yml began pulling on a schedule.';

INSERT INTO meta.migration_history (filename)
VALUES ('0055_sqp_freshness_cadence.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
