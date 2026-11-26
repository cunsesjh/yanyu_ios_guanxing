/**
 * core_glue.js — WASM 胶水层
 * 支持两种加载模式：
 * 1. 优先使用 wasm_data.js 里的 EMBEDDED_WASM_B64（页面每次都会重新校验这份脚本）
 * 2. 没有内嵌数据时再 fetch pkg/wasm_core_bg.wasm（该地址在 CDN 上会长期缓存，不能用来发新引擎）
 */

let wasmExports = null;
let wasmReady = false;

if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'wasmReady', {
        configurable: true,
        enumerable: true,
        get() { return wasmReady; },
        set(v) { wasmReady = !!v; },
    });
}

// ========== Low-level WASM helpers ==========

let cachedDataViewMemory0 = null;
let cachedUint8ArrayMemory0 = null;
let WASM_VECTOR_LEN = 0;

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;

const cachedTextEncoder = new TextEncoder();
if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return { read: arg.length, written: buf.length };
    };
}

function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true ||
        (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasmExports.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasmExports.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null
        || cachedUint8ArrayMemory0.byteLength === 0
        || cachedUint8ArrayMemory0.buffer !== wasmExports.memory.buffer) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasmExports.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;
    const mem = getUint8ArrayMemory0();
    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) arg = arg.slice(offset);
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);
        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function passBytesToWasm0(arg, malloc) {
    const bytes = arg instanceof Uint8Array ? arg : new Uint8Array(arg);
    const ptr = malloc(bytes.length, 1) >>> 0;
    getUint8ArrayMemory0().subarray(ptr, ptr + bytes.length).set(bytes);
    WASM_VECTOR_LEN = bytes.length;
    return ptr;
}

function base64ToUint8Array(b64) {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// ========== WASM 双模加载逻辑 ==========

async function initWasm() {
    try {
        const imports = {
            './wasm_core_bg.js': new Proxy({
                __wbg_random_95ef1cd58b1a3d73: function() {
                    return Math.random();
                },
                __wbg_now_24037b0877b2471b: function() {
                    return Date.now();
                },
            }, {
                get(target, prop) {
                    if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(target, prop)) {
                        return target[prop];
                    }
                    const n = String(prop);
                    if (n.includes('random')) return () => Math.random();
                    if (/now|Date|performance/i.test(n)) return () => Date.now();
                    return undefined;
                },
            }),
        };

        let bytes = null;

        // 内嵌优先：/pkg/wasm_core_bg.wasm 在 Cloudflare 上 Cache-Control immutable 一年，
        // 无痕窗口也会拿到旧文件。wasm_data.js 是 max-age=0，和这次构建一致。
        if (typeof EMBEDDED_WASM_B64 !== 'undefined' && EMBEDDED_WASM_B64) {
            bytes = base64ToUint8Array(EMBEDDED_WASM_B64);
        } else if (location.protocol !== 'file:') {
            try {
                const response = await fetch('pkg/wasm_core_bg.wasm', { cache: 'no-store' });
                if (response.ok) {
                    bytes = await response.arrayBuffer();
                }
            } catch (e) {
                console.warn('HTTP fetch WASM 失败:', e);
            }
        }

        if (!bytes) {
            throw new Error('无法获取 WASM 模块数据。请检查 WASM 文件或内嵌数据是否完整。');
        }

        const { instance } = await WebAssembly.instantiate(bytes, imports);

        wasmExports = instance.exports;
        cachedDataViewMemory0 = null;
        cachedUint8ArrayMemory0 = null;
        wasmReady = true;
        return true;
    } catch (e) {
        console.error('WASM 加载失败:', e);
        return false;
    }
}

// ========== 封装 WASM 函数 ==========

function _callStringReturn(fn) {
    let d0, d1;
    try {
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        fn(retptr);
        const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
        const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
        d0 = r0; d1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasmExports.__wbindgen_add_to_stack_pointer(16);
        wasmExports.__wbindgen_export3(d0, d1, 1);
    }
}

function wasmInitEngine(talentData, zzData) {
    if (!wasmReady) return false;
    const tj = JSON.stringify(talentData);
    const zj = JSON.stringify(zzData);
    const ptr0 = passStringToWasm0(tj, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(zj, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    return wasmExports.init_engine(ptr0, len0, ptr1, len1) !== 0;
}

function wasmSetState(stateObj) {
    if (!wasmReady) return false;
    const json = JSON.stringify(stateObj);
    const ptr = passStringToWasm0(json, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
    const len = WASM_VECTOR_LEN;
    return wasmExports.set_state(ptr, len) !== 0;
}

function wasmGetState() {
    if (!wasmReady) return null;
    try {
        return JSON.parse(_callStringReturn(r => wasmExports.get_state(r)));
    } catch { return null; }
}

function wasmDoWash() {
    if (!wasmReady) return null;
    try {
        const json = _callStringReturn(r => wasmExports.do_wash(r));
        return json === 'null' ? null : JSON.parse(json);
    } catch { return null; }
}

function wasmWashMulti(times) {
    if (!wasmReady) return [];
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            wasmExports.wash_multi(retptr, times);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch { return []; }
}

function wasmWashUntilGold(maxIterations) {
    if (!wasmReady) return [];
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            wasmExports.wash_until_gold(retptr, maxIterations);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch { return []; }
}

/** 连洗直到槽位出现指定天赋名 */
function wasmWashUntilTalentName(name, maxIterations) {
    if (!wasmReady) return [];
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            const ptr = passStringToWasm0(String(name || ''), wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const len = WASM_VECTOR_LEN;
            wasmExports.wash_until_talent_name(retptr, ptr, len, maxIterations >>> 0);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch (e) {
        console.error('wash_until_talent_name failed', e);
        return [];
    }
}

function wasmPreviewLuckSeq(n) {
    if (!wasmReady) return { inited: false, source: 'born', items: [] };
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            wasmExports.preview_luck_seq(retptr, n >>> 0);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch {
        return { inited: false, source: 'born', items: [] };
    }
}

function wasmPreviewLuckAfterPad(targets, pad, n) {
    if (!wasmReady) return { inited: false, source: 'born', pad: 0, items: [] };
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            const json = JSON.stringify(targets || []);
            const ptr = passStringToWasm0(json, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const len = WASM_VECTOR_LEN;
            wasmExports.preview_luck_after_pad(retptr, ptr, len, pad >>> 0, n >>> 0);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch (e) {
        console.error('preview_luck_after_pad failed', e);
        return { inited: false, source: 'born', pad: 0, items: [], error: String(e && e.message || e) };
    }
}

function wasmSearchLuckConsecutive(targets, desired, fromPad, maxPad, n) {
    if (!wasmReady) return { found: false, pad: 0, start: 0, hits: 0, pads: [], items: [] };
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            const j0 = JSON.stringify(targets || []);
            const p0 = passStringToWasm0(j0, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const l0 = WASM_VECTOR_LEN;
            const j1 = JSON.stringify(desired || []);
            const p1 = passStringToWasm0(j1, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const l1 = WASM_VECTOR_LEN;
            wasmExports.search_luck_consecutive(retptr, p0, l0, p1, l1, fromPad >>> 0, maxPad >>> 0, n >>> 0);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch (e) {
        console.error('search_luck_consecutive failed', e);
        return { found: false, pad: 0, start: 0, hits: 0, pads: [], items: [], error: String(e && e.message || e) };
    }
}

function wasmPreviewLuckBorn(maxWashes) {
    if (!wasmReady) return [];
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            wasmExports.preview_luck_born(retptr, maxWashes);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch { return []; }
}

function wasmPreviewSequence(maxWashes) {
    if (!wasmReady) return [];
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            wasmExports.preview_sequence(retptr, maxWashes);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch { return []; }
}

/**
 * 多紫脉联动置换真实路径推演
 * @param {{purple_name:string, conflict_name:string}[]} targets
 * @param {number} maxPad
 */
function wasmPreviewExchangePads(targets, maxPad) {
    if (!wasmReady) return [];
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            const json = JSON.stringify(targets || []);
            const ptr = passStringToWasm0(json, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const len = WASM_VECTOR_LEN;
            wasmExports.preview_exchange_pads(retptr, ptr, len, maxPad >>> 0);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch (e) {
        console.error('preview_exchange_pads failed', e);
        return [];
    }
}

function wasmExchangeTalent(index) {
    if (!wasmReady) return null;
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            wasmExports.exchange_talent(retptr, index);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch { return null; }
}

function wasmDecryptSave(b64Text) {
    if (!wasmReady) throw new Error('WASM 未加载');
    let d0, d1;
    const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
    try {
        const ptr = passStringToWasm0(b64Text, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
        const len = WASM_VECTOR_LEN;
        wasmExports.decrypt_save(retptr, ptr, len);
        const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
        const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
        d0 = r0; d1 = r1;
        const result = getStringFromWasm0(r0, r1);
        const parsed = JSON.parse(result);
        if (parsed && parsed.error) throw new Error(parsed.error);
        return parsed;
    } finally {
        wasmExports.__wbindgen_add_to_stack_pointer(16);
        if (d0) wasmExports.__wbindgen_export3(d0, d1, 1);
    }
}

/** 双层/动态 psw 解密：content + psw + sn + userid */
function wasmDecryptSaveEx(content, psw, sn, userid) {
    if (!wasmReady) throw new Error('WASM 未加载');
    if (typeof wasmExports.decrypt_save_ex !== 'function') {
        throw new Error('当前 WASM 不支持 decrypt_save_ex，请重新 build');
    }
    let d0, d1;
    const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
    try {
        const p0 = passStringToWasm0(String(content || ''), wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
        const l0 = WASM_VECTOR_LEN;
        const p1 = passStringToWasm0(String(psw || ''), wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
        const l1 = WASM_VECTOR_LEN;
        const p2 = passStringToWasm0(String(sn || ''), wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
        const l2 = WASM_VECTOR_LEN;
        const p3 = passStringToWasm0(String(userid || ''), wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
        const l3 = WASM_VECTOR_LEN;
        wasmExports.decrypt_save_ex(retptr, p0, l0, p1, l1, p2, l2, p3, l3);
        const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
        const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
        d0 = r0; d1 = r1;
        const result = getStringFromWasm0(r0, r1);
        const parsed = JSON.parse(result);
        if (parsed && parsed.error) throw new Error(parsed.error);
        return parsed;
    } finally {
        wasmExports.__wbindgen_add_to_stack_pointer(16);
        if (d0) wasmExports.__wbindgen_export3(d0, d1, 1);
    }
}

/** WASM abort / 二次释放会变成 RuntimeError: unreachable，控制台默认不打栈。 */
function rethrowWasm(err, what) {
    console.error(what, err);
    const msg = (err && err.message) || String(err || '');
    if (err && (err.name === 'RuntimeError' || /unreachable|out of bounds|memory access/i.test(msg))) {
        throw new Error(what + '失败（WASM 内部错误）。请刷新页面后重试。');
    }
    throw err;
}

/** 解析存档文件字节（明文 JSON 或 SQLite .db） */
function wasmParseSaveBytes(bytes) {
    if (!wasmReady) throw new Error('WASM 未加载');
    if (typeof wasmExports.parse_save_bytes !== 'function') {
        throw new Error('当前 WASM 不支持 parse_save_bytes，请重新 build');
    }
    let d0, d1;
    const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
    try {
        const ptr0 = passBytesToWasm0(bytes, wasmExports.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasmExports.parse_save_bytes(retptr, ptr0, len0);
        const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
        const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
        d0 = r0; d1 = r1;
        const parsed = JSON.parse(getStringFromWasm0(r0, r1));
        if (parsed && parsed.ok === false) throw new Error(parsed.error || '存档解析失败');
        return parsed;
    } catch (e) {
        if (e && e.name === 'RuntimeError') rethrowWasm(e, '存档解析');
        throw e;
    } finally {
        wasmExports.__wbindgen_add_to_stack_pointer(16);
        // &[u8] 由 WASM 侧 Drop；JS 再 free 就是二次释放 → unreachable
        if (d0) wasmExports.__wbindgen_export3(d0, d1, 1);
    }
}

/** Whale LCG intRand。算法在 WASM，不要在 JS 里重写。 */
function wasmIntRand(seed, n) {
    if (!wasmReady || typeof wasmExports.int_rand !== 'function') return 0;
    return wasmExports.int_rand(seed | 0, n | 0) | 0;
}

/** 池种子 → 入队后 BornTalent.S（getBornTalent）。 */
function wasmBornTalentFromPool(poolSeed) {
    if (!wasmReady || typeof wasmExports.born_talent_from_pool !== 'function') return 0;
    return wasmExports.born_talent_from_pool(poolSeed | 0) | 0;
}

const SAVE_CREDS_KEY = 'simulator_save_creds_v1';

/** 已知版本默认 psw（热更换版后需补一条；同版本期内固定） */
const DEFAULT_SAVE_PSW = {
    '72294': 'juhycd8e',
    '72288': 'jkds85we',
    '72280': 'hjo0e3q9',
    '72274': '3598gjjd',
};

function detectSaveMagic(text) {
    const s = String(text || '');
    if (s.startsWith('nfidfug8')) return 'nfidfug8';
    if (s.startsWith('js9qf8me')) return 'js9qf8me';
    if (s.startsWith('kjie00o0')) return 'kjie00o0';
    return null;
}

function resolveSavePsw(psw, version, magic) {
    const p = String(psw || '').trim();
    if (p) return p;
    if (magic === 'nfidfug8') return DEFAULT_SAVE_PSW['72294'];
    if (magic === 'js9qf8me') return DEFAULT_SAVE_PSW['72288'];
    if (magic === 'kjie00o0') return DEFAULT_SAVE_PSW['72280'];
    const ver = Number(version) || 0;
    const known = Object.keys(DEFAULT_SAVE_PSW)
        .map(Number)
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => b - a);
    for (let i = 0; i < known.length; i++) {
        if (ver >= known[i]) return DEFAULT_SAVE_PSW[String(known[i])];
    }
    return DEFAULT_SAVE_PSW['72280'];
}

/** 从页面输入框 / localStorage 读取解档凭证 */
function getSaveDecryptCreds() {
    const read = (id) => {
        const el = document.getElementById(id);
        return el ? String(el.value || '').trim() : '';
    };
    let userid = read('saveUserId');
    let sn = read('saveSn');
    if (!userid && !sn) {
        try {
            const raw = localStorage.getItem(SAVE_CREDS_KEY);
            if (raw) {
                const o = JSON.parse(raw);
                userid = String(o.userid || '').trim();
                sn = String(o.sn || '').trim();
            }
        } catch (_) {}
    }
    return { userid, sn };
}

function setSaveDecryptCreds(creds) {
    const userid = String((creds && creds.userid) || '').trim();
    const sn = String((creds && creds.sn) || '').trim();
    const fill = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.value = v;
    };
    fill('saveUserId', userid);
    fill('saveSn', sn);
    try {
        localStorage.setItem(SAVE_CREDS_KEY, JSON.stringify({
            userid, sn, saveVer: creds && creds.saveVer,
        }));
    } catch (_) {}
}

/**
 * 自动选择旧单层 / 双层解密。
 * opts: { sn, userid, saveId, version }
 * - kjie00o0：sn + 存档 id 末 8 / userid；psw 按版本
 * - js9qf8me：sn + 明文 userid；psw 按版本
 * - nfidfug8：sn + 明文 userid → getDBDirKey；psw 按版本
 * - 无外层魔数：单层内层解密
 */
function wasmDecryptSaveAuto(content, opts) {
    const text = String(content || '').trim();
    const saved = getSaveDecryptCreds();
    const o = Object.assign({}, saved, opts || {});
    const magic = detectSaveMagic(text);
    const psw = resolveSavePsw('', o.version, magic);
    const sn = String(o.sn || '').trim();
    const userid = String(o.userid || '').trim();
    const saveId = String(o.saveId || '').trim();
    const ver = o.version != null ? Number(o.version) : 0;

    if (magic) {
        if (magic === 'nfidfug8') {
            if (!sn || !userid) {
                throw new Error('nfidfug8 存档需要 sn 与明文 userid（dirKey 由二者自动计算）');
            }
            return wasmDecryptSaveEx(text, psw, sn, userid);
        }
        if (!sn) {
            throw new Error('双层存档需要 sn（本机设备 ID，填一次即可记住）');
        }
        let idOrUser;
        if (magic === 'js9qf8me') {
            // md5(reverse(userid))，存档外壳 id 用不了
            if (!userid) {
                throw new Error('js9qf8me 存档需要明文 userid（不能只用存档 id）');
            }
            idOrUser = userid;
        } else {
            idOrUser = saveId || userid;
            if (!idOrUser) {
                throw new Error('kjie00o0 存档需要存档 id 或 userid');
            }
        }
        return wasmDecryptSaveEx(text, psw, sn, idOrUser);
    }

    try {
        if (psw) {
            return wasmDecryptSaveEx(text, psw, '', '');
        }
        return wasmDecryptSave(text);
    } catch (e) {
        const msg = (e && e.message) || String(e);
        if (ver >= 72280 && !text.startsWith('MDAw')) {
            throw new Error(
                `存档 content 无法按单层解密（v${ver || '?'}）。` +
                `若为双层应带 nfidfug8 / js9qf8me / kjie00o0 前缀。（${msg}）`
            );
        }
        throw e;
    }
}

/** 绑定凭证输入框 / 加载凭证文件；页面需含 #saveUserId #saveSn #saveCredsInput */
function bindSaveCredsUI() {
    const ids = ['saveUserId', 'saveSn'];
    // 恢复上次凭证
    try {
        const raw = localStorage.getItem(SAVE_CREDS_KEY);
        if (raw) setSaveDecryptCreds(JSON.parse(raw));
    } catch (_) {}

    const persist = () => setSaveDecryptCreds(getSaveDecryptCreds());
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', persist);
            el.addEventListener('blur', persist);
        }
    });

    const credInput = document.getElementById('saveCredsInput');
    if (credInput) {
        credInput.addEventListener('change', async (e) => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            try {
                const text = (await f.text()).replace(/^\uFEFF/, '').trim();
                const obj = JSON.parse(text);
                // 兼容完整 startGame 明文：从 data 里取
                let creds = obj;
                if (obj && obj.data && (obj.data.psw || obj.data.sn)) {
                    const data = obj.data;
                    const ver = data.saveVer || data.ver;
                    creds = { userid: '', sn: data.sn || '', saveVer: ver };
                    // userid 可能不在 startGame 明文里，保留原输入
                    const cur = getSaveDecryptCreds();
                    creds.userid = cur.userid || '';
                }
                if (!creds.userid && !creds.sn) {
                    throw new Error('凭证 JSON 缺少 userid/sn');
                }
                // 合并：文件有的字段覆盖
                const merged = { ...getSaveDecryptCreds(), ...creds };
                setSaveDecryptCreds(merged);
                alert(`已加载凭证\nuserid=${merged.userid || '(空)'}\nsn=${merged.sn || '(空)'}`);
            } catch (err) {
                alert('加载凭证失败: ' + (err.message || err));
            }
            e.target.value = '';
        });
    }
}

function formatSaveDecryptError(err, rawMeta) {
    let versionTip = '';
    let ver = 0;
    if (rawMeta) {
        try {
            const metaObj = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
            if (metaObj && metaObj.version != null) {
                ver = Number(metaObj.version) || 0;
                versionTip = ` (存档版本 v${metaObj.version})`;
            }
        } catch (_) {}
    }
    const msg = (err && err.message) || String(err || '');
    if (msg.indexOf('nfidfug8') !== -1 || ver >= 72294) {
        return (
            `存档解密失败${versionTip}：${msg}\n\n` +
            `72294（nfidfug8）需填写 sn + 明文 userid；psw / dirKey 按版本自动计算。也可直接导入明文 JSON。`
        );
    }
    if (msg.indexOf('js9qf8me') !== -1 || ver >= 72288) {
        return (
            `存档解密失败${versionTip}：${msg}\n\n` +
            `72288+（js9qf8me）需填写 sn + 明文 userid；psw 按版本自动选。` +
            `也可直接导入已解密的明文 JSON。`
        );
    }
    if (msg.indexOf('kjie00o0') !== -1 || ver >= 72280) {
        return (
            `存档解密失败${versionTip}：${msg}\n\n` +
            `kjie00o0 档一般只需填写本机 sn；userid 可用存档 id 推导，psw 按版本自动选。` +
            `也可直接导入明文 JSON。`
        );
    }
    return `存档解密失败${versionTip}：${msg}\n\n也可直接导入明文 JSON。`;
}

/** 从加密存档外壳取出 content / id / version */
function pickSaveCipherMeta(raw) {
    const it = Array.isArray(raw) ? raw[0] : raw;
    if (!it || typeof it !== 'object' || !it.content) {
        return null;
    }
    let version = null;
    const player = it.player;
    if (player) {
        try {
            const meta = typeof player === 'string' ? JSON.parse(player) : player;
            if (meta && meta.version != null) version = meta.version;
        } catch (_) {}
    }
    return {
        content: it.content,
        saveId: it.id ? String(it.id) : '',
        version,
        player,
    };
}

function wasmGetAvailableTalents() {
    if (!wasmReady) return [];
    try {
        return JSON.parse(_callStringReturn(r => wasmExports.get_available_talents(r)));
    } catch { return []; }
}

function wasmGetConflicts() {
    if (!wasmReady) return [];
    try {
        return JSON.parse(_callStringReturn(r => wasmExports.get_conflicts(r)));
    } catch { return []; }
}

// ========== 装备打造 API ==========

function wasmMakeInitTables(tablesObj) {
    if (!wasmReady) return false;
    try {
        const json = JSON.stringify(tablesObj);
        const ptr = passStringToWasm0(json, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
        const len = WASM_VECTOR_LEN;
        return wasmExports.make_init_tables(ptr, len) !== 0;
    } catch (e) {
        console.error('make_init_tables failed', e);
        return false;
    }
}

function wasmMakeSetState(stateObj) {
    if (!wasmReady) return false;
    try {
        const json = JSON.stringify(stateObj);
        const ptr = passStringToWasm0(json, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
        const len = WASM_VECTOR_LEN;
        return wasmExports.make_set_state(ptr, len) !== 0;
    } catch (e) {
        console.error('make_set_state failed', e);
        return false;
    }
}

function wasmMakeGetState() {
    if (!wasmReady) return null;
    try {
        return JSON.parse(_callStringReturn(r => wasmExports.make_get_state(r)));
    } catch { return null; }
}

function wasmMakePreview(req, n) {
    if (!wasmReady) return { items: [], error: 'WASM 未加载' };
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            const json = JSON.stringify(req || {});
            const ptr = passStringToWasm0(json, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const len = WASM_VECTOR_LEN;
            wasmExports.make_preview(retptr, ptr, len, n >>> 0);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch (e) {
        console.error('make_preview failed', e);
        return { items: [], error: String(e) };
    }
}

function wasmMakeOnce(req) {
    if (!wasmReady) return { error: 'WASM 未加载' };
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            const json = JSON.stringify(req || {});
            const ptr = passStringToWasm0(json, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const len = WASM_VECTOR_LEN;
            wasmExports.make_once(retptr, ptr, len);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch (e) {
        console.error('make_once failed', e);
        return { error: String(e) };
    }
}

function _callJsonInOut(fnName, obj, extraArg) {
    if (!wasmReady) return { error: 'WASM 未加载' };
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            const json = JSON.stringify(obj || {});
            const ptr = passStringToWasm0(json, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const len = WASM_VECTOR_LEN;
            if (extraArg === undefined) {
                wasmExports[fnName](retptr, ptr, len);
            } else {
                wasmExports[fnName](retptr, ptr, len, extraArg >>> 0);
            }
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch (e) {
        console.error(fnName + ' failed', e);
        return { error: String(e) };
    }
}

function wasmXilianPreview(equip, n) {
    return _callJsonInOut('xilian_preview', equip, n);
}

function wasmXilianOnce(equip) {
    return _callJsonInOut('xilian_once', equip);
}

/** accepts: boolean[] */
function wasmXilianPlan(equip, accepts) {
    if (!wasmReady) return { error: 'WASM 未加载' };
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            const j0 = JSON.stringify(equip || {});
            const p0 = passStringToWasm0(j0, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const l0 = WASM_VECTOR_LEN;
            const j1 = JSON.stringify(accepts || []);
            const p1 = passStringToWasm0(j1, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const l1 = WASM_VECTOR_LEN;
            wasmExports.xilian_plan(retptr, p0, l0, p1, l1);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch (e) {
        console.error('xilian_plan failed', e);
        return { error: String(e) };
    }
}

function wasmStrongPreview(equip, n) {
    return _callJsonInOut('strong_preview', equip, n);
}

function wasmStrongOnce(equip) {
    return _callJsonInOut('strong_once', equip);
}

// ========== 剑王阁红武 ==========

function _callU32Return(fnName, a, b, c, d) {
    if (!wasmReady) return { error: 'WASM 未加载' };
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            if (d !== undefined) wasmExports[fnName](retptr, a >>> 0, b | 0, c | 0, d >>> 0);
            else if (c !== undefined) wasmExports[fnName](retptr, a >>> 0, b | 0, c | 0);
            else if (b !== undefined) wasmExports[fnName](retptr, a >>> 0, b >>> 0);
            else wasmExports[fnName](retptr, a >>> 0);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch (e) {
        console.error(fnName + ' failed', e);
        return { error: String(e) };
    }
}

function wasmJwgCreatePreview(equipId, n) {
    return _callU32Return('jwg_create_preview', equipId, n);
}

function wasmJwgCreateOnce(equipId) {
    return _callU32Return('jwg_create_once', equipId);
}

function wasmJwgGrowOnce(equip, targetId, keepSlot) {
    if (!wasmReady) return { error: 'WASM 未加载' };
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            const json = JSON.stringify(equip || {});
            const ptr = passStringToWasm0(json, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const len = WASM_VECTOR_LEN;
            wasmExports.jwg_grow_once(retptr, ptr, len, targetId >>> 0, keepSlot | 0);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch (e) {
        console.error('jwg_grow_once failed', e);
        return { error: String(e) };
    }
}

function wasmJwgGrowPreview(equip, targetId, keepSlot, n) {
    if (!wasmReady) return { items: [], error: 'WASM 未加载' };
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            const json = JSON.stringify(equip || {});
            const ptr = passStringToWasm0(json, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const len = WASM_VECTOR_LEN;
            wasmExports.jwg_grow_preview(retptr, ptr, len, targetId >>> 0, keepSlot | 0, n >>> 0);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch (e) {
        console.error('jwg_grow_preview failed', e);
        return { items: [], error: String(e) };
    }
}

function wasmJwgPathPreview(createN, recastN) {
    return _callU32Return('jwg_path_preview', createN, recastN);
}

function wasmJwgPathAdvance(createN, targetId, recastN) {
    return _callU32Return('jwg_path_advance', createN, targetId, recastN);
}

function wasmJwgPathFromPreview(equip, recastN) {
    if (!wasmReady) return { items: [], error: 'WASM 未加载' };
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            const json = JSON.stringify(equip || {});
            const ptr = passStringToWasm0(json, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const len = WASM_VECTOR_LEN;
            wasmExports.jwg_path_from_preview(retptr, ptr, len, recastN >>> 0);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch (e) {
        console.error('jwg_path_from_preview failed', e);
        return { items: [], error: String(e) };
    }
}

function wasmJwgPathFromAdvance(equip, targetId, recastN) {
    if (!wasmReady) return { error: 'WASM 未加载' };
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            const json = JSON.stringify(equip || {});
            const ptr = passStringToWasm0(json, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const len = WASM_VECTOR_LEN;
            wasmExports.jwg_path_from_advance(retptr, ptr, len, targetId >>> 0, recastN >>> 0);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch (e) {
        console.error('jwg_path_from_advance failed', e);
        return { error: String(e) };
    }
}

function wasmJwgPromote100(equip) {
    return _callJsonInOut('jwg_promote_100', equip);
}

function wasmMjReplacePreview(req) {
    return _callJsonInOut('mj_replace_preview', req);
}

function wasmMjReplaceOnce(req) {
    return _callJsonInOut('mj_replace_once', req);
}

function wasmPipelineSearch(req) {
    return _callJsonInOut('pipeline_search', req);
}

function wasmAutoSearch(req) {
    return _callJsonInOut('auto_search', req);
}

function wasmXilianSearch(req) {
    return _callJsonInOut('xilian_search', req);
}

function wasmJwgSearch(req) {
    return _callJsonInOut('jwg_search', req);
}

function wasmSearchWashRoutes(req) {
    return _callJsonInOut('search_wash_routes', req);
}

function wasmSectInitTables(tablesObj) {
    if (!wasmReady) return false;
    try {
        const json = JSON.stringify(tablesObj);
        const ptr = passStringToWasm0(json, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
        const len = WASM_VECTOR_LEN;
        return wasmExports.sect_init_tables(ptr, len) !== 0;
    } catch (e) {
        console.error('sect_init_tables failed', e);
        return false;
    }
}

function wasmSectWashPreview(req) {
    return _callJsonInOut('sect_wash_preview', req);
}

function wasmSectWashUntil(req) {
    return _callJsonInOut('sect_wash_until', req);
}

function wasmSectSearchPath(req) {
    return _callJsonInOut('sect_search_path', req);
}

function wasmSectProjectSlots(req) {
    return _callJsonInOut('sect_project_slots', req);
}

function wasmSectPreviewRefresh(req) {
    return _callJsonInOut('sect_preview_refresh', req);
}

function wasmParseSectData(obj) {
    return _callJsonInOut('parse_sect_data', obj);
}

/** 战斗推演：传入 buildSimRequest 产出的完整 JSON */
function wasmSimulateBattle(request) {
    if (!wasmReady) return { error: 'WASM 未加载' };
    try {
        let d0, d1;
        const retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
        try {
            const json = JSON.stringify(request || {});
            const ptr = passStringToWasm0(json, wasmExports.__wbindgen_export, wasmExports.__wbindgen_export2);
            const len = WASM_VECTOR_LEN;
            wasmExports.simulate_battle(retptr, ptr, len);
            const r0 = getDataViewMemory0().getInt32(retptr + 0, true);
            const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
            d0 = r0; d1 = r1;
            return JSON.parse(getStringFromWasm0(r0, r1));
        } finally {
            wasmExports.__wbindgen_add_to_stack_pointer(16);
            wasmExports.__wbindgen_export3(d0, d1, 1);
        }
    } catch (e) {
        console.error('simulate_battle failed', e);
        return { error: String(e) };
    }
}

// ========== State 同步 ==========

function syncStateToWasm(jsState) {
    const ws = {
        mode: jsState.mode,
        zizhi: jsState.zizhi,
        sex: jsState.sex,
        vip: jsState.vip,
        seed: jsState.seed,
        luck_seed: jsState.luckSeed,
        luck_seed_inited: jsState.luckSeedInited,
        role_id: jsState.roleId,
        salt: jsState.salt,
        born_rc: Number(jsState.bornRc) || 0,
        has_born_talent: jsState.hasBornTalent !== false,
        rng_variant: '73324',
        talents: jsState.talents,
        tal_lucky: jsState.talLucky,
        total_wash: jsState.totalWash,
        total_talent_bars: jsState.totalTalentBars || 0,
        total_pills: jsState.totalPills,
        bag_pills: jsState.bagPills,
        has_bag_pills: jsState.hasBagPills,
        gold_count: jsState.goldCount,
        pity_count: jsState.pityCount,
        quality_counts: jsState.qualityCounts,
        last_purple_total_pills: jsState.lastPurpleTotalPills,
        exchange_count: jsState.exchangeCount,
        str_gift: jsState.strGift,
        con_gift: jsState.conGift,
        dex_gift: jsState.dexGift,
        int_gift: jsState.intGift,
        role_level: jsState.roleLevel,
        role_stats: jsState.roleStats || { str_val: 0, dex: 0, con: 0, int_val: 0 },
        global_vars: jsState.globalVars || {},
    };
    return wasmSetState(ws);
}

function syncStateFromWasm(jsState) {
    const ws = wasmGetState();
    if (!ws) return;
    jsState.mode = ws.mode;
    jsState.zizhi = ws.zizhi;
    jsState.sex = ws.sex;
    jsState.vip = ws.vip;
    jsState.seed = ws.seed;
    jsState.luckSeed = ws.luck_seed;
    jsState.luckSeedInited = ws.luck_seed_inited;
    jsState.roleId = ws.role_id;
    jsState.salt = ws.salt;
    if (ws.born_rc != null) jsState.bornRc = ws.born_rc;
    if (ws.has_born_talent != null) jsState.hasBornTalent = !!ws.has_born_talent;
    jsState.rngVariant = '73324';
    jsState.talents = ws.talents;
    jsState.talLucky = ws.tal_lucky;
    jsState.totalWash = ws.total_wash;
    jsState.totalTalentBars = ws.total_talent_bars || 0;
    jsState.totalPills = ws.total_pills;
    jsState.bagPills = ws.bag_pills;
    jsState.hasBagPills = ws.has_bag_pills;
    jsState.goldCount = ws.gold_count;
    jsState.pityCount = ws.pity_count;
    jsState.qualityCounts = ws.quality_counts;
    jsState.lastPurpleTotalPills = ws.last_purple_total_pills;
    jsState.exchangeCount = ws.exchange_count;
    jsState.strGift = ws.str_gift;
    jsState.conGift = ws.con_gift;
    jsState.dexGift = ws.dex_gift;
    jsState.intGift = ws.int_gift;
    jsState.roleLevel = ws.role_level;
}

function convertWashResult(wr) {
    if (!wr) return null;
    return {
        washNo: wr.wash_no,
        talents: wr.talents,
        gotGold: wr.got_gold,
        pillsUsed: wr.pills_used,
        totalPills: wr.total_pills,
        bagPills: wr.bag_pills,
        wasPity: wr.was_pity,
        pityArmed: wr.pity_armed,
        talLucky: wr.tal_lucky,
        purpleGapPills: wr.purple_gap_pills,
        isFirstPurple: wr.is_first_purple,
        startS: wr.start_s,
        endS: wr.end_s,
        luckSeed: wr.luck_seed,
        roleId: wr.role_id,
    };
}

function convertExchangeResult(er) {
    if (!er) return null;
    return {
        success: er.success,
        error: er.error,
        washNo: er.wash_no,
        exchangeNo: er.exchange_no,
        talents: er.talents,
        gotGold: er.got_gold,
        isExchange: er.is_exchange,
        exchangedFrom: er.exchanged_from,
        exchangedTo: er.exchanged_to,
        pillsUsed: er.pills_used,
        totalPills: er.total_pills,
        bagPills: er.bag_pills,
        wasPity: er.was_pity,
        pityArmed: er.pity_armed,
        talLucky: er.tal_lucky,
        purpleGapPills: er.purple_gap_pills,
        isFirstPurple: er.is_first_purple,
        startS: er.start_s,
        endS: er.end_s,
        luckSeed: er.luck_seed,
        roleId: er.role_id,
    };
}
