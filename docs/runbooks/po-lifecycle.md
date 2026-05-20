# Runbook: purchase-order lifecycle & status changes

A purchase order moves through a lifecycle. This runbook covers the stages, how to change
a PO's status with the `set-po-status` CLI, and when to use it versus a re-import.

## The lifecycle

```
draft → placed → confirmed → in_production → shipped → at_destination → received → closed
```

`cancelled` is terminal and reachable from any state.

| Status | Meaning |
|---|---|
| `draft` | In preparation during forecast/stock review. Quantities and costs are **estimates**. Not yet sent to the supplier. |
| `placed` | Sent to the supplier. `order_date` is set. Costs are now finalised. |
| `confirmed` | Supplier has confirmed the order. |
| `in_production` | Goods being manufactured. |
| `shipped` | Goods have left the supplier / consolidation point. `actual_ship_date` set. |
| `at_destination` | Goods arrived at the destination 3PL / AWD. `actual_arrival_date` set. |
| `received` | Goods receipted into inventory. `actual_arrival_date` set. |
| `closed` | PO complete and reconciled. |
| `cancelled` | PO will not proceed. |

**Draft is special.** A `draft` PO's estimated line costs do **not** populate
`brain.sku_landed_cost` (they are not authoritative COGS), and a draft does not count as
committed stock in `brain.po_committed_inventory`. See
[import-purchase-orders.md](import-purchase-orders.md).

## Changing status — `set-po-status`

```
cd infrastructure/operator-datacore
npm run set-po-status -- --po PO22365 --status shipped --date 2026-08-20
npm run set-po-status -- --po PO22365 --status confirmed --dry-run
```

- `--po` — the PO number (required).
- `--status` — the target status (required). Loose text is normalised (`"In Production"` works).
- `--date` — `YYYY-MM-DD`. Fills the date column the status implies (see matrix below).
- `--dry-run` — print the intended change without writing.

The CLI looks up the PO, updates `status` (and the implied date), and the database trigger
`trg_po_status_history` auto-logs the transition to `brain.purchase_order_status_history`
with `change_source = 'cli:set-po-status'`. Setting a PO to a status it already holds is a
no-op. A backwards move (or re-opening a `cancelled` PO) is allowed but warned.

### Status → date matrix

| Target status | `--date` fills | If `--date` omitted |
|---|---|---|
| `placed` | `order_date` | left unchanged (warned) |
| `shipped` | `actual_ship_date` | left unchanged (warned) |
| `at_destination` / `received` | `actual_arrival_date` | left unchanged (warned) |
| `draft` / `confirmed` / `in_production` / `closed` / `cancelled` | — | `--date` ignored (warned) |

## `set-po-status` vs re-import

| Situation | Use |
|---|---|
| **draft → placed** (costs finalised at the same time) | **Re-import.** Update the workbook with final costs, re-export the CSV pair with `status=placed` + `order_date`, and run `import-purchase-orders`. The re-import flips the status *and* populates `brain.sku_landed_cost`. |
| **Any status change with no cost change** (placed → confirmed → shipped → …) | **`set-po-status`.** A one-line command — no workbook re-export. |
| Quick correction of a single PO's status | `set-po-status`. |
| Bulk update of many POs, or any line/cost change | `import-purchase-orders` (the CSV pair). |

`set-po-status` changes status only — it never touches line costs or
`brain.sku_landed_cost`. When a PO leaves `draft`, the CLI prints a reminder to re-import
it with finalised costs so `sku_landed_cost` picks them up.

## Auditing status history

```sql
SELECT po_id, from_status, to_status, changed_at, change_source
FROM brain.purchase_order_status_history
WHERE po_id = (SELECT po_id FROM brain.purchase_orders WHERE po_number = 'PO22365')
ORDER BY changed_at;
```

`change_source` is `cli:set-po-status` for a CLI change, or `import:<sync_run_id>` for a
change made by a CSV re-import.
