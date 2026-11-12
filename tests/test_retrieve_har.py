import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from yyjh.capture.retrieve import prepare, session_from_har


def entry(when, path, request_headers, response_headers=None, response_body=None):
    host = 'yanyuonline.novastargame.net'
    return {
        'startedDateTime': when,
        'request': {
            'method': 'POST',
            'url': f'https://{host}{path}',
            'headers': [{'name': name, 'value': value}
                        for name, value in request_headers.items()],
        },
        'response': {
            'status': 200,
            'headers': [{'name': name, 'value': value}
                        for name, value in (response_headers or {}).items()],
            'content': {'text': json.dumps(response_body or {'code': 0})},
        },
    }


class RetrieveHarTests(unittest.TestCase):
    def test_login_during_capture_uses_matching_post_login_session(self):
        old_request = {
            'acc': 'old-account', 'session': 'old-session', 'area': '7',
            'command': 'download', 'plat': 'android', 'sn': 'old-device',
        }
        login_request = {
            'channel': 'test_ios', 'plat': 'ios', 'sn': 'device-sn',
            'sn2': 'device-sn2', 'sn3': 'device-sn3',
            'cookie': 'must-not-be-forwarded',
        }
        post_login_request = {
            'acc': 'new-account', 'session': 'new-session', 'area': '31',
            'command': 'startGame', 'channel': 'test_ios', 'plat': 'ios',
            'sn': 'device-sn', 'sn2': 'device-sn2', 'sn3': 'device-sn3',
        }
        later_request = {
            'acc': 'new-account', 'session': 'new-session', 'area': '31',
            'command': 'uploadPower', 'channel': 'test_ios',
            'appver': '73576', 'cookie': 'must-not-be-forwarded',
        }
        entries = [
            entry('2026-11-12T12:03:10Z', '/api_command', later_request),
            entry('2026-11-12T12:03:03Z', '/api_command', post_login_request,
                  {'k': 'login-k'}),
            entry('2026-11-12T12:03:01Z', '/api_check_user', login_request,
                  {'k': 'login-k'}, {'code': 0, 'data': {'acc': 'new-account'}}),
            entry('2026-11-12T12:03:00Z', '/api_command', old_request,
                  {'k': 'old-k'}),
        ]
        with tempfile.TemporaryDirectory() as folder:
            har_path = Path(folder) / 'capture.har'
            har_path.write_text(json.dumps({'log': {'entries': entries}}), encoding='utf-8')
            with patch('yyjh.capture.retrieve.protocol.derive', side_effect=lambda acc, _k: {
                    'real_key': '0123456789abcdef'}):
                session = session_from_har(har_path)

        self.assertEqual(session['account'], 'new-account')
        self.assertEqual(session['session'], 'new-session')
        self.assertEqual(session['area'], '31')
        self.assertEqual(session['platform'], 'ios')
        _, headers, _ = prepare(session)
        self.assertEqual(headers['sn'], 'device-sn')
        self.assertEqual(headers['sn2'], 'device-sn2')
        self.assertEqual(headers['sn3'], 'device-sn3')
        self.assertEqual(headers['plat'], 'ios')
        self.assertNotIn('cookie', headers)


if __name__ == '__main__':
    unittest.main()
