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


def _cipher_cands(payload):
    """载荷 -> 密文候选。除常规 base64/原始字节外，
    还兼容「8 字节标记 + base64(...)」这种新版外壳（与存档 NEW 格式同构）。"""
    out = []
    c = codecs.b64d(payload)
    if c:
        out.append(('base64', c))
    if len(payload) >= 8 and len(payload) % 4 == 0:
        out.append(('原始字节', bytes(payload)))
    if len(payload) > 16:
        c2 = codecs.b64d(payload[8:])
        if c2 and len(c2) % 4 == 0:
            out.append(('去8字节头', c2))
    return out


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


def _real_key_cands(har, acc, real_key, say):
    """候选 realKey 列表 [(标签, real_key, derive信息 or None)]。

    --real-key 指定则唯一；否则从**每一处** k 响应头各自推一把 ——
    一次抓包里 k 常常有多份（登录 / startGame / 重启各一次），
    拿错会话的 k 推出的 realKey 就解不开外层（报「realKey 不对」）。
    末尾再附种子窗口兜底：万一游戏更新后 realKey 不再取 innerK[:6]，
    把种子里每个 6 字节窗口都当候选试一遍（校验预言机会挑出对的）。
    """
    if real_key:
        say('realKey', f'{real_key}  (命令行指定)')
        return [('--real-key', real_key, None)]
    ks = har.k_sources()
    if not ks:
        raise ValueError('HAR 里没有带 k 的响应头 —— 请从"打开游戏之前"开始抓，'
                         '或用 --real-key 手动指定')
    if len(ks) > 1:
        say('k 响应头', f'共 {len(ks)} 处（同一次抓包里有多次会话？），逐个试')
    out = []
    for ki, _e, kv in ks:
        try:
            info = protocol.derive(acc, kv)
        except ValueError:
            continue                      # 这条 k 跟 acc 对不上，跳过
        out.append((f'k#{ki}', info['real_key'], info))
    if not out:
        raise ValueError('k 头解密失败或种子长度非法（acc 取错了？）')
    for ki, _e, kv in ks:
        try:
            info = protocol.derive(acc, kv)
        except ValueError:
            continue
        seed = info['inner_k']
        for off in range(0, max(1, len(seed) - 5)):
            rk = protocol.protocol_key(acc, seed[off:off + 6]).decode('ascii')
            if rk != info['real_key']:
                out.append((f'k#{ki} 种子窗口[{off}:{off + 6}]', rk, None))
    return out


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
    runtime = har.platform_hint(entry) or ('ios' if protocol.is_ios(acc) else 'android')
    server = har.server(entry) or ''
    say('账号 acc', f'{acc}   平台 = {runtime}   服 = {server or "?"}')
    save_id = savefmt.save_id_of(acc)
    say('save.id', f'md5(acc) = {save_id}')

    # ── 候选 realKey：--real-key 指定，或从每一处 k 响应头各自推一把 ──
    key_cands = _real_key_cands(har, acc, real_key, say)

    # ── 穷举：upload × 请求体解释 × realKey，用长度字预言机挑对的 ──
    hit = None
    for u in tried_ups:
        if hit:
            break
        for vlabel, payload in Har.body_variants(u):
            if hit:
                break
            for clabel, cipher in _cipher_cands(payload):
                for klabel, rk, info in key_cands:
                    got = _outer_ok(cipher, rk)
                    if got:
                        hit = (u, vlabel, clabel, klabel, rk, info, cipher, got)
                        break

    if hit is None:
        # ── 失败诊断：把现场数据 dump 出来，方便定位是协议变了还是抓包不对 ──
        lines = [
            f'外层解密失败（realKey 不对）—— 试了 {len(tried_ups)} 个 upload × '
            f'{len(key_cands)} 把 realKey，全部不匹配。',
            '现场数据（发给维护者就能定位）：']
        for ki, ke, kv in har.k_sources()[:5]:
            try:
                info = protocol.derive(acc, kv)
                seed = info['inner_k']
                lines.append(f'  k#{ki}: seed长度={len(seed)} seed={seed.hex()} '
                             f'realKey={info["real_key"]}')
            except ValueError:
                lines.append(f'  k#{ki}: 解不开（acc 对不上？） k={kv[:40]}')
        for u in tried_ups[:5]:
            body = Har.body(u) or b''
            if not isinstance(body, (bytes, bytearray)):
                body = body.encode('utf-8', 'replace')
            raw = codecs.b64d(body) or b''
            lines.append(
                f'  upload cmd={Har.header(u, "command") or "?"} '
                f'acc={Har.header(u, "acc")} ver={Har.header(u, "ver")} '
                f'area={Har.header(u, "area")} body长度={len(body)} '
                f'密文头32B={bytes(raw[:32]).hex()}')
        lines += [
            '排查建议（按可能性排序）:',
            '  1. 抓包必须从「打开游戏之前」开始，一次会话内完成 '
            '（登录 -> 开始游戏 -> 上传存档）后**立刻停止抓包**；',
            '  2. 确认游戏里真的上传过存档（HAR 里最大的那个 upload 就是它）；',
            '  3. 上面 dump 里 ver 头比密钥表新的话，是**游戏更新改了协议**，',
            '     把这份 dump（连同 HAR）交给维护者分析新协议。']
        raise ValueError('\n'.join(lines))

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


def download_body(har_path, real_key=None, steps=None):
    """新版（v73492+）完整存档提取：download 命令的响应。

    响应是**明文 JSON**：{saveCode, extra, data, code}
      · data  = 初版 content = base64(版本号(8) + XXTEA(zlib(json), 内层密钥))
      · extra = base64(XXTEA(psw(8), realKey))
                —— 内层密钥的 psw（前 8 位）由服务器随下载下发；
                    后 8 位是渠道后缀（iOS = yoqkmrtj），逐个试到 zlib 解开为准。

    一条响应同时拿到完整存档（含 Rnds 世界种子）和新版本内层密钥，
    是 v73492+ 存档本体被安全信封包住后的**正路**。
    返回 dict: content / version / data / psw / inner_key / account /
               save_id / server / runtime / real_key
    """
    import base64
    import json as _json
    import zlib

    from ..config import keytables

    say = steps or (lambda *a, **k: None)
    har = Har(har_path)
    cands = har.download_entries()
    if not cands:
        raise ValueError('HAR 里没有 download 请求（游戏里点一次「下载」再抓包）')

    # ── 逐条找「真·存档下载」：响应得是带 data+extra 的 JSON；
    # 响应体可能是 base64 转码存的（Har.resp_text 统一还原）──
    def _load_json(txt):
        try:
            return _json.loads(txt)
        except Exception:                                  # noqa: BLE001
            pass
        try:
            return _json.loads(codecs.b64d(txt) or b'')
        except Exception:                                  # noqa: BLE001
            return None

    e = j = None
    skipped = []
    for e2 in cands:
        txt = Har.resp_text(e2)
        jj = _load_json(txt) if txt else None
        if jj is None:
            skipped.append(f'[{Har.header(e2, "command") or "?"}] 响应不是 JSON'
                           f'（前 40 字 {txt[:40]!r}）')
            continue
        if not (jj.get('data') and jj.get('extra')):
            skipped.append(f'[{Har.header(e2, "command") or "?"}] 是 JSON 但缺 '
                           'data/extra（不是存档下载）')
            continue
        e, j = e2, jj
        break
    if j is None:
        raise ValueError('HAR 里有 download 请求，但没有一条是可解析的存档下载：'
                         + '；'.join(skipped) +
                         ' —— 抓包时请在游戏里点「下载」拉一次云端存档')
    say('download 响应', f'明文 JSON：saveCode={j.get("saveCode")!r}')

    acc = har.account(e) or har.account()
    if not acc:
        raise ValueError('找不到 acc 请求头')
    runtime = har.platform_hint(e) or ('ios' if protocol.is_ios(acc) else 'android')
    server = har.server(e) or har.server() or ''
    save_id = savefmt.save_id_of(acc)

    key_cands = _real_key_cands(har, acc, real_key, say)

    # ── data -> 初版 content -> 内层密文 ──
    content = j['data']
    version, inner = savefmt.parse_old(content)
    say('版本号', version)

    # ── extra -> psw（8 字符）× 渠道后缀 -> 内层密钥；
    # 多把 realKey 候选都要试到**完整链路**（zlib 解开）为止，
    # 不能被某个候选随机解出的 8 位 ASCII 骗到 ──
    tried = []
    got_psw = False
    for klabel, rk, info in key_cands:
        blob = codecs.b64d(j['extra'])
        psw_b = xxtea.decrypt(blob, rk) if blob else None
        if not psw_b:
            continue
        try:
            psw = psw_b.decode('ascii')
        except UnicodeDecodeError:
            continue
        if len(psw) != 8:
            continue
        got_psw = True
        for suf in list(keytables.CHANNEL_SUFFIXES) + ['00000000']:
            ik = (psw + suf)[:16]
            tried.append(ik)
            x = xxtea.decrypt(inner, ik)
            if x:
                try:
                    data = _json.loads(zlib.decompress(x))
                except Exception:                              # noqa: BLE001
                    continue
                say('realKey', f'{rk}  ← {klabel}')
                if info:
                    say('key0', info['key0'])
                say('内层 psw', f'{psw!r}（extra 字段下发）')
                say('内层密钥', f'{ik}  (psw + 后缀 {suf})')
                say('解密结果', f'{len(data)} 个字段   角色 = '
                               f'{(data.get("MainRole") or {}).get("Name")!r}')
                return {'content': content, 'version': version, 'data': data,
                        'psw': psw, 'inner_key': ik, 'account': acc,
                        'save_id': save_id, 'server': server, 'runtime': runtime,
                        'real_key': rk}
    if not got_psw:
        raise ValueError(f'extra 解不开（试了 {len(key_cands)} 把 realKey）—— '
                         'realKey 不对，或 extra 字段格式变了')
    raise savefmt.InnerKeyMissing(version, runtime, tried=len(tried),
                                  fmt=savefmt.OLD)


def power_data(har_path, real_key=None, steps=None):
    """新版（v73492+）存档提取：从 uploadPower.data 取角色/装备数据。

    背景：v73492 起存档本体（upload3）不再走 realKey 信封，被"安全信封"
    包住（marker+base64 + 未知密钥，疑似每账号外层密钥 / ?K 参数里
    RSA 包裹的会话密钥），HAR 里解不开。但同一会话的 uploadPower 仍走
    标准信封，其明文 JSON 的 data 字段 = base64(zlib(角色数组 JSON))，
    含全部角色 + 装备 + 打造/洗练种子（MJSeed/SeedBeforeXL/CZSeed）。

    返回 dict: summary / roles / account / save_id / server / version / real_key
    """
    import base64
    import json as _json
    import zlib

    say = steps or (lambda *a, **k: None)
    har = Har(har_path)
    e = har.power_upload()
    if e is None:
        raise ValueError('HAR 里没有 uploadPower 请求 —— 新版存档提取需要它')
    acc = har.account(e)
    if not acc:
        raise ValueError('uploadPower 请求里没有 acc 请求头')

    key_cands = _real_key_cands(har, acc, real_key, say)

    body = Har.body(e)
    cipher = body if isinstance(body, (bytes, bytearray)) else codecs.b64d(body)
    if cipher is None:
        raise ValueError('uploadPower 请求体不是合法 base64')
    summary = None
    for klabel, rk, info in key_cands:
        plain = xxtea.decrypt(bytes(cipher), rk)
        if plain is None:
            continue
        try:
            summary = _json.loads(plain.decode('utf-8'))
        except Exception:                                  # noqa: BLE001
            continue                                       # 这把 key 不对，换下一把
        say('realKey', f'{rk}  ← {klabel}')
        if info:
            say('key0', info['key0'])
        break
    if summary is None:
        raise ValueError(f'uploadPower 解不开（试了 {len(key_cands)} 把 realKey）')
    say('信封解密', f'uploadPower -> JSON（{len(summary)} 个字段）')

    try:
        blob = base64.b64decode(summary.get('data') or '')
        roles = _json.loads(zlib.decompress(blob))
    except Exception as e2:                              # noqa: BLE001
        raise ValueError(f'uploadPower.data 解析失败: {e2}')
    say('data 字段', f'base64 + zlib -> {len(roles)} 个角色对象（含装备/种子）')

    ver_num = str(summary.get('version') or '')
    return {
        'summary': summary,
        'roles': roles,
        'account': acc,
        'save_id': savefmt.save_id_of(acc),
        'server': har.server(e) or '',
        'version': ver_num.zfill(8) if ver_num.isdigit() else ver_num,
        'real_key': rk,
        'runtime': har.platform_hint(e) or ('ios' if protocol.is_ios(acc) else 'android'),
    }


def power_save(info):
    """uploadPower 提取物 -> 旧形状存档 dict（dat.json / player 摘要都能用）。

    字段映射与 player.py 的注释一一对应；角色对象原样放在 MainRole / Roles，
    网页版要的打造/洗练状态就在角色的 Equips 里。"""
    roles = info.get('roles') or []
    s = info.get('summary') or {}
    main = next((r for r in roles
                 if r.get('IsMaster') or r.get('IsZhu') or r.get('ID') == 1),
                roles[0] if roles else {})
    return {
        'MainRole': main,
        'Roles': roles,
        'globalVariable': {'repute': s.get('prestige', 0)},
        'Energy': s.get('energy', 0),
        'Money': s.get('money', 0),
        'SavCode': s.get('saveCode', 0),
        'Yue': s.get('yue', 0),
    }


def decode(har_path, index=None, real_key=None, inner_key=None,
           avatar_field='auto'):
    """返回 SaveResult。"""
    r = model.SaveResult(source=har_path, kind='har')

    # ── ① 新版正路：download 响应里有完整存档 + 新版内层密钥 ──
    dl_err = None
    if Har(har_path).download_entry() is not None:
        try:
            d = download_body(har_path, real_key=real_key, steps=r.step)
            r.account, r.runtime = d['account'], d['runtime']
            r.server, r.save_id = d['server'], d['save_id']
            r.version, r.content, r.data = d['version'], d['content'], d['data']
            r.outer_key, r.inner_key = d['real_key'], d['inner_key']
            r.step('数据来源', 'download 响应（完整存档，含 Rnds 世界种子）')
            r.player = player_mod.build(r.data, r.version, avatar_field)
            r.step('player 摘要', r.player)
            enc = r.data.get('EncryptID')
            if enc and enc != d['account']:
                r.warn(f'JSON 里的 EncryptID（{enc}）与 acc 不一致')
            return r
        except savefmt.InnerKeyMissing:
            raise
        except ValueError as e:
            dl_err = str(e)
            r.step('download 路径', f'没走通（{e}），回退旧路径')

    try:
        info = inner_body(har_path, index=index, real_key=real_key, steps=r.step)
    except ValueError as e:
        if '外层解密失败' not in str(e):
            raise
        # ── 新版安全信封：存档本体解不开，退而从 uploadPower.data 提取 ──
        pinfo = power_data(har_path, real_key=real_key, steps=r.step)
        r.account, r.runtime = pinfo['account'], pinfo['runtime']
        r.server, r.save_id = pinfo['server'], pinfo['save_id']
        r.version = pinfo['version']
        r.outer_key = pinfo['real_key']
        r.data = power_save(pinfo)
        r.step('数据来源',
               'uploadPower.data（v73492+ 存档本体被安全信封包住，HAR 里解不开）')
        r.step('解密结果', f'{len(r.data)} 个字段   角色 = {r.nick!r}')
        r.player = player_mod.build(r.data, r.version, avatar_field)
        r.step('player 摘要', r.player)
        r.warn('存档本体 upload3 被新版安全信封包住（非 realKey 信封），'
               '本次数据来自同会话的 uploadPower.data（角色+装备+打造/洗练种子）。'
               '⚠ 这份 dat.json 不含 Rnds.Sds.* 世界种子，网页的鬼市/家园等模块 '
               '会报「缺少 Rnds.Sds.guishishop 种子」一类错误；'
               '要完整存档请重抓一次并在游戏里点「下载」拉云端存档')
        if dl_err:
            r.warn(f'HAR 里那条 download 响应本次没解析成功：{dl_err}')
        return r
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
