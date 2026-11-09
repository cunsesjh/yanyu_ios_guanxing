"""Public release update checks; never downloads or replaces the executable."""
import json
import re
import urllib.request


LATEST_RELEASE = 'https://gitee.com/api/v5/repos/cunses/yanyu_ios_guanxing/releases/latest'
GITHUB_RELEASE_PAGE = 'https://github.com/cunsesjh/yanyu_ios_guanxing/releases/tag/'
GITEE_RELEASE_PAGE = 'https://gitee.com/cunses/yanyu_ios_guanxing/releases/tag/'


def version_tuple(value):
    match = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)', str(value).strip())
    if not match:
        raise ValueError('无法识别发布版本号。')
    return tuple(map(int, match.groups()))


def parse_release(payload, current):
    tag = str(payload.get('tag_name') or '').strip()
    latest = version_tuple(tag)
    body = str(payload.get('body') or '').strip()
    return {
        'tag': tag,
        'version': '.'.join(map(str, latest)),
        'available': latest > version_tuple(current),
        'body': body[:1200],
        'github_url': GITHUB_RELEASE_PAGE + tag,
        'gitee_url': GITEE_RELEASE_PAGE + tag,
    }


def check_update(current, opener=urllib.request.urlopen):
    request = urllib.request.Request(LATEST_RELEASE, headers={
        'Accept': 'application/json',
        'User-Agent': 'iosGuanxing-update-check/' + str(current),
    })
    try:
        with opener(request, timeout=10) as response:
            payload = json.loads(response.read().decode('utf-8'))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError('暂时无法连接更新服务器，请稍后重试。') from error
    if not isinstance(payload, dict):
        raise RuntimeError('更新服务器返回了无法识别的数据。')
    return parse_release(payload, current)
