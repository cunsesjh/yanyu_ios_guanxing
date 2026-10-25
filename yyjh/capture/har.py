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
