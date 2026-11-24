(function () {
    'use strict';

    var BONE_ID = 3065;
    var TIGER_MEAT_NAME = '虎肉';
    var EXACT_TARGET_LIMIT = 20;
    var ROLLING_CHUNK_SIZE = 10;
    var SEARCH_LIMIT = 120000;
    var saveState = null;

    function $(id) { return document.getElementById(id); }
    function root(data) { return Array.isArray(data) ? data[0] : data; }
    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
            return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch];
        });
    }
    function integer(value, fallback) {
        var number = Number(value);
        return Number.isFinite(number) ? Math.trunc(number) : fallback;
    }
    function findNumber(source, key, depth, seen) {
        if (!source || typeof source !== 'object' || depth > 8 || seen.indexOf(source) >= 0) return null;
        seen.push(source);
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            var value = Number(source[key]);
            if (Number.isFinite(value)) return Math.trunc(value);
        }
        var keys = Object.keys(source);
        for (var index = 0; index < keys.length; index += 1) {
            var found = findNumber(source[keys[index]], key, depth + 1, seen);
            if (found != null) return found;
        }
        return null;
    }
    function readValue(source, key, fallback) {
        var value = findNumber(source, key, 0, []);
        return value == null ? fallback : value;
    }
    function extractState(data) {
        var source = root(data);
        var sds = source && source.Rnds && source.Rnds.Sds;
        if (!sds || sds.seed_32601 == null || sds.seed_32600 == null) return null;
        var seeds = {
            seed_32601: integer(sds.seed_32601, 0),
            seed_32600: integer(sds.seed_32600, 0)
        };
        if (sds.seed_hssbz_tiger != null) seeds.seed_hssbz_tiger = integer(sds.seed_hssbz_tiger, 0);
        return {
            seeds: seeds,
            values: {
                no_drop_3065: readValue(source, 'no_drop_3065', 0),
                hss_bz_cf: readValue(source, 'hss_bz_cf', 0),
                read_2442: readValue(source, 'read_2442', 0),
                '2443_tiger': readValue(source, '2443_tiger', 0)
            }
        };
    }
    function itemQuantity(items, predicate) {
        return (items || []).reduce(function (total, item) {
            return total + (predicate(item) ? Math.max(1, integer(item.quantity, 1)) : 0);
        }, 0);
    }
    function compareNodes(left, right) {
        if (left.estimate !== right.estimate) return left.estimate - right.estimate;
        if (left.tigerUses !== right.tigerUses) return left.tigerUses - right.tigerUses;
        if (left.steps !== right.steps) return left.steps - right.steps;
        return right.bones - left.bones;
    }
    function MinHeap() { this.items = []; }
    MinHeap.prototype.push = function (value) {
        var items = this.items;
        var index = items.push(value) - 1;
        while (index > 0) {
            var parent = Math.floor((index - 1) / 2);
            if (compareNodes(items[parent], value) <= 0) break;
            items[index] = items[parent];
            index = parent;
        }
        items[index] = value;
    };
    MinHeap.prototype.pop = function () {
        var items = this.items;
        if (!items.length) return null;
        var first = items[0];
        var last = items.pop();
        if (items.length) {
            var index = 0;
            while (true) {
                var left = index * 2 + 1;
                var right = left + 1;
                if (left >= items.length) break;
                var child = right < items.length && compareNodes(items[right], items[left]) < 0 ? right : left;
                if (compareNodes(items[child], last) >= 0) break;
                items[index] = items[child];
                index = child;
            }
            items[index] = last;
        }
        return first;
    };
    function stateKey(node) {
        var seeds = node.seeds || {};
        var values = node.values || {};
        return [seeds.seed_32601, seeds.seed_32600, seeds.seed_hssbz_tiger || 0,
            values.no_drop_3065 || 0, values.hss_bz_cf || 0, values.read_2442 || 0,
            values['2443_tiger'] || 0, node.bones].join(':');
    }
    async function previewOne(node, bait) {
        var response = await HomesteadEngine.wildPreview({
            target: 'tiger',
            bait: bait,
            count: 1,
            seeds: node.seeds,
            values: node.values
        });
        if (!response || response.ok === false) throw new Error(response && response.error || '虎骨引擎返回错误');
        var value = response.value != null ? response.value : response;
        var run = value.runs && value.runs[0];
        if (!run) throw new Error('虎骨引擎没有返回本次投喂结果');
        return { value: value, run: run };
    }
    async function findRoute(target, initialState, progressLabel) {
        var heap = new MinHeap();
        var seen = Object.create(null);
        var start = {
            seeds: initialState.seeds,
            values: initialState.values,
            bones: 0,
            steps: 0,
            tigerUses: 0,
            estimate: target,
            parent: null,
            bait: '',
            run: null
        };
        heap.push(start);
        seen[stateKey(start)] = { steps: 0, tigerUses: 0 };
        var explored = 0;
        while (heap.items.length) {
            var node = heap.pop();
            if (node.bones >= target) return { goal: node, explored: explored };
            if (++explored > SEARCH_LIMIT) throw new Error('目标路线分支过多，请降低目标虎骨数后重试');
            var baits = ['raw_meat', 'tiger_meat'];
            for (var index = 0; index < baits.length; index += 1) {
                var bait = baits[index];
                var outcome = await previewOne(node, bait);
                var gained = itemQuantity(outcome.run.items, function (item) { return Number(item.id) === BONE_ID; });
                var child = {
                    seeds: outcome.value.nextSeeds,
                    values: outcome.value.nextValues,
                    bones: node.bones + gained,
                    steps: node.steps + 1,
                    tigerUses: node.tigerUses + (bait === 'tiger_meat' ? 1 : 0),
                    parent: node,
                    bait: bait,
                    run: outcome.run
                };
                child.estimate = child.steps + Math.max(0, target - child.bones);
                var key = stateKey(child);
                var previous = seen[key];
                if (previous && (previous.steps < child.steps
                    || (previous.steps === child.steps && previous.tigerUses <= child.tigerUses))) continue;
                seen[key] = { steps: child.steps, tigerUses: child.tigerUses };
                heap.push(child);
            }
            if (explored % 120 === 0) {
                $('searchMessage').textContent = (progressLabel || '正在比较混合路线') + '，已检查 ' + explored.toLocaleString() + ' 个状态…';
                await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
            }
        }
        throw new Error('没有找到可执行的虎骨路线');
    }
    async function buildRoute(target) {
        if (target <= EXACT_TARGET_LIMIT) {
            var exact = await findRoute(target, saveState, '正在比较完整混合路线');
            return { route: reconstruct(exact.goal), explored: exact.explored, exact: true };
        }
        var state = { seeds: saveState.seeds, values: saveState.values };
        var route = [];
        var explored = 0;
        var completed = 0;
        while (completed < target) {
            var chunkTarget = Math.min(ROLLING_CHUNK_SIZE, target - completed);
            var label = '正在优化第 ' + (completed + 1) + '-' + (completed + chunkTarget) + ' 个虎骨';
            var result = await findRoute(chunkTarget, state, label);
            var chunk = reconstruct(result.goal);
            route = route.concat(chunk);
            explored += result.explored;
            completed += result.goal.bones;
            state = { seeds: result.goal.seeds, values: result.goal.values };
            $('searchMessage').textContent = '已完成 ' + completed + ' / ' + target + ' 个虎骨的分段优化…';
            await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
        }
        return { route: route, explored: explored, exact: false };
    }
    function reconstruct(goal) {
        var route = [];
        var node = goal;
        while (node && node.parent) {
            route.push(node);
            node = node.parent;
        }
        return route.reverse();
    }
    function routeOverview(route) {
        var groups = [];
        route.forEach(function (node) {
            var label = node.bait === 'tiger_meat' ? '虎肉' : '普通生肉';
            var last = groups[groups.length - 1];
            if (last && last.label === label) last.count += 1;
            else groups.push({ label: label, count: 1 });
        });
        return groups.map(function (group) { return group.label + ' ×' + group.count; }).join(' → ');
    }
    function render(route, target, explored, exact) {
        var normalUses = route.filter(function (node) { return node.bait === 'raw_meat'; }).length;
        var tigerUses = route.length - normalUses;
        var tigerMeatDrops = 0;
        route.forEach(function (node) {
            tigerMeatDrops += itemQuantity(node.run.items, function (item) { return item && item.name === TIGER_MEAT_NAME; });
        });
        var summaries = [
            ['路线模式', exact ? '全局最优' : '分段推荐'],
            ['目标虎骨', target + ' 个'],
            ['总投喂', route.length + ' 次'],
            ['普通生肉', normalUses + ' 个'],
            ['虎肉', tigerUses + ' 个'],
            ['途中虎肉掉落', tigerMeatDrops + ' 个']
        ];
        $('summaryGrid').innerHTML = summaries.map(function (entry) {
            return '<div class="summary-item"><span>' + escapeHtml(entry[0]) + '</span><strong>' + escapeHtml(entry[1]) + '</strong></div>';
        }).join('');
        $('routeOverview').textContent = routeOverview(route);
        var cumulative = 0;
        $('resultList').innerHTML = route.map(function (node, index) {
            var run = node.run;
            var gained = itemQuantity(run.items, function (item) { return Number(item.id) === BONE_ID; });
            cumulative += gained;
            var items = (run.items || []).map(function (item) {
                return '<span class="drop-token' + (Number(item.id) === BONE_ID ? ' is-bone' : '') + '">' +
                    escapeHtml(item.name || ('物品 ' + item.id)) + (Number(item.quantity) > 1 ? ' ×' + Number(item.quantity) : '') + '</span>';
            }).join('') || '<span class="drop-token is-empty">无掉落</span>';
            var encounter = run.encounter || {};
            var audit = run.audit || {};
            return '<article class="result-card">' +
                '<div class="result-index"><strong>第 ' + (index + 1) + ' 次</strong><span>' +
                (node.bait === 'tiger_meat' ? '虎肉' : '普通生肉') + '</span></div>' +
                '<div class="encounter"><strong>' + escapeHtml(encounter.tiger || '猛虎') + '</strong><span>' +
                (encounter.enraged ? '激怒' : '普通') + ' · 虎骨保底计数 ' + integer(audit.boneMissesBefore, 0) + ' → ' + integer(audit.boneMissesAfter, 0) + '</span></div>' +
                '<div class="drop-items">' + items + '</div>' +
                '<div class="bone-total">累计 <strong>' + cumulative + '</strong> 个虎骨</div>' +
                '</article>';
        }).join('');
        $('resultTitle').textContent = exact ? '最省投喂路线' : '推荐省肉路线';
        $('resultMeta').textContent = (exact ? '全局最优 · ' : '分段优化 · ') + '已检查 ' + explored.toLocaleString() + ' 个状态';
        $('resultEmpty').hidden = true;
        $('resultContent').hidden = false;
        $('searchMessage').textContent = exact
            ? '已找到总投喂次数最少、同长度下虎肉用量最少的路线。'
            : '已生成掉落准确的分段省肉路线；该路线不代表200个虎骨目标下的全局最优。';
    }
    async function search() {
        if (!saveState) {
            $('searchMessage').textContent = '当前存档缺少衡山诱虎随机状态，请先在首页导入有效存档。';
            return;
        }
        var input = $('targetBones');
        var target = Math.max(1, Math.min(200, integer(input.value, 5)));
        input.value = target;
        var button = $('btnSearch');
        button.disabled = true;
        button.textContent = '推演中…';
        $('resultContent').hidden = true;
        $('resultEmpty').hidden = false;
        $('resultEmpty').textContent = '正在搜索最省投喂路线…';
        $('resultMeta').textContent = '计算中';
        $('searchMessage').textContent = '正在读取普通生肉与虎肉的混合分支…';
        try {
            await HomesteadEngine.ensure();
            var result = await buildRoute(target);
            render(result.route, target, result.explored, result.exact);
        } catch (error) {
            console.error('[虎骨掉落]', error);
            $('resultMeta').textContent = '推演失败';
            $('resultEmpty').hidden = false;
            $('resultEmpty').textContent = error && error.message ? error.message : String(error);
            $('searchMessage').textContent = '未能生成路线，请检查存档状态或降低目标数量。';
        } finally {
            button.disabled = false;
            button.textContent = '开始推演';
        }
    }
    async function init() {
        var shared = typeof loadShareStore === 'function' ? loadShareStore() : null;
        var data = shared && shared.data;
        if (typeof renderArchiveState === 'function') renderArchiveState(data);
        saveState = extractState(data);
        $('seedStatus').textContent = saveState ? '可精确推演' : '缺少诱虎种子';
        $('btnSearch').disabled = !saveState;
        $('btnSearch').addEventListener('click', search);
        $('targetBones').addEventListener('keydown', function (event) {
            if (event.key === 'Enter') search();
        });
        document.querySelectorAll('header a[href*=".html"]').forEach(function (link) {
            link.addEventListener('click', function () { if (typeof markNavTransition === 'function') markNavTransition(); });
        });
        try { await HomesteadEngine.ensure(); } catch (error) {
            $('seedStatus').textContent = '引擎加载失败';
            $('btnSearch').disabled = true;
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
