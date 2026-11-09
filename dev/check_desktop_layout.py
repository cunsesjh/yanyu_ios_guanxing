"""Render all desktop modules at supported window sizes and check their navigation."""
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from PySide6.QtCore import QTimer, QUrl
from PySide6.QtWidgets import QApplication
from desktop.app import MainWindow
from desktop.storage import Store
from desktop.smoke import DATA

app = QApplication(sys.argv)
temporary = tempfile.TemporaryDirectory()
store = Store(temporary.name)
store.save_snapshot(DATA, 'ios', '1', '73576')
window = MainWindow(store, ROOT / 'web')
window.show()
out = ROOT / 'build' / 'layout'
out.mkdir(parents=True, exist_ok=True)
pages = ['index.html', 'wash/index.html', 'equip/index.html', 'hengshan/index.html',
         'role/index.html', 'role/status.html', 'auto/index.html',
         'guishi/index.html', 'guishi/index.html?page=hs', 'qna/index.html']
queue = [(theme, size, page) for theme in ['dark', 'light']
         for size in [(1000, 680), (1380, 900)] for page in pages]
results = []
current = None

SCRIPT = r'''JSON.stringify((function () {
    var nav = document.querySelector('.sim-nav');
    var links = Array.from(nav ? nav.querySelectorAll('a') : []);
    var rect = nav ? nav.getBoundingClientRect() : null;
    var home = document.querySelector('.home-shell');
    return {
        width: innerWidth, height: innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
        homeBottom: home ? home.getBoundingClientRect().bottom : null,
        background: getComputedStyle(document.body).backgroundColor,
        theme: document.documentElement.dataset.theme,
        importPanel: !!document.querySelector('.archive-import-panel'),
        modules: document.querySelectorAll('.module-card').length,
        shop: document.querySelector('.page.active')?.id,
        shopHome: !!document.getElementById('page-home'),
        disclaimer: document.body.textContent.includes('免责声明：'),
        ghostGuide: document.getElementById('page-ghost')?.textContent.includes('一个必须知道的事'),
        nav: rect ? {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom} : null,
        links: links.map(function (a) {
            var r = a.getBoundingClientRect(), s = getComputedStyle(a);
            return {text: a.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
                    width: r.width, scrollWidth: a.scrollWidth, clientWidth: a.clientWidth,
                    color: s.color, background: s.backgroundColor};
        })
    };
})())'''


def inspect(value):
    data = json.loads(value)
    theme, size, page = current
    data.update(size=size, page=page)
    results.append(data)
    name = '%s-%dx%d-%s.png' % (theme, size[0], size[1], page.replace('/', '-').replace('?', '-').replace('=', '-'))
    window.grab().save(str(out / name))
    QTimer.singleShot(50, next_page)


def loaded(ok):
    if ok:
        QTimer.singleShot(700, lambda: window.page.runJavaScript(SCRIPT, 0, inspect))


def next_page():
    global current
    if not queue:
        (out / 'report.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        failures = []
        for row in results:
            if row['page'] == 'index.html':
                if row['scrollHeight'] > row['height'] + 1 or row['homeBottom'] > row['height'] + 1:
                    failures.append((row['size'], row['page'], 'homepage overflow'))
                if row['importPanel'] or row['modules'] != 9:
                    failures.append((row['size'], row['page'], 'homepage features'))
            elif len(row['links']) != 10 or row['nav']['top'] < 0 or any(link['left'] < 0 or link['right'] > row['width'] + 1
                                              or link['bottom'] > row['nav']['bottom'] + 1
                                              or link['scrollWidth'] > link['clientWidth'] + 1
                                              for link in row['links']):
                failures.append((row['size'], row['page'], 'navigation cropped'))
            expected = 'rgb(12, 17, 27)' if row['theme'] == 'dark' else 'rgb(243, 246, 251)'
            if row['background'] != expected:
                failures.append((row['size'], row['page'], 'inconsistent theme background'))
            if row['page'].startswith('guishi/'):
                expected_shop = 'page-hs' if '?page=hs' in row['page'] else 'page-ghost'
                if row['shop'] != expected_shop or row['shopHome'] or row['disclaimer'] or not row['ghostGuide']:
                    failures.append((row['size'], row['page'], 'shop entry or content'))
        print(json.dumps(dict(pages=len(results), failures=failures), ensure_ascii=False), flush=True)
        window.close()
        app.exit(bool(failures))
        return
    current = queue.pop(0)
    window.apply_theme(current[0])
    window.resize(*current[1])
    window.view.setUrl(QUrl(window.site.url + current[2]))


QTimer.singleShot(300, lambda: (window.view.loadFinished.connect(loaded), next_page()))
QTimer.singleShot(150000, lambda: app.exit(2))
sys.exit(app.exec())
