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
assert.equal(typeof sandbox.AutoWash2UnifiedRouteConstructor.constructBest, 'function',
    'the latest upstream unified route constructor must be part of the worker search');
assert.equal(sandbox.AutoWash2SearchPolicy.initialSearchWindow(), 120000);
assert.equal(sandbox.AutoWash2SearchPolicy.initialSearchWindow(1000), 400);
assert.equal(sandbox.AutoWash2SearchPolicy.searchTimeLimit(4), 900000,
    'four-target searches may run for up to fifteen minutes');
assert.equal(sandbox.AutoWash2SearchPolicy.searchTimeLimit(3), 600000,
    'searches with fewer than four targets stay capped at ten minutes');
assert.deepEqual(JSON.parse(JSON.stringify(sandbox.AutoWash2SearchPolicy.stages.map(s => [s.fraction, s.intensity]))),
    [[0.2, 1], [0.3, 2], [0.3, 3], [0.2, 4]], 'four progressive stages must consume the full shared deadline');
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
const fourTargetSelection = model.targets(converted,
    new Map([[272, 0], [250, 1], [249, 2]]), data);
assert.ok(model.combinations(fourTargetSelection).every(branch => branch.length === 4),
    'required talents plus three compatible groups form four-target branches');
assert.equal(sandbox.AutoWash2SearchPolicy.searchTimeLimit(model.combinations(fourTargetSelection)[0].length), 900000);
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
    // Preview/early-access uses the domestic table order and must remain
    // bit-for-bit identical to the current domestic engine.
    {
        const base = {...converted, zizhi:154, talents:[], tal_lucky:0};
        const domestic = new sandbox.AutoWash2Engine.Engine(sandbox.TALENT_DATA, base);
        const preview = new sandbox.AutoWash2Engine.Engine(sandbox.TALENT_DATA,
            {...base, save_channel:'先行服'});
        let a = domestic.initialState(base), b = preview.initialState(base);
        for (let i = 0; i < 30; i++) {
            a = domestic.wash(a, []).state; b = preview.wash(b, []).state;
            assert.equal(JSON.stringify(a), JSON.stringify(b), 'preview channel must share domestic wash rules');
        }
    }
    // International uses the same RNG transition but a different talent table
    // order. Cross-check the AutoWash2 adapter against the existing dedicated
    // international simulator for unlocked and locked washes.
    vm.runInContext(fs.readFileSync(path.join(root, 'international_wash.js'), 'utf8'), context,
        {filename:'international_wash.js'});
    {
        const intlRaw = {...converted, save_channel:'international', zizhi:154,
            talents:[], tal_lucky:0, luck_seed:0, luck_seed_inited:false};
        const adapter = new sandbox.AutoWash2Engine.Engine(sandbox.TALENT_DATA, intlRaw);
        let actual = adapter.initialState(intlRaw);
        const reference = {saveChannel:'international', zizhi:154, sex:intlRaw.sex, vip:intlRaw.vip,
            seed:intlRaw.seed, luckSeed:0, luckSeedInited:false, roleId:intlRaw.role_id,
            salt:intlRaw.salt, talents:[], talLucky:0, bornTalentRC:intlRaw.born_talent_rc,
            roleLevel:intlRaw.role_level, roleStats:intlRaw.role_stats, globalVars:intlRaw.global_vars,
            totalWash:0,totalTalentBars:0,totalPills:0,bagPills:0,hasBagPills:false,
            goldCount:0,pityCount:0,qualityCounts:{1:0,2:0,3:0,4:0},exchangeCount:0};
        for (let i = 0; i < 60; i++) {
            const keep = i % 4 === 0 && actual.talents.length ? [0] : [];
            reference.talents = actual.talents.map((id, index) => ({id, locked:keep.includes(index)}));
            const expected = sandbox.internationalWashCore(reference, adapter.allowed, true);
            const result = adapter.wash(actual, keep); actual = result.state;
            assert.ok(expected, 'international reference wash must advance');
            assert.equal(result.cost, expected.pills_used);
            assert.deepEqual(JSON.parse(JSON.stringify(actual.talents)),
                JSON.parse(JSON.stringify(reference.talents.map(t => t.id))));
            assert.equal(actual.bornSeed, reference.seed);
            assert.equal(actual.bornRC, reference.bornTalentRC);
            assert.equal(actual.luckSeed, reference.luckSeedInited ? reference.luckSeed : null);
            assert.equal(actual.talLucky, reference.talLucky);
        }
        const intlStart = {...intlRaw, talents:[], tal_lucky:900};
        const intlEngine = new sandbox.AutoWash2Engine.Engine(sandbox.TALENT_DATA, intlStart);
        const intlFirst = intlEngine.wash(intlEngine.initialState(intlStart), []);
        const intlTarget = intlFirst.state.talents.find(id => sandbox.TALENT_DATA[id].weight === 4);
        const intlCandidate = {ok:true, kind:'international-test', cost:intlFirst.cost,
            steps:[{type:'wash', washes:1, cost:intlFirst.cost, locks:[], field:intlFirst.state.talents}]};
        const intlUnified = sandbox.AutoWash2Unified.convert({initialState:intlStart,
            options:{maxTotalPills:intlFirst.cost},bagPills:100,hasBagPills:true}, [intlTarget], intlCandidate);
        assert.ok(intlUnified?.verified, 'international unified route must replay with the international table order');
        assert.equal(intlUnified.channelEngine, '国际服');
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
    const settings = {options:{maxTotalPills:10000}, bagPills:5000, hasBagPills:true};
    const upstreamCandidate = sandbox.AutoWash2UnifiedRouteConstructor.constructBest(
        anchorRaw, targetIds, {budget:10000, timeMs:5000, nMax:40, topN:20, maxWash:3000});
    const upstreamUnified = sandbox.AutoWash2Unified.convert({...settings, initialState:anchorRaw},
        targetIds, upstreamCandidate, 'U');
    assert.ok(upstreamUnified?.verified, 'ported upstream route must pass our independent replay');
    assert.equal(upstreamUnified.sourceFamily, 'U');
    assert.equal(upstreamUnified.seedMethod, 'exchange');
    assert.equal(upstreamUnified.postSeedMode, 'exchange-chain');
    assert.ok(upstreamUnified.steps.every(step => step.after.talents.length > 0),
        'unified route steps must include their post-action field snapshot');
    assert.equal(upstreamUnified.steps.reduce((sum, step) => sum + step.washes, 0),
        upstreamUnified.totalWashes, 'displayed wash counts must add up to the verified total');
    assert.ok(upstreamUnified.steps.some(step => step.detail.includes('本段洗髓')),
        'wash segments must be called out in the step details');
    const legacy = planner.search(anchorRaw, anchors, source, 0,
        {targets:targetIds, maxNodes:500, depth:10, maxCost:10000, sequenceBasis:'theory2'}).routes[0];
    assert.equal(legacy.cost, 1025);
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
    // Sanitized regression for the documented 7,311-pill lock-seed route.
    // Keep only fields used by the wash engine; no full save/global vars.
    {
        const lockRaw = {seed:1331151271, born_talent_rc:86, luck_seed:0,
            luck_seed_inited:false, tal_lucky:47, zizhi:153, role_id:10060,
            sex:1, role_level:100, salt:573887, vip:1,
            role_stats:{str_val:314, con:123, dex:20, int_val:15}, global_vars:{},
            save_channel:'', talents:[{id:199,locked:false},{id:190,locked:false},{id:193,locked:false}]};
        const lockTargets = [250,268,271,272];
        const candidate = sandbox.AutoWash2RouteConstructor.planBest(lockRaw, lockTargets,
            {budget:10000,methodMs:25000,onlyPaths:['B'],nMax:100,count:40,lead:24});
        assert.equal(candidate?.seedOpt?.seed, 915630490,
            'automatic lock search must prioritize the documented lock seed');
        const checked = sandbox.AutoWash2Unified.convert({initialState:lockRaw,
            options:{maxTotalPills:10000}},lockTargets,candidate,'B');
        assert.equal(checked?.totalPills,7311);
        assert.equal(checked?.totalWashes,1071);
        assert.equal(checked?.seedMethod,'lock');
        assert.equal(checked?.postSeedMode,'exchange-chain');
    }
    // The third engine changes the first luck-seed landing, then hands its
    // candidate to our independent replay adapter before it can be displayed.
    const seedTargets = [276, 268];
    const seedResult = sandbox.AutoWash2SeedPlanner.solve(anchorRaw, seedTargets, {
        slots: 3, maxPills: 10000, maxJump: 12, queueLength: 20,
        sweep: false, padForTarget: true, timeBudgetMs: 5000,
    });
    const seedRoute = sandbox.AutoWash2Seed.convert({...settings, initialState: anchorRaw}, seedTargets, seedResult);
    assert.ok(seedRoute, 'seed engine must produce an independently replayed route');
    assert.equal(seedRoute.kind, 'luck-seed-replay');
    assert.equal(seedRoute.verified, true);
    assert.ok(seedRoute.totalPills <= 10000);
    assert.ok(seedTargets.every(id => seedRoute.finalTalents.some(t => t.id === id)));
    const tamperedSeedSteps = JSON.parse(JSON.stringify(seedResult.winner.pick.plan.steps));
    const firstWash = tamperedSeedSteps.find(step => step.type === 'wash');
    firstWash.lockIds = [999999];
    assert.throws(() => sandbox.AutoWash2Seed.replay(anchorRaw, seedTargets,
        tamperedSeedSteps, seedResult.zizhi), /回放失败/);
    // The full unified constructor is namespace-isolated and its adapter must
    // independently replay even a mechanically supplied candidate.
    const oneWash = new sandbox.AutoWash2Engine.Engine(sandbox.TALENT_DATA, anchorRaw)
        .wash(new sandbox.AutoWash2Engine.Engine(sandbox.TALENT_DATA, anchorRaw).initialState(anchorRaw), []);
    const oneTarget = oneWash.state.talents.find(id => sandbox.TALENT_DATA[id].weight === 4);
    if (oneTarget) {
        const candidate = {ok:true, kind:'test', cost:oneWash.cost,
            steps:[{type:'wash', washes:1, cost:oneWash.cost, locks:[], field:oneWash.state.talents}]};
        const unified = sandbox.AutoWash2Unified.convert({...settings, initialState:anchorRaw}, [oneTarget], candidate);
        assert.ok(unified && unified.verified, 'unified candidate must pass independent replay');
        candidate.steps[0].field = [999999];
        // Recorded fields are display-only; corrupting the executable target is rejected instead.
        candidate.steps[0].locks = [999999];
        assert.equal(sandbox.AutoWash2Unified.convert({...settings, initialState:anchorRaw}, [oneTarget], candidate), null);
    }
    // Keep the known long-prefix continuous-exchange strategy from being
    // starved behind later-stage seed scans.
    {
        const calls = [];
        const early = {WashSourceEngine:{isInternationalChannel:()=>false},
            AutoWash2RouteConstructor:{
                readSequence() { return {seq:[{id:268, no:1, fromPity:false, conflictId:1}]}; },
                resolveSeedState() { return {valid:true, fixed:false, seedStatus:'unfixed'}; },
                resolveSeedMethod() { return {valid:true, methodFamily:'swallow+infinite-exchange',
                    allowsSwallow:true, allowsInfiniteExchange:true}; },
                verify() { return {ok:false}; },
                verifyJumpManual() { return {ok:false}; },
                planBest(_raw, _targets, options) { calls.push(options); return null; },
            },
            AutoWash2UnifiedRouteConstructor:{constructBest() {
                calls.push({onlyPaths:['U']}); return null;
            }}};
        early.window = early;
        vm.runInContext(fs.readFileSync(path.join(root, 'auto_wash2_unified.js'), 'utf8'),
            vm.createContext(early));
        early.AutoWash2Unified.search({initialState:{zizhi:153}, options:{maxTotalPills:10000}},
            [276, 268, 266], () => {}, () => {}, {intensity:1, timeBudgetMs:10000});
        assert.deepEqual(JSON.parse(JSON.stringify(calls[0].onlyPaths)), ['G'],
            'first stage must prioritize the continuous-exchange search');
        assert.equal(calls[0].budget, 10000, 'early path must retain the user pill ceiling');
        assert.deepEqual(JSON.parse(JSON.stringify(calls.map(call => call.onlyPaths))),
            [['G'], ['B'], ['E']], 'candidate families must receive isolated bounded passes');
        calls.length = 0;
        early.AutoWash2Unified.search({initialState:{zizhi:153}, options:{maxTotalPills:10000}},
            [276, 268, 266], () => {}, () => {}, {intensity:4, timeBudgetMs:30000});
        assert.deepEqual(JSON.parse(JSON.stringify(calls.map(call => call.onlyPaths))),
            [['G'], ['B'], ['U'], ['E'], ['D'], ['A']],
            'full intensity must isolate continuous exchange, fixed/pity, lock, jump and exchange families');
    }
    {
        const calls = [];
        const lowAptitude = {WashSourceEngine:{isInternationalChannel:()=>false},
            TALENT_DATA:{268:{name:'天生神力'}}, AutoWash2RouteConstructor:{
                verify() { calls.push('generic'); return {ok:false}; },
                verifyJumpManual(_raw, _targets, _steps, zi) {
                    calls.push(['jumpManual', zi]);
                    return {ok:true, cost:42, washes:7, zizhi:153,
                        state:{talents:[268], bornSeed:123, luckSeed:null, bornRC:0, talLucky:0}};
                },
            }};
        lowAptitude.window = lowAptitude;
        vm.runInContext(fs.readFileSync(path.join(root, 'auto_wash2_unified.js'), 'utf8'),
            vm.createContext(lowAptitude));
        const route = lowAptitude.AutoWash2Unified.convert({initialState:{zizhi:151},
            options:{maxTotalPills:10000}}, [268], {ok:true, kind:'jumpManual', zizhi:153,
            cost:42, steps:[{type:'startWash', washes:7, cost:42, startZi:153, field:[268]},
                {type:'exchange', washes:7, cost:42, from:1, to:268, field:[268]}]}, 'B');
        assert.ok(route?.verified, 'manual routes must use their dedicated verifier');
        assert.equal(route.seedMethod, 'lock', 'seed method must stay separate from route shape');
        assert.equal(route.postSeedMode, 'exchange-chain');
        assert.equal(route.sourceFamily, 'B');
        assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['jumpManual', 153]],
            'verify from the route start aptitude, not the save aptitude');
    }
    // Real iOS 73576 regression: the cheapest verified path opens the fourth
    // slot immediately, retains an earlier low-grade carrier, pads the purple
    // exchange twice, then follows a straight two-target tail.
    {
        const shang = {
            mode:'seed', zizhi:153, sex:1, vip:1,
            seed:1377955264, born_talent_rc:10,
            luck_seed:0, luck_seed_inited:false,
            role_id:10031, salt:551595, tal_lucky:31, role_level:100,
            role_stats:{str_val:393, con:12, dex:12, int_val:13},
            global_vars:{}, save_channel:'',
            talents:[{id:205,locked:true},{id:203,locked:true},{id:185,locked:true}],
        };
        const candidates = [];
        await sandbox.AutoWash2Optimizer.searchWashRoutes({
            initialState:shang, talentData:sandbox.TALENT_DATA,
            targetIds:[250,271,272], bagPills:7397, hasBagPills:true,
            options:{maxTotalPills:5000, searchIntensity:4},
            onCandidate:value => candidates.push(...(value.routes || [])),
            shouldCancel:() => candidates.some(route => route.totalPills === 4523),
        });
        const exact = candidates.find(route => route.totalPills === 4523);
        assert.ok(exact, 'Shang Haoqian immediate-four-slot route must not be pruned');
        assert.equal(exact.totalWashes, 605);
        assert.equal(exact.exchangeCount, 1);
        assert.deepEqual(JSON.parse(JSON.stringify(exact.finalTalents.map(t => t.id))),
            [250,272,271,172]);
    }
    console.log('PASS: four-stage family scheduler, upstream unified route replay, 7,311-pill lock regression, domestic/preview parity, international parity, target groups, inventory, engine parity and tamper/budget rejection');
})().catch(error => { console.error(error); process.exitCode = 1; });
