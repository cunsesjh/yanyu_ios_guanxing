"""App-owned, token-scoped loopback static server; no subprocess or disk payload."""
import http.server
import json
from pathlib import Path
import secrets
import socketserver
import threading
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
            def do_GET(self):
                expected = '127.0.0.1:' + str(self.server.server_port)
                if self.headers.get('Host') != expected:
                    self.send_error(403)
                    return
                raw = urlsplit(self.path).path
                if not raw.startswith(site.prefix):
                    self.send_error(404)
                    return
                relative = unquote(raw[len(site.prefix):]) or 'index.html'
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
