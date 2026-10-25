# jay-claude-switcher: every Claude account in one side panel, auto-switch at 99%

A Claude Code plugin that puts a panel next to the chat with every Claude account you own, how much of its 5-hour and weekly limit is gone, and a switch that moves your running session to the least-used account the moment the current one hits 99%, or the moment Claude Code gets refused for the limit, whichever comes first. No restart, no `/login`, no lost turn.

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
- **Auto-switch 99%** toggles the automatic switch (on by default, remembered across sessions).
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

- **At session start:** every account once, so the balancer knows each one's windows and whether a weekly limit applies.
- **The current account:** the rate-limit numbers Claude Code already gets with every response (main loop, subagents, workflow agents), read again every second. Free.
- **The others:** every 10 minutes, and at once after one of their windows resets (the wake-up).
- **From 95%:** the current account's usage is also read every 5 seconds, and the other accounts once per 5 minutes, so the switch target is already known when 99% arrives.
- **A usage answer never lowers the session's own number** for the same window. Usage within a window only goes up, and the endpoint's answer can lag the live headers; the higher one wins.
- **At 99%, switch due:** the switch goes out on the readings in hand. It does not wait for any read. Only when no account has a reading below 99% are the others read, for 4 seconds at most.
- **Refresh** and `/switcher-accounts` read everything, because you asked.
- **A failed read is never retried in a loop.** A 429 waits for its `Retry-After`; without one it waits 5 minutes, then 10, 20, capped at 30. Not even **Refresh** skips the wait.

A check runs every second on the session's own numbers and switches with no click, within a second of a bar reaching 99%. After a switch it waits 90 s before another, and for 10 minutes a reading that still carries only the old account's windows (requests sent before the switch) is not laid over the new account.

### The trace

Every reading, decision and switch is one timestamped line in `switch-trace.log`, next to the store (`~/.claude/logins/`), last 400 lines kept:

```
2026-10-24T20:00:08.120Z reading five_hour=99
2026-10-24T20:00:08.121Z decide account=a@example.com peak=99 threshold=99 due=true
2026-10-24T20:00:08.390Z switch from=a@example.com to=b@example.com reason="a@example.com (max 20x) at 99% (5h)" switched=true took=269ms
```

Emails, percents and reasons only, never a token. When a session still hits the wall, the trace says whether 99% was ever read, when, and what the switch did about it.

### Load balancer: which account, and when to swap

The switcher spends the cheap accounts first and keeps the big ones for when nothing else is left.

**What it knows about each account.** When the session starts it reads the usage of every stored account once (skipping any that is backing off after a failure): the 5-hour %, its reset, the weekly %, its reset, and whether a weekly limit applies at all. The usage endpoint lists only the meters that apply to the account (`limits[]`; Claude Code's own schema describes it as "which meters apply ... are the server's"). So an answer with **no `weekly_all` row** (or, in the older shape, `seven_day: null`) means **no weekly limit**. A `weekly_all` row at 0% is a weekly limit with all its room left. The session's rate-limit headers never decide this: only a usage answer does. The plan size comes from the stored credentials' `rateLimitTier` (`default_claude_max_5x` is 5, `default_claude_max_20x` is 20, a Pro tier counts as 1).

**Priority, best first:**

1. Accounts with no weekly limit, smallest plan first.
2. Weekly-limited accounts, smallest plan first (a 5x before a 20x).
3. Inside one class: for weekly-limited accounts, the most weekly headroom wins, then the soonest weekly reset; otherwise the lowest 5-hour %, then the soonest 5-hour reset; then the store's order.

An account never read counts as weekly-limited until a read says otherwise. An account is **free** while its 5-hour window is under 98% and its weekly window under 99% (a window whose reset time has passed counts as empty).

**Override.** `priority.json` next to the store (`~/.claude/logins/priority.json`): `{ "order": ["email", "email#organizationUuid", ...] }`, best first. Listed accounts outrank every unlisted one, in the listed order; the rest follow the rule above.

**When it swaps. Exactly two triggers, nothing else:**

- **(a) A better account frees up.** A free account in a strictly better class than the current one: swap to it at once, even mid-use (on a 20x and a 5x frees up; on a weekly 5x and one with no weekly limit frees up). If its reading is older than a minute it is read once first to confirm. Not within 15 s of another switch.
- **(b) The current account runs out.** Its 5-hour or weekly bar shows 99% (the 1 s check on the session's own numbers), or a request is refused for the limit (429): swap to the best free account by the priority above. With none free, it falls back to the account with the lowest reading below 99%, and failing that one never read.

There is no rebalancing. It never swaps because another account in the same class has more room, nor to a bigger plan while the current one is fine.

**Wake-ups.** Each account's 5-hour and weekly reset is a wake-up. At the reset its window counts as empty from the cached reading, so trigger (a) fires on the next 1 s check, and the account is read again to confirm. The panel shows the next wake-up (the soonest reset of an account that is not free) and, under the list, why the current account is the one in use.

**Reads.** The current account follows the session's own numbers every second (free, no request). The others are read every 10 minutes, every 5 minutes once the current one passes 95%, at once after one of their windows resets, and the new account is read right after each switch. Every failed read still backs off (Retry-After, else 5 to 30 minutes).

Every decision goes to `switch-trace.log`: `switch trigger=freed|out from=... to=... reason="..."`, `freed-gone` when the confirming read says otherwise. Never a token.


**Before settling for a weekly-limited account (0.9.0).** When the 99% switch is about to land on a weekly-limited account while any other account's weekly status is unknown (never read) or its reading is more than 10 minutes old, those accounts are read first, for 4 s at most, and the ranking is redone. An account with no weekly limit is never passed over for want of a reading; only one whose read fails (backing off after a 429) can be, and the trace then shows it as `read=never` or with its error. The "better account frees up" rule moves the session back as soon as it reads free.

**The trace (0.9.0).** `switch-trace.log` is appended to, never replaced, so several sessions and reloads share it (last 2000 lines). Each line carries a 4-letter tag for the module instance that wrote it. Every load writes `start version=<version>` and the ranking; every swap decision writes the ranking it used, one `rank` line per account, best first (`*` marks the current one):

```
2026-10-25T05:00:25.120Z k3f9 rank out priority=default
2026-10-25T05:00:25.120Z k3f9 rank #1 me@example.com[Team] plan=5x weekly=none 5h=0% week=- free=true read=40s
2026-10-25T05:00:25.120Z k3f9 rank #4 personal@example.com[Max] plan=20x weekly=limited 5h=0% week=0% free=true read=40s
2026-10-25T05:00:25.121Z k3f9 switch trigger=out from=devs@example.com to=me@example.com reason="..." switched=true took=210ms
```

No line without `start version=` above it came from 0.9.0 or later. Emails, plans and percents only, never a token.

### How it picks the target

- Only the **binding** windows count: the 5-hour window and the all-models weekly window (`session` and `weekly_all` in the API). Those are the ones that stop you.
- **Scoped weekly windows** (one model only, like weekly Opus) are ignored. They limit one model, not the account.
- **Accounts with no weekly limit** (some team organizations) are judged on the 5-hour window alone.
- **The rule is the number on screen.** The moment a binding bar of the current account shows 99% (98.5% and up, rounded), the next 1-second check switches. No waiting for another read, nor for one already running. It goes to the best free account by the load balancer's priority (above); with none free, to the lowest peak below 99% (tie: lowest 5-hour). It checks at once on every new reading, not only on the 1-second tick.
- **It also fires on the limit error itself.** When a request comes back refused for the limit (Claude Code's `StopFailure` with `rate_limit`), the current account is marked full on the spot (the weekly window if the error says weekly, else the 5-hour one) and the switch runs, no reading needed. A turn, main or agent, that ends on an API error while the account already shows 98% or more counts too. After a limit error the pause between switches drops from 90 s to 15 s.
- **A candidate the usage endpoint answered with 429 still counts**, on its last reading. Only a logged-out account (its refresh token refused) is ruled out. With no reading below 99% anywhere, an account never read gets a blind try: a guess beats a session stuck on a full account.
- **Nowhere to go?** It stays put, doesn't thrash, and the tab says why in one line: how many accounts are full and how many are logged out.
- **Who to resume.** After a limit error the status line (and the tab) says where the session went and who died on the wall: `Limit hit, now on <account>. Resume: the main conversation, @writer, @tester`. It names every agent whose turn ended on an error within two minutes of the hit, and clears itself after 15 minutes. Paste a "continue" into each one and off they go.
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

**An account says "logged out: its refresh token was refused".** An expired access token alone never does this: the plugin refreshes it with the stored refresh token (also when a read comes back 401) and saves the rotated pair. Only when the token endpoint refuses the refresh token itself (`invalid_grant`) is the account logged out, usually because the same account was used in another Claude Code (another folder, another session that refreshed it) and the rotation left the stored copy behind. Do step 3 again for it.

**"token refresh HTTP 403, trying again later"?** The token endpoint sits behind a firewall that refuses some HTTP clients' default User-Agent (Cloudflare error 1010). The plugin sends its own, but if you call the endpoint from a script, set one too.

**Why 99% and not 100%?** At 100% the request that hits the wall already failed, and the numbers Claude Code gets back are rounded, so 99.9% may never show up before the wall does. 99% switches a few requests early. (Learned the hard way: the first version waited for 99.9%, the account sat at 99%, and 13 agents ate 429s.)

**Does it work with one account?** It shows your bars and forecast and never switches. Which is also what my laptop does with one agent: nothing exciting.

**Why "jay"?** Because "claude-switcher" alone sounds like something Anthropic shipped. They didn't. I did, at 3 a.m., on a 32 GB laptop.

## Tests

`claude plugin test .` covers picking the least-used account, the 99%-on-screen trigger, the switch on the session's own limit error, the who-to-resume status line, the refresh on 401 (and that only a refused refresh logs out), not switching (and saying why) when every account is full, a 429'd candidate keeping its last reading, accounts with no weekly window, the gentle read schedule (no reads below 95%, Retry-After, the 5 to 30 minute backoff), a 99% switching within a second while every usage read hangs and with no hook firing, a lagging usage answer not hiding a 99%, the old account's reading not laid over the new one, the trace (and no token in it), the token refresh write-back, the switch writes (backup, `mcpOAuth` kept, no write when the login changed elsewhere), `CLAUDE_CONFIG_DIR`, the first-run store, the import, and the tab drawn on every surface.
