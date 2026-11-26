#!/usr/bin/env node
'use strict';

const { parentPort, workerData } = require('worker_threads');
const P = require('./pity_seed_frontier');

try {
    const result = P.discoverPitySeedFrontier(
        workerData.raw,
        Object.assign({}, workerData.options, {
            zizhiList: [workerData.zizhi],
        })
    );
    parentPort.postMessage({
        ok: true,
        result: JSON.parse(JSON.stringify(result)),
    });
} catch (error) {
    parentPort.postMessage({
        ok: false,
        error: String(error && error.stack || error),
    });
}
