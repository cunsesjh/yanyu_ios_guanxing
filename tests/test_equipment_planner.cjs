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
            if (!elements.has(id)) elements.set(id, { hidden: false, style: {}, innerHTML: '', textContent: '' });
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
    window.plannerRegression = {scoreCandidate, refinementDisplayTotal, renderLimitsTable, scanRoutes,
        setSave: function (data) { saveData = data; }};
    if (document.readyState === 'loading')`), context);
const api = sandbox.plannerRegression;
const candidate = {
    equipId: 5219, craftIndex: 65, upgraded: true, region: [{prop: 'hp', value: 400}],
    refinementRatingReference: {atk_add: 400, mp_back: 1},
    refinements: [{prop: 'atk_add', maxima: {1: {value: 160}, 2: {value: 116}, 3: {value: 80}},
        plan: {cost: {lianjin: 354}}}],
};
assert.equal(api.scoreCandidate(candidate, 364, 'atk_add', 0).craftIndex, 65,
    'explicit target tracking must retain an affordable 356 attack candidate');
assert.equal(api.scoreCandidate(candidate, 363, 'atk_add', 0), null,
    'the upgrade cost must remain part of the total mud budget');
const ring = {...candidate, equipId: 5409, region: [], refinements: [
    {prop: 'mp_back', maxima: {1: {value: 1}}},
]};
assert.equal(api.scoreCandidate(ring, 900, 'all'), null,
    'one qi must not qualify a ring as artifact or premium in fixed planning');
assert.equal(api.scoreCandidate(ring, 900, 'mp_back', 0).grade, '候选',
    'explicit qi tracking may show the result but cannot label it artifact');
assert.equal(api.refinementDisplayTotal({prop: 'dmg_off', maxima: {
    1: {value: 0.0329}, 2: {value: 0.0249}, 3: {value: 0.0160},
}}), '7.2%', 'percentages must be truncated per slot before summing');
api.renderLimitsTable();
const limitsHtml = elements.get('limitsTableBody').innerHTML;
assert.equal((limitsHtml.match(/scope="rowgroup"/g) || []).length, 9);
assert.match(limitsHtml, /攻击<\/th><td>163<\/td><td>122<\/td><td>81<\/td>/,
    'attack limits must list three individual slot maxima instead of only a total');
const html = fs.readFileSync(path.join(root, 'web/planner/index.html'), 'utf8');
assert.deepEqual(Array.from(html.matchAll(/data-planner-tool="([^"]+)"/g), match => match[1]),
    ['target', 'fixed', 'standards']);
assert.match(html, /来源：B站《丶索巴宰》/);
assert.ok(fs.existsSync(path.join(root, 'web/planner/pvp-refine-standards.png')));
const simulator = fs.readFileSync(path.join(root, 'web/shared/simulator.js'), 'utf8');
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
