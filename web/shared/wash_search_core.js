// -*- coding: utf-8 -*-
/**
 * AWash core (WashSearchV2 implementation).
 *
 * This module searches the real WashSourceEngine state. It does not use the
 * old anchor/tail/insertMap pipeline. The first implementation is an
 * event-macro beam search so routes can be produced and replayed before the
 * final exhaustive scheduler is added.
 */
(function (root) {
    'use strict';

    const VERSION = '0.2.0';
    const DEFAULT_LIMITS = Object.freeze({
        maxExpandedNodes: 500000,
        maxWashSteps: 2500000,
        maxUniqueStates: 300000,
        maxRuntimeMs: 300000,
    });
    const DEFAULT_RUNTIME = Object.freeze({
        beamWidth: 2000,
        maxDepth: 40,
        maxRunWashes: 1200,
        maxTargetWait: 1500,
        maxTargetConflictWait: 400,
        maxCarrierWait: 300,
        maxPolicyWashes: 300000,
        chainBeamWidth: 24,
        maxTicketStages: 12,
        maxLockMasks: 20,
        maxRunLockMasks: 8,
        maxExchangePads: 32,
        reverseTailOrders: 8,
    });

    function number(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function uniqueNumbers(values) {
        return Array.from(new Set((values || []).map(Number)
            .filter(value => Number.isFinite(value) && value > 0)));
    }

    function sorted(values) {
        return uniqueNumbers(values).sort((a, b) => a - b);
    }

    function nameOf(id) {
        const item = root.TALENT_DATA && root.TALENT_DATA[String(Number(id))];
        return item && item.name ? item.name : String(id);
    }

    function createAdapter(raw, options) {
        const engineByZi = new Map();
        const pinnedTargetIds = uniqueNumbers(
            (options && options.pinnedTargetIds) || []
        );

        function engineForZi(zi) {
            const value = Number(zi) >= 150 ? Number(zi) : 153;
            if (engineByZi.has(value)) return engineByZi.get(value);
            const zz = root.ZZ_DATA && root.ZZ_DATA[String(value)];
            if (!zz || !root.WashSourceEngine || typeof root.WashSourceEngine.Engine !== 'function') {
                throw new Error('洗脉引擎或资质数据未加载');
            }
            const engine = new root.WashSourceEngine.Engine(root.TALENT_DATA, raw, {
                slotCount: Number(zz.num_talent),
                pity: Number(zz.bd_zz),
                eat: Number(zz.eat_xisui),
                eligibleZi: value,
                advancePerDraw: !!(root.SequenceRules && root.SequenceRules.washRC(raw)),
                dlcMode: !!raw.dlc_mode,
            });
            engineByZi.set(value, engine);
            return engine;
        }

        function engineForState(state) {
            return engineForZi(state && state.zizhi);
        }

        function initialValue() {
            const sourceZi = Math.max(151, Math.min(number(raw.zizhi, 153), 154));
            if (sourceZi >= 153) {
                const engine = engineForZi(sourceZi);
                return {
                    engine,
                    state: engine.initialState(Object.assign({}, raw, { zizhi: sourceZi })),
                    steps: [],
                };
            }
            const base = engineForZi(sourceZi);
            let state = base.initialState(Object.assign({}, raw, { zizhi: sourceZi }));
            const target = engineForZi(153);
            state = target.upgradeToThree(Object.assign({}, state, { zizhi: 153 }));
            return {
                engine: target,
                state,
                steps: [{ op: 'upgrade', fromZizhi: sourceZi, toZizhi: 153 }],
            };
        }

        const start = initialValue();
        const activePinnedIds = pinnedTargetIds.filter(id =>
            start.state.talents.includes(id)
        );
        const locked = (raw.talents || [])
            .filter(item => item && (item.locked || item.Lock))
            .map(item => Number(item.id != null ? item.id : item.ID))
            .filter(id => start.state.talents.includes(id));

        return {
            start,
            initialLocks: sorted(locked),
            pinnedTargetIds: activePinnedIds,
            engineForZi,
            engineForState,
            stateKey(state) {
                return root.WashSourceEngine.stateKey(state);
            },
            prepareLocks(state, keepIds) {
                return Object.assign({}, state, {
                    talents: state.talents.slice(),
                });
            },
            wash(state, keepIds) {
                const engine = engineForState(state);
                const effectiveKeepIds = uniqueNumbers(
                    activePinnedIds.filter(id =>
                        state.talents.includes(Number(id))
                    ).concat(keepIds || [])
                );
                const positions = effectiveKeepIds
                    .map(id => state.talents.indexOf(Number(id)))
                    .filter(index => index >= 0)
                    .sort((a, b) => a - b);
                return engine.wash(state, positions);
            },
            replaceablePositions(state, lockIds) {
                const effectiveLockIds = uniqueNumbers(
                    activePinnedIds.filter(id =>
                        state.talents.includes(Number(id))
                    ).concat(lockIds || [])
                );
                return engineForState(state).replaceablePositions(
                    state, sorted(effectiveLockIds)
                );
            },
            replace(state, position, lockIds) {
                const carrierId = Number(state.talents[position]);
                if (activePinnedIds.includes(carrierId)) {
                    throw new Error('固定目标不能作为置换载体');
                }
                const effectiveLockIds = uniqueNumbers(
                    activePinnedIds.filter(id =>
                        state.talents.includes(Number(id))
                    ).concat(lockIds || [])
                );
                return engineForState(state).replace(
                    state,
                    position,
                    sorted(effectiveLockIds)
                );
            },
            exchangeMoves(state, lockIds) {
                const positions = this.replaceablePositions(state, lockIds);
                return positions.map(position => ({
                    state,
                    position,
                    carrierId: Number(state.talents[position]),
                }));
            },
            upgradeFour(state) {
                const engine = engineForZi(154);
                return engine.upgradeToFour(Object.assign({}, state, { zizhi: 154 }));
            },
            pityThreshold(state) {
                const engine = engineForState(state);
                if (engine.dlcMode) return 300;
                if (engine.pity != null) return Number(engine.pity);
                const rule = engine.ruleFor(state.zizhi);
                return Number(rule && rule.pity) || 0;
            },
            slotCount(state) {
                return engineForState(state).slotCountFor(state.zizhi);
            },
            quality(id) {
                return engineForZi(154).quality(Number(id));
            },
            isShenmai(id) {
                return engineForZi(154).isShenmai(Number(id));
            },
            knownTalent(id) {
                return !!(root.TALENT_DATA && root.TALENT_DATA[String(Number(id))]);
            },
        };
    }

    function invalidatedCarriersForUnlock(adapter, state, removedLocks) {
        const engine = adapter.engineForState(state);
        const result = [];
        const removed = new Set(uniqueNumbers(removedLocks));
        if (!removed.size) return result;
        state.talents.forEach((carrierId, carrierPosition) => {
            const carrier = Number(carrierId);
            if (adapter.quality(carrier) !== 4
                || adapter.isShenmai(carrier)) return;
            const type = engine.talentType(carrier);
            for (let index = carrierPosition - 1; index >= 0; index--) {
                const conflictId = Number(state.talents[index]);
                if (adapter.quality(conflictId) >= 4
                    || adapter.isShenmai(conflictId)
                    || engine.talentType(conflictId) !== type) {
                    continue;
                }
                if (removed.has(conflictId)) result.push(carrier);
                break;
            }
        });
        return sorted(result);
    }

    function updateExchangeHistory(adapter, state, beforeLocks, steps,
        blockedIds) {
        const blocked = new Set(uniqueNumbers(blockedIds));
        let locks = uniqueNumbers(beforeLocks);
        let invalidExchangeAttempt = false;
        for (const step of steps || []) {
            if (step.op === 'locks') {
                const next = uniqueNumbers(step.lockIds);
                const nextSet = new Set(next);
                invalidatedCarriersForUnlock(
                    adapter,
                    state,
                    locks.filter(id => !nextSet.has(id))
                ).forEach(id => blocked.add(id));
                locks = next;
            } else if (step.op === 'exchange') {
                const carrierId = Number(step.carrierId);
                if (blocked.has(carrierId)) invalidExchangeAttempt = true;
                blocked.delete(carrierId);
            }
        }
        return {
            blocked: sorted(Array.from(blocked)
                .filter(id => state.talents.includes(id))),
            invalidExchangeAttempt,
        };
    }

    function subsets(ids) {
        const values = uniqueNumbers(ids);
        const result = [];
        for (let mask = 0; mask < (1 << values.length); mask++) {
            const item = [];
            for (let index = 0; index < values.length; index++) {
                if (mask & (1 << index)) item.push(values[index]);
            }
            result.push(item);
        }
        return result;
    }

    function permutations(ids) {
        const values = uniqueNumbers(ids);
        if (values.length <= 1) return [values];
        const result = [];
        values.forEach((value, index) => {
            permutations(values.slice(0, index).concat(values.slice(index + 1)))
                .forEach(rest => result.push([value].concat(rest)));
        });
        return result;
    }

    function presentTargets(state, targets) {
        const field = new Set((state.talents || []).map(Number));
        return targets.filter(id => field.has(Number(id)));
    }

    function usefulLockMasks(adapter, state, targets, previousLock, limit) {
        const field = uniqueNumbers(state.talents);
        const present = presentTargets(state, targets);
        const targetSets = subsets(present);
        const lowIds = field.filter(id => id !== 251 && adapter.quality(id) < 4);
        const shenIds = field.filter(id => adapter.isShenmai(id));
        const masks = [];
        const seen = new Set();
        const add = (ids, priority) => {
            const value = sorted(ids).filter(id => field.includes(id));
            const key = value.join(',');
            if (seen.has(key)) return;
            seen.add(key);
            masks.push({ ids: value, priority: Number(priority) || 0, order: masks.length });
        };

        if (present.length) add(present, 0);
        shenIds.forEach(id => add([id].concat(present), 1));
        lowIds.forEach(id => add([id].concat(present), 2));
        shenIds.forEach(shenId => lowIds.forEach(lowId =>
            add([shenId, lowId], 2)));
        add(previousLock || [], 2);
        lowIds.forEach(id => add([id], 3));
        add([], 4);
        targetSets.forEach(ids => add(ids, 5));

        masks.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));
        return masks.slice(0, Math.max(1, Number(limit) || masks.length)).map(item => item.ids);
    }

    function postLockCandidates(adapter, state, targets, previousLock, extraLocks, carrierId) {
        const field = new Set((state.talents || []).map(Number));
        const present = presentTargets(state, targets);
        const previous = sorted(previousLock).filter(id => field.has(Number(id)));
        const result = [];
        const seen = new Set();
        const add = ids => {
            const value = sorted(ids).filter(id => field.has(Number(id)));
            const key = value.join(',');
            if (seen.has(key)) return;
            seen.add(key);
            result.push(value);
        };
        add([]);
        add(present);
        add(previous);
        add(previous.concat(present));
        add(previous.concat(present, extraLocks || []));
        add((extraLocks || []).concat(present));
        if (carrierId) {
            add([carrierId]);
            add([carrierId].concat(present));
            add([carrierId].concat(present, extraLocks || []));
            add([carrierId].concat(previous, extraLocks || []));
        }
        return result;
    }

    function targetStats(state, targets) {
        const field = new Set((state.talents || []).map(Number));
        return targets.filter(id => field.has(Number(id))).length;
    }

    function scoreNode(node, targetCount) {
        const chainReward = Number(node.exchangeChainIndex) || 0;
        const explicitOrder = !!node.targetOrderExplicit;
        const orderProgress = !explicitOrder
            ? node.targetHeldCount
            : node.targetOrderProgress == null
            ? node.targetHeldCount : node.targetOrderProgress;
        const missing = Math.max(0, targetCount - orderProgress);
        const capturedCount = node.capturedTargetCount == null
            ? node.targetHeldCount : node.capturedTargetCount;
        const unseen = Math.max(0, targetCount - capturedCount);
        const unseenEarly = node.chainTargetPlanActive
            ? Math.max(0,
                node.earlyTargetCount - node.capturedEarlyTargetCount)
            : unseen;
        const unseenDeferred = node.chainTargetPlanActive
            ? Math.max(0,
                node.deferredTargetCount
                    - node.capturedDeferredTargetCount)
            : 0;
        const deferredWeight = node.chainComplete ? 10000 : 500;
        const currentEarlyMissing = node.chainTargetPlanActive
            ? Math.max(0,
                node.earlyTargetCount - node.currentEarlyTargetCount)
            : 0;
        const outOfOrder = explicitOrder
            ? Math.max(0, node.targetHeldCount - orderProgress) : 0;
        const nextStage = Math.min(
            Math.max(1, node.targetHeldCount + 1), 4
        );
        const nextWeight = [1, 2, 4, 10][nextStage - 1];
        const orderedDistance = !explicitOrder
            ? node.nextTargetDistance
            : node.nextOrderTargetDistance == null
            ? node.nextTargetDistance : node.nextOrderTargetDistance;
        const seedPenalty = node.engineState.luckSeed == null ? 250 : 0;
        return chainReward * 4000
            - (node.chainLookahead ? 5000 : 0)
            - (Number(node.exchangeChainPadCount) || 0) * 1500
            + unseenEarly * 10000
            + unseenDeferred * deferredWeight
            + currentEarlyMissing * 8000
            + missing * 2000 + outOfOrder * 9000
            + node.pillsUsed * 1.5
            + node.nextWashCost * 60
            + node.advanceUnitCost * 300
            + seedPenalty
            - node.exchangeReady * 1800 - node.purpleCount * 100
            - node.shenCount * 350 - node.lowCount * 80
            - (node.ticketCarrier ? 1200 : 0)
            - node.chainHitsNext8 * 180
            + (explicitOrder
                ? Math.min(64, orderedDistance) * nextWeight * 45 : 0)
            - (orderedDistance <= 8
                ? (9 - orderedDistance) * 300 : 0)
            - (node.anchorShiftCount || 0) * (explicitOrder ? 2200 : 0)
            + (node.anchorTargetError || 0) * 900
            + node.depth * 2 + node.washes * 0.01;
    }

    function compareNodes(a, b, targetCount) {
        return (scoreNode(a, targetCount) - scoreNode(b, targetCount))
            || (a.pillsUsed - b.pillsUsed)
            || (b.targetHeldCount - a.targetHeldCount)
            || (a.washes - b.washes)
            || (a.exchangeCount - b.exchangeCount)
            || (a.sequence - b.sequence);
    }

    function selectStratifiedFrontier(children, width, targetCount) {
        const sortedChildren = children.slice()
            .sort((a, b) => compareNodes(a, b, targetCount));
        if (sortedChildren.length <= width) return sortedChildren;
        const targetGroups = new Map();
        for (const node of sortedChildren) {
            if (!targetGroups.has(node.targetMask)) targetGroups.set(node.targetMask, []);
            targetGroups.get(node.targetMask).push(node);
        }
        const activeGroups = Math.max(1, targetGroups.size);
        const perTargetQuota = Math.max(1, Math.floor(width / activeGroups));
        const selected = [];
        const selectedKeys = new Set();
        const orderedGroups = Array.from(targetGroups.keys())
            .map(mask => ({
                mask,
                count: targetGroups.get(mask)[0].targetHeldCount,
                best: targetGroups.get(mask)[0],
            }))
            .sort((a, b) => (b.count - a.count)
                || compareNodes(a.best, b.best, targetCount));
        for (const group of orderedGroups) {
            const nodes = targetGroups.get(group.mask);
            const subGroups = new Map();
            for (const node of nodes) {
                const subKey = node.ticketCarrier + '|' + node.exchangeReady
                    + '|' + Math.floor(node.washes / 20);
                if (!subGroups.has(subKey)) subGroups.set(subKey, []);
                subGroups.get(subKey).push(node);
            }
            const orderedSubGroups = Array.from(subGroups.values())
                .sort((a, b) => compareNodes(a[0], b[0], targetCount));
            let picked = 0;
            for (const sub of orderedSubGroups) {
                if (picked >= perTargetQuota) break;
                const node = sub[0];
                selected.push(node);
                selectedKeys.add(node.stateKey);
                picked++;
            }
            if (picked < perTargetQuota) {
                for (const node of nodes) {
                    if (picked >= perTargetQuota) break;
                    if (selectedKeys.has(node.stateKey)) continue;
                    selected.push(node);
                    selectedKeys.add(node.stateKey);
                    picked++;
                }
            }
        }
        for (const node of sortedChildren) {
            if (selected.length >= width) break;
            if (selectedKeys.has(node.stateKey)) continue;
            selected.push(node);
            selectedKeys.add(node.stateKey);
        }
        return selected.slice(0, width);
    }

    function selectChainPortfolio(children, width, targetCount) {
        const sortedChildren = children.slice()
            .sort((a, b) =>
                ((Number(b.exchangeChainIndex) || 0)
                    - (Number(a.exchangeChainIndex) || 0))
                || (Number(!!b.targetOrderExplicit)
                    - Number(!!a.targetOrderExplicit))
                || (b.targetOrderExplicit
                    ? (b.targetOrderProgress - a.targetOrderProgress)
                        || ((a.targetHeldCount - a.targetOrderProgress)
                            - (b.targetHeldCount - b.targetOrderProgress))
                    : 0)
                || ((b.anchorShiftCount || 0) - (a.anchorShiftCount || 0))
                || (b.targetHeldCount - a.targetHeldCount)
                || ((!a.targetOrderExplicit
                    ? a.nextTargetDistance
                    : a.nextOrderTargetDistance == null
                    ? a.nextTargetDistance : a.nextOrderTargetDistance)
                    - (!b.targetOrderExplicit
                        ? b.nextTargetDistance
                        : b.nextOrderTargetDistance == null
                        ? b.nextTargetDistance : b.nextOrderTargetDistance))
                || (b.chainHitsNext8 - a.chainHitsNext8)
                || (a.pillsUsed - b.pillsUsed)
                || (a.sequence - b.sequence));
        const groups = new Map();
        for (const node of sortedChildren) {
            const action = node.action || {};
            const key = [
                node.targetMask,
                action.type || '',
                Number(action.addedId) || 0,
                node.nextTargetDistance,
            ].join('|');
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(node);
        }
        const selected = [];
        const used = new Set();
        const ordered = Array.from(groups.values())
            .sort((a, b) => compareNodes(a[0], b[0], targetCount));
        for (let level = 0; selected.length < width; level++) {
            let added = false;
            for (const group of ordered) {
                if (level >= group.length || selected.length >= width) continue;
                const node = group[level];
                added = true;
                if (used.has(node.stateKey)) continue;
                used.add(node.stateKey);
                selected.push(node);
            }
            if (!added) break;
        }
        for (const node of sortedChildren) {
            if (selected.length >= width) break;
            if (used.has(node.stateKey)) continue;
            used.add(node.stateKey);
            selected.push(node);
        }
        return selected.slice(0, width);
    }

    function routeCompare(a, b) {
        if (!a) return false;
        if (!b) return true;
        if (a.pills !== b.pills) return a.pills < b.pills;
        if (a.washes !== b.washes) return a.washes < b.washes;
        if (a.exchanges !== b.exchanges) return a.exchanges < b.exchanges;
        return a.signature < b.signature;
    }

    function materializeSteps(node, initialSteps) {
        const actions = [];
        let cursor = node;
        while (cursor && cursor.parent) {
            actions.push(cursor.action);
            cursor = cursor.parent;
        }
        actions.reverse();
        const steps = (initialSteps || []).slice();
        actions.forEach(action => {
            (action.steps || []).forEach(step => steps.push(Object.assign({}, step)));
        });
        return steps;
    }

    function withPinnedSteps(steps, pinnedIds) {
        const pins = uniqueNumbers(pinnedIds || []);
        if (!pins.length) return steps;
        return (steps || []).map(step => {
            const copy = Object.assign({}, step);
            if (copy.op === 'locks') {
                copy.lockIds = uniqueNumbers(
                    pins.concat(copy.lockIds || [])
                );
            } else if (copy.op === 'wash') {
                copy.keepIds = uniqueNumbers(
                    pins.concat(copy.keepIds || [])
                );
            } else if (copy.op === 'exchange') {
                copy.lockIds = uniqueNumbers(
                    pins.concat(copy.lockIds || [])
                );
            }
            return copy;
        });
    }

    function replay(raw, targets, steps) {
        const adapter = createAdapter(raw);
        let engine = adapter.start.engine;
        let state = adapter.start.state;
        let locks = adapter.initialLocks.slice();
        let pills = 0;
        let washes = 0;
        let exchanges = 0;
        const lostExchangeIds = new Set();

        function pruneLostExchanges() {
            for (const id of Array.from(lostExchangeIds)) {
                if (!state.talents.includes(Number(id))) {
                    lostExchangeIds.delete(id);
                }
            }
        }

        function setLocks(ids) {
            const requested = uniqueNumbers(ids);
            const value = requested.filter(id => state.talents.includes(id));
            if (value.length !== requested.length) {
                throw new Error('回放锁定脉不在场');
            }
            const next = new Set(value);
            const removed = locks.filter(id => !next.has(id));
            invalidatedCarriersForUnlock(
                adapter, state, removed
            ).forEach(id => lostExchangeIds.add(id));
            locks = value;
            state = adapter.prepareLocks(state, value);
        }

        for (const step of steps || []) {
            if (step.op === 'locks') {
                setLocks(step.lockIds || []);
                continue;
            }
            if (step.op === 'upgrade') {
                const to = Number(step.toZizhi) || 154;
                engine = adapter.engineForZi(to);
                state = to === 154
                    ? engine.upgradeToFour(state)
                    : engine.upgradeToThree(state);
                continue;
            }
            if (step.op === 'wash') {
                const keepIds = uniqueNumbers(step.keepIds || []);
                const count = Math.max(1, Number(step.count) || 1);
                let segmentCost = 0;
                for (let index = 0; index < count; index++) {
                    const result = adapter.wash(state, keepIds);
                    state = result.state;
                    segmentCost += Number(result.cost) || 0;
                    washes++;
                }
                pruneLostExchanges();
                if (segmentCost !== Number(step.cost)) {
                    throw new Error('回放洗髓丹耗不一致');
                }
                pills += segmentCost;
                continue;
            }
            if (step.op === 'exchange') {
                setLocks(step.lockIds || []);
                const carrierId = Number(step.carrierId);
                if (lostExchangeIds.has(carrierId)) {
                    throw new Error(
                        '回放置换失败：冲突脉解锁后不能重新锁定，'
                        + '载体置换资格已失效'
                    );
                }
                const position = state.talents.indexOf(carrierId);
                if (position < 0) throw new Error('回放置换载体不在场');
                const result = adapter.replace(state, position, locks);
                state = result.state;
                exchanges++;
                lostExchangeIds.delete(carrierId);
                pruneLostExchanges();
                if (Number(result.addedId) !== Number(step.addedId)) {
                    throw new Error('回放置换结果不一致');
                }
                continue;
            }
            throw new Error('未知路线步骤: ' + String(step.op));
        }

        const field = new Set((state.talents || []).map(Number));
        return {
            ok: targets.every(id => field.has(Number(id))),
            pills,
            washes,
            exchanges,
            finalTalents: state.talents.slice(),
            finalStateKey: adapter.stateKey(state),
        };
    }

    function toConstructorResult(result, options) {
        const o = options || {};
        const route = result && result.route;
        if (!route) {
            return {
                ok: false,
                note: result && result.stopReason || '无可行路线',
                methodFamily: '多链反推法',
                methodBranch: '固定三四锚点，前二目标后补',
            };
        }
        const startWashes = Math.max(0, Number(o.startWashes) || 0);
        const startPills = Math.max(0, Number(o.startPills) || 0);
        const targets = (route.targetIds || []).map(Number);
        let washes = startWashes;
        let pills = startPills;
        const steps = [];
        for (const rawStep of (route.steps || [])) {
            if (rawStep.op === 'wash') {
                washes += Number(rawStep.count) || 0;
                pills += Number(rawStep.cost) || 0;
            }
            if (rawStep.op === 'wash') {
                steps.push({
                    type: 'washTo',
                    count: Number(rawStep.count) || 0,
                    target: Number(rawStep.target) || 0,
                    targetName: rawStep.target ? nameOf(rawStep.target) : '',
                    keepIds: (rawStep.keepIds || []).map(Number),
                    keepNames: (rawStep.keepIds || []).map(nameOf),
                    generatedPurples: (rawStep.generatedPurples || [])
                        .map(item => ({
                            id: Number(item.id),
                            name: nameOf(item.id),
                            at: Number(item.at) || 0,
                        })),
                    washes,
                    cost: pills,
                    why: rawStep.stopReason || '',
                });
            } else if (rawStep.op === 'exchange') {
                steps.push({
                    type: 'exchange',
                    from: Number(rawStep.removedId || rawStep.carrierId) || 0,
                    fromName: nameOf(
                        rawStep.removedId || rawStep.carrierId
                    ),
                    to: Number(rawStep.addedId) || 0,
                    toName: nameOf(rawStep.addedId),
                    lockIds: (rawStep.lockIds || []).map(Number),
                    lockNames: (rawStep.lockIds || []).map(nameOf),
                    washes,
                    cost: pills,
                    why: 'anchor-exchange',
                });
            } else if (rawStep.op === 'upgrade') {
                steps.push({
                    type: 'upgrade',
                    fromZi: Number(rawStep.fromZizhi) || 0,
                    toZi: Number(rawStep.toZizhi) || 0,
                    washes,
                    cost: pills,
                    why: 'open-four',
                });
            } else if (rawStep.op === 'locks') {
                const lockIds = (rawStep.lockIds || []).map(Number);
                steps.push({
                    type: lockIds.length ? 'lock' : 'unlockAll',
                    lockIds,
                    lockNames: lockIds.map(nameOf),
                    washes,
                    cost: pills,
                    why: lockIds.length ? 'set-locks' : 'release-all',
                });
            }
        }
        const targetAnchorDetails = route.targetAnchorDetails || {};
        const insertMap = targets.map(targetId => {
            const detail = targetAnchorDetails[targetId] || {};
            return {
                target: targetId,
                targetName: nameOf(targetId),
                anchorNo: Number(detail.ordinal) || 0,
                anchorId: Number(detail.sourceId) || 0,
                anchorName: detail.sourceId ? nameOf(detail.sourceId) : '',
            };
        }).sort((a, b) =>
            (Number(a.anchorNo) || 9999) - (Number(b.anchorNo) || 9999));
        const tail = insertMap[insertMap.length - 1] || {};
        const exchangeChain = (route.steps || [])
            .filter(step => step.op === 'exchange')
            .map(step => Number(step.addedId))
            .filter(id => id > 0);
        return {
            ok: true,
            cost: startPills + (Number(route.pills) || 0),
            washes: startWashes + (Number(route.washes) || 0),
            exchanges: Number(route.exchanges) || 0,
            burns: 0,
            kind: 'anchor-search',
            methodFamily: '多链反推法',
            methodBranch: '固定三四锚点，前二目标后补',
            tailNo: Number(tail.anchorNo) || 0,
            tailId: Number(tail.target) || 0,
            tailName: tail.targetName || '',
            seed: {
                kind: 'exchange',
                zi: Number(o.zizhi) || 154,
                n: 0,
                seed: Number(o.seed) || 0,
                startWash: startWashes,
                washes: startWashes,
                cost: startPills,
                chain: exchangeChain.map((id, index) => ({
                    no: index + 1,
                    id,
                    name: nameOf(id),
                })),
            },
            insertMap,
            targetAnchors: Object.assign({}, route.targetAnchors || {}),
            steps,
            verification: {
                ok: Number(result.metrics && result.metrics.replayFailures) === 0,
                replayFailures: Number(
                    result.metrics && result.metrics.replayFailures
                ) || 0,
                finalTalents: (route.finalTalents || []).map(id => ({
                    id: Number(id),
                    name: nameOf(id),
                })),
            },
        };
    }

    function search(raw, targetIds, options, hooks) {
        const optionsValue = options || {};
        const hook = hooks || {};
        const targets = uniqueNumbers(targetIds).sort((a, b) => a - b);
        const desiredTargetAnchors = optionsValue.anchorTargets || {};
        const anchorOrdinalBase = Math.max(
            0, Number(optionsValue.anchorOrdinalBase) || 0
        );
        const configuredTargetOrder = uniqueNumbers(
            optionsValue.targetOrder || []
        );
        const configuredExchangeChain = Array.isArray(
            optionsValue.exchangeChain
        ) ? optionsValue.exchangeChain.map(item => ({
            from: Number(item && (item.from || item.carrierId)),
            to: Number(item && (item.to || item.addedId)),
        })) : [];
        const configuredExchangeChainStart = Math.max(
            0, Math.min(
                configuredExchangeChain.length,
                Number(optionsValue.exchangeChainStart) || 0
            )
        );
        const earlyTargetIds = uniqueNumbers(
            optionsValue.earlyTargetIds || []
        ).filter(id => targets.includes(id));
        const deferredTargetIds = targets.filter(id =>
            !earlyTargetIds.includes(id)
        );
        const pinnedTargetIds = uniqueNumbers(
            optionsValue.pinnedTargetIds || []
        );
        if (targets.length !== (targetIds || []).length
            || (targets.length !== 3 && targets.length !== 4)) {
            return {
                ok: false,
                status: 'invalid-input',
                provenOptimal: false,
                route: null,
                metrics: {},
                stopReason: 'targets-must-be-3-or-4-unique',
            };
        }
        const budget = Math.max(0, Number(optionsValue.budget) || 0);
        if (!budget) {
            return {
                ok: false,
                status: 'invalid-input',
                provenOptimal: false,
                route: null,
                metrics: {},
                stopReason: 'positive-budget-required',
            };
        }

        const adapter = createAdapter(raw, {
            pinnedTargetIds,
        });
        for (const id of targets) {
            if (!adapter.knownTalent(id) || adapter.quality(id) !== 4) {
                return {
                    ok: false,
                    status: 'invalid-input',
                    provenOptimal: false,
                    route: null,
                    metrics: {},
                    stopReason: 'unknown-or-non-purple-target:' + id,
                };
            }
        }

        const limits = Object.assign({}, DEFAULT_LIMITS, optionsValue.limits || {});
        const runtime = Object.assign({}, DEFAULT_RUNTIME, optionsValue.runtime || {});
        const beamWidth = Math.max(1, Math.floor(number(runtime.beamWidth, DEFAULT_RUNTIME.beamWidth)));
        const maxDepth = Math.max(1, Math.floor(number(runtime.maxDepth, DEFAULT_RUNTIME.maxDepth)));
        const maxRunWashes = Math.max(1, Math.floor(number(runtime.maxRunWashes, DEFAULT_RUNTIME.maxRunWashes)));
        const maxTargetWait = Math.max(1, Math.floor(number(runtime.maxTargetWait, DEFAULT_RUNTIME.maxTargetWait)));
        const maxTargetConflictWait = Math.max(1, Math.floor(number(runtime.maxTargetConflictWait, DEFAULT_RUNTIME.maxTargetConflictWait)));
        const maxCarrierWait = Math.max(1, Math.floor(number(runtime.maxCarrierWait, DEFAULT_RUNTIME.maxCarrierWait)));
        const maxPolicyWashes = Math.max(1, Math.floor(number(runtime.maxPolicyWashes, DEFAULT_RUNTIME.maxPolicyWashes)));
        const chainBeamWidth = Math.max(1, Math.floor(number(runtime.chainBeamWidth, DEFAULT_RUNTIME.chainBeamWidth)));
        const maxTicketStages = Math.max(1, Math.floor(number(runtime.maxTicketStages, DEFAULT_RUNTIME.maxTicketStages)));
        const maxLockMasks = Math.max(1, Math.floor(number(runtime.maxLockMasks, DEFAULT_RUNTIME.maxLockMasks)));
        const maxRunLockMasks = Math.max(1, Math.floor(number(runtime.maxRunLockMasks, DEFAULT_RUNTIME.maxRunLockMasks)));
        const maxExchangePads = Math.max(0, Math.floor(number(runtime.maxExchangePads, DEFAULT_RUNTIME.maxExchangePads)));
        const reverseTailOrderLimit = Math.max(0, Math.floor(
            number(runtime.reverseTailOrders, DEFAULT_RUNTIME.reverseTailOrders)
        ));
        const chainSearch = !!runtime.chainSearch;
        const stopOnFirstRoute = !!optionsValue.stopOnFirstRoute;
        const metrics = {
            expandedNodes: 0,
            uniqueStates: 0,
            simulatedWashes: 0,
            generatedActions: 0,
            acceptedActions: 0,
            rejectedActions: 0,
            dominatedNodes: 0,
            budgetPrunedNodes: 0,
            incumbentPrunedNodes: 0,
            beamPrunedNodes: 0,
            replayFailures: 0,
            frontierPeak: 1,
            bestTargetHeldCount: 0,
            bestExchangeChainIndex: 0,
            copyPointNodes: 0,
            chainPortfolioNodes: 0,
            chainCheckpoints: 0,
            reverseTailOrders: 0,
            reverseTailRoutes: 0,
            initialReleaseNodes: 0,
            releaseRecaptureActions: 0,
        };
        const stateSeen = new Map();
        const dualTargetSeeds = new Map();
        const luckCache = new Map();
        const ticketCache = new Map();
        let sequence = 0;
        let stopped = false;
        let stopReason = '';
        let cancelled = false;
        let bestRoute = null;
        let policyLabel = '';
        let activeTargetOrder = targets.slice();
        let targetOrderActive = false;
        let targetPlanMode = '';
        const startedAt = Date.now();

        function stateKey(state, locks) {
            return adapter.stateKey(state) + '|' + sorted(locks).join(',');
        }

        function historyKey(state, locks, blockedExchangeIds,
            capturedTargetMask) {
            return stateKey(state, locks) + '|x='
                + sorted(blockedExchangeIds).join(',')
                + '|c=' + (Number(capturedTargetMask) || 0);
        }

        function chainHits(state) {
            const sourceSeed = state.luckSeed == null ? state.bornSeed : state.luckSeed;
            const cacheKey = state.zizhi + '|' + sourceSeed;
            if (luckCache.has(cacheKey)) return luckCache.get(cacheKey);
            const engine = adapter.engineForState(state);
            let luck = Number(sourceSeed);
            let count = 0;
            const hits = new Set();
            for (let index = 0; index < 8; index++) {
                try {
                    const draw = engine.draw(luck, true);
                    luck = draw[1];
                    const id = Number(draw[0]);
                    if (targets.includes(id)
                        && engine.allowed.has(id)
                        && !state.talents.includes(id)) {
                        hits.add(id);
                    }
                } catch (error) {
                    break;
                }
            }
            count = hits.size;
            luckCache.set(cacheKey, count);
            return count;
        }

        function distanceToTarget(state, targetId, fallbackTargets) {
            const sourceSeed = state.luckSeed == null ? state.bornSeed : state.luckSeed;
            const wanted = Number(targetId) || 0;
            const cacheKey = 'distance|' + state.zizhi + '|' + sourceSeed
                + '|' + wanted + '|' + (fallbackTargets ? 'all' : 'one');
            if (luckCache.has(cacheKey)) return luckCache.get(cacheKey);
            const engine = adapter.engineForState(state);
            let luck = Number(sourceSeed);
            let distance = 99;
            for (let index = 1; index <= 16; index++) {
                try {
                    const draw = engine.draw(luck, true);
                    luck = Number(draw[1]);
                    const id = Number(draw[0]);
                    const matches = wanted
                        ? id === wanted
                        : targets.includes(id);
                    if (matches
                        && engine.allowed.has(Number(draw[0]))
                        && !state.talents.includes(Number(draw[0]))) {
                        distance = index;
                        break;
                    }
                } catch (error) {
                    break;
                }
            }
            luckCache.set(cacheKey, distance);
            return distance;
        }

        function nextTargetDistance(state) {
            return distanceToTarget(state, 0, true);
        }

        function trackAnchorOrigins(parent, action) {
            const origins = Object.assign(
                {}, parent ? parent.anchorOrigins || {} : {}
            );
            let cursor = parent
                ? Number(parent.anchorCursor) || 0
                : anchorOrdinalBase;
            for (const step of (action && action.steps || [])) {
                if (step.op === 'wash') {
                    for (const event of (step.generatedPurples || [])) {
                        const id = Number(event.id);
                        if (adapter.quality(id) !== 4) continue;
                        cursor += 1;
                        origins[id] = {
                            ordinal: cursor,
                            sourceId: id,
                        };
                    }
                } else if (step.op === 'exchange') {
                    const removedId = Number(
                        step.removedId || step.carrierId
                    ) || 0;
                    const addedId = Number(step.addedId) || 0;
                    const origin = origins[removedId] || {
                        ordinal: 0,
                        sourceId: removedId,
                    };
                    delete origins[removedId];
                    if (addedId) origins[addedId] = origin;
                }
            }
            return { origins, cursor };
        }

        function makeNode(parent, state, locks, action, pillsUsed, washes, exchanges) {
            const value = sorted(locks).filter(id => state.talents.includes(id));
            const exchangeHistory = updateExchangeHistory(
                adapter,
                state,
                parent ? parent.lockSet : adapter.initialLocks,
                action && action.steps,
                parent ? parent.exchangeBlocked : []
            );
            const exchangeBlocked = exchangeHistory.blocked;
            let exchangeChainIndex = parent
                ? Number(parent.exchangeChainIndex) || 0 : 0;
            let exchangeChainPadCount = parent
                ? Number(parent.exchangeChainPadCount) || 0 : 0;
            for (const step of (action && action.steps || [])) {
                if (step.op !== 'exchange'
                    || !configuredExchangeChain.length) continue;
                const expected =
                    configuredExchangeChain[exchangeChainIndex];
                if (!expected
                    || Number(step.removedId) !== expected.from
                    || Number(step.addedId) !== expected.to) {
                    exchangeChainPadCount += 1;
                    continue;
                }
                exchangeChainIndex += 1;
            }
            const fieldSet = new Set(state.talents.map(Number));
            let targetMask = 0;
            targets.forEach((id, index) => {
                if (fieldSet.has(Number(id))) targetMask |= (1 << index);
            });
            const capturedTargetMask =
                (Number(parent && parent.capturedTargetMask) || 0)
                | targetMask;
            const capturedTargetCount = targets.reduce(
                (count, id, index) =>
                    capturedTargetMask & (1 << index)
                        ? count + 1 : count,
                0
            );
            const countCapturedTargets = ids => targets.reduce(
                (count, id, index) =>
                    ids.includes(id)
                    && (capturedTargetMask & (1 << index))
                        ? count + 1 : count,
                0
            );
            const purpleCount = state.talents
                .filter(id => adapter.quality(id) === 4).length;
            const shenCount = state.talents
                .filter(id => adapter.isShenmai(id)).length;
            const lowCount = state.talents
                .filter(id => id !== 251 && adapter.quality(id) < 4).length;
            const engineEat = Number(
                adapter.engineForState(state).eat
            ) || 0;
            const nextWashCost = value.length
                ? engineEat + 2 * value.length - 1
                : engineEat;
            const washPulses = Math.max(
                1, adapter.slotCount(state) - value.length
            );
            const advanceUnitCost = nextWashCost / washPulses;
            const order = targetOrderActive
                && activeTargetOrder.length === targets.length
                ? activeTargetOrder : targets;
            let targetOrderProgress = targetStats(state, targets);
            if (targetOrderActive) {
                targetOrderProgress = 0;
                for (const id of order) {
                    if (!fieldSet.has(Number(id))) break;
                    targetOrderProgress += 1;
                }
            }
            const nextOrderTarget = order.find(id => !fieldSet.has(Number(id))) || 0;
            const nextOrderTargetDistance = nextOrderTarget
                ? distanceToTarget(state, nextOrderTarget, false) : 0;
            const anchorTrack = trackAnchorOrigins(parent, action);
            const targetAnchorOrdinals = {};
            let anchorTargetError = 0;
            for (const id of targets) {
                if (!fieldSet.has(Number(id))) continue;
                const ordinal = Number(
                    anchorTrack.origins[id]
                    && anchorTrack.origins[id].ordinal
                ) || 0;
                targetAnchorOrdinals[id] = ordinal;
                const desired = Number(desiredTargetAnchors[id]) || 0;
                if (desired > 0) {
                    anchorTargetError += ordinal > 0
                        ? Math.abs(ordinal - desired)
                        : 50;
                }
            }
            const exchangeReady = adapter.replaceablePositions(state, value)
                .some(position => !exchangeBlocked.includes(
                    Number(state.talents[position])
                )) ? 1 : 0;
            let ticketCarrier = 0;
            const ticketKey = adapter.stateKey(state);
            if (ticketCache.has(ticketKey)) {
                ticketCarrier = ticketCache.get(ticketKey);
            } else {
                const lowIds = state.talents.filter(id =>
                    id !== 251 && adapter.quality(id) < 4);
                for (const lowId of lowIds) {
                    let positions = [];
                    try {
                        positions = adapter.replaceablePositions(state, [lowId]);
                    } catch (error) {
                        positions = [];
                    }
                    if (positions.length) {
                        ticketCarrier = Number(state.talents[positions[0]]);
                        break;
                    }
                }
                ticketCache.set(ticketKey, ticketCarrier);
            }
            const node = {
                id: sequence++,
                sequence: sequence,
                parent,
                action,
                engineState: state,
                lockSet: value,
                pillsUsed,
                nextWashCost,
                advanceUnitCost,
                washes,
                exchangeCount: exchanges,
                targetHeldCount: targetStats(state, targets),
                targetMask,
                capturedTargetMask,
                capturedTargetCount,
                chainTargetPlanActive: earlyTargetIds.length > 0,
                earlyTargetCount: earlyTargetIds.length,
                deferredTargetCount: deferredTargetIds.length,
                capturedEarlyTargetCount:
                    countCapturedTargets(earlyTargetIds),
                currentEarlyTargetCount:
                    countCapturedTargets(
                        earlyTargetIds.filter(id =>
                            state.talents.includes(id)
                        )
                    ),
                capturedDeferredTargetCount:
                    countCapturedTargets(deferredTargetIds),
                chainComplete: configuredExchangeChain.length > 0
                    && exchangeChainIndex
                        >= configuredExchangeChain.length,
                targetOrderExplicit: targetOrderActive,
                targetOrderProgress,
                nextOrderTarget: Number(nextOrderTarget) || 0,
                nextOrderTargetDistance,
                anchorCursor: anchorTrack.cursor,
                anchorOrigins: anchorTrack.origins,
                targetAnchorOrdinals,
                anchorTargetError,
                anchorShiftCount: (parent ? parent.anchorShiftCount || 0 : 0)
                    + (action && (action.type === 'release-recapture'
                        || action.type === 'target-burn-chain') ? 1 : 0),
                chainHitsNext8: chainHits(state),
                nextTargetDistance: nextTargetDistance(state),
                purpleCount,
                shenCount,
                lowCount,
                exchangeReady,
                exchangeBlocked,
                exchangeChainIndex,
                exchangeChainPadCount,
                chainSearchConstrained:
                    configuredExchangeChain.length > 0,
                chainLookahead: !!(action && action.chainLookahead),
                invalidExchangeAttempt:
                    exchangeHistory.invalidExchangeAttempt,
                ticketCarrier,
                depth: parent ? parent.depth + 1 : 0,
                stateKey: stateKey(state, value),
                searchKey: historyKey(
                    state, value, exchangeBlocked,
                    capturedTargetMask
                ),
            };
            metrics.bestExchangeChainIndex = Math.max(
                metrics.bestExchangeChainIndex, exchangeChainIndex
            );
            metrics.bestTargetHeldCount = Math.max(
                metrics.bestTargetHeldCount, node.targetHeldCount
            );
            if (root.__WASH_SEARCH_TRACE && (!parent
                || node.targetHeldCount > parent.targetHeldCount
                || (action && /exchange/.test(action.type))
                || node.nextTargetDistance < parent.nextTargetDistance)) {
                console.log('[WashSearchV2] chain=' + node.nextTargetDistance
                    + ' target-count=' + node.targetHeldCount
                    + ' pills=' + node.pillsUsed + ' washes=' + node.washes
                    + ' action=' + (action && action.type || 'root')
                    + ' locks=' + value.map(nameOf).join('/')
                    + ' field=' + state.talents.map(nameOf).join('/'));
            }
            return node;
        }

        const initialLocks = uniqueNumbers(
            adapter.initialLocks
                .concat(adapter.pinnedTargetIds)
                .filter(id => adapter.start.state.talents.includes(id))
        );
        const rootNode = makeNode(
            null,
            adapter.start.state,
            initialLocks,
            null,
            0,
            0,
            0
        );
        rootNode.exchangeChainIndex = configuredExchangeChainStart;
        rootNode.chainComplete = configuredExchangeChain.length > 0
            && configuredExchangeChainStart
                >= configuredExchangeChain.length;

        function buildRoute(node) {
            const steps = withPinnedSteps(
                materializeSteps(node, adapter.start.steps),
                adapter.pinnedTargetIds
            );
            const replayed = replay(raw, targets, steps);
            if (!replayed.ok || replayed.pills !== node.pillsUsed
                || replayed.washes !== node.washes
                || replayed.exchanges !== node.exchangeCount
                || replayed.finalStateKey !== adapter.stateKey(node.engineState)) {
                metrics.replayFailures++;
                return null;
            }
            const targetAnchorDetails = {};
            for (const id of targets) {
                if (!node.engineState.talents.includes(Number(id))) continue;
                const origin = node.anchorOrigins
                    && node.anchorOrigins[Number(id)];
                targetAnchorDetails[id] = {
                    ordinal: Number(node.targetAnchorOrdinals[id]) || 0,
                    sourceId: Number(origin && origin.sourceId) || 0,
                };
            }
            let seedOrigin = null;
            for (let cursor = node; cursor; cursor = cursor.parent) {
                if (cursor.action
                    && cursor.action.type === 'seed-quality-root') {
                    seedOrigin = cursor.action;
                    break;
                }
            }
            return {
                pills: node.pillsUsed,
                washes: node.washes,
                exchanges: node.exchangeCount,
                targetIds: targets.slice(),
                initialSeed: {
                    bornSeed: adapter.start.state.bornSeed,
                    luckSeed: adapter.start.state.luckSeed,
                    luckSeedInited: adapter.start.state.luckSeed != null,
                },
                finalSeed: {
                    bornSeed: node.engineState.bornSeed,
                    luckSeed: node.engineState.luckSeed,
                    luckSeedInited: node.engineState.luckSeed != null,
                },
                finalTalents: replayed.finalTalents,
                targetAnchors: Object.assign({}, node.targetAnchorOrdinals),
                targetAnchorDetails,
                steps,
                finalStateKey: node.stateKey,
                finalEngineStateKey: adapter.stateKey(node.engineState),
                signature: JSON.stringify(steps),
                seedCheckpointSource: seedOrigin
                    ? String(seedOrigin.source || 'seed') : '',
                seedCheckpointPills: seedOrigin
                    ? Number(seedOrigin.prefixPills) || 0 : 0,
                seedCheckpointWashes: seedOrigin
                    ? Number(seedOrigin.prefixWashes) || 0 : 0,
                seed: seedOrigin ? Number(seedOrigin.seed) || 0 : 0,
                seedChain: seedOrigin
                    && Array.isArray(seedOrigin.seedChain)
                    ? seedOrigin.seedChain.slice() : [],
            };
        }

        function rememberBest(node) {
            const route = buildRoute(node);
            if (!route) return;
            if (!bestRoute || routeCompare(route, bestRoute)) {
                bestRoute = route;
                metrics.bestPolicy = policyLabel || 'beam';
                metrics.bestPolicyWashes = metrics.simulatedWashes;
                if (typeof hook.onBest === 'function') {
                    try {
                        hook.onBest({
                            pills: route.pills,
                            washes: route.washes,
                            exchanges: route.exchanges,
                            provenOptimal: false,
                        });
                    } catch (error) { }
                }
                if (stopOnFirstRoute) {
                    stopped = true;
                    stopReason = 'first-route';
                }
            }
        }

        function canAddWash() {
            return metrics.simulatedWashes < limits.maxWashSteps;
        }

        function childKey(state, locks) {
            return stateKey(state, locks);
        }

        function matchesDesiredTargetAnchors(parent, node) {
            const parentField = new Set(
                parent && parent.engineState
                    ? parent.engineState.talents.map(Number) : []
            );
            for (const id of targets) {
                if (!node.engineState.talents.includes(Number(id))
                    || parentField.has(Number(id))) continue;
                const desired = Number(desiredTargetAnchors[id]) || 0;
                if (!desired) continue;
                if (Number(node.targetAnchorOrdinals[id]) !== desired) {
                    return false;
                }
            }
            return true;
        }

        function addCandidate(output, node) {
            if (node.invalidExchangeAttempt || node.invalidExchangeChain) {
                metrics.dominatedNodes++;
                return;
            }
            if (Object.keys(desiredTargetAnchors).length
                && !matchesDesiredTargetAnchors(node.parent, node)) return;
            const existing = output.get(node.searchKey);
            if (!existing || compareNodes(node, existing, targets.length) < 0) {
                output.set(node.searchKey, node);
            } else {
                metrics.dominatedNodes++;
            }
        }

        function actionStepsLocks(lockIds) {
            return [{ op: 'locks', lockIds: uniqueNumbers(lockIds) }];
        }

        function generateWashOne(node, masks, output) {
            const state = node.engineState;
            const slots = adapter.slotCount(state);
            for (const mask of masks) {
                if (mask.length >= slots || !canAddWash()) continue;
                metrics.generatedActions++;
                const result = adapter.wash(state, mask);
                metrics.simulatedWashes++;
                const pills = node.pillsUsed + (Number(result.cost) || 0);
                if (pills > budget) {
                    metrics.budgetPrunedNodes++;
                    continue;
                }
                if (bestRoute && pills >= bestRoute.pills) {
                    metrics.incumbentPrunedNodes++;
                    continue;
                }
                const steps = actionStepsLocks(mask);
                steps.push({
                    op: 'wash',
                    keepIds: sorted(mask),
                    count: 1,
                    cost: Number(result.cost) || 0,
                    generatedPurples: (result.generatedEvents || [])
                        .filter(event => adapter.quality(event.id) === 4)
                        .map(event => ({
                            at: 1,
                            id: Number(event.id),
                            fromPity: !!event.fromPity,
                        })),
                    pityPurples: result.pityPurpleId == null ? [] : [Number(result.pityPurpleId)],
                });
                const child = makeNode(
                    node, result.state, mask.slice(), {
                        type: 'wash',
                        keepIds: sorted(mask),
                        steps,
                    },
                    pills,
                    node.washes + 1,
                    node.exchangeCount
                );
                metrics.acceptedActions++;
                addCandidate(output, child);
            }
        }

        function generateWashRun(node, masks, output) {
            const slots = adapter.slotCount(node.engineState);
            for (const mask of masks) {
                if (mask.length >= slots || !canAddWash()) continue;
                metrics.generatedActions++;
                let state = node.engineState;
                let segmentCost = 0;
                let count = 0;
                let pits = [];
                const generated = [];
                let stop = false;
                while (count < maxRunWashes && canAddWash()) {
                    const result = adapter.wash(state, mask);
                    state = result.state;
                    count++;
                    metrics.simulatedWashes++;
                    segmentCost += Number(result.cost) || 0;
                    const purples = (result.generatedEvents || [])
                        .filter(event => adapter.quality(event.id) === 4);
                    purples.forEach(event => generated.push({
                        at: count,
                        id: Number(event.id),
                        fromPity: !!event.fromPity,
                    }));
                    if (result.pityPurpleId != null) pits.push({ at: count, id: Number(result.pityPurpleId) });
                    const field = new Set(state.talents.map(Number));
                    if (targets.every(id => field.has(id))
                        || purples.length
                        || result.pityPurpleId != null
                        || adapter.replaceablePositions(state, mask).length
                        || state.talLucky >= adapter.pityThreshold(state)) {
                        stop = true;
                        break;
                    }
                }
                const pills = node.pillsUsed + segmentCost;
                if (!count || pills > budget) {
                    metrics.budgetPrunedNodes++;
                    continue;
                }
                if (bestRoute && pills >= bestRoute.pills) {
                    metrics.incumbentPrunedNodes++;
                    continue;
                }
                const steps = actionStepsLocks(mask);
                steps.push({
                    op: 'wash',
                    keepIds: sorted(mask),
                    count,
                    cost: segmentCost,
                    generatedPurples: generated,
                    pityPurples: pits,
                    stopReason: stop ? 'decision' : 'run-limit',
                });
                const child = makeNode(
                    node, state, mask.slice(), {
                        type: 'wash-run',
                        keepIds: sorted(mask),
                        steps,
                    },
                    pills,
                    node.washes + count,
                    node.exchangeCount
                );
                metrics.acceptedActions++;
                addCandidate(output, child);
            }
        }

        function generatePrepareRun(node, output, lookAheadNatural,
            lockedTargetsOnly) {
            const state = node.engineState;
            const held = presentTargets(state, targets).filter(id =>
                !lockedTargetsOnly || node.lockSet.includes(id));
            const baseKeep = sorted(node.lockSet.concat(held))
                .filter(id => state.talents.includes(id));
            const nextPurple = nextAllowedPurple(state);
            const naturalPurple = lookAheadNatural
                ? nextNaturalPurple(state, baseKeep) : 0;
            const nextType = nextPurple
                && !targets.includes(Number(nextPurple))
                && !adapter.isShenmai(nextPurple)
                ? adapter.engineForState(state).talentType(nextPurple)
                : 0;
            const futureTypes = new Set(nextType ? [nextType] : []);
            if (naturalPurple
                && !targets.includes(naturalPurple)
                && !adapter.isShenmai(naturalPurple)) {
                futureTypes.add(adapter.engineForState(state)
                    .talentType(naturalPurple));
            }
            const keptTypes = new Set(baseKeep.map(id =>
                adapter.engineForState(state).talentType(Number(id))
            ));
            if (root.__WASH_SEARCH_TRACE && node.pillsUsed > 5000) {
                console.log('[WashSearchV2][prepare-start] pills='
                    + node.pillsUsed + ' next='
                    + (nextPurple ? nameOf(nextPurple) : '无')
                    + ' natural=' + (naturalPurple ? nameOf(naturalPurple) : '无')
                    + ' keep=' + baseKeep.map(nameOf).join('/'));
            }
            let runState = state;
            let segmentCost = 0;
            let count = 0;
            const generated = [];
            const pityPurples = [];
            const prepareVariants = [];
            let terminal = false;
            while (count < maxTargetWait && canAddWash()) {
                const result = adapter.wash(runState, baseKeep);
                runState = result.state;
                segmentCost += Number(result.cost) || 0;
                count++;
                metrics.simulatedWashes++;
                const purples = (result.generatedEvents || [])
                    .filter(event => adapter.quality(event.id) === 4);
                purples.forEach(event => generated.push({
                    at: count,
                    id: Number(event.id),
                    fromPity: !!event.fromPity,
                }));
                if (result.pityPurpleId != null) {
                    pityPurples.push({
                        at: count,
                        id: Number(result.pityPurpleId),
                    });
                    terminal = true;
                    break;
                }
                if (purples.length) {
                    terminal = true;
                    break;
                }
                const engine = adapter.engineForState(runState);
                const low = (result.generatedEvents || []).find(event =>
                    event.id !== 251
                    && adapter.quality(event.id) < 4
                    && futureTypes.has(engine.talentType(Number(event.id)))
                    && !keptTypes.has(engine.talentType(Number(event.id)))
                );
                if (low) {
                    prepareVariants.push({
                        state: runState,
                        cost: segmentCost,
                        count,
                        generated: generated.slice(),
                        pityPurples: pityPurples.slice(),
                        prepareId: Number(low.id),
                    });
                }
            }
            if (!count) return;
            if (root.__WASH_SEARCH_TRACE && node.pillsUsed > 5000) {
                console.log('[WashSearchV2][prepare-end] count=' + count
                    + ' terminal=' + terminal
                    + ' preps=' + prepareVariants.length
                    + ' field=' + runState.talents.map(nameOf).join('/'));
            }
            const addPrepare = variant => {
                const pills = node.pillsUsed + variant.cost;
                if (pills > budget
                    || (bestRoute && pills >= bestRoute.pills)) return;
                const locks = uniqueNumbers(
                    baseKeep.concat([variant.prepareId])
                );
                const steps = [
                    { op: 'locks', lockIds: baseKeep },
                    {
                        op: 'wash',
                        keepIds: baseKeep,
                        count: variant.count,
                        cost: variant.cost,
                        generatedPurples: variant.generated,
                        pityPurples: variant.pityPurples,
                        prepareId: variant.prepareId,
                        stopReason: 'decision',
                    },
                    { op: 'locks', lockIds: locks },
                ];
                const child = makeNode(
                    node,
                    variant.state,
                    locks,
                    {
                        type: 'wash-prepare',
                        prepareId: variant.prepareId,
                        steps,
                    },
                    pills,
                    node.washes + variant.count,
                    node.exchangeCount
                );
                metrics.acceptedActions++;
                addCandidate(output, child);
            };
            prepareVariants.slice(-6).forEach(addPrepare);
            if (terminal) {
                const pills = node.pillsUsed + segmentCost;
                if (pills > budget
                    || (bestRoute && pills >= bestRoute.pills)) return;
                const steps = [
                    { op: 'locks', lockIds: baseKeep },
                    {
                        op: 'wash',
                        keepIds: baseKeep,
                        count,
                        cost: segmentCost,
                        generatedPurples: generated,
                        pityPurples,
                        stopReason: 'decision',
                    },
                    { op: 'locks', lockIds: baseKeep },
                ];
                const child = makeNode(
                    node,
                    runState,
                    baseKeep,
                    { type: 'wash-event', steps },
                    pills,
                    node.washes + count,
                    node.exchangeCount
                );
                metrics.acceptedActions++;
                addCandidate(output, child);
            }
        }

        function generateExchanges(node, masks, output) {
            const state = node.engineState;
            const seen = new Set();
            for (const mask of masks) {
                let moves;
                try {
                    moves = adapter.exchangeMoves(state, mask);
                } catch (error) {
                    metrics.rejectedActions++;
                    continue;
                }
                for (const move of moves) {
                    metrics.generatedActions++;
                    let result;
                    try {
                        result = adapter.replace(move.state, move.position, mask);
                    } catch (error) {
                        metrics.rejectedActions++;
                        continue;
                    }
                    const carrierId = Number(move.carrierId);
                    const nextSupport = nextLuckSupport(result.state);
                    for (const post of postLockCandidates(
                        adapter, result.state, targets, mask,
                        nextSupport ? [nextSupport] : [],
                        Number(result.addedId)
                    )) {
                        const key = childKey(result.state, post);
                        if (seen.has(key)) continue;
                        seen.add(key);
                        const steps = actionStepsLocks(mask);
                        steps.push({
                            op: 'exchange',
                            carrierId,
                            lockIds: sorted(mask),
                            removedId: Number(result.removedId),
                            addedId: Number(result.addedId),
                        });
                        steps.push({ op: 'locks', lockIds: post });
                        const child = makeNode(
                            node, result.state, post, {
                                type: 'exchange',
                                carrierId,
                                addedId: Number(result.addedId),
                                steps,
                            },
                            node.pillsUsed,
                            node.washes,
                            node.exchangeCount + 1
                        );
                        metrics.acceptedActions++;
                        addCandidate(output, child);
                    }
                }
            }
        }

        function conflictMaskForCarrier(state, position, previousLock) {
            const carrierId = Number(state.talents[position]);
            const present = presentTargets(state, targets);
            if (adapter.isShenmai(carrierId)) {
                return uniqueNumbers(present.length ? present : previousLock);
            }
            const engine = adapter.engineForState(state);
            const type = engine.talentType(carrierId);
            for (let index = position - 1; index >= 0; index--) {
                const id = Number(state.talents[index]);
                if (id !== 251 && adapter.quality(id) < 4
                    && engine.talentType(id) === type) {
                    return uniqueNumbers([id].concat(present));
                }
            }
            return null;
        }

        function nextLuckSupport(state) {
            if (state.luckSeed == null) return 0;
            const engine = adapter.engineForState(state);
            let luck = Number(state.luckSeed);
            let candidate = 0;
            for (let index = 0; index < 32; index++) {
                try {
                    const draw = engine.draw(luck, true);
                    candidate = Number(draw[0]);
                    luck = Number(draw[1]);
                } catch (error) {
                    return 0;
                }
                if (engine.allowed.has(candidate)
                    && !state.talents.includes(candidate)) break;
                candidate = 0;
            }
            if (!candidate || adapter.isShenmai(candidate)) return 0;
            const type = engine.talentType(candidate);
            for (let index = state.talents.length - 1; index >= 0; index--) {
                const id = Number(state.talents[index]);
                if (id !== 251 && adapter.quality(id) < 4
                    && engine.talentType(id) === type) {
                    return id;
                }
            }
            return 0;
        }

        function nextAllowedPurple(state) {
            const source = state.luckSeed == null ? state.bornSeed : state.luckSeed;
            const engine = adapter.engineForState(state);
            let luck = Number(source);
            for (let index = 0; index < 64; index++) {
                let id = 0;
                try {
                    const draw = engine.draw(luck, true);
                    id = Number(draw[0]);
                    luck = Number(draw[1]);
                } catch (error) {
                    return 0;
                }
                if (engine.allowed.has(id) && !state.talents.includes(id)) return id;
            }
            return 0;
        }

        function nextNaturalPurple(state, keepIds) {
            let previewState = state;
            const keep = sorted(keepIds);
            for (let index = 0; index < maxTargetWait; index++) {
                const result = adapter.wash(previewState, keep);
                previewState = result.state;
                const purple = (result.generatedEvents || [])
                    .find(event => adapter.quality(event.id) === 4);
                if (purple) return Number(purple.id);
            }
            return 0;
        }

        function findSupportForCandidate(state, candidateId) {
            if (!candidateId) return 0;
            const engine = adapter.engineForState(state);
            const type = engine.talentType(candidateId);
            for (let index = state.talents.length - 1; index >= 0; index--) {
                const id = Number(state.talents[index]);
                if (id !== 251 && adapter.quality(id) < 4
                    && engine.talentType(id) === type) {
                    return id;
                }
            }
            return 0;
        }

        function advanceTicketChain(node, startState, startLocks, startSteps,
            startPills, startWashes, startExchanges, startCarrier, output) {
            let state = startState;
            let locks = sorted(startLocks);
            let steps = startSteps.slice();
            let pills = startPills;
            let washes = startWashes;
            let exchanges = startExchanges;
            let carrierId = Number(startCarrier) || 0;
            for (let stage = 0; stage < maxTicketStages && carrierId; stage++) {
                let carrierPosition = state.talents.indexOf(carrierId);
                if (carrierPosition < 0) break;
                let conflictMask = conflictMaskForCarrier(state, carrierPosition, locks);
                if (!conflictMask
                    || !adapter.replaceablePositions(state, conflictMask)
                        .includes(carrierPosition)) break;
                const candidate = nextAllowedPurple(state);
                if (candidate && !targets.includes(candidate) && !adapter.isShenmai(candidate)
                    && !findSupportForCandidate(state, candidate)) {
                    const held = presentTargets(state, targets);
                    const padKeep = Array.from(new Set(
                        conflictMask.filter(id => !targets.includes(Number(id)))
                            .concat([carrierId], held)
                    ))
                        .slice(0, Math.max(1, adapter.slotCount(state) - 1));
                    let segmentCost = 0;
                    let count = 0;
                    while (count < maxRunWashes && canAddWash()
                        && !findSupportForCandidate(state, candidate)) {
                        const washed = adapter.wash(state, padKeep);
                        state = washed.state;
                        segmentCost += Number(washed.cost) || 0;
                        count++;
                        metrics.simulatedWashes++;
                    }
                    if (!findSupportForCandidate(state, candidate)) break;
                    if (count) {
                        steps.push({ op: 'locks', lockIds: padKeep });
                        steps.push({
                            op: 'wash',
                            keepIds: padKeep,
                            count,
                            cost: segmentCost,
                        });
                        pills += segmentCost;
                        washes += count;
                    }
                    carrierPosition = state.talents.indexOf(carrierId);
                    if (carrierPosition < 0) break;
                    conflictMask = conflictMaskForCarrier(state, carrierPosition, locks);
                    if (!conflictMask
                        || !adapter.replaceablePositions(state, conflictMask)
                            .includes(carrierPosition)) break;
                }
                if (pills > budget || (bestRoute && pills >= bestRoute.pills)) break;
                metrics.generatedActions++;
                let replaced;
                try {
                    replaced = adapter.replace(state, carrierPosition, conflictMask);
                } catch (error) {
                    metrics.rejectedActions++;
                    break;
                }
                steps.push({ op: 'locks', lockIds: conflictMask });
                steps.push({
                    op: 'exchange',
                    carrierId,
                    lockIds: conflictMask,
                    removedId: Number(replaced.removedId),
                    addedId: Number(replaced.addedId),
                });
                const nextSupport = nextLuckSupport(replaced.state);
                const post = sorted(presentTargets(replaced.state, targets)
                    .concat([Number(replaced.addedId)],
                        nextSupport ? [nextSupport] : []));
                steps.push({ op: 'locks', lockIds: post });
                const child = makeNode(
                    node,
                    replaced.state,
                    post,
                    { type: 'ticket-chain', carrierId, steps: steps.slice() },
                    pills,
                    washes,
                    exchanges + 1
                );
                metrics.acceptedActions++;
                addCandidate(output, child);
                if (child.targetHeldCount >= 2) {
                    generateTargetCarrierExchanges(child, output);
                }
                if (child.targetHeldCount > node.targetHeldCount) {
                    generateTargetRuns(child, output);
                    generateTargetWithConflictRuns(child, output);
                }
                state = replaced.state;
                locks = post;
                carrierId = Number(replaced.addedId);
                exchanges++;
                if (targets.includes(carrierId)) break;
            }
        }

        function generateExchangePads(node, output, stopAfterTarget,
            padLimit, skipChain) {
            if (!maxExchangePads) return;
            const limit = Math.min(
                maxExchangePads,
                Math.max(0, Math.floor(number(padLimit, maxExchangePads)))
            );
            const state = node.engineState;
            const slots = adapter.slotCount(state);
            const candidates = [];
            const candidateSeen = new Set();
            for (const mask of usefulLockMasks(
                adapter, state, targets, node.lockSet, maxLockMasks
            )) {
                let moves = [];
                try {
                    moves = adapter.exchangeMoves(state, mask);
                } catch (error) {
                    moves = [];
                }
                for (const move of moves) {
                    if (candidateSeen.has(move.carrierId)) continue;
                    candidateSeen.add(move.carrierId);
                    candidates.push({ carrierId: move.carrierId, mask });
                }
            }
            if (!candidates.length) return;

            for (const candidate of candidates.slice(0, 4)) {
                const carrierId = Number(candidate.carrierId);
                const position = state.talents.indexOf(carrierId);
                const conflictMask = conflictMaskForCarrier(state, position, node.lockSet);
                if (!conflictMask) continue;
                const padKeep = Array.from(new Set(
                    conflictMask.filter(id => !targets.includes(Number(id)))
                        .concat([carrierId])
                ));
                if (padKeep.length >= slots) continue;

                let padded = state;
                let segmentCost = 0;
                for (let pad = 0; pad <= limit && canAddWash(); pad++) {
                    if (pad > 0) {
                        const result = adapter.wash(padded, padKeep);
                        padded = result.state;
                        segmentCost += Number(result.cost) || 0;
                        metrics.simulatedWashes++;
                    }
                    const pills = node.pillsUsed + segmentCost;
                    if (pills > budget) break;
                    if (bestRoute && pills >= bestRoute.pills) continue;
                    const carrierPosition = padded.talents.indexOf(carrierId);
                    if (carrierPosition < 0) break;
                    const nextCandidate = nextAllowedPurple(padded);
                    if (pad > 0 && nextCandidate
                        && !targets.includes(nextCandidate)
                        && !adapter.isShenmai(nextCandidate)
                        && !findSupportForCandidate(padded, nextCandidate)) {
                        continue;
                    }
                    const moves = adapter.exchangeMoves(padded, conflictMask);
                    if (!moves.some(move => move.carrierId === carrierId)) continue;
                    if (root.__WASH_SEARCH_TRACE && node.pillsUsed < 300) {
                        console.log('[WashSearchV2][pad] ' + carrierId + ':' + nameOf(carrierId)
                            + ' conflict=' + conflictMask.map(nameOf).join('/')
                            + ' pad=' + pad + ' state='
                            + padded.talents.map(nameOf).join('/'));
                    }
                    metrics.generatedActions++;
                    let replaced;
                    try {
                        replaced = adapter.replace(padded, carrierPosition, conflictMask);
                    } catch (error) {
                        metrics.rejectedActions++;
                        continue;
                    }
                    for (const post of postLockCandidates(
                        adapter, replaced.state, targets, conflictMask,
                        [], Number(replaced.addedId)
                    )) {
                        const steps = [];
                        if (pad > 0) {
                            steps.push({ op: 'locks', lockIds: padKeep });
                            steps.push({
                                op: 'wash',
                                keepIds: padKeep,
                                count: pad,
                                cost: segmentCost,
                            });
                        }
                        steps.push({ op: 'locks', lockIds: conflictMask });
                        steps.push({
                            op: 'exchange',
                            carrierId,
                            lockIds: conflictMask,
                            removedId: Number(replaced.removedId),
                            addedId: Number(replaced.addedId),
                        });
                        steps.push({ op: 'locks', lockIds: post });
                        const child = makeNode(
                            node,
                            replaced.state,
                            post,
                            { type: 'exchange-pad', carrierId, pad, steps },
                            pills,
                            node.washes + pad,
                            node.exchangeCount + 1
                        );
                        metrics.acceptedActions++;
                        addCandidate(output, child);
                        if (!skipChain) {
                            advanceTicketChain(
                                node, replaced.state, post, steps, pills,
                                node.washes + pad, node.exchangeCount + 1,
                                Number(replaced.addedId), output
                            );
                        }
                        if (stopAfterTarget && Array.from(output.values())
                            .some(child => child.targetHeldCount > node.targetHeldCount)) {
                            return;
                        }
                    }
                }
            }
        }

        function generateCarrierExchangeMacro(node, output) {
            const state = node.engineState;
            const slots = adapter.slotCount(state);
            const field = uniqueNumbers(state.talents);
            const present = presentTargets(state, targets);
            const lows = field.filter(id => id !== 251 && adapter.quality(id) < 4);
            const shens = field.filter(id => adapter.isShenmai(id));
            const keeps = [];
            const seenKeeps = new Set();
            const addKeep = ids => {
                const value = sorted(ids).filter(id => field.includes(id));
                if (!value.length || value.length >= slots) return;
                const key = value.join(',');
                if (seenKeeps.has(key)) return;
                seenKeeps.add(key);
                keeps.push(value);
            };
            for (const low of lows) {
                addKeep([low].concat(present));
                addKeep([low].concat(present, shens));
                addKeep([low].concat(shens));
            }
            for (const keep of keeps) {
                let runState = state;
                let segmentCost = 0;
                for (let count = 1; count <= maxRunWashes && canAddWash(); count++) {
                    const washed = adapter.wash(runState, keep);
                    runState = washed.state;
                    segmentCost += Number(washed.cost) || 0;
                    metrics.simulatedWashes++;
                    let positions = [];
                    try {
                        positions = adapter.replaceablePositions(runState, keep);
                    } catch (error) {
                        break;
                    }
                    if (!positions.length) continue;
                    for (const position of positions) {
                        const carrierId = Number(runState.talents[position]);
                        metrics.generatedActions++;
                        let replaced;
                        try {
                            replaced = adapter.replace(runState, position, keep);
                        } catch (error) {
                            metrics.rejectedActions++;
                            continue;
                        }
                        const pills = node.pillsUsed + segmentCost;
                        if (pills > budget) continue;
                        if (bestRoute && pills >= bestRoute.pills) continue;
                        const nextSupport = nextLuckSupport(replaced.state);
                        for (const post of postLockCandidates(
                            adapter, replaced.state, targets, keep,
                            nextSupport ? [nextSupport] : [],
                            Number(replaced.addedId)
                        )) {
                            const steps = [
                                { op: 'locks', lockIds: keep },
                                {
                                    op: 'wash',
                                    keepIds: keep,
                                    count,
                                    cost: segmentCost,
                                },
                                {
                                    op: 'exchange',
                                    carrierId,
                                    lockIds: keep,
                                    removedId: Number(replaced.removedId),
                                    addedId: Number(replaced.addedId),
                                },
                                { op: 'locks', lockIds: post },
                            ];
                            const child = makeNode(
                                node,
                                replaced.state,
                                post,
                                { type: 'carrier-exchange', carrierId, steps },
                                pills,
                                node.washes + count,
                                node.exchangeCount + 1
                            );
                            metrics.acceptedActions++;
                            addCandidate(output, child);
                        }
                    }
                    if (positions.length) break;
                }
            }
        }

        function generateCarrierSupportRuns(node, output) {
            // A support pulse that appears after a locked carrier cannot be
            // moved in front of it in the real UI. Use prepare-first chains.
            return;
            if (!targetOrderActive) return;
            const state = node.engineState;
            const slots = adapter.slotCount(state);
            const held = presentTargets(state, targets);
            const carriers = state.talents.filter(id =>
                adapter.quality(id) === 4
                && !targets.includes(Number(id))
                && !adapter.isShenmai(id)
            );
            const action = node.action || {};
            const addedId = Number(action.addedId || action.target) || 0;
            const orderIndex = activeTargetOrder.indexOf(addedId);
            if (node.parent && node.targetHeldCount > node.parent.targetHeldCount
                && held.includes(addedId)
                && (orderIndex === 0 || orderIndex === 1)
                && !adapter.isShenmai(addedId)
                && !carriers.includes(addedId)) {
                carriers.push(addedId);
            }
            for (const carrierId of carriers) {
                const keep = uniqueNumbers(
                    [carrierId].concat(held)
                ).filter(id => state.talents.includes(id));
                if (keep.length >= slots) continue;
                let runState = state;
                let segmentCost = 0;
                let count = 0;
                let supportId = 0;
                const generated = [];
                const engine = adapter.engineForState(state);
                const carrierType = engine.talentType(carrierId);
                while (count < maxCarrierWait && canAddWash()) {
                    const unitCost = engine.eat + 2 * keep.length - 1;
                    if (node.pillsUsed + segmentCost + unitCost > budget) break;
                    const washed = adapter.wash(runState, keep);
                    runState = washed.state;
                    segmentCost += Number(washed.cost) || 0;
                    count++;
                    metrics.simulatedWashes++;
                    supportId = runState.talents.find(id =>
                        id !== 251
                        && adapter.quality(id) < 4
                        && engine.talentType(id) === carrierType
                    ) || 0;
                    const purples = (washed.generatedEvents || [])
                        .filter(event => adapter.quality(event.id) === 4);
                    purples.forEach(event => generated.push({
                        at: count,
                        id: Number(event.id),
                        fromPity: !!event.fromPity,
                    }));
                    if (supportId || purples.length
                        || washed.pityPurpleId != null) {
                        break;
                    }
                }
                if (!count || !supportId) continue;
                const mask = uniqueNumbers(
                    [supportId, carrierId].concat(held)
                ).filter(id => runState.talents.includes(id));
                const orderedState = adapter.prepareLocks(runState, mask);
                const carrierPosition = orderedState.talents.indexOf(carrierId);
                if (carrierPosition < 0 || mask.length >= slots
                    || !adapter.replaceablePositions(orderedState, mask)
                        .includes(carrierPosition)) {
                    continue;
                }
                let replaced;
                try {
                    replaced = adapter.replace(
                        orderedState, carrierPosition, mask
                    );
                } catch (error) {
                    continue;
                }
                const nextSupport = nextLuckSupport(replaced.state);
                const post = postLockCandidates(
                    adapter, replaced.state, targets, mask,
                    nextSupport ? [nextSupport] : [],
                    Number(replaced.addedId)
                );
                for (const locks of post) {
                    const steps = [
                        { op: 'locks', lockIds: keep },
                        {
                            op: 'wash',
                            keepIds: keep,
                            count,
                            cost: segmentCost,
                            generatedPurples: generated,
                            stopReason: 'support',
                        },
                        { op: 'locks', lockIds: mask },
                        {
                            op: 'exchange',
                            carrierId,
                            lockIds: mask,
                            removedId: Number(replaced.removedId),
                            addedId: Number(replaced.addedId),
                        },
                        { op: 'locks', lockIds: locks },
                    ];
                    const child = makeNode(
                        node,
                        replaced.state,
                        locks,
                        {
                            type: carrierId === addedId
                                ? 'target-burn-chain' : 'carrier-support',
                            carrierId,
                            releasedTargetId: carrierId === addedId
                                ? carrierId : 0,
                            supportId,
                            steps,
                        },
                        node.pillsUsed + segmentCost,
                        node.washes + count,
                        node.exchangeCount + 1
                    );
                    metrics.acceptedActions++;
                    addCandidate(output, child);
                }
            }
        }

        function generateSupportCarrierRuns(node, output) {
            if (!targetOrderActive) return;
            const state = node.engineState;
            const slots = adapter.slotCount(state);
            const held = presentTargets(state, targets);
            const supports = node.lockSet.filter(id =>
                id !== 251 && adapter.quality(id) < 4
            );
            for (const supportId of supports) {
                const engine = adapter.engineForState(state);
                const supportType = engine.talentType(supportId);
                const keep = uniqueNumbers(
                    [supportId].concat(held)
                ).filter(id => state.talents.includes(id));
                if (keep.length >= slots) continue;
                let runState = state;
                let segmentCost = 0;
                let count = 0;
                let carrierId = 0;
                const generated = [];
                while (count < maxCarrierWait && canAddWash()) {
                    const unitCost = engine.eat + 2 * keep.length - 1;
                    if (node.pillsUsed + segmentCost + unitCost > budget) break;
                    const washed = adapter.wash(runState, keep);
                    runState = washed.state;
                    segmentCost += Number(washed.cost) || 0;
                    count++;
                    metrics.simulatedWashes++;
                    for (const event of (washed.generatedEvents || [])) {
                        const id = Number(event.id);
                        if (adapter.quality(id) !== 4
                            || adapter.isShenmai(id)) continue;
                        generated.push({
                            at: count,
                            id,
                            fromPity: !!event.fromPity,
                        });
                        if (engine.talentType(id) === supportType) {
                            carrierId = id;
                            break;
                        }
                    }
                    if (carrierId) break;
                }
                if (!count || !carrierId) continue;
                const mask = uniqueNumbers(
                    [supportId, carrierId].concat(held)
                ).filter(id => runState.talents.includes(id));
                const carrierPosition = runState.talents.indexOf(carrierId);
                const supportPosition = runState.talents.indexOf(supportId);
                if (carrierPosition < 0 || supportPosition < 0
                    || supportPosition > carrierPosition
                    || !adapter.replaceablePositions(runState, mask)
                        .includes(carrierPosition)) {
                    continue;
                }
                let replaced;
                try {
                    replaced = adapter.replace(runState, carrierPosition, mask);
                } catch (error) {
                    continue;
                }
                const nextSupport = nextLuckSupport(replaced.state);
                const post = postLockCandidates(
                    adapter, replaced.state, targets, mask,
                    nextSupport ? [nextSupport] : [],
                    Number(replaced.addedId)
                );
                for (const locks of post) {
                    const steps = [
                        { op: 'locks', lockIds: keep },
                        {
                            op: 'wash',
                            keepIds: keep,
                            count,
                            cost: segmentCost,
                            generatedPurples: generated,
                            stopReason: 'carrier',
                        },
                        { op: 'locks', lockIds: mask },
                        {
                            op: 'exchange',
                            carrierId,
                            lockIds: mask,
                            removedId: Number(replaced.removedId),
                            addedId: Number(replaced.addedId),
                        },
                        { op: 'locks', lockIds: locks },
                    ];
                    const child = makeNode(
                        node,
                        replaced.state,
                        locks,
                        {
                            type: 'support-carrier',
                            carrierId,
                            supportId,
                            steps,
                        },
                        node.pillsUsed + segmentCost,
                        node.washes + count,
                        node.exchangeCount + 1
                    );
                    metrics.acceptedActions++;
                    addCandidate(output, child);
                }
            }
        }

        function generateTargetRuns(node, output, waitLimit, skipCarrierExchanges,
            stopTargetId) {
            const state = node.engineState;
            const slots = adapter.slotCount(state);
            const maxWait = Math.max(1, Math.floor(waitLimit == null
                ? maxTargetConflictWait
                : number(waitLimit, maxTargetConflictWait)));
            const field = new Set(state.talents.map(Number));
            const missing = targets.filter(id => !field.has(Number(id)));
            if (!missing.length) return;
            const held = targets.filter(id => field.has(Number(id)));
            const shens = state.talents.filter(id => adapter.isShenmai(id));
            const lows = state.talents.filter(id =>
                id !== 251 && adapter.quality(id) < 4);
            const masks = [];
            const seen = new Set();
            const add = ids => {
                const value = sorted(ids).filter(id => field.has(Number(id)));
                if (value.length >= slots) return;
                const key = value.join(',');
                if (seen.has(key)) return;
                seen.add(key);
                masks.push(value);
            };
            add(held);
            shens.forEach(id => add(held.concat([id])));
            lows.slice(0, 4).forEach(id => add(held.concat([id])));

            for (const mask of masks.slice(0, 8)) {
                let runState = state;
                let segmentCost = 0;
                let count = 0;
                let hit = 0;
                while (count < maxWait && canAddWash()) {
                    if (node.pillsUsed + segmentCost + adapter.engineForState(runState).eat > budget) break;
                    if (bestRoute
                        && node.pillsUsed + segmentCost
                            >= bestRoute.pills) break;
                    const washed = adapter.wash(runState, mask);
                    runState = washed.state;
                    segmentCost += Number(washed.cost) || 0;
                    count++;
                    metrics.simulatedWashes++;
                    const found = missing.find(id =>
                        runState.talents.includes(id)) || 0;
                    if (found
                        && (!stopTargetId
                            || found === Number(stopTargetId))) {
                        hit = found;
                        break;
                    }
                }
                if (!hit) continue;
                const pills = node.pillsUsed + segmentCost;
                if (pills > budget) continue;
                if (bestRoute && pills >= bestRoute.pills) continue;
                const steps = [
                    { op: 'locks', lockIds: mask },
                    {
                        op: 'wash',
                        keepIds: mask,
                        count,
                        cost: segmentCost,
                        target: hit,
                    },
                ];
                const child = makeNode(
                    node,
                    runState,
                    mask,
                    { type: 'target-run', target: hit, steps },
                    pills,
                    node.washes + count,
                    node.exchangeCount
                );
                metrics.acceptedActions++;
                addCandidate(output, child);
                if (child.targetHeldCount >= 2 && !skipCarrierExchanges) {
                    generateTargetCarrierExchanges(child, output);
                }
            }
        }

        function generateTargetWithConflictRuns(node, output) {
            const state = node.engineState;
            const held = presentTargets(state, targets);
            const missing = targets.filter(id => !state.talents.includes(id));
            const slots = adapter.slotCount(state);
            for (const targetId of missing) {
                const targetType = adapter.engineForState(state).talentType(targetId);
                let runState = state;
                let cost = 0;
                let count = 0;
                const starts = [];
                const startKeys = new Set();
                const addStart = (conflictId, atState, atCount, atCost) => {
                    if (!conflictId || atState.talents.includes(targetId)) return;
                    const key = conflictId + '|' + atCount;
                    if (startKeys.has(key)) return;
                    startKeys.add(key);
                    starts.push({ conflictId, state: atState, count: atCount, cost: atCost });
                };
                const initialConflict = runState.talents.find(id =>
                    id !== 251 && adapter.quality(id) < 4
                    && adapter.engineForState(runState).talentType(id) === targetType
                );
                if (initialConflict) addStart(initialConflict, runState, 0, 0);
                while (count < maxTargetConflictWait && canAddWash()
                    && !runState.talents.includes(targetId) && held.length < slots) {
                    const washed = adapter.wash(runState, held);
                    runState = washed.state;
                    cost += Number(washed.cost) || 0;
                    count++;
                    metrics.simulatedWashes++;
                    const conflictNow = runState.talents.find(id =>
                        id !== 251 && adapter.quality(id) < 4
                        && adapter.engineForState(runState).talentType(id) === targetType
                    );
                    if (conflictNow) {
                        addStart(conflictNow, runState, count, cost);
                    }
                }

                const variants = [];
                if (runState.talents.includes(targetId)) {
                    variants.push({
                        state: runState,
                        locks: held,
                        count,
                        cost,
                        conflictId: 0,
                        splitCount: count,
                        splitCost: cost,
                    });
                }
                const selectedStarts = starts.length > 10
                    ? starts.slice(0, 2).concat(starts.slice(-8))
                    : starts;
                for (const start of selectedStarts) {
                    const mask = uniqueNumbers(held.concat([start.conflictId]));
                    let after = start.state;
                    let extraCost = 0;
                    let extraCount = 0;
                    while (extraCount < maxTargetConflictWait && canAddWash()
                        && !after.talents.includes(targetId)) {
                        const washed = adapter.wash(after, mask);
                        after = washed.state;
                        extraCost += Number(washed.cost) || 0;
                        extraCount++;
                        metrics.simulatedWashes++;
                    }
                    if (!after.talents.includes(targetId)) continue;
                    variants.push({
                        state: after,
                        locks: mask,
                        count: start.count + extraCount,
                        cost: start.cost + extraCost,
                        conflictId: start.conflictId,
                        splitCount: start.count,
                        splitCost: start.cost,
                    });
                }
                for (const variant of variants) {
                    const pills = node.pillsUsed + variant.cost;
                    if (pills > budget || (bestRoute && pills >= bestRoute.pills)) continue;
                    const steps = [];
                    if (variant.splitCount > 0) {
                        steps.push({
                            op: 'wash',
                            keepIds: held,
                            count: variant.splitCount,
                            cost: variant.splitCost,
                        });
                    }
                    if (variant.conflictId) {
                        steps.push({ op: 'locks', lockIds: variant.locks });
                        steps.push({
                            op: 'wash',
                            keepIds: variant.locks,
                            count: variant.count - variant.splitCount,
                            cost: variant.cost - variant.splitCost,
                            target: targetId,
                            conflictId: variant.conflictId,
                        });
                    } else if (!steps.length) {
                        steps.push({
                            op: 'wash',
                            keepIds: held,
                            count: variant.count,
                            cost: variant.cost,
                            target: targetId,
                        });
                    }
                    const child = makeNode(
                        node,
                        variant.state,
                        variant.locks,
                        {
                            type: 'target-with-conflict',
                            target: targetId,
                            conflictId: variant.conflictId,
                            steps,
                        },
                        pills,
                        node.washes + variant.count,
                        node.exchangeCount
                    );
                    metrics.acceptedActions++;
                    addCandidate(output, child);
                    if (child.targetHeldCount >= 2) {
                        generateTargetCarrierExchanges(child, output);
                    }
                }
            }
        }

        function generateTargetCarrierExchanges(node, output) {
            if (node.targetHeldCount < 1) return;
            const state = node.engineState;
            const field = new Set(state.talents.map(Number));
            const held = targets.filter(id => field.has(Number(id)));
            if (!held.length) return;
            for (const targetId of held) {
                if (root.__WASH_SEARCH_TRACE && node.pillsUsed < 1000) {
                    console.log('[WashSearchV2][sacrifice] start target='
                        + nameOf(targetId) + ' field=' + state.talents.map(nameOf).join('/')
                        + ' pills=' + node.pillsUsed);
                }
                let runState = state;
                let conflictMask = null;
                let segmentCost = 0;
                let count = 0;
                const heldMask = held.filter(id => runState.talents.includes(id));
                for (let attempt = 0; attempt <= maxCarrierWait && canAddWash(); attempt++) {
                    const position = runState.talents.indexOf(targetId);
                    if (position < 0) break;
                    conflictMask = conflictMaskForCarrier(runState, position, heldMask);
                    const targetType = adapter.engineForState(runState).talentType(targetId);
                    if (conflictMask
                        && runState.talents.some((id, index) =>
                            index < position && id !== 251
                            && adapter.quality(id) < 4
                            && adapter.engineForState(runState).talentType(id) === targetType)) {
                        break;
                    }
                    const keep = held.filter(id => runState.talents.includes(id));
                    if (keep.length >= adapter.slotCount(runState)) break;
                    const washed = adapter.wash(runState, keep);
                    runState = washed.state;
                    segmentCost += Number(washed.cost) || 0;
                    count++;
                    metrics.simulatedWashes++;
                }
                const position = runState.talents.indexOf(targetId);
                if (position < 0) continue;
                conflictMask = conflictMaskForCarrier(runState, position, held);
                let move = null;
                try {
                    move = adapter.exchangeMoves(runState, conflictMask || [])
                        .find(item => item.carrierId === targetId) || null;
                } catch (error) {
                    move = null;
                }
                if (!conflictMask || !move) {
                    if (root.__WASH_SEARCH_TRACE && node.pillsUsed < 1000) {
                        console.log('[WashSearchV2][sacrifice] blocked target='
                            + nameOf(targetId) + ' conflict='
                            + (conflictMask || []).map(nameOf).join('/')
                            + ' washes=' + count + ' field='
                            + runState.talents.map(nameOf).join('/'));
                    }
                    continue;
                }
                if (root.__WASH_SEARCH_TRACE && node.pillsUsed < 1000) {
                    console.log('[WashSearchV2][sacrifice] ready target='
                        + nameOf(targetId) + ' conflict='
                        + conflictMask.map(nameOf).join('/') + ' washes=' + count
                        + ' field=' + runState.talents.map(nameOf).join('/'));
                }
                const pills = node.pillsUsed + segmentCost;
                if (pills > budget || (bestRoute && pills >= bestRoute.pills)) continue;
                metrics.generatedActions++;
                let replaced;
                try {
                    replaced = adapter.replace(move.state, move.position, conflictMask);
                } catch (error) {
                    metrics.rejectedActions++;
                    continue;
                }
                const steps = [];
                if (count) {
                    steps.push({ op: 'locks', lockIds: held });
                    steps.push({
                        op: 'wash',
                        keepIds: held,
                        count,
                        cost: segmentCost,
                    });
                }
                steps.push({ op: 'locks', lockIds: conflictMask });
                steps.push({
                    op: 'exchange',
                    carrierId: targetId,
                    lockIds: conflictMask,
                    removedId: Number(replaced.removedId),
                    addedId: Number(replaced.addedId),
                });
                const nextSupport = nextLuckSupport(replaced.state);
                for (const post of postLockCandidates(
                    adapter, replaced.state, targets, conflictMask,
                    nextSupport ? [nextSupport] : [],
                    Number(replaced.addedId)
                )) {
                    const childSteps = steps.concat([
                        { op: 'locks', lockIds: post },
                    ]);
                    const child = makeNode(
                        node,
                        replaced.state,
                        post,
                        { type: 'target-carrier', carrierId: targetId, steps: childSteps },
                        pills,
                        node.washes + count,
                        node.exchangeCount + 1
                    );
                    metrics.acceptedActions++;
                    addCandidate(output, child);
                    generateTargetRuns(child, output);
                    advanceTicketChain(
                        node, replaced.state, post, childSteps, pills,
                        node.washes + count, node.exchangeCount + 1,
                        Number(replaced.addedId), output
                    );
                }
            }
        }

        function generateExchangeClosure(node, masks, output) {
            const localSeen = new Set([node.stateKey]);
            const stack = [{
                state: node.engineState,
                locks: node.lockSet.slice(),
                steps: [],
                exchanges: 0,
            }];
            let guard = 0;
            while (stack.length && guard++ < 500) {
                const branch = stack.pop();
                if (branch.exchanges >= 10) continue;
                const branchMasks = usefulLockMasks(
                    adapter, branch.state, targets, branch.locks, maxLockMasks
                ).concat(masks);
                const maskSeen = new Set();
                for (const mask of branchMasks) {
                    const maskKey = sorted(mask).join(',');
                    if (maskSeen.has(maskKey)) continue;
                    maskSeen.add(maskKey);
                    let positions = [];
                    try {
                        positions = adapter.replaceablePositions(branch.state, mask);
                    } catch (error) {
                        continue;
                    }
                    for (const position of positions) {
                        metrics.generatedActions++;
                        const carrierId = Number(branch.state.talents[position]);
                        let replaced;
                        try {
                            replaced = adapter.replace(branch.state, position, mask);
                        } catch (error) {
                            metrics.rejectedActions++;
                            continue;
                        }
                        const nextSupport = nextLuckSupport(replaced.state);
                        for (const post of postLockCandidates(
                            adapter, replaced.state, targets, mask,
                            nextSupport ? [nextSupport] : [],
                            Number(replaced.addedId)
                        )) {
                            const key = childKey(replaced.state, post);
                            if (localSeen.has(key)) continue;
                            localSeen.add(key);
                            const steps = branch.steps.concat([
                                { op: 'locks', lockIds: sorted(mask) },
                                {
                                    op: 'exchange',
                                    carrierId,
                                    lockIds: sorted(mask),
                                    removedId: Number(replaced.removedId),
                                    addedId: Number(replaced.addedId),
                                },
                                { op: 'locks', lockIds: post },
                            ]);
                            const child = makeNode(
                                node,
                                replaced.state,
                                post,
                                {
                                    type: 'exchange-closure',
                                    carrierId,
                                    steps,
                                },
                                node.pillsUsed,
                                node.washes,
                                node.exchangeCount + branch.exchanges + 1
                            );
                            metrics.acceptedActions++;
                            addCandidate(output, child);
                            stack.push({
                                state: replaced.state,
                                locks: post,
                                steps,
                                exchanges: branch.exchanges + 1,
                            });
                        }
                    }
                }
            }
        }

        function generateUpgrade(node, output) {
            if (Number(node.engineState.zizhi) >= 154) return;
            metrics.generatedActions++;
            const state = adapter.upgradeFour(node.engineState);
            const locks = node.lockSet.filter(id => state.talents.includes(id));
            const child = makeNode(
                node, state, locks, {
                    type: 'upgrade',
                    steps: [{
                        op: 'upgrade',
                        fromZizhi: Number(node.engineState.zizhi),
                        toZizhi: 154,
                    }],
                },
                node.pillsUsed,
                node.washes,
                node.exchangeCount
            );
            metrics.acceptedActions++;
            addCandidate(output, child);
        }

        function expand(node) {
            const output = new Map();
            if (node.targetHeldCount === 1) {
                generateTargetWithConflictRuns(node, output);
            }
            const masks = usefulLockMasks(
                adapter, node.engineState, targets, node.lockSet, maxLockMasks
            );
            const runMasks = masks.slice(0, maxRunLockMasks);
            generateExchanges(node, masks, output);
            generateExchangeClosure(node, masks, output);
            generateExchangePads(node, output);
            generateCarrierExchangeMacro(node, output);
            generateTargetCarrierExchanges(node, output);
            generateTargetRuns(node, output);
            generateUpgrade(node, output);
            generateWashOne(node, masks, output);
            generateWashRun(node, runMasks, output);
            return Array.from(output.values());
        }

        function greedyRollout(start) {
            let current = start;
            const seen = new Set([start.stateKey]);
            for (let depth = 0; depth < 40 && !stopped; depth++) {
                if (targetStats(current.engineState, targets) === targets.length) {
                    rememberBest(current);
                    return current;
                }
                const cap = capReached();
                if (cap) {
                    stopped = true;
                    stopReason = cap;
                    return current;
                }
                const children = expand(current).filter(child => !seen.has(child.stateKey));
                if (!children.length) return current;
                const actionRank = child => {
                    const type = child.action && child.action.type;
                    if (type === 'target-with-conflict') return 100;
                    if (type === 'ticket-chain') return 95;
                    if (type === 'target-carrier') return 90;
                    if (type === 'carrier-exchange') return 80;
                    if (type === 'target-run') return 70;
                    if (type === 'exchange-pad') return 60;
                    if (type === 'exchange-closure' || type === 'exchange') return 50;
                    if (type === 'wash-run') return 30;
                    return 10;
                };
                children.sort((a, b) =>
                    (b.targetHeldCount - a.targetHeldCount)
                    || (actionRank(b) - actionRank(a))
                    || (a.pillsUsed - b.pillsUsed)
                    || (a.washes - b.washes));
                current = children[0];
                seen.add(current.stateKey);
                metrics.expandedNodes++;
                if (root.__WASH_SEARCH_TRACE) {
                    console.log('[WashSearchV2][greedy] depth=' + depth
                        + ' action=' + (current.action && current.action.type)
                        + ' targets=' + current.targetHeldCount
                        + ' pills=' + current.pillsUsed
                        + ' washes=' + current.washes
                        + ' field=' + current.engineState.talents.map(nameOf).join('/'));
                }
            }
            return current;
        }

        function expandPolicyStep(node, preferSacrifice, depth, output,
            preferDirectTargets, preferWaitAfterTwoExchanges,
            preferredTargetId) {
            if (node.targetHeldCount <= 0) {
                if (depth === 0) {
                    generateWashRun(node, [[]], output);
                } else if (preferWaitAfterTwoExchanges
                    && node.exchangeCount === 0) {
                    generateExchangePads(node, output, true, 3, true);
                } else if (preferWaitAfterTwoExchanges
                    && node.exchangeCount === 1) {
                    generateExchanges(
                        node,
                        usefulLockMasks(
                            adapter, node.engineState, targets,
                            node.lockSet, maxLockMasks
                        ),
                        output
                    );
                } else if (preferWaitAfterTwoExchanges
                    && preferDirectTargets) {
                    generateTargetRuns(
                        node, output, maxTargetWait, true,
                        Number(preferredTargetId) || 0
                    );
                } else if (preferDirectTargets) {
                    generateTargetRuns(node, output, maxTargetWait, true);
                } else {
                    generateExchangePads(node, output, true);
                    generateTargetRuns(node, output);
                }
            } else if (node.targetHeldCount === 1) {
                if (!preferDirectTargets && preferSacrifice && depth === 0) {
                    generateWashRun(node, [[]], output);
                }
                if (!preferDirectTargets) {
                    generateTargetWithConflictRuns(node, output);
                }
                generateTargetRuns(
                    node, output, preferDirectTargets ? maxTargetWait : null,
                    preferDirectTargets,
                    preferDirectTargets
                        && preferWaitAfterTwoExchanges
                        && node.targetHeldCount === 0
                        ? Number(preferredTargetId) || 0 : 0
                );
            } else if (node.targetHeldCount === 2) {
                if (!preferDirectTargets) {
                    generateTargetCarrierExchanges(node, output);
                }
                generateTargetRuns(
                    node, output, preferDirectTargets ? maxTargetWait : null,
                    preferDirectTargets
                );
            } else {
                generateTargetRuns(node, output);
            }
            return Array.from(output.values());
        }

        function policyRollout(start, preferInitialSacrifice, preferredTargetId,
            allowTargetSacrifice, preferDirectTargets,
            preferWaitAfterTwoExchanges, washBudget) {
            let current = start;
            const seen = new Set([start.stateKey]);
            const policyWashStop = metrics.simulatedWashes
                + Math.max(
                    1,
                    Number(washBudget) || maxPolicyWashes
                );
            for (let depth = 0; depth < 50 && !stopped; depth++) {
                if (targetStats(current.engineState, targets) === targets.length) {
                    rememberBest(current);
                    return current;
                }
                if (metrics.simulatedWashes >= policyWashStop) return current;
                const cap = capReached();
                if (cap) {
                    stopped = true;
                    stopReason = cap;
                    return current;
                }
                const children = expandPolicyStep(
                    current, preferInitialSacrifice, depth, new Map(),
                    preferDirectTargets
                        || (preferWaitAfterTwoExchanges
                            && current.exchangeCount >= 2),
                    preferWaitAfterTwoExchanges,
                    preferredTargetId
                ).filter(child => !seen.has(child.stateKey));
                if (!children.length) return current;
                const typeOf = child => child.action && child.action.type || '';
                if (root.__WASH_SEARCH_TRACE
                    && preferWaitAfterTwoExchanges
                    && current.targetHeldCount === 0) {
                    console.log('[WashSearchV2][wait-children] depth=' + depth
                        + ' exchanges=' + current.exchangeCount + ' '
                        + children.slice(0, 16).map(child =>
                            `${typeOf(child)}:${child.targetHeldCount}:`
                            + `${child.exchangeCount}:${child.pillsUsed}`)
                            .join(' | '));
                }
                if (root.__WASH_SEARCH_TRACE && current.action
                    && current.action.type === 'ticket-chain') {
                    console.log('[WashSearchV2][policy-children] '
                        + children.slice(0, 20).map(child =>
                            `${typeOf(child)}:${child.targetHeldCount}:${child.pillsUsed}`)
                            .join(' | '));
                }
                let pool = [];
                const directNow = preferDirectTargets
                    || (preferWaitAfterTwoExchanges
                        && current.exchangeCount >= 2);
                if (current.targetHeldCount <= 0) {
                    if (preferWaitAfterTwoExchanges
                        && current.exchangeCount === 0) {
                        pool = children.filter(child =>
                            typeOf(child) === 'exchange-pad'
                            && Number(child.action && child.action.pad) > 0)
                            .sort((a, b) =>
                                (Number(a.action.pad) - Number(b.action.pad))
                                || (a.pillsUsed - b.pillsUsed));
                    }
                    if (directNow) {
                        const directPool = children.filter(child =>
                            typeOf(child) === 'target-run');
                        if (directPool.length) pool = directPool;
                    }
                    if (!pool.length && preferWaitAfterTwoExchanges) {
                        pool = children.filter(child =>
                            child.targetHeldCount === 0
                            && child.exchangeCount >= 2)
                            .sort((a, b) => (a.pillsUsed - b.pillsUsed)
                                || (a.exchangeCount - b.exchangeCount));
                    }
                    if (!pool.length) {
                        pool = children.filter(child => child.targetHeldCount <= 1
                            && (child.ticketCarrier || typeOf(child) === 'ticket-chain'));
                    }
                    if (!pool.length) {
                        pool = children.filter(child => child.ticketCarrier);
                    }
                } else if (current.targetHeldCount === 1) {
                    if (preferDirectTargets) {
                        pool = children.filter(child =>
                            typeOf(child) === 'target-run'
                            && child.targetHeldCount >= current.targetHeldCount);
                    }
                    if (preferInitialSacrifice && depth === 0) {
                        const sacrificed = children.filter(child =>
                            child.targetHeldCount === 0 && child.ticketCarrier)
                            .sort((a, b) => (a.pillsUsed - b.pillsUsed));
                        if (!pool.length) pool = sacrificed;
                    }
                    if (!pool.length) pool = children.filter(child => child.targetHeldCount >= 2)
                        .sort((a, b) => {
                            const rank = child => typeOf(child) === 'target-with-conflict' ? 2
                                : typeOf(child) === 'ticket-chain' ? 1 : 0;
                            return (rank(b) - rank(a)) || (a.pillsUsed - b.pillsUsed);
                        });
                    if (!pool.length) {
                        pool = children.filter(child => typeOf(child) === 'target-with-conflict'
                            || typeOf(child) === 'ticket-chain'
                            || typeOf(child) === 'target-run');
                    }
                    if (!pool.length) {
                        pool = children.filter(child => child.targetHeldCount === 0
                            && child.ticketCarrier)
                            .sort((a, b) => (a.pillsUsed - b.pillsUsed));
                    }
                } else if (current.targetHeldCount === 2) {
                    if (preferDirectTargets) {
                        pool = children.filter(child =>
                            typeOf(child) === 'target-run'
                            && child.targetHeldCount >= current.targetHeldCount);
                    }
                    if (!pool.length && allowTargetSacrifice) {
                        pool = children.filter(child =>
                            typeOf(child) === 'target-carrier');
                    }
                    if (!pool.length) {
                        pool = children.filter(child => child.targetHeldCount >= 3
                            || typeOf(child) === 'target-with-conflict'
                            || typeOf(child) === 'target-run');
                    }
                } else {
                    pool = children.filter(child => child.targetHeldCount >= current.targetHeldCount)
                        .sort((a, b) => (b.targetHeldCount - a.targetHeldCount)
                            || (a.pillsUsed - b.pillsUsed));
                }
                if (!pool.length) return current;
                pool.sort((a, b) => (b.targetHeldCount - a.targetHeldCount)
                    || ((typeOf(b) === 'target-with-conflict' ? 3
                        : typeOf(b) === 'ticket-chain' ? 2
                            : typeOf(b) === 'target-carrier' ? 1 : 0)
                        - (typeOf(a) === 'target-with-conflict' ? 3
                            : typeOf(a) === 'ticket-chain' ? 2
                                : typeOf(a) === 'target-carrier' ? 1 : 0))
                    || (((typeOf(b) === 'target-with-conflict'
                        && Number(b.action && b.action.target) === Number(preferredTargetId)) ? 1 : 0)
                        - ((typeOf(a) === 'target-with-conflict'
                            && Number(a.action && a.action.target) === Number(preferredTargetId)) ? 1 : 0))
                    || (((b.action && Number(b.action.conflictId) > 0) ? 1 : 0)
                        - ((a.action && Number(a.action.conflictId) > 0) ? 1 : 0))
                    || (a.pillsUsed - b.pillsUsed)
                    || (a.washes - b.washes));
                current = pool[0];
                seen.add(current.stateKey);
                metrics.expandedNodes++;
                if (root.__WASH_SEARCH_TRACE) {
                    console.log('[WashSearchV2][policy] depth=' + depth
                        + ' action=' + typeOf(current)
                        + ' targets=' + current.targetHeldCount
                        + ' pills=' + current.pillsUsed
                        + ' washes=' + current.washes
                        + ' field=' + current.engineState.talents.map(nameOf).join('/'));
                }
            }
            return current;
        }

        function chainChildren(current, lookAheadNatural, lockedTargetsOnly) {
            const output = new Map();
            generateFinalTargetWait(current, output);
            generateReleaseRecaptureRuns(current, output);
            if (Number(current.engineState.zizhi) < 154) {
                generateUpgrade(current, output);
            }
            generatePrepareRun(
                current, output, !!lookAheadNatural, !!lockedTargetsOnly
            );
            generateSupportCarrierRuns(current, output);
            generateCarrierSupportRuns(current, output);
            const masks = usefulLockMasks(
                adapter, current.engineState, targets,
                current.lockSet, maxLockMasks
            );
            generateExchanges(current, masks, output);
            return Array.from(output.values());
        }

        function generateReleaseRecaptureRuns(node, output) {
            const action = node.action || {};
            const justAcquired = !!node.parent
                && node.targetHeldCount > node.parent.targetHeldCount;
            if (!targetOrderActive || (targetPlanMode !== 'backward'
                && !Object.keys(desiredTargetAnchors).length)
                || (!justAcquired && action.type !== 'release-recapture')
                || node.targetHeldCount <= 0
                || node.targetHeldCount >= targets.length) {
                return;
            }
            const state = node.engineState;
            const held = presentTargets(state, targets);
            const addedId = Number(
                action.addedId || action.target || action.releaseId
            ) || 0;
            const orderIndex = activeTargetOrder.indexOf(addedId);
            const releaseIds = addedId && held.includes(addedId)
                && (orderIndex === 0 || orderIndex === 1)
                ? [addedId] : [];
            for (const releaseId of releaseIds) {
                const keep = held.filter(id => Number(id) !== Number(releaseId));
                if (keep.length >= adapter.slotCount(state)) continue;
                let runState = state;
                let segmentCost = 0;
                let count = 0;
                let releasedAt = 0;
                let wasPresent = runState.talents.includes(Number(releaseId));
                const occurrences = [];
                const generated = [];
                const pityPurples = [];
                const waitLimit = Math.min(maxTargetWait, 1800);
                while (count < waitLimit && canAddWash()) {
                    const unitCost = adapter.engineForState(runState).eat
                        + 2 * keep.length - 1;
                    if (node.pillsUsed + segmentCost + unitCost > budget) break;
                    const washed = adapter.wash(runState, keep);
                    runState = washed.state;
                    segmentCost += Number(washed.cost) || 0;
                    count++;
                    metrics.simulatedWashes++;
                    (washed.generatedEvents || [])
                        .filter(event => adapter.quality(event.id) === 4)
                        .forEach(event => generated.push({
                            at: count,
                            id: Number(event.id),
                            fromPity: !!event.fromPity,
                        }));
                    if (washed.pityPurpleId != null) {
                        pityPurples.push({
                            at: count,
                            id: Number(washed.pityPurpleId),
                        });
                    }
                    if (!releasedAt
                        && !runState.talents.includes(Number(releaseId))) {
                        releasedAt = count;
                    }
                    const isPresent = runState.talents.includes(Number(releaseId));
                    if (releasedAt && isPresent && !wasPresent) {
                        occurrences.push({
                            state: Object.assign({}, runState, {
                                talents: runState.talents.slice(),
                            }),
                            count,
                            cost: segmentCost,
                            generated: generated.slice(),
                            pityPurples: pityPurples.slice(),
                        });
                        if (occurrences.length >= 4) break;
                    }
                    wasPresent = isPresent;
                }
                if (!releasedAt || !occurrences.length) continue;
                occurrences.forEach((occurrence, occurrenceIndex) => {
                    const locks = uniqueNumbers(keep.concat([releaseId]))
                        .filter(id => occurrence.state.talents.includes(id));
                    const steps = [
                        { op: 'locks', lockIds: keep },
                        {
                            op: 'wash',
                            keepIds: keep,
                            count: occurrence.count,
                            cost: occurrence.cost,
                            generatedPurples: occurrence.generated,
                            pityPurples: occurrence.pityPurples,
                            releasedTargetId: releaseId,
                            releasedAt,
                            recapturedAt: occurrence.count,
                            stopReason: 'release-recapture',
                        },
                        { op: 'locks', lockIds: locks },
                    ];
                    const child = makeNode(
                        node,
                        occurrence.state,
                        locks,
                        {
                            type: 'release-recapture',
                            releaseId,
                            releasedAt,
                            recapturedAt: occurrence.count,
                            occurrenceIndex,
                            steps,
                        },
                        node.pillsUsed + occurrence.cost,
                        node.washes + occurrence.count,
                        node.exchangeCount
                    );
                    if (root.__WASH_SEARCH_TRACE) {
                        console.log('[WashSearchV2][release-recapture] '
                            + nameOf(releaseId)
                            + ' releasedAt=' + releasedAt
                            + ' recapturedAt=' + occurrence.count
                            + ' occurrence=' + (occurrenceIndex + 1)
                            + ' pills=' + child.pillsUsed
                            + ' washes=' + child.washes);
                    }
                    metrics.releaseRecaptureActions++;
                    metrics.acceptedActions++;
                    addCandidate(output, child);
                });
            }
        }

        function generateFinalTargetWait(node, output) {
            if (!targetOrderActive) return;
            const state = node.engineState;
            const held = presentTargets(state, targets);
            const missing = targets.filter(id => !held.includes(id));
            if (held.length !== targets.length - 1 || missing.length !== 1) return;
            const targetId = missing[0];
            const keep = held.filter(id => state.talents.includes(id));
            if (keep.length >= adapter.slotCount(state)) return;
            let runState = state;
            let segmentCost = 0;
            let count = 0;
            const generated = [];
            const pityPurples = [];
            while (count < maxTargetWait && canAddWash()) {
                const unitCost = adapter.engineForState(runState).eat
                    + 2 * keep.length - 1;
                if (node.pillsUsed + segmentCost + unitCost > budget) break;
                const washed = adapter.wash(runState, keep);
                runState = washed.state;
                segmentCost += Number(washed.cost) || 0;
                count++;
                metrics.simulatedWashes++;
                (washed.generatedEvents || [])
                    .filter(event => adapter.quality(event.id) === 4)
                    .forEach(event => generated.push({
                        at: count,
                        id: Number(event.id),
                        fromPity: !!event.fromPity,
                    }));
                if (washed.pityPurpleId != null) {
                    pityPurples.push({
                        at: count,
                        id: Number(washed.pityPurpleId),
                    });
                }
                if (runState.talents.includes(targetId)) break;
            }
            if (!count || !runState.talents.includes(targetId)) return;
            const steps = [
                { op: 'locks', lockIds: keep },
                {
                    op: 'wash',
                    keepIds: keep,
                    count,
                    cost: segmentCost,
                    generatedPurples: generated,
                    pityPurples,
                    target: targetId,
                },
            ];
            const child = makeNode(
                node,
                runState,
                keep,
                { type: 'final-target-wait', target: targetId, steps },
                node.pillsUsed + segmentCost,
                node.washes + count,
                node.exchangeCount
            );
            metrics.acceptedActions++;
            addCandidate(output, child);
        }

        function chainPolicyRollout(start, washBudget, diversify, targetOrder,
            planMode) {
            activeTargetOrder = targetOrder && targetOrder.length === targets.length
                ? targetOrder.slice() : targets.slice();
            targetOrderActive = !!targetOrder;
            targetPlanMode = targetOrder ? (planMode || 'forward') : '';
            start = makeNode(
                start.parent,
                start.engineState,
                start.lockSet,
                start.action,
                start.pillsUsed,
                start.washes,
                start.exchangeCount
            );
            let frontier = [start];
            const seen = new Set([start.stateKey]);
            const washStop = metrics.simulatedWashes
                + Math.max(1, Number(washBudget) || maxPolicyWashes);
            for (let depth = 0; depth < 80 && !stopped; depth++) {
                if (metrics.simulatedWashes >= washStop) break;
                const cap = capReached();
                if (cap) {
                    stopped = true;
                    stopReason = cap;
                    break;
                }
                const next = new Map();
                for (const current of frontier) {
                    if (targetStats(current.engineState, targets) === targets.length) {
                        rememberBest(current);
                        continue;
                    }
                    for (const child of chainChildren(current, false, false)) {
                        if (seen.has(child.stateKey)) continue;
                        seen.add(child.stateKey);
                        const existing = next.get(child.stateKey);
                        if (!existing
                            || compareNodes(child, existing, targets.length) < 0) {
                            next.set(child.stateKey, child);
                        }
                        if (targetStats(child.engineState, targets) === targets.length) {
                            rememberBest(child);
                        }
                    }
                }
                const children = Array.from(next.values());
                metrics.expandedNodes += frontier.length;
                if (!children.length) break;
                const typeOf = child => child.action && child.action.type || '';
                if (root.__WASH_SEARCH_TRACE) {
                    console.log('[WashSearchV2][chain-children] depth=' + depth + ' '
                        + children.slice(0, 16).map(child =>
                            `${typeOf(child)}:${child.targetHeldCount}:`
                            + `${child.nextTargetDistance}:${child.chainHitsNext8}:`
                            + `${child.pillsUsed}`).join(' | '));
                }
                children.sort((a, b) =>
                    (Number(!!b.targetOrderExplicit)
                        - Number(!!a.targetOrderExplicit))
                    || (b.targetOrderExplicit
                        ? (b.targetOrderProgress - a.targetOrderProgress)
                            || ((a.targetHeldCount - a.targetOrderProgress)
                                - (b.targetHeldCount - b.targetOrderProgress))
                        : 0)
                    || ((b.anchorShiftCount || 0) - (a.anchorShiftCount || 0))
                    || (b.targetHeldCount - a.targetHeldCount)
                    || ((!a.targetOrderExplicit
                        ? a.nextTargetDistance
                        : a.nextOrderTargetDistance == null
                        ? a.nextTargetDistance : a.nextOrderTargetDistance)
                        - (!b.targetOrderExplicit
                            ? b.nextTargetDistance
                            : b.nextOrderTargetDistance == null
                            ? b.nextTargetDistance : b.nextOrderTargetDistance))
                    || (b.chainHitsNext8 - a.chainHitsNext8)
                    || ((typeOf(b) === 'exchange' ? 1 : 0)
                        - (typeOf(a) === 'exchange' ? 1 : 0))
                    || (a.pillsUsed - b.pillsUsed)
                    || (a.washes - b.washes)
                );
                frontier = diversify
                    ? selectChainPortfolio(
                        children, chainBeamWidth * 2, targets.length
                    )
                    : children.slice(0, chainBeamWidth);
                if (root.__WASH_SEARCH_TRACE) {
                    console.log('[WashSearchV2][chain-policy] depth=' + depth
                        + ' frontier=' + frontier.length
                        + ' top=' + frontier.slice(0, 5).map(current =>
                            `${typeOf(current)}:${current.targetHeldCount}:`
                            + `${current.nextTargetDistance}:${current.pillsUsed}:`
                            + current.engineState.talents.map(nameOf).join('/')
                        ).join(' || '));
                }
            }
            activeTargetOrder = targets.slice();
            targetOrderActive = false;
            targetPlanMode = '';
            return frontier[0] || start;
        }

        function chainFollowRollout(start, washBudget) {
            let current = start;
            const seen = new Set([start.stateKey]);
            const washStop = metrics.simulatedWashes
                + Math.max(1, Number(washBudget) || maxPolicyWashes);
            for (let depth = 0; depth < 60 && !stopped; depth++) {
                if (metrics.simulatedWashes >= washStop) return current;
                if (targetStats(current.engineState, targets) === targets.length) {
                    rememberBest(current);
                    return current;
                }
                const cap = capReached();
                if (cap) {
                    stopped = true;
                    stopReason = cap;
                    return current;
                }
                const desired = nextAllowedPurple(current.engineState);
                const output = new Map();
                generatePrepareRun(current, output, true);
                const masks = usefulLockMasks(
                    adapter, current.engineState, targets,
                    current.lockSet, maxLockMasks
                );
                generateExchanges(current, masks, output);
                const children = Array.from(output.values())
                    .filter(child => !seen.has(child.stateKey));
                if (!children.length) return current;
                const typeOf = child => child.action && child.action.type || '';
                const desiredAdded = child =>
                    Number(child.action && child.action.addedId)
                    === Number(desired);
                const desiredPresent = child =>
                    desired && child.engineState.talents.includes(desired);
                const afterExchange = current.action
                    && current.action.type === 'exchange';
                const hasPrepare = children.some(child =>
                    typeOf(child) === 'wash-prepare');
                const prepareWash = child => {
                    const wash = (child.action && child.action.steps || [])
                        .find(step => step.op === 'wash');
                    return wash ? Number(wash.count) || 0 : 0;
                };
                const ranked = afterExchange
                    ? children.filter(child => typeOf(child) !== 'exchange')
                    : children;
                if (!ranked.length) return current;
                ranked.sort((a, b) => {
                    if (hasPrepare) {
                        const prepareOrder =
                            (typeOf(b) === 'wash-prepare' ? 1 : 0)
                            - (typeOf(a) === 'wash-prepare' ? 1 : 0);
                        if (prepareOrder) return prepareOrder;
                        if (typeOf(a) === 'wash-prepare'
                            && typeOf(b) === 'wash-prepare') {
                            const washOrder = prepareWash(b) - prepareWash(a);
                            if (washOrder) return washOrder;
                        }
                    }
                    return (b.targetHeldCount - a.targetHeldCount)
                    || (Number(desiredPresent(b)) - Number(desiredPresent(a)))
                    || (Number(desiredAdded(b)) - Number(desiredAdded(a)))
                    || (a.nextTargetDistance - b.nextTargetDistance)
                    || (a.pillsUsed - b.pillsUsed)
                    || (a.washes - b.washes);
                });
                const previousTargetCount = current.targetHeldCount;
                current = ranked[0];
                seen.add(current.stateKey);
                metrics.expandedNodes++;
                if (root.__WASH_SEARCH_TRACE) {
                    console.log('[WashSearchV2][chain-follow] depth=' + depth
                        + ' target=' + (desired ? nameOf(desired) : '无')
                        + ' action=' + typeOf(current)
                        + ' targets=' + current.targetHeldCount
                        + ' pills=' + current.pillsUsed
                        + ' field='
                        + current.engineState.talents.map(nameOf).join('/'));
                }
                if (current.targetHeldCount > previousTargetCount) {
                    const held = presentTargets(current.engineState, targets);
                    const checkpointState = adapter.prepareLocks(
                        current.engineState, held
                    );
                    current = makeNode(
                        current,
                        checkpointState,
                        held,
                        {
                            type: 'chain-checkpoint',
                            steps: [{ op: 'locks', lockIds: held }],
                        },
                        current.pillsUsed,
                        current.washes,
                        current.exchangeCount
                    );
                    seen.add(current.stateKey);
                    metrics.chainCheckpoints++;
                }
                if (chainSearch && current.targetHeldCount > 0) {
                    const prior = dualTargetSeeds.get(current.stateKey);
                    if (!prior || current.pillsUsed < prior.pillsUsed) {
                        dualTargetSeeds.set(current.stateKey, current);
                    }
                }
            }
            return current;
        }

        function pureChainRollout(start, washBudget) {
            let current = start;
            const seen = new Set([start.stateKey]);
            const confirmed = new Set(
                start.lockSet.filter(id => targets.includes(Number(id)))
            );
            const washStop = metrics.simulatedWashes
                + Math.max(1, Number(washBudget) || maxPolicyWashes);
            for (let depth = 0; depth < 80 && !stopped; depth++) {
                if (metrics.simulatedWashes >= washStop) {
                    if (root.__WASH_SEARCH_TRACE) {
                        console.log('[WashSearchV2][pure-return] wash-budget'
                            + ' depth=' + depth);
                    }
                    return current;
                }
                if (targets.every(id =>
                    current.engineState.talents.includes(id)
                    && confirmed.has(id))) {
                    rememberBest(current);
                    return current;
                }
                const desired = nextAllowedPurple(current.engineState);
                if (!desired) {
                    if (root.__WASH_SEARCH_TRACE) {
                        console.log('[WashSearchV2][pure-return] no-desired'
                            + ' depth=' + depth);
                    }
                    return current;
                }
                const rawChildren = chainChildren(current, true, true);
                if (root.__WASH_SEARCH_TRACE) {
                    console.log('[WashSearchV2][pure-raw] depth=' + depth
                        + ' children=' + rawChildren.length
                        + ' washes=' + metrics.simulatedWashes);
                }
                const children = rawChildren
                    .filter(child => !seen.has(child.stateKey))
                    .filter(child =>
                        !(child.action
                            && child.action.type === 'target-checkpoint'));
                if (!children.length) {
                    const targetFallback = new Map();
                    generateCarrierExchangeMacro(current, targetFallback);
                    generateExchangePads(current, targetFallback);
                    generateTargetRuns(
                        current, targetFallback, maxTargetWait, true
                    );
                    for (const child of targetFallback.values()) {
                        if (!seen.has(child.stateKey)) children.push(child);
                    }
                }
                if (!children.length) {
                    if (root.__WASH_SEARCH_TRACE) {
                        console.log('[WashSearchV2][pure-return] no-children'
                            + ' depth=' + depth + ' desired=' + nameOf(desired)
                            + ' state=' + adapter.stateKey(current.engineState)
                            + ' locks=' + current.lockSet.map(nameOf).join('/'));
                    }
                    return current;
                }
                const typeOf = child => child.action && child.action.type || '';
                if (root.__WASH_SEARCH_TRACE) {
                    console.log('[WashSearchV2][pure-children] depth=' + depth
                        + ' desired=' + nameOf(desired) + ' '
                        + children.slice(0, 20).map(child =>
                            `${typeOf(child)}:`
                            + `${Number(child.action && child.action.addedId) || 0}:`
                            + `${child.pillsUsed}`).join(' | '));
                }
                const addsDesired = child =>
                    Number(child.action && child.action.addedId)
                    === Number(desired);
                const holdsDesired = child =>
                    child.engineState.talents.includes(Number(desired));
                const prepareWash = child => {
                    const wash = (child.action && child.action.steps || [])
                        .find(step => step.op === 'wash');
                    return wash ? Number(wash.count) || 0 : 0;
                };
                children.sort((a, b) =>
                    ((typeOf(b) === 'upgrade' ? 1 : 0)
                        - (typeOf(a) === 'upgrade' ? 1 : 0))
                    || (Number(addsDesired(b)) - Number(addsDesired(a)))
                    || ((typeOf(b) === 'wash-prepare' ? 1 : 0)
                        - (typeOf(a) === 'wash-prepare' ? 1 : 0))
                    || (prepareWash(b) - prepareWash(a))
                    || (Number(holdsDesired(b)) - Number(holdsDesired(a)))
                    || ((typeOf(b) === 'wash-event' ? 1 : 0)
                        - (typeOf(a) === 'wash-event' ? 1 : 0))
                    || (a.pillsUsed - b.pillsUsed)
                    || (a.washes - b.washes));
                current = children[0];
                seen.add(current.stateKey);
                metrics.expandedNodes++;
                if (root.__WASH_SEARCH_TRACE) {
                    console.log('[WashSearchV2][pure-chain] depth=' + depth
                        + ' target=' + nameOf(desired)
                        + ' action=' + typeOf(current)
                        + ' pills=' + current.pillsUsed
                        + ' field='
                        + current.engineState.talents.map(nameOf).join('/'));
                }
                if (targets.includes(Number(desired))
                    && current.engineState.talents.includes(Number(desired))) {
                    confirmed.add(Number(desired));
                    const held = uniqueNumbers(
                        Array.from(confirmed)
                    ).filter(id =>
                        targets.includes(Number(id))
                        && current.engineState.talents.includes(Number(id)));
                    const checkpointState = adapter.prepareLocks(
                        current.engineState, held
                    );
                    current = makeNode(
                        current,
                        checkpointState,
                        held,
                        {
                            type: 'chain-checkpoint',
                            steps: [{ op: 'locks', lockIds: held }],
                        },
                        current.pillsUsed,
                        current.washes,
                        current.exchangeCount
                    );
                    seen.add(current.stateKey);
                    metrics.chainCheckpoints++;
                }
                if (chainSearch && current.targetHeldCount > 0) {
                    const prior = dualTargetSeeds.get(current.stateKey);
                    if (!prior || current.pillsUsed < prior.pillsUsed) {
                        dualTargetSeeds.set(current.stateKey, current);
                    }
                }
            }
            return current;
        }

        function generateSeedProbeNodes(start, limit) {
            const slots = adapter.slotCount(start.engineState);
            if (slots !== 3 || start.engineState.luckSeed != null) return [];
            const threshold = adapter.pityThreshold(start.engineState);
            // shortcut: probe the lock-shift window around 26% of pity threshold;
            // expand into an explicit slot-plan frontier when more slot counts need it.
            const openCenter = Math.max(0, Math.round(threshold * 0.26));
            const firstOpen = Math.max(0, openCenter - 8);
            const lastOpen = openCenter + 8;
            const afterOpenBase = Math.max(
                16, Math.round(threshold * 0.05)
            );
            const afterOpenCandidates = Array.from(
                { length: 7 }, (_, index) => afterOpenBase - 3 + index
            );
            const results = [];
            const seen = new Set();
            let baseState = start.engineState;
            let baseCost = 0;

            for (let openAt = 0; openAt <= lastOpen && canAddWash(); openAt++) {
                if (openAt >= firstOpen) {
                    let state = adapter.upgradeFour(
                        Object.assign({}, baseState, { zizhi: 154 })
                    );
                    const steps = [];
                    if (openAt) {
                        steps.push({
                            op: 'locks',
                            lockIds: [],
                        });
                        steps.push({
                            op: 'wash',
                            keepIds: [],
                            count: openAt,
                            cost: baseCost,
                        });
                    }
                    steps.push({
                        op: 'upgrade',
                        fromZizhi: 153,
                        toZizhi: 154,
                    });
                    for (const afterOpen of afterOpenCandidates) {
                        let quietState = state;
                        let quietCost = 0;
                        for (let index = 0;
                            index < afterOpen && canAddWash();
                            index++) {
                            const washed = adapter.wash(quietState, []);
                            quietState = washed.state;
                            quietCost += Number(washed.cost) || 0;
                            metrics.simulatedWashes++;
                        }
                        const quietSteps = steps.concat(afterOpen ? [{
                            op: 'wash',
                            keepIds: [],
                            count: afterOpen,
                            cost: quietCost,
                        }] : []);
                        const cost = baseCost + quietCost;
                        const lows = quietState.talents.filter(id =>
                            id !== 251 && adapter.quality(id) < 4);
                        for (const low of lows) {
                        let probeState = quietState;
                        let probeCost = cost;
                        const washed = adapter.wash(probeState, [low]);
                        probeState = washed.state;
                        probeCost += Number(washed.cost) || 0;
                        metrics.simulatedWashes++;
                        let count = 1;
                        const generated = (washed.generatedEvents || [])
                            .filter(event => adapter.quality(event.id) === 4)
                            .map(event => ({
                                at: 1,
                                id: Number(event.id),
                                fromPity: !!event.fromPity,
                            }));
                        const pity = [];
                        if (washed.pityPurpleId != null) {
                            pity.push({
                                at: 1,
                                id: Number(washed.pityPurpleId),
                            });
                        }
                        let targetHit = presentTargets(probeState, targets).length > 0;
                        while (!targetHit && !pity.length
                            && count < Math.min(maxTargetWait, 256)
                            && canAddWash()) {
                            const next = adapter.wash(probeState, []);
                            probeState = next.state;
                            probeCost += Number(next.cost) || 0;
                            count++;
                            metrics.simulatedWashes++;
                            (next.generatedEvents || [])
                                .filter(event => adapter.quality(event.id) === 4)
                                .forEach(event => generated.push({
                                    at: count,
                                    id: Number(event.id),
                                    fromPity: !!event.fromPity,
                                }));
                            if (next.pityPurpleId != null) {
                                pity.push({
                                    at: count,
                                    id: Number(next.pityPurpleId),
                                });
                            }
                            targetHit = presentTargets(probeState, targets).length > 0;
                            if (probeCost > budget) break;
                        }
                        if (!targetHit && !pity.length) continue;
                        if (probeCost > budget) continue;
                        const probeSteps = quietSteps.concat([
                            { op: 'locks', lockIds: [low] },
                            {
                                op: 'wash',
                                keepIds: [low],
                                count: 1,
                                cost: Number(washed.cost) || 0,
                            },
                            { op: 'locks', lockIds: [] },
                            {
                                op: 'wash',
                                keepIds: [],
                                count: count - 1,
                                cost: probeCost - cost - (Number(washed.cost) || 0),
                                generatedPurples: generated,
                                pityPurples: pity,
                                stopReason: 'decision',
                            },
                        ]);
                        const locks = presentTargets(probeState, targets);
                        const key = stateKey(probeState, locks);
                        if (seen.has(key)) continue;
                        seen.add(key);
                        const node = makeNode(
                            start,
                            probeState,
                            locks,
                            {
                                type: 'pity-seed',
                                seedOpenAt: openAt,
                                seedLowId: low,
                                steps: probeSteps,
                            },
                            probeCost,
                            openAt + afterOpen + count,
                            0
                        );
                        if (root.__WASH_SEARCH_TRACE && node.targetHeldCount) {
                            console.log('[WashSearchV2][pity-seed] open='
                                + openAt + ' after=' + afterOpen
                                + ' low=' + nameOf(low)
                                + ' targets=' + node.targetHeldCount
                                + ' pills=' + probeCost
                                + ' field='
                                + probeState.talents.map(nameOf).join('/'));
                        }
                        metrics.acceptedActions++;
                        results.push(node);
                        }
                    }
                }
                if (!canAddWash()) break;
                const advanced = adapter.wash(baseState, []);
                baseState = advanced.state;
                baseCost += Number(advanced.cost) || 0;
                metrics.simulatedWashes++;
            }
            return results
                .sort((a, b) =>
                    (b.targetHeldCount - a.targetHeldCount)
                    || (a.nextTargetDistance - b.nextTargetDistance)
                    || (b.chainHitsNext8 - a.chainHitsNext8)
                    || (a.pillsUsed - b.pillsUsed))
                .slice(0, limit);
        }

        function generateCopyPulse(node, lowId, duration, output) {
            if (node.engineState.luckSeed != null) return;
            let state = node.engineState;
            let cost = 0;
            let count = 0;
            const generated = [];
            const pityPurples = [];
            for (let index = 0; index < duration && canAddWash(); index++) {
                const result = adapter.wash(state, [lowId]);
                state = result.state;
                cost += Number(result.cost) || 0;
                count++;
                metrics.simulatedWashes++;
                (result.generatedEvents || [])
                    .filter(event => adapter.quality(event.id) === 4)
                    .forEach(event => generated.push({
                        at: count,
                        id: Number(event.id),
                        fromPity: !!event.fromPity,
                    }));
                if (result.pityPurpleId != null) {
                    pityPurples.push({
                        at: count,
                        id: Number(result.pityPurpleId),
                    });
                }
                if (state.luckSeed != null) break;
            }
            if (!count) return;
            const pills = node.pillsUsed + cost;
            if (pills > budget) return;
            const locks = presentTargets(state, targets);
            const steps = [
                { op: 'locks', lockIds: [lowId] },
                {
                    op: 'wash',
                    keepIds: [lowId],
                    count,
                    cost,
                    generatedPurples: generated,
                    pityPurples,
                },
                { op: 'locks', lockIds: locks },
            ];
            const child = makeNode(
                node,
                state,
                locks,
                {
                    type: 'copy-pulse',
                    lowId,
                    duration,
                    steps,
                },
                pills,
                node.washes + count,
                node.exchangeCount
            );
            metrics.acceptedActions++;
            addCandidate(output, child);
        }

        function generateCopyPointNodes(start, limit, width) {
            if (adapter.slotCount(start.engineState) !== 3
                || start.engineState.luckSeed != null) return [];
            let frontier = [start];
            const points = new Map();
            const seen = new Set([start.stateKey]);
            for (let depth = 0; depth < 850 && frontier.length && !stopped; depth++) {
                const cap = capReached();
                if (cap) {
                    stopped = true;
                    stopReason = cap;
                    break;
                }
                const next = new Map();
                for (const current of frontier) {
                    if (current.engineState.luckSeed != null
                        || presentTargets(current.engineState, targets).length) {
                        const existing = points.get(current.stateKey);
                        if (!existing || current.pillsUsed < existing.pillsUsed) {
                            points.set(current.stateKey, current);
                        }
                        continue;
                    }
                    const output = new Map();
                    generateWashOne(current, [[]], output);
                    const lows = current.engineState.talents.filter(id =>
                        id !== 251 && adapter.quality(id) < 4);
                    for (const low of lows) {
                        for (const duration of [1, 3, 5]) {
                            generateCopyPulse(current, low, duration, output);
                        }
                    }
                    if (current.engineState.zizhi < 154) {
                        generateUpgrade(current, output);
                    }
                    for (const child of output.values()) {
                        if (child.engineState.luckSeed != null
                            || presentTargets(child.engineState, targets).length) {
                            const existing = points.get(child.stateKey);
                            if (!existing || child.pillsUsed < existing.pillsUsed) {
                                points.set(child.stateKey, child);
                            }
                            continue;
                        }
                        if (seen.has(child.stateKey)) continue;
                        seen.add(child.stateKey);
                        const existing = next.get(child.stateKey);
                        if (!existing || compareNodes(child, existing, targets.length) < 0) {
                            next.set(child.stateKey, child);
                        }
                    }
                }
                frontier = Array.from(next.values())
                    .sort((a, b) =>
                        (b.targetHeldCount - a.targetHeldCount)
                        || (b.engineState.talLucky - a.engineState.talLucky)
                        || (a.pillsUsed - b.pillsUsed)
                        || (a.washes - b.washes))
                    .slice(0, Math.max(1, Number(width) || chainBeamWidth));
                metrics.expandedNodes += frontier.length;
            }
            return Array.from(points.values())
                .sort((a, b) =>
                    (b.targetHeldCount - a.targetHeldCount)
                    || (a.nextTargetDistance - b.nextTargetDistance)
                    || (b.chainHitsNext8 - a.chainHitsNext8)
                    || (a.pillsUsed - b.pillsUsed))
                .slice(0, limit);
        }

        function addDualCandidate(output, node) {
            if (Object.keys(desiredTargetAnchors).length
                && !matchesDesiredTargetAnchors(node.parent, node)) return;
            const existing = output.get(node.stateKey);
            if (!existing || compareNodes(node, existing, targets.length) < 0) {
                output.set(node.stateKey, node);
            }
            if (!node.parent
                || node.targetHeldCount <= node.parent.targetHeldCount) {
                return;
            }
            const held = presentTargets(node.engineState, targets);
            if (!held.length) return;
            const checkpointState = adapter.prepareLocks(node.engineState, held);
            const checkpoint = makeNode(
                node,
                checkpointState,
                held,
                {
                    type: 'dual-checkpoint',
                    steps: [{ op: 'locks', lockIds: held }],
                },
                node.pillsUsed,
                node.washes,
                node.exchangeCount
            );
            const prior = output.get(checkpoint.stateKey);
            if (!prior
                || compareNodes(checkpoint, prior, targets.length) < 0) {
                output.set(checkpoint.stateKey, checkpoint);
            }
        }

        function generateDualBornEvents(node, output) {
            const state = node.engineState;
            const slots = adapter.slotCount(state);
            const masks = usefulLockMasks(
                adapter, state, targets, node.lockSet, maxLockMasks
            ).slice(0, 6);
            const initialTargets = presentTargets(state, targets);
            for (const mask of masks) {
                if (mask.length >= slots || !canAddWash()) continue;
                let runState = state;
                let segmentCost = 0;
                let count = 0;
                let reason = '';
                const generated = [];
                const pityPurples = [];
                const engine = adapter.engineForState(state);
                const threshold = adapter.pityThreshold(state);
                if (state.talLucky >= threshold && !node.action
                    || state.talLucky >= threshold
                    && node.action
                    && node.action.type !== 'pity-boundary') {
                    const boundary = makeNode(
                        node,
                        state,
                        mask,
                        {
                            type: 'pity-boundary',
                            pityIndex: node.action
                                && node.action.pityEvent
                                ? Number(node.action.pityIndex) + 1 : 1,
                            steps: [{ op: 'locks', lockIds: mask }],
                        },
                        node.pillsUsed,
                        node.washes,
                        node.exchangeCount
                    );
                    addDualCandidate(output, boundary);
                    continue;
                }
                while (count < maxRunWashes && canAddWash()) {
                    const runEngine = adapter.engineForState(runState);
                    const unitCost = runEngine.eat + 2 * mask.length - 1;
                    if (node.pillsUsed + segmentCost + unitCost > budget) break;
                    const result = adapter.wash(runState, mask);
                    runState = result.state;
                    segmentCost += Number(result.cost) || 0;
                    count++;
                    metrics.simulatedWashes++;
                    const purples = (result.generatedEvents || [])
                        .filter(event => adapter.quality(event.id) === 4);
                    purples.forEach(event => generated.push({
                        at: count,
                        id: Number(event.id),
                        fromPity: !!event.fromPity,
                    }));
                    if (result.pityPurpleId != null) {
                        pityPurples.push({
                            at: count,
                            id: Number(result.pityPurpleId),
                        });
                    }
                    const currentTargets = presentTargets(runState, targets);
                    const newTarget = currentTargets.some(id =>
                        !initialTargets.includes(id));
                    const supportReady = runState.talents.some(id => {
                        if (id === 251 || adapter.quality(id) >= 4) return false;
                        const type = runEngine.talentType(id);
                        return runState.talents.some(otherId =>
                            Number(otherId) !== Number(id)
                            && adapter.quality(otherId) === 4
                            && !adapter.isShenmai(otherId)
                            && runEngine.talentType(otherId) === type);
                    });
                    const crossingPity = runState.talLucky >= threshold;
                    if (purples.length) reason = 'purple';
                    else if (result.pityPurpleId != null) reason = 'pity';
                    else if (newTarget) reason = 'target';
                    else if (supportReady) reason = 'support';
                    else if (crossingPity) reason = 'pity-boundary';
                    else continue;
                    break;
                }
                if (!count || reason === 'pity-boundary' && !generated.length) {
                    if (!count) continue;
                }
                const pills = node.pillsUsed + segmentCost;
                if (pills > budget) continue;
                const steps = [
                    { op: 'locks', lockIds: mask },
                    {
                        op: 'wash',
                        keepIds: mask,
                        count,
                        cost: segmentCost,
                        generatedPurples: generated,
                        pityPurples,
                        stopReason: reason,
                    },
                ];
                const child = makeNode(
                    node,
                    runState,
                    mask,
                    {
                        type: 'dual-born-event',
                        event: reason,
                        pityEvent: pityPurples.length > 0,
                        pityIndex: node.action && node.action.pityEvent
                            ? Number(node.action.pityIndex) + 1
                            : (pityPurples.length ? 1 : 0),
                        steps,
                    },
                    pills,
                    node.washes + count,
                    node.exchangeCount
                );
                addDualCandidate(output, child);
            }
        }

        function generateDualExchanges(node, output) {
            const state = node.engineState;
            const lockedTargets = targets.filter(id =>
                node.lockSet.includes(id)
                && state.talents.includes(id));
            const freeSlots = adapter.slotCount(state) - lockedTargets.length;
            const masks = usefulLockMasks(
                adapter, state, targets, node.lockSet, maxLockMasks
            );
            const seen = new Set();
            for (const mask of masks) {
                let moves = [];
                try {
                    moves = adapter.exchangeMoves(state, mask);
                } catch (error) {
                    continue;
                }
                for (const move of moves) {
                    const carrierId = Number(move.carrierId);
                    if (targets.includes(carrierId)) continue;
                    const shenExchange = adapter.isShenmai(carrierId);
                    if (!shenExchange && freeSlots < 2) continue;
                    if (!shenExchange && lockedTargets.length >= 3) continue;
                    const key = move.carrierId + '|' + sorted(mask).join(',');
                    if (seen.has(key)) continue;
                    seen.add(key);
                    let replaced;
                    try {
                        replaced = adapter.replace(
                            move.state, move.position, mask
                        );
                    } catch (error) {
                        continue;
                    }
                    const nextSupport = nextLuckSupport(replaced.state);
                    for (const post of postLockCandidates(
                        adapter, replaced.state, targets, mask,
                        nextSupport ? [nextSupport] : [],
                        Number(replaced.addedId)
                    )) {
                        const steps = [
                            { op: 'locks', lockIds: sorted(mask) },
                            {
                                op: 'exchange',
                                carrierId: Number(move.carrierId),
                                lockIds: sorted(mask),
                                removedId: Number(replaced.removedId),
                                addedId: Number(replaced.addedId),
                            },
                            { op: 'locks', lockIds: post },
                        ];
                        const child = makeNode(
                            node,
                            replaced.state,
                            post,
                            {
                                type: 'dual-exchange',
                                carrierId,
                                addedId: Number(replaced.addedId),
                                exchangeKind: shenExchange
                                    ? 'shen' : 'ordinary',
                                targetRank: lockedTargets.length + 1,
                                steps,
                            },
                            node.pillsUsed,
                            node.washes,
                            node.exchangeCount + 1
                        );
                        addDualCandidate(output, child);
                    }
                }
            }
        }

        function generateDualExchangeRuns(node, output) {
            const state = node.engineState;
            const lockedTargets = targets.filter(id =>
                node.lockSet.includes(id)
                && state.talents.includes(id));
            if (lockedTargets.length > 1) return;
            const slots = adapter.slotCount(state);
            const masks = usefulLockMasks(
                adapter, state, targets, node.lockSet, maxLockMasks
            );
            const starts = [];
            const startSeen = new Set();
            for (const mask of masks) {
                let moves = [];
                try {
                    moves = adapter.exchangeMoves(state, mask);
                } catch (error) {
                    continue;
                }
                for (const move of moves) {
                    if (targets.includes(Number(move.carrierId))) continue;
                    const key = move.carrierId + '|' + sorted(mask).join(',');
                    if (startSeen.has(key)) continue;
                    startSeen.add(key);
                    starts.push({ mask, carrierId: Number(move.carrierId) });
                }
            }

            for (const start of starts.slice(0, 6)) {
                let runState = state;
                let carrierId = start.carrierId;
                let mask = start.mask;
                let totalCost = 0;
                let totalWashes = 0;
                let exchanges = 0;
                const steps = [];
                const initialTargetCount = targetStats(runState, targets);
                for (let stage = 0; stage < maxTicketStages; stage++) {
                    const position = runState.talents.indexOf(carrierId);
                    if (position < 0) break;
                    mask = conflictMaskForCarrier(
                        runState, position, lockedTargets
                    );
                    if (!mask) break;
                    const nextId = nextAllowedPurple(runState);
                    if (!nextId) break;
                    const nextType = adapter.engineForState(runState)
                        .talentType(nextId);
                    let supportId = 0;
                    if (!adapter.isShenmai(nextId)) {
                        supportId = runState.talents.find(id =>
                            id !== 251
                            && adapter.quality(id) < 4
                            && adapter.engineForState(runState)
                                .talentType(id) === nextType);
                    }
                    if (!adapter.isShenmai(nextId) && !supportId) {
                        const keep = uniqueNumbers(
                            [carrierId].concat(lockedTargets, mask)
                        );
                        if (keep.length >= slots) break;
                        let preloadCost = 0;
                        let preloadWashes = 0;
                        while (preloadWashes < Math.min(160, maxCarrierWait)
                            && canAddWash()) {
                            const runEngine = adapter.engineForState(runState);
                            const unitCost = runEngine.eat + 2 * keep.length - 1;
                            if (node.pillsUsed + totalCost + preloadCost
                                + unitCost > budget) break;
                            const washed = adapter.wash(runState, keep);
                            runState = washed.state;
                            preloadCost += Number(washed.cost) || 0;
                            preloadWashes++;
                            metrics.simulatedWashes++;
                            supportId = runState.talents.find(id =>
                                id !== 251
                                && adapter.quality(id) < 4
                                && runEngine.talentType(id) === nextType);
                            if (supportId) break;
                        }
                        if (!supportId) break;
                        totalCost += preloadCost;
                        totalWashes += preloadWashes;
                        steps.push({ op: 'locks', lockIds: keep });
                        steps.push({
                            op: 'wash',
                            keepIds: keep,
                            count: preloadWashes,
                            cost: preloadCost,
                            stopReason: 'preload-next-support',
                        });
                        const ordered = uniqueNumbers(
                            [supportId, carrierId].concat(lockedTargets)
                        ).slice(0, slots);
                        runState = adapter.prepareLocks(runState, ordered);
                        mask = conflictMaskForCarrier(
                            runState,
                            runState.talents.indexOf(carrierId),
                            lockedTargets
                        );
                    } else if (supportId) {
                        const ordered = uniqueNumbers(
                            [supportId, carrierId].concat(lockedTargets)
                        ).slice(0, slots);
                        runState = adapter.prepareLocks(runState, ordered);
                        mask = conflictMaskForCarrier(
                            runState,
                            runState.talents.indexOf(carrierId),
                            lockedTargets
                        );
                    }
                    const runPosition = runState.talents.indexOf(carrierId);
                    if (!mask || runPosition < 0
                        || !adapter.replaceablePositions(runState, mask)
                            .includes(runPosition)) {
                        break;
                    }
                    let replaced;
                    try {
                        replaced = adapter.replace(runState, runPosition, mask);
                    } catch (error) {
                        break;
                    }
                    if (Number(replaced.addedId) !== Number(nextId)) break;
                    steps.push({ op: 'locks', lockIds: sorted(mask) });
                    steps.push({
                        op: 'exchange',
                        carrierId,
                        lockIds: sorted(mask),
                        removedId: Number(replaced.removedId),
                        addedId: Number(replaced.addedId),
                    });
                    runState = replaced.state;
                    exchanges++;
                    const child = makeNode(
                        node,
                        runState,
                        lockedTargets,
                        {
                            type: 'dual-exchange-run',
                            stage: stage + 1,
                            carrierId,
                            addedId: Number(replaced.addedId),
                            targetRank: lockedTargets.length + 1,
                            steps: steps.slice(),
                        },
                        node.pillsUsed + totalCost,
                        node.washes + totalWashes,
                        node.exchangeCount + exchanges
                    );
                    addDualCandidate(output, child);
                    if (targetStats(runState, targets) > initialTargetCount) break;
                    carrierId = Number(replaced.addedId);
                }
            }
        }

        function generateDualChildren(node) {
            const output = new Map();
            generateFinalTargetWait(node, output);
            generateReleaseRecaptureRuns(node, output);
            if (Number(node.engineState.zizhi) < 154) {
                generateUpgrade(node, output);
            }
            generateSupportCarrierRuns(node, output);
            generateCarrierSupportRuns(node, output);
            generateDualBornEvents(node, output);
            generateDualExchanges(node, output);
            generateDualExchangeRuns(node, output);
            return Array.from(output.values());
        }

        function selectDualPortfolio(children, width) {
            const stageRank = node => {
                const locked = targets.filter(id =>
                    node.lockSet.includes(id)
                    && node.engineState.talents.includes(id)).length;
                const orderedLocked = node.targetOrderProgress == null
                    ? locked : node.targetOrderProgress;
                const type = node.action && node.action.type || '';
                if (orderedLocked <= 1 && type === 'dual-exchange-run') return 3;
                if (orderedLocked <= 1 && type === 'dual-exchange') return 2;
                if (orderedLocked === 2 && type === 'dual-exchange') return 3;
                if (orderedLocked === 2 && type === 'dual-born-event') return 2;
                if (orderedLocked >= 3 && type === 'dual-born-event') return 3;
                return 1;
            };
            const groups = new Map();
            children.slice()
                .sort((a, b) =>
                    (Number(!!b.targetOrderExplicit)
                        - Number(!!a.targetOrderExplicit))
                    || (b.targetOrderExplicit
                        ? (b.targetOrderProgress - a.targetOrderProgress)
                            || ((a.targetHeldCount - a.targetOrderProgress)
                                - (b.targetHeldCount - b.targetOrderProgress))
                        : 0)
                    || ((b.anchorShiftCount || 0) - (a.anchorShiftCount || 0))
                    || (b.targetHeldCount - a.targetHeldCount)
                    || (stageRank(b) - stageRank(a))
                    || (b.exchangeReady - a.exchangeReady)
                    || (b.chainHitsNext8 - a.chainHitsNext8)
                    || ((!a.targetOrderExplicit
                        ? a.nextTargetDistance
                        : a.nextOrderTargetDistance == null
                        ? a.nextTargetDistance : a.nextOrderTargetDistance)
                        - (!b.targetOrderExplicit
                            ? b.nextTargetDistance
                            : b.nextOrderTargetDistance == null
                            ? b.nextTargetDistance : b.nextOrderTargetDistance))
                    || (a.pillsUsed - b.pillsUsed)
                    || (a.washes - b.washes))
                .forEach(node => {
                    if (!groups.has(node.targetMask)) {
                        groups.set(node.targetMask, []);
                    }
                    groups.get(node.targetMask).push(node);
                });
            const ordered = Array.from(groups.values())
                .sort((a, b) =>
                    (Number(!!b[0].targetOrderExplicit)
                        - Number(!!a[0].targetOrderExplicit))
                    || (b[0].targetOrderExplicit
                        ? (b[0].targetOrderProgress - a[0].targetOrderProgress)
                            || ((a[0].targetHeldCount
                                - a[0].targetOrderProgress)
                                - (b[0].targetHeldCount
                                    - b[0].targetOrderProgress))
                        : 0)
                    || ((b[0].anchorShiftCount || 0)
                        - (a[0].anchorShiftCount || 0))
                    || (b[0].targetHeldCount - a[0].targetHeldCount)
                    || (a[0].pillsUsed - b[0].pillsUsed));
            const selected = [];
            for (let index = 0; selected.length < width; index++) {
                let added = false;
                for (const group of ordered) {
                    if (index >= group.length) continue;
                    selected.push(group[index]);
                    added = true;
                    if (selected.length >= width) break;
                }
                if (!added) break;
            }
            return selected;
        }

        function generateReverseTargetOrders(start, limit) {
            if (!chainSearch || adapter.slotCount(start.engineState) < 3) {
                return [];
            }
            const events = new Map(targets.map(id => [id, []]));
            let state = start.engineState;
            // Initial targets may be released and recaptured later. Scan the
            // natural stream from an unlocked preview; full replay decides
            // whether each initial target is actually worth releasing.
            const locks = [];
            let bars = 0;
            let naturalOrdinal = 0;
            const scanLimit = Math.min(2400, maxTargetWait);
            for (let index = 0; index < scanLimit && canAddWash(); index++) {
                if (locks.length >= adapter.slotCount(state)) break;
                const result = adapter.wash(state, locks);
                state = result.state;
                bars += Number(result.generatedBars) || 0;
                metrics.simulatedWashes++;
                for (const event of (result.generatedEvents || [])) {
                    const id = Number(event.id);
                    if (adapter.quality(id) !== 4) continue;
                    naturalOrdinal++;
                    if (!events.has(id)) continue;
                    events.get(id).push({
                        position: bars,
                        source: 'natural',
                        ordinal: naturalOrdinal,
                    });
                }
            }
            const engine = adapter.engineForState(state);
            let luck = Number(state.luckSeed == null
                ? state.bornSeed : state.luckSeed);
            if (Number.isFinite(luck)) {
                for (let index = 1; index <= 64; index++) {
                    try {
                        const draw = engine.draw(luck, true);
                        luck = Number(draw[1]);
                        const id = Number(draw[0]);
                        if (!events.has(id)
                            || !engine.allowed.has(id)
                            || state.talents.includes(id)) {
                            continue;
                        }
                        events.get(id).push({
                            // Exchange events have no born-stream bars. Forty
                            // bars is the cheap-carrier upper estimate used only
                            // for ordering, never for budget pruning.
                            position: index * 40,
                            source: 'exchange',
                            ordinal: 0,
                        });
                    } catch (error) {
                        break;
                    }
                }
            }
            events.forEach(values => values.sort((a, b) =>
                (a.position - b.position) || (a.source < b.source ? -1 : 1)));
            if (root.__WASH_SEARCH_TRACE) {
                console.log('[WashSearchV2][reverse-events] '
                    + targets.map(id => nameOf(id) + ':'
                        + events.get(id).slice(0, 6).map(event =>
                            event.position + event.source.charAt(0)
                        ).join('/')).join(' | '));
            }
            const multipliers = [1, 2, 4, 10];
            const orders = [];
            for (const tailTarget of targets) {
                const tailEvents = (events.get(tailTarget) || [])
                    .filter(event => event.source === 'natural');
                const remaining = targets.filter(id =>
                    Number(id) !== Number(tailTarget));
                for (const tailEvent of tailEvents) {
                    for (const thirdTarget of remaining) {
                        const thirdCandidates = (events.get(thirdTarget) || [])
                            .filter(event => event.position < tailEvent.position);
                        const thirdEvent = thirdCandidates[thirdCandidates.length - 1];
                        if (!thirdEvent) continue;
                        const pairTargets = remaining.filter(id =>
                            Number(id) !== Number(thirdTarget));
                        for (const pairOrder of permutations(pairTargets)) {
                        const stages = new Array(targets.length);
                        stages[targets.length - 1] = {
                            target: tailTarget,
                            event: tailEvent,
                        };
                            stages[2] = {
                                target: thirdTarget,
                                event: thirdEvent,
                            };
                            const usedPositions = new Set([
                                thirdEvent.position,
                                tailEvent.position,
                            ]);
                            let ok = true;
                            // The third/tail pair is already fixed. Targets 1
                            // and 2 independently take their latest remaining
                            // anchors; they are not forced before the third.
                            for (let stage = pairOrder.length - 1; stage >= 0; stage--) {
                                const candidates = (events.get(pairOrder[stage]) || [])
                                    .filter(event => event.position < tailEvent.position
                                        && !usedPositions.has(event.position));
                                const event = candidates[candidates.length - 1];
                                if (!event) {
                                    ok = false;
                                    break;
                                }
                                stages[stage] = {
                                    target: pairOrder[stage],
                                    event,
                                };
                                usedPositions.add(event.position);
                            }
                            if (!ok) continue;
                        let totalCost = 0;
                        for (let stage = 0; stage < stages.length; stage++) {
                                totalCost += (tailEvent.position
                                    - stages[stage].event.position)
                                    * multipliers[stage];
                        }
                        orders.push({
                                order: pairOrder.concat([
                                    thirdTarget, tailTarget,
                                ]),
                                tailGap: tailEvent.position - thirdEvent.position,
                            totalCost,
                            mode: 'backward',
                            stages: stages.map(stage => ({
                                target: stage.target,
                                position: stage.event.position,
                                ordinal: stage.event.ordinal,
                                source: stage.event.source,
                            })),
                        });
                        }
                    }
                }
            }
            orders.sort((a, b) =>
                (a.tailGap - b.tailGap)
                || (a.totalCost - b.totalCost)
                || (a.stages[2].position - b.stages[2].position)
                || (a.order.join(',') < b.order.join(',') ? -1 : 1));
            const forwardOrders = [];
            for (const order of permutations(targets)) {
                let cursor = -1;
                let previous = 0;
                let totalCost = 0;
                let tailGap = 0;
                let previousEvent = null;
                let ok = true;
                const stages = [];
                for (let stage = 0; stage < order.length; stage++) {
                    const event = (events.get(order[stage]) || [])
                        .find(item => item.position > cursor);
                    if (!event || (stage === order.length - 1
                        && event.source !== 'natural')) {
                        ok = false;
                        break;
                    }
                    tailGap = event.position - previous;
                    totalCost += tailGap * multipliers[stage];
                    cursor = event.position;
                    previous = event.position;
                    previousEvent = event;
                    stages.push({
                        target: order[stage],
                        position: event.position,
                        ordinal: event.ordinal,
                        source: event.source,
                    });
                }
                if (!ok || !previousEvent) continue;
                forwardOrders.push({
                    order,
                    tailGap,
                    totalCost,
                    stages,
                    mode: 'forward',
                });
            }
            forwardOrders.sort((a, b) =>
                (a.tailGap - b.tailGap)
                || (a.totalCost - b.totalCost)
                || (a.order.join(',') < b.order.join(',') ? -1 : 1));
            const wanted = Math.max(0, Number(limit) || 0);
            const selected = [];
            if (orders[0]) selected.push(orders[0]);
            if (orders[1]) selected.push(orders[1]);
            if (forwardOrders[0]) selected.push(forwardOrders[0]);
            if (forwardOrders[1]) selected.push(forwardOrders[1]);
            selected.push.apply(selected, orders.slice(2));
            selected.push.apply(selected, forwardOrders.slice(2));
            return selected
                .filter((item, index, values) => values.findIndex(other =>
                    other.stages.map(stage =>
                        stage.target + ':' + stage.position
                    ).join(',') === item.stages.map(stage =>
                        stage.target + ':' + stage.position
                    ).join(',')) === index)
                .slice(0, wanted);
        }

        function generateInitialReleaseStarts(start, limit) {
            const initialTargets = presentTargets(
                start.engineState, targets
            );
            if (!initialTargets.length) return [start];
            const variants = subsets(initialTargets).sort((a, b) =>
                (a.length - b.length)
                || (a.join(',') < b.join(',') ? -1 : 1)
            );
            return variants.slice(
                0, Math.max(1, Number(limit) || 4)
            ).map(lockIds => {
                const locks = sorted(lockIds);
                if (locks.join(',') === start.lockSet.join(',')) {
                    return start;
                }
                return makeNode(
                    start.parent,
                    start.engineState,
                    locks,
                    {
                        type: 'release-initial-targets',
                        steps: [{ op: 'locks', lockIds: locks }],
                    },
                    start.pillsUsed,
                    start.washes,
                    start.exchangeCount
                );
            });
        }

        function runDualChainSearch(start, washBudget, targetOrder, planMode) {
            activeTargetOrder = targetOrder && targetOrder.length === targets.length
                ? targetOrder.slice() : targets.slice();
            targetOrderActive = !!targetOrder;
            targetPlanMode = targetOrder ? (planMode || 'forward') : '';
            const orderedStart = makeNode(
                start.parent,
                start.engineState,
                start.lockSet,
                start.action,
                start.pillsUsed,
                start.washes,
                start.exchangeCount
            );
            let frontier = [orderedStart];
            const seen = new Map([[orderedStart.stateKey, orderedStart.pillsUsed]]);
            const washStop = metrics.simulatedWashes
                + Math.max(1, Number(washBudget) || maxPolicyWashes);
            const width = Math.max(512, chainBeamWidth * 8);
            for (let depth = 0; depth < 80 && frontier.length && !stopped; depth++) {
                if (metrics.simulatedWashes >= washStop) break;
                const cap = capReached();
                if (cap) {
                    stopped = true;
                    stopReason = cap;
                    break;
                }
                const next = new Map();
                for (const node of frontier) {
                    if (targetStats(node.engineState, targets) === targets.length) {
                        rememberBest(node);
                        continue;
                    }
                    metrics.expandedNodes++;
                    for (const child of generateDualChildren(node)) {
                        if (child.pillsUsed > budget) continue;
                        const prior = seen.get(child.stateKey);
                        if (prior != null && prior <= child.pillsUsed) continue;
                        seen.set(child.stateKey, child.pillsUsed);
                        const existing = next.get(child.stateKey);
                        if (!existing
                            || compareNodes(child, existing, targets.length) < 0) {
                            next.set(child.stateKey, child);
                        }
                        if (targetStats(child.engineState, targets)
                            === targets.length) {
                            rememberBest(child);
                        }
                    }
                }
                if (!next.size) break;
                frontier = selectDualPortfolio(
                    Array.from(next.values()), width
                );
                if (root.__WASH_SEARCH_TRACE) {
                    const best = new Map();
                    for (const node of next.values()) {
                        const prior = best.get(node.targetMask);
                        if (!prior || node.pillsUsed < prior.pillsUsed) {
                            best.set(node.targetMask, node);
                        }
                    }
                    console.log('[WashSearchV2][dual] depth=' + depth
                        + ' masks=' + Array.from(best.values())
                            .sort((a, b) =>
                                (b.targetHeldCount - a.targetHeldCount)
                                || (a.pillsUsed - b.pillsUsed))
                            .slice(0, 6)
                            .map(node => node.targetHeldCount + '@'
                                + node.pillsUsed + ':'
                                + targets.filter((id, index) =>
                                    node.targetMask & (1 << index))
                                    .map(nameOf).join('/'))
                            .join(';')
                        + ' top=' + frontier.slice(0, 4).map(node =>
                            node.targetHeldCount + ':' + node.pillsUsed + ':'
                            + node.engineState.talents.map(nameOf).join('/')
                        ).join(' || '));
                }
            }
            activeTargetOrder = targets.slice();
            targetOrderActive = false;
            targetPlanMode = '';
        }

        function capReached() {
            if (Date.now() - startedAt >= limits.maxRuntimeMs) {
                return 'max-runtime';
            }
            if (metrics.expandedNodes >= limits.maxExpandedNodes) return 'max-expanded-nodes';
            if (metrics.simulatedWashes >= limits.maxWashSteps) return 'max-wash-steps';
            if (stateSeen.size >= limits.maxUniqueStates) return 'max-unique-states';
            return '';
        }

        if (targetStats(rootNode.engineState, targets) === targets.length) {
            rememberBest(rootNode);
        }
        stateSeen.set(rootNode.stateKey, rootNode.pillsUsed);

        function generateChainPrelude(node, output, targetKeepOverride) {
            const expected =
                configuredExchangeChain[node.exchangeChainIndex];
            if (!expected) {
                return;
            }
            const carrierType =
                adapter.engineForState(node.engineState).talentType(
                    expected.from
                );
            let state = node.engineState;
            let pills = node.pillsUsed;
            let washes = node.washes;
            let count = 0;
            const steps = [];
            const allHeldTargets = targets.filter(id =>
                state.talents.includes(id)
            );
            const heldTargets = Array.isArray(targetKeepOverride)
                ? targetKeepOverride.filter(id =>
                    state.talents.includes(id)
                )
                : allHeldTargets;
            const washWith = keep => {
                if (!canAddWash()) return false;
                const washed = adapter.wash(state, keep);
                state = washed.state;
                pills += Number(washed.cost) || 0;
                washes += 1;
                count += 1;
                metrics.simulatedWashes++;
                const last = steps[steps.length - 1];
                const generated = (washed.generatedEvents || [])
                    .filter(event =>
                        adapter.quality(Number(event.id)) === 4
                    ).map(event => ({
                        at: 1,
                        id: Number(event.id),
                        fromPity: !!event.fromPity,
                    }));
                if (last && last.op === 'wash'
                    && last.keepIds.join(',') === keep.join(',')) {
                    last.count += 1;
                    last.cost += Number(washed.cost) || 0;
                    last.generatedPurples.push(...generated);
                    if (washed.pityPurpleId != null) {
                        last.pityPurples.push({
                            id: Number(washed.pityPurpleId),
                        });
                    }
                } else {
                    steps.push({
                        op: 'locks',
                        lockIds: keep.slice(),
                    });
                    steps.push({
                        op: 'wash',
                        keepIds: keep.slice(),
                        count: 1,
                        cost: Number(washed.cost) || 0,
                        generatedPurples: generated,
                        pityPurples: washed.pityPurpleId == null
                            ? [] : [{
                                id: Number(washed.pityPurpleId),
                            }],
                        stopReason: 'decision',
                    });
                }
                return true;
            };

            const engine = adapter.engineForState(state);
            const carrierIsShenmai = engine.isShenmai(expected.from);
            const shenmaiCount = state.talents.filter(id =>
                adapter.engineForState(state).isShenmai(Number(id))
            ).length;
            const allowShenmaiExchange =
                carrierIsShenmai && shenmaiCount >= 2;
            let conflictId = allowShenmaiExchange ? 0
                : state.talents.find(id =>
                    adapter.quality(Number(id)) < 4
                    && adapter.engineForState(state).talentType(Number(id))
                        === carrierType
                ) || 0;
            for (let index = 0;
                !allowShenmaiExchange && !conflictId
                && index < maxCarrierWait && canAddWash(); index++) {
                if (!washWith(heldTargets)) break;
                conflictId = state.talents.find(id =>
                    adapter.quality(Number(id)) < 4
                    && adapter.engineForState(state).talentType(Number(id))
                        === carrierType
                ) || 0;
            }
            if (!allowShenmaiExchange && !conflictId) return;

            let keep = uniqueNumbers(
                (allowShenmaiExchange ? [] : [conflictId]).concat(
                    targets.filter(id => state.talents.includes(id))
                )
            );
            for (let index = 0;
                !state.talents.includes(expected.from)
                && index < maxCarrierWait && canAddWash();
                index++) {
                if (!washWith(keep)) break;
            }
            if (!state.talents.includes(expected.from)) return;
            keep = uniqueNumbers(keep.concat([expected.from]));
            let replaced = null;
            for (let index = 0;
                index <= maxCarrierWait && canAddWash(); index++) {
                const prepared = adapter.prepareLocks(state, keep);
                const position = prepared.talents.indexOf(expected.from);
                if (position < 0) return;
                try {
                    const candidate = adapter.replace(
                        prepared, position, keep
                    );
                    if (Number(candidate.addedId) === expected.to) {
                        replaced = candidate;
                        break;
                    }
                } catch (error) {
                    // Keep waiting while the conflict is still present.
                }
                if (index >= maxCarrierWait
                    || !washWith(keep)) break;
            }
            if (!replaced) return;
            const readyState = state;
            const readyPills = pills;
            const readyWashes = washes;
            const readySteps = steps.slice();
            const readyKeep = keep.slice();
            steps.push({
                op: 'locks',
                lockIds: keep,
            });
            steps.push({
                op: 'exchange',
                carrierId: expected.from,
                lockIds: keep,
                removedId: Number(replaced.removedId),
                addedId: Number(replaced.addedId),
            });
            addCandidate(output, makeNode(
                node,
                replaced.state,
                keep.filter(id =>
                    replaced.state.talents.includes(id)
                ),
                {
                    type: 'chain-prep',
                    steps,
                },
                pills,
                washes,
                node.exchangeCount + 1
            ));

            const nextExpected =
                configuredExchangeChain[node.exchangeChainIndex + 1];
            if (!nextExpected) return;
            const nextConflictType =
                adapter.engineForState(readyState).talentType(
                    nextExpected.from
                );
            const hasNextConflict = current =>
                current.talents.some(id =>
                    adapter.quality(Number(id)) < 4
                    && adapter.engineForState(current).talentType(
                        Number(id)
                    ) === nextConflictType
                );
            if (hasNextConflict(readyState)) return;
            let lookState = readyState;
            let lookPills = readyPills;
            let lookWashes = readyWashes;
            const lookSteps = readySteps.slice();
            for (let index = 0;
                index < maxCarrierWait * 2 && canAddWash(); index++) {
                const washed = adapter.wash(lookState, readyKeep);
                lookState = washed.state;
                lookPills += Number(washed.cost) || 0;
                lookWashes += 1;
                metrics.simulatedWashes++;
                lookSteps.push({
                    op: 'locks',
                    lockIds: readyKeep.slice(),
                });
                lookSteps.push({
                    op: 'wash',
                    keepIds: readyKeep.slice(),
                    count: 1,
                    cost: Number(washed.cost) || 0,
                    generatedPurples: (washed.generatedEvents || [])
                        .filter(event =>
                            adapter.quality(Number(event.id)) === 4
                        ).map(event => ({
                            at: 1,
                            id: Number(event.id),
                            fromPity: !!event.fromPity,
                        })),
                    pityPurples: washed.pityPurpleId == null
                        ? [] : [{
                            id: Number(washed.pityPurpleId),
                        }],
                    stopReason: 'decision',
                });
                if (!hasNextConflict(lookState)) continue;
                const prepared = adapter.prepareLocks(
                    lookState, readyKeep
                );
                const position = prepared.talents.indexOf(expected.from);
                if (position < 0) break;
                let candidate;
                try {
                    candidate = adapter.replace(
                        prepared, position, readyKeep
                    );
                } catch (error) {
                    break;
                }
                if (Number(candidate.addedId) !== expected.to) continue;
                lookSteps.push({
                    op: 'locks',
                    lockIds: readyKeep.slice(),
                });
                lookSteps.push({
                    op: 'exchange',
                    carrierId: expected.from,
                    lockIds: readyKeep.slice(),
                    removedId: Number(candidate.removedId),
                    addedId: Number(candidate.addedId),
                });
                addCandidate(output, makeNode(
                    node,
                    candidate.state,
                    readyKeep.filter(id =>
                        candidate.state.talents.includes(id)
                    ),
                    {
                        type: 'chain-prep-lookahead',
                        steps: lookSteps,
                        chainLookahead: true,
                    },
                    lookPills,
                    lookWashes,
                    node.exchangeCount + 1
                ));
                break;
            }
        }

        function generateCarrierFirstPrelude(node, output,
            targetKeepOverride) {
            const expected =
                configuredExchangeChain[node.exchangeChainIndex];
            if (!expected || !canAddWash()) return;
            let state = node.engineState;
            let pills = node.pillsUsed;
            let washes = node.washes;
            const heldTargets = (targetKeepOverride || []).filter(id =>
                state.talents.includes(id)
            );
            const steps = [];
            const washWith = keep => {
                if (!canAddWash()) return false;
                const washed = adapter.wash(state, keep);
                state = washed.state;
                pills += Number(washed.cost) || 0;
                washes += 1;
                metrics.simulatedWashes++;
                steps.push({
                    op: 'locks',
                    lockIds: keep.slice(),
                });
                steps.push({
                    op: 'wash',
                    keepIds: keep.slice(),
                    count: 1,
                    cost: Number(washed.cost) || 0,
                    generatedPurples: (washed.generatedEvents || [])
                        .filter(event =>
                            adapter.quality(Number(event.id)) === 4
                        ).map(event => ({
                            at: 1,
                            id: Number(event.id),
                            fromPity: !!event.fromPity,
                        })),
                    pityPurples: washed.pityPurpleId == null
                        ? [] : [{ id: Number(washed.pityPurpleId) }],
                    stopReason: 'decision',
                });
                return true;
            };
            for (let index = 0;
                !state.talents.includes(expected.from)
                && index < maxCarrierWait && canAddWash(); index++) {
                if (!washWith(heldTargets)) return;
            }
            if (!state.talents.includes(expected.from)) return;
            const carrierType = adapter.engineForState(state).talentType(
                expected.from
            );
            let keep = uniqueNumbers(heldTargets.concat([expected.from]));
            for (let index = 0;
                index < maxCarrierWait * 2 && canAddWash(); index++) {
                const low = state.talents.find(id =>
                    adapter.quality(Number(id)) < 4
                    && adapter.engineForState(state).talentType(Number(id))
                        === carrierType
                );
                if (low) {
                    const locks = uniqueNumbers(
                        heldTargets.concat([low, expected.from])
                    );
                    const prepared = adapter.prepareLocks(state, locks);
                    const position = prepared.talents.indexOf(expected.from);
                    if (position >= 0) {
                        try {
                            const replaced = adapter.replace(
                                prepared, position, locks
                            );
                            if (Number(replaced.addedId) === expected.to) {
                                const actions = steps.concat([{
                                    op: 'locks',
                                    lockIds: locks,
                                }, {
                                    op: 'exchange',
                                    carrierId: expected.from,
                                    lockIds: locks,
                                    removedId: Number(replaced.removedId),
                                    addedId: Number(replaced.addedId),
                                }]);
                                addCandidate(output, makeNode(
                                    node,
                                    replaced.state,
                                    locks.filter(id =>
                                        replaced.state.talents.includes(id)
                                    ),
                                    {
                                        type: 'chain-carrier-first',
                                        steps: actions,
                                    },
                                    pills,
                                    washes,
                                    node.exchangeCount + 1
                                ));
                                return;
                            }
                        } catch (error) {
                            // Continue until both conflict and luck align.
                        }
                    }
                }
                if (!washWith(keep)) return;
            }
        }

        if (configuredExchangeChain.length) {
            let chainFrontier = [rootNode];
            let bestChainNode = rootNode;
            policyLabel = 'exchange-chain-beam';
            for (let depth = 0;
                depth < maxDepth && chainFrontier.length && !stopped;
                depth++) {
                const cap = capReached();
                if (cap) {
                    stopped = true;
                    stopReason = cap;
                    break;
                }
                const next = new Map();
                for (const node of chainFrontier) {
                    if (targetStats(node.engineState, targets)
                        === targets.length) {
                        rememberBest(node);
                        if (stopOnFirstRoute) break;
                        continue;
                    }
                    metrics.expandedNodes++;
                    const outputs = new Map();
                    const preludeOutputs = new Map();
                    const heldTargetIds = targets.filter(id =>
                        node.engineState.talents.includes(id)
                    );
                    for (const targetKeep of subsets(
                        heldTargetIds,
                        Math.max(0, adapter.slotCount(
                            node.engineState
                        ) - 1)
                    )) {
                        const heldEarlyTargets = earlyTargetIds.filter(
                            id => heldTargetIds.includes(id)
                        );
                        if (heldEarlyTargets.length
                            && !heldEarlyTargets.every(id =>
                                targetKeep.includes(id)
                            )) {
                            continue;
                        }
                        generateChainPrelude(
                            node, preludeOutputs, targetKeep
                        );
                        generateCarrierFirstPrelude(
                            node, preludeOutputs, targetKeep
                        );
                    }
                    for (const child of preludeOutputs.values()) {
                        addCandidate(outputs, child);
                    }
                    generateUpgrade(node, outputs);
                    if (!preludeOutputs.size) {
                        const masks = usefulLockMasks(
                            adapter,
                            node.engineState,
                            targets,
                            node.lockSet,
                            maxLockMasks
                        );
                        generateWashRun(node, masks, outputs);
                        generateExchanges(node, masks, outputs);
                        generateExchangeClosure(node, masks, outputs);
                        generateExchangePads(node, outputs);
                        generateCarrierExchangeMacro(node, outputs);
                    }
                    for (const child of outputs.values()) {
                        const prior = stateSeen.get(child.searchKey);
                        if (prior != null && prior <= child.pillsUsed) {
                            metrics.dominatedNodes++;
                            continue;
                        }
                        stateSeen.set(child.searchKey, child.pillsUsed);
                        if (root.__WASH_SEARCH_TRACE
                            && child.exchangeChainIndex
                                > metrics.bestExchangeChainIndex) {
                            metrics.bestExchangeChainIndex =
                                child.exchangeChainIndex;
                            console.log('[WashSearchV2][exchange-chain] '
                                + child.exchangeChainIndex + '/'
                                + configuredExchangeChain.length
                                + ' pills=' + child.pillsUsed
                                + ' washes=' + child.washes
                                + ' field='
                                + child.engineState.talents.map(nameOf)
                                    .join('/'));
                        }
                        if (child.exchangeChainIndex
                            > bestChainNode.exchangeChainIndex) {
                            bestChainNode = child;
                        }
                        if (targetStats(child.engineState, targets)
                            === targets.length) {
                            rememberBest(child);
                            if (stopOnFirstRoute) break;
                        }
                        const existing = next.get(child.searchKey);
                        if (!existing || compareNodes(
                            child, existing, targets.length
                        ) < 0) {
                            next.set(child.searchKey, child);
                        }
                    }
                    if (stopped) break;
                }
                if (stopped) break;
                chainFrontier = Array.from(next.values())
                    .sort((a, b) =>
                        compareNodes(a, b, targets.length)
                    )
                    .slice(0, beamWidth);
                metrics.frontierPeak = Math.max(
                    metrics.frontierPeak, chainFrontier.length
                );
            }
            metrics.uniqueStates = stateSeen.size;
            return {
                ok: !!bestRoute,
                status: bestRoute ? 'resource-limited' : 'no-route',
                provenOptimal: false,
                route: bestRoute,
                metrics,
                stopReason: bestRoute
                    ? 'exchange-chain-route'
                    : (stopReason || 'exchange-chain-exhausted'),
                partialRoute: bestRoute ? null : {
                    pills: bestChainNode.pillsUsed,
                    washes: bestChainNode.washes,
                    exchangeChainIndex:
                        bestChainNode.exchangeChainIndex,
                    steps: materializeSteps(
                        bestChainNode, adapter.start.steps
                    ),
                    finalState: Object.assign(
                        {}, bestChainNode.engineState, {
                            talents:
                                bestChainNode.engineState.talents.slice(),
                        }
                    ),
                },
            };
        }
        const perSeedWashBudget = Math.max(
            5000, Math.floor(maxPolicyWashes / 20)
        );
        if (stopOnFirstRoute && !stopped) {
            policyLabel = 'fast-preferred:' + targets[0];
            policyRollout(
                rootNode,
                true,
                targets[0],
                false,
                false,
                false,
                Math.min(
                    maxPolicyWashes,
                    Math.max(
                        20000,
                        Math.floor(limits.maxWashSteps * 0.1)
                    )
                )
            );
        }
        if (chainSearch && rootNode.engineState.luckSeed != null && !stopped) {
            const reverseOrders = configuredTargetOrder.length === targets.length
                && configuredTargetOrder.every(id => targets.includes(id))
                ? [{
                    order: configuredTargetOrder.slice(),
                    mode: 'forward',
                    stages: [],
                    tailGap: 0,
                    totalCost: 0,
                }]
                : generateReverseTargetOrders(
                    rootNode, reverseTailOrderLimit
                );
            metrics.reverseTailOrders += reverseOrders.length;
            const policyStarts = generateInitialReleaseStarts(
                rootNode, 4
            );
            metrics.initialReleaseNodes = policyStarts.length;
            for (const plan of reverseOrders) {
                if (stopped) break;
                if (bestRoute) break;
                if (root.__WASH_SEARCH_TRACE) {
                    console.log('[WashSearchV2][reverse-order] '
                        + (plan.mode || 'backward') + ' '
                        + plan.order.map(nameOf).join(' > ')
                        + ' tailGap=' + plan.tailGap
                        + ' cost=' + plan.totalCost
                        + ' anchors=' + plan.stages.map(stage =>
                            (stage.ordinal ? 'O' + stage.ordinal : 'C')
                            + ':' + nameOf(stage.target)
                        ).join('>'));
                }
                policyLabel = 'reverse-tail-chain:'
                    + plan.order.map(nameOf).join('>');
                for (const policyStart of policyStarts) {
                    if (stopped || bestRoute) break;
                    chainPolicyRollout(
                        policyStart,
                        plan.mode === 'forward'
                            ? Math.max(20000, Math.floor(
                                maxPolicyWashes / 4
                            ))
                            : Math.max(
                                6000,
                                Math.floor(maxPolicyWashes
                                    / Math.max(
                                        3,
                                        reverseOrders.length
                                            * policyStarts.length * 3
                                    ))
                            ),
                        true,
                        plan.order,
                        plan.mode
                    );
                }
            }
            for (const plan of reverseOrders) {
                if (stopped) break;
                if (bestRoute) break;
                policyLabel = 'reverse-tail:'
                    + plan.order.map(nameOf).join('>');
                runDualChainSearch(
                    rootNode,
                    plan.mode === 'forward'
                        ? Math.max(20000, Math.floor(maxPolicyWashes / 5))
                        : Math.max(
                            6000,
                            Math.floor(maxPolicyWashes
                                / Math.max(3, reverseOrders.length * 2))
                        ),
                    plan.order,
                    plan.mode
                );
            }
            if (bestRoute) metrics.reverseTailRoutes++;
            policyLabel = 'dual-greedy-seed';
            pureChainRollout(
                rootNode,
                Math.max(20000, Math.floor(maxPolicyWashes / 5))
            );
            const targetStarts = Array.from(dualTargetSeeds.values())
                .sort((a, b) =>
                    (b.targetHeldCount - a.targetHeldCount)
                    || (a.pillsUsed - b.pillsUsed)
                    || (a.nextTargetDistance - b.nextTargetDistance))
                .slice(0, 8);
            for (const targetStart of targetStarts) {
                if (stopped || bestRoute) break;
                policyLabel = 'dual-chain';
                if (root.__WASH_SEARCH_TRACE) {
                    console.log('[WashSearchV2][dual-start] pills='
                        + targetStart.pillsUsed
                        + ' washes=' + targetStart.washes
                        + ' targets=' + targets.filter(id =>
                            targetStart.engineState.talents.includes(id))
                            .map(nameOf).join('/'));
                }
                runDualChainSearch(
                    targetStart,
                    Math.max(20000, Math.floor(maxPolicyWashes / 8))
                );
            }
            if (!stopped && !bestRoute) {
                policyLabel = 'dual-chain-root';
                runDualChainSearch(rootNode, maxPolicyWashes);
            }
        }
        policyLabel = 'pity-seed';
        const seedStarts = generateSeedProbeNodes(
            rootNode, chainBeamWidth
        );
        for (const seedStart of seedStarts) {
            if (stopped) break;
            if (seedStart.targetHeldCount > 0
                || seedStart.engineState.luckSeed != null) {
                policyLabel = 'pity-seed';
                chainPolicyRollout(seedStart, perSeedWashBudget);
                policyLabel = 'fixed-chain';
                chainFollowRollout(seedStart, perSeedWashBudget);
                policyLabel = 'pure-chain';
                pureChainRollout(seedStart, perSeedWashBudget);
            }
        }
        policyLabel = 'copy-point';
        const copyPointStarts = generateCopyPointNodes(
            rootNode,
            Math.max(4, Math.floor(chainBeamWidth / 2)),
            Math.max(4, Math.floor(chainBeamWidth / 2))
        );
        metrics.copyPointNodes += copyPointStarts.length;
        for (const copyStart of copyPointStarts) {
            if (stopped) break;
            if (chainSearch && reverseTailOrderLimit > 0) {
                const plans = generateReverseTargetOrders(
                    copyStart, Math.min(3, reverseTailOrderLimit)
                );
                metrics.reverseTailOrders += plans.length;
                for (const plan of plans) {
                    if (stopped || bestRoute) break;
                    policyLabel = 'reverse-tail-copy:'
                        + plan.order.map(nameOf).join('>');
                    runDualChainSearch(
                        copyStart,
                        Math.max(6000, Math.floor(
                            perSeedWashBudget
                            / Math.max(3, plans.length)
                        )),
                        plan.order,
                        plan.mode
                    );
                }
            }
            policyLabel = 'copy-point-chain';
            chainPolicyRollout(copyStart, perSeedWashBudget);
            chainFollowRollout(copyStart, perSeedWashBudget);
            policyLabel = 'pure-chain';
            pureChainRollout(copyStart, perSeedWashBudget);
        }
        policyLabel = 'chain-portfolio';
            const portfolioBudget = Math.max(
                5000, Math.min(60000, Math.floor(maxPolicyWashes / 4))
            );
            const portfolioStarts = copyPointStarts.concat(seedStarts)
                .filter((node, index, values) =>
                    node.engineState.luckSeed != null
                    && values.findIndex(item =>
                        item.stateKey === node.stateKey
                    ) === index)
                .slice(0, 2);
            metrics.chainPortfolioNodes += portfolioStarts.length;
            for (const portfolioStart of portfolioStarts) {
                if (stopped) break;
                chainPolicyRollout(
                    portfolioStart, portfolioBudget, true
                );
            }
            policyLabel = 'pure-chain';
            if (!stopped) pureChainRollout(rootNode, maxPolicyWashes);
            policyLabel = 'fixed-chain';
            if (!stopped) {
                chainFollowRollout(rootNode, perSeedWashBudget);
            }
            policyLabel = 'chain';
            if (!stopped && !bestRoute) {
                chainPolicyRollout(rootNode);
            }
            for (const preferredTarget of targets) {
                policyLabel = 'wait-after-two-exchanges:'
                    + preferredTarget;
                if (!stopped && !bestRoute) {
                    policyRollout(
                        rootNode, true, preferredTarget,
                        true, false, true
                    );
                }
            }
            for (const preferredTarget of targets) {
                policyLabel = 'preferred:' + preferredTarget;
                if (!stopped && !bestRoute) {
                    policyRollout(
                        rootNode, true, preferredTarget, false
                    );
                }
            }
            policyLabel = 'direct-targets';
            if (!stopped && !bestRoute) {
                policyRollout(rootNode, true, 0, true, true);
            }
            policyLabel = 'sacrifice';
            if (!stopped && !bestRoute) {
                policyRollout(rootNode, true, 0, true);
            }
            policyLabel = 'natural';
            if (!stopped && !bestRoute) {
                policyRollout(rootNode, false, 0, true);
            }
            policyLabel = 'greedy';
            if (!bestRoute) greedyRollout(rootNode);
        policyLabel = 'beam';
        let frontier = [rootNode];
        let beamPruned = false;

        for (let depth = 0; depth < maxDepth && frontier.length && !stopped; depth++) {
            const next = new Map();
            for (let index = 0; index < frontier.length; index++) {
                if (typeof hook.shouldCancel === 'function') {
                    try {
                        if (hook.shouldCancel()) {
                            cancelled = true;
                            stopped = true;
                            stopReason = 'cancelled';
                            break;
                        }
                    } catch (error) { }
                }
                const cap = capReached();
                if (cap) {
                    stopped = true;
                    stopReason = cap;
                    break;
                }
                const node = frontier[index];
                if (bestRoute && node.pillsUsed >= bestRoute.pills) continue;
                if (targetStats(node.engineState, targets) === targets.length) {
                    rememberBest(node);
                    continue;
                }
                metrics.expandedNodes++;
                const children = expand(node);
                for (const child of children) {
                    const prior = stateSeen.get(child.stateKey);
                    if (prior != null && prior <= child.pillsUsed) {
                        metrics.dominatedNodes++;
                        continue;
                    }
                    stateSeen.set(child.stateKey, child.pillsUsed);
                    if (targetStats(child.engineState, targets) === targets.length) {
                        rememberBest(child);
                    }
                    const existing = next.get(child.stateKey);
                    if (!existing || compareNodes(child, existing, targets.length) < 0) {
                        next.set(child.stateKey, child);
                    }
                }
                if (typeof hook.onProgress === 'function' && metrics.expandedNodes % 250 === 0) {
                    try {
                        hook.onProgress({
                            phase: 'beam',
                            depth,
                            expandedNodes: metrics.expandedNodes,
                            uniqueStates: stateSeen.size,
                            simulatedWashes: metrics.simulatedWashes,
                            frontierSize: next.size,
                            bestPills: bestRoute && bestRoute.pills,
                        });
                    } catch (error) { }
                }
            }
            if (stopped) break;
            const generated = Array.from(next.values());
            const children = configuredExchangeChain.length
                ? generated.sort((a, b) =>
                    compareNodes(a, b, targets.length)
                ).slice(0, beamWidth)
                : selectStratifiedFrontier(
                    generated, beamWidth, targets.length
                );
            if (generated.length > beamWidth) {
                metrics.beamPrunedNodes += generated.length - beamWidth;
                beamPruned = true;
            }
            frontier = children;
            metrics.frontierPeak = Math.max(metrics.frontierPeak, frontier.length);
            if (root.__WASH_SEARCH_TRACE) {
                console.log('[WashSearchV2] depth=' + depth
                    + ' frontier=' + frontier.length
                    + ' top=' + frontier.slice(0, 5).map(node =>
                        `${node.targetHeldCount}/${node.pillsUsed}丹/${node.washes}洗:`
                        + node.engineState.talents.map(nameOf).join('/')).join(' || '));
            }
        }

        if (!stopped && maxDepth && frontier.length) {
            stopped = true;
            stopReason = 'max-depth';
        }
        metrics.uniqueStates = stateSeen.size;
        if (cancelled) {
            return {
                ok: !!bestRoute,
                status: 'cancelled',
                provenOptimal: false,
                route: bestRoute,
                metrics,
                stopReason: 'cancelled',
            };
        }
        if (stopReason && stopReason.startsWith('max-')) {
            return {
                ok: !!bestRoute,
                status: 'resource-limited',
                provenOptimal: false,
                route: bestRoute,
                metrics,
                stopReason,
            };
        }
        if (bestRoute && stopReason === 'first-route') {
            return {
                ok: true,
                status: 'resource-limited',
                provenOptimal: false,
                route: bestRoute,
                metrics,
                stopReason,
            };
        }
        if (bestRoute) {
            const proven = !beamPruned && !metrics.beamPrunedNodes;
            return {
                ok: true,
                status: proven ? 'optimal' : 'resource-limited',
                provenOptimal: proven,
                route: bestRoute,
                metrics,
                stopReason: proven ? 'frontier-exhausted' : 'beam-pruned',
            };
        }
        return {
            ok: false,
            status: beamPruned ? 'resource-limited' : 'no-route',
            provenOptimal: !beamPruned,
            route: null,
            metrics,
            stopReason: beamPruned ? 'beam-pruned' : 'frontier-exhausted',
        };
    }

    root.WashSearchV2 = Object.freeze({
        VERSION,
        DEFAULT_LIMITS,
        DEFAULT_RUNTIME,
        createRuleAdapter: createAdapter,
        search,
        replay,
        toConstructorResult,
        nameOf,
    });
})(typeof window !== 'undefined' ? window : globalThis);
