/* Sanitized regression for a long-prefix relay route on Shang Haoqian. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../web/shared');
const messages = [];
const sandbox = {console, TextEncoder, TextDecoder, Uint8Array, WebAssembly, performance,
    atob, setTimeout, clearTimeout, postMessage: message => messages.push(message)};
sandbox.self = sandbox;
const context = vm.createContext(sandbox);
sandbox.importScripts = (...files) => files.forEach(file =>
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename: file}));
vm.runInContext(fs.readFileSync(path.join(root, 'auto_wash2_worker.js'), 'utf8'), context);

const raw = {
    seed:1705411653, born_talent_rc:10, luck_seed:0, luck_seed_inited:false,
    tal_lucky:2, zizhi:153, role_id:10031, sex:1, role_level:90, salt:780148, vip:1,
    role_stats:{str_val:129, con:117, dex:10, int_val:101}, global_vars:{}, save_channel:'',
    talents:[{id:272,locked:false},{id:189,locked:false},{id:247,locked:false}],
};
const candidates = [];
(async () => {
    const result = await sandbox.AutoWash2Optimizer.searchWashRoutes({
        initialState:raw,
        talentData:sandbox.TALENT_DATA,
        targetIds:[250,268,271,272],
        options:{maxTotalPills:5000, searchIntensity:1},
        onCandidate:value => candidates.push(...(value.routes || [])),
        shouldCancel:() => candidates.some(route => route.totalPills === 4910),
    });
    const exact = candidates.find(route => route.totalPills === 4910);
    assert.ok(exact, 'automatic long-prefix search must find the 4,910-pill relay route');
    assert.equal(exact.totalWashes,1163);
    assert.equal(exact.verified,true);
    assert.deepEqual(JSON.parse(JSON.stringify(exact.finalTalents.map(t => t.id))), [250,268,271,272]);
    assert.ok(exact.steps.some(step => step.mode === 'long-prefix-scan' && step.count === 697));
    assert.ok(result.cancelled || result.routes?.some(route => route.totalPills === 4910));
    console.log('PASS: automatic long-prefix relay finds and independently replays Shang Haoqian 4,910/1,163 route');
})().catch(error => { console.error(error); process.exitCode = 1; });
