"""报错详情：GUI 文本安全但可诊断，完整诊断进本地 last_error.log。"""
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from desktop.storage import Store
from yyjh.capture import retrieve

SESSION = dict(url='http://pre.wlfy.blue8.cn/api_command', account='15751788607',
               session='s', area='1', protocol_key='k' * 16, platform='ios',
               headers={'ver': '73580', 'channel': 'lanjing_ios_pre'})


class FakeProtector:
    def protect(self, raw):
        return bytes(b ^ 0x5a for b in raw)

    def unprotect(self, raw):
        return self.protect(raw)


class FakeOpener:
    def __init__(self, exc=None, body=b'', status=200):
        self.exc, self.body, self.status = exc, body, status

    def open(self, req, timeout=None):
        if self.exc:
            raise self.exc
        body, status = self.body, self.status

        class R:
            def read(inner, n=-1):
                return body
            def __enter__(inner):
                return inner
            def __exit__(inner, *a):
                return False
        inst = R()
        inst.status = status
        return inst


class FetchErrorTests(unittest.TestCase):
    def _fetch(self, opener):
        with patch('urllib.request.build_opener', return_value=opener):
            return retrieve.fetch(SESSION)

    def test_http_error_reports_status_and_keeps_detail(self):
        exc = urllib.error.HTTPError(SESSION['url'], 302, 'Found',
                                     {'Location': 'https://waf.example/challenge'},
                                     None)
        exc.read = lambda n=-1: b'<html>WAF challenge acc=15751788607</html>'
        with self.assertRaises(retrieve.FetchError) as ctx:
            self._fetch(FakeOpener(exc=exc))
        msg = str(ctx.exception)
        self.assertIn('HTTP 302', msg)                 # 状态码进 GUI 文本
        self.assertIn('waf.example', msg)              # 只给重定向主机，不给完整 URL
        self.assertNotIn('waf.example/challenge', msg)  # 完整 URL 不进 GUI 文本
        self.assertIn('302', ctx.exception.detail)      # 详情进 detail
        self.assertIn('Location', ctx.exception.detail)

    def test_network_error_names_the_real_cause(self):
        exc = urllib.error.URLError(TimeoutError('timed out'))
        with self.assertRaises(retrieve.FetchError) as ctx:
            self._fetch(FakeOpener(exc=exc))
        self.assertIn('TimeoutError', str(ctx.exception))
        self.assertIn('pre.wlfy.blue8.cn', str(ctx.exception))
        self.assertIn('timed out', ctx.exception.detail)

    def test_non_json_response_includes_snippet_in_detail_only(self):
        with self.assertRaises(retrieve.FetchError) as ctx:
            self._fetch(FakeOpener(body=b'<html>502 Bad Gateway</html>'))
        self.assertIn('JSON', str(ctx.exception))
        self.assertIn('502 Bad Gateway', ctx.exception.detail)

    def test_snippet_masks_long_digit_runs(self):
        masked = retrieve._snippet(b'account 15751788607 and 123456')
        self.assertIn('157*****', masked.replace('*', '*'))
        self.assertNotIn('15751788607', masked)
        self.assertIn('123456', masked)                # 6 位及以下不遮

    def test_session_failure_reports_har_diagnostics(self):
        har = {'log': {'entries': [
            {'request': {'url': 'http://pre.wlfy.blue8.cn/api_command',
                         'headers': [{'name': 'command', 'value': 'lookmail'},
                                     {'name': 'acc', 'value': 'x'}]},
             'response': {'status': 200, 'headers': [], 'content': {'text': '{}'}}}]}}
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'a.har'
            p.write_text(json.dumps(har), encoding='utf-8')
            with self.assertRaises(ValueError) as ctx:
                retrieve.session_from_har(p)
        self.assertIn('共 1 条记录', str(ctx.exception))
        self.assertIn('k 响应头 0 处', str(ctx.exception))


class ErrorLogTests(unittest.TestCase):
    def test_write_error_log_and_gui_hint(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(tmp, FakeProtector())
            ok = store.write_error_log('diag 详情')
            self.assertTrue(ok)
            self.assertEqual((Path(tmp) / 'last_error.log').read_text(encoding='utf-8'),
                             'diag 详情')

    def test_fetch_error_is_value_error_for_gui(self):
        # GUI 分支靠 isinstance(error, ValueError) 取可读文本
        self.assertTrue(issubclass(retrieve.FetchError, ValueError))


if __name__ == '__main__':
    unittest.main()
