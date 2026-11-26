/* Search adapter around the same per-draw state machine as the current wash page.
 * Loaded only in the new module's Worker; legacy engine/registry remain untouched.
 */
(function (root) {
    'use strict';
    const source = root.WashSourceEngine;
    const cloneState = state => ({...source.cloneState(state), zizhi: Number(state.zizhi ?? 154)});
    const isInternational = channel => /^(国际服|國際服|oversea|international)$/i.test(String(channel || '').trim());
    class Engine extends source.Engine {
        constructor(data, raw, options = {}) {
            super(data, raw, {...options, eligibleZi: 154,
                advancePerDraw: !!(root.SequenceRules && root.SequenceRules.washRC(raw))});
            this.data = data; this.raw = raw; this.options = options; this.levels = new Map();
        }
        at(zizhi) {
            zizhi = Number(zizhi ?? 154);
            if (!this.levels.has(zizhi)) {
                const config = root.ZZ_DATA[zizhi];
                if (!config) throw new Error('无法读取该资质的洗脉规则');
                this.levels.set(zizhi, new source.Engine(this.data, this.raw, {
                    ...this.options, eligibleZi: zizhi, slotCount: Number(config.num_talent),
                    pity: Number(config.bd_zz), eat: Number(config.eat_xisui),
                    advancePerDraw: !!(root.SequenceRules && root.SequenceRules.washRC(this.raw)),
                    international: isInternational(this.raw.save_channel || this.raw.channel),
                }));
            }
            return this.levels.get(zizhi);
        }
        initialState(raw) { return {...super.initialState(raw), zizhi: Number(raw.zizhi ?? 154)}; }
        slotCountFor(zizhi) { return Number(root.ZZ_DATA[zizhi]?.num_talent || 0); }
        isAllowedAt(id, zizhi, state) { return this.at(zizhi).isAllowedAt(id, zizhi, state); }
        // The worker asks for the state-scoped allowed set. Keep this adapter
        // explicit so the AWASH inspection path does not depend on a legacy
        // engine method name.
        allowedForState(state, zizhi = state?.zizhi) {
            return this.at(zizhi).allowedSet(zizhi);
        }
        wash(state, keepPositions) {
            const result = this.at(state.zizhi).wash(state, keepPositions);
            result.state.zizhi = state.zizhi;
            return result;
        }
        replace(state, position, locks) {
            const result = this.at(state.zizhi).replace(state, position, locks);
            result.state.zizhi = state.zizhi;
            return result;
        }
        upgradeToThree(state) { return {...cloneState(state), zizhi: 153}; }
        upgradeToFour(state) { return {...cloneState(state), zizhi: 154}; }
    }
    root.AutoWash2Engine = Object.freeze({...source, Engine, cloneState,
        stateKey: state => `${state.zizhi}|${source.stateKey(state)}`});
})(typeof globalThis !== 'undefined' ? globalThis : self);
