-- ============================================================================
-- 0052_skill_support_layer.sql
-- The lake side of Project Simplify Workstream A + the learning rung.
--
-- Four objects the skills lean on so they stop re-embedding boilerplate and
-- start recording their own decisions:
--
--   (a) analytics.freshness_gate          — one row per ingest object with a
--       simple is_fresh boolean, derived from meta.sync_freshness. Skills read
--       this for their confidence block instead of restating cadence SQL.
--   (b) analytics.product_title_canonical — the (marketplace_id, asin, title)
--       fallback chain, baked once so every skill labels products identically.
--   (c) ops.decision_log                  — records each skill recommendation +
--       the operator's accept/reject/ship decision + the later verified outcome.
--       The foundation of the propose -> approve -> ship -> verify loop. The
--       skill NEVER writes here (G-WRITE-2); the operator runs the INSERT at
--       sign-off, and the outcome-check CLI writes the outcome_* columns later.
--   (d) analytics.system_health           — the one-query "is the system OK?"
--       view for anyone standing in for Chris (absence playbook / daily digest).
--
-- Additive + idempotent: CREATE OR REPLACE VIEW / CREATE TABLE IF NOT EXISTS,
-- safe to re-apply. ops.decision_log gets RLS + the operator_readwrite policy
-- to satisfy check:migrations' RLS-posture gate (see 0026).
--
-- NB numbering: main is at 0051; 0043-0045 / 0048-0050 are gaps from parallel
-- branches that never merged. This sits above the current max. CREATE ... IF
-- NOT EXISTS keeps a later renumber safe.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- (a) analytics.freshness_gate
-- Collapses meta.sync_freshness into a per-object boolean. is_fresh is:
--   NULL  — object has no cadence expectation (operator-driven / intermittent);
--           not alerted, not a failure.
--   false — expected but never succeeded, or stale past its threshold.
--   true  — last success within the threshold.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.freshness_gate AS
SELECT
  object,
  source,
  last_success_at,
  hours_since_last_success,
  expected_max_hours_since_success              AS threshold_hours,
  CASE
    WHEN expected_max_hours_since_success IS NULL THEN NULL
    WHEN last_success_at IS NULL                  THEN FALSE
    WHEN hours_since_last_success
         <= expected_max_hours_since_success      THEN TRUE
    ELSE FALSE
  END                                           AS is_fresh
FROM meta.sync_freshness;

COMMENT ON VIEW analytics.freshness_gate IS
  'Per-object is_fresh boolean derived from meta.sync_freshness (thresholds: 25h daily / 8d weekly / 35d monthly). Skills read this for the confidence-block footer instead of restating cadence SQL. is_fresh NULL = no cadence expectation (not alerted). See wiki/concepts/data-model.md.';

-- ---------------------------------------------------------------------------
-- (b) analytics.product_title_canonical
-- The documented title fallback chain, once:
--   inventory_health_by_asin.product_name  (spine)
--   -> most-recent brain.order_items.product_name for that asin  (fallback)
--   -> '[TITLE NOT IN LAKE]'
-- Spined on inventory_health_by_asin, so it covers every ASIN that has
-- inventory (which is every ASIN the restock/audit/pacing skills act on).
-- order_items has no marketplace_id, so the fallback is matched by asin only —
-- titles are marketplace-invariant enough to serve as a label of last resort.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.product_title_canonical AS
WITH oi_title AS (
  SELECT DISTINCT ON (asin)
    asin,
    product_name
  FROM brain.order_items
  WHERE product_name IS NOT NULL AND product_name <> ''
  ORDER BY asin, product_name          -- deterministic pick per asin
)
SELECT
  ih.marketplace_id,
  ih.asin,
  COALESCE(
    NULLIF(ih.product_name, ''),
    oi.product_name,
    '[TITLE NOT IN LAKE]'
  )                                     AS title,
  CASE
    WHEN NULLIF(ih.product_name, '') IS NOT NULL THEN 'inventory_health'
    WHEN oi.product_name IS NOT NULL             THEN 'order_items'
    ELSE 'missing'
  END                                   AS title_source
FROM analytics.inventory_health_by_asin ih
LEFT JOIN oi_title oi ON oi.asin = ih.asin;

COMMENT ON VIEW analytics.product_title_canonical IS
  'Canonical product title per (marketplace_id, asin) via the fallback chain inventory_health_by_asin -> order_items -> [TITLE NOT IN LAKE]. title_source flags which link was used. Spined on inventory_health, so ASINs with no inventory are absent (they are not actionable by the skills that consume this). See wiki/concepts/data-model.md identity rules.';

-- ---------------------------------------------------------------------------
-- (c) ops.decision_log
-- One row per skill recommendation that reaches an operator decision. The
-- learning rung: outcome_* columns are filled weeks later by the outcome-check
-- CLI so we can measure whether a shipped recommendation actually moved the
-- metric. Skills emit an INSERT-ready snippet; the operator runs it at sign-off.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.decision_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill               TEXT        NOT NULL,               -- e.g. 'restock-memo', 'ppc-audit'
  run_date            DATE        NOT NULL,
  asin                TEXT,
  marketplace_id      TEXT,
  subject             TEXT        NOT NULL,               -- human-readable what-this-is-about
  recommendation      TEXT        NOT NULL,               -- what the skill proposed
  decision            TEXT        CHECK (decision IN
                        ('accepted', 'accepted_modified', 'rejected', 'deferred')),
  decided_by          TEXT,
  decided_at          TIMESTAMPTZ,
  shipped_at          TIMESTAMPTZ,                        -- when the action went live (if it did)
  outcome_status      TEXT        CHECK (outcome_status IN
                        ('pending', 'improved', 'no_change', 'worsened', 'n/a')),
  outcome_note        TEXT,                               -- outcome-check CLI writes the measured delta
  outcome_checked_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decision_log_skill_date
  ON ops.decision_log (skill, run_date DESC);
CREATE INDEX IF NOT EXISTS idx_decision_log_outcome_pending
  ON ops.decision_log (shipped_at)
  WHERE outcome_status = 'pending' AND shipped_at IS NOT NULL;

COMMENT ON TABLE ops.decision_log IS
  'Skill recommendation -> operator decision -> verified outcome. The propose/approve/ship/verify learning loop. Skills never write here (G-WRITE-2): the operator runs an INSERT at sign-off; the outcome-check CLI fills outcome_* weeks later. decision: accepted/accepted_modified/rejected/deferred. outcome_status: pending/improved/no_change/worsened/n/a.';

-- RLS + operator_readwrite policy, matching every other ops table (0026).
-- Required or check:migrations' RLS-posture gate fails. service_role
-- (ingest CLIs, MCP) bypasses RLS; operator_readonly reaches this only via
-- analytics views, never directly.
ALTER TABLE ops.decision_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_readwrite_all ON ops.decision_log;
CREATE POLICY operator_readwrite_all ON ops.decision_log
  FOR ALL TO operator_readwrite
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- (d) analytics.system_health
-- The standing-in-for-Chris one-query check. Union of small health signals:
-- freshness per object, plus a decision-log follow-up count. Kept deliberately
-- lean — richer per-workflow status lives in meta.sync_freshness.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.system_health AS
SELECT
  'freshness'                                   AS signal,
  fg.object                                     AS detail,
  CASE
    WHEN fg.is_fresh IS NULL  THEN 'n/a'
    WHEN fg.is_fresh          THEN 'ok'
    ELSE 'STALE'
  END                                           AS status,
  fg.hours_since_last_success::numeric          AS value,
  fg.threshold_hours::numeric                   AS threshold
FROM analytics.freshness_gate fg
WHERE fg.threshold_hours IS NOT NULL

UNION ALL

SELECT
  'decisions_awaiting_outcome'                  AS signal,
  'shipped >21d, outcome still pending'         AS detail,
  CASE WHEN COUNT(*) = 0 THEN 'ok' ELSE 'REVIEW' END AS status,
  COUNT(*)::numeric                             AS value,
  0::numeric                                    AS threshold
FROM ops.decision_log
WHERE outcome_status = 'pending'
  AND shipped_at IS NOT NULL
  AND shipped_at <= now() - INTERVAL '21 days';

COMMENT ON VIEW analytics.system_health IS
  'One-query "is the system OK?" for absence cover / daily digest: per-object freshness (STALE = past cadence threshold) plus shipped decisions whose outcome-check is overdue. Extend with more UNION ALL signals as they earn their place.';

COMMIT;
