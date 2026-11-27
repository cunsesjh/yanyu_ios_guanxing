const assert = require('node:assert/strict');
const {loadAWash} = require('../awash/context');
const solver = require('../awash/solve');

const context = loadAWash();
require('../web/shared/auto_wash2_model.js');
const rawFor = zizhi => ({
    seed: 12345,
    born_talent_rc: 0,
    luck_seed: 12345,
    luck_seed_inited: true,
    tal_lucky: 0,
    zizhi,
    role_id: 10044,
    sex: 1,
    vip: 1,
    role_level: 100,
    talents: [271],
});

(async () => {
    const oneTarget = global.AutoWash2Model.targets(
        {talents: []}, new Map([[271, -1]]), {271: {weight: 4}}
    );
    assert.deepEqual(oneTarget.targetIds, [271]);

    const engine = new context.WashSourceEngine.Engine(
        context.TALENT_DATA, rawFor(151)
    );
    const initial = engine.initialState(rawFor(151));
    const allowed = engine.allowedForState(initial, initial.zizhi);
    assert.ok((allowed.size || allowed.length || 0) > 0,
        'the one-slot role can load its available talent pool');

    const oneSlot = await solver.solveJoint(rawFor(151), [271], {context});
    assert.equal(oneSlot.ok, true, 'one-slot role with one target should be plannable');
    assert.ok(oneSlot.searchMode.startsWith('low-slot-'),
        'one-slot roles use the low-slot planning path');
    assert.equal(oneSlot.route.pills, 0);
    assert.equal(oneSlot.route.steps[0].after.zizhi, 153,
        'route results include talents after each visible operation');
    assert.equal(oneSlot.route.steps[0].after.talents[0].id, 271);

    const oneSlotUnfixed = Object.assign({}, rawFor(151), {
        seed: 184736291,
        luck_seed: 0,
        luck_seed_inited: false,
        talents: [],
    });
    const oneSlotWash = await solver.solveJoint(
        oneSlotUnfixed,
        [271],
        {
            context,
            budget: 1000000,
            limits: {
                maxRuntimeMs: 30000,
                maxExpandedNodes: 100000,
                maxWashSteps: 200000,
                maxUniqueStates: 100000,
            },
            runtime: {beamWidth: 50, maxDepth: 60},
        }
    );
    assert.equal(oneSlotWash.ok, true,
        'one-slot roles without a fixed luck seed can wash to a target');
    assert.ok(oneSlotWash.searchMode.startsWith('low-slot-'),
        'one-slot wash routes use the low-slot planning path');
    assert.ok(oneSlotWash.route.pills > 0);
    assert.ok(oneSlotWash.route.steps.every(step => step.after),
        'one-slot wash routes include a state after every step');

    const threeSlot = await solver.solveJoint(rawFor(153), [271], {context});
    assert.equal(threeSlot.ok, true, 'the backend must accept a single target for any slot count');
    assert.equal(threeSlot.route.pills, 0);

    const traceRaw = rawFor(153);
    const adapter = context.WashSearchV2.createRuleAdapter(traceRaw);
    const washed = adapter.wash(adapter.start.state, [271]);
    const replayed = context.WashSearchV2.replay(traceRaw, [271], [
        {op: 'locks', lockIds: [271]},
        {op: 'wash', keepIds: [271], count: 1, cost: washed.cost},
    ], true);
    assert.equal(replayed.ok, true);
    assert.equal(replayed.trace.length, 2);
    assert.equal(replayed.trace[0].talents[0].locked, true);
    assert.equal(replayed.trace[1].talents[0].locked, true);
    assert.deepEqual(replayed.trace[1].talents.map(item => item.id),
        washed.state.talents,
        'each route step carries its exact current talent state');

    assert.equal(context.InfiniteSeedFrontier.normalizeNMax(), 100);
    assert.equal(context.InfiniteSeedFrontier.normalizeNMax(500), 100);
    assert.equal(context.InfiniteSeedFrontier.normalizeNMax(100), 100);
    console.log('AWASH low-slot and expanded padding tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
