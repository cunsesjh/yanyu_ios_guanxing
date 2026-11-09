import io
import json
import unittest

from desktop.update import LATEST_RELEASE, check_update, parse_release, version_tuple


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class UpdateTests(unittest.TestCase):
    def test_semantic_version_comparison_is_numeric(self):
        self.assertGreater(version_tuple('v3.10.0'), version_tuple('3.9.9'))
        self.assertTrue(parse_release({'tag_name': 'v3.0.3'}, '3.0.2')['available'])
        self.assertFalse(parse_release({'tag_name': 'v3.0.2'}, '3.0.2')['available'])

    def test_public_release_payload_and_fixed_release_pages(self):
        payload = {'tag_name': 'v3.1.0', 'body': '修复内容',
                   'html_url': 'https://untrusted.example/download'}
        result = check_update('3.0.2', lambda request, timeout: Response(json.dumps(payload).encode()))
        self.assertEqual(result['github_url'],
                         'https://github.com/cunsesjh/yanyu_ios_guanxing/releases/tag/v3.1.0')
        self.assertEqual(result['gitee_url'],
                         'https://gitee.com/cunses/yanyu_ios_guanxing/releases/tag/v3.1.0')
        self.assertEqual(result['body'], '修复内容')

    def test_update_check_uses_public_gitee_release_api(self):
        captured = {}
        def open_release(request, timeout):
            captured['url'] = request.full_url
            captured['accept'] = request.get_header('Accept')
            captured['timeout'] = timeout
            return Response(json.dumps({'tag_name': 'v3.0.3'}).encode())
        check_update('3.0.3', open_release)
        self.assertEqual(LATEST_RELEASE,
                         'https://gitee.com/api/v5/repos/cunses/yanyu_ios_guanxing/releases/latest')
        self.assertEqual(captured, {'url': LATEST_RELEASE, 'accept': 'application/json', 'timeout': 10})

    def test_invalid_version_is_rejected(self):
        with self.assertRaises(ValueError):
            parse_release({'tag_name': 'latest'}, '3.0.2')


if __name__ == '__main__':
    unittest.main()
