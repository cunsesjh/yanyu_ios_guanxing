# -*- coding: utf-8 -*-
"""回归：HAR 外层解密的鲁棒性（捕获 decode.inner_body 的取键/解码盲区）。

跑法: python -u dev\\check_har_decode.py

覆盖三种真实踩过的坑：
  ① 一次抓包里有多份 k（多次会话），k 与最大 upload 跨会话错位
  ② ProxyPin 导出 postData.encoding=base64（含双层 base64）
  ③ 游戏更新后 realKey 取种子的窗口漂移（不是 innerK[:6]）
"""
import base64
import json
import os
import shutil
import sys
import tempfile
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from yyjh.capture import decode as capdec                       # noqa: E402
from yyjh.core import xxtea                                     # noqa: E402
from yyjh.game.protocol import protocol_key                     # noqa: E402

ACC = 'player123@example.com'
VER = '00073440'
INNER_KEY = '***'[:16]
ALPHABET = b'abcdefghijklmnopqrstuvwxyz0123456789'

_ok = _fail = 0


def check(name, cond, detail=''):
    global _ok, _fail
    if cond:
        _ok += 1
        print(f'  [OK]   {name}')
    else:
        _fail += 1
        print(f'  [FAIL] {name}   {detail}')


# ── 合成数据（按逆向出的协议真实加密封装）─────────────────────
def _seed(n=9):
    return bytes(ALPHABET[b % len(ALPHABET)] for b in os.urandom(n))


def _content(nick):
    data = {'Nick': nick, 'EncryptID': ACC}
    body = xxtea.encrypt(zlib.compress(json.dumps(data).encode('utf-8'), 6), INNER_KEY)
    return base64.b64encode(VER.encode('ascii') + body).decode('ascii')


def _k_header(seed):
    return base64.b64encode(xxtea.encrypt(seed, protocol_key(ACC, b''))).decode('ascii')


def _upload(content, real_key, when, encoding=None, double_b64=False, cmd='upload'):
    cipher = xxtea.encrypt(content.encode('ascii'), real_key)
    payload = base64.b64encode(cipher).decode('ascii')
    pd = {'mimeType': 'application/octet-stream', 'text': payload}
    if double_b64:
        pd = {'mimeType': 'application/octet-stream',
              'text': base64.b64encode(payload.encode('ascii')).decode('ascii'),
              'encoding': 'base64'}
    elif encoding:
        pd['encoding'] = encoding
    return {'request': {'url': 'https://game/api_command', 'method': 'POST',
                        'headers': [{'name': 'command', 'value': cmd},
                                    {'name': 'acc', 'value': ACC}],
                        'postData': pd},
            'response': {'status': 200, 'headers': []},
            'startedDateTime': when}


def _k_entry(k_header, when):
    return {'request': {'url': 'https://game/api_command', 'method': 'POST',
                        'headers': [{'name': 'command', 'value': 'startGame'}]},
            'response': {'status': 200, 'headers': [{'name': 'k', 'value': k_header}]},
            'startedDateTime': when}


def _write_har(path, entries):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'log': {'version': '1.2', 'entries': entries}}, f, ensure_ascii=False)


def _download_json(psw, suf, real_key, nick):
    """download 响应：{saveCode, extra, data, code}。
    data = base64(版本号 + XXTEA(zlib(json), psw+渠道后缀))
    extra = base64(XXTEA(psw(8), realKey))"""
    inner_key = (psw + suf)[:16]
    blob = xxtea.encrypt(zlib.compress(
        json.dumps({'Nick': nick, 'EncryptID': ACC}).encode('utf-8'), 6), inner_key)
    content = base64.b64encode(VER.encode('ascii') + blob).decode('ascii')
    extra = base64.b64encode(xxtea.encrypt(psw.encode('ascii'), real_key)).decode('ascii')
    return {'saveCode': 1, 'extra': extra, 'data': content, 'code': 0}


def _download_entry(resp_json, when):
    return {'request': {'url': 'https://game/api_command', 'method': 'POST',
                        'headers': [{'name': 'command', 'value': 'download'},
                                    {'name': 'acc', 'value': ACC}]},
            'response': {'status': 200, 'headers': [],
                         'content': {'mimeType': 'application/json',
                                     'text': json.dumps(resp_json)}},
            'startedDateTime': when}


# ── 用例 ────────────────────────────────────────────────────
def main():
    tmp = tempfile.mkdtemp(prefix='yyjh_har_')
    try:
        # ① 多会话：k1/upload1（小）+ k2/upload2（大）—— 旧代码取 k1 + 最大 upload = 错位
        print('— ① 多份 k（跨会话错位）—')
        s1, s2 = _seed(), _seed()
        rk1 = protocol_key(ACC, s1).decode('ascii')
        rk2 = protocol_key(ACC, s2).decode('ascii')
        p = os.path.join(tmp, 'two_sessions.har')
        _write_har(p, [_k_entry(_k_header(s1), '2026-10-25T10:00:00Z'),
                       _upload(_content('会话1'), rk1, '2026-10-25T10:00:01Z'),
                       _k_entry(_k_header(s2), '2026-10-25T10:05:00Z'),
                       _upload(_content('会话2') + 'x' * 2000, rk2,
                               '2026-10-25T10:05:01Z')])
        try:
            info = capdec.inner_body(p)
            check('跨会话错位也能命中正确的 k', info['outer_key'] == rk2,
                  f'outer_key={info["outer_key"]}')
        except ValueError as e:
            check('跨会话错位也能命中正确的 k', False, str(e))

        # ② ProxyPin 导出的请求体编码
        print('— ② postData 编码变体 —')
        for label, kw in [('encoding=base64', {'encoding': 'base64'}),
                          ('双层 base64', {'double_b64': True})]:
            s = _seed()
            rk = protocol_key(ACC, s).decode('ascii')
            p = os.path.join(tmp, 'enc.har')
            _write_har(p, [_k_entry(_k_header(s), '2026-10-25T10:00:00Z'),
                           _upload(_content(label), rk, '2026-10-25T10:00:01Z', **kw)])
            try:
                info = capdec.inner_body(p)
                check(f'请求体 {label} 能解开', info['outer_key'] == rk)
            except ValueError as e:
                check(f'请求体 {label} 能解开', False, str(e))

        # ③ 种子窗口漂移：realKey 不取 innerK[:6] 而取 [2:8]
        print('— ③ realKey 种子窗口漂移 —')
        s = _seed(12)
        rk = protocol_key(ACC, s[2:8]).decode('ascii')
        p = os.path.join(tmp, 'drift.har')
        _write_har(p, [_k_entry(_k_header(s), '2026-10-25T10:00:00Z'),
                       _upload(_content('漂移'), rk, '2026-10-25T10:00:01Z')])
        try:
            info = capdec.inner_body(p)
            check('种子窗口兜底能命中', info['outer_key'] == rk,
                  f'outer_key={info["outer_key"]}')
        except ValueError as e:
            check('种子窗口兜底能命中', False, str(e))

        # ④ --real-key 指定优先
        print('— ④ --real-key —')
        s = _seed()
        rk = protocol_key(ACC, s).decode('ascii')
        p = os.path.join(tmp, 'manual.har')
        _write_har(p, [_upload(_content('手动'), rk, '2026-10-25T10:00:01Z')])  # 故意不给 k
        try:
            info = capdec.inner_body(p, real_key=rk)
            check('没有 k 响应头时 --real-key 也能用', info['outer_key'] == rk)
        except ValueError as e:
            check('没有 k 响应头时 --real-key 也能用', False, str(e))

        # ⑤ 完全不匹配要报错且给排查清单，不许静默/瞎报
        print('— ⑤ 全错要报错 —')
        p = os.path.join(tmp, 'bad.har')
        _write_har(p, [_k_entry(_k_header(_seed()), '2026-10-25T10:00:00Z'),
                       _upload(_content('坏'), 'z' * 16, '2026-10-25T10:00:01Z')])
        try:
            capdec.inner_body(p)
            check('全错时报错', False, '居然解开了？')
        except ValueError as e:
            check('全错时报错', '排查建议' in str(e))

        # ⑥ 新版正路：download 响应（多 k 错位也要命中）
        print('— ⑥ download 正路（多 k）—')
        s1, s2 = _seed(), _seed()
        rk1 = protocol_key(ACC, s1).decode('ascii')
        rk2 = protocol_key(ACC, s2).decode('ascii')
        psw, suf = 'abcd1234', 'yoqkmrtj'
        p = os.path.join(tmp, 'download.har')
        _write_har(p, [_k_entry(_k_header(s1), '2026-10-25T10:00:00Z'),
                       _k_entry(_k_header(s2), '2026-10-25T10:05:00Z'),
                       _download_entry(_download_json(psw, suf, rk2, '下载'),
                                       '2026-10-25T10:05:01Z')])
        try:
            d = capdec.download_body(p)
            check('download 正路命中（k2 会话）', d['real_key'] == rk2,
                  f'outer_key={d["real_key"]}')
            check('内层密钥 = psw + 渠道后缀', d['inner_key'] == psw + suf,
                  f'inner_key={d["inner_key"]}')
            check('download 存档解出', d['data'].get('Nick') == '下载')
        except ValueError as e:
            check('download 正路命中（k2 会话）', False, str(e))
            check('内层密钥 = psw + 渠道后缀', False, str(e))
            check('download 存档解出', False, str(e))

        # ⑦ decode 全链路：upload3 被安全信封包住 -> uploadPower 回退（多 k）
        print('— ⑦ uploadPower 回退（多 k）—')
        roles = [{'ID': 1, 'Name': '主号', 'IsMaster': True,
                  'Equips': [{'MJSeed': 123}]},
                 {'ID': 2, 'Name': '副号'}]
        summary = {'energy': 7, 'menpai': 3, 'sex': 1, 'money': 99, 'lev': 100,
                   'prestige': 5, 'saveCode': 42, 'job': 2, 'version': 73492,
                   'avatar': 9, 'yue': 1,
                   'data': base64.b64encode(zlib.compress(
                       json.dumps(roles).encode('utf-8'), 6)).decode('ascii')}
        p = os.path.join(tmp, 'power.har')
        _write_har(p, [_k_entry(_k_header(s1), '2026-10-25T10:00:00Z'),
                       _upload(_content('坏存档'), 'z' * 16,   # 安全信封：解不开
                               '2026-10-25T10:00:01Z', cmd='upload3'),
                       _k_entry(_k_header(s2), '2026-10-25T10:05:00Z'),
                       _upload(json.dumps(summary), rk2,
                               '2026-10-25T10:05:01Z', cmd='uploadPower')])
        try:
            r = capdec.decode(p)
            check('回退到 uploadPower 且命中 k2', r.outer_key == rk2,
                  f'outer_key={r.outer_key}')
            check('MainRole/装备种子完整',
                  (r.data.get('MainRole') or {}).get('Equips', [{}])[0].get('MJSeed') == 123
                  and len(r.data.get('Roles') or []) == 2)
            check('版本/摘要字段组装',
                  r.version == '00073492' and r.data.get('Money') == 99)
        except ValueError as e:
            check('回退到 uploadPower 且命中 k2', False, str(e))
            check('MainRole/装备种子完整', False, str(e))
            check('版本/摘要字段组装', False, str(e))

        # ⑧ download 响应不是存档（不挡路，自动回退旧路径）
        print('— ⑧ download 非存档回退 —')
        s = _seed()
        rk = protocol_key(ACC, s).decode('ascii')
        p = os.path.join(tmp, 'fake_dl.har')
        _write_har(p, [_k_entry(_k_header(s), '2026-10-25T10:00:00Z'),
                       _download_entry({'code': 0, 'msg': 'ok'},
                                       '2026-10-25T10:00:01Z'),
                       _upload(_content('旧路'), rk, '2026-10-25T10:00:02Z')])
        try:
            r = capdec.decode(p, inner_key=INNER_KEY)
            check('download 非存档时自动回退旧路径', r.data.get('Nick') == '旧路',
                  f'Nick={r.data.get("Nick")!r}')
        except ValueError as e:
            check('download 非存档时自动回退旧路径', False, str(e))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f'\n通过 {_ok} / 失败 {_fail}')
    return 1 if _fail else 0


if __name__ == '__main__':
    sys.exit(main())
