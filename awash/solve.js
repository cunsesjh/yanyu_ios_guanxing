#!/usr/bin/env node
'use strict';

const { loadAWash } = require('./context');
const RolePlanner = require('./role_planner');
const Sequence = require('./sequence');
const JumpSeedSearch = require('./jump_seed_search');
const PityFrontier = require('./pity_seed_frontier');
const {
    solveSeedCheckpointQuality,
} = require('./seed_checkpoint_quality');
const {
    indexPitySeedChains,
} = require('./seed_chain_order');

const DEFAULT_PILL_BUDGET = 1000000;

function actualSlotCount(context, raw) {
    const zizhi = Number(raw && raw.zizhi) || 153;
    return Number(context.ZZ_DATA
        && context.ZZ_DATA[String(zizhi)]
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
    } catch (_) {
        // A route already returned by an independently verified checkpoint
        // stays usable if optional presentation-state replay is unavailable.
    }
    return result;
}

function solveLowSlotRole(context, raw, targets, options) {
    const slots = actualSlotCount(context, raw);
    if (!(slots > 0 && slots < 3)) return null;
    const o = options || {};
    const configuredBudget = Number(o.budget);
    const result = context.WashFixedChain.search(raw, targets, {
        budget: Number.isFinite(configuredBudget) && configuredBudget > 0
            ? configuredBudget : DEFAULT_PILL_BUDGET,
        limits: o.limits || {},
        runtime: o.runtime || {},
    });
    result.searchMode = 'direct-low-slot';
    return attachRouteStepStates(context, raw, targets, result);
}

function compareRoute(a, b) {
    for (const field of ['pills', 'washes', 'exchanges']) {
        const difference = Number(a && a[field] || 0)
            - Number(b && b[field] || 0);
        if (difference) return difference;
    }
    return 0;
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

async function solve(raw, targetIds, options) {
    const o = options || {};
    const context = o.context || loadAWash();
    const sessionCache = o.sessionCache
        && typeof o.sessionCache.get === 'function'
        && typeof o.sessionCache.set === 'function'
        ? o.sessionCache : new Map();
    const targets = Array.from(new Set((targetIds || []).map(Number)));
    const lowSlotResult = solveLowSlotRole(context, raw, targets, o);
    if (lowSlotResult) return lowSlotResult;
    const sequence = o.plan ? null : Sequence.readSequence(raw, {
        context,
        zi: Number(raw.zizhi) || 153,
        count: Number(o.count) || 40,
    });
    const plan = o.plan || RolePlanner.selectPlan(
        raw,
        sequence,
        { context }
    );
    const metrics = {
        backendCalls: 0,
        prunedSeeds: 0,
        duplicateSeeds: 0,
        infiniteSeeds: 0,
        pitySeeds: 0,
    };
    const phaseResults = {};
    const seen = new Map();
    let best = null;
    let upperBound = Infinity;
    function consume(packet) {
        const item = normalizeCheckpoint(packet);
        const key = `${item.source || ''}|${item.seed || ''}|`
            + `${item.checkpointRaw && item.checkpointRaw.luck_seed || ''}|`
            + (item.pinTargetIds || []).map(Number).sort((a, b) => a - b)
                .join(',');
        const priorPrefix = seen.get(key);
        if (priorPrefix != null && priorPrefix <= item.prefixPills) {
            metrics.duplicateSeeds++;
            return { upperBound };
        }
        seen.set(key, item.prefixPills);
        metrics.infiniteSeeds++;
        if (item.prefixPills >= upperBound) {
            metrics.prunedSeeds++;
            return { upperBound };
        }
        const configuredBudget = Number(o.budget);
        const budget = Number.isFinite(upperBound)
            ? upperBound - item.prefixPills
            : (Number.isFinite(configuredBudget) && configuredBudget > 0
                ? configuredBudget : DEFAULT_PILL_BUDGET);
        if (Number.isFinite(upperBound) && !(budget > 0)) {
            metrics.prunedSeeds++;
            return { upperBound };
        }
        const backend = o.backend || ((checkpointRaw, wanted, backendOptions) =>
            context.WashFixedChain.search(
                checkpointRaw,
                wanted,
                backendOptions
            ));
        const result = backend(
            item.checkpointRaw,
            targets,
            Object.assign({}, o.backendOptions || {}, {
                budget,
                limits: o.limits || {},
                runtime: o.runtime || {},
                checkpoint: item,
            })
        );
        if (result && typeof result.then === 'function') {
            throw new Error('AWash 同步种子流不能调用异步后端');
        }
        metrics.backendCalls++;
        if (result && result.ok && result.route) {
            const route = Object.assign({}, result.route, {
                pills: item.prefixPills + Number(result.route.pills || 0),
                washes: item.prefixWashes
                    + Number(result.route.washes || 0),
                exchanges: Number(item.exchanges || 0)
                    + Number(result.route.exchanges || 0),
                prefixSteps: item.prefixSteps,
                steps: item.prefixSteps.concat(
                    Array.isArray(result.route.steps)
                        ? result.route.steps : []
                ),
                checkpoint: item,
            });
            if (!best || compareRoute(route, best) < 0) {
                best = route;
                upperBound = route.pills;
            }
        }
        return { upperBound };
    }

    function acceptPityResult(result) {
        phaseResults.pity = result;
        const candidate = result && result.best;
        if (candidate && candidate.totalPills != null
            && (!best
                || Number(candidate.totalPills) < best.pills)) {
            best = {
                pills: Number(candidate.totalPills),
                washes: Number(candidate.totalWashes) || 0,
                exchanges: Number(candidate.exchanges) || 0,
                steps: candidate.route
                    ? candidate.route.steps || [] : [],
                route: candidate.route || null,
                seed: Number(candidate.seed),
                zizhi: Number(candidate.zizhi),
                preludePills: Number(candidate.preludePills) || 0,
                preludeWashes: Number(candidate.preludeWashes) || 0,
                checkpointRaw: candidate.checkpointRaw || null,
                keptTargetIds: (candidate.keptTargetIds || []).slice(),
                branchKey: candidate.branchKey || '',
            };
            upperBound = best.pills;
        }
        metrics.pitySeeds += Number(
            result && result.metrics
            && result.metrics.totalSeedsSearched
        ) || 0;
    }

    for (const method of plan.methodOrder || []) {
        if (method === 'fixed-current-chain') {
            consume({
                source: method,
                checkpointRaw: raw,
                prefixPills: 0,
                prefixWashes: 0,
                prefixSteps: [],
                seed: raw.luck_seed,
                seedChain: [],
            });
            phaseResults[method] = {
                ok: !!best,
                best,
            };
            continue;
        }
        if (method === 'infinite-exchange') {
            let produced;
            if (typeof o.infiniteProducer === 'function') {
                produced = await o.infiniteProducer({
                    raw,
                    targets,
                    context,
                    emit: consume,
                    upperBound,
                });
            } else {
                produced = context.InfiniteSeedFrontier.enumerate(
                    raw,
                    targets,
                    Object.assign({}, o.infiniteOptions || {}, {
                        onSeed: consume,
                    })
                );
            }
            phaseResults['infinite-exchange'] = produced;
            continue;
        }
        if (method === 'pity') {
            let frontier;
            const frontierOptions = productionPityFrontierOptions(
                raw, targets, context, o.frontierOptions
            );
            if (typeof o.pityFrontierProducer === 'function') {
                frontier = await o.pityFrontierProducer({
                    raw,
                    targets,
                    context,
                    upperBoundPills: upperBound,
                    options: frontierOptions,
                });
            } else if (o.pitySeedCandidates) {
                frontier = {
                    seeds: o.pitySeedCandidates.slice(),
                    metrics: {},
                };
            } else if (typeof o.pityProducer === 'function') {
                frontier = { seeds: [], metrics: {} };
            } else {
                frontier = o.parallelPity
                    && typeof PityFrontier.discoverPitySeedFrontierAsync
                        === 'function'
                    ? await PityFrontier.discoverPitySeedFrontierAsync(
                        raw, frontierOptions
                    )
                    : PityFrontier.discoverPitySeedFrontier(
                        raw, frontierOptions
                    );
            }
            phaseResults.pityFrontier = frontier;
            const seedCandidates = (frontier && frontier.seeds || [])
                .slice();
            let result;
            if (typeof o.pityProducer === 'function') {
                result = await o.pityProducer(raw, targets, {
                    context,
                    upperBoundPills: upperBound,
                    initialUpperBoundPills: Number.isFinite(upperBound)
                        ? upperBound : 0,
                    seedCandidates,
                    skipEnumeratedSeeds: true,
                    limits: o.limits || {},
                    runtime: o.runtime || {},
                });
            } else {
                result = await JumpSeedSearch.searchJumpRoutes(
                    raw,
                    targets,
                    Object.assign({}, o.pityOptions || {}, {
                        context,
                        seedCandidates,
                        skipEnumeratedSeeds: true,
                        initialUpperBoundPills: Number.isFinite(upperBound)
                            ? upperBound
                            : Number(
                                o.pityOptions
                                && o.pityOptions.initialUpperBoundPills
                            ) || 0,
                        limits: o.limits
                            || (o.pityOptions && o.pityOptions.limits)
                            || {},
                    })
                );
            }
            acceptPityResult(result);
        }
    }

    const output = {
        ok: !!best,
        best,
        plan,
        metrics,
        phaseResults,
        upperBound: Number.isFinite(upperBound) ? upperBound : null,
    };
    if (best && best.route) {
        attachRouteStepStates(context, raw, targets, {route: best.route});
    }
    return output;
}

async function solveJoint(raw, targetIds, options) {
    const o = options || {};
    const context = o.context || loadAWash();
    const sessionCache = o.sessionCache
        && typeof o.sessionCache.get === 'function'
        && typeof o.sessionCache.set === 'function'
        ? o.sessionCache : new Map();
    const targets = Array.from(new Set(
        (targetIds || []).map(Number)
    ));
    const lowSlotResult = solveLowSlotRole(context, raw, targets, o);
    if (lowSlotResult) return lowSlotResult;
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
    // 0 表示还没有路线上界；资源节点/时长限制仍然生效。
    const requestedPillBudget = Number(o.budget);
    let sharedUpperBoundPills = Number.isFinite(requestedPillBudget)
        && requestedPillBudget > 0
        ? requestedPillBudget : DEFAULT_PILL_BUDGET;
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
        const backendHorizon = Number(o.horizon) || 1000;
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
            ? sharedUpperBoundPills
            : Number(options.budget) || 0;
        return backend(
            checkpoints,
            targets,
            {
                budget: requestedBudget > 0 ? requestedBudget : 0,
                concurrency: Number(o.concurrency) || 16,
                horizon: backendHorizon,
                maxHorizon: Number(o.maxHorizon) || backendHorizon,
                limits: o.limits || {},
                runtime: o.runtime || {},
                sessionCache,
                targetOrder: targets,
                stopOnFirstRoute: options.stopOnFirstRoute != null
                    ? !!options.stopOnFirstRoute
                    : false,
            }
        );
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
            const sequence = Sequence.readSequence(raw, {
                context,
                zi: Number(raw.zizhi) || 153,
                count: Number(o.count) || 40,
            });
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
            context.InfiniteSeedFrontier.enumerate(
                raw,
                targets,
                Object.assign({
                    nMax: 300,
                    count: 60,
                }, o.infiniteOptions || {}, {
                    onSeed(packet) {
                        if (!packet) return;
                        infiniteFrontierSeeds++;
                        infinitePackets.push(packet);
                    },
                })
            );
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
                            stopOnFirstRoute: false,
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
                            stopOnFirstRoute: false,
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
    const checkpointRoots = fixedRoot
        ? [fixedRoot]
        : firstMethod === 'infinite-exchange'
            ? (infinitePhaseComplete
                ? pityRoots.slice()
                : infiniteRoots.concat(pityRoots))
            : pityRoots.concat(infiniteRoots);
    if (fixedRoot) {
        result = context.WashFixedChain.search(
            raw,
            targets,
            {
                budget: sharedUpperBoundPills > 0
                    ? sharedUpperBoundPills : 0,
                limits: o.limits || {},
                runtime: o.runtime || {},
            }
        );
        if (result && result.route) {
            result.route.seedCheckpointSource =
                'fixed-current-chain';
            result.route.seedCheckpointPills = 0;
            result.route.seedCheckpointWashes = 0;
            result.route.seedCheckpointSteps = [];
        }
    } else if (checkpointRoots.length) {
        const checkpoints = checkpointRoots
            .map(checkpointFromRoot)
            .filter(Boolean);
        const backendHorizon = Number(o.horizon) || 1000;
        const backend = typeof o.checkpointBackend === 'function'
            ? o.checkpointBackend
            : (items, targets, backendOptions) =>
                solveSeedCheckpointQuality(
                    raw,
                    items,
                    targets,
                    backendOptions
                );
        result = await backend(
            checkpoints,
            targets,
            {
                budget: sharedUpperBoundPills > 0
                    ? sharedUpperBoundPills : 0,
                concurrency: Number(o.concurrency) || 16,
                horizon: backendHorizon,
                maxHorizon: Number(o.maxHorizon) || backendHorizon,
                limits: o.limits || {},
                runtime: o.runtime || {},
                sessionCache,
                targetOrder: targets,
                stopOnFirstRoute: o.stopOnFirstRoute != null
                    ? !!o.stopOnFirstRoute
                    : false,
            }
        );
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
    result.metrics.horizon = Number(o.horizon) || 1000;
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
    result.searchMode = fixedRoot
        ? 'fixed-current-chain'
        : infiniteRoots.length
        ? 'seed-quality'
        : (pityRoots.length ? 'pity-quality' : 'route-search');
    attachRouteStepStates(context, raw, targets, result);
    return Object.assign(
        {},
        result,
        { strategy: result.strategy || 'awash-route-search' }
    );
}

module.exports = {
    classifyInfiniteSeedPackets,
    currentZizhiList,
    filterPitySeedsForRole,
    pityZizhiList,
    solve,
    solveJoint,
    normalizeCheckpoint,
    selectInfiniteSeedPackets,
};
