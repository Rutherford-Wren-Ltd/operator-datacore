// Amazon Ads API regional endpoints.
//
// LWA auth always goes to https://api.amazon.com/auth/o2/token (shared with
// SP-API — getLwaAccessToken is reused from src/lib/sp-api/auth.ts).
// The regional endpoint below is the data plane for the Ads API itself.
//
// Reference: https://advertising.amazon.com/API/docs/en-us/info/api-overview

export const ADS_API_ENDPOINTS = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
} as const;

export type AdsApiRegion = keyof typeof ADS_API_ENDPOINTS;
