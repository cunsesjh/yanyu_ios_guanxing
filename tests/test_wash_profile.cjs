const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const shared = path.resolve(__dirname, '../web/shared');
const sandbox = { console, TextEncoder, structuredClone };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const context = vm.createContext(sandbox);
for (const file of ['data.js', 'sequence_rules.js', 'wash_route_engine.js', 'wash_source_engine.js', 'wash_engine_registry.js']) {
    vm.runInContext(fs.readFileSync(path.join(shared, file), 'utf8'), context, { filename: file });
}

assert.equal(typeof sandbox.SequenceRules.washRC, 'function');
assert.equal(typeof sandbox.WashSourceEngine.Engine, 'function');
assert.equal(sandbox.WashEngineRegistry.selectForProfile(), 'official');
assert.equal(sandbox.WashEngineRegistry.usesSourceEngine(), true);

// Keep this as a wiring/API smoke test. The previous hard-coded sample routes
// were retired; route parity is exercised only with currently approved samples.
const initial = {
    seed: 184736291, born_talent_rc: 10, luck_seed: 0,
    luck_seed_inited: false, tal_lucky: 0, zizhi: 154, role_id: 10044,
    sex: 1, role_level: 90, salt: 278440, vip: 1,
    role_stats: { str_val: 120, con: 110, dex: 100, int_val: 100 },
    global_vars: {}, save_channel: '', save_version: 0,
    talents: [],
};
const engine = new sandbox.WashSourceEngine.Engine(sandbox.TALENT_DATA, initial);
const state = engine.initialState(initial);
const allowed = engine.allowedForState(state, state.zizhi);
assert.equal(typeof allowed.has, 'function');
assert.ok(allowed.size > 0);
assert.deepEqual([...allowed], [...engine.allowedSet(state.zizhi)]);
const first = engine.wash(state, []);
assert.equal(first.state.talents.length, 4);
assert.ok(Number.isFinite(first.cost) && first.cost >= 0);

sandbox.state = { saveChannel: 'international', savePlatform: 'oversea' };
assert.equal(sandbox.WashEngineRegistry.selectForProfile(), 'international');
assert.equal(sandbox.WashEngineRegistry.usesSourceEngine(), false);

console.log('wash profile bootstrap smoke test passed');
