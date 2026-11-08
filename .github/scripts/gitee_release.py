"""Create a Gitee release and upload one build artifact."""
import json
import os
from pathlib import Path
import re
import sys
import urllib.request
import uuid


def main():
    path, tag = Path(sys.argv[1]), sys.argv[2]
    token = os.environ.get('GITEE_TOKEN', '').strip()
    repo = os.environ.get('GITEE_REPO', 'cunses/yanyu_ios_guanxing')
    if not token or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise RuntimeError('Gitee release configuration is invalid')
    base = 'https://gitee.com/api/v5/repos/' + repo

    def request(endpoint, data=None, content_type='application/json'):
        payload = json.dumps(data).encode() if isinstance(data, dict) else data
        req = urllib.request.Request(base + endpoint, data=payload, headers={
            'Authorization': 'Bearer ' + token, 'User-Agent': 'iosGuanxing-release',
            'Content-Type': content_type})
        with urllib.request.urlopen(req, timeout=180) as response:
            raw = response.read()
            return json.loads(raw) if raw else None

    releases = request('/releases?per_page=100')
    release = next((item for item in releases if item['tag_name'] == tag), None)
    if release is None:
        release = request('/releases', dict(tag_name=tag, target_commitish='main',
            name='iosGuanxing ' + tag + '（正式版）', prerelease=False,
            body='Windows 正式版：HAR 导入、主动下载、内置观星网页及本地模拟功能。'))
    assets = release.get('assets') or []
    attachments = assets.get('attachments', []) if isinstance(assets, dict) else assets
    if any(item.get('name') == path.name for item in attachments):
        return
    boundary = '----iosguanxing' + uuid.uuid4().hex
    payload = ('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' +
               path.name + '"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
    payload += path.read_bytes() + ('\r\n--' + boundary + '--\r\n').encode()
    request('/releases/%s/attach_files' % release['id'], payload,
            'multipart/form-data; boundary=' + boundary)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, IndexError) as error:
        print('::error::' + str(error), file=sys.stderr)
        sys.exit(1)
