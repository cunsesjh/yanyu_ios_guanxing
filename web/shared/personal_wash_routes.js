/* Personal route replay and export; uses the upstream engine for every draw. */
(function (root) {
    'use strict';
    function numeric(value, fallback = 0) {
        const result = Number(value);
        return Number.isFinite(result) ? result : fallback;
    }

    function traceAppend(trace, action) {
        return { previous: trace || null, action };
    }

    function traceActions(trace) {
        const actions = [];
        for (let cursor = trace; cursor; cursor = cursor.previous) actions.push(cursor.action);
        actions.reverse();
        return actions;
    }

    function positionsForIds(state, ids) {
        const remaining = state.talents.map((id, index) => ({ id, index, used: false }));
        return ids.map(id => {
            const item = remaining.find(value => !value.used && value.id === id);
            if (!item) throw new Error(`锁脉回放失败：槽位中不存在天赋 ${id}`);
            item.used = true;
            return item.index;
        });
    }

    function idsInStateOrder(state, ids) {
        const wanted = new Set(ids);
        return state.talents.filter(id => wanted.has(id));
    }

    function actionWash(engine, state, keepIds, mode) {
        const result = engine.wash(state, positionsForIds(state, keepIds));
        return {
            state: result.state,
            action: {
                kind: 'wash',
                mode,
                keepIds: result.keepIds,
                cost: result.cost,
                draws: result.draws,
                generatedBars: result.generatedBars,
                after: result.state,
            },
        };
    }

    function actionReplace(engine, state, position, mode, lockedIds = []) {
        const orderedLocks = idsInStateOrder(state, lockedIds);
        const result = engine.replace(state, position, orderedLocks);
        return {
            state: result.state,
            action: {
                kind: 'exchange',
                mode,
                keepIds: orderedLocks,
                cost: 0,
                draws: result.draws,
                generatedBars: 0,
                removedId: result.removedId,
                addedId: result.addedId,
                after: result.state,
            },
        };
    }

    function actionOpen(engine, state) {
        const fourth = state.zizhi === 153;
        const upgraded = fourth ? engine.upgradeToFour(state)
            : {...root.AutoWash2Engine.cloneState(state), zizhi: state.zizhi + 1};
        return {
            state: upgraded,
            action: {
                kind: fourth ? 'upgrade' : 'openSlot',
                mode: 'open-next',
                keepIds: [],
                cost: 0,
                draws: 0,
                generatedBars: 0,
                after: upgraded,
            },
        };
    }

    function stateTalentNames(engine, state, lockedIds = []) {
        const locked = new Set(lockedIds);
        return state.talents.map(id => ({ id, name: engine.name(id), locked: locked.has(id) }));
    }

    function replayNode(ctx, node, actions) {
        let state = root.AutoWash2Engine.cloneState(ctx.startState);
        let pills = 0;
        for (const action of actions) {
            if (action.kind === 'wash') {
                const replayed = ctx.engine.wash(state, positionsForIds(state, action.keepIds));
                state = replayed.state;
                pills += replayed.cost;
            } else if (action.kind === 'exchange') {
                const position = state.talents.indexOf(action.removedId);
                if (position < 0) throw new Error(`路线回放失败：找不到待置换天赋 ${action.removedId}`);
                state = ctx.engine.replace(state, position, action.keepIds).state;
            } else if (action.kind === 'openSlot') {
                state = {...root.AutoWash2Engine.cloneState(state), zizhi: state.zizhi + 1};
            } else if (action.kind === 'upgrade') {
                state = ctx.engine.upgradeToFour(state);
            } else throw Error('无法回放未知操作：' + action.kind);
            if (root.AutoWash2Engine.stateKey(state) !== root.AutoWash2Engine.stateKey(action.after)) {
                throw new Error('路线回放失败：操作后状态与搜索状态不一致');
            }
        }
        if (pills !== node.cost || root.AutoWash2Engine.stateKey(state) !== root.AutoWash2Engine.stateKey(node.state)) {
            throw new Error('路线回放失败：累计丹耗或最终状态不一致');
        }
    }

    function stepLabel(group, engine) {
        if (group.kind === 'openSlot') return `开启第 ${group.after.zizhi - 150} 槽`;
        if (group.kind === 'upgrade') return '开启第四脉';
        if (group.kind === 'exchange') return '置换冲突紫脉';
        if (!group.keepIds.length) return '不锁脉推进';
        return `锁定 ${group.keepIds.map(id => engine.name(id)).join('、')} 推进`;
    }

    function stepDetail(group, engine) {
        if (group.kind === 'openSlot') return '提升资质开槽，保持当前脉序。';
        if (group.kind === 'upgrade') return '在当前三脉状态开启第四脉；开槽本身不推进洗髓种子。';
        if (group.kind === 'exchange') {
            if (group.keepIds.length) {
                const locks = group.keepIds.map(id => engine.name(id)).join('、');
                return `锁定「${locks}」，置换「${engine.name(group.removedId)}」，应得到「${engine.name(group.addedId)}」。`;
            }
            return `点击置换「${engine.name(group.removedId)}」，应得到「${engine.name(group.addedId)}」。`;
        }
        const locks = group.keepIds.length
            ? `锁定「${group.keepIds.map(id => engine.name(id)).join('、')}」`
            : '取消全部锁定';
        return `${locks}，连续洗脉 ${group.count} 次；以每次结果核对最后一组槽位。`;
    }

    function routeFromNode(ctx, node) {
        const actions = traceActions(node.trace);
        replayNode(ctx, node, actions);
        const groups = root.AutoWash2Optimizer.compactActions(actions);
        const steps = [];
        let cumulativePills = 0;
        let cumulativeWashes = 0;
        let cumulativeTalentBars = 0;
        const initialSlots = Math.max(0, Math.min(4, numeric(ctx.initialState.zizhi) - 150));
        const costBreakdown = {};
        for (const group of groups) {
            cumulativePills += group.cost;
            cumulativeWashes += group.kind === 'wash' ? group.count : 0;
            cumulativeTalentBars += group.generatedBars;
            if (group.kind === 'wash') {
                const slotCount = Math.max(0, Math.min(4, numeric(group.after?.zizhi, 154) - 150));
                const bucket = group.keepIds.length ? `lock${group.keepIds.length}`
                    : (slotCount === 3 ? 'threeUnlocked' : 'fourUnlocked');
                costBreakdown[bucket] = numeric(costBreakdown[bucket]) + group.cost;
            }
            steps.push({
                type: group.kind,
                label: stepLabel(group, ctx.engine),
                detail: stepDetail(group, ctx.engine),
                expectedName: group.kind === 'exchange' ? ctx.engine.name(group.addedId) : '',
                washes: group.kind === 'wash' ? group.count : 0,
                unitCost: group.kind === 'wash' ? group.cost / Math.max(1, group.count) : null,
                pills: group.cost,
                cumulativePills,
                cumulativeWashes,
                cumulativeTalentBars,
                after: { talents: stateTalentNames(ctx.engine, group.after, group.keepIds) },
            });
        }
        steps.push({
            type: 'verify', label: '核对最终目标',
            detail: `确认槽位同时包含：${ctx.targetIds.map(id => ctx.engine.name(id)).join('、')}。`,
            washes: 0, unitCost: null, pills: 0, cumulativePills, cumulativeWashes,
            cumulativeTalentBars, after: { talents: stateTalentNames(ctx.engine, node.state, ctx.targetIds) },
        });
        const available = ctx.hasBagPills ? ctx.bagPills : null;
        return {
            kind: 'source-bounded-tactical', verified: true, verifiedOptimal: false,
            branchId: `source-bounded-${node.serial}`,
            branchLabel: initialSlots === 4 ? '当前四槽起点' : `${initialSlots} 槽真实起手`,
            slotPath: [initialSlots, ...groups.filter(group => ['upgrade', 'openSlot'].includes(group.kind)).map(group => group.after.zizhi - 150)]
                .filter((value, index, values) => index === 0 || value !== values[index - 1]),
            totalPills: node.cost, totalWashes: cumulativeWashes,
            totalTalentBars: cumulativeTalentBars,
            exchangeCount: groups.filter(group => group.kind === 'exchange').length,
            steps,
            finalTalents: stateTalentNames(ctx.engine, node.state, ctx.targetIds),
            finalState: {
                zizhi: numeric(node.state.zizhi, 154),
                seed: node.state.bornSeed,
                luck_seed: node.state.luckSeed,
                luck_seed_inited: node.state.luckSeed != null,
                born_talent_rc: numeric(node.state.bornRC),
                tal_lucky: node.state.talLucky,
                talents: stateTalentNames(ctx.engine, node.state, ctx.targetIds),
            },
            costBreakdown,
            inventory: {
                available,
                enough: available == null ? null : available >= node.cost,
                shortfall: available == null ? null : Math.max(0, node.cost - available),
                remaining: available == null ? null : available - node.cost,
            },
        };
    }

    root.PersonalWashRoutes = Object.freeze({actionWash, actionReplace, actionOpen, traceAppend, routeFromNode});
})(self);
