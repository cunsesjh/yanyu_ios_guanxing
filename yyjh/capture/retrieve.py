"""Known-key download3 acquisition, reconstructed from apk-2's P0.e/P0.g.

Unlike passive HAR decoding this requires a still-valid game login session.
No third-party decode service is used. Running without --fetch is offline.
"""
import base64
import json
import re
import secrets
import string
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from . import envelope
from ..core import xxtea
from ..game import protocol

# Game public key from apk-2/assets/download-public.der (not a private key).
RSA_N = int(
    'b7e9744b45faa620d31c30e96386e9cd5fb993deca45c9d60894f77db9eea9d078'
    '457694809df70524d730e2c00f046e605323bd5003bf2ca9bbb45cc5115a1dce257d'
    '42034f7e1c7a3e1a68e89a00108d1828ac26bd71ae4ac9b9230b9bc1016746a901'
    '5e70f1d9bd7f564b976164ffc1d96e93ab4066d5cbf402f5fc531151a9805c0716ab'
    'cb9825fe02f3897e57917a64cc2c7a71e88333590aa95923cf4a6be4241af78ca904'
    '5d65b67487194249e36903dda4c975fea73c07c191675445fe5fcf4572f8bd4795ba'
    '81a754505529922f8182719b431ceb2716ca87e2ba83a01e85ef75e463882d0b5376'
    'b6b3d66819e26c2b674f0a9ddefe934243ce87ad', 16)
HOSTS = frozenset(('ios.wlfy.blue8.cn', 'andr.wlfy.blue8.cn',
                   'pre.wlfy.blue8.cn',           # 先行服（ios/android 同域名，按渠道头判平台）
                   'yanyuonline.novastargame.net'))  # 国际服（xinma 等，按渠道头判平台）
COPY_HEADERS = ('ver', 'appver', 'channel', 'realchannel', 'whale', 'lang',
                'blue', 'green', 'user-agent', 'plat', 'sn', 'sn2', 'sn3')


def _platform_of(headers, host):
    """平台判定：主机名 -> channel/realchannel 头 -> plat 头。

    先行服 ios/android 共用 pre.wlfy.blue8.cn，只能靠渠道头区分
    （如 lanjing_ios_pre）。"""
    if host.startswith('ios.'):
        return 'ios'
    if host.startswith('andr.'):
        return 'android'
    for name in ('realchannel', 'channel'):
        v = (headers.get(name) or '').lower()
        if 'ios' in v:
            return 'ios'
        if 'android' in v or 'andr' in v:
            return 'android'
    plat = (headers.get('plat') or '').strip().lower()
    return plat if plat in ('ios', 'android') else 'android'


def session_from_har(path):
    """Select latest same-account session and its preceding handshake.

    Some game replies are encrypted; only an actual download can confirm expiry.
    """
    with open(path, encoding='utf-8') as f:
        entries = json.load(f).get('log', {}).get('entries', [])
    # ProxyPin 等工具导出的 HAR 条目可能是倒序（新→旧），状态机必须按时间正序处理
    entries.sort(key=lambda e: e.get('startedDateTime') or '')
    account = key = selected = None
    context_headers = {}
    for entry in entries:
        req, res = entry.get('request', {}), entry.get('response', {})
        url = urlsplit(req.get('url', ''))
        if url.hostname not in HOSTS or url.path not in ('/api_check_user', '/api_command'):
            continue
        h, rh = envelope._headers(req), envelope._headers(res)
        payload = {}
        try:
            payload = json.loads(envelope._body(res, True) or b'{}')
        except (ValueError, TypeError):
            pass
        if not isinstance(payload, dict):
            payload = {}
        acc = h.get('acc')
        if url.path == '/api_check_user':
            data = payload.get('data')
            if isinstance(data, dict):
                acc = data.get('acc') or acc
            # A successful login response is a new session boundary. Ignore
            # failed checks so a transient retry cannot erase a usable session.
            if (not acc or not 200 <= res.get('status', 0) < 300
                    or payload.get('code') != 0):
                continue
            account = key = selected = None
            context_headers = {}
        if acc and acc != account:
            account, key, selected = acc, None, None
            context_headers = {}
        if account:
            context_headers.update({name: value for name, value in h.items()
                                    if name in COPY_HEADERS})
        if rh.get('k') and account:
            # A failed fresh handshake must invalidate an earlier working key.
            key = selected = None
            try:
                key = protocol.derive(account, rh['k'])['real_key']
            except ValueError:
                continue
        session = rh.get('session') or h.get('session')
        area = h.get('area') or h.get('server')
        if (url.path == '/api_command' and account and key and session
                and len(session) <= 4096 and re.fullmatch(r'[1-9][0-9]{0,5}', area or '')
                and 200 <= res.get('status', 0) < 300 and payload.get('code', 0) == 0):
            selected = dict(url=f'{url.scheme}://{url.hostname}/api_command',
                            account=account, session=session, area=area,
                            protocol_key=key, headers=context_headers.copy(),
                            platform=_platform_of(context_headers, url.hostname or ''))
    if selected is None:
        raise ValueError('HAR 未匹配到完整登录会话；请确保文件包含登录校验或同账号握手，以及登录后的区服请求（可在抓包过程中登录）')
    return selected


def rsa_wrap(message, modulus=RSA_N, exponent=65537):
    """RSAES-PKCS1-v1_5 public-key encryption, matching the APK's Cipher."""
    size = (modulus.bit_length() + 7) // 8
    if len(message) > size - 11:
        raise ValueError('RSA message too long')
    padding = bytes(secrets.randbelow(255) + 1 for _ in range(size - len(message) - 3))
    encoded = b'\x00\x02' + padding + b'\x00' + message
    return pow(int.from_bytes(encoded, 'big'), exponent, modulus).to_bytes(size, 'big')


def prepare(session):
    key = ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(16))
    auto = base64.b64encode(rsa_wrap(key.encode('ascii'))).decode('ascii')
    payload = json.dumps({'stamp': 0, 'auto': auto}, separators=(',', ':')).encode('ascii')
    body = base64.b64encode(xxtea.encrypt(payload, session['protocol_key']))
    headers = {k: v for k, v in session['headers'].items() if k in COPY_HEADERS}
    headers.update(acc=session['account'], session=session['session'], area=session['area'],
                   command='download3', **{'Content-Type': 'application/x-www-form-urlencoded',
                                           'Accept-Encoding': 'identity'})
    return body, headers, key


def decode_response(payload, key, session):
    if not isinstance(payload, dict) or payload.get('code') != 0:
        if isinstance(payload, dict) and payload.get('code') == 6:
            raise ValueError('登录会话已失效，请重新进入角色并导出新的 HAR')
        raise ValueError('游戏服务器未返回成功的 download3 响应')
    try:
        cipher = base64.b64decode(payload['data'], validate=True)
    except (ValueError, KeyError, TypeError):
        raise ValueError('download3 响应缺少合法存档数据') from None
    got = envelope.open_full(cipher, key, session['platform'])
    if not got:
        raise ValueError('响应未能通过本地内层解码校验；未回退到远端服务或残缺存档')
    data, version, inner_key = got
    if str(data.get('ServerID')) != session['area']:
        raise ValueError('返回存档区服与请求不一致')
    if data.get('EncryptID') and str(data['EncryptID']) != session['account']:
        raise ValueError('返回存档账号与请求不一致')
    if not all(field in data for field in ('MainRole', 'Roles', 'Rnds')):
        raise ValueError('返回存档缺少 MainRole/Roles/Rnds，不能作为完整存档')
    return data, version, inner_key


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch(session):
    """One download request to the original game host; never follows redirects."""
    url = urlsplit(session['url'])
    if (url.hostname not in HOSTS or url.scheme not in ('http', 'https')
            or url.path != '/api_command' or url.username or url.password or url.port):
        raise ValueError('请求目标不是受支持的游戏服务器')
    body, headers, key = prepare(session)
    request = urllib.request.Request(session['url'], data=body, headers=headers, method='POST')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=30) as response:
            raw = response.read(envelope.MAX_SAVE_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise ValueError(f'游戏服务器拒绝请求（HTTP {error.code}）；请确认 HAR 会话和登录状态仍有效') from None
    except (urllib.error.URLError, OSError):
        raise ValueError('游戏服务器连接失败；请检查网络及 HAR 会话有效期（未重试，未转发到其他服务）') from None
    if len(raw) > envelope.MAX_SAVE_BYTES:
        raise ValueError('游戏服务器响应超过大小限制')
    try:
        payload = json.loads(raw)
    except ValueError:
        raise ValueError('游戏服务器返回的不是有效 JSON') from None
    return decode_response(payload, key, session)


def acquire(har_path, avatar_field='auto'):
    """Acquire a complete save for the ordinary capture/output pipeline."""
    from .. import model
    from ..game import player, savefmt

    session = session_from_har(har_path)
    data, version, inner_key = fetch(session)
    result = model.SaveResult(
        source=har_path, kind='har', runtime=session['platform'],
        account=session['account'], save_id=savefmt.save_id_of(session['account']),
        server=session['area'], version='%08d' % int(version),
        inner_key=inner_key, data=data)
    # The chosen transport key is ephemeral, not a local dat.db outer key.
    result.player = player.build(data, result.version, avatar_field)
    result.step('数据来源', '主动 download3（完整存档，本地解码）')
    result.step('解密结果', f'{len(data)} 个字段（含 Rnds 世界种子）')
    return result


def command(args):
    session = session_from_har(args.har)
    print('已离线匹配登录握手、会话和区服（有效期需联网确认）；平台：' + session['platform'])
    if not args.fetch:
        print('尚未联网。使用 --fetch --output <新文件.json> 主动下载并本地解码。')
        return 0
    if not args.output:
        raise ValueError('--fetch 需要 --output 指定新 JSON 文件')
    # Reserve output before the request so existing user files cannot be overwritten.
    import os
    fd = os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        data, version, _ = fetch(session)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            fd = None
            json.dump(data, f, ensure_ascii=False)
    except BaseException:
        if fd is not None:
            os.close(fd)
        os.unlink(args.output)
        raise
    print(f'已保存完整存档（版本 {version}），可使用 rebuild 导入。')
    return 0


def add_parser(sub):
    p = sub.add_parser('retrieve', help='用有效 HAR 会话主动下载云存档（默认仅离线检查）')
    p.add_argument('har', help='从登录前开始抓取的 HAR')
    p.add_argument('--fetch', action='store_true', help='向原游戏服务器发起一次 download3')
    p.add_argument('--output', help='完整 JSON 的新输出路径，不覆盖已有文件')
    p.set_defaults(func=command)
