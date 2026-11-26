/* Dedicated runtime: does not install or replace any legacy page/worker globals. */
'use strict';
self.window = self;
importScripts('data.js', 'born_talent_data.js', 'battle_talent_data.js', 'life_hedao_data.js',
    'extra_attr_data.js', 'equip_data.js', 'kongfu_data.js', '../role/role.js', 'wash_role_context.js',
    'sequence_rules.js', 'wash_route_engine.js', 'wash_source_engine.js',
    'wash_source_optimizer.js', 'auto_wash2_source_cache.js',
    'auto_wash2_engine.js?v=20261126source-search', 'auto_wash2_model.js');
self.onmessage = async ({data: message}) => {
    const send = (type, payload) => self.postMessage({type, requestId: message.requestId, ...payload});
    try {
        if (message.type === 'inspect') {
            const engine = new AutoWash2Engine.Engine(TALENT_DATA, message.raw);
            const initial = engine.initialState(message.raw);
            const allowedSet = typeof engine.allowedForState === 'function'
                ? engine.allowedForState(initial, initial.zizhi)
                : engine.allowedSet(initial.zizhi);
            const summary = {
                allowed: [...allowedSet], purpleIds: engine.purpleIds,
            };
            send('summary', {summary});
            return;
        }
        if (message.type !== 'search') return;
        // Use the same source-search implementation as the normal wash page.
        // The AWASH/checkpoint service is a different search graph and cannot
        // reproduce source routes such as the known 4,688-pill route.
        const input = message.input, branches = AutoWash2Model.combinations(input);
        const routes = [];
        for (let branch = 0; branch < branches.length; branch++) {
            const targets = branches[branch];
            send('progress', {progress: {message: `源码 wash 搜索 ${branch + 1}/${branches.length} · 正在回放路线`} });
            const result = await WashSourceOptimizer.searchWashRoutes({
                initialState: input.initialState,
                targetIds: targets,
                talentData: TALENT_DATA,
                dlcMode: !!input.dlcMode,
                eligibleTalentIds: input.eligibleTalentIds,
                bagPills: input.bagPills,
                hasBagPills: !!input.hasBagPills,
                options: input.options,
                shouldCancel: () => false,
                onProgress: progress => send('progress', {progress}),
            });
            (result?.routes || []).forEach(route => routes.push(route));
            if (result?.routes?.length) {
                send('candidate', {result: {
                    routes: routes.slice().sort((a, b) => a.totalPills - b.totalPills),
                    noResultReason: '',
                }});
            }
        }
        send('result', {result: {routes: routes.sort((a,b) => a.totalPills-b.totalPills), limitReason: 'completed',
            limitReasons: [], noResultReason: routes.length ? '' : '源码 wash 搜索在当前耗丹上限内未找到可回放路线。'}});
    } catch (error) {
        send('error', {error: error?.message || String(error)});
    }
};
