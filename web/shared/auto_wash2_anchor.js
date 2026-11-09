/* Reuse the legacy anchor planner, with independent inputs and result conversion. */
(function (root) {
    'use strict';
    function convert(raw, anchors, route, targets, input, planner = root.AnchorRoutePlanner) {
        const checked = planner.replay(raw, anchors, route.steps, targets);
        const budget = Number(input.options?.maxTotalPills ?? 10000);
        if (!checked.verified || checked.cost > budget) return null;
        const names = (state, locks = []) => state.talents.map(id => ({id,
            name: root.TALENT_DATA[id]?.name || '#' + id, locked: locks.includes(id)}));
        const name = id => root.TALENT_DATA[id]?.name || '#' + id;
        const steps = route.steps.map(action => {
            const pills = action.after.cost - action.before.cost;
            const lock = action.keepIds?.length ? '锁定' + action.keepIds.map(name).join('、') : '不锁脉';
            return {type: action.type, pills, cumulativePills: action.after.cost,
                washes: action.type === 'wash' ? action.count : 0,
                label: action.type === 'wash' ? `${lock}，洗 ${action.count} 次`
                    : action.type === 'exchange' ? `置换 ${name(action.from)} → ${name(action.to)}` : '开四槽',
                detail: action.type === 'wash' ? (action.why || '按当前锁法连续洗脉').replace(/锚点/g, '紫脉')
                    : action.type === 'exchange' ? `${lock}；置换第 ${action.position + 1} 条，核对得到${name(action.to)}` : '将资质升至空前绝后后继续',
                after: {talents: names(action.after.state, action.keepIds || [])}};
        });
        const final = checked.final, state = final.state;
        const available = input.hasBagPills ? Number(input.bagPills) : null;
        return {kind: 'anchor-replay', verified: true, verifiedOptimal: false,
            totalPills: checked.cost, totalWashes: checked.washes, exchangeCount: checked.exchanges,
            steps, finalTalents: names(state, targets),
            finalState: {zizhi: final.zi, seed: state.bornSeed, born_talent_rc: state.bornRC,
                luck_seed: state.luckSeed, luck_seed_inited: state.luckSeed != null,
                tal_lucky: state.talLucky, talents: names(state, targets)},
            inventory: {available, enough: available == null ? null : available >= checked.cost,
                remaining: available == null ? null : available - checked.cost,
                shortfall: available == null ? null : Math.max(0, checked.cost - available)}};
    }
    function search(input, targets, collect, progress, shouldCancel) {
        const raw = input.initialState, planner = root.AnchorRoutePlanner;
        const intensity = Math.max(1, Math.min(4,
            Math.trunc(Number(input.options?.searchIntensity) || 1)));
        // Locks describe the initial game state, not a permanent restriction.
        // Model.targets already adds every preserved purple to the final targets,
        // matching the tactical planner's unlock-and-reacquire semantics.
        if (![153, 154].includes(Number(raw.zizhi)) || targets.length < 1 || targets.length > 4
                || Number(input.options?.maxTotalPills) === 0) return false;
        const purples = planner.scan(raw, 24);
        const choices = [purples.filter(p => !p.fromPity && p.id !== 251).slice(0, targets.length),
            purples.slice(0, targets.length), purples.filter(p => p.id !== 251).slice(0, targets.length)];
        const seen = new Set();
        let best = null, bestAnchors = null, bounded = false;
        const accepted = new Set();
        const accept = (route, anchors) => {
            const key = root.AnchorRouteSearch.routeKey(route);
            if (accepted.has(key)) return;
            accepted.add(key);
            const converted = convert(raw, anchors, route, targets, input);
            if (!converted) return;
            if (!best || route.cost < best.cost) { best = route; bestAnchors = anchors; }
            collect({routes: [converted]});
        };
        for (const anchors of choices) {
            if (shouldCancel()) break;
            const key = anchors.map(p => p.key).join('|');
            if (anchors.length !== targets.length || seen.has(key)) continue;
            seen.add(key);
            const choiceStarted = Date.now();
            root.AnchorRouteSearch.run({mode: 'auto', raw, anchors, purples,
                options: {targets, maxCost: Number(input.options?.maxTotalPills ?? 10000),
                    maxNodes: 3000 + (intensity - 1) * 2500,
                    sequenceBasis: 'theory2', exhaustive: true,
                    perJobMs: 1000 + (intensity - 1) * 350,
                    stages: [{limit:150 * intensity,depth:24 + (intensity - 1) * 8},
                        {limit:450 * intensity,depth:36 + (intensity - 1) * 12},
                        {limit:900 * intensity,depth:48 + (intensity - 1) * 16}],
                    shouldCancel: () => shouldCancel()
                        || Date.now() - choiceStarted > 20000 + (intensity - 1) * 10000}}, packet => {
                if (packet.type === 'progress') progress({message: `置换路线比较 · 序列 ${packet.pad} · 深度 ${packet.depth}`});
                if (packet.candidate || packet.routes?.length) {
                    (packet.candidate ? [packet.candidate] : packet.routes).forEach(route => accept(route, anchors));
                }
            });
            bounded ||= Date.now() - choiceStarted > 20000 + (intensity - 1) * 10000;
        }
        // Fast sequence comparison must not skip the legacy late-lock and slot
        // optimizations. Refine the best verified sequence with a separate budget.
        if (best && !shouldCancel()) {
            const source = purples.find(p => p.key === best.source.key);
            progress({message: '继续优化已找到路线的锁脉时机与开槽步骤…'});
            const result = planner.search(raw, bestAnchors, source, best.pad,
                {targets, maxCost: Math.min(Number(input.options?.maxTotalPills ?? 10000), best.cost + 1),
                    depth: best.sequence.pool.length, maxNodes: 500 * intensity,
                    sequenceBasis: 'theory2', shouldCancel},
                packet => { if (packet.candidate) accept(packet.candidate, bestAnchors); });
            result.routes.forEach(route => accept(route, bestAnchors));
        }
        return bounded || shouldCancel();
    }
    root.AutoWash2Anchor = Object.freeze({search, convert});
})(typeof window !== 'undefined' ? window : globalThis);
