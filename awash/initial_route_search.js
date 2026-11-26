#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const U = require('./dev/unified_runner');

const ROOT = __dirname;
const ENGINE = path.join(ROOT, 'initial_route_engine');
let sharedSearchContext = null;
let sharedInitPromise = null;

function loadInitialRouteContext() {
    const sandbox = {
        console,
        atob,
        btoa,
        TextEncoder,
        TextDecoder,
        WebAssembly,
        Uint8Array,
        Uint32Array,
        Int32Array,
        BigInt,
        Math,
        Date,
        JSON,
        Proxy,
        Map,
        Set,
        Promise,
        setTimeout,
        clearTimeout,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    for (const name of ['data.js', 'wasm_data.js', 'core_glue.js']) {
        const file = path.join(ENGINE, name);
        vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    }
    return context;
}

function toWasmState(raw) {
    return {
        mode: 'seed',
        zizhi: Number(raw.zizhi) || 153,
        sex: Number(raw.sex) || 1,
        vip: Number(raw.vip) || 1,
        seed: Number(raw.seed) || 0,
        luck_seed: raw.luck_seed_inited ? Number(raw.luck_seed) || 0 : 0,
        luck_seed_inited: !!raw.luck_seed_inited,
        role_id: Number(raw.role_id) || 0,
        salt: Number(raw.salt) || 0,
        born_rc: Number(raw.born_talent_rc) || 0,
        has_born_talent: true,
        rng_variant: '73324',
        talents: (raw.talents || []).map(item => ({
            id: Number(item.id != null ? item.id : item),
            locked: !!(item && item.locked),
        })).filter(item => item.id > 0),
        tal_lucky: Number(raw.tal_lucky) || 0,
        total_wash: Number(raw.total_wash) || 0,
        total_talent_bars: Number(raw.total_talent_bars) || 0,
        total_pills: Number(raw.total_pills) || 0,
        bag_pills: Number(raw.bag_pills) || 0,
        has_bag_pills: !!raw.has_bag_pills,
        gold_count: Number(raw.gold_count) || 0,
        pity_count: Number(raw.pity_count) || 0,
        quality_counts: raw.quality_counts || { 1: 0, 2: 0, 3: 0, 4: 0 },
        last_purple_total_pills: raw.last_purple_total_pills,
        exchange_count: Number(raw.exchange_count) || 0,
        str_gift: Number(raw.str_gift) || 0,
        con_gift: Number(raw.con_gift) || 0,
        dex_gift: Number(raw.dex_gift) || 0,
        int_gift: Number(raw.int_gift) || 0,
        role_level: Number(raw.role_level) || 90,
        role_stats: raw.role_stats || { str_val: 0, dex: 0, con: 0, int_val: 0 },
        global_vars: raw.global_vars || {},
    };
}

async function getInitialRouteContext() {
    if (!sharedSearchContext) {
        sharedSearchContext = loadInitialRouteContext();
    }
    if (!sharedInitPromise) {
        sharedInitPromise = sharedSearchContext.initWasm()
            .then(ok => {
                if (!ok
                    || !sharedSearchContext.wasmInitEngine(
                        sharedSearchContext.TALENT_DATA,
                        sharedSearchContext.ZZ_DATA
                    )) {
                    throw new Error('AWASH 初始路线引擎初始化失败');
                }
                return sharedSearchContext;
            })
            .catch(error => {
                sharedInitPromise = null;
                throw error;
            });
    }
    await sharedInitPromise;
    return sharedSearchContext;
}

async function searchInitialRoute(raw, targetText, options) {
    const opts = options || {};
    const context = await getInitialRouteContext();
    if (!context.wasmSetState(toWasmState(raw))) {
        throw new Error('AWASH 初始路线状态写入失败');
    }
    const targets = U.resolveTargets(context, targetText);
    const result = context.wasmSearchWashRoutes({
        desired_ids: targets,
        max_pad: Number(opts.maxPad) || 0,
        horizon: Number(opts.horizon) || 12000,
        top_n: Number(opts.topN) || 1,
        allow_open_slot: true,
        allow_pity: true,
    });
    return { context, result, targets };
}

async function main() {
    const args = U.parseArgs(process.argv.slice(2));
    if (!args.save || !args.role || !args.targets) {
        console.log('node AWASH/initial_route_search.js --save <快照> --role <角色> '
            + '--targets "紫脉1,紫脉2,紫脉3" [--json]');
        return;
    }
    const savePath = U.findSavePath(args.save);
    const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));
    const selected = U.selectRole(U.collectRoles(save), args.role);
    if (!selected) throw new Error(`未找到角色: ${args.role}`);
    const metaPath = path.join(path.dirname(savePath), 'dat.meta.json');
    const meta = fs.existsSync(metaPath)
        ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
    const raw = U.buildRaw(save, selected.role, meta, args.vip == null ? 1 : args.vip);
    const searched = await searchInitialRoute(raw, args.targets, args);
    const result = searched.result;
    if (args.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    console.log(JSON.stringify(result, null, 2));
}

module.exports = {
    loadInitialRouteContext,
    getInitialRouteContext,
    toWasmState,
    searchInitialRoute,
};

if (require.main === module) {
    main().catch(error => {
        console.error(`错误: ${error && error.stack || error}`);
        process.exitCode = 1;
    });
}
