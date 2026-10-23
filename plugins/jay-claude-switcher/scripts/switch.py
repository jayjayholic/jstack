"""Claude Code account router.

  python switch.py save            store the current login (adds it, or updates it)
  python switch.py list            show stored accounts, no tokens; * marks the current one
  python switch.py use <n|email>   save the current login back, then switch (n = number from `list`)
  python switch.py next            rotate to the next stored account
  python switch.py import <dir>    store the login of another config folder (a CLAUDE_CONFIG_DIR)

Accounts are keyed by email#organizationUuid: one email can hold several organizations.
Paths follow Claude Code: CLAUDE_CONFIG_DIR when set, else ~/.claude (and ~/.claude.json).
The store is <config>/logins/accounts.json. It holds tokens, so it is written owner-only.
A running Claude Code picks up a switch on its next request; /status may show the old email until restart.
"""
import datetime
import json
import os
import sys

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
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
