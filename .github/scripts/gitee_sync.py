"""Mirror main and the current release tag to Gitee without logging credentials."""
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import base64
import json
import urllib.error
import urllib.request


def main():
    token = os.environ.get('GITEE_TOKEN', '').strip()
    repo = os.environ.get('GITEE_REPO', 'cunses/yanyu_ios_guanxing')
    if not token:
        raise RuntimeError('GITEE_TOKEN is not configured')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise RuntimeError('Invalid GITEE_REPO')
    api_base = 'https://gitee.com/api/v5/repos/' + repo
    headers = {'Authorization': 'Bearer ' + token, 'User-Agent': 'iosGuanxing-sync',
               'Content-Type': 'application/json'}
    def request(endpoint, data=None, method=None):
        payload = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(api_base + endpoint, data=payload, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    try:
        readme = request('/contents/README.md?ref=main')
        preserved_readme = base64.b64decode(readme['content'])
    except (urllib.error.HTTPError, urllib.error.URLError, KeyError, ValueError):
        preserved_readme = None
    with tempfile.TemporaryDirectory() as folder:
        helper = Path(folder) / 'askpass.py'
        helper.write_text('#!/usr/bin/env python3\nimport os, sys\nprint(os.environ["GITEE_TOKEN"] if "password" in sys.argv[1].lower() else "cunses")\n')
        helper.chmod(0o700)
        env = dict(os.environ, GIT_ASKPASS=str(helper), GIT_TERMINAL_PROMPT='0')
        ref = os.environ.get('GITHUB_REF', '')
        specs = ['HEAD:refs/heads/main']
        if ref.startswith('refs/tags/'):
            subprocess.run(['git', 'check-ref-format', ref], check=True)
            specs.append(ref + ':' + ref)
        result = subprocess.run(['git', '-c', 'credential.helper=', 'push', '--force', '--atomic',
                                 'https://gitee.com/' + repo + '.git', *specs],
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, timeout=180)
        print(result.stdout.replace(token, '***'), end='')
        if result.returncode:
            raise RuntimeError('Gitee code synchronization failed')
    if preserved_readme is not None:
        current = request('/contents/README.md?ref=main')
        current_raw = base64.b64decode(current['content'])
        if current_raw != preserved_readme:
            request('/contents/README.md', dict(
                content=base64.b64encode(preserved_readme).decode(), sha=current['sha'],
                message='Preserve Gitee README after code synchronization', branch='main'), 'PUT')
            print('Gitee README preserved.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.SubprocessError) as error:
        print('::error::' + str(error), file=sys.stderr)
        sys.exit(1)
