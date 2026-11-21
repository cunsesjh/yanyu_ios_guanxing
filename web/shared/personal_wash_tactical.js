/* Run the upstream tactical branches with a fixed amount of search work.
 * The seven-layer incumbent and all later improvements stay available. */
(function (root) {
    'use strict';
    const MAX_CHECKS = 500000;
    function replay(ctx, source) {
        const text = source.steps.filter(s => s.type !== 'unlock')
            .map((s,i) => (i+1)+'. '+s.label+'：'+s.detail).join('\n');
        let route;
        try { route = root.PersonalWashSearch.reference(ctx,text); }
        catch { return null; }
        const same = ['zizhi','seed','born_talent_rc','luck_seed','tal_lucky']
            .every(k => route.finalState[k] === source.finalState[k]);
        if (!same || route.totalPills !== source.totalPills || route.totalWashes !== source.totalWashes ||
            route.finalTalents.length !== source.finalTalents.length ||
            !route.finalTalents.every((talent,i) => talent.id === source.finalTalents[i].id)) return null;
        route.kind = 'personal-tactical';
        route.strategyLabel = '取得冲突紫脉后开槽与连续置换';
        return route;
    }
    async function search(ctx, incumbent, accept, progress, checkpoint) {
        let cap = Math.min(ctx.options.maxTotalPills,(incumbent?.totalPills ?? Infinity)-1);
        if (cap < 1) return;
        const goals = root.PersonalWashSeedConstruction.combinations(ctx).filter(ids =>
            ids.length >= 3 && ids.length <= ctx.options.maxZi-150 && ids.every(id => ctx.engine.quality(id)===4));
        if (!goals.length) return;
        const field = new Set((incumbent?.finalTalents || []).map(t=>t.id));
        const preferred = goals.find(ids=>ids.every(id=>field.has(id)));
        if (preferred) goals.unshift(...goals.splice(goals.indexOf(preferred),1));
        // Reserve half the work for improving the current concrete target set
        // when there are alternatives. Every other set gets a turn as well.
        const primary = preferred && goals.length>1 ? Math.floor(MAX_CHECKS/2) : 0;
        const shared = Math.floor((MAX_CHECKS-primary)/goals.length);
        for (const [index,ids] of goals.entries()) {
            if (cap<1) break;
            const limit = shared + (!index ? primary : 0);
            let checked = 0;
            const show = () => progress({tactical:true, message:'目标组合 '+(index+1)+' / '+goals.length+
                '，已检查 '+Math.min(checked,limit).toLocaleString()+' / '+limit.toLocaleString()+' 次。'});
            function collect(result) {
                for (const item of result.routes || []) {
                    if (!item.verified || item.totalPills > cap) continue;
                    const valid = replay(ctx,item);
                    if (valid) {
                        if (valid.totalWashes > 0 && result.searchScope?.expandedNodes === 0 &&
                                result.searchScope.rawWashesSimulated === 0)
                            valid.strategyLabel = '上游起步候选（自用回放）';
                        accept(valid);
                        cap = valid.totalPills - 1;
                    }
                }
            }
            show();
            const input = {
                initialState:ctx.initialState, targetIds:ids, talentData:root.TALENT_DATA,
                bagPills:ctx.bagPills, hasBagPills:ctx.hasBagPills, dlcMode:ctx.dlcMode,
                eligibleTalentIds:ctx.eligibleTalentIds,
                onCandidate:collect,onProgress:show,shouldCancel:()=>++checked>limit,yieldControl:checkpoint,
            };
            // A starting route may return before the tactical graph is visited.
            // Keep the remaining checks and rerun at the tighter replayed ceiling.
            let nextCap = cap;
            while (nextCap >= 0 && checked < limit) {
                const result = await root.AutoWash2Optimizer.searchWashRoutes({
                    ...input, options:{maxTotalPills:nextCap, searchIntensity:1},
                });
                collect(result);
                await checkpoint();
                if (result.searchScope?.expandedNodes !== 0 || cap >= nextCap) break;
                nextCap = cap;
            }
        }
    }
    root.PersonalWashTactical = Object.freeze({search,replay});
})(self);
