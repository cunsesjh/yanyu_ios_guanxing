#!/usr/bin/env node
'use strict';

const { loadAWash } = require('./context');
const { findInitialRoutes } = require('./fixed_chain_initial_route');

function engineFor(context, raw, zizhi) {
    const zz = context.ZZ_DATA[String(zizhi)];
    if (!zz || !zz.num_talent) {
        throw new Error(`资质 ${zizhi} 没有可洗槽位`);
    }
    return new context.WashSourceEngine.Engine(
        context.TALENT_DATA,
        raw,
        {
            slotCount: Number(zz.num_talent),
            pity: Number(zz.bd_zz),
            eat: Number(zz.eat_xisui),
            eligibleZi: zizhi,
            advancePerDraw: true,
            dlcMode: !!raw.dlc_mode,
        }
    );
}

function checkpointRaw(baseRaw, state) {
    return Object.assign({}, baseRaw, {
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

function orderTargetBranches(candidates, targetOrder) {
    const order = Array.from(new Set(
        (targetOrder || []).map(Number)
    ));
    const orderIndex = id => {
        const index = order.indexOf(Number(id));
        return index < 0 ? order.length : index;
    };
    const firstWash = candidate => Math.min(
        Number.POSITIVE_INFINITY,
        ...(candidate.targetEvents || []).map(event =>
            Number(event.wash)
        ).filter(Number.isFinite)
    );
    const vector = candidate => (candidate.keptTargetIds || [])
        .slice()
        .sort((a, b) => orderIndex(a) - orderIndex(b)
            || Number(a) - Number(b))
        .map(orderIndex);
    return (candidates || []).slice().sort((a, b) => {
        const ac = (a.keptTargetIds || []).length;
        const bc = (b.keptTargetIds || []).length;
        if (ac !== bc) return ac - bc;
        const av = vector(a);
        const bv = vector(b);
        for (let index = 0; index < Math.min(av.length, bv.length); index++) {
            if (av[index] !== bv[index]) return av[index] - bv[index];
        }
        return firstWash(a) - firstWash(b)
            || Number(a.preludePills) - Number(b.preludePills)
            || Number(a.preludeWashes) - Number(b.preludeWashes)
            || String(a.branchKey || '').localeCompare(
                String(b.branchKey || '')
            );
    }).map(candidate => Object.assign({}, candidate, {
        keptTargetIds: (candidate.keptTargetIds || [])
            .slice()
            .sort((a, b) => orderIndex(a) - orderIndex(b)
                || Number(a) - Number(b)),
    }));
}

function pickJumpPosition(engine, state, slots, onlyId) {
    const next = engine.wash(state, []).state.talents
        .slice(0, Math.max(0, slots - 1));
    for (let index = 0; index < state.talents.length; index++) {
        const id = Number(state.talents[index]);
        if (onlyId && id !== Number(onlyId)) continue;
        if (next.includes(id)) return index;
    }
    return -1;
}

function runJumpToFirstPity(context, raw, zizhi, jumps, options) {
    const o = options || {};
    const engine = engineFor(context, raw, zizhi);
    const slots = Number(
        context.ZZ_DATA[String(zizhi)].num_talent
    );
    const maxWashes = Math.max(
        1, Number(o.maxWashes) || 6000
    );
    let state = engine.initialState(
        Object.assign({}, raw, { zizhi })
    );
    let washes = 0;
    let cost = 0;
    let done = 0;
    let since = 0;
    let pending = false;
    let activeJumpId = 0;
    const jumpsUsed = [];
    const naturalPurplesBeforePity = [];

    while (washes < maxWashes) {
        if (activeJumpId && o.allowRepeat !== false) {
            const position = state.talents.indexOf(activeJumpId);
            const repeat = pickJumpPosition(
                engine, state, slots, activeJumpId
            );
            if (position >= 0 && repeat >= 0) {
                const result = engine.wash(state, [position]);
                state = result.state;
                washes += 1;
                cost += Number(result.cost) || 0;
                done += 1;
                jumpsUsed.push({
                    ordinal: done,
                    wash: washes,
                    id: activeJumpId,
                    repeated: true,
                });
                continue;
            }
            activeJumpId = 0;
        }
        if (done < jumps
            && (pending || since === (done === 0 ? 7 : slots))) {
            const position = pickJumpPosition(
                engine, state, slots
            );
            if (position >= 0) {
                const jumpedId = Number(state.talents[position]);
                const result = engine.wash(state, [position]);
                state = result.state;
                washes += 1;
                cost += Number(result.cost) || 0;
                done += 1;
                since = 0;
                pending = false;
                activeJumpId = jumpedId;
                jumpsUsed.push({
                    ordinal: done,
                    wash: washes,
                    id: jumpedId,
                });
                continue;
            }
            pending = true;
        }
        const result = engine.wash(state, []);
        state = result.state;
        washes += 1;
        cost += Number(result.cost) || 0;
        since += 1;
        for (const event of result.generatedEvents || []) {
            if (!event.fromPity && engine.quality(Number(event.id)) === 4) {
                naturalPurplesBeforePity.push({
                    wash: washes,
                    id: Number(event.id),
                });
            }
        }
        if (result.pityPurpleId != null) {
            return {
                zizhi,
                slots,
                requestedJumps: jumps,
                actualJumps: done,
                saturated: done < jumps,
                seed: Number(state.luckSeed),
                firstPityId: Number(result.pityPurpleId),
                preludeWashes: washes,
                preludePills: cost,
                state,
                jumpsUsed,
                naturalPurplesBeforePity,
            };
        }
    }
    return null;
}

function cloneJumpState(state) {
    return Object.assign({}, state, {
        talents: (state.talents || []).slice(),
    });
}

function createJumpLandingCursor(context, raw, zizhi, maxJump, options) {
    const o = options || {};
    const engine = engineFor(context, raw, zizhi);
    const slots = Number(
        context.ZZ_DATA[String(zizhi)].num_talent
    );
    const maxWashes = Math.max(
        1, Number(o.maxWashes) || 6000
    );
    let state = engine.initialState(
        Object.assign({}, raw, { zizhi })
    );
    let washes = 0;
    let cost = 0;
    let done = 0;
    let since = 0;
    let pending = false;
    let activeJumpId = 0;
    const jumpsUsed = [];
    const naturalPurplesBeforePity = [];
    const snapshots = new Map();
    const snapshot = () => ({
        jumps: done,
        state: cloneJumpState(state),
        washes,
        cost,
        jumpsUsed: jumpsUsed.map(item => Object.assign({}, item)),
        naturalPurplesBeforePity:
            naturalPurplesBeforePity.map(item =>
                Object.assign({}, item)
            ),
    });
    snapshots.set(0, snapshot());
    function advanceTo(targetJump) {
        const wanted = Math.min(maxJump, Number(targetJump) || 0);
        if (snapshots.has(wanted)) return snapshots.get(wanted);
        while (washes < maxWashes && done < wanted) {
            if (activeJumpId && o.allowRepeat !== false) {
                const position = state.talents.indexOf(activeJumpId);
                const repeat = pickJumpPosition(
                    engine, state, slots, activeJumpId
                );
                if (position >= 0 && repeat >= 0) {
                    const result = engine.wash(state, [position]);
                    state = result.state;
                    washes += 1;
                    cost += Number(result.cost) || 0;
                    done += 1;
                    jumpsUsed.push({
                        ordinal: done,
                        wash: washes,
                        id: activeJumpId,
                        repeated: true,
                    });
                    snapshots.set(done, snapshot());
                    continue;
                }
                activeJumpId = 0;
            }
            if (pending || since === (done === 0 ? 7 : slots)) {
                const position = pickJumpPosition(
                    engine, state, slots
                );
                if (position >= 0) {
                    const jumpedId = Number(state.talents[position]);
                    const result = engine.wash(state, [position]);
                    state = result.state;
                    washes += 1;
                    cost += Number(result.cost) || 0;
                    done += 1;
                    since = 0;
                    pending = false;
                    activeJumpId = jumpedId;
                    jumpsUsed.push({
                        ordinal: done,
                        wash: washes,
                        id: jumpedId,
                    });
                    snapshots.set(done, snapshot());
                    continue;
                }
                pending = true;
            }
            const result = engine.wash(state, []);
            state = result.state;
            washes += 1;
            cost += Number(result.cost) || 0;
            since += 1;
            for (const event of result.generatedEvents || []) {
                if (!event.fromPity
                    && engine.quality(Number(event.id)) === 4) {
                    naturalPurplesBeforePity.push({
                        wash: washes,
                        id: Number(event.id),
                    });
                }
            }
            if (result.pityPurpleId != null) return null;
        }
        return snapshots.get(wanted) || null;
    }

    return {
        engine,
        advanceTo,
        get builtJumps() {
            return done;
        },
        get prefixWashes() {
            return washes;
        },
    };
}

function finishJumpSnapshot(engine, zizhi, snapshot, options) {
    const o = options || {};
    const maxWashes = Math.max(
        1, Number(o.maxWashes) || 6000
    );
    const boundarySpan = Math.max(
        1, Number(o.boundarySpan) || 16
    );
    const boundarySnapshots = [];
    let state = cloneJumpState(snapshot.state);
    let washes = Number(snapshot.washes) || 0;
    let cost = Number(snapshot.cost) || 0;
    const naturalPurplesBeforePity =
        (snapshot.naturalPurplesBeforePity || []).map(item =>
            Object.assign({}, item)
        );
    const rememberBoundary = () => {
        boundarySnapshots.push({
            wash: washes,
            pills: cost,
            state: cloneJumpState(state),
        });
        while (boundarySnapshots.length > boundarySpan + 2) {
            boundarySnapshots.shift();
        }
    };
    rememberBoundary();
    while (washes < maxWashes) {
        const result = engine.wash(state, []);
        state = result.state;
        washes += 1;
        cost += Number(result.cost) || 0;
        rememberBoundary();
        for (const event of result.generatedEvents || []) {
            if (!event.fromPity
                && engine.quality(Number(event.id)) === 4) {
                naturalPurplesBeforePity.push({
                    wash: washes,
                    id: Number(event.id),
                });
            }
        }
        if (result.pityPurpleId != null) {
            return {
                zizhi,
                requestedJumps: Number(snapshot.jumps) || 0,
                actualJumps: (snapshot.jumpsUsed || []).length,
                saturated: false,
                seed: Number(state.luckSeed),
                firstPityId: Number(result.pityPurpleId),
                preludeWashes: washes,
                preludePills: cost,
                state,
                jumpsUsed: (snapshot.jumpsUsed || []).map(item =>
                    Object.assign({}, item)
                ),
                naturalPurplesBeforePity,
                boundarySnapshots,
                _probeWashes: washes,
            };
        }
    }
    return null;
}

function enumerateLongLockSeeds(raw, options) {
    const o = options || {};
    if (raw && raw.luck_seed_inited) {
        throw new Error('跳脉枚举要求 luck_seed_inited=false');
    }
    const context = o.context || loadAWash();
    const zizhi = Number(o.zizhi) >= 150
        ? Number(o.zizhi) : 153;
    const slots = Number(
        context.ZZ_DATA[String(zizhi)].num_talent
    );
    const engine = engineFor(context, raw, zizhi);
    const maxWashes = Math.max(
        1, Number(o.maxWashes) || 6000
    );
    const maxStates = Math.max(
        1, Number(o.maxStates) || 500000
    );
    const maxJump = Math.max(
        slots, Number(o.maxJump) || slots * 60
    );
    const chainLimit = Math.max(
        1, Math.min(64, Math.trunc(Number(o.chainLimit) || 15))
    );
    const chainCache = o.chainCache instanceof Map
        ? o.chainCache : new Map();
    const byLanding = new Map();
    const bestByState = new Map();
    const startedAt = Date.now();
    const metrics = {
        expanded: 0,
        generated: 0,
        truncated: false,
        longLockWashes: 0,
        repeatedJumps: 0,
        landingSeeds: 0,
        elapsedMs: 0,
        chainBuilds: 0,
        chainCacheHits: 0,
    };
    const stateKey = (state, activeId) => [
        state.zizhi,
        state.bornSeed,
        state.luckSeed == null ? '-' : state.luckSeed,
        state.bornRC,
        state.talLucky,
        state.talents.join(','),
        activeId || 0,
    ].join('|');
    const remember = node => {
        const key = stateKey(node.state, node.activeId);
        const previous = bestByState.get(key);
        if (previous && previous.pills <= node.pills) return false;
        bestByState.set(key, node);
        return true;
    };
    const initialHeldIds = Array.from(new Set(
        (o.initialHeldIds || []).map(Number)
    )).filter(id => id > 0);
    const initialHeldId = initialHeldIds[0] || 0;
    let initial = engine.initialState(
        Object.assign({}, raw, { zizhi })
    );
    if (initialHeldId
        && initial.talents.includes(initialHeldId)) {
        initial = Object.assign({}, initial, {
            talents: [initialHeldId].concat(
                initial.talents.filter(id =>
                    Number(id) !== initialHeldId)
            ),
        });
    }
    let frontier = [{
        state: initial,
        wash: 0,
        pills: 0,
        jumps: 0,
        repeated: 0,
        activeId: initialHeldId,
        parent: null,
        action: null,
    }];
    remember(frontier[0]);

    const scan = state => {
        const measured = engine.wash(state, []);
        const next = measured.state.talents.slice(
            0, Math.max(0, slots - 1)
        );
        const candidates = [];
        for (let position = 0;
            position < state.talents.length;
            position++) {
            const id = Number(state.talents[position]);
            if (next.includes(id)) {
                candidates.push({ position, id });
            }
        }
        return { measured, candidates };
    };

    const makeChain = seed => {
        const cacheKey = `${zizhi}:${Number(seed)}`;
        const cached = chainCache.get(cacheKey);
        if (cached) {
            metrics.chainCacheHits += 1;
            return cached.slice();
        }
        const chain = [];
        let luck = Number(seed);
        for (let index = 0;
            index < 4000 && chain.length < chainLimit;
            index++) {
            let draw;
            try {
                draw = engine.draw(luck, true);
            } catch (error) {
                break;
            }
            luck = Number(draw[1]);
            const id = Number(draw[0]);
            if (engine.allowed.has(id)) chain.push(id);
        }
        chainCache.set(cacheKey, chain);
        metrics.chainBuilds += 1;
        return chain.slice();
    };
    const record = (node, result) => {
        if (result.pityPurpleId == null) return;
        const key = [
            Number(result.pityPurpleId),
            node.wash,
            Number(node.state.luckSeed),
        ].join('|');
        const actions = [];
        let cursor = node;
        while (cursor && cursor.parent) {
            if (cursor.action) actions.push(
                Object.assign({}, cursor.action)
            );
            cursor = cursor.parent;
        }
        actions.reverse();
        const previous = byLanding.get(key);
        const item = {
            zizhi,
            seed: Number(node.state.luckSeed),
            firstPityId: Number(result.pityPurpleId),
            preludeWashes: node.wash,
            preludePills: node.pills,
            state: node.state,
            actions,
            jumpsUsed: actions.filter(action =>
                !action.longLock
            ).map(action => Object.assign({}, action)),
            jumpsTo: [node.jumps],
            actualJumps: node.jumps,
            repeatedJumps: node.repeated,
        };
        if (!previous
            || item.preludePills < previous.preludePills
            || (item.preludePills === previous.preludePills
                && item.preludeWashes < previous.preludeWashes)) {
            byLanding.set(key, item);
        }
    };
    while (frontier.length && metrics.expanded < maxStates) {
        const next = [];
        for (const node of frontier) {
            if (node.wash >= maxWashes) continue;
            metrics.expanded += 1;
            const measured = scan(node.state);
            const activePosition = node.activeId
                ? node.state.talents.indexOf(
                    Number(node.activeId)) : -1;
            const activeCandidate = node.activeId
                ? measured.candidates.find(item =>
                    item.id === Number(node.activeId)) : null;
            const issue = (result, candidate, repeated, lockId) => {
                const child = {
                    state: result.state,
                    wash: node.wash + 1,
                    pills: node.pills
                        + (Number(result.cost) || 0),
                    jumps: node.jumps + (candidate ? 1 : 0),
                    repeated: node.repeated + (repeated ? 1 : 0),
                    activeId: candidate
                        ? Number(candidate.id)
                        : Number(lockId) || 0,
                    parent: node,
                    action: candidate
                        ? {
                            wash: node.wash + 1,
                            id: Number(candidate.id),
                            repeated: !!repeated,
                        }
                        : lockId
                            ? {
                                wash: node.wash + 1,
                                id: Number(lockId),
                                longLock: true,
                            }
                            : null,
                };
                metrics.generated += 1;
                if (result.pityPurpleId == null
                    && child.jumps <= maxJump
                    && remember(child)) {
                    next.push(child);
                }
                record(child, result);
            };

            if (activeCandidate) {
                const repeated = engine.wash(
                    node.state, [activeCandidate.position]
                );
                metrics.repeatedJumps += 1;
                issue(repeated, activeCandidate, true, 0);
            }
            if (node.activeId && activePosition >= 0) {
                const locked = engine.wash(
                    node.state, [activePosition]
                );
                metrics.longLockWashes += 1;
                issue(locked, null, false, node.activeId);
            }
            if (node.activeId) {
                node.activeId = 0;
                const clearKey = stateKey(node.state, 0);
                if (!bestByState.has(clearKey)) {
                    bestByState.set(clearKey, node);
                }
            }
            const unlocked = scan(node.state);
            if (unlocked.measured.pityPurpleId == null) {
                issue(unlocked.measured, null, false, 0);
            } else {
                const normal = {
                    state: unlocked.measured.state,
                    wash: node.wash + 1,
                    pills: node.pills
                        + (Number(unlocked.measured.cost) || 0),
                    jumps: node.jumps,
                    repeated: node.repeated,
                    activeId: 0,
                    parent: node,
                    action: null,
                };
                record(normal, unlocked.measured);
            }
            for (const candidate of unlocked.candidates) {
                const jumped = engine.wash(
                    node.state, [candidate.position]
                );
                issue(jumped, candidate, false, 0);
            }
        }
        frontier = next;
    }
    const seeds = Array.from(byLanding.values())
        .map(item => {
            const chain = makeChain(item.seed);
            return Object.assign({}, item, {
                checkpointRaw: checkpointRaw(raw, item.state),
                chain,
                chainCacheKey: `${zizhi}:${item.seed}`,
            });
        })
        .sort((a, b) =>
            a.preludePills - b.preludePills
            || a.preludeWashes - b.preludeWashes
            || a.seed - b.seed
        );
    metrics.landingSeeds = seeds.length;
    metrics.elapsedMs = Date.now() - startedAt;
    metrics.truncated = metrics.expanded >= maxStates;
    metrics.uniqueStates = bestByState.size;
    return {
        zizhi,
        slots,
        maxJump,
        maxUsefulJump: seeds.reduce(
            (value, seed) => Math.max(value, seed.actualJumps),
            -1
        ),
        seeds,
        metrics,
    };
}

function enumerateJumpSeeds(raw, options) {
    const o = options || {};
    if (o.allowLongLock) {
        return enumerateLongLockSeeds(raw, o);
    }
    if (raw && raw.luck_seed_inited) {
        throw new Error('跳脉枚举要求 luck_seed_inited=false');
    }
    const context = o.context || loadAWash();
    const zizhi = Number(o.zizhi) >= 150
        ? Number(o.zizhi) : 153;
    const slots = Number(context.ZZ_DATA[String(zizhi)].num_talent);
    const maxJump = Math.max(
        slots, Number(o.maxJump) || slots * 60
    );
    const chainLimit = Math.max(
        1, Math.min(64, Math.trunc(Number(o.chainLimit) || 15))
    );
    const chainCache = o.chainCache instanceof Map
        ? o.chainCache : new Map();
    const bySeed = new Map();
    const seeds = [];
    let maxUsefulJump = -1;
    const metrics = {
        jumpProbes: 0,
        skippedLandingProbes: 0,
        prefixBuilds: 0,
        prefixWashes: 0,
        fullProbeWashes: 0,
        replayedPrefixWashes: 0,
        probedJumps: [],
        chainBuilds: 0,
        chainCacheHits: 0,
    };
    const landing = createJumpLandingCursor(
        context, raw, zizhi, maxJump, o
    );
    metrics.prefixBuilds = 1;
    const probe = jumps => {
        metrics.jumpProbes++;
        metrics.probedJumps.push(jumps);
        const snapshot = landing.advanceTo(jumps);
        if (!snapshot) return null;
        const result = finishJumpSnapshot(
            landing.engine, zizhi, snapshot, o
        );
        if (result) {
            metrics.fullProbeWashes += Number(
                result._probeWashes
            ) || 0;
            delete result._probeWashes;
            result.slots = slots;
        }
        return result;
    };
    const addResult = (jumps, result) => {
        const key = String(result.seed);
        const previous = bySeed.get(key);
        if (previous) return previous;
        const cacheKey = `${zizhi}:${Number(result.seed)}`;
        let chain = chainCache.get(cacheKey);
        if (chain) {
            metrics.chainCacheHits += 1;
        } else {
            chain = [];
            let luck = Number(result.seed);
            for (let index = 0;
                index < 4000 && chain.length < chainLimit;
                index++) {
                let draw;
                try {
                    draw = landing.engine.draw(luck, true);
                } catch (error) {
                    break;
                }
                luck = Number(draw[1]);
                const id = Number(draw[0]);
                if (landing.engine.allowed.has(id)) chain.push(id);
            }
            chainCache.set(cacheKey, chain);
            metrics.chainBuilds += 1;
        }
        const item = Object.assign({}, result, {
            jumpsTo: [jumps],
            checkpointRaw: checkpointRaw(raw, result.state),
            chain: chain.slice(),
            chainCacheKey: cacheKey,
        });
        bySeed.set(key, item);
        seeds.push(item);
        maxUsefulJump = Math.max(maxUsefulJump, jumps);
        return item;
    };

    let cursor = 0;
    let current = probe(cursor);
    if (current) current = addResult(cursor, current);
    let boundaryConfirmed = false;
    while (current && cursor < maxJump) {
        const next = boundaryConfirmed
            ? cursor + slots : cursor + 1;
        if (next > maxJump) break;
        const result = probe(next);
        if (!result || result.seed === current.seed) {
            if (!boundaryConfirmed) {
                current.jumpsTo.push(next);
                cursor = next;
                continue;
            }
            const tail = Math.min(
                maxJump,
                next + Math.max(8, slots * 2) - 1
            );
            for (let jumps = cursor + 1; jumps <= tail; jumps++) {
                current.jumpsTo.push(jumps);
            }
            break;
        }
        const repeated = bySeed.get(String(result.seed));
        if (repeated && repeated !== current) break;
        for (let jumps = cursor + 1; jumps < next; jumps++) {
            current.jumpsTo.push(jumps);
        }
        current = addResult(next, result);
        boundaryConfirmed = true;
        cursor = next;
    }
    metrics.skippedLandingProbes = Math.max(
        0, maxJump + 1 - metrics.jumpProbes
    );
    metrics.prefixWashes = landing.prefixWashes;
    metrics.builtJumps = landing.builtJumps;

    return {
        zizhi,
        slots,
        maxJump,
        maxUsefulJump,
        seeds,
        metrics,
    };
}

async function searchJumpRoutes(raw, targetIds, options) {
    const o = options || {};
    const context = o.context || loadAWash();
    const fixed = context.WashFixedChain
        ? context
        : require('../dev/fixed_chain_fixtures')
            .loadFixedChainContext();
    const targets = Array.from(new Set(targetIds.map(Number)))
        .sort((a, b) => a - b);
    const zizhiList = Array.isArray(o.zizhiList)
        ? o.zizhiList.map(Number) : [153, 154];
    const startedAt = Date.now();
    const chainCache = o.chainCache instanceof Map
        ? o.chainCache : new Map();
    const enumerated = [];
    if (!o.skipEnumeratedSeeds) {
        for (const zizhi of zizhiList) {
            const result = enumerateJumpSeeds(raw, Object.assign({}, o, {
                context,
                zizhi,
                chainCache,
            }));
            for (const seed of result.seeds) {
                enumerated.push(Object.assign({}, seed, { zizhi }));
            }
        }
    }
    for (const candidate of (o.seedCandidates || [])) {
        const zizhi = Number(candidate.zizhi);
        if (!zizhiList.includes(zizhi)
            || !candidate.checkpointRaw
            || !Number.isFinite(Number(candidate.seed))) {
            continue;
        }
        enumerated.push(Object.assign({}, candidate, {
            zizhi,
            seed: Number(candidate.seed),
            preludePills: Number(candidate.preludePills
                != null ? candidate.preludePills : candidate.pills) || 0,
            preludeWashes: Number(candidate.preludeWashes
                != null ? candidate.preludeWashes : candidate.washes) || 0,
            jumpsTo: Array.isArray(candidate.jumpsTo)
                ? candidate.jumpsTo.slice() : [],
        }));
    }
    const targetOrder = Array.from(new Set(
        (o.targetOrder || targetIds).map(Number)
    ));
    const bySeed = new Map();
    for (const item of enumerated) {
        const keptTargetIds = Array.from(new Set(
            (item.keptTargetIds || []).map(Number)
        )).sort((a, b) => a - b);
        const checkpoint = item.checkpointRaw || {};
        const stateKey = item.exchangeReady ? [
            Number(checkpoint.seed) || 0,
            Number(checkpoint.luck_seed) || 0,
            checkpoint.luck_seed_inited ? 1 : 0,
            Number(checkpoint.born_talent_rc) || 0,
            Number(checkpoint.tal_lucky) || 0,
            (checkpoint.talents || [])
                .map(entry => Number(entry && entry.id != null
                    ? entry.id : entry))
                .join(','),
        ].join('|') : '';
        const key = `${item.zizhi}:${Number(item.seed)}:`
            + `${keptTargetIds.join(',')}:${stateKey}`;
        const normalized = Object.assign({}, item, {
            keptTargetIds,
            exchangeReady: !!item.exchangeReady,
            ignoredTargetIds: Array.from(new Set(
                (item.ignoredTargetIds || []).map(Number)
            )),
            targetEvents: (item.targetEvents || []).map(
                event => Object.assign({}, event)
            ),
            targetOrder: targetOrder.slice(),
            terminal: !!item.terminal,
            branchKey: (item.branchKey
                || `keep:${keptTargetIds.join(',')}`
                    + `:${item.terminal ? 'terminal' : 'search'}`)
                + (item.exchangeReady ? `:exchange-ready:${stateKey}` : ''),
        });
        const previous = bySeed.get(key);
        if (!previous
            || normalized.preludePills < previous.preludePills
            || (normalized.preludePills === previous.preludePills
                && normalized.preludeWashes < previous.preludeWashes)) {
            bySeed.set(key, normalized);
        }
    }
    const unique = orderTargetBranches(
        Array.from(bySeed.values()),
        targetOrder
    );
    const selected = [];
    const maxSeeds = Number(o.maxSeeds) > 0
        ? Number(o.maxSeeds) : unique.length;
    const representedKeepCounts = new Set();
    for (const candidate of unique) {
        const keepCount = (candidate.keptTargetIds || []).length;
        if (representedKeepCounts.has(keepCount)
            || selected.length >= maxSeeds) continue;
        representedKeepCounts.add(keepCount);
        selected.push(candidate);
    }
    for (const candidate of unique) {
        if (selected.length >= maxSeeds) break;
        if (!selected.includes(candidate)) selected.push(candidate);
    }
    const results = [];
    const branchSearchOrder = [];
    const branchGroups = [];
    // 只有调用方已经给出共享上界时才启用丹耗剪枝。
    let sharedUpperBoundPills = Number(o.initialUpperBoundPills) > 0
        ? Number(o.initialUpperBoundPills)
        : 0;
    let best = null;
    let neighborhoodSeedsSearched = 0;
    const keepCounts = Array.from(new Set(selected.map(seed =>
        (seed.keptTargetIds || []).length
    ))).sort((a, b) => a - b);

    for (const keepCount of keepCounts) {
        const group = selected.filter(seed =>
            (seed.keptTargetIds || []).length === keepCount
        );
        const groupStart = results.length;
        for (const seed of group) {
            branchSearchOrder.push(seed.branchKey);
            const seedStartedAt = Date.now();
            const keptTargetIds = seed.keptTargetIds || [];
            const searchBudgetPills = sharedUpperBoundPills > 0
                ? sharedUpperBoundPills - seed.preludePills
                : 0;
            const base = {
                zizhi: seed.zizhi,
                jumps: seed.jumpsTo.length ? seed.jumpsTo[0] : null,
                jumpsTo: seed.jumpsTo.slice(),
                actualJumps: Number(seed.actualJumps)
                    || (Array.isArray(seed.actions) ? seed.actions.length : 0),
                seed: seed.seed,
                firstPityId: seed.firstPityId,
                preludeWashes: seed.preludeWashes,
                preludePills: seed.preludePills,
                checkpointRaw: seed.checkpointRaw,
                searchBudgetPills,
                neighborhoodRan: false,
                keptTargetIds,
                ignoredTargetIds: seed.ignoredTargetIds || [],
                targetEvents: seed.targetEvents || [],
                targetOrder: seed.targetOrder || targetOrder,
                branchKey: seed.branchKey,
                terminal: !!seed.terminal,
                heldTargetsVerified: true,
            };
            if (sharedUpperBoundPills > 0
                && seed.preludePills >= sharedUpperBoundPills) {
                const skipped = Object.assign({}, base, {
                    ok: false,
                    status: 'resource-limited',
                    stopReason: 'shared-upper-bound',
                    route: null,
                    initialRoutes: [],
                    continuationPills: null,
                    continuationWashes: null,
                    totalPills: null,
                    totalWashes: null,
                    exchanges: null,
                    metrics: {},
                    elapsedMs: Date.now() - seedStartedAt,
                });
                results.push(skipped);
                if (typeof o.onSeedResult === 'function') {
                    try {
                        o.onSeedResult(skipped);
                    } catch (error) { }
                }
                continue;
            }

            let initialRoutes = [];
            if (seed.terminal) {
                const field = new Set(
                    (seed.checkpointRaw.talents || []).map(item =>
                        Number(item && item.id != null ? item.id : item)
                    )
                );
                const complete = targets.every(id => field.has(id));
                if (complete) {
                    const route = {
                        pills: 0,
                        washes: 0,
                        exchanges: 0,
                        steps: [],
                        targetIds: targets.slice(),
                        finalTalents: Array.from(field),
                    };
                    initialRoutes = [{
                        source: 'terminal',
                        steps: [],
                        replay: route,
                        pills: 0,
                        washes: 0,
                        exchanges: 0,
                        heldTargetsVerified: true,
                    }];
                }
            } else {
                const searched = await fixed.WashFixedChain.solve(
                    seed.checkpointRaw,
                    targets,
                    {
                        budget: searchBudgetPills,
                        pinnedTargetIds: keptTargetIds,
                        requiredHeldIds: keptTargetIds,
                        targetOrder,
                        limits: o.limits || {},
                        runtime: Object.assign(
                            { chainSearch: true },
                            o.runtime || {}
                        ),
                        findInitialRoutes: o.findInitialRoutes
                            || findInitialRoutes,
                    }
                );
                if (searched.ok && searched.route) {
                    initialRoutes = [{
                        source: 'awash-internal',
                        steps: searched.route.steps,
                        replay: searched.route,
                        pills: searched.route.pills,
                        washes: searched.route.washes,
                        exchanges: searched.route.exchanges,
                        heldTargetsVerified: true,
                    }];
                }
            }
            const initial = initialRoutes[0] || null;
            const routePills = initial && initial.replay.pills;
            const routeWashes = initial && initial.replay.washes;
            const summary = Object.assign({}, base, {
                ok: !!initial,
                status: initial
                    ? (seed.terminal ? 'terminal' : 'screened')
                    : 'no-route',
                stopReason: initial
                    ? (seed.terminal
                        ? 'targets-complete' : 'initial-route-screened')
                    : 'initial-search-no-route',
                route: seed.terminal && initial
                    ? initial.replay : null,
                initialRoutes,
                continuationPills: routePills,
                continuationWashes: routeWashes,
                totalPills: initial
                    ? seed.preludePills + routePills : null,
                totalWashes: initial
                    ? seed.preludeWashes + routeWashes : null,
                exchanges: initial ? initial.replay.exchanges : null,
                heldTargetsVerified: initial
                    ? !!initial.heldTargetsVerified : false,
                metrics: {
                    initialSearchElapsedMs: Date.now() - seedStartedAt,
                },
                elapsedMs: Date.now() - seedStartedAt,
            });
            if (summary.ok
                && (sharedUpperBoundPills === 0
                    || summary.totalPills < sharedUpperBoundPills)) {
                sharedUpperBoundPills = summary.totalPills;
            }
            results.push(summary);
            if (typeof o.onSeedResult === 'function') {
                try {
                    o.onSeedResult(summary);
                } catch (error) { }
            }
        }

        const groupResults = results.slice(groupStart);
        let groupBest = groupResults.filter(item => item.ok)
            .sort((a, b) =>
                (a.totalPills - b.totalPills)
                || (a.totalWashes - b.totalWashes)
                || (a.exchanges - b.exchanges)
            )[0] || null;
        if (groupBest && !groupBest.terminal) {
            if (groupBest.keptTargetIds.length) {
                const route = groupBest.initialRoutes[0].replay;
                groupBest.route = route;
                groupBest.continuationPills = route.pills;
                groupBest.continuationWashes = route.washes;
                groupBest.totalPills =
                    groupBest.preludePills + route.pills;
                groupBest.totalWashes =
                    groupBest.preludeWashes + route.washes;
                groupBest.exchanges = route.exchanges;
                groupBest.status = 'screened';
                groupBest.stopReason = 'pinned-initial-route';
                groupBest.heldTargetsVerified = true;
            } else {
                const neighborhoodStartedAt = Date.now();
                const optimized = fixed.WashFixedChain.optimizeRoutes(
                    groupBest.checkpointRaw,
                    targets,
                    groupBest.initialRoutes,
                    {
                        budget: groupBest.continuationPills,
                        limits: o.limits || {},
                        incumbentSearch: o.incumbentSearch,
                        incumbentBeamWidth: o.incumbentBeamWidth,
                        incumbentPasses: o.incumbentPasses,
                        incumbentMaxNodes: o.incumbentMaxNodes,
                        incumbentMaxRuntimeMs: o.incumbentMaxRuntimeMs,
                        optimizerCandidates: o.optimizerCandidates,
                    }
                );
                neighborhoodSeedsSearched += 1;
                const route = optimized.route;
                groupBest.route = route;
                groupBest.ok = !!optimized.ok && !!route;
                groupBest.status = optimized.status;
                groupBest.stopReason = optimized.stopReason;
                groupBest.continuationPills = route && route.pills;
                groupBest.continuationWashes = route && route.washes;
                groupBest.totalPills = route
                    ? groupBest.preludePills + route.pills : null;
                groupBest.totalWashes = route
                    ? groupBest.preludeWashes + route.washes : null;
                groupBest.exchanges = route && route.exchanges;
                groupBest.metrics = Object.assign(
                    {},
                    groupBest.metrics,
                    optimized.metrics,
                    {
                        neighborhoodElapsedMs:
                            Date.now() - neighborhoodStartedAt,
                    }
                );
                groupBest.neighborhoodRan = true;
            }
        }
        const groupComplete = groupResults.filter(item =>
            item.ok && item.route
        ).sort((a, b) =>
            (a.totalPills - b.totalPills)
            || (a.totalWashes - b.totalWashes)
            || (a.exchanges - b.exchanges)
        )[0] || null;
        if (groupComplete && (!best
            || groupComplete.totalPills < best.totalPills
            || (groupComplete.totalPills === best.totalPills
                && groupComplete.totalWashes < best.totalWashes))) {
            best = groupComplete;
        }
        if (best && (sharedUpperBoundPills === 0
            || best.totalPills < sharedUpperBoundPills)) {
            sharedUpperBoundPills = best.totalPills;
        }
        branchGroups.push({
            keepCount,
            candidates: group.length,
            successful: groupResults.filter(item => item.ok).length,
            bestPills: groupComplete && groupComplete.totalPills,
        });
    }

    return {
        ok: !!(best && best.ok && best.route),
        best: best && best.ok ? best : null,
        results,
        metrics: {
            elapsedMs: Date.now() - startedAt,
            seedsEnumerated: enumerated.length,
            uniqueSeedCandidates: unique.length,
            totalSeedsSearched: selected.length,
            successfulSeeds: results.filter(item => item.ok).length,
            neighborhoodSeedsSearched,
            sharedUpperBoundPills: sharedUpperBoundPills || null,
            branchSearchOrder,
            branchGroups,
        },
    };
}

module.exports = {
    checkpointRaw,
    engineFor,
    enumerateJumpSeeds,
    orderTargetBranches,
    runJumpToFirstPity,
    searchJumpRoutes,
};
