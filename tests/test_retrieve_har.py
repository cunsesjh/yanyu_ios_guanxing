import base64
import json
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

from yyjh.capture.retrieve import decode_response, prepare, session_from_har


def entry(when, path, request_headers, response_headers=None, response_body=None,
          host='yanyuonline.novastargame.net'):
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

    def test_pre_host_whalegame_matches(self):
        """v73618+ 先行服新域名 wlfypre.whalegame.cn 也要能匹配登录会话。"""
        request = {
            'acc': 'pre-account', 'session': 'pre-session', 'area': '1',
            'command': 'download3', 'realchannel': 'lanjing_ios_pre',
            'plat': 'ios', 'ver': '73618',
        }
        entries = [
            entry('2026-11-24T04:01:40Z', '/api_command', request,
                  {'k': 'pre-k'}, host='wlfypre.whalegame.cn'),
        ]
        with tempfile.TemporaryDirectory() as folder:
            har_path = Path(folder) / 'capture.har'
            har_path.write_text(json.dumps({'log': {'entries': entries}}),
                                encoding='utf-8')
            with patch('yyjh.capture.retrieve.protocol.derive',
                       side_effect=lambda acc, _k: {
                           'real_key': '0123456789abcdef'}):
                session = session_from_har(har_path)

        self.assertEqual(session['account'], 'pre-account')
        self.assertEqual(session['area'], '1')
        self.assertEqual(session['platform'], 'ios')
        self.assertIn('wlfypre.whalegame.cn', session['url'])

    def test_decode_response_uses_extra_psw(self):
        """v73618+ 内层 psw 由 extra 下发：decode_response 要能用它解存档。"""
        from yyjh.core import xxtea

        account, area = 'acc-1', '31'
        psw, suffix = 'newpsw12', 'yoqkmrtj'
        save = {'ServerID': area, 'EncryptID': account,
                'MainRole': {'Name': 'x'}, 'Roles': [], 'Rnds': {}}
        inner_plain = zlib.compress(json.dumps(save).encode())
        inner_plain += b'\x00' * ((-len(inner_plain)) % 4)
        inner = xxtea._encrypt_py(inner_plain, psw + suffix)
        stage1 = base64.b64encode(b'00073618' + inner)
        stage1 += b'\x00' * ((-len(stage1)) % 4)
        key = 'Aa1Bb2Cc3Dd4Ee5F'
        real_key = '0123456789abcdef'
        cipher = xxtea._encrypt_py(stage1, key)
        payload = {
            'code': 0,
            'data': base64.b64encode(cipher).decode('ascii'),
            'extra': base64.b64encode(
                xxtea.encrypt(psw.encode('ascii'), real_key)).decode('ascii'),
        }
        session = {'protocol_key': real_key, 'platform': 'ios',
                   'area': area, 'account': account}
        data, version, inner_key = decode_response(payload, key, session)
        self.assertEqual(version, 73618)
        self.assertEqual(inner_key, psw + suffix)
        self.assertEqual(data['EncryptID'], account)


if __name__ == '__main__':
    unittest.main()
