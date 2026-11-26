#!/usr/bin/env node
'use strict';

const J = require('./jump_seed_search');

function cloneState(state) {
    return Object.assign({}, state, {
        talents: (state.talents || []).slice(),
    });
}

function createRoot(engine, raw, zizhi) {
    const value = Number(zizhi) || 153;
    return {
        state: engine.initialState(
            Object.assign({}, raw, { zizhi: value })
        ),
        wash: 0,
        pills: 0,
        dropCount: 0,
        actions: [],
        naturalPurplesBeforePity: [],
    };
}

function ordinarySameName(engine, state, generatedEvents) {
    const field = new Set((state.talents || []).map(Number));
    const seen = new Set();
    const result = [];
    for (const event of generatedEvents || []) {
        const id = Number(event.id);
        if (!field.has(id) || seen.has(id)) continue;
        if (event.fromPity
            || engine.quality(id) >= 4
            || engine.isShenmai(id)) continue;
        seen.add(id);
        result.push({
            id,
            position: state.talents.indexOf(id),
            name: engine.name(id),
        });
    }
    return result;
}

function seekSameNameEvent(engine, input, options) {
    const o = options || {};
    const maxWashes = Math.max(
        1, Number(o.maxWashes) || 1200
    );
    const node = Object.assign({}, input, {
        state: cloneState(input.state),
        actions: (input.actions || []).slice(),
        naturalPurplesBeforePity:
            (input.naturalPurplesBeforePity || []).slice(),
    });
    for (let step = 0; step < maxWashes; step++) {
        const state = node.state;
        const result = engine.wash(state, []);
        const washed = Object.assign({}, node, {
            state: result.state,
            wash: node.wash + 1,
            pills: node.pills + (Number(result.cost) || 0),
            naturalPurplesBeforePity:
                node.naturalPurplesBeforePity.slice(),
        });
        let sawPity = false;
        for (const event of result.generatedEvents || []) {
            if (event.fromPity) {
                sawPity = true;
                continue;
            }
            if (!sawPity
                && engine.quality(Number(event.id)) === 4) {
                washed.naturalPurplesBeforePity.push({
                    id: Number(event.id),
                    wash: washed.wash,
                });
            }
        }
        if (result.pityPurpleId != null) {
            return {
                status: 'pity',
                node: washed,
                pityId: Number(result.pityPurpleId),
                seed: Number(washed.state.luckSeed),
            };
        }
        const sameName = ordinarySameName(
            engine, state, result.generatedEvents
        );
        if (sameName.length) {
            return {
                status: 'opportunity',
                node,
                control: {
                    state: result.state,
                    cost: Number(result.cost) || 0,
                },
                sameName,
            };
        }
        Object.assign(node, washed);
    }
    return { status: 'limit', node };
}

function enumerateSameNameEvents(engine, input, options) {
    const o = options || {};
    const maxWashes = Math.max(
        1, Number(o.maxWashes) || 1200
    );
    const node = Object.assign({}, input, {
        state: cloneState(input.state),
        naturalPurplesBeforePity:
            (input.naturalPurplesBeforePity || []).slice(),
    });
    const result = [];
    for (let step = 0;
        node.wash < maxWashes && step < maxWashes;
        step++) {
        const state = cloneState(node.state);
        const wash = node.wash;
        const pills = node.pills;
        const naturalBefore =
            node.naturalPurplesBeforePity.slice();
        const control = engine.wash(state, []);
        const sameName = control.pityPurpleId == null
            ? ordinarySameName(
                engine, state, control.generatedEvents
            ) : [];
        for (const candidate of sameName) {
            result.push({
                id: candidate.id,
                name: candidate.name,
                position: candidate.position,
                wash: wash + 1,
                cost: Number(control.cost) || 0,
                stateBefore: state,
                washBefore: wash,
                pillsBefore: pills,
                naturalBefore,
            });
        }
        node.state = control.state;
        node.wash = wash + 1;
        node.pills = pills + (Number(control.cost) || 0);
        for (const event of control.generatedEvents || []) {
            if (!event.fromPity
                && engine.quality(Number(event.id)) === 4) {
                node.naturalPurplesBeforePity.push({
                    id: Number(event.id),
                    wash: node.wash,
                });
            }
        }
        if (control.pityPurpleId != null) break;
    }
    return result;
}

function swallowCandidate(engine, input, candidate) {
    const node = Object.assign({}, input, {
        naturalPurplesBeforePity:
            (candidate.naturalBefore || []).slice(),
    });
    const result = engine.wash(
        candidate.stateBefore,
        [candidate.position]
    );
    return Object.assign({}, node, {
        state: result.state,
        wash: Number(candidate.washBefore) + 1,
        pills: Number(candidate.pillsBefore)
            + (Number(result.cost) || 0),
        dropCount: Number(node.dropCount) + 1,
        phaseId: node.phaseId
            || `${Number(candidate.wash)}:${candidate.id}`,
        actions: (node.actions || []).concat([{
            type: 'swallow',
            id: Number(candidate.id),
            name: candidate.name,
            wash: Number(candidate.wash),
            position: Number(candidate.position),
        }]),
    });
}

function expandSameNameNode(engine, input, options) {
    const o = options || {};
    const node = Object.assign({}, input, {
        state: cloneState(input.state),
        actions: (input.actions || []).slice(),
        naturalPurplesBeforePity:
            (input.naturalPurplesBeforePity || []).slice(),
    });
    const control = engine.wash(node.state, []);
    if (control.pityPurpleId != null) return [];
    const sameName = ordinarySameName(
        engine, node.state, control.generatedEvents
    );
    if (!sameName.length) return [];
    const children = [Object.assign({}, node, {
        state: control.state,
        wash: node.wash + 1,
        pills: node.pills + (Number(control.cost) || 0),
        parentAction: { type: 'no-swallow' },
    })];
    const limit = Math.max(
        1, Number(o.maxActionsPerNode) || sameName.length
    );
    for (const candidate of sameName.slice(0, limit)) {
        const position = node.state.talents.indexOf(
            Number(candidate.id)
        );
        if (position < 0) continue;
        const result = engine.wash(node.state, [position]);
        children.push(Object.assign({}, node, {
            state: result.state,
            wash: node.wash + 1,
            pills: node.pills + (Number(result.cost) || 0),
            dropCount: node.dropCount + 1,
            phaseId: node.phaseId
                || `${node.wash + 1}:${candidate.id}`,
            actions: node.actions.concat([{
                type: 'swallow',
                id: Number(candidate.id),
                name: candidate.name,
                wash: node.wash + 1,
                position,
            }]),
            parentAction: {
                type: 'swallow',
                id: Number(candidate.id),
            },
        }));
    }
    return children;
}

function stateKey(state) {
    return [
        Number(state.zizhi) || 0,
        Number(state.bornSeed) || 0,
        state.luckSeed == null ? '-' : Number(state.luckSeed),
        Number(state.bornRC) || 0,
        Number(state.talLucky) || 0,
        (state.talents || []).map(Number).join(','),
    ].join('|');
}

function makePityWindowOutcome(node, events, pity) {
    if (!pity || pity.index < 3) {
        return {
            status: 'limit',
            node,
            events,
        };
    }
    const after = events.slice(pity.index + 1)
        .filter(event => !event.fromPity);
    if (after.length < 3) {
        return {
            status: 'limit',
            node,
            events,
        };
    }
    const window = events.slice(pity.index - 3, pity.index + 1)
        .concat(after.slice(0, 3));
    return {
        status: 'pity',
        state: pity.state,
        checkpointKey: stateKey(pity.state),
        pityId: Number(window[3].id),
        seed: Number(pity.state.luckSeed),
        washes: pity.wash,
        pills: pity.pills,
        observationWashes: node.wash,
        observationPills: node.pills,
        dropCount: Number(node.dropCount) || 0,
        phaseId: node.phaseId || null,
        actions: node.actions.slice(),
        naturalPurplesBeforePity:
            node.naturalPurplesBeforePity.slice(),
        window,
        windowKey: window.map(event =>
            `${event.fromPity ? 'P' : 'O'}:${event.id}`
        ).join('|'),
    };
}

function analyzeNode(engine, input, options) {
    const o = options || {};
    const maxWashes = Math.max(
        1, Number(o.maxWashes) || 1200
    );
    const node = Object.assign({}, input, {
        state: cloneState(input.state),
        actions: (input.actions || []).slice(),
        naturalPurplesBeforePity:
            (input.naturalPurplesBeforePity || []).slice(),
    });
    const events = [];
    const anchors = [];
    let pityIndex = -1;
    let pityWash = 0;
    let pityPills = 0;
    let pityState = null;
    for (let step = 0;
        node.wash < maxWashes && step < maxWashes;
        step++) {
        const inputState = cloneState(node.state);
        const inputWash = node.wash;
        const inputPills = node.pills;
        const naturalBefore =
            node.naturalPurplesBeforePity.slice();
        const result = engine.wash(node.state, []);
        node.state = result.state;
        node.wash += 1;
        node.pills += Number(result.cost) || 0;
        const sameName = pityIndex < 0
            && result.pityPurpleId == null
            ? ordinarySameName(
                engine, inputState, result.generatedEvents
            ) : [];
        for (const candidate of sameName) {
            anchors.push({
                id: candidate.id,
                name: candidate.name,
                position: candidate.position,
                wash: node.wash,
                cost: Number(result.cost) || 0,
                stateBefore: inputState,
                washBefore: inputWash,
                pillsBefore: inputPills,
                naturalBefore: naturalBefore,
            });
        }
        for (const event of result.generatedEvents || []) {
            const item = {
                id: Number(event.id),
                fromPity: !!event.fromPity,
                wash: node.wash,
            };
            events.push(item);
            if (item.fromPity && pityIndex < 0) {
                pityIndex = events.length - 1;
                pityWash = node.wash;
                pityPills = node.pills;
                pityState = cloneState(node.state);
            } else if (!item.fromPity
                && engine.quality(item.id) === 4
                && pityIndex < 0) {
                node.naturalPurplesBeforePity.push({
                    id: item.id,
                    wash: item.wash,
                });
            }
        }
        if (pityIndex >= 0) {
            const after = events.slice(pityIndex + 1)
                .filter(event => !event.fromPity);
            if (after.length >= 3) break;
        }
    }
    return {
        outcome: makePityWindowOutcome(node, events, {
            index: pityIndex,
            wash: pityWash,
            pills: pityPills,
            state: pityState,
        }),
        anchors,
    };
}

function finishToPityWindow(engine, input, options) {
    return analyzeNode(engine, input, options).outcome;
}

function buildBoundaryChains(input, slots) {
    const step = Math.max(1, Number(slots) || 0);
    const byResult = new Map();
    for (const item of input || []) {
        if (!item || !(Number(item.dropCount) >= 0)) continue;
        const key = [
            Number(item.dropCount),
            String(item.phaseId || ''),
            String(item.windowKey || ''),
            Number(item.pityId) || 0,
            Number(item.seed) || 0,
            String(item.checkpointKey || ''),
        ].join('|');
        const previous = byResult.get(key);
        if (!previous
            || Number(item.pills) < Number(previous.pills)
            || (Number(item.pills) === Number(previous.pills)
                && Number(item.washes) < Number(previous.washes))) {
            byResult.set(key, item);
        }
    }
    const byPhase = new Map();
    for (const item of byResult.values()) {
        const phaseId = String(item.phaseId || '');
        if (!phaseId || Number(item.dropCount) <= 0) continue;
        if (!byPhase.has(phaseId)) byPhase.set(phaseId, []);
        byPhase.get(phaseId).push(item);
    }
    const chains = [];
    for (const [phaseId, items] of byPhase) {
        items.sort((a, b) =>
            Number(a.dropCount) - Number(b.dropCount)
            || Number(a.pills) - Number(b.pills)
            || Number(a.washes) - Number(b.washes)
        );
        const byOffset = new Map();
        for (const item of items) {
            const offset = Number(item.dropCount);
            if (!byOffset.has(offset)) byOffset.set(offset, []);
            byOffset.get(offset).push(item);
        }
        let offset = Number(items[0].dropCount);
        const points = [];
        while (byOffset.has(offset)) {
            points.push(...byOffset.get(offset));
            offset += step;
        }
        if (!points.length) continue;
        chains.push({
            phaseId,
            startOffset: Number(points[0].dropCount),
            step,
            points,
            seeds: Array.from(new Set(points.map(item =>
                Number(item.seed)
            ))),
            minPills: points.reduce((value, item) =>
                Math.min(value, Number(item.pills) || 0),
                Infinity
            ),
        });
    }
    return chains.sort((a, b) =>
        a.startOffset - b.startOffset
        || a.phaseId.localeCompare(b.phaseId)
    );
}

function searchTargetLanding(engine, raw, target, options) {
    const o = options || {};
    const targetWash = Number(target && target.wash);
    const targetPityId = Number(target && target.pityId);
    if (!(targetWash > 1) || !targetPityId) {
        return {
            ok: false,
            stopReason: 'invalid-target',
            actions: [],
        };
    }
    const initial = engine.initialState(raw);
    const zizhi = Number(initial.zizhi);
    const slots = typeof engine.slotCountFor === 'function'
        ? engine.slotCountFor(zizhi)
        : (initial.talents || []).length;
    const threshold = Number(engine.pity != null
        ? engine.pity
        : engine.ruleFor(zizhi).pity);
    const initialTalLucky = Number(initial.talLucky) || 0;
    const targetLocks = Math.max(
        0,
        slots * (targetWash - 1)
            - Math.max(0, threshold - initialTalLucky)
    );
    const beamWidth = Math.max(
        1, Number(o.beamWidth) || 5000
    );
    const maxExpanded = Math.max(
        1, Number(o.maxExpanded) || 2000000
    );
    const maxRuntimeMs = Math.max(
        1, Number(o.maxRuntimeMs) || 300000
    );
    const startedAt = Date.now();
    let frontier = [{
        state: initial,
        locks: 0,
        wash: 0,
        parent: null,
        action: null,
    }];
    const visited = new Set();
    let expanded = 0;
    let solution = null;

    for (let wash = 1;
        wash <= targetWash && !solution
            && expanded < maxExpanded
            && Date.now() - startedAt < maxRuntimeMs;
        wash++) {
        const next = new Map();
        for (const node of frontier) {
            if (expanded >= maxExpanded) break;
            expanded += 1;
            const choices = Array.from(new Set(
                (node.state.talents || []).map(Number)
            )).filter(id => id > 0
                && engine.quality(id) < 4
                && !engine.isShenmai(id))
                .map(id => ({
                    id,
                    position: node.state.talents.indexOf(id),
                }));
            for (const choice of [null].concat(choices)) {
                const locks = node.locks + (choice ? 1 : 0);
                const remaining = targetWash - (wash - 1);
                if (locks > targetLocks) continue;
                if (locks + remaining < targetLocks) continue;
                const result = engine.wash(
                    node.state,
                    choice ? [choice.position] : []
                );
                const child = {
                    state: result.state,
                    locks,
                    wash,
                    parent: node,
                    action: choice ? {
                        wash,
                        type: 'jump',
                        id: choice.id,
                        name: engine.name(choice.id),
                    } : null,
                };
                if (result.pityPurpleId != null) {
                    if (wash === targetWash
                        && Number(result.pityPurpleId)
                            === targetPityId) {
                        solution = child;
                        break;
                    }
                    continue;
                }
                const key = [
                    wash,
                    locks,
                    child.state.bornSeed,
                    child.state.luckSeed == null
                        ? '-' : child.state.luckSeed,
                    child.state.bornRC,
                    child.state.talLucky,
                    // Shortcut: field variants sharing RNG/progress are
                    // collapsed for speed. Restore field when exhaustiveness matters.
                ].join('|');
                if (visited.has(key)) continue;
                visited.add(key);
                next.set(key, child);
            }
            if (solution) break;
        }
        frontier = Array.from(next.values()).slice(0, beamWidth);
    }
    const actions = [];
    let cursor = solution;
    while (cursor && cursor.parent) {
        if (cursor.action) actions.push(cursor.action);
        cursor = cursor.parent;
    }
    actions.reverse();
    return {
        ok: !!solution,
        elapsedMs: Date.now() - startedAt,
        expanded,
        truncated: expanded >= maxExpanded
            || Date.now() - startedAt >= maxRuntimeMs,
        stateMode: 'collapsed-field',
        targetWash,
        targetPityId,
        targetLocks,
        usedLocks: solution ? solution.locks : null,
        seed: solution ? Number(solution.state.luckSeed) : null,
        pityId: solution ? targetPityId : null,
        wash: solution ? solution.wash : null,
        pills: solution
            ? (Number(engine.eat) || 0) * solution.wash
                + solution.locks : null,
        actions,
        state: solution ? solution.state : null,
        checkpointRaw: solution
            ? J.checkpointRaw(raw, solution.state) : null,
    };
}

function discoverBoundaryLandings(raw, options) {
    const o = options || {};
    const context = o.context || require('./context').loadAWash();
    const zizhiList = Array.isArray(o.zizhiList)
        ? o.zizhiList.map(Number) : [153, 154];
    const maxStates = Math.max(
        1, Number(o.maxStates) || 200
    );
    const maxWashes = Math.max(
        1, Number(o.maxWashes) || 1200
    );
    const maxPills = Number(o.upperBoundPills || o.maxPills) > 0
        ? Number(o.upperBoundPills || o.maxPills) : Infinity;
    const startedAt = Date.now();
    const results = new Map();
    const landingSeeds = [];
    const metrics = {
        searchMode: 'boundary-landing',
        expandedStates: 0,
        uniqueNodes: 0,
        effectiveSwallows: 0,
        budgetPruned: 0,
        anchorCandidatesScanned: 0,
        duplicateResults: 0,
        layersExplored: 0,
        queueSorts: 0,
        deduplicatedChildren: 0,
        analysisPasses: 0,
        landingSeeds: 0,
        landingSearches: 0,
        landingByZizhi: {},
        byZizhi: [],
    };
    let truncated = false;

    const requestedZizhi = new Set(zizhiList);
    for (const target of o.landingTargets || []) {
        const zizhi = Number(target.zizhi) || Number(zizhiList[0]);
        if (!requestedZizhi.has(zizhi)) continue;
        metrics.landingSearches += 1;
        metrics.landingByZizhi[zizhi] =
            (metrics.landingByZizhi[zizhi] || 0) + 1;
        const engine = J.engineFor(context, raw, zizhi);
        const searched = searchTargetLanding(
            engine,
            Object.assign({}, raw, { zizhi }),
            target,
            {
                beamWidth: o.landingBeamWidth,
                maxExpanded: o.landingMaxExpanded,
                maxRuntimeMs: o.landingMaxRuntimeMs,
            }
        );
        if (searched.ok && (!Number.isFinite(maxPills)
            || Number(searched.pills) < maxPills)) {
            landingSeeds.push(Object.assign({}, searched, {
                zizhi,
                source: 'landing-search',
            }));
        } else if (searched.ok) {
            metrics.budgetPruned += 1;
            truncated = true;
        }
        truncated = truncated || searched.truncated;
    }
    metrics.landingSeeds = landingSeeds.length;

    for (const zizhi of zizhiList) {
        const slots = Number(
            context.ZZ_DATA[String(zizhi)].num_talent
        );
        const maxDrops = Math.max(
            1,
            Number(o.maxDrops) || slots * 8
        );
        const engine = J.engineFor(context, raw, zizhi);
        const root = createRoot(engine, raw, zizhi);
        let frontier = [root];
        const seen = new Set();
        let processed = 0;
        let ziTruncated = false;
        let ziBudgetPruned = 0;
        const addResult = item => {
            if (!item || item.status !== 'pity') return;
            const key = [
                Number(item.dropCount),
                item.windowKey,
                Number(item.pityId),
                Number(item.seed),
                item.checkpointKey,
            ].join('|');
            const previous = results.get(key);
            if (previous) {
                metrics.duplicateResults += 1;
                if (Number(item.pills) >= Number(previous.pills)
                    && Number(item.washes) >= Number(previous.washes)) {
                    return;
                }
            }
            results.set(key, Object.assign({}, item, {
                zizhi,
                slots,
            }));
        };

        let queuedStates = 0;
        for (let layer = 0;
            frontier.length && layer <= maxDrops
                && processed < maxStates;
            layer++) {
            frontier.sort((a, b) =>
                Number(a.dropCount) - Number(b.dropCount)
                || Number(a.pills) - Number(b.pills)
                || Number(a.wash) - Number(b.wash)
            );
            metrics.layersExplored += 1;
            metrics.queueSorts += 1;
            const next = new Map();
            for (const node of frontier) {
                if (processed >= maxStates) {
                    ziTruncated = true;
                    break;
                }
                const nodeKey = [
                    zizhi,
                    stateKey(node.state),
                    Number(node.dropCount),
                ].join('|');
                if (seen.has(nodeKey)) continue;
                seen.add(nodeKey);
                processed += 1;
                metrics.expandedStates += 1;

                const analysis = analyzeNode(engine, node, {
                    maxWashes,
                });
                metrics.analysisPasses += 1;
                if (analysis.outcome
                    && Number(analysis.outcome.pills) < maxPills) {
                    addResult(analysis.outcome);
                } else if (analysis.outcome) {
                    metrics.budgetPruned += 1;
                    ziBudgetPruned += 1;
                    ziTruncated = true;
                }
                const anchors = analysis.anchors;
                metrics.anchorCandidatesScanned += anchors.length;
                for (const candidate of anchors) {
                    const child = swallowCandidate(
                        engine, node, candidate
                    );
                    if (Number(child.dropCount) > maxDrops) {
                        ziTruncated = true;
                        continue;
                    }
                    if (Number(child.pills) >= maxPills) {
                        metrics.budgetPruned += 1;
                        ziBudgetPruned += 1;
                        ziTruncated = true;
                        continue;
                    }
                    metrics.effectiveSwallows += 1;
                    const childKey = [
                        zizhi,
                        stateKey(child.state),
                        Number(child.dropCount),
                    ].join('|');
                    const previous = next.get(childKey);
                    if (!previous
                        || Number(child.pills) < Number(previous.pills)
                        || (Number(child.pills)
                            === Number(previous.pills)
                            && Number(child.wash)
                                < Number(previous.wash))) {
                        next.set(childKey, child);
                    } else {
                        metrics.deduplicatedChildren += 1;
                    }
                }
            }
            frontier = Array.from(next.values());
            queuedStates = frontier.length;
            if (processed >= maxStates && frontier.length) {
                ziTruncated = true;
            }
        }
        if (frontier.length) {
            ziTruncated = true;
            queuedStates = frontier.length;
        }
        if (processed >= maxStates) {
            ziTruncated = true;
        }
        truncated = truncated || ziTruncated;
        metrics.uniqueNodes += seen.size;
        metrics.byZizhi.push({
            zizhi,
            slots,
            expandedStates: processed,
            queuedStates,
            budgetPruned: ziBudgetPruned,
            truncated: ziTruncated,
        });
    }

    const list = Array.from(results.values());
    const chains = [];
    for (const zizhi of zizhiList) {
        const slots = Number(
            context.ZZ_DATA[String(zizhi)].num_talent
        );
        const ziResults = list.filter(item =>
            Number(item.zizhi) === Number(zizhi)
        );
        for (const chain of buildBoundaryChains(ziResults, slots)) {
            chains.push(Object.assign({ zizhi, slots }, chain));
        }
    }
    metrics.elapsedMs = Date.now() - startedAt;
    metrics.uniqueResults = list.length;
    metrics.uniqueSeeds = new Set(list.map(item =>
        `${item.zizhi}:${item.seed}`
    )).size;
    metrics.minPreludePills = list.reduce((value, item) =>
        Math.min(value, Number(item.pills) || 0),
        Infinity
    );
    return {
        ok: list.length > 0 || landingSeeds.length > 0,
        results: list,
        landingSeeds,
        chains,
        metrics,
        truncated,
    };
}

module.exports = {
    createRoot,
    seekSameNameEvent,
    enumerateSameNameEvents,
    swallowCandidate,
    expandSameNameNode,
    analyzeNode,
    finishToPityWindow,
    buildBoundaryChains,
    searchTargetLanding,
    discoverBoundaryLandings,
};
