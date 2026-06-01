# Demand forecast — `data_lake_v1` (Phase 11)

The first data-lake-driven demand forecast. Replaces (over time) the interim
manual spreadsheet (`source='operator_tool'`) with a baseline forecast computed
directly from `brain.sales_traffic_daily`. Lands rows into the **same**
`brain.demand_forecast` table — the `source` column was scaffolded in 0017 for
exactly this — under `source='data_lake_v1'`.

`/restock-memo` and `generate-pos` don't change: they read
`analytics.demand_forecast_current`, a view that now prefers the model when it
exists per `(ean, market, forecast_month)` and falls back to `operator_tool`
otherwise.

## The 30-second version

```powershell
npm run forecast                            # default 12 months
npm run forecast -- --horizon 6             # 6 months out
npm run forecast -- --dry-run               # diff vs current, rollback
```

Nightly cron runs `brain.refresh_demand_forecast_modeled()` at **02:30 UTC**
(after the daily-sync at 15:00 UTC + the rollup at 14:30 UTC have landed the
day's data). The CLI is for on-demand refreshes (after a big backfill lands,
or to test changes).

## Method (v1)

```
forecast(asin, market, forecast_month) =
  CASE
    WHEN last_year_same_month IS NOT NULL THEN
        last_year_same_month × trend_factor
    WHEN recent_28d_velocity > 0 THEN
        recent_28d_velocity × (days_in_month / 28)        -- flat-velocity fallback
    ELSE NULL                                              -- skip
  END

trend_factor = recent_28d_units / same_28d_a_year_ago_units
               (clamped to [0.25, 4.0]; NULL → 1.0)
```

- **Transparent**: the CASE explains itself; `source_ref` per row records the
  last-year + factor + recent-28d numbers used.
- **Anchored to a real Christmas** when we have one (W1+W2 landed Q4 2024).
- **Trend overlay** catches a SKU growing or fading vs last year.
- **Clamp** prevents a single anomalous week from x10-ing the next 12 months.
- **Flat-velocity fallback** keeps new SKUs in the system until they have a
  same-month-last-year anchor.

## Scope of v1

- Markets: **`uk` + `usa`** only. The manual tool's `eu` is a whole-EU pool
  that needs DE/FR/IT/ES/NL/SE/PL/TR daily-sync data; that's separate work.
  `ukw` (UK website / MFN) is outside the SP-API surface entirely.
- Horizon: default 12 months out (configurable 1-24).
- No proper seasonality decomposition (needs ≥2 Christmases — gets there
  once W3-W6 lands 2024-Q1 through 2025-full-year).
- No promo-aware adjustments.
- No inventory-availability adjustment ("could the SKU even have sold last
  year?") — a Q4 2024 OOS week underweights this year's forecast for that
  month. Worth a future overlay using inventory snapshots.

## Verification queries

```sql
-- What did the model land for the next 6 months?
SELECT market, forecast_month, COUNT(*) AS skus, SUM(units_forecast) AS units
FROM brain.demand_forecast
WHERE source = 'data_lake_v1' AND is_current
  AND forecast_month <= CURRENT_DATE + INTERVAL '6 months'
GROUP BY market, forecast_month
ORDER BY market, forecast_month;

-- Where does analytics.demand_forecast_current actually source each row?
SELECT source, COUNT(*) AS rows, COUNT(DISTINCT ean) AS skus
FROM analytics.demand_forecast_current
GROUP BY source
ORDER BY rows DESC;

-- For a specific SKU, what does the model say for the next 12 months?
SELECT forecast_month, market, units_forecast, source_ref
FROM brain.demand_forecast
WHERE source = 'data_lake_v1' AND is_current
  AND asin = 'B0CX9FCC59'                    -- change this
ORDER BY market, forecast_month;

-- Sanity vs the manual tool for the overlap (same SKU × market × month):
SELECT
    f1.ean, f1.market, f1.forecast_month,
    f1.units_forecast AS modeled,
    f2.units_forecast AS manual,
    ROUND(f1.units_forecast - f2.units_forecast, 2) AS delta
FROM brain.demand_forecast f1
JOIN brain.demand_forecast f2
  ON f1.ean = f2.ean AND f1.market = f2.market AND f1.forecast_month = f2.forecast_month
WHERE f1.source = 'data_lake_v1' AND f1.is_current
  AND f2.source = 'operator_tool' AND f2.is_current
ORDER BY ABS(f1.units_forecast - f2.units_forecast) DESC
LIMIT 20;
```

## Gotchas

- **Thin history right now.** Until W3-W6 land, the only "last year" data is
  Q4 2024 (W1+W2). The model uses flat-velocity fallback for any month that
  doesn't have a Q4-2024 anchor — which is most months. Once 2024-Q1-Q3 and
  the full 2025 land, the forecast quality jumps.
- **Snapshot semantics.** Re-running the same calendar day replaces today's
  `data_lake_v1` snapshot in-place (it's a `WHERE is_current` demote + insert).
  A different day creates a new snapshot.
- **Consumer override.** If you want to force the manual tool back into a
  specific SKU's forecast, delete or demote the `data_lake_v1` row for that
  `(ean, market, forecast_month)`. The view falls back to `operator_tool`
  automatically.
- **`/restock-memo` will report which source it used** — the `forecast_basis`
  field already reads `analytics.demand_forecast_current` and surfaces the
  `source` column it returns.

## When v2

Once W3-W6 lands and we have ≥2 Christmases of data, the natural upgrades are:
- Proper seasonality decomposition (STL or similar)
- Inventory-availability adjustment (don't anchor to an OOS month)
- Promo flags (when a promo week last year was an outlier, weight it down)
- Confidence intervals (Bayesian / Holt-Winters with prediction interval)

Those are a v2 conversation, not a hot-fix to v1.
