"""Publish Gitee release metadata with a GitHub binary download link."""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request


def main():
    tag, download_url = sys.argv[1], sys.argv[2]
    token = os.environ.get('GITEE_TOKEN', '').strip()
    repo = os.environ.get('GITEE_REPO', 'cunses/yanyu_ios_guanxing')
    if not token or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise RuntimeError('Gitee release configuration is invalid')
    base = 'https://gitee.com/api/v5/repos/' + repo

    def request(endpoint, data=None):
        payload = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(base + endpoint, data=payload, headers={
            'Authorization': 'Bearer ' + token, 'User-Agent': 'iosGuanxing-release',
            'Content-Type': 'application/json'})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=60) as response:
                    raw = response.read()
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as error:
                if error.code < 500:
                    raise RuntimeError('Gitee API returned HTTP %s' % error.code) from None
            except (urllib.error.URLError, TimeoutError):
                if attempt == 2:
                    raise RuntimeError('Gitee API connection failed') from None
            time.sleep(3)

    release = None
    for page in range(1, 101):
        rows = request('/releases?per_page=100&page=' + str(page))
        release = next((row for row in rows if row.get('tag_name') == tag), None)
        if release or len(rows) < 100:
            break
    body = ('Windows 正式版，适配国际服 73680。\n'
            '修复自动洗脉（改进）中 Talents 格式不兼容导致的报错。\n\n'
            '由于 Gitee 附件大小限制，EXE 和 SHA256 校验文件请从 GitHub Release 下载：\n'
            + download_url)
    if release:
        print('Gitee release already exists; leaving its metadata unchanged.')
        return
    request('/releases', dict(tag_name=tag, target_commitish='main',
        name='iosGuanxing ' + tag + '（正式版）', body=body, prerelease=False))
    print('Gitee release metadata published; no large binary uploaded.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, IndexError) as error:
        print('::error::' + str(error), file=sys.stderr)
        sys.exit(1)
