"""Atomic desktop state and Windows user-bound session encryption."""
import ctypes
from ctypes import wintypes
import hashlib
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
        self.sessions = self.root / 'sessions'
        self.state_path = self.root / 'state.json'
        self.snapshots = self.root / 'snapshots'

    @staticmethod
    def session_ref(session):
        identity = '|'.join((
            str(session.get('platform', '')).strip().lower(),
            str(session.get('area', '')).strip().lower(),
            str(session.get('account', '')).strip().lower(),
        ))
        if identity == '||':
            raise ValueError('登录会话缺少账号信息。')
        return hashlib.sha256(identity.encode('utf-8')).hexdigest()[:32]

    def session_file(self, session_ref):
        if not isinstance(session_ref, str) or len(session_ref) != 32 \
                or any(char not in '0123456789abcdef' for char in session_ref):
            raise ValueError('登录会话引用无效。')
        return self.sessions / (session_ref + '.dpapi')

    def save_session(self, session):
        # Do not retain cookies, unrelated headers, or the original HAR path.
        from yyjh.capture.retrieve import COPY_HEADERS
        clean = {key: session[key] for key in
                 ('url', 'account', 'session', 'area', 'protocol_key', 'platform')}
        clean['headers'] = {k: v for k, v in session['headers'].items() if k in COPY_HEADERS}
        encrypted = self.protector.protect(json.dumps(clean).encode())
        session_ref = self.session_ref(clean)
        atomic_write(self.session_file(session_ref), encrypted)
        return session_ref

    def load_session(self, session_ref=None):
        if session_ref:
            path = self.session_file(session_ref)
            if not path.exists():
                return None
            return json.loads(self.protector.unprotect(path.read_bytes()))
        # One-time compatibility with releases that only kept the latest session.
        if self.session_path.exists():
            session = json.loads(self.protector.unprotect(self.session_path.read_bytes()))
            self.save_session(session)
            return session
        return None

    def session_for_snapshot(self, row, data=None):
        session_ref = row.get('session_ref')
        if session_ref:
            return self.load_session(session_ref)
        # Old snapshots did not record a reference. Match their EncryptID to a
        # migrated legacy session without exposing the account in meta.json.
        data = data if data is not None else self.load_snapshot(row['id'])
        account = data.get('EncryptID') if isinstance(data, dict) else None
        if account:
            derived = self.session_ref(dict(platform=row.get('platform'), area=row.get('area'),
                                            account=account))
            session = self.load_session(derived)
            if session:
                return session
        legacy = self.load_session()
        if legacy and account and self.session_ref(legacy) == self.session_ref(dict(
                platform=row.get('platform'), area=row.get('area'), account=account)):
            return legacy
        return None

    def save_snapshot(self, data, platform, area, version, session_ref=None):
        from datetime import datetime, timezone
        self.snapshots.mkdir(exist_ok=True)
        ident = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:10]
        pending = Path(tempfile.mkdtemp(prefix='.pending-', dir=self.snapshots))
        meta = dict(id=ident, nick=(data.get('MainRole') or {}).get('Name') or '未命名角色',
                    platform=platform, area=str(area), version=str(version), fields=len(data),
                    downloaded_at=datetime.now().astimezone().isoformat(timespec='seconds'))
        if session_ref:
            self.session_file(session_ref)  # Validate before persisting metadata.
            meta['session_ref'] = session_ref
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

    def preferences(self):
        try:
            value = json.loads((self.root / 'preferences.json').read_text(encoding='utf-8'))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError, AttributeError):
            return {}

    def update_preferences(self, **changes):
        value = self.preferences()
        value.update(changes)
        atomic_write(self.root / 'preferences.json',
                     json.dumps(value, ensure_ascii=False, sort_keys=True).encode('utf-8'))

    def theme(self):
        value = self.preferences().get('theme')
        if value not in ('dark', 'light'):
            return 'dark'
        return value

    def set_theme(self, theme):
        if theme not in ('dark', 'light'):
            raise ValueError('Unknown theme')
        self.update_preferences(theme=theme)

    def release_notes_seen(self, version):
        return self.preferences().get('release_notes_seen') == str(version)

    def mark_release_notes_seen(self, version):
        if not str(version).strip():
            raise ValueError('Unknown release notes version')
        self.update_preferences(release_notes_seen=str(version))

    def selected(self):
        rows = self.list_snapshots()
        try:
            ident = json.loads(self.state_path.read_text())['selected']
            return next(row for row in rows if row['id'] == ident)
        except (OSError, ValueError, KeyError, StopIteration):
            return rows[0] if rows else None
