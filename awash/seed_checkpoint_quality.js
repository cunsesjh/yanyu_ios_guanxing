#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { loadAWash } = require('./context');
const {
    findInitialRoutes,
} = require('./fixed_chain_initial_route');

const WORKER = path.join(__dirname, 'seed_checkpoint_worker.js');
let localContext = null;

function routeRank(route) {
    return [
        Number(route && route.pills) || 0,
        Number(route && route.washes) || 0,
        Number(route && route.exchanges) || 0,
    ];
}

function routeBeats(candidate, incumbent) {
    if (!candidate) return false;
    if (!incumbent) return true;
    const left = routeRank(candidate);
    const right = routeRank(incumbent);
    for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) {
            return left[index] < right[index];
        }
    }
    return false;
}

function routeSignature(route) {
    if (!route) return '';
    return [
        route.seed,
        route.pills,
        route.washes,
        route.exchanges,
        route.finalStateKey || '',
        route.signature || JSON.stringify(route.steps || []),
    ].join('|');
}

function optimizeGlobalBest(rootRaw, targets, best, options, metrics) {
    const o = options || {};
    if (!best || o.optimizeBest === false
        || !best.checkpointRaw
        || !Array.isArray(best.continuationSteps)
        || !(Number(best.seedCheckpointPills) >= 0)) {
        return best;
    }
    if (!localContext) localContext = loadAWash();
    const checkpointPills = Number(best.seedCheckpointPills) || 0;
    const budget = Math.max(
        1,
        Number(best.pills) - checkpointPills
    );
    const startedAt = Date.now();
    let optimized;
    try {
        optimized = localContext.WashFixedChain.optimizeRoutes(
            best.checkpointRaw,
            targets,
            [{
                steps: best.continuationSteps,
                replay: {
                    pills: Number(best.continuationPills) || 0,
                    washes: Number(best.continuationWashes) || 0,
                    exchanges: Number(best.exchanges) || 0,
                },
            }],
            {
                budget,
                limits: o.limits || {},
                incumbentSearch: o.incumbentSearch,
                incumbentBeamWidth: o.incumbentBeamWidth,
                incumbentPasses: o.incumbentPasses,
                incumbentMaxNodes: o.incumbentMaxNodes,
                incumbentMaxRuntimeMs: o.incumbentMaxRuntimeMs,
                optimizerCandidates: o.optimizerCandidates,
            }
        );
    } catch (error) {
        optimized = null;
    }
    metrics.optimizationSearches += 1;
    metrics.optimizationElapsedMs += Date.now() - startedAt;
    if (!optimized || !optimized.ok || !optimized.route) return best;
    const steps = (best.seedCheckpointSteps || [])
        .concat(optimized.route.steps || []);
    let replayed;
    try {
        replayed = localContext.WashSearchV2.replay(
            rootRaw,
            targets,
            steps
        );
    } catch (error) {
        return best;
    }
    if (!replayed.ok
        || !routeBeats({
            pills: replayed.pills,
            washes: replayed.washes,
            exchanges: replayed.exchanges,
        }, best)) {
        return best;
    }
    return Object.assign({}, best, {
        pills: replayed.pills,
        washes: replayed.washes,
        exchanges: replayed.exchanges,
        finalTalents: replayed.finalTalents,
        finalStateKey: replayed.finalStateKey,
        steps,
        status: optimized.status,
        stopReason: optimized.stopReason,
        optimized: true,
        optimizationMetrics: optimized.metrics,
    });
}

class PersistentWorkerPool {
    constructor(size) {
        this.workers = [];
        this.idle = [];
        this.queue = [];
        this.pending = new Map();
        this.sequence = 0;
        for (let index = 0; index < size; index++) {
            const worker = new Worker(WORKER);
            worker.on('message', message => {
                const pending = this.pending.get(message.id);
                if (!pending) return;
                this.pending.delete(message.id);
                pending.resolve(message.result);
                this.idle.push(worker);
                this.dispatch();
            });
            worker.on('error', error => {
                for (const [id, pending] of this.pending) {
                    if (pending.worker !== worker) continue;
                    this.pending.delete(id);
                    pending.reject(error);
                }
            });
            this.workers.push(worker);
            this.idle.push(worker);
        }
    }

    run(data) {
        return new Promise((resolve, reject) => {
            this.queue.push({ data, resolve, reject });
            this.dispatch();
        });
    }

    dispatch() {
        while (this.idle.length && this.queue.length) {
            const worker = this.idle.pop();
            const task = this.queue.shift();
            const id = ++this.sequence;
            this.pending.set(id, {
                worker,
                resolve: task.resolve,
                reject: task.reject,
            });
            worker.postMessage({ id, data: task.data });
        }
    }

    async close() {
        await Promise.all(this.workers.map(worker =>
            worker.terminate()
        ));
    }
}

function normalizeCheckpoints(checkpoints) {
    const byKey = new Map();
    for (const checkpoint of checkpoints || []) {
        if (!checkpoint || !checkpoint.raw) continue;
        const source = String(checkpoint.source || 'seed');
        const pins = Array.isArray(checkpoint.pinTargetIds)
            ? checkpoint.pinTargetIds.map(Number)
                .sort((a, b) => a - b)
            : [];
        const key = [
            source,
            checkpoint.raw.luck_seed,
            checkpoint.raw.luck_seed_inited ? '1' : '0',
            Number(checkpoint.raw.seed) || 0,
            Number(checkpoint.raw.born_talent_rc) || 0,
            Number(checkpoint.raw.tal_lucky) || 0,
            (checkpoint.raw.talents || [])
                .map(item => Number(item && item.id != null
                    ? item.id : item))
                .join(','),
            pins.join(','),
        ].join('|');
        const item = Object.assign({}, checkpoint, {
            source,
            chainKey: `${Number(checkpoint.raw.zizhi) || 0}:`
                + `${Number(checkpoint.raw.luck_seed) || 0}`,
            pills: Math.max(0, Number(checkpoint.pills) || 0),
            washes: Math.max(0, Number(checkpoint.washes) || 0),
            exchanges: Math.max(0, Number(checkpoint.exchanges) || 0),
            steps: Array.isArray(checkpoint.steps)
                ? checkpoint.steps.slice() : [],
            seedChain: Array.isArray(checkpoint.seedChain)
                ? checkpoint.seedChain.slice() : [],
            pinTargetIds: pins,
            key,
        });
        const prior = byKey.get(key);
        if (!prior
            || item.pills < prior.pills
            || (item.pills === prior.pills
                && item.washes < prior.washes)) {
            byKey.set(key, item);
        }
    }
    const groups = new Map();
    for (const item of byKey.values()) {
        const groupKey = `${Number(item.raw.zizhi) || 0}:`
            + `${Number(item.raw.luck_seed) || 0}`;
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push(item);
    }
    const scheduled = [];
    for (let index = 0; ; index++) {
        let added = false;
        for (const group of groups.values()) {
            if (index >= group.length) continue;
            scheduled.push(group[index]);
            added = true;
        }
        if (!added) break;
    }
    return scheduled;
}

async function runLocal(data) {
    if (!localContext) localContext = loadAWash();
    const checkpoint = data.checkpoint;
    let solved;
    if (data.screenOnly !== false) {
        const initial = await findInitialRoutes(
            checkpoint.raw,
            data.targets,
            {
                budget: data.budget,
                horizon: data.horizon,
                requiredHeldIds: checkpoint.pinTargetIds || [],
                targetOrder: data.targetOrder || data.targets,
                limits: data.limits || {},
                runtime: data.runtime || {},
            }
        );
        const route = (initial || [])
            .filter(item => item && Array.isArray(item.steps)
                && Number(item.pills) <= data.budget)
            .sort((a, b) =>
                (Number(a.pills) - Number(b.pills))
                || (Number(a.washes) - Number(b.washes))
                || (Number(a.exchanges) - Number(b.exchanges))
            )[0] || null;
        solved = {
            ok: !!route,
            status: route ? 'initial-route-screened' : 'no-route',
            stopReason: route
                ? 'initial-route-screened'
                : 'initial-search-no-route',
            route,
        };
    } else {
        solved = await localContext.WashFixedChain.solve(
            checkpoint.raw,
            data.targets,
            {
                budget: data.budget,
                horizon: data.horizon,
                findInitialRoutes,
                requiredHeldIds: checkpoint.pinTargetIds || [],
                targetOrder: data.targetOrder || data.targets,
                limits: data.limits || {},
                runtime: data.runtime || {},
            }
        );
    }
    if (!solved.ok || !solved.route) {
        return {
            ok: false,
            source: checkpoint.source,
            status: solved.status,
            stopReason: solved.stopReason,
        };
    }
    const steps = checkpoint.steps.concat(solved.route.steps || []);
    const replayed = localContext.WashSearchV2.replay(
        data.rootRaw,
        data.targets,
        steps
    );
    return {
        ok: replayed.ok,
        source: checkpoint.source,
        seedCheckpointSource: checkpoint.source,
        seedCheckpointPills: checkpoint.pills,
        seedCheckpointWashes: checkpoint.washes,
        seedCheckpointSteps: checkpoint.steps,
        checkpointRaw: checkpoint.raw,
        continuationSteps: solved.route.steps || [],
        continuationPills: Number(solved.route.pills) || 0,
        continuationWashes: Number(solved.route.washes) || 0,
        seedChain: checkpoint.seedChain,
        seed: Number(checkpoint.raw.luck_seed),
        zizhi: Number(checkpoint.raw.zizhi),
        pills: replayed.pills,
        washes: replayed.washes,
        exchanges: replayed.exchanges,
        finalTalents: replayed.finalTalents,
        finalStateKey: replayed.finalStateKey,
        steps,
        status: solved.status,
        stopReason: solved.stopReason,
    };
}

async function solveSeedCheckpointQuality(
    rootRaw,
    checkpoints,
    targetIds,
    options
) {
    const o = options || {};
    const startedAt = Date.now();
    const targets = (targetIds || []).map(Number);
    const ordered = normalizeCheckpoints(checkpoints);
    const cpuCount = typeof os.availableParallelism === 'function'
        ? os.availableParallelism() : os.cpus().length;
    const concurrency = Math.max(
        1,
        Math.min(
            Number(o.concurrency) || Math.min(16, cpuCount),
            ordered.length || 1
        )
    );
    const limits = Object.assign({}, o.limits || {});
    const maxRuntimeMs = Math.max(
        1,
        Number(limits.maxRuntimeMs) || 300000
    );
    const deadline = startedAt + maxRuntimeMs;
    const firstHorizon = Number(o.horizon) || 1000;
    const horizonStep = Math.max(
        1, Number(o.horizonStep) || 200
    );
    const maxHorizon = Math.max(
        firstHorizon + horizonStep,
        Number(o.maxHorizon) || 6000
    );
    const stopOnFirstRoute = !!o.stopOnFirstRoute;
    const cache = o.sessionCache
        && typeof o.sessionCache.get === 'function'
        && typeof o.sessionCache.set === 'function'
        ? o.sessionCache : new Map();
    const pool = ordered.length > 0 && concurrency > 0
        ? new PersistentWorkerPool(concurrency)
        : null;
    const requestedBudget = Number(o.budget);
    // budget=0 表示本阶段还没有共享丹耗上界。
    let upperBound = Number.isFinite(requestedBudget)
        && requestedBudget > 0 ? requestedBudget : Infinity;
    let best = null;
    const metrics = {
        checkpointCount: ordered.length,
        checkpointSearches: 0,
        screenSearches: 0,
        optimizationSearches: 0,
        upperBoundPruned: 0,
        chainCount: new Set(
            ordered.map(item => item.chainKey)
        ).size,
        maxActiveChains: 0,
        cacheHits: 0,
        concurrency,
        horizons: [],
        firstRouteMs: null,
        optimizationElapsedMs: 0,
        elapsedMs: 0,
    };

    async function runCheckpoint(checkpoint, horizon) {
        if (checkpoint.pills >= upperBound) {
            metrics.upperBoundPruned += 1;
            return {
                ok: false,
                status: 'resource-limited',
                stopReason: 'prefix-at-or-over-upper-bound',
            };
        }
        const budget = upperBound - checkpoint.pills;
        if (!(budget > 0)) {
            return {
                ok: false,
                status: 'resource-limited',
                stopReason: 'no-remaining-budget',
            };
        }
        const cacheKey = `${checkpoint.key}|${budget}|${horizon}`;
        if (cache.has(cacheKey)) {
            metrics.cacheHits++;
            return cache.get(cacheKey);
        }
        metrics.checkpointSearches++;
        metrics.screenSearches++;
        const remaining = Math.max(1, deadline - Date.now());
        const data = {
            rootRaw,
            targets,
            checkpoint,
            budget,
            horizon,
            screenOnly: o.screenOnly !== false,
            targetOrder: o.targetOrder || targets,
            stopOnFirstRoute,
            limits: Object.assign({}, limits, {
                maxRuntimeMs: Math.min(
                    maxRuntimeMs, remaining
                ),
            }),
            runtime: o.runtime || {},
        };
        let result;
        if (pool) {
            result = await pool.run(data);
        } else {
            result = await runLocal(data);
        }
        cache.set(cacheKey, result);
        if (result && result.ok
            && routeBeats(result, best)) {
            best = result;
            upperBound = Math.min(upperBound, result.pills);
            if (metrics.firstRouteMs == null) {
                metrics.firstRouteMs = Date.now() - startedAt;
            }
        }
        return result;
    }

    async function runStage(horizon) {
        let stopped = false;
        const routes = [];
        if (stopOnFirstRoute) {
            for (let start = 0;
                start < ordered.length;
                start += concurrency) {
                if (Date.now() >= deadline) {
                    stopped = true;
                    break;
                }
                const batch = ordered.slice(start, start + concurrency);
                metrics.maxActiveChains = Math.max(
                    metrics.maxActiveChains,
                    new Set(batch.map(item => item.chainKey)).size
                );
                const batchResults = await Promise.all(
                    batch.map(checkpoint =>
                        runCheckpoint(checkpoint, horizon)
                    )
                );
                routes.push.apply(routes, batchResults);
                if (batchResults.some(result => result && result.ok)) {
                    stopped = true;
                    break;
                }
            }
        } else {
            let cursor = 0;
            const activeChains = new Set();
            async function workerLoop() {
                while (!stopped) {
                    if (Date.now() >= deadline) {
                        stopped = true;
                        break;
                    }
                    const index = cursor++;
                    if (index >= ordered.length) break;
                    const checkpoint = ordered[index];
                    activeChains.add(checkpoint.chainKey);
                    metrics.maxActiveChains = Math.max(
                        metrics.maxActiveChains,
                        activeChains.size
                    );
                    const result = await runCheckpoint(
                        checkpoint, horizon
                    );
                    routes.push(result);
                    activeChains.delete(checkpoint.chainKey);
                }
            }
            await Promise.all(Array.from(
                {
                    length: Math.min(
                        concurrency, ordered.length
                    ),
                },
                workerLoop
            ));
        }
        return {
            horizon,
            routes,
            stopped,
            timedOut: Date.now() >= deadline,
        };
    }

    try {
        let horizon = firstHorizon;
        let previousSignature = null;
        while (true) {
            const stage = await runStage(horizon);
            const signature = routeSignature(best);
            metrics.horizons.push({
                horizon,
                upperBound,
                firstRouteMs: metrics.firstRouteMs,
                signature,
                timedOut: stage.timedOut,
            });
            if (stopOnFirstRoute && best) break;
            if (Date.now() >= deadline) break;
            if (previousSignature != null
                && signature === previousSignature) {
                metrics.stableHorizon = horizon;
                break;
            }
            previousSignature = signature;
            if (horizon + horizonStep > maxHorizon) break;
            horizon += horizonStep;
        }
    } finally {
        if (pool) await pool.close();
    }
    best = optimizeGlobalBest(
        rootRaw,
        targets,
        best,
        o,
        metrics
    );
    metrics.elapsedMs = Date.now() - startedAt;
    metrics.totalElapsedMs = metrics.elapsedMs;
    return {
        ok: !!best,
        status: best ? 'resource-limited' : 'no-route',
        provenOptimal: false,
        route: best,
        metrics,
        stopReason: best
            ? (stopOnFirstRoute && metrics.firstRouteMs != null
                ? 'first-route'
                : (metrics.elapsedMs >= maxRuntimeMs
                    ? 'max-runtime'
                    : 'checkpoint-quality-exhausted'))
            : 'checkpoint-quality-no-route',
        strategy: 'awash-seed-checkpoint-quality',
    };
}

module.exports = {
    solveSeedCheckpointQuality,
};
