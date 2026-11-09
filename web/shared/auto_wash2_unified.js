/* Adapter for the isolated unified seed/swallow/jump route constructor.
 * Nothing is admitted until the route has been replayed by the active
 * channel-specific AutoWash2 engine.
 */
(function (root) {
    'use strict';
    const name = id => root.TALENT_DATA[String(id)]?.name || `#${id}`;
    const international = raw => root.WashSourceEngine.isInternationalChannel(
        raw?.save_channel || raw?.channel);
    const talentRows = (state, targets) => (state?.talents || []).map(id => ({
        id: Number(id), name: name(id), locked: (targets || []).includes(Number(id)),
    }));

    function stepLabel(step) {
        const locks = (step.locks || step.washLocks || []).map(name).join('、');
        if (step.type === 'upgrade') return ['开启第4槽', '提升资质后继续当前路线'];
        if (step.type === 'exchange' || step.type === 'burn') {
            return [`置换 ${name(step.from)} → ${name(step.to)}`,
                locks ? `锁定${locks}后置换` : '按统一路线构造器执行置换'];
        }
        if (step.type === 'prelude') return ['建立欧气种子', '按吞脉/跳脉前奏推进到首个种子落点'];
        if (step.type === 'washToPity') return ['洗到保底紫', '保持当前锁脉并推进到保底事件'];
        if (step.type === 'lock' || step.type === 'lockConflict'
            || step.type === 'lockCarrier' || step.type === 'seedLock'
            || step.type === 'seedLockWash') {
            return [`锁定 ${name(step.id)}`, '作为吞脉、跳脉或倒插锚点继续推进'];
        }
        return [locks ? `锁定${locks}继续洗` : '不锁脉继续洗', '统一路线构造步骤'];
    }

    function convert(input, targets, candidate) {
        if (!candidate?.ok || !candidate?.steps?.length) return null;
        const raw = input.initialState || {};
        const zi = Number(candidate.seedOpt?.zi || raw.zizhi || 153);
        const checked = root.AutoWash2RouteConstructor.verify(raw, targets, candidate.steps, zi);
        if (!checked.ok || Number(checked.cost) !== Number(candidate.cost)) return null;
        const ceiling = Number(input.options?.maxTotalPills ?? 5000);
        if (checked.cost > ceiling) return null;
        let priorCost = 0, priorWashes = 0;
        const steps = candidate.steps.map(step => {
            const cumulativePills = Math.max(priorCost, Number(step.cost) || priorCost);
            const washes = Math.max(priorWashes, Number(step.washes) || priorWashes);
            const [label, detail] = stepLabel(step);
            const row = {type: step.type || 'wash', label, detail,
                pills: cumulativePills - priorCost, cumulativePills,
                washes: washes - priorWashes,
                after: {talents: (step.field || []).map(id => ({id: Number(id), name: name(id)}))}};
            priorCost = cumulativePills; priorWashes = washes;
            return row;
        });
        // Some constructor steps only record operation boundaries. Keep the
        // independently replayed totals authoritative on the final row.
        if (steps.length) {
            steps[steps.length - 1].pills += checked.cost - priorCost;
            steps[steps.length - 1].cumulativePills = checked.cost;
            steps[steps.length - 1].washes += checked.washes - priorWashes;
        }
        const available = input.hasBagPills ? Number(input.bagPills) : null;
        const finalTalents = talentRows(checked.state, targets);
        return {
            kind: 'unified-seed-route', verified: true, verifiedOptimal: false,
            seedMethod: candidate.kind || '统一路线构造', channelEngine: international(raw) ? '国际服' : '国服/先行服',
            totalPills: checked.cost, totalWashes: checked.washes,
            exchangeCount: candidate.steps.filter(s => s.type === 'exchange' || s.type === 'burn').length,
            steps, finalTalents,
            finalState: {zizhi: checked.zizhi, seed: checked.state.bornSeed,
                born_talent_rc: checked.state.bornRC, luck_seed: checked.state.luckSeed,
                luck_seed_inited: checked.state.luckSeed != null, tal_lucky: checked.state.talLucky,
                talents: finalTalents},
            inventory: {available, enough: available == null ? null : available >= checked.cost,
                remaining: available == null ? null : available - checked.cost,
                shortfall: available == null ? null : Math.max(0, checked.cost - available)},
        };
    }

    function search(input, targets, collect, progress, options = {}) {
        if (input.dlcMode) return {skipped: true, reason: 'DLC 路线暂不使用统一构造器'};
        const raw = input.initialState || {};
        const intensity = Math.max(1, Math.min(4, Number(options.intensity) || 1));
        const timeBudgetMs = Math.max(1000, Number(options.timeBudgetMs) || 10000);
        const onlyPaths = intensity === 1 ? ['E', 'B']
            : intensity === 2 ? ['E', 'B', 'D'] : ['E', 'G', 'B', 'D', 'A'];
        const seen = new Set();
        const accept = candidate => {
            let route = null;
            try { route = convert(input, targets, candidate); } catch (_) { return; }
            if (!route) return;
            const key = JSON.stringify([route.finalState, route.steps]);
            if (seen.has(key)) return;
            seen.add(key); collect({routes: [route]});
        };
        progress({message: `统一路线构造：第 ${intensity}/4 阶段`});
        const result = root.AutoWash2RouteConstructor.planBest(raw, targets, {
            budget: Number(input.options?.maxTotalPills ?? 5000),
            methodMs: Math.max(1000, timeBudgetMs / 2),
            onlyPaths, nMax: Math.min(100, 20 + intensity * 20),
            count: 20 + intensity * 10, lead: 8 + intensity * 4,
            progressCb: value => progress({message: value?.note || value?.method || '统一路线构造中'}),
            onCandidate: accept,
        });
        accept(result);
        return {routeCount: seen.size, timedOut: Number(result?.timings?.totalMs) >= timeBudgetMs,
            analyzed: !!result};
    }

    root.AutoWash2Unified = Object.freeze({search, convert});
})(typeof window !== 'undefined' ? window : globalThis);
