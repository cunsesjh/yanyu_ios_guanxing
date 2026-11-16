(function () {
    'use strict';
    const $ = id => document.getElementById('w2' + id);
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const name = id => TALENT_DATA[id]?.name || '#' + id;
    const clone = value => JSON.parse(JSON.stringify(value));
    let raw = null, worker = null, request = 0, running = false, available = [], assignments = new Map();
    let source = null, context = '', lastResult = null, bag = 0, activeRole = '';
    const panel = document.getElementById('autoWash2ModePanel');
    if (!panel) return;
    panel.innerHTML = `
        <div class="w2-note"><strong>独立存档分支 · 本地计算</strong><span>始终从导入存档起算；页面试算不会改写存档。生成的是操作方案，需在游戏中手动执行。</span></div>
        <section class="w2-section">
            <h3><span>01</span>选择人物</h3>
            <div class="w2-fields">
                <label>存档人物<select id="w2Role"><option value="">请先导入存档</option></select></label>
                <label>VIP<select id="w2Vip"><option value="0">无 VIP</option><option value="1" selected>VIP 1+</option><option value="2">VIP 2+</option></select></label>
                <label>最大耗丹数量<input id="w2Budget" type="number" min="0" max="20000" step="100" value="5000"></label>
                <div class="w2-stock">背包洗髓丹<strong id="w2Bag">—</strong></div>
            </div>
            <p id="w2Summary" class="w2-muted">请先在首页导入存档，再选择人物。</p>
        </section>
        <section class="w2-section">
            <h3><span>02</span>保留当前天赋</h3>
            <p class="w2-muted">锁定作为起始状态；已锁紫脉自动加入必选目标。路线中可暂时解锁再取得，最终仍须包含这些紫脉。</p>
            <div id="w2Locks" class="w2-locks"></div>
        </section>
        <section class="w2-section">
            <h3><span>03</span>选择目标紫脉<strong id="w2Count"></strong></h3>
            <div class="w2-fields w2-target-tools">
                <label>筛选紫脉<input id="w2Filter" type="search" placeholder="输入名称"></label>
                <label>选入分组<select id="w2Group"><option value="-1">必选脉</option><option value="0">兼容组一 · 任选一条</option><option value="1">兼容组二 · 任选一条</option><option value="2">兼容组三 · 任选一条</option><option value="3">兼容组四 · 任选一条</option></select></label>
                <button id="w2Preset" type="button" class="btn btn-reset">金顶混</button>
                <button id="w2Clear" type="button" class="btn btn-reset">清空选择</button>
            </div>
            <p class="w2-muted">必选脉全部取得，每个兼容组至少取得一条，合计最多四槽。切换分组后点击可移动目标，再点同组目标取消。欧气种子/统一构造、锚点路线与分级战术搜索按四阶段共同比较，未用时间会自动转给后续引擎；整轮通常最多约 10 分钟，三个或四个目标紫脉时最多约 15 分钟，找到后继续按当前最低丹耗减一压价。国服、先行服及国际服均使用各自脉序状态机回放，只有验证通过的候选才会显示。</p>
            <p class="w2-credit">特别鸣谢 B站大佬「庸丶人」提供欧气种子路线、吞脉/跳脉及统一路线构造的研究方案</p>
            <div id="w2Targets" class="w2-targets"></div>
            <p id="w2Requirements" class="w2-requirements"></p>
        </section>
        <div class="w2-actions"><button id="w2Run" class="btn btn-ai-predict" disabled>开始规划路线</button><button id="w2Stop" class="btn btn-reset" hidden>停止搜索</button><button id="w2Export" class="btn btn-reset" disabled>导出路线</button></div>
        <p id="w2Status" role="status" aria-live="polite">等待选择人物。</p>
        <div id="w2Results"><div class="ai-result-empty">选择人物及目标后开始规划。</div></div>`;

    function status(text, error = false) {
        $('Status').textContent = text;
        $('Status').classList.toggle('w2-error', error);
    }
    function limitReasonText(reasons) {
        const labels = {
            'event-depth': '路线深度',
            'main-wash-budget': '主脉序扫描量',
            'tail-wash-budget': '尾脉扫描量',
            'tail-exchange-depth': '尾段置换深度',
            'event-node-budget': '状态节点数',
            'search-safety-limit': '搜索安全预算',
        };
        return [...new Set(reasons || [])].map(reason => labels[reason] || reason).join('、');
    }
    function stop(text) {
        request++;
        worker?.terminate(); worker = null; running = false;
        $('Stop').hidden = true;
        $('Run').disabled = !raw || !available.length;
        if (text) status(text);
    }
    function invalidate() {
        stop(); lastResult = null;
        $('Export').disabled = true;
        $('Results').innerHTML = '<div class="ai-result-empty">条件已改变，请重新规划路线。</div>';
    }
    function preserved() {
        return raw?.talents.filter(t => t.locked && Number(TALENT_DATA[t.id]?.weight) === 4).map(t => t.id) || [];
    }
    function renderTargets() {
        const filter = $('Filter').value.trim();
        const locked = preserved();
        $('Targets').innerHTML = available.filter(id => name(id).includes(filter)).map(id => {
            const kept = locked.includes(id), group = assignments.get(id);
            const label = kept ? '已保留' : group == null ? '' : group === -1 ? '必选' : '组' + (group + 1);
            return `<button type="button" class="w2-target ${label ? 'is-selected' : ''}" data-id="${id}" aria-pressed="${!!label}" ${kept ? 'disabled' : ''} title="${esc(TALENT_DATA[id]?.desc)}"><span>${esc(name(id))}</span><small>${label || '＋'}</small></button>`;
        }).join('') || '<p class="w2-muted">暂无可选紫脉。</p>';
        try {
            const selection = AutoWash2Model.targets(raw || {talents: []}, assignments, TALENT_DATA);
            $('Count').textContent = `${selection.targetIds.length + selection.compatibleGroups.length} / 4 槽`;
            $('Requirements').textContent = ['必选：' + (selection.targetIds.map(name).join('、') || '无'),
                ...selection.compatibleGroups.map((g, i) => `兼容组${i + 1}：${g.map(name).join(' / ')}`)].join('；');
        } catch (error) {
            $('Count').textContent = '待选择'; $('Requirements').textContent = error.message;
        }
    }
    function renderLocks() {
        $('Locks').innerHTML = raw?.talents.length ? raw.talents.map((t, i) => `<button type="button" class="w2-lock ${t.locked ? 'is-selected' : ''}" data-index="${i}" aria-pressed="${t.locked}"><strong>${esc(name(t.id))}</strong><span>${t.locked ? '已锁定' : '未锁定 · 点击保留'}</span></button>`).join('') : '<p class="w2-muted">当前无天赋。</p>';
    }
    function makeWorker() {
        if (worker) return worker;
        worker = new Worker(new URL('auto_wash2_worker.js', document.currentScript?.src || new URL('../shared/auto_wash2.js', location.href)));
        worker.onerror = event => { stop(); status('后台计算失败：' + (event.message || '请重新进入此页面重试'), true); };
        return worker;
    }
    function inspect() {
        const id = ++request;
        status('正在读取人物可用紫脉…');
        const w = makeWorker();
        w.onmessage = ({data}) => {
            if (data.requestId !== id) return;
            if (data.type === 'error') { stop(); status(data.error, true); return; }
            if (data.type !== 'summary') return;
            const allowed = new Set(data.summary.allowed);
            available = data.summary.purpleIds.filter(id => allowed.has(id));
            assignments = new Map([...assignments].filter(([id]) => available.includes(id)));
            renderTargets(); $('Run').disabled = false; status('已就绪，选择目标后开始规划。');
        };
        w.postMessage({type: 'inspect', requestId: id, raw});
    }
    function chooseRole() {
        invalidate(); raw = null; available = []; activeRole = $('Role').value;
        $('Run').disabled = true;
        const s = window.state || {}, entry = s.saveRoles?.find(e => e.key === activeRole);
        if (!entry) { $('Run').disabled = true; renderLocks(); renderTargets(); status('请选择人物。'); return; }
        try {
            if (s.dlcMode || /international|oversea|国际|國際/i.test([s.saveChannel, s.savePlatform].join(' '))) throw new Error('此模块暂支持国服及先行服，国际服请使用原有功能。');
            raw = AutoWash2Model.snapshot(s.saveData, entry.role, {vip: $('Vip').value, channel: s.saveChannel});
            if (![150, 151, 152, 153, 154].includes(raw.zizhi)) throw new Error('该人物资质不受支持。');
            bag = (Array.isArray(s.saveData.Items) ? s.saveData.Items : Object.values(s.saveData.Items || {})).reduce((n, t) => n + (Number(t.ID) === 2601 ? Number(t.Num) || 0 : 0), 0);
            $('Bag').textContent = bag.toLocaleString() + ' 丹';
            $('Summary').textContent = `${entry.tag} · ${entry.role.Name || '无名'} · ${ZZ_DATA[raw.zizhi]?.zz_name || ZZ_DATA[raw.zizhi]?.name || ['资质平平', '资质过人', '武林俊杰', '绝世奇才', '空前绝后'][raw.zizhi - 150]} · ${raw.zizhi - 150} 槽 · 从导入存档的原始状态起算`;
            renderLocks(); renderTargets(); inspect();
        } catch (error) { raw = null; $('Run').disabled = true; renderLocks(); renderTargets(); status(error.message, true); }
    }
    function refresh() {
        const s = window.state || {}, signature = JSON.stringify([s.saveChannel, s.savePlatform, s.dlcMode]);
        if (source === s.saveData && context === signature) return;
        source = s.saveData; context = signature; invalidate(); raw = null; available = []; assignments.clear();
        $('Role').innerHTML = '<option value="">请选择人物</option>' + (s.saveRoles || []).map(e => `<option value="${esc(e.key)}">${esc(e.tag + ' · ' + (e.role.Name || e.role.ID))}</option>`).join('');
        $('Role').disabled = !s.saveRoles?.length; $('Run').disabled = true;
        $('Bag').textContent = '—'; $('Summary').textContent = s.saveData ? '存档已导入，请明确选择一名人物。' : '请先在首页导入存档，再选择人物。';
        renderLocks(); renderTargets(); status('等待选择人物。');
    }
    function renderResult(result) {
        if (!result) return;
        lastResult = result;
        const routes = result.routes || [];
        $('Export').disabled = !routes.length;
        $('Results').innerHTML = routes.length ? `<p class="w2-muted">已找到 ${routes.length} 条候选，按总丹耗排序。候选经过内核回放校验，不保证全局最优。</p>` + routes.slice(0, 20).map((r, i) => {
            const remaining = bag - Number(r.totalPills || 0);
            const method = r.kind === 'unified-seed-route' ? `欧气种子统一路线 · ${r.seedMethod || '统一构造'}`
                : r.kind === 'luck-seed-replay' ? `欧气种子路线 · ${r.seedMethod || '种子优化'}`
                : r.kind === 'anchor-replay' ? '锚点路线' : '分级战术搜索';
            return `<details class="w2-route" ${i === 0 ? 'open' : ''}><summary><strong>路线 ${i + 1} · ${Number(r.totalPills).toLocaleString()} 丹</strong><span>${esc(method)} · ${Number(r.totalWashes)} 次洗脉 · ${remaining < 0 ? '缺' + -remaining : '余' + remaining} 丹</span></summary><p>最终天赋：${esc((r.finalTalents || []).map(t => t.name || name(t.id)).join('、'))}</p><div class="w2-table"><table><thead><tr><th>步骤</th><th>操作与核对</th><th>本步丹耗</th><th>累计丹耗</th><th>剩余丹数</th></tr></thead><tbody>${(r.steps || []).map((step, n) => `<tr><td>${n + 1}</td><td><strong>${esc(step.label)}</strong><p>${esc(step.detail)}</p><small>${esc((step.after?.talents || []).map(t => (t.name || name(t.id)) + (t.locked ? '（锁）' : '')).join('、'))}</small></td><td>${Number(step.pills || 0)}</td><td>${Number(step.cumulativePills || 0)}</td><td>${bag - Number(step.cumulativePills || 0)}</td></tr>`).join('')}</tbody></table></div></details>`;
        }).join('') : `<div class="ai-result-empty">${esc(result.noResultReason || '本轮搜索暂未找到路线，可以增加耗丹上限或调整目标。')}</div>`;
    }
    function run() {
        refresh();
        if (!raw || running) return;
        try {
            const budget = Number($('Budget').value);
            if (!Number.isInteger(budget) || budget < 0 || budget > 20000) throw new Error('耗丹上限须为 0–20000 的整数。');
            const selection = AutoWash2Model.targets(raw, assignments, TALENT_DATA);
            AutoWash2Model.combinations(selection);
            invalidate();
            running = true; $('Run').disabled = true; $('Stop').hidden = false;
            const id = ++request, started = Date.now(), input = {initialState: clone(raw), ...selection,
                bagPills: bag, hasBagPills: true, dlcMode: false,
                options: {maxTotalPills: budget, maxStoredStates: 500000, searchPolicy: 'full'}};
            status('正在启动本地路线搜索…');
            const w = makeWorker();
            w.onmessage = ({data}) => {
                if (data.requestId !== id) return;
                if (data.type === 'progress') status(`${data.progress?.message || '搜索中…'} · ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
                if (data.type === 'candidate') renderResult(data.result);
                if (data.type === 'error') { stop(); status(data.error, true); }
                if (data.type === 'result') {
                    renderResult(data.result); stop();
                    const internalReason = limitReasonText(data.result?.limitReasons);
                    const limitMessage = data.result?.limitReason === 'time' ? '已用满总时限'
                        : data.result?.limitReason === 'time-and-internal' ? '总时限与内部安全上限均已触发'
                            : data.result?.limitReason === 'internal' ? `触发内部安全上限${internalReason ? '：' + internalReason : ''}`
                                : '完成当前搜索范围';
                    status(`本轮搜索${limitMessage} · ${((Date.now() - started) / 1000).toFixed(1)} 秒。${data.result?.routes?.length ? '可展开查看操作路线。' : '本轮未找到不代表不存在可行路线。'}`);
                }
            };
            w.postMessage({type: 'search', requestId: id, input});
        } catch (error) { stop(); status(error.message, true); }
    }
    $('Role').addEventListener('change', () => { assignments.clear(); chooseRole(); });
    $('Vip').addEventListener('change', chooseRole);
    $('Budget').addEventListener('input', () => { invalidate(); status('耗丹上限已修改，请重新规划。'); });
    $('Filter').addEventListener('input', renderTargets);
    $('Targets').addEventListener('click', event => {
        const button = event.target.closest('[data-id]'); if (!button || button.disabled) return;
        invalidate(); const id = Number(button.dataset.id), group = Number($('Group').value);
        if (assignments.get(id) === group) assignments.delete(id); else assignments.set(id, group);
        renderTargets();
    });
    $('Locks').addEventListener('click', event => {
        const button = event.target.closest('[data-index]'); if (!button || !raw) return;
        invalidate(); const talent = raw.talents[Number(button.dataset.index)]; talent.locked = !talent.locked;
        renderLocks(); renderTargets();
    });
    $('Preset').addEventListener('click', () => {
        if (![271, 272, 250].every(id => available.includes(id))) { status('当前人物无法选择完整的金顶混组合，请检查 VIP 和人物条件。', true); return; }
        invalidate(); assignments = new Map([271, 272, 250].map(id => [id, -1])); renderTargets();
    });
    $('Clear').addEventListener('click', () => { invalidate(); assignments.clear(); renderTargets(); });
    $('Run').addEventListener('click', run);
    $('Stop').addEventListener('click', () => stop('搜索已停止，保留已找到的候选；再次开始将重新搜索。'));
    $('Export').addEventListener('click', () => {
        if (!lastResult?.routes?.length) return;
        const text = lastResult.routes.map((r, i) => `路线 ${i + 1}：${r.totalPills} 丹\n` + r.steps.map((s, n) => `${n + 1}. ${s.label}：${s.detail}（累计 ${s.cumulativePills || 0} 丹，剩余 ${bag - Number(s.cumulativePills || 0)} 丹）`).join('\n')).join('\n\n');
        const url = URL.createObjectURL(new Blob([text], {type: 'text/plain;charset=utf-8'}));
        const a = document.createElement('a'); a.href = url; a.download = '自动洗脉(改进)_路线.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    window.AutoWash2 = Object.freeze({refresh});
    refresh();
    const watch = setInterval(refresh, 500);
    window.addEventListener('pagehide', () => { clearInterval(watch); stop(); });
})();
