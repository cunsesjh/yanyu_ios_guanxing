import json
from pathlib import Path
import tempfile
import unittest

from desktop.data_location import (DATA_MARKER, DataLocationUnavailable,
                                   configured_data_root, migrate_data_root, pointer_path,
                                   remove_data_root, save_configured_data_root)
from desktop.storage import Store


class FakeProtector:
    def protect(self, raw):
        return b'protected:' + raw

    def unprotect(self, raw):
        return raw.removeprefix(b'protected:')


class DataLocationTests(unittest.TestCase):
    def test_migration_verifies_files_and_pointer_survives_old_root_removal(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            local = base / 'local'
            source = local / 'iosGuanxing'
            store = Store(source, FakeProtector())
            (source / 'last_error.log').write_text('diagnostic', encoding='utf-8')
            session = {'platform': 'ios', 'area': '1', 'account': 'a', 'session': 's',
                       'url': 'https://example.test', 'protocol_key': 'k', 'headers': {}}
            session_ref = store.save_session(session)
            data = {'MainRole': {'Name': '测试'}, 'Roles': [], 'Rnds': {}}
            store.save_snapshot(data, 'ios', '1', '1', session_ref)

            target = base / 'other-drive' / 'data'
            migrate_data_root(source, target)
            self.assertTrue((target / DATA_MARKER).is_file())
            self.assertEqual(Store(target, FakeProtector()).list_snapshots()[0]['nick'], '测试')
            self.assertEqual((target / 'last_error.log').read_text(encoding='utf-8'), 'diagnostic')

            save_configured_data_root(target, local)
            self.assertEqual(configured_data_root(local), target.resolve())
            remove_data_root(source)
            self.assertFalse(source.exists())
            self.assertEqual(configured_data_root(local), target.resolve())
            self.assertTrue(pointer_path(local).is_file())

    def test_nonempty_destination_and_unmarked_delete_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            source = base / 'source'
            Store(source, FakeProtector())
            target = base / 'target'
            target.mkdir()
            (target / 'unrelated.txt').write_text('keep', encoding='utf-8')
            with self.assertRaises(ValueError):
                migrate_data_root(source, target)
            with self.assertRaises(ValueError):
                remove_data_root(target)
            self.assertTrue((target / 'unrelated.txt').is_file())

    def test_missing_custom_drive_never_falls_back_to_default_root(self):
        with tempfile.TemporaryDirectory() as folder:
            local = Path(folder) / 'local'
            missing = Path(folder) / 'removed-drive' / 'iosGuanxing'
            save_configured_data_root(missing, local)
            with self.assertRaises(DataLocationUnavailable):
                configured_data_root(local)
            self.assertNotEqual(configured_data_root(local, require_exists=False),
                                Path(local) / 'iosGuanxing')


if __name__ == '__main__':
    unittest.main()

