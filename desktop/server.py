"""App-owned, token-scoped loopback server for embedded pages and local journals."""
import hashlib
import http.server
import json
from pathlib import Path
import secrets
import shutil
import socketserver
import sqlite3
import tempfile
import threading
from urllib.parse import unquote, urlsplit

from .hengshan_journal import HengshanJournal


class LocalSite:
    def __init__(self, root, journal_root=None):
        self.root = Path(root).resolve()
        self.token = secrets.token_urlsafe(24)
        self.prefix = '/' + self.token + '/'
        self.payload = b''
        self.sequence_scope = self.sequence_owner = ''
        self.sequence_journal_root = journal_root
        self.sequence_journal = None
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

            def do_POST(self):
                host = '127.0.0.1:' + str(self.server.server_port)
                if self.headers.get('Host') != host or self.headers.get('Origin') != 'http://' + host:
                    self.send_error(403)
                    return
                if self.path != site.prefix + 'api/hengshan-sequence' or site.sequence_journal_root is None:
                    self.send_error(404)
                    return
                if self.headers.get_content_type() != 'application/json':
                    self.send_error(415)
                    return
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= 2 * 1024 * 1024:
                        raise ValueError('批次请求大小无效。')
                    msg = json.loads(self.rfile.read(size))
                    if not isinstance(msg, dict):
                        raise ValueError('批次请求格式无效。')
                    with site.lock:
                        if site.sequence_journal is None:
                            site.sequence_journal = HengshanJournal(site.sequence_journal_root)
                        journal, scope, owner = site.sequence_journal, site.sequence_scope, site.sequence_owner
                        if msg.get('op') != 'export':
                            result = journal.run(scope, msg, owner)
                    if msg.get('op') == 'export':
                        # Compress outside the snapshot lock. Each request keeps its
                        # original owner, and large batches spill to a temporary file.
                        with tempfile.SpooledTemporaryFile(max_size=4*1024*1024) as archive:
                            journal.export(scope, owner, msg, archive)
                            size = archive.tell()
                            archive.seek(0)
                            self.send_response(200)
                            self.send_header('Content-Type', 'application/zip')
                            self.send_header('Content-Length', str(size))
                            self.send_header('Cache-Control', 'no-store')
                            self.end_headers()
                            try:
                                shutil.copyfileobj(archive, self.wfile)
                            except (BrokenPipeError, ConnectionResetError):
                                pass
                        return
                    code = 200
                except (ValueError, KeyError, TypeError) as exc:
                    code, result = 400, dict(error=str(exc))
                except (OSError, sqlite3.Error):
                    code, result = 503, dict(error='无法读写本地断点，请检查可用空间后重试。')
                body = json.dumps(result, ensure_ascii=False).encode('utf-8')
                self.send_response(code)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
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

    def set_snapshot(self, data, platform='ios', sequence_owner=None):
        # Qt renders locally, with the same import channel as the existing web app.
        encoded = json.dumps(dict(data=data, platform=platform), ensure_ascii=True,
                             separators=(',', ':')).encode()
        with self.lock:
            self.payload = b'window.__latestPlainSave=' + encoded + b';\n'
            owner = ('account:' + str(sequence_owner)).encode() if sequence_owner else b''
            self.sequence_scope = hashlib.sha256(owner + encoded).hexdigest()
            self.sequence_owner = hashlib.sha256(owner).hexdigest() if owner else self.sequence_scope

    def clear_snapshot(self):
        with self.lock:
            self.payload = b''
            self.sequence_scope = self.sequence_owner = ''

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
