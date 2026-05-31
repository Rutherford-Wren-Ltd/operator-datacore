-- ============================================================================
-- 0023_brain_search_query_marketplace_id.sql
-- Add marketplace_id to brain.search_query_performance and reissue the PK.
--
-- Why:
--
-- The table was scaffolded in 0003 with PK (period_type, period_start, asin,
-- search_query). That worked when the assumed grain was one row per
-- (period, ASIN, query) and ASINs were expected to be unique across regions.
--
-- They aren't. RW's product range has same-ASIN-in-multiple-marketplaces
-- (e.g. B0F9YZ46ND is live in both UK and US). If we backfill SQP for both
-- regions, the UK and US rows for that ASIN × period × search_query would
-- PK-collide and silently overwrite each other.
--
-- Compounding this: as of 2026-05-30 Amazon's SP-API now requires the
-- `asin` reportOption on this report type (see [[amazon-brand-analytics]]
-- memory). One createReport request = one (period, marketplace, ASIN), so
-- the natural grain of the data is `(period, marketplace, asin, query)`.
-- The PK should mirror that.
--
-- The table is empty (nothing has ever been ingested), so this is a
-- destructive PK swap with no data migration concerns.
-- ============================================================================

BEGIN;

ALTER TABLE brain.search_query_performance
    ADD COLUMN IF NOT EXISTS marketplace_id TEXT;

-- The table is empty, so backfilling existing rows isn't a concern, but
-- the NOT NULL needs to wait until after we set a value on any rows that
-- somehow snuck in.
UPDATE brain.search_query_performance SET marketplace_id = 'A1F83G8C2ARO7P'
WHERE marketplace_id IS NULL;

ALTER TABLE brain.search_query_performance
    ALTER COLUMN marketplace_id SET NOT NULL;

-- Drop the old PK and replace with the marketplace-aware one. The old
-- index is auto-dropped when the constraint is.
ALTER TABLE brain.search_query_performance
    DROP CONSTRAINT search_query_performance_pkey;
ALTER TABLE brain.search_query_performance
    ADD CONSTRAINT search_query_performance_pkey
    PRIMARY KEY (period_type, period_start, marketplace_id, asin, search_query);

COMMENT ON COLUMN brain.search_query_performance.marketplace_id IS
'Amazon marketplace identifier (e.g. A1F83G8C2ARO7P for UK). Required: SQP reports are per-marketplace and the same ASIN can exist in multiple marketplaces with different search-query funnels.';

INSERT INTO meta.migration_history (filename)
VALUES ('0023_brain_search_query_marketplace_id.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
