# Import FBA fulfilment fees

`import-fba-fees` pulls the per-unit FBA fulfilment fee for every catalogue ASIN from
Amazon (SP-API `getMyFeesEstimates`) and writes it to `brain.sku_master.fba_fee`.

`fba_fee` is the figure that closes the **CM3 calculation** — the restock engine's margin
gate uses real contribution margin once `fba_fee` is populated, instead of the
gross-margin proxy.

---

## The 30-second version

```bash
npm run import-fba-fees -- --dry-run    # hit the API, show fees, no DB write
npm run import-fba-fees                 # write fba_fee to brain.sku_master
```

Run it for the UK marketplace (the default) — RW's COGS currency is GBP, so the UK fee is
the right reference. Re-run whenever Amazon changes its FBA fee schedule (typically once
or twice a year, and around the Q4 peak-fee period).

---

## What it does

1. Reads every distinct ASIN from `brain.sku_master`.
2. Calls SP-API `getMyFeesEstimates` in batches of 20 (~1 request/second).
3. Extracts the `FBAFees` line — the per-unit FBA fulfilment fee — from each estimate.
4. Writes it to `brain.sku_master.fba_fee` (and so into `brain.sku_effective_terms`,
   which the restock engine and `/sku-audit` read).

The listing price sent to the API is **nominal** — the FBA fulfilment fee is based on
size and weight, not price, so only the price-independent `FBAFees` component is read.

---

## Flags

| Flag | Default | Effect |
|---|---|---|
| `--marketplace <id>` | `A1F83G8C2ARO7P` (UK) | Which marketplace's fee schedule to pull. |
| `--dry-run` | off | Call the API and print the fees, but do not write to the database. |

---

## First run — the SP-API role

The Product Fees API needs the **Pricing** role on the SP-API app. If the role is not
granted, the run stops with:

```
SP-API 403 — the Product Fees API role is not granted to this app.
```

Grant it: Seller Central → **Apps & Services → Develop Apps** → the operator-datacore
app → edit → add the **Pricing** role → re-authorise the app. Then re-run. A `400`
(not `403`) means the role *is* granted and a parameter is wrong — that is a code bug,
not a permissions issue.

---

## Relationship with the masters CSV

`fba_fee` is also a column in `sku-master.csv`. As a one-time bootstrap you can fill it
by hand from Seller Central's FBA fee estimate (the **Fee Preview** report) and re-run
`import-masters`.

`import-masters` no longer overwrites a non-NULL `fba_fee` with a blank CSV cell — it
`COALESCE`s — so this CLI and a manual CSV value coexist: whichever wrote last with a
real value wins, and a blank CSV column never wipes an API-sourced fee. Once
`import-fba-fees` is the routine source, leave the CSV `fba_fee` column blank.

---

## Verifying

After a run:

```sql
SELECT count(*) FILTER (WHERE fba_fee IS NOT NULL) AS priced,
       count(*)                                    AS total
FROM brain.sku_master;
```

Spot-check a couple of `fba_fee` values against the FBA fee shown for that SKU in Seller
Central → Manage FBA Inventory. They are estimates and will be close, not exact.

Failures (an ASIN with no estimate, or no `FBAFees` line) are logged to `meta.sync_log`
as `warn` rows against the run's `sync_run_id` — they do not abort the run. A failure
reading "There is an internal service failure" is Amazon-side and usually transient —
re-run the CLI to pick most of them up (it is idempotent: it re-estimates every ASIN and
overwrites `fba_fee`).
