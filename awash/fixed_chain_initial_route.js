#!/usr/bin/env node
'use strict';

const { loadAWash } = require('./context');
const {
    searchInitialRoute,
} = require('./initial_route_search');
let sharedAWashContext = null;

function getAWashContext() {
    if (!sharedAWashContext) {
        sharedAWashContext = loadAWash();
    }
    return sharedAWashContext;
}

function orderedState(state, keepIds) {
    const keep = keepIds.filter(id => state.talents.includes(Number(id)));
    const keepSet = new Set(keep);
    return Object.assign({}, state, {
        talents: keep.concat(
            state.talents.filter(id => !keepSet.has(Number(id)))
        ),
    });
}

function idByName(context, name) {
    const item = Object.values(context.TALENT_DATA)
        .find(value => value && value.name === name);
    return item ? Number(item.id) : 0;
}

function validateHeldTargets(steps, heldIds) {
    const held = Array.from(new Set(
        (heldIds || []).map(Number)
    ));
    const failures = [];
    if (!held.length) return { ok: true, failures };
    for (const [index, step] of (steps || []).entries()) {
        if (!step || typeof step !== 'object') continue;
        if (step.op === 'exchange'
            && held.includes(Number(step.removedId))) {
            failures.push(
                `step ${index + 1}: removed held target `
                + `${Number(step.removedId)}`
            );
            continue;
        }
        const keepIds = step.op === 'wash'
            ? (step.keepIds || []).map(Number)
            : step.op === 'locks'
                ? (step.lockIds || []).map(Number) : null;
        if (!keepIds) continue;
        const missing = held.filter(id => !keepIds.includes(id));
        if (missing.length) {
            failures.push(
                `step ${index + 1}: ${step.op} did not keep `
                + missing.join(',')
            );
        }
    }
    return {
        ok: failures.length === 0,
        failures,
    };
}

function materializeInitialRoute(context, raw, targets, route) {
    const zz3 = context.ZZ_DATA['153'];
    const zz4 = context.ZZ_DATA['154'];
    const engineFor = zi => {
        const zz = zi >= 154 ? zz4 : zz3;
        return new context.WashSourceEngine.Engine(
            context.TALENT_DATA,
            raw,
            {
                slotCount: Number(zz.num_talent),
                pity: Number(zz.bd_zz),
                eat: Number(zz.eat_xisui),
                eligibleZi: zi,
                advancePerDraw: true,
                dlcMode: !!raw.dlc_mode,
            }
        );
    };

    let zizhi = Number(raw.zizhi) || 153;
    let engine = engineFor(zizhi);
    let state = engine.initialState(
        Object.assign({}, raw, { zizhi })
    );
    let pills = 0;
    let washes = 0;
    let locks = (raw.talents || [])
        .filter(item => item && item.locked)
        .map(item => Number(item.id))
        .filter(id => id > 0);
    const steps = [];

    const pushLocks = () => {
        const lockIds = locks.filter(id => state.talents.includes(id));
        const previous = steps.length
            ? steps[steps.length - 1] : null;
        if (previous && previous.op === 'locks'
            && previous.lockIds.join(',') === lockIds.join(',')) {
            return;
        }
        steps.push({ op: 'locks', lockIds });
    };

    const washTo = targetWash => {
        const delta = Math.max(0, Number(targetWash) - washes);
        if (!delta) return;
        pushLocks();
        let count = 0;
        let cost = 0;
        const generatedPurples = [];
        const pityPurples = [];
        while (count < delta) {
            state = orderedState(state, locks);
            const keepIds = locks.filter(id =>
                state.talents.includes(Number(id))
            );
            const result = engine.wash(
                state,
                keepIds.map((_, index) => index)
            );
            state = result.state;
            count += 1;
            washes += 1;
            cost += Number(result.cost) || 0;
            (result.generatedEvents || [])
                .filter(event => engine.quality(Number(event.id)) === 4)
                .forEach(event => generatedPurples.push({
                    at: count,
                    id: Number(event.id),
                    fromPity: !!event.fromPity,
                }));
            if (result.pityPurpleId != null) {
                pityPurples.push({
                    at: count,
                    id: Number(result.pityPurpleId),
                });
            }
        }
        pills += cost;
        steps.push({
            op: 'wash',
            keepIds: locks.slice(),
            count,
            cost,
            generatedPurples,
            pityPurples,
            stopReason: 'decision',
        });
    };

    for (const [actionIndex, action] of (route.actions || []).entries()) {
        washTo(action.wash_no);
        if (action.kind === 'open_slot') {
            zizhi = 154;
            engine = engineFor(zizhi);
            state = engine.upgradeToFour(
                Object.assign({}, state, { zizhi })
            );
            steps.push({
                op: 'upgrade',
                fromZizhi: 153,
                toZizhi: 154,
            });
            continue;
        }
        if (action.kind === 'lock' || action.kind === 'keep') {
            const id = idByName(context, action.talent);
            if (!state.talents.includes(id)) {
                throw new Error(
                    `动作#${actionIndex + 1} ${action.kind} ${action.talent}`
                    + ` 不在场 @${action.wash_no}洗`
                );
            }
            locks = locks.filter(value => value !== id);
            locks.push(id);
            pushLocks();
            continue;
        }
        if (action.kind === 'unlock') {
            const id = idByName(context, action.talent);
            locks = locks.filter(value => value !== id);
            pushLocks();
            continue;
        }
        if (action.kind === 'exchange') {
            const from = idByName(context, action.from);
            const to = idByName(context, action.to);
            state = orderedState(state, locks);
            const position = state.talents.indexOf(from);
            if (position < 0) {
                throw new Error(`置换载体 ${action.from} 不在场`);
            }
            let exchangeLocks = locks.filter(id =>
                state.talents.includes(id)
            );
            pushLocks();
            let replaced;
            try {
                replaced = engine.replace(
                    state, position, exchangeLocks
                );
            } catch (error) {
                const type = engine.talentType(from);
                const conflict = state.talents.slice(0, position)
                    .reverse()
                    .find(id => id !== 251
                        && engine.quality(id) < 4
                        && engine.talentType(id) === type);
                if (!conflict) throw error;
                if (!exchangeLocks.includes(conflict)) {
                    exchangeLocks = exchangeLocks.concat([conflict]);
                    steps.push({
                        op: 'locks',
                        lockIds: exchangeLocks,
                    });
                }
                replaced = engine.replace(
                    state, position, exchangeLocks
                );
            }
            if (Number(replaced.addedId) !== to) {
                throw new Error(
                    `置换结果不一致: ${action.from} -> `
                    + `${context.WashSearchV2.nameOf(replaced.addedId)}，`
                    + `期望 ${action.to}`
                );
            }
            state = replaced.state;
            locks = locks.filter(id =>
                id !== from && state.talents.includes(id)
            );
            steps.push({
                op: 'exchange',
                carrierId: from,
                lockIds: exchangeLocks,
                removedId: from,
                addedId: to,
            });
            continue;
        }
        if (action.kind !== 'wash_to') {
            throw new Error(`未知初始路线动作: ${action.kind}`);
        }
        if (action.pills_after != null
            && Number(action.pills_after) !== pills) {
            throw new Error(
                `${action.kind}@${action.wash_no} 丹耗不一致`
            );
        }
    }
    pushLocks();
    if (washes !== Number(route.washes)
        || pills !== Number(route.pills)) {
        throw new Error(
            `初始路线统计不一致: ${pills}/${washes} `
            + `!= ${route.pills}/${route.washes}`
        );
    }
    const replayed = context.WashSearchV2.replay(
        raw, targets, steps
    );
    if (!replayed.ok
        || replayed.pills !== pills
        || replayed.washes !== washes
        || replayed.exchanges !== Number(route.exchanges)) {
        throw new Error('初始路线未通过 V2 独立回放');
    }
    return {
        source: 'awash-initial-route',
        actions: (route.actions || []).map(item =>
            Object.assign({}, item)
        ),
        steps,
        replay: replayed,
        pills: replayed.pills,
        washes: replayed.washes,
        exchanges: replayed.exchanges,
    };
}

async function findInitialRoutes(raw, targetIds, options) {
    const context = getAWashContext();
    const targets = Array.from(new Set(targetIds.map(Number)));
    const requiredHeldIds = Array.from(new Set(
        ((options || {}).requiredHeldIds || []).map(Number)
    ));
    const names = targets.map(id => {
        const item = context.TALENT_DATA[String(id)];
        return item && item.name;
    });
    if (names.some(name => !name)) {
        throw new Error('初始搜索缺少合法目标');
    }
    const requiredSet = new Set(requiredHeldIds);
    const fastRaw = requiredHeldIds.length
        ? Object.assign({}, raw, {
            talents: (raw.talents || []).map(item => {
                const id = Number(item && item.id != null
                    ? item.id : item);
                return Object.assign(
                    {},
                    typeof item === 'object' ? item : { id },
                    { locked: requiredSet.has(id) }
                );
            }),
        })
        : raw;
    const searched = await searchInitialRoute(
        fastRaw,
        names.join(','),
        Object.assign({
            topN: requiredHeldIds.length ? 8 : 1,
            horizon: 2000,
        }, options || {})
    );
    const routes = (searched.result.routes || []);
    const verified = [];
    for (const route of routes) {
        try {
                const materialized = materializeInitialRoute(
                    context, fastRaw, targets, route
                );
            const held = validateHeldTargets(
                materialized.steps,
                requiredHeldIds
            );
            if (!held.ok) continue;
            verified.push(Object.assign(materialized, {
                heldTargetsVerified: true,
            }));
        } catch (error) {
            // A generic search candidate may use a different runtime version.
            // Keep trying the next route instead of treating it as solved.
        }
    }
    verified.sort((a, b) =>
        a.replay.pills - b.replay.pills
        || a.replay.washes - b.replay.washes
        || a.replay.exchanges - b.replay.exchanges
    );
    if (verified.length || !requiredHeldIds.length) {
        return verified;
    }
    return [];
}

module.exports = {
    findInitialRoutes,
    materializeInitialRoute,
    validateHeldTargets,
};
