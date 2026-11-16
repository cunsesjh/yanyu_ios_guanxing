"""Offline integration check using synthetic data; also exercised in frozen EXE."""
import json
import os
from pathlib import Path
import tempfile
import time
from unittest.mock import patch

from PySide6.QtCore import QTimer, QUrl

from .app import MainWindow
from .storage import Store

DATA = {'MainRole': {'Name': '观星预览', 'ID': 1}, 'Roles': {},
        'Rnds': {'preview': 12345}, 'DBVersion': 73576, 'globalVariable': {}}
SESSION = dict(url='https://ios.wlfy.blue8.cn/api_command', account='preview',
               session='synthetic', area='1', protocol_key='synthetic',
               platform='ios', headers={'ver': '73576'})


def run_smoke(app, web, report):
    """Drive the real download worker and Chromium without any game requests."""
    report = Path(report)
    report.parent.mkdir(parents=True, exist_ok=True)
    temporary = tempfile.TemporaryDirectory()
    store = Store(temporary.name)
    window = MainWindow(store, web)
    window.view.renderProcessTerminated.connect(
        lambda status, code: print('WebEngine process stopped:', status, code, flush=True))
    window.show()
    state = dict(stage=0, started=time.monotonic(), ticks=0, pending=False)
    results = []
    timer = QTimer()
    timer.setInterval(100)

    def save_image(name):
        folder = os.environ.get('IOSGUANXING_SCREENSHOTS')
        if folder:
            Path(folder).mkdir(parents=True, exist_ok=True)
            window.grab().save(str(Path(folder) / name))

    def finish(ok, reason):
        timer.stop()
        report.write_text(json.dumps(dict(ok=ok, reason=reason, checks=results),
                                     ensure_ascii=False), encoding='utf-8')
        window.close()
        app.exit(0 if ok else 1)

    def inspect_js(script, callback):
        state['pending'] = True
        def received(value):
            state['pending'] = False
            callback(value)
        window.page.runJavaScript(script, 0, received)

    def home_ready(value):
        if value != '导入成功|观星预览':
            return
        results.append('worker -> snapshot -> embedded home auto-import')
        if not window.profile.isOffTheRecord():
            finish(False, 'Browser profile is persistent')
            return
        results.append('off-the-record Chromium profile')
        state['stage'] = 1.5
        def after_paint():
            save_image('02-home.png')
            window.view.setUrl(QUrl(window.site.url + 'wash/index.html'))
            state['stage'] = 2
        QTimer.singleShot(600, after_paint)

    def module_ready(value):
        if value != '观星预览':
            return
        results.append('module navigation retains full imported save')
        # A failed refresh must preserve the already opened snapshot and history.
        before = window.current['id']
        window.download_failed('登录会话已失效，请重新导入 HAR')
        if window.current['id'] != before or window.session is not None:
            finish(False, 'Failed refresh did not preserve the old snapshot')
            return
        results.append('expired session preserves existing snapshot')
        window.go_home()
        state['stage'] = 3

    def restored_home(value):
        if value != '导入成功|观星预览':
            return
        results.append('home navigation restores imported save')
        row = Store(temporary.name).selected()
        if not row or Store(temporary.name).load_snapshot(row['id']) != DATA:
            finish(False, 'Restarted store lost snapshot')
            return
        results.append('snapshot selection and full data survive reopening store')
        finish(True, 'All offline desktop checks passed')

    def tick():
        state['ticks'] += 1
        if time.monotonic() - state['started'] > 70:
            if window.worker:
                return
            save_image('99-timeout.png')
            finish(False, 'Timed out at stage %s: %s; URL=%s' %
                   (state['stage'], window.status_label.text(), window.view.url().toString()))
            return
        if state['pending']:
            return
        if state['stage'] == 0 and state['ticks'] >= 8:
            save_image('01-welcome.png')
            results.append('welcome screen, no automatic game requests')
            window.start_download('synthetic.har')
            state['stage'] = 1
        elif state['stage'] == 1 and window.current and not window.worker:
            inspect_js("(()=>{var s=typeof loadShareStore==='function'&&loadShareStore();return s?.data?'导入成功|'+s.data.MainRole.Name:''})()", home_ready)
        elif state['stage'] == 2:
            inspect_js("typeof loadShareStore === 'function' ? "
                       "(loadShareStore()?.data?.MainRole?.Name || '') : ''", module_ready)
        elif state['stage'] == 3:
            inspect_js("(()=>{var s=typeof loadShareStore==='function'&&loadShareStore();return s?.data?'导入成功|'+s.data.MainRole.Name:''})()", restored_home)

    def fake_fetch(session):
        time.sleep(0.4)  # Only the worker waits, while Qt continues to process events.
        return DATA, '73576', None

    timer.timeout.connect(tick)
    with patch('desktop.service.retrieve.session_from_har', return_value=SESSION), \
         patch('desktop.service.retrieve.fetch', side_effect=fake_fetch):
        timer.start()
        status = app.exec()
    temporary.cleanup()
    return status
