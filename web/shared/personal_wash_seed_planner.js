/* Follow the upstream conflict/carrier decisions using the personal tab's engine.
 * A rolling lookahead keeps ordinary washes between two lock changes reusable. */
(function (root) {
    'use strict';
    function create(ctx) {
        const {engine} = ctx;
        const starts = new Map([[ctx.startState.zizhi, ctx.startState]]);
        for (let zi = ctx.startState.zizhi + 1; zi <= ctx.options.maxZi; zi++) {
            starts.set(zi, root.PersonalWashRoutes.actionOpen(engine, starts.get(zi - 1)).state);
        }
        // Transitions are deterministic for this role. A weak key lets abandoned
        // branches disappear; periodically drop the roots' retained subtrees.
        let memo = new WeakMap(), opened = new WeakMap(), memoSize = 0;
        function wash(state, ids) {
            let mask = 0;
            const positions = [];
            for (let i = 0; i < state.talents.length; i++) {
                if (ids.includes(state.talents[i])) {
                    mask |= 1 << i;
                    positions.push(i);
                }
            }
            let byMask = memo.get(state);
            if (byMask?.[mask]) return byMask[mask];
            const result = engine.wash(state, positions);
            if (++memoSize >= 48000) { memo = new WeakMap(); memoSize = 0; byMask = null; }
            if (!byMask) { byMask = []; memo.set(state, byMask); }
            byMask[mask] = result;
            return result;
        }
        function construct(ids, {zi0, lead, n = 0, maxWash, budget, probeSeeds}) {
            let state = starts.get(zi0), cost = 0, washes = 0;
            const held = [], steps = [];
            let conflict = null, since = 0, segment = null;
            let future = [], head = 0, tailState = state, expected = state, signature = '';
            const coming = new Map();
            function countPurples(roll, delta) {
                for (const ev of roll.generatedEvents) {
                    if (engine.quality(ev.id) !== 4 || ids.includes(ev.id)) continue;
                    const type = engine.talentType(ev.id);
                    const count = (coming.get(type) || 0) + delta;
                    if (count) coming.set(type, count);
                    else coming.delete(type);
                }
            }
            function locks() { return conflict == null ? held : [...held, conflict]; }
            function align(keep) {
                const key = keep.join(',');
                if (expected !== state || signature !== key) {
                    future = []; head = 0; tailState = state; expected = state; signature = key; coming.clear();
                }
            }
            function advance(keep) {
                if (keep.length >= engine.slotCountFor(state.zizhi)) return false;
                align(keep);
                const known = head < future.length;
                const result = known ? future[head++] : wash(state, keep);
                if (known) countPurples(result, -1);
                if (head === future.length) { future = []; head = 0; tailState = result.state; }
                else if (head > 64) { future = future.slice(head); head = 0; }
                state = result.state; expected = state; washes++; cost += result.cost;
                if (cost > budget) return false;
                if (probeSeeds == null) {
                    if (!segment || segment.signature !== signature) {
                        segment = {type:'wash', signature, locks:keep.slice()};
                        steps.push(segment);
                    }
                    Object.assign(segment, {cost, washes, field:state.talents});
                }
                return result;
            }
            function track() {
                for (const id of ids) if (state.talents.includes(id) && !held.includes(id)) held.push(id);
            }
            function incoming(keep, lows) {
                align(keep);
                while (future.length - head < lead) {
                    const roll = wash(tailState, keep);
                    future.push(roll); tailState = roll.state; countPurples(roll, 1);
                }
                for (const low of lows) {
                    if (coming.has(engine.talentType(low))) return low;
                }
                return null;
            }
            function event(type, attrs) {
                segment = null;
                if (probeSeeds == null) steps.push({type, washes, cost, field:state.talents, locks:[], ...attrs});
            }
            function exchange(pos, keep) {
                const from = state.talents[pos];
                const result = engine.replace(state, pos, keep);
                state = result.state;
                event('exchange', {from, to:result.addedId, replaceLocks:keep.slice()});
                if (ids.includes(result.addedId) && !held.includes(result.addedId)) held.push(result.addedId);
            }
            function exchangeKnown() {
                let acted = false;
                for (let i = 0; i < 4; i++) {
                    const keep = locks();
                    const pos = engine.replaceablePositions(state, keep)
                        .find(index => state.talents[index] !== 251 && !keep.includes(state.talents[index]));
                    if (pos == null) break;
                    let cursor = state.luckSeed;
                    const heads = [];
                    for (let j = 0; j < 4000 && heads.length < 3; j++) {
                        const [id, next] = engine.draw(cursor, true);
                        cursor = next;
                        if (engine.allowed.has(id) && !state.talents.includes(id)) heads.push(id);
                    }
                    if (!heads.some(id => ids.includes(id) && !held.includes(id))) { conflict = null; break; }
                    exchange(pos, keep); acted = true;
                }
                if (acted) conflict = null;
                return acted;
            }
            for (let guard = 0; guard < 2 * maxWash && washes < maxWash; guard++) {
                if (held.length === ids.length) break;
                if (state.zizhi === 153 && ctx.options.maxZi >= 154 &&
                        (held.length >= 1 || locks().length + 1 >= 3)) {
                    if (!opened.has(state)) opened.set(state, engine.upgradeToFour(state));
                    state = opened.get(state); event('upgrade', {toZi:154}); continue;
                }
                track();
                if (held.length === ids.length) break;
                if (state.luckSeed != null && exchangeKnown()) continue;
                if (conflict != null && washes - since > 260) conflict = null;
                const result = advance(locks());
                if (!result) return null;
                track();
                if (held.length === ids.length) break;
                if (conflict == null) {
                    const lows = result.generatedEvents.map(ev => ev.id)
                        .filter(id => id !== 251 && engine.quality(id) < 4 && !held.includes(id));
                    if (lows.length) {
                        conflict = incoming(held, lows);
                        since = washes;
                    }
                }
                if (conflict == null || state.luckSeed != null) continue;
                const type = engine.talentType(conflict);
                const carrier = state.talents.find(id => engine.quality(id) === 4 &&
                    engine.talentType(id) === type && !held.includes(id));
                if (carrier == null) continue;
                if (probeSeeds != null) {
                    const seeds = [state.bornSeed];
                    const keep = [...locks(), carrier];
                    for (let k = 0; k < probeSeeds && advance(keep); k++) seeds.push(state.bornSeed);
                    return {probe:{seeds}};
                }
                for (let k = 0; k < n; k++) {
                    if (!advance([...locks(), carrier])) return null;
                    track();
                }
                const keep = locks(), pos = state.talents.indexOf(carrier);
                if (engine.replaceablePositions(state, keep).includes(pos)) exchange(pos, keep);
                conflict = null;
            }
            return held.length === ids.length ? {ok:true, cost, washes, steps} : null;
        }
        return construct;
    }
    root.PersonalWashSeedPlanner = Object.freeze({create});
})(self);
