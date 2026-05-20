#!/usr/bin/env tsx
// ============================================================================
// set-po-status.ts
// Move a purchase order to a new lifecycle status and set the date that status
// implies. The 0013 trigger trg_po_status_history auto-logs the transition to
// brain.purchase_order_status_history.
//
// Usage:
//   npm run set-po-status -- --po PO22365 --status placed --date 2026-06-15
//   npm run set-po-status -- --po PO22365 --status shipped --date 2026-08-20 --dry-run
//
// This changes the PO's status only — never its line costs or
// brain.sku_landed_cost. When a PO leaves draft, re-import it with finalised
// costs (npm run import-purchase-orders) so sku_landed_cost picks them up.
// ============================================================================

import { parseArgs } from 'node:util';
import { getPgClient } from '../lib/supabase.js';

// Lifecycle order — must match the status CHECK in migration 0013. cancelled is
// terminal-from-anywhere and sits outside the linear order.
const LIFECYCLE = ['draft', 'placed', 'confirmed', 'in_production',
  'shipped', 'at_destination', 'received', 'closed'];
const STATUS_VALUES = [...LIFECYCLE, 'cancelled'];

// The date column a status transition fills, if any. Values are fixed column
// identifiers (not user input) — safe to interpolate into the UPDATE.
const STATUS_DATE_COLUMN: Record<string, string> = {
  placed: 'order_date',
  shipped: 'actual_ship_date',
  at_destination: 'actual_arrival_date',
  received: 'actual_arrival_date',
};

// Canonicalise loose status text: lowercase, trim, spaces/hyphens -> underscore.
function canon(s: string): string {
  return s.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

interface PoRow {
  po_id: string;
  status: string;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'po':      { type: 'string' },
      'status':  { type: 'string' },
      'date':    { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const poNumber = values['po'];
  const statusRaw = values['status'];
  const date = values['date'];
  const dryRun = !!values['dry-run'];

  if (!poNumber || !statusRaw) {
    console.error('Error: --po <po_number> and --status <status> are required.');
    console.error(`  --status one of: ${STATUS_VALUES.join(', ')}`);
    process.exit(1);
  }
  const status = canon(statusRaw);
  if (!STATUS_VALUES.includes(status)) {
    console.error(`Error: status "${statusRaw}" not in ${STATUS_VALUES.join('/')}`);
    process.exit(1);
  }
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`Error: --date "${date}" must be YYYY-MM-DD.`);
    process.exit(1);
  }

  const dateColumn = STATUS_DATE_COLUMN[status];

  console.log('operator-datacore — set purchase-order status');
  console.log('----------------------------------------------');
  console.log(`  PO:      ${poNumber}`);
  console.log(`  Status:  ${status}`);
  console.log(`  Date:    ${date ?? '(none)'}`);
  console.log(`  Dry-run: ${dryRun}`);
  console.log('');

  const pg = await getPgClient();
  try {
    const { rows } = await pg.query<PoRow>(
      'SELECT po_id, status FROM brain.purchase_orders WHERE po_number = $1',
      [poNumber],
    );
    if (rows.length === 0) {
      console.error(`Error: no PO with po_number "${poNumber}".`);
      process.exit(1);
    }
    const current = rows[0]!.status;

    if (current === status) {
      console.log(`PO ${poNumber} is already "${status}" — nothing to do.`);
      return;
    }

    // Warn on a backwards move (both ends inside the linear lifecycle), or on
    // re-opening a cancelled PO. The transition is still allowed.
    const ci = LIFECYCLE.indexOf(current);
    const ti = LIFECYCLE.indexOf(status);
    if (ci >= 0 && ti >= 0 && ti < ci) {
      console.log(`Warning: moving backwards in the lifecycle (${current} -> ${status}).`);
    }
    if (current === 'cancelled') {
      console.log(`Warning: re-opening a cancelled PO (${current} -> ${status}).`);
    }

    // Date handling.
    if (dateColumn && !date) {
      console.log(`Warning: status "${status}" records a date in ${dateColumn}, but no --date was given — ${dateColumn} left unchanged.`);
    } else if (!dateColumn && date) {
      console.log(`Warning: status "${status}" takes no date — --date ignored.`);
    }
    const setDate = !!(dateColumn && date);

    if (dryRun) {
      console.log('--dry-run — no write.');
      console.log(`Would set PO ${poNumber}: status ${current} -> ${status}`
        + (setDate ? `, ${dateColumn} = ${date}` : ''));
      return;
    }

    // Attribute the status-history row (written by the 0013 trigger) to this CLI.
    await pg.query("SET app.change_source = 'cli:set-po-status'");

    if (setDate) {
      await pg.query(
        `UPDATE brain.purchase_orders
           SET status = $1, ${dateColumn} = $2, updated_at = NOW()
         WHERE po_number = $3`,
        [status, date, poNumber],
      );
    } else {
      await pg.query(
        `UPDATE brain.purchase_orders
           SET status = $1, updated_at = NOW()
         WHERE po_number = $2`,
        [status, poNumber],
      );
    }

    console.log(`Done. PO ${poNumber}: ${current} -> ${status}`
      + (setDate ? `, ${dateColumn} = ${date}` : ''));
    console.log('Transition logged to brain.purchase_order_status_history.');

    if (current === 'draft') {
      console.log('');
      console.log(`Note: ${poNumber} has left draft. Re-import it with finalised costs`);
      console.log('(npm run import-purchase-orders) so brain.sku_landed_cost picks them up.');
    }
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
