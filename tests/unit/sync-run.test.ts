// ============================================================================
// sync-run.test.ts
//
// Fixtures for the withSyncRun() helper. Uses a hand-rolled pg-client mock so
// the test runs without a live Postgres — verifies the INSERT-then-UPDATE
// lifecycle, the handle setters, and (critically) that thrown exceptions still
// finalise the row as 'failed' rather than leaving it 'running'.
//
// Run via `npm test`.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { withSyncRun } from '../../src/lib/sync-run.js';

// Minimal mock pg client. Records every query in order so assertions can
// inspect the lifecycle. Returns a hardcoded sync_run_id for the INSERT.
interface RecordedQuery {
  sql: string;
  params: unknown[];
}

function makeMockPg(syncRunId: string) {
  const queries: RecordedQuery[] = [];
  const pg = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      // The INSERT returns sync_run_id; everything else returns empty rows.
      if (sql.includes('INSERT INTO meta.sync_run')) {
        return { rows: [{ sync_run_id: syncRunId }] };
      }
      return { rows: [] };
    },
  };
  return { pg, queries };
}

describe('withSyncRun — happy path', () => {
  it('opens a sync_run, calls fn, marks success', async () => {
    const { pg, queries } = makeMockPg('test-run-1');
    const result = await withSyncRun(
      pg as never,
      {
        connectionId: 'conn-1',
        source: 'amazon_sp_api',
        object: 'orders_report',
        mode: 'backfill',
        windowStart: new Date('2026-06-01'),
        windowEnd: new Date('2026-06-18'),
      },
      async (run) => {
        run.setRowsFetched(42);
        run.setRowsUpserted(40);
        return 'work-done';
      },
    );

    assert.equal(result, 'work-done');
    assert.equal(queries.length, 2);
    assert.match(queries[0]!.sql, /INSERT INTO meta\.sync_run/);
    assert.match(queries[1]!.sql, /UPDATE meta\.sync_run/);

    const updateParams = queries[1]!.params;
    assert.equal(updateParams[0], 'test-run-1');
    assert.equal(updateParams[1], 'success');
    assert.equal(updateParams[2], 42);
    assert.equal(updateParams[3], 40);
  });

  it('exposes syncRunId on the handle for nested writes', async () => {
    const { pg } = makeMockPg('test-run-2');
    let observedSyncRunId: string | null = null;
    await withSyncRun(
      pg as never,
      { connectionId: 'c', source: 's', object: 'o', mode: 'incremental' },
      async (run) => {
        observedSyncRunId = run.syncRunId;
      },
    );
    assert.equal(observedSyncRunId, 'test-run-2');
  });

  it('defaults rows_fetched and rows_upserted to NULL when setters not called', async () => {
    const { pg, queries } = makeMockPg('test-run-3');
    await withSyncRun(
      pg as never,
      { connectionId: 'c', source: 's', object: 'o', mode: 'manual' },
      async () => { /* no setters called */ },
    );
    const updateParams = queries[1]!.params;
    assert.equal(updateParams[2], null);
    assert.equal(updateParams[3], null);
  });

  it('honours setStatus("partial") on the success branch', async () => {
    const { pg, queries } = makeMockPg('test-run-4');
    await withSyncRun(
      pg as never,
      { connectionId: 'c', source: 's', object: 'o', mode: 'backfill' },
      async (run) => {
        run.setStatus('partial');
      },
    );
    assert.equal(queries[1]!.params[1], 'partial');
  });
});

describe('withSyncRun — failure path (the bug PR #99 cleaned up)', () => {
  it('marks status="failed" when fn throws — no orphaned "running" row', async () => {
    const { pg, queries } = makeMockPg('test-run-5');
    let thrownErr: Error | null = null;
    try {
      await withSyncRun(
        pg as never,
        { connectionId: 'c', source: 's', object: 'o', mode: 'backfill' },
        async () => {
          throw new Error('SP-API 403');
        },
      );
    } catch (err) {
      thrownErr = err as Error;
    }

    assert.ok(thrownErr instanceof Error);
    assert.equal(thrownErr.message, 'SP-API 403');

    // CRITICAL: even though the inner fn threw, the row was finalised — no
    // zombie 'running' row left behind. The failure-branch SQL has
    // status='failed' inlined, so the only bound param after syncRunId is
    // the error_message.
    assert.equal(queries.length, 2);
    assert.match(queries[0]!.sql, /INSERT INTO meta\.sync_run/);
    assert.match(queries[1]!.sql, /UPDATE meta\.sync_run/);
    assert.match(queries[1]!.sql, /status = 'failed'/);
    assert.equal(queries[1]!.params[0], 'test-run-5');
    assert.equal(queries[1]!.params[1], 'SP-API 403');
  });

  it('serialises non-Error throws to a stringified message', async () => {
    const { pg, queries } = makeMockPg('test-run-6');
    try {
      await withSyncRun(
        pg as never,
        { connectionId: 'c', source: 's', object: 'o', mode: 'backfill' },
        async () => {
          throw 'string thrown as error';
        },
      );
    } catch { /* swallow */ }
    assert.match(queries[1]!.sql, /status = 'failed'/);
    assert.equal(queries[1]!.params[1], 'string thrown as error');
  });
});
