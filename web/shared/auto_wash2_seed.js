/* Convert seed-route research candidates into the isolated AutoWash2 format.
 * A candidate is accepted only after an independent replay with the current engine.
 */
(function (root) {
    'use strict';
    const name = id => root.TALENT_DATA[String(id)]?.name || `#${id}`;
    const positions = (state, ids) => ids.map(id => state.talents.indexOf(Number(id))).filter(i => i >= 0);
    function talents(state, locks) {
        return (state.talents || []).map(id => ({id, name: name(id), locked: locks.includes(id)}));
    }
    function replay(raw, targets, steps, startZi) {
        let zi = Number(startZi || raw.zizhi || 153);
        let engine = new root.AutoWash2Engine.Engine(root.TALENT_DATA, {...raw, zizhi: zi});
        let state = engine.initialState({...raw, zizhi: zi});
        let pills = 0, washes = 0, exchanges = 0;
        const converted = [];
        for (const step of steps || []) {
            if (step.type === 'upgrade') {
                zi = Number(step.zi || 154);
                state = {...state, zizhi: zi};
                engine = new root.AutoWash2Engine.Engine(root.TALENT_DATA, {...raw, zizhi: zi});
                converted.push({type: 'upgrade', label: '开启第4槽', detail: '将资质提升至四槽后继续',
                    pills: 0, cumulativePills: pills, washes: 0, after: {talents: talents(state, [])}});
                continue;
            }
            if (step.type === 'wash') {
                const locks = (step.lockIds || []).map(Number);
                const count = Math.max(0, Number(step.count) || 0);
                const startPills = pills;
                for (let i = 0; i < count; i++) {
                    const keep = positions(state, locks);
                    if (keep.length !== locks.length) throw new Error('种子路线回放失败：锁定脉已不在场');
                    const result = engine.wash(state, keep);
                    state = result.state; pills += Number(result.cost) || 0; washes++;
                }
                converted.push({type: 'wash', label: locks.length ? `锁定${locks.map(name).join('、')}，洗 ${count} 次` : `不锁脉，洗 ${count} 次`,
                    detail: '按欧气种子候选路线推进', pills: pills - startPills,
                    cumulativePills: pills, washes: count, after: {talents: talents(state, locks)}});
                continue;
            }
            if (step.type === 'exchange') {
                const locks = (step.lockIds || []).map(Number);
                const lowLocks = locks.filter(id => engine.at(zi).quality(id) < 4);
                const pos = engine.at(zi).replaceablePositions(state, lowLocks)[0];
                if (pos == null) throw new Error('种子路线回放失败：置换条件不成立');
                const result = engine.replace(state, pos, lowLocks);
                if (Number(result.addedId) !== Number(step.to)) {
                    throw new Error(`种子路线回放失败：预期${name(step.to)}，实际${name(result.addedId)}`);
                }
                state = result.state; exchanges++;
                converted.push({type: 'exchange', label: `置换 ${name(step.from)} → ${name(step.to)}`,
                    detail: locks.length ? `锁定${locks.map(name).join('、')}后置换` : '按当前场上状态置换',
                    pills: 0, cumulativePills: pills, washes: 0, after: {talents: talents(state, locks)}});
            }
        }
        if (!(targets || []).every(id => state.talents.includes(Number(id)))) {
            throw new Error('种子路线回放失败：终态缺少目标紫脉');
        }
        return {state, pills, washes, exchanges, steps: converted};
    }
    function convert(input, targets, result) {
        const pick = result?.winner?.pick;
        if (!result || result.error || result.noSolution || !pick?.plan?.steps) return null;
        const checked = replay(input.initialState, targets, pick.plan.steps, result.zizhi);
        const budget = Number(input.options?.maxTotalPills ?? 5000);
        if (checked.pills > budget) return null;
        const available = input.hasBagPills ? Number(input.bagPills) : null;
        return {kind: 'luck-seed-replay', verified: true, verifiedOptimal: false,
            seedMethod: result.winner.prelude ? '锁脉挪种子' : `跳脉 ${result.winner.arch?.jumps || 0} 次`,
            totalPills: checked.pills, totalWashes: checked.washes, exchangeCount: checked.exchanges,
            steps: checked.steps, finalTalents: talents(checked.state, targets),
            finalState: {zizhi: checked.state.zizhi, seed: checked.state.bornSeed,
                born_talent_rc: checked.state.bornRC, luck_seed: checked.state.luckSeed,
                luck_seed_inited: checked.state.luckSeed != null, tal_lucky: checked.state.talLucky,
                talents: talents(checked.state, targets)},
            inventory: {available, enough: available == null ? null : available >= checked.pills,
                remaining: available == null ? null : available - checked.pills,
                shortfall: available == null ? null : Math.max(0, checked.pills - available)}};
    }
    function search(input, targets, collect, progress, options = {}) {
        const raw = input.initialState || {};
        if (input.dlcMode) return {skipped: true, reason: 'DLC 路线暂不使用欧气种子引擎'};
        if (Number(input.options?.maxTotalPills) <= 0) return {skipped: true};
        progress({message: '欧气种子路线：正在比较保底落点与置换队列'});
        const intensity = Math.max(1, Math.min(4, Number(options.intensity) || 1));
        const result = root.AutoWash2SeedPlanner.solve(raw, targets, {
            slots: Math.max(3, Math.min(4, targets.length)),
            maxPills: Number(input.options?.maxTotalPills),
            maxJump: 12 + intensity * 6, queueLength: 16 + intensity * 4,
            sweep: intensity >= 2, maxSwitch: 40 + intensity * 40,
            seedCandidates: 2 + intensity, padForTarget: true,
            timeBudgetMs: Math.max(1000, Number(options.timeBudgetMs) || 12000),
        });
        const route = convert(input, targets, result);
        if (route) collect({routes: [route]});
        return {route, timedOut: !!result?.timedOut, analyzed: !result?.error};
    }
    root.AutoWash2Seed = Object.freeze({search, convert, replay});
})(typeof window !== 'undefined' ? window : globalThis);
