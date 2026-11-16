const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sandbox = {
    console,
    document: { addEventListener() {} },
    setTimeout() { return 0; },
    clearTimeout() {},
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const context = vm.createContext(sandbox);

for (const file of [
    'web/shared/equip_data.js',
    'web/shared/equip_auto_optimizer.js',
    'web/equip/equip.js',
]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

const data = sandbox.EQUIP_DATA;
const optimizer = sandbox.EquipmentAutoOptimizer;
const redMarrow = data.special['8825'];
const stoneCore = data.special['8826'];
const dragonBone = data.special['2021'];
const ring100 = { id: 1, name: '100级戒指', typ: 8, need_lv: 100, MJSeed: 1234567 };
const ring90 = { ...ring100, name: '90级戒指', need_lv: 90 };
const belt100 = { id: 2, name: '100级腰带', typ: 5, need_lv: 100, MJSeed: 7654321 };
const belt90 = { ...belt100, name: '90级腰带', need_lv: 90 };

assert.equal(optimizer.specialMaterialSupportsEquip(redMarrow, ring100), true);
assert.equal(optimizer.specialMaterialSupportsEquip(redMarrow, ring90), false);
assert.equal(optimizer.specialMaterialSupportsEquip(redMarrow, belt100), false);
assert.equal(optimizer.specialMaterialSupportsEquip(stoneCore, belt100), true);
assert.equal(optimizer.specialMaterialSupportsEquip(stoneCore, belt90), false);
assert.equal(optimizer.specialMaterialSupportsEquip(stoneCore, ring100), false);
assert.equal(optimizer.specialMaterialSupportsEquip(dragonBone, ring90), true,
    'existing materials must keep their original part behavior');

assert.equal(vm.runInContext('specialMaterialSupportsEquip(EQUIP_DATA.special["8825"], ({typ:8, need_lv:100}))', context), true);
assert.equal(vm.runInContext('specialMaterialSupportsEquip(EQUIP_DATA.special["8825"], ({typ:8, need_lv:90}))', context), false);
assert.equal(vm.runInContext('specialMaterialSupportsEquip(EQUIP_DATA.special["8826"], ({typ:5, need_lv:100}))', context), true);
assert.equal(vm.runInContext('specialMaterialSupportsEquip(EQUIP_DATA.special["8826"], ({typ:7, need_lv:100}))', context), false);

const redSequence = optimizer.predictSpecialAttachSequence(ring100, redMarrow, 5);
assert.equal(redSequence.items.length, 5);
assert.ok(redSequence.items.every(item => item.prop === 'neij'));
const stoneSequence = optimizer.predictSpecialAttachSequence(belt100, stoneCore, 5);
assert.equal(stoneSequence.items.length, 5);
assert.ok(stoneSequence.items.every(item => item.prop === 'gangqi'));
const pageRedSequence = vm.runInContext(
    'predictSpecialAttachSequence(({name:"100级戒指", typ:8, need_lv:100, MJSeed:1234567}), EQUIP_DATA.special["8825"], 3)',
    context,
);
assert.equal(pageRedSequence.length, 3);
assert.ok(pageRedSequence.every(item => item.prop === 'neij'));

const orangePapers = vm.runInContext('orangePapersForNpc(40520).map(item => item.paper)', context);
assert.ok(orangePapers.length > 0, 'orange blueprint category must contain entries');
assert.ok(orangePapers.every(paper => Number(paper.min_color) === 5 && Number(paper.max_color) === 5));
assert.ok(orangePapers.some(paper => Number(paper.id) === 3478), '炎火戒图样 should be visible');

const html = fs.readFileSync(path.join(root, 'web/equip/index.html'), 'utf8');
assert.ok((html.match(/value="orange"/g) || []).length >= 2,
    'both linked equipment category selectors must expose orange blueprints');
assert.match(html, /<option value="" selected>全部<\/option>/,
    'equipment prediction quality filter must default to all results');
assert.doesNotMatch(html, /<option value="4" selected>紫<\/option>/);
const equipSource = fs.readFileSync(path.join(root, 'web/equip/equip.js'), 'utf8');
assert.match(equipSource, /DEFAULT_MAKE_COLOR_FILTER = ''/,
    'prediction reset must keep the all-quality filter selected');

console.log('equipment feature regression tests passed');
