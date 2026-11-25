(function () {
    'use strict';

    var PAPER_IDS = [2581, 2584, 2580, 3461, 3439, 3449, 3460, 2586, 2585, 2587, 2583, 2582, 3458, 3454, 3429, 3456, 3409, 3419];
    var PART_NAMES = {1: '拳套', 2: '刀', 3: '剑', 4: '枪棍', 5: '腰带', 6: '护腕', 7: '内甲', 8: '戒指', 9: '挂坠'};
    var PART_ORDER = Object.keys(PART_NAMES).map(Number);
    var results = [];
    var resultIndexes = Object.create(null);
    var saveData = null;
    var cancelRequested = false;
    var allocationCancelRequested = false;
    var targetCancelRequested = false;
    var equipmentEngineReady = null;

    function $(id) { return document.getElementById(id); }
    function number(value, fallback) { var n = Number(value); return Number.isFinite(n) ? n : fallback; }
    function integer(value, min, max, fallback) { return Math.max(min, Math.min(max, Math.trunc(number(value, fallback)))); }
    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
            return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch];
        });
    }
    function rootSave(data) { return Array.isArray(data) ? data[0] : data; }
    function extractMakeRnd(data) {
        var root = rootSave(data);
        var make = root && root.MakeRnd || (data && (data.Seeds || data.LuckySeeds) ? data : null);
        if (!make) return null;
        return {Seeds: make.Seeds || {}, LuckySeeds: make.LuckySeeds || {}, IDSeeds: make.IDSeeds || {}, MakeLucky: make.MakeLucky || {}};
    }
    function propName(prop) { return EQUIP_DATA.propNames && EQUIP_DATA.propNames[prop] || prop; }
    function formatProp(prop, value) {
        var percentProps = ['dmg_off', 'dmg_ref', 'def_ign', 'atk_extend', 'sword_add', 'unarmed_add', 'blade_add', 'stick_add', 'blood', 'po_parry', 'po_dodge', 'xx_prob', 'xx_crit'];
        if (percentProps.indexOf(prop) >= 0) return (number(value, 0) * 100).toFixed(1).replace(/\.0$/, '') + '%';
        return Math.round(number(value, 0) * 10) / 10;
    }
    function refinementTotal(refinement) {
        var maxima = refinement && refinement.maxima || {};
        return [1, 2, 3].reduce(function (sum, slot) { return sum + number(maxima[slot] && maxima[slot].value, 0); }, 0);
    }
    function refinementDisplayTotal(refinement) {
        var prop = refinement && refinement.prop;
        var percentProps = ['dmg_off', 'dmg_ref', 'def_ign', 'atk_extend', 'sword_add', 'unarmed_add', 'blade_add', 'stick_add', 'blood', 'po_parry', 'po_dodge', 'xx_prob', 'xx_crit'];
        if (percentProps.indexOf(prop) < 0) return formatProp(prop, refinementTotal(refinement));
        var maxima = refinement && refinement.maxima || {};
        var points = [1, 2, 3].reduce(function (sum, slot) {
            var value = number(maxima[slot] && maxima[slot].value, 0);
            return sum + Math.floor(value * 1000 + 0.001) / 10;
        }, 0);
        return points.toFixed(1).replace(/\.0$/, '') + '%';
    }
    function refinementCost(refinement) { return number(refinement && refinement.plan && refinement.plan.cost && refinement.plan.cost.lianjin, 0); }
    function regionBonusItem(item) {
        var value = Math.max(0, number(item && item.value, 0));
        var weights = {dmg_off: 1250, dmg_ref: 1000, atk: 0.2, atk_add: 0.2, str: 1.25, con: 1.25, dex: 1.25, int: 1.25, mp_f: 2, mp_back: 5, def: 0.04, def_add: 0.04, hp: 0.03, hp_add: 0.03, hit: 0.1, hit_add: 0.1, speed: 0.08, speed_add: 0.08, dodge: 0.06, dodge_add: 0.06, parry: 0.06, parry_add: 0.06};
        return value * number(weights[item && item.prop], 0);
    }
    function regionBonus(region) { return Math.min(30, (region || []).reduce(function (sum, item) { return sum + regionBonusItem(item); }, 0)); }
    function bestWithinBudget(candidate, budget, refineProp) {
        var upgradeMud = candidate.upgraded ? 10 : 0;
        var reference = candidate.refinementRatingReference || {};
        return (candidate.refinements || []).reduce(function (best, refinement) {
            if (refineProp && refineProp !== 'all' && refinement.prop !== refineProp) return best;
            var mud = upgradeMud + refinementCost(refinement);
            var maximum = number(reference[refinement.prop], 0);
            var baseScore = maximum > 0 ? Math.min(100, refinementTotal(refinement) / maximum * 100) : 0;
            var option = {refinement: refinement, mud: mud, baseScore: baseScore};
            if (mud > budget) return best;
            if (!best || option.baseScore > best.baseScore || (option.baseScore === best.baseScore && option.mud < best.mud)) return option;
            return best;
        }, null);
    }
    function scoreCandidate(candidate, budget, refineProp) {
        var best = bestWithinBudget(candidate, budget, refineProp);
        if (!best) return null;
        var bonus = regionBonus(candidate.region);
        var finalScore = Math.min(100, best.baseScore + bonus);
        if (finalScore < 91) return null;
        var config = EQUIP_DATA.equipment[String(candidate.equipId)] || {};
        return {id: candidate.id, part: number(config.type, 0), equipName: candidate.equipName, paperName: candidate.paperName,
            location: candidate.location, craftIndex: number(candidate.craftIndex, 0), region: candidate.region || [], refinement: best.refinement,
            mud: best.mud, silver: number(candidate.craftCost && candidate.craftCost.silver, 0) + number(candidate.upgradeCost && candidate.upgradeCost.silver, 0) + number(best.refinement.plan && best.refinement.plan.cost && best.refinement.plan.cost.silver, 0),
            baseScore: best.baseScore, bonus: bonus, finalScore: finalScore, grade: finalScore >= 96 ? '神器' : '极品'};
    }
    function resultKey(item, candidate) {
        return [item.part, candidate.equipId, candidate.S, candidate.CZSeed, item.refinement.prop, refinementTotal(item.refinement), item.mud].join('::');
    }
    function addToCollection(collection, indexes, candidate, budget, refineProp) {
        var scored = scoreCandidate(candidate, budget, refineProp);
        if (!scored) return;
        var key = resultKey(scored, candidate);
        var index = indexes[key];
        if (index == null) { indexes[key] = collection.length; collection.push(scored); return; }
        var old = collection[index];
        if (scored.bonus > old.bonus || (scored.bonus === old.bonus && scored.silver < old.silver)) collection[index] = scored;
    }
    function compareResults(a, b) { return b.finalScore - a.finalScore || b.bonus - a.bonus || a.mud - b.mud || a.craftIndex - b.craftIndex || a.location.localeCompare(b.location, 'zh'); }
    function dedupeCraftsmen(craftsmen) {
        var seen = Object.create(null);
        return craftsmen.filter(function (npc) {
            var signature = npc.zhi + ':' + JSON.stringify(npc.tx || null) + ':' + JSON.stringify(npc.tx2 || null);
            if (seen[signature]) return false;
            seen[signature] = true;
            return true;
        });
    }
    function branchesForPart(part) {
        var papers = PAPER_IDS.map(function (id) { return EQUIP_DATA.papers[String(id)]; }).filter(function (paper) {
            var equip = paper && EQUIP_DATA.equipment[String(paper.dz_equip)];
            return equip && number(equip.type, 0) === part;
        });
        var branches = [];
        dedupeCraftsmen(EquipmentAutoOptimizer.sortedCraftsmen(EQUIP_DATA)).forEach(function (npc) {
            papers.forEach(function (paper) {
                var available = EquipmentAutoOptimizer.papersForCraftsman(EQUIP_DATA, npc.id).some(function (entry) { return Number(entry.paper.id) === Number(paper.id); });
                if (available) branches.push({npcId: npc.id, paperId: paper.id, specialId: 0});
            });
        });
        return branches;
    }
    function propertyTargetsForPart(part) {
        var props = Object.create(null);
        PAPER_IDS.forEach(function (id) {
            var paper = EQUIP_DATA.papers[String(id)];
            var equip = paper && EQUIP_DATA.equipment[String(paper.dz_equip)];
            if (!equip || number(equip.type, 0) !== part) return;
            var upgraded = EQUIP_DATA.equipment[String(equip.equ_next)] || equip;
            Object.keys(upgraded.exts || {}).forEach(function (prop) { props[prop] = true; });
        });
        return EquipmentAutoOptimizer.TARGET_PROPERTIES.filter(function (prop) { return props[prop]; });
    }
    function regionPropertiesForPart(part) {
        var npcIds = new Set(branchesForPart(part).map(function (branch) { return Number(branch.npcId); }));
        var props = Object.create(null);
        npcIds.forEach(function (npcId) {
            var npc = EQUIP_DATA.craftsman[String(npcId)] || {};
            [npc.tx, npc.tx2].forEach(function (entries) {
                (entries || []).forEach(function (entry) { if (Array.isArray(entry) && entry[0]) props[entry[0]] = true; });
            });
        });
        return Object.keys(props).sort(function (a, b) { return propName(a).localeCompare(propName(b), 'zh'); });
    }
    function setProgress(prefix, done, total, text) {
        var percent = total ? Math.round(done / total * 100) : 0;
        var textId = prefix === 'plan' ? 'progressText' : prefix + 'ProgressText';
        var percentId = prefix === 'plan' ? 'progressPercent' : prefix + 'ProgressPercent';
        var fillId = prefix === 'plan' ? 'progressFill' : prefix + 'ProgressFill';
        $(prefix + 'Progress').hidden = false;
        $(textId).textContent = text;
        $(percentId).textContent = percent + '%';
        $(fillId).style.width = percent + '%';
    }
    function bridge() {
        return {getMakeState: function () { return window.wasmMakeGetState(); }, setMakeState: function (next) { if (!window.wasmMakeSetState(next)) throw new Error('打造状态恢复失败'); return true; }, makePreview: function (request, count) { return window.wasmMakePreview(request, count); }, xilianPlan: function (equip, accepts) { return window.wasmXilianPlan(equip, accepts); }};
    }
    function ensureEquipmentEngine() {
        if (!equipmentEngineReady) {
            equipmentEngineReady = window.initWasm().then(function (ready) {
                if (!ready) throw new Error('装备计算内核加载失败。');
                if (!window.wasmMakeInitTables(EQUIP_DATA)) throw new Error('装备数据初始化失败。');
                return true;
            }).catch(function (error) {
                equipmentEngineReady = null;
                throw error;
            });
        }
        return equipmentEngineReady;
    }
    async function scanRoutes(options) {
        var makeRnd = extractMakeRnd(saveData);
        if (!makeRnd) throw new Error('当前存档缺少 MakeRnd 打造状态。');
        await ensureEquipmentEngine();
        window.wasmMakeSetState(makeRnd);
        var tasks = [];
        options.parts.forEach(function (part) { branchesForPart(part).forEach(function (branch) { tasks.push({part: part, branch: branch}); }); });
        try {
            for (var index = 0; index < tasks.length; index += 1) {
                if (options.cancelled()) break;
                var task = tasks[index];
                options.progress(index, tasks.length, '正在计算' + PART_NAMES[task.part] + ' · 路线 ' + (index + 1) + '/' + tasks.length);
                await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
                var targetProps = options.targetProp && options.targetProp !== 'all' ? [options.targetProp] : propertyTargetsForPart(task.part);
                var simulated = await EquipmentAutoOptimizer.simulateEquipmentRoutes({data: EQUIP_DATA, initialMakeState: makeRnd, branches: [task.branch], targetProps: targetProps,
                    options: {craftCount: options.craftCount, refineCount: Math.min(1000, options.mudBudget), refineMudBudget: Math.max(1, options.mudBudget - 10), attachCount: 1, maxCraftWork: 500000, maxRefineWork: 10000000, resultLimit: Math.max(100, options.craftCount)}, bridge: bridge()});
                (simulated.candidates || []).forEach(options.candidate);
                if (options.afterTask) options.afterTask();
            }
            options.progress(tasks.length, tasks.length, options.cancelled() ? '已停止' : '规划完成');
        } finally { window.wasmMakeSetState(makeRnd); }
    }
    function score(value) { return number(value, 0).toFixed(1).replace(/\.0$/, ''); }
    function silver(value) { var total = Math.max(0, Math.round(number(value, 0))); return Math.floor(total / 1000).toLocaleString() + '两' + (total % 1000) + '文'; }
    function cardHtml(item) {
        var region = item.region.length ? item.region.map(function (prop) { return '<span>' + escapeHtml(propName(prop.prop)) + ' +' + escapeHtml(formatProp(prop.prop, prop.value)) + '</span>'; }).join('') : '<span>无地区附加</span>';
        var refineText = escapeHtml(propName(item.refinement.prop)) + ' ' + escapeHtml(refinementDisplayTotal(item.refinement));
        return '<article class="planner-card ' + (item.grade === '神器' ? 'is-artifact' : 'is-premium') + '"><header class="planner-card-head"><div><h4>' + escapeHtml(item.equipName) + '</h4><p>' + escapeHtml(item.paperName) + ' · ' + escapeHtml(item.location) + ' · 第' + item.craftIndex + '件</p></div><span class="planner-grade"><b>' + item.grade + '</b><strong>' + score(item.finalScore) + '</strong></span></header><div class="planner-score-grid"><span>精炼基础<strong>' + score(item.baseScore) + '</strong></span><span>地区附加<strong>+' + score(item.bonus) + '</strong></span><span>最终评分<strong>' + score(item.finalScore) + '</strong></span></div><div class="planner-props"><span>最佳精炼 ' + refineText + '</span>' + region + '</div><footer class="planner-card-foot"><span>实际泥耗 <strong>' + item.mud.toLocaleString() + '</strong></span><span>累计银两 <strong>' + silver(item.silver) + '</strong></span></footer></article>';
    }
    function renderResults() {
        var filter = $('partFilter').value;
        var attachOnly = $('attachOnly').checked;
        var html = [], shown = 0;
        (filter === 'all' ? PART_ORDER : [Number(filter)]).forEach(function (part) {
            var items = results.filter(function (item) { return item.part === part && (!attachOnly || item.region.length); }).sort(compareResults);
            if (!items.length) return;
            shown += items.length;
            html.push('<section class="planner-part-group"><div class="planner-part-title"><h3>' + PART_NAMES[part] + '</h3><span>符合 ' + items.length + ' 件</span></div><div class="planner-cards">' + items.map(cardHtml).join('') + '</div></section>');
        });
        $('resultGroups').innerHTML = html.join('');
        $('resultEmpty').hidden = shown > 0;
        if (!shown) $('resultEmpty').textContent = results.length ? '当前筛选条件下没有神器或极品。' : '当前已完成范围内没有达到神器或极品的装备。';
        $('resultMeta').textContent = results.length ? '共找到 ' + results.length + ' 件 · 当前展示 ' + shown + ' 件' : '尚无符合结果';
    }
    async function runPlanner() {
        var budget = integer($('mudBudget').value, 10, 1000, 200), count = integer($('craftCount').value, 1, 500, 20);
        $('mudBudget').value = budget; $('craftCount').value = count; results = []; resultIndexes = Object.create(null); cancelRequested = false;
        $('btnPlan').disabled = true; $('btnCancel').hidden = false; $('btnCancel').disabled = false; $('resultEmpty').hidden = false; $('resultEmpty').textContent = '正在按部位推演打造与精炼结果...'; $('resultGroups').replaceChildren();
        try {
            await scanRoutes({parts: PART_ORDER, mudBudget: budget, craftCount: count, cancelled: function () { return cancelRequested; }, progress: function (done, total, text) { setProgress('plan', done, total, text); }, candidate: function (candidate) { addToCollection(results, resultIndexes, candidate, budget, 'all'); }, afterTask: renderResults});
            renderResults(); $('planMessage').textContent = cancelRequested ? '已停止后续路线计算，当前结果仍可筛选。' : '规划完成。结果均为预算内可执行方案。';
        } catch (error) { $('planMessage').textContent = '装备规划失败：' + (error && error.message || error); }
        finally { $('btnPlan').disabled = false; $('btnCancel').hidden = true; }
    }
    function betterState(a, b) {
        if (!b) return a; if (!a) return b;
        if (a.value !== b.value) return a.value > b.value ? a : b;
        if (a.items.length !== b.items.length) return a.items.length > b.items.length ? a : b;
        return a.silver <= b.silver ? a : b;
    }
    function allocateResources(items, budget) {
        var byPart = Object.create(null);
        items.forEach(function (item) { (byPart[item.part] || (byPart[item.part] = [])).push(item); });
        var states = new Array(budget + 1); states[0] = {value: 0, silver: 0, items: []};
        PART_ORDER.forEach(function (part) {
            var next = states.slice();
            for (var spent = 0; spent <= budget; spent += 1) if (states[spent]) (byPart[part] || []).forEach(function (item) {
                var total = spent + Math.max(0, Math.round(item.mud)); if (total > budget) return;
                next[total] = betterState(next[total], {value: states[spent].value + item.finalScore, silver: states[spent].silver + item.silver, items: states[spent].items.concat([item])});
            });
            states = next;
        });
        return states.reduce(function (best, state) { return betterState(best, state); }, null) || {value: 0, silver: 0, items: []};
    }
    function renderAllocation(plan, budget) {
        var items = (plan.items || []).slice().sort(function (a, b) { return a.part - b.part; });
        var mud = items.reduce(function (sum, item) { return sum + item.mud; }, 0), silverTotal = items.reduce(function (sum, item) { return sum + item.silver; }, 0);
        $('allocationResults').innerHTML = items.map(cardHtml).join(''); $('allocationEmpty').hidden = items.length > 0; $('allocationMeta').textContent = items.length ? '推荐 ' + items.length + ' 件装备' : '没有可分配结果'; $('allocationSummary').hidden = !items.length;
        $('allocationSummary').innerHTML = items.length ? '<span>采用装备<strong>' + items.length + ' 件</strong></span><span>连金泥<strong>' + mud + ' / ' + budget + '</strong></span><span>累计银两<strong>' + silver(silverTotal) + '</strong></span><span>总评分<strong>' + score(plan.value) + '</strong></span>' : '';
        if (!items.length) $('allocationEmpty').textContent = '当前预算内没有达到神器或极品的可分配装备。';
    }
    async function runAllocation() {
        var budget = integer($('allocationMudBudget').value, 10, 3000, 400), count = integer($('allocationCraftCount').value, 1, 500, 20), collection = [], indexes = Object.create(null);
        $('allocationMudBudget').value = budget; $('allocationCraftCount').value = count; allocationCancelRequested = false; $('btnAllocationPlan').disabled = true; $('btnAllocationCancel').hidden = false; $('btnAllocationCancel').disabled = false; $('allocationResults').replaceChildren(); $('allocationSummary').hidden = true; $('allocationEmpty').hidden = false; $('allocationEmpty').textContent = '正在扫描全部部位并计算资源组合...';
        try {
            await scanRoutes({parts: PART_ORDER, mudBudget: budget, craftCount: count, cancelled: function () { return allocationCancelRequested; }, progress: function (done, total, text) { setProgress('allocation', done, total, text); }, candidate: function (candidate) { addToCollection(collection, indexes, candidate, budget, 'all'); }});
            renderAllocation(allocateResources(collection, budget), budget); $('allocationMessage').textContent = allocationCancelRequested ? '已停止后续扫描，分配结果基于已完成路线。' : '分配完成。银两仅统计，不参与预算限制。';
        } catch (error) { $('allocationMessage').textContent = '资源分配失败：' + (error && error.message || error); }
        finally { $('btnAllocationPlan').disabled = false; $('btnAllocationCancel').hidden = true; }
    }
    function targetRegionMatches(candidate, target) {
        var region = candidate.region || [];
        if (target === 'all') return true;
        if (target === 'attached') return region.length > 0;
        var accepted = String(target).split(',');
        return region.some(function (entry) { return accepted.indexOf(entry.prop) >= 0; });
    }
    function targetComparator(mode) {
        if (mode === 'mud') return function (a, b) { return a.mud - b.mud || b.finalScore - a.finalScore || a.craftIndex - b.craftIndex; };
        if (mode === 'silver') return function (a, b) { return a.silver - b.silver || b.finalScore - a.finalScore || a.craftIndex - b.craftIndex; };
        if (mode === 'score') return compareResults;
        return function (a, b) { return a.craftIndex - b.craftIndex || b.finalScore - a.finalScore || a.mud - b.mud; };
    }
    async function runTarget() {
        var part = Number($('targetPart').value) || 1, budget = integer($('targetMudBudget').value, 10, 1000, 200), count = integer($('targetCraftCount').value, 1, 500, 100), refineProp = $('targetRefineProp').value || 'all', regionProp = $('targetRegionProp').value || 'all', collection = [], indexes = Object.create(null);
        $('targetMudBudget').value = budget; $('targetCraftCount').value = count; targetCancelRequested = false; $('btnTargetPlan').disabled = true; $('btnTargetCancel').hidden = false; $('btnTargetCancel').disabled = false; $('targetResults').replaceChildren(); $('targetEmpty').hidden = false; $('targetEmpty').textContent = '正在追踪目标装备...';
        try {
            await scanRoutes({parts: [part], mudBudget: budget, craftCount: count, targetProp: refineProp, cancelled: function () { return targetCancelRequested; }, progress: function (done, total, text) { setProgress('target', done, total, text); }, candidate: function (candidate) { if (targetRegionMatches(candidate, regionProp)) addToCollection(collection, indexes, candidate, budget, refineProp); }});
            var grade = $('targetGrade').value;
            var shown = collection.filter(function (item) { return grade !== 'artifact' || item.grade === '神器'; }).sort(targetComparator($('targetSort').value));
            $('targetResults').innerHTML = shown.map(cardHtml).join(''); $('targetEmpty').hidden = shown.length > 0; $('targetMeta').textContent = shown.length ? '找到 ' + shown.length + ' 条符合路线' : '没有符合路线';
            if (!shown.length) $('targetEmpty').textContent = '当前打造范围和泥预算内没有满足全部条件的装备。';
            $('targetMessage').textContent = targetCancelRequested ? '已停止后续路线，结果来自已完成范围。' : '追踪完成。所有结果均同时满足当前筛选条件。';
        } catch (error) { $('targetMessage').textContent = '目标追踪失败：' + (error && error.message || error); }
        finally { $('btnTargetPlan').disabled = false; $('btnTargetCancel').hidden = true; }
    }
    function fillTargetOptions() {
        var part = Number($('targetPart').value) || 1, refine = $('targetRefineProp'), oldRefine = refine.value, region = $('targetRegionProp'), oldRegion = region.value;
        refine.innerHTML = '<option value="all">不限属性</option>' + propertyTargetsForPart(part).map(function (prop) { return '<option value="' + escapeHtml(prop) + '">' + escapeHtml(propName(prop)) + '</option>'; }).join('');
        if ([].some.call(refine.options, function (option) { return option.value === oldRefine; })) refine.value = oldRefine;
        var regionGroups = Object.create(null);
        regionPropertiesForPart(part).forEach(function (prop) { var label = propName(prop); (regionGroups[label] || (regionGroups[label] = [])).push(prop); });
        region.innerHTML = '<option value="all">不限附加</option><option value="attached">任意地区附加</option>' + Object.keys(regionGroups).sort(function (a, b) { return a.localeCompare(b, 'zh'); }).map(function (label) { return '<option value="' + escapeHtml(regionGroups[label].join(',')) + '">' + escapeHtml(label) + '</option>'; }).join('');
        if ([].some.call(region.options, function (option) { return option.value === oldRegion; })) region.value = oldRegion;
    }
    function switchPlannerTool(tool, updateUrl) {
        var selected = ['fixed', 'allocation', 'target'].indexOf(tool) >= 0 ? tool : 'fixed';
        document.querySelectorAll('[data-planner-tool]').forEach(function (button) { var active = button.dataset.plannerTool === selected; button.classList.toggle('is-active', active); button.setAttribute('aria-selected', active ? 'true' : 'false'); });
        document.querySelectorAll('[data-planner-view]').forEach(function (view) { view.hidden = view.dataset.plannerView !== selected; });
        if (updateUrl && window.history && typeof window.history.replaceState === 'function') {
            var url = new URL(window.location.href); url.searchParams.set('tool', selected); window.history.replaceState(null, '', url);
        }
    }
    function loadSharedSave() {
        var shared = typeof loadShareStore === 'function' ? loadShareStore() : null; saveData = shared && shared.data || null;
        var ready = !!extractMakeRnd(saveData); ['btnPlan', 'btnAllocationPlan', 'btnTargetPlan'].forEach(function (id) { $(id).disabled = !ready; });
        $('planMessage').textContent = ready ? '已读取打造状态，可开始规划。' : '当前没有可用的打造状态，请先在首页或其他功能页导入存档。';
        $('allocationMessage').textContent = ready ? '已读取打造状态，可开始计算资源分配。' : '当前没有可用的打造状态，请先导入存档。';
        $('targetMessage').textContent = ready ? '已读取打造状态，选择目标后开始追踪。' : '当前没有可用的打造状态，请先导入存档。';
    }
    function init() {
        PART_ORDER.forEach(function (part) { var option = document.createElement('option'); option.value = String(part); option.textContent = PART_NAMES[part]; $('partFilter').appendChild(option); $('targetPart').appendChild(option.cloneNode(true)); });
        fillTargetOptions();
        document.querySelector('.planner-tool-tabs').addEventListener('click', function (event) { var button = event.target.closest('[data-planner-tool]'); if (button) switchPlannerTool(button.dataset.plannerTool, true); });
        $('btnPlan').addEventListener('click', runPlanner); $('btnCancel').addEventListener('click', function () { cancelRequested = true; $('btnCancel').disabled = true; }); $('partFilter').addEventListener('change', renderResults); $('attachOnly').addEventListener('change', renderResults);
        $('btnAllocationPlan').addEventListener('click', runAllocation); $('btnAllocationCancel').addEventListener('click', function () { allocationCancelRequested = true; $('btnAllocationCancel').disabled = true; });
        $('btnTargetPlan').addEventListener('click', runTarget); $('btnTargetCancel').addEventListener('click', function () { targetCancelRequested = true; $('btnTargetCancel').disabled = true; }); $('targetPart').addEventListener('change', fillTargetOptions);
        loadSharedSave();
        switchPlannerTool(new URLSearchParams(window.location.search).get('tool') || 'fixed', false);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true}); else init();
})();
