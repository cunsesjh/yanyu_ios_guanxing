/* Dedicated runtime: does not install or replace any legacy page/worker globals. */
'use strict';
self.window = self;
function initialSearchWindow(totalSearchMs = 300000) {
    return Math.min(120000, totalSearchMs * 0.4);
}
self.AutoWash2SearchPolicy = Object.freeze({initialSearchWindow});
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
        // First obtain a verified route. As soon as one is found, recompute the
        // remaining schedule around the current best cost instead of waiting
        // for a fixed feasibility phase to expire.
        const searchStarted = Date.now();
        const requestedSearchMs = Number(message.searchTimeMs);
        const totalSearchMs = Number.isFinite(requestedSearchMs)
            ? Math.max(100, Math.min(300000, requestedSearchMs)) : 300000;
        const totalDeadline = searchStarted + totalSearchMs;
        const userBudget = Math.max(0, Math.trunc(Number(input.options?.maxTotalPills ?? 5000)));
        async function runPass(stageCap, stageDeadline, purpose, stopWhenFound = false,
                stopWhenImproved = false, searchIntensity = 1) {
            const startingBest = combined().routes[0]?.totalPills ?? null;
            send('progress', {progress: {message: `${purpose}：耗丹上限 ${stageCap.toLocaleString()}`}});
            for (let branch = 0; branch < branches.length; branch++) {
                const now = Date.now();
                if (now >= stageDeadline || now >= totalDeadline) { limited = true; break; }
                const branchesLeft = branches.length - branch;
                const branchDeadline = Math.min(stageDeadline, now + (stageDeadline - now) / branchesLeft);
                const progress = value => send('progress', {progress: {...value,
                    message: `耗丹 ≤${stageCap} · 目标组合 ${branch + 1}/${branches.length} · ${value?.message || '正在搜索'}`}});
                const bestBefore = combined().routes[0]?.totalPills;
                const ceiling = Math.min(stageCap, bestBefore == null ? stageCap : Math.max(0, bestBefore - 1));
                if (bestBefore === 0) break;
                const waitingForFirst = stopWhenFound && bestBefore == null;
                const improvedBefore = startingBest != null && bestBefore < startingBest;
                if (stopWhenImproved && improvedBefore) return true;
                const tacticalDeadline = now + Math.max(1, (branchDeadline - now) * 0.4);
                const result = await AutoWash2Optimizer.searchWashRoutes({
                    ...input, talentData: TALENT_DATA, targetIds: branches[branch],
                    options: {...input.options, maxTotalPills: ceiling, searchIntensity},
                    onProgress: progress, onCandidate: collect,
                    shouldCancel: () => Date.now() >= tacticalDeadline || Date.now() >= stageDeadline
                        || Date.now() >= totalDeadline || (waitingForFirst && found.size > 0)
                        || (stopWhenImproved && startingBest != null
                            && (combined().routes[0]?.totalPills ?? Infinity) < startingBest),
                });
                collect(result);
                const foundFirstTactical = waitingForFirst && found.size > 0;
                const improvedTactical = stopWhenImproved && startingBest != null
                    && (combined().routes[0]?.totalPills ?? Infinity) < startingBest;
                limited ||= (!foundFirstTactical && !improvedTactical && !!result.cancelled)
                    || !!result.searchScope?.safetyLimitReached;
                if (foundFirstTactical) return true;
                if (improvedTactical) return true;
                if (Date.now() >= branchDeadline || Date.now() >= totalDeadline) {
                    limited = true;
                    continue;
                }
                const bestAfterTactical = combined().routes[0]?.totalPills;
                const anchorCeiling = Math.min(ceiling,
                    bestAfterTactical == null ? ceiling : Math.max(0, bestAfterTactical - 1));
                if (anchorCeiling === 0 && bestAfterTactical != null) continue;
                const anchorInput = {...input, options: {...input.options,
                    maxTotalPills: anchorCeiling, searchIntensity}};
                const anchorLimited = !!AutoWash2Anchor.search(anchorInput, branches[branch], collect, progress,
                    () => Date.now() >= branchDeadline || Date.now() >= stageDeadline
                        || Date.now() >= totalDeadline || (waitingForFirst && found.size > 0)
                        || (stopWhenImproved && startingBest != null
                            && (combined().routes[0]?.totalPills ?? Infinity) < startingBest));
                const foundFirstAnchor = waitingForFirst && found.size > 0;
                const improvedAnchor = stopWhenImproved && startingBest != null
                    && (combined().routes[0]?.totalPills ?? Infinity) < startingBest;
                limited ||= !foundFirstAnchor && !improvedAnchor && anchorLimited;
                if (foundFirstAnchor) return true;
                if (improvedAnchor) return true;
            }
            return false;
        }

        // Give the first attempt up to two minutes. If it still finds nothing,
        // keep the full user ceiling for the remainder rather than spending
        // time "optimizing" a route that does not yet exist.
        await runPass(userBudget, Math.min(totalDeadline, searchStarted + initialSearchWindow(totalSearchMs)),
            '优先寻找可执行路线', true);
        let searchIntensity = 1;
        while (!found.size && Date.now() < totalDeadline && searchIntensity < 4) {
            searchIntensity += 1;
            await runPass(userBudget, totalDeadline,
                `扩大可执行路线搜索（强度 ${searchIntensity}/4）`, true, false, searchIntensity);
        }

        // Keep tightening to best - 1. Whenever a lower verified route is
        // found, stop that pass immediately and restart under the new bound.
        while (found.size && Date.now() < totalDeadline) {
            const best = combined().routes[0].totalPills;
            if (best <= 0) break;
            const improved = await runPass(best - 1, totalDeadline,
                `继续压低丹耗（当前最好 ${best.toLocaleString()} 丹）`,
                false, true, searchIntensity);
            if (!improved) break;
        }
        send('result', {result: {...combined(), limited}});
    } catch (error) {
        send('error', {error: error?.message || String(error)});
    }
};
