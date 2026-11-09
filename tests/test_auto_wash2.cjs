/* Run with Node 22+: exercises the real isolated worker and current source engine. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../web/shared');
const messages = [];
const sandbox = {console, TextEncoder, TextDecoder, Uint8Array, WebAssembly, performance,
    atob, setTimeout, clearTimeout, postMessage: message => messages.push(message)};
sandbox.self = sandbox;
const context = vm.createContext(sandbox);
sandbox.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename: file}));
vm.runInContext(fs.readFileSync(path.join(root, 'auto_wash2_worker.js'), 'utf8'), context);
const model = sandbox.AutoWash2Model;
assert.equal(sandbox.AutoWash2SearchPolicy.initialSearchWindow(), 120000);
assert.equal(sandbox.AutoWash2SearchPolicy.initialSearchWindow(1000), 400);
const save = {CenterID: 1278440, Items: [{ID: 2601, Num: 100}], globalVariable: {test: 1}};
const role = {ID: 10044, Name: '测试', ZiZhi: 154, BornTalent: {S: 12345, RC: 7},
    Talents: [{ID: 271, Lock: true}], Str: 100, BornStr: 10, StrGift: 1000};
const before = JSON.stringify({save, role});
const raw = model.snapshot(save, role, {vip: 2});
assert.equal(raw.role_stats.str_val, 116);
assert.equal(raw.salt, 278440);
const objectTalentRole = {...role, Talents: {'0': {ID: 271, Lock: true}, '1': {id: 272, locked: false}}};
assert.deepEqual(JSON.parse(JSON.stringify(model.snapshot(save, objectTalentRole).talents)),
    [{id: 271, locked: true}, {id: 272, locked: false}], 'accept object-shaped role talents');
assert.deepEqual(JSON.parse(JSON.stringify(model.snapshot(save, {...role, Talents: 'invalid'}).talents)), [],
    'ignore malformed non-collection talent data without crashing');
raw.talents[0].locked = false;
raw.global_vars.test = 9;
assert.equal(JSON.stringify({save, role}), before, 'adapter must not mutate imported save');
const converted = model.snapshot(save, role, {vip: 2});
assert.equal(converted.luck_seed_inited, false);
const data = {271: {weight: 4}, 272: {weight: 4}, 250: {weight: 4}};
const selection = model.targets(converted, new Map([[272, 0], [250, 0]]), data);
assert.equal(selection.targetIds[0], 271, 'preserved purple is required');
assert.equal(model.combinations(selection).length, 2);
assert.throws(() => model.targets(converted, new Map([[272, -1], [250, -1], [249, -1], [248, -1]]), data), /1–4/);

async function send(type, payload) {
    messages.length = 0;
    await sandbox.onmessage({data: {type, requestId: 'test',
        ...(type === 'search' ? {searchTimeMs: 1000} : {}), ...payload}});
    const error = messages.find(m => m.type === 'error');
    assert.equal(error, undefined, error?.error);
    return messages;
}
(async () => {
    let rows = await send('inspect', {raw: converted});
    assert.ok(rows.find(r => r.type === 'summary').summary.allowed.includes(271));
    const expandedScope = await sandbox.AutoWash2Optimizer.searchWashRoutes({
        initialState: converted, talentData: sandbox.TALENT_DATA, targetIds: [271],
        options: {maxTotalPills: 0, searchIntensity: 3}});
    assert.equal(expandedScope.searchScope.searchIntensity, 3);
    assert.equal(expandedScope.searchScope.maxEventNodes, 900000);
    assert.equal(expandedScope.searchScope.maxEventDepth, 128);
    const input = {initialState: converted, targetIds: [271], compatibleGroups: [], bagPills: 100,
        hasBagPills: true, options: {maxTotalPills: 0}};
    rows = await send('search', {input});
    let result = rows.find(r => r.type === 'result').result;
    assert.ok(result.routes.length > 0);
    assert.equal(result.routes[0].totalPills, 0);
    assert.equal(result.routes[0].inventory.remaining, 100);
    assert.equal(result.routes[0].verified, true);
    // Group-only requests must be expanded before calling this kernel.
    rows = await send('search', {input: {...input, targetIds: [], compatibleGroups: [[271, 272]]}});
    result = rows.find(r => r.type === 'result').result;
    assert.ok(result.routes.some(r => r.finalTalents.some(t => t.id === 271)));
    rows = await send('search', {input: {...input, initialState: {...converted, talents: []}, targetIds: [271]}});
    assert.equal(rows.find(r => r.type === 'result').result.routes.length, 0, 'no fabricated route outside zero budget');
    // Cross-check adapter output against the engine used by the existing wash page,
    // including RC progression, locks, different aptitude levels and pity draws.
    for (const zizhi of [151, 152, 153, 154]) {
        const initial = {...converted, zizhi, talents: [], tal_lucky: 900};
        const config = sandbox.ZZ_DATA[zizhi];
        const baseline = new sandbox.AutoWash2SourceCache.UncachedEngine(sandbox.TALENT_DATA, initial, {
            slotCount: config.num_talent, eligibleZi: zizhi, pity: config.bd_zz,
            eat: config.eat_xisui, advancePerDraw: true, international: false,
        });
        const adapter = new sandbox.AutoWash2Engine.Engine(sandbox.TALENT_DATA, initial);
        let expected = baseline.initialState(initial), actual = adapter.initialState(initial);
        for (let i = 0; i < 30; i++) {
            const locks = i % 3 === 0 && expected.talents.length > 1 ? [0] : [];
            const a = baseline.wash(expected, locks), b = adapter.wash(actual, locks);
            assert.equal(JSON.stringify({...a.state, zizhi}), JSON.stringify(b.state));
            assert.equal(a.cost, b.cost);
            expected = a.state; actual = b.state;
        }
    }
    // A real nonzero-cost route must reproduce the current engine's first pity purple.
    const initial = {...converted, talents: [], tal_lucky: 900};
    const engine = new sandbox.AutoWash2Engine.Engine(sandbox.TALENT_DATA, initial);
    const predicted = engine.wash(engine.initialState(initial), []);
    const purple = predicted.state.talents.find(id => sandbox.TALENT_DATA[id].weight === 4);
    assert.ok(purple);
    rows = await send('search', {input: {...input, initialState: initial, targetIds: [purple], options: {maxTotalPills: predicted.cost}}});
    result = rows.find(r => r.type === 'result').result;
    const route = result.routes.find(r => r.totalPills === predicted.cost);
    assert.ok(route, 'must find and replay a real wash route');
    assert.equal(route.finalState.seed, predicted.state.bornSeed);
    assert.equal(route.finalState.born_talent_rc, predicted.state.bornRC);
    assert.equal(JSON.stringify({save, role}), before);
    // The new search strategy must reproduce a real legacy route and keep its
    // exact cost through conversion; no mocked route or private save fixture.
    const anchorRaw = {seed:23456, zizhi:153, role_id:10031, salt:278440, vip:1, sex:1,
        role_level:100, role_stats:{str_val:150, con:150, dex:150, int_val:150},
        talents:[], tal_lucky:0, luck_seed_inited:false};
    const anchorBefore = JSON.stringify(anchorRaw);
    const planner = sandbox.AnchorRoutePlanner;
    const purples = planner.scan(anchorRaw, 12);
    const anchors = purples.filter(p => !p.fromPity && p.id !== 251).slice(0, 3);
    const source = planner.usableSources(anchorRaw, anchors, purples)[0];
    const targetIds = [276, 268, 266];
    const legacy = planner.search(anchorRaw, anchors, source, 0,
        {targets:targetIds, maxNodes:500, depth:10, maxCost:10000, sequenceBasis:'theory2'}).routes[0];
    assert.equal(legacy.cost, 1025);
    const settings = {options:{maxTotalPills:10000}, bagPills:5000, hasBagPills:true};
    const migrated = sandbox.AutoWash2Anchor.convert(anchorRaw, anchors, legacy, targetIds, settings);
    assert.equal(migrated.verified, true);
    assert.equal(migrated.totalPills, 1025);
    assert.equal(migrated.steps.reduce((sum, s) => sum + s.pills, 0), 1025);
    assert.equal(migrated.inventory.remaining, 3975);
    assert.equal(sandbox.AutoWash2Anchor.convert(anchorRaw, anchors, legacy, targetIds,
        {...settings, options:{maxTotalPills:1024}}), null, 'respect pill ceiling');
    assert.doesNotThrow(() => planner.search(anchorRaw, anchors.slice(0, 2), source, 0,
        {targets: targetIds.slice(0, 2), maxNodes: 10, depth: 2, maxCost: 10000,
            sequenceBasis: 'theory2'}), 'two-target anchor planning must be supported');
    const broken = JSON.parse(JSON.stringify(legacy));
    broken.steps[0].after.cost++;
    assert.throws(() => sandbox.AutoWash2Anchor.convert(anchorRaw, anchors, broken, targetIds, settings), /回放/);
    assert.equal(JSON.stringify(anchorRaw), anchorBefore);
    console.log('PASS: immutable adapter, target groups, inventory, 120 uncached-engine parity checks, wash replay, exact 1025-pill legacy route migration and tamper/budget rejection');
})().catch(error => { console.error(error); process.exitCode = 1; });
