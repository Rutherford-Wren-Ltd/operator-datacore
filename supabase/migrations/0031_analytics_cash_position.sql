-- ============================================================================
-- 0031_analytics_cash_position.sql
-- analytics.cash_position_current — per-marketplace cash position rollup
-- for the WBR cash section and operator dashboards.
--
-- Grain: one row per (marketplace_id, currency_code). Stays in native
-- currency per marketplace (no FX rollup) — operator sees what Amazon is
-- actually wiring.
--
-- Columns answer three operator questions:
--   1. "How much cash is landing in the next two weeks?"  → arriving_14d
--   2. "When was the last settlement and how big was it?" → last_settlement_*
--   3. "How much have we earned but not yet been paid?"   → earned_unsettled
--
-- Earned-but-not-settled is the gap between sales recognised on the
-- listFinancialEvents stream and the most recent settlement window end.
-- During ramp-up periods (peak season, ad-spend lifts), this gap can be
-- material — operators need to see it to plan supplier payments.
--
-- Direction semantics on brain.financial_events: `amount` is the absolute
-- value, `direction` is 'credit' (money to RW) or 'debit' (money out).
-- All sums net by direction.
--
-- See:
--   - brain.settlements / brain.settlement_lines      (Amazon settlements ingest)
--   - brain.financial_events                          (listFinancialEvents ingest)
--   - .github/workflows/daily-sync.yml :: phase7-ingests
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW analytics.cash_position_current AS
WITH
upcoming AS (
    -- Settlements that have a deposit_date scheduled in the next 14 days.
    -- Amazon writes deposit_date when the settlement closes, before the
    -- bank transfer fires, so these are "money in transit" not "money in
    -- bank".
    SELECT marketplace_id,
           currency_code,
           SUM(total_amount)        AS arriving_14d,
           COUNT(*)                 AS arriving_count,
           MIN(deposit_date)::date  AS next_settlement_date
    FROM brain.settlements
    WHERE deposit_date >= CURRENT_DATE
      AND deposit_date <  CURRENT_DATE + INTERVAL '14 days'
    GROUP BY marketplace_id, currency_code
),
last_paid AS (
    -- Most recent settlement that has already deposited (deposit_date in
    -- the past). One row per (marketplace, currency). The settlement
    -- window end is what we use to bound "earned but not yet settled".
    SELECT DISTINCT ON (marketplace_id, currency_code)
           marketplace_id,
           currency_code,
           deposit_date::date         AS last_settlement_date,
           total_amount               AS last_settlement_amount,
           settlement_end_date        AS last_settlement_window_end
    FROM brain.settlements
    WHERE deposit_date < CURRENT_DATE
    ORDER BY marketplace_id, currency_code, deposit_date DESC
),
earned_unsettled AS (
    -- Sum of financial_events occurring AFTER the most recent settlement
    -- window end. Netted by direction (credits positive, debits negative)
    -- so the figure represents "money owed to RW, not yet settled".
    -- When no settlement exists for the (marketplace, currency) yet (new
    -- account, fresh ingest), bound to 2000-01-01 so the whole history
    -- counts as unsettled — accurate for that edge case.
    SELECT fe.marketplace_id,
           fe.currency_code,
           SUM(CASE WHEN fe.direction = 'credit'
                    THEN fe.amount
                    ELSE -fe.amount END) AS earned_unsettled,
           COUNT(*)                      AS unsettled_event_count,
           MIN(fe.posted_date)::date     AS oldest_unsettled_date
    FROM brain.financial_events fe
    LEFT JOIN last_paid ls
           ON ls.marketplace_id = fe.marketplace_id
          AND ls.currency_code  = fe.currency_code
    WHERE fe.posted_date > COALESCE(ls.last_settlement_window_end, '2000-01-01'::timestamptz)
    GROUP BY fe.marketplace_id, fe.currency_code
)
SELECT
    COALESCE(up.marketplace_id, lp.marketplace_id, eu.marketplace_id)   AS marketplace_id,
    COALESCE(up.currency_code,  lp.currency_code,  eu.currency_code)    AS currency_code,

    -- Money landing in the next 14 days
    COALESCE(up.arriving_14d, 0)                                        AS arriving_14d,
    COALESCE(up.arriving_count, 0)                                      AS arriving_count,
    up.next_settlement_date,

    -- Most recent settlement already deposited
    lp.last_settlement_date,
    lp.last_settlement_amount,
    CASE WHEN lp.last_settlement_date IS NOT NULL
         THEN CURRENT_DATE - lp.last_settlement_date
         ELSE NULL END                                                  AS days_since_last_settlement,

    -- Earned but not yet settled (net of refunds + debits)
    COALESCE(eu.earned_unsettled, 0)                                    AS earned_unsettled,
    COALESCE(eu.unsettled_event_count, 0)                               AS unsettled_event_count,
    eu.oldest_unsettled_date,

    -- Freshness — how stale is the underlying source data
    GREATEST(
        (SELECT MAX(ingested_at) FROM brain.settlements),
        (SELECT MAX(ingested_at) FROM brain.financial_events)
    )                                                                   AS as_of,
    EXTRACT(EPOCH FROM (
        NOW() - GREATEST(
            (SELECT MAX(ingested_at) FROM brain.settlements),
            (SELECT MAX(ingested_at) FROM brain.financial_events)
        )
    )) / 3600.0                                                         AS lake_age_hours

FROM upcoming up
FULL OUTER JOIN last_paid        lp USING (marketplace_id, currency_code)
FULL OUTER JOIN earned_unsettled eu USING (marketplace_id, currency_code);

COMMENT ON VIEW analytics.cash_position_current IS
'Per-marketplace cash position rollup for /wbr cash section. One row per (marketplace_id, currency_code) in native currency (no FX). Surfaces arriving_14d (money in transit), last settlement, and earned_unsettled (sales recognised since last settlement window). Earned-unsettled nets credits and debits on brain.financial_events by direction. lake_age_hours indicates source freshness; flag in /wbr when > 30h.';

INSERT INTO meta.migration_history (filename)
VALUES ('0031_analytics_cash_position.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
