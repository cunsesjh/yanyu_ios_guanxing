/* Exchange an already required natural purple back into itself to set the luck
 * sequence. The upstream anchor planner can then carry a temporary purple and
 * choose the fourth-slot opening separately from the first exchange. */
(function (root) {
    'use strict';
    const POOL_DEPTH = 36, MAX_PADDING = 200, MAX_JOBS = 12, MAX_NODES = 500;
    function asPersonal(ctx, found, startZi, cap) {
        let washes = 0;
        const steps = found.steps.map(action => {
            if (action.type === 'wash') washes += action.count;
            return {type:action.type, washes, cost:action.after.cost, field:action.after.state.talents,
                locks:action.type === 'wash' ? action.keepIds : [], replaceLocks:action.keepIds,
                from:action.from, to:action.to, toZi:action.after.zi};
        });
        if (found.washes !== washes) return null;
        const route = root.PersonalWashSeedConstruction.replay(ctx,{steps, washes, cost:found.cost},startZi,cap);
        if (route) {
            route.kind = 'personal-anchor-exchange';
            route.strategyLabel = '同名置换、保留临时紫脉与延迟开槽';
        }
        return route;
    }
    function* search(ctx, cap, accept, progress) {
        const {initialState,options,engine} = ctx;
        if (ctx.dlcMode || engine.international || initialState.luck_seed_inited ||
            options.maxZi < 153 || !ctx.targetIds.length || cap < engine.at(153).eat) return;
        const startZi = Math.max(153, initialState.zizhi);
        const raw = startZi === initialState.zizhi ? initialState : {...initialState,zizhi:startZi};
        const goals = root.PersonalWashSeedConstruction.combinations(ctx).filter(ids =>
            ids.length >= 2 && ids.length <= 4 && ids.length <= options.maxZi - 150 &&
            ids.every(id => engine.quality(id) === 4));
        if (!goals.length) return;
        const planner = root.AnchorRoutePlanner;
        let purples;
        try { purples = planner.scan(raw,24); }
        catch (err) { progress({sameName:true,message:'无法读取该起点的紫脉顺序：'+err.message}); return; }
        const pools = new Map(), jobs = [];
        const order = (a,b) => b.hits-a.hits || a.depth-b.depth || a.pad-b.pad;
        let ceiling = cap;
        progress({sameName:true,message:'正在比较保留必选紫脉的同名置换。'});
        for (const ids of goals) {
            const size = ids.length, masks = new Set(), candidates = [];
            for (const selection of [purples.filter(p=>!p.fromPity && p.id!==251), purples,
                    purples.filter(p=>p.id!==251)]) {
                const anchors = selection.slice(0,size), key = anchors.map(a=>a.key).join('|');
                if (anchors.length < size || masks.has(key)) continue;
                masks.add(key);
                for (const source of planner.usableSources(raw, anchors, purples)) {
                    if (!ctx.targetIds.includes(source.id)) continue;
                    const poolKey = key+'|'+source.key;
                    if (!pools.has(poolKey)) {
                        const same = [];
                        for (let pad = 0; pad <= MAX_PADDING; pad++) {
                            try {
                                // The planner returns its sequence before expanding any nodes.
                                const probe = planner.search(raw,anchors,source,pad,{targets:ids,
                                    sequenceBasis:'theory2', maxCost:cap, depth:POOL_DEPTH,
                                    shouldCancel:()=>true});
                                const seq = probe.sequence;
                                if (seq?.pool[0] === source.id) same.push({pad,pool:seq.pool});
                                if (seq?.fixedLuck) break;
                            } catch (error) {
                                // Longer pads share this prefix and can never undo pity.
                                if (pad===0 || /欧气已固定|已触发保底/.test(String(error.message))) break;
                            }
                            if (pad % 8 === 0) yield;
                        }
                        pools.set(poolKey,same);
                    }
                    for (const {pad,pool} of pools.get(poolKey)) {
                        const positions = ids.map(id=>pool.indexOf(id));
                        const hits = positions.filter(i=>i>=0).length;
                        if (hits < ids.length-1) continue;
                        candidates.push({ids,anchors,source,pad,hits,depth:Math.max(...positions)});
                    }
                }
            }
            candidates.sort(order);
            if (candidates.length) jobs.push(candidates);
        }
        jobs.sort((a,b)=>order(a[0],b[0]));
        let tried = 0;
        const total = Math.min(MAX_JOBS,jobs.reduce((n,items)=>n+items.length,0));
        for (let index=0; tried<total && ceiling>0; index++) {
            for (const list of jobs) {
                if (!list[index] || tried>=MAX_JOBS || ceiling<1) continue;
                const {ids,anchors,source,pad} = list[index];
                tried++;
                progress({sameName:true,message:'正在回放同名置换候选 '+tried+' / '+total+'。'});
                try {
                    const result = planner.search(raw,anchors,source,pad,{targets:ids, maxCost:ceiling,
                        depth:POOL_DEPTH,maxNodes:MAX_NODES,sequenceBasis:'theory2'});
                    for (const found of result.routes) {
                        if (!found.verified || found.cost>ceiling) continue;
                        const route = asPersonal(ctx,found,startZi,ceiling);
                        if (route) { accept(route); ceiling = route.totalPills-1; break; }
                    }
                } catch (err) {
                    progress({sameName:true,message:'本组合未能回放，继续比较其他同名置换。'+err.message});
                }
                yield;
            }
        }
    }
    root.PersonalWashAnchor = Object.freeze({search});
})(self);
