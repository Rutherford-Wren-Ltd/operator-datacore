// ============================================================================
// marketplaces.ts
// Single source of truth for the Amazon marketplace short-code → marketplace-id
// lookup the CLIs use to parse --marketplaces flags. Previously duplicated in 5
// places (backfill / backfill-search-query / diagnose-sqp / ingest-finances /
// ingest-orders), with one of them (diagnose-sqp) carrying a stripped-down
// 3-entry subset that drifted from the others.
//
// Reference: Amazon SP-API marketplace IDs.
//   https://developer-docs.amazon.com/sp-api/docs/marketplace-ids
// Add entries as RW expands into new marketplaces. The CLI flags accept either
// the short-code (UK, US, DE...) or the raw marketplace-id; resolveMarketplaceFilter
// passes raw IDs through unchanged.
// ============================================================================

export const MARKETPLACE_ALIASES: Record<string, string> = {
  // North America (NA region)
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  // Europe (EU region)
  UK: 'A1F83G8C2ARO7P',
  GB: 'A1F83G8C2ARO7P',   // alias for UK
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  IT: 'APJ6JRA9NG5V4',
  ES: 'A1RKKUPIHCS9HS',
  NL: 'A1805IZSGTT6HS',
  SE: 'A2NODRKZP88ZB9',
  PL: 'A1C3SOZRARQ6R3',
  TR: 'A33AVAJ2PDY3EV',
  // Far East (FE region)
  JP: 'A1VC38T7YXB528',
};

/**
 * Parse a --marketplaces flag value into a list of marketplace IDs.
 * Accepts comma-separated short-codes ("UK,DE,FR"), raw IDs
 * ("ATVPDKIKX0DER"), or a mix. Whitespace tolerated; case-insensitive on the
 * short-code lookup; unknown tokens pass through unchanged so the caller's
 * region validation can produce a useful error.
 *
 * Returns null when the input is empty/undefined — callers interpret that as
 * "no filter, use the region default".
 */
export function resolveMarketplaceFilter(raw: string | undefined | null): string[] | null {
  if (!raw) return null;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((tok) => {
    const upper = tok.toUpperCase();
    return MARKETPLACE_ALIASES[upper] ?? tok;
  });
}

// Amazon "sales-channel" (a domain string like "Amazon.co.uk") → marketplace id.
// The GET_FLAT_FILE_ALL_ORDERS report is ACCOUNT-WIDE — a request scoped to one
// marketplace still returns every marketplace's orders, each carrying its true
// domain in the sales-channel column. Use this to stamp the real marketplace_id
// per row instead of the requested one. Keyed lowercase for case-insensitivity.
export const SALES_CHANNEL_TO_MARKETPLACE: Record<string, string> = {
  'amazon.com': 'ATVPDKIKX0DER',
  'amazon.ca': 'A2EUQ1WTGCTBG2',
  'amazon.com.mx': 'A1AM78C64UM0Y8',
  'amazon.co.uk': 'A1F83G8C2ARO7P',
  'amazon.de': 'A1PA6795UKMFR9',
  'amazon.fr': 'A13V1IB3VIYZZH',
  'amazon.it': 'APJ6JRA9NG5V4',
  'amazon.es': 'A1RKKUPIHCS9HS',
  'amazon.nl': 'A1805IZSGTT6HS',
  'amazon.se': 'A2NODRKZP88ZB9',
  'amazon.pl': 'A1C3SOZRARQ6R3',
  'amazon.com.be': 'AMEN7PMS3EDWL',
  'amazon.ie': 'A28R8C7NBKEWEA',
  'amazon.com.tr': 'A33AVAJ2PDY3EV',
  'amazon.co.jp': 'A1VC38T7YXB528',
};

/**
 * Resolve the true marketplace id from an order's sales-channel domain.
 * Returns null for non-Amazon channels ("Non-Amazon", "Non-Amazon UK") or any
 * unmapped domain — callers should fall back to the requested marketplace id.
 */
export function salesChannelToMarketplaceId(channel: string | null | undefined): string | null {
  if (!channel) return null;
  return SALES_CHANNEL_TO_MARKETPLACE[channel.trim().toLowerCase()] ?? null;
}
