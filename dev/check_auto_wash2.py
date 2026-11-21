"""Exercise new/legacy tabs in the actual desktop Chromium with synthetic saves."""
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('IOSGUANXING_DISABLE_AUTO_UPDATE', '1')
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
last_observation = {}

def fail(message):
    print(message, flush=True)
    window.grab().save(str(out / 'failure.png'))
    window.close()
    app.exit(1)

def received(value):
    global stage, last_observation
    try:
        row = json.loads(value or '{}')
        if row != last_observation:
            print('stage %d: %s' % (stage, json.dumps(row, ensure_ascii=True)), flush=True)
        last_observation = row
        if row.get('error'):
            return fail(row['error'])
        if not row.get('ready'):
            return
        if stage == 0:
            stage = 1
            print('ready: page and module', flush=True)
        elif stage == 1:
            QTimer.singleShot(200, lambda: window.grab().save(str(out / 'configuration.png')))
            stage = 2
            print('ready: save role and inspect', flush=True)
        elif stage == 2:
            window.grab().save(str(out / 'results.png'))
            window.theme_button.click()
            stage = 3
            print('ready: worker result and native theme toggle', flush=True)
        elif stage == 3:
            if Store(temp.name).theme() != 'light':
                return fail('Native theme button did not persist preference')
            stage = 4
        elif stage < len(scripts) - 1:
            stage += 1
        else:
            print('PASS: both workers, personal seven-layer search, pause/resume, bag, export and tab isolation', flush=True)
            window.close()
            app.exit(0)
    except Exception as error:
        fail(str(error))

scripts = [r'''JSON.stringify((()=>{
    if (!window.AutoWash2 || !state.saveData || !state.saveRoles?.length) {
        return {waiting:'save import', autoWash2:!!window.AutoWash2,
            saveData:!!state.saveData, saveRoles:state.saveRoles?.length || 0,
            stored:!!window.loadShareStore?.()?.data,
            url:location.href, readyState:document.readyState,
            pageError:document.querySelector('.error-message, #errorMessage')?.textContent || ''};
    }
    // Import and WASM initialization finish independently. The DOM can already
    // contain saveRoles while the legacy tab listeners and role options are not
    // ready yet (especially on Windows CI). Wait for the actual tab activation.
    document.getElementById('btnAutoWash2Mode').click();
    if (document.getElementById('autoWash2ModePanel').hidden) return {waiting:'tab initialization'};
    if (document.getElementById('w2Depth') || document.getElementById('w2Reference') ||
        document.getElementById('wpDepth') || !document.getElementById('wpReference'))
        return {error:'Personal settings must only exist on the personal tab'};
    window.AutoWash2.refresh();
    const r = document.getElementById('w2Role');
    if (r.disabled || !Array.from(r.options).some(o => o.value === state.saveRoles[0].key)) return {waiting:'role options'};
    window.w2Baseline = JSON.stringify(state);
    r.value = state.saveRoles[0].key;
    r.dispatchEvent(new Event('change'));
    return {ready: true};
})())''', r'''JSON.stringify((()=>{
    const status = document.getElementById('w2Status');
    if (status.classList.contains('w2-error')) return {error:status.textContent};
    if (document.getElementById('w2Run').disabled) return {
        waiting:status.textContent, role:document.getElementById('w2Role').value,
        targets:document.querySelectorAll('#w2Targets [data-id]').length};
    if (JSON.stringify(state) !== w2Baseline) return {error:'New role selection mutated legacy simulator state'};
    const b = document.getElementById('w2Budget'); b.value = 0; b.dispatchEvent(new Event('input'));
    document.querySelector('#autoWash2ModePanel .w2-section').scrollIntoView({block:'start'});
    return {ready:true};
})())''', r'''JSON.stringify((()=>{
    const status = document.getElementById('w2Status');
    if (status.classList.contains('w2-error')) return {error:status.textContent};
    if (!window.w2SearchStarted) {
        window.w2SearchStarted = true;
        document.getElementById('w2Run').click();
    }
    if (!document.querySelector('.w2-route')) return {waiting:status.textContent};
    if (JSON.stringify(state) !== w2Baseline) return {error:'Search mutated legacy simulator state'};
    if (document.documentElement.scrollWidth > innerWidth + 1) return {error:'Horizontal page overflow'};
    return {ready:true};
})())''', r'''JSON.stringify((()=>{
    if (document.documentElement.dataset.theme !== 'light') return {waiting:'native theme application'};
    if (JSON.stringify(state) !== w2Baseline) return {error:'Search mutated legacy simulator state'};
    const tabs = [['btnAutoEquipMode','autoEquipModePanel'], ['btnAutoJianwangMode','autoJianwangModePanel'],
        ['btnAutoWashMode','autoWashModePanel'], ['btnPersonalWashMode','personalWashModePanel'],
        ['btnAutoWash2Mode','autoWash2ModePanel']];
    for (const [button, panel] of tabs) {
        document.getElementById(button).click();
        if (document.getElementById(panel).hidden || tabs.filter(([,p])=>!document.getElementById(p).hidden).length !== 1)
            return {error:'Tab isolation failed: ' + panel};
    }
    if (!document.getElementById('anchorRun')) return {error:'Legacy wash controls missing'};
    const b = document.getElementById('w2Budget'); b.value = 1; b.dispatchEvent(new Event('input'));
    if (document.querySelector('.w2-route') || !document.getElementById('w2Export').disabled)
        return {error:'Budget change retained stale results'};
    document.getElementById('w2Run').click(); document.getElementById('w2Stop').click();
    if (document.getElementById('w2Run').disabled || !document.getElementById('w2Stop').hidden) return {error:'Stop failed'};
    return {ready:true};
})())''']

scripts.extend([r'''JSON.stringify((()=>{
    const el=id=>document.getElementById(id);
    el('btnPersonalWashMode').click();
    if (el('personalWashModePanel').hidden || !el('autoWash2ModePanel').hidden) return {error:'personal tab visibility'};
    if (el('wpRole').value || el('wpBudget').value === '1') return {error:'settings shared between tabs'};
    if (el('wpDepth') || el('wpAutoExact') || el('wpExact') || !el('wpRun').textContent.includes('七层')) return {error:'Unexpected search controls'};
    if (!el('wpPreset').disabled) return {error:'Preset enabled before role inspection'};
    el('wpVip').value='0';
    el('wpRole').value=state.saveRoles[0].key;
    el('wpRole').dispatchEvent(new Event('change'));
    el('wpBudget').dispatchEvent(new Event('input'));
    if (!el('wpPreset').disabled) return {error:'Preset enabled during role inspection'};
    return {ready:true};
})())''', r'''JSON.stringify((()=>{
    const el=id=>document.getElementById(id);
    if (el('wpPreset').disabled) return {waiting:el('wpStatus').textContent};
    el('wpPreset').click();
    if (!['混元奇脉','VIP 1+'].every(text=>el('wpStatus').textContent.includes(text)))
        return {error:'Missing VIP requirement for preset'};
    el('wpVip').value='1'; el('wpVip').dispatchEvent(new Event('change'));
    if (!el('wpPreset').disabled) return {error:'Stale preset after VIP change'};
    return {ready:true};
})())''', r'''JSON.stringify((()=>{
    const el=id=>document.getElementById(id);
    if (el('wpStatus').classList.contains('w2-error')) return {error:el('wpStatus').textContent};
    if (el('wpRun').disabled) return {waiting:el('wpStatus').textContent};
    if (el('wpBag').value !== '5000') return {error:'Personal bag did not load from save'};
    el('wpBag').value='-1'; el('wpBag').dispatchEvent(new Event('input'));
    if (!el('wpStatus').classList.contains('w2-error')) return {error:'Negative bag accepted'};
    el('wpResetBag').click();
    if (el('wpBag').value !== '5000') return {error:'Personal bag reset failed'};
    el('wpBag').value='1234'; el('wpBag').dispatchEvent(new Event('input'));
    if (state.saveData.Items.find(item=>item.ID===2601).Num !== 5000)
        return {error:'Personal bag changed imported save'};
    el('wpBudget').value=0;
    el('wpBudget').dispatchEvent(new Event('input'));
    el('wpRun').click();
    return {ready:true};
})())''', r'''JSON.stringify((()=>{
    const el=id=>document.getElementById(id);
    if (el('wpStatus').classList.contains('w2-error')) return {error:el('wpStatus').textContent};
    if (el('wpStatusBox').dataset.state !== 'done') return {waiting:el('wpStatus').textContent};
    if (el('wpBest').textContent !== '0 丹' || !el('wpDetail').textContent.includes('0 丹'))
        return {error:'Missing zero-cost result'};
    el('btnAutoWash2Mode').click(); el('btnPersonalWashMode').click();
    if (!el('wpResults').querySelector('details') || el('wpExport').disabled) return {error:'missing exportable result'};
    if (el('wpBag').value !== '1234' || !el('wpResults').textContent.includes('余1234 丹'))
        return {error:'Personal bag not retained in result'};
    if (el('w2Budget').value !== '1') return {error:'modified other tabs budget'};
    el('wpBudget').value=9000;
    el('wpBudget').dispatchEvent(new Event('input'));
    el('wpPreset').click();
    el('wpRun').click();
    return {ready:true};
})())''', r'''JSON.stringify((()=>{
    const el=id=>document.getElementById(id);
    if (el('wpStatus').classList.contains('w2-error')) return {error:el('wpStatus').textContent};
    if (el('wpStatusBox').dataset.state !== 'strategy') return {waiting:el('wpStatus').textContent};
    el('wpPause').click();
    return {ready:true};
})())''', r'''JSON.stringify((()=>{
    const el=id=>document.getElementById(id);
    if (el('wpStatus').classList.contains('w2-error')) return {error:el('wpStatus').textContent};
    if (el('wpPause').textContent !== '继续') return {waiting:el('wpStatus').textContent};
    el('btnAutoWash2Mode').click(); el('btnPersonalWashMode').click();
    el('wpPause').click();
    return {ready:true};
})())''', r'''JSON.stringify((()=>{
    const el=id=>document.getElementById(id);
    if (el('wpPause').textContent !== '暂停') return {waiting:el('wpStatus').textContent};
    el('wpStop').click();
    if(!el('wpPause').hidden || el('wpRun').disabled) return {error:'cancel failed'};
    if(JSON.stringify(state)!==w2Baseline) return {error:'modified imported simulation state'};
    return {ready:true};
})())'''])

pending = False
def tick():
    global ticks, pending
    ticks += 1
    if ticks > 660:
        return fail('Desktop verification timed out at stage %d: %s' %
                    (stage, json.dumps(last_observation, ensure_ascii=True)))
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
    def loaded(value):
        if value == 'ready':
            window.view.setUrl(QUrl(window.site.url + 'auto/index.html'))
            timer.start()
        elif home_tries[0] < 120:
            home_tries[0] += 1
            QTimer.singleShot(250, start)
        else:
            fail('Home did not finish importing its snapshot')
    window.page.runJavaScript("window.loadShareStore?.()?.data ? 'ready' : 'loading'", 0, loaded)
home_tries = [0]
QTimer.singleShot(500, start)
sys.exit(app.exec())
