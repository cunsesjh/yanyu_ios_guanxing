/* Seven tactical layers. Every candidate is replayed with the desktop wash engine. */
(function (root) {
    'use strict';
    const LAYERS = 7;
    const WORK_PER_LAYER = 750000;
    const QUANTUM = 128;

    function* iterate(ctx, cap, nearby, accept, progress) {
        const {engine, startState, targetIds, compatibleGroups = [], options} = ctx;
        const {actionWash, actionOpen, actionReplace, traceAppend, routeFromNode} = root.PersonalWashRoutes;
        const {goal, exchangeLocks} = root.PersonalWashSearch;
        const required = new Set(targetIds);
        const wanted = new Set([...targetIds, ...compatibleGroups.flat()]);
        const startingLocks = (ctx.initialState.talents || []).filter(t => t.locked).map(t => t.id);
        const keyOf = root.AutoWash2Engine.stateKey;
        const slots = state => engine.slotCountFor(state.zizhi);
        let ceiling = cap, work = 0, washes = 0, limit = 0;
        let frontier, windows;
        const expired = () => work >= limit;
        const step = (node, result) => ({state:result.state, cost:node.cost + result.action.cost,
            trace:traceAppend(node.trace, result.action)});
        function wash(node, locks) {
            washes++;
            work++;
            return step(node, actionWash(engine, node.state, locks, 'conflict-window'));
        }
        function* slotVariants(node) {
            yield node;
            while (node.state.zizhi < options.maxZi) {
                node = step(node, actionOpen(engine, node.state));
                yield node;
            }
        }
        function windowLength(node, lockCount) {
            const cost = engine.at(node.state.zizhi).eat + Math.max(0, 2 * lockCount - 1);
            const affordable = Math.max(0, Math.floor((ceiling - node.cost) / cost));
            return Math.ceil(Math.sqrt(affordable) * slots(node.state));
        }
        function finish(node) {
            if (node.cost > ceiling) return false;
            const targets = goal(ctx, node.state);
            if (!targets) return false;
            const route = routeFromNode({...ctx, targetIds:targets}, {...node, serial:0});
            route.strategyLabel = nearby ? '邻近冲突与连续置换' : '冲突回溯与延迟置换';
            accept(route);
            ceiling = node.cost - 1;
            return true;
        }
        // Only branch on group members actually in these slots. Input groups may have
        // many combinations, but at a particular state there are at most four talents.
        function lockChoices(state, held) {
            const present = state.talents;
            const fixed = present.filter(id => held.includes(id) || required.has(id));
            let choices = [fixed];
            for (const group of compatibleGroups) {
                const available = present.filter(id => group.includes(id));
                if (!available.length) continue;
                choices = choices.flatMap(ids => ids.some(id => group.includes(id)) ? [ids]
                    : available.map(id => [...ids, id]));
            }
            return choices;
        }
        function keep(node, ids) {
            if (node.cost > ceiling) return;
            const held = node.state.talents.filter(id => ids.includes(id));
            const group = [node.state.zizhi, node.state.luckSeed, held.join(',')].join('/');
            const key = keyOf(node.state);
            const bucket = frontier.get(group) || [];
            const same = bucket.findIndex(item => item.key === key);
            if (same >= 0) {
                if (bucket[same].cost <= node.cost) return;
                bucket.splice(same, 1);
            }
            if (bucket.length === 3 && bucket[2].cost <= node.cost) return;
            bucket.push({...node, held, key});
            bucket.sort((a,b) => a.cost - b.cost);
            if (bucket.length > 3) bucket.pop();
            frontier.set(group, bucket);
        }
        function retainTargets(node, held) {
            for (const locks of lockChoices(node.state, held)) {
                const gained = locks.filter(id => !held.includes(id));
                if (!gained.length) continue;
                keep(node, locks);
                // A cheaper first target can have a more expensive continuation.
                if (gained.length > 1)
                    for (const id of gained) keep(node, [...held, id]);
            }
        }
        // After the first exchange, follow only legal zero-pill edges. A repeated
        // talent name may have a new luck seed. Only the full state closes a cycle.
        function* freeChain(first, held) {
            const queue = [first], seen = new Set([keyOf(first.state)]);
            for (let i = 0; i < queue.length && !expired() && first.cost <= ceiling; i++) {
                const node = queue[i];
                if (finish(node)) break;
                const retained = held.filter(id => node.state.talents.includes(id));
                retainTargets(node, retained);
                if (retained.length) keep(node, retained);
                for (const pos of engine.replaceablePositions(node.state, node.state.talents)) {
                    if (expired()) break;
                    const locks = exchangeLocks(engine, node.state, pos, retained);
                    const next = step(node, actionReplace(engine, node.state, pos, 'free-chain', locks));
                    work++;
                    const key = keyOf(next.state);
                    if (!seen.has(key)) {
                        seen.add(key);
                        queue.push(next);
                    }
                    if (work % QUANTUM === 0) yield;
                }
            }
        }
        function* exchangeWindow(start, held, carrier) {
            const key = [keyOf(start.state), held.join(','), carrier].join('/');
            if ((windows.get(key) ?? Infinity) <= start.cost) return;
            windows.set(key, start.cost);
            const padLocks = [...new Set([...held, carrier])];
            const protectedIds = held.filter(id => wanted.has(id) || startingLocks.includes(id));
            const maxPad = windowLength(start, padLocks.length);
            let node = start;
            for (let n = 0; n <= maxPad && node.cost <= ceiling && !expired(); n++) {
                const pos = node.state.talents.indexOf(carrier);
                if (!engine.replaceablePositions(node.state, held).includes(pos)) break;
                const next = step(node, actionReplace(engine, node.state, pos, 'window-exchange', held));
                work++;
                if (work % QUANTUM === 0) yield;
                yield* freeChain(next, protectedIds);
                if (n === maxPad || padLocks.length >= slots(node.state) || expired()) break;
                node = wash(node, padLocks);
                if (work % QUANTUM === 0) yield;
            }
        }
        function* atPair(node, held, carrier) {
            // Opening here preserves the RNG but changes the price and the number
            // of unlocked draws per wash. Keep the original slot count as well.
            for (const variant of slotVariants(node)) {
                if (expired()) return;
                yield* exchangeWindow(variant, held, carrier);
            }
        }
        function* activePairs(node, held) {
            for (const pos of engine.replaceablePositions(node.state, node.state.talents)) {
                const locks = exchangeLocks(engine, node.state, pos, held);
                yield* atPair(node, locks, node.state.talents[pos]);
            }
        }
        function* scan(node, held, explore) {
            if (node.cost > ceiling || finish(node)) return;
            if (explore) yield* activePairs(node, held);
            const recent = [], lookback = windowLength(node, held.length);
            while (held.length < slots(node.state) && node.cost <= ceiling && !expired()) {
                const next = wash(node, held);
                if (work % QUANTUM === 0) yield;
                if (next.cost > ceiling || finish(next)) break;
                const fresh = next.state.talents.filter(id => !held.includes(id));
                if (explore && fresh.some(id => engine.quality(id) === 4)) {
                    yield* activePairs(next, held);
                    for (const purple of fresh.filter(id => engine.quality(id) === 4)) {
                        const type = engine.talentType(purple);
                        const anchors = nearby ? recent.slice().reverse() : recent;
                        let matches = 0;
                        for (const before of anchors) {
                            const anchor = before.state.talents.find(id => !held.includes(id)
                                && engine.quality(id) < 4 && engine.talentType(id) === type);
                            if (anchor == null) continue;
                            if (nearby && ++matches > 3) break;
                            const locks = [...held, anchor];
                            for (let pivot of slotVariants(before)) {
                                while (locks.length < slots(pivot.state) && !expired()
                                        && pivot.state.bornRC <= next.state.bornRC && pivot.cost < ceiling) {
                                    pivot = wash(pivot, locks);
                                    if (work % QUANTUM === 0) yield;
                                    if (pivot.cost > ceiling) break;
                                    const pos = pivot.state.talents.indexOf(purple);
                                    if (pos >= 0 && engine.replaceablePositions(pivot.state, locks).includes(pos)) {
                                        yield* atPair(pivot, locks, purple);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                if (explore) retainTargets(next, held);
                else held = lockChoices(next.state, held)[0];
                if (explore) {
                    recent.push(node);
                    if (recent.length > lookback) recent.shift();
                }
                node = next;
            }
        }
        const scores = new Map();
        function seedScore(node) {
            const key = [node.state.zizhi,node.state.luckSeed,node.state.talents.join(','),node.held.join(',')].join('/');
            if (scores.has(key)) return scores.get(key);
            let seed = node.state.luckSeed;
            const seen = new Set(node.held);
            if (seed != null) {
                for (let i = 0, accepted = 0; i < 32 && accepted < 4; i++) {
                    const [id, next] = engine.draw(seed, true);
                    seed = next;
                    if (seen.has(id) || !engine.isAllowedAt(id, node.state.zizhi, node.state)) continue;
                    seen.add(id); accepted++;
                }
            }
            const score = targetIds.filter(id => seen.has(id)).length * 2
                + compatibleGroups.filter(group => group.some(id => seen.has(id))).length;
            scores.set(key, score);
            return score;
        }
        const start = {state:startState, cost:0, trace:null, held:startingLocks};
        let layer = [start];
        if (startingLocks.length) layer.push({...start, held:[]});
        for (const locks of lockChoices(startState, startingLocks)) {
            if (locks.length > startingLocks.length) layer.push({...start, held:locks});
        }
        for (const id of startState.talents.filter(id => wanted.has(id)))
            layer.push({...start, held:[id]});
        for (let depth = 1; depth <= LAYERS && layer.length && ceiling >= 0; depth++) {
            washes = work = 0;
            limit = Math.floor(WORK_PER_LAYER * 0.8);
            frontier = new Map();
            windows = new Map();
            const report = () => progress({layer:depth, layers:LAYERS, washes,
                method:nearby ? '邻近前置与开槽' : '冲突回溯与延迟置换'});
            report();
            let nextReport = 16384;
            function* runLayer(items, explore) {
                const starts = new Map();
                for (const item of items) {
                    if (item.cost > ceiling) continue;
                    for (const variant of slotVariants(item)) {
                        const key = keyOf(variant.state) + '/' + item.held.join(',');
                        if ((starts.get(key)?.cost ?? Infinity) > variant.cost)
                            starts.set(key, {...variant, held:item.held});
                    }
                }
                let jobs = Array.from(starts.values(), item => scan(item, item.held, explore));
                while (jobs.length && !expired() && ceiling >= 0) {
                    const pending = [];
                    for (const job of jobs) {
                        if (expired()) break;
                        if (!job.next().done) pending.push(job);
                        if (work >= nextReport) {
                            report();
                            nextReport = work + 16384;
                        }
                        yield;
                    }
                    jobs = pending;
                }
            }
            yield* runLayer(layer, true);
            layer = [...frontier.values()].flat().sort((a,b) => b.held.length - a.held.length
                || seedScore(b) - seedScore(a) || a.cost - b.cost);
            limit = WORK_PER_LAYER;
            yield* runLayer(layer, false);
        }
    }
    root.PersonalWashConflictWindows = Object.freeze({iterate});
})(self);
