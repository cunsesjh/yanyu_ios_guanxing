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
    assert.equal(oneSlot.searchMode, 'direct-low-slot');
    assert.equal(oneSlot.route.pills, 0);
    assert.equal(oneSlot.route.steps[0].after.zizhi, 153,
        'route results include talents after each visible operation');
    assert.equal(oneSlot.route.steps[0].after.talents[0].id, 271);

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

    assert.equal(context.InfiniteSeedFrontier.normalizeNMax(), 300);
    assert.equal(context.InfiniteSeedFrontier.normalizeNMax(500), 300);
    assert.equal(context.InfiniteSeedFrontier.normalizeNMax(100), 100);
    console.log('AWASH low-slot and expanded padding tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
