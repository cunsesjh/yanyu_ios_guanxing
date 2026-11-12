const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const shared = path.resolve(__dirname, '../web/shared');
const sandbox = { console, TextEncoder, structuredClone };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const context = vm.createContext(sandbox);
for (const file of ['data.js', 'wash_source_engine.js', 'wash_engine_registry.js']) {
    vm.runInContext(fs.readFileSync(path.join(shared, file), 'utf8'), context, { filename: file });
}

const initial = {
    mode: 'seed', zizhi: 154, sex: 1, vip: 1,
    seed: 366482940, born_talent_rc: 10,
    luck_seed: 0, luck_seed_inited: false,
    role_id: 1, role_level: 100, salt: 946561,
    // These are the incomplete base values derivable from the save. The game uses
    // full runtime stats for sx_limit, so they must not remove pool candidates.
    role_stats: { str_val: 228, con: 57, dex: 267, int_val: 61 },
    global_vars: { num_ZhuangGu: 1, talent_BaiSheng: 1, mh_tianfu_401: 1, taiyi_tf1: 0 },
    save_channel: '', tal_lucky: 313,
    talents: [205, 400, 193, 257].map(id => ({ id, locked: false })),
    total_wash: 0, total_talent_bars: 0, total_pills: 0,
    gold_count: 0, pity_count: 0, quality_counts: { 1: 0, 2: 0, 3: 0, 4: 0 },
};

function firstPity(lockedId) {
    sandbox.state = { saveChannel: '', savePlatform: '' };
    assert.equal(sandbox.WashEngineRegistry.selectForProfile(), 'official');
    assert.equal(sandbox.WashEngineRegistry.usesSourceEngine(), true);
    const state = structuredClone(initial);
    if (lockedId) state.talents.find(t => t.id === lockedId).locked = true;
    sandbox.wasmSetState(state);
    const rows = sandbox.wasmWashUntilGold(1000);
    assert.ok(rows.length > 0);
    return rows.at(-1);
}

const unlocked = firstPity();
assert.equal(unlocked.wash_no, 148);
assert.equal(unlocked.total_pills, 740);
assert.ok(unlocked.talents.some(t => t.id === 267),
    `unlocked first pity must be 天人合一: ${JSON.stringify(unlocked.talents)}`);

const locked = firstPity(257);
assert.equal(locked.wash_no, 197);
assert.equal(locked.total_pills, 1182);
assert.ok(locked.talents.some(t => t.id === 272),
    `locking 百战百胜 must yield 岿然顶天: ${JSON.stringify(locked.talents)}`);

sandbox.state = { saveChannel: 'international', savePlatform: 'oversea' };
assert.equal(sandbox.WashEngineRegistry.selectForProfile(), 'international');
assert.equal(sandbox.WashEngineRegistry.usesSourceEngine(), false);

console.log('wash profile regression tests passed');
