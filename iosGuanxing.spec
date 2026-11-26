# Windows x64, one executable, no console window.
from pathlib import Path
import shutil

root = Path(SPECPATH)


def collect_runtime_tree(source_root, destination_root, excluded_paths=(), excluded_suffixes=()):
    """Collect runtime files while keeping development-only files out of releases."""
    excluded_paths = {Path(path) for path in excluded_paths}
    datas = []
    for source in sorted(source_root.rglob('*')):
        if not source.is_file():
            continue
        relative = source.relative_to(source_root)
        if any(relative == path or path in relative.parents for path in excluded_paths):
            continue
        if source.suffix.lower() in excluded_suffixes:
            continue
        datas.append((str(source), str(Path(destination_root) / relative.parent)))
    return datas


web_datas = collect_runtime_tree(
    root / 'web',
    'web',
    excluded_paths=('README.md', 'serve.js', 'tools'),
    excluded_suffixes=('.bak', '.lnk'),
)

awash_datas = collect_runtime_tree(root / 'awash', 'awash')
awash_runner = [(str(root / 'awash_runner.js'), '.')]
node_executable = shutil.which('node')
if not node_executable:
    raise RuntimeError('Building iosGuanxing requires Node.js to bundle the AWASH runtime')
awash_runner.append((node_executable, 'node'))

a = Analysis([str(root / 'desktop_main.py')], pathex=[str(root)],
             binaries=[], datas=web_datas + awash_datas + awash_runner + [(str(root / 'assets' / 'iosGuanxing.png'), 'assets'),
                                             (str(root / 'keys.json'), '.')],
             hiddenimports=[], hookspath=[], hooksconfig={}, runtime_hooks=[],
             excludes=['tkinter', 'PyQt5', 'PyQt6'], noarchive=False)

# Qt's hook includes every Chromium locale. The application is Chinese and
# Chromium still needs en-US as its fallback locale.
webengine_locales = {'en-US.pak', 'zh-CN.pak'}
a.datas[:] = [
    item for item in a.datas
    if 'qtwebengine_locales' not in Path(item[0]).parts or Path(item[0]).name in webengine_locales
]

pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name='iosGuanxing',
          debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
          console=False, disable_windowed_traceback=False,
          icon=str(root / 'assets' / 'iosGuanxing.ico'))
