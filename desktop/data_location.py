"""Resolve and migrate the desktop data directory without hiding missing drives."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import uuid


POINTER_NAME = 'iosGuanxing-location.json'
DATA_MARKER = '.iosguanxing-data'


class DataLocationUnavailable(OSError):
    pass


def default_data_root(local_app_data=None):
    base = local_app_data or os.environ.get('LOCALAPPDATA') or Path.home()
    return Path(base).expanduser().resolve() / 'iosGuanxing'


def pointer_path(local_app_data=None):
    base = Path(local_app_data or os.environ.get('LOCALAPPDATA') or Path.home()).expanduser().resolve()
    return base / POINTER_NAME


def configured_data_root(local_app_data=None, require_exists=True):
    default = default_data_root(local_app_data)
    pointer = pointer_path(local_app_data)
    try:
        payload = json.loads(pointer.read_text(encoding='utf-8'))
        configured = Path(payload['data_root']).expanduser()
        if not configured.is_absolute():
            raise ValueError('data_root must be absolute')
        configured = configured.resolve()
    except FileNotFoundError:
        return default
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise DataLocationUnavailable('数据目录配置损坏，请重新选择数据存储位置。') from error
    if require_exists and not configured.is_dir():
        raise DataLocationUnavailable('已配置的数据目录不可用：%s' % configured)
    return configured


def _atomic_json(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.location-', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(payload, stream, ensure_ascii=False, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save_configured_data_root(root, local_app_data=None):
    root = Path(root).expanduser().resolve()
    if not root.is_absolute():
        raise ValueError('数据目录必须是绝对路径。')
    _atomic_json(pointer_path(local_app_data), {'data_root': str(root)})


def mark_data_root(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    marker = root / DATA_MARKER
    if not marker.exists():
        marker.write_text('iosGuanxing desktop data\n', encoding='utf-8')


def _file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _manifest(root):
    root = Path(root)
    return {
        str(path.relative_to(root)).replace(os.sep, '/'): (path.stat().st_size, _file_digest(path))
        for path in root.rglob('*')
        if path.is_file() and '.deleted-snapshots' not in path.parts
    }


def migrate_data_root(source, target):
    source = Path(source).expanduser().resolve()
    target = Path(target).expanduser().resolve()
    if source == target:
        raise ValueError('新旧数据目录相同。')
    if source in target.parents or target in source.parents:
        raise ValueError('新数据目录不能位于旧数据目录内部或外层。')
    if not source.is_dir() or not (source / DATA_MARKER).is_file():
        raise ValueError('当前数据目录缺少应用标记，不能迁移。')
    if target.exists() and any(target.iterdir()):
        raise ValueError('目标文件夹必须为空。')
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.parent / ('.iosGuanxing-migration-' + uuid.uuid4().hex)
    try:
        shutil.copytree(source, staging, ignore=shutil.ignore_patterns('.deleted-snapshots'))
        mark_data_root(staging)
        if _manifest(source) != _manifest(staging):
            raise OSError('迁移后的文件校验不一致。')
        if target.exists():
            target.rmdir()
        os.replace(staging, target)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    return target


def remove_data_root(root):
    root = Path(root).expanduser().resolve()
    if not root.is_dir() or not (root / DATA_MARKER).is_file():
        raise ValueError('拒绝删除未经识别的数据目录。')
    if root == root.parent or root == Path(root.anchor):
        raise ValueError('拒绝删除磁盘根目录。')
    shutil.rmtree(root)

