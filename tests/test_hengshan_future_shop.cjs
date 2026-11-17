const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const calls = [];
const sandbox = {
    console,
    HENGSHAN_TALENT_DATA: {},
    HENGSHAN_SHOP_DATA: {},
    HengshanStudentEngine: {
        shopRefresh(data, shopData, state) {
            calls.push({ ...state });
            const nextSeed = state.seed + 100;
            return {
                students: [{ key: `candidate-${nextSeed}`, name: '候选', seed: nextSeed, talents: [1] }],
                nextState: { seed: nextSeed, npc: { day: calls.length } },
            };
        },
    },
    HengshanShopState: {
        getBackpackStudents() { return []; },
        getShopState() { return { seed: 1000, refreshes: 1, npc: {} }; },
    },
};
sandbox.window = sandbox;
const context = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web/hengshan/hengshan_shop_view.js'), 'utf8'), context);

const result = sandbox.HengshanShopView.predictFutureShopStudents(3);
assert.equal(result.length, 3);
assert.deepEqual(calls.map(call => call.seed), [1000, 1100, 1200]);
assert.ok(calls.every(call => call.refreshes === 0));
assert.deepEqual(Array.from(result, item => item.shopDay), [1, 2, 3]);
assert.equal(new Set(result.map(item => item.key)).size, 3);

calls.length = 0;
const thirtyDays = sandbox.HengshanShopView.predictFutureShopStudents(30);
assert.equal(thirtyDays.length, 30);
assert.equal(calls.length, 30);
assert.deepEqual(Array.from(thirtyDays, item => item.shopDay),
    Array.from({ length: 30 }, (_, index) => index + 1));
assert.equal(new Set(thirtyDays.map(item => item.key)).size, 30);

console.log('hengshan future shop tests passed');
