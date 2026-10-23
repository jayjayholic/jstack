---
name: add-account
description: Add another Claude account (or another organization of the same email) to the jay-claude-switcher store without logging the running session out. Use when the user asks to add, import or log in a second Claude account, a new org, or "another Max plan" for the switcher.
---

# Add an account to the switcher

The running session must keep its login. So the new login happens in a SECOND Claude Code with its own config folder, and `switch.py import` copies it into the store. Never run `/login` in the user's working session for this.

The scripts are in the plugin folder, two levels above this skill's base directory: `<base>/../../scripts/switch.py` and `<base>/../../scripts/login-window.ps1`. Resolve the absolute path once and use it below. Use `python3` where `python` is missing.

## Steps

1. **Pick the login folder.** Default `~/.claude-login`. If it already has a `.credentials.json`, first run `python <scripts>/switch.py import ~/.claude-login` (a leftover login that was never imported is still an account) and only then clear it (step 7).

2. **Open the second Claude Code.**
   - Windows: run `powershell -ExecutionPolicy Bypass -File <scripts>/login-window.ps1` (optional `-Dir <folder>`). It sets `CLAUDE_CONFIG_DIR` and starts `claude` in a new window. Don't try to inline this in one `Start-Process` line: the nested quoting breaks.
   - macOS / Linux: ask the user to open a new terminal and run `CLAUDE_CONFIG_DIR=~/.claude-login claude`. (UNVERIFIED on macOS: Claude Code keeps macOS logins in the Keychain, so the file-based switch may not apply there.)

3. **The user runs `/login` in that window** and picks the account (and the organization, if the email has several). Tell them to say "done" when the window shows they are logged in. You can't see that window; wait for them.

4. **Wait about 10 seconds.** `.credentials.json` lands first; `.claude.json` with the email and organization is written a few seconds later. Importing too early prints `no login found`. If it does, wait 10 more seconds and retry, up to 3 times.

5. **Import:** `python <scripts>/switch.py import ~/.claude-login`. It prints `imported <email> [<org name>] org <organizationUuid>` and the stored list.

6. **Confirm with the user** that the email and organization printed are the ones they meant. Accounts are keyed by `email#organizationUuid`, so the same email in two orgs is two rows; a re-import of the same pair just refreshes it. Then run `python <scripts>/switch.py list` and show it.

7. **Only now clear the login folder** so the next login starts clean: ask the user to close the second window, then delete `~/.claude-login` (`Remove-Item -Recurse -Force` on Windows, `rm -rf` elsewhere). Clearing before step 5 loses the login and they have to do it again. Leaving it signed in is worse: both copies share one refresh token, and whichever side refreshes first breaks the other.

8. Tell the user the Sessions tab picks the account up on its next read (or run `/switcher-accounts` now).

## Rules

- Never print, echo, log or paste a token. Don't `cat` `.credentials.json`, `accounts.json` or `.claude.json`; read only through `switch.py` (it never prints tokens). If you must inspect, print key names, never values.
- Never copy `accounts.json`, `.credentials.json` or `.claude.json` anywhere else (repos, chats, issues).
- Never touch the user's main config folder (`~/.claude` or their `CLAUDE_CONFIG_DIR`) by hand. `switch.py` and the Sessions tab write it atomically.
