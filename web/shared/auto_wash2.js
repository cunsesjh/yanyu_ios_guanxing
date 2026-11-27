(function () {
    'use strict';
    const $ = id => document.getElementById('w2' + id);
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const name = id => TALENT_DATA[id]?.name || '#' + id;
    const clone = value => JSON.parse(JSON.stringify(value));
    let raw = null, worker = null, request = 0, running = false, inspecting = false, available = [], assignments = new Map(), progressTimer = null, awashController = null;
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
                <div class="w2-stock">背包洗髓丹<strong id="w2Bag">—</strong></div>
            </div>
            <p id="w2BudgetNotice" class="w2-muted">搜索耗丹上限固定为 100 万丹。</p>
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
                <button id="w2Preset" type="button" class="btn btn-reset" disabled>金顶混</button>
                <button id="w2Clear" type="button" class="btn btn-reset">清空选择</button>
            </div>
        <p class="w2-muted">必选脉全部取得，每个兼容组至少取得一条，目标数最多四条。切换分组后点击可移动目标，再点同组目标取消。规划会持续比较可执行路线并优先降低丹耗，找到后继续压价；只有经过完整回放核对的候选才会显示。</p>
            <p class="w2-credit">特别鸣谢 B 站 UP 主「庸丶人」提供欧气种子、无限置换垫洗、吞脉/跳脉、保底种子前沿与检查点质量搜索等路线的研究方案。</p>
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
            'search-safety-limit': '搜索安全上限',
        };
        return [...new Set(reasons || [])].map(reason => labels[reason] || reason).join('、');
    }
    function routeReasonText(reason) {
        const labels = {
            'positive-budget-required': '搜索缺少有效的洗髓丹预算，无法开始。',
            'checkpoint-quality-no-route': '已检查的候选检查点中没有找到可行路线。',
            'initial-search-no-route': '从当前存档直接搜索也没有找到路线（在本轮搜索范围内）。',
            'no-remaining-budget': '前置步骤已用完丹耗预算，无法继续搜索。',
            'prefix-at-or-over-upper-bound': '前置步骤丹耗已达到或超过预算上限。',
            'checkpoint-quality-exhausted': '候选检查点已搜索完，未找到更优路线。',
            'max-runtime': '搜索时间已到上限；可以减少目标或重新开始搜索。',
            'route-search-no-route': '本轮没有找到可行路线。',
        };
        const key = String(reason || '本分支未找到路线');
        if (labels[key]) return labels[key];
        if (key.startsWith('unknown-or-non-purple-target:')) {
            return '所选目标中有当前不支持的紫脉。';
        }
        return `搜索未找到路线（${key}）。`;
    }
    function talentStateHtml(after) {
        const talents = after?.talents || [];
        if (!talents.length) return '';
        return `<div class="w2-step-state"><strong>本步完成后的当前脉序</strong><ul>${talents.map(t => {
            const item = TALENT_DATA[Number(t.id)] || {};
            return `<li><b>${esc(item.name || name(t.id))}${t.locked ? '（已锁定）' : ''}</b><span>${esc(item.desc || '暂无天赋说明')}</span></li>`;
        }).join('')}</ul></div>`;
    }
    function stop(text) {
        request++;
        if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
        if (awashController) { awashController.abort(); awashController = null; }
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
        worker = new Worker(new URL('auto_wash2_worker.js?v=20261126washfix4', document.currentScript?.src || new URL('../shared/auto_wash2.js', location.href)));
        worker.onerror = event => { stop(); status('后台计算失败：' + (event.message || '请重新进入此页面重试'), true); };
        return worker;
    }
    function inspect() {
        const id = ++request;
        inspecting = true;
        $('Preset').disabled = true;
        status('正在读取人物可用紫脉…');
        const w = makeWorker();
        w.onmessage = ({data}) => {
            if (data.requestId !== id) return;
            if (data.type === 'error') { inspecting = false; stop(); status(data.error, true); return; }
            if (data.type !== 'summary') return;
            inspecting = false;
            const allowed = new Set(data.summary.allowed);
            available = data.summary.purpleIds.filter(id => allowed.has(id));
            assignments = new Map([...assignments].filter(([id]) => available.includes(id)));
            renderTargets(); $('Preset').disabled = false; $('Run').disabled = false; status('已就绪，选择目标后开始规划。');
        };
        w.postMessage({type: 'inspect', requestId: id, raw});
    }
    function chooseRole() {
        invalidate(); raw = null; available = []; inspecting = false; activeRole = $('Role').value;
        $('Preset').disabled = true; $('Run').disabled = true;
        const s = window.state || {}, entry = s.saveRoles?.find(e => e.key === activeRole);
        if (!entry) { $('Run').disabled = true; renderLocks(); renderTargets(); status('请选择人物。'); return; }
        try {
            if (s.dlcMode || /international|oversea|国际|國際/i.test([s.saveChannel, s.savePlatform].join(' '))) throw new Error('此模块暂支持国服及先行服，国际服请使用原有功能。');
            raw = AutoWash2Model.snapshot(s.saveData, entry.role, {vip: $('Vip').value, channel: s.saveChannel, saveVersion: s.saveVersion});
            if (![150, 151, 152, 153, 154].includes(raw.zizhi)) throw new Error('该人物资质不受支持。');
            bag = (Array.isArray(s.saveData.Items) ? s.saveData.Items : Object.values(s.saveData.Items || {})).reduce((n, t) => n + (Number(t.ID) === 2601 ? Number(t.Num) || 0 : 0), 0);
            $('Bag').textContent = bag.toLocaleString() + ' 丹';
            $('Summary').textContent = `${entry.tag} · ${entry.role.Name || '无名'} · ${ZZ_DATA[raw.zizhi]?.zz_name || ZZ_DATA[raw.zizhi]?.name || ['资质平平', '资质过人', '武林俊杰', '绝世奇才', '空前绝后'][raw.zizhi - 150]} · ${raw.zizhi - 150} 槽 · 从导入存档的原始状态起算${raw.zizhi === 151 ? ' · 单槽也支持自动规划（请选择可用目标）' : ''}`;
            renderLocks(); renderTargets(); inspect();
        } catch (error) { raw = null; $('Run').disabled = true; renderLocks(); renderTargets(); status(error.message, true); }
    }
    function refresh() {
        const s = window.state || {}, signature = JSON.stringify([s.saveChannel, s.savePlatform, s.dlcMode]);
        if (source === s.saveData && context === signature) return;
        source = s.saveData; context = signature; invalidate(); raw = null; available = []; inspecting = false; assignments.clear();
        $('Role').innerHTML = '<option value="">请选择人物</option>' + (s.saveRoles || []).map(e => `<option value="${esc(e.key)}">${esc(e.tag + ' · ' + (e.role.Name || e.role.ID))}</option>`).join('');
        $('Role').disabled = !s.saveRoles?.length; $('Preset').disabled = true; $('Run').disabled = true;
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
            const method = r.kind === 'awash-full-route' ? 'AWASH 完整路线'
                : r.kind === 'unified-seed-route' ? `欧气种子统一路线 · ${r.seedMethod || '统一构造'}`
                : r.kind === 'luck-seed-replay' ? `欧气种子路线 · ${r.seedMethod || '种子优化'}`
                : r.kind === 'anchor-replay' ? '锚点路线' : '分级战术搜索';
            return `<details class="w2-route" ${i === 0 ? 'open' : ''}><summary><strong>路线 ${i + 1} · ${Number(r.totalPills).toLocaleString()} 丹</strong><span>${esc(method)} · ${Number(r.totalWashes)} 次洗脉 · ${remaining < 0 ? '缺' + -remaining : '余' + remaining} 丹</span></summary><p>最终天赋：${esc((r.finalTalents || []).map(t => t.name || name(t.id)).join('、'))}</p><div class="w2-table"><table><thead><tr><th>步骤</th><th>操作与核对</th><th>本步丹耗</th><th>累计丹耗</th><th>剩余丹数</th></tr></thead><tbody>${(r.steps || []).map((step, n) => `<tr><td>${n + 1}</td><td><strong>${esc(step.label)}</strong><p class="w2-step-detail">${esc(step.detail)}</p>${talentStateHtml(step.after)}</td><td>${Number(step.pills || 0)}</td><td>${Number(step.cumulativePills || 0)}</td><td>${bag - Number(step.cumulativePills || 0)}</td></tr>`).join('')}</tbody></table></div></details>`;
        }).join('') : `<div class="ai-result-empty">${esc(result.noResultReason || '本轮搜索暂未找到路线，可以增加耗丹上限或调整目标。')}</div>`;
    }
    async function runAwash(input, branches, id, started, onProgress) {
        const routes = [], reasons = [];
        const apiUrl = new URL('../api/awash/search', location.href);
        awashController = new AbortController();
        for (let index = 0; index < branches.length; index++) {
            if (!running || id !== request) return;
            onProgress(`AWASH 正在规划路线 ${index + 1}/${branches.length}…`);
            const response = await fetch(apiUrl, {method: 'POST',
                headers: {'Content-Type': 'application/json'}, signal: awashController.signal,
                body: JSON.stringify({raw: input.initialState, targets: branches[index],
                    budget: input.options.maxTotalPills,
                    options: {budget: input.options.maxTotalPills,
                        concurrency: 16, horizon: 2000,
                        pityQuality: true, seedQuality: true, stopOnFirstRoute: false,
                        infiniteOptions: {nMax: 100, count: 30},
                        frontierOptions: {boundaryLanding: true, maxStates: 200, maxRounds: 1},
                        limits: {maxRuntimeMs: 900000, maxExpandedNodes: 500000,
                            maxWashSteps: 2000000, maxUniqueStates: 300000},
                        runtime: {beamWidth: 150, chainBeamWidth: 24, maxDepth: 150,
                            maxRunWashes: 1000, maxPolicyWashes: 300000}}})});
            let payload;
            try { payload = await response.json(); }
            catch (_) { throw new Error(`AWASH 服务返回非 JSON（HTTP ${response.status}），请确认已运行支持 AWASH 的本地程序。`); }
            if (!response.ok) throw new Error(payload?.error || `AWASH 请求失败（HTTP ${response.status}）。`);
            const route = AutoWash2RouteView.normalizeRoute(payload.route, index, name);
            if (route) {
                routes.push(route);
                renderResult({routes: routes.slice().sort((a, b) => a.totalPills - b.totalPills), noResultReason: ''});
            } else reasons.push(routeReasonText(payload.stopReason || payload.status));
        }
        if (!running || id !== request) return;
        const sorted = routes.sort((a, b) => a.totalPills - b.totalPills);
        const result = {routes: sorted, noResultReason: sorted.length ? ''
            : `AWASH 未找到路线：${[...new Set(reasons)].join('；') || '无可行路线'}`};
        renderResult(result); stop();
        status(sorted.length ? `AWASH 完成 · ${sorted.length} 条路线 · ${((Date.now() - started) / 1000).toFixed(1)} 秒。`
            : `${result.noResultReason} · ${((Date.now() - started) / 1000).toFixed(1)} 秒。`, !sorted.length);
    }
    function run() {
        refresh();
        if (!raw || running) return;
        try {
            const budget = 1000000;
            const selection = AutoWash2Model.targets(raw, assignments, TALENT_DATA);
            const branches = AutoWash2Model.combinations(selection);
            invalidate();
            running = true; $('Run').disabled = true; $('Stop').hidden = false;
            const id = ++request, started = Date.now(), input = {initialState: clone(raw), ...selection,
                bagPills: bag, hasBagPills: true, dlcMode: false,
                options: {maxTotalPills: budget, timeBudgetMs: 1200000}};
            let progressMessage = '正在启动 wash 路线构造器…';
            const updateProgress = () => {
                if (running) status(`${progressMessage} · ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
            };
            updateProgress();
            progressTimer = setInterval(updateProgress, 250);
            runAwash(input, branches, id, started, message => { progressMessage = message; updateProgress(); }).catch(error => {
                if (error?.name === 'AbortError') return;
                stop(); status(error?.message || String(error), true);
            });
        } catch (error) { stop(); status(error.message, true); }
    }
    $('Role').addEventListener('change', () => { assignments.clear(); chooseRole(); });
    $('Vip').addEventListener('change', chooseRole);
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
        if (inspecting) { status('正在读取人物可用紫脉，请稍候。'); return; }
        const presetIds = [271, 272, 250], missing = presetIds.filter(id => !available.includes(id));
        if (missing.length) {
            const reasons = missing.map(id => {
                if (id === 250) {
                    const limits = [];
                    if (Number(raw?.vip) < 1) limits.push('需要 VIP 1+');
                    if (Number(raw?.zizhi) < 152) limits.push('需要至少 2 槽资质');
                    return `${name(id)}${limits.length ? '（' + limits.join('、') + '）' : '（不在当前人物可用脉池）'}`;
                }
                return `${name(id)}${Number(raw?.zizhi) < 151 ? '（需要至少 1 槽资质）' : '（不在当前人物可用脉池）'}`;
            });
            if (Number(raw?.zizhi) <= 151 && missing.includes(250)) {
                const slotText = Number(raw?.zizhi) === 150 ? '零槽' : '单槽';
                status(`当前是${slotText}角色，金顶混预设中的${name(250)}需要至少 2 槽。${slotText}仍可自动洗脉，请手动选择当前可用紫脉。`);
                return;
            }
            status(`无法选择完整的金顶混组合，缺少：${reasons.join('、')}。`, true);
            return;
        }
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
