#!/usr/bin/env node
'use strict';

const { parentPort } = require('worker_threads');
const { loadAWash } = require('./context');
const {
    findInitialRoutes,
} = require('./fixed_chain_initial_route');

let context = null;

async function run(data) {
    if (!context) context = loadAWash();
    const checkpoint = data.checkpoint;
    const targets = (data.targets || []).map(Number);
    let solved;
    if (data.screenOnly !== false) {
        const initial = await findInitialRoutes(
            checkpoint.raw,
            targets,
            {
                budget: data.budget,
                horizon: data.horizon,
                requiredHeldIds: checkpoint.pinTargetIds || [],
                targetOrder: data.targetOrder || targets,
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
        solved = await context.WashFixedChain.solve(
            checkpoint.raw,
            targets,
            {
                budget: data.budget,
                horizon: data.horizon,
                findInitialRoutes,
                requiredHeldIds: checkpoint.pinTargetIds || [],
                targetOrder: data.targetOrder || targets,
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
    const steps = checkpoint.steps.concat(
        Array.isArray(solved.route.steps) ? solved.route.steps : []
    );
    let replayed;
    try {
        replayed = context.WashSearchV2.replay(
            data.rootRaw,
            targets,
            steps
        );
    } catch (error) {
        return {
            ok: false,
            source: checkpoint.source,
            status: 'replay-error',
            stopReason: String(error && error.message || error),
        };
    }
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

parentPort.on('message', async message => {
    try {
        parentPort.postMessage({
            id: message.id,
            result: await run(message.data || {}),
        });
    } catch (error) {
        parentPort.postMessage({
            id: message.id,
            result: {
                ok: false,
                status: 'worker-error',
                stopReason: String(error && error.stack || error),
            },
        });
    }
});
