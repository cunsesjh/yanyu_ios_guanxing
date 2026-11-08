/* Dedicated runtime: does not install or replace any legacy page/worker globals. */
'use strict';
self.window = self;
function searchCapsForBudget(budget) {
    const ceiling = Math.max(0, Math.trunc(Number(budget) || 0));
    return [...new Set([Math.min(2000, ceiling), Math.min(3500, ceiling), ceiling])];
}
self.AutoWash2SearchPolicy = Object.freeze({capsForBudget: searchCapsForBudget});
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
        // The planner first searches useful lower-cost bands, then spends the
        // remaining budget comparing routes below the user's current best.
        const searchStarted = Date.now();
        const totalSearchMs = 180000;
        const userBudget = Math.max(0, Math.trunc(Number(input.options?.maxTotalPills ?? 5000)));
        const caps = searchCapsForBudget(userBudget);
        const stageDeadlines = caps.length === 1 ? [totalSearchMs]
            : caps.length === 2 ? [45000, totalSearchMs]
            : [30000, 75000, totalSearchMs];
        for (let stage = 0; stage < caps.length; stage++) {
            const stageCap = caps[stage];
            const stageDeadline = searchStarted + stageDeadlines[stage];
            send('progress', {progress: {message: `分阶段搜索：耗丹上限 ${stageCap.toLocaleString()}，共 ${caps.length} 阶段`}});
            for (let branch = 0; branch < branches.length; branch++) {
                const now = Date.now();
                if (now >= stageDeadline || now - searchStarted >= totalSearchMs) { limited = true; break; }
                const branchesLeft = branches.length - branch;
                const branchDeadline = Math.min(stageDeadline, now + (stageDeadline - now) / branchesLeft);
                const progress = value => send('progress', {progress: {...value,
                    message: `耗丹 ≤${stageCap} · 目标组合 ${branch + 1}/${branches.length} · ${value?.message || '正在搜索'}`}});
                const bestBefore = combined().routes[0]?.totalPills;
                const ceiling = Math.min(stageCap, bestBefore == null ? stageCap : Math.max(0, bestBefore - 1));
                if (bestBefore === 0) break;
                const tacticalDeadline = now + Math.max(1, (branchDeadline - now) * 0.4);
                const result = await AutoWash2Optimizer.searchWashRoutes({
                    ...input, talentData: TALENT_DATA, targetIds: branches[branch],
                    options: {...input.options, maxTotalPills: ceiling},
                    onProgress: progress, onCandidate: collect,
                    shouldCancel: () => Date.now() >= tacticalDeadline || Date.now() >= stageDeadline
                        || Date.now() - searchStarted >= totalSearchMs,
                });
                limited ||= !!result.cancelled || !!result.searchScope?.safetyLimitReached;
                collect(result);
                if (Date.now() >= branchDeadline || Date.now() - searchStarted >= totalSearchMs) {
                    limited = true;
                    continue;
                }
                const bestAfterTactical = combined().routes[0]?.totalPills;
                const anchorCeiling = Math.min(ceiling,
                    bestAfterTactical == null ? ceiling : Math.max(0, bestAfterTactical - 1));
                if (anchorCeiling === 0 && bestAfterTactical != null) continue;
                const anchorInput = {...input, options: {...input.options, maxTotalPills: anchorCeiling}};
                limited = !!AutoWash2Anchor.search(anchorInput, branches[branch], collect, progress,
                    () => Date.now() >= branchDeadline || Date.now() >= stageDeadline
                        || Date.now() - searchStarted >= totalSearchMs) || limited;
            }
            if (Date.now() - searchStarted >= totalSearchMs) { limited = true; break; }
        }
        send('result', {result: {...combined(), limited}});
    } catch (error) {
        send('error', {error: error?.message || String(error)});
    }
};
