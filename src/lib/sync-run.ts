// ============================================================================
// sync-run.ts
// Helper that wraps a CLI run in a meta.sync_run lifecycle: opens a 'running'
// row before the work, marks it 'success' / 'failed' / 'partial' on exit, and
// captures rows_fetched / rows_upserted via a small handle the callback
// fills out.
//
// Why: every ingest/backfill CLI does the same INSERT-then-UPDATE pattern by
// hand, and most of them skip the catch-side UPDATE — so a thrown exception
// (or process.exit before the success update) leaves the sync_run row stuck
// at 'running' with no finished_at. Those orphans are what migration 0037
// retroactively cleaned up; this helper prevents new ones.
//
// Usage:
//
//   await withSyncRun(pg, {
//     connectionId,
//     source: 'amazon_sp_api',
//     object: 'orders_report',
//     mode: 'backfill',
//     windowStart: fromDate.toISOString(),
//     windowEnd: toDate.toISOString(),
//   }, async (run) => {
//     // ... do the work, using run.syncRunId where needed ...
//     run.setRowsUpserted(totalRows);
//     run.setStatus(failures.length === 0 ? 'success' : 'partial');
//   });
//
// The handle's setStatus() is optional; defaults to 'success'. setRowsFetched()
// and setRowsUpserted() are also optional. Any exception thrown inside `fn`
// triggers the failure branch (status='failed', error_message=stringified) and
// is re-thrown so the CLI's outer .catch() can decide whether to process.exit
// or not.
// ============================================================================

import type { Client as PgClient } from 'pg';

export type SyncRunMode = 'backfill' | 'incremental' | 'manual' | 'verification';
export type SyncRunStatus = 'success' | 'partial' | 'failed';

export interface SyncRunHandle {
  /** The newly-created sync_run row's id, for nested writes that need it. */
  readonly syncRunId: string;
  /** Optional. Number of rows pulled from the source for this run. */
  setRowsFetched(n: number): void;
  /** Optional. Number of rows written/updated/inserted in the lake. */
  setRowsUpserted(n: number): void;
  /** Optional. Override the success branch's status (default 'success'). */
  setStatus(s: SyncRunStatus): void;
}

export interface WithSyncRunParams {
  connectionId: string;
  source: string;
  object: string;
  mode: SyncRunMode;
  /** ISO 8601 string or Date. Stored on meta.sync_run.window_start. */
  windowStart?: Date | string | null;
  windowEnd?: Date | string | null;
}

export async function withSyncRun<T>(
  pg: PgClient,
  params: WithSyncRunParams,
  fn: (handle: SyncRunHandle) => Promise<T>,
): Promise<T> {
  const { rows } = await pg.query<{ sync_run_id: string }>(
    `INSERT INTO meta.sync_run (connection_id, source, object, mode, window_start, window_end)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING sync_run_id`,
    [
      params.connectionId,
      params.source,
      params.object,
      params.mode,
      toIsoOrNull(params.windowStart),
      toIsoOrNull(params.windowEnd),
    ],
  );
  const syncRunId = rows[0]!.sync_run_id;

  let rowsFetched: number | null = null;
  let rowsUpserted: number | null = null;
  let status: SyncRunStatus = 'success';

  const handle: SyncRunHandle = {
    syncRunId,
    setRowsFetched(n) { rowsFetched = n; },
    setRowsUpserted(n) { rowsUpserted = n; },
    setStatus(s) { status = s; },
  };

  try {
    const result = await fn(handle);
    await pg.query(
      `UPDATE meta.sync_run
         SET finished_at = NOW(), status = $2, rows_fetched = $3, rows_upserted = $4
       WHERE sync_run_id = $1`,
      [syncRunId, status, rowsFetched, rowsUpserted],
    );
    return result;
  } catch (err) {
    await pg.query(
      `UPDATE meta.sync_run
         SET finished_at = NOW(), status = 'failed', error_message = $2
       WHERE sync_run_id = $1`,
      [syncRunId, err instanceof Error ? err.message : String(err)],
    );
    throw err;
  }
}

function toIsoOrNull(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  return v.toISOString();
}
