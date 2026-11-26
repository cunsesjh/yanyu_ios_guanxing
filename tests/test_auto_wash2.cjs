/* Worker wiring test: browser legacy A* must not be used for route search. */
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
sandbox.importScripts = (...files) => files.forEach(file => {
    const localName = file.split('?')[0];
    vm.runInContext(fs.readFileSync(path.join(root, localName), 'utf8'), context, {filename: localName});
});
vm.runInContext(fs.readFileSync(path.join(root, 'auto_wash2_worker.js'), 'utf8'), context);

const raw = {seed: 184736291, born_talent_rc: 10, luck_seed: 0, luck_seed_inited: false,
    tal_lucky: 0, zizhi: 154, role_id: 10044, sex: 1, role_level: 90,
    salt: 278440, vip: 1, role_stats: {str_val: 120, con: 110, dex: 100, int_val: 100},
    global_vars: {}, save_channel: '', save_version: 0,
    talents: [{id: 271, locked: false}, {id: 272, locked: false}, {id: 250, locked: false}]};

async function send(type, payload) {
    messages.length = 0;
    await sandbox.onmessage({data: {type, requestId: 'smoke', ...payload}});
    const error = messages.find(message => message.type === 'error');
    assert.equal(error, undefined, error && error.error);
    return messages;
}

(async () => {
    const inspected = await send('inspect', {raw});
    const summary = inspected.find(message => message.type === 'summary').summary;
    assert.ok(summary.allowed.includes(271));
    assert.ok(summary.allowed.includes(250));
    assert.equal(sandbox.RouteConstructor, undefined,
        'deprecated RouteConstructor graph must not be loaded into the search worker');
    assert.equal(sandbox.WashSourceOptimizer, undefined,
        'deprecated browser A* optimizer must not be loaded into the search worker');
    messages.length = 0;
    await sandbox.onmessage({data: {type: 'search', requestId: 'smoke', input: {}}});
    assert.match(messages.find(message => message.type === 'error')?.error || '', /AWASH/,
        'the browser worker must refuse to fall back instead of returning unrelated routes');
    console.log('auto wash legacy-search exclusion test passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
