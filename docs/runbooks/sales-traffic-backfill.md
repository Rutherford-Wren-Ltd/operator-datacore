# Sales & Traffic backfill — Wrenbury-first wave plan

The `GET_SALES_AND_TRAFFIC_REPORT` SP-API endpoint is permanently rate-limited to
**1 createReport call per 15 minutes, app-wide** (Amazon confirmed 2026-05-26,
no increase available — daily data refresh cadence means a higher rate has no
business justification). Per-ASIN granularity needs one report per
`(marketplace, day)`, so any large window has to be paced.

This runbook is the operational recipe for the 24-month historical backfill,
sequenced Wrenbury-first because UK + US carry ~100% of Wrenbury revenue.

## Quick math

- Limit: 1 call / 15 min = **96 calls / day clock time**, app-wide
- 24 months ≈ 730 days per marketplace
- UK + US, both fully filled: **~1,394 calls ≈ 14.5 days clock time**
- The other 7 marketplaces (DE/FR/IT/ES/NL/SE/PL/TR) carry **zero Wrenbury
  revenue** in the trailing 30 days → deferred until/unless Wrenbury expands
  there.

## Safety rails (already in the code)

- `backfillSalesTraffic` clamps concurrency to **1** and per-task delay to
  **>= 900 000 ms (15 min)**, regardless of CLI flags. The clamp logs a warning
  if the caller asked for something looser.
- `--skip-existing` queries `brain.sales_traffic_daily` for distinct
  `(marketplace_id, metric_date)` pairs in the window and skips them. **Always
  use it** — re-running a wave is idempotent and never burns calls on data
  we already have.
- The CLI cannot mix regions in a single run (UK is `eu`, US is `na`; each
  uses a separate refresh token). Run each region as its own wave.

## Waves — run sequentially, one at a time

The waves share one rate-limit bucket, so they **cannot run in parallel**.
Wait for one wave to finish before starting the next.

### Wave W1 — UK Christmas 2024 (highest single-day ROI)
Unlocks Wrenbury Q4 2024 baseline → Q4 2026 forecast.

```bash
npm run backfill -- \
  --region eu --marketplaces UK \
  --from 2024-10-01 --to 2024-12-31 \
  --skip-existing
```
**~92 calls, ~23 hours clock.**

### Wave W2 — US Christmas 2024
Mirror of W1 for the US.

```bash
npm run backfill -- \
  --region na --marketplaces US \
  --from 2024-10-01 --to 2024-12-31 \
  --skip-existing
```
**~92 calls, ~23 hours clock.**

### Wave W3 — UK trailing 12 months (gap-fill)
Closes the day-by-day UK gap; full recent baseline for forecasting + restock.

```bash
npm run backfill -- \
  --region eu --marketplaces UK \
  --from 2025-06-01 --to 2026-05-25 \
  --skip-existing
```
**~318 calls (after skip), ~3.3 days clock.** Window deliberately ends
yesterday — the daily-sync covers today's pull.

### Wave W4 — US trailing 12 months (gap-fill)
Same as W3, US side. US has only 19 days currently → most of this wave will run.

```bash
npm run backfill -- \
  --region na --marketplaces US \
  --from 2025-06-01 --to 2026-05-25 \
  --skip-existing
```
**~346 calls (after skip), ~3.6 days clock.**

### Wave W5 — UK mid-tail (24-month completeness)
Fills the remaining UK window (May–Sep 2024 + Jan–May 2025).

```bash
npm run backfill -- \
  --region eu --marketplaces UK \
  --from 2024-05-01 --to 2025-05-31 \
  --skip-existing
```
**~273 calls (after skip, excluding the Q4 2024 segment already done in W1),
~2.8 days clock.**

### Wave W6 — US mid-tail (24-month completeness)
Mirror of W5 for the US.

```bash
npm run backfill -- \
  --region na --marketplaces US \
  --from 2024-05-01 --to 2025-05-31 \
  --skip-existing
```
**~273 calls (after skip), ~2.8 days clock.**

## Pre-flight test (do this once before W1)

Verifies pacing, ASIN-level data lands, and `--skip-existing` actually skips.
Total clock time: ~15 minutes for the live calls, then a re-run that should
complete in seconds.

```bash
# Step 1 — pull one day in the W1 window (the UK call). 1 call, returns in minutes.
npm run backfill -- \
  --region eu --marketplaces UK \
  --from 2024-10-15 --to 2024-10-15 \
  --skip-existing

# Step 2 — same day, US side. 1 call. Reuses the same Wrenbury Q4 2024 window.
npm run backfill -- \
  --region na --marketplaces US \
  --from 2024-10-15 --to 2024-10-15 \
  --skip-existing

# Step 3 — re-run step 1 to prove --skip-existing skips the date now present.
#          Expect "1 call(s) made, 0 skipped" on first run; "0 made, 1 skipped" on re-run.
npm run backfill -- \
  --region eu --marketplaces UK \
  --from 2024-10-15 --to 2024-10-15 \
  --skip-existing
```

**Verification SQL** after step 2:
```sql
select marketplace_id, count(distinct child_asin) as asins, sum(ordered_product_sales) as revenue
  from brain.sales_traffic_daily
 where metric_date = '2024-10-15'
   and marketplace_id in ('A1F83G8C2ARO7P','ATVPDKIKX0DER')
 group by marketplace_id;
```

Both rows should show >50 ASINs and non-zero revenue. If either marketplace
has 0 ASINs, the report-document parse is broken — stop and investigate
before kicking off W1.

## Operational notes

- **Where to run from.** The waves block for days; run on a long-lived host
  (the GitHub Actions daily-sync runner is wrong — that's for ~5 min jobs).
  Recommend a tmux session on a dev box, or a one-shot Compute Engine VM that
  exits when the wave completes. Capture stdout to a log file.
- **Crash recovery.** If a wave dies mid-flight, re-run the same command —
  `--skip-existing` will pick up exactly where it stopped. No state file
  required.
- **Don't double-pump.** Daily-sync runs on the same rate-limit bucket. If a
  daily-sync window overlaps with a wave, the wave will see its dates already
  present (free skip) and proceed.
- **Region pairing rule.** Never start a `eu` wave while a `na` wave is
  active — they share the app-wide quota and will race for the 1/15-min slot.
- **`Muldale` is one seller account.** Despite the per-marketplace Ads-profile
  names (`Emporium Cookshop & Homewares`, `Muldale USA`), there is one SP-API
  merchant account and therefore one rate-limit bucket spanning every
  marketplace.

## Total budget

| Wave | Marketplace | Window | Calls (after skip) | Clock |
|---|---|---|---|---|
| W1 | UK | 2024-10-01 → 2024-12-31 | 92 | ~24h |
| W2 | US | 2024-10-01 → 2024-12-31 | 92 | ~24h |
| W3 | UK | 2025-06-01 → 2026-05-25 | ~318 | ~3.3d |
| W4 | US | 2025-06-01 → 2026-05-25 | ~346 | ~3.6d |
| W5 | UK | 2024-05-01 → 2025-05-31 (skip Q4) | ~273 | ~2.8d |
| W6 | US | 2024-05-01 → 2025-05-31 (skip Q4) | ~273 | ~2.8d |
| **Total** | UK + US | 24 months | **~1,394** | **~14.5 days** |

After W6 the brain.sales_traffic_daily table holds a clean 24-month
per-ASIN baseline for the marketplaces that actually move Wrenbury revenue.
