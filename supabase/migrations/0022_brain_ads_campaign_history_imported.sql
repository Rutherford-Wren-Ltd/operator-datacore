-- ============================================================================
-- 0022_brain_ads_campaign_history_imported.sql
-- Table for manually-imported Amazon Ads Console campaign-level history.
--
-- Why this exists (separate from brain.ads_sp_daily / ads_sd_daily):
--
-- The Amazon Ads API only retains advertised-product reports for 65-95 days
-- (confirmed 2026-05-28; see [[amazon-ads-api-retention]]). Anything beyond
-- that is unrecoverable via the API.
--
-- The Ads Console (web UI), however, exports CAMPAIGN-LEVEL reports going
-- back ~2 years (SP/SD) or ~1 year (SB). It's a less granular dataset — no
-- per-ASIN attribution, no per-keyword/target detail — but it gives the
-- year-over-year ACoS / TACoS / spend trends per campaign that we need for
-- Christmas 2024 retrospectives and other historical comparisons.
--
-- Schema choices:
--
-- - Generic enough to absorb SP, SD, and SB campaign exports (the three
--   share the same conceptual shape: date, campaign, status, spend, sales).
-- - raw_csv JSONB carries the full CSV row verbatim. Every column the
--   Console exports lands there, so we don't lose data we haven't modelled
--   and can grow the typed columns later without re-importing.
-- - Provenance fields (import_batch_id, source_file, imported_at) so that
--   any anomaly in the data can be traced to a specific CSV.
-- - PK is (metric_date, profile_id, ad_product, campaign_name). campaign_id
--   would be cleaner but isn't always present in Console exports;
--   campaign_name is reliably populated.
--
-- The API-pulled `brain.ads_sp_daily` / `ads_sd_daily` tables stay as the
-- source of truth for the granular (ASIN-level, keyword-level) recent
-- window. This table is the historical complement.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS brain.ads_campaign_history_imported (
    metric_date        DATE NOT NULL,
    profile_id         TEXT NOT NULL,
    profile_label      TEXT,                       -- e.g. 'Emporium Cookshop & Homewares (UK)'
    region             TEXT,                       -- 'NA' | 'EU' | 'FE'
    ad_product         TEXT NOT NULL,              -- 'SP' | 'SD' | 'SB'
    portfolio_name     TEXT,
    campaign_id        TEXT,
    campaign_name      TEXT NOT NULL,
    campaign_status    TEXT,
    targeting_type     TEXT,                       -- 'manual' | 'auto' (SP)
    bidding_strategy   TEXT,                       -- SP-specific
    currency_code      TEXT,

    -- Performance metrics (nullable; populated as the CSV provides them).
    -- Attribution windows vary by product: SP is 7d, SD is 14d, SB is 14d
    -- (Amazon's defaults). The Console export labels are normalised to
    -- these typed columns at import time; original column names live in
    -- raw_csv for audit / re-modelling.
    impressions        BIGINT,
    clicks             BIGINT,
    spend              NUMERIC(14, 4),
    orders             BIGINT,
    sales              NUMERIC(14, 4),
    units              BIGINT,

    -- Full CSV row, headers normalised to lowercase snake_case keys.
    raw_csv            JSONB NOT NULL,

    -- Provenance — what import populated this row, for audit / re-import.
    import_batch_id    TEXT NOT NULL,
    source_file        TEXT,
    imported_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ads_campaign_history_imported_pk
        PRIMARY KEY (metric_date, profile_id, ad_product, campaign_name),
    CONSTRAINT ads_campaign_history_imported_product_chk
        CHECK (ad_product IN ('SP', 'SD', 'SB'))
);

COMMENT ON TABLE brain.ads_campaign_history_imported IS
'Campaign-level Amazon Ads history imported from manual Ads Console CSV exports. Covers the long-tail window (12-24 months) that the Ads API does not retain. Less granular than brain.ads_sp_daily / ads_sd_daily (no per-ASIN), but spans the year-over-year window. Imported via npm run import-ads-console.';

-- Secondary index for joins back to the API-pulled tables. Partial index
-- since campaign_id is not always populated.
CREATE INDEX IF NOT EXISTS ads_campaign_history_imported_campaign_id_idx
    ON brain.ads_campaign_history_imported (campaign_id)
    WHERE campaign_id IS NOT NULL;

-- Secondary index for product-level rollups across all profiles.
CREATE INDEX IF NOT EXISTS ads_campaign_history_imported_product_date_idx
    ON brain.ads_campaign_history_imported (ad_product, metric_date);

INSERT INTO meta.migration_history (filename)
VALUES ('0022_brain_ads_campaign_history_imported.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
