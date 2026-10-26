"""Claude Code account router.

  python switch.py save            store the current login (adds it, or updates it)
  python switch.py list            show stored accounts, no tokens; * marks the current one
  python switch.py use <n|email>   save the current login back, then switch (n = number from `list`)
  python switch.py next            rotate to the next stored account
  python switch.py import <dir>    store the login of another config folder (a CLAUDE_CONFIG_DIR)
  python switch.py least-used --from <store> [--min-valid-min 45]
                                   read every account's usage in <store> (another folder's logins/accounts.json),
                                   activate the least-used one in THIS config folder; no token is refreshed or printed
  python switch.py give-back --to <store>
                                   after a run: if Claude Code rotated the borrowed login here, put the new tokens
                                   back into <store>, unless that row changed meanwhile

Accounts are keyed by email#organizationUuid: one email can hold several organizations.
Paths follow Claude Code: CLAUDE_CONFIG_DIR when set, else ~/.claude (and ~/.claude.json).
The store is <config>/logins/accounts.json. It holds tokens, so it is written owner-only.
A running Claude Code picks up a switch on its next request; /status may show the old email until restart.
"""
import datetime
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser('~')
CONFIG_DIR = os.environ.get('CLAUDE_CONFIG_DIR', '').rstrip('/\\')
CONFIG = os.path.expanduser(CONFIG_DIR) if CONFIG_DIR else os.path.join(HOME, '.claude')
CRED = os.path.join(CONFIG, '.credentials.json')
CLAUDE_JSON = os.path.join(CONFIG, '.claude.json') if CONFIG_DIR else os.path.join(HOME, '.claude.json')
STORE = os.path.join(CONFIG, 'logins', 'accounts.json')


def load(path, default):
    try:
        with open(path, encoding='utf-8-sig') as f:
            return json.load(f)
    except FileNotFoundError:
        return default


# Temp file then rename: a reader sees the old file or the new one, never half. Owner-only on POSIX.
def dump(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    if os.name != 'nt':
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def login_in(cred_path, claude_json_path):
    oauth = (load(cred_path, {}) or {}).get('claudeAiOauth')
    acct = (load(claude_json_path, {}) or {}).get('oauthAccount') or {}
    return acct.get('emailAddress'), acct, oauth


def current():
    return login_in(CRED, CLAUDE_JSON)


def key_of(acct, email):
    return f"{email}#{(acct or {}).get('organizationUuid') or ''}"


def stored_key(a):
    return a.get('key') or key_of(a.get('oauthAccount'), a['email'])


def label(a):
    org = (a.get('oauthAccount') or {}).get('organizationName') or ''
    return f"{a['email']} [{org}]" if org else a['email']


def stamp():
    return datetime.datetime.now().isoformat(timespec='seconds')


def put(store, email, acct, oauth):
    k = key_of(acct, email)
    store['accounts'] = [a for a in store['accounts'] if stored_key(a) != k]
    store['accounts'].append({'key': k, 'email': email, 'savedAt': stamp(), 'oauthAccount': acct, 'claudeAiOauth': oauth})
    return store


def save_current(store):
    email, acct, oauth = current()
    if not email or not oauth:
        print('no current login to save')
        return store
    return put(store, email, acct, oauth)


# Only claudeAiOauth and oauthAccount change; every other key (mcpOAuth, settings) is kept.
def activate(entry):
    cred = load(CRED, {})
    cred['claudeAiOauth'] = entry['claudeAiOauth']
    dump(CRED, cred)
    cj = load(CLAUDE_JSON, {})
    cj['oauthAccount'] = entry['oauthAccount']
    dump(CLAUDE_JSON, cj)
    print('now using', label(entry))


USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
OAUTH_BETA = 'oauth-2025-04-20'
USER_AGENT = 'jay-claude-switcher/0.9'
BORROWED = os.path.join(CONFIG, 'logins', 'borrowed.json')


def fetch_usage(token):
    req = urllib.request.Request(USAGE_URL, headers={'Authorization': f'Bearer {token}', 'anthropic-beta': OAUTH_BETA, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return e.code, None
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        print('usage read failed:', type(e).__name__)
        return 0, None


# The binding windows' percents, read like hooks/accounts.ts parseUsage: `limits` (session, weekly_all) first, the
# older five_hour / seven_day fields as a fallback. A window whose reset has passed counts as empty.
def usage_percents(body, now=None):
    now = time.time() if now is None else now
    out = {}

    def live(pct, resets_at):
        if resets_at:
            try:
                if datetime.datetime.fromisoformat(resets_at.replace('Z', '+00:00')).timestamp() <= now:
                    return 0
            except ValueError:
                return pct
        return pct

    limits = [l for l in (body or {}).get('limits') or [] if isinstance(l.get('percent'), (int, float))]
    for l in limits:
        if l.get('kind') in ('session', 'weekly_all'):
            out['5h' if l['kind'] == 'session' else 'week'] = live(l['percent'], l.get('resets_at'))
    if not limits:
        for key, name in (('five_hour', '5h'), ('seven_day', 'week')):
            w = (body or {}).get(key)
            if isinstance(w, dict) and isinstance(w.get('utilization'), (int, float)):
                out[name] = live(w['utilization'], w.get('resets_at'))
    return out


def plan_of(a):
    tier = str((a.get('claudeAiOauth') or {}).get('rateLimitTier') or '')
    for part in tier.split('_'):
        if part.endswith('x') and part[:-1].isdigit():
            return int(part[:-1])
    return 1 if 'pro' in tier.lower() else 0


def borrowable(a, now, min_valid_s):
    oauth = a.get('claudeAiOauth') or {}
    return bool(oauth.get('accessToken')) and (oauth.get('expiresAt') or 0) / 1000 - now >= min_valid_s


# Least used = the lowest peak over its binding windows; ties go to the larger plan (more room), then store order.
# A token expiring within min_valid_s is never borrowed: the run must not need a refresh, because a refresh here
# rotates the refresh token away from the store the switcher reads.
def pick_least_used(accounts, readings, now, min_valid_s):
    best = None
    for i, a in enumerate(accounts):
        r = readings.get(stored_key(a))
        if not r or not borrowable(a, now, min_valid_s):
            continue
        rank = (max(r.values()), -plan_of(a), i)
        if best is None or rank < best[0]:
            best = (rank, a, r)
    return best


def sha(s):
    return hashlib.sha256((s or '').encode('utf-8')).hexdigest()


def arg_after(flag, default=''):
    i = sys.argv.index(flag) if flag in sys.argv else -1
    return sys.argv[i + 1] if 0 <= i < len(sys.argv) - 1 else default


def pct_text(r):
    return ' '.join(f'{k}={v}%' for k, v in r.items())


def least_used():
    src = os.path.expanduser(arg_after('--from'))
    if not src:
        print('least-used --from <logins/accounts.json of the switcher store>')
        sys.exit(2)
    if os.path.abspath(src) == os.path.abspath(STORE):
        print("least-used: --from must be another config folder's store, not this one")
        sys.exit(2)
    min_valid_s = int(arg_after('--min-valid-min', '45')) * 60
    accounts = load(src, {'accounts': []})['accounts']
    now = time.time()
    readings = {}
    for a in accounts:
        if not borrowable(a, now, min_valid_s):
            print('skip', label(a), '(token expires too soon to borrow)')
            continue
        status, body = fetch_usage(a['claudeAiOauth']['accessToken'])
        r = usage_percents(body, now) if status == 200 else {}
        print('read', label(a), f'HTTP {status}', pct_text(r))
        if r:
            readings[stored_key(a)] = r
    best = pick_least_used(accounts, readings, now, min_valid_s)
    if not best:
        print('least-used: no account with a usage reading and a token valid long enough')
        sys.exit(1)
    _, a, r = best
    activate(a)
    dump(BORROWED, {'key': stored_key(a), 'from': src, 'refreshSha': sha(a['claudeAiOauth'].get('refreshToken')), 'at': stamp(), 'usage': r})
    print('picked', label(a), pct_text(r))


def give_back():
    dest = os.path.expanduser(arg_after('--to'))
    b = load(BORROWED, None)
    if not dest or not b:
        print('give-back --to <store>' if not dest else 'give-back: nothing borrowed')
        return
    _, _, oauth = current()
    if not oauth or sha(oauth.get('refreshToken')) == b['refreshSha']:
        print('give-back: login not rotated, nothing to return')
        return
    store = load(dest, {'accounts': []})
    row = next((a for a in store['accounts'] if stored_key(a) == b['key']), None)
    if not row or sha((row.get('claudeAiOauth') or {}).get('refreshToken')) != b['refreshSha']:
        print('give-back: the store row changed meanwhile; left as it is')
        return
    row['claudeAiOauth'] = oauth
    row['savedAt'] = stamp()
    dump(dest, store)
    print('give-back: rotated tokens returned for', label(row))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'list'
    arg = sys.argv[2] if len(sys.argv) > 2 else ''
    store = load(STORE, {'accounts': []})
    if cmd == 'save':
        dump(STORE, save_current(store))
        print('stored:', [label(a) for a in store['accounts']])
    elif cmd == 'import':
        src = os.path.expanduser(arg or '~/.claude-login')
        email, acct, oauth = login_in(os.path.join(src, '.credentials.json'), os.path.join(src, '.claude.json'))
        if not oauth or not email:
            print('no login found in', src, '(wait a few seconds after /login and try again)')
            sys.exit(1)
        dump(STORE, put(store, email, acct, oauth))
        print('imported', label(store['accounts'][-1]), 'org', acct.get('organizationUuid') or '?')
        print('stored:', [label(a) for a in store['accounts']])
    elif cmd == 'list':
        email, acct, _ = current()
        ck = key_of(acct, email)
        for i, a in enumerate(store['accounts']):
            mark = '*' if stored_key(a) == ck else ' '
            print(mark, i, label(a), (a.get('claudeAiOauth') or {}).get('rateLimitTier'), 'saved', a.get('savedAt'))
    elif cmd in ('use', 'next'):
        before = store['accounts']
        if cmd == 'use' and arg.isdigit() and int(arg) < len(before):
            arg = stored_key(before[int(arg)])
        store = save_current(store)
        dump(STORE, store)
        accts = store['accounts']
        keys = [stored_key(a) for a in accts]
        if cmd == 'use':
            idx = keys.index(arg) if arg in keys else None
            if idx is None:
                matches = [i for i, a in enumerate(accts) if a['email'] == arg]
                idx = matches[0] if len(matches) == 1 else None
        else:
            email, acct, _ = current()
            ck = key_of(acct, email)
            i = keys.index(ck) if ck in keys else -1
            idx = (i + 1) % len(accts) if accts else None
        if idx is None:
            print('unknown account:', arg, '| stored:', [label(a) for a in accts])
            sys.exit(1)
        activate(accts[idx])
    elif cmd == 'least-used':
        least_used()
    elif cmd == 'give-back':
        give_back()
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
