import http.client
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from desktop.storage import Store, WindowsProtector
from desktop.service import DownloadService
from desktop.server import LocalSite

DATA = {'MainRole': {'Name': '预览角色'}, 'Roles': {}, 'Rnds': {'test': 123}}
SESSION = dict(url='https://ios.wlfy.blue8.cn/api_command', account='fake-account',
               session='fake-session', area='1', protocol_key='fake-key',
               platform='ios', headers={'ver': '73576', 'cookie': 'never-save'})


class FakeProtector:
    # A test double only. Production always uses WindowsProtector.
    def protect(self, raw):
        return bytes(b ^ 0x5a for b in raw)

    def unprotect(self, raw):
        return self.protect(raw)


class DesktopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(self.tmp.name, FakeProtector())

    def test_download_restart_and_session_minimization(self):
        with patch('desktop.service.retrieve.fetch', return_value=(DATA, '73576', None)) as fetch:
            result = DownloadService(self.store).download(SESSION)
        fetch.assert_called_once_with(SESSION)
        reopened = Store(self.tmp.name, FakeProtector())
        self.assertEqual(reopened.selected()['id'], result['row']['id'])
        self.assertEqual(reopened.load_snapshot(result['row']['id']), DATA)
        saved = reopened.load_session()
        self.assertEqual(saved['headers'], {'ver': '73576'})
        raw = reopened.session_path.read_bytes()
        self.assertNotIn(b'fake-session', raw)
        self.assertNotIn(b'never-save', raw)

    def test_theme_preference_is_separate_from_snapshot_selection(self):
        row = self.store.save_snapshot(DATA, 'ios', '1', '73576')
        self.assertEqual(self.store.theme(), 'dark')
        self.store.set_theme('light')
        reopened = Store(self.tmp.name)
        self.assertEqual(reopened.theme(), 'light')
        self.assertEqual(reopened.selected()['id'], row['id'])
        self.assertEqual(reopened.load_snapshot(row['id']), DATA)
        with self.assertRaises(ValueError):
            self.store.set_theme('invalid')

    def test_release_notes_are_shown_once_per_version_and_preserve_theme(self):
        self.assertFalse(self.store.release_notes_seen('3.0.5'))
        self.store.mark_release_notes_seen('3.0.5')
        self.assertTrue(Store(self.tmp.name).release_notes_seen('3.0.5'))
        self.assertFalse(self.store.release_notes_seen('3.0.6'))
        self.store.set_theme('light')
        reopened = Store(self.tmp.name)
        self.assertEqual(reopened.theme(), 'light')
        self.assertTrue(reopened.release_notes_seen('3.0.5'))
        reopened.mark_release_notes_seen('3.0.6')
        reopened.set_theme('dark')
        self.assertTrue(Store(self.tmp.name).release_notes_seen('3.0.6'))
        with self.assertRaises(ValueError):
            self.store.mark_release_notes_seen('')

    def test_failed_refresh_keeps_previous_snapshot_and_session(self):
        self.store.save_session(SESSION)
        row = self.store.save_snapshot(DATA, 'ios', '1', '73576')
        before = self.store.session_path.read_bytes()
        with patch('desktop.service.retrieve.fetch', side_effect=ValueError('登录会话已失效')):
            with self.assertRaises(ValueError):
                DownloadService(self.store).download(dict(SESSION, session='other-account'))
        self.assertEqual(self.store.selected()['id'], row['id'])
        self.assertEqual(self.store.session_path.read_bytes(), before)
        self.assertEqual(len(self.store.list_snapshots()), 1)

    def test_har_download_falls_back_to_complete_offline_snapshot(self):
        parsed = SimpleNamespace(data=DATA, runtime='ios', server='31', version='73680',
                                 steps=[SimpleNamespace(label='数据来源', value='download 响应')])
        with patch('desktop.service.retrieve.session_from_har', return_value=SESSION), \
             patch('desktop.service.retrieve.fetch', side_effect=ValueError('游戏服务器拒绝请求（HTTP 500）')), \
             patch('yyjh.capture.decode.decode', return_value=parsed):
            result = DownloadService(self.store).download_from_har('capture.har')
        self.assertIn('已改为从 HAR 离线导入', result['warning'])
        self.assertIn('73680', result['warning'])
        self.assertIsNone(result['session'])
        self.assertEqual(self.store.load_snapshot(result['row']['id']), DATA)
        self.assertFalse(self.store.session_path.exists(),
                         'an unsuccessful active session must not be persisted as fresh')

    def test_har_download_does_not_fallback_to_incomplete_data(self):
        parsed = SimpleNamespace(data={'MainRole': {}, 'Roles': {}}, runtime='ios',
                                 server='31', version='73680', steps=[])
        with patch('desktop.service.retrieve.session_from_har', return_value=SESSION), \
             patch('desktop.service.retrieve.fetch', side_effect=ValueError('HTTP 500')), \
             patch('yyjh.capture.decode.decode', return_value=parsed):
            with self.assertRaisesRegex(ValueError, 'HTTP 500.*没有可离线导入的完整存档'):
                DownloadService(self.store).download_from_har('capture.har')
        self.assertEqual(self.store.list_snapshots(), [])

    def test_history_selection_survives_restart_and_rejects_traversal(self):
        first = self.store.save_snapshot(DATA, 'ios', '1', '73576')
        self.store.save_snapshot(dict(DATA, Rnds={'test': 456}), 'ios', '1', '73580')
        self.store.select(first['id'])
        self.assertEqual(Store(self.tmp.name).selected()['id'], first['id'])
        with self.assertRaises(ValueError):
            self.store.load_snapshot('../session.dpapi')

    def test_snapshot_survives_session_encryption_failure(self):
        with patch('desktop.service.retrieve.fetch', return_value=(DATA, '73576', None)), \
             patch.object(self.store, 'save_session', side_effect=RuntimeError('DPAPI failed')):
            result = DownloadService(self.store).download(SESSION)
        self.assertTrue(result['warning'])
        self.assertEqual(self.store.load_snapshot(result['row']['id']), DATA)

    def test_delete_snapshot_is_recoverable_and_preserves_session(self):
        self.store.save_session(SESSION)
        session = self.store.session_path.read_bytes()
        first = self.store.save_snapshot(DATA, 'ios', '1', '73576')
        second = self.store.save_snapshot(DATA, 'ios', '1', '73580')
        with self.assertRaises(ValueError):
            self.store.delete_snapshot('../session.dpapi')
        self.store.delete_snapshot(first['id'])
        self.assertEqual(self.store.selected()['id'], second['id'])
        archived = self.store.root / '.deleted-snapshots' / first['id'] / 'dat.json'
        self.assertEqual(json.loads(archived.read_text(encoding='utf-8')), DATA)
        with self.assertRaises(ValueError):
            self.store.load_snapshot(first['id'])
        third = self.store.save_snapshot(DATA, 'ios', '1', '73580')
        self.store.delete_snapshot(third['id'])
        self.assertEqual(Store(self.tmp.name).selected()['id'], second['id'])
        self.store.delete_snapshot(second['id'])
        self.assertIsNone(Store(self.tmp.name).selected())
        self.assertEqual(self.store.list_snapshots(), [])
        self.assertEqual(self.store.session_path.read_bytes(), session)

    def test_incomplete_or_corrupt_snapshots_are_not_silently_loaded(self):
        row = self.store.save_snapshot(DATA, 'ios', '1', '73576')
        (self.store.snapshots / '.pending-test').mkdir()
        self.assertEqual(len(self.store.list_snapshots()), 1)
        (self.store.snapshots / row['id'] / 'dat.json').write_text('{}')
        with self.assertRaises(ValueError):
            self.store.load_snapshot(row['id'])

    @unittest.skipUnless(os.name == 'nt', 'Windows DPAPI')
    def test_real_windows_dpapi(self):
        protector = WindowsProtector()
        raw = b'private-test-session'
        encrypted = protector.protect(raw)
        self.assertNotIn(raw, encrypted)
        self.assertEqual(protector.unprotect(encrypted), raw)
        with self.assertRaises(RuntimeError):
            protector.unprotect(b'corrupt')

    def test_local_server_token_host_and_payload(self):
        root = Path(self.tmp.name) / 'web'
        root.mkdir()
        (root / 'index.html').write_text('<h1>hello</h1>')
        (root / 'last-import.js').write_text('// shim')
        site = LocalSite(root)
        self.addCleanup(site.close)
        site.set_snapshot(DATA)
        connection = http.client.HTTPConnection('127.0.0.1', site.httpd.server_port, timeout=5)
        self.addCleanup(connection.close)
        for path, status, host in [('/', 404, None), (site.prefix, 200, None),
                                   (site.prefix + '%2e%2e/session.dpapi', 404, None),
                                   (site.prefix, 403, 'untrusted.example')]:
            connection.request('GET', path, headers={'Host': host} if host else {})
            response = connection.getresponse()
            self.assertEqual(response.status, status)
            response.read()
        connection.request('GET', site.prefix + 'last-import.js')
        response = connection.getresponse()
        self.assertIn(b'window.__latestPlainSave=', response.read())
        self.assertEqual(response.getheader('Cache-Control'), 'no-store')


if __name__ == '__main__':
    unittest.main()
