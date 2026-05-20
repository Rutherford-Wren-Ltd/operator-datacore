# Runbook: import purchase orders

Load purchase orders from CSV into `brain.purchase_orders` + `brain.purchase_order_lines`.
Run it for the initial load of existing open POs and after every PO-sheet edit.

## When to run

- After creating or updating a PO in the Google Drive PO sheet.
- Before a weekly restock cycle, so `/restock-memo` sees current committed stock.
- Any time a PO changes status (placed, shipped, received, ...).

## What you need

Two CSV files, exported from the Google Drive PO sheet, in a gitignored folder
(`seller-sessions-2026/imports/` is the convention):

- `purchase-orders.csv` — one row per PO header.
- `purchase-order-lines.csv` — one row per SKU per PO.

Templates with the exact columns and example rows are in
`docs/samples/purchase-orders.sample.csv` and `docs/samples/purchase-order-lines.sample.csv`.

### purchase-orders.csv columns

| Column | Required | Notes |
|---|---|---|
| `po_number` | yes | Operator-facing PO id. The idempotency key — re-importing the same number updates the PO. |
| `supplier_id` | yes | Must exist in `brain.supplier_master` (e.g. `SUP-020`). Run `import-masters` first if not. |
| `status` | yes | `draft` / `placed` / `confirmed` / `in_production` / `shipped` / `at_destination` / `received` / `closed` / `cancelled`. Loose text is normalised (`"In Production"` works). |
| `destination` | yes | Physical first landing: `fba_direct` / `uk_3pl_lemonpath` / `usa_awd` / `rw_held`. Aliases accepted (`fba`, `lemonpath`, `lp`, `awd`, ...). |
| `serves_region` | yes | Which demand region the stock can fulfil: `uk_eu` / `na` / `global`. A `uk_3pl_lemonpath` PO must not be marked `na`. |
| `currency` | recommended | 3-letter code (`USD`, `GBP`, `EUR`). |
| `order_date` etc. | optional | `order_date`, `expected_ship_date`, `actual_ship_date`, `expected_arrival_date`, `actual_arrival_date` — `YYYY-MM-DD`. |
| `payment_terms` | optional | Free-text snapshot. |
| `total_value`, `deposit_amount`, `balance_amount` | optional | Numbers in the PO's `currency`. |
| `payment_status` | optional | `unpaid` (default) / `deposit_paid` / `paid_in_full` / `not_applicable`. |
| `notes` | optional | |

### purchase-order-lines.csv columns

| Column | Required | Notes |
|---|---|---|
| `po_number` | yes | Must match a header row. |
| `line_no` | yes | 1-based, unique within a PO. |
| `ean` | recommended | The SKU key. Unknown EANs import anyway and log a warning (see below). |
| `asin` | optional | Backfilled from `sku_master` when omitted and the EAN resolves. |
| `supplier_sku`, `description` | optional | A line must carry at least one of `ean` / `supplier_sku` / `description`. |
| `qty_ordered` | yes | |
| `qty_received` | optional | Defaults 0. May exceed `qty_ordered` (over-ships are allowed; see `analytics.po_over_receipts`). |
| `unit_cost` | optional | Per-unit, in the PO's currency. |
| `line_status` | optional | `open` (default) / `partial` / `received` / `cancelled`. |
| `notes` | optional | |

## How to run

Dry-run first — it validates everything and reports counts + warnings without writing:

```
cd infrastructure/operator-datacore
npm run import-purchase-orders -- --import-dir "<path to imports folder>" --dry-run
```

If the dry-run looks right, run for real:

```
npm run import-purchase-orders -- --import-dir "<path to imports folder>"
```

`--import-dir` expects `purchase-orders.csv` + `purchase-order-lines.csv` inside it. To point
at differently-named files use `--orders-csv` and `--lines-csv` instead.

## What the importer does

- **Headers** are upserted on `po_number` — re-importing updates the PO in place.
- **Lines** are delete-then-insert per PO: every line of a PO present in the lines CSV is
  replaced, so a line removed from the sheet is removed from the DB. A PO absent from the
  lines CSV keeps its existing lines untouched.
- A status change recorded by the import is logged to `brain.purchase_order_status_history`,
  attributed to the import run.
- The run is recorded in `meta.sync_run` (`object='purchase_orders'`).

## Hard errors vs warnings

**Hard errors stop the import** (nothing is written):
- a `supplier_id` not in `brain.supplier_master`
- a line whose `po_number` has no header row
- an unrecognised `status` / `destination` / `serves_region` / `payment_status` / `line_status`
- a missing required column or required field

**Warnings do not stop the import** — the row is imported and a `warn` row is written to
`meta.sync_log`:
- an `ean` that is not in `brain.sku_master`. The line still imports; this just flags that
  the SKU master may need updating (run `import-masters`) or the EAN is mistyped.

After a run, review warnings:

```sql
SELECT message, payload FROM meta.sync_log
WHERE level = 'warn'
  AND sync_run_id = (SELECT sync_run_id FROM meta.sync_run
                     WHERE object = 'purchase_orders' ORDER BY started_at DESC LIMIT 1);
```

## After importing

`/restock-memo` reads `brain.po_committed_inventory` and the monthly-close reads
`analytics.trade_payables` — both reflect the import immediately. `/restock-memo` also checks
how fresh this import is; keep it current so restock decisions are not made on stale PO state.
