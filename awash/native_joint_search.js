#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadAWash } = require('./context');
const U = require('../dev/unified_runner');

const TARGET_QUALITY = 4;

function uniqueIds(values) {
    return Array.from(new Set((values || [])
        .map(Number)
        .filter(id => id > 0)));
}

function positionOf(state, id) {
    return (state.talents || []).map(Number).indexOf(Number(id));
}

function fieldLocks(state, ids) {
    const wanted = new Set(uniqueIds(ids));
    return (state.talents || [])
        .map(Number)
        .filter(id => wanted.has(id));
}

function orderedByLocks(state, lockIds) {
    const locks = fieldLocks(state, lockIds);
    const lockSet = new Set(locks);
    return Object.assign({}, state, {
        talents: locks.concat(
            (state.talents || []).filter(id =>
                !lockSet.has(Number(id))
            )
        ),
    });
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

function talentQuality(context, id) {
    const item = context.TALENT_DATA[String(Number(id))];
    return Number(item && item.pinzhi) || 0;
}

function targetFirstHit(tapeItems, targets) {
    const first = new Map();
    for (const item of tapeItems || []) {
        const id = Number(item.rawId);
        if (!targets.includes(id) || first.has(id)) continue;
        first.set(id, Number(item.index) || 0);
    }
    return first;
}

function lookaheadAllowed(context, engine, seed, maxDraws) {
    const items = [];
    let luck = Number(seed);
    for (let index = 0; index < maxDraws; index++) {
        let id;
        try {
            [id, luck] = engine.draw(luck, true);
        } catch (error) {
            break;
        }
        if (!engine.allowed || !engine.allowed.has(Number(id))) {
            continue;
        }
        if (talentQuality(context, id) !== TARGET_QUALITY) continue;
        items.push({
            index,
            rawId: Number(id),
        });
    }
    return { items };
}

function padBranches(context, packet, targets, options, rootRaw) {
    const o = options || {};
    const maxAdvanceBars = Math.max(
        0,
        Math.trunc(Number(o.maxAdvanceBars) || 200)
    );
    const horizon = Math.max(
        1,
        Math.trunc(Number(o.horizon) || 1000)
    );
    const scoreDraws = Math.max(
        8,
        Math.min(
            horizon,
            Math.trunc(Number(o.scoreDraws) || horizon)
        )
    );
    const anchor = packet.anchor;
    const conflict = Number(anchor.conflictId);
    const carrier = Number(anchor.id);
    const pins = uniqueIds(packet.pinTargetIds);
    const baseSteps = (packet.prefixSteps || []).slice();
    const finalStep = baseSteps[baseSteps.length - 1];
    if (!finalStep || finalStep.op !== 'exchange'
        || Number(finalStep.carrierId) !== carrier) {
        return [];
    }
    baseSteps.pop();

    const startSlots = Number(packet.padState.zizhi) >= 154 ? 4 : 3;
    const slotVariants = [{ slots: startSlots, upgrade: false }];
    if (startSlots === 3) {
        slotVariants.push({ slots: 4, upgrade: true });
    }
    const candidates = [];
    const adapter = context.WashSearchV2.createRuleAdapter(rootRaw);

    for (const variant of slotVariants) {
        let state = packet.padState;
        let washes = Number(packet.prefixWashes) || 0;
        let pills = Number(packet.prefixCost) || 0;
        const steps = baseSteps.map(step => Object.assign({}, step));
        if (variant.upgrade) {
            state = adapter.upgradeFour(Object.assign({}, state, {
                zizhi: 154,
            }));
            steps.push({
                op: 'upgrade',
                fromZizhi: 153,
                toZizhi: 154,
            });
        }

        const keepIds = pins.concat([conflict, carrier]);
        for (let advanceBars = 0;
            advanceBars <= maxAdvanceBars;
            advanceBars++) {
            const exchangeLocks = pins.concat([conflict]);
            const exchangeState = orderedByLocks(state, exchangeLocks);
            const carrierPosition = positionOf(exchangeState, carrier);
            let positions = [];
            try {
                positions = adapter.replaceablePositions(
                    exchangeState,
                    exchangeLocks
                );
            } catch (error) {
                positions = [];
            }
            if (carrierPosition >= 0
                && positions.includes(carrierPosition)) {
                const exchanged = adapter.replace(
                    exchangeState,
                    carrierPosition,
                    exchangeLocks
                );
                const exchangeStep = {
                    op: 'exchange',
                    carrierId: carrier,
                    removedId: Number(exchanged.removedId) || carrier,
                    addedId: Number(exchanged.addedId),
                    lockIds: fieldLocks(exchangeState, exchangeLocks),
                };
                const candidateSteps = steps.concat([
                    exchangeStep,
                ]);
                const candidateRaw = checkpointRaw(
                    rootRaw,
                    exchanged.state
                );
                const lookahead = lookaheadAllowed(
                    context,
                    adapter.engineForState(exchanged.state),
                    exchanged.state.luckSeed,
                    scoreDraws
                );
                const firstHits = targetFirstHit(
                    lookahead.items || [],
                    targets
                );
                const held = targets.filter(id =>
                    exchanged.state.talents.includes(id)
                );
                const missingHits = targets.filter(id =>
                    !held.includes(id) && firstHits.has(id)
                );
                const hitScore = Array.from(firstHits.values())
                    .reduce((sum, index) =>
                        sum + Math.max(0, 200 - Math.min(199, index)),
                    0);
                const score = held.length * 1000
                    + missingHits.length * 500
                    + hitScore
                    - Math.max(0, pills);
                candidates.push({
                    source: 'native-joint-pad',
                    slots: variant.slots,
                    advanceBars,
                    anchor: Object.assign({}, anchor),
                    pinTargetIds: pins.slice(),
                    addedId: Number(exchanged.addedId),
                    heldTargetIds: held,
                    missingTargetHits: missingHits,
                    targetFirstHits: firstHits,
                    state: exchanged.state,
                    raw: candidateRaw,
                    prefixSteps: candidateSteps,
                    prefixPills: pills,
                    prefixWashes: washes,
                    score,
                    lookahead,
                });
            }

            const keep = fieldLocks(state, keepIds);
            const result = adapter.wash(
                state,
                keep
            );
            state = result.state;
            washes += 1;
            pills += Number(result.cost) || 0;
            steps.push({ op: 'locks', lockIds: keep });
            steps.push({
                op: 'wash',
                keepIds: keep,
                count: 1,
                cost: Number(result.cost) || 0,
            });
        }
    }
    return candidates;
}

function chainPool(candidate, enumResult, context, targets, horizon) {
    const futureAnchors = (enumResult.anchors || [])
        .filter(anchor => Number(anchor.wash)
            > Number(candidate.anchor.wash))
        .filter(anchor => !targets.includes(Number(anchor.id)))
        .map(anchor => Number(anchor.id))
        .filter(id => id > 0);
    const tape = (candidate.lookahead.items || [])
        .map(item => Number(item.rawId))
        .filter(id => talentQuality(context, id) === TARGET_QUALITY)
        .filter((id, index, values) => values.indexOf(id) === index)
        .slice(0, Math.max(8, Math.min(32, horizon)));
    return {
        futureAnchors: uniqueIds(futureAnchors),
        tape: uniqueIds(tape),
    };
}

function buildChainHints(candidate, enumResult, context, targets, targetOrder,
    horizon) {
    const pool = chainPool(
        candidate, enumResult, context, targets, horizon
    );
    const field = new Set(candidate.state.talents.map(Number));
    const held = targets.filter(id => field.has(id));
    const missing = (targetOrder.length ? targetOrder : targets)
        .filter(id => !held.includes(id));
    const anchors = pool.futureAnchors.slice();
    const tape = pool.tape.filter(id => !held.includes(id));
    const full = [];
    const tapeAnchored = [];
    let tapeCursor = 0;
    let previousTapeId = targets.includes(Number(candidate.addedId))
        ? 0 : Number(candidate.addedId);
    for (const target of missing) {
        const tapeIndex = tape.indexOf(Number(target), tapeCursor);
        if (tapeIndex < 0) continue;
        for (const intermediate of tape.slice(
            tapeCursor, tapeIndex
        )) {
            if (!previousTapeId
                || previousTapeId === Number(intermediate)
                || held.includes(Number(intermediate))) {
                continue;
            }
            tapeAnchored.push({
                from: previousTapeId,
                to: Number(intermediate),
            });
            previousTapeId = Number(intermediate);
        }
        const source = anchors.find(id =>
            id !== Number(target)
        );
        if (source) {
            tapeAnchored.push({
                from: source,
                to: Number(target),
            });
            const sourceIndex = anchors.indexOf(source);
            if (sourceIndex >= 0) anchors.splice(sourceIndex, 1);
        } else if (previousTapeId) {
            tapeAnchored.push({
                from: previousTapeId,
                to: Number(target),
            });
        }
        previousTapeId = Number(target);
        tapeCursor = tapeIndex + 1;
    }
    for (const target of missing) {
        const tapeIndex = tape.indexOf(Number(target));
        const previous = tapeIndex > 0 ? tape[tapeIndex - 1] : 0;
        if (previous && previous !== Number(target)
            && targets.includes(Number(previous))
            && !field.has(Number(previous))) {
            const source = anchors.find(id =>
                id !== Number(target)
            );
            if (source) {
                full.push({ from: source, to: Number(target) });
                const sourceIndex = anchors.indexOf(source);
                if (sourceIndex >= 0) anchors.splice(sourceIndex, 1);
            }
        } else if (previous && previous !== Number(target)
            && !field.has(Number(previous))) {
            const source = anchors.find(id =>
                id !== Number(previous)
                && id !== Number(target)
            );
            if (source) {
                full.push({ from: source, to: Number(previous) });
                const sourceIndex = anchors.indexOf(source);
                if (sourceIndex >= 0) anchors.splice(sourceIndex, 1);
            } else if (!full.some(item =>
                item.to === Number(previous))) {
                continue;
            }
            full.push({ from: Number(previous), to: Number(target) });
        } else if (previous && previous !== Number(target)) {
            full.push({ from: Number(previous), to: Number(target) });
        } else {
            const source = anchors.find(id =>
                id !== Number(target)
            );
            if (source) {
                full.push({ from: source, to: Number(target) });
                const sourceIndex = anchors.indexOf(source);
                if (sourceIndex >= 0) anchors.splice(sourceIndex, 1);
            }
        }

    }

    const variants = [];
    const add = chain => {
        if (!chain || !chain.length) return;
        const key = chain.map(item =>
            `${Number(item.from)}>${Number(item.to)}`
        ).join(',');
        if (variants.some(item => item.key === key)) return;
        variants.push({ key, chain });
    };
    add(tapeAnchored);
    add(full);
    add(full.slice(1));
    if (!variants.length) {
        const fallbackAnchors = pool.futureAnchors.slice();
        const fallback = [];
        for (const target of missing) {
            const source = fallbackAnchors.shift();
            if (source) {
                fallback.push({
                    from: source,
                    to: Number(target),
                });
            }
        }
        add(fallback);
    }
    return variants;
}

function compactCandidate(candidate) {
    return {
        slots: candidate.slots,
        advanceBars: candidate.advanceBars,
        anchorId: Number(candidate.anchor.id),
        pinTargetIds: (candidate.pinTargetIds || []).slice(),
        addedId: Number(candidate.addedId),
        heldTargetIds: candidate.heldTargetIds.slice(),
        missingTargetHits: candidate.missingTargetHits.slice(),
        targetFirstHits: Object.fromEntries(
            Array.from(candidate.targetFirstHits.entries())
        ),
        lookaheadIds: (candidate.lookahead.items || [])
            .map(item => Number(item.rawId))
            .slice(0, 16),
        prefixPills: candidate.prefixPills,
        prefixWashes: candidate.prefixWashes,
        score: candidate.score,
    };
}

function routeRank(route) {
    return [
        Number(route && route.pills) || 0,
        Number(route && route.washes) || 0,
        Number(route && route.exchanges) || 0,
    ];
}

function routeBeats(left, right) {
    if (!left) return false;
    if (!right) return true;
    const a = routeRank(left);
    const b = routeRank(right);
    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) return a[index] < b[index];
    }
    return false;
}

function materializeCandidateRoute(context, raw, candidate, targets, steps,
    source) {
    let replay;
    try {
        replay = context.WashSearchV2.replay(raw, targets, steps);
    } catch (error) {
        return null;
    }
    if (!replay.ok) return null;
    return {
        replay,
        route: {
            pills: Number(replay.pills) || 0,
            washes: Number(replay.washes) || 0,
            exchanges: Number(replay.exchanges) || 0,
            targetIds: targets.slice(),
            finalTalents: replay.finalTalents || [],
            steps,
            finalEngineStateKey: replay.finalStateKey,
            seed: Number(candidate.raw.luck_seed),
            zizhi: Number(candidate.raw.zizhi),
            seedCheckpointSource: source,
            seedCheckpointPills: candidate.prefixPills,
            seedCheckpointWashes: candidate.prefixWashes,
            seedCheckpointSteps: candidate.prefixSteps.slice(),
            continuationPills: Math.max(
                0,
                (Number(replay.pills) || 0) - candidate.prefixPills
            ),
            continuationWashes: Math.max(
                0,
                (Number(replay.washes) || 0) - candidate.prefixWashes
            ),
        },
    };
}

function lockSets(state) {
    const ids = uniqueIds(state.talents);
    const sets = [];
    for (let bits = 0; bits < (1 << ids.length); bits++) {
        const locks = [];
        for (let index = 0; index < ids.length; index++) {
            if (bits & (1 << index)) locks.push(ids[index]);
        }
        sets.push(locks);
    }
    return sets;
}

function washNode(adapter, node, locks) {
    const keep = fieldLocks(node.state, locks);
    const washed = adapter.wash(node.state, keep);
    return {
        state: washed.state,
        pills: node.pills + (Number(washed.cost) || 0),
        washes: node.washes + 1,
        steps: node.steps.concat([
            { op: 'locks', lockIds: keep },
            {
                op: 'wash',
                keepIds: keep,
                count: 1,
                cost: Number(washed.cost) || 0,
            },
        ]),
    };
}

function exchangeNode(adapter, node, carrier, acquired, wanted) {
    const carrierId = Number(carrier);
    for (const locks of lockSets(node.state)) {
        if (!acquired.every(id => locks.includes(id))) continue;
        if (!locks.includes(carrierId)) continue;
        if (locks.length >= adapter.slotCount(node.state)) continue;
        const ordered = orderedByLocks(node.state, locks);
        const position = ordered.talents.indexOf(carrierId);
        let positions = [];
        try {
            positions = adapter.replaceablePositions(ordered, locks);
        } catch (error) {
            positions = [];
        }
        if (!positions.includes(position)) continue;
        let replaced;
        try {
            replaced = adapter.replace(ordered, position, locks);
        } catch (error) {
            continue;
        }
        if (Number(replaced.addedId) !== Number(wanted)) continue;
        return {
            state: replaced.state,
            pills: node.pills,
            washes: node.washes,
            steps: node.steps.concat([
                { op: 'locks', lockIds: locks },
                {
                    op: 'exchange',
                    carrierId,
                    lockIds: locks,
                    removedId: Number(replaced.removedId),
                    addedId: Number(replaced.addedId),
                },
            ]),
        };
    }
    return null;
}

function scanHoldingUntil(adapter, node, locks, wanted, horizon) {
    let current = node;
    for (let wash = 0; wash < horizon; wash++) {
        if (current.state.talents.includes(Number(wanted))) {
            return current;
        }
        current = washNode(adapter, current, locks);
    }
    return current.state.talents.includes(Number(wanted))
        ? current : null;
}

function scanHoldingUntilType(adapter, node, locks, type, horizon) {
    let current = node;
    for (let wash = 0; wash < horizon; wash++) {
        const engine = adapter.engineForState(current.state);
        if (current.state.talents.some(id =>
            adapter.quality(Number(id)) < 4
            && engine.talentType(Number(id)) === Number(type)
        )) {
            return current;
        }
        current = washNode(adapter, current, locks);
    }
    return null;
}

function scanAnchorWindow(adapter, node, carrier, conflict, acquired,
    wanted, horizon, slots) {
    let current = node;
    for (let wash = 0; wash < horizon; wash++) {
        if (current.state.talents.includes(Number(conflict))) {
            let branch = current;
            for (let gap = 0; gap < slots; gap++) {
                if (branch.state.talents.includes(Number(carrier))) {
                    const exchanged = exchangeNode(
                        adapter,
                        branch,
                        carrier,
                        uniqueIds(acquired.concat([conflict])),
                        wanted
                    );
                    if (exchanged) return exchanged;
                }
                branch = washNode(
                    adapter,
                    branch,
                    acquired.concat(
                        [conflict],
                        branch.state.talents.includes(Number(carrier))
                            ? [carrier] : []
                    )
                );
            }
        }
        const keep = acquired.concat(
            current.state.talents.includes(Number(carrier))
                ? [carrier] : []
        );
        current = washNode(adapter, current, keep);
    }
    return null;
}

function executeChainPlan(adapter, start, chain, targets,
    conflictByCarrier, horizon) {
    let node = start;
    for (let index = 0; index < chain.length; index++) {
        const pair = chain[index];
        const next = chain[index + 1];
        const acquired = targets.filter(id =>
            node.state.talents.includes(id)
        );
        const slots = adapter.slotCount(node.state);
        if (!node.state.talents.includes(Number(pair.from))) {
            const conflict = Number(conflictByCarrier.get(
                Number(pair.from)
            )) || 0;
            if (!conflict) return null;
            node = scanAnchorWindow(
                adapter,
                node,
                pair.from,
                conflict,
                acquired,
                pair.to,
                horizon,
                slots
            );
            if (!node) return null;
            continue;
        }
        if (next && Number(next.from) === Number(pair.to)) {
            const nextConflict = Number(conflictByCarrier.get(
                Number(next.from)
            )) || 0;
            if (nextConflict
                && !node.state.talents.includes(nextConflict)) {
                node = scanHoldingUntil(
                    adapter,
                    node,
                    acquired.concat([pair.from]),
                    nextConflict,
                    horizon
                );
            } else if (!nextConflict) {
                const engine = adapter.engineForState(node.state);
                node = scanHoldingUntilType(
                    adapter,
                    node,
                    acquired.concat([pair.from]),
                    engine.talentType(Number(next.from)),
                    horizon
                );
            }
            if (!node) return null;
        }
        let exchanged = exchangeNode(
            adapter,
            node,
            pair.from,
            acquired,
            pair.to
        );
        if (!exchanged) {
            const conflict = Number(conflictByCarrier.get(
                Number(pair.from)
            )) || 0;
            if (conflict) {
                node = scanAnchorWindow(
                    adapter,
                    node,
                    pair.from,
                    conflict,
                    acquired,
                    pair.to,
                    horizon,
                    slots
                );
                if (!node) return null;
                exchanged = node;
            }
        }
        if (!exchanged) return null;
        node = exchanged;
    }
    return targets.every(id => node.state.talents.includes(id))
        ? node : null;
}

async function searchJoint(rawInput, targetIds, options) {
    const o = options || {};
    const context = o.context || loadAWash();
    const targets = uniqueIds(targetIds);
    if (targets.length !== 3 && targets.length !== 4) {
        throw new Error('联合搜索实验只接受三紫或四紫目标');
    }
    const targetOrder = uniqueIds(o.targetOrder || targets);
    const horizon = Math.max(
        1,
        Math.trunc(Number(o.horizon) || 1000)
    );
    const maxAdvanceBars = Math.max(
        0,
        Math.trunc(Number(o.maxAdvanceBars) || 200)
    );
    const maxSelected = Math.max(
        1,
        Math.trunc(Number(o.maxSelected) || 8)
    );
    const maxRouteSearches = Math.max(
        1,
        Math.trunc(Number(o.maxRouteSearches) || 2)
    );
    const startedAt = Date.now();
    const maxRuntimeMs = Math.max(
        1,
        Number(o.maxRuntimeMs) || 120000
    );
    // WashSearchV2 requires a positive budget. This is an internal resource
    // ceiling before the first route exists, not the shared route bound.
    const initialResourceBudgetPills = Math.max(
        1,
        Number(o.initialResourceBudgetPills) || 1000000
    );
    const raw = Object.assign({}, rawInput);
    const packets = [];
    const packetKeys = new Set();
    const maxBasePackets = Math.max(
        1,
        Math.trunc(Number(o.maxBasePackets) || 8)
    );
    const enumResult = context.InfiniteSeedFrontier.enumerate(
        raw,
        targets,
        {
            nMax: 0,
            count: Math.max(30, Number(o.count) || 30),
            onSeed(packet) {
                if (!packet || Number(packet.advanceBars) !== 0) return;
                const key = [
                    Number(packet.anchor && packet.anchor.id) || 0,
                    Number(packet.seed) || 0,
                    Number(packet.padState && packet.padState.zizhi) || 0,
                    context.WashSourceEngine.stateKey(packet.padState),
                ].join('|');
                if (packetKeys.has(key)) return;
                packetKeys.add(key);
                packets.push(packet);
            },
        }
    );
    const baseByAnchor = new Map();
    for (const packet of packets) {
        const key = [
            Number(packet.anchor && packet.anchor.id) || 0,
            uniqueIds(packet.pinTargetIds).sort((a, b) => a - b)
                .join(','),
        ].join('|');
        const previous = baseByAnchor.get(key);
        if (!previous
            || Number(packet.prefixWashes)
                < Number(previous.prefixWashes)
            || (Number(packet.prefixWashes)
                    === Number(previous.prefixWashes)
                && Number(packet.prefixCost)
                    < Number(previous.prefixCost))) {
            baseByAnchor.set(key, packet);
        }
    }
    packets.length = 0;
    packets.push.apply(
        packets,
        Array.from(baseByAnchor.values())
            .sort((a, b) =>
                Number(a.anchor.wash) - Number(b.anchor.wash)
            )
            .slice(0, maxBasePackets)
    );
    const candidates = [];
    for (const packet of packets) {
        candidates.push.apply(
            candidates,
            padBranches(context, packet, targets, {
                horizon,
                maxAdvanceBars,
            }, raw)
        );
    }
    candidates.sort((a, b) =>
        (b.score - a.score)
        || (a.prefixPills - b.prefixPills)
        || (a.prefixWashes - b.prefixWashes)
    );
    const selected = [];
    const seen = new Set();
    let orderedWinner = null;
    let orderedWinnerScore = Infinity;
    for (const candidate of candidates) {
        let score = 0;
        let complete = true;
        let previousIndex = -1;
        let ordered = true;
        targetOrder.forEach((id, index) => {
            if (!candidate.targetFirstHits.has(id)) {
                complete = false;
                return;
            }
            const hitIndex = candidate.targetFirstHits.get(id);
            if (hitIndex < previousIndex) ordered = false;
            previousIndex = hitIndex;
            score += hitIndex * 100
                + index;
        });
        if (complete
            && ordered
            && candidate.heldTargetIds.length > 0
            && score < orderedWinnerScore) {
            orderedWinner = candidate;
            orderedWinnerScore = score;
        }
    }
    const pinnedWinners = new Map();
    for (const candidate of candidates) {
        const pinKey = (candidate.pinTargetIds || [])
            .map(Number)
            .sort((a, b) => a - b)
            .join(',');
        if (!pinKey) continue;
        const groupKey = `${pinKey}:${candidate.addedId}`;
        const previous = pinnedWinners.get(groupKey);
        if (!previous
            || candidate.score > previous.score
            || (candidate.score === previous.score
                && candidate.prefixPills < previous.prefixPills)) {
            pinnedWinners.set(groupKey, candidate);
        }
    }
    const pinnedRanked = Array.from(pinnedWinners.values())
        .map(candidate => {
            const chain = buildChainHints(
                candidate,
                enumResult,
                context,
                targets,
                targetOrder,
                horizon
            )[0];
            const startsAtSeed = chain
                && chain.chain.length
                && Number(chain.chain[0].from)
                    === Number(candidate.addedId);
            const compact = chain
                ? Math.max(0, chain.chain.length - 2)
                : 8;
            const lookahead = (candidate.lookahead.items || [])
                .map(item => Number(item.rawId));
            const firstMatches = !!(chain
                && chain.chain[0]
                && Number(chain.chain[0].from)
                    === Number(candidate.addedId)
                && Number(chain.chain[0].to)
                    === Number(lookahead[0]));
            const secondMatches = !!(chain
                && chain.chain[1]
                && Number(chain.chain[1].from)
                    === Number(chain.chain[0].to)
                && Number(chain.chain[1].to)
                    === Number(lookahead[1]));
            return {
                candidate,
                rank: candidate.score
                    + (startsAtSeed ? 10000 : 0)
                    + (firstMatches ? 10000 : 0)
                    + (secondMatches ? 10000 : 0)
                    - compact * 100,
            };
        })
        .sort((a, b) =>
            (b.rank - a.rank)
            || (a.candidate.prefixPills
                - b.candidate.prefixPills)
        );
    for (const item of pinnedRanked) {
        if (selected.length >= maxSelected) break;
        const candidate = item.candidate;
        const key = [
            context.WashSourceEngine.stateKey(candidate.state),
            candidate.raw.zizhi,
            candidate.raw.luck_seed,
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(candidate);
    }
    if (orderedWinner) {
        const key = [
            context.WashSourceEngine.stateKey(orderedWinner.state),
            orderedWinner.raw.zizhi,
            orderedWinner.raw.luck_seed,
        ].join('|');
        if (!seen.has(key) && selected.length < maxSelected) {
            seen.add(key);
            selected.push(orderedWinner);
        }
    }
    const bucketSize = Math.max(
        1,
        Math.trunc(Number(o.scoreBucketBars) || 25)
    );
    const bucketWinners = new Map();
    for (const candidate of candidates) {
        const bucket = Math.floor(
            candidate.advanceBars / bucketSize
        );
        if (!bucketWinners.has(bucket)) {
            bucketWinners.set(bucket, candidate);
        }
    }
    for (const candidate of bucketWinners.values()) {
        if (selected.length >= maxSelected) break;
        const key = [
            context.WashSourceEngine.stateKey(candidate.state),
            candidate.raw.zizhi,
            candidate.raw.luck_seed,
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(candidate);
    }
    for (const candidate of candidates) {
        if (selected.length >= maxSelected) break;
        const key = [
            context.WashSourceEngine.stateKey(candidate.state),
            candidate.raw.zizhi,
            candidate.raw.luck_seed,
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(candidate);
    }
    if (o.candidatesOnly) {
        return {
            ok: false,
            status: 'candidates-only',
            stopReason: 'candidates-only',
            route: null,
            replay: null,
            metrics: {
                horizon,
                initialUpperBoundPills: null,
                sharedUpperBoundPills: null,
                candidateCheckpoints: candidates.length,
                selectedCheckpoints: selected.length,
                routeSearches: 0,
                searchElapsedMs: 0,
                elapsedMs: Date.now() - startedAt,
                initialResourceBudgetPills,
                selected: (o.allCandidates
                    ? candidates
                    : selected).map(candidate => Object.assign(
                    compactCandidate(candidate),
                    {
                        chainHints: buildChainHints(
                            candidate,
                            enumResult,
                            context,
                            targets,
                            targetOrder,
                            horizon
                        ),
                    }
                )),
            },
        };
    }

    let sharedUpperBoundPills = 0;
    let best = null;
    let routeSearches = 0;
    let searchElapsedMs = 0;
    const routeResults = [];
    const conflictByCarrier = new Map(
        (enumResult.anchors || []).map(anchor => [
            Number(anchor.id),
            Number(anchor.conflictId) || 0,
        ])
    );
    // The chain planner is cheap and state-directed. Run it across the
    // selected pinned/normal candidates before consuming route-search slots.
    for (const candidate of selected) {
        if (sharedUpperBoundPills > 0
            && candidate.prefixPills >= sharedUpperBoundPills) {
            continue;
        }
        const chains = buildChainHints(
            candidate,
            enumResult,
            context,
            targets,
            targetOrder,
            horizon
        );
        for (const variant of chains.slice(0, 2)) {
            const adapter = context.WashSearchV2.createRuleAdapter(raw);
            const planned = executeChainPlan(
                adapter,
                {
                    state: candidate.state,
                    pills: candidate.prefixPills,
                    washes: candidate.prefixWashes,
                    steps: candidate.prefixSteps.slice(),
                },
                variant.chain,
                targets,
                conflictByCarrier,
                horizon
            );
            if (!planned) continue;
            const materialized = materializeCandidateRoute(
                context,
                raw,
                candidate,
                targets,
                planned.steps,
                'native-chain-plan'
            );
            if (!materialized) continue;
            routeResults.push({
                candidate: compactCandidate(candidate),
                chain: variant.chain,
                searchStopReason: 'chain-plan',
                route: {
                    pills: materialized.route.pills,
                    washes: materialized.route.washes,
                    exchanges: materialized.route.exchanges,
                },
            });
            if (routeBeats(materialized.route, best && best.route)) {
                best = Object.assign(materialized, {
                    candidate,
                    chain: variant.chain,
                    searchMetrics: null,
                    searchStopReason: 'chain-plan',
                });
                sharedUpperBoundPills = materialized.route.pills;
            }
        }
    }
    for (const candidate of selected) {
        if (Date.now() - startedAt >= maxRuntimeMs) break;
        if (sharedUpperBoundPills > 0
            && candidate.prefixPills >= sharedUpperBoundPills) {
            continue;
        }
        if (routeSearches >= maxRouteSearches) break;
        const chains = buildChainHints(
            candidate,
            enumResult,
            context,
            targets,
            targetOrder,
            horizon
        );
        for (const variant of chains.slice(0, 2)) {
            if (routeSearches >= maxRouteSearches) break;
            const remainingMs = Math.max(
                1,
                maxRuntimeMs - (Date.now() - startedAt)
            );
            const budget = sharedUpperBoundPills > 0
                ? Math.max(
                    1,
                    sharedUpperBoundPills - candidate.prefixPills
                )
                : initialResourceBudgetPills;
            const searchStarted = Date.now();
            routeSearches += 1;
            const found = context.WashSearchV2.search(
                candidate.raw,
                targets,
                {
                    budget,
                    targetOrder,
                    earlyTargetIds: targets.filter(id =>
                        !candidate.heldTargetIds.includes(id)
                    ).slice(0, 1),
                    pinnedTargetIds: candidate.heldTargetIds,
                    exchangeChain: variant.chain,
                    stopOnFirstRoute: false,
                    limits: Object.assign({
                        maxExpandedNodes: 100000,
                        maxWashSteps: 500000,
                        maxUniqueStates: 100000,
                        maxRuntimeMs: Math.min(20000, remainingMs),
                    }, o.limits || {}),
                    runtime: Object.assign({
                        beamWidth: 1000,
                        chainBeamWidth: 48,
                        maxDepth: 150,
                        maxRunWashes: 1000,
                        maxPolicyWashes: 200000,
                        maxExchangePads: 64,
                    }, o.runtime || {}),
                }
            );
            searchElapsedMs += Date.now() - searchStarted;
            if (!found || !found.ok || !found.route) continue;
            const steps = candidate.prefixSteps.concat(
                found.route.steps || []
            );
            const materialized = materializeCandidateRoute(
                context,
                raw,
                candidate,
                targets,
                steps,
                'native-joint-pad'
            );
            if (!materialized) continue;
            const { replay, route } = materialized;
            routeResults.push({
                candidate: compactCandidate(candidate),
                chain: variant.chain,
                searchStopReason: found.stopReason,
                searchMetrics: found.metrics,
                route: {
                    pills: route.pills,
                    washes: route.washes,
                    exchanges: route.exchanges,
                },
            });
            if (routeBeats(route, best && best.route)) {
                best = {
                    route,
                    replay,
                    candidate,
                    chain: variant.chain,
                    searchMetrics: found.metrics,
                    searchStopReason: found.stopReason,
                };
                sharedUpperBoundPills = Math.min(
                    sharedUpperBoundPills > 0
                        ? sharedUpperBoundPills
                        : Number.MAX_SAFE_INTEGER,
                    route.pills
                );
            }
            break;
        }
    }

    const elapsedMs = Date.now() - startedAt;
    if (!best) {
        return {
            ok: false,
            status: 'no-route',
            stopReason: 'native-joint-no-route',
            route: null,
            replay: null,
            metrics: {
                horizon,
                initialUpperBoundPills: null,
                sharedUpperBoundPills: null,
                candidateCheckpoints: candidates.length,
                selectedCheckpoints: selected.length,
                routeSearches,
                searchElapsedMs,
                elapsedMs,
                initialResourceBudgetPills,
            },
        };
    }
    return {
        ok: true,
        status: 'route',
        stopReason: 'native-joint-route',
        route: best.route,
        replay: best.replay,
        chain: best.chain,
        metrics: {
            horizon,
            initialUpperBoundPills: null,
            sharedUpperBoundPills,
            candidateCheckpoints: candidates.length,
            selectedCheckpoints: selected.length,
            routeSearches,
            searchElapsedMs,
            elapsedMs,
            initialResourceBudgetPills,
            selected: selected.slice().map(compactCandidate),
            routeResults,
            winningCandidate: compactCandidate(best.candidate),
            winningSearchMetrics: best.searchMetrics,
            winningSearchStopReason: best.searchStopReason,
        },
    };
}

async function main() {
    const args = U.parseArgs(process.argv.slice(2));
    if (!args.save || !args.role || !args.targets) {
        console.log('node AWASH/native_joint_search.js '
            + '--save <快照> --role <角色> '
            + '--targets "紫脉1,紫脉2,紫脉3" [--json]');
        return;
    }
    const context = loadAWash();
    const savePath = U.findSavePath(args.save);
    const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));
    const selected = U.selectRole(
        U.collectRoles(save),
        args.role
    );
    if (!selected) throw new Error(`未找到角色: ${args.role}`);
    const metaPath = path.join(path.dirname(savePath), 'dat.meta.json');
    const meta = fs.existsSync(metaPath)
        ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
    const raw = U.buildRaw(
        save,
        selected.role,
        meta,
        args.vip == null ? 1 : args.vip
    );
    const targets = U.resolveTargets(context, args.targets);
    const result = await searchJoint(raw, targets, {
        context,
        horizon: args.horizon == null ? 1000 : Number(args.horizon),
        maxAdvanceBars: args.maxAdvanceBars == null
            ? 200 : Number(args.maxAdvanceBars),
        maxRuntimeMs: args.maxRuntimeMs == null
            ? 120000 : Number(args.maxRuntimeMs),
    });
    console.log(JSON.stringify(result, null, 2));
}

module.exports = {
    searchJoint,
};

if (require.main === module) {
    main().catch(error => {
        console.error(error && error.stack || error);
        process.exitCode = 1;
    });
}
