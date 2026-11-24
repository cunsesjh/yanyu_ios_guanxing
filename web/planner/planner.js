(function () {
    'use strict';

    var PAPER_IDS = [2581, 2584, 2580, 3461, 3439, 3449, 3460, 2586, 2585,
        2587, 2583, 2582, 3458, 3454, 3429, 3456, 3409, 3419];
    var PART_NAMES = {1: '拳套', 2: '刀', 3: '剑', 4: '枪棍', 5: '腰带', 6: '护腕', 7: '内甲', 8: '戒指', 9: '挂坠'};
    var PART_ORDER = Object.keys(PART_NAMES).map(Number);
    var results = [];
    var resultIndexes = Object.create(null);
    var saveData = null;
    var cancelRequested = false;

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
        var percentProps = ['dmg_off', 'dmg_ref', 'def_ign', 'atk_extend', 'sword_add', 'unarmed_add', 'blade_add', 'stick_add', 'blood', 'renxing', 'po_parry', 'po_dodge'];
        if (percentProps.indexOf(prop) >= 0) return (number(value, 0) * 100).toFixed(1).replace(/\.0$/, '') + '%';
        return Math.round(number(value, 0) * 10) / 10;
    }
    function refinementTotal(refinement) {
        var maxima = refinement && refinement.maxima || {};
        return [1, 2, 3].reduce(function (sum, slot) { return sum + number(maxima[slot] && maxima[slot].value, 0); }, 0);
    }
    function refinementCost(refinement) { return number(refinement && refinement.plan && refinement.plan.cost && refinement.plan.cost.lianjin, 0); }
    function regionBonusItem(item) {
        var prop = item && item.prop;
        var value = Math.max(0, number(item && item.value, 0));
        var weights = {
            dmg_off: 1250, dmg_ref: 1000,
            atk: 0.2, atk_add: 0.2,
            str: 1.25, con: 1.25, dex: 1.25, int: 1.25,
            mp_f: 2, mp_back: 5,
            def: 0.04, def_add: 0.04,
            hp: 0.03, hp_add: 0.03,
            hit: 0.1, hit_add: 0.1,
            speed: 0.08, speed_add: 0.08,
            dodge: 0.06, dodge_add: 0.06,
            parry: 0.06, parry_add: 0.06
        };
        return value * number(weights[prop], 0);
    }
    function regionBonus(region) {
        return Math.min(30, (region || []).reduce(function (sum, item) { return sum + regionBonusItem(item); }, 0));
    }
    function bestWithinBudget(candidate, budget) {
        var upgradeMud = candidate.upgraded ? 10 : 0;
        var reference = candidate.refinementRatingReference || {};
        return (candidate.refinements || []).reduce(function (best, refinement) {
            var mud = upgradeMud + refinementCost(refinement);
            var maximum = number(reference[refinement.prop], 0);
            var baseScore = maximum > 0 ? Math.min(100, refinementTotal(refinement) / maximum * 100) : 0;
            var option = {refinement: refinement, mud: mud, baseScore: baseScore};
            if (mud > budget) return best;
            if (!best || option.baseScore > best.baseScore || (option.baseScore === best.baseScore && option.mud < best.mud)) return option;
            return best;
        }, null);
    }
    function scoreCandidate(candidate, budget) {
        var best = bestWithinBudget(candidate, budget);
        if (!best) return null;
        var bonus = regionBonus(candidate.region);
        var finalScore = Math.min(100, best.baseScore + bonus);
        if (finalScore < 91) return null;
        var config = EQUIP_DATA.equipment[String(candidate.equipId)] || {};
        return {
            id: candidate.id,
            part: number(config.type, 0),
            equipName: candidate.equipName,
            paperName: candidate.paperName,
            location: candidate.location,
            craftIndex: number(candidate.craftIndex, 0),
            region: candidate.region || [],
            refinement: best.refinement,
            mud: best.mud,
            silver: number(candidate.craftCost && candidate.craftCost.silver, 0)
                + number(candidate.upgradeCost && candidate.upgradeCost.silver, 0)
                + number(best.refinement.plan && best.refinement.plan.cost && best.refinement.plan.cost.silver, 0),
            baseScore: best.baseScore,
            bonus: bonus,
            finalScore: finalScore,
            grade: finalScore >= 96 ? '神器' : '极品'
        };
    }
    function resultKey(item, candidate) {
        var region = (item.region || []).map(function (entry) { return entry.prop + ':' + entry.value; }).sort().join('|');
        return [item.part, candidate.equipId, candidate.S, candidate.CZSeed, item.refinement.prop,
            refinementTotal(item.refinement), item.mud, region].join('::');
    }
    function addResult(candidate, budget) {
        var scored = scoreCandidate(candidate, budget);
        if (!scored) return;
        var key = resultKey(scored, candidate);
        var existingIndex = resultIndexes[key];
        if (existingIndex == null) {
            resultIndexes[key] = results.length;
            results.push(scored);
        } else if (scored.silver < results[existingIndex].silver) {
            results[existingIndex] = scored;
        }
    }
    function compareResults(a, b) {
        return b.finalScore - a.finalScore || b.bonus - a.bonus || a.mud - b.mud || a.craftIndex - b.craftIndex || a.location.localeCompare(b.location, 'zh');
    }
    function dedupeCraftsmen(craftsmen) {
        var seen = Object.create(null);
        return craftsmen.filter(function (craftsman) {
            var signature = craftsman.zhi + ':' + JSON.stringify(craftsman.tx || null) + ':' + JSON.stringify(craftsman.tx2 || null);
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
        var craftsmen = dedupeCraftsmen(EquipmentAutoOptimizer.sortedCraftsmen(EQUIP_DATA));
        var branches = [];
        craftsmen.forEach(function (craftsman) {
            papers.forEach(function (paper) {
                var available = EquipmentAutoOptimizer.papersForCraftsman(EQUIP_DATA, craftsman.id).some(function (entry) {
                    return Number(entry.paper.id) === Number(paper.id);
                });
                if (available) branches.push({npcId: craftsman.id, paperId: paper.id, specialId: 0});
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
    function setProgress(done, total, text) {
        var percent = total ? Math.round(done / total * 100) : 0;
        $('planProgress').hidden = false;
        $('progressText').textContent = text;
        $('progressPercent').textContent = percent + '%';
        $('progressFill').style.width = percent + '%';
    }
    function bridge() {
        return {
            getMakeState: function () { return window.wasmMakeGetState(); },
            setMakeState: function (next) { if (!window.wasmMakeSetState(next)) throw new Error('打造状态恢复失败'); return true; },
            makePreview: function (request, count) { return window.wasmMakePreview(request, count); },
            xilianPlan: function (equip, accepts) { return window.wasmXilianPlan(equip, accepts); }
        };
    }
    async function runPlanner() {
        var makeRnd = extractMakeRnd(saveData);
        if (!makeRnd) { $('planMessage').textContent = '当前存档缺少 MakeRnd 打造状态。'; return; }
        var mudBudget = integer($('mudBudget').value, 10, 1000, 200);
        var craftCount = integer($('craftCount').value, 1, 500, 100);
        $('mudBudget').value = mudBudget;
        $('craftCount').value = craftCount;
        results = [];
        resultIndexes = Object.create(null);
        cancelRequested = false;
        $('btnPlan').disabled = true;
        $('btnCancel').hidden = false;
        $('btnCancel').disabled = false;
        $('resultEmpty').hidden = false;
        $('resultEmpty').textContent = '正在按部位推演打造与精炼结果...';
        $('resultGroups').replaceChildren();
        try {
            await window.WasmAlgorithmAPI.ready;
            window.wasmMakeSetState(makeRnd);
            var tasks = [];
            PART_ORDER.forEach(function (part) {
                branchesForPart(part).forEach(function (branch) { tasks.push({part: part, branch: branch}); });
            });
            var lastPart = 0;
            for (var index = 0; index < tasks.length; index += 1) {
                if (cancelRequested) break;
                var task = tasks[index];
                var part = task.part;
                setProgress(index, tasks.length, '正在计算' + PART_NAMES[part] + ' · 路线 ' + (index + 1) + '/' + tasks.length);
                await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
                var simulated = await EquipmentAutoOptimizer.simulateEquipmentRoutes({
                    data: EQUIP_DATA,
                    initialMakeState: makeRnd,
                    branches: [task.branch],
                    targetProps: propertyTargetsForPart(part),
                    options: {
                        craftCount: craftCount,
                        refineCount: Math.min(1000, mudBudget),
                        attachCount: 1,
                        maxCraftWork: 500000,
                        maxRefineWork: 10000000,
                        resultLimit: 100
                    },
                    bridge: bridge()
                });
                (simulated.candidates || []).forEach(function (candidate) { addResult(candidate, mudBudget); });
                if (lastPart && lastPart !== part) renderResults();
                lastPart = part;
            }
            renderResults();
            setProgress(cancelRequested ? Math.min(tasks.length, index) : tasks.length, tasks.length, cancelRequested ? '已停止' : '规划完成');
            $('planMessage').textContent = cancelRequested ? '已停止后续部位计算，当前结果仍可筛选。' : '规划完成。结果均为预算内可执行方案。';
        } catch (error) {
            console.error('装备规划失败:', error);
            $('planMessage').textContent = '装备规划失败：' + (error && error.message || error);
        } finally {
            window.wasmMakeSetState(makeRnd);
            $('btnPlan').disabled = false;
            $('btnCancel').hidden = true;
        }
    }
    function score(value) { return number(value, 0).toFixed(1).replace(/\.0$/, ''); }
    function silver(value) { return Math.round(number(value, 0)).toLocaleString(); }
    function cardHtml(item) {
        var region = item.region.length ? item.region.map(function (prop) {
            return '<span>' + escapeHtml(propName(prop.prop)) + ' +' + escapeHtml(formatProp(prop.prop, prop.value)) + '</span>';
        }).join('') : '<span>无地区附加</span>';
        var refinement = item.refinement;
        var refineText = escapeHtml(propName(refinement.prop)) + ' ' + escapeHtml(formatProp(refinement.prop, refinementTotal(refinement)));
        var artifact = item.grade === '神器';
        return '<article class="planner-card ' + (artifact ? 'is-artifact' : 'is-premium') + '">' +
            '<header class="planner-card-head"><div><h4>' + escapeHtml(item.equipName) + '</h4><p>' + escapeHtml(item.paperName) + ' · ' + escapeHtml(item.location) + ' · 第' + item.craftIndex + '件</p></div>' +
            '<span class="planner-grade"><b>' + item.grade + '</b><strong>' + score(item.finalScore) + '</strong></span></header>' +
            '<div class="planner-score-grid"><span>精炼基础<strong>' + score(item.baseScore) + '</strong></span><span>地区附加<strong>+' + score(item.bonus) + '</strong></span><span>最终评分<strong>' + score(item.finalScore) + '</strong></span></div>' +
            '<div class="planner-props"><span>最佳精炼 ' + refineText + '</span>' + region + '</div>' +
            '<footer class="planner-card-foot"><span>实际泥耗 <strong>' + item.mud.toLocaleString() + '</strong></span><span>累计银两 <strong>' + silver(item.silver) + '</strong></span></footer></article>';
    }
    function renderResults() {
        var filter = $('partFilter').value;
        var attachOnly = $('attachOnly').checked;
        var visibleParts = filter === 'all' ? PART_ORDER : [Number(filter)];
        var html = [];
        var shown = 0;
        visibleParts.forEach(function (part) {
            var partResults = results.filter(function (item) { return item.part === part && (!attachOnly || item.region.length); }).sort(compareResults);
            var total = partResults.length;
            if (!partResults.length) return;
            shown += partResults.length;
            html.push('<section class="planner-part-group"><div class="planner-part-title"><h3>' + PART_NAMES[part] + '</h3><span>符合 ' + total + ' 件</span></div><div class="planner-cards">' + partResults.map(cardHtml).join('') + '</div></section>');
        });
        $('resultGroups').innerHTML = html.join('');
        $('resultEmpty').hidden = shown > 0;
        if (!shown) $('resultEmpty').textContent = results.length ? '当前筛选条件下没有神器或极品。' : '当前已完成范围内没有达到神器或极品的装备。';
        $('resultMeta').textContent = results.length ? '共找到 ' + results.length + ' 件 · 当前展示 ' + shown + ' 件' : '尚无符合结果';
    }
    function loadSharedSave() {
        var shared = typeof loadShareStore === 'function' ? loadShareStore() : null;
        saveData = shared && shared.data || null;
        $('btnPlan').disabled = !extractMakeRnd(saveData);
        $('planMessage').textContent = extractMakeRnd(saveData)
            ? '已读取打造状态，可开始规划。'
            : '当前没有可用的打造状态，请先在首页或其他功能页导入存档。';
    }
    function init() {
        PART_ORDER.forEach(function (part) {
            var option = document.createElement('option');
            option.value = String(part);
            option.textContent = PART_NAMES[part];
            $('partFilter').appendChild(option);
        });
        $('btnPlan').addEventListener('click', runPlanner);
        $('btnCancel').addEventListener('click', function () { cancelRequested = true; $('btnCancel').disabled = true; });
        $('partFilter').addEventListener('change', renderResults);
        $('attachOnly').addEventListener('change', renderResults);
        loadSharedSave();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true});
    else init();
})();
