"""国际服（xinma 等）旧式 download：空体请求 + 明文响应。"""
import base64
import json
import unittest
import zlib
from unittest.mock import patch

from yyjh.capture import retrieve
from yyjh.core import xxtea

REAL_KEY = '10338qwmyk391945'
PSW = '2dsf45ad'
SUFFIX = 'meeo0wmk'
VERSION = '00073680'

SESSION = dict(url='http://yanyuonline.novastargame.net/api_command',
               account='103389291', session='5055803939', area='31',
               protocol_key=REAL_KEY, platform='ios',
               headers={'ver': '73680', 'channel': 'xinma_ios'})


def make_payload():
    save = {'MainRole': {'Name': '测试'}, 'Roles': [{}], 'Rnds': {'x': 1},
            'ServerID': 31, 'EncryptID': '103389291'}
    inner = xxtea.encrypt(zlib.compress(json.dumps(save).encode('utf-8')),
                          PSW + SUFFIX)
    content = base64.b64encode(VERSION.encode() + inner).decode('ascii')
    extra = base64.b64encode(xxtea.encrypt(PSW.encode('ascii'),
                                           REAL_KEY)).decode('ascii')
    return {'saveCode': 'x', 'extra': extra, 'data': content, 'code': 0}, save


class PlainDownloadTests(unittest.TestCase):
    def test_decode_plain_response_uses_extra_psw(self):
        payload, save = make_payload()
        data, version, inner_key = retrieve.decode_plain_response(payload, SESSION)
        self.assertEqual(version, 73680)
        self.assertEqual(inner_key, PSW + SUFFIX)
        self.assertEqual(data['MainRole']['Name'], '测试')

    def test_prepare_plain_mimics_game(self):
        url, body, headers = retrieve.prepare_plain(SESSION)
        self.assertTrue(url.startswith(SESSION['url'] + '?'))  # 设备号在查询串
        self.assertEqual(body, b'')                            # 空请求体
        self.assertEqual(headers['command'], 'download')
        self.assertEqual(headers['acc'], '103389291')
        # 查询串 = XXTEA({"sn":...,"sn2":"unknow"}, 协议密钥)
        q = base64.b64decode(url.split('?', 1)[1] + '==')
        blob = json.loads(xxtea.decrypt(q, REAL_KEY))
        self.assertEqual(blob['sn2'], 'unknow')
        self.assertEqual(len(blob['sn']), 36)                  # UUID 形态，不复用真实设备号

    def test_fetch_dispatches_plain_host(self):
        payload, _ = make_payload()

        class R:
            status = 200
            def read(self, n=-1):
                return json.dumps(payload).encode('utf-8')
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False

        class Opener:
            def open(self, req, timeout=None):
                self.req = req
                return R()

        opener = Opener()
        with patch('urllib.request.build_opener', return_value=opener):
            data, version, inner_key = retrieve.fetch(SESSION)
        self.assertEqual(version, 73680)
        self.assertEqual(inner_key, PSW + SUFFIX)
        self.assertIn('download', opener.req.get_header('Command'))
        self.assertEqual(opener.req.data, b'')

    def test_plain_response_rejects_wrong_account(self):
        payload, _ = make_payload()
        bad = dict(SESSION, account='999')
        with self.assertRaises(ValueError) as ctx:
            retrieve.decode_plain_response(payload, bad)
        self.assertIn('账号', str(ctx.exception))

    def test_session_from_international_har_host(self):
        # 国际服主机 + xinma_ios 渠道 -> 平台 ios（主机不在 ios./andr. 前缀里）
        self.assertEqual(
            retrieve._platform_of({'channel': 'xinma_ios'},
                                  'yanyuonline.novastargame.net'), 'ios')
        self.assertEqual(
            retrieve._platform_of({'realchannel': 'xinma_android'},
                                  'yanyuonline.novastargame.net'), 'android')
        self.assertIn('yanyuonline.novastargame.net', retrieve.HOSTS)

    def test_session_survives_proxypin_reverse_order(self):
        # ProxyPin 导出倒序（新的在前）：api_check_user 登录在文件末尾，
        # 不能把最后提取的会话状态冲掉。
        import base64
        import tempfile
        from pathlib import Path
        from yyjh.core import xxtea as _xx
        from yyjh.game import protocol
        host = 'yanyuonline.novastargame.net'

        def entry(t, path, cmd=None, k=None, acc='103389291',
                  resp='{"code":0}'):
            rh = [{'name': 's', 'value': '5055803939'}]
            if k:
                rh.append({'name': 'k', 'value': k})
            req_h = [{'name': 'session', 'value': '5055803939'},
                     {'name': 'area', 'value': '31'},
                     {'name': 'channel', 'value': 'xinma_ios'}]
            if cmd:
                req_h.append({'name': 'command', 'value': cmd})
            if acc:
                req_h.append({'name': 'acc', 'value': acc})
            return {'startedDateTime': t,
                    'request': {'url': f'http://{host}{path}', 'headers': req_h},
                    'response': {'status': 200, 'headers': rh,
                                 'content': {'text': resp}}}

        seed = b'391945'
        k = base64.b64encode(_xx.encrypt(seed, protocol.key0('103389291',
                                                             'qwmyk'))).decode()
        # 倒序：新 -> 旧，登录 api_check_user 在最后（ProxyPin 实际就是这样）
        entries = [
            entry('2026-11-08T06:10:36+00:00', '/api_command', cmd='uploadPower'),
            entry('2026-11-08T06:10:30+00:00', '/api_command', cmd='download'),
            entry('2026-11-08T06:10:18+00:00', '/api_check_user', k=k, acc=None,
                  resp='{"code":0,"data":{"acc":"103389291","area":31}}'),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'rev.har'
            p.write_text(json.dumps({'log': {'entries': entries}}), encoding='utf-8')
            s = retrieve.session_from_har(p)
        self.assertEqual(s['account'], '103389291')
        self.assertEqual(s['platform'], 'ios')
        self.assertEqual(s['protocol_key'], protocol.protocol_key(
            '103389291', seed, 'qwmyk').decode('ascii'))


if __name__ == '__main__':
    unittest.main()
