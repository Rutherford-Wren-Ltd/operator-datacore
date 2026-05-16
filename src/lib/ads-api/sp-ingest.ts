// ============================================================================
// Sponsored Products — daily advertised-product report → brain.ads_sp_daily.
//
// Report type: spAdvertisedProduct
// Granularity: campaign + ad group + advertised ASIN/SKU + date
//
// What this fills: per-ASIN PPC spend, impressions, clicks, attributed sales
// at 1d/7d/14d/30d windows. That's what powers TACoS in /sku-audit.
//
// What this DOESN'T fill yet: keyword/target-level breakdowns (those come
// from spTargeting / spKeyword reports — separate follow-up). For ASIN-level
// rows here, entity_key = the ASIN, keyword_id and target_id stay NULL.
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

const SP_ADVERTISED_PRODUCT_COLUMNS = [
  'date',
  'campaignId',
  'adGroupId',
  'advertisedAsin',
  'advertisedSku',
  'impressions',
  'clicks',
  'cost',
  'sales1d',
  'sales7d',
  'sales14d',
  'sales30d',
  'unitsSoldClicks1d',
  'unitsSoldClicks7d',
  'unitsSoldClicks14d',
  'unitsSoldClicks30d',
] as const;

interface SpAdvertisedProductRow {
  date: string;
  campaignId: string | number;
  adGroupId: string | number;
  advertisedAsin?: string;
  advertisedSku?: string;
  impressions?: number;
  clicks?: number;
  cost?: number;
  sales1d?: number;
  sales7d?: number;
  sales14d?: number;
  sales30d?: number;
  unitsSoldClicks1d?: number;
  unitsSoldClicks7d?: number;
  unitsSoldClicks14d?: number;
  unitsSoldClicks30d?: number;
}

export interface IngestSpOptions {
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

export interface IngestSpResult {
  reportId: string;
  status: string;
  rowsFetched: number;
  rowsUpserted: number;
}

/**
 * End-to-end SP ingest: create → poll → download → upsert.
 * Idempotent for the same date range — re-running replaces rows for that window.
 */
export async function ingestSpDaily(opts: IngestSpOptions): Promise<IngestSpResult> {
  const created = await createReport(opts.adsClient, {
    name: `operator-datacore SP advertised-product ${opts.startDate}_${opts.endDate}`,
    startDate: opts.startDate,
    endDate: opts.endDate,
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['advertiser'],
      columns: [...SP_ADVERTISED_PRODUCT_COLUMNS],
      reportTypeId: 'spAdvertisedProduct',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON',
    },
  });

  const completed: GetReportResponse = await pollReport(
    opts.adsClient,
    created.reportId,
    opts.poll ?? {},
  );

  const rows = await downloadReport<SpAdvertisedProductRow>(completed.url!);

  let upserted = 0;
  for (const r of rows) {
    const campaignId = String(r.campaignId);
    const adGroupId = String(r.adGroupId);
    const asin = r.advertisedAsin ?? null;
    const sku = r.advertisedSku ?? null;
    const entityKey = asin ?? sku ?? 'campaign';

    await opts.pg.query(
      `INSERT INTO brain.ads_sp_daily (
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
        r.sales1d ?? 0,
        r.sales7d ?? 0,
        r.sales14d ?? 0,
        r.sales30d ?? 0,
        r.unitsSoldClicks1d ?? 0,
        r.unitsSoldClicks7d ?? 0,
        r.unitsSoldClicks14d ?? 0,
        r.unitsSoldClicks30d ?? 0,
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
