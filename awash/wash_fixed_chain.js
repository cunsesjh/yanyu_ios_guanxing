// -*- coding: utf-8 -*-
/**
 * AWash fixed-chain optimizer.
 */
(function (root) {
    'use strict';

    const VERSION = '0.2.1';

    function uniqueNumbers(values) {
        return Array.from(new Set((values || []).map(Number)
            .filter(value => Number.isFinite(value) && value > 0)));
    }

    function sorted(values) {
        return uniqueNumbers(values).sort((a, b) => a - b);
    }

    function compareCost(a, b) {
        return Number(a && a.pills || 0)
            - Number(b && b.pills || 0);
    }

    function advanceUnitCost(pills, advanceBars) {
        const bars = Math.max(0, Number(advanceBars) || 0);
        return bars
            ? Math.max(0, Number(pills) || 0) / bars
            : Number.POSITIVE_INFINITY;
    }

    function dominates(a, b) {
        return compareCost(a, b) < 0;
    }

    function lockMasks(field, slotCount) {
        const values = sorted(field);
        const masks = [];
        for (let bits = 0; bits < (1 << values.length); bits++) {
            const mask = [];
            for (let index = 0; index < values.length; index++) {
                if (bits & (1 << index)) mask.push(values[index]);
            }
            if (mask.length < slotCount) masks.push(mask);
        }
        return masks;
    }

    function targetMaskOf(state, targets) {
        const field = new Set((state.talents || []).map(Number));
        let mask = 0;
        targets.forEach((id, index) => {
            if (field.has(Number(id))) mask |= (1 << index);
        });
        return mask;
    }

    function usefulWashMasks(state, targets) {
        const field = sorted(state.talents);
        const held = targets.filter(id => field.includes(Number(id)));
        const masks = new Map();
        const add = values => {
            const mask = sorted(values)
                .filter(id => field.includes(Number(id)));
            masks.set(mask.join(','), mask);
        };
        add(held);
        add([]);
        for (const id of field) {
            if (held.includes(Number(id))) continue;
            add(held.concat([id]));
            add([id]);
        }
        return Array.from(masks.values());
    }

    function stateKeyOf(adapter, state, locks) {
        return adapter.stateKey(state) + '|' + sorted(locks).join(',');
    }

    function makeNode(parent, state, lockSet, action, pills, washes,
        exchanges, steps, sequence, advanceBars) {
        return {
            parent,
            state,
            lockSet: sorted(lockSet).filter(id =>
                state.talents.includes(Number(id))
            ),
            action,
            pills: Number(pills) || 0,
            washes: Number(washes) || 0,
            exchanges: Number(exchanges) || 0,
            steps: (steps || []).slice(),
            sequence,
            advanceBars: Math.max(0, Number(advanceBars) || 0),
        };
    }

    function nodeCompare(a, b) {
        return compareCost(a, b)
            || (Number(a.sequence) || 0) - (Number(b.sequence) || 0);
    }

    function actionStepLocks(lockIds) {
        return { op: 'locks', lockIds: sorted(lockIds) };
    }

    function generatedPurples(adapter, result, at) {
        return (result.generatedEvents || [])
            .filter(event => adapter.quality(event.id) === 4)
            .map(event => ({
                at,
                id: Number(event.id),
                fromPity: !!event.fromPity,
            }));
    }

    function addOutcome(outcomes, node, targetMask, startMask, limit) {
        if (targetMask === startMask) return false;
        outcomes.push({
            targetMask,
            pills: node.pills,
            washes: node.washes,
            exchanges: node.exchanges,
            finalStateKey: node._engineStateKey,
            stepCount: node.steps.length,
            rawSteps: node.steps.slice(),
            state: node.state,
            lockSet: node.lockSet.slice(),
        });
        return outcomes.length >= limit;
    }

    function enumerateChildren(adapter, node, targets, options, counters) {
        const state = node.state;
        const slots = adapter.slotCount(state);
        const maxRun = Math.max(1, Number(options.maxRunWashes) || 1200);
        const generated = [];

        for (const mask of lockMasks(state.talents, slots)) {
            if (counters.washes >= counters.maxWashes) break;
            const washed = adapter.wash(state, mask);
            counters.washes += 1;
            generated.push(makeNode(
                node,
                washed.state,
                mask,
                { type: 'wash', lockIds: mask.slice() },
                node.pills + (Number(washed.cost) || 0),
                node.washes + 1,
                node.exchanges,
                node.steps.concat([
                    actionStepLocks(mask),
                    {
                        op: 'wash',
                        keepIds: mask.slice(),
                        count: 1,
                        cost: Number(washed.cost) || 0,
                        generatedPurples: generatedPurples(
                            adapter, washed, 1
                        ),
                        pityPurples: washed.pityPurpleId == null
                            ? [] : [Number(washed.pityPurpleId)],
                        stopReason: 'decision',
                    },
                ]),
                counters.sequence++
            ));

            let runState = state;
            let runPills = 0;
            let runWashes = 0;
            const runPurples = [];
            const runPities = [];
            while (runWashes < maxRun
                && counters.washes < counters.maxWashes) {
                const result = adapter.wash(runState, mask);
                runState = result.state;
                counters.washes += 1;
                runWashes += 1;
                runPills += Number(result.cost) || 0;
                runPurples.push.apply(
                    runPurples,
                    generatedPurples(adapter, result, runWashes)
                );
                if (result.pityPurpleId != null) {
                    runPities.push({
                        at: runWashes,
                        id: Number(result.pityPurpleId),
                    });
                }
                const maskChanged = targetMaskOf(runState, targets)
                    !== targetMaskOf(state, targets);
                let exchangeReady = false;
                try {
                    exchangeReady = adapter.replaceablePositions(
                        runState, mask
                    ).length > 0;
                } catch (error) {
                    exchangeReady = false;
                }
                if (maskChanged || runPurples.length
                    || runPities.length || exchangeReady
                    || runState.talLucky >= adapter.pityThreshold(runState)) {
                    break;
                }
            }
            if (runWashes) {
                generated.push(makeNode(
                    node,
                    runState,
                    mask,
                    { type: 'wash-run', lockIds: mask.slice() },
                    node.pills + runPills,
                    node.washes + runWashes,
                    node.exchanges,
                    node.steps.concat([
                        actionStepLocks(mask),
                        {
                            op: 'wash',
                            keepIds: mask.slice(),
                            count: runWashes,
                            cost: runPills,
                            generatedPurples: runPurples,
                            pityPurples: runPities,
                            stopReason: 'decision',
                        },
                    ]),
                    counters.sequence++
                ));
            }

            let moves = [];
            try {
                moves = adapter.exchangeMoves(state, mask);
            } catch (error) {
                moves = [];
            }
            for (const move of moves) {
                let replaced;
                try {
                    replaced = adapter.replace(
                        move.state, move.position, mask
                    );
                } catch (error) {
                    continue;
                }
                for (const post of lockMasks(
                    replaced.state.talents,
                    adapter.slotCount(replaced.state)
                )) {
                    generated.push(makeNode(
                        node,
                        replaced.state,
                        post,
                        {
                            type: 'exchange',
                            lockIds: mask.slice(),
                            carrierId: Number(move.carrierId),
                            addedId: Number(replaced.addedId),
                        },
                        node.pills,
                        node.washes,
                        node.exchanges + 1,
                        node.steps.concat([
                            actionStepLocks(mask),
                            {
                                op: 'exchange',
                                carrierId: Number(move.carrierId),
                                lockIds: mask.slice(),
                                removedId: Number(replaced.removedId),
                                addedId: Number(replaced.addedId),
                            },
                            actionStepLocks(post),
                        ]),
                        counters.sequence++
                    ));
                }
            }
        }

        if (Number(state.zizhi) < 154) {
            const upgraded = adapter.upgradeFour(
                Object.assign({}, state, { zizhi: 154 })
            );
            generated.push(makeNode(
                node,
                upgraded,
                node.lockSet,
                { type: 'upgrade' },
                node.pills,
                node.washes,
                node.exchanges,
                node.steps.concat([
                    actionStepLocks(node.lockSet),
                    {
                        op: 'upgrade',
                        fromZizhi: Number(state.zizhi) || 153,
                        toZizhi: 154,
                    },
                ]),
                counters.sequence++
            ));
        }
        return generated;
    }

    function advanceToMaskChange(adapter, targets, start, options) {
        const maxNodes = Math.max(1, Number(options.maxNodes) || 50000);
        const maxWashes = Math.max(
            1, Number(options.maxWashes) || 100000
        );
        const maxOutcomes = Math.max(
            1, Number(options.maxOutcomes) || Number.MAX_SAFE_INTEGER
        );
        const startMask = targetMaskOf(start.state, targets);
        const startKey = stateKeyOf(adapter, start.state, start.lockSet);
        start._engineStateKey = adapter.stateKey(start.state);
        const frontier = [start];
        const seen = new Map([[startKey, start]]);
        const outcomes = [];
        const counters = {
            expanded: 0,
            washes: 0,
            sequence: 1,
            maxWashes,
        };
        const maxExpanded = options.maxExpandedNodes
            ? Math.max(1, Number(options.maxExpandedNodes))
            : Number.MAX_SAFE_INTEGER;

        while (frontier.length
            && outcomes.length < maxOutcomes
            && counters.expanded < maxNodes
            && counters.washes < maxWashes
            && counters.expanded < maxExpanded) {
            frontier.sort((a, b) =>
                targetMaskOf(b.state, targets)
                - targetMaskOf(a.state, targets)
                || nodeCompare(a, b)
            );
            const node = frontier.shift();
            counters.expanded += 1;
            for (const child of enumerateChildren(
                adapter, node, targets, options, counters
            )) {
                child._engineStateKey = adapter.stateKey(child.state);
                const childMask = targetMaskOf(child.state, targets);
                if (childMask !== startMask) {
                    addOutcome(
                        outcomes, child, childMask, startMask, maxOutcomes
                    );
                    if (outcomes.length >= maxOutcomes) break;
                    continue;
                }
                const key = stateKeyOf(adapter, child.state, child.lockSet);
                const prior = seen.get(key);
                if (prior && compareCost(prior, child) <= 0) continue;
                seen.set(key, child);
                frontier.push(child);
            }
        }
        outcomes.sort((a, b) => compareCost(a, b));
        return outcomes;
    }

    function invalidInput(stopReason) {
        return {
            ok: false,
            status: 'invalid-input',
            provenOptimal: false,
            route: null,
            metrics: {},
            stopReason,
        };
    }

    function previewLuckTape(raw, options) {
        if (!raw || !raw.luck_seed_inited) {
            return Object.assign(invalidInput('seed-not-fixed'), {
                startSeed: null,
                items: [],
            });
        }
        const adapter = root.WashSearchV2.createRuleAdapter(raw);
        const engine = adapter.engineForState(adapter.start.state);
        const maxDraws = Math.max(
            0,
            Math.floor(Number(options && options.maxDraws) || 4096)
        );
        let seed = Number(raw.luck_seed);
        const items = [];
        for (let index = 0; index < maxDraws; index++) {
            const [rawId, nextSeed] = engine.draw(seed, true);
            items.push({
                index,
                rawId: Number(rawId),
                nextSeed: Number(nextSeed),
            });
            seed = Number(nextSeed);
        }
        return {
            ok: true,
            startSeed: Number(raw.luck_seed),
            items,
        };
    }

    function previewActions(raw, options) {
        const adapter = root.WashSearchV2.createRuleAdapter(raw);
        const state = adapter.start.state;
        const slots = adapter.slotCount(state);
        const requested = options && Array.isArray(options.lockSets)
            ? options.lockSets.map(sorted)
            : lockMasks(state.talents, slots);
        const actions = [];
        const seen = new Set();
        const add = action => {
            const key = [
                action.type,
                action.carrierId || 0,
                (action.lockIds || []).join(','),
                action.addedId || 0,
            ].join('|');
            if (seen.has(key)) return;
            seen.add(key);
            actions.push(action);
        };

        for (const lockIds of requested) {
            if (lockIds.length >= slots) continue;
            const washed = adapter.wash(state, lockIds);
            add({
                type: 'wash',
                lockIds,
                carrierId: 0,
                addedId: 0,
                cost: Number(washed.cost) || 0,
                washCount: 1,
                exchangeCount: 0,
            });
            let moves = [];
            try {
                moves = adapter.exchangeMoves(state, lockIds);
            } catch (error) {
                moves = [];
            }
            for (const move of moves) {
                try {
                    const replaced = adapter.replace(
                        move.state, move.position, lockIds
                    );
                    add({
                        type: 'exchange',
                        lockIds,
                        carrierId: Number(move.carrierId),
                        addedId: Number(replaced.addedId),
                        cost: 0,
                        washCount: 0,
                        exchangeCount: 1,
                    });
                } catch (error) {
                    continue;
                }
            }
        }
        if (Number(state.zizhi) < 154) {
            add({
                type: 'upgrade',
                lockIds: [],
                carrierId: 0,
                addedId: 0,
                cost: 0,
                washCount: 0,
                exchangeCount: 0,
            });
        }
        return actions;
    }

    function previewAdvance(raw, targetIds, options) {
        if (!raw || !raw.luck_seed_inited) return [];
        const adapter = root.WashSearchV2.createRuleAdapter(raw);
        const targets = uniqueNumbers(targetIds).sort((a, b) => a - b);
        const start = makeNode(
            null,
            adapter.start.state,
            adapter.initialLocks,
            null,
            0,
            0,
            0,
            adapter.start.steps.slice(),
            0
        );
        return advanceToMaskChange(
            adapter, targets, start, options || {}
        );
    }

    function cloneRouteSteps(steps) {
        return (steps || []).map(step => Object.assign({}, step, {
            lockIds: Array.isArray(step.lockIds)
                ? step.lockIds.map(Number) : undefined,
            keepIds: Array.isArray(step.keepIds)
                ? step.keepIds.map(Number) : undefined,
            generatedPurples: Array.isArray(step.generatedPurples)
                ? step.generatedPurples.map(item => Object.assign({}, item))
                : undefined,
            pityPurples: Array.isArray(step.pityPurples)
                ? step.pityPurples.map(item => Object.assign({}, item))
                : undefined,
        }));
    }

    function lockSubsets(ids) {
        const values = uniqueNumbers(ids);
        const result = [];
        for (let bits = 0; bits < (1 << values.length); bits++) {
            const subset = [];
            values.forEach((id, index) => {
                if (bits & (1 << index)) subset.push(id);
            });
            result.push(subset);
        }
        return result.sort((a, b) =>
            a.length - b.length || a.join(',').localeCompare(b.join(','))
        );
    }

    function previousLocksIndex(steps, index) {
        for (let cursor = index - 1; cursor >= 0; cursor--) {
            if (steps[cursor].op === 'locks') return cursor;
        }
        return -1;
    }

    function cloneEngineState(state) {
        return {
            bornSeed: Number(state.bornSeed),
            luckSeed: state.luckSeed == null
                ? null : Number(state.luckSeed),
            bornRC: Number(state.bornRC),
            talLucky: Number(state.talLucky),
            zizhi: Number(state.zizhi),
            talents: (state.talents || []).map(Number),
        };
    }

    function applyIncumbentLocks(adapter, state, locks) {
        const value = uniqueNumbers(locks)
            .filter(id => state.talents.includes(id));
        return {
            state: adapter.prepareLocks(state, value),
            locks: value,
        };
    }

    function buildIncumbentSchedule(raw, steps) {
        const adapter = root.WashSearchV2.createRuleAdapter(raw);
        let state = cloneEngineState(adapter.start.state);
        let locks = adapter.initialLocks.slice();
        const ticks = [];
        const startSteps = adapter.start.steps.slice();
        let startState = cloneEngineState(state);
        let startLocks = locks.slice();
        let exchanges = 0;

        for (const step of steps || []) {
            if (step.op === 'locks') {
                const applied = applyIncumbentLocks(
                    adapter, state, step.lockIds || []
                );
                state = applied.state;
                locks = applied.locks;
                if (ticks.length) {
                    ticks[ticks.length - 1].post.push({
                        type: 'locks',
                        lockIds: locks.slice(),
                    });
                    ticks[ticks.length - 1].state =
                        cloneEngineState(state);
                } else {
                    startSteps.push(actionStepLocks(locks));
                    startState = cloneEngineState(state);
                    startLocks = locks.slice();
                }
                continue;
            }
            if (step.op === 'wash') {
                const keep = uniqueNumbers(step.keepIds || []);
                for (let index = 0;
                    index < Math.max(1, Number(step.count) || 1);
                    index++) {
                    const washed = adapter.wash(state, keep);
                    state = washed.state;
                    ticks.push({
                        state: cloneEngineState(state),
                        post: [],
                        advanceBars: Math.max(
                            0, Number(washed.generatedBars) || 0
                        ),
                    });
                }
                continue;
            }
            if (step.op === 'upgrade') {
                state = adapter.upgradeFour(
                    Object.assign({}, state, { zizhi: 154 })
                );
                if (!ticks.length) {
                    startSteps.push({
                        op: 'upgrade',
                        fromZizhi: Number(step.fromZizhi) || 153,
                        toZizhi: Number(step.toZizhi) || 154,
                    });
                    startState = cloneEngineState(state);
                    startLocks = locks.slice();
                    continue;
                }
                ticks[ticks.length - 1].post.push({
                    type: 'upgrade',
                    fromZizhi: Number(step.fromZizhi) || 153,
                    toZizhi: Number(step.toZizhi) || 154,
                });
                ticks[ticks.length - 1].state =
                    cloneEngineState(state);
                continue;
            }
            if (step.op === 'exchange') {
                const applied = applyIncumbentLocks(
                    adapter, state, step.lockIds || locks
                );
                state = applied.state;
                locks = applied.locks;
                const carrierId = Number(step.carrierId);
                const position = state.talents.indexOf(carrierId);
                if (position < 0) throw new Error('incumbent 置换载体不在场');
                const replaced = adapter.replace(
                    state, position, locks
                );
                if (Number(replaced.addedId) !== Number(step.addedId)) {
                    throw new Error('incumbent 置换结果不一致');
                }
                state = replaced.state;
                locks = locks.filter(id =>
                    state.talents.includes(id)
                );
                if (!ticks.length) {
                    startSteps.push(
                        actionStepLocks(applied.locks),
                        {
                            op: 'exchange',
                            carrierId,
                            lockIds: locks.slice(),
                            removedId: Number(replaced.removedId),
                            addedId: Number(replaced.addedId),
                        }
                    );
                    startState = cloneEngineState(state);
                    startLocks = locks.slice();
                    continue;
                }
                ticks[ticks.length - 1].post.push({
                    type: 'exchange',
                    carrierId,
                    preLocks: applied.locks.slice(),
                    lockIds: locks.slice(),
                    addedId: Number(step.addedId),
                });
                ticks[ticks.length - 1].state =
                    cloneEngineState(state);
                exchanges += 1;
            }
        }
        return {
            adapter,
            ticks,
            exchanges,
            startState,
            startLocks,
            startSteps,
        };
    }

    function applyIncumbentPostActions(adapter, node, postActions) {
        let state = node.state;
        let locks = node.lockSet.slice();
        let steps = node.steps.slice();
        let exchanges = node.exchanges;
        for (const action of postActions || []) {
            if (action.type === 'locks') {
                const applied = applyIncumbentLocks(
                    adapter, state, action.lockIds
                );
                state = applied.state;
                locks = applied.locks;
                steps = steps.concat([actionStepLocks(locks)]);
                continue;
            }
            if (action.type === 'upgrade') {
                state = adapter.upgradeFour(
                    Object.assign({}, state, { zizhi: 154 })
                );
                steps = steps.concat([{
                    op: 'upgrade',
                    fromZizhi: action.fromZizhi,
                    toZizhi: action.toZizhi,
                }]);
                continue;
            }
            if (action.type === 'exchange') {
                const applied = applyIncumbentLocks(
                    adapter, state, action.preLocks
                );
                state = applied.state;
                locks = applied.locks;
                const position = state.talents.indexOf(action.carrierId);
                if (position < 0) return null;
                let replaced;
                try {
                    replaced = adapter.replace(state, position, locks);
                } catch (error) {
                    return null;
                }
                if (Number(replaced.addedId) !== action.addedId) {
                    return null;
                }
                state = replaced.state;
                exchanges += 1;
                steps = steps.concat([{
                    op: 'exchange',
                    carrierId: action.carrierId,
                    lockIds: locks.slice(),
                    removedId: Number(replaced.removedId),
                    addedId: Number(replaced.addedId),
                }]);
                const posted = applyIncumbentLocks(
                    adapter, state, action.lockIds
                );
                state = posted.state;
                locks = posted.locks;
                steps = steps.concat([actionStepLocks(locks)]);
            }
        }
        return { state, locks, steps, exchanges };
    }

    function incumbentDistance(state, guideState) {
        const target = new Set(guideState.talents);
        const overlap = state.talents.filter(id =>
            target.has(Number(id))
        ).length;
        return (4 - overlap) * 100000
            + Math.abs(Number(state.bornRC) - Number(guideState.bornRC))
                * 10
            + Math.abs(
                Number(state.bornSeed) - Number(guideState.bornSeed)
            ) / 1e6;
    }

    function searchNearIncumbent(raw, targets, steps, options) {
        const startedAt = Date.now();
        let schedule;
        try {
            schedule = buildIncumbentSchedule(raw, steps);
        } catch (error) {
            return {
                best: null,
                metrics: {
                    expanded: 0,
                    pruned: 0,
                    hitLimit: false,
                    passMetrics: [],
                    elapsedMs: Date.now() - startedAt,
                    skipped: String(error && error.message || error),
                },
            };
        }
        const adapter = schedule.adapter;
        const suffixWashFloor = new Array(schedule.ticks.length + 1).fill(0);
        for (let index = schedule.ticks.length - 1; index >= 0; index--) {
            const engine = adapter.engineForState(
                schedule.ticks[index].state
            );
            // Safety-only lower bound: every guide tick still performs one
            // wash. This is never used to compare progress efficiency.
            suffixWashFloor[index] = suffixWashFloor[index + 1]
                + Math.max(0, Number(engine.eat) - 1);
        }

        const limits = options.limits || {};
        const maxNodes = Math.max(
            1,
            Math.min(
                Number(options.incumbentMaxNodes) || 500000,
                Number(limits.maxExpandedNodes) || 500000
            )
        );
        const maxRuntimeMs = Math.max(
            1,
            Math.min(
                Number(options.incumbentMaxRuntimeMs) || 300000,
                Number(limits.maxRuntimeMs) || 300000
            )
        );
        const beamWidth = Math.max(
            1, Number(options.incumbentBeamWidth) || 8
        );
        const passCount = Math.max(
            1, Number(options.incumbentPasses) || 2
        );
        let upperBound = replay(raw, targets, steps).pills;
        let best = null;
        let expanded = 0;
        let pruned = 0;
        let hitLimit = false;
        const passMetrics = [];

        for (let pass = 0; pass < passCount; pass++) {
            if (Date.now() - startedAt >= maxRuntimeMs) {
                hitLimit = true;
                break;
            }
            const width = pass === 0 ? 1 : beamWidth;
            const rootStartState = schedule.startState
                || adapter.start.state;
            const rootStartLocks = schedule.startLocks
                || adapter.initialLocks;
            const rootStartSteps = schedule.startSteps
                || adapter.start.steps;
            const rootNode = makeNode(
                null,
                rootStartState,
                rootStartLocks,
                null,
                0,
                0,
                0,
                rootStartSteps.slice(),
                0,
                0
            );
            let frontier = [rootNode];
            let passExpanded = 0;
            let passPruned = 0;
            let passBest = null;
            let passFirst = null;

            for (let tick = 0;
                tick < schedule.ticks.length && frontier.length;
                tick++) {
                if (Date.now() - startedAt >= maxRuntimeMs
                    || expanded >= maxNodes) {
                    hitLimit = true;
                    break;
                }
                const guideTick = schedule.ticks[tick];
                const next = new Map();
                for (const node of frontier) {
                    const slots = adapter.slotCount(node.state);
                    const masks = lockMasks(node.state.talents, slots);
                    for (const mask of masks) {
                        if (expanded >= maxNodes) {
                            hitLimit = true;
                            break;
                        }
                        expanded += 1;
                        passExpanded += 1;
                        const washed = adapter.wash(node.state, mask);
                        const advanceBars = (Number(node.advanceBars) || 0)
                            + Math.max(
                                0, Number(washed.generatedBars) || 0
                            );
                        let child = makeNode(
                            node,
                            washed.state,
                            mask,
                            {
                                type: 'incumbent-wash',
                                lockIds: mask.slice(),
                            },
                            node.pills + (Number(washed.cost) || 0),
                            node.washes + 1,
                            node.exchanges,
                            node.steps.concat([
                                actionStepLocks(mask),
                                {
                                    op: 'wash',
                                    keepIds: mask.slice(),
                                    count: 1,
                                    cost: Number(washed.cost) || 0,
                                    generatedPurples: generatedPurples(
                                        adapter, washed, 1
                                    ),
                                    pityPurples: washed.pityPurpleId == null
                                        ? [] : [Number(washed.pityPurpleId)],
                                    stopReason: 'decision',
                                },
                            ]),
                            node.sequence + 1,
                            advanceBars
                        );
                        const posted = applyIncumbentPostActions(
                            adapter, child, guideTick.post
                        );
                        if (!posted) continue;
                        child = makeNode(
                            child,
                            posted.state,
                            posted.locks,
                            child.action,
                            child.pills,
                            child.washes,
                            posted.exchanges,
                            posted.steps,
                            child.sequence,
                            advanceBars
                        );
                        if (targets.every(id =>
                            child.state.talents.includes(Number(id)))) {
                            if (!passBest
                                || compareCost(child, passBest) < 0) {
                                passBest = child;
                            }
                            if (passFirst == null) {
                                passFirst = child.pills;
                            }
                            if (child.pills < upperBound) {
                                upperBound = child.pills;
                            }
                            continue;
                        }
                        if (child.pills + suffixWashFloor[tick + 1]
                            > upperBound) {
                            pruned += 1;
                            passPruned += 1;
                            continue;
                        }
                        const key = stateKeyOf(
                            adapter, child.state, child.lockSet
                        );
                        const prior = next.get(key);
                        if (!prior || compareCost(child, prior) < 0) {
                            next.set(key, child);
                        }
                    }
                    if (hitLimit) break;
                }
                if (hitLimit) break;
                // Total pills stay the objective. Only after two candidates
                // tie on total cost do we prefer the lower cost per advanced
                // pulse, then the one that advanced more pulses.
                frontier = Array.from(next.values())
                    .sort((a, b) =>
                        incumbentDistance(a.state, guideTick.state)
                            - incumbentDistance(b.state, guideTick.state)
                        || compareCost(a, b)
                        || (advanceUnitCost(a.pills, a.advanceBars)
                            - advanceUnitCost(b.pills, b.advanceBars))
                        || ((Number(b.advanceBars) || 0)
                            - (Number(a.advanceBars) || 0))
                        || (a.sequence - b.sequence)
                    )
                    .slice(0, width);
            }
            passMetrics.push({
                pass,
                beamWidth: width,
                expanded: passExpanded,
                pruned: passPruned,
                firstPills: passFirst,
                bestPills: passBest && passBest.pills,
            });
            if (passBest && (!best
                || compareCost(passBest, best) < 0)) {
                best = passBest;
                upperBound = Math.min(upperBound, passBest.pills);
            }
            if (hitLimit) break;
        }
        return {
            best,
            metrics: {
                expanded,
                pruned,
                hitLimit,
                passMetrics,
                elapsedMs: Date.now() - startedAt,
            },
        };
    }

    function optimizeIncumbent(raw, targets, steps, options) {
        const baseline = replay(raw, targets, steps);
        if (!baseline.ok) throw new Error('初始路线回放失败');
        let current = cloneRouteSteps(steps);
        let currentReplay = baseline;
        let candidates = 0;
        let improvements = 0;
        const maxPasses = Math.max(
            1, Number(options.optimizerPasses) || 2
        );
        const maxCandidates = Math.max(
            1, Number(options.optimizerCandidates) || 5000
        );

        for (let pass = 0;
            pass < maxPasses && candidates < maxCandidates;
            pass++) {
            let improved = false;
            for (let index = 0;
                index < current.length && candidates < maxCandidates;
                index++) {
                const wash = current[index];
                if (wash.op !== 'wash' || !wash.keepIds) continue;
                const originalKeep = sorted(wash.keepIds);
                if (!originalKeep.length || !wash.count) continue;
                const originalCost = Number(wash.cost) || 0;
                if (originalCost <= 0) continue;
                const baseUnit = originalCost / wash.count
                    - 2 * originalKeep.length;
                let best = null;
                for (const subset of lockSubsets(originalKeep)) {
                    const normalized = sorted(subset).join(',');
                    if (normalized === originalKeep.join(',')) continue;
                    candidates += 1;
                    const candidate = cloneRouteSteps(current);
                    const nextWash = candidate[index];
                    nextWash.keepIds = subset.slice();
                    const unitCost = baseUnit + 2 * subset.length;
                    if (unitCost <= 0) continue;
                    nextWash.cost = unitCost * nextWash.count;
                    const lockIndex = previousLocksIndex(candidate, index);
                    if (lockIndex >= 0) {
                        candidate[lockIndex].lockIds = subset.slice();
                    }
                    let replayed;
                    try {
                        replayed = replay(raw, targets, candidate);
                    } catch (error) {
                        continue;
                    }
                    if (!replayed.ok
                        || compareCost(replayed, currentReplay) >= 0) {
                        continue;
                    }
                    if (!best
                        || compareCost(replayed, best.replay) < 0) {
                        best = { steps: candidate, replay: replayed };
                    }
                    if (candidates >= maxCandidates) break;
                }
                if (best) {
                    current = best.steps;
                    currentReplay = best.replay;
                    improvements += 1;
                    improved = true;
                }
            }
            if (!improved) break;
        }
        return {
            ok: true,
            steps: current,
            replay: currentReplay,
            baseline,
            candidates,
            improvements,
        };
    }

    function routeResult(replayed, steps, targets) {
        return {
            pills: replayed.pills,
            washes: replayed.washes,
            exchanges: replayed.exchanges,
            targetIds: targets.slice(),
            finalTalents: replayed.finalTalents,
            steps: steps.slice(),
            finalEngineStateKey: replayed.finalStateKey,
            signature: JSON.stringify(steps),
        };
    }

    function scanRoute(raw, targetIds, steps, options) {
        const o = options || {};
        const startedAt = Date.now();
        const targets = uniqueNumbers(targetIds).sort((a, b) => a - b);
        let replayed;
        try {
            replayed = replay(raw, targets, steps);
        } catch (error) {
            return {
                ok: false,
                status: 'scan-error',
                provenOptimal: false,
                route: null,
                metrics: {
                    replayFailures: 1,
                    totalElapsedMs: Date.now() - startedAt,
                },
                stopReason: String(error && error.message || error),
            };
        }
        if (!replayed.ok) {
            return {
                ok: false,
                status: 'scan-replay-failed',
                provenOptimal: false,
                route: null,
                metrics: {
                    replayFailures: 1,
                    totalElapsedMs: Date.now() - startedAt,
                },
                stopReason: 'replay-failed',
            };
        }
        const budget = Math.max(0, Number(o.budget) || 0);
        if (budget && replayed.pills > budget) {
            return {
                ok: false,
                status: 'resource-limited',
                provenOptimal: false,
                route: null,
                metrics: {
                    replayFailures: 0,
                    totalElapsedMs: Date.now() - startedAt,
                },
                stopReason: 'route-over-budget',
            };
        }
        return {
            ok: true,
            status: 'route-scanned',
            provenOptimal: false,
            route: routeResult(replayed, steps, targets),
            metrics: {
                replayFailures: 0,
                totalElapsedMs: Date.now() - startedAt,
            },
            stopReason: 'route-scanned',
        };
    }

    function limitCap(limits) {
        const values = limits || {};
        for (const name of [
            'maxExpandedNodes',
            'maxWashSteps',
            'maxUniqueStates',
            'maxRuntimeMs',
            'maxLuckDraws',
            'maxExchangeStages',
        ]) {
            if (values[name] != null && Number(values[name]) <= 1) {
                return name;
            }
        }
        return '';
    }

    function optimizeRoutes(raw, targetIds, initialRoutes, options) {
        if (!raw || !raw.luck_seed_inited) {
            return invalidInput('seed-not-fixed');
        }
        const o = options || {};
        const targets = uniqueNumbers(targetIds).sort((a, b) => a - b);
        const startedAt = Date.now();
        const cap = limitCap(o.limits);
        if (cap) {
            return {
                ok: false,
                status: 'resource-limited',
                provenOptimal: false,
                route: null,
                metrics: {
                    initialRouteSource: 'independent-search',
                    initialRouteCount: 0,
                    elapsedMs: Date.now() - startedAt,
                },
                stopReason: cap,
            };
        }

        const foundRoutes = Array.isArray(initialRoutes)
            ? initialRoutes.slice() : [];
        const rankedRoutes = foundRoutes.map((candidate, index) => {
            const steps = candidate && Array.isArray(candidate.steps)
                ? candidate.steps : candidate;
            const measured = candidate && candidate.replay
                ? candidate.replay : candidate || {};
            return {
                candidate,
                index,
                cost: Number(measured.pills)
                    || Number.POSITIVE_INFINITY,
                washes: Number(measured.washes)
                    || Number.POSITIVE_INFINITY,
                exchanges: Number(measured.exchanges)
                    || Number.POSITIVE_INFINITY,
                signature: String(
                    candidate && candidate.signature
                    || JSON.stringify(steps || null)
                ),
            };
        }).sort((a, b) =>
            (a.cost - b.cost)
            || (a.index - b.index)
        );
        const finiteCosts = rankedRoutes
            .map(item => item.cost)
            .filter(value => Number.isFinite(value));
        const costFloor = finiteCosts.length ? finiteCosts[0] : null;
        const selectedRoutes = [];
        const seenSignatures = new Set();
        for (const item of rankedRoutes) {
            if (seenSignatures.has(item.signature)) continue;
            seenSignatures.add(item.signature);
            selectedRoutes.push(item);
            break;
        }

        const metrics = {
            initialRouteSource: 'independent-search',
            initialRoutesFound: foundRoutes.length,
            initialRouteCount: selectedRoutes.length,
            initialRoutesSkipped: foundRoutes.length
                - selectedRoutes.length,
            initialRouteCostFloor: costFloor,
            selectedInitialRouteSignature:
                selectedRoutes[0] && selectedRoutes[0].signature || '',
            selectedInitialPills:
                selectedRoutes[0] && selectedRoutes[0].cost,
            selectedInitialWashes:
                selectedRoutes[0] && selectedRoutes[0].washes,
            selectedInitialExchanges:
                selectedRoutes[0] && selectedRoutes[0].exchanges,
            replayFailures: 0,
            optimizerCandidates: 0,
            optimizerImprovements: 0,
            incumbentSearchExpanded: 0,
            incumbentSearchPruned: 0,
            incumbentSearchImproved: false,
            incumbentSearchElapsedMs: 0,
            localOptimizeElapsedMs: 0,
            initialSearchPills: null,
            incumbentPills: null,
            finalPills: null,
            luckDrawsConsumed: 0,
            checkpointTransitions: 0,
            segmentSearches: 0,
        };
        let best = null;
        for (const selected of selectedRoutes) {
            const candidate = selected.candidate;
            const steps = candidate && Array.isArray(candidate.steps)
                ? candidate.steps : candidate;
            if (!Array.isArray(steps)) {
                metrics.replayFailures += 1;
                continue;
            }
            let optimized;
            try {
                const initialReplay = replay(raw, targets, steps);
                if (metrics.initialSearchPills == null
                    || initialReplay.pills < metrics.initialSearchPills) {
                    metrics.initialSearchPills = initialReplay.pills;
                }
                let workingSteps = steps;
                if (o.incumbentSearch === true) {
                    const nearbyStarted = Date.now();
                    const nearby = searchNearIncumbent(
                        raw, targets, steps, o
                    );
                    metrics.incumbentSearchElapsedMs +=
                        Date.now() - nearbyStarted;
                    metrics.incumbentSearchExpanded +=
                        nearby.metrics.expanded;
                    metrics.incumbentSearchPruned +=
                        nearby.metrics.pruned;
                    if (nearby.best) {
                        let nearbyReplay = null;
                        try {
                            nearbyReplay = replay(
                                raw, targets, nearby.best.steps
                            );
                        } catch (error) {
                            nearbyReplay = null;
                        }
                        if (nearbyReplay
                            && compareCost(nearbyReplay, initialReplay) < 0) {
                            workingSteps = nearby.best.steps;
                            metrics.incumbentSearchImproved = true;
                        }
                    }
                }
                const localOptions = Object.assign({}, o);
                if (metrics.incumbentSearchImproved
                    && localOptions.optimizerCandidates == null) {
                    localOptions.optimizerCandidates = 64;
                }
                const localStarted = Date.now();
                optimized = optimizeIncumbent(
                    raw, targets, workingSteps, localOptions
                );
                metrics.localOptimizeElapsedMs +=
                    Date.now() - localStarted;
            } catch (error) {
                metrics.replayFailures += 1;
                continue;
            }
            metrics.optimizerCandidates += optimized.candidates;
            metrics.optimizerImprovements += optimized.improvements;
            if (metrics.incumbentPills == null
                || optimized.baseline.pills < metrics.incumbentPills) {
                metrics.incumbentPills = optimized.baseline.pills;
            }
            if (!best
                || compareCost(optimized.replay, best.replay) < 0) {
                best = optimized;
            }
        }

        metrics.expandedNodes = metrics.optimizerCandidates;
        const limits = o.limits || {};
        const elapsedMs = Date.now() - startedAt;
        let limitStop = '';
        if (best) {
            const checks = [
                ['maxExpandedNodes', limits.maxExpandedNodes,
                    metrics.expandedNodes],
                ['maxWashSteps', limits.maxWashSteps,
                    best.replay.washes],
                ['maxUniqueStates', limits.maxUniqueStates,
                    metrics.uniqueStates || 1],
                ['maxLuckDraws', limits.maxLuckDraws,
                    best.replay.exchanges],
                ['maxExchangeStages', limits.maxExchangeStages,
                    best.replay.exchanges],
                ['maxRuntimeMs', limits.maxRuntimeMs, elapsedMs],
            ];
            const hit = checks.find(item =>
                item[1] != null && item[2] > Number(item[1])
            );
            if (hit) limitStop = hit[0];
        }
        if (limitStop) {
            metrics.elapsedMs = elapsedMs;
            return {
                ok: false,
                status: 'resource-limited',
                provenOptimal: false,
                route: null,
                metrics,
                stopReason: limitStop,
            };
        }

        const budget = Number(o.budget) || 0;
        if (!best
            || (budget > 0 && best.replay.pills > budget)) {
            metrics.elapsedMs = elapsedMs;
            return {
                ok: false,
                status: best ? 'resource-limited' : 'no-route',
                provenOptimal: false,
                route: null,
                metrics,
                stopReason: best
                    ? 'initial-route-over-budget'
                    : 'no-replayable-initial-route',
            };
        }

        metrics.uniqueStates = 1;
        metrics.simulatedWashes = best.replay.washes;
        metrics.finalPills = best.replay.pills;
        metrics.elapsedMs = elapsedMs;
        metrics.totalElapsedMs = elapsedMs;
        return {
            ok: true,
            status: 'resource-limited',
            provenOptimal: false,
            route: routeResult(best.replay, best.steps, targets),
            metrics,
            stopReason: 'incumbent-optimization',
        };
    }

    async function solve(raw, targetIds, options, hooks) {
        if (!raw || !raw.luck_seed_inited) {
            return invalidInput('seed-not-fixed');
        }
        const o = options || {};
        const targets = uniqueNumbers(targetIds).sort((a, b) => a - b);
        const startedAt = Date.now();
        const cap = limitCap(o.limits);
        if (cap) {
            return {
                ok: false,
                status: 'resource-limited',
                provenOptimal: false,
                route: null,
                metrics: {
                    initializer: typeof o.findInitialRoutes === 'function'
                        ? 'independent-search' : 'internal-v2',
                    initialRouteCount: 0,
                    elapsedMs: Date.now() - startedAt,
                },
                stopReason: cap,
            };
        }
        if (typeof o.findInitialRoutes !== 'function') {
            const result = search(raw, targets, o, hooks);
            result.metrics.totalElapsedMs = Date.now() - startedAt;
            return result;
        }

        let initialRoutes = [];
        let searchError = '';
        let initialSearchElapsedMs = 0;
        try {
            const initialStarted = Date.now();
            const found = await o.findInitialRoutes(
                raw, targets, o, hooks
            );
            initialSearchElapsedMs = Date.now() - initialStarted;
            initialRoutes = Array.isArray(found) ? found : [];
        } catch (error) {
            initialSearchElapsedMs = Date.now() - startedAt;
            searchError = String(error && error.message || error);
        }
        if (!initialRoutes.length) {
            return {
                ok: false,
                status: searchError ? 'search-error' : 'no-route',
                provenOptimal: false,
                route: null,
                metrics: {
                    initializer: 'independent-search',
                    initialRouteCount: 0,
                    searchError,
                    initialSearchElapsedMs,
                    incumbentSearchElapsedMs: 0,
                    localOptimizeElapsedMs: 0,
                    elapsedMs: Date.now() - startedAt,
                    totalElapsedMs: Date.now() - startedAt,
                },
                stopReason: searchError
                    ? 'initial-search-error'
                    : 'initial-search-no-route',
            };
        }
        if (o.limits
            && o.limits.maxRuntimeMs != null
            && Date.now() - startedAt >= Number(o.limits.maxRuntimeMs)) {
            return {
                ok: false,
                status: 'resource-limited',
                provenOptimal: false,
                route: null,
                metrics: {
                    initializer: 'independent-search',
                    initialRouteCount: initialRoutes.length,
                    elapsedMs: Date.now() - startedAt,
                },
                stopReason: 'maxRuntimeMs',
            };
        }

        const optimized = optimizeRoutes(
            raw, targets, initialRoutes, o
        );
        optimized.metrics.initializer = 'independent-search';
        optimized.metrics.initialRouteSource = 'independent-search';
        optimized.metrics.initialSearchElapsedMs = initialSearchElapsedMs;
        optimized.metrics.totalElapsedMs = Date.now() - startedAt;
        return optimized;
    }

    function search(raw, targetIds, options, hooks) {
        if (!raw || !raw.luck_seed_inited) {
            return invalidInput('seed-not-fixed');
        }
        const o = options || {};
        const targets = uniqueNumbers(targetIds).sort((a, b) => a - b);
        const initialStarted = Date.now();
        const initial = root.WashSearchV2.search(raw, targets, {
            budget: Number(o.budget) || 0,
            limits: o.limits || {},
            runtime: o.runtime || {},
        }, hooks);
        const initialSearchElapsedMs = Date.now() - initialStarted;
        if (!initial.route) {
            return {
                ok: false,
                status: initial.status || 'no-route',
                provenOptimal: false,
                route: null,
                metrics: {
                    initializer: 'internal-v2',
                    initialRouteSource: 'internal-v2',
                    initialRouteCount: 0,
                    initialSearch: initial.metrics || null,
                    initialSearchElapsedMs,
                    incumbentSearchElapsedMs: 0,
                    localOptimizeElapsedMs: 0,
                    totalElapsedMs: initialSearchElapsedMs,
                },
                stopReason: initial.stopReason || 'initial-search-no-route',
            };
        }
        const optimized = optimizeRoutes(
            raw, targets, [initial.route], o
        );
        optimized.metrics.initializer = 'internal-v2';
        optimized.metrics.initialRouteSource = 'internal-v2';
        optimized.metrics.initialSearch = initial.metrics || null;
        optimized.metrics.initialSearchElapsedMs = initialSearchElapsedMs;
        optimized.metrics.totalElapsedMs =
            initialSearchElapsedMs
            + Number(optimized.metrics.totalElapsedMs || 0);
        return optimized;
    }

    async function solveSeedCheckpoints(checkpoints, targetIds, options, hooks) {
        const o = options || {};
        const budget = Math.max(0, Number(o.budget) || 0);
        const normalized = (checkpoints || []).map((checkpoint, index) => {
            const raw = checkpoint && (checkpoint.raw
                || checkpoint.checkpointRaw);
            if (!raw) return null;
            return {
                checkpoint,
                index,
                raw,
                source: String(checkpoint.source || 'seed'),
                pills: Math.max(0, Number(checkpoint.pills) || 0),
                washes: Math.max(0, Number(checkpoint.washes) || 0),
                exchanges: Math.max(0, Number(checkpoint.exchanges) || 0),
                steps: Array.isArray(checkpoint.steps)
                    ? checkpoint.steps.slice() : [],
                seedChain: Array.isArray(checkpoint.seedChain)
                    ? checkpoint.seedChain.slice() : [],
            };
        }).filter(Boolean).sort((a, b) =>
            (a.pills - b.pills)
            || (a.washes - b.washes)
            || (a.index - b.index)
        );
        const metrics = {
            seedCheckpointSearches: 0,
            seedCheckpointNodes: normalized.length,
            initialRouteCount: 0,
            initialSearchElapsedMs: 0,
            incumbentSearchElapsedMs: 0,
            localOptimizeElapsedMs: 0,
            totalElapsedMs: 0,
        };
        let best = null;
        let bestTotalPills = 0;
        let lastStopReason = 'no-seed-checkpoints';
        for (const item of normalized) {
            if (!budget || item.pills >= budget) continue;
            const remaining = bestTotalPills > 0
                ? bestTotalPills - item.pills
                : budget - item.pills;
            if (!(remaining > 0)) continue;
            const result = await solve(
                item.raw,
                targetIds,
                Object.assign({}, o, {
                    budget: remaining,
                    seedCheckpoints: null,
                }),
                hooks
            );
            metrics.seedCheckpointSearches++;
            metrics.initialRouteCount += Number(
                result.metrics && result.metrics.initialRouteCount
            ) || 0;
            for (const key of [
                'initialSearchElapsedMs',
                'incumbentSearchElapsedMs',
                'localOptimizeElapsedMs',
                'totalElapsedMs',
            ]) {
                metrics[key] += Number(result.metrics && result.metrics[key]) || 0;
            }
            lastStopReason = result.stopReason || lastStopReason;
            if (!result.ok || !result.route) continue;
            const totalPills = item.pills + Number(result.route.pills || 0);
            const route = Object.assign({}, result.route, {
                pills: totalPills,
                washes: item.washes + Number(result.route.washes || 0),
                exchanges: item.exchanges
                    + Number(result.route.exchanges || 0),
                seedCheckpointIndex: item.index,
                seedCheckpointSource: item.source,
                seedCheckpointPills: item.pills,
                seedCheckpointWashes: item.washes,
                seedCheckpointSteps: item.steps.slice(),
                seedChain: item.seedChain.slice(),
            });
            if (!best || compareCost(route, best) < 0) {
                best = route;
                bestTotalPills = totalPills;
            }
        }
        if (best) {
            return {
                ok: true,
                status: 'seeded-fixed-chain',
                provenOptimal: false,
                route: best,
                metrics,
                stopReason: 'seed-checkpoints-exhausted',
            };
        }
        return {
            ok: false,
            status: 'no-route',
            provenOptimal: false,
            route: null,
            metrics,
            stopReason: lastStopReason,
        };
    }

    function replay(raw, targetIds, steps) {
        return root.WashSearchV2.replay(raw, targetIds, steps);
    }

    function nameOf(id) {
        return root.WashSearchV2.nameOf(id);
    }

    root.WashFixedChain = Object.freeze({
        VERSION,
        compareCost,
        advanceUnitCost,
        dominates,
        previewLuckTape,
        previewActions,
        previewAdvance,
        scanRoute,
        optimizeRoutes,
        solve,
        solveSeedCheckpoints,
        search,
        replay,
        nameOf,
    });
})(typeof window !== 'undefined' ? window : globalThis);
