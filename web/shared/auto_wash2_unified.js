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

    function convert(input, targets, candidate, family = '') {
        if (!candidate?.ok || !candidate?.steps?.length) return null;
        const raw = input.initialState || {};
        const zi = Number(candidate.seedOpt?.zi || candidate.zizhi || candidate.zi
            || candidate.params?.zi0
            || candidate.steps.find(step => Number(step.startZi) >= 150)?.startZi
            || raw.zizhi || 153);
        const checked = candidate.kind === 'jumpManual'
            ? root.AutoWash2RouteConstructor.verifyJumpManual(raw, targets, candidate.steps, zi)
            : root.AutoWash2RouteConstructor.verify(raw, targets, candidate.steps, zi);
        if (!checked.ok || Number(checked.cost) !== Number(candidate.cost)) return null;
        const ceiling = Number(input.options?.maxTotalPills ?? 5000);
        if (checked.cost > ceiling) return null;
        let priorCost = 0, priorWashes = 0;
        const steps = candidate.steps.map(step => {
            const cumulativePills = Math.max(priorCost, Number(step.cost) || priorCost);
            const washes = Math.max(priorWashes, Number(step.washes) || priorWashes);
            const washDelta = washes - priorWashes;
            const [label, baseDetail] = stepLabel(step);
            const segmentLocks = (step.locks || step.washLocks || []).map(Number);
            const detailParts = [];
            if (washDelta > 0) {
                detailParts.push(`本段洗髓 ${washDelta} 次`);
                detailParts.push(segmentLocks.length
                    ? `洗髓时保留：${segmentLocks.map(name).join('、')}`
                    : '洗髓时不锁脉');
            }
            if (baseDetail) detailParts.push(baseDetail);
            const row = {type: step.type || 'wash', label, detail: detailParts.join('；'),
                pills: cumulativePills - priorCost, cumulativePills,
                washes: washDelta,
                after: {talents: (step.field || []).map(id => ({id: Number(id), name: name(id),
                    locked: (step.lockedIds || []).map(Number).includes(Number(id))}))}};
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
        const seedState = typeof root.AutoWash2RouteConstructor.resolveSeedState === 'function'
            ? root.AutoWash2RouteConstructor.resolveSeedState(raw)
            : {fixed: !!raw.luck_seed_inited};
        const familyMethods = {
            E: seedState.fixed ? 'fixed-current-chain' : 'natural-to-pity',
            G: 'exchange', U: 'exchange', B: 'lock', D: 'jump', A: 'exchange',
        };
        const seedMethod = candidate.seedMethod || familyMethods[family]
            || (seedState.fixed ? 'fixed-current-chain' : candidate.kind || 'unknown');
        const postSeedMode = candidate.postSeedMode
            || (candidate.refinement?.anchorMode === 'natural' ? 'natural'
                : candidate.steps.some(step => step.type === 'exchange' || step.type === 'burn')
                    ? 'exchange-chain' : 'natural');
        return {
            kind: 'unified-seed-route', verified: true, verifiedOptimal: false,
            seedMethod, postSeedMode, sourceFamily: family || candidate.kind || 'unified',
            channelEngine: international(raw) ? '国际服' : '国服/先行服',
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
        const startedAt = Date.now();
        const deadline = startedAt + timeBudgetMs;
        const sequence = root.AutoWash2RouteConstructor.readSequence(raw, {
            zi: Number(raw.zizhi) >= 154 ? 154 : 153, count: 40,
        });
        const seedState = root.AutoWash2RouteConstructor.resolveSeedState(raw, sequence);
        const seedPlan = root.AutoWash2RouteConstructor.resolveSeedMethod(raw, sequence);
        if (!seedPlan.valid || seedPlan.methodFamily === 'invalid') {
            progress({message: `种子状态异常：${seedPlan.error || '无法生成候选方法'}`});
            return {routeCount: 0, analyzed: true, invalidSeedState: true};
        }
        // Each route family gets its own bounded pass. A long lock/jump scan
        // cannot consume the whole slice before the continuous-exchange path
        // or an already-fixed luck chain is considered.
        const families = seedState.fixed ? ['E'] : [
            ...(intensity === 1 || intensity >= 3
                ? (!international(raw) ? ['G'] : []) : []),
            ...(seedPlan.allowsSwallow ? ['B'] : []),
            ...(intensity >= 2 ? ['U'] : []),
            'E',
            ...(intensity >= 2 && seedPlan.allowsSwallow ? ['D'] : []),
            ...(intensity >= 3 && seedPlan.allowsInfiniteExchange ? ['A'] : []),
        ];
        const uniqueFamilies = [...new Set(families)];
        const weights = {G: 1.1, B: 12.0, U: 0.8, E: 0.7, D: 0.8, A: 1.2};
        const seen = new Set();
        let bestCost = null;
        const familyTimings = {};
        const accept = (candidate, family) => {
            let route = null;
            try { route = convert(input, targets, candidate, family); } catch (_) { return; }
            if (!route) return;
            const key = JSON.stringify([route.finalState, route.steps]);
            if (seen.has(key)) return;
            seen.add(key); collect({routes: [route]});
            if (bestCost == null || route.totalPills < bestCost) bestCost = route.totalPills;
        };
        let analyzed = false;
        for (let index = 0; index < uniqueFamilies.length; index++) {
            const family = uniqueFamilies[index];
            const remaining = deadline - Date.now();
            const remainingWeight = uniqueFamilies.slice(index)
                .reduce((sum, item) => sum + weights[item], 0) || 1;
            if (remaining < 2000) break;
            const sliceMs = Math.max(2000, Math.floor(remaining * weights[family] / remainingWeight));
            if (family === 'U' && sliceMs < 3000) continue;
            const ziCount = Number(options.zi) >= 150 ? 1 : 2;
            progress({message: `阶段 ${intensity}/4 · 方法 ${index + 1}/${uniqueFamilies.length} (${family}) · `
                + `${seedState.seedStatus === 'fixed' ? '已固定种子' : '未固定种子'}`});
            const userBudget = Number(input.options?.maxTotalPills ?? 5000);
            const routeBudget = bestCost == null ? userBudget : Math.min(userBudget, bestCost - 1);
            if (routeBudget < 0) break;
            const familyStarted = Date.now();
            try {
                if (family === 'U') {
                    const result = root.AutoWash2UnifiedRouteConstructor.constructBest(raw, targets, {
                        budget: routeBudget, timeMs: sliceMs,
                        nMax: Math.min(200, 40 + intensity * 40),
                        topN: Math.min(80, 20 + intensity * 15),
                        maxWash: 3000 + intensity * 1000,
                    });
                    accept(result, family);
                    analyzed = analyzed || !!result;
                    continue;
                }
                const result = root.AutoWash2RouteConstructor.planBest(raw, targets, {
                    budget: routeBudget,
                    methodMs: Math.max(1000, Math.floor(sliceMs / ziCount)),
                    onlyPaths: [family], nMax: Math.min(100, 20 + intensity * 20),
                    count: 20 + intensity * 10, lead: 8 + intensity * 4,
                    jumpStartWashes: family === 'G' ? [864, 600, 300, 0] : undefined,
                    progressCb: value => progress({message: value?.note || value?.method
                        || `方法 ${family} 路线构造中`}),
                    onCandidate: candidate => accept(candidate, family),
                });
                accept(result, family);
                analyzed = analyzed || !!result;
            } catch (_) {
                progress({message: `方法 ${family} 未形成候选，继续其他方法`});
            } finally {
                familyTimings[family] = Date.now() - familyStarted;
            }
        }
        return {routeCount: seen.size, timedOut: Date.now() >= deadline,
            analyzed, seedMethod: seedPlan.methodFamily, originalSequenceCount: sequence.seq.length,
            familyTimings};
    }

    root.AutoWash2Unified = Object.freeze({search, convert});
})(typeof window !== 'undefined' ? window : globalThis);
