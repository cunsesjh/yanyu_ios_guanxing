"""Saved-snapshot reopening must deliver full data without game requests."""
import functools
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from yyjh import webserve


class SavedReopenTests(unittest.TestCase):
    def test_deliver_again_after_restart(self):
        sample = {'MainRole': {}, 'globalVariable': {}, 'Rnds': {'Sds': [1, 2]}}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'dat.json'
            source.write_text(json.dumps(sample), encoding='utf-8')
            row = {'json': str(source), 'meta': {'runtime': 'ios'}}
            with patch.object(webserve, 'runtime_dir', return_value=tmp), \
                    patch.object(webserve.paths, 'CACHE_DIR', str(root / 'cache')):
                handler = functools.partial(webserve.Handler, directory=webserve.web_dir())
                with webserve.socketserver.ThreadingTCPServer(('127.0.0.1', 0), handler) as server:
                    thread = threading.Thread(target=server.serve_forever, daemon=True)
                    thread.start()
                    base = 'http://127.0.0.1:%s/' % server.server_address[1]
                    try:
                        with patch.object(webserve, 'ensure_server', return_value=base), \
                                patch.object(webserve.webbrowser, 'open', return_value=True) as browser:
                            for _ in range(2):
                                self.assertTrue(webserve.open_site(row))
                                url = browser.call_args.args[0]
                                self.assertTrue(url.startswith(base + '?open='))
                                with urllib.request.urlopen(url) as response:
                                    self.assertIn(b'last-import.js', response.read())
                                delivered = webserve._served_last_import(server.server_address[1])
                                payload = json.loads(delivered.splitlines()[0].split('=', 1)[1][:-1])
                                self.assertEqual(payload['data'], sample)
                            self.assertNotEqual(browser.call_args_list[0].args, browser.call_args_list[1].args)
                        self.assertEqual(json.loads(source.read_text()), sample)
                    finally:
                        server.shutdown()
                        thread.join()


if __name__ == '__main__':
    unittest.main()
