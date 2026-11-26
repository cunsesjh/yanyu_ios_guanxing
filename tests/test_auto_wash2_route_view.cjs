const assert = require('node:assert/strict');
const view = require('../web/shared/auto_wash2_route_view.js');

const route = view.normalizeRoute({
    pills: 8,
    washes: 2,
    exchanges: 0,
    finalTalents: [271, 272],
    steps: [
        {op: 'wash', type: 'chaseAnchor', count: 1, cost: 4, keepIds: [182]},
        // AWASH lock metadata includes cumulative totals, not a new action cost.
        {op: 'locks', type: 'lockConflict', id: 182, washes: 1, cost: 4, lockIds: [182]},
        {op: 'wash', type: 'chaseAnchor', count: 1, cost: 4, keepIds: [182]},
    ],
}, 0, id => ({182: '刀法好手', 271: '转世金仙', 272: '岿然顶天'}[id] || `#${id}`));

assert.equal(route.totalPills, 8);
assert.equal(route.totalWashes, 2);
assert.equal(route.steps.length, 3, 'lock changes stay visible and prevent merging across them');
assert.equal(route.steps[0].pills, 4);
assert.equal(route.steps[1].pills, 0, 'cumulative lock metadata must not be charged again');
assert.equal(route.steps[1].cumulativePills, 4);
assert.equal(route.steps[2].pills, 4);
assert.equal(route.steps[2].cumulativePills, 8);

const repeated = view.normalizeRoute({
    pills: 12, washes: 3, finalTalents: [271],
    steps: [
        {op: 'wash', type: 'chaseAnchor', count: 1, cost: 4, keepIds: [182]},
        {op: 'wash', type: 'chaseAnchor', count: 1, cost: 4, keepIds: [182]},
        {op: 'wash', type: 'chaseAnchor', count: 1, cost: 4, keepIds: [182]},
    ],
}, 0, id => id === 182 ? '刀法好手' : `#${id}`);
assert.equal(repeated.steps.length, 1, 'consecutive identical washes should be grouped');
assert.equal(repeated.steps[0].washes, 3);
assert.equal(repeated.steps[0].pills, 12);
assert.equal(repeated.steps[0].cumulativePills, 12);

console.log('auto wash route display accounting tests passed');
