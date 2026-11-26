#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

const ROOT = __dirname;
const SHARED = path.join(ROOT, '..', 'web', 'shared');

function loadAWash() {
    const sandbox = {
        console,
        TextEncoder,
        TextDecoder,
        URL,
        setTimeout,
        clearTimeout,
        performance,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    const files = [
        path.join(SHARED, 'sequence_rules.js'),
        path.join(SHARED, 'data.js'),
        path.join(SHARED, 'wash_route_engine.js'),
        path.join(SHARED, 'wash_source_engine.js'),
        path.join(__dirname, 'sequence.js'),
        path.join(__dirname, 'wash_search_core.js'),
        path.join(__dirname, 'wash_fixed_chain.js'),
        path.join(__dirname, 'infinite_seed_frontier.js'),
    ];
    for (const file of files) {
        vm.runInContext(
            fs.readFileSync(file, 'utf8'),
            context,
            { filename: file }
        );
    }
    if (!context.WashSearchV2 || !context.WashFixedChain
        || !context.InfiniteSeedFrontier || !context.AWashSequence) {
        throw new Error('AWash 上下文加载失败');
    }
    return context;
}

module.exports = { ROOT, loadAWash };
