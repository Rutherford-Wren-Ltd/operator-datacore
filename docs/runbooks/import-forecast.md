# Runbook: import demand forecast

Load RW's demand forecast from the forecasting tool's workbook into
`brain.demand_forecast` (schema added in migration 0017). This gives `/restock-memo` a
real seasonal, forward-looking demand number in place of flat 30-day velocity.

> **The forecasting tool is interim.** It is a manually maintained spreadsheet; the
> forecasting *approach* is slated for a rebuild once the data lake holds clean
> per-marketplace actuals + seasonality. See
> `wiki/decisions/2026-05-20-forecasting-approach-interim.md` in the RW-AI-OS knowledge
> vault. This importer ingests the current tool faithfully; it does not endorse it as
> the permanent method.

## When to run

- Whenever the forecast is revised (the tool says forecasting is refreshed monthly).
- Before a restock cycle, so `/restock-memo` plans against the current forecast.

## What you need

The forecasting tool's export — the **"Unit forecast" `.xlsx`** — in a gitignored folder
(`seller-sessions-2026/imports/` is the convention).

## How to run

Dry-run first — it parses and validates, reporting counts and warnings without writing:

```
cd infrastructure/operator-datacore
npm run import-forecast -- --workbook "<path to Unit forecast.xlsx>" --dry-run
```

If the dry-run looks right, run for real:

```
npm run import-forecast -- --workbook "<path to Unit forecast.xlsx>"
```

`--snapshot-date YYYY-MM-DD` overrides the snapshot date (default: today).

## What the importer does

- Reads `Sheet1`: each SKU row, and the repeating monthly `UK | USA | DE | Total` column
  blocks. Only the **Forecast** blocks are ingested (Actual / Variance are skipped — the
  data lake has its own Amazon actuals). `DE` is stored as market **`eu`** — it is the
  whole-EU pool, not Germany alone.
- Stores **positive forecasts only** — a blank or zero cell produces no row (a missing
  `(ean, market, month)` row reads as a forecast of 0).
- Each run is a dated **snapshot** (`snapshot_date`). The just-imported snapshot becomes
  `is_current`; the previous one is demoted. Re-importing the same `--snapshot-date`
  replaces it; a new date adds a snapshot and keeps the old one as history.
- `analytics.demand_forecast_current` always reflects the latest snapshot.
- The run is recorded in `meta.sync_run` (`object='demand_forecast'`).

## Hard errors vs warnings

**Hard errors stop the import** (nothing is written):
- the workbook has no `Sheet1`, or its first block is not `UK/USA/DE/Total`
- the `UK/USA/DE/Total` grid drifts mid-sheet (a column inserted into the tool) — the
  importer fails rather than silently misaligning every later column
- a Forecast block with no year in row 1, or an unrecognised month label

**Warnings do not stop the import** — a `warn` row is written to `meta.sync_log`:
- an `ean` not in `brain.sku_master` (the forecast still imports; the SKU master may need
  updating via `import-masters`)

Fractional forecast figures (the tool produces them, notably in the `UKW` column) are
stored exactly — `units_forecast` is `NUMERIC`, not rounded.

After a run, review warnings:

```sql
SELECT message, payload FROM meta.sync_log
WHERE level = 'warn'
  AND sync_run_id = (SELECT sync_run_id FROM meta.sync_run
                     WHERE object = 'demand_forecast' ORDER BY started_at DESC LIMIT 1);
```

## After importing

`/restock-memo` reads `analytics.demand_forecast_current` for its demand forecast,
falling back to flat 30-day velocity for any SKU with no forecast row. The forecast's
`eu` market is an EU-wide pool — a restock run for a single EU marketplace treats it as
the pool figure and flags that on the draft.
