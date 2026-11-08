"""Atomic desktop state and Windows user-bound session encryption."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import tempfile
import uuid


def atomic_write(path, raw):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.pending-')
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


class WindowsProtector:
    """DPAPI: no raw HAR, account, or session is persisted as a credential file."""
    def _crypt(self, raw, decrypt=False):
        if os.name != 'nt':
            raise RuntimeError('会话加密保存仅支持 Windows；当前平台仅在本次运行中记住会话。')

        class Blob(ctypes.Structure):
            _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]

        buffer = ctypes.create_string_buffer(raw)
        source = Blob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
        target = Blob()
        crypt = ctypes.WinDLL('crypt32', use_last_error=True)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree.restype = ctypes.c_void_p
        func = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
        func.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD,
                         ctypes.POINTER(Blob)]
        func.restype = wintypes.BOOL
        # CRYPTPROTECT_UI_FORBIDDEN; current Windows user, no machine-wide sharing.
        if not func(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
            raise RuntimeError('无法读取或保存 Windows 加密会话，请重新导入 HAR。')
        try:
            return ctypes.string_at(target.data, target.size)
        finally:
            kernel.LocalFree(target.data)

    def protect(self, raw):
        return self._crypt(raw)

    def unprotect(self, raw):
        return self._crypt(raw, True)


class Store:
    def __init__(self, root, protector=None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.protector = protector or WindowsProtector()
        self.session_path = self.root / 'session.dpapi'
        self.state_path = self.root / 'state.json'
        self.error_path = self.root / 'last_error.log'
        self.snapshots = self.root / 'snapshots'

    def write_error_log(self, text):
        """把完整诊断写进数据目录（仅本机；用户主动发给维护者才离开这台机器）。
        含请求头/响应体片段/堆栈都可以，但调用方仍应隐去会话密钥。"""
        try:
            atomic_write(self.error_path, text.encode('utf-8', 'replace'))
            return True
        except OSError:
            return False

    def save_session(self, session):
        # Do not retain cookies, unrelated headers, or the original HAR path.
        from yyjh.capture.retrieve import COPY_HEADERS
        clean = {key: session[key] for key in
                 ('url', 'account', 'session', 'area', 'protocol_key', 'platform')}
        clean['headers'] = {k: v for k, v in session['headers'].items() if k in COPY_HEADERS}
        encrypted = self.protector.protect(json.dumps(clean).encode())
        atomic_write(self.session_path, encrypted)

    def load_session(self):
        if not self.session_path.exists():
            return None
        return json.loads(self.protector.unprotect(self.session_path.read_bytes()))

    def save_snapshot(self, data, platform, area, version):
        from datetime import datetime, timezone
        self.snapshots.mkdir(exist_ok=True)
        ident = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:10]
        pending = Path(tempfile.mkdtemp(prefix='.pending-', dir=self.snapshots))
        meta = dict(id=ident, nick=(data.get('MainRole') or {}).get('Name') or '未命名角色',
                    platform=platform, area=str(area), version=str(version), fields=len(data),
                    downloaded_at=datetime.now().astimezone().isoformat(timespec='seconds'))
        try:
            atomic_write(pending / 'dat.json', json.dumps(data, ensure_ascii=False).encode())
            atomic_write(pending / 'meta.json', json.dumps(meta, ensure_ascii=False).encode())
            os.replace(pending, self.snapshots / ident)
        finally:
            # Only discard this incomplete, newly allocated snapshot.
            if pending.exists():
                for path in pending.iterdir():
                    path.unlink()
                pending.rmdir()
        self.select(ident)
        return meta

    def list_snapshots(self):
        rows = []
        if self.snapshots.exists():
            for folder in sorted(self.snapshots.iterdir(), reverse=True):
                if folder.name.startswith('.'):
                    continue
                try:
                    meta = json.loads((folder / 'meta.json').read_text(encoding='utf-8'))
                    if meta.get('id') == folder.name and (folder / 'dat.json').is_file():
                        rows.append(meta)
                except (OSError, ValueError):
                    continue
        return rows

    def load_snapshot(self, ident):
        # Only a known snapshot identifier is accepted, never an arbitrary file path.
        if not any(row['id'] == ident for row in self.list_snapshots()):
            raise ValueError('找不到这份历史存档。')
        data = json.loads((self.snapshots / ident / 'dat.json').read_text(encoding='utf-8'))
        if not isinstance(data, dict) or not all(k in data for k in ('MainRole', 'Roles', 'Rnds')):
            raise ValueError('本地存档不完整，请选择其他历史记录或重新下载。')
        return data

    def select(self, ident):
        atomic_write(self.state_path, json.dumps(dict(selected=ident)).encode())

    def delete_snapshot(self, ident):
        rows = self.list_snapshots()
        if not any(row['id'] == ident for row in rows):
            raise ValueError('找不到这份历史存档。')
        folder = self.snapshots / ident
        if folder.is_symlink() or folder.resolve().parent != self.snapshots.resolve():
            raise ValueError('历史存档路径无效。')
        selected = self.selected()
        trash = self.root / '.deleted-snapshots'
        trash.mkdir(exist_ok=True)
        destination = trash / ident
        if destination.exists():
            raise ValueError('这份存档已存在于本地回收目录。')
        # Atomic, recoverable removal; never touch session credentials or cloud data.
        os.replace(folder, destination)
        try:
            if selected and selected['id'] == ident:
                remaining = [row for row in rows if row['id'] != ident]
                self.select(remaining[0]['id'] if remaining else None)
        except OSError:
            os.replace(destination, folder)
            raise

    def theme(self):
        try:
            value = json.loads((self.root / 'preferences.json').read_text()).get('theme')
            return value if value in ('dark', 'light') else 'dark'
        except (OSError, ValueError, AttributeError):
            return 'dark'

    def set_theme(self, theme):
        if theme not in ('dark', 'light'):
            raise ValueError('Unknown theme')
        atomic_write(self.root / 'preferences.json', json.dumps(dict(theme=theme)).encode())

    def selected(self):
        rows = self.list_snapshots()
        try:
            ident = json.loads(self.state_path.read_text())['selected']
            return next(row for row in rows if row['id'] == ident)
        except (OSError, ValueError, KeyError, StopIteration):
            return rows[0] if rows else None
