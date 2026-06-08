// ============================================================================
// Sponsored Brands — daily ingest → brain.ads_sb_daily.
//
// SB takes TWO reports to assemble the full picture, because Amazon's v3
// API splits SB metrics across report types:
//
//   1. sbPurchasedProduct  → per-purchased-ASIN attributed sales / units.
//                            NO impressions / clicks / cost.
//   2. sbCampaigns         → per-campaign impressions / clicks / cost +
//                            campaign-level attributed sales (for sanity).
//                            NO per-ASIN breakdown.
//
// SB ads promote a brand / Store / multi-ASIN showcase — there's no
// per-ASIN advertised entity, so cost lives at the campaign grain and
// sales attribute to whichever products the customer bought after the
// click. The two reports are designed to be joined, not collapsed.
//
// Schema mapping into brain.ads_sb_daily (shared shape with SP/SD via
// `LIKE brain.ads_sp_daily INCLUDING ALL` from migration 0003):
//
//   - sbPurchasedProduct rows:
//       ad_group_id = adGroupId from report (or '' if absent)
//       entity_key  = purchasedAsin
//       sales_14d, units_sold_14d populated
//       impressions / clicks / cost = 0
//
//   - sbCampaigns rows:
//       ad_group_id = ''
//       entity_key  = 'campaign'        ← distinguishes from purchased-ASIN rows
//       impressions, clicks, cost populated
//       sales_14d, units_sold_14d also populated (campaign-level total)
//
// The two row types have disjoint PKs (entity_key='campaign' vs ASIN), so
// they coexist in the same table without collision. Analytics views can
// JOIN them by (metric_date, profile_id, campaign_id) to spread the
// campaign cost across the per-ASIN sales by sales share — the canonical
// approach for per-ASIN SB TACoS.
//
// Both reports fire in parallel inside `ingestSbDaily`; quota footprint
// for one (profile, date) is 2 SB reports concurrent on Amazon's side.
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

// ---------------------------------------------------------------------------
// sbPurchasedProduct — per-purchased-ASIN attributed sales / units.
// ---------------------------------------------------------------------------

// sbPurchasedProduct retained the `14d` suffix on its metric columns —
// only sbCampaigns dropped it (see note above SB_CAMPAIGNS_COLUMNS).
// PR #88 incorrectly renamed both report types; this stanza was reverted
// in PR #89 after sbPurchasedProduct started 400'ing with the opposite
// error: "configuration columns includes invalid values: (sales, unitsSold)".
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
  sales14d?: number;
  unitsSold14d?: number;
}

// ---------------------------------------------------------------------------
// sbCampaigns — campaign-level impressions / clicks / cost / sales.
// ---------------------------------------------------------------------------

// Note 2026-06-08: Amazon renamed sbCampaigns metric columns `sales14d` → `sales`
// and `unitsSold14d` → `unitsSold` (breaking change observed in the Sat Jun 7
// ripen run, fixed in PR #88). The 14-day attribution window is still the SB
// default — only the API field names dropped the `14d` suffix. DB columns
// `sales_14d` / `units_sold_14d` keep the same name + semantic. The same
// rename does NOT apply to sbPurchasedProduct (see stanza above) — these are
// two distinct Ads-API report types with independent schemas.
const SB_CAMPAIGNS_COLUMNS = [
  'date',
  'campaignId',
  'impressions',
  'clicks',
  'cost',
  'sales',
  'unitsSold',
] as const;

interface SbCampaignsRow {
  date: string;
  campaignId: string | number;
  impressions?: number;
  clicks?: number;
  cost?: number;
  sales?: number;
  unitsSold?: number;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

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
  /** "<purchasedReportId>+<campaignsReportId>" — both reports' IDs, for traceability. */
  reportId: string;
  /** "COMPLETED" if both reports completed, "PARTIAL" otherwise. */
  status: string;
  rowsFetched: number;
  rowsUpserted: number;
}

/**
 * End-to-end SB ingest: fires sbPurchasedProduct + sbCampaigns in parallel,
 * upserts both row types into brain.ads_sb_daily. Idempotent for the same
 * date range.
 *
 * Returns 0 rows when the profile has no SB campaigns for the date — that's
 * normal (many RW profiles run SP+SD but no SB) and not an error.
 */
export async function ingestSbDaily(opts: IngestSbOptions): Promise<IngestSbResult> {
  const [purchased, campaigns] = await Promise.all([
    ingestSbPurchasedProduct(opts),
    ingestSbCampaigns(opts),
  ]);

  return {
    reportId: `${purchased.reportId}+${campaigns.reportId}`,
    status:
      purchased.status === 'COMPLETED' && campaigns.status === 'COMPLETED'
        ? 'COMPLETED'
        : 'PARTIAL',
    rowsFetched: purchased.rowsFetched + campaigns.rowsFetched,
    rowsUpserted: purchased.rowsUpserted + campaigns.rowsUpserted,
  };
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

interface SubResult {
  reportId: string;
  status: string;
  rowsFetched: number;
  rowsUpserted: number;
}

async function ingestSbPurchasedProduct(opts: IngestSbOptions): Promise<SubResult> {
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

async function ingestSbCampaigns(opts: IngestSbOptions): Promise<SubResult> {
  const created = await createReport(opts.adsClient, {
    name: `operator-datacore SB campaigns ${opts.startDate}_${opts.endDate}`,
    startDate: opts.startDate,
    endDate: opts.endDate,
    configuration: {
      adProduct: 'SPONSORED_BRANDS',
      groupBy: ['campaign'],
      columns: [...SB_CAMPAIGNS_COLUMNS],
      reportTypeId: 'sbCampaigns',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON',
    },
  });

  const completed: GetReportResponse = await pollReport(
    opts.adsClient,
    created.reportId,
    opts.poll ?? {},
  );
  const rows = await downloadReport<SbCampaignsRow>(completed.url!);

  let upserted = 0;
  for (const r of rows) {
    const campaignId = String(r.campaignId);

    // Campaign-level rows always land with ad_group_id='' + entity_key='campaign'
    // so they don't collide with the per-purchased-ASIN rows from
    // sbPurchasedProduct (which use entity_key=ASIN).
    await opts.pg.query(
      `INSERT INTO brain.ads_sb_daily (
        metric_date, profile_id, campaign_id, ad_group_id, entity_key,
        keyword_id, target_id, asin, sku,
        impressions, clicks, cost,
        sales_1d, sales_7d, sales_14d, sales_30d,
        units_sold_1d, units_sold_7d, units_sold_14d, units_sold_30d,
        currency_code, raw_id, ingested_at
      ) VALUES (
        $1, $2, $3, '', 'campaign',
        NULL, NULL, NULL, NULL,
        $4, $5, $6,
        0, 0, $7, 0,
        0, 0, $8, 0,
        $9, NULL, NOW()
      )
      ON CONFLICT (metric_date, campaign_id, ad_group_id, entity_key) DO UPDATE SET
        profile_id        = EXCLUDED.profile_id,
        impressions       = EXCLUDED.impressions,
        clicks            = EXCLUDED.clicks,
        cost              = EXCLUDED.cost,
        sales_14d         = EXCLUDED.sales_14d,
        units_sold_14d    = EXCLUDED.units_sold_14d,
        currency_code     = EXCLUDED.currency_code,
        ingested_at       = NOW()`,
      [
        r.date,
        opts.profileId,
        campaignId,
        r.impressions ?? 0,
        r.clicks ?? 0,
        r.cost ?? 0,
        r.sales ?? 0,
        r.unitsSold ?? 0,
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
