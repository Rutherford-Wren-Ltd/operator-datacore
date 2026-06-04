-- ============================================================================
-- 0032_cash_position_fees_vs_sales.sql
-- Decompose `earned_unsettled` on analytics.cash_position_current into two
-- sub-columns so operators can tell a fees-timing artifact from real
-- operational distress.
--
-- Why this matters: 2026-06-03 EU read showed earned_unsettled = -€161 and
-- it triggered "is something wrong?" — turned out to be ~€558 of monthly
-- Amazon service fees posted in the small post-settlement window with no
-- corresponding 30 days of sales credits to offset. Every actual EU trading
-- day was positive. Need to surface the split at the view level so the
-- /wbr cash section can render the two components separately.
--
-- Classification:
--   Sales-related = events tied to a specific order's economic flow.
--                   ShipmentEvent (credits = Principal + Tax; debits =
--                   FBA fee, commission, DSF withheld from that sale),
--                   RefundEvent, AdjustmentEvent.
--   Fees-related  = standalone fees not tied to a specific sale.
--                   ServiceFeeEvent (FBA storage, subscription, account-
--                   level fees), ProductAdsPaymentEvent (ad-spend
--                   reconciliation).
--
-- The total earned_unsettled column stays for back-compat — it's just the
-- sum of the two new columns.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW analytics.cash_position_current AS
WITH
upcoming AS (
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
unsettled_events AS (
    -- One row per financial event in the unsettled window, tagged sales vs fees.
    SELECT fe.marketplace_id,
           fe.currency_code,
           fe.event_type,
           fe.direction,
           fe.amount,
           fe.posted_date,
           CASE
               WHEN fe.event_type IN ('ServiceFeeEvent', 'ProductAdsPaymentEvent')
                   THEN 'fees'
               ELSE 'sales'  -- ShipmentEvent, RefundEvent, AdjustmentEvent, others
           END AS bucket
    FROM brain.financial_events fe
    LEFT JOIN last_paid ls
           ON ls.marketplace_id = fe.marketplace_id
          AND ls.currency_code  = fe.currency_code
    WHERE fe.posted_date > COALESCE(ls.last_settlement_window_end, '2000-01-01'::timestamptz)
),
earned_unsettled AS (
    SELECT marketplace_id,
           currency_code,
           SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END) AS earned_unsettled,
           SUM(CASE WHEN bucket = 'sales' AND direction = 'credit' THEN amount
                    WHEN bucket = 'sales' AND direction = 'debit'  THEN -amount
                    ELSE 0 END)                                              AS earned_unsettled_from_sales,
           SUM(CASE WHEN bucket = 'fees' AND direction = 'credit' THEN amount
                    WHEN bucket = 'fees' AND direction = 'debit'  THEN -amount
                    ELSE 0 END)                                              AS earned_unsettled_from_fees,
           COUNT(*)                                                          AS unsettled_event_count,
           MIN(posted_date)::date                                            AS oldest_unsettled_date
    FROM unsettled_events
    GROUP BY marketplace_id, currency_code
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

    -- Earned but not yet settled — TOTAL (back-compat column at original position).
    -- Decomposed sub-columns appended at the end of the SELECT (positions 13-14)
    -- because Postgres CREATE OR REPLACE VIEW forbids inserting new columns
    -- in the middle of an existing view's column list.
    COALESCE(eu.earned_unsettled, 0)                                    AS earned_unsettled,
    COALESCE(eu.unsettled_event_count, 0)                               AS unsettled_event_count,
    eu.oldest_unsettled_date,

    -- Freshness
    GREATEST(
        (SELECT MAX(ingested_at) FROM brain.settlements),
        (SELECT MAX(ingested_at) FROM brain.financial_events)
    )                                                                   AS as_of,
    EXTRACT(EPOCH FROM (
        NOW() - GREATEST(
            (SELECT MAX(ingested_at) FROM brain.settlements),
            (SELECT MAX(ingested_at) FROM brain.financial_events)
        )
    )) / 3600.0                                                         AS lake_age_hours,

    -- Decomposed earned_unsettled — appended (see comment above).
    COALESCE(eu.earned_unsettled_from_sales, 0)                         AS earned_unsettled_from_sales,
    COALESCE(eu.earned_unsettled_from_fees, 0)                          AS earned_unsettled_from_fees

FROM upcoming up
FULL OUTER JOIN last_paid        lp USING (marketplace_id, currency_code)
FULL OUTER JOIN earned_unsettled eu USING (marketplace_id, currency_code);

COMMENT ON VIEW analytics.cash_position_current IS
'Per-marketplace cash position rollup for /wbr cash section. One row per (marketplace_id, currency_code) in native currency. arriving_14d = settlement deposits scheduled in the next 14d; earned_unsettled = net financial events since last settled window end, decomposed into _from_sales (ShipmentEvent / RefundEvent / AdjustmentEvent — per-order economics) and _from_fees (ServiceFeeEvent / ProductAdsPaymentEvent — standalone fees). A negative earned_unsettled_from_fees with positive earned_unsettled_from_sales is the canonical "monthly fees just posted" pattern, not operational distress.';

INSERT INTO meta.migration_history (filename)
VALUES ('0032_cash_position_fees_vs_sales.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
