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
assert.equal(route.steps.length, 1, 'a lock instruction that repeats the already-active set is redundant');
assert.equal(route.steps[0].washes, 2, 'same washes merge even when internal search labels differ');
assert.equal(route.steps[0].pills, 8);
assert.equal(route.steps[0].cumulativePills, 8);

const repeated = view.normalizeRoute({
    pills: 12, washes: 3, finalTalents: [271],
    steps: [
        {op: 'wash', type: 'pityBoundary', count: 1, cost: 4, keepIds: [182]},
        {op: 'wash', type: 'chaseAnchor', count: 1, cost: 4, keepIds: [182]},
        {op: 'wash', type: 'chaseAnchor', count: 1, cost: 4, keepIds: [182]},
    ],
}, 0, id => id === 182 ? '刀法好手' : `#${id}`);
assert.equal(repeated.steps.length, 1, 'consecutive identical washes should be grouped');
assert.equal(repeated.steps[0].washes, 3);
assert.equal(repeated.steps[0].pills, 12);
assert.equal(repeated.steps[0].cumulativePills, 12);

const changedLocks = view.normalizeRoute({
    pills: 8, washes: 2, finalTalents: [271],
    steps: [
        {op: 'wash', count: 1, cost: 4, keepIds: [182]},
        {op: 'locks', lockIds: []},
        {op: 'wash', count: 1, cost: 4, keepIds: []},
    ],
}, 0, id => id === 182 ? '刀法好手' : `#${id}`);
assert.equal(changedLocks.steps.length, 3, 'a real lock change stays visible between wash groups');
assert.equal(changedLocks.steps[1].label, '解除锁脉');

const inheritedLocks = view.normalizeRoute({
    pills: 8, washes: 2, finalTalents: [271],
    steps: [
        {op: 'locks', lockIds: [182]},
        {op: 'wash', count: 1, cost: 4, keepIds: [182]},
        {op: 'wash', count: 1, cost: 4},
    ],
}, 0, id => id === 182 ? '刀法好手' : `#${id}`);
assert.equal(inheritedLocks.steps.length, 2, 'wash actions without explicit keepIds inherit active locks');
assert.equal(inheritedLocks.steps[1].washes, 2);

console.log('auto wash route display accounting tests passed');
