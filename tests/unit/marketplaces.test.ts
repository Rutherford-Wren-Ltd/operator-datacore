// ============================================================================
// marketplaces.test.ts
//
// Fixtures for the marketplace-alias lookup + filter parser. Pins the 14
// short-code → marketplace-id mappings the CLIs rely on so a typo in a future
// edit (e.g. UK mapped to a Canadian marketplace ID by accident) gets caught
// before it lands.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MARKETPLACE_ALIASES, resolveMarketplaceFilter, salesChannelToMarketplaceId } from '../../src/lib/marketplaces.js';

describe('salesChannelToMarketplaceId — order sales-channel domain → marketplace id', () => {
  it('maps the EU channels the account sells on', () => {
    assert.equal(salesChannelToMarketplaceId('Amazon.co.uk'), 'A1F83G8C2ARO7P');
    assert.equal(salesChannelToMarketplaceId('Amazon.de'), 'A1PA6795UKMFR9');
    assert.equal(salesChannelToMarketplaceId('Amazon.fr'), 'A13V1IB3VIYZZH');
    assert.equal(salesChannelToMarketplaceId('Amazon.it'), 'APJ6JRA9NG5V4');
    assert.equal(salesChannelToMarketplaceId('Amazon.es'), 'A1RKKUPIHCS9HS');
    assert.equal(salesChannelToMarketplaceId('Amazon.com.be'), 'AMEN7PMS3EDWL');
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    assert.equal(salesChannelToMarketplaceId('amazon.CO.uk'), 'A1F83G8C2ARO7P');
    assert.equal(salesChannelToMarketplaceId('  Amazon.de  '), 'A1PA6795UKMFR9');
  });

  it('returns null for non-Amazon / unmapped / empty channels (caller falls back)', () => {
    assert.equal(salesChannelToMarketplaceId('Non-Amazon'), null);
    assert.equal(salesChannelToMarketplaceId('Non-Amazon UK'), null);
    assert.equal(salesChannelToMarketplaceId(''), null);
    assert.equal(salesChannelToMarketplaceId(null), null);
    assert.equal(salesChannelToMarketplaceId(undefined), null);
  });
});

describe('MARKETPLACE_ALIASES — canonical short-code → ID', () => {
  it('NA region marketplaces', () => {
    assert.equal(MARKETPLACE_ALIASES.US, 'ATVPDKIKX0DER');
    assert.equal(MARKETPLACE_ALIASES.CA, 'A2EUQ1WTGCTBG2');
    assert.equal(MARKETPLACE_ALIASES.MX, 'A1AM78C64UM0Y8');
  });

  it('EU region marketplaces — UK + GB alias the same ID', () => {
    assert.equal(MARKETPLACE_ALIASES.UK, 'A1F83G8C2ARO7P');
    assert.equal(MARKETPLACE_ALIASES.GB, 'A1F83G8C2ARO7P');
    assert.equal(MARKETPLACE_ALIASES.UK, MARKETPLACE_ALIASES.GB);
  });

  it('EU region — DE / FR / IT / ES', () => {
    assert.equal(MARKETPLACE_ALIASES.DE, 'A1PA6795UKMFR9');
    assert.equal(MARKETPLACE_ALIASES.FR, 'A13V1IB3VIYZZH');
    assert.equal(MARKETPLACE_ALIASES.IT, 'APJ6JRA9NG5V4');
    assert.equal(MARKETPLACE_ALIASES.ES, 'A1RKKUPIHCS9HS');
  });

  it('EU region — NL / SE / PL / TR (the Muldale-account markets)', () => {
    assert.equal(MARKETPLACE_ALIASES.NL, 'A1805IZSGTT6HS');
    assert.equal(MARKETPLACE_ALIASES.SE, 'A2NODRKZP88ZB9');
    assert.equal(MARKETPLACE_ALIASES.PL, 'A1C3SOZRARQ6R3');
    assert.equal(MARKETPLACE_ALIASES.TR, 'A33AVAJ2PDY3EV');
  });

  it('FE region — JP', () => {
    assert.equal(MARKETPLACE_ALIASES.JP, 'A1VC38T7YXB528');
  });

  it('has the expected 14 entries (regression guard against silent drops/adds)', () => {
    assert.equal(Object.keys(MARKETPLACE_ALIASES).length, 14);
  });
});

describe('resolveMarketplaceFilter', () => {
  it('returns null for empty / undefined / null', () => {
    assert.equal(resolveMarketplaceFilter(undefined), null);
    assert.equal(resolveMarketplaceFilter(null), null);
    assert.equal(resolveMarketplaceFilter(''), null);
  });

  it('maps single short-code to ID', () => {
    assert.deepEqual(resolveMarketplaceFilter('UK'), ['A1F83G8C2ARO7P']);
    assert.deepEqual(resolveMarketplaceFilter('US'), ['ATVPDKIKX0DER']);
  });

  it('parses comma-separated short-codes', () => {
    assert.deepEqual(resolveMarketplaceFilter('UK,DE,FR'), [
      'A1F83G8C2ARO7P', 'A1PA6795UKMFR9', 'A13V1IB3VIYZZH',
    ]);
  });

  it('is case-insensitive on short-codes', () => {
    assert.deepEqual(resolveMarketplaceFilter('uk,De,fr'), [
      'A1F83G8C2ARO7P', 'A1PA6795UKMFR9', 'A13V1IB3VIYZZH',
    ]);
  });

  it('passes raw marketplace IDs through unchanged', () => {
    // Useful when the operator already has the ID and wants to skip the
    // short-code mapping (or for marketplaces not yet in the alias table).
    assert.deepEqual(resolveMarketplaceFilter('ATVPDKIKX0DER'), ['ATVPDKIKX0DER']);
  });

  it('mixes short-codes and raw IDs', () => {
    assert.deepEqual(resolveMarketplaceFilter('UK,ATVPDKIKX0DER'), [
      'A1F83G8C2ARO7P', 'ATVPDKIKX0DER',
    ]);
  });

  it('passes unknown tokens through unchanged (caller catches via region validation)', () => {
    assert.deepEqual(resolveMarketplaceFilter('ZZ'), ['ZZ']);
  });

  it('tolerates whitespace around separators', () => {
    assert.deepEqual(resolveMarketplaceFilter(' UK , DE , FR '), [
      'A1F83G8C2ARO7P', 'A1PA6795UKMFR9', 'A13V1IB3VIYZZH',
    ]);
  });

  it('drops empty tokens (trailing commas, double-comma)', () => {
    assert.deepEqual(resolveMarketplaceFilter('UK,,DE,'), [
      'A1F83G8C2ARO7P', 'A1PA6795UKMFR9',
    ]);
  });
});
