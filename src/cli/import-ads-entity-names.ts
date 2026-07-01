#!/usr/bin/env tsx
// ============================================================================
// import-ads-entity-names.ts
// Import campaign_id→campaign_name and ad_group_id→ad_group_name from the
// operator's Amazon Ads bulk export. Lands rows in brain.ads_campaign_names
// and brain.ads_ad_group_names (migration 0051).
//
// Why this exists:
//   The API report tables (brain.ads_sp_daily, ads_sp_searchterm_daily, …) have
//   only campaign_id / ad_group_id — no names — and ads_campaign_history_imported
//   has campaign_name but a NULL campaign_id (no join key). So /ppc-audit could
//   not print a real, searchable campaign name (a campaign's dominant keyword is
//   NOT its name). This CLI loads the real names, joinable by id.
//
// Input:
//   The Amazon Ads → Bulk operations / Campaign manager export as .xlsx with two
//   tabs: "Campaign name and ID" (cols: Campaign ID, Campaign name) and
//   "Ad group name and ID" (cols: Ad group ID, Ad group name). Header matching is
//   case-insensitive and falls back to the first sheet whose name looks right.
//
// Usage:
//   npm run import-ads-entity-names -- --file "C:/path/Campaign and ad group ID and name.xlsx"
//   add --dry-run to inspect what would land without writing.
//
// Idempotent on the id PK — re-run any time to refresh names.
// ============================================================================

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import ExcelJS from 'exceljs';
import type { Client as PgClient } from 'pg';
import { getPgClient } from '../lib/supabase.js';

interface Args {
  file: string;
  dryRun: boolean;
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!values.file) {
    console.error('Missing --file. Usage: npm run import-ads-entity-names -- --file "path/to/export.xlsx"');
    process.exit(1);
  }
  if (!existsSync(values.file)) {
    console.error(`File not found: ${values.file}`);
    process.exit(1);
  }
  return { file: values.file, dryRun: Boolean(values['dry-run']) };
}

/** 1-based index of the header cell (row 1) matching any of `names` (lower-cased, exact). */
function findCol(ws: ExcelJS.Worksheet, names: string[]): number {
  const header = ws.getRow(1);
  for (let c = 1; c <= header.cellCount; c++) {
    const v = String(header.getCell(c).value ?? '').trim().toLowerCase();
    if (names.includes(v)) return c;
  }
  return -1;
}

/** Read [id, name] pairs from a sheet; skips the header and any blank rows. */
function readPairs(
  ws: ExcelJS.Worksheet | undefined,
  idHeaders: string[],
  nameHeaders: string[],
): Array<[string, string]> {
  if (!ws) throw new Error('Expected worksheet not found in workbook');
  const idCol = findCol(ws, idHeaders);
  const nameCol = findCol(ws, nameHeaders);
  if (idCol < 0 || nameCol < 0) {
    throw new Error(
      `Sheet "${ws.name}" is missing an id/name header (looked for ${idHeaders.join('|')} and ${nameHeaders.join('|')})`,
    );
  }
  const out: Array<[string, string]> = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    // Use `.text` (formatted string), not `.value` — id/name cells can come
    // back as rich-text/hyperlink objects that stringify to "[object Object]".
    const id = String(row.getCell(idCol).text ?? '').trim();
    const name = String(row.getCell(nameCol).text ?? '').trim();
    if (id && name) out.push([id, name]);
  });
  return out;
}

async function upsert(
  pg: PgClient | null,
  table: 'ads_campaign_names' | 'ads_ad_group_names',
  idCol: string,
  nameCol: string,
  pairs: Array<[string, string]>,
  sourceFile: string,
  dryRun: boolean,
): Promise<void> {
  const rows = [...new Map(pairs).entries()]; // dedupe by id, last-wins
  console.log(`  brain.${table}: ${rows.length} unique ${idCol} (${pairs.length} rows read)`);
  if (dryRun) {
    rows.slice(0, 5).forEach(([id, name]) => console.log(`    ${id} -> ${name}`));
    if (rows.length > 5) console.log(`    … +${rows.length - 5} more`);
    return;
  }
  if (!pg) throw new Error('pg client required for a non-dry-run upsert');
  const BATCH = 1000;
  let done = 0;
  for (let b = 0; b < rows.length; b += BATCH) {
    const batch = rows.slice(b, b + BATCH);
    const params: unknown[] = [];
    const valuesClauses: string[] = [];
    for (const [id, name] of batch) {
      const i = params.length;
      params.push(id, name, sourceFile);
      valuesClauses.push(`($${i + 1},$${i + 2},$${i + 3})`);
    }
    await pg.query(
      `INSERT INTO brain.${table} (${idCol}, ${nameCol}, source_file)
       VALUES ${valuesClauses.join(',')}
       ON CONFLICT (${idCol}) DO UPDATE SET
         ${nameCol}  = EXCLUDED.${nameCol},
         source_file = EXCLUDED.source_file,
         ingested_at = NOW()`,
      params,
    );
    done += batch.length;
  }
  console.log(`  brain.${table}: upserted ${done}`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(args.file);
  const sourceFile = basename(args.file);

  const campWs =
    wb.getWorksheet('Campaign name and ID') ??
    wb.worksheets.find((w) => /campaign/i.test(w.name) && !/ad ?group/i.test(w.name));
  const agWs =
    wb.getWorksheet('Ad group name and ID') ??
    wb.worksheets.find((w) => /ad ?group/i.test(w.name));

  const campaigns = readPairs(campWs, ['campaign id'], ['campaign name']);
  const adGroups = readPairs(agWs, ['ad group id'], ['ad group name']);
  console.log(
    `Read ${campaigns.length} campaign rows + ${adGroups.length} ad-group rows from ${sourceFile}` +
      (args.dryRun ? '  (dry-run — no writes)' : ''),
  );

  if (args.dryRun) {
    await upsert(null, 'ads_campaign_names', 'campaign_id', 'campaign_name', campaigns, sourceFile, true);
    await upsert(null, 'ads_ad_group_names', 'ad_group_id', 'ad_group_name', adGroups, sourceFile, true);
    console.log('Dry-run complete (no DB connection).');
    return;
  }
  const pg = await getPgClient();
  try {
    await upsert(pg, 'ads_campaign_names', 'campaign_id', 'campaign_name', campaigns, sourceFile, false);
    await upsert(pg, 'ads_ad_group_names', 'ad_group_id', 'ad_group_name', adGroups, sourceFile, false);
  } finally {
    await pg.end();
  }
  console.log('Import complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
