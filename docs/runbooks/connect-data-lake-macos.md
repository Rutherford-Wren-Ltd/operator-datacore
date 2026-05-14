# Runbook: connect a second operator to the data lake (Claude Code, macOS)

This guide connects your Claude Code to the shared Wrenbury data lake on Supabase, so you
can ask questions about Amazon Sales and Traffic data in plain English. It is read-only.

It was written first for Miia's Phase 1 onboarding. It is the single source of truth for
this setup. The plan and the progress tracker point here rather than repeating the steps.

## What you need, and what you do not

You need:
- Claude Code installed on your Mac, signed in.
- Your own Supabase login. You are the project Owner, so you do not need anyone to invite you.

You do **not** need:
- Any repo cloned. No `git clone`, no build, no `.env` file.
- Any Amazon SP-API credentials. These are never placed on your machine. They live only with
  Chris and in GitHub Actions. Your connection reads from the data lake, which a scheduled
  job refreshes every day.

The whole setup is two commands and a browser login. It takes about five minutes.

---

## A. Multi-factor authentication first

Do this before anything else, even if you are short on time.

1. **GitHub**: Settings, then Password and authentication, then enable Two-factor authentication.
2. **Supabase**: Account settings, then enable multi-factor authentication.
3. Save the recovery codes for both into the shared NordPass vault.

---

## B. Confirm Claude Code on macOS

Open Terminal and run:

```
claude --version
```

If that prints a version, you are set. If it does not, install Claude Code from the official
instructions and sign in, then run the check again.

---

## C. Get the Supabase project ref

The project ref for the Wrenbury project is:

```
mfqhxzhlqoaazupsyjab
```

It is not a secret. It appears in the Supabase dashboard URL
(`https://supabase.com/dashboard/project/mfqhxzhlqoaazupsyjab`) and in the project's API
settings. It is already filled into the command in the next step, so you do not need to look
it up. It is shown here only so you know what it is.

---

## D. Add the Supabase MCP server

Run this exact command in Terminal. Copy it from here. Do not retype it from memory.

```
claude mcp add --transport http supabase \
  "https://mcp.supabase.com/mcp?project_ref=mfqhxzhlqoaazupsyjab&read_only=true" --scope user
```

What each part does:
- `--transport http` points Claude Code at Supabase's hosted MCP server. Nothing runs on your
  Mac, and Supabase keeps the server updated.
- `--scope user` makes the connection available in all your Claude Code projects, not just one
  folder.
- `read_only=true` makes every query run as a read-only database user. This is the guardrail.
  It must always be in the URL.
- `project_ref=mfqhxzhlqoaazupsyjab` limits the connection to the Wrenbury project only.

**Important.** Always use this exact command. If you ever need to add the server again, copy
it from this runbook. Never type it without `read_only=true`. If the flag is missing, the
connection would have write access, because you log in as the project Owner.

---

## E. Authenticate

1. Open Claude Code.
2. Run the command:

   ```
   /mcp
   ```

3. Select the `supabase` server and follow the prompt to authenticate. A browser window opens.
4. Log in to Supabase with your own account and approve the request.
5. Back in Claude Code, run `/mcp` again. The `supabase` server should show as connected, with
   a tool count next to it.

If the browser does not open on its own, Claude Code prints a URL. Copy it into a browser
manually. If the redirect back to Claude Code fails, copy the full callback URL from the
browser address bar and paste it into the prompt Claude Code shows.

---

## F. Confirm it works

Three checks. Each one tests a different thing. Run all three.

### F1. Connectivity

Ask Claude Code:

> Using the supabase MCP, query analytics.amazon_daily for the GB marketplace, last 5 days,
> and show me revenue and units.

You should get a small table of numbers back. This proves the connection works. It does **not**
prove the numbers are correct. That is F3.

### F2. Write-rejection

Ask Claude Code:

> Using the supabase MCP, run this SQL: CREATE TABLE _miia_write_test (id int);

This **must fail** with a permission or read-only error. That is the correct result. It proves
`read_only=true` is in force on your connection.

If it succeeds, **stop and tell Chris immediately**. The read-only guardrail is not working.
(If a table did get created, ask Claude to drop it: `DROP TABLE _miia_write_test;`.)

### F3. Correctness chain

Do this step with Chris, once, so the numbers line up to a shared window.

Chris will give you a recent date window and the revenue and units he reads from the source
table `brain.sales_traffic_daily` for it. You then ask Claude Code:

> Using the supabase MCP, query analytics.amazon_daily for GB, sum revenue_native and
> units_ordered between <from date> and <to date>.

Your number should match Chris's number for the same window, and Chris compares both to
Seller Central. Three independent points agreeing tests the connection, the daily rollup, and
the actual data at once.

As an illustration, for the window 2026-05-12 to 2026-05-13 the expected total is revenue
4,914.80 GBP and 220 units. Amazon restates the most recent two or three days, so the live
figure for a very recent window can shift slightly. Use the window and figure Chris gives you
on the day, not this example.

### Credential smoke check

Run this in Terminal:

```
grep -rIn "REFRESH_TOKEN" ~/ 2>/dev/null
```

It should find nothing. This is a quick smoke check, not proof. The real assurance is that the
setup above never issues you any Amazon SP-API credentials, so there is nothing to find.

---

## G. Troubleshooting and rollback

**The `supabase` server shows connected but tools do not work, or the OAuth flow only half
completed.** Remove it and start clean:

```
claude mcp remove supabase
```

Then run the add command from section D again.

**`/mcp` shows the server as failed or pending.** Claude Code retries automatically with a
short backoff. If it stays failed, remove and re-add as above.

**You do not need to clone any repo for this guide.** If you later clone RW-AI-OS for code
work, keep the clone out of iCloud Drive. Use a path like `~/code` or `~/projects`. iCloud
creates duplicate folders that break Node builds.

---

## Appendix: before your first code commit

You do **not** need any of this for the data-lake connection or for Phase 1 testing. This is
only for when you start code-role work, meaning editing the repos and committing changes.

- `brew install gitleaks gh`
- Clone the monorepo outside iCloud:
  `git clone --recurse-submodules <RW-AI-OS repo URL> ~/code/RW-AI-OS`
- Set up the global pre-commit hook so secrets cannot be committed. Chris will share the exact
  hook script. The one-time config is `git config --global core.hooksPath ~/.githooks`.
- `gh auth login`

Until then, the connection from sections A to F is everything you need.
