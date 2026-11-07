"""Publish Gitee release assets using header authentication and safe errors."""
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.request
import uuid


def main():
    path, tag = Path(sys.argv[1]), sys.argv[2]
    token = os.environ.get('GITEE_TOKEN', '').strip()
    repo = os.environ.get('GITEE_REPO', 'cunses/yanyu_ios_guanxing')
    if not token:
        raise RuntimeError('未配置 GITEE_TOKEN。')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise RuntimeError('GITEE_REPO 必须是 owner/repo。')
    base = 'https://gitee.com/api/v5/repos/' + repo

    def request(endpoint, data=None, content_type='application/json'):
        payload = json.dumps(data).encode() if isinstance(data, dict) else data
        headers = {'Authorization': 'Bearer ' + token,
                   'User-Agent': 'yanyu-release', 'Content-Type': content_type}
        for attempt in range(3):
            try:
                req = urllib.request.Request(base + endpoint, data=payload, headers=headers)
                with urllib.request.urlopen(req, timeout=180) as response:
                    raw = response.read()
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as error:
                if error.code < 500 or attempt == 2:
                    hint = '；请更新 GitHub Secrets 中的 GITEE_TOKEN 并确认仓库权限' if error.code in (401, 403) else ''
                    raise RuntimeError('Gitee HTTP %s%s' % (error.code, hint)) from None
            except (urllib.error.URLError, TimeoutError):
                if attempt == 2:
                    raise RuntimeError('Gitee 连接失败。') from None
            time.sleep(5)

    # Paginate so rerunning an older tag never creates a duplicate release.
    release = None
    for page in range(1, 101):
        items = request('/releases?per_page=100&page=' + str(page))
        release = next((r for r in items if r['tag_name'] == tag), None)
        if release or len(items) < 100:
            break
    if release is None:
        release = request('/releases', dict(
            tag_name=tag, target_commitish='main',
            name='v2.9(适配ios73576)' if tag == 'v2.9' else tag,
            body='iOS 73576 存档适配、查看历史存档修复及 HAR 导入提示修复。',
            prerelease=False))
    assets = release.get('assets') or []
    attachments = assets.get('attachments', []) if isinstance(assets, dict) else assets
    if any(item.get('name') == path.name for item in attachments):
        print('同名附件已存在，保留已有文件。')
        return
    boundary = '----yanyu' + uuid.uuid4().hex
    payload = ('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' +
               path.name + '"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
    payload += path.read_bytes() + ('\r\n--' + boundary + '--\r\n').encode()
    request('/releases/%s/attach_files' % release['id'], payload,
            'multipart/form-data; boundary=' + boundary)
    print('Gitee Release 附件上传完成。')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, IndexError) as error:
        print('::error::' + str(error), file=sys.stderr)
        sys.exit(1)
