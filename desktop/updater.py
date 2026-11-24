"""Download, verify, apply, roll back, and clean full Windows executable updates."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid


ASSET_NAME = 'iosGuanxing.exe'
CHECKSUM_NAME = 'SHA256SUMS.txt'
MAX_UPDATE_BYTES = 2 * 1024 * 1024 * 1024


def parse_checksum(raw, asset_name=ASSET_NAME):
    text = raw.decode('utf-8-sig') if isinstance(raw, bytes) else str(raw)
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) >= 2 and parts[-1].lstrip('*') == asset_name:
            value = parts[0].lower()
            if len(value) == 64 and all(char in '0123456789abcdef' for char in value):
                return value
    raise ValueError('更新校验文件中没有有效的 iosGuanxing.exe SHA256。')


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def download_file(url, destination, opener, progress=lambda received, total: None):
    import urllib.request
    request = urllib.request.Request(url, headers={
        'Accept': 'application/octet-stream',
        'User-Agent': 'iosGuanxing-updater',
    })
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + '.part')
    received = 0
    try:
        with opener(request, timeout=45) as response, temporary.open('wb') as output:
            total = int(response.headers.get('Content-Length') or 0)
            if total > MAX_UPDATE_BYTES:
                raise ValueError('更新文件异常大，已停止下载。')
            if total and shutil.disk_usage(destination.parent).free < total + 100 * 1024 * 1024:
                raise OSError('数据盘剩余空间不足，无法下载更新。')
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                received += len(chunk)
                if received > MAX_UPDATE_BYTES:
                    raise ValueError('更新文件超过安全大小限制。')
                output.write(chunk)
                progress(received, total)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return destination


def download_update(release, updates_root, opener=None, progress=lambda received, total: None):
    import urllib.request
    opener = opener or urllib.request.urlopen
    folder = Path(updates_root) / str(release['tag']).replace('/', '_')
    folder.mkdir(parents=True, exist_ok=True)
    checksum_path = download_file(release['checksum_url'], folder / CHECKSUM_NAME, opener)
    expected = parse_checksum(checksum_path.read_bytes())
    executable = download_file(release['download_url'], folder / ASSET_NAME, opener, progress)
    actual = sha256_file(executable)
    if actual != expected:
        executable.unlink(missing_ok=True)
        raise ValueError('新版程序 SHA256 校验失败，已删除下载文件。')
    return {'executable': executable, 'sha256': expected, 'folder': folder}


def cleanup_stale_updates(updates_root, max_age_days=7, preserve=()):
    root = Path(updates_root)
    if not root.is_dir():
        return 0
    cutoff = time.time() - max_age_days * 86400
    preserved = {Path(path).resolve() for path in preserve}
    removed = 0
    for child in root.iterdir():
        try:
            if child.resolve() in preserved or child.stat().st_mtime >= cutoff:
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
            removed += 1
        except OSError:
            continue
    return removed


def wait_for_process_exit(pid, timeout=120):
    if os.name != 'nt':
        return
    import ctypes
    synchronize = 0x00100000
    handle = ctypes.windll.kernel32.OpenProcess(synchronize, False, int(pid))
    if not handle:
        return
    try:
        result = ctypes.windll.kernel32.WaitForSingleObject(handle, int(timeout * 1000))
        if result == 0x00000102:
            raise TimeoutError('等待旧版程序退出超时。')
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def apply_update(current_executable, staged_executable, expected_sha256, old_pid):
    current = Path(current_executable).resolve()
    staged = Path(staged_executable).resolve()
    if sha256_file(staged) != expected_sha256:
        raise ValueError('待安装程序校验失败。')
    wait_for_process_exit(old_pid)
    backup = current.with_name(current.name + '.previous')
    incoming = current.with_name(current.name + '.updating')
    backup.unlink(missing_ok=True)
    incoming.unlink(missing_ok=True)
    if current.exists():
        os.replace(current, backup)
    try:
        shutil.copy2(staged, incoming)
        if sha256_file(incoming) != expected_sha256:
            raise ValueError('安装后的程序校验失败。')
        os.replace(incoming, current)
        marker = staged.parent / ('.started-' + uuid.uuid4().hex)
        process = subprocess.Popen([str(current), '--confirm-update', str(marker), str(staged.parent)])
        deadline = time.time() + 30
        while time.time() < deadline:
            if marker.is_file():
                try:
                    backup.unlink(missing_ok=True)
                except OSError:
                    pass
                marker.unlink(missing_ok=True)
                return
            if process.poll() is not None:
                raise RuntimeError('新版程序未能正常启动。')
            time.sleep(0.25)
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        raise RuntimeError('新版程序启动确认超时。')
    except Exception:
        incoming.unlink(missing_ok=True)
        current.unlink(missing_ok=True)
        if backup.exists():
            os.replace(backup, current)
        raise


def launch_update_helper(staged_executable, expected_sha256):
    if os.name != 'nt' or not getattr(sys, 'frozen', False):
        raise RuntimeError('自动安装只支持已打包的 Windows 桌面版。')
    staged = Path(staged_executable).resolve()
    current = Path(sys.executable).resolve()
    probe = current.parent / '.iosGuanxing-write-test'
    try:
        probe.write_bytes(b'')
        probe.unlink()
    except OSError as error:
        raise RuntimeError('程序所在目录不可写，请将 EXE 移到可写目录后重试。') from error
    if shutil.disk_usage(current.parent).free < staged.stat().st_size + 100 * 1024 * 1024:
        raise RuntimeError('程序所在磁盘剩余空间不足，无法安装更新。')
    subprocess.Popen([
        str(staged), '--apply-update', str(current), str(staged), expected_sha256, str(os.getpid()),
    ], close_fds=True)


def cleanup_successful_update(stage_folder, backup_path=None):
    for _ in range(10):
        try:
            if backup_path:
                Path(backup_path).unlink(missing_ok=True)
            shutil.rmtree(stage_folder, ignore_errors=False)
            return True
        except OSError:
            time.sleep(0.5)
    return False

