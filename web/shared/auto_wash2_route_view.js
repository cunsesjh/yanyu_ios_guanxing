/* Format AWASH route actions for the browser without treating metadata as cost. */
(function (root) {
    'use strict';

    function normalizeRoute(route, branchIndex, name) {
        if (!route || !Array.isArray(route.steps)) return null;
        const nameOf = id => name(Number(id) || 0);
        const steps = [];
        let totalStepPills = 0, totalStepWashes = 0;

        for (const source of route.steps) {
            const op = String(source.op || source.type || 'wash');
            if (op === 'wash') {
                const count = Math.max(0, Number(source.count) || 0);
                const pills = Math.max(0, Number(source.cost) || 0);
                const keepIds = (source.keepIds || []).map(Number);
                const key = JSON.stringify([String(source.type || ''), keepIds]);
                const previous = steps[steps.length - 1];
                if (previous && previous._washKey === key) {
                    previous.washes += count;
                    previous.pills += pills;
                    previous.detail = `洗髓 ${previous.washes} 次${keepIds.length
                        ? `，保留 ${keepIds.map(nameOf).join('、')}` : ''}`;
                } else {
                    steps.push({label: '洗髓',
                        detail: `洗髓 ${count} 次${keepIds.length
                            ? `，保留 ${keepIds.map(nameOf).join('、')}` : ''}`,
                        pills, washes: count, _washKey: key});
                }
                totalStepPills += pills;
                totalStepWashes += count;
                continue;
            }

            if (op === 'locks') {
                const ids = (source.lockIds || []).map(Number);
                const special = String(source.type || '');
                const label = ids.length ? '调整锁脉' : '解除锁脉';
                const detail = special === 'lockConflict' && source.id
                    ? `锁定冲突脉「${nameOf(source.id)}」`
                    : ids.length ? `锁定：${ids.map(nameOf).join('、')}` : '解除全部锁脉';
                steps.push({label, detail, pills: 0, washes: 0});
            } else if (op === 'exchange' || op === 'burn') {
                steps.push({label: '置换', detail: `「${nameOf(source.removedId || source.from || source.carrierId)}」→「${nameOf(source.addedId || source.to || source.id)}」`, pills: 0, washes: 0});
            } else if (op === 'upgrade') {
                steps.push({label: '提升资质', detail: `提升至资质 ${Number(source.zizhi || source.toZizhi) || ''}`, pills: 0, washes: 0});
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
        if (steps.length) steps[steps.length - 1].after = {talents: finalTalents};
        return {kind: 'awash-full-route', branchId: `awash-${branchIndex + 1}`,
            totalPills, totalWashes: Number(route.washes) || totalStepWashes,
            exchangeCount: Number(route.exchanges) || 0, finalTalents, steps,
            verified: true, source: 'AWASH', rawRoute: route};
    }

    const api = Object.freeze({normalizeRoute});
    root.AutoWash2RouteView = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
