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

operator-datacore ships a CLI that does both halves of the flow for you: prints the authorisation URL, then exchanges the code for a refresh token. It reads Client ID + Secret from your `.env` so you never type them on the command line.

**Pre-check:** set `ADS_API_CLIENT_ID` and `ADS_API_CLIENT_SECRET` in your `.env` (Step 2 values). If you haven't run `operator-datacore` locally before, do `npm ci` first.

**3.1 — Print the authorisation URL**

```
npm run ads-exchange-code
```

This prints an `https://www.amazon.com/ap/oa?...` URL. Tips for the next two steps:

- **Sign out of advertising.amazon.com first** and sign in as the **specific seller account** you want to authorise (UK Emporium, US Emporium-cookshop, etc.). Amazon's session-stickiness can otherwise default to the wrong account and produce a token that probes against the wrong region. **An incognito / private browsing window is the safest way to guarantee account isolation.**
- The URL pre-encodes the right scope (`advertising::campaign_management`) and redirect URI (`http://localhost:3000/callback`).

**3.2 — Open the URL → Allow → copy the code**

Amazon redirects to `http://localhost:3000/callback?code=ANxxxxx&scope=...`. The browser will show **"This site can't be reached"** — that's expected, nothing's running on port 3000. **Copy the `code` value** out of the URL bar (between `code=` and `&scope=`).

**3.3 — Exchange the code for a refresh token**

```
npm run ads-exchange-code -- --code "ANxxxxx"
```

The output ends with:

```
Refresh token (paste into .env as ADS_API_REFRESH_TOKEN):

  Atzr|IwEBI...

Token issued. Valid for ~12 months.
```

Paste the `Atzr|...` value into `.env` as `ADS_API_REFRESH_TOKEN` (or `ADS_API_<REGION>_REFRESH_TOKEN` for multi-region setups — see below).

The authorisation code is **single-use and short-lived** (~5 minutes). If you wait too long, restart from 3.1.

**Multi-region note:** if you're adding NA as a second region alongside an existing EU setup, do Steps 3.1–3.3 again signed in as the US seller. The same LWA app produces a distinct refresh token per (seller, region). Paste the result into `.env` as `ADS_API_NA_REFRESH_TOKEN` (not `ADS_API_REFRESH_TOKEN`, which stays as the primary EU value).

**Fallback — raw curl (only if `npm run ads-exchange-code` isn't available):**

```
# 1. Build the auth URL by hand, click it in a browser, Allow, copy code.
# 2. Exchange:
curl -s -X POST https://api.amazon.com/auth/o2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=<CODE>" \
  -d "redirect_uri=http://localhost:3000/callback" \
  -d "client_id=<CLIENT_ID>" \
  -d "client_secret=<CLIENT_SECRET>"
```

The response JSON's `refresh_token` (starts with `Atzr|`) is what you want.

---

## Step 4 — Find your Profile ID

The Ads API uses **Profiles** — one per advertising account per marketplace. You need the Profile ID for the Wrenbury UK ads account.

With the refresh token from Step 3 in `.env`, run:

```
npm run ads-probe
```

(Or for a non-primary region: `npm run ads-probe -- --region NA` etc.)

The output lists every profile your token can see, one block per profile:

```
  profileId:    567327329024034
  account:      Emporium Cookshop & Homewares (seller)
  marketplace:  A1F83G8C2ARO7P
  country:      UK
  currency:     GBP
  timezone:     Europe/London
```

Find the one for the marketplace you care about (`UK` / `GBP` for Wrenbury UK; `US` / `USD` for US Emporium-cookshop; etc.). Capture the `profileId` (a long integer) and add it to `.env`:

- Primary region: `ADS_PROFILE_ID=...` (or `ADS_PROFILE_IDS=...,...` for multiple).
- Secondary region: `ADS_API_<REGION>_PROFILE_ID=...` (or `_PROFILE_IDS` plural).

Re-run `npm run ads-probe` and you should see `OK — profile ... matches "..."` at the end. That's the green light.

**Failure modes:**

- **Empty profile list / 403:** the Ads API access from Step 1 hasn't been granted yet — wait for the approval email and retry.
- **`invalid_grant`:** the refresh token in `.env` doesn't pair with the Client ID/Secret. Most common cause: pasted the SP-API refresh token into the Ads slot (or vice versa). Re-do Step 3.
- **Probe succeeds but lists profiles for the wrong region:** check `ADS_API_REGION` in `.env` (or pass `--region` explicitly). A primary-EU operator probing the US seller's token without `--region NA` will hit the EU endpoint and see EU profiles.

**Fallback — raw curl:**

```
curl -s https://advertising-api-eu.amazon.com/v2/profiles \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Amazon-Advertising-API-ClientId: <CLIENT_ID>"
```

(For NA use `advertising-api.amazon.com`; for FE use `advertising-api-fe.amazon.com`.)

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
