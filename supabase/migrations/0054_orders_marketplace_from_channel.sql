-- ============================================================================
-- 0054_orders_marketplace_from_channel.sql
-- Re-attribute brain.orders.marketplace_id from the order's true sales-channel.
--
-- GET_FLAT_FILE_ALL_ORDERS is ACCOUNT-WIDE: a report requested "for DE" returns
-- every marketplace's orders, and ingest-orders (pre the companion code fix)
-- stamped marketplace_id = the *requested* marketplace on all of them. The DE
-- history backfill therefore mislabeled ~150k UK orders (sales_channel
-- 'Amazon.co.uk') as DE, and buried the real UK order book under the DE tag.
--
-- This migration relabels each row to the marketplace its sales_channel implies
-- (mirrors salesChannelToMarketplaceId in src/lib/marketplaces.ts). The PK is
-- (marketplace_id, amazon_order_id), so a naive UPDATE can collide with a row
-- already stored under the correct marketplace (e.g. the same order also pulled
-- by the daily-sync under UK). Step 1 deletes those mislabeled duplicates;
-- step 2 relabels the rest. Non-Amazon / unmapped channels are left untouched.
--
-- order_items carries no marketplace_id (keyed on amazon_order_id), so nothing
-- there needs to move. Idempotent: re-running matches no rows once corrected.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _channel_map (sales_channel text PRIMARY KEY, correct_id text)
  ON COMMIT DROP;
INSERT INTO _channel_map (sales_channel, correct_id) VALUES
  ('Amazon.com',    'ATVPDKIKX0DER'),
  ('Amazon.ca',     'A2EUQ1WTGCTBG2'),
  ('Amazon.com.mx', 'A1AM78C64UM0Y8'),
  ('Amazon.co.uk',  'A1F83G8C2ARO7P'),
  ('Amazon.de',     'A1PA6795UKMFR9'),
  ('Amazon.fr',     'A13V1IB3VIYZZH'),
  ('Amazon.it',     'APJ6JRA9NG5V4'),
  ('Amazon.es',     'A1RKKUPIHCS9HS'),
  ('Amazon.nl',     'A1805IZSGTT6HS'),
  ('Amazon.se',     'A2NODRKZP88ZB9'),
  ('Amazon.pl',     'A1C3SOZRARQ6R3'),
  ('Amazon.com.be', 'AMEN7PMS3EDWL'),
  ('Amazon.ie',     'A28R8C7NBKEWEA'),
  ('Amazon.com.tr', 'A33AVAJ2PDY3EV'),
  ('Amazon.co.jp',  'A1VC38T7YXB528');

-- 1. Drop mislabeled rows that would collide with an already-correct row.
DELETE FROM brain.orders o
USING _channel_map m
WHERE o.sales_channel = m.sales_channel
  AND o.marketplace_id <> m.correct_id
  AND EXISTS (
    SELECT 1 FROM brain.orders c
    WHERE c.amazon_order_id = o.amazon_order_id
      AND c.marketplace_id  = m.correct_id
  );

-- 2. Relabel the remaining mislabeled rows to their true marketplace.
UPDATE brain.orders o
   SET marketplace_id = m.correct_id,
       updated_at     = NOW()
  FROM _channel_map m
 WHERE o.sales_channel = m.sales_channel
   AND o.marketplace_id <> m.correct_id;

INSERT INTO meta.migration_history (filename)
VALUES ('0054_orders_marketplace_from_channel.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
