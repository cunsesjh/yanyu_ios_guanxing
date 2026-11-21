/* Schedule conflict/carrier windows and replay successful timelines. */
(function (root) {
    'use strict';
    const LEADS = [8, 16, 20, 24, 28, 32];
    const MAX_PADDING = 200;
    const MAX_COMBINATIONS = 32;
    const MAX_TRIALS = 4096;

    function combinations(ctx) {
        const groups = ctx.compatibleGroups || [];
        const count = groups.reduce((n, group) => n * group.length, 1);
        if (count <= MAX_COMBINATIONS) return root.AutoWash2Model.combinations(ctx);
        // Give large selections a spread of concrete options. The seven-layer
        // search still treats every member of every group as a possible goal.
        const choices = [];
        for (let i = 0; i < MAX_COMBINATIONS; i++) {
            let index = Math.floor(i * (count - 1) / (MAX_COMBINATIONS - 1));
            const ids = [...ctx.targetIds];
            for (const group of groups) {
                ids.push(group[index % group.length]);
                index = Math.floor(index / group.length);
            }
            choices.push([...new Set(ids)]);
        }
        return choices;
    }

    function replay(ctx, plan, startZi, cap) {
        const {actionWash, actionReplace, actionOpen, traceAppend, routeFromNode} = root.PersonalWashRoutes;
        let state = ctx.startState, cost = 0, trace = null, washes = 0;
        function apply(result) {
            state = result.state;
            cost += result.action.cost;
            trace = traceAppend(trace, result.action);
        }
        while (state.zizhi < startZi) apply(actionOpen(ctx.engine, state));
        for (const step of plan.steps) {
            const to = Number(step.washes);
            if (!Number.isSafeInteger(to) || to < washes || to > plan.washes) return null;
            for (; washes < to; washes++) {
                const locks = step.locks || [];
                if (locks.length >= ctx.engine.slotCountFor(state.zizhi)
                        || new Set(locks).size !== locks.length
                        || !locks.every(id => state.talents.includes(id))) return null;
                apply(actionWash(ctx.engine, state, locks, 'seed-construction'));
                if (cost > cap) return null;
            }
            if (step.type === 'upgrade') {
                if (step.toZi !== state.zizhi + 1 || step.toZi > ctx.options.maxZi) return null;
                apply(actionOpen(ctx.engine, state));
            } else if (step.type === 'exchange' || step.type === 'burn') {
                const pos = state.talents.indexOf(step.from), locks = step.replaceLocks || [];
                if (!ctx.engine.replaceablePositions(state, locks).includes(pos)) return null;
                const result = actionReplace(ctx.engine, state, pos, 'seed-construction', locks);
                if (result.action.addedId !== step.to) return null;
                apply(result);
            } else if (['lock', 'lockConflict', 'lockCarrier'].includes(step.type)) {
                if (!state.talents.includes(step.id)) return null;
            } else if (step.type !== 'unlockConflict' && step.type !== 'wash') {
                return null;
            }
            if (cost !== step.cost || !Array.isArray(step.field)
                    || step.field.length !== state.talents.length
                    || step.field.some((id, i) => id !== state.talents[i])) return null;
        }
        const targetIds = root.PersonalWashSearch.goal(ctx, state);
        if (!targetIds || cost !== plan.cost || washes !== plan.washes || cost > cap) return null;
        const route = routeFromNode({...ctx, targetIds}, {state, cost, trace, serial:0});
        route.strategyLabel = '前置冲突脉、垫洗与置换脉序';
        return route;
    }

    function* search(ctx, cap, accept, progress) {
        const {engine, initialState, options} = ctx;
        const starts = [153, 154].filter(zi => zi >= initialState.zizhi && zi <= options.maxZi);
        const targets = combinations(ctx).filter(ids => ids.length >= 2 && ids.length <= 4
            && ids.every(id => engine.quality(id) === 4));
        if (!starts.length || !targets.length || ctx.dlcMode || cap < engine.at(starts[0]).eat) return;
        const simulate = root.PersonalWashSeedPlanner.create(ctx);
        const maxWash = Math.ceil(cap / engine.at(starts[0]).eat);
        const perWindow = Math.min(35, Math.max(1, Math.floor(MAX_TRIALS / (targets.length * starts.length * LEADS.length))));
        const pools = new Map(), windows = [];
        let skipped = 0;
        function construct(ids, params) {
            try {
                return simulate(ids, params);
            } catch {
                // A failed optional window must not discard a verified route
                // already returned by the seven-layer search or another window.
                skipped++;
                return null;
            }
        }
        function pool(seed) {
            if (pools.has(seed)) return pools.get(seed);
            const ids = [];
            let cursor = seed;
            for (let i = 0; i < 4000 && ids.length < 12; i++) {
                const [id, next] = engine.draw(cursor, true);
                cursor = next;
                if (engine.allowed.has(id)) ids.push(id);
            }
            pools.set(seed, ids);
            return ids;
        }
        progress({construction:true, message:'正在比较开槽时机和首次置换的脉序。'});
        for (const ids of targets) {
            for (const zi0 of starts) {
                for (const lead of LEADS) {
                    const params = {zi0, lead, maxWash, budget:cap};
                    let pads = [0];
                    if (!initialState.luck_seed_inited) {
                        const probe = construct(ids, {...params, probeSeeds:MAX_PADDING});
                        const ranked = [];
                        for (const [n, seed] of (probe?.probe?.seeds || []).entries()) {
                            const preview = pool(seed);
                            const positions = ids.map(id => preview.indexOf(id));
                            const hits = positions.filter(i => i >= 0).length;
                            if (hits >= Math.max(1, ids.length - 2))
                                ranked.push({n, hits, last:Math.max(...positions)});
                        }
                        ranked.sort((a, b) => b.hits - a.hits || a.last - b.last || a.n - b.n);
                        pads = ranked.slice(0, perWindow).map(candidate => candidate.n);
                        // With no writable first exchange the constructor may
                        // still collect everything by natural draws or pity.
                        if (probe && !probe.probe) pads = [0];
                    }
                    if (pads.length) windows.push({ids, params, pads});
                    yield;
                }
            }
        }
        let ceiling = cap, tried = 0;
        const total = windows.reduce((n, window) => n + window.pads.length, 0);
        for (let rank = 0; rank < perWindow && ceiling > 0; rank++) {
            for (const {ids, params, pads} of windows) {
                if (rank >= pads.length) continue;
                const plan = construct(ids, {...params, n:pads[rank], budget:ceiling});
                if (plan?.ok && plan.cost <= ceiling) {
                    const route = replay(ctx, plan, params.zi0, ceiling);
                    if (route) {
                        accept(route);
                        ceiling = route.totalPills - 1;
                        if (ceiling < 1) return;
                    }
                }
                if (++tried === 1 || tried % 16 === 0 || tried === total)
                    progress({construction:true, message:'已比较 ' + tried + ' / ' + total + ' 种置换走法。'});
                yield;
            }
        }
        if (skipped) progress({construction:true, message:'有 ' + skipped + ' 个置换窗口无法构造，已保留通过回放的路线。'});
    }

    root.PersonalWashSeedConstruction = Object.freeze({search, replay, combinations});
})(self);
