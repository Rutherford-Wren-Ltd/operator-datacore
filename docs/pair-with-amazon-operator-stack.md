# Pair operator-datacore with amazon-operator-stack

You now have **two complementary repos**:

| Repo | What it does |
|---|---|
| [`operator-datacore`](https://github.com/ShubhashSharma/operator-datacore) | The data layer. Five-schema Supabase database with daily Sales & Traffic mirror. |
| [`amazon-operator-stack`](https://github.com/ShubhashSharma/amazon-operator-stack) | The agent layer. MCP server connecting Claude Code to live SP-API. |

They work independently. They're far more valuable together.

---

## What pairing unlocks

| Without pairing | With pairing |
|---|---|
| Claude can call SP-API live (mcp-amazon) | Claude can call SP-API live AND query 24 months of historical data instantly |
| You can write SQL against `operator-datacore` (this repo) | Claude writes SQL against `operator-datacore` for you, in plain English |
| Two separate tools | One operator stack, one mental model |

---

## Setup (5 minutes)

### Step 1 — Add the Supabase MCP server to Claude Code

Claude Code talks to the data lake through Supabase's official hosted MCP server. There is
nothing to install and no key to store. You add one remote server and authenticate with your
Supabase login:

```
claude mcp add --transport http supabase \
  "https://mcp.supabase.com/mcp?project_ref=YOUR_PROJECT_REF&read_only=true" --scope user
```

Replace `YOUR_PROJECT_REF` with your Supabase project ref. It is the subdomain of your
project URL and also appears in the dashboard URL. It is not a secret.

The two query parameters matter:

- `read_only=true` runs every query as a read-only Postgres user. Keep it in the URL. It is
  the guardrail.
- `project_ref=...` scopes the connection to one project and disables account-level tools.

Then, inside Claude Code, run `/mcp`, select the `supabase` server, and complete the browser
login. Run `/mcp` again and it should show the server connected with a tool count.

Do not configure this with `SUPABASE_SERVICE_ROLE_KEY`. The service role key bypasses every
access control in the database. The hosted server with `read_only=true` plus your own login
is both simpler and safer, and it keeps no secret in a config file.

For a step-by-step macOS walkthrough aimed at a non-technical operator, see
[`docs/runbooks/connect-data-lake-macos.md`](runbooks/connect-data-lake-macos.md).

### Step 2 — Tell Claude what to do with it

Add this to the project's `CLAUDE.md` (or a new `~/.claude/CLAUDE.md` for global use):

```markdown
## Data lake
This operator runs operator-datacore on Supabase. When asked about historical
Amazon performance (revenue, units, sessions, ASIN-level data), prefer the
data lake (`brain.sales_traffic_daily`, `analytics.amazon_daily`,
`analytics.amazon_top_asins`) over live SP-API calls — it's faster and the
numbers match Seller Central exactly.

When asked about live state (current inventory, today's orders, latest
buy-box owner), use amazon-operator-stack to call SP-API directly.

The canonical metric ownership map is at meta.report_catalog. Never
reconstruct revenue from the Orders Report.
```

### Step 3 — Try a paired query

In Claude Code:

> "What were my top 10 ASINs by revenue last month, and which one has the lowest current inventory?"

Claude will:
1. Query `analytics.amazon_top_asins` from operator-datacore (historical revenue).
2. Call `getInventorySummaries` via amazon-operator-stack (live inventory).
3. Cross-reference the two and tell you which top earner is at risk.

That's a single question that previously needed two tools, two queries, and a spreadsheet.

---

## Recommended division of labour

| Question type | Use |
|---|---|
| "What did we sell last week?" | operator-datacore (historical, instant, exact match to Seller Central) |
| "What's currently in stock?" | amazon-operator-stack → live FBA Inventory |
| "Which ASIN has the highest CM3?" | operator-datacore (once COGS + ad spend are wired in via homework) |
| "What's the latest fulfilment status of order 111-XXXXXXX-XXXXXXX?" | amazon-operator-stack → live Orders API |
| "Where did our search query share drop the most last quarter?" | operator-datacore (Brand Analytics rollups, once SQP connector is active) |
| "Pull the buyer's shipping address for order X" | amazon-operator-stack → RDT-scoped Orders API call (not stored anywhere) |

---

## Why split the layers?

We could have shoved everything into one repo. We didn't, because:

1. **Data layer ages slowly.** A schema migration is a once-a-quarter event.
2. **Agent layer iterates fast.** New tools, new prompts, new model versions. We don't want the database changing every time we redeploy the agent.
3. **You can run them independently.** Run only the data layer if you just want a Supabase mirror. Run only the agent layer if you don't want to host a database. They cooperate but don't depend on each other.
4. **Different security postures.** The data layer holds your full historical data and never makes external calls (after sync). The agent layer makes live SP-API calls but holds nothing. Different threat models, different architectures.

This is the same split that BI tools (data warehouse + dashboard) and modern MLOps (feature store + model server) use. We didn't invent it. We're just applying it to operator workflows.
