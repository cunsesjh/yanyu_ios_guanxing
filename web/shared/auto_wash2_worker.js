/* Dedicated runtime: does not install or replace any legacy page/worker globals. */
'use strict';
self.window = self;
importScripts('data.js', 'born_talent_data.js', 'battle_talent_data.js', 'life_hedao_data.js?v=20261126washfix3',
    'extra_attr_data.js', 'equip_data.js', 'kongfu_data.js', '../role/role.js', 'wash_role_context.js',
    'sequence_rules.js?v=20261126washfix5', 'wash_route_engine.js?v=20261126washfix5', 'wash_source_engine.js?v=20261126washfix5',
    'auto_wash2_model.js');
self.onmessage = async ({data: message}) => {
    const send = (type, payload) => self.postMessage({type, requestId: message.requestId, ...payload});
    try {
        if (message.type === 'inspect') {
            const engine = new WashSourceEngine.Engine(TALENT_DATA, message.raw);
            const initial = engine.initialState(message.raw);
            // Low-slot roles are upgraded to three slots before the direct
            // search begins. Inspect that effective pool as well; checking
            // raw 0/1-slot aptitude here incorrectly hides valid targets
            // (notably 天生神力) before the user can select them.
            const inspectZi = Number(initial.zizhi) < 153 ? 153 : initial.zizhi;
            const allowedSet = typeof engine.allowedForState === 'function'
                ? engine.allowedForState(initial, inspectZi)
                : engine.allowedSet(inspectZi);
            const summary = {
                allowed: [...allowedSet], purpleIds: engine.purpleIds,
            };
            send('summary', {summary});
            return;
        }
        if (message.type !== 'search') return;
        send('error', {error: '路线搜索必须调用本地 AWASH 服务，不能回退到浏览器旧搜索器。'});
    } catch (error) {
        send('error', {error: error?.message || String(error)});
    }
};
