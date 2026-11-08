/* Dedicated runtime: does not install or replace any legacy page/worker globals. */
'use strict';
self.window = self;
importScripts('data.js', 'wash_source_engine.js', 'auto_wash2_source_cache.js', 'auto_wash2_engine.js', 'auto_wash2_optimizer.js', 'auto_wash2_model.js');
importScripts('anchor_route_planner.js', 'anchor_route_search.js', 'auto_wash2_anchor.js');
self.onmessage = async ({data: message}) => {
    const send = (type, payload) => self.postMessage({type, requestId: message.requestId, ...payload});
    try {
        if (message.type === 'inspect') {
            const engine = new AutoWash2Engine.Engine(TALENT_DATA, message.raw);
            const summary = {allowed: [...engine.allowed], purpleIds: engine.purpleIds};
            send('summary', {summary});
            return;
        }
        if (message.type !== 'search') return;
        // The local optimizer accepts concrete target sets. Expand compatible groups here,
        // keeping every branch on the same immutable save snapshot.
        const input = message.input, branches = AutoWash2Model.combinations(input);
        const found = new Map();
        const combined = () => ({routes: [...found.values()].sort((a, b) => a.totalPills - b.totalPills || a.totalWashes - b.totalWashes),
            noResultReason: '本轮搜索在耗丹上限及内核搜索范围内未找到路线，可调整目标或增加上限。'});
        function collect(result) {
            for (const route of result?.routes || []) {
                const key = JSON.stringify([route.finalState, route.steps]);
                found.set(key, route);
            }
            // Keep result transfer/rendering bounded; retain the lowest-cost candidates.
            if (found.size > 20) {
                const best = combined().routes.slice(0, 20); found.clear();
                for (const route of best) found.set(JSON.stringify([route.finalState, route.steps]), route);
            }
            if (found.size) send('candidate', {result: combined()});
        }
        let limited = false;
        const searchStarted = Date.now();
        for (let branch = 0; branch < branches.length; branch++) {
            if (Date.now() - searchStarted > 60000) { limited = true; break; }
            const progress = value => send('progress', {progress: {...value,
                message: `目标组合 ${branch + 1}/${branches.length} · ${value?.message || '正在搜索'}`}});
            const tacticalStarted = Date.now();
            const result = await AutoWash2Optimizer.searchWashRoutes({
                ...input, talentData: TALENT_DATA, targetIds: branches[branch],
                onProgress: progress, onCandidate: collect,
                shouldCancel: () => Date.now() - tacticalStarted > 20000 || Date.now() - searchStarted > 60000,
            });
            limited ||= !!result.cancelled || !!result.searchScope?.safetyLimitReached;
            collect(result);
            const started = Date.now();
            const bestCost = combined().routes[0]?.totalPills;
            const anchorInput = {...input, options: {...input.options,
                maxTotalPills: Math.min(Number(input.options?.maxTotalPills ?? 10000), bestCost ?? Infinity)}};
            limited = !!AutoWash2Anchor.search(anchorInput, branches[branch], collect, progress,
                () => Date.now() - started > 40000 || Date.now() - searchStarted > 60000) || limited;
        }
        send('result', {result: {...combined(), limited}});
    } catch (error) {
        send('error', {error: error?.message || String(error)});
    }
};
