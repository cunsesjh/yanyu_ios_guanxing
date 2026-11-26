"""App-owned, token-scoped loopback static server; no subprocess or disk payload."""
import http.server
import json
from pathlib import Path
import secrets
import socketserver
import threading
import os
import shutil
import subprocess
from urllib.parse import unquote, urlsplit


class LocalSite:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.token = secrets.token_urlsafe(24)
        self.prefix = '/' + self.token + '/'
        self.payload = b''
        self.theme = 'dark'
        self.lock = threading.Lock()
        site = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def _relative_path(self):
                expected = '127.0.0.1:' + str(self.server.server_port)
                raw = urlsplit(self.path).path
                if self.headers.get('Host') != expected:
                    return 403, None
                if not raw.startswith(site.prefix):
                    return 404, None
                return None, unquote(raw[len(site.prefix):]).lstrip('/')

            def do_POST(self):
                error_status, relative = self._relative_path()
                if error_status:
                    self.send_error(error_status)
                    return
                if relative != 'api/awash/search':
                    self.send_error(404)
                    return
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if length <= 0 or length > 8 * 1024 * 1024:
                        raise ValueError('invalid request size')
                    result = site.run_awash(self.rfile.read(length))
                    body = json.dumps(result, ensure_ascii=True, separators=(',', ':')).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Cache-Control', 'no-store')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except Exception as error:
                    body = json.dumps({'ok': False, 'status': 'error', 'error': str(error)}).encode()
                    self.send_response(500)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

            def do_GET(self):
                error_status, relative = self._relative_path()
                if error_status:
                    self.send_error(error_status)
                    return
                if relative.startswith('api/'):
                    self.send_error(404)
                    return
                relative = relative or 'index.html'
                target = (site.root / relative).resolve()
                if site.root not in target.parents or not target.is_file():
                    self.send_error(404)
                    return
                mime = {'.js': 'application/javascript', '.mjs': 'application/javascript',
                        '.wasm': 'application/wasm', '.json': 'application/json',
                        '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml'}.get(target.suffix)
                if mime is None:
                    import mimetypes
                    mime = mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
                try:
                    body = target.read_bytes()
                    if relative == 'last-import.js':
                        with site.lock:
                            body = site.payload + body
                    elif target.suffix.lower() == '.html':
                        marker = b'</head>'
                        prefix = site.prefix.encode('ascii')
                        theme = (b'<link rel="stylesheet" href="' + prefix + b'desktop-theme.css">'
                                 b'<link rel="stylesheet" href="' + prefix + b'desktop-light.css">'
                                 b'<script>document.documentElement.dataset.theme="' + site.theme.encode('ascii') + b'";</script>'
                                 b'<script defer src="' + prefix + b'desktop-ui.js"></script>')
                        position = body.lower().find(marker)
                        if position >= 0:
                            body = body[:position] + theme + body[position:]
                except OSError:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass  # The random URL and save contents never enter access logs.

        class LoopbackServer(http.server.ThreadingHTTPServer):
            def server_bind(self):
                # HTTPServer's getfqdn() can block startup on reverse DNS.
                socketserver.TCPServer.server_bind(self)
                self.server_name = '127.0.0.1'
                self.server_port = self.server_address[1]

        self.httpd = LoopbackServer(('127.0.0.1', 0), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.origin = 'http://127.0.0.1:' + str(self.httpd.server_port)
        self.url = self.origin + self.prefix

    def run_awash(self, payload):
        root = self.root.parent
        runner = root / 'awash_runner.js'
        if not runner.is_file():
            raise RuntimeError('AWASH 求解器未随程序安装')
        node = os.environ.get('IOSGUANXING_NODE') or shutil.which('node')
        if not node:
            bundled = root / 'node' / ('node.exe' if os.name == 'nt' else 'node')
            node = str(bundled) if bundled.is_file() else None
        if not node:
            raise RuntimeError('当前程序缺少内置 Node 运行时')
        completed = subprocess.run([node, str(runner)], input=payload,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   cwd=str(root), timeout=900, check=False)
        if not completed.stdout:
            detail = completed.stderr.decode('utf-8', 'replace')[-1000:]
            raise RuntimeError(detail or 'AWASH 求解器没有返回结果')
        result = json.loads(completed.stdout.decode('utf-8'))
        if completed.returncode and result.get('status') != 'no-route':
            raise RuntimeError(result.get('error') or 'AWASH 求解器执行失败')
        return result

    def set_snapshot(self, data, platform='ios'):
        # Qt renders locally, with the same import channel as the existing web app.
        encoded = json.dumps(dict(data=data, platform=platform), ensure_ascii=True,
                             separators=(',', ':')).encode()
        with self.lock:
            self.payload = b'window.__latestPlainSave=' + encoded + b';\n'

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
