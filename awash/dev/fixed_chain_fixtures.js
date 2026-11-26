#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const U = require('./unified_runner');

const ROOT = path.resolve(__dirname, '..', '..');
const CORE = path.join(ROOT, 'AWASH', 'wash_search_core.js');
const FIXED_CHAIN = path.join(
    ROOT, 'AWASH', 'wash_fixed_chain.js'
);
const SAVE = path.join(
    ROOT,
    'output',
    '存档',
    'ios-s20-将进酒',
    '20261111-092203'
);
const TARGETS = [250, 272, 271, 268];

function loadBaseRaw(roleName) {
    const savePath = U.findSavePath(SAVE);
    const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));
    const selected = U.selectRole(U.collectRoles(save), roleName);
    if (!selected) throw new Error(`未找到角色: ${roleName}`);
    const metaPath = path.join(path.dirname(savePath), 'dat.meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return {
        raw: U.buildRaw(save, selected.role, meta, 1),
        selected,
    };
}

function loadFixedChainContext() {
    const context = U.loadUnified();
    vm.runInContext(fs.readFileSync(CORE, 'utf8'), context, {
        filename: CORE,
    });
    if (fs.existsSync(FIXED_CHAIN)) {
        vm.runInContext(
            fs.readFileSync(FIXED_CHAIN, 'utf8'),
            context,
            { filename: FIXED_CHAIN }
        );
    }
    return context;
}

function taohuaFixture() {
    const { raw } = loadBaseRaw('桃花');
    if (!raw.luck_seed_inited) {
        throw new Error('桃花夹具不是固定种子状态');
    }
    return {
        name: 'taohua',
        raw,
        targets: TARGETS.slice(),
        budget: 7500,
        spentPills: 0,
        reference: {
            pills: 6191,
            // The former 6188 candidate unlocked and re-locked a carrier's
            // conflict. The game permanently invalidates that carrier.
            improvedPills: 6191,
            washes: 847,
            exchanges: 4,
        },
    };
}

function orderedState(state, keepIds) {
    const keep = keepIds.filter(id => state.talents.includes(id));
    return Object.assign({}, state, {
        talents: keep.concat(
            state.talents.filter(id => !keep.includes(id))
        ),
    });
}

function taohuaExchangeFixture() {
    const { raw } = loadBaseRaw('桃花');
    const context = loadFixedChainContext();
    const zz = context.ZZ_DATA[String(raw.zizhi)];
    const engine = new context.WashSourceEngine.Engine(
        context.TALENT_DATA,
        raw,
        {
            slotCount: Number(zz.num_talent),
            pity: Number(zz.bd_zz),
            eat: Number(zz.eat_xisui),
            eligibleZi: raw.zizhi,
            advancePerDraw: true,
            dlcMode: !!raw.dlc_mode,
        }
    );
    let state = engine.initialState(
        Object.assign({}, raw, { zizhi: raw.zizhi })
    );
    const wash = (keepIds, count) => {
        state = orderedState(state, keepIds);
        for (let index = 0; index < count; index++) {
            state = engine.wash(
                state,
                keepIds.map((_, position) => position)
            ).state;
        }
    };
    wash([], 35);
    wash([273, 276], 3);
    const lockSet = [273];
    const exchangeRaw = Object.assign({}, raw, {
        zizhi: state.zizhi,
        seed: state.bornSeed,
        luck_seed: state.luckSeed,
        luck_seed_inited: state.luckSeed != null,
        born_talent_rc: state.bornRC,
        tal_lucky: state.talLucky,
        talents: state.talents.map(id => ({
            id,
            locked: lockSet.includes(id),
        })),
    });
    return {
        raw: exchangeRaw,
        state,
        lockSet,
        carrierId: 276,
        conflictId: 273,
    };
}

function bujingyunFixture() {
    const { raw: base } = loadBaseRaw('步惊云');
    const raw = Object.assign({}, base, {
        zizhi: 153,
        seed: 500283554,
        luck_seed: 1826357454,
        luck_seed_inited: true,
        born_talent_rc: 1408,
        tal_lucky: 0,
        talents: [267, 174, 172].map(id => ({
            id,
            locked: false,
        })),
    });
    return {
        name: 'bujingyun',
        raw,
        targets: TARGETS.slice(),
        budget: 8000 - 836,
        spentPills: 836,
        reference: {
            pills: 6871,
            washes: 1084,
            exchanges: 11,
        },
    };
}

module.exports = {
    ROOT,
    TARGETS,
    loadFixedChainContext,
    taohuaFixture,
    taohuaExchangeFixture,
    bujingyunFixture,
};
