#!/usr/bin/env node
'use strict';

const { loadAWash } = require('./context');
const RolePlanner = require('./role_planner');
const Sequence = require('./sequence');
const PityFrontier = require('./pity_seed_frontier');
const { findInitialRoutes } = require('./fixed_chain_initial_route');
const {
    solveSeedCheckpointQuality,
} = require('./seed_checkpoint_quality');
const {
    indexPitySeedChains,
} = require('./seed_chain_order');

function compareRoute(a, b) {
    for (const field of ['pills', 'washes', 'exchanges']) {
        const difference = Number(a && a[field] || 0)
            - Number(b && b[field] || 0);
        if (difference) return difference;
    }
    return 0;
}

function targetOrderCandidates(targets, limit) {
    const ids = Array.from(new Set((targets || []).map(Number)));
    if (ids.length < 2) return [ids];
    const out = [ids];
    const reversed = ids.slice().reverse();
    if (reversed.join(',') !== ids.join(',')) out.push(reversed);
    // Rotations cover the common case where one purple is much cheaper as
    // the first carrier without exploding into all factorial permutations.
    for (let index = 1; index < ids.length && out.length < (limit || 3); index++) {
        const rotated = ids.slice(index).concat(ids.slice(0, index));
        if (!out.some(item => item.join(',') === rotated.join(','))) out.push(rotated);
    }
    return out.slice(0, limit || 3);
}

function normalizeCheckpoint(packet) {
    return Object.assign({}, packet, {
        prefixPills: Math.max(
            0,
            Number(packet.prefixPills != null
                ? packet.prefixPills : packet.prefixCost) || 0
        ),
        prefixWashes: Math.max(0, Number(packet.prefixWashes) || 0),
        prefixSteps: Array.isArray(packet.prefixSteps)
            ? packet.prefixSteps.slice() : [],
    });
}

function currentZizhiList(raw) {
    const zizhi = Number(raw && raw.zizhi) || 153;
    return [zizhi >= 154 ? 154 : 153];
}

function pityZizhiList(raw) {
    return (Number(raw && raw.zizhi) || 153) >= 154
        ? [154] : [153, 154];
}

function productionPityFrontierOptions(
    raw, targets, context, options
) {
    const frontierOptions = options || {};
    return Object.assign({
        boundaryLanding: true,
        maxStates: 200,
    }, frontierOptions, {
        context,
        targetIds: targets,
        targetOrder: targets,
        zizhiList: frontierOptions.zizhiList
            || pityZizhiList(raw),
    });
}

function filterPitySeedsForRole(raw, seeds) {
    const startsFour = (Number(raw && raw.zizhi) || 153) >= 154;
    return (seeds || []).filter(seed => {
        const zizhi = Number(seed.zizhi);
        if (startsFour) return zizhi === 154;
        if (zizhi === 153) {
            return (seed.keptTargetIds || []).length === 0;
        }
        return zizhi === 154;
    });
}

function classifyInfiniteSeedPackets(packets, raw) {
    const baseByKey = new Map();
    const lockOneByKey = new Map();
    const slotZizhi = currentZizhiList(raw)[0];
    for (const packet of packets || []) {
        if (!packet || !packet.checkpointRaw) continue;
        const zizhi = Number(packet.checkpointRaw.zizhi)
            || (Number(packet.slots) === 4 ? 154 : 153);
        const pins = (packet.pinTargetIds || [])
            .map(Number).sort((a, b) => a - b);
        let key;
        if (slotZizhi === 153) {
            if (zizhi === 153 && pins.length === 0) {
                key = `${zizhi}:${Number(packet.seed)}`;
                const previous = baseByKey.get(key);
                const pills = Number(packet.prefixPills != null
                    ? packet.prefixPills : packet.prefixCost) || 0;
                if (!previous
                    || pills < previous._pills
                    || (pills === previous._pills
                        && (Number(packet.prefixWashes) || 0)
                            < previous._washes)) {
                    baseByKey.set(key, Object.assign({}, packet, {
                        _pills: pills,
                        _washes: Number(packet.prefixWashes) || 0,
                    }));
                }
            } else if (zizhi === 154 && pins.length === 1) {
                // Four slots with one kept target advance one bar per wash,
                // exactly matching the three-slot seed cadence while
                // preserving a target before the exchange.
                key = `${zizhi}:${Number(packet.seed)}:${pins[0]}`;
                const previous = lockOneByKey.get(key);
                const pills = Number(packet.prefixPills != null
                    ? packet.prefixPills : packet.prefixCost) || 0;
                if (!previous
                    || pills < previous._pills
                    || (pills === previous._pills
                        && (Number(packet.prefixWashes) || 0)
                            < previous._washes)) {
                    lockOneByKey.set(key, Object.assign({}, packet, {
                        _pills: pills,
                        _washes: Number(packet.prefixWashes) || 0,
                    }));
                }
            } else {
                continue;
            }
        } else {
            if (zizhi !== 154) continue;
            key = `${zizhi}:${Number(packet.seed)}:`
                + `${Math.abs(Number(packet.advanceBars) || 0) % 2}:`
                + pins.join(',');
            const target = pins.length === 0
                ? baseByKey : pins.length === 1
                    ? lockOneByKey : null;
            if (!target) continue;
            const previous = target.get(key);
            const pills = Number(packet.prefixPills != null
                ? packet.prefixPills : packet.prefixCost) || 0;
            if (!previous
                || pills < previous._pills
                || (pills === previous._pills
                    && (Number(packet.prefixWashes) || 0)
                        < previous._washes)) {
                target.set(key, Object.assign({}, packet, {
                    _pills: pills,
                    _washes: Number(packet.prefixWashes) || 0,
                }));
            }
            continue;
        }
    }
    const clean = packet => {
        const copy = Object.assign({}, packet);
        delete copy._pills;
        delete copy._washes;
        return copy;
    };
    const base = Array.from(baseByKey.values()).map(clean);
    const chainBySeed = new Map();
    for (const packet of base) {
        if (!chainBySeed.has(Number(packet.seed))) {
            chainBySeed.set(Number(packet.seed), packet.chain);
        }
    }
    const lockedOne = Array.from(lockOneByKey.values())
        .map(clean)
        .map(packet => {
            const baseChain = chainBySeed.get(Number(packet.seed));
            return Object.assign({}, packet, {
                chain: baseChain
                    ? baseChain.slice() : packet.chain,
                variantOfSeed: baseChain
                    ? Number(packet.seed) : null,
                reusesBaseSeed: !!baseChain,
            });
        });
    return {
        base,
        lockedOne,
        all: base.concat(lockedOne),
    };
}

function selectInfiniteSeedPackets(packets, raw) {
    return classifyInfiniteSeedPackets(packets, raw).all;
}

function checkpointEngineState(context, checkpointRaw) {
    const zi = Number(checkpointRaw.zizhi);
    const zz = context.ZZ_DATA && context.ZZ_DATA[String(zi)];
    if (!zz || !context.WashSourceEngine
        || typeof context.WashSourceEngine.Engine !== 'function') {
        throw new Error('无限置换检查点缺少洗脉引擎或资质数据');
    }
    const engine = new context.WashSourceEngine.Engine(
        context.TALENT_DATA,
        checkpointRaw,
        {
            slotCount: Number(zz.num_talent),
            pity: Number(zz.bd_zz),
            eat: Number(zz.eat_xisui),
            eligibleZi: zi,
            advancePerDraw: true,
            dlcMode: !!checkpointRaw.dlc_mode,
        }
    );
    return engine.initialState(checkpointRaw);
}

function materializeInfiniteRoot(context, raw, targets, packet) {
    const item = normalizeCheckpoint(packet);
    const checkpointRaw = item.checkpointRaw;
    if (!checkpointRaw) {
        throw new Error('无限置换种子包缺少 checkpointRaw');
    }
    const checkpointState = checkpointEngineState(
        context,
        checkpointRaw
    );
    const state = item.checkpointState || checkpointState;
    const expectedStateKey = context.WashSourceEngine.stateKey(state);
    if (context.WashSourceEngine.stateKey(checkpointState)
        !== expectedStateKey) {
        throw new Error('无限置换种子包状态与 checkpointRaw 不一致');
    }
    if (!item.checkpointState) {
        const replayed = context.WashSearchV2.replay(
            raw,
            targets,
            item.prefixSteps
        );
        if (replayed.finalStateKey !== expectedStateKey
            || replayed.pills !== item.prefixPills
            || replayed.washes !== item.prefixWashes) {
            throw new Error(
                '无限置换前缀与 checkpointRaw 不一致'
            );
        }
    }
    const zi = Number(checkpointRaw.zizhi);
    const pins = (item.pinTargetIds || []).map(Number);
    return {
        source: 'infinite-exchange',
        zizhi: zi,
        seed: Number(checkpointRaw.luck_seed),
        pills: item.prefixPills,
        washes: item.prefixWashes,
        exchanges: Math.max(1, Number(item.exchanges) || 1),
        steps: item.prefixSteps,
        state,
        lockIds: pins.filter(id => state.talents.includes(id)),
        keptTargetIds: pins,
        pinTargetIds: pins,
        seedChain: Array.isArray(item.chain) ? item.chain.slice() : [],
        checkpointRaw,
        anchor: item.anchor || null,
        advanceBars: Number(item.advanceBars) || 0,
    };
}

function materializePityRoots(context, raw, candidate, targets, options) {
    const base = PityFrontier.materializePityRoot(
        context,
        raw,
        candidate,
        targets,
        options
    );
    const root = Object.assign({}, base, {
        source: 'pity',
        checkpointRaw: candidate.checkpointRaw,
        seedChain: Array.isArray(candidate.chain)
            ? candidate.chain.slice() : [],
        pinTargetIds: (candidate.keptTargetIds || []).slice(),
    });
    const advanced = PityFrontier.advanceExchangeReadyRoot(
        context,
        raw,
        candidate,
        targets,
        options
    );
    return advanced
        ? [root, Object.assign({}, advanced, {
            seedChain: Array.isArray(candidate.chain)
                ? candidate.chain.slice() : [],
        })]
        : [root];
}

function checkpointFromRoot(root) {
    if (!root || !root.checkpointRaw) return null;
    return {
        source: String(root.source || 'seed'),
        raw: root.checkpointRaw,
        pills: Math.max(0, Number(root.pills) || 0),
        washes: Math.max(0, Number(root.washes) || 0),
        exchanges: Math.max(0, Number(root.exchanges) || 0),
        steps: Array.isArray(root.steps) ? root.steps.slice() : [],
        seedChain: Array.isArray(root.seedChain)
            ? root.seedChain.slice() : [],
        pinTargetIds: Array.isArray(root.pinTargetIds)
            ? root.pinTargetIds.slice()
            : (Array.isArray(root.keptTargetIds)
                ? root.keptTargetIds.slice() : []),
    };
}

function actualSlotCount(context, raw) {
    const zizhi = Number(raw && raw.zizhi) || 153;
    return Number(context.ZZ_DATA && context.ZZ_DATA[String(zizhi)]
        && context.ZZ_DATA[String(zizhi)].num_talent) || 0;
}

function attachRouteStepStates(context, raw, targets, result) {
    const route = result && result.route;
    if (!route || !Array.isArray(route.steps)) return result;
    try {
        const replayed = context.WashSearchV2.replay(
            raw, targets, route.steps, true
        );
        if (!replayed.ok || replayed.trace.length !== route.steps.length
            || replayed.pills !== Number(route.pills)
            || replayed.washes !== Number(route.washes)) return result;
        route.steps = route.steps.map((step, index) => Object.assign({}, step, {
            after: replayed.trace[index],
        }));
        route.finalTalents = replayed.trace.length
            ? replayed.trace[replayed.trace.length - 1].talents : [];
    } catch (_) { /* Keep the independently verified route if display replay fails. */ }
    return result;
}

async function solveJoint(raw, targetIds, options) {
    const o = options || {};
    const context = o.context || loadAWash();
    const sourceRaw = raw;
    const sourceZizhi = Number(raw && raw.zizhi) || 153;
    const upgradeLowSlot = actualSlotCount(context, raw) < 3;
    const originalLowSlotRaw = upgradeLowSlot
        ? Object.assign({}, raw, { talents: (raw.talents || []).map(item =>
            Object.assign({}, item)) }) : null;
    let selectedLowSlotRoute = false;
    if (upgradeLowSlot) {
        // Search low-slot roles through the full checkpoint-quality pipeline.
        // Its seed/pity frontiers operate on the three-slot state used after
        // the free aptitude upgrade, while the result is replayed from sourceRaw.
        raw = Object.assign({}, raw, { zizhi: 153 });
    }
    const sessionCache = o.sessionCache
        && typeof o.sessionCache.get === 'function'
        && typeof o.sessionCache.set === 'function'
        ? o.sessionCache : new Map();
    const targets = Array.from(new Set(
        (targetIds || []).map(Number)
    ));
    let plan = o.plan || null;
    let firstMethod = plan && Array.isArray(plan.methodOrder)
        ? String(plan.methodOrder[0] || '') : '';
    let fixedRoot = null;
    let pityRoots = [];
    let infiniteRoots = [];
    let infiniteBaseRoots = [];
    let infiniteLockedOneRoots = [];
    const infinitePackets = [];
    let frontierSeeds = 0;
    let pityPreludePruned = 0;
    let infiniteFrontierSeeds = 0;
    let pityCandidates = [];
    let pityFrontierMetrics = null;
    let preliminaryInfiniteResult = null;
    let lockOneInfiniteResult = null;
    let infinitePhaseComplete = false;
    const infiniteMaterializationErrors = [];
    const sequenceMetrics = {
        cacheHits: 0,
        reads: 0,
    };
    const backendHorizon = Number(o.horizon) || 2000;
    // 0 表示还没有路线上界；资源节点/时长限制仍然生效。
    let sharedUpperBoundPills = 0;
    const qualityRequested = !!o.pityQuality
        || !!o.seedQuality;
    let nativePityQuality = qualityRequested;

    async function runCheckpointQuality(roots, overrides) {
        if (!roots || !roots.length) {
            return null;
        }
        const options = overrides || {};
        const checkpoints = roots
            .map(checkpointFromRoot)
            .filter(Boolean);
        if (!checkpoints.length) return null;
        const backend = typeof o.checkpointBackend === 'function'
            ? o.checkpointBackend
            : (items, wanted, backendOptions) =>
                solveSeedCheckpointQuality(
                    raw,
                    items,
                    wanted,
                    backendOptions
                );
        const requestedBudget = options.budget == null
            ? (sharedUpperBoundPills > 0
                ? sharedUpperBoundPills
                : Number(o.budget) || 0)
            : Number(options.budget) || 0;
        const orders = options.targetOrders || targetOrderCandidates(
            targets, Number(o.targetOrderCandidates) || 3
        );
        let best = null;
        for (const targetOrder of orders) {
            const candidate = await backend(
                checkpoints,
                targets,
                {
                budget: requestedBudget > 0 ? requestedBudget : 0,
                concurrency: Number(o.concurrency) || 16,
                horizon: backendHorizon,
                limits: o.limits || {},
                runtime: o.runtime || {},
                sessionCache,
                targetOrder,
                adaptiveHorizon: o.adaptiveHorizon !== false,
                }
            );
            if (candidate && candidate.route
                && (!best || compareRoute(candidate.route, best.route) < 0)) {
                best = candidate;
                if (Number(candidate.route.pills) > 0) {
                    sharedUpperBoundPills = Math.min(
                        sharedUpperBoundPills > 0
                            ? sharedUpperBoundPills : Infinity,
                        Number(candidate.route.pills)
                    );
                }
            }
        }
        return best;
    }
    if (raw && raw.luck_seed_inited) {
        plan = plan || {
            methodOrder: ['fixed-current-chain'],
            preferredMethod: 'fixed-current-chain',
            allowsInfiniteExchange: false,
            allowsPity: false,
        };
        fixedRoot = {
            source: 'fixed-current-chain',
            checkpointRaw: raw,
            zizhi: Number(raw.zizhi),
            seed: Number(raw.luck_seed),
            pills: Math.max(0, Number(o.spentPills) || 0),
            washes: Math.max(0, Number(o.spentWashes) || 0),
            exchanges: Math.max(0, Number(o.spentExchanges) || 0),
            steps: Array.isArray(o.prefixSteps)
                ? o.prefixSteps.slice() : [],
            pinTargetIds: [],
            seedChain: [],
        };
    } else if (raw) {
        if (!plan) {
            const sequenceCacheKey = `awash:sequence-plan:${JSON.stringify({
                seed: raw.seed,
                luck_seed: raw.luck_seed,
                luck_seed_inited: !!raw.luck_seed_inited,
                born_talent_rc: raw.born_talent_rc,
                tal_lucky: raw.tal_lucky,
                zizhi: raw.zizhi,
                dlc_mode: !!raw.dlc_mode,
                talents: (raw.talents || []).map(item => ({
                    id: Number(item && item.id != null ? item.id : item),
                    locked: !!(item && item.locked),
                })),
            })}`;
            let sequence = sessionCache.get(sequenceCacheKey);
            if (sequence) {
                sequenceMetrics.cacheHits += 1;
            } else {
                sequenceMetrics.reads += 1;
                sequence = Sequence.readSequence(raw, {
                    context,
                    zi: Number(raw.zizhi) || 153,
                    count: Number(o.count) || 40,
                    cache: sessionCache,
                });
                sessionCache.set(sequenceCacheKey, sequence);
            }
            plan = RolePlanner.selectPlan(raw, sequence, {
                context,
            });
        }
        const methods = plan && Array.isArray(plan.methodOrder)
            ? plan.methodOrder : [];
        firstMethod = String(methods[0] || '');
        nativePityQuality = qualityRequested
            || (methods.length === 1 && methods[0] === 'pity');
        const collectQualityRoots = nativePityQuality
            || methods.includes('infinite-exchange');
        if (collectQualityRoots && methods.includes('infinite-exchange')) {
            const collectInfinite = settings =>
                context.InfiniteSeedFrontier.enumerate(
                    raw,
                    targets,
                    Object.assign({
                        nMax: 100,
                        count: 30,
                        sequenceCache: sessionCache,
                    }, settings, {
                        onSeed(packet) {
                            if (!packet) return;
                            infiniteFrontierSeeds++;
                            infinitePackets.push(packet);
                        },
                    })
                );
            collectInfinite(o.infiniteOptions || {});
            // Adaptive frontier widening: only pay for the larger anchor
            // scan when the normal pass produced no usable seed packets.
            if (!infinitePackets.length
                && o.adaptiveFrontier !== false) {
                collectInfinite(Object.assign(
                    {},
                    o.infiniteOptions || {},
                    { nMax: 300, count: 60 }
                ));
            }
            const batches = classifyInfiniteSeedPackets(
                infinitePackets, raw
            );
            const materialize = (packets, output) => {
                for (const packet of packets) {
                    try {
                        output.push(materializeInfiniteRoot(
                            context,
                            raw,
                            targets,
                            packet
                        ));
                    } catch (error) {
                        infiniteMaterializationErrors.push(
                            String(error && error.message || error)
                        );
                    }
                }
            };
            materialize(batches.base, infiniteBaseRoots);
            materialize(
                batches.lockedOne,
                infiniteLockedOneRoots
            );
            infiniteRoots = infiniteBaseRoots.concat(
                infiniteLockedOneRoots
            );
        }
        if (firstMethod === 'infinite-exchange'
            && (infiniteBaseRoots.length
                || infiniteLockedOneRoots.length)) {
            infinitePhaseComplete = true;
            if (infiniteBaseRoots.length) {
                preliminaryInfiniteResult =
                    await runCheckpointQuality(
                        infiniteBaseRoots,
                        {
                            budget: 0,
                        }
                    );
                if (preliminaryInfiniteResult
                    && preliminaryInfiniteResult.ok
                    && preliminaryInfiniteResult.route) {
                    sharedUpperBoundPills = Math.min(
                        sharedUpperBoundPills > 0
                            ? sharedUpperBoundPills
                            : Infinity,
                        Number(
                            preliminaryInfiniteResult.route.pills
                        ) || Infinity
                    );
                }
            }
            if (infiniteLockedOneRoots.length) {
                lockOneInfiniteResult =
                    await runCheckpointQuality(
                        infiniteLockedOneRoots,
                        {
                            budget:
                                sharedUpperBoundPills > 0
                                    ? sharedUpperBoundPills
                                    : 0,
                        }
                    );
                if (lockOneInfiniteResult
                    && lockOneInfiniteResult.ok
                    && lockOneInfiniteResult.route) {
                    sharedUpperBoundPills = Math.min(
                        sharedUpperBoundPills > 0
                            ? sharedUpperBoundPills
                            : Infinity,
                        Number(lockOneInfiniteResult.route.pills)
                            || Infinity
                    );
                    if (!preliminaryInfiniteResult
                        || !preliminaryInfiniteResult.ok
                        || compareRoute(
                            lockOneInfiniteResult.route,
                            preliminaryInfiniteResult.route
                        ) < 0) {
                        preliminaryInfiniteResult =
                            lockOneInfiniteResult;
                    }
                }
            }
        }
        const shouldCollectPity = nativePityQuality
            || (methods.includes('infinite-exchange')
                && !infiniteRoots.length);
        if (shouldCollectPity && methods.includes('pity')) {
            const frontierOptions =
                productionPityFrontierOptions(
                    raw, targets, context, o.frontierOptions
                );
            const pityOptions = Object.assign({}, frontierOptions, {
                    cache: sessionCache,
                    upperBoundPills:
                        Number.isFinite(sharedUpperBoundPills)
                        && sharedUpperBoundPills > 0
                            ? sharedUpperBoundPills
                            : Number(o.frontierOptions
                                && o.frontierOptions.upperBoundPills)
                                || 0,
                    allowLongLock: !!(o.frontierOptions
                        && o.frontierOptions.allowLongLock),
                });
            const frontier = o.parallelPity
                && typeof PityFrontier.discoverPitySeedFrontierAsync
                    === 'function'
                ? await PityFrontier.discoverPitySeedFrontierAsync(
                    raw, pityOptions
                )
                : PityFrontier.discoverPitySeedFrontier(
                    raw, pityOptions
                );
            pityFrontierMetrics = frontier.metrics || null;
            const rolePitySeeds = filterPitySeedsForRole(
                raw, frontier.seeds
            );
            frontierSeeds = rolePitySeeds.length;
            pityPreludePruned = Number(
                frontier.metrics
                && frontier.metrics.preludePruned
            ) || 0;
            pityCandidates = indexPitySeedChains(
                context,
                raw,
                rolePitySeeds,
                targets,
                { chainCache: sessionCache }
            ).candidates;
            pityRoots = pityCandidates.flatMap(candidate =>
                materializePityRoots(
                    context,
                    raw,
                    candidate,
                    targets,
                    o
                )
            );
        }
    }
    let result = null;
    // Keep the genuine low-slot state in the candidate set. This is the
    // wangye-style joint decision: opening slots can happen at the cheapest
    // checkpoint instead of being forced before search.
    let lowSlotResult = null;
    if (originalLowSlotRaw) {
        try {
            const startedAt = Date.now();
            const routes = await findInitialRoutes(
                originalLowSlotRaw,
                targets,
                {
                    horizon: backendHorizon,
                    topN: 6,
                    limits: o.limits || {},
                    runtime: o.runtime || {},
                }
            );
            const route = (routes || []).reduce((best, item) =>
                !best || compareRoute(item, best) < 0 ? item : best, null);
            if (route) {
                lowSlotResult = {
                    ok: true,
                    status: 'found',
                    provenOptimal: false,
                    route: Object.assign({}, route, {
                        finalTalents: route.replay && route.replay.state
                            ? route.replay.state.talents
                            : (route.replay && route.replay.finalTalents || []),
                    }),
                    metrics: {
                        initializer: 'low-slot-joint-open-slot',
                        directSearchElapsedMs: Date.now() - startedAt,
                    },
                    stopReason: 'low-slot-open-slot-candidate',
                };
            }
        } catch (_) {
            // The regular three-slot pipeline remains available as fallback.
        }
    }
    const checkpointRoots = fixedRoot
        ? [fixedRoot]
        : firstMethod === 'infinite-exchange'
            ? (infinitePhaseComplete
                ? pityRoots.slice()
                : infiniteRoots.concat(pityRoots))
            : pityRoots.concat(infiniteRoots);
    if (checkpointRoots.length) {
        result = await runCheckpointQuality(checkpointRoots);
        if (fixedRoot && result && result.route) {
            result.route.seedCheckpointSource =
                'fixed-current-chain';
            result.route.seedCheckpointPills = 0;
            result.route.seedCheckpointWashes = 0;
            result.route.seedCheckpointSteps = [];
        }
    }
    if (preliminaryInfiniteResult
        && preliminaryInfiniteResult.ok
        && preliminaryInfiniteResult.route
        && (!result || !result.ok || !result.route
            || compareRoute(
                preliminaryInfiniteResult.route,
                result.route
            ) < 0)) {
        result = preliminaryInfiniteResult;
    }
    if (!result || !result.ok || !result.route) {
        const directStartedAt = Date.now();
        try {
            const directRoutes = await findInitialRoutes(
                raw,
                targets,
                {
                    horizon: backendHorizon,
                    topN: 6,
                    limits: o.limits || {},
                    runtime: o.runtime || {},
                }
            );
            const direct = (directRoutes || []).reduce((best, item) =>
                !best || compareRoute(item, best) < 0 ? item : best, null);
            const budget = Number(o.budget);
            if (direct && (!Number.isFinite(budget)
                || budget <= 0 || Number(direct.pills) <= budget)) {
                result = {
                    ok: true,
                    status: 'found',
                    provenOptimal: false,
                    route: Object.assign({}, direct, {
                        finalTalents: direct.replay
                            && direct.replay.state
                            && direct.replay.state.talents
                            ? direct.replay.state.talents : [],
                    }),
                    metrics: {
                        initializer: 'direct-initial-route',
                        directSearchElapsedMs: Date.now() - directStartedAt,
                    },
                    stopReason: 'direct-initial-route-fallback',
                };
            } else if (result && result.metrics) {
                result.metrics.directSearchElapsedMs =
                    Date.now() - directStartedAt;
            }
        } catch (error) {
            if (result && result.metrics) {
                result.metrics.directSearchElapsedMs =
                    Date.now() - directStartedAt;
                result.metrics.directSearchError = String(
                    error && error.message || error
                );
            }
        }
    }
    if (!result) {
        result = {
            ok: false,
            status: 'no-route',
            provenOptimal: false,
            route: null,
            metrics: {},
            stopReason: 'route-search-no-route',
        };
    }
    if (lowSlotResult && lowSlotResult.route
        && (!result || !result.route
            || compareRoute(lowSlotResult.route, result.route) <= 0)) {
        result = lowSlotResult;
        selectedLowSlotRoute = true;
    }
    result.metrics = result.metrics || {};
    result.metrics.pityFrontierSeeds = frontierSeeds;
    result.metrics.pityFrontierMetrics = pityFrontierMetrics;
    result.metrics.pityPreludePruned = pityPreludePruned;
    result.metrics.sharedUpperBoundPills =
        result.route
            ? Math.min(
                Number(sharedUpperBoundPills) || Infinity,
                Number(result.route.pills) || Infinity
            )
            : (Number.isFinite(sharedUpperBoundPills)
                && sharedUpperBoundPills > 0
                ? sharedUpperBoundPills : null);
    if (result.metrics.sharedUpperBoundPills === Infinity) {
        result.metrics.sharedUpperBoundPills = null;
    }
    result.metrics.horizon = backendHorizon;
    result.metrics.sequenceCacheHits = sequenceMetrics.cacheHits;
    result.metrics.sequenceReads = sequenceMetrics.reads;
    result.metrics.preliminaryInfinitePills =
        preliminaryInfiniteResult
        && preliminaryInfiniteResult.route
            ? Number(preliminaryInfiniteResult.route.pills) || 0
            : null;
    result.metrics.pityRootsMaterialized = pityRoots.length;
    result.metrics.infiniteFrontierSeeds = infiniteFrontierSeeds;
    result.metrics.infiniteRootsMaterialized = infiniteRoots.length;
    result.metrics.infiniteUniqueSeeds = new Set(
        infiniteRoots.map(root => Number(root.seed) || 0)
    ).size;
    result.metrics.infiniteMaterializationFailures =
        infiniteMaterializationErrors.length;
    result.metrics.infiniteMaterializationError =
        infiniteMaterializationErrors[0] || '';
    result.plan = plan;
    if (upgradeLowSlot && result.route && !selectedLowSlotRoute
        && Array.isArray(result.route.steps)) {
        result.route.steps.unshift({
            op: 'upgrade',
            fromZizhi: sourceZizhi,
            toZizhi: 153,
        });
        result.searchMode = 'low-slot-checkpoint-quality';
    }
    result.searchMode = selectedLowSlotRoute
        ? 'low-slot-joint-open-slot'
        : fixedRoot
        ? 'fixed-current-chain'
        : infiniteRoots.length
        ? 'seed-quality'
        : (pityRoots.length ? 'pity-quality' : 'route-search');
    if (upgradeLowSlot && result.route && !selectedLowSlotRoute) {
        result.searchMode = 'low-slot-checkpoint-quality';
    }
    return attachRouteStepStates(context, upgradeLowSlot ? sourceRaw : raw, targets, Object.assign(
        {},
        result,
        { strategy: result.strategy || 'awash-route-search' }
    ));
}

module.exports = {
    classifyInfiniteSeedPackets,
    currentZizhiList,
    filterPitySeedsForRole,
    pityZizhiList,
    solveJoint,
    selectInfiniteSeedPackets,
};
