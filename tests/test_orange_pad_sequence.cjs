const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    WebAssembly,
    Uint8Array,
    DataView,
    ArrayBuffer,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const context = vm.createContext(sandbox);

vm.runInContext(
    fs.readFileSync(path.join(root, 'web/shared/core_glue.js'), 'utf8'),
    context,
    { filename: 'web/shared/core_glue.js' },
);

vm.runInContext(`
    wasmReady = true;
    globalThis.mockState = { step: 0 };
    globalThis.mockCalls = [];
    wasmMakeGetState = () => JSON.parse(JSON.stringify(globalThis.mockState));
    wasmMakeSetState = next => {
        globalThis.mockState = JSON.parse(JSON.stringify(next));
        return true;
    };
    wasmMakeOnce = request => {
        globalThis.mockCalls.push(request.kind);
        if (request.failAt === globalThis.mockState.step) return { error: 'mock failure' };
        const item = { kind: request.kind, at: globalThis.mockState.step };
        globalThis.mockState.step += 1;
        return item;
    };
`, context);

const preview = vm.runInContext(
    'wasmMakeOrangePadSequence({kind:"orange"}, {kind:"pad"}, 3, true)',
    context,
);
assert.deepEqual(
    JSON.parse(JSON.stringify(preview.items.map(item => ({ at: item.at, index: item.index })))),
    [{ at: 0, index: 1 }, { at: 1, index: 2 }, { at: 2, index: 3 }],
    'each orange candidate must be evaluated after N-1 ordinary pads',
);
assert.equal(vm.runInContext('mockState.step', context), 0,
    'preview must restore the imported make state');
assert.deepEqual(
    JSON.parse(JSON.stringify(vm.runInContext('mockCalls.slice()', context))),
    ['orange', 'pad', 'orange', 'pad', 'orange'],
);

vm.runInContext('mockCalls.length = 0', context);
const applied = vm.runInContext(
    'wasmMakeOrangePadSequence({kind:"orange"}, {kind:"pad"}, 3, false)',
    context,
);
assert.equal(applied.item.at, 2);
assert.equal(applied.item.index, 3);
assert.equal(vm.runInContext('mockState.step', context), 3,
    'applying #3 must persist two pads and one orange craft');
assert.deepEqual(
    JSON.parse(JSON.stringify(vm.runInContext('mockCalls.slice()', context))),
    ['pad', 'pad', 'orange'],
);

vm.runInContext('mockState = { step: 0 }; mockCalls.length = 0', context);
const failed = vm.runInContext(
    'wasmMakeOrangePadSequence({kind:"orange"}, {kind:"pad", failAt:1}, 3, false)',
    context,
);
assert.match(failed.error, /mock failure/);
assert.equal(vm.runInContext('mockState.step', context), 0,
    'failed apply must roll back partial pad state');

console.log('orange pad sequence regression tests passed');
