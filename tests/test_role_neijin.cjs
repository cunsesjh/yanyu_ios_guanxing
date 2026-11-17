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

console.log('role neijin reference tests passed');
