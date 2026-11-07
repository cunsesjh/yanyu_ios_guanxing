"""Offline acquisition checks: session isolation, RSA format, real response guards."""
import base64
import json
import math
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from yyjh.capture import retrieve
from yyjh.core import xxtea
from yyjh.game.protocol import protocol_key


class RetrieveTests(unittest.TestCase):
    def entry(self, account='alpha@example.com', seed=b'abcdef', code=0):
        k = base64.b64encode(xxtea.encrypt(seed, protocol_key(account, b''))).decode()
        return {'request': {'url': 'http://ios.wlfy.blue8.cn/api_command',
                            'headers': [{'name': n, 'value': ' ' + v} for n, v in
                                        dict(acc=account, area='1', session='session',
                                             ver='73576', command='startGame').items()]},
                'response': {'status': 200, 'headers': [{'name': 'k', 'value': k}],
                             'content': {'text': json.dumps({'code': code})}}}

    def select(self, entries):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, 'input.har')
            with open(path, 'w') as f:
                json.dump({'log': {'entries': entries}}, f)
            return retrieve.session_from_har(path)

    def test_whitespace_and_latest_handshake(self):
        result = self.select([self.entry(), self.entry(seed=b'ghijkl')])
        self.assertEqual(result['protocol_key'], 'alphaeakecghijkl')
        self.assertEqual(result['area'], '1')

    def test_account_switch_cannot_reuse_handshake(self):
        second = self.entry(account='bravo@example.com')
        second['response']['headers'] = []
        with self.assertRaises(ValueError):
            self.select([self.entry(), second])

    def test_invalid_new_handshake_cannot_reuse_old_one(self):
        second = self.entry()
        second['response']['headers'][0]['value'] = 'invalid'
        with self.assertRaises(ValueError):
            self.select([self.entry(), second])

    def test_explicit_error_not_selected(self):
        with self.assertRaises(ValueError):
            self.select([self.entry(code=6)])

    def test_foreign_host_not_selected(self):
        entry = self.entry()
        entry['request']['url'] = 'http://example.com/api_command'
        with self.assertRaises(ValueError):
            self.select([entry])

    def test_rsa_recovers_pkcs1_message_with_private_exponent(self):
        # Two known Mersenne primes, strictly test-only, never used for game requests.
        p, q = 2**127 - 1, 2**107 - 1
        n, e = p * q, 65537
        d = pow(e, -1, math.lcm(p - 1, q - 1))
        message = b'0123456789abcdef'
        cipher = retrieve.rsa_wrap(message, n, e)
        block = pow(int.from_bytes(cipher, 'big'), d, n).to_bytes(len(cipher), 'big')
        self.assertTrue(block.startswith(b'\x00\x02'))
        padding, recovered = block[2:].split(b'\x00', 1)
        self.assertGreaterEqual(len(padding), 8)
        self.assertEqual(recovered, message)

    def test_request_body_contains_chosen_key_rsa_and_stamp(self):
        session = self.select([self.entry()])
        session['headers']['authorization'] = 'must-not-copy'
        with patch.object(retrieve, 'rsa_wrap', return_value=b'public-cipher') as wrap:
            body, headers, key = retrieve.prepare(session)
        payload = json.loads(xxtea.decrypt(base64.b64decode(body), session['protocol_key']))
        self.assertEqual(payload, {'stamp': 0, 'auto': base64.b64encode(b'public-cipher').decode()})
        wrap.assert_called_once_with(key.encode('ascii'))
        self.assertEqual(headers['command'], 'download3')
        self.assertNotIn('authorization', headers)

    def test_expiry_error_is_specific(self):
        with self.assertRaisesRegex(ValueError, '失效'):
            retrieve.decode_response({'code': 6}, 'unused', {})

    def test_partial_or_wrong_server_is_rejected(self):
        session = dict(platform='ios', area='1', account='alpha@example.com')
        payload = dict(code=0, data=base64.b64encode(b'cipher').decode())
        for data in ({'ServerID': 2}, {'ServerID': 1, 'MainRole': {}, 'Roles': []}):
            with patch.object(retrieve.envelope, 'open_full', return_value=(data, 73576, 'key')):
                with self.assertRaises(ValueError):
                    retrieve.decode_response(payload, 'key', session)

    def test_redirects_are_not_followed(self):
        self.assertIsNone(retrieve.NoRedirect().redirect_request(None, None, None, None))

    def test_foreign_target_cannot_fetch(self):
        with patch.object(retrieve, 'prepare') as prepare:
            with self.assertRaises(ValueError):
                retrieve.fetch({'url': 'https://example.com/api_command'})
        prepare.assert_not_called()

    def test_dry_run_never_fetches(self):
        from types import SimpleNamespace
        with patch.object(retrieve, 'session_from_har', return_value={'platform': 'ios'}):
            with patch.object(retrieve, 'fetch') as fetch:
                self.assertEqual(retrieve.command(SimpleNamespace(har='unused', fetch=False)), 0)
        fetch.assert_not_called()


class CaptureIntegrationTests(unittest.TestCase):
    def args(self, path, fetch):
        from yyjh.__main__ import build_parser
        return build_parser().parse_args(['capture', path, '--mem', 'off']
                                        + (['--fetch'] if fetch else []))

    def test_acquire_preserves_platform_and_excludes_transport_key(self):
        session = dict(platform='ios', account='alpha@example.com', area='1')
        data = dict(ServerID=1, EncryptID=session['account'],
                    MainRole={}, Roles=[], Rnds={})
        with patch.object(retrieve, 'session_from_har', return_value=session), \
                patch.object(retrieve, 'fetch', return_value=(data, 73576, 'inner')), \
                patch('yyjh.game.player.build', return_value='summary'):
            result = retrieve.acquire('sample.har')
        self.assertEqual(result.runtime, 'ios')
        self.assertEqual(result.version, '00073576')
        self.assertEqual(result.data, data)
        self.assertEqual(result.outer_key, '')
        self.assertEqual(result.player, 'summary')

    def test_capture_fetch_uses_normal_output_without_passive_or_memory_fallback(self):
        from yyjh import layer2, model
        result = model.SaveResult(runtime='ios')
        with tempfile.NamedTemporaryFile(suffix='.har') as har:
            with patch.object(retrieve, 'acquire', return_value=result) as acquire, \
                    patch('yyjh.capture.decode.decode') as passive, \
                    patch.object(layer2, '_mem_outer_key') as memory, \
                    patch.object(layer2, '_finish', return_value=result) as finish:
                args = self.args(har.name, True)
                self.assertIs(layer2.pipeline_capture(args), result)
        acquire.assert_called_once_with(har.name, avatar_field=args.avatar_field)
        passive.assert_not_called()
        memory.assert_not_called()
        finish.assert_called_once_with(result, args)

    def test_failed_acquisition_never_writes_or_falls_back_to_partial(self):
        from yyjh import layer2, ui
        with tempfile.NamedTemporaryFile(suffix='.har') as har:
            with patch.object(retrieve, 'acquire', side_effect=ValueError('内层解码失败')), \
                    patch('yyjh.capture.decode.decode') as passive, \
                    patch.object(layer2, '_finish') as finish:
                with self.assertRaises(ui.UserError):
                    layer2.pipeline_capture(self.args(har.name, True))
        passive.assert_not_called()
        finish.assert_not_called()

    def test_default_capture_remains_offline(self):
        from yyjh import layer2, model
        result = model.SaveResult(runtime='ios')
        with tempfile.NamedTemporaryFile(suffix='.har') as har:
            with patch.object(retrieve, 'acquire') as acquire, \
                    patch('yyjh.capture.decode.decode', return_value=result), \
                    patch.object(layer2, '_finish', return_value=result):
                layer2.pipeline_capture(self.args(har.name, False))
        acquire.assert_not_called()


if __name__ == '__main__':
    unittest.main()
