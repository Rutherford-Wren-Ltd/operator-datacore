# Brand Analytics — Search Query Performance backfill

`brain.search_query_performance` is the long-tail keyword/query source.
Where the Ads API caps at 65-95 days, Brand Analytics SQP retains **17
months at monthly grain** — enough for year-over-year query analysis.

Access requirements: Brand Registry enrolment + the SP-API `Brand
Analytics` role. RW has both (already pulling Sales & Traffic, which uses
the same role).

**One call = one (period, marketplace, ASIN).** Amazon's API now requires
the `asin` reportOption (confirmed 2026-05-30). The CLI fans out across
your ASIN set; expect ~3,400 calls for a 17-month UK backfill of 200
ASINs, ~57 hours wall-clock at the 60s pacing floor.

## Quick sanity check (1 month, 1 marketplace, ~2 min)

Verify auth + parser before kicking off a long backfill. Pulls the most
recent completed month for the primary marketplace:

```powershell
cd c:\Users\chrisrandle\Documents\rutherfordwren\RW-AI-OS\infrastructure\operator-datacore
npm run backfill-search-query -- --period-type MONTH --months 1
```

What to expect:

- One progress line: `[100.0%] 2026-04-01 → 2026-04-30 A1F83G8C2ARO7P → N rows`
- N is typically several thousand for an active brand on UK or US.
- Final line: `Done in 0.X min. 1 call(s) made, 0 skipped, N rows upserted ...`

Verify the rows landed:

```sql
SELECT COUNT(*)                                              AS rows,
       COUNT(DISTINCT asin)                                  AS asins,
       COUNT(DISTINCT search_query)                          AS queries,
       SUM(purchases)                                        AS purchases
FROM brain.search_query_performance
WHERE period_type = 'MONTH';
```

If the parser misses fields (e.g. shares come back NULL when they should
have values), inspect a raw payload:

```sql
SELECT payload FROM raw.sp_api_report
WHERE report_type = 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT'
ORDER BY raw_id DESC LIMIT 1;
```

Then update `src/lib/sp-api/search-query.ts` field mapping and re-run with
`--skip-existing` to fill anything missed.

## The 17-month historical backfill

Run for each marketplace separately. Each call paces at ~60 seconds, so a
17-month MONTH backfill is **~17 calls × 60s ≈ 17 minutes per marketplace.**

**UK:**
```powershell
npm run backfill-search-query -- `
  --period-type MONTH --months 17 `
  --region eu --marketplaces UK `
  --skip-existing `
  2>&1 | Tee-Object -FilePath ".\sqp-backfill-uk-17mo.log"
```

**US:**
```powershell
npm run backfill-search-query -- `
  --period-type MONTH --months 17 `
  --region na --marketplaces US `
  --skip-existing `
  2>&1 | Tee-Object -FilePath ".\sqp-backfill-us-17mo.log"
```

`--skip-existing` checks `raw.sp_api_report` for completed pulls in the
window and drops the matching periods from the worklist. Safe to re-run.

## Weekly backfill — finer-grain trailing window

WEEK reports retain a shorter window than MONTH (exact figure varies but
typically ~6 months). Useful for week-by-week trend analysis on recent
periods.

```powershell
npm run backfill-search-query -- `
  --period-type WEEK --weeks 26 `
  --region eu --marketplaces UK `
  --skip-existing `
  2>&1 | Tee-Object -FilePath ".\sqp-backfill-uk-26wk.log"
```

26 weeks × ~60s = ~26 min wall-clock per marketplace.

## Quarterly aggregates

Useful for high-level rollups; little reason to backfill since MONTH
already gives you period-aligned data you can sum.

```powershell
npm run backfill-search-query -- --period-type QUARTER --quarters 8
```

## Dry-run any window

`--dry-run` prints what would be requested without firing any API calls:

```powershell
npm run backfill-search-query -- `
  --period-type MONTH --from 2025-01-01 --to 2026-04-30 --dry-run
```

Useful for boundary sanity (the CLI widens `--from`/`--to` to the nearest
period boundary — the dry-run output confirms what you'll actually get).

## Verification queries

```sql
-- Coverage by period
SELECT period_type, MIN(period_start) AS earliest, MAX(period_end) AS latest,
       COUNT(DISTINCT period_start)   AS periods,
       COUNT(DISTINCT asin)           AS asins,
       COUNT(DISTINCT search_query)   AS queries
FROM brain.search_query_performance
GROUP BY period_type
ORDER BY period_type;

-- Top queries by purchase share for one ASIN, last 12 months
SELECT period_start, search_query, search_query_volume, purchases, purchase_share
FROM brain.search_query_performance
WHERE period_type = 'MONTH'
  AND asin = 'B0F9YZ46ND'           -- change this
  AND period_start >= CURRENT_DATE - INTERVAL '12 months'
ORDER BY period_start DESC, purchase_share DESC NULLS LAST
LIMIT 50;

-- YoY query volume for a brand's top 20 queries by impressions
WITH top_q AS (
  SELECT search_query
  FROM brain.search_query_performance
  WHERE period_type = 'MONTH'
    AND period_start = (SELECT MAX(period_start) FROM brain.search_query_performance WHERE period_type = 'MONTH')
  GROUP BY search_query
  ORDER BY SUM(impressions) DESC NULLS LAST
  LIMIT 20
)
SELECT t.search_query,
       EXTRACT(YEAR FROM s.period_start) AS year,
       EXTRACT(MONTH FROM s.period_start) AS month,
       SUM(s.search_query_volume)         AS volume,
       SUM(s.purchases)                   AS purchases
FROM brain.search_query_performance s
JOIN top_q t USING (search_query)
WHERE s.period_type = 'MONTH'
GROUP BY t.search_query, EXTRACT(YEAR FROM s.period_start), EXTRACT(MONTH FROM s.period_start)
ORDER BY t.search_query, year, month;
```

## Gotchas

- **Period boundaries are strict.** Amazon 400s if `dataStartTime` /
  `dataEndTime` don't align — the CLI widens `--from` / `--to` to the
  nearest boundary for you, but be aware of it when reading logs.
- **17-month ceiling is on MONTH grain.** WEEK is shorter (~6 months);
  QUARTER may go further. Don't assume the same window across period types.
- **Brand Registry required.** If a marketplace shows no rows after a
  successful run, check Seller Central → Brand Analytics is enabled for
  that marketplace. Brand Analytics enrolment is per-marketplace, not
  per-account.
- **One period per call.** No spanning. Listing every Tuesday in
  October's monthly report = 1 call covering Oct 1–31; you can't merge
  with September.
- **Daily-sync isn't wired yet.** This CLI is operator-run. Adding a
  weekly cron (every Sunday for the previous Sun-Sat week) is a Phase 7
  follow-up.
- **Forward-looking:** as the lake fills going forward via daily / weekly
  sync, the 17-month ceiling becomes less of a problem — the daily-sync
  history will eventually exceed Amazon's retention.
