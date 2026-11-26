#!/usr/bin/env node
'use strict';

const readline = require('readline');
const { solveJoint } = require('./awash/solve');

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let body = '';
input.on('line', line => { body += line; });
input.on('close', async () => {
    try {
        const request = JSON.parse(body || '{}');
        const options = Object.assign({
            horizon: 1000, horizonStep: 200, maxHorizon: 4000,
            nMax: 100, fallbackNMax: 300, count: 30,
            pityQuality: true, seedQuality: true, concurrency: 16,
        }, request.options || {});
        const result = await solveJoint(request.raw || {}, request.targets || [], options);
        process.stdout.write(JSON.stringify(result));
    } catch (error) {
        process.stdout.write(JSON.stringify({ok: false, status: 'error',
            error: String(error && error.stack || error)}));
        process.exitCode = 1;
    }
});
