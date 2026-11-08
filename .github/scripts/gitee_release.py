"""Create Gitee release metadata; the owner adds the netdisk link afterward."""
import json
import os
import re
import sys
import urllib.request


def main():
    tag = sys.argv[1]
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
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            return json.loads(raw) if raw else None

    releases = request('/releases?per_page=100')
    if any(item.get('tag_name') == tag for item in releases):
        print('Gitee release already exists; leaving owner-maintained description unchanged.')
        return
    request('/releases', dict(tag_name=tag, target_commitish='main',
        name='iosGuanxing ' + tag + '（正式版）', prerelease=False,
        body='Windows 正式版。下载链接请查看本发行版说明。'))
    print('Gitee release metadata published; no oversized binary uploaded.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, IndexError) as error:
        print('::error::' + str(error), file=sys.stderr)
        sys.exit(1)
