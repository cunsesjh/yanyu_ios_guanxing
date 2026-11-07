"""Fast-forward the mirror without embedding credentials in Git URLs or logs."""
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


def main():
    token = os.environ.get('GITEE_TOKEN', '').strip()
    repo = os.environ.get('GITEE_REPO', 'cunses/yanyu_ios_guanxing')
    if not token:
        raise RuntimeError('未配置 GITEE_TOKEN，请在 GitHub Actions repository secrets 中更新。')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise RuntimeError('GITEE_REPO 必须是 owner/repo。')
    with tempfile.TemporaryDirectory() as folder:
        helper = Path(folder) / 'askpass.py'
        helper.write_text('#!/usr/bin/env python3\nimport os, sys\n'
                          'print(os.environ["GITEE_TOKEN"] if "password" in '
                          'sys.argv[1].lower() else "cunses")\n')
        helper.chmod(0o700)
        env = dict(os.environ, GIT_ASKPASS=str(helper), GIT_TERMINAL_PROMPT='0')
        ref = os.environ.get('GITHUB_REF', '')
        specs = ['HEAD:refs/heads/main']
        if ref.startswith('refs/tags/'):
            subprocess.run(['git', 'check-ref-format', ref], check=True)
            specs.append(ref + ':' + ref)
        for attempt in range(3):
            result = subprocess.run(
                ['git', '-c', 'credential.helper=', 'push', '--force',
                 'https://gitee.com/' + repo + '.git'] + specs,
                env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, timeout=180)
            print(result.stdout.replace(token, '***'), end='')
            if result.returncode == 0:
                print('Gitee 代码同步完成。')
                return
            if attempt < 2:
                time.sleep(5)
        raise RuntimeError('Gitee 推送失败；请检查 token 权限或分支分叉，未执行强制推送。')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.SubprocessError) as error:
        print('::error::' + str(error), file=sys.stderr)
        sys.exit(1)
