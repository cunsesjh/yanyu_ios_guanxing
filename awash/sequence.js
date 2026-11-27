// -*- coding: utf-8 -*-
/**
 * AWash 原始紫脉序列读取器。只依赖 WashSourceEngine，不依赖统一构造器。
 */
(function (root) {
    'use strict';

    function engineFor(context, raw, zi) {
        const zz = context.ZZ_DATA[String(zi)];
        if (!zz) throw new Error(`资质表缺失: ${zi}`);
        return new context.WashSourceEngine.Engine(
            context.TALENT_DATA,
            raw,
            {
                slotCount: Number(zz.num_talent) || 0,
                pity: Number(zz.bd_zz) || 0,
                eat: Number(zz.eat_xisui) || 0,
                eligibleZi: zi,
                advancePerDraw: true,
                dlcMode: !!raw.dlc_mode,
            }
        );
    }

    function readSequence(raw, options) {
        const o = options || {};
        const context = o.context || root;
        const zi = Number(o.zi) >= 150 ? Number(o.zi) : 153;
        const count = Math.max(12, Number(o.count) || 40);
        const cache = o.cache
            && typeof o.cache.get === 'function'
            && typeof o.cache.set === 'function'
            ? o.cache : null;
        // The sequence depends on every seed/state field consumed by
        // WashSourceEngine.initialState. Keep this key local to AWash so the
        // shared session cache cannot collide with pity/checkpoint entries.
        const cacheKey = cache ? `awash:sequence:${JSON.stringify({
            zi,
            count,
            seed: raw && raw.seed,
            luck_seed: raw && raw.luck_seed,
            luck_seed_inited: !!(raw && raw.luck_seed_inited),
            born_talent_rc: raw && raw.born_talent_rc,
            tal_lucky: raw && raw.tal_lucky,
            zizhi: raw && raw.zizhi,
            dlc_mode: !!(raw && raw.dlc_mode),
            talents: (raw && raw.talents || []).map(item => ({
                id: Number(item && item.id != null ? item.id : item),
                locked: !!(item && item.locked),
            })),
        })}` : '';
        if (cache && cache.has(cacheKey)) {
            return cache.get(cacheKey);
        }
        const engine = engineFor(context, raw, zi);
        const initial = engine.initialState(
            Object.assign({}, raw, { zizhi: zi })
        );
        const field = new Set(initial.talents.map(Number));
        let state = initial;
        const lastByType = new Map();
        const seq = [];

        for (const id of state.talents.map(Number)) {
            if (engine.quality(id) === 4 || engine.isShenmai(id)) continue;
            lastByType.set(engine.talentType(id), { id, wash: 0 });
        }
        for (let wash = 1; wash <= 12000 && seq.length < count; wash++) {
            const result = engine.wash(state, []);
            state = result.state;
            for (const event of result.generatedEvents || []) {
                const id = Number(event.id);
                const type = engine.talentType(id);
                if (engine.quality(id) === 4) {
                    const conflict = lastByType.get(type);
                    const conflictId = conflict
                        ? Number(conflict.id) || 0 : 0;
                    seq.push({
                        no: seq.length + 1,
                        wash,
                        id,
                        fromPity: !!event.fromPity,
                        shenmai: engine.isShenmai(id),
                        field: field.has(id),
                        conflictId,
                        conflictWash: conflict
                            ? Number(conflict.wash) || 0 : 0,
                        isAnchor: conflictId > 0,
                    });
                }
                if (engine.quality(id) < 4 && id !== 251) {
                    lastByType.set(type, { id, wash });
                }
            }
        }
        const output = {
            zizhi: zi,
            slots: engine.slotCount,
            seq,
            context,
            raw,
        };
        if (cache) cache.set(cacheKey, output);
        return output;
    }

    const api = Object.freeze({ readSequence });
    root.AWashSequence = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
