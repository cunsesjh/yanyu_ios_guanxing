"""Exercise new/legacy tabs in the actual desktop Chromium with synthetic saves."""
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
temp = tempfile.TemporaryDirectory()
store = Store(temp.name)
role = dict(ID=10044, Name='测试人物', ZiZhi=154, BornTalent=dict(S=12345, RC=0),
            Talents=[dict(ID=271, Lock=True)], Sex=1, Level=100)
save = dict(MainRole=role, Roles={}, CenterID=1278440, Items=[dict(ID=2601, Num=5000)],
            Rnds={'preview': 12345}, MakeRnd={}, globalVariable={}, DBVersion=73576)
store.save_snapshot(save, 'ios', '1', '73576')
window = MainWindow(store, ROOT / 'web')
window.resize(1000, 680)
window.show()
out = ROOT / 'build' / 'wash2'
out.mkdir(parents=True, exist_ok=True)
stage = 0
ticks = 0

def fail(message):
    print(message, flush=True)
    window.close()
    app.exit(1)

def received(value):
    global stage
    try:
        row = json.loads(value or '{}')
        if row.get('error'):
            return fail(row['error'])
        if not row.get('ready'):
            return
        if stage == 0:
            stage = 1
        elif stage == 1:
            QTimer.singleShot(200, lambda: window.grab().save(str(out / 'configuration.png')))
            stage = 2
        elif stage == 2:
            QTimer.singleShot(200, lambda: window.grab().save(str(out / 'results.png')))
            window.theme_button.click()
            stage = 3
        elif stage == 3:
            if Store(temp.name).theme() != 'light':
                return fail('Native theme button did not persist preference')
            print('PASS: four tabs, independent save state, actual Worker result, input invalidation, stop, original tabs retained', flush=True)
            window.close()
            app.exit(0)
    except Exception as error:
        fail(str(error))

scripts = [r'''JSON.stringify((()=>{
    if (!window.AutoWash2 || !state.saveData || !state.saveRoles?.length) return {};
    window.w2Baseline = JSON.stringify(state);
    document.getElementById('btnAutoWash2Mode').click();
    const r = document.getElementById('w2Role'); r.value = state.saveRoles[0].key;
    r.dispatchEvent(new Event('change'));
    return {ready: true};
})())''', r'''JSON.stringify((()=>{
    if (document.getElementById('w2Run').disabled) return {};
    if (JSON.stringify(state) !== w2Baseline) return {error:'New role selection mutated legacy simulator state'};
    const b = document.getElementById('w2Budget'); b.value = 0; b.dispatchEvent(new Event('input'));
    document.querySelector('#autoWash2ModePanel .w2-section').scrollIntoView({block:'start'});
    return {ready:true};
})())''', r'''JSON.stringify((()=>{
    const result = document.querySelector('#w2Results .w2-route');
    if (!result) {if (!document.getElementById('w2Run').disabled) document.getElementById('w2Run').click(); return {};}
    if (JSON.stringify(state) !== w2Baseline) return {error:'Search mutated legacy simulator state'};
    if (document.documentElement.scrollWidth > innerWidth + 1) return {error:'Horizontal page overflow'};
    document.getElementById('w2Results').scrollIntoView({block:'start'});
    return {ready:true};
})())''', r'''JSON.stringify((()=>{
    if (document.documentElement.dataset.theme !== 'light') return {error:'Native theme toggle did not reach embedded page'};
    if (JSON.stringify(state) !== w2Baseline) return {error:'Theme switch mutated simulation state'};
    for (const [button,panel] of [['btnAutoEquipMode','autoEquipModePanel'],['btnAutoJianwangMode','autoJianwangModePanel'],['btnAutoWashMode','autoWashModePanel'],['btnAutoWash2Mode','autoWash2ModePanel']]) {
        document.getElementById(button).click();
        if (document.getElementById(panel).hidden || document.querySelectorAll('#aiPredictionPanel > .auto-mode-panel:not([hidden])').length !== 1) return {error:'Tab isolation failed: '+button};
    }
    if (!document.getElementById('anchorRun')) return {error:'Legacy wash UI missing'};
    const b = document.getElementById('w2Budget'); b.value = 5000; b.dispatchEvent(new Event('input'));
    if (document.querySelector('#w2Results .w2-route')) return {error:'Stale result after input change'};
    document.getElementById('w2Run').click(); document.getElementById('w2Stop').click();
    if (document.getElementById('w2Run').disabled || !document.getElementById('w2Stop').hidden) return {error:'Stop failed'};
    return {ready:true};
})())''']

pending = False
def tick():
    global ticks, pending
    ticks += 1
    if ticks > 180:
        return fail('Desktop verification timed out at stage %d' % stage)
    if pending:
        return
    pending = True
    def done(value):
        global pending
        pending = False
        received(value)
    window.page.runJavaScript(scripts[stage], 0, done)

timer = QTimer()
timer.setInterval(500)
timer.timeout.connect(tick)
def start():
    window.view.setUrl(QUrl(window.site.url + 'auto/index.html'))
    timer.start()
QTimer.singleShot(500, start)
sys.exit(app.exec())
