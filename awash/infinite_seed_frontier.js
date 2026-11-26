// -*- coding: utf-8 -*-
/**
 * 无限置换定种子前沿。
 *
 * 本文件只负责找到可置换锚点、增量推进垫洗并输出种子包。
 * 收尾、倒插和完整路线筛选由 AWash 路线后端负责。
 */
(function (root) {
    'use strict';

    function padPlan(slots, advanceBars, pinCount) {
        const slotCount = Number(slots) === 4 ? 4 : 3;
        const bars = Math.max(0, Math.trunc(Number(advanceBars) || 0));
        const pins = Math.max(0, Math.trunc(Number(pinCount) || 0));
        const steps = [];

        if (slotCount === 3) {
            if (bars > 0) {
                steps.push({ mode: 'free', count: bars, advancePer: 1 });
            }
        } else if (pins === 0) {
            const free = Math.floor(bars / 2);
            if (free > 0) {
                steps.push({ mode: 'free', count: free, advancePer: 2 });
            }
            if (bars % 2) {
                steps.push({ mode: 'locked', count: 1, advancePer: 1 });
            }
        } else if (pins === 1 && bars > 0) {
            steps.push({ mode: 'single', count: bars, advancePer: 1 });
        }

        return { slots: slotCount, advanceBars: bars, pinCount: pins, steps };
    }

    function uniqueIds(values) {
        return Array.from(new Set((values || []).map(Number).filter(id => id > 0)));
    }

    function engineFor(raw, slots) {
        const zi = Number(slots) === 4 ? 154 : 153;
        const zz = root.ZZ_DATA && root.ZZ_DATA[String(zi)];
        if (!zz) throw new Error(`资质表缺失: ${zi}`);
        return new root.WashSourceEngine.Engine(root.TALENT_DATA, raw, {
            slotCount: Number(zz.num_talent) || slots,
            pity: Number(zz.bd_zz) || 0,
            eat: Number(zz.eat_xisui) || 0,
            eligibleZi: zi,
            advancePerDraw: true,
            international: false,
        });
    }

    function positionOf(state, id) {
        return state.talents.map(Number).indexOf(Number(id));
    }

    function positionsOf(state, ids) {
        return uniqueIds(ids)
            .map(id => positionOf(state, id))
            .filter(index => index >= 0)
            .sort((a, b) => a - b);
    }

    function fieldLocks(state, ids) {
        const wanted = new Set(uniqueIds(ids));
        return state.talents
            .map(Number)
            .filter(id => wanted.has(id));
    }

    function nearestOrdinaryBefore(engine, state, carrierId) {
        const carrierPos = positionOf(state, carrierId);
        if (carrierPos < 0) return 0;
        const type = engine.talentType(carrierId);
        for (let index = carrierPos - 1; index >= 0; index--) {
            const id = Number(state.talents[index]);
            if (id > 0 && id !== 251 && engine.quality(id) < 4
                && !engine.isShenmai(id) && engine.talentType(id) === type) {
                return id;
            }
        }
        return 0;
    }

    function isShenmaiId(id) {
        const talentId = Number(id);
        return talentId === 248 || talentId === 249 || talentId === 250;
    }

    function findFieldAnchors(engine, state) {
        const anchors = [];
        state.talents.forEach((carrierId, index) => {
            const id = Number(carrierId);
            if (!(id > 0) || id === 251 || engine.quality(id) !== 4
                || engine.isShenmai(id)) return;
            const conflictId = nearestOrdinaryBefore(engine, state, id);
            if (!conflictId) return;
            if (!engine.replaceablePositions(state, [conflictId]).includes(index)) return;
            anchors.push({
                id,
                no: 0,
                wash: 0,
                conflictId,
                conflictWash: 0,
                fromField: true,
            });
        });
        const shenmai = state.talents
            .map((id, index) => ({ id: Number(id), index }))
            .filter(item => item.id > 0 && isShenmaiId(item.id));
        if (shenmai.length >= 2) {
            for (const carrier of shenmai) {
                const partner = shenmai.find(item => item.id !== carrier.id);
                if (!partner) continue;
                if (!engine.replaceablePositions(
                    state, [partner.id]
                ).includes(carrier.index)) continue;
                anchors.push({
                    id: carrier.id,
                    no: 0,
                    wash: 0,
                    conflictId: partner.id,
                    conflictWash: 0,
                    fromField: true,
                    shenmaiPair: true,
                });
            }
        }
        return anchors;
    }

    function findSequenceAnchors(context, engine, raw, slots, count) {
        if (!root.AWashSequence) {
            throw new Error('AWashSequence 未加载');
        }
        const sequence = root.AWashSequence.readSequence(raw, {
            context,
            zi: Number(slots) === 4 ? 154 : 153,
            count,
        });
        const firstPity = (sequence.seq || []).find(item => item.fromPity);
        const pityWash = firstPity ? Number(firstPity.wash) || Infinity : Infinity;
        const ordinaryAnchors = (sequence.seq || [])
            .filter(item => !item.field && !item.fromPity
                && !item.shenmai && Number(item.id) !== 251
                && Number(item.wash) < pityWash
                && Number(item.conflictId) > 0
                && Number(item.conflictWash) >= 0
                && Number(item.conflictWash) < Number(item.wash))
            .map(item => ({
                id: Number(item.id),
                no: Number(item.no) || 0,
                wash: Number(item.wash) || 0,
                conflictId: Number(item.conflictId) || 0,
                conflictWash: Number(item.conflictWash) || 0,
                fromField: false,
            }));
        const shenmaiAnchors = [];
        let previousShenmai = null;
        for (const item of (sequence.seq || [])) {
            if (!item || item.field || item.fromPity
                || Number(item.wash) >= pityWash
                || Number(item.id) === 251 || !isShenmaiId(item.id)) {
                continue;
            }
            if (previousShenmai
                && previousShenmai.id !== Number(item.id)) {
                shenmaiAnchors.push({
                    id: Number(item.id),
                    no: Number(item.no) || 0,
                    wash: Number(item.wash) || 0,
                    conflictId: previousShenmai.id,
                    conflictWash: previousShenmai.wash,
                    partnerNo: previousShenmai.no,
                    fromField: false,
                    shenmaiPair: true,
                });
            }
            previousShenmai = {
                id: Number(item.id),
                no: Number(item.no) || 0,
                wash: Number(item.wash) || 0,
            };
        }
        const anchors = ordinaryAnchors.concat(shenmaiAnchors);
        const seen = new Set();
        return {
            sequence,
            pityWash,
            anchors: anchors.filter(item => {
                const key = `${item.id}|${item.conflictId}|${item.no}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }),
        };
    }

    function buildNoLockStates(engine, raw, maxWash) {
        const states = [engine.initialState(raw)];
        const costs = [0];
        const steps = [];
        let washes = 0;
        let cost = 0;
        while (washes < maxWash) {
            const before = states[states.length - 1];
            const result = engine.wash(before, []);
            states.push(result.state);
            washes++;
            const washCost = Number(result.cost) || 0;
            cost += washCost;
            costs.push(cost);
            steps.push({ op: 'locks', lockIds: [] });
            steps.push({
                op: 'wash',
                keepIds: [],
                count: 1,
                cost: washCost,
            });
            if (result.pityPurpleId != null) break;
        }
        return { states, costs, steps, washes, cost };
    }

    function prepareAnchor(engine, baseState, anchor, pinTargetIds, slots, maxWash,
        initialWashes, initialCost, initialSteps) {
        const pins = uniqueIds(pinTargetIds);
        if (!(anchor.conflictId > 0) || !(anchor.id > 0)) return null;
        let state = baseState;
        let washes = Math.max(0, Number(initialWashes) || 0);
        let cost = Math.max(0, Number(initialCost) || 0);
        const steps = Array.isArray(initialSteps)
            ? initialSteps.map(step => Object.assign({}, step)) : [];

        if (!state.talents.includes(Number(anchor.conflictId))) return null;
        const conflict = Number(anchor.conflictId);
        steps.push({
            op: 'locks',
            type: 'lockConflict',
            id: conflict,
            forPurple: Number(anchor.id),
            washes,
            cost,
            lockIds: [conflict],
        });
        const keepBase = () => uniqueIds(pins.concat([conflict, Number(anchor.id)]));

        let guard = 0;
        while (!state.talents.includes(Number(anchor.id))
            && guard++ < maxWash) {
            const keepIds = fieldLocks(state, keepBase());
            const result = engine.wash(state, positionsOf(state, keepIds));
            state = result.state;
            washes++;
            const washCost = Number(result.cost) || 0;
            cost += washCost;
            steps.push({
                op: 'wash',
                type: 'chaseAnchor',
                keepIds,
                count: 1,
                cost: washCost,
            });
            if (pins.some(id => (result.generatedEvents || [])
                .some(event => Number(event.id) === id))
                && slots === 3) {
                state = engine.upgradeToFour(state);
                steps.push({ op: 'upgrade', toZizhi: 154 });
            }
            if (result.pityPurpleId != null
                && Number(result.pityPurpleId) !== Number(anchor.id)) {
                return null;
            }
        }
        if (!state.talents.includes(Number(anchor.id))) return null;
        const carrierPos = positionOf(state, anchor.id);
        if (!engine.replaceablePositions(state, uniqueIds(pins.concat([conflict])))
            .includes(carrierPos)) return null;
        return {
            engine,
            state,
            washes,
            cost,
            steps,
            pins,
            conflict,
            carrier: Number(anchor.id),
            slots: state.zizhi >= 154 ? 4 : 3,
        };
    }

    function preparePinnedAnchor(engine, raw, anchor, pinTargetIds, maxWash) {
        const pins = uniqueIds(pinTargetIds);
        if (!pins.length) return null;
        let state = engine.initialState(raw);
        let washes = 0;
        let cost = 0;
        const steps = [];
        const activePins = [];
        let conflictLocked = false;
        const conflict = Number(anchor.conflictId);
        const carrier = Number(anchor.id);
        const conflictWash = Math.max(
            0, Number(anchor.conflictWash) || 0
        );

        const lockPin = id => {
            if (activePins.includes(id) || !state.talents.includes(id)) return;
            activePins.push(id);
            if (state.zizhi < 154) {
                engine = engineFor(
                    Object.assign({}, raw, { zizhi: 154 }),
                    4
                );
                state = engine.upgradeToFour(
                    Object.assign({}, state, { zizhi: 154 })
                );
                steps.push({ op: 'upgrade', toZizhi: 154 });
            }
        };

        for (const id of pins) lockPin(id);
        let guard = 0;
        while (guard++ < maxWash) {
            for (const id of pins) lockPin(id);
            const allPins = pins.every(id => activePins.includes(id));
            if (allPins && !conflictLocked
                && (anchor.fromField || washes >= conflictWash)
                && state.talents.includes(conflict)) {
                conflictLocked = true;
            }
            if (allPins && conflictLocked && state.talents.includes(carrier)) {
                const carrierPos = positionOf(state, carrier);
                if (engine.replaceablePositions(state, activePins.concat([conflict]))
                    .includes(carrierPos)) {
                    return {
                        engine,
                        state,
                        washes,
                        cost,
                        steps,
                        pins: activePins.slice(),
                        conflict,
                        carrier,
                        slots: 4,
                    };
                }
            }
            const locks = activePins.concat(conflictLocked ? [conflict] : []);
            const keepIds = fieldLocks(state, locks);
            const result = engine.wash(state, positionsOf(state, keepIds));
            state = result.state;
            washes++;
            const washCost = Number(result.cost) || 0;
            cost += washCost;
            steps.push({
                op: 'locks',
                lockIds: keepIds,
            });
            steps.push({
                op: 'wash',
                type: 'chasePinnedAnchor',
                keepIds,
                count: 1,
                cost: washCost,
            });
            if (result.pityPurpleId != null
                && Number(result.pityPurpleId) !== carrier) {
                return null;
            }
        }
        return null;
    }

    function choosePadLock(engine, state, usedIds) {
        const used = new Set(uniqueIds(usedIds));
        for (const rawId of state.talents) {
            const id = Number(rawId);
            if (!(id > 0) || used.has(id) || id === 251
                || engine.quality(id) >= 4 || engine.isShenmai(id)) continue;
            return id;
        }
        return 0;
    }

    function incrementPad(engine, parent, mode, usedIds) {
        const state = parent.state;
        const padLock = mode === 'locked'
            ? choosePadLock(engine, state, usedIds) : 0;
        if (mode === 'locked' && !padLock) return null;
        const locks = uniqueIds(usedIds.concat(padLock ? [padLock] : []));
        const keepIds = fieldLocks(state, locks);
        const result = engine.wash(state, positionsOf(state, keepIds));
        const advancePer = mode === 'locked' || mode === 'single'
            ? 1 : (state.zizhi >= 154 ? 2 : 1);
        const washCost = Number(result.cost) || 0;
        return {
            parent,
            state: result.state,
            advanceBars: parent.advanceBars + advancePer,
            washes: parent.washes + 1,
            cost: parent.cost + washCost,
            padLock,
            steps: parent.steps.concat([
                { op: 'locks', lockIds: keepIds },
                {
                    op: 'wash',
                    type: 'pad',
                    mode,
                    advanceBars: advancePer,
                    id: padLock || 0,
                    keepIds,
                    count: 1,
                    cost: washCost,
                },
            ]),
        };
    }

    function flattenPadSteps(node) {
        return node && Array.isArray(node.steps) ? node.steps : [];
    }

    function exchangeOnce(engine, node, prepared, chainCache, chainLimit, metrics,
        reuseOnly) {
        const state = node.state;
        const locks = fieldLocks(
            state,
            uniqueIds(prepared.pins.concat([prepared.conflict]))
        );
        const lockSet = new Set(locks);
        const orderedState = Object.assign({}, state, {
            talents: locks.concat(
                state.talents.filter(id => !lockSet.has(Number(id)))
            ),
        });
        const carrierPos = positionOf(orderedState, prepared.carrier);
        if (carrierPos < 0
            || !engine.replaceablePositions(
                orderedState, locks
            ).includes(carrierPos)) {
            return null;
        }
        const result = engine.replace(orderedState, carrierPos, locks);
        metrics.seedSearches++;
        const seed = Number(result.state.luckSeed);
        let chain = chainCache.get(seed);
        if (!chain) {
            if (reuseOnly) return null;
            chain = [Number(result.addedId)];
            let luck = seed;
            for (let index = 0;
                index < 4000 && chain.length < chainLimit; index++) {
                let id;
                try {
                    [id, luck] = engine.draw(luck, true);
                } catch (error) {
                    break;
                }
                if (engine.allowed.has(Number(id))) chain.push(Number(id));
            }
            chainCache.set(seed, chain);
            metrics.chainBuilds++;
        }
        return {
            seed,
            chain,
            state: result.state,
            step: {
                op: 'exchange',
                carrierId: prepared.carrier,
                removedId: Number(result.removedId) || prepared.carrier,
                addedId: Number(result.addedId),
                lockIds: locks,
            },
            firstExchange: {
                from: prepared.carrier,
                to: Number(result.addedId),
                washes: node.washes,
                cost: node.cost,
            },
        };
    }

    function checkpointRaw(raw, state) {
        return Object.assign({}, raw, {
            zizhi: Number(state.zizhi),
            seed: Number(state.bornSeed),
            luck_seed: Number(state.luckSeed),
            luck_seed_inited: state.luckSeed != null,
            born_talent_rc: Number(state.bornRC),
            tal_lucky: Number(state.talLucky),
            talents: (state.talents || []).map(id => ({
                id: Number(id),
                locked: false,
            })),
        });
    }

    function targetsBeforeAnchor(raw, sequence, anchor, targets) {
        const targetIds = new Set((targets || []).map(Number));
        const available = new Set((raw.talents || [])
            .map(item => Number(item && item.id != null ? item.id : item))
            .filter(id => targetIds.has(id)));
        for (const event of (sequence.seq || [])) {
            const id = Number(event.id);
            if (targetIds.has(id) && !event.field
                && Number(event.wash) < Number(anchor.wash)) {
                available.add(id);
            }
        }
        available.delete(Number(anchor.conflictId));
        available.delete(Number(anchor.id));
        return Array.from(available);
    }

    function anchorSeedKey(anchor, seed) {
        return `${Number(anchor.no) || 0}|${Number(anchor.id) || 0}|` +
            `${Number(anchor.conflictId) || 0}|${Number(seed) || 0}`;
    }

    function appendPinVariants(result, raw, targets, engine, chainCache,
        chainLimit, metrics, nMax, maxWash, emitCandidate) {
        const zero = result.candidates.filter(item => item.pinTargetIds.length === 0);
        const zeroByAnchorSeed = new Map(zero.map(item => [
            anchorSeedKey(item.anchor, item.seed), item,
        ]));
        const addVariant = (packet, zeroPacket) => {
            const emitted = Object.assign({}, packet, {
                seed: zeroPacket.seed,
                chain: zeroPacket.chain,
                variantOfSeed: zeroPacket.seed,
            });
            result.candidates.push(emitted);
            return emitted;
        };

        for (const anchor of result.anchors) {
            const available = targetsBeforeAnchor(raw, result.sequence, anchor, targets);
            for (const targetId of available) {
                const prepared = preparePinnedAnchor(
                    engine, raw, anchor, [targetId], maxWash);
                if (!prepared) continue;
                let node = {
                    parent: null,
                    state: prepared.state,
                    advanceBars: 0,
                    washes: prepared.washes,
                    cost: prepared.cost,
                    steps: [],
                };
                for (let advance = 0; advance <= nMax; advance++) {
                    if (advance > 0) {
                        node = incrementPad(prepared.engine, node, 'single',
                            prepared.pins.concat([prepared.conflict, prepared.carrier]));
                        metrics.padSteps++;
                    }
                    const exchanged = exchangeOnce(
                        prepared.engine, node, prepared, chainCache, chainLimit,
                        metrics, true);
                    if (!exchanged) continue;
                    const zeroPacket = zeroByAnchorSeed.get(
                        anchorSeedKey(anchor, exchanged.seed));
                    if (!zeroPacket) continue;
                    const packet = addVariant({
                        slots: 4,
                        advanceBars: advance,
                        anchor: Object.assign({}, anchor),
                        pinTargetIds: [targetId],
                        padPlan: padPlan(4, advance, 1),
                        padState: node.state,
                        checkpointRaw: checkpointRaw(raw, exchanged.state),
                        checkpointState: exchanged.state,
                        prefixSteps: prepared.steps.concat(
                            flattenPadSteps(node), [exchanged.step]
                        ),
                        prefixWashes: node.washes,
                        prefixCost: node.cost,
                        exchanges: 1,
                        firstExchange: exchanged.firstExchange,
                    }, zeroPacket);
                    const response = emitCandidate(packet);
                    if (response && response.stop) return;
                }
            }

            for (let left = 0; left < available.length; left++) {
                for (let right = left + 1; right < available.length; right++) {
                    const pins = [available[left], available[right]];
                    const prepared = preparePinnedAnchor(
                        engine, raw, anchor, pins, maxWash);
                    if (!prepared) continue;
                    const node = {
                        parent: null,
                        state: prepared.state,
                        advanceBars: 0,
                        washes: prepared.washes,
                        cost: prepared.cost,
                        steps: [],
                    };
                    const exchanged = exchangeOnce(
                        prepared.engine, node, prepared, chainCache, chainLimit,
                        metrics, true);
                    if (!exchanged) continue;
                    const zeroPacket = zeroByAnchorSeed.get(
                        anchorSeedKey(anchor, exchanged.seed));
                    if (!zeroPacket) continue;
                    const packet = addVariant({
                        slots: 4,
                        advanceBars: 0,
                        anchor: Object.assign({}, anchor),
                        pinTargetIds: pins,
                        padPlan: padPlan(4, 0, 2),
                        padState: node.state,
                        checkpointRaw: checkpointRaw(raw, exchanged.state),
                        checkpointState: exchanged.state,
                        prefixSteps: prepared.steps.concat([exchanged.step]),
                        prefixWashes: node.washes,
                        prefixCost: node.cost,
                        exchanges: 1,
                        firstExchange: exchanged.firstExchange,
                    }, zeroPacket);
                    const response = emitCandidate(packet);
                    if (response && response.stop) return;
                }
            }
        }
    }

    function enumerate(rawInput, targets, options) {
        const o = options || {};
        const raw = Object.assign({}, rawInput);
        const slots = Number(raw.zizhi) >= 154 ? 4 : 3;
        const nMax = Math.max(0, Math.min(100, Math.trunc(Number(o.nMax) || 100)));
        const count = Math.max(12, Math.trunc(Number(o.count) || 30));
        const maxWash = Math.max(500, Math.trunc(Number(o.maxWash) || 4000));
        const chainLimit = Math.max(2, Math.min(15, Math.trunc(
            Number(o.chainLimit) || 15)));
        const engine = engineFor(raw, slots);
        const initial = engine.initialState(raw);
        const sequenceInfo = findSequenceAnchors(
            root, engine, Object.assign({}, raw, {
                zizhi: slots === 4 ? 154 : 153,
            }), slots, count);
        const anchors = findFieldAnchors(engine, initial)
            .concat(sequenceInfo.anchors.filter(item =>
                anchorBeforePity(item, sequenceInfo.pityWash)));
        const noLock = buildNoLockStates(engine, Object.assign({}, raw, {
            zizhi: slots === 4 ? 154 : 153,
        }), Math.max(0, Math.min(maxWash, Math.max(
            sequenceInfo.pityWash === Infinity ? 0 : sequenceInfo.pityWash,
            ...sequenceInfo.anchors.map(item => item.conflictWash || 0)
        ))));
        const candidates = [];
        const chainCache = o.chainCache instanceof Map
            ? o.chainCache : new Map();
        const metrics = {
            chainBuilds: 0,
            padSteps: 0,
            replayedPrefixWashes: 0,
            seedSearches: 0,
        };
        let upperBound = Infinity;
        let stopped = false;

        function emitCandidate(packet) {
            let response = null;
            if (typeof o.onSeed === 'function') {
                response = o.onSeed(packet);
                if (response != null) {
                    const value = typeof response === 'number'
                        ? response : Number(response.upperBound);
                    if (Number.isFinite(value) && value >= 0) {
                        upperBound = Math.min(upperBound, value);
                    }
                }
            }
            if (response && response.stop) stopped = true;
            return response;
        }

        for (const anchor of anchors) {
            if (stopped) break;
            const baseState = anchor.fromField
                ? initial
                : noLock.states[Math.min(noLock.states.length - 1,
                    Number(anchor.conflictWash) || 0)];
            const baseIndex = anchor.fromField ? 0 : Math.min(
                noLock.costs.length - 1, Number(anchor.conflictWash) || 0);
            const prepared = prepareAnchor(
                engine, baseState, anchor, [], slots, maxWash,
                anchor.fromField ? 0 : baseIndex,
                anchor.fromField ? 0 : noLock.costs[baseIndex],
                anchor.fromField ? [] : noLock.steps.slice(0, baseIndex * 2));
            if (!prepared) continue;
            const rootNode = {
                parent: null,
                state: prepared.state,
                advanceBars: 0,
                washes: prepared.washes,
                cost: prepared.cost,
                steps: [],
            };
            const nodes = new Map([[0, rootNode]]);
            let even = rootNode;
            for (let advance = 0; advance <= nMax; advance++) {
                if (stopped) break;
                let node = nodes.get(advance);
                if (!node) {
                    if (slots === 4) {
                        const evenBars = advance - 1;
                        const evenNode = nodes.get(evenBars);
                        if (evenNode) {
                            node = incrementPad(engine, evenNode, 'locked',
                                [prepared.conflict, prepared.carrier]);
                        }
                    }
                }
                if (!node) continue;
                const exchanged = exchangeOnce(
                    engine, node, prepared, chainCache, chainLimit, metrics);
                if (exchanged) {
                    const packet = {
                        seed: exchanged.seed,
                        chain: exchanged.chain,
                        slots: prepared.slots,
                        advanceBars: advance,
                        anchor: Object.assign({}, anchor),
                        pinTargetIds: [],
                        padPlan: padPlan(prepared.slots, advance, 0),
                        padState: node.state,
                        checkpointRaw: checkpointRaw(raw, exchanged.state),
                        checkpointState: exchanged.state,
                        prefixSteps: prepared.steps.concat(
                            flattenPadSteps(node), [exchanged.step]
                        ),
                        prefixWashes: node.washes,
                        prefixCost: node.cost,
                        exchanges: 1,
                        firstExchange: exchanged.firstExchange,
                        variantOfSeed: null,
                    };
                    candidates.push(packet);
                    emitCandidate(packet);
                    if (Number.isFinite(upperBound) && node.cost > upperBound) break;
                }

                if (advance >= nMax) break;
                if (slots === 3) {
                    const next = incrementPad(engine, node, 'free',
                        [prepared.conflict, prepared.carrier]);
                    metrics.padSteps++;
                    nodes.set(next.advanceBars, next);
                } else if ((advance & 1) === 0) {
                    const nextEven = incrementPad(engine, node, 'free',
                        [prepared.conflict, prepared.carrier]);
                    metrics.padSteps++;
                    nodes.set(nextEven.advanceBars, nextEven);
                    even = nextEven;
                    if (advance + 1 <= nMax) {
                        const nextOdd = incrementPad(engine, node, 'locked',
                            [prepared.conflict, prepared.carrier]);
                        if (nextOdd) {
                            metrics.padSteps++;
                            nodes.set(nextOdd.advanceBars, nextOdd);
                        }
                    }
                }
            }
        }

        if (!stopped) {
            appendPinVariants(resultForPins(), raw, targets, engine, chainCache,
                chainLimit, metrics, nMax, maxWash, emitCandidate);
        }

        function resultForPins() {
            return {
                candidates,
                anchors,
                sequence: sequenceInfo.sequence,
            };
        }

        return {
            ok: candidates.length > 0,
            slots,
            pityWash: sequenceInfo.pityWash,
            sequence: sequenceInfo.sequence,
            anchors,
            candidates,
            metrics,
            stopped,
        };
    }

    function anchorBeforePity(anchor, pityWash) {
        const limit = Number(pityWash);
        return !(limit > 0) || Number(anchor.wash) < limit;
    }

    const api = Object.freeze({ padPlan, enumerate });
    root.InfiniteSeedFrontier = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
