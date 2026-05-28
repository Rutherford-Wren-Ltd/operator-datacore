# Import Amazon Ads Console campaign history

The Amazon Ads API only retains advertised-product reports for 65-95 days
(see [the rate-limits / retention memory](../canonical-reports.md)). For
year-over-year ACoS / TACoS / spend analysis we need to bypass the API and
use the Ads Console manual export, which retains campaign-level reports for
~2 years (SP/SD) or ~1 year (SB).

This runbook covers the one-time / occasional import of those Console CSVs
into `brain.ads_campaign_history_imported`. The granular `brain.ads_sp_daily`
/ `brain.ads_sd_daily` tables remain the source of truth for the recent
65-95 day window pulled via the Ads API.

## Step 1 — Export from Ads Console

For each `(profile, ad_product)` you want history for, run this in the
Ads Console web UI:

1. Sign into [advertising.amazon.com](https://advertising.amazon.com/) **with the seller account that owns the profile** (Emporium for UK + US; Muldale for NL/SE/PL/TR).
2. Switch the country / marketplace selector to the profile you want.
3. **Reports → Sponsored Products** (or **Sponsored Display** / **Sponsored Brands**).
4. **Create report** with these settings:
   - Report type: **Campaign report**
   - Time unit: **Daily**
   - Report period: choose the largest window the Console allows (typically last 65 days for SD/SB campaign reports, last 24 months for SP campaign reports — Amazon caps differ by product). Pick the maximum the UI offers.
   - Format: **CSV**
   - File extension: `.csv` (not `.xlsx`)
5. **Run** and download. Name the file something traceable — e.g.
   `SP-Campaign-UK-2024-01-01-to-2025-12-31.csv`. Save to a local folder.

Repeat for each (profile, ad-product) combo. For RW with one UK profile + one
US profile + three ad products, you'll end up with **up to 6 CSVs**:

- `SP-Campaign-UK-*.csv`
- `SD-Campaign-UK-*.csv`
- `SB-Campaign-UK-*.csv`
- `SP-Campaign-US-*.csv`
- `SD-Campaign-US-*.csv`
- `SB-Campaign-US-*.csv`

If a product has no campaigns for a profile (e.g. no SB in the US window),
skip that file — no import needed.

## Step 2 — Dry-run a single file first

Before importing, dry-run to confirm the column mapping. This catches header-
mismatch surprises (Console column naming has changed historically) without
writing anything to the lake.

```powershell
cd c:\Users\chrisrandle\Documents\rutherfordwren\RW-AI-OS\infrastructure\operator-datacore

npm run import-ads-console -- `
  --file "C:\path\to\SP-Campaign-UK-2024-01-01-to-2025-12-31.csv" `
  --profile-id 567327329024034 `
  --profile-label "Emporium Cookshop & Homewares (UK)" `
  --region EU `
  --ad-product SP `
  --batch-id 2026-05-28-uk-sp-24mo `
  --dry-run
```

The dry-run prints:
- Detected CSV columns → normalised header keys
- Typed-column mapping (e.g. `spend ← total_spend`)
- Any unmapped typed columns (warnings — those fields will be NULL)
- Row count, date range, distinct campaigns
- Spend / sales totals

**Sanity-check:**
- Date range matches what you exported (no off-by-one).
- Spend and sales totals look plausible vs Seller Central / your monthly close.
- No "missing required column" hard errors.

If any typed column says `[warn] No header matched…`, check whether the CSV
genuinely lacks that data or whether the Console used a header name we don't
recognise. Unrecognised headers can be added to `TYPED_COLUMN_ALIASES` in
[`src/cli/import-ads-console.ts`](../../src/cli/import-ads-console.ts).

## Step 3 — Real import

Drop the `--dry-run` flag once the dry-run looks right:

```powershell
npm run import-ads-console -- `
  --file "C:\path\to\SP-Campaign-UK-2024-01-01-to-2025-12-31.csv" `
  --profile-id 567327329024034 `
  --profile-label "Emporium Cookshop & Homewares (UK)" `
  --region EU `
  --ad-product SP `
  --batch-id 2026-05-28-uk-sp-24mo
```

Idempotent: re-running the same command upserts on
`(metric_date, profile_id, ad_product, campaign_name)`. Safe to repeat if you
realise the dry-run missed something and re-export.

Repeat for each of the up-to-6 CSVs. Pick distinct `--batch-id` per file so
you can trace any anomaly back to the source CSV.

## Step 4 — Verify in the lake

```sql
-- Per-batch sanity
SELECT
  import_batch_id,
  ad_product,
  profile_id,
  MIN(metric_date)            AS earliest,
  MAX(metric_date)            AS latest,
  COUNT(DISTINCT metric_date) AS days,
  COUNT(DISTINCT campaign_name) AS campaigns,
  ROUND(SUM(spend)::numeric, 2) AS spend,
  ROUND(SUM(sales)::numeric, 2) AS sales,
  MAX(imported_at)            AS last_imported
FROM brain.ads_campaign_history_imported
GROUP BY import_batch_id, ad_product, profile_id
ORDER BY ad_product, profile_id, earliest;

-- Sample row, see what raw_csv captured (every column the Console exported)
SELECT raw_csv
FROM brain.ads_campaign_history_imported
WHERE import_batch_id = '2026-05-28-uk-sp-24mo'
ORDER BY metric_date DESC
LIMIT 1;
```

If `raw_csv` has fields we'd want as typed columns (e.g. ROAS, conversion
rate, new-to-brand metrics), open a small PR adding them to the
`TYPED_COLUMN_ALIASES` map plus the migration — they were captured
verbatim, so they don't need re-importing once the schema catches up.

## Gotchas

- **BOM**: Console exports usually carry a UTF-8 BOM. The parser strips it.
- **Currency cells**: stored as numbers; the parser strips `£`, `$`, `€`,
  thousands separators, and percent signs.
- **Date format**: Console sometimes exports as `2024-12-31`, sometimes as
  `12/31/2024`. The parser handles both.
- **Empty cells**: stored as NULL (not zero) for numeric columns. A
  campaign with zero spend on a given day still gets a row — Amazon writes
  the day; we faithfully record it.
- **Status / portfolio fields**: snapshot at export time. If you re-export
  later and a campaign was renamed, the upsert key is `campaign_name`, so
  the new name lands as a separate row. Watch for that if you re-import
  after long gaps.
- **Attribution windows differ between products**: SP defaults to 7-day,
  SD/SB to 14-day. The single `sales` / `orders` / `units` columns in this
  table reflect whichever window the Console exported (recorded verbatim
  in `raw_csv` for unambiguous attribution).
- **Daily-sync interaction**: this CLI does not touch `brain.ads_sp_daily`
  / `ads_sd_daily`. The two datasets sit alongside each other — Console
  import is campaign-level, daily-sync is campaign + keyword + ASIN-level.
  Use the API tables for the recent 65-95 days and the imported table for
  the long-tail.
