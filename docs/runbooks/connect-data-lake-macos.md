# Runbook: connect a second operator to the data lake (Claude Code, macOS)

This guide connects your Claude Code to the shared Wrenbury data lake on Supabase so you can
ask questions about Amazon Sales and Traffic data in plain English. The connection is
**read-only and scoped to the Wrenbury project**.

It was written for Miia's Phase 1 onboarding and is the single source of truth for this
setup. The implementation plan and the progress tracker point here rather than repeating the
steps. The Windows variant for Chris's machine and a Cowork variant for Jo's later onboarding
both follow the same pattern with two small differences (noted at the end).

> **Why a personal access token rather than OAuth.** An earlier draft of this guide used
> Supabase's hosted MCP server with browser OAuth. In practice the OAuth handshake fails on
> Claude Code with `{"message":"resource: Resource must be a valid MCP endpoint"}` whenever
> the server URL carries a query string (which we need, for `read_only` and `project_ref`).
> The local stdio approach below sidesteps that entirely and is proven on both Mac and
> Windows. See `progress-tracker.md` and the `supabase_mcp_setup` memory for the full story.

## What you need, and what you do not

You need:
- Claude Code installed on your Mac, signed in.
- Your own Supabase login. As the project Owner you do not need anyone to invite you.
- A few minutes to create a Supabase personal access token.

You do **not** need:
- Any repo cloned. No `git clone`, no build.
- Any Amazon SP-API credentials. These never go on your machine. They live only with Chris
  and in GitHub Actions. Your connection reads from the data lake, which a scheduled job
  refreshes every day.

---

## A. Multi-factor authentication first

Do this before anything else.

1. **GitHub**: Settings, then Password and authentication, then enable two-factor.
2. **Supabase**: Account settings, then enable multi-factor authentication.
3. Save the recovery codes for both into the shared NordPass vault.

---

## B. Confirm Claude Code on macOS

Open Terminal and run:

```
claude --version
```

If that prints a version, you are set. If it does not, install Claude Code from the official
instructions, sign in, and run the check again.

---

## C. Project ref and personal access token

You need two pieces of information for the next step.

**1. The Wrenbury Supabase project ref.** It is:

```
mfqhxzhlqoaazupsyjab
```

It is not a secret. It is the subdomain of the project URL and is visible in the dashboard
URL `https://supabase.com/dashboard/project/mfqhxzhlqoaazupsyjab`. It is already filled into
the config in the next step.

**2. A personal access token (PAT) you create now.**

1. Go to `https://supabase.com/dashboard/account/tokens`.
2. Click **Generate new token**.
3. Name it `claude-code-<your-first-name>-mac-<YYYY-MM-DD>`, for example
   `claude-code-miia-mac-2026-05-14`. This makes future rotation unambiguous.
4. Set expiry to **90 days**. Diary a calendar note for a few days before the date so the
   next rotation can happen without breaking the running connection.
5. Click **Generate** and copy the token. It begins with `sbp_`. You will see it only once.
   Paste it somewhere safe for the next step (it is going into your local config in a
   moment).

**Important.** Treat the PAT like a password. It lives on disk on your Mac after the next
step (acceptable, see "Accepted risks" below). Never paste it into a repo, a shared chat, or
a screenshot.

---

## D. Add the supabase MCP to your Claude Code config

Open your Claude Code user config in VS Code (this is the same VS Code instance that runs the
Claude Code extension):

```
code ~/.claude.json
```

Find the top-level `mcpServers` key. If it does not exist, add it as a sibling of the other
top-level keys. Inside `mcpServers`, add a new entry called `supabase` with this exact shape
(replace `PASTE_YOUR_PAT_HERE` with the token you just generated):

```json
"supabase": {
  "type": "stdio",
  "command": "npx",
  "args": [
    "-y",
    "@supabase/mcp-server-supabase@latest",
    "--read-only",
    "--project-ref=mfqhxzhlqoaazupsyjab"
  ],
  "env": {
    "SUPABASE_ACCESS_TOKEN": "PASTE_YOUR_PAT_HERE"
  }
}
```

If `mcpServers` already contains other entries, add a comma after the last existing entry
before pasting the `supabase` block. The whole file must remain valid JSON. If VS Code shows
red squigglies after saving, you have a syntax slip (usually a missing or extra comma).

Save the file.

What each part does:
- `--read-only` makes every SQL query run as a read-only Postgres user. This is the guardrail
  that prevents writes from chat.
- `--project-ref=mfqhxzhlqoaazupsyjab` scopes the connection to the Wrenbury project only and
  removes account-level tools (`list_projects`, `pause_project`, and so on) from the surface.
- `SUPABASE_ACCESS_TOKEN` authenticates the server as you. With `--read-only` and the
  project ref both in force, the connection cannot reach any other project and cannot write
  to this one.

---

## E. Reload Claude Code

The stdio process for the new server only starts when Claude Code starts a fresh session.

Open the Command Palette (Cmd-Shift-P), type **Developer: Reload Window**, and press Enter.

When Claude Code opens again, run `/mcp`. The `supabase` server should appear and show as
**Connected**, with a tool count.

---

## F. Confirm it works

Three checks. Each tests a different thing. Run all three.

### F1. Connectivity

Ask Claude Code:

> Using the supabase MCP, query analytics.amazon_daily for the GB marketplace, last 5 days,
> and show me revenue and units.

You should get a small table of numbers. This proves the connection works. It does **not**
prove the numbers are correct (F3 does that).

### F2. Write-rejection

Ask Claude Code:

> Using the supabase MCP, run this SQL: CREATE TABLE _miia_write_test (id int);

This **must fail** with a permission or read-only error (the typical message is
`ERROR 25006: cannot execute CREATE TABLE in a read-only transaction`). That is the correct
result and proves `--read-only` is in force on your connection.

If it succeeds, stop and tell Chris. The read-only guardrail is not working. (If a table did
somehow get created, ask Claude to drop it: `DROP TABLE _miia_write_test;`.)

### F3. Correctness chain

Do this with Chris once so the numbers line up to a shared window.

Chris will give you a recent date window and the revenue and units he reads from the source
table `brain.sales_traffic_daily` for it. You then ask Claude Code:

> Using the supabase MCP, query analytics.amazon_daily for GB, sum revenue_native and
> units_ordered between <from date> and <to date>.

Your number should match Chris's number for the same window, and Chris compares both to
Seller Central. Three independent points agreeing tests the connection, the rollup, and the
actual data at once.

As an illustration, for the window 2026-05-12 to 2026-05-13 the total is revenue 4,914.80 GBP
and 220 units. Amazon restates the most recent two or three days, so the live figure for a
very recent window can shift slightly. Use the window and figure Chris gives you on the day,
not this example.

### Credential smoke check

Run this in Terminal:

```
grep -rIn "REFRESH_TOKEN" ~/ 2>/dev/null
```

It should find nothing. This is a quick smoke check, not proof. The real assurance is
architectural: the setup above never issues you any Amazon SP-API credentials, so there is
nothing to find.

---

## G. Troubleshooting and rollback

**`supabase` shows as Failed or disappears from `/mcp` after the reload.** Most often a JSON
syntax error in `~/.claude.json`. Open it in VS Code and look for the red squigglies, fix,
save, reload again. A backup is created automatically the first time Claude Code rewrote it
(`~/.claude.json.bak.*`).

**`supabase` shows as Connected but tools error out.** Likely an invalid or expired PAT. Open
the Supabase tokens page, check whether your token is still listed and not expired. If it is
gone, create a new one and replace the value in `~/.claude.json`
`mcpServers.supabase.env.SUPABASE_ACCESS_TOKEN`. Reload.

**Remove the server and start clean.** Two commands in Terminal:

```
claude mcp remove supabase
```

then re-do section D from scratch.

**`npx` cannot find the package.** First run usually downloads it. If your Mac blocks the
download (corporate proxy, offline), Claude Code will time out on the MCP start. Confirm
`npx -y @supabase/mcp-server-supabase@latest --help` runs cleanly in Terminal before
re-adding the server.

**You do not need to clone any repo for this guide.** If you later clone RW-AI-OS for code
work, keep the clone out of iCloud Drive. Use `~/code` or `~/projects`. iCloud creates
duplicate folders that break Node builds.

---

## Accepted risks (be aware)

Honest framing, kept short.

- **`--read-only` is a CLI flag, not a database role.** Server-side Supabase runs your
  connection as a read-only Postgres user once the flag is set, so it is a real guardrail
  while it is there. But if you ever edit `args` and drop the flag the connection regains
  write access. The F2 write-rejection test exists for exactly this reason and should be
  re-run any time the config is touched.
- **The PAT lives plaintext in `~/.claude.json`.** Acceptable for your own laptop, never
  committed to any repo. Mitigated by 90-day expiry, the rotation flow, and the ability to
  revoke from the Supabase tokens page at any time.

---

## Rotation flow (every ~90 days, before the PAT expires)

1. Create a new PAT at `https://supabase.com/dashboard/account/tokens` with a fresh date in
   the name.
2. Open `~/.claude.json` in VS Code, replace the value in
   `mcpServers.supabase.env.SUPABASE_ACCESS_TOKEN` with the new token. Save.
3. Reload Claude Code (Command Palette → Developer: Reload Window).
4. Prove the new token works by running F1 again (or asking any data-lake question).
5. **Only then** go back to the tokens page and revoke the old token. If you revoke before
   step 4 and the new token was mistyped, you have no recovery path short of generating yet
   another one.

---

## Platform notes (for reference)

- **Windows (Chris):** identical pattern but the `command` and `args` need a `cmd /c` npx
  wrapper because Git Bash mangles `/c` paths. The shape is
  `"command": "cmd", "args": ["/c", "npx", "-y", "@supabase/mcp-server-supabase@latest", "--read-only", "--project-ref=mfqhxzhlqoaazupsyjab"]`.
- **Cowork / Claude Desktop (planned for Jo):** the config file is
  `claude_desktop_config.json`, not `~/.claude.json`. The same `supabase` entry shape
  applies. Jo is not a Supabase Owner, so Miia invites her into the project first; Jo
  generates her own PAT once she has access.

---

## Appendix: before your first code commit

You do **not** need any of this for the data-lake connection or for Phase 1 testing. It is
only for when you start code-role work, meaning editing the repos and committing changes.

- `brew install gitleaks gh`
- Clone the monorepo outside iCloud:
  `git clone --recurse-submodules <RW-AI-OS repo URL> ~/code/RW-AI-OS`
- Set up the global pre-commit hook so secrets cannot be committed. Chris will share the
  exact hook script. The one-time config is `git config --global core.hooksPath ~/.githooks`.
- `gh auth login`

Until then, sections A through F are everything you need.
