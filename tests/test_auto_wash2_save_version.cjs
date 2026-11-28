const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const shared = path.resolve(__dirname, '../web/shared');
const sandbox = {JSON, Number, Object, Array};
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(shared, 'auto_wash2_model.js'), 'utf8'), sandbox);

const save = {DBVersion: 73648, CenterID: 9294308, globalVariable: {}};
const role = {ID: 10057, Name: '示例角色', ZiZhi: 153, Sex: 2,
    BornTalent: {S: 123456789, RC: 10}, Talents: {}};

const fromPlainJson = sandbox.AutoWash2Model.snapshot(save, role, {
    saveVersion: '明文', channel: '', vip: 1,
});
assert.strictEqual(fromPlainJson.save_version, 73648,
    'human-readable import labels must not hide DBVersion');

const fromSharedSnapshot = sandbox.AutoWash2Model.snapshot(save, role, {});
assert.strictEqual(fromSharedSnapshot.save_version, 73648,
    'DBVersion must be used when import metadata is absent');

const explicitVersion = sandbox.AutoWash2Model.snapshot(save, role, {saveVersion: 73500});
assert.strictEqual(explicitVersion.save_version, 73500,
    'numeric import metadata should remain authoritative');

console.log('auto wash save version fallback tests passed');
