// ============================================================================
// Sponsored Display — daily advertised-product report → brain.ads_sd_daily.
//
// Report type: sdAdvertisedProduct
// Granularity: campaign + ad group + advertised ASIN/SKU + date
//
// Mirrors sp-ingest.ts in shape, but the column model is NOT identical:
//   - SP returns sales1d/sales7d/sales14d/sales30d split.
//   - SD's advertised-product report returns a single `sales` column,
//     pre-aggregated to SD's default attribution window (14d for product
//     targeting, 14d click + 14d view-through for audience targeting).
//   - Same shape difference applies to unitsSold.
//
// We map SD's `sales` → schema column `sales_14d` (the matching window) and
// leave sales_1d/sales_7d/sales_30d at 0. Same logic for units_sold_14d.
//
// Consequence for queries: TACoS calculations for SD must read `sales_14d`,
// not `sales_7d`. SP's 7d attribution is the canonical industry window;
// SD's 14d is Amazon's own pre-aggregated number. Don't mix them.
//
// What this fills: per-ASIN Display ad spend, impressions, clicks, and the
// 14d-attributed sales. Combined with SP ingest, gives the full picture of
// paid spend per ASIN (SB is brand-level — handled separately).
// ============================================================================

import type { Client as PgClient } from 'pg';
import type { AdsApiClient } from './client.js';
import {
  createReport,
  downloadReport,
  pollReport,
  type GetReportResponse,
  type PollOptions,
} from './reports.js';

const SD_ADVERTISED_PRODUCT_COLUMNS = [
  'date',
  'campaignId',
  'adGroupId',
  'promotedAsin',
  'promotedSku',
  'impressions',
  'clicks',
  'cost',
  'sales',
  'unitsSold',
] as const;

interface SdAdvertisedProductRow {
  date: string;
  campaignId: string | number;
  adGroupId: string | number;
  promotedAsin?: string;
  promotedSku?: string;
  impressions?: number;
  clicks?: number;
  cost?: number;
  /** Pre-aggregated to SD's default attribution window (14d). */
  sales?: number;
  /** Pre-aggregated to SD's default attribution window (14d). */
  unitsSold?: number;
}

export interface IngestSdOptions {
  adsClient: AdsApiClient;
  pg: PgClient;
  profileId: string;
  /** Inclusive. Format YYYY-MM-DD. */
  startDate: string;
  /** Inclusive. Format YYYY-MM-DD. */
  endDate: string;
  /** Currency code to stamp on rows (the Ads report does not include it). */
  currencyCode: string;
  poll?: PollOptions;
}

export interface IngestSdResult {
  reportId: string;
  status: string;
  rowsFetched: number;
  rowsUpserted: number;
}

/**
 * End-to-end SD ingest: create → poll → download → upsert.
 * Idempotent for the same date range.
 */
export async function ingestSdDaily(opts: IngestSdOptions): Promise<IngestSdResult> {
  const created = await createReport(opts.adsClient, {
    name: `operator-datacore SD advertised-product ${opts.startDate}_${opts.endDate}`,
    startDate: opts.startDate,
    endDate: opts.endDate,
    configuration: {
      adProduct: 'SPONSORED_DISPLAY',
      groupBy: ['advertiser'],
      columns: [...SD_ADVERTISED_PRODUCT_COLUMNS],
      reportTypeId: 'sdAdvertisedProduct',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON',
    },
  });

  const completed: GetReportResponse = await pollReport(
    opts.adsClient,
    created.reportId,
    opts.poll ?? {},
  );

  const rows = await downloadReport<SdAdvertisedProductRow>(completed.url!);

  let upserted = 0;
  for (const r of rows) {
    const campaignId = String(r.campaignId);
    const adGroupId = String(r.adGroupId);
    const asin = r.promotedAsin ?? null;
    const sku = r.promotedSku ?? null;
    const entityKey = asin ?? sku ?? 'campaign';

    await opts.pg.query(
      `INSERT INTO brain.ads_sd_daily (
        metric_date, profile_id, campaign_id, ad_group_id, entity_key,
        keyword_id, target_id, asin, sku,
        impressions, clicks, cost,
        sales_1d, sales_7d, sales_14d, sales_30d,
        units_sold_1d, units_sold_7d, units_sold_14d, units_sold_30d,
        currency_code, raw_id, ingested_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        NULL, NULL, $6, $7,
        $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18,
        $19, NULL, NOW()
      )
      ON CONFLICT (metric_date, campaign_id, ad_group_id, entity_key) DO UPDATE SET
        profile_id        = EXCLUDED.profile_id,
        asin              = EXCLUDED.asin,
        sku               = EXCLUDED.sku,
        impressions       = EXCLUDED.impressions,
        clicks            = EXCLUDED.clicks,
        cost              = EXCLUDED.cost,
        sales_1d          = EXCLUDED.sales_1d,
        sales_7d          = EXCLUDED.sales_7d,
        sales_14d         = EXCLUDED.sales_14d,
        sales_30d         = EXCLUDED.sales_30d,
        units_sold_1d     = EXCLUDED.units_sold_1d,
        units_sold_7d     = EXCLUDED.units_sold_7d,
        units_sold_14d    = EXCLUDED.units_sold_14d,
        units_sold_30d    = EXCLUDED.units_sold_30d,
        currency_code     = EXCLUDED.currency_code,
        ingested_at       = NOW()`,
      [
        r.date,
        opts.profileId,
        campaignId,
        adGroupId,
        entityKey,
        asin,
        sku,
        r.impressions ?? 0,
        r.clicks ?? 0,
        r.cost ?? 0,
        // SD returns one aggregated sales value at the default attribution
        // window (14d). Stamp it onto sales_14d, leave other windows at 0.
        0,
        0,
        r.sales ?? 0,
        0,
        0,
        0,
        r.unitsSold ?? 0,
        0,
        opts.currencyCode,
      ],
    );
    upserted += 1;
  }

  return {
    reportId: created.reportId,
    status: completed.status,
    rowsFetched: rows.length,
    rowsUpserted: upserted,
  };
}
