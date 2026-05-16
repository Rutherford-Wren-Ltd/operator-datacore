// Amazon Ads API — GET /v2/profiles
//
// Returns one entry per advertiser account the authenticated user has access
// to, across all marketplaces in the region. The profileId is what every
// subsequent scoped request needs in the Amazon-Advertising-API-Scope header.

import type { AdsApiClient } from './client.js';

export interface AdsProfile {
  profileId: number;
  countryCode: string;
  currencyCode: string;
  dailyBudget?: number;
  timezone: string;
  accountInfo: {
    marketplaceStringId: string;
    id: string;
    type: 'seller' | 'vendor' | 'agency';
    name: string;
    validPaymentMethod?: boolean;
  };
}

export async function getProfiles(client: AdsApiClient): Promise<AdsProfile[]> {
  const res = await client.request<AdsProfile[]>({
    method: 'GET',
    path: '/v2/profiles',
  });
  return res.payload;
}
