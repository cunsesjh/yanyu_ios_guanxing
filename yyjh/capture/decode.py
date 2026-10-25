# -*- coding: utf-8 -*-
"""抓包 HAR -> 存档（SaveResult）。

关键点：**外层解开后拿到的 base64 文本就是"初版" content**
（网络外层用的是服务器下发的 realKey，正好替代了那个每账号随机、
 只存在内存里的"外层密钥"），所以不需要重新加密任何数据。
"""
import os

from .. import model
from ..core import codecs, xxtea
from ..game import player as player_mod
from ..game import protocol, savefmt
from .har import Har


def pick_entry(har, index=None):
    ups = har.uploads()
    if not ups:
        raise ValueError('HAR 里没有 upload 请求（抓包时游戏没上传存档？）')
    if index is not None:
        if not (0 <= index < len(ups)):
            raise ValueError(f'--index 超范围（共 {len(ups)} 个）')
        return ups[index], len(ups)
    return max(ups, key=har.body_len), len(ups)


def _outer_ok(cipher, key):
    """外层解密 + 强校验。成功返回 (content, version, inner)，失败 None。

    校验很严：解出的必须是 ASCII base64 文本，且 savefmt.parse_old 认账
    （版本号 8 位数字 + 内层密文 4 字节对齐）—— 随机钥匙误报概率 ~1e-9，
    所以可以放心拿它当预言机去试一堆候选组合。
    """
    x = xxtea.decrypt(cipher, key)
    if x is None:
        return None
    try:
        content = x.decode('ascii')
    except UnicodeDecodeError:
        return None
    try:
        version, inner = savefmt.parse_old(content)
    except ValueError:
        return None
    return content, version, inner


def inner_body(har_path, index=None, real_key=None, steps=None):
    """HAR -> 只做到「初版 content」为止。

    返回 dict: version / body / runtime / account / save_id / server / content
    其中 body 是**内层 XXTEA 密文** —— 缺内层密钥时拿它去爆破
    （`yyjh key crack --har` 就是这么干的）。

    为什么单独抽出来：内层密钥不知道时，外层其实已经能免费解开 ——
    抓包里的 realKey 顶替了那把只存在内存里的「外层密钥」，
    所以「密钥表过期」根本不该妨碍我们从抓包里拿到爆破靶子。

    ⚠ 会自动穷举「哪个 upload × 哪个 k 响应头 × 请求体怎么解码」：
    一次抓包里 k 常常有多份（登录 / startGame / 重启各一次），
    拿错会话的 k 推出的 realKey 就解不开外层（报「realKey 不对」）。
    """
    say = steps or (lambda *a, **k: None)
    har = Har(har_path)
    say('HAR', f'{os.path.basename(har_path)}  共 {len(har.entries)} 条记录')

    ups = har.uploads()
    if not ups:
        raise ValueError('HAR 里没有 upload 请求（抓包时游戏没上传存档？）')
    if index is not None:
        if not (0 <= index < len(ups)):
            raise ValueError(f'--index 超范围（共 {len(ups)} 个）')
        tried_ups = [ups[index]]
    else:
        tried_ups = sorted(ups, key=har.body_len, reverse=True)
    entry = tried_ups[0]
    if len(ups) > 1:
        say('选择 upload',
            f'共 {len(ups)} 个，按请求体大小排序，最大的 {har.body_len(entry):,} 字符')

    acc = har.account(entry)
    if not acc:
        raise ValueError('upload 请求里没有 acc 请求头')
    runtime = 'ios' if protocol.is_ios(acc) else 'android'
    server = har.server(entry) or ''
    say('账号 acc', f'{acc}   平台 = {runtime}   服 = {server or "?"}')
    save_id = savefmt.save_id_of(acc)
    say('save.id', f'md5(acc) = {save_id}')

    # ── 候选 realKey：--real-key 指定，或从**每一处** k 响应头各自推一把 ──
    key_cands = []            # [(标签, real_key, 推导信息 or None)]
    if real_key:
        say('realKey', f'{real_key}  (命令行指定)')
        key_cands.append(('--real-key', real_key, None))
    else:
        ks = har.k_sources()
        if not ks:
            raise ValueError('HAR 里没有带 k 的响应头 —— 请从"打开游戏之前"开始抓，'
                             '或用 --real-key 手动指定')
        if len(ks) > 1:
            say('k 响应头', f'共 {len(ks)} 处（同一次抓包里有多次会话？），逐个试')
        for ki, _e, kv in ks:
            try:
                info = protocol.derive(acc, kv)
            except ValueError:
                continue                      # 这条 k 跟 acc 对不上，跳过
            key_cands.append((f'k#{ki}', info['real_key'], info))
        if not key_cands:
            raise ValueError('k 头解密失败或种子长度非法（acc 取错了？）')

        # ── 兔底：万一游戏更新后 realKey 不再取 innerK[:6]，
        # 把种子里每个 6 字节窗口都当候选试一遍（长度预言机会挑出对的）──
        for ki, _e, kv in ks:
            try:
                info = protocol.derive(acc, kv)
            except ValueError:
                continue
            seed = info['inner_k']
            for off in range(0, max(1, len(seed) - 5)):
                rk = protocol.protocol_key(acc, seed[off:off + 6]).decode('ascii')
                if rk != info['real_key']:
                    key_cands.append((f'k#{ki} 种子窗口[{off}:{off + 6}]', rk, None))

    # ── 穷举：upload × 请求体解释 × realKey，用长度字预言机挑对的 ──
    hit = None
    for u in tried_ups:
        if hit:
            break
        for vlabel, payload in Har.body_variants(u):
            if hit:
                break
            cands = []
            c = codecs.b64d(payload)
            if c:
                cands.append(('base64', c))
            if len(payload) >= 8 and len(payload) % 4 == 0:
                cands.append(('原始字节', bytes(payload)))
            for clabel, cipher in cands:
                for klabel, rk, info in key_cands:
                    got = _outer_ok(cipher, rk)
                    if got:
                        hit = (u, vlabel, clabel, klabel, rk, info, cipher, got)
                        break

    if hit is None:
        n_body = sum(max(1, len(Har.body_variants(u))) for u in tried_ups)
        raise ValueError(
            f'外层解密失败（realKey 不对）—— 试了 {len(tried_ups)} 个 upload × '
            f'{len(key_cands)} 把 realKey × {n_body} 种请求体解释，全部不匹配。\n'
            '排查建议（按可能性排序）:\n'
            '  1. 抓包必须从「打开游戏之前」开始，一次会话内完成 '
            '（登录 -> 开始游戏 -> 上传存档）后**立刻停止抓包**；\n'
            '     中途关过游戏 / 重新登录过，HAR 里会有两份 k，拿错那份就解不开外层。\n'
            '  2. 确认游戏里真的上传过存档（HAR 里最大的那个 upload 就是它）；\n'
            '  3. 如果游戏最近更新过、协议变了，用 --real-key <16位> 手动指定外层密钥。')

    u, vlabel, clabel, klabel, rk, info, cipher, (content, version, inner) = hit
    if info:
        say('key0', info['key0'])
        say('innerK', repr(info['inner_k']))
    say('realKey', f'{rk}  ← {klabel}')
    if klabel != '--real-key' or len(tried_ups) > 1 or vlabel != 'postData.text':
        say('命中组合', f'upload[{har.uploads().index(u)}] / {klabel} / {vlabel}')
    say('外层解密', f'{len(cipher):,}B -> {len(content):,} '
                   f'字符 base64  ← 即初版 content')
    say('版本号', version)
    return {'version': version, 'body': inner, 'runtime': runtime, 'account': acc,
            'save_id': save_id, 'server': server, 'content': content,
            # realKey 就是「外层密钥」那把（它只存在服务器的响应里，
            # 本地存档要解时得去内存挖）—— 白送的，调用方可以记下来复用
            'outer_key': rk}


def decode(har_path, index=None, real_key=None, inner_key=None,
           avatar_field='auto'):
    """返回 SaveResult。"""
    r = model.SaveResult(source=har_path, kind='har')
    info = inner_body(har_path, index=index, real_key=real_key, steps=r.step)
    version, inner = info['version'], info['body']
    r.account, r.runtime = info['account'], info['runtime']
    r.server, r.save_id = info['server'], info['save_id']
    r.content, r.version = info['content'], version
    r.outer_key = info.get('outer_key') or ''

    # ── 内层 -> JSON ──
    cands = savefmt.inner_candidates(r.runtime, version, inner_key)
    data, used = savefmt.try_inner(inner, cands)
    if data is None:
        raise savefmt.InnerKeyMissing(version, r.runtime,
                                      tried=len(cands), fmt=savefmt.OLD)
    r.data = data
    r.inner_key = used
    r.step('内层密钥', f'{used}  ({len(cands)} 个候选中命中)')
    r.step('解密结果', f'{len(data)} 个字段   角色 = {r.nick!r}')

    r.player = player_mod.build(data, version, avatar_field)
    r.step('player 摘要', r.player)

    enc = data.get('EncryptID')
    if enc and enc != info['account']:
        r.warn(f'JSON 里的 EncryptID（{enc}）与 acc 不一致')
    return r
