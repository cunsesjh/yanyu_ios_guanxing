#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const path = require('path');
const { Worker } = require('worker_threads');
const U = require('./dev/unified_runner');
const J = require('./jump_seed_search');
const BoundaryFrontier = require('./pity_boundary_frontier');
const { loadAWash } = require('./context');
const FRONTIER_WORKER = path.join(
    __dirname, 'pity_frontier_worker.js'
);
const FRONTIER_CACHE_VERSION = '2026-11-25-v3';

function frontierCacheKey(raw, options) {
    const o = options || {};
    const payload = {
        version: FRONTIER_CACHE_VERSION,
        raw,
        targetIds: (o.targetIds || []).map(Number),
        targetOrder: (o.targetOrder || o.targetIds || []).map(Number),
        zizhiList: (o.zizhiList || [153, 154]).map(Number),
        maxRounds: Number(o.maxRounds) || 4,
        boundarySpan: Number(o.boundarySpan) || 16,
        maxSeeds: Number(o.maxSeeds) || 500,
        maxWashes: Number(o.maxWashes) || 6000,
        maxStates: Number(o.maxStates) || 500000,
        maxJump: Number(o.maxJump) || 0,
        upperBoundPills: Number(o.upperBoundPills) || 0,
        allowLongLock: o.allowLongLock === true,
    };
    return crypto.createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex');
}

function expandTargetPinBranches(targetEvents, targetOrder, targetIds) {
    const required = new Set((targetIds || []).map(Number));
    const order = Array.from(new Set(
        (targetOrder || []).map(Number)
    ));
    const firstWash = new Map();
    for (const event of targetEvents || []) {
        const id = Number(event.id);
        if (!required.has(id)) continue;
        if (!firstWash.has(id)
            || Number(event.wash) < firstWash.get(id)) {
            firstWash.set(id, Number(event.wash));
        }
    }
    const actual = Array.from(firstWash.keys()).sort((a, b) => {
        const ai = order.indexOf(a);
        const bi = order.indexOf(b);
        return (ai < 0 ? order.length : ai)
            - (bi < 0 ? order.length : bi)
            || firstWash.get(a) - firstWash.get(b)
            || a - b;
    });
    const branches = [];
    const limit = 1 << actual.length;
    for (let mask = 0; mask < limit; mask++) {
        const kept = actual.filter((_, index) =>
            (mask & (1 << index)) !== 0
        );
        branches.push({
            keptTargetIds: kept,
            terminal: required.size > 0
                && Array.from(required).every(id => kept.includes(id)),
        });
    }
    return branches;
}

function createScheduleRunShell(context, raw, zizhi, options) {
    const o = options || {};
    const engine = o.engine || J.engineFor(context, raw, zizhi);
    const targetIds = new Set((o.targetIds || []).map(Number));
    const pinIds = Array.from(new Set(
        (o.pinIds || []).map(Number)
    )).filter(id => targetIds.has(id));
    return {
        context,
        raw,
        engine,
        zizhi,
        targetIds,
        pinIds,
        maxWashes: Math.max(1, Number(o.maxWashes) || 6000),
        pillLimit: Number(o.maxPills) > 0
            ? Number(o.maxPills) : Infinity,
        pillLimitReached: false,
        state: null,
        wash: 0,
        pills: 0,
        naturalPurples: [],
        targetEvents: [],
        seenPinIds: new Set(),
        lostPinIds: new Set(),
        pityPurpleId: null,
    };
}

function createScheduleRun(context, raw, zizhi, options) {
    const run = createScheduleRunShell(
        context, raw, zizhi, options
    );
    run.state = run.engine.initialState(
        Object.assign({}, raw, { zizhi })
    );
    return run;
}

function createScheduleRunFromSnapshot(context, raw, node, options, start) {
    const snapshots = node.boundarySnapshots || [];
    const snapshot = snapshots.find(item =>
        Number(item.wash) === Number(start) - 1);
    if (!snapshot) return null;

    const run = createScheduleRunShell(
        context, raw, node.zizhi, options
    );
    const targetEvents = (node.targetEvents || [])
        .filter(event => Number(event.wash) < Number(start))
        .map(event => Object.assign({}, event));
    const naturalPurples = (node.naturalPurplesBeforePity || [])
        .filter(event => Number(event.wash) < Number(start))
        .map(event => Object.assign({}, event));
    const seenPinIds = new Set(targetEvents.map(event =>
        Number(event.id)));
    const lostPinIds = new Set(run.pinIds.filter(id =>
        seenPinIds.has(id) && !snapshot.state.talents.includes(id)));
    return Object.assign(run, {
        state: Object.assign({}, snapshot.state, {
            talents: snapshot.state.talents.slice(),
        }),
        wash: Number(snapshot.wash) || 0,
        pills: Number(snapshot.pills) || 0,
        naturalPurples,
        targetEvents,
        seenPinIds,
        lostPinIds,
    });
}

function forkScheduleRun(run) {
    return Object.assign({}, run, {
        naturalPurples: run.naturalPurples.slice(),
        targetEvents: run.targetEvents.slice(),
        seenPinIds: new Set(run.seenPinIds),
        lostPinIds: new Set(run.lostPinIds),
    });
}

function stepScheduleRun(run, byWash) {
    if (run.wash >= run.maxWashes) return false;
    run.wash += 1;
    const action = byWash.get(run.wash);
    const keepIds = run.pinIds.filter(id =>
        run.state.talents.includes(id)
    );
    if (action) {
        let position = -1;
        if (action.id != null) {
            position = run.state.talents.indexOf(Number(action.id));
        }
        if (position < 0 && action.position != null) {
            position = Number(action.position);
        }
        if (position >= 0 && position < run.state.talents.length) {
            keepIds.push(Number(run.state.talents[position]));
        }
    }
    const keep = Array.from(new Set(keepIds))
        .map(id => run.state.talents.indexOf(id))
        .filter(position => position >= 0)
        .sort((a, b) => a - b);
    const result = run.engine.wash(run.state, keep);
    run.state = result.state;
    run.pills += Number(result.cost) || 0;
    if (run.pills > run.pillLimit) {
        run.pillLimitReached = true;
        return false;
    }
    for (const event of result.generatedEvents || []) {
        if (!event.fromPity
            && run.engine.quality(Number(event.id)) === 4) {
            run.naturalPurples.push({
                wash: run.wash,
                id: Number(event.id),
            });
            if (run.targetIds.has(Number(event.id))) {
                run.targetEvents.push({
                    wash: run.wash,
                    id: Number(event.id),
                });
            }
        }
    }
    for (const id of run.pinIds) {
        if (run.state.talents.includes(id)) {
            run.seenPinIds.add(id);
        } else if (run.seenPinIds.has(id)) {
            run.lostPinIds.add(id);
        }
    }
    if (result.pityPurpleId != null) {
        run.pityPurpleId = Number(result.pityPurpleId);
        return true;
    }
    return false;
}

function advanceScheduleTo(run, byWash, stopWash) {
    while (run.wash < stopWash) {
        if (stepScheduleRun(run, byWash)) return false;
        if (run.pillLimitReached) return false;
    }
    return true;
}

function scheduleResult(run, actions) {
    return {
        zizhi: run.zizhi,
        seed: Number(run.state.luckSeed),
        firstPityId: run.pityPurpleId,
        washes: run.wash,
        pills: run.pills,
        naturalPurplesBeforePity: run.naturalPurples,
        targetEvents: run.targetEvents,
        pinIds: run.pinIds.slice(),
        keptTargetIds: run.pinIds.filter(id =>
            run.seenPinIds.has(id) && !run.lostPinIds.has(id)
        ),
        lostPinIds: Array.from(run.lostPinIds),
        checkpointRaw: J.checkpointRaw(run.raw, run.state),
        engine: run.engine,
        state: run.state,
        exchangeReady: !!exchangeReadyMove(
            run.context, run.raw, run.state, run.targetIds, run.engine
        ),
        actions: actions.map(item => Object.assign({}, item)),
    };
}

function finishScheduleRun(run, byWash, actions) {
    while (run.wash < run.maxWashes) {
        const pity = stepScheduleRun(run, byWash);
        if (run.pillLimitReached) return null;
        if (pity) {
            return scheduleResult(run, actions);
        }
    }
    return null;
}

function runSchedule(context, raw, zizhi, actions, options) {
    const run = createScheduleRun(
        context, raw, zizhi, options
    );
    const byWash = new Map();
    for (const action of actions || []) {
        byWash.set(Number(action.wash), action);
    }
    return finishScheduleRun(run, byWash, actions);
}

function materializePityRoot(
    context, raw, candidate, targets, options
) {
    const o = options || {};
    const zizhi = Number(candidate.zizhi) || Number(raw.zizhi) || 153;
    const engine = J.engineFor(context, raw, zizhi);
    let state = engine.initialState(
        Object.assign({}, raw, { zizhi })
    );
    const actions = new Map();
    for (const action of candidate.actions || []) {
        actions.set(Number(action.wash), action);
    }
    const pins = Array.from(new Set(
        (candidate.keptTargetIds || []).map(Number)
    )).filter(id => (targets || []).map(Number).includes(id));
    const steps = [];
    let pills = 0;
    const washLimit = Math.max(
        1,
        Number(candidate.preludeWashes)
        || Number(candidate.washes)
        || Number(o.maxWash)
        || 6000
    );
    for (let wash = 1; wash <= washLimit; wash++) {
        const action = actions.get(wash);
        const keepIds = pins.filter(id =>
            state.talents.includes(id)
        );
        if (action) {
            let position = action.id == null
                ? -1 : state.talents.indexOf(Number(action.id));
            if (position < 0 && action.position != null) {
                position = Number(action.position);
            }
            if (position >= 0 && position < state.talents.length) {
                keepIds.push(Number(state.talents[position]));
            }
        }
        const lockIds = Array.from(new Set(keepIds));
        const positions = lockIds
            .map(id => state.talents.indexOf(id))
            .filter(position => position >= 0)
            .sort((a, b) => a - b);
        steps.push({ op: 'locks', lockIds });
        const result = engine.wash(state, positions);
        state = result.state;
        const cost = Number(result.cost) || 0;
        pills += cost;
        steps.push({
            op: 'wash',
            keepIds: lockIds,
            count: 1,
            cost,
        });
    }
    const seed = Number(state.luckSeed);
    if (seed !== Number(candidate.seed)) {
        throw new Error(
            `保底根种子不一致: ${seed} != ${candidate.seed}`
        );
    }
    if (pills !== Number(candidate.pills)) {
        throw new Error(
            `保底根丹耗不一致: ${pills} != ${candidate.pills}`
        );
    }
    const lockIds = Array.from(new Set(
        (targets || []).map(Number)
            .filter(id => state.talents.includes(id))
    ));
    if (lockIds.length) {
        steps.push({ op: 'locks', lockIds });
    }
    return {
        zizhi,
        seed,
        pills,
        washes: washLimit,
        lockIds,
        keptTargetIds: pins.slice(),
        state,
        steps,
    };
}

function exchangeReadyMove(context, raw, state, targets, engineOverride) {
    const engine = engineOverride
        || J.engineFor(context, raw, Number(state.zizhi));
    const field = (state.talents || []).map(Number);
    const targetIds = targets instanceof Set
        ? targets : new Set((targets || []).map(Number));
    for (let carrierPosition = field.length - 1;
        carrierPosition >= 0;
        carrierPosition--) {
        const carrierId = Number(field[carrierPosition]);
        if (targetIds.has(carrierId)
            || engine.quality(carrierId) !== 4
            || engine.isShenmai(carrierId)) {
            continue;
        }
        const type = engine.talentType(carrierId);
        for (let index = carrierPosition - 1; index >= 0; index--) {
            const conflictId = Number(field[index]);
            if (conflictId === 251
                || engine.quality(conflictId) >= 4) {
                continue;
            }
            if (engine.talentType(conflictId) !== type) continue;
            if (engine.replaceablePositions(state, [conflictId])
                .includes(carrierPosition)) {
                return {
                    carrierId,
                    conflictId,
                    carrierPosition,
                };
            }
            break;
        }
    }
    return null;
}

function advanceExchangeReadyRoot(context, raw, candidate, targets, options) {
    const root = materializePityRoot(
        context, raw, candidate, targets, options
    );
    const targetIds = new Set((targets || []).map(Number));
    const move = exchangeReadyMove(
        context, raw, root.state, targetIds
    );
    if (!move) return null;
    const engine = J.engineFor(context, raw, Number(root.state.zizhi));
    const orderLocks = (state, lockIds) => {
        const keep = lockIds.filter(id =>
            state.talents.includes(Number(id))
        );
        const set = new Set(keep);
        return Object.assign({}, state, {
            talents: keep.concat(
                state.talents.filter(id => !set.has(Number(id)))
            ),
        });
    };
    const nextAllowed = state => {
        let luck = Number(state.luckSeed);
        for (let index = 0; index < 64; index++) {
            const [id, next] = engine.draw(luck, true);
            luck = Number(next);
            if (engine.allowed.has(Number(id))
                && !state.talents.includes(Number(id))) {
                return Number(id);
            }
        }
        return 0;
    };
    const findSupport = (state, wantedId) => {
        const type = engine.talentType(Number(wantedId));
        return Number((state.talents || []).find(id =>
            id !== 251
            && engine.quality(id) < 4
            && engine.talentType(Number(id)) === type
        )) || 0;
    };

    let state = root.state;
    const lockIds = [move.conflictId, move.carrierId];
    state = orderLocks(state, lockIds);
    const firstTrial = engine.replace(
        state,
        state.talents.indexOf(move.carrierId),
        lockIds
    );
    const nextCarrierId = Number(firstTrial.addedId);
    const secondId = nextAllowed(firstTrial.state);
    if (!nextCarrierId || targetIds.has(nextCarrierId)
        || !secondId || targetIds.has(secondId)
        || engine.isShenmai(secondId)) {
        return null;
    }
    const steps = [];
    let pills = root.pills;
    let washes = root.washes;
    if (!findSupport(state, nextCarrierId)) {
        steps.push({ op: 'locks', lockIds });
        let count = 0;
        let cost = 0;
        while (count < 160 && !findSupport(state, nextCarrierId)) {
            const positions = lockIds
                .map(id => state.talents.indexOf(Number(id)))
                .filter(position => position >= 0);
            const washed = engine.wash(state, positions);
            state = orderLocks(washed.state, lockIds);
            count += 1;
            cost += Number(washed.cost) || 0;
        }
        const supportId = findSupport(state, nextCarrierId);
        if (!supportId) return null;
        steps.push({
            op: 'wash',
            keepIds: lockIds,
            count,
            cost,
        });
        pills += cost;
        washes += count;
    }

    const firstLocked = orderLocks(state, lockIds);
    const first = engine.replace(
        firstLocked,
        firstLocked.talents.indexOf(move.carrierId),
        lockIds
    );
    if (Number(first.addedId) === 0) return null;
    state = first.state;
    steps.push({
        op: 'exchange',
        carrierId: move.carrierId,
        lockIds,
        removedId: Number(first.removedId),
        addedId: Number(first.addedId),
    });

    const supportId = findSupport(state, nextCarrierId);
    if (!supportId) return null;
    const secondLocks = [move.conflictId, supportId]
        .filter(id => state.talents.includes(Number(id)));
    const secondLocked = orderLocks(state, secondLocks);
    const second = engine.replace(
        secondLocked,
        secondLocked.talents.indexOf(Number(first.addedId)),
        secondLocks
    );
    if (Number(second.addedId) !== secondId) return null;
    state = second.state;
    steps.push({
        op: 'exchange',
        carrierId: Number(first.addedId),
        lockIds: secondLocks,
        removedId: Number(second.removedId),
        addedId: Number(second.addedId),
    });
    const remainingLocks = Array.from(new Set(
        lockIds.concat(secondLocks)
            .filter(id => state.talents.includes(Number(id)))
    ));
    steps.push({ op: 'locks', lockIds: remainingLocks });
    return Object.assign({}, root, {
        source: 'pity-chain-advance',
        state,
        checkpointRaw: J.checkpointRaw(raw, state),
        lockIds: remainingLocks,
        steps: root.steps.concat(steps),
        pills,
        washes,
        exchanges: Number(root.exchanges || 0) + 2,
        firstExchange: {
            carrierId: move.carrierId,
            conflictId: move.conflictId,
            removedId: Number(first.removedId),
            addedId: Number(first.addedId),
        },
    });
}

function addCandidate(map, candidate, actions) {
    const keptTargetIds = Array.from(new Set(
        (candidate.keptTargetIds || []).map(Number)
    )).sort((a, b) => a - b);
    const checkpoint = candidate.checkpointRaw || {};
    const checkpointKey = [
        Number(checkpoint.seed) || 0,
        Number(checkpoint.luck_seed) || 0,
        checkpoint.luck_seed_inited ? 1 : 0,
        Number(checkpoint.born_talent_rc) || 0,
        Number(checkpoint.tal_lucky) || 0,
        (checkpoint.talents || [])
            .map(item => Number(item && item.id != null ? item.id : item))
            .join(','),
    ].join('|');
    const key = `${candidate.zizhi}:${candidate.seed}:`
        + `${keptTargetIds.join(',')}:`
        + (candidate.exchangeReady ? checkpointKey : '');
    const previous = map.get(key);
    const pills = Number(candidate.preludePills != null
        ? candidate.preludePills : candidate.pills) || 0;
    const washes = Number(candidate.preludeWashes != null
        ? candidate.preludeWashes : candidate.washes) || 0;
    if (!previous
        || pills < previous.pills
        || (pills === previous.pills
            && washes < previous.washes)) {
        map.set(key, Object.assign({}, candidate, {
            pills,
            washes,
            keptTargetIds,
            ignoredTargetIds: Array.from(new Set(
                (candidate.ignoredTargetIds || []).map(Number)
            )).sort((a, b) => a - b),
            targetEvents: (candidate.targetEvents || []).map(
                event => Object.assign({}, event)
            ),
            targetOrder: (candidate.targetOrder || []).map(Number),
            naturalPurplesBeforePity:
                candidate.naturalPurplesBeforePity || [],
            actions: actions.map(item => Object.assign({}, item)),
        }));
    }
    return {
        key,
        isNew: !previous,
    };
}

function seedMergeKey(seed) {
    const checkpoint = seed.checkpointRaw || {};
    return [
        Number(seed.zizhi) || 0,
        Number(seed.seed) || 0,
        (seed.keptTargetIds || []).map(Number).sort((a, b) =>
            a - b
        ).join(','),
        Number(checkpoint.seed) || 0,
        Number(checkpoint.luck_seed) || 0,
        checkpoint.luck_seed_inited ? 1 : 0,
        Number(checkpoint.born_talent_rc) || 0,
        Number(checkpoint.tal_lucky) || 0,
        (checkpoint.talents || []).map(item =>
            Number(item && item.id != null ? item.id : item)
        ).join(','),
    ].join('|');
}

function mergeCoverageFirst(boundarySeeds, legacySeeds) {
    const merged = new Map();
    const stats = {
        boundarySeeds: boundarySeeds.length,
        legacySeeds: legacySeeds.length,
        duplicates: 0,
        boundaryPreferred: 0,
        legacyPreferred: 0,
    };
    const add = seed => {
        const key = seedMergeKey(seed);
        const previous = merged.get(key);
        if (!previous) {
            merged.set(key, seed);
            return;
        }
        stats.duplicates += 1;
        const pills = Number(seed.preludePills != null
            ? seed.preludePills : seed.pills) || 0;
        const prevPills = Number(previous.preludePills != null
            ? previous.preludePills : previous.pills) || 0;
        const washes = Number(seed.preludeWashes != null
            ? seed.preludeWashes : seed.washes) || 0;
        const prevWashes = Number(previous.preludeWashes != null
            ? previous.preludeWashes : previous.washes) || 0;
        if (pills < prevPills || (pills === prevPills
            && washes < prevWashes)) {
            merged.set(key, seed);
            if (seed.seedSource === 'boundary-landing') {
                stats.boundaryPreferred += 1;
            } else {
                stats.legacyPreferred += 1;
            }
        } else if (previous.seedSource === 'boundary-landing') {
            stats.boundaryPreferred += 1;
        } else {
            stats.legacyPreferred += 1;
        }
    };
    legacySeeds.forEach(add);
    boundarySeeds.forEach(add);
    return {
        seeds: Array.from(merged.values()),
        stats,
    };
}

function discoverPitySeedFrontier(raw, options) {
    const o = options || {};
    if (!raw || raw.luck_seed_inited) {
        throw new Error('种子前沿要求 luck_seed_inited=false');
    }
    const context = o.context || loadAWash();
    if (o.boundaryLanding === true) {
        const boundary = BoundaryFrontier.discoverBoundaryLandings(
            raw,
            Object.assign({}, o, { context })
        );
        const boundarySeeds = boundary.results.map(item =>
            Object.assign({}, item, {
                seedSource: 'boundary-landing',
                firstPityId: item.pityId,
                preludeWashes: item.washes,
                preludePills: item.pills,
                checkpointRaw: J.checkpointRaw(raw, item.state),
                jumpsTo: [Number(item.dropCount) || 0],
                actualJumps: Number(item.dropCount) || 0,
                keptTargetIds: [],
                ignoredTargetIds: [],
                targetEvents: [],
                targetOrder: (o.targetOrder || o.targetIds || [])
                    .map(Number),
            })
        );
        for (const item of boundary.landingSeeds || []) {
            boundarySeeds.push({
                zizhi: Number(item.zizhi),
                seed: Number(item.seed),
                firstPityId: Number(item.pityId),
                pityId: Number(item.pityId),
                preludePills: Number(item.pills) || 0,
                preludeWashes: Number(item.wash) || 0,
                pills: Number(item.pills) || 0,
                washes: Number(item.wash) || 0,
                checkpointRaw: item.checkpointRaw,
                actions: (item.actions || []).map(action =>
                    Object.assign({}, action)
                ),
                keptTargetIds: [],
                ignoredTargetIds: [],
                targetEvents: [],
                targetOrder: (o.targetOrder || o.targetIds || [])
                    .map(Number),
                seedSource: 'landing-search',
                landingSearchExpanded:
                    Number(item.expanded) || 0,
                landingSearchLocks:
                    Number(item.usedLocks) || 0,
            });
        }
        const legacy = discoverPitySeedFrontier(
            raw,
            Object.assign({}, o, {
                context,
                boundaryLanding: false,
            })
        );
        const legacySeeds = (legacy.seeds || []).map(seed =>
            Object.assign({}, seed, {
                seedSource: seed.seedSource || 'legacy-pity',
            })
        );
        const merged = mergeCoverageFirst(
            boundarySeeds, legacySeeds
        );
        return {
            ok: boundary.ok || legacy.ok,
            seeds: merged.seeds,
            chains: boundary.chains,
            truncated: boundary.truncated,
            metrics: Object.assign({}, boundary.metrics, {
                searchMode: 'hybrid-boundary-landing',
                distinctSeeds: merged.seeds.length,
                cacheHit: false,
                merge: merged.stats,
                legacyMetrics: legacy.metrics,
            }),
        };
    }
    const sessionCache = o.cache
        && typeof o.cache.get === 'function'
        && typeof o.cache.set === 'function'
        ? o.cache : null;
    const cacheKey = sessionCache ? frontierCacheKey(raw, o) : '';
    if (sessionCache && sessionCache.has(cacheKey)) {
        const cached = sessionCache.get(cacheKey);
        return Object.assign({}, cached, {
            metrics: Object.assign(
                {}, cached.metrics || {},
                { cacheHit: true, cacheKey }
            ),
        });
    }
    const zizhiList = Array.isArray(o.zizhiList)
        ? o.zizhiList.map(Number) : [153, 154];
    const maxRounds = Math.max(1, Number(o.maxRounds) || 4);
    const boundarySpan = Math.max(
        1, Number(o.boundarySpan) || 16
    );
    const maxSeeds = Number(o.maxSeeds) > 0
        ? Number(o.maxSeeds) : 500;
    const upperBoundPills = Number(o.upperBoundPills) > 0
        ? Number(o.upperBoundPills) : Infinity;
    const runOptions = Object.assign({}, o, {
        maxPills: upperBoundPills,
    });
    const targetOrder = Array.from(new Set(
        (o.targetOrder || o.targetIds || []).map(Number)
    ));
    const targetIds = Array.from(new Set(
        (o.targetIds || []).map(Number)
    ));
    const candidates = new Map();
    const metrics = {
        exploredSchedules: 0,
        snapshotPrefixHits: 0,
        mutationSnapshotHits: 0,
        postMutationStateHits: 0,
        prefixReplayBuilds: 0,
        newSeedsByRound: [],
        targetBranches: 0,
        preludePruned: 0,
        truncated: false,
    };
    const postMutationCache = new Map();
    const postMutationKey = (run, pinIds, actions, fromWash) => [
        Number(run.zizhi) || 0,
        (pinIds || []).map(Number).sort((a, b) => a - b).join(','),
        Number(run.state && run.state.bornSeed) || 0,
        Number(run.state && run.state.luckSeed) || 0,
        Number(run.state && run.state.bornRC) || 0,
        Number(run.state && run.state.talLucky) || 0,
        (run.state && run.state.talents || []).map(Number).join(','),
        (run.naturalPurples || []).map(event =>
            `${Number(event.wash)}:${Number(event.id)}`).join(','),
        (run.targetEvents || []).map(event =>
            `${Number(event.wash)}:${Number(event.id)}`).join(','),
        Array.from(run.lostPinIds || []).map(Number)
            .sort((a, b) => a - b).join(','),
        (actions || []).filter(action =>
            Number(action.wash) > Number(fromWash))
            .map(action => `${Number(action.wash)}:${Number(action.position)}`)
            .join(';'),
    ].join('|');
    const addScheduleBranches = (base, actions) => {
        const events = (base.targetEvents
            || base.naturalPurplesBeforePity || [])
            .filter(event => targetIds.includes(Number(event.id)));
        const branches = targetIds.length
            ? expandTargetPinBranches(events, targetOrder, targetIds)
            : [{ keptTargetIds: [], terminal: false }];
        const keys = [];
        for (const branch of branches) {
            if (candidates.size >= maxSeeds) {
                metrics.truncated = true;
                break;
            }
            let candidate = base;
            if (branch.keptTargetIds.length) {
                candidate = runSchedule(
                    context,
                    raw,
                    base.zizhi,
                    actions,
                    Object.assign({}, runOptions, {
                        targetIds,
                        pinIds: branch.keptTargetIds,
                    })
                );
                if (!candidate) continue;
                if (!branch.keptTargetIds.every(id =>
                    candidate.keptTargetIds.includes(id)
                )) {
                    continue;
                }
            }
            const keptTargetIds = Array.from(new Set(
                (candidate.keptTargetIds || []).map(Number)
            ));
            const seenTargetIds = Array.from(new Set(
                (candidate.targetEvents || events)
                    .map(event => Number(event.id))
            ));
            const fieldIds = new Set(
                ((candidate.checkpointRaw || {}).talents || [])
                    .map(item => Number(item && item.id != null
                        ? item.id : item))
            );
            candidate = Object.assign({}, candidate, {
                targetIds: targetIds.slice(),
                targetOrder: targetOrder.slice(),
                keptTargetIds,
                exchangeReady: candidate.state
                    ? !!exchangeReadyMove(
                        context, raw, candidate.state, targetIds,
                        candidate.engine
                    ) : !!candidate.exchangeReady,
                ignoredTargetIds: seenTargetIds.filter(id =>
                    !keptTargetIds.includes(id)
                ),
                targetEvents: (candidate.targetEvents || events)
                    .map(event => Object.assign({}, event)),
                terminal: targetIds.length > 0
                    && targetIds.every(id => fieldIds.has(id)),
            });
            const branchPills = Number(candidate.preludePills
                != null ? candidate.preludePills : candidate.pills) || 0;
            const branchWashes = Number(candidate.preludeWashes
                != null ? candidate.preludeWashes : candidate.washes) || 0;
            if (branchPills > upperBoundPills) {
                metrics.preludePruned += 1;
                continue;
            }
            candidate.branchKey = `keep:${keptTargetIds.slice()
                .sort((a, b) => a - b).join(',')}`
                + `:${candidate.terminal ? 'terminal' : 'search'}`
                + `:${branchPills}/${branchWashes}`;
            const added = addCandidate(candidates, candidate, actions);
            metrics.targetBranches += 1;
            keys.push({
                key: added.key,
                isNew: added.isNew,
                terminal: !!(candidates.get(added.key) || {}).terminal,
            });
        }
        return keys;
    };

    const seedRoots = [];
    const engines = new Map();
    for (const zizhi of zizhiList) {
        const enumerated = J.enumerateJumpSeeds(
            raw, Object.assign(
                { allowLongLock: o.allowLongLock === true },
                o,
                { context, zizhi }
            )
        );
        for (const seed of enumerated.seeds) {
            const added = addScheduleBranches(
                seed,
                seed.actions || seed.jumpsUsed || []
            );
            for (const item of added) {
                if (!item.terminal) {
                    seedRoots.push(candidates.get(item.key));
                }
            }
        }
    }

    let frontier = seedRoots.slice();
    for (let round = 0;
        round < maxRounds && frontier.length
        && candidates.size < maxSeeds;
        round++) {
        const before = candidates.size;
        const next = [];
        for (const node of frontier) {
            const slots = Number(
                context.ZZ_DATA[String(node.zizhi)].num_talent
            );
            const usedWashes = new Set(
                node.actions.map(action => Number(action.wash))
            );
            const start = Math.max(
                1, node.washes - boundarySpan
            );
            const baseActions = new Map();
            for (const action of node.actions) {
                baseActions.set(Number(action.wash), action);
            }
            const runOptionsForNode = Object.assign({}, runOptions, {
                targetIds,
                pinIds: node.keptTargetIds || [],
                engine: engines.has(node.zizhi)
                    ? engines.get(node.zizhi)
                    : (() => {
                        const engine = J.engineFor(
                            context, raw, node.zizhi
                        );
                        engines.set(node.zizhi, engine);
                        return engine;
                    })(),
            });
            const snapshotRun = createScheduleRunFromSnapshot(
                context,
                raw,
                node,
                runOptionsForNode,
                start
            );
            const baseRun = snapshotRun || createScheduleRun(
                context,
                raw,
                node.zizhi,
                runOptionsForNode
            );
            if (snapshotRun) metrics.snapshotPrefixHits += 1;
            else metrics.prefixReplayBuilds += 1;
            if (!advanceScheduleTo(baseRun, baseActions, start - 1)) {
                continue;
            }
            for (let wash = start; wash <= node.washes; wash++) {
                if (!usedWashes.has(wash)) {
                    const runAtWash = createScheduleRunFromSnapshot(
                        context,
                        raw,
                        node,
                        runOptionsForNode,
                        wash
                    );
                    if (runAtWash) metrics.mutationSnapshotHits += 1;
                    for (let position = 0;
                        position < slots; position++) {
                        if (candidates.size >= maxSeeds) {
                            metrics.truncated = true;
                            break;
                        }
                        const mutation = {
                            wash,
                            position,
                            source: 'boundary-mutation',
                        };
                        const actions = node.actions.concat([mutation]);
                        const branchActions = new Map(baseActions);
                        branchActions.set(wash, mutation);
                        const mutationRun = forkScheduleRun(
                            runAtWash || baseRun
                        );
                        const mutationPity = stepScheduleRun(
                            mutationRun, branchActions
                        );
                        let found = mutationPity
                            ? scheduleResult(mutationRun, actions)
                            : null;
                        if (!mutationPity && !mutationRun.pillLimitReached) {
                            const stateKey = postMutationKey(
                                mutationRun,
                                node.keptTargetIds || [],
                                actions,
                                wash
                            );
                            if (postMutationCache.has(stateKey)) {
                                found = postMutationCache.get(stateKey);
                                metrics.postMutationStateHits += 1;
                            } else {
                                found = finishScheduleRun(
                                    mutationRun,
                                    branchActions,
                                    actions
                                );
                                postMutationCache.set(stateKey, found);
                            }
                        }
                        metrics.exploredSchedules += 1;
                        if (!found) continue;
                        const added = addScheduleBranches(
                            found, actions
                        );
                        for (const item of added) {
                            if (item.terminal) continue;
                            if (item.isNew) {
                                next.push(candidates.get(item.key));
                            }
                        }
                    }
                }
                if (candidates.size >= maxSeeds) break;
                if (stepScheduleRun(baseRun, baseActions)) break;
                if (baseRun.pillLimitReached) break;
            }
            if (candidates.size >= maxSeeds) break;
        }
        metrics.newSeedsByRound.push(candidates.size - before);
        frontier = next;
    }

    const result = {
        ok: true,
        seeds: Array.from(candidates.values()),
        metrics: Object.assign({}, metrics, {
            distinctSeeds: candidates.size,
            naturalPurpleSeeds: Array.from(candidates.values())
                .filter(item =>
                    item.naturalPurplesBeforePity.length > 0
                ).length,
            cacheHit: false,
            cacheKey,
        }),
    };
    if (sessionCache) {
        sessionCache.set(cacheKey, result);
    }
    return result;
}

function discoverPitySeedFrontierAsync(raw, options) {
    const o = options || {};
    const zizhiList = Array.isArray(o.zizhiList)
        ? o.zizhiList.map(Number) : [153, 154];
    const workerOptions = Object.assign({}, o);
    delete workerOptions.context;
    delete workerOptions.cache;
    const tasks = zizhiList.map(zizhi => new Promise((resolve, reject) => {
        const worker = new Worker(FRONTIER_WORKER, {
            workerData: {
                raw,
                options: workerOptions,
                zizhi,
            },
        });
        let settled = false;
        const finish = callback => value => {
            if (settled) return;
            settled = true;
            callback(value);
            worker.terminate().catch(() => {});
        };
        worker.once('message', message => {
            if (!message || !message.ok) {
                finish(reject)(new Error(
                    message && message.error || 'pity frontier worker failed'
                ));
                return;
            }
            finish(resolve)(message.result);
        });
        worker.once('error', finish(reject));
    }));
    return Promise.all(tasks).then(results => {
        const seeds = results.flatMap(result => result.seeds || []);
        const merged = mergeCoverageFirst([], seeds);
        return {
            ok: results.some(result => result.ok),
            seeds: merged.seeds,
            chains: results.flatMap(result => result.chains || []),
            truncated: results.some(result => result.truncated),
            metrics: {
                searchMode: 'parallel-hybrid-boundary-landing',
                workers: results.length,
                distinctSeeds: merged.seeds.length,
                merge: merged.stats,
                byZizhi: results.map(result => result.metrics),
            },
        };
    }).catch(() => discoverPitySeedFrontier(raw, options));
}

if (require.main === module) {
    const fs = require('fs');
    const path = require('path');
    const savePath = U.findSavePath(path.join(
        __dirname,
        '..',
        'output',
        '存档',
        'ios-s20-将进酒',
        '20261111-092203'
    ));
    const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));
    const selected = U.selectRole(U.collectRoles(save), '步惊云');
    const meta = JSON.parse(fs.readFileSync(
        path.join(path.dirname(savePath), 'dat.meta.json'),
        'utf8'
    ));
    const raw = U.buildRaw(save, selected.role, meta, 1);
    const result = discoverPitySeedFrontier(raw, {
        zizhiList: [153, 154],
        maxRounds: Number(process.argv[2]) || 6,
        boundarySpan: Number(process.argv[3]) || 16,
    });
    console.log(JSON.stringify(result, null, 2));
}

module.exports = {
    discoverPitySeedFrontier,
    discoverPitySeedFrontierAsync,
    mergeCoverageFirst,
    expandTargetPinBranches,
    materializePityRoot,
    advanceExchangeReadyRoot,
    runSchedule,
};
