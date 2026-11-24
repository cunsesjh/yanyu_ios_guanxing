import hashlib
import io
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from desktop.updater import (apply_update, cleanup_stale_updates, download_update, parse_checksum,
                             sha256_file)


class Response(io.BytesIO):
    def __init__(self, raw):
        super().__init__(raw)
        self.headers = {'Content-Length': str(len(raw))}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class UpdaterTests(unittest.TestCase):
    def test_full_update_download_and_sha256_verification(self):
        executable = b'new executable bytes'
        digest = hashlib.sha256(executable).hexdigest()
        checksum = ('%s  iosGuanxing.exe\n' % digest).encode()

        def opener(request, timeout):
            return Response(checksum if request.full_url.endswith('SHA256SUMS.txt') else executable)

        with tempfile.TemporaryDirectory() as folder:
            result = download_update({
                'tag': 'v9.0.0',
                'checksum_url': 'https://example.test/SHA256SUMS.txt',
                'download_url': 'https://example.test/iosGuanxing.exe',
            }, folder, opener=opener)
            self.assertEqual(sha256_file(result['executable']), digest)
            self.assertEqual(parse_checksum(checksum), digest)

    def test_bad_checksum_removes_downloaded_executable(self):
        checksum = (('0' * 64) + '  iosGuanxing.exe\n').encode()

        def opener(request, timeout):
            return Response(checksum if request.full_url.endswith('SHA256SUMS.txt') else b'bad')

        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'SHA256'):
                download_update({'tag': 'v9.0.0', 'checksum_url': 'https://x/SHA256SUMS.txt',
                                 'download_url': 'https://x/iosGuanxing.exe'}, folder, opener=opener)
            self.assertFalse((Path(folder) / 'v9.0.0' / 'iosGuanxing.exe').exists())

    def test_cleanup_only_removes_old_update_entries(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            old = root / 'old'
            new = root / 'new'
            old.mkdir()
            new.mkdir()
            timestamp = time.time() - 10 * 86400
            old.touch()
            import os
            os.utime(old, (timestamp, timestamp))
            self.assertEqual(cleanup_stale_updates(root, 7), 1)
            self.assertFalse(old.exists())
            self.assertTrue(new.exists())

    def test_apply_waits_for_new_version_start_confirmation(self):
        class StartedProcess:
            def __init__(self, args):
                Path(args[2]).write_text('started', encoding='ascii')
            def poll(self):
                return None

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            current = root / 'installed' / 'iosGuanxing.exe'
            staged = root / 'updates' / 'v2' / 'iosGuanxing.exe'
            current.parent.mkdir()
            staged.parent.mkdir(parents=True)
            current.write_bytes(b'old')
            staged.write_bytes(b'new')
            digest = sha256_file(staged)
            with patch('desktop.updater.subprocess.Popen', side_effect=lambda args: StartedProcess(args)):
                apply_update(current, staged, digest, 123)
            self.assertEqual(current.read_bytes(), b'new')
            self.assertFalse(current.with_name('iosGuanxing.exe.previous').exists())

    def test_apply_rolls_back_when_new_version_exits_before_confirmation(self):
        class FailedProcess:
            def poll(self):
                return 1

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            current = root / 'installed' / 'iosGuanxing.exe'
            staged = root / 'updates' / 'v2' / 'iosGuanxing.exe'
            current.parent.mkdir()
            staged.parent.mkdir(parents=True)
            current.write_bytes(b'old')
            staged.write_bytes(b'new')
            with patch('desktop.updater.subprocess.Popen', return_value=FailedProcess()):
                with self.assertRaisesRegex(RuntimeError, '未能正常启动'):
                    apply_update(current, staged, sha256_file(staged), 123)
            self.assertEqual(current.read_bytes(), b'old')


if __name__ == '__main__':
    unittest.main()

