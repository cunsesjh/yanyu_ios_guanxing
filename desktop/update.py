"""Public stable/beta release discovery and trusted asset URL construction."""
import json
import re
import urllib.request


LATEST_RELEASE = 'https://gitee.com/api/v5/repos/cunses/yanyu_ios_guanxing/releases/latest'
BETA_RELEASES = 'https://api.github.com/repos/cunsesjh/iosGuanxing/releases?per_page=20'
GITHUB_RELEASE_PAGE = 'https://github.com/cunsesjh/yanyu_ios_guanxing/releases/tag/'
GITEE_RELEASE_PAGE = 'https://gitee.com/cunses/yanyu_ios_guanxing/releases/tag/'
STABLE_REPOSITORY = 'cunsesjh/yanyu_ios_guanxing'
BETA_REPOSITORY = 'cunsesjh/iosGuanxing'


def version_tuple(value):
    match = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?', str(value).strip())
    if not match:
        raise ValueError('无法识别发布版本号。')
    major, minor, patch, beta = match.groups()
    return int(major), int(minor), int(patch), 0 if beta else 1, int(beta or 0)


def parse_release(payload, current, repository=STABLE_REPOSITORY):
    tag = str(payload.get('tag_name') or '').strip()
    latest = version_tuple(tag)
    body = str(payload.get('body') or '').strip()
    return {
        'tag': tag,
        'version': tag[1:] if tag.startswith('v') else tag,
        'available': latest > version_tuple(current),
        'body': body[:1200],
        'github_url': 'https://github.com/%s/releases/tag/%s' % (repository, tag),
        'gitee_url': GITEE_RELEASE_PAGE + tag if repository == STABLE_REPOSITORY else '',
        'download_url': 'https://github.com/%s/releases/download/%s/iosGuanxing.exe' % (repository, tag),
        'checksum_url': 'https://github.com/%s/releases/download/%s/SHA256SUMS.txt' % (repository, tag),
    }


def check_update(current, opener=urllib.request.urlopen, channel='正式版'):
    beta = str(channel) == '测试版'
    endpoint = BETA_RELEASES if beta else LATEST_RELEASE
    request = urllib.request.Request(endpoint, headers={
        'Accept': 'application/json',
        'User-Agent': 'iosGuanxing-update-check/' + str(current),
    })
    try:
        with opener(request, timeout=10) as response:
            payload = json.loads(response.read().decode('utf-8'))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError('暂时无法连接更新服务器，请稍后重试。') from error
    if beta:
        if not isinstance(payload, list):
            raise RuntimeError('更新服务器返回了无法识别的数据。')
        payload = next((item for item in payload
                        if isinstance(item, dict) and item.get('prerelease') and not item.get('draft')), None)
        if payload is None:
            raise RuntimeError('没有找到可用的测试版更新。')
    if not isinstance(payload, dict):
        raise RuntimeError('更新服务器返回了无法识别的数据。')
    return parse_release(payload, current, BETA_REPOSITORY if beta else STABLE_REPOSITORY)
