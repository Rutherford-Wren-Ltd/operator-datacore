# Settlements ingest — `brain.settlements` + `brain.settlement_lines`

`ingest-settlements` pulls `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` reports
that Amazon auto-generates every ~14 days into `brain.settlements` (one row
per settlement cycle) and `brain.settlement_lines` (one row per line in the
settlement).

> **Settlements are NOT requested.** Amazon auto-generates one report per
> settlement cycle. Our connector lists DONE settlement reports and ingests
> anything we haven't seen. This is the inverse of every other ingest in
> operator-datacore — there is no createReport step.

## Pairs with `brain.financial_events`

| Source | Cadence | Question it answers |
|---|---|---|
| `brain.financial_events` (`listFinancialEvents`) | Posted as-they-happen | "What's the running fee pattern? What did this order cost in fees?" |
| `brain.settlements` (settlement report) | Fortnightly cycle | "What hit my bank account this fortnight? Does Amazon's total match the deposit?" |

Both live in the lake; pick by question.

## The 30-second version

```powershell
npm run ingest-settlements                                  # last 180 days
npm run ingest-settlements -- --since 2025-01-01
npm run ingest-settlements -- --region na --marketplaces US # filter post-list
npm run ingest-settlements -- --dry-run                     # banner only
```

## What gets ingested

For each new settlement report Amazon has produced:

1. **One row in `brain.settlements`** (the header) with:
   - `settlement_id` (PK; Amazon's unique id)
   - `marketplace_id` (resolved from the TSV's `marketplace-name` column)
   - `settlement_start_date` / `settlement_end_date`
   - `deposit_date` (when it hit the bank)
   - `total_amount` + `currency_code`
2. **Many rows in `brain.settlement_lines`** — one per line in the TSV with:
   - `transaction_type` (Order, Refund, ServiceFee, Other-Transaction, ...)
   - `posted_date`
   - `amazon_order_id` (NULL on non-order lines)
   - `sku` (NULL on non-product lines)
   - `description`
   - `amount` + `currency_code`
   - **`line_hash`** — deterministic SHA-256 of natural-key columns; makes
     re-pulls of the same settlement safe (`ON CONFLICT DO NOTHING`).

## Marketplace mapping

The TSV's `marketplace-name` column is a string (e.g. `"amazon.co.uk"`). The
connector maps it to a marketplace_id via a lookup table:

| TSV value | marketplace_id |
|---|---|
| amazon.com | ATVPDKIKX0DER |
| amazon.co.uk | A1F83G8C2ARO7P |
| amazon.de | A1PA6795UKMFR9 |
| amazon.fr | A13V1IB3VIYZZH |
| amazon.it | APJ6JRA9NG5V4 |
| amazon.es | A1RKKUPIHCS9HS |
| amazon.com.mx | A1AM78C64UM0Y8 |
| amazon.ca | A2EUQ1WTGCTBG2 |
| amazon.com.tr | A33AVAJ2PDY3EV |
| amazon.co.jp | A1VC38T7YXB528 |

An unknown name lands as the raw string — flag it and add the row to the
lookup if it's persistent.

`--marketplaces` on the CLI filters POST-list: the connector lists every
report Amazon has, then drops any whose resolved marketplace_id isn't in
the filter. Useful when running per-region.

## Idempotency

Two layers of safety:

1. **Settlement-level**: if `raw.sp_api_report` already has a row for this
   `report_id` with `parsed_at IS NOT NULL`, the report is skipped without
   downloading.
2. **Line-level**: `(settlement_id, line_hash)` is the PK on
   `brain.settlement_lines`. Re-running a settlement upserts the header
   (`ON CONFLICT DO UPDATE`) but skips already-present lines
   (`ON CONFLICT DO NOTHING`).

## Verification

```sql
-- Recent settlement summary
SELECT settlement_id,
       marketplace_id,
       settlement_start_date::date AS start_date,
       settlement_end_date::date   AS end_date,
       deposit_date::date          AS deposit,
       total_amount, currency_code
FROM brain.settlements
ORDER BY settlement_end_date DESC
LIMIT 10;

-- Line-type breakdown for a known settlement
SELECT transaction_type,
       COUNT(*) AS lines,
       ROUND(SUM(amount), 2) AS total
FROM brain.settlement_lines
WHERE settlement_id = '<paste-id>'
GROUP BY transaction_type
ORDER BY total DESC;

-- Does the sum of lines match the settlement total?
-- (Sanity check — should match within rounding error.)
SELECT s.settlement_id,
       s.total_amount,
       ROUND(SUM(l.amount), 2) AS lines_sum,
       ROUND(s.total_amount - SUM(l.amount), 2) AS diff
FROM brain.settlements s
JOIN brain.settlement_lines l USING (settlement_id)
GROUP BY s.settlement_id, s.total_amount
ORDER BY ABS(s.total_amount - SUM(l.amount)) DESC
LIMIT 10;

-- Orders that hit a specific settlement
SELECT amazon_order_id,
       transaction_type,
       SUM(amount) AS net,
       MAX(posted_date) AS posted
FROM brain.settlement_lines
WHERE settlement_id = '<paste-id>'
  AND amazon_order_id IS NOT NULL
GROUP BY amazon_order_id, transaction_type
ORDER BY MAX(posted_date) DESC
LIMIT 20;
```

## Gotchas

- **Not all lines have an order id.** Transfers, adjustments, fees not tied
  to a specific order (storage, etc) have `amazon_order_id = NULL`. Filter
  accordingly when joining to `brain.orders`.
- **The TSV's first row sometimes IS the settlement-total row** (no
  transaction-type, no description, just the totals). The ingest preserves
  it as a regular line for reconciliation but it won't match an order.
- **Settlements span 2 weeks** and post a few days after the end date.
  Today's `--since N days` window may show empty if no new settlement has
  closed yet. Re-run when Amazon's payout schedule rolls forward.
- **`marketplace_id = 'UNKNOWN'`** appears when the TSV's marketplace-name
  isn't in our lookup table (memory: `feedback_sp_api_settlement_quirks.md`
  if it exists). Add the row to the lookup and re-run.
- **No daily-sync hook yet.** This CLI is operator-run. A weekly /
  daily-sync wiring is a Phase 7 follow-up.

## Why this matters

Settlements are the **truth-of-the-truth** on revenue: Amazon's own
calculation of what it deposited to your bank, after every fee, refund,
adjustment, and reserve. They're the right source for:

- Monthly close reconciliation (does deposit-date sum match Xero?)
- Cash-flow visibility (when does which marketplace's money arrive?)
- Per-order net contribution after Amazon's full accounting
- Detecting reserve / withhold patterns that financial_events misses
