# Connect Amazon Ads API

This runbook walks you through obtaining credentials for the **Amazon Ads API** so operator-datacore can ingest Sponsored Products, Sponsored Brands and Sponsored Display spend / sales data into `brain.ads_*_daily`. It is the gating step that unblocks the **TACoS** scoring dimension in `/sku-audit`.

The full official docs are at <https://advertising.amazon.com/API/docs/en-us/guides/onboarding/overview>. This runbook is the operator's happy path — clear what to click, what to expect at each step, what value to keep.

> **Important:** the Amazon Ads API uses **a different LWA Security Profile** from the one you already created for SP-API. Do not reuse the SP-API client ID / secret. The Ads API has its own auth scope and its own approval process. Plan for **1–3 business days of calendar lead time** on the application step.

---

## What you'll end up with

Five values that go into `.env` / GitHub Secrets:

```
ADS_API_CLIENT_ID=amzn1.application-oa2-client.xxxxxxxxxxxx
ADS_API_CLIENT_SECRET=amzn1.oa2-cs.v1.xxxxxxxxxxxx
ADS_API_REFRESH_TOKEN=Atzr|xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ADS_PROFILE_ID=1234567890123456
ADS_API_REGION=EU
```

The endpoint is derived from the region: `ADS_API_ENDPOINT=https://advertising-api-eu.amazon.com` (UK + EU). For NA accounts it's `advertising-api.amazon.com`; for FE it's `advertising-api-fe.amazon.com`.

---

## Step 1 — Apply for Amazon Ads API access (do this first, async)

The Ads API needs Amazon's explicit approval before the LWA scope works. This is the step with calendar lead time.

1. Sign in to **<https://advertising.amazon.com/>** with the account that runs Wrenbury's ads (same login as Seller Central in most cases — but the *Ads account* is a separate entity behind the same login).
2. Go to **<https://advertising.amazon.com/API/docs/en-us/guides/onboarding/overview>** and click through to **Sign up for API access** / **Apply**.
3. Fill in the application:
   - **Use case**: own-account analytics / reporting. Be plain and accurate. Do **not** describe it as a SaaS / multi-tenant product.
   - **Company name**: Rutherford Wren Ltd.
   - **Region**: EU (this is the region you'll receive a profile in — additional regions can be added later).
4. Submit. Approval typically lands by email within **1–3 business days**.

You do not need approval to do Steps 2–3 below, so kick those off in parallel.

---

## Step 2 — Create the LWA Security Profile for Ads

This is a **new** profile, separate from your existing SP-API one.

1. Go to **<https://developer.amazon.com/loginwithamazon/console/site/lwa/overview.html>** and sign in with the Amazon account that owns Wrenbury Seller Central / Ads.
2. Click **Create a New Security Profile**.
   - **Security profile name**: `RW-AI-OS Ads API` (anything memorable; this is for your reference).
   - **Description**: `Operator-datacore daily Ads API ingestion for Wrenbury` (or similar).
   - **Consent privacy notice URL**: any URL you control. A placeholder is fine for own-account use.
3. After saving, you'll see the new profile listed. Click into it. Capture:
   - **Client ID** → goes into `ADS_API_CLIENT_ID` (starts with `amzn1.application-oa2-client.`)
   - **Client Secret** → goes into `ADS_API_CLIENT_SECRET` (starts with `amzn1.oa2-cs.v1.`)
4. Click **Web Settings** on the profile and configure:
   - **Allowed Origins**: leave blank.
   - **Allowed Return URLs**: add `http://localhost:3000/callback`. This is what Amazon redirects to after authorisation. Localhost is fine for getting a refresh token even though no server is running there — you'll copy the code out of the URL bar manually in Step 3.

---

## Step 3 — Get a refresh token via the OAuth code flow

Wait until your Ads API application from Step 1 is approved before doing this — the scope won't work without approval.

1. Open this URL in a browser (replace `<CLIENT_ID>` with the value from Step 2):

   ```
   https://eu.account.amazon.com/ap/oa?client_id=<CLIENT_ID>&scope=advertising::campaign_management&response_type=code&redirect_uri=http://localhost:3000/callback
   ```

   (For NA accounts use `www.amazon.com` instead of `eu.account.amazon.com`.)

2. Sign in if prompted, then **Allow** the consent screen.

3. Amazon redirects to `http://localhost:3000/callback?code=ANxxxxx&scope=…`. Your browser will show **"Can't reach localhost"** — that's expected and harmless. **Copy the `code` value out of the URL bar.**

4. In a terminal, exchange the code for a refresh token. Replace the four placeholders:

   ```
   curl -s -X POST https://api.amazon.com/auth/o2/token \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d "grant_type=authorization_code" \
     -d "code=<CODE>" \
     -d "redirect_uri=http://localhost:3000/callback" \
     -d "client_id=<CLIENT_ID>" \
     -d "client_secret=<CLIENT_SECRET>"
   ```

   You'll get back JSON containing `access_token`, `refresh_token`, `token_type`, `expires_in`. Capture the **`refresh_token`** (starts with `Atzr|`). This is `ADS_API_REFRESH_TOKEN`. The access_token is short-lived (60 min); the client uses the refresh token to generate fresh access tokens automatically.

   The authorisation code is **single-use and short-lived** (~5 minutes). If you wait too long or get an error, repeat from Step 3.1.

---

## Step 4 — Find your Profile ID

The Ads API uses **Profiles** — one per advertising account per marketplace. You need the Profile ID for the Wrenbury UK ads account.

1. Use the access token from Step 3 (or do another quick token refresh — see "Refreshing access tokens" below) and call:

   ```
   curl -s https://advertising-api-eu.amazon.com/v2/profiles \
     -H "Authorization: Bearer <ACCESS_TOKEN>" \
     -H "Amazon-Advertising-API-ClientId: <CLIENT_ID>"
   ```

2. You'll get a JSON array of profiles. Find the one with `countryCode: "GB"` (or `countryCode: "UK"` on older accounts) and the right account name. Capture:
   - `profileId` → goes into `ADS_PROFILE_ID` (a long integer like `1234567890123456`)
   - `countryCode` → confirms `GB` / UK
   - `currencyCode` → should be `GBP`

If the response is an empty array `[]` or returns `403`, the Ads API access from Step 1 hasn't been granted yet — wait for the approval email and retry.

---

## Step 5 — Put the credentials in place

Once you have all four values, populate **two locations**:

1. **Local `.env`** (Chris's machine only — for ad-hoc CLI debugging):

   ```
   ADS_API_CLIENT_ID=amzn1.application-oa2-client.xxxxxxxx
   ADS_API_CLIENT_SECRET=amzn1.oa2-cs.v1.xxxxxxxx
   ADS_API_REFRESH_TOKEN=Atzr|xxxxxxxxxxxxxxxxx
   ADS_PROFILE_ID=1234567890123456
   ADS_API_REGION=EU
   ADS_API_ENDPOINT=https://advertising-api-eu.amazon.com
   ```

2. **GitHub Repository Secrets** on `Rutherford-Wren-Ltd/operator-datacore` (for the daily-sync workflow):

   ```
   gh secret set ADS_API_CLIENT_ID
   gh secret set ADS_API_CLIENT_SECRET
   gh secret set ADS_API_REFRESH_TOKEN
   gh secret set ADS_PROFILE_ID
   gh secret set ADS_API_REGION
   gh secret set ADS_API_ENDPOINT
   ```

   Same `gh secret set --body` pattern we used for the SP-API secrets — `gitleaks` blocks `.env` commits, and the GitHub Secrets store the values for the workflow.

---

## Refreshing access tokens

The Ads API uses short-lived access tokens (60 minutes). To get a new one from the refresh token:

```
curl -s -X POST https://api.amazon.com/auth/o2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "refresh_token=<REFRESH_TOKEN>" \
  -d "client_id=<CLIENT_ID>" \
  -d "client_secret=<CLIENT_SECRET>"
```

The operator-datacore Ads client (built in the code work that follows this onboarding) handles this automatically on every API call.

---

## Smoke test

Once everything is in place, a single curl confirms end-to-end connectivity. Get a fresh access token, then:

```
curl -s "https://advertising-api-eu.amazon.com/v2/sp/campaigns" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Amazon-Advertising-API-ClientId: <CLIENT_ID>" \
  -H "Amazon-Advertising-API-Scope: <ADS_PROFILE_ID>"
```

`200 OK` with a JSON array (possibly empty) is the green light. `401` means the access token expired (refresh and retry). `403` means the Ads API scope isn't granted for the profile yet (re-check Step 1).

---

## What unlocks next

Once the credentials are in place, the operator-datacore Ads ingestion code (separate work block; see Phase 1.7 in `implementation-plan.md`) wires Sponsored Products, Sponsored Brands and Sponsored Display reports into the daily-sync. From that point on:

- `/sku-audit` shows a real **TACoS** score (the fourth and final scoring dimension).
- `brain.ads_sp_daily / ads_sb_daily / ads_sd_daily` tables fill day-by-day.
- The brand brain can answer ad-efficiency questions per-SKU and per-campaign without leaving the Obsidian vault.

---

## Common gotchas

- **"The LwA client ID is not approved to use the requested scope"** — your Ads API application from Step 1 hasn't been approved yet. Wait for the email and retry.
- **Empty `/v2/profiles` response** — same root cause as above.
- **Browser redirects to `http://localhost:3000/callback` and says "Can't reach localhost"** — this is the *correct* behaviour; the code you need is in the browser's URL bar.
- **`invalid_grant` from the token exchange** — the code is single-use and short-lived (~5 minutes). Generate a fresh code (back to Step 3.1) and retry quickly.
- **Reusing the SP-API LWA client ID** — won't work. Ads API needs its own Security Profile with the Ads scope granted to it.
