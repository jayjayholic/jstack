# jay-claude-switcher: every Claude account in one side panel, auto-switch at 99.9%

A Claude Code plugin that puts a panel next to the chat with every Claude account you own, how much of its 5-hour and weekly limit is gone, and a switch that moves your running session to the least-used account the moment the current one hits 99.9%. No restart, no `/login`, no lost turn.

```text
/plugin install jay-claude-switcher --marketplace jayjayholic/jstack
```

(Older Claude Code: `/plugin marketplace add jayjayholic/jstack`, then `/plugin install jay-claude-switcher@jstack`.) Then `/reload-plugins`.

## Why I made this

I run 10 to 13 agents at once on one 32 GB laptop. The laptop survives that now (see the rest of [jstack](../../README.md)). The rate limits don't. At 3 a.m. one account hits its 5-hour wall, half the agents die mid-task, and I'm logging in and out by hand while the other half wait. Swapping accounts by hand costs more than the limit itself.

So the plugin watches the numbers and swaps the login file for me, a beat before the wall. The agents never notice. The laptop fan still does.

## What it does

The panel has two tabs. `/switcher` opens it.

**Work**: your current account's limit bars with a burn-rate forecast, the subagents running right now (name, time, tokens), the tool calls in flight, the task list, and the context window broken down like `/context`.

**Sessions**: one row per stored account, `(5x) you@example.com`, with a bar for the 5-hour window and one for the weekly window, each with percent used and reset time. The current account is in bold.

- **Sorted by nearest reset.** An account full for the week waits for its weekly reset; any other sorts by its 5-hour reset (nothing pending goes first). So the top row is always the next one you can actually use.
- **Use** on a row switches to it.
- **Refresh** reads the usage of every account now.
- **Auto-switch 99.9%** toggles the automatic switch (on by default, remembered across sessions).
- `/switcher-accounts` reads every account and prints the list as text.

### How the switch works

A switch is a file swap. It does what `switch.py use` does:

1. The live login is saved back into the store (it may have refreshed its token since you stored it).
2. `.credentials.json` is copied to `logins/backups/credentials.<time>.json`.
3. The chosen account's `claudeAiOauth` goes into `.credentials.json` (every other key, like `mcpOAuth`, is kept) and its `oauthAccount` into `.claude.json`.

Every write is a temp file plus a rename, so nothing ever reads half a file.

**A running session picks it up on its next request.** Tested on Claude Code 2.1.308 (Windows): a session whose `.credentials.json` was replaced mid-run used the new file on its very next message. Claude Code compares the file's modified time before each request and drops its cached login when it changed. The email `/status` shows comes from `.claude.json`, which is cached in memory, so `/status` can show the old email until a restart. Ignore it, the requests go out as the new account.

### When it reads usage (gently, the endpoint bites)

The usage endpoint answers 429 if you poke it too often, so the plugin barely pokes it:

- **Below 98%: zero calls.** The current account's bars come from the rate-limit numbers Claude Code already gets on every request. Free.
- **From 98%:** the current account's usage is read at most once a minute.
- **At 99.9%, switch due:** the other accounts are read once (not again within 5 minutes) to pick the target.
- **Refresh** and `/switcher-accounts` read everything, because you asked.
- **A failed read is never retried in a loop.** A 429 waits for its `Retry-After`; without one it waits 5 minutes, then 10, 20, capped at 30. Not even **Refresh** skips the wait.

A check runs every second on the cached numbers and switches with no click. After a switch it waits 90 s before another.

### How it picks the target

- Only the **binding** windows count: the 5-hour window and the all-models weekly window (`session` and `weekly_all` in the API). Those are the ones that stop you.
- **Scoped weekly windows** (one model only, like weekly Opus) are ignored. They limit one model, not the account.
- **Accounts with no weekly limit** (some team organizations) are judged on the 5-hour window alone.
- The switch fires when the current account is at 99.9% or more on a binding window, and goes to the account with the lowest peak below 99.9% (tie: lowest 5-hour). If every account is full, it stays put and doesn't thrash.
- A window whose reset time has passed counts as empty, even from an old reading.

## Install and first account, step by step

You need Claude Code 2.1.275 or later, and Python 3 for the `switch.py` command line (the panel itself needs nothing).

1. **Install** with the line at the top, then `/reload-plugins`. The panel opens on the right by itself when the terminal is wide enough (about 144 columns); `/switcher` opens it in any width.
2. **Your current login is stored automatically.** The first time the Sessions tab is drawn it creates `~/.claude/logins/accounts.json` and adds the account you're logged in with. Press **Refresh** to see its bars.
3. **Add the second account without logging out.** Easiest: tell Claude "add another account to the switcher". The plugin's `add-account` skill walks it. By hand:
   - Open a second Claude Code with its own config folder:
     - macOS / Linux: `CLAUDE_CONFIG_DIR=~/.claude-login claude`
     - Windows: `powershell -ExecutionPolicy Bypass -File <plugin>/scripts/login-window.ps1` (inline quoting in `Start-Process` breaks, so it's a script).
   - Run `/login` there and pick the other account (and organization).
   - **Wait about 10 seconds.** `.credentials.json` lands first; `.claude.json` with the email arrives a few seconds later.
   - `python switch.py import ~/.claude-login`. It prints the email and organization. Check they're the ones you meant.
   - **Only now** close that window and delete `~/.claude-login`. Delete it before the import and the login is gone; leave it signed in and the two copies fight over one refresh token.
4. Repeat 3 for every other account. Press **Refresh**. Done. Go to sleep.

Where's `switch.py`? In the plugin folder under `scripts/`. Claude can find it for you, or grab a copy:

```bash
mkdir -p ~/.claude/logins
curl -o ~/.claude/logins/switch.py https://raw.githubusercontent.com/jayjayholic/jstack/main/plugins/jay-claude-switcher/scripts/switch.py
```

## Commands

```text
python switch.py save            store the current login (adds it, or updates it)
python switch.py list            stored accounts, no tokens; * marks the current one
python switch.py use <n|email>   save the current login back, then switch (n from `list`)
python switch.py next            rotate to the next stored account
python switch.py import <dir>    store the login of another config folder (default ~/.claude-login)
```

Accounts are keyed by `email#organizationUuid`, because one email can belong to several organizations, each with its own plan and its own limits. Same email, two orgs: two rows. Importing the same pair again just refreshes it.

Paths follow Claude Code: `CLAUDE_CONFIG_DIR` when set, else `~/.claude/.credentials.json` and `~/.claude.json`. The store lives at `<config>/logins/accounts.json`. The panel and `switch.py` read and write the same files, so mix them freely.

## Safety

- **The store holds tokens.** It's written owner-only (`chmod 600` on macOS and Linux; on Windows it sits in your profile folder, which only your user can read). Same for the backups in `logins/backups/`. Delete old backups whenever you like.
- **Nothing leaves your machine** except calls to Anthropic's own endpoints: `GET https://api.anthropic.com/api/oauth/usage` (the one `/usage` uses) and, for a stored account whose token expired, `POST https://platform.claude.com/v1/oauth/token` (the refresh Claude Code itself does). A refresh rotates the refresh token, so the new pair is written back to the store at once.
- **The live login is never refreshed by the plugin.** It belongs to the running Claude Code. If its token is expired, the panel shows the session's own rate-limit numbers instead.
- **Tokens are never shown, logged or put in the panel's state.** Errors show only an HTTP status. `switch.py` never prints them either.
- Never commit `accounts.json`, `.credentials.json` or `.claude.json`. The plugin never copies them anywhere.

## FAQ

**Is this allowed?** It only switches between accounts you're logged into yourself, using the same files and endpoints Claude Code uses. Check your plan's terms for how many accounts you may hold; this plugin doesn't create any.

**Do I need to restart after a switch?** No. The next request uses the new account. `/status` may show the old email until a restart; that's cosmetic.

**macOS?** UNVERIFIED. Claude Code keeps macOS logins in the Keychain, not in `.credentials.json`, so the file swap probably does nothing there. Tested on Windows. Linux should behave like Windows (same file), but nobody has run it yet. PRs with a test run welcome.

**One account says "usage API busy (429)".** The endpoint is rate-limited. The plugin waits as the server asked and tries again later on its own. Don't mash Refresh, it won't help (it also won't hurt, it respects the wait).

**An account says "login expired: sign in again and import it".** Its refresh token died (usually because the same account was used in another folder and refreshed there). Do step 3 again for it.

**Why 99.9% and not 100%?** At 100% the request that hits the wall already failed. 99.9% switches one request early.

**Does it work with one account?** It shows your bars and forecast and never switches. Which is also what my laptop does with one agent: nothing exciting.

**Why "jay"?** Because "claude-switcher" alone sounds like something Anthropic shipped. They didn't. I did, at 3 a.m., on a 32 GB laptop.

## Tests

`claude plugin test .` covers picking the least-used account, the 99.9% trigger, not switching when every account is full, accounts with no weekly window, the gentle read schedule (no reads below 98%, Retry-After, the 5 to 30 minute backoff), the token refresh write-back, the switch writes (backup, `mcpOAuth` kept, no write when the login changed elsewhere), `CLAUDE_CONFIG_DIR`, the first-run store, the import, and the tab drawn on every surface.
