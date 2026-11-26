const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const elements = new Map();
const sandbox = {
    console, TextDecoder, TextEncoder, WebAssembly,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    location: { protocol: 'file:' },
    setTimeout: callback => { callback(); },
    document: {
        readyState: 'loading', addEventListener() {},
    getElementById(id) {
            if (!elements.has(id)) elements.set(id, { hidden: false, checked: false, style: {}, innerHTML: '', textContent: '', value: '', addEventListener() {} });
            return elements.get(id);
        },
    },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const context = vm.createContext(sandbox);
for (const file of ['equip_data.js', 'wasm_data.js', 'core_glue.js', 'equip_auto_optimizer.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'web/shared', file), 'utf8'), context);
}
const planner = fs.readFileSync(path.join(root, 'web/planner/planner.js'), 'utf8');
vm.runInContext(planner.replace("    if (document.readyState === 'loading')", `
    window.plannerRegression = {scoreCandidate, refinementDisplayTotal, renderLimitsTable, scanRoutes, addToCollection, renderResults, fillPlannerPropertyOptions, regionBonus,
        setResults: function (items) { results = items; },
        setSave: function (data) { saveData = data; }};
    if (document.readyState === 'loading')`), context);
const api = sandbox.plannerRegression;
assert.equal(api.regionBonus([{prop: 'dmg_off', value: 0.02}]), 11,
    'two percent regional damage reduction should add eleven points');
assert.equal(api.regionBonus([{prop: 'dmg_off', value: 0.02}, {prop: 'atk', value: 100}]), 12,
    'regional attachment points must be capped at twelve');
const candidate = {
    equipId: 5219, craftIndex: 65, upgraded: true, region: [{prop: 'hp', value: 400}],
    refinementRatingReference: {atk_add: 400, mp_back: 1},
    refinements: [{prop: 'atk_add', maxima: {1: {value: 160}, 2: {value: 116}, 3: {value: 80}},
        plan: {cost: {lianjin: 354}}}],
};
const weakerRef = {...candidate, region: [], refinements: [{prop: 'dmg_ref', maxima: {1: {value: 0.04}, 2: {value: 0.03}, 3: {value: 0.019}}, plan: {cost: {lianjin: 100}}}]};
const strongerRef = {...weakerRef, refinements: [{prop: 'dmg_ref', maxima: {1: {value: 0.05}, 2: {value: 0.04}, 3: {value: 0.021}}, plan: {cost: {lianjin: 100}}}]};
assert.ok(api.scoreCandidate(strongerRef, 900, 'dmg_ref', 0).baseScore > api.scoreCandidate(weakerRef, 900, 'dmg_ref', 0).baseScore,
    'for the same part and refinement property, a larger actual value must score higher');
assert.equal(api.scoreCandidate(candidate, 364, 'atk_add', 0).craftIndex, 65,
    'explicit target tracking must retain an affordable 356 attack candidate');
assert.equal(api.scoreCandidate(candidate, 363, 'atk_add', 0), null,
    'the upgrade cost must remain part of the total mud budget');
const blueCandidate = {...candidate, color: 3, region: [{prop: 'dmg_off', value: 0.02}]};
assert.equal(api.scoreCandidate(blueCandidate, 364, 'atk_add').qualityName, '蓝',
    'blue gear must retain its actual equipment color in planning results');
assert.ok(['极品', '神器'].includes(api.scoreCandidate(blueCandidate, 364, 'atk_add').grade),
    'blue gear with strong refinement and regional attachment must be eligible for premium/artifact grades');
const ring = {...candidate, equipId: 5409, region: [], refinements: [
    {prop: 'mp_back', maxima: {1: {value: 1}}},
]};
assert.equal(api.scoreCandidate(ring, 900, 'all'), null,
    'one qi must not qualify a ring as artifact or premium in fixed planning');
assert.equal(api.scoreCandidate(ring, 900, 'mp_back', 0).grade, '候选',
    'explicit qi tracking may show the result but cannot label it artifact');
const variants = [
    {...candidate, id: 'craft-east', paperId: 3429, specialId: 0, S: 10, CZSeed: 20, craftIndex: 65,
        equipName: '乌蚕宝甲', paperName: '乌蚕宝甲图样', location: '泠月', region: [{prop: 'dmg_ref', value: 0.03}],
        craftCost: {silver: 10}, upgradeCost: {silver: 20}},
    {...candidate, id: 'craft-west', paperId: 3429, specialId: 0, S: 11, CZSeed: 21, craftIndex: 65,
        equipName: '乌蚕宝甲', paperName: '乌蚕宝甲图样', location: '无双城', region: [{prop: 'dmg_off', value: 0.03}],
        craftCost: {silver: 10}, upgradeCost: {silver: 20}},
];
const deduped = [], dedupeIndexes = Object.create(null);
variants.forEach(item => api.addToCollection(deduped, dedupeIndexes, item, 900, 'atk_add', 0));
assert.equal(deduped.length, 1, 'the same crafted item must not be repeated for each region');
assert.equal(deduped[0].location, '无双城', 'keep the region with the higher attachment bonus');
assert.equal(api.refinementDisplayTotal({prop: 'dmg_off', maxima: {
    1: {value: 0.0329}, 2: {value: 0.0249}, 3: {value: 0.0160},
}}), '7.2%', 'percentages must be truncated per slot before summing');
sandbox.document.getElementById('partFilter').value = '7';
api.fillPlannerPropertyOptions();
assert.match(sandbox.document.getElementById('propertyFilter').innerHTML, /value="dmg_off"/,
    'property dropdown must list properties available for the selected part');
api.setResults([
    {part: 7, equipName: '免伤内甲', paperName: '甲图样', location: '甲店', craftIndex: 1, region: [], refinement: {prop: 'dmg_off', maxima: {1: {value: 0.01}}}, mud: 10, silver: 0, baseScore: 95, bonus: 0, finalScore: 95, grade: '极品'},
    {part: 7, equipName: '反伤内甲', paperName: '乙图样', location: '乙店', craftIndex: 2, region: [], refinement: {prop: 'dmg_ref', maxima: {1: {value: 0.01}}}, mud: 10, silver: 0, baseScore: 95, bonus: 0, finalScore: 95, grade: '极品'},
]);
sandbox.document.getElementById('propertyFilter').value = 'dmg_off';
api.renderResults();
assert.match(sandbox.document.getElementById('resultGroups').innerHTML, /免伤内甲/);
assert.doesNotMatch(sandbox.document.getElementById('resultGroups').innerHTML, /反伤内甲/,
    'property dropdown must filter fixed-planning results');
sandbox.document.getElementById('limitsPartFilter').value = '7';
api.renderLimitsTable();
const limitsHtml = elements.get('limitsDiagramGroups').innerHTML;
assert.equal((limitsHtml.match(/class="limits-paper-card/g) || []).length, 2,
    'each level-90 inner-armor blueprint must receive its own expandable limit card');
assert.equal((limitsHtml.match(/<details class="limits-paper-card" open>/g) || []).length, 2,
    'both blueprints for the selected part must start expanded');
assert.match(limitsHtml, /乌蚕宝甲图样/);
assert.match(limitsHtml, /攻击<\/th><td>163<\/td><td>122<\/td><td>81<\/td>/,
    'attack limits must list three individual slot maxima instead of only a total');
const html = fs.readFileSync(path.join(root, 'web/planner/index.html'), 'utf8');
assert.deepEqual(Array.from(html.matchAll(/data-planner-tool="([^"]+)"/g), match => match[1]),
    ['target', 'fixed', 'standards']);
assert.match(html, /来源：B站《丶索巴宰》/);
assert.ok(fs.existsSync(path.join(root, 'web/planner/pvp-refine-standards.png')));
const simulator = fs.readFileSync(path.join(root, 'web/shared/simulator.js'), 'utf8');
assert.match(simulator, /id="equipAutoShowBlueFilter"/,
    'automatic equipment results must expose a show-blue checkbox');
assert.match(simulator, /includeBlue: true/,
    'automatic equipment simulation must analyze blue gear so the result checkbox can reveal it');
vm.runInContext(simulator.slice(simulator.indexOf('const EQUIP_AUTO_RATING_LEVELS'),
    simulator.indexOf('function equipAutoCostTotals')), context);
sandbox.ringFixture = ring;
assert.equal(vm.runInContext('equipAutoCandidateRating(ringFixture).label', context), '特殊词条',
    'automatic equipment simulation must not mark one qi as artifact');

async function main() {
    if (process.argv[2]) {
        api.setSave(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
        const found = [];
        await api.scanRoutes({parts: [7], mudBudget: 374, craftCount: 100, targetProp: 'atk_add',
            cancelled: () => false, progress() {}, candidate(item) {
                const scored = api.scoreCandidate(item, 374, 'atk_add', 0);
                if (scored) found.push(scored);
            }});
        const item = found.find(item => item.craftIndex === 65 && item.paperName === '乌蚕宝甲图样'
            && item.location === '无双城衣服店');
        assert.ok(item, 'the actual save must retain Wushuang City craft 65 in target tracking');
        assert.equal(api.refinementDisplayTotal(item.refinement), 356,
            'the actual save must discover the pre-lock route to 356 attack');
        assert.equal(item.refinement.plan.cost.lianjin, 364,
            'the full replayed route must report the exact 364 refinement mud');
        assert.deepEqual(Array.from(item.refinement.plan.accepts, step => step.index), [46, 66, 147, 176],
            'the route must include the early lock needed to raise the value at #66 to its maximum');
        assert.equal(item.mud, 374, 'the 10-mud upgrade cost must be added separately to the 364 refinement mud');
        console.log('actual-save craft 65:', api.refinementDisplayTotal(item.refinement), 'attack;',
            item.refinement.plan.cost.lianjin, 'refinement mud + 10 upgrade mud');
    }
    console.log('equipment planner regression tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
