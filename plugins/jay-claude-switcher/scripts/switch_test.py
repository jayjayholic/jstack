"""python -m unittest switch_test   (from this folder)"""
import os
import sys
import tempfile
import unittest

os.environ['CLAUDE_CONFIG_DIR'] = tempfile.mkdtemp()
sys.path.insert(0, os.path.dirname(__file__))
import switch  # noqa: E402

NOW = 1_800_000_000


def acct(email, tier='default_claude_max_5x', valid_min=120, org='o'):
    return {'key': f'{email}#{org}', 'email': email, 'oauthAccount': {'emailAddress': email, 'organizationUuid': org},
            'claudeAiOauth': {'accessToken': 't-' + email, 'refreshToken': 'r-' + email, 'expiresAt': (NOW + valid_min * 60) * 1000, 'rateLimitTier': tier}}


class UsageTest(unittest.TestCase):
    def test_limits_shape_reads_session_and_weekly(self):
        body = {'limits': [{'kind': 'session', 'percent': 40, 'resets_at': '2030-01-01T00:00:00Z'}, {'kind': 'weekly_all', 'percent': 12}, {'kind': 'weekly_opus', 'percent': 99}]}
        self.assertEqual(switch.usage_percents(body, NOW), {'5h': 40, 'week': 12})

    def test_window_past_its_reset_reads_empty(self):
        body = {'limits': [{'kind': 'session', 'percent': 97, 'resets_at': '2020-01-01T00:00:00Z'}]}
        self.assertEqual(switch.usage_percents(body, NOW), {'5h': 0})

    def test_legacy_shape_and_garbage(self):
        self.assertEqual(switch.usage_percents({'five_hour': {'utilization': 5}, 'seven_day': None}, NOW), {'5h': 5})
        self.assertEqual(switch.usage_percents(None, NOW), {})
        self.assertEqual(switch.usage_percents({'limits': [{'kind': 'session'}]}, NOW), {})


class PickTest(unittest.TestCase):
    def test_lowest_peak_wins(self):
        a, b = acct('a@x'), acct('b@x')
        best = switch.pick_least_used([a, b], {'a@x#o': {'5h': 60, 'week': 10}, 'b@x#o': {'5h': 20, 'week': 30}}, NOW, 2700)
        self.assertEqual(best[1]['email'], 'b@x')

    def test_tie_goes_to_larger_plan(self):
        a, b = acct('a@x'), acct('b@x', tier='default_claude_max_20x')
        best = switch.pick_least_used([a, b], {'a@x#o': {'5h': 0}, 'b@x#o': {'5h': 0}}, NOW, 2700)
        self.assertEqual(best[1]['email'], 'b@x')

    def test_token_expiring_soon_or_unread_is_skipped(self):
        a, b = acct('a@x', valid_min=10), acct('b@x')
        self.assertIsNone(switch.pick_least_used([a, b], {'a@x#o': {'5h': 0}}, NOW, 2700))
        self.assertEqual(switch.pick_least_used([a, b], {'a@x#o': {'5h': 0}, 'b@x#o': {'5h': 90}}, NOW, 2700)[1]['email'], 'b@x')

    def test_plan_of(self):
        self.assertEqual(switch.plan_of(acct('a', tier='default_claude_max_20x')), 20)
        self.assertEqual(switch.plan_of(acct('a', tier='claude_pro')), 1)
        self.assertEqual(switch.plan_of(acct('a', tier='')), 0)


class GiveBackTest(unittest.TestCase):
    def setUp(self):
        self.dest = os.path.join(tempfile.mkdtemp(), 'accounts.json')
        self.row = acct('a@x')
        switch.dump(self.dest, {'accounts': [self.row]})
        switch.activate(self.row)
        switch.dump(switch.BORROWED, {'key': 'a@x#o', 'refreshSha': switch.sha('r-a@x')})
        sys.argv = ['switch.py', 'give-back', '--to', self.dest]

    def rotate(self):
        cred = switch.load(switch.CRED, {})
        cred['claudeAiOauth'] = {**cred['claudeAiOauth'], 'refreshToken': 'r-new'}
        switch.dump(switch.CRED, cred)

    def test_rotated_login_goes_back(self):
        self.rotate()
        switch.give_back()
        self.assertEqual(switch.load(self.dest, {})['accounts'][0]['claudeAiOauth']['refreshToken'], 'r-new')

    def test_unrotated_login_leaves_store(self):
        switch.give_back()
        self.assertEqual(switch.load(self.dest, {})['accounts'][0]['claudeAiOauth']['refreshToken'], 'r-a@x')

    def test_store_row_changed_meanwhile_is_kept(self):
        self.rotate()
        store = switch.load(self.dest, {})
        store['accounts'][0]['claudeAiOauth']['refreshToken'] = 'r-from-switcher'
        switch.dump(self.dest, store)
        switch.give_back()
        self.assertEqual(switch.load(self.dest, {})['accounts'][0]['claudeAiOauth']['refreshToken'], 'r-from-switcher')


if __name__ == '__main__':
    unittest.main()
