# -*- coding: utf-8 -*-
"""新版动态信封（v73492+ / JHNetClient 传输层）解码。

    传输层密钥 = MD5(platform + '_' + session请求头 + '_' + 请求epoch)[:16]
    外层: XXTEA(密文, 密钥)  —— ⚠ 无长度字（padding=False），旧长度字预言机会误杀
    信封: 版本号(8) + XXTEA(zlib(存档JSON), 内层密钥)
    内层密钥: psw + 渠道后缀（iOS 'yoqkmrtj' / Android 'po06ewkx'）

来源：游戏 JHNetClient 的传输规则（prototypes 152/153/155），经真实
iOS/Android 抓包验证。时间戳取请求时间，±window 秒穷举以容忍时钟偏差。

收编自 4.2 参考实现的 ios_har_support（decoder.py / yanyu_save.py）。
"""
import base64
import datetime as dt
import hashlib
import json
import zlib
from urllib.parse import urlsplit

from ..core import xxtea
from ..game import savefmt

MAX_SAVE_BYTES = 32 * 1024 * 1024
COMMANDS = frozenset(('upload3', 'upload_auto3', 'download3'))
PLATFORM_HOSTS = {'ios.wlfy.blue8.cn': 'ios', 'andr.wlfy.blue8.cn': 'android'}
# 兜底内层密钥（psw + 渠道后缀）；优先还试 keytables 的版本化候选
INNER_KEYS_FALLBACK = {
    'android': ('xi9iz9h4po06ewkx',),
    'ios': ('xi9iz9h4yoqkmrtj', 'xi9iz9h4po06ewkx'),
}


class EnvelopeError(ValueError):
    pass


# ────────────────────────── 基础件 ──────────────────────────

def _raw_decrypt(cipher, key):
    """XXTEA 解密，**不裁长度字**（新信封没有长度字）。"""
    if len(cipher) < 8 or len(cipher) % 4:
        return None
    k = key.encode('ascii') if isinstance(key, str) else key
    return xxtea.decrypt_raw(cipher, k)


def open_envelope(stage1):
    """外层解出的 base64 文本 -> 信封二进制(版本号8字节 + 密文)。

    游戏加密时明文总会补齐到下一个 4 字节整数倍（哪怕本来就是 4 的倍数
    也要加满一整块），所以解密结果尾部混着 0~4 个填充字节。逐个砍掉
    0~4 个尾部字节，取第一个「严格 base64 合法、前 8 位是版本号数字、
    整体长度是 4 的倍数」的结果。
    """
    for drop in range(5):
        chunk = stage1[:len(stage1) - drop] if drop else stage1
        if len(chunk) % 4 == 1:          # base64 有效长度不可能是 4n+1
            continue
        padded = chunk + b'=' * ((4 - len(chunk) % 4) % 4)
        try:
            env = base64.b64decode(padded, validate=True)
        except Exception:
            continue
        if len(env) > 8 and len(env) % 4 == 0 and env[:8].isdigit():
            return env
    return None


def inflate_json(plain):
    for wbits in (15, -15, 47):
        try:
            dec = zlib.decompressobj(wbits)
            raw = dec.decompress(plain, MAX_SAVE_BYTES + 1)
            if len(raw) > MAX_SAVE_BYTES or not dec.eof or dec.unconsumed_tail:
                continue
            if len(dec.unused_data) > 7:      # 允许 ≤4 字节补零/长度残留
                continue
            result = json.loads(raw)
            if isinstance(result, dict):
                return result
        except (zlib.error, ValueError, UnicodeError):
            continue
    return None


def key_stream(platform, session, anchor, window=5):
    """(offset, key) 序列：先 0，再 ±1…±window。"""
    for offset in [0] + [v for n in range(1, window + 1) for v in (-n, n)]:
        raw = f'{platform}_{session}_{anchor + offset}'.encode('utf-8')
        yield offset, hashlib.md5(raw).hexdigest()[:16]


def open_full(cipher, key, platform='ios', version_hint=None):
    """传输层解密 -> (完整存档 dict, 版本号, 内层密钥)。失败返回 None。"""
    stage1 = _raw_decrypt(cipher, key)
    if not stage1:
        return None
    env = open_envelope(stage1)
    if not env:
        return None
    version = int(env[:8])
    inner = env[8:]
    cands = list(INNER_KEYS_FALLBACK.get(platform, ()))
    try:
        cands += list(savefmt.inner_candidates(platform, version, None))
    except Exception:
        pass
    seen = set()
    for ik in cands:
        if not ik or ik in seen:
            continue
        seen.add(ik)
        x = _raw_decrypt(inner, ik)
        if not x:
            continue
        save = inflate_json(x)
        if save is None:
            continue
        return save, version, ik
    return None


# ────────────────────────── HAR 入口 ──────────────────────────

def _headers(message):
    return {str(h.get('name', '')).strip().lower(): str(h.get('value', '')).strip()
            for h in (message.get('headers') or []) if isinstance(h, dict)}


def _body(message, response=False):
    part = message.get('content' if response else 'postData', {}) or {}
    text = part.get('text', '')
    if not isinstance(text, str):
        return None
    if part.get('encoding') == 'base64':
        try:
            return base64.b64decode(text, validate=True)
        except Exception:
            return None
    return text.encode('utf-8')


def decode_har(har_path, window=5, steps=None):
    """扫 HAR 里的 upload3/download3 记录，动态信封解出完整存档。

    返回第一条成功的 dict：
        {account, runtime, server, save_id, version, data, inner_key,
         command, entry_index, clock_offset}
    全部失败返回 None（调用方回退旧路径）。
    """
    say = steps or (lambda *a, **k: None)
    with open(har_path, encoding='utf-8') as f:
        har = json.load(f)
    entries = (har.get('log') or {}).get('entries') or []

    for index, entry in enumerate(entries):
        request = entry.get('request') or {}
        h = _headers(request)
        command = h.get('command', '').strip().lower()
        if command not in COMMANDS:
            continue
        try:
            host = (urlsplit(request.get('url', '')).hostname or '').lower()
        except Exception:
            continue
        platform = PLATFORM_HOSTS.get(host)
        if platform is None:
            continue
        session = h.get('session')
        if not session or len(session) > 4096:
            continue
        try:
            started = dt.datetime.fromisoformat(
                str(entry.get('startedDateTime', '')).replace('Z', '+00:00'))
            if started.tzinfo is None:
                started = started.replace(tzinfo=dt.timezone.utc)
            anchor = int(started.timestamp())
        except Exception:
            continue

        # 取密文：download3 在响应 JSON 的 data 字段；upload3 在请求体
        if command == 'download3':
            try:
                payload = json.loads(_body(entry.get('response') or {}, True) or b'')
            except Exception:
                continue
            if not isinstance(payload, dict) or payload.get('code') != 0:
                continue
            text = payload.get('data')
        else:
            raw = _body(request)
            text = raw.decode('ascii') if raw else None
        if not isinstance(text, str):
            continue
        try:
            cipher = base64.b64decode(text.strip(), validate=True)
        except Exception:
            continue
        if len(cipher) < 16 or len(cipher) % 4 or len(cipher) > MAX_SAVE_BYTES:
            continue

        for offset, key in key_stream(platform, session, anchor, window):
            got = open_full(cipher, key, platform)
            if not got:
                continue
            save, version, inner_key = got
            acc = h.get('acc') or save.get('EncryptID') or save.get('UserID')
            acc = str(acc) if acc is not None else ''
            runtime = platform
            server = h.get('area') or str(save.get('ServerID') or '')
            say('动态信封', f'命中 #{index} {command}（时间偏移 {offset:+d}s）')
            say('传输密钥', f'md5({platform}_{session[:6]}…_{anchor + offset})[:16]')
            say('信封版本', version)
            return {
                'account': acc, 'runtime': runtime,
                'server': server, 'save_id': savefmt.save_id_of(acc) if acc else '',
                'version': version, 'data': save, 'inner_key': inner_key,
                'command': command, 'entry_index': index, 'clock_offset': offset,
            }
    return None
