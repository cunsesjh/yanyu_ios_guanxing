/* Format AWASH route actions for the browser without treating metadata as cost. */
(function (root) {
    'use strict';

    function normalizeRoute(route, branchIndex, name) {
        if (!route || !Array.isArray(route.steps)) return null;
        const nameOf = id => name(Number(id) || 0);
        const steps = [];
        let totalStepPills = 0, totalStepWashes = 0, currentLocks = null;

        for (let sourceIndex = 0; sourceIndex < route.steps.length; sourceIndex++) {
            const source = route.steps[sourceIndex];
            const op = String(source.op || source.type || 'wash');
            const afterSource = source.after
                || (Array.isArray(route.stepStates)
                    ? route.stepStates[sourceIndex] : null);
            const after = afterSource && Array.isArray(afterSource.talents)
                ? {zizhi: Number(afterSource.zizhi) || 0,
                    talents: afterSource.talents.map(item => {
                        const id = Number(typeof item === 'object' ? item.id : item) || 0;
                        return {id, name: typeof item === 'object' && item.name
                            ? item.name : nameOf(id),
                        locked: !!(typeof item === 'object' && item.locked)};
                    })}
                : null;
            if (op === 'wash') {
                const count = Math.max(0, Number(source.count) || 0);
                const pills = Math.max(0, Number(source.cost) || 0);
                const hasKeepIds = Array.isArray(source.keepIds);
                const keepIds = hasKeepIds ? source.keepIds.map(Number) : (currentLocks || []);
                const normalizedKeepIds = [...new Set(keepIds)].sort((a, b) => a - b);
                const keptNames = normalizedKeepIds.map(nameOf);
                const generatedPurples = [...new Set([
                    ...(source.generatedPurples || []).map(item => Number(item && item.id)),
                    ...(source.pityPurples || []).map(Number),
                ].filter(id => id > 0))].map(nameOf);
                const detail = `本段连续洗髓 ${count} 次；洗髓时${keptNames.length
                    ? `锁定并保留：${keptNames.join('、')}` : '不锁脉'}。${generatedPurples.length
                    ? `本段遇到紫脉：${generatedPurples.join('、')}。` : ''}`;
                const key = JSON.stringify(normalizedKeepIds);
                const previous = steps[steps.length - 1];
                if (previous && previous._washKey === key) {
                    previous.washes += count;
                    previous.pills += pills;
                    previous.detail = `本段连续洗髓 ${previous.washes} 次；洗髓时${keptNames.length
                        ? `锁定并保留：${keptNames.join('、')}` : '不锁脉'}。${generatedPurples.length
                        ? `本段遇到紫脉：${generatedPurples.join('、')}。` : ''}`;
                    if (after) previous.after = after;
                } else {
                    steps.push({label: '洗髓', detail, pills, washes: count,
                        after, _washKey: key});
                }
                totalStepPills += pills;
                totalStepWashes += count;
                currentLocks = normalizedKeepIds;
                continue;
            }

            if (op === 'locks') {
                const ids = [...new Set((source.lockIds || []).map(Number))].sort((a, b) => a - b);
                if (currentLocks && JSON.stringify(currentLocks) === JSON.stringify(ids)) continue;
                currentLocks = ids;
                const special = String(source.type || '');
                const label = ids.length ? '调整锁脉' : '解除锁脉';
                const detail = special === 'lockConflict' && source.id
                    ? `锁定冲突脉「${nameOf(source.id)}」`
                    : ids.length ? `锁定：${ids.map(nameOf).join('、')}` : '解除全部锁脉';
                steps.push({label,
                    detail: `${detail}；后续洗髓或置换按此锁脉状态执行。`,
                    pills: 0, washes: 0, after});
            } else if (op === 'exchange' || op === 'burn') {
                const lockedNames = (source.lockIds || []).map(Number).filter(id => id > 0).map(nameOf);
                steps.push({label: '置换',
                    detail: `将「${nameOf(source.removedId || source.from || source.carrierId)}」置换为「${nameOf(source.addedId || source.to || source.id)}」；置换时${lockedNames.length
                        ? `锁定：${lockedNames.join('、')}` : '不额外锁脉'}。`,
                    pills: 0, washes: 0, after});
            } else if (op === 'upgrade') {
                const toZizhi = Number(source.zizhi || source.toZizhi) || 0;
                const slotCount = toZizhi >= 154 ? 4
                    : toZizhi === 153 ? 3
                        : toZizhi === 152 ? 2
                            : toZizhi === 151 ? 1 : 0;
                steps.push({label: '开启槽位',
                    detail: `开启${slotCount}槽；后续按新的槽位与脉池继续规划。`,
                    pills: 0, washes: 0, after});
            }
        }

        const totalPills = Number(route.pills ?? route.cost) || totalStepPills;
        const difference = totalPills - totalStepPills;
        if (difference && steps.length) {
            const lastWash = [...steps].reverse().find(step => step.label === '洗髓');
            if (lastWash) lastWash.pills = Math.max(0, lastWash.pills + difference);
        }
        let cumulativePills = 0;
        for (const step of steps) {
            delete step._washKey;
            cumulativePills += step.pills;
            step.cumulativePills = cumulativePills;
        }

        const finalTalents = (route.finalTalents || []).map(item => {
            const id = Number(typeof item === 'object' ? item.id : item) || 0;
            return typeof item === 'object' ? {...item, id, name: item.name || nameOf(id)}
                : {id, name: nameOf(id)};
        });
        if (steps.length && !steps[steps.length - 1].after) {
            steps[steps.length - 1].after = {talents: finalTalents};
        }
        return {kind: 'awash-full-route', branchId: `awash-${branchIndex + 1}`,
            totalPills, totalWashes: Number(route.washes) || totalStepWashes,
            exchangeCount: Number(route.exchanges) || 0, finalTalents, steps,
            verified: true, source: 'AWASH', rawRoute: route};
    }

    const api = Object.freeze({normalizeRoute});
    root.AutoWash2RouteView = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
