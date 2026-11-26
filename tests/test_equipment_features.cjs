const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const equipmentHtml = fs.readFileSync(path.join(root, 'web/equip/index.html'), 'utf8');
assert.ok(equipmentHtml.indexOf('../shared/equip_auto_optimizer.js') < equipmentHtml.indexOf('equip.js'),
    'equipment optimizer must load before equip.js');
assert.match(equipmentHtml, /data-tab="mangjing">芒晶序列</);
assert.match(equipmentHtml, /id="specialAttachEquipSelect"/);
assert.match(equipmentHtml, /id="mangjingSourceFilter"/,
    'mangjing equipment list must expose the same source selection as refinement');
assert.match(equipmentHtml, /id="mangjingTextFilter"/,
    'mangjing equipment list must support text filtering');
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
const ratingFixture = optimizer.AUTO_PAPER_IDS.map(id => {
    const paper = data.papers[String(id)];
    return paper && data.equipment[String(paper.dz_equip)];
}).filter(Boolean).find(equip => Object.keys(equip.exts || {}).some(prop => {
    const ownMax = optimizer.theoreticalRefinementReference(equip, [prop])[prop] || 0;
    return ownMax > 0 && optimizer.partRefinementReference(data, equip.type, prop, 0) > ownMax;
}));
if (ratingFixture) {
    const prop = Object.keys(ratingFixture.exts).find(key => {
        const ownMax = optimizer.theoreticalRefinementReference(ratingFixture, [key])[key] || 0;
        return ownMax > 0 && optimizer.partRefinementReference(data, ratingFixture.type, key, 0) > ownMax;
    });
    const ownMax = optimizer.theoreticalRefinementReference(ratingFixture, [prop])[prop];
    assert.equal(optimizer.scoreEquipmentRefinement(data, ratingFixture.id, prop, ownMax, []).baseScore, 100,
        'equipment rating must use the current item ceiling instead of another item’s higher slot ceiling');
}
const redMarrow = data.special['8825'];
const stoneCore = data.special['8826'];
const dragonBone = data.special['2021'];
const ring100 = { id: 1, name: '100级戒指', typ: 8, need_lv: 100, MJSeed: 1234567 };
const ring90 = { ...ring100, name: '90级戒指', need_lv: 90 };
const belt100 = { id: 2, name: '100级腰带', typ: 5, need_lv: 100, MJSeed: 7654321 };
const belt90 = { ...belt100, name: '90级腰带', need_lv: 90 };

assert.equal(optimizer.mangjingPerAttempt(100), 10);
assert.equal(optimizer.mangjingPerAttempt(90), 9);
assert.equal(optimizer.mangjingPerAttempt(1), 1);
assert.equal(optimizer.normalizeOptions({}).includeBlue, false,
    'automatic equipment simulation must keep blue equipment excluded by default');
assert.equal(optimizer.normalizeOptions({includeBlue: true}).includeBlue, true,
    'equipment simulation must accept an explicit blue-equipment inclusion setting');

const refinementBudgetEquip = {
    id: 5220, need_lv: 100, typ: 7, color: 4,
    xilian_marks: [1, 2], exts: [], S: 1, CZSeed: 2, XLLevel: 0, XLNumber: 0,
};
const refinementBudgetPreview = [
    { index: 1, slot: 3, prop: { prop: 'hp_add', value: 1 }, xl_level: 700, accepted: false },
    { index: 2, slot: 3, prop: { prop: 'dmg_off', value: 0.015 }, xl_level: 800, accepted: false },
    { index: 3, slot: 3, prop: { prop: 'dmg_off', value: 0.018 }, xl_level: 950, accepted: false },
];
const refinementBudgetBridge = {
    xilianPlan(equip, flags) {
        const applying = flags.some(Boolean);
        return {
            items: refinementBudgetPreview.slice(0, flags.length).map((item, index) => ({
                ...item,
                accepted: applying && !!flags[index],
            })),
            equip: { ...equip, xilian_marks: [1, 2, 3] },
        };
    },
};
const unlimitedRefinement = optimizer.analyzeRefinement(
    refinementBudgetBridge, refinementBudgetEquip, 'dmg_off', 3, data, 0,
);
const budgetedRefinement = optimizer.analyzeRefinement(
    refinementBudgetBridge, refinementBudgetEquip, 'dmg_off', 3, data, 890,
);
assert.equal(unlimitedRefinement.maxima[3].value, 0.018,
    'without a mud budget refinement should choose the global maximum');
assert.equal(budgetedRefinement.maxima[3].value, 0.015,
    'an over-budget maximum must not hide the best affordable refinement result');
assert.equal(budgetedRefinement.maxima[3].occurrences[0].cumMud, 800);

assert.equal(optimizer.refinementActualTotal({
    total: 300,
    maxima: {
        1: { value: 80, theoretical: 100 },
        2: { value: 60, theoretical: 75 },
        3: { value: 40, theoretical: 50 },
    },
}), 180, 'collapsed refinement result must use actual accepted values, not theoretical values');
assert.deepEqual(
    { ...optimizer.costTotals(
        { silver: 1000, materials: [{ id: 8801, name: '连金泥', amount: 10 }] },
        { silver: 2500, lianjin: 7, mainMaterial: { id: 3026, name: '昆吾石' }, mainAmount: 35 },
    ) },
    { silver: 3500, lianjin: 17 },
    'candidate cost totals must combine crafting, upgrading, and one actual refinement route',
);

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
assert.equal(vm.runInContext('canPredictSpecialAttach(({color:4, typ:8, need_lv:100, MJSeed:1234567}))', context), true);
assert.equal(vm.runInContext('canPredictSpecialAttach(({color:5, typ:8, need_lv:100, MJSeed:1234567}))', context), false,
    'orange equipment cannot be washed with mangjing and must stay out of the target list');

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

const orangeRequest = vm.runInContext(`(() => {
    const item = orangePapersForNpc(40520).find(entry => Number(entry.equip.lv) < 100 && makePadCandidatesFor({
        npc_id: 40520,
        select_id: entry.selectId,
        equip_id: entry.equipId,
        min_color: entry.paper.min_color,
        max_color: entry.paper.max_color,
    }).length > 0);
    return item && ({
        npc_id: 40520,
        select_id: item.selectId,
        equip_id: item.equipId,
        min_color: item.paper.min_color,
        max_color: item.paper.max_color,
    });
})()`, context);
assert.ok(orangeRequest, 'fixture must contain a fixed orange target with ordinary pad candidates');
context.orangeRequest = orangeRequest;
assert.equal(vm.runInContext('usesOrangePadSequence(orangeRequest)', context), true);
const padCandidates = vm.runInContext('makePadCandidatesFor(orangeRequest)', context);
const orangeTarget = data.equipment[String(orangeRequest.equip_id)];
assert.ok(padCandidates.length > 0);
assert.ok(padCandidates.every(item => Number(item.paper.max_color) <= 4));
assert.ok(padCandidates.every(item => Number(item.equip.type) === Number(orangeTarget.type)));
assert.ok(padCandidates.every(item => Number(item.equip.lv) === Number(orangeTarget.lv)));
assert.ok(padCandidates.every(item => vm.runInContext(
    `PURCHASABLE_MAKE_PAD_PAPER_IDS.has(${Number(item.paper.id)})`, context)),
    'every ordinary pad must come from the purchasable-paper allowlist');
const polearmOrangeRequest = vm.runInContext(`(() => {
    const item = orangePapersForNpc(40520).find(entry => Number(entry.equip.type) === 4 && Number(entry.equip.lv) === 90);
    return item && ({npc_id:40520, select_id:item.selectId, equip_id:item.equipId,
        min_color:item.paper.min_color, max_color:item.paper.max_color});
})()`, context);
assert.ok(polearmOrangeRequest, 'fixture must contain a level 90 orange polearm');
context.polearmOrangeRequest = polearmOrangeRequest;
assert.ok(vm.runInContext('makePadCandidatesFor(polearmOrangeRequest).some(item => Number(item.paper.id) === 2586)', context));
assert.equal(vm.runInContext('makePadCandidatesFor(polearmOrangeRequest).some(item => Number(item.paper.id) === 2542)', context), false);
const excludedSpecialPapers = [2512, 2522, 2542, 3455, 3457, 3459, 2557, 2558];
context.excludedSpecialPapers = excludedSpecialPapers;
assert.equal(vm.runInContext(
    `Object.values(EQUIP_DATA.papers)
        .filter(paper => excludedSpecialPapers.includes(Number(paper.id)))
        .some(paper => isCraftableOrdinaryPadPaper({paper, equip:EQUIP_DATA.equipment[String(paper.dz_equip)]}))`,
    context,
), false, 'special-source papers must never be offered as orange pads');

const expectedLevel90Pads = new Map([
    [1, [2580, 2581]], [2, [2584, 2585]], [3, [2582, 2583]],
    [4, [2586, 2587]], [5, [3409, 3454]], [6, [3419, 3456]],
    [7, [3429, 3458]], [8, [3439, 3460]], [9, [3449, 3461]],
]);
for (const [type, expectedIds] of expectedLevel90Pads) {
    const craftsmanId = [5, 6, 7].includes(type) ? 31230 : 40520;
    const actualIds = vm.runInContext(
        `papersForNpc(${craftsmanId}).filter(item => Number(item.equip.lv) === 90
            && Number(item.equip.type) === ${type} && isCraftableOrdinaryPadPaper(item))
            .map(item => Number(item.paper.id)).sort((a, b) => a - b)`,
        context,
    );
    assert.deepEqual(Array.from(actualIds), expectedIds.slice().sort((a, b) => a - b),
        `level 90 type ${type} pad papers must match the standard purchasable set`);
}
const uncoveredOrangePadGroups = vm.runInContext(`(() => {
    const missing = [];
    for (const npcId of [40520, 31230]) {
        const groups = new Set();
        for (const item of orangePapersForNpc(npcId)) {
            if (Number(item.equip.lv) >= 100) continue;
            const key = item.equip.lv + ':' + item.equip.type;
            if (groups.has(key)) continue;
            groups.add(key);
            const req = {npc_id:npcId, select_id:item.selectId, equip_id:item.equipId,
                min_color:item.paper.min_color, max_color:item.paper.max_color};
            const pads = makePadCandidatesFor(req);
            if (!pads.length || pads.some(pad => !PURCHASABLE_MAKE_PAD_PAPER_IDS.has(Number(pad.paper.id)))) {
                missing.push(npcId + ':' + key);
            }
        }
    }
    return missing;
})()`, context);
assert.deepEqual(Array.from(uncoveredOrangePadGroups), [],
    'every sub-100 orange level/type group must have only purchasable pad papers');
context.freeOrangeRequest = { ...orangeRequest, select_id: data.craftsman['40520'].pf[0] };
assert.equal(vm.runInContext('usesOrangePadSequence(freeOrangeRequest)', context), false,
    'free craftsman papers must keep the normal continuous sequence');

const html = fs.readFileSync(path.join(root, 'web/equip/index.html'), 'utf8');
const autoSimulatorSource = fs.readFileSync(path.join(root, 'web/shared/simulator.js'), 'utf8');
const equipmentOptimizerSource = fs.readFileSync(path.join(root, 'web/shared/equip_auto_optimizer.js'), 'utf8');
const plannerHtml = fs.readFileSync(path.join(root, 'web/planner/index.html'), 'utf8');
const plannerSource = fs.readFileSync(path.join(root, 'web/planner/planner.js'), 'utf8');
assert.ok((html.match(/value="orange"/g) || []).length >= 2,
    'both linked equipment category selectors must expose orange blueprints');
assert.equal(vm.runInContext('DEFAULT_MAKE_COLOR_FILTER', context), '',
    'craft prediction must show all qualities by default');
assert.match(html, /<option value="" selected>全部<\/option>/,
    'the craft quality selector must visibly default to all qualities');
assert.match(html, /id="makePadPaperSelect"/,
    'fixed orange prediction must expose the ordinary pad paper selector');
assert.match(html, /id="orangeLevelFilter"/,
    'orange blueprint category must expose a level filter');
assert.match(autoSimulatorSource, /id="equipAutoResultSort"/,
    'automatic equipment results must expose consumption sorting');
assert.match(autoSimulatorSource, /value="silver-asc"/,
    'automatic equipment results must support sorting by silver consumption');
assert.match(autoSimulatorSource, /value="lianjin-asc"/,
    'automatic equipment results must support sorting by lianjin consumption');
assert.match(autoSimulatorSource, /实际\$\{escapeAiHtml\(equipAutoPropertyLabel\(refinement\.prop\)\)\}/,
    'collapsed cards must label refinement values as actual results');
assert.match(autoSimulatorSource, /equip-auto-refine-route-steps/,
    'automatic equipment results must render refinement operations as compact steps');
const simulatorCss = fs.readFileSync(path.join(root, 'web/shared/simulator.css'), 'utf8');
assert.match(simulatorCss, /\.equip-auto-refine-step\s*\{/,
    'refinement operations must have compact visual step styling');
assert.match(plannerHtml, /id="craftCount"[^>]*value="20"/,
    'equipment planner must default each route to 20 crafts');
assert.equal((plannerHtml.match(/class="planner-intro /g) || []).length, 3,
    'all three equipment planner tools must start with a feature description panel');
assert.match(plannerHtml, /data-planner-tool="fixed">固定打造规划/);
assert.match(plannerHtml, /data-planner-tool="standards">精炼上限与PVP精炼标准/);
assert.match(plannerHtml, /value="premium" selected>极品及以上/);
assert.match(plannerHtml, /不含强化、地区及首次材料附加，也不是纯打造词条完整上限/);
assert.match(plannerHtml, /id="limitsPartFilter"/);
assert.match(plannerSource, /class="limits-paper-card"/);
assert.match(plannerHtml, /data-planner-tool="target">目标装备追踪/);
assert.match(plannerHtml, /\.\.\/shared\/wasm_data\.js/,
    'planner must use the same equipment WASM runtime as automatic simulation');
assert.match(plannerHtml, /\.\.\/shared\/core_glue\.js/,
    'planner must use the proven legacy equipment bindings');
assert.doesNotMatch(plannerHtml, /wasm_algorithm_api\.js/,
    'the Rust bridge must not replace the planner optimizer with a divergent equipment sequence');
assert.doesNotMatch(plannerHtml, /data-planner-tool="allocation"|id="allocationMudBudget"/,
    'resource allocation has been replaced by the equipment reference page');
assert.match(plannerHtml, /id="targetRefineProp"/);
assert.match(plannerHtml, /id="targetRegionProp"/);
assert.match(plannerSource, /function renderLimitsTable\(/,
    'the reference page must generate limits from equipment configuration');
assert.match(plannerSource, /function targetRegionMatches\(/,
    'target tracking must apply regional attachment conditions');
assert.match(plannerSource, /refineMudBudget: Math\.max\(1, options\.mudBudget - 10\)/,
    'planner must constrain refinement analysis to the remaining budget after upgrading');
assert.match(plannerSource, /await ensureEquipmentEngine\(\)/,
    'planner must initialize the shared equipment runtime before scanning routes');
assert.match(equipmentOptimizerSource, /maxMud > 0 && cumMud > maxMud/,
    'refinement analysis must discard over-budget occurrences before choosing slot maxima');
assert.doesNotMatch(plannerSource.match(/var percentProps = \[[^\]]+\]/)?.[0] || '', /renxing/,
    'toughness is a point value and must not be rendered as a percentage');
assert.match(plannerSource, /function refinementDisplayTotal\([\s\S]*?Math\.floor\(value \* 1000 \+ 0\.001\) \/ 10/,
    'planner must sum the per-slot displayed percentages using the same truncation as automatic simulation');
assert.match(plannerSource, /escapeHtml\(refinementDisplayTotal\(item\.refinement\)\)/,
    'planner cards must use the shared per-slot refinement display rule');
assert.match(plannerSource, /Math\.floor\(total \/ 1000\).*'两'.*total % 1000.*'文'/s,
    'planner silver costs must be rendered in liang and wen');
assert.doesNotMatch(plannerSource.match(/function resultKey[\s\S]*?\n    }/)?.[0] || '', /item\.region/,
    'regional variants of the same craft result must share one deduplication key');

assert.equal(
    vm.runInContext('summarizeExtTotals([{prop:"atk",value:100},{prop:"atk",value:80},{prop:"blood",value:0.02}])', context),
    '攻击+180 · 吸血+2%',
);

console.log('equipment feature regression tests passed');
