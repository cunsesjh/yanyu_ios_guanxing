/* Dedicated runtime: does not install or replace any legacy page/worker globals. */
'use strict';
self.window = self;
function initialSearchWindow(totalSearchMs = 600000) {
    return Math.min(120000, totalSearchMs * 0.4);
}
function searchTimeLimit(targetCount) {
    return Number(targetCount) === 4 ? 900000 : 600000;
}
const SEARCH_STAGES = Object.freeze([
    {fraction: 0.20, intensity: 1, label: '快速找路'},
    {fraction: 0.30, intensity: 2, label: '扩展种子与脉序'},
    {fraction: 0.30, intensity: 3, label: '扩大锚点与战术图'},
    {fraction: 0.20, intensity: 4, label: '全强度压低丹耗'},
]);
self.AutoWash2SearchPolicy = Object.freeze({initialSearchWindow, searchTimeLimit, stages: SEARCH_STAGES});
importScripts('data.js', 'wash_source_engine.js', 'auto_wash2_source_cache.js', 'auto_wash2_engine.js', 'auto_wash2_optimizer.js', 'auto_wash2_model.js');
importScripts('anchor_route_planner.js', 'anchor_route_search.js', 'auto_wash2_anchor.js');
importScripts('auto_wash2_seed_planner.js', 'auto_wash2_seed.js');
importScripts('auto_wash2_unified_anchor.js', 'auto_wash2_route_constructor.js',
    'auto_wash2_unified_route_constructor.js', 'auto_wash2_unified.js');
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
        // Four-target routes have a much larger combinatorial search space;
        // only those runs may use the additional five-minute allowance.
        const maxSearchMs = searchTimeLimit(branches[0]?.length || 0);
        const totalSearchMs = Number.isFinite(requestedSearchMs)
            ? Math.max(100, Math.min(maxSearchMs, requestedSearchMs)) : maxSearchMs;
        const totalDeadline = searchStarted + totalSearchMs;
        const userBudget = Math.max(0, Math.trunc(Number(input.options?.maxTotalPills ?? 5000)));
        const isInternational = WashSourceEngine.isInternationalChannel(
            input.initialState?.save_channel || input.initialState?.channel);
        const progressFor = (branch, stage, value) => send('progress', {progress: {...value,
            message: `阶段 ${stage.intensity}/4 · 目标组合 ${branch + 1}/${branches.length} · ${value.message}`}});
        function stageInput(ceiling) {
            return {...input, options: {...input.options, maxTotalPills: ceiling}};
        }
        function runSeedStage(stage, stageDeadline, engineFraction) {
            for (let branch = 0; branch < branches.length && Date.now() < stageDeadline; branch++) {
                const best = combined().routes[0]?.totalPills;
                if (best === 0) return;
                const ceiling = Math.min(userBudget, best == null ? userBudget : Math.max(0, best - 1));
                const branchesLeft = branches.length - branch;
                const branchWindow = Math.max(0, (stageDeadline - Date.now()) / branchesLeft * engineFraction);
                if (branchWindow < 250) return;
                const quickBudget = Math.max(250, branchWindow * 0.30);
                try {
                    AutoWash2Seed.search(stageInput(ceiling), branches[branch], collect,
                        value => progressFor(branch, stage, value),
                        {intensity: stage.intensity, timeBudgetMs: quickBudget});
                } catch (_) {
                    progressFor(branch, stage, {message: '欧气种子快搜未形成候选，转入统一构造'});
                }
                if (Date.now() >= stageDeadline) return;
                const unifiedBudget = Math.max(500, Math.min(stageDeadline - Date.now(), branchWindow * 0.70));
                // Unified construction has a few indivisible sequence scans.
                // Starting it with a tiny slice can overrun that stage and
                // starve stages 3/4; return the slice to tactical search.
                if (unifiedBudget < 8000) {
                    progressFor(branch, stage, {message: '本阶段剩余时间不足以启动统一构造，转入可中断搜索'});
                    continue;
                }
                try {
                    AutoWash2Unified.search(stageInput(ceiling), branches[branch], collect,
                        value => progressFor(branch, stage, value),
                        {intensity: stage.intensity, timeBudgetMs: unifiedBudget});
                } catch (_) {
                    progressFor(branch, stage, {message: '统一路线构造未形成候选，继续战术搜索'});
                }
            }
        }
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
                const anchorMinimumMs = 10000 + (searchIntensity - 1) * 5000;
                if (!isInternational && branchDeadline - Date.now() < anchorMinimumMs) {
                    progress({message: '本阶段剩余时间不足以启动锚点整轮，转入下一阶段'});
                    continue;
                }
                const anchorInput = {...input, options: {...input.options,
                    maxTotalPills: anchorCeiling, searchIntensity}};
                // The legacy anchor planner is tied to the domestic table order.
                // International saves use the channel-aware unified constructor above.
                const anchorLimited = isInternational ? false : !!AutoWash2Anchor.search(anchorInput, branches[branch], collect, progress,
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

        // Four progressive stages share one hard deadline. Engines receive a
        // larger share while no route exists; once feasible, unused time flows
        // to tactical/anchor refinement under best-1 instead of sitting idle.
        let cumulative = 0;
        for (const stage of SEARCH_STAGES) {
            if (Date.now() >= totalDeadline || combined().routes[0]?.totalPills === 0) break;
            cumulative += stage.fraction;
            const stageDeadline = Math.min(totalDeadline,
                searchStarted + Math.round(totalSearchMs * cumulative));
            const hadRoute = found.size > 0;
            send('progress', {progress: {message: `阶段 ${stage.intensity}/4 · ${stage.label}`}});
            runSeedStage(stage, stageDeadline, hadRoute ? 0.40 : 0.55);
            if (Date.now() >= stageDeadline) { limited = true; continue; }
            const best = combined().routes[0]?.totalPills;
            const ceiling = best == null ? userBudget : Math.max(0, best - 1);
            await runPass(ceiling, stageDeadline,
                best == null ? stage.label : `${stage.label}（当前最好 ${best.toLocaleString()} 丹）`,
                best == null, best != null, stage.intensity);
        }
        send('result', {result: {...combined(), limited}});
    } catch (error) {
        send('error', {error: error?.message || String(error)});
    }
};
