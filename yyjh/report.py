# -*- coding: utf-8 -*-
"""输出生成：明文 JSON + 元信息 + 初版 dat.db。

默认输出三个文件（都在 tool_1.1/output/）：
    <平台><区服>区-<用户名>/<时间戳>/dat.json        解密后的完整存档
    <平台><区服>区-<用户名>/<时间戳>/dat.meta.json   元信息（账号/版本/密钥/来源/时间）
    <平台><区服>区-<用户名>/<时间戳>/dat.db          初版 dat.db

例如:
    ios3区-示例角色
    android12区-示例角色

**账号不进文件名**（邮箱/QQ/微信号都是敏感信息），只写在 `.meta.json` 里。
时间戳到秒，所以连续跑不会互相覆盖。

开发者想看"流程报告"可以加 `--report`，会多写一个 `.report.md`。
文件名冲突时自动加 `-2` `-3` 后缀，不会覆盖已有文件。
"""
import datetime
import json
import os
import re

from . import __version__, ui
from .config import paths

_SAFE = re.compile(r'[^\w\u4e00-\u9fff.-]+')


def _safe(s, limit=24):
    if s is None:
        return ''
    return _SAFE.sub('_', str(s)).strip('_')[:limit]


def server_tag(server):
    """区服标识：`25`（用于拼 `ios25区` 这类名字）。没读到服号退化到 `0`。"""
    s = _safe(server, 8) if server else ''
    return s or '0'


def platform_tag(runtime=None):
    """命名里的平台标识 —— 存档统一按 **ios** 命名。

    （抓包/模拟器链路里 runtime 常被识别成 android，但账号是 iOS 的，
    命名一律写 ios；runtime 本身仍按事实存进 meta，供解密逻辑用。）
    """
    return 'ios'


# 兼容旧调用方（已不再用于文件名）
def account_tag(account, limit=20):
    """账号短标识（仅日志/调试用，**不进文件名**）。"""
    if not account:
        return 'unknown'
    raw = str(account).strip()
    core = raw.split('@', 1)[0] if '@' in raw else raw    # 邮箱只取 @ 前那段
    tag = _safe(core, limit + 8)
    return tag or 'unknown'


def group_name(res, name=None):
    """归档**目录名**：`<平台><区服>区-<用户名>`，如 `ios25区-示例角色`。

    不带时间戳 —— 时间那一段留给文件名，目录只回答"这是谁的"。
    """
    if name:
        return _safe(name, 80)
    return f'{platform_tag(res.runtime)}{server_tag(res.server)}区-' \
           f'{_safe(res.nick, 20) or "未知"}'


def make_stem(res, name=None):
    """备份用：`<平台>-<区服>-<用户名>`（不含时间戳）。"""
    return group_name(res, name)


def snapshot_dir(res, root, name=None, stamp=None):
    """建出这次输出的**快照目录**并返回路径。

    只有这一种结构（不再提供 --flat 之类的变体）：

        <root>/<平台>-<区服>-<用户名>/<时间戳>/
            dat.db
            dat.json
            dat.meta.json
            dat.report.md     （加 --report 才有）

    为什么要多这一层快照目录：
      · 里面文件名固定（`dat.db` 就叫 `dat.db`），**推回设备不用改名**
      · 分享/备份/打包直接拿这一个目录，不用挑三个带时间戳的文件
      · 撞名只在目录名上处理（`…-2/`），里面的文件名永远干净

    同一秒重复跑会得到 `…-2/`、`…-3/`，不覆盖也不丢数据。
    """
    who = group_name(res, name)
    stamp = stamp or datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    base = paths.ensure_dir(os.path.join(root, who))
    d = os.path.join(base, stamp)
    n = 2
    while os.path.exists(d):
        d = os.path.join(base, f'{stamp}-{n}')
        n += 1
    return paths.ensure_dir(d)


# ───────────────────────── 开发者用的流程报告 ─────────────────────────
def render_markdown(res):
    L = []
    A = L.append
    A(f'# 存档报告 · {res.nick or res.account or os.path.basename(res.source)}')
    A('')
    A(f'> 生成时间：{datetime.datetime.now():%Y-%m-%d %H:%M:%S}　·　'
      f'yyjh tool_1.1 v{__version__}')
    A('')
    A('## 1. 概要')
    A('')
    A('| 项目 | 值 |')
    A('|---|---|')
    rows = [('来源', f'`{res.source}`'), ('类型', res.kind),
            ('平台', platform_tag(res.runtime)), ('账号', f'`{res.account or "—"}`'),
            ('save.id', f'`{res.save_id or "—"}`'), ('服务器', res.server or '—'),
            ('存档版本', f'`{res.version or "—"}`')]
    if res.marker:
        rows.append(('外层标记', f'`{res.marker}`'))
    if res.outer_key:
        rows.append(('外层密钥', f'`{res.outer_key}`'))
    rows += [('内层密钥', f'`{res.inner_key or "—"}`'),
             ('角色名', f'**{res.nick or "—"}**'), ('顶层字段数', res.field_count)]
    for k, v in rows:
        A(f'| {k} | {v} |')
    A('')
    A('## 2. 解密流程')
    A('')
    A('| 步骤 | 结果 |')
    A('|---|---|')
    for s in res.steps:
        A(f'| {"✅" if s.ok else "⚠️"} {s.label} | {s.value} |')
    A('')
    if res.warnings:
        A('### ⚠️ 警告')
        A('')
        for w in res.warnings:
            A(f'- {w}')
        A('')
    mr = res.data.get('MainRole') or {}
    if mr:
        gv = res.data.get('globalVariable') or {}
        A('## 3. 角色属性')
        A('')
        A('| 属性 | 值 |')
        A('|---|---|')
        for k, v in ([(k, mr.get(k)) for k in ('Name', 'Level', 'MenPai', 'Sex',
                                               'Job', 'Age', 'Favour', 'GongLi')
                      if k in mr] +
                     [('声望(repute)', gv.get('repute')),
                      ('银两(Money)', res.data.get('Money')),
                      ('体力(Energy)', res.data.get('Energy')),
                      ('月卡(Yue)', res.data.get('Yue'))]):
            A(f'| {k} | {v if v is not None else "—"} |')
        A('')
    if res.player:
        A('## 4. save.player（明文摘要列）')
        A('')
        A('```json')
        try:
            A(json.dumps(json.loads(res.player), ensure_ascii=False, indent=2))
        except Exception:
            A(res.player)
        A('```')
        A('')
    keys = list(res.data.keys())
    if keys:
        A(f'## 5. 顶层字段（共 {len(keys)} 个）')
        A('')
        for i in range(0, len(keys), 6):
            A('| ' + ' | '.join(keys[i:i + 6]) + ' |')
        A('')
    return '\n'.join(L)


# ───────────────────────── 写盘 ─────────────────────────
def write_all(res, outdir=None, name=None, write_db=False,
              write_json=True, write_report=False, write_meta=True):
    """写出结果文件。返回 {'json'|'db'|'report'|'meta': 路径}。

    结构见 `snapshot_dir()` —— 一次跑一个快照目录，里面文件名固定。
    存档只出一份：`dat.json`（明文），网页「导入数据」直接认。
    """
    root = paths.ensure_dir(outdir or paths.OUT_DIR)
    snap = snapshot_dir(res, root, name=name)
    out = {}

    if write_json and res.data:
        p = os.path.join(snap, 'dat.json')
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(res.data, f, ensure_ascii=False)
        out['json'] = p

    if write_db and res.content and res.save_id:
        from .game import player as player_mod
        from .localdb import sqlitedb
        ply = res.player or player_mod.build(res.data, res.version)
        p = os.path.join(snap, 'dat.db')
        try:
            sqlitedb.write_save(p, res.save_id, res.content, ply)
            out['db'] = p
        except Exception as e:
            res.warn(f'写 dat.db 失败: {e}')

    if write_report:
        p = os.path.join(snap, 'dat.report.md')
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            f.write(render_markdown(res))
        out['report'] = p

    if write_meta:
        meta = res.as_dict()
        meta.update({
            'generator': f'yyjh tool_1.1 v{__version__}',
            'generated_at': datetime.datetime.now().isoformat(timespec='seconds'),
            'snapshot_dir': snap,
            'outputs': {k: os.path.basename(v) for k, v in out.items()},
        })
        p = os.path.join(snap, 'dat.meta.json')
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        out['meta'] = p
    return out


# ─────────────────────── 控制台结果块 ───────────────────────
def print_result(res, outs):
    """给使用者的结果摘要（默认就这几行）。"""
    ui.info()
    ui.rule()
    ui.ok(f'完成：{res.nick or res.account}'
          f'　平台 {platform_tag(res.runtime)}　版本 {res.version or "?"}'
          f'　{res.field_count} 个字段')
    ui.rule()
    labels = {'json': '存档数据', 'db': '存档文件', 'meta': '元信息',
              'report': '流程报告'}
    # 几个文件都在同一个快照目录里，目录只打一遍，省得三行都超长
    dirs = {os.path.dirname(p) for p in outs.values()}
    if len(dirs) == 1:
        ui.info(f'  输出目录   {paths.rel(dirs.pop())}{os.sep}')
    for k in ('json', 'db', 'meta', 'report'):
        if k in outs:
            ui.info(f'  {labels.get(k, k):6} {os.path.basename(outs[k])}')
    for w in res.warnings:
        ui.warn(w)
