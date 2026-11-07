"""A decoded HAR does not require an attached Android device."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from yyjh import layer2, model
from yyjh.__main__ import build_parser


class CaptureMemoryTests(unittest.TestCase):
    def capture(self, mode='auto', key=''):
        result = model.SaveResult(runtime='ios', account='test')
        result.data = {'MainRole': {}, 'globalVariable': {}, 'Rnds': {'Sds': [1]}}
        result.outer_key = key
        with tempfile.NamedTemporaryFile(suffix='.har') as har:
            args = build_parser().parse_args(['capture', har.name, '--mem', mode])
            with patch('yyjh.capture.decode.decode', return_value=result), \
                    patch.object(layer2, '_mem_outer_key', return_value=(None, 'adb 里没有任何设备')) as memory, \
                    patch.object(layer2.keytables, 'remember_outer_key') as remember, \
                    patch.object(layer2, '_finish', side_effect=lambda res, args: res):
                self.assertIs(layer2.pipeline_capture(args), result)
        return result, memory, remember

    def test_default_har_does_not_probe_adb_or_warn(self):
        result, memory, remember = self.capture()
        memory.assert_not_called()
        remember.assert_not_called()
        self.assertFalse(result.warnings)
        self.assertIn('Sds', result.data['Rnds'])

    def test_har_key_is_still_remembered_without_adb(self):
        result, memory, remember = self.capture(key='test-key')
        memory.assert_not_called()
        remember.assert_called_once_with('test', 'test-key', save_id=result.save_id)

    def test_explicit_memory_request_keeps_failure_warning(self):
        result, memory, _ = self.capture(mode='force')
        memory.assert_called_once()
        self.assertTrue(any('没拿到外层密钥' in warning for warning in result.warnings))


if __name__ == '__main__':
    unittest.main()
