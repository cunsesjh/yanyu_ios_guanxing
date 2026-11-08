"""离线兜底导入：主动下载失败时用 HAR 里已下载的存档。"""
import unittest
from unittest.mock import patch

from desktop.service import DownloadService
from desktop.storage import Store
from tests.test_desktop import FakeProtector, SESSION

COMPLETE = {'MainRole': {'Name': '苏'}, 'Roles': [{}], 'Rnds': {'x': 1}}
PARTIAL = {'MainRole': {'Name': '苏'}, 'Roles': [{}]}


class ImportPassiveTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(self.tmp.name, FakeProtector())

    def test_passive_import_saves_snapshot_and_session(self):
        got = dict(data=COMPLETE, runtime='ios', server='31', version='00073680')
        with patch('yyjh.capture.decode.download_body', return_value=got):
            result = DownloadService(self.store).import_passive('x.har', SESSION)
        self.assertEqual(result['row']['version'], '73680')   # 展示用规范化
        self.assertEqual(result['session'], SESSION)
        self.assertEqual(self.store.load_snapshot(result['row']['id']), COMPLETE)
        self.assertEqual(self.store.load_session()['area'], SESSION['area'])

    def test_passive_import_rejects_incomplete_save(self):
        got = dict(data=PARTIAL, runtime='ios', server='31', version='00073680')
        with patch('yyjh.capture.decode.download_body', return_value=got):
            with self.assertRaises(ValueError) as ctx:
                DownloadService(self.store).import_passive('x.har')
        self.assertIn('Rnds', str(ctx.exception))
        self.assertEqual(self.store.list_snapshots(), [])

    def test_passive_import_without_session_still_works(self):
        got = dict(data=COMPLETE, runtime='ios', server='31', version='00073680')
        with patch('yyjh.capture.decode.download_body', return_value=got):
            result = DownloadService(self.store).import_passive('x.har', None)
        self.assertIsNone(result['session'])
        self.assertEqual(len(self.store.list_snapshots()), 1)


if __name__ == '__main__':
    unittest.main()
