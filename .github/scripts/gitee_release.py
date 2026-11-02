#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 exe 上传为 Gitee Release 资产（GitHub Actions tag 构建时调用）。

用法: python gitee_release.py <exe路径> <tag名>
环境: GITEE_TOKEN（私人令牌，projects 权限）、GITEE_REPO（如 cunses/yanyu_ios_guanxing）

认证一律走 access_token 查询参数（Gitee 最稳的方式）；
资产重名时先删旧再传，保证可重复运行。
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API = 'https://gitee.com/api/v5/repos/'


def call(url, data=None, headers=None, raw=False):
    h = {'User-Agent': 'ci'}
    if data is not None and not raw:
        data = json.dumps(data).encode('utf-8')
        h['Content-Type'] = 'application/json'
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read()
        return body if raw else json.loads(body)


def main():
    exe, tag = sys.argv[1], sys.argv[2]
    token = os.environ.get('GITEE_TOKEN')
    repo = os.environ.get('GITEE_REPO')
    if not token or not repo:
        print('!! 缺少 GITEE_TOKEN / GITEE_REPO 环境变量')
        sys.exit(1)
    q = urllib.parse.urlencode({'access_token': token})
    base = f'{API}{repo}'

    # 1) 找或建 release
    releases = call(f'{base}/releases?per_page=50&{q}')
    rel = next((r for r in releases if r.get('tag_name') == tag), None)
    if rel is None:
        rel = call(f'{base}/releases?{q}', data={
            'tag_name': tag,
            'name': tag,
            'body': f'构建产物见附件 ios观星.exe（与 GitHub Release 同一份）',
            'target_commitish': 'main',
        })
        print('已创建 Gitee Release:', tag)
    else:
        print('Gitee Release 已存在:', tag)
    rid = rel['id']

    # 2) 同名资产先删（可重复运行）
    filename = os.path.basename(exe)
    for a in rel.get('attach_files') or []:
        if a.get('name') == filename:
            call(f'{base}/releases/{rid}/attach_files/{a["id"]}?{q}')
            print('已删除旧资产:', filename)

    # 3) multipart 上传
    boundary = '----ciBoundary7MA4YWxkTrZu0gW'
    with open(exe, 'rb') as f:
        blob = f.read()
    part = (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="access_token"\r\n\r\n{token}\r\n'
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f'Content-Type: application/octet-stream\r\n\r\n'
    ).encode('utf-8') + blob + f'\r\n--{boundary}--\r\n'.encode('utf-8')
    call(f'{base}/releases/{rid}/attach_files?{q}', data=part, raw=True,
         headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
    print('✅ Gitee Release 资产已上传:', filename)


if __name__ == '__main__':
    main()
