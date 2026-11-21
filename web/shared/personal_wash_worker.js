/* Dedicated worker for the personal tab. */
'use strict';
self.window = self;
importScripts('data.js','born_talent_data.js','battle_talent_data.js','life_hedao_data.js',
    'extra_attr_data.js','equip_data.js','kongfu_data.js','../role/role.js','wash_role_context.js',
    'wash_source_engine.js','auto_wash2_source_cache.js','auto_wash2_engine.js',
    'auto_wash2_optimizer.js','auto_wash2_model.js','personal_wash_routes.js',
    'personal_wash_search.js','personal_wash_conflict_windows.js',
    'personal_wash_seed_planner.js','personal_wash_seed_construction.js','anchor_route_planner.js',
    'personal_wash_anchor.js','personal_wash_tactical.js');
let active;
self.onmessage = async ({data}) => {
    const send = (type,payload) => self.postMessage({type,requestId:data.requestId,...payload});
    if (data.type === 'inspect') {
        try {
            const engine = new AutoWash2Engine.Engine(TALENT_DATA,data.raw);
            const initial = engine.initialState(data.raw);
            send('summary',{summary:{allowed:[...engine.allowedForState(initial,initial.zizhi)],purpleIds:engine.purpleIds}});
        } catch (err) { send('error',{error:err.message}); }
        return;
    }
    if (data.type !== 'search') {
        if (!active || active.id !== data.requestId) return;
        if (data.type === 'pause') active.paused = true;
        if (data.type === 'resume') { active.paused = false; active.wake?.(); }
        return;
    }
    if (active) return;
    const job = active = {id:data.requestId,paused:false};
    let best = null;
    try {
        const input = data.input, opts = input.options;
        if (!Number.isInteger(opts.maxTotalPills) || opts.maxTotalPills < 0 || opts.maxTotalPills > 20000 ||
            !Number.isInteger(opts.maxZi) || opts.maxZi > 154 || opts.maxZi < input.initialState.zizhi) throw Error('预算或开槽范围无效');
        const ctx = PersonalWashSearch.context(input);
        const progress = info => send('progress',{progress:info});
        let lastYield = performance.now();
        async function checkpoint() {
            if (performance.now() - lastYield >= 20) {
                await new Promise(resolve => setTimeout(resolve,0));
                lastYield = performance.now();
            }
            if (job.paused) {
                send('paused',{});
                await new Promise(resolve => { job.wake = resolve; });
                job.wake = null;
                send('resumed',{});
            }
        }
        function accept(route) {
            if (!best || route.totalPills < best.totalPills) {
                best = route;
                send('candidate',{result:{routes:[best]}});
            }
        }
        let reason = '';
        if (opts.referenceText) {
            const referenceCtx = {...ctx, options:{...opts,maxTotalPills:20000}};
            const reference = PersonalWashSearch.reference(referenceCtx,opts.referenceText);
            if (reference.totalPills <= opts.maxTotalPills) accept(reference);
            else progress({message:'参考路线超出本次耗丹上限。'});
        }
        if (PersonalWashSearch.goal(ctx,ctx.startState))
            accept(PersonalWashSearch.route(ctx,[],'personal-start'));
        if (!PersonalWashSearch.fitsSlots(ctx)) reason = '所选槽数不足以容纳目标。';
        else if (best?.totalPills !== 0) {
            send('phase',{phase:'strategy'});
            const caps = [];
            if (input.hasBagPills && input.bagPills > 0 && input.bagPills < opts.maxTotalPills)
                caps.push({nearby:true,cap:input.bagPills});
            caps.push({nearby:true,cap:opts.maxTotalPills},{nearby:false,cap:opts.maxTotalPills});
            let previousCap;
            for (const [index,{nearby,cap}] of caps.entries()) {
                const searchCap = Math.min(cap,(best?.totalPills ?? Infinity) - 1);
                if (searchCap < 0) break;
                if (nearby && searchCap === previousCap) continue;
                previousCap = searchCap;
                const runner = PersonalWashConflictWindows.iterate(ctx, searchCap, nearby, accept,
                    info => progress({...info,pass:index + 1,passes:caps.length}));
                for (const _ of runner) await checkpoint();
            }
            const ceiling = Math.min(opts.maxTotalPills, (best?.totalPills ?? Infinity) - 1);
            for (const _ of PersonalWashSeedConstruction.search(ctx, ceiling, accept, progress))
                await checkpoint();
            const anchorCap = Math.min(opts.maxTotalPills, (best?.totalPills ?? Infinity) - 1);
            for (const _ of PersonalWashAnchor.search(ctx, anchorCap, accept, progress))
                await checkpoint();
            await PersonalWashTactical.search(ctx,best,accept,progress,checkpoint);
        }
        send('result',{result:{routes:best ? [best] : [],
            noResultReason:reason || '本次搜索在当前丹数上限内尚未找到满足目标的路线。'}});
    } catch (err) {
        send('error',{error:'搜索未完成：' + (err.message || err) + (best ? '。已保留经过回放的候选。' : '')});
    } finally {
        active = null;
    }
};
