# Windows x64, one executable, no console window.
from pathlib import Path

root = Path(SPECPATH)
a = Analysis([str(root / 'desktop_main.py')], pathex=[str(root)],
             binaries=[], datas=[(str(root / 'web'), 'web'), (str(root / 'assets'), 'assets'),
                                 (str(root / 'keys.json'), '.')],
             hiddenimports=[], hookspath=[], hooksconfig={}, runtime_hooks=[],
             excludes=['tkinter', 'PyQt5', 'PyQt6'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name='iosGuanxing',
          debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
          console=False, disable_windowed_traceback=False,
          icon=str(root / 'assets' / 'iosGuanxing.ico'))
