const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sandbox = {
    console,
    document: {
        getElementById() { return null; },
        addEventListener() {},
    },
    setTimeout() { return 0; },
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const context = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'web/role/role.js'), 'utf8'), context, {
    filename: 'web/role/role.js',
});

assert.equal(vm.runInContext('neijinInfluenceRate(0)', context), 0);
assert.equal(vm.runInContext('neijinInfluenceRate(2000)', context), 1);
const rows = vm.runInContext('neijinReferenceRows(1000)', context);
assert.deepEqual(Array.from(rows, row => row.neijin), [1000, 1050, 1100, 1150]);
assert.ok(rows[3].rate > rows[2].rate);
assert.ok((rows[3].rate - rows[2].rate) < (rows[1].rate - rows[0].rate),
    'the reference should expose diminishing marginal returns');

assert.equal(vm.runInContext("refinedMainBonus(159, 'neijin')", context), 319);
assert.equal(vm.runInContext("refinedMainBonus(242, 'gangqi')", context), 280);
assert.equal(vm.runInContext("equipNeijin({ Neijin: 60, XLLevel: 159 })", context), 300,
    'refinement must raise the accessory main stat up to the 300 Neijin cap');
assert.equal(vm.runInContext("equipGangqi({ Gangqi: 60, XLLevel: 242 })", context), 200,
    'refinement must raise the armor main stat up to the 200 Gangqi cap');
assert.equal(vm.runInContext(`[
    equipNeijin({ Neijin: 60, XLLevel: 159 }),
    equipNeijin({ Neijin: 60, XLLevel: 347 }),
    equipNeijin({ Neijin: 240, XLLevel: 0 }),
].reduce((sum, value) => sum + value, 0)`, context), 840,
    'the supplied main-role equipment must total 840 Neijin');

const lifeBonus = vm.runInContext(`lifeNjGqBonus([{
    level: 300,
    menpai: 0,
    cfg: { effects: [['neijper', 10, 0.01]] },
}], 'neijin', 1336)`, context);
assert.equal(lifeBonus.rate, 0.3);
assert.equal(lifeBonus.percent, 400,
    'Baima Tongrong at level 300 must add floor(1336 * 30%) = 400 Neijin');

const flatGangqi = vm.runInContext(`lifeNjGqBonus([{
    level: 300,
    menpai: 0,
    cfg: { effects: [['gangqi', 30, 25]] },
}], 'gangqi', 1000)`, context);
assert.equal(flatGangqi.total, 250,
    'flat secret-tech Gangqi must be included');

const baseRole = {
    ID: 1, Level: 100, Age: 16, ExtGangqi: 0, GrowGangqi: 0,
    Neis: [], Taolus: [], Qings: [], LifeSkills: [], LifeProps: [],
    HeDaoSkill: [], Talents: [], JingMais: [],
};
context.mainRole = {
    ...baseRole,
    ExtNeijin: 356,
    GrowNeijin: 20,
    Equips: [
        { Neijin: 60, XLLevel: 159 },
        { Neijin: 60, XLLevel: 347 },
        { Neijin: 240, XLLevel: 0 },
    ],
};
const mainStats = vm.runInContext('computeFinalStats(mainRole, [mainRole])', context);
assert.equal(mainStats.body.neijin, 556);
assert.equal(mainStats.equip.neijin, 840);
assert.equal(mainStats.neijin, 1396);
assert.equal(mainStats.gangqi, 0, 'refinement must not add Gangqi to Neijin equipment');

vm.runInContext(`var LIFE_HEDAO_DATA = {
    skills: { '614': { id: 614, type: 2, effects: [['neijper', 10, 0.01]] } },
    hedao: {},
}`, context);
context.companion = {
    ...baseRole,
    Level: 92,
    ExtNeijin: 400,
    GrowNeijin: 20,
    LifeProps: [{ ID: 614, Level: 300 }],
    Equips: [
        { Neijin: 300 }, { Neijin: 300 }, { Neijin: 300 }, { Neijin: 36 },
    ],
};
const companionStats = vm.runInContext('computeFinalStats(companion, [companion])', context);
assert.equal(companionStats.body.neijin, 400);
assert.equal(companionStats.equip.neijin, 936);
assert.equal(companionStats.njgq.lifeNeijin, 400);
assert.equal(companionStats.neijin, 1736);

console.log('role neijin reference tests passed');
