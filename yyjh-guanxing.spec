# -*- mode: python ; coding: utf-8 -*-
# PyInstaller 打包配置 —— 单文件 exe（控制台）。
#
#   python -m PyInstaller yyjh-guanxing.spec --noconfirm
#
# 产物 dist/ios观星.exe 自包含：
#   · Python 工具全套（向导 / 解密 / 挖密钥）
#   · web/ 网页版整站（不带 web/bin/node.exe —— 服务已用 Python 实现，不需要 Node）
#   · adb/ platform-tools（构建时放入；运行时 find_adb() 会自动用它）
#   · keys.json（首次运行自动释放到 %LOCALAPPDATA%\yanyu-guanxing\）

import os

ROOT = os.path.dirname(os.path.abspath(SPEC))


def tree(src, dst, skip_names=(), skip_dirs=()):
    out = []
    base = os.path.join(ROOT, src)
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for f in files:
            if f in skip_names:
                continue
            p = os.path.join(root, f)
            rel = os.path.relpath(p, base)
            out.append((p, os.path.join(dst, os.path.dirname(rel))))
    return out


datas = tree('web', 'web',
             skip_names={'.DS_Store', 'node.exe', '_autoload_last.html'},
             skip_dirs={'bin', '__pycache__', 'convert', 'license', 'downloads'})
datas += tree('adb', 'adb')
datas += [(os.path.join(ROOT, 'keys.json'), '.')]

# favicon 不在包里就不用图标（仓库里没这个文件也能打包）
_ICON = os.path.join(ROOT, 'web', 'favicon.ico')

hiddenimports = [
    'yyjh', 'yyjh.config', 'yyjh.core', 'yyjh.game', 'yyjh.localdb',
    'yyjh.memscan', 'yyjh.capture', 'yyjh.unpack', 'yyjh.reverse',
    'tqdm', 'xxtea', 'elftools', 'capstone',
]

a = Analysis(
    [os.path.join(ROOT, 'run.py')],
    pathex=[ROOT],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter'],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='ios观星',
    icon=_ICON if os.path.exists(_ICON) else None,
    console=True,          # 控制台形态：向导是交互式的
    disable_windowed_traceback=False,
    upx=False,
)
# v2.6-版本号对齐
