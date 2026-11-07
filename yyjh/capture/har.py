# -*- coding: utf-8 -*-
"""HAR 读取 —— 只负责"把抓包文件变成好用的对象"，不做任何解密。"""
import json
import os

UPLOAD_CMDS = ('upload', 'upload2', 'upload_auto', 'upload_auto2', 'save')


class Har:
    def __init__(self, path):
        self.path = path
        with open(path, encoding='utf-8') as f:
            self.raw = json.load(f)
        try:
            self.entries = self.raw['log']['entries']
        except (KeyError, TypeError):
            raise ValueError('不是合法的 HAR 文件（缺 log.entries）')

    # ── 小工具 ──
    @staticmethod
    def header(entry, name, where='request'):
        for h in (entry.get(where) or {}).get('headers', []) or []:
            if (h.get('name') or '').lower() == name.lower():
                return (h.get('value') or '').strip()
        return None

    @staticmethod
    def body(entry):
        """请求体文本；若声明了 base64 编码则自动解码成 bytes。"""
        import base64
        pd = (entry.get('request') or {}).get('postData') or {}
        txt = pd.get('text')
        if txt is None:
            return None
        if (pd.get('encoding') or '').lower() == 'base64':
            try:
                return base64.b64decode(txt)
            except Exception:
                return txt
        return txt.strip()

    @staticmethod
    def body_variants(entry):
        """请求体的**几种解释**，返回 [(标签, 载荷 bytes)]。

        不同抓包工具（以及 ProxyPin 的不同版本）导出 HAR 时对 postData
        的处理不一样，同一份数据可能有三种形态：
          1. text = 裸的 base64 载荷（游戏原始请求体）
          2. encoding='base64'，text = base64(游戏原始请求体)   ← 多套一层
          3. encoding='base64'，text = base64(base64(密文))     ← 套两层
        每种解释都当作候选交给上层试解，靠 XXTEA 长度字预言机挑对的那个。
        """
        import base64
        pd = (entry.get('request') or {}).get('postData') or {}
        txt = pd.get('text')
        if txt is None:
            return []

        def _d(s):
            try:
                return base64.b64decode(s, validate=False)
            except Exception:
                return None

        out = []
        if (pd.get('encoding') or '').lower() == 'base64':
            raw = _d(txt)
            if raw:
                out.append(('postData.encoding=base64', raw))
                inner = _d(raw)
                if inner:
                    out.append(('双层 base64', inner))
        s = (txt or '').strip()
        if s:
            out.append(('postData.text', s.encode('utf-8')))
        return out

    def body_len(self, entry):
        b = self.body(entry)
        return len(b) if b else 0

    # ── 查询 ──
    def api_entries(self, keyword='api_command'):
        return [e for e in self.entries
                if keyword in ((e.get('request') or {}).get('url') or '')]

    def uploads(self):
        out = []
        for e in self.entries:
            cmd = self.header(e, 'command') or ''
            if cmd.lower().startswith(UPLOAD_CMDS):
                out.append(e)
        return out

    def power_upload(self):
        """新版（v73492+）：角色/装备数据走 uploadPower 标准信封。

        存档本体 upload3 被"安全信封"包住（解不开），但同一个会话里
        uploadPower 的明文 JSON 带 data 字段 = base64(zlib(角色数组))，
        含全部角色 + 装备 + 打造/洗练种子 —— 从这里取数据。
        """
        for e in self.uploads():
            if (self.header(e, 'command') or '').lower() == 'uploadpower':
                return e
        return None

    def download_entry(self):
        """download 命令 —— 服务器把**完整存档**发回来的那条（取响应最长的一条）。"""
        es = self.download_entries()
        return es[0] if es else None

    def download_entries(self):
        """所有 download 类命令的条目，按响应长度降序。

        新版（v73492+）存档本体 upload3 被安全信封包住解不开，但游戏里
        点「下载」拉云端存档时，响应是明文 JSON：
            {saveCode, extra, data, code}
        · data  = 初版 content = base64(版本号 + XXTEA(zlib(json), 内层密钥))
        · extra = base64(XXTEA(psw(8), realKey)) —— 内层密钥的 psw 由它下发
        一条响应同时拿到完整存档（含 Rnds 世界种子）和新版本内层密钥。

        ⚠ 一次抓包里可能有多条 download 类请求（资源下载等）——
        是不是存档下载要看响应里有没有 data+extra，由上层逐条判定。
        """
        out = []
        for e in self.entries:
            cmd = (self.header(e, 'command') or '').lower()
            if cmd.startswith('download') or cmd in ('down', 'down2', 'getsave'):
                out.append(e)
        return sorted(out, key=self.resp_len, reverse=True)

    @staticmethod
    def resp_text(entry):
        """响应体文本 —— 统一还原 HAR 导出工具的各种转码。

        ProxyPin / Charles 等导出 HAR 时可能把响应体 base64 存
        （content.encoding='base64'），甚至套两层；
        直接 json.loads 会炸。解不出来返回 ''。
        """
        resp = entry.get('response') or {}
        c = resp.get('content') or {}
        txt = c.get('text')
        if txt is None:
            txt = resp.get('text')
        if not txt:
            return ''
        if (c.get('encoding') or '').lower() == 'base64':
            def _d(s):
                try:
                    return base64.b64decode(s)
                except Exception:
                    return None
            raw = _d(txt.strip())
            if raw is not None:
                try:
                    txt = raw.decode('utf-8')
                except UnicodeDecodeError:
                    raw2 = _d(raw)
                    txt = (raw2 if raw2 is not None else raw).decode('utf-8', 'replace')
        return (txt or '').lstrip('\ufeff').strip()

    @staticmethod
    def resp_len(entry):
        return len(((entry.get('response') or {}).get('content') or {}).get('text') or '')

    def platform_hint(self, entry=None):
        """平台判断线索：realchannel/channel 请求头 > URL 主机 > acc 形态。

        新版（v73492+）acc 不再是邮箱而是随机 token，不能靠 '@' 判平台。
        """
        e = entry or self.largest_upload() or (self.entries[0] if self.entries else None)
        if not e:
            return None
        for name in ('realchannel', 'channel'):
            v = self.header(e, name)
            if v:
                return 'ios' if 'ios' in v.lower() else 'android'
        url = ((e.get('request') or {}).get('url') or '').lower()
        if 'ios.' in url or '/ios' in url:
            return 'ios'
        if 'android' in url:
            return 'android'
        return None

    def largest_upload(self):
        """存档上传的请求体最大；内力/坐标上传都很小。"""
        ups = self.uploads()
        if not ups:
            return None
        return max(ups, key=self.body_len)

    def key_source(self):
        """找到带 k 响应头的那条（通常是登录或 startGame 的响应）。"""
        for e in self.entries:
            if self.header(e, 'k', 'response'):
                return e
        return None

    def k_header(self):
        e = self.key_source()
        return self.header(e, 'k', 'response') if e else None

    def k_sources(self):
        """所有带 k 响应头的响应，按 HAR 顺序返回 [(entry序号, entry, k值)]。

        ⚠ 一次抓包里 k 常常出现多次（登录 / startGame / 重启游戏各一次），
        每次会话的 k 都不一样 —— 拿错会话的 k 推出的 realKey 就解不开外层。
        """
        out = []
        for i, e in enumerate(self.entries):
            v = self.header(e, 'k', 'response')
            if v:
                out.append((i, e, v))
        return out

    def account(self, entry=None):
        e = entry or self.largest_upload()
        return self.header(e, 'acc') if e else None

    def server(self, entry=None):
        e = entry or self.largest_upload()
        return self.header(e, 'area') if e else None

    def overview(self):
        return {
            'file': os.path.basename(self.path),
            'entries': len(self.entries),
            'api_entries': len(self.api_entries()),
            'uploads': [(i, self.header(e, 'command'), self.header(e, 'acc'),
                         self.header(e, 'ver'), self.header(e, 'area'),
                         self.body_len(e))
                        for i, e in enumerate(self.uploads())],
            'has_k': bool(self.k_header()),
        }
