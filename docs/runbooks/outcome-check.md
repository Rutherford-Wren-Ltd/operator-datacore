# Runbook — outcome-check (close the verify loop)

**What it is.** The last rung of the propose → approve → ship → **verify** loop. Skills draft
recommendations; the operator logs them to `ops.decision_log` at sign-off and sets `shipped_at`
when the action goes live; this CLI later records what happened to the SKU.

**CLI:** `npm run outcome-check` · **Schedule:** `outcome-check-weekly.yml`, Mondays 05:15 UTC · **Writes:** `ops.decision_log.outcome_status / outcome_note / outcome_checked_at`

## What it measures (and what it does NOT)

For each decision shipped ≥ `--min-age-days` (default 21) ago whose `outcome_status='pending'`, it
compares a pre-ship window against a post-ship window (default 14 days each) around `shipped_at`:

- **Universal signal:** units + revenue from `brain.sales_traffic_daily` for the decision's `(asin, marketplace_id)`.
- **ppc-audit decisions also:** ACoS from `analytics.ads_per_asin_daily` (the metric that skill targets — a fall is the intended direction). When ACoS is readable it drives the verdict; otherwise revenue does.

Verdict: `improved` / `no_change` / `worsened` on a ±10% band, or `n/a` if there's no pre-window
data (new SKU / gap) or no ASIN on the row.

> **This is observed movement, not causal attribution.** Season, price, stock and competitors all
> move too. The `outcome_note` carries the raw pre→post numbers so a human reads the verdict as
> "what happened after", not "what the recommendation caused". Contribution (CM3) is deliberately
> not used — `product_profitability_30d` is a current-state 30-day snapshot with no history, so a
> pre/post CM3 read is impossible; units/revenue/ACoS have true daily history.

## Operator flow that feeds it

1. A skill (restock-memo, price-test, scale-audit, ppc-audit) drafts an action and emits an
   INSERT-ready `ops.decision_log` snippet.
2. At sign-off you run the INSERT (skill never writes to the lake). Row starts `outcome_status='pending'`.
3. When the action actually goes live, set `decision='accepted'` and `shipped_at=now()`.
4. ~3 weeks later this job measures and fills `outcome_*`. Read the results:
   ```sql
   SELECT skill, asin, subject, outcome_status, outcome_note, outcome_checked_at
     FROM ops.decision_log WHERE outcome_status <> 'pending' ORDER BY outcome_checked_at DESC;
   ```

## Flags

- `--window-days=14` — pre/post window length.
- `--min-age-days=21` — how long after shipping before a decision is measurable (must be ≥ window).
- `--dry-run` — print verdicts, write nothing.

## Notes / gotchas

- **Idempotent.** Only `pending` rows are touched; writing an outcome flips them off `pending`, so
  re-runs are safe no-ops. A week with no due decisions prints "No decisions due" and exits 0.
- **No rows yet is normal.** The loop only has data once real decisions are logged *and* shipped.
  Until then the weekly run is a clean no-op — that's expected, not a failure.
- **Compute CLI, no `sync_run`.** Follows the `forecast.ts` precedent (internal compute jobs skip
  the `meta.sync_run` lifecycle — that's for external-source ingests; `meta.connection.source` is
  constrained to Amazon/etc. and wouldn't accept an internal job).
- **V2 candidates:** per-skill target metrics (e.g. cover-recovered-without-stockout for restock,
  DiD for price-test), a summary line into the weekly digest / an Issue, and confidence weighting by
  how clean the window was (no confounding price/promo change).
