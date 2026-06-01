// ============================================================================
// Sponsored Brands — daily purchased-product report → brain.ads_sb_daily.
//
// Report type: sbPurchasedProduct (Amazon Ads API v3, adProduct = SPONSORED_BRANDS)
// Granularity: campaign + ad group + PURCHASED ASIN + date
//
// What's different about SB vs SP/SD:
//
//   - SB ads promote a BRAND / Store, not a single ASIN, so there's no
//     "advertised ASIN" — the equivalent is `purchasedAsin`: the ASIN(s)
//     a customer actually bought after clicking the SB ad.
//   - Cost and impressions are reported at the campaign/ad-group level, NOT
//     at the purchased-ASIN level. The `sbPurchasedProduct` report intentionally
//     omits impressions/clicks/cost — those come from `sbCampaigns` /
//     `sbAdGroup` (a separate ingest, follow-up).
//   - Attribution is the 14-day window (same convention as SD).
//
// Schema mapping into brain.ads_sb_daily (shared shape with SP/SD via
// `LIKE brain.ads_sp_daily INCLUDING ALL` from migration 0003):
//   - entity_key = purchasedAsin (or '' fallback)
//   - sales_14d  = sales14d from the report
//   - units_sold_14d = unitsSold14d
//   - impressions / clicks / cost = 0 for now (sbCampaigns ingest is a
//     Phase 7 follow-up that will UPDATE the matching campaign-level row).
//   - Other sales_* / units_sold_* windows = 0 (SB only attributes to 14d).
//
// What this enables today: per-ASIN attributed SB sales, joinable to S&T
// for "where did SB drive purchases?" Doesn't yet enable per-ASIN SB TACoS
// — that needs the campaign-cost follow-up.
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

const SB_PURCHASED_PRODUCT_COLUMNS = [
  'date',
  'campaignId',
  'adGroupId',
  'purchasedAsin',
  'sales14d',
  'unitsSold14d',
] as const;

interface SbPurchasedProductRow {
  date: string;
  campaignId: string | number;
  adGroupId?: string | number;
  purchasedAsin?: string;
  /** 14-day attributed sales for purchases after an SB ad interaction. */
  sales14d?: number;
  /** 14-day attributed units sold. */
  unitsSold14d?: number;
}

export interface IngestSbOptions {
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

export interface IngestSbResult {
  reportId: string;
  status: string;
  rowsFetched: number;
  rowsUpserted: number;
}

/**
 * End-to-end SB ingest: create → poll → download → upsert.
 * Idempotent for the same date range — re-running replaces rows for that window.
 *
 * Returns 0 rows when the profile has no SB campaigns for the date — that's
 * normal (many RW profiles run SP+SD but no SB) and not an error.
 */
export async function ingestSbDaily(opts: IngestSbOptions): Promise<IngestSbResult> {
  const created = await createReport(opts.adsClient, {
    name: `operator-datacore SB purchased-product ${opts.startDate}_${opts.endDate}`,
    startDate: opts.startDate,
    endDate: opts.endDate,
    configuration: {
      adProduct: 'SPONSORED_BRANDS',
      groupBy: ['purchasedAsin'],
      columns: [...SB_PURCHASED_PRODUCT_COLUMNS],
      reportTypeId: 'sbPurchasedProduct',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON',
    },
  });

  const completed: GetReportResponse = await pollReport(
    opts.adsClient,
    created.reportId,
    opts.poll ?? {},
  );

  const rows = await downloadReport<SbPurchasedProductRow>(completed.url!);

  let upserted = 0;
  for (const r of rows) {
    const campaignId = String(r.campaignId);
    const adGroupId = r.adGroupId !== undefined && r.adGroupId !== null ? String(r.adGroupId) : '';
    const asin = r.purchasedAsin ?? null;
    const entityKey = asin ?? 'campaign';

    await opts.pg.query(
      `INSERT INTO brain.ads_sb_daily (
        metric_date, profile_id, campaign_id, ad_group_id, entity_key,
        keyword_id, target_id, asin, sku,
        impressions, clicks, cost,
        sales_1d, sales_7d, sales_14d, sales_30d,
        units_sold_1d, units_sold_7d, units_sold_14d, units_sold_30d,
        currency_code, raw_id, ingested_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        NULL, NULL, $6, NULL,
        0, 0, 0,
        0, 0, $7, 0,
        0, 0, $8, 0,
        $9, NULL, NOW()
      )
      ON CONFLICT (metric_date, campaign_id, ad_group_id, entity_key) DO UPDATE SET
        profile_id        = EXCLUDED.profile_id,
        asin              = EXCLUDED.asin,
        sales_14d         = EXCLUDED.sales_14d,
        units_sold_14d    = EXCLUDED.units_sold_14d,
        currency_code     = EXCLUDED.currency_code,
        ingested_at       = NOW()`,
      [
        r.date,
        opts.profileId,
        campaignId,
        adGroupId,
        entityKey,
        asin,
        r.sales14d ?? 0,
        r.unitsSold14d ?? 0,
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
