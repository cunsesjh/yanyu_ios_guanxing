# -*- coding: utf-8 -*-
"""路径解析：定位工作区、数据目录、输出目录、adb。

支持环境变量覆盖（方便换机器）:
    YYJH_WORKSPACE   工作区根目录
    YYJH_ADB         adb 可执行文件
    YYJH_SERIAL      设备 serial
"""
import os
import re
import sys

# tool_1.1/yyjh/config/paths.py
_THIS = os.path.abspath(__file__)
YYJH_PKG = os.path.dirname(os.path.dirname(_THIS))      # .../tool_1.1/yyjh
FROZEN = getattr(sys, 'frozen', False)
if FROZEN:
    # exe 打包：网页资源在包内（webserve 走 sys._MEIPASS 找 web/）。
    # 生成物（keys.json / output/）统一放 %LOCALAPPDATA%\yanyu-guanxing\，
    # exe 所在目录（桌面等）保持干净 —— 2026-10 起的新约定。
    TOOL_DIR = os.path.dirname(os.path.abspath(sys.executable))
    USER_DIR = os.environ.get('YYJH_USER_DIR') or os.path.join(
        os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'),
        'yanyu-guanxing')
else:
    TOOL_DIR = os.path.dirname(YYJH_PKG)                # .../tool_1.1
    USER_DIR = TOOL_DIR                                 # 开发模式照旧放工具目录
WORKSPACE = os.environ.get('YYJH_WORKSPACE') or (
    USER_DIR if FROZEN else os.path.dirname(TOOL_DIR))

DATA_DIR = os.path.join(WORKSPACE, 'data')
OUT_DIR = os.path.join(USER_DIR, 'output')     # 所有生成物都落在这里
# 中间产物（内存候选缓存之类）不乱丢，单独放
CACHE_DIR = os.path.join(OUT_DIR, '_cache')
DOCS_DIR = os.path.join(WORKSPACE, 'docs')

# 用户自定义密钥覆盖文件（可选），格式见 keytables.py
#
# 拆成两个文件的理由（重要）：
#   keys.json       —— 内层密钥表。**可以分享/提交/从别人那拉一份覆盖**，换机器照样用。
#   keys.local.json —— 本机信息（adb 路径/设备/包名）+ 外层密钥（跟账号绑），
#                      属于"不该给别人"的东西，已加进 .gitignore。
KEYS_FILE = os.path.join(USER_DIR, 'keys.json')


def _migrate_legacy_files():
    """旧版把 keys*.json / output/ 放在 exe 旁边 —— 首次运行搬进 USER_DIR。"""
    if not FROZEN or os.path.abspath(USER_DIR) == os.path.abspath(TOOL_DIR):
        return
    try:
        os.makedirs(USER_DIR, exist_ok=True)
    except OSError:
        return
    import shutil
    for name in ('keys.json', 'keys.local.json', 'keys.user.json'):
        src = os.path.join(TOOL_DIR, name)
        dst = os.path.join(USER_DIR, name)
        if os.path.exists(src) and not os.path.exists(dst):
            try:
                shutil.move(src, dst)
            except OSError:
                try:
                    shutil.copy2(src, dst)
                except OSError:
                    pass
    src_out = os.path.join(TOOL_DIR, 'output')
    dst_out = os.path.join(USER_DIR, 'output')
    if os.path.isdir(src_out) and not os.path.isdir(dst_out):
        try:
            shutil.move(src_out, dst_out)
        except OSError:
            pass


_migrate_legacy_files()
if FROZEN:
    # 首次运行：把打包内置的 keys.json 释放到用户目录（之后可自行更新/分享）；
    # 升级运行：内置表里**新增**的密钥合并进用户表 —— 只增不改，
    # 不碰用户自己挖到/导入的条目，否则老安装永远拿不到新版本密钥。
    import shutil
    _bundled_keys = os.path.join(getattr(sys, '_MEIPASS', ''), 'keys.json')
    if os.path.exists(_bundled_keys):
        try:
            os.makedirs(USER_DIR, exist_ok=True)
            if not os.path.exists(KEYS_FILE):
                shutil.copy2(_bundled_keys, KEYS_FILE)
            else:
                import json as _json
                with open(_bundled_keys, encoding='utf-8') as f:
                    _b = _json.load(f)
                with open(KEYS_FILE, encoding='utf-8') as f:
                    _u = _json.load(f)
                _rows_u = _u.setdefault('inner_keys', [])
                _have = {(r.get('runtime'), r.get('version')) for r in _rows_u}
                _new = [r for r in (_b.get('inner_keys') or [])
                        if (r.get('runtime'), r.get('version')) not in _have]
                if _new:
                    _rows_u.extend(_new)
                    with open(KEYS_FILE, 'w', encoding='utf-8') as f:
                        _json.dump(_u, f, ensure_ascii=False, indent=2)
        except OSError:
            pass
        except ValueError:                                 # noqa: PERF203 表坏了不挡启动
            pass
LOCAL_FILE = os.path.join(USER_DIR, 'keys.local.json')
USER_KEYS = KEYS_FILE                 # 兼容旧名字
# 早期把两样东西混在一个文件里，第一次运行会自动拆开（原文件改名保留）
LEGACY_KEYS = os.path.join(USER_DIR, 'keys.user.json')

# 设备相关：这里是**可选的显式覆盖**，真正的自动发现在 memscan.adb.find_adb()
# （会依次看 --adb / YYJH_ADB / keys.local.json / PATH / 常见安装位置 / 模拟器自带）
ADB = os.environ.get('YYJH_ADB') or ''
SERIAL = os.environ.get('YYJH_SERIAL') or ''
DEVICE_TMP = '/sdcard/_yyjh.bin'

# 设备上存档的位置模板（`{pkg}` 会被换包名）。
# 前两个是正常位置，后两个是部分模拟器的目录映射。
REMOTE_SAVE_ROOTS = (
    '/data/data/{pkg}/files',
    '/data/user/0/{pkg}/files',
    '/sdcard/Android/data/{pkg}/files',
    '/mnt/shared/MuMuShared/{pkg}/files',
)
# 存档文件的 glob（相对上面的 root）
REMOTE_SAVE_GLOB = '*/server*/dat.db'


def canon_remote(p):
    """把 `/data/user/0/<pkg>/…` 归一成 `/data/data/<pkg>/…`。

    两者在设备上是**同一个文件**（前者是后者的软链），不归一的话
    候选列表里会出现两份看起来一模一样的存档。
    """
    if not p:
        return p
    return p.replace('/data/user/0/', '/data/data/')


def ensure_dir(p):
    os.makedirs(p, exist_ok=True)
    return p


def resolve(p, base=None):
    """相对路径解析。

    优先级: 当前工作目录 -> base（默认工作区根）。
    这样在 tool_1.1 目录里敲 `..\\data\\x.har` 和在别处敲 `data\\x.har` 都对。
    """
    if not p:
        return p
    p = os.path.expanduser(p)
    if os.path.isabs(p):
        return p
    if base is None and os.path.exists(p):
        return os.path.abspath(p)
    return os.path.normpath(os.path.join(base or WORKSPACE, p))


def resolve_out(p):
    """输出路径解析：**一律相对当前工作目录**（不想 input 那样去猜工作区）。

    输入用 resolve()（会尝试已有文件），输出用这个，避免
    `--outdir out\\x` 被解析到工作区根而不是当前目录。
    """
    if not p:
        return p
    p = os.path.expanduser(p)
    if os.path.isabs(p):
        return p
    return os.path.abspath(p)


def rel(p, base=None):
    try:
        return os.path.relpath(p, base or WORKSPACE)
    except ValueError:
        return p


# ───────────────────── 设备路径识别 ─────────────────────
# `/data/data/.../dat.db` 或 `127.0.0.1:7555:/data/data/.../dat.db`
# （后者是常见的"从模拟器里的文件管理器复制出来的路径"写法）
_DEV_PATH = re.compile(r'^(?:(?P<serial>[A-Za-z0-9_.\-]+:\d{2,5}):)?(?P<path>/.*)$')


def parse_device_path(s):
    """看着像不像**设备上**的路径。是就返回 (serial|None, remote)，不是返回 None。

    注意要排除 Windows 盘符（`C:\\...`）：
        `C:\\x`       -> None（本地）
        `/data/x`     -> (None, '/data/x')
        `127.0.0.1:7555:/data/x` -> ('127.0.0.1:7555', '/data/x')
    """
    s = strip_quotes(s)
    if not s:
        return None
    if re.match(r'^[A-Za-z]:[\\/]', s):      # Windows 盘符
        return None
    m = _DEV_PATH.match(s)
    return (m.group('serial'), m.group('path')) if m else None


def strip_quotes(s):
    """去掉拖拽/复制粘贴常见的包裹引号。

    把文件拖进 cmd / PowerShell 窗口时会得到 `"C:\\a b\\dat.db"` 甚至
    `'C:\\a b\\dat.db'`，原样传给 argparse 会报"找不到文件"。
    """
    if s is None:
        return s
    s = str(s).strip()
    for q in ('"', "'"):
        if len(s) >= 2 and s[0] == q and s[-1] == q:
            s = s[1:-1].strip()
            break
    return s
