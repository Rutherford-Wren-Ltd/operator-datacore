# Generate draft reorder POs — the restock engine

`generate-pos` is the restock engine. It scans the active catalogue, runs the same
availability-vs-forecast decision math as `/restock-memo` — but across every SKU at once —
and writes **draft purchase orders** for the team to review.

It never places an order. It drafts. A human reviews, assigns destinations, allocates a
real PO number, and promotes each PO they approve.

---

## The 30-second version

```bash
npm run generate-pos -- --dry-run     # preview — writes the report, no DB writes
npm run generate-pos                  # real run — writes draft POs + the report
```

The run prints a summary and writes a review report to the vault at
`wiki/restock/<date>-reorder-proposals.md`. Open that in Obsidian — it is grouped by
supplier, one draft PO each, with the per-region breakdown for every proposed SKU.

Always do a `--dry-run` first and read the report before the real run.

> **Automated weekly run:** GitHub Actions workflow `restock-engine-weekly.yml`
> runs the engine every **Monday at 06:00 UTC** (07:00 BST / 06:00 GMT — before
> Chris's 07:00 UK working window) and opens a team-review issue titled
> "Restock proposals — YYYY-MM-DD — N SKU(s) triggered" with the full report
> inline. The same idempotency contract applies: any `restock_engine` PO still
> at `status='draft'` on the next Monday is replaced, so promote what you want
> to keep with `set-po-status` before then.

---

## What it does

For each active SKU (status `active`, `seasonal`, or `new_launch`) with a supplier, a
MOQ, and a lead time:

1. **Demand** over a planning window (lead time + 8 weeks) — from the demand forecast
   (`analytics.demand_forecast_current`), pro-rated month by month. If a SKU has no
   forecast rows it falls back to flat 30-day velocity, flagged.
2. **Supply** — FBA fulfillable + Amazon inbound + clean committed POs.
3. **Gap, region by region.** UK/EU and NA are computed *separately* and each floored at
   zero before being summed. A surplus in one region can never cancel a real shortage in
   the other — this is the whole reason the engine does not just pool everything.
4. **Margin gate.** A SKU short on stock but unprofitable is not proposed (see below).
5. SKUs that clear all of that are **grouped by supplier into one draft PO each.**

The proposed quantity is one number per SKU (rounded up to the MOQ). The per-region
breakdown is in the report and in each PO line's `notes` — that is how you decide how to
split destinations.

---

## After a run — how to action the drafts

Draft POs land in `brain.purchase_orders` with `source_system = 'restock_engine'`,
`status = 'draft'`, and a provisional number `RX-<supplier_id>` (e.g. `RX-SUP-009`).
Their lines sit at `destination = 'unallocated'`, `serves_region = 'unallocated'`.

For each PO you approve:

1. **Assign destinations.** Decide where each line's stock should land (FBA UK, USA AWD,
   UK 3PL, RW-held) and set `destination` + `serves_region` on the line. The per-region
   need in the line `notes` tells you the split.
2. **Allocate the real PO number.** Rename `po_number` from `RX-...` to the real PO
   number once you have one.
3. **Promote it.** `npm run set-po-status -- --po <real-number> --status placed --date <YYYY-MM-DD>`.

> **Idempotency contract — important.** Re-running the engine **deletes every
> `restock_engine` PO still at `status = 'draft'` and rebuilds them.** That is
> deliberate: each run is a fresh snapshot of what to reorder now. So:
>
> - Do **not** annotate or edit a draft engine PO and leave it as `draft` — your edits
>   are discarded on the next run.
> - If you are acting on a draft, **promote it out of `draft` first** (`set-po-status`).
>   Promoting is how you protect a PO from regeneration. Promoted POs are never touched
>   by the engine.

---

## Margin gate — and the `fba_fee` gap

Every proposal passes a margin check, so the engine never drafts a PO for an obvious
loss-maker.

- If `brain.sku_master.fba_fee` is populated, the gate uses real CM3
  (`(ASP − COGS − FBA fee) / ASP`, threshold 10%).
- `fba_fee` is **empty for the whole catalogue today**, so the gate currently uses a
  cruder proxy: gross margin before the FBA fee (`(ASP − COGS) / ASP`, floor 15%). The
  report labels every SKU "CM3 unavailable — proxy used".

To upgrade the gate to real CM3: fill the `fba_fee` column in the masters spreadsheet
from Seller Central's FBA fee estimate (the bulk **Fee Preview** report,
`GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA`, or the per-SKU figure in Manage FBA Inventory),
then `npm run import-masters`. The engine picks it up automatically on the next run — no
code change. See the v1 decision page,
`knowledge-vault/.../wiki/decisions/2026-05-21-auto-po-generation-v1.md`.

A SKU whose ASP cannot be read in the same currency as its COGS has its gate **skipped**
(annotated), not failed — it is still proposed.

---

## Flags

| Flag | Default | Effect |
|---|---|---|
| `--dry-run` | off | Compute and write the report, but **no** database writes. |
| `--report-path <file>` | `../../knowledge-vault/.../wiki/restock/<date>-reorder-proposals.md` | Where to write the report. |
| `--weeks N` | lead time + 8 weeks | Override the cover window with a flat `N`-week target. |
| `--cm3-threshold` | 0.10 | Real-CM3 gate threshold (used when `fba_fee` is loaded). |
| `--margin-floor` | 0.15 | Proxy-gate floor (used when `fba_fee` is NULL). |

---

## Reading the report

- **Summary** — SKUs evaluated / triggering / margin-gated / skipped, the forecast
  snapshot used, and a rough estimated value.
- **One section per draft PO** — the per-SKU table: UK/EU need, NA need, net gap,
  proposed quantity, 30-day velocity, trend, margin, demand basis.
- **Margin-gated** — SKUs that need stock but failed the margin gate. Review pricing or
  cost, do not just override.
- **Skipped** — ineligible SKUs. `no lead time` / `no supplier` / `no MOQ` are data gaps
  worth fixing (fill the supplier or SKU row, re-run `import-masters`); `discontinued` /
  `on_hold` are expected exclusions.

> **Caveat — flat intra-month demand.** Monthly forecasts are pro-rated evenly across the
> days of each month. A cover window running into a high-season month (e.g. a November
> run reaching into December) slightly under-weights the high-season tail. For a seasonal
> SKU near a season boundary, sanity-check the proposed quantity by hand.

---

## Troubleshooting

- **"More than 70% of the catalogue is triggering a reorder"** — the run prints this
  warning when the trigger rate is implausibly high. It usually means the inventory
  snapshot or the committed-PO data is stale or wrong. Check
  `analytics.inventory_health_by_asin` has a fresh `snapshot_date` (and `lake_age_hours`
  isn't far above ~24) and that `brain.po_committed_inventory` looks right before
  trusting the run.
- **A SKU you expected is in "Skipped — no lead time"** — 57 active SKUs currently have
  no `effective_lead_time_days`. Fill the lead time on the supplier or SKU row and re-run
  `import-masters`; the engine cannot size a planning window without it.
- **A SKU is on "flat-velocity fallback"** — it has no rows in the demand forecast.
  Add it to the forecasting tool and re-run `import-forecast` for a real seasonal number.
- **Duplicate-pool warning on a SKU** — obsolete after migration 0019 (per-FNSKU dedupe
  at the view level) + 0020 (ASIN-aggregate view). The engine still logs it for
  defensive completeness but should never fire under the new views. If you see it,
  inspect `analytics.fba_inventory_per_fnsku` for the ASIN — something has slipped
  past the dedupe.
