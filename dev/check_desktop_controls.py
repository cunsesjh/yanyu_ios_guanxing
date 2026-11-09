"""Verify desktop selector commit semantics in the real embedded Chromium."""
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from PySide6.QtCore import QTimer, QUrl
from PySide6.QtWidgets import QApplication
from desktop.app import MainWindow
from desktop.storage import Store

app = QApplication(sys.argv)
temporary = tempfile.TemporaryDirectory()
window = MainWindow(Store(temporary.name), ROOT / 'web')
window.show()
pages = ['wash/index.html', 'equip/index.html', 'hengshan/index.html',
         'role/index.html', 'role/status.html', 'auto/index.html', 'guishi/index.html']
results = []
SCRIPT = r'''JSON.stringify((()=>{
    try {
    const fail = m => {throw new Error(m);};
    const select = document.createElement('select');
    select.id = 'control-test'; select.style.cssText = 'position:fixed;top:100px;left:100px';
    select.innerHTML = Array.from({length:40}, (_,i)=>`<option value="${i}">选项 ${i}</option>`).join('');
    document.body.appendChild(select);
    let changes = 0; select.addEventListener('change', ()=>changes++);
    const open = () => select.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, button:0}));
    open();
    let popup = document.querySelector('.desktop-select-popup');
    if (!popup) fail('Custom popup did not open');
    popup.querySelectorAll('button').forEach(b=>b.dispatchEvent(new MouseEvent('mousemove',{bubbles:true})));
    popup.scrollTop = 300;
    popup.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:120}));
    if (select.value !== '0' || changes) fail('Hover/scroll committed an option');
    if (getComputedStyle(popup).scrollBehavior !== 'auto') fail('Popup has smooth scroll');
    popup.querySelectorAll('button')[20].click();
    if (select.value !== '20' || changes !== 1 || document.querySelector('.desktop-select-popup')) fail('Click did not commit exactly once');
    open();
    select.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
    if (select.value !== '20' || changes !== 1) fail('Keyboard browsing committed early');
    select.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    if (select.value !== '20' || document.querySelector('.desktop-select-popup')) fail('Escape changed selection');
    open();
    select.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
    select.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    if (select.value !== '21' || changes !== 2) fail('Keyboard confirmation failed');
    select.remove();
    const budget = document.getElementById('w2Budget');
    if (budget && budget.value !== '5000') fail('Wash2 default budget mismatch: expected 5000, got ' + budget.value);
    if (budget && document.querySelector('#autoWash2ModePanel [id^="anchor"]')) fail('Anchor control leaked into Wash2 UI');
    const guide = document.querySelector('.ghost-guide');
    if (guide && !guide.open) fail('Ghost guide not expanded');
    return {ok:true};
    } catch (error) {
        return {ok:false, error:String(error.message || error), page:location.pathname};
    }
})())'''

def checked(value):
    try:
        result = json.loads(value or '{}')
        if not result.get('ok'):
            raise RuntimeError('Control verification failed: ' + str(value))
        results.append(result)
        next_page()
    except Exception as error:
        print(str(error), flush=True)
        window.close()
        app.exit(1)

def loaded(ok):
    if ok:
        QTimer.singleShot(900, lambda: window.page.runJavaScript(SCRIPT, 0, checked))

def next_page():
    if not pages:
        print('PASS: dropdown hover/scroll never commits; click/keyboard confirm once; Escape cancels; default budget 5000; guide expanded; no Wash2 anchor controls (%d pages)' % len(results), flush=True)
        window.close()
        app.exit(0)
        return
    window.view.setUrl(QUrl(window.site.url + pages.pop(0)))

window.view.loadFinished.connect(loaded)
QTimer.singleShot(500, next_page)
QTimer.singleShot(60000, lambda: app.exit(2))
sys.exit(app.exec())
