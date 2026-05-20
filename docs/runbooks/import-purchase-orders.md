# Runbook: import purchase orders

Load purchase orders from CSV into `brain.purchase_orders` + `brain.purchase_order_lines`
(schema v1.5, migration 0015). Run it for the initial load of existing open POs and after
every PO-sheet edit.

## What v1.5 changed

A PO line is now **one row per (PO, SKU, destination)**. A SKU ordered once but split
UK / USA is **two product lines**. Packaging is its **own `line_type=packaging` line**
(separately invoiced for a lower duty bracket); its per-unit cost folds into the product
line it points at and is not double-counted anywhere else. Each product line's computed
landed cost flows into `brain.sku_landed_cost` per `(SKU, region)` — the COGS figure
`brain` treats as authoritative.

So `destination` / `serves_region` moved off the **header** onto the **line**, and the
line gained the landed-cost component columns.

## When to run

- After creating or updating a PO in the source PO workbook.
- Before a weekly restock cycle, so `/restock-memo` sees current committed stock.
- Any time a PO changes status (placed, shipped, received, ...).

## What you need

Two CSV files, exported from the PO workbook, in a gitignored folder
(`seller-sessions-2026/imports/` is the convention):

- `purchase-orders.csv` — one row per PO header.
- `purchase-order-lines.csv` — one row per (SKU, destination), plus packaging lines.

Templates with the exact columns and example rows are in
`docs/samples/purchase-orders.sample.csv` and `docs/samples/purchase-order-lines.sample.csv`.

### purchase-orders.csv columns

| Column | Required | Notes |
|---|---|---|
| `po_number` | yes | Operator-facing PO id. The idempotency key — re-importing the same number updates the PO. |
| `supplier_id` | yes | Must exist in `brain.supplier_master` (e.g. `SUP-020`). Run `import-masters` first if not. |
| `status` | yes | `draft` / `placed` / `confirmed` / `in_production` / `shipped` / `at_destination` / `received` / `closed` / `cancelled`. Loose text is normalised (`"In Production"` works). |
| `currency` | recommended | Payment / supplier-invoice currency, 3-letter code (`USD`, `GBP`, `EUR`). Distinct from a line's `landed_cost_currency`. |
| `order_date` etc. | optional | `order_date`, `expected_ship_date`, `actual_ship_date`, `expected_arrival_date`, `actual_arrival_date` — `YYYY-MM-DD`. **`order_date` doubles as the `as_of_date`** for `brain.sku_landed_cost` — without it, landed cost is not written for that PO's lines. |
| `payment_terms` | optional | Free-text snapshot. |
| `total_value`, `deposit_amount`, `balance_amount` | optional | Numbers in the PO's `currency`. `total_value` is advisory — the authoritative converted total is `analytics.open_purchase_orders`. |
| `payment_status` | optional | `unpaid` (default) / `deposit_paid` / `paid_in_full` / `not_applicable`. |
| `notes` | optional | |

`destination` and `serves_region` are **no longer header columns** — they are on the line.

### purchase-order-lines.csv columns

| Column | Required | Notes |
|---|---|---|
| `po_number` | yes | Must match a header row. |
| `line_no` | yes | 1-based, unique within a PO. |
| `line_type` | optional | `product` (default) or `packaging`. Omit the column entirely for an all-product PO. |
| `ean` | recommended | The SKU key. Unknown EANs import anyway and log a warning (see below). |
| `asin` | optional | Backfilled from `sku_master` when omitted and the EAN resolves. |
| `supplier_sku`, `description` | optional | A line must carry at least one of `ean` / `supplier_sku` / `description`. |
| `destination` | yes | Physical first landing: `fba_direct` / `uk_3pl_lemonpath` / `usa_awd` / `rw_held`. Aliases accepted (`fba`, `lemonpath`, `lp`, `awd`, ...). |
| `serves_region` | yes | Demand region this slice can fulfil: `uk_eu` / `na` / `global`. What restock math groups on — a `uk_3pl_lemonpath` line must not be marked `na`. |
| `qty_ordered` | yes | The **split** quantity for this destination, not the PO total. |
| `qty_received` | optional | Defaults 0. May exceed `qty_ordered` (over-ships are allowed; see `analytics.po_over_receipts`). |
| `line_status` | optional | `open` (default) / `partial` / `received` / `cancelled`. |
| `comp_fob` | optional | Per-unit FOB cost. |
| `comp_lcl` | optional | Per-unit LCL / consolidation cost. |
| `comp_import_duty` | optional | Per-unit import-duty **amount**. |
| `import_duty_rate` | optional | The duty **rate** as a fraction (`0.6020`, not `60.20`). Stored for customs audit. |
| `comp_qa` | optional | Per-unit QA / inspection cost. |
| `comp_china_3pl` | optional | Per-unit China-3PL handling cost. |
| `comp_freight_dock` | optional | Per-unit freight / dock cost (CBM-derived). |
| `comp_photos` | optional | Per-unit photography / listing-asset cost. |
| `comp_bond_fee` | optional | Per-unit customs-bond fee (USA leg). |
| `comp_amz_location_fee` | optional | Per-unit Amazon inbound placement fee (USA leg). |
| `comp_azus_storage` | optional | Per-unit AWD/AZUS storage cost (USA leg). |
| `landed_cost_currency` | conditional | 3-letter code. **Required if any `comp_*` value is given.** Typically `GBP` for a UK destination, `USD` for USA. |
| `stated_landed_cost` | optional | Operator's own landed-cost figure. Used only for the drift check — the importer warns, never fails, if its computed figure disagrees. |
| `packages_line_no` | conditional | On a **packaging line only**: the `line_no` of the product line (same PO) whose cost it folds into. |
| `notes` | optional | |

The importer computes `landed_cost` = sum of the non-NULL `comp_*` columns; you do not
supply it. `comp_packaging_allocated` is also computed (from the packaging fold) — never a
CSV column.

## How to run

Dry-run first — it validates everything, computes landed costs, resolves the packaging
fold, and reports what *would* be written, without touching the database:

```
cd infrastructure/operator-datacore
npm run import-purchase-orders -- --import-dir "<path to imports folder>" --dry-run
```

If the dry-run looks right, run for real:

```
npm run import-purchase-orders -- --import-dir "<path to imports folder>"
```

`--import-dir` expects `purchase-orders.csv` + `purchase-order-lines.csv` inside it. To
point at differently-named files use `--orders-csv` and `--lines-csv` instead.

## What the importer does

- **Headers** are upserted on `po_number` — re-importing updates the PO in place.
- **Lines** are delete-then-insert per PO: every line of a PO present in the lines CSV is
  replaced, so a line removed from the sheet is removed from the DB. A PO absent from the
  lines CSV keeps its existing lines untouched.
- **Landed cost** per line = sum of the non-NULL `comp_*` columns.
- **Packaging fold:** each `line_type=packaging` line's computed landed cost is added into
  the `comp_packaging_allocated` of the product line named by its `packages_line_no`, and
  that product line's `landed_cost` is re-summed. Packaging is thus costed once, inside
  the product.
- **`brain.sku_landed_cost`** is upserted from every product line (per `ean` +
  `serves_region`), with the PO's `order_date` as `as_of_date`. A **newer-wins guard**
  means re-importing an older PO never regresses a SKU's landed cost.
- A status change recorded by the import is logged to `brain.purchase_order_status_history`.
- The run is recorded in `meta.sync_run` (`object='purchase_orders'`).

## Hard errors vs warnings

**Hard errors stop the import** (nothing is written):
- a `supplier_id` not in `brain.supplier_master`
- a line whose `po_number` has no header row
- an unrecognised `status` / `destination` / `serves_region` / `payment_status` /
  `line_status` / `line_type`
- a duplicate `line_no` within a PO, or a duplicate `(ean, destination, line_type)`
- `comp_*` values given with no `landed_cost_currency`
- a `packages_line_no` that does not match a product line in the same PO
- a missing required column or required field

**Warnings do not stop the import** — the row is imported and a `warn` row is written to
`meta.sync_log`:
- an `ean` not in `brain.sku_master` (the line still imports; run `import-masters` or fix
  the EAN)
- a computed `landed_cost` that drifts from the line's `stated_landed_cost`
- a packaging line with no `packages_line_no` (its cost folds into nothing)
- a product line whose PO has no `order_date` (landed cost not written to
  `brain.sku_landed_cost`)

After a run, review warnings:

```sql
SELECT message, payload FROM meta.sync_log
WHERE level = 'warn'
  AND sync_run_id = (SELECT sync_run_id FROM meta.sync_run
                     WHERE object = 'purchase_orders' ORDER BY started_at DESC LIMIT 1);
```

## Mapping an existing PO workbook into the CSV pair

The current open POs live in per-order workbooks. For v1.5 the one-time load is a manual
mapping of each workbook into the two CSVs:

- **Order Placed tab** → the header row + the PO-total quantities. Quantities here are
  totals; the split comes from the Costings tab.
- **Costings tab, UK Shipment sub-section** → one `product` line per SKU, `destination`
  matching where the UK stock lands (`uk_3pl_lemonpath` or `fba_direct`),
  `serves_region=uk_eu`, `landed_cost_currency=GBP`. The `qty_ordered` is the UK split, not
  the PO total.
- **Costings tab, USA Shipment sub-section** → a second `product` line for the same SKU,
  `destination=usa_awd`, `serves_region=na`, `landed_cost_currency=USD`. Its `comp_*`
  columns carry the USA-only costs — `comp_import_duty` + `import_duty_rate`,
  `comp_bond_fee`, `comp_amz_location_fee`, `comp_azus_storage`.
- **Costings tab, Packaging sub-section** → a `packaging` line per destination, with
  `packages_line_no` pointing at that destination's product line.
- **3PL Charge tab** → `comp_china_3pl`.
- **Shipping CBM tab** → the CBM-derived per-unit freight goes into `comp_freight_dock`.
- **Forecast tabs** → ignored in v1.5 (a later phase).

Put each Costings sub-section's stated landed figure into `stated_landed_cost` so the
importer's drift check confirms the mapping reproduced it.

A standardised PO workbook template + an xlsx-aware importer is the planned next phase —
after the existing POs are loaded with this CSV pair.

## After importing

`/restock-memo` reads `brain.po_committed_inventory` and `brain.sku_landed_cost`; the
monthly-close reads `analytics.trade_payables` — all reflect the import immediately.
`/restock-memo` also checks how fresh this import is; keep it current so restock decisions
are not made on stale PO state.
