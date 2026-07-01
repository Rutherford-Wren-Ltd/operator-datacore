-- ============================================================================
-- 0051_brain_ads_entity_names.sql
-- campaign_id → campaign_name and ad_group_id → ad_group_name lookups, imported
-- from the operator's Amazon Ads bulk export.
--
-- Why: the API report tables (brain.ads_sp_daily, ads_sp_searchterm_daily,
-- ads_sp_targeting_daily, ads_sb_daily, ads_sd_daily) carry only campaign_id /
-- ad_group_id — no names. brain.ads_campaign_history_imported has campaign_name
-- but a NULL campaign_id (no join key). So per-ASIN audits + action sheets
-- (e.g. /ppc-audit) could not show a searchable campaign name — and a campaign's
-- dominant keyword is NOT its name (that's ad-group/keyword scope). These two
-- tables give the real names, joinable by id.
--
-- Source: the operator's Amazon Ads export (Bulk operations / Campaign manager),
-- an xlsx with tabs "Campaign name and ID" + "Ad group name and ID", loaded by
-- the import-ads-entity-names CLI. Point-in-time snapshot (not every live id is
-- present); idempotent on the id PK — re-import to refresh names.
--
-- NB migration numbering: main is at 0047; 0048-0050 are in-flight on parallel
-- branches, so this is numbered 0051 to sit above them. Renumber if it collides
-- at merge time (CREATE TABLE IF NOT EXISTS makes that safe).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS brain.ads_campaign_names (
    campaign_id    TEXT PRIMARY KEY,
    campaign_name  TEXT NOT NULL,
    source_file    TEXT,
    ingested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS brain.ads_ad_group_names (
    ad_group_id    TEXT PRIMARY KEY,
    ad_group_name  TEXT NOT NULL,
    source_file    TEXT,
    ingested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE brain.ads_campaign_names IS
'campaign_id → campaign_name from the operator Amazon Ads bulk export (API report tables carry only ids; ads_campaign_history_imported has names but a null campaign_id, so no join there). Join on campaign_id to label campaigns in /ppc-audit. Point-in-time snapshot — not every live campaign_id is present; idempotent on campaign_id, re-import to refresh.';

COMMENT ON TABLE brain.ads_ad_group_names IS
'ad_group_id → ad_group_name from the operator Amazon Ads bulk export. Join on ad_group_id. Point-in-time snapshot; idempotent on ad_group_id.';

COMMIT;
