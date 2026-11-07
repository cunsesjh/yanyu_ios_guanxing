/* Offline regression: execute real homepage import, then new page contexts. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert');
const { TextDecoder, TextEncoder } = require('util');
const web = path.join(__dirname, '..', 'web');
const sample = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : {
    MainRole: { Name: 'test' }, globalVariable: {}, DBVersion: '00073576',
    Rnds: { Sds: { seed: 123 }, padding: 'seed-data'.repeat(50000) }
};

function storage(limit) {
    const data = new Map();
    return {
        getItem: k => data.has(k) ? data.get(k) : null,
        setItem(k, v) {
            v = String(v);
            let size = 2 * (k.length + v.length);
            for (const [key, value] of data) if (key !== k) size += 2 * (key.length + value.length);
            if (size > limit) throw Error('QuotaExceededError');
            data.set(k, v);
        },
        removeItem: k => data.delete(k)
    };
}

function page(store, autoSave, homepage) {
    const nodes = {};
    const timers = [];
    const ctx = { TextDecoder, TextEncoder, localStorage: store,
        atob: s => Buffer.from(s, 'base64').toString('binary'),
        btoa: s => Buffer.from(s, 'binary').toString('base64'),
        setTimeout: fn => timers.push(fn),
        document: { readyState: 'complete', getElementById(id) {
            return nodes[id] || (nodes[id] = { textContent: '',
                classList: { toggle() {}, remove() {} }, addEventListener() {} });
        } }
    };
    ctx.window = ctx; ctx.self = ctx;
    vm.createContext(ctx);
    function run(name) { vm.runInContext(fs.readFileSync(path.join(web, name), 'utf8'), ctx); }
    run('shared/pako.min.js');
    run('shared/save_decrypt.js');
    if (homepage) {
        if (autoSave) ctx.__latestPlainSave = { data: autoSave, platform: 'iOS' };
        run('last-import.js'); run('home.js');
        timers.forEach(fn => fn());
    }
    return { ctx, nodes };
}

function verify(store, label) {
    const initial = page(store, sample, true);
    assert.strictEqual(initial.nodes.homeSaveStatus.textContent, '导入成功', label);
    for (const homepage of [false, true]) {
        const reopened = page(store, null, homepage);
        assert.strictEqual(JSON.stringify(reopened.ctx.loadShareStore().data), JSON.stringify(sample), label);
    }
    // Choosing a saved snapshot re-imports it even if browser storage was cleared.
    store.removeItem('yyjh_share_save_v1');
    assert.strictEqual(page(store, sample, true).nodes.homeSaveStatus.textContent, '导入成功');
}

verify(storage(Infinity), 'normal reload');
const packed = require('zlib').deflateSync(JSON.stringify(sample));
const quota = 2 * (Math.ceil(packed.length / 3) * 4 + 1024);
assert(quota < 2 * JSON.stringify(sample).length, 'fixture must exercise compression');
const tight = storage(quota);
verify(tight, 'quota compression reload');
assert.notStrictEqual(tight.getItem('yyjh_share_save_v1')[0], '{');

const blocked = page(storage(0), sample, true);
assert.strictEqual(blocked.nodes.homeSaveStatus.textContent, '未导入');
assert(blocked.nodes.homeImportMessage.textContent.includes('浏览器无法保存存档'));
assert.strictEqual(blocked.ctx.loadShareStore(), null);

const previous = storage(512);
const ctx = page(previous, null, false).ctx;
assert(ctx.saveShareStore({ MainRole: {}, globalVariable: {} }, { source: 'old' }));
const before = JSON.stringify(ctx.loadShareStore());
// Incompressible enough that neither the raw nor the compressed form fits.
const large = { value: require('crypto').randomBytes(8192).toString('hex') };
assert.strictEqual(ctx.saveShareStore(large, { source: 'new' }), false);
assert.strictEqual(JSON.stringify(ctx.loadShareStore()), before);
console.log('PASS: homepage -> subpage -> reopen, compressed persistence, blocked storage error, previous save preserved');
