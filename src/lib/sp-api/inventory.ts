// ============================================================================
// FBA Inventory snapshot via SP-API getInventorySummaries
//
// Endpoint: GET /fba/inventory/v1/summaries
// Source:   FBA Inventory API (live JSON), NOT GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA
//
// Why this endpoint instead of the Reports API path the brain.fba_inventory_snapshot
// migration comment references: getInventorySummaries sits on its own rate-limit
// bucket (separate from the Reports API createReport quota that the daily Sales &
// Traffic pulls already constrain), and returns JSON in real time so there is no
// async report-polling round-trip. Response columns map cleanly onto the existing
// brain.fba_inventory_snapshot schema — the migration comment is descriptive of
// one valid source, not a constraint.
// ============================================================================

import type { Client as PgClient } from 'pg';
import { SpApiError, type SpApiClient } from './client.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pace between successful pages to stay under the getInventorySummaries
 * rate limit (~2 req/s + burst 2). At 600ms we sit at ~1.6 req/s, with
 * headroom for the client's own retry logic.
 */
const INTER_PAGE_DELAY_MS = 600;

interface ReservedQty {
  totalReservedQuantity?: number;
}

interface ResearchingQty {
  totalResearchingQuantity?: number;
}

interface UnfulfillableQty {
  totalUnfulfillableQuantity?: number;
}

interface InventoryDetails {
  fulfillableQuantity?: number;
  inboundWorkingQuantity?: number;
  inboundShippedQuantity?: number;
  inboundReceivingQuantity?: number;
  reservedQuantity?: ReservedQty;
  researchingQuantity?: ResearchingQty;
  unfulfillableQuantity?: UnfulfillableQty;
}

export interface InventorySummary {
  asin?: string;
  fnSku?: string;
  sellerSku: string;
  condition?: string;
  productName?: string;
  totalQuantity?: number;
  lastUpdatedTime?: string;
  inventoryDetails?: InventoryDetails;
}

interface InventorySummariesBody {
  payload?: {
    inventorySummaries?: InventorySummary[];
    granularity?: { granularityType: string; granularityId: string };
  };
  pagination?: { nextToken?: string };
}

export interface SnapshotOptions {
  spClient: SpApiClient;
  pg: PgClient;
  marketplaceId: string;
  snapshotDate?: Date;
  onPage?: (info: {
    page: number;
    rowsFetched: number;
    cumulativeRows: number;
    cumulativeSkipped: number;
  }) => void;
}

export interface SnapshotResult {
  marketplaceId: string;
  snapshotDate: string;
  /** Rows actually written. Excludes ones filtered as zero-inventory + no-inbound. */
  totalRows: number;
  /** Rows seen by the API but skipped because they had no live or inbound inventory. */
  skipped: number;
  pages: number;
}

/**
 * Pulls the current FBA inventory snapshot for one marketplace via SP-API
 * getInventorySummaries with details=true, paginates through nextToken, upserts
 * into brain.fba_inventory_snapshot keyed by (snapshot_date, marketplace_id, sku).
 *
 * Designed to be idempotent for the same UTC date: running twice on the same day
 * replaces the day's rows with the latest snapshot.
 */
export async function snapshotFbaInventory(opts: SnapshotOptions): Promise<SnapshotResult> {
  const snapshotDate = (opts.snapshotDate ?? new Date()).toISOString().slice(0, 10);
  let nextToken: string | undefined = undefined;
  let page = 0;
  let totalRows = 0;
  let skipped = 0;

  do {
    page += 1;
    const query: Record<string, string> = {
      details: 'true',
      granularityType: 'Marketplace',
      granularityId: opts.marketplaceId,
      marketplaceIds: opts.marketplaceId,
    };
    if (nextToken) query.nextToken = nextToken;

    let res;
    try {
      res = await opts.spClient.request<InventorySummariesBody>({
        method: 'GET',
        path: '/fba/inventory/v1/summaries',
        query,
      });
    } catch (err) {
      // The nextToken has a short server-side TTL. If a 429 wait causes it
      // to expire we get back 400 InvalidInput "Next token is invalid or
      // expired". Treat that as graceful end-of-pagination — the rows we
      // have already upserted are valid; subsequent pages will be picked
      // up on the next daily run.
      //
      // p-retry can surface this either as SpApiError directly OR wrapped
      // in AbortError (when client.ts marks the 4xx as non-retryable).
      // Handle both — see client.ts onFailedAttempt.
      const spErr =
        err instanceof SpApiError
          ? err
          : (err as { originalError?: unknown })?.originalError instanceof SpApiError
            ? ((err as { originalError: SpApiError }).originalError)
            : null;
      if (
        spErr &&
        spErr.status === 400 &&
        /Next token is invalid or expired/i.test(spErr.responseText)
      ) {
        opts.onPage?.({ page, rowsFetched: 0, cumulativeRows: totalRows, cumulativeSkipped: skipped });
        console.error(`  nextToken expired between pages — stopping at ${totalRows} rows; remainder will be picked up next run.`);
        break;
      }
      throw err;
    }

    const summaries = res.payload?.payload?.inventorySummaries ?? [];

    for (const s of summaries) {
      const sku = s.sellerSku;
      if (!sku) continue;
      const d = s.inventoryDetails ?? {};
      const total = s.totalQuantity ?? 0;

      // Skip SKUs with no live inventory and no inbound. getInventorySummaries
      // returns the full "ever-listed" SKU tail (~25k for this account), but
      // most rows are zero across every column — discontinued or never-stocked
      // SKUs that still have an Amazon listing. Storing them blows out the
      // free-tier quota (~98% of writes daily); their absence carries the
      // same information (no inventory) at zero storage cost.
      //
      // What "no inventory" means here: total = 0 AND every inbound flavor
      // = 0. We keep rows where any inbound > 0 because that's a SKU on
      // its way back to relevance.
      const inboundWorking = d.inboundWorkingQuantity ?? 0;
      const inboundShipped = d.inboundShippedQuantity ?? 0;
      const inboundReceiving = d.inboundReceivingQuantity ?? 0;
      if (
        total === 0 &&
        inboundWorking === 0 &&
        inboundShipped === 0 &&
        inboundReceiving === 0
      ) {
        skipped += 1;
        continue;
      }

      await opts.pg.query(
        `INSERT INTO brain.fba_inventory_snapshot (
          snapshot_date, marketplace_id, sku, fnsku, asin, product_name, condition,
          afn_listing_exists,
          afn_warehouse_quantity, afn_fulfillable_quantity, afn_unsellable_quantity,
          afn_reserved_quantity, afn_total_quantity,
          afn_inbound_working_quantity, afn_inbound_shipped_quantity, afn_inbound_receiving_quantity,
          afn_researching_quantity,
          raw_id, ingested_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          TRUE,
          $8, $9, $10,
          $11, $12,
          $13, $14, $15,
          $16,
          NULL, NOW()
        )
        ON CONFLICT (snapshot_date, marketplace_id, sku) DO UPDATE SET
          fnsku                          = EXCLUDED.fnsku,
          asin                           = EXCLUDED.asin,
          product_name                   = EXCLUDED.product_name,
          condition                      = EXCLUDED.condition,
          afn_listing_exists             = EXCLUDED.afn_listing_exists,
          afn_warehouse_quantity         = EXCLUDED.afn_warehouse_quantity,
          afn_fulfillable_quantity       = EXCLUDED.afn_fulfillable_quantity,
          afn_unsellable_quantity        = EXCLUDED.afn_unsellable_quantity,
          afn_reserved_quantity          = EXCLUDED.afn_reserved_quantity,
          afn_total_quantity             = EXCLUDED.afn_total_quantity,
          afn_inbound_working_quantity   = EXCLUDED.afn_inbound_working_quantity,
          afn_inbound_shipped_quantity   = EXCLUDED.afn_inbound_shipped_quantity,
          afn_inbound_receiving_quantity = EXCLUDED.afn_inbound_receiving_quantity,
          afn_researching_quantity       = EXCLUDED.afn_researching_quantity,
          ingested_at                    = NOW()`,
        [
          snapshotDate,
          opts.marketplaceId,
          sku,
          s.fnSku ?? null,
          s.asin ?? null,
          s.productName ?? null,
          s.condition ?? null,
          total,
          d.fulfillableQuantity ?? 0,
          d.unfulfillableQuantity?.totalUnfulfillableQuantity ?? 0,
          d.reservedQuantity?.totalReservedQuantity ?? 0,
          total,
          d.inboundWorkingQuantity ?? 0,
          d.inboundShippedQuantity ?? 0,
          d.inboundReceivingQuantity ?? 0,
          d.researchingQuantity?.totalResearchingQuantity ?? 0,
        ],
      );
      totalRows += 1;
    }

    opts.onPage?.({
      page,
      rowsFetched: summaries.length,
      cumulativeRows: totalRows,
      cumulativeSkipped: skipped,
    });
    nextToken = res.payload?.pagination?.nextToken;
    if (nextToken) await sleep(INTER_PAGE_DELAY_MS);
  } while (nextToken);

  return { marketplaceId: opts.marketplaceId, snapshotDate, totalRows, skipped, pages: page };
}
