# -*- coding: utf-8 -*-
"""网页版（web/）本地服务 + 存档自动导入（guanxing4.0 新网页，纯静态）。

web/ 里是 guanxing4.0 的网页整站。这版站点**不需要任何服务端接口**：
存档导入只认明文 JSON（`dat.json`）和 `.yanyu`，全程离线。

自动导入走站点自带的「last-import 通道」—— home.js 的 initializeHome()
本来就在读 `window.__latestPlainSave`；APK / PC 导出工具的做法是
**在 last-import.js 前面拼一行赋值**，我们用「虚拟路由」原样复刻：
请求 /last-import.js 时动态返回"赋值语句 + 原版 last-import.js"，
网页源码一字不动。首页 index.html 本来就把 last-import.js 当脚本引入，
所以开首页 = 自动导入 + 落在首页。

向导导入完存档会自动：

    1. 拉起本服务（后台独立进程，不需要命令行窗口）；
    2. 把 dat.json 交给 last-import 通道；
    3. 打开浏览器（首页）—— 进去就是「已导入」状态。

服务默认 http://127.0.0.1:8080 （被占自动顺延到 8085），
后台常驻、下次直接复用；空闲 30 分钟自动退出，
不用了也可手动跑 `python run.py serve --stop`。

用法::

    python run.py serve             # 起服务并打开浏览器
    python run.py serve --stop      # 停掉工具启动的后台服务
    python run.py serve --no-browser
"""
import argparse
import base64
import json
import os
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
import uuid
import zlib
import http.server

from . import ui
from .config import paths

DEFAULT_PORT = 8080          # 与 web/serve.js 一致；被占时自动顺延 8081..8085
PORT_RANGE = 6
BG_IDLE_MIN = 30             # 后台服务空闲多久自动退出（分钟；0 = 不退）
_LAST_HIT = 0.0              # 最后一次 HTTP 请求的时间（空闲自动退出用）
# 判断"占着端口的是不是这个站"
PING_PATH = '/'
PING_MARK = 'last-import.js'
# 自动导入走虚拟路由（不往 web/ 里写文件；冻结打包后 web/ 也不可写）
LAST_IMPORT_NAME = 'last-import.js'
LAST_IMPORT_FILE = 'last_import.js'
PID_FILE = 'webserver.pid'


def runtime_dir():
    """自动导入脚本 / pid 文件的落盘位置：系统临时目录下的固定子目录。

    **必须跨实例共享**：端口上的服务可能是另一个实例（另一个 exe 位置、
    仓库里的开发版）起的，要是写在各自工具目录的缓存里，它读不到这边写的
    文件，自动导入就静默失效。放全局共享目录后，谁起的服务都读得到。
    """
    return os.path.join(tempfile.gettempdir(), 'yyjh_web')


def _last_import_path(port):
    """按端口分文件：服务只认发给**自己端口**的那份，互不串台。"""
    return os.path.join(runtime_dir(), f'{LAST_IMPORT_FILE[:-3]}_{port}.js')


def _pid_path(port=None):
    name = PID_FILE if port is None else f'{PID_FILE[:-4]}_{port}.pid'
    return os.path.join(runtime_dir(), name)


def _legacy_pid_path():
    return os.path.join(paths.CACHE_DIR, PID_FILE)

# 与 web/shared/save_decrypt.js 里的键名保持一致（dev/check_site_import.py 会逐字比对）
SAVE_SHARE_KEY = 'yyjh_share_save_v1'
SAVE_SHARE_META_KEY = 'yyjh_share_save_meta_v1'


def web_dir():
    """网页版根目录：exe 内打包的 web/，或开发目录下的 web/。"""
    if getattr(sys, 'frozen', False):
        return os.path.join(sys._MEIPASS, 'web')          # noqa: SLF001
    return os.path.join(paths.TOOL_DIR, 'web')


# ───────────────────────── 静态服务（Python 版 serve.js） ─────────────────────────
class Handler(http.server.SimpleHTTPRequestHandler):
    """静态文件 + /last-import.js 自动导入虚拟路由。"""

    def end_headers(self):
        # 不缓存：改完源码刷新即生效
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    def guess_type(self, path):
        lower = str(path).lower()
        if lower.endswith('.wasm'):
            return 'application/wasm'
        if lower.endswith('.mjs') or lower.endswith('.js'):
            return 'application/javascript; charset=utf-8'
        if lower.endswith('.json'):
            return 'application/json; charset=utf-8'
        return super().guess_type(path)

    def do_GET(self):                                     # noqa: N802
        path = self.path.split('?')[0]
        if path == '/' + LAST_IMPORT_NAME:
            # 优先给「自动导入版」（write_last_import 刚写的那份）；
            # 没有就回落原版 —— 等于没有自动导入，页面照常可用。
            port = self.server.server_address[1]
            for p in (_last_import_path(port),
                      os.path.join(paths.CACHE_DIR, LAST_IMPORT_FILE),
                      os.path.join(web_dir(), LAST_IMPORT_NAME)):
                try:
                    with open(p, 'rb') as f:
                        body = f.read()
                    break
                except OSError:
                    body = None
            if body is None:
                self.send_error(404, 'last-import.js not found')
                return
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        global _LAST_HIT
        _LAST_HIT = time.time()                       # 空闲自动退出的依据
        if os.environ.get('YYJH_SERVE_VERBOSE'):
            super().log_message(fmt, *args)


def make_httpd(port=DEFAULT_PORT):
    """构建 HTTP 服务（端口被占自动顺延）。返回 (httpd, 实际端口)。"""
    handler = lambda *a, **kw: Handler(*a, directory=web_dir(), **kw)  # noqa: E731
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    for p in range(port, min(port + PORT_RANGE, 65536)):
        try:
            httpd = socketserver.ThreadingTCPServer(('127.0.0.1', p), handler)
            return httpd, p
        except OSError:                                   # 端口被占，顺延
            continue
    raise ui.UserError(f'端口 {port}-{port + PORT_RANGE - 1} 全部被占用',
                       ['关掉占用端口的程序后重试'])


def _dress_console():
    """把服务窗口打扮得像个人样：标题 + 一行说明（仅 Windows 有窗口）。"""
    if os.name != 'nt':
        return
    try:
        import ctypes
        ctypes.windll.kernel32.SetConsoleTitleW('网页服务运行中 · 关闭此窗口=停止网页')
    except Exception:                                # noqa: BLE001
        pass
    try:
        if sys.stdout is None or not getattr(sys.stdout, 'fileno', lambda: -1)():
            raise ValueError('no stdout')
    except Exception:                                # noqa: BLE001
        try:
            sys.stdout = open('CONOUT$', 'w', encoding='utf-8', errors='replace')
            sys.stderr = sys.stdout
        except Exception:                            # noqa: BLE001
            return
    ui.info('')
    ui.info('  ── 网页服务运行中 ──────────────────────────')
    ui.info('  这个窗口别关：关闭本窗口 = 停止网页服务，')
    ui.info('  浏览器里的页面就会打不开（拒绝连接）。')
    ui.info('  不用了：直接关掉本窗口，或空闲 30 分钟自动退出。')
    ui.info('  ────────────────────────────────────────────')


def serve_forever(port=DEFAULT_PORT, open_browser=False, idle_min=0):
    """前台跑服务（`yyjh serve` / 内部子进程都走这里）。

    `idle_min` > 0 时：这么久没碰过任何页面就自己退出，不占端口不占内存。
    """
    global _LAST_HIT
    _LAST_HIT = time.time()
    _dress_console()
    httpd, p = make_httpd(port)
    httpd.daemon_threads = True
    url = f'http://127.0.0.1:{p}/'
    ui.info(f'网页版服务已启动：{url}（停止：python run.py serve --stop）')
    if idle_min:
        threading.Thread(target=_idle_watchdog, args=(httpd, idle_min),
                         daemon=True).start()
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        ui.info('\n已停止服务。')
    return 0


def _idle_watchdog(httpd, idle_min):
    """空闲太久就把服务关掉 —— 免得后台进程一直占着端口和内存。"""
    deadline = idle_min * 60.0
    while True:
        time.sleep(max(1.0, min(30.0, deadline / 3)))
        if time.time() - _LAST_HIT >= deadline:
            ui.info(f'空闲超过 {idle_min:g} 分钟，网页版服务自动退出。')
            ui.info('  下次跑向导会自动再拉起来；手动停：python run.py serve --stop')
            httpd.shutdown()
            return


# ───────────────────────── 服务启停 ─────────────────────────
def ping(port):
    """端口上跑的是不是这个站。"""
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}{PING_PATH}',
                                    timeout=0.6) as r:
            return PING_MARK in r.read().decode('utf-8', 'replace')
    except Exception:                                    # noqa: BLE001
        return False


def _live_ports():
    return [p for p in range(DEFAULT_PORT, DEFAULT_PORT + PORT_RANGE) if ping(p)]


def _kill_pid(pid):
    try:
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(pid), '/F'],
                           capture_output=True, timeout=10)
        else:
            os.kill(pid, 15)
        return True
    except Exception:                                    # noqa: BLE001
        return False


def stop_server():
    """停掉**由工具启动**的后台服务（含其它实例起的）。返回 True = 停掉了。"""
    killed = False
    seen = set()
    candidates = []
    run_dir = runtime_dir()
    if os.path.isdir(run_dir):
        candidates += [os.path.join(run_dir, n) for n in sorted(os.listdir(run_dir))
                       if n.startswith(PID_FILE[:-4]) and n.endswith('.pid')]
    candidates.append(_legacy_pid_path())
    for pid_file in candidates:
        try:
            with open(pid_file, encoding='utf-8') as f:
                pid = int(f.read().strip())
        except Exception:                                # noqa: BLE001
            pid = None
        try:
            os.remove(pid_file)
        except OSError:
            pass
        if pid and pid not in seen:
            seen.add(pid)
            killed = _kill_pid(pid) or killed
    return killed


def _spawn_server(port):
    """后台独立进程起服务：冻结（exe）= 自己带 serve 子命令；开发 = python -m yyjh。"""
    if getattr(sys, 'frozen', False):
        cmd = [sys.executable, 'serve', '--no-browser', '--port', str(port),
               '--idle-min', str(BG_IDLE_MIN)]
    else:
        cmd = [sys.executable, '-m', 'yyjh', 'serve', '--no-browser',
               '--port', str(port), '--idle-min', str(BG_IDLE_MIN)]
    kwargs = dict(cwd=os.path.dirname(web_dir()) if getattr(sys, 'frozen', False)
                  else paths.TOOL_DIR,
                  stdin=subprocess.DEVNULL)
    # 关键：把 PyInstaller 的「复用父进程解压目录」变量清掉。
    # 不清的话子服务跑在**向导自己的解压目录**里，向导一退出就被清理，
    # 子服务的 web/ 静态文件跟着消失 —— 现象就是首页能开、点子页面 404。
    env = {k: v for k, v in os.environ.items() if not k.startswith('_PYI_')}
    env.pop('LD_LIBRARY_PATH', None)
    if env.get('PATH'):
        env['PATH'] = os.pathsep.join(
            e for e in env['PATH'].split(os.pathsep) if '_MEI' not in e)
    kwargs['env'] = env
    if os.name == 'nt':
        # 独立后台进程：给它一个**自己的可见控制台**（带标题和说明），
        # 不跟着向导一起退出；关掉那个窗口 = 停止网页服务
        kwargs['creationflags'] = (getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
                                   | getattr(subprocess, 'CREATE_NEW_CONSOLE', 0))
        kwargs['close_fds'] = True
    else:
        kwargs['start_new_session'] = True
    proc = subprocess.Popen(cmd, **kwargs)
    paths.ensure_dir(runtime_dir())
    with open(_pid_path(port), 'w', encoding='utf-8') as f:
        f.write(str(proc.pid))


def ensure_server():
    """确保服务在跑，返回 `http://127.0.0.1:<port>/`。

    已经在跑就复用；没在跑就拉起一个**后台独立进程**
    （关掉向导/命令行窗口都不影响）。
    """
    live = _live_ports()
    if live:
        return f'http://127.0.0.1:{live[0]}/'
    if not os.path.isfile(os.path.join(web_dir(), 'index.html')):
        raise ui.UserError('找不到网页版文件（web/index.html）',
                           ['web/ 目录丢了？重新解压工具包'])

    port = DEFAULT_PORT
    for p in range(DEFAULT_PORT, DEFAULT_PORT + PORT_RANGE):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(('127.0.0.1', p))
                port = p
                break
            except OSError:
                continue
    _spawn_server(port)

    for _ in range(300):           # 最多等 30 秒（冻结版首次解压 50MB 可能要十几秒）
        live = _live_ports()
        if live:
            return f'http://127.0.0.1:{live[0]}/'
        time.sleep(0.1)
    raise ui.UserError('网页版服务启动失败', [
        f'手动启动试一下：python run.py serve --port {port}',
    ])


# ───────────────────────── 存档自动导入 ─────────────────────────
def pack_save(data):
    """压成站点 loadShareStore() 认得的形式：base64(zlib(JSON))（备用通道）。"""
    raw = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return base64.b64encode(zlib.compress(raw, 9)).decode('ascii')


def write_last_import(row, port=DEFAULT_PORT):
    """生成「自动导入版」last-import.js（经 /last-import.js 虚拟路由提供）。

    与 APK / PC 导出工具的做法一致：在原版 last-import.js **前面**拼一行赋值，
    home.js 的 initializeHome() 读到就把存档接进来。web/ 里既有文件一字不动。

    走 `window.__latestPlainSave` 明文通道 —— 直接把 dat.json 交给网页。
    文件写到**跨实例共享**的 runtime_dir()（按端口分文件，谁起的服务都读得到），
    另在本实例缓存里留一份兼容副本。返回生成的文件路径。
    """
    from . import report
    json_path = row.get('json')
    if not json_path or not os.path.exists(json_path):
        return None
    with open(json_path, encoding='utf-8') as f:
        data = json.load(f)
    try:
        src_path = os.path.join(web_dir(), LAST_IMPORT_NAME)
        with open(src_path, encoding='utf-8') as f:
            shim = f.read()
    except OSError:
        shim = ''

    old = row.get('meta') or {}
    payload = {'data': data, 'platform': report.platform_tag(
        old.get('runtime') or ''), 'version': '明文'}
    head = f'window.__latestPlainSave={json.dumps(payload, ensure_ascii=False)};\n'
    body = head + shim

    out = _last_import_path(port)
    paths.ensure_dir(runtime_dir())
    # 服务可能同时读取；原子替换防止浏览器读到只写了一半的脚本。
    fd, temporary = tempfile.mkstemp(prefix='last_import_', dir=runtime_dir())
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as f:
            f.write(body)
        os.replace(temporary, out)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    # 兼容副本：给还在读旧缓存目录的老版本服务
    try:
        paths.ensure_dir(paths.CACHE_DIR)
        with open(os.path.join(paths.CACHE_DIR, LAST_IMPORT_FILE), 'w',
                  encoding='utf-8', newline='\n') as f:
            f.write(body)
    except OSError:
        pass
    return out


def _served_last_import(port):
    """端口上的服务实际端出的 last-import.js 内容（拿不到返回 ''）。"""
    try:
        with urllib.request.urlopen(
                f'http://127.0.0.1:{port}/{LAST_IMPORT_NAME}', timeout=3) as r:
            return r.read().decode('utf-8', 'replace')
    except Exception:                                    # noqa: BLE001
        return ''


def _deliver(snapshot, port):
    """把存档交给端口上的服务并**核验**它真的会端出去。返回 True = 成功。"""
    page = write_last_import(snapshot, port)
    if not page:
        return False
    with open(page, encoding='utf-8') as f:
        head = f.readline()
    return _served_last_import(port).startswith(head)


def open_site(snapshot=None):
    """起服务（如需）→ 自动导入存档（如给了）→ 打开浏览器首页。

    打开前先核验端口上的服务真的会把这份存档端出去 ——
    免得再出现「网页开了但没导入」的静默失败。
    """
    base = ensure_server()
    port = urllib.parse.urlsplit(base).port or DEFAULT_PORT
    target = base                       # 首页 index.html（内嵌 last-import.js 自动导入）
    auto = False
    if snapshot:
        try:
            auto = _deliver(snapshot, port)
            if not auto:
                # 端口上的服务是别的实例/旧版本起的、读不到刚写的文件：重启掉再来一次
                ui.debug('自动导入脚本没被端出去，重启服务后再试')
                stop_server()
                base = ensure_server()
                port = urllib.parse.urlsplit(base).port or DEFAULT_PORT
                target = base
                auto = _deliver(snapshot, port)
            if not auto:
                ui.warn('自动导入没生效（端口上的服务不认这份存档），请手动导入。')
        except Exception as e:                           # noqa: BLE001
            ui.warn(f'准备自动导入失败，改开普通入口页：{e}')
    if auto:
        # 每次查看都重新执行首页导入，避免浏览器复用上一次的页面。
        target = base + '?open=' + uuid.uuid4().hex
    ok = False
    try:
        ok = bool(webbrowser.open(target))
    except Exception as e:                               # pragma: no cover
        ui.debug(f'webbrowser.open 失败: {e}')
    if ok:
        ui.ok('已用默认浏览器打开网页版模拟器')
        if auto:
            ui.info('  存档已自动载入，进去就能直接用。')
        else:
            ui.info('  在网页里点「导入数据」，选存档目录里的 dat.json。')
    else:
        ui.warn('没能自动打开浏览器，请手动打开：')
        ui.info(f'  {target}')
    return ok


# ───────────────────────── 子命令 ─────────────────────────
def add_parsers(sub):
    p = sub.add_parser('serve', help='网页版本地服务（向导会自动拉起）')
    p.add_argument('--port', type=int, default=DEFAULT_PORT,
                   help=f'监听端口（默认 {DEFAULT_PORT}）')
    p.add_argument('--no-browser', action='store_true', help='不自动打开浏览器')
    p.add_argument('--idle-min', type=float, default=0,
                   help='空闲这么多分钟后自动退出（默认 0 = 一直跑）')
    p.add_argument('--stop', action='store_true', help='停掉工具启动的后台服务后退出')
    p.set_defaults(func=cmd_serve)
    return p


def cmd_serve(args):
    if getattr(args, 'stop', False):
        if stop_server():
            ui.ok('后台服务已停止')
        else:
            ui.info('没有由工具启动的后台服务')
        return 0
    return serve_forever(port=getattr(args, 'port', DEFAULT_PORT),
                         open_browser=not getattr(args, 'no_browser', False),
                         idle_min=getattr(args, 'idle_min', 0) or 0)


def main(argv=None):
    """`python -m yyjh.webserve` 的入口（与 `yyjh serve` 等价）。"""
    ui.configure()
    ap = argparse.ArgumentParser(
        prog='python -m yyjh.webserve',
        description='网页版本地服务（向导会自动拉起，这里一般只用来手动启停）')
    ap.add_argument('--port', type=int, default=DEFAULT_PORT)
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--idle-min', type=float, default=0)
    ap.add_argument('--stop', action='store_true')
    args = ap.parse_args(sys.argv[1:] if argv is None else list(argv))
    return cmd_serve(args)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except ui.UserError as e:
        ui.report_error(e, ui.is_verbose())
        sys.exit(2)
