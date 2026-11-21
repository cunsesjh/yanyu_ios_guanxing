// Compare the personal worker with a small independent enumeration of engine operations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
global.self = global;
global.importScripts = (...files) => files.forEach(file => vm.runInThisContext(
    fs.readFileSync(path.join(__dirname, '../web/shared', file), 'utf8'), {filename:file}));
importScripts('personal_wash_worker.js');

const raw = {seed:12345, born_talent_rc:7, zizhi:153, role_id:10044, salt:278440,
    role_level:100, sex:1, vip:2, role_stats:{}, global_vars:{}, talents:[], tal_lucky:100000};
function input(initialState, targetIds, compatibleGroups, budget, maxZi) {
    return {initialState,targetIds,compatibleGroups,options:{maxTotalPills:budget,maxZi}};
}
async function run(job) {
    const messages = [];
    global.postMessage = message => messages.push(message);
    await self.onmessage({data:{type:'search',input:job,requestId:1}});
    assert.ok(!messages.some(m => m.type === 'error'), JSON.stringify(messages.at(-1)));
    return messages.find(m => m.type === 'result').result;
}
// Use a FIFO worklist with repeated cost relaxation. For exchange try every
// lock/position pair, without the production graph's deduplication by position.
function enumerate(initial, budget, maxZi) {
    const engine = new AutoWash2Engine.Engine(TALENT_DATA,initial);
    const queue = [], visited = new Map();
    function visit(state,cost) {
        const key = JSON.stringify(state);
        if (cost > budget || (visited.get(key) ?? Infinity) <= cost) return;
        visited.set(key,cost);
        queue.push({state,cost});
    }
    visit(engine.initialState(initial),0);
    for (let i=0;i<queue.length;i++) {
        const {state,cost} = queue[i];
        if (state.zizhi < maxZi) visit({...state,zizhi:state.zizhi+1},cost);
        for (let mask=0;mask<2**state.talents.length;mask++) {
            const positions = state.talents.map((_,index)=>index).filter(index=>(1<<index)&mask);
            if (positions.length < engine.slotCountFor(state.zizhi)) {
                const result = engine.wash(state,positions);
                visit(result.state,cost + result.cost);
            }
            const ids = positions.map(index=>state.talents[index]);
            for (const index of engine.replaceablePositions(state,ids))
                visit(engine.replace(state,index,ids).state,cost);
        }
    }
    return queue;
}
function report(route) {
    return '路线 1：' + route.totalPills + ' 丹\n' +
        route.steps.map((s,i)=>(i+1)+'. '+s.label+'：'+s.detail).join('\n');
}
async function checkStrategyWorkflow() {
    const engine = new AutoWash2Engine.Engine(TALENT_DATA,raw);
    const once = engine.wash(engine.initialState(raw),[]);
    const purple = once.state.talents.find(id=>engine.quality(id)===4);
    assert.ok(purple);
    for (const cap of [once.cost - 1, once.cost]) {
        const job = input(raw,[purple],[],cap,raw.zizhi);
        const messages = [];
        global.postMessage = m => messages.push(m);
        await self.onmessage({data:{type:'search',input:job,requestId:1}});
        const last = messages.at(-1);
        assert.equal(last.type,'result',last.error);
        assert.ok(messages.some(m => m.progress?.layers === 7 && m.progress.layer === 1));
        assert.equal(last.result.routes.length, cap === once.cost ? 1 : 0);
        if (cap === once.cost) assert.equal(last.result.routes[0].totalPills,cap);
    }
}
function checkConstructionReplay() {
    const held = 271;
    const initial = {...raw, talents:[{id:held,locked:true}], luck_seed:77, luck_seed_inited:true};
    const engine = new AutoWash2Engine.Engine(TALENT_DATA, initial);
    const hit = engine.wash(engine.initialState(initial), [0]);
    const purple = hit.state.talents.find(id => id !== held && engine.quality(id) === 4);
    assert.ok(purple);
    const step = {type:'lock', id:purple, locks:[held], washes:1, cost:hit.cost, field:hit.state.talents};
    const job = input(initial,[held],[[purple]],hit.cost,153);
    const ctx = PersonalWashSearch.context(job);
    function check(steps, cap) {
        const r = PersonalWashSeedConstruction.replay(ctx,{steps,cost:hit.cost,washes:1},153,cap);
        return r ? [r] : [];
    }
    const [valid] = check([step],hit.cost);
    assert.equal(valid.totalPills,hit.cost);
    assert.deepEqual(valid.finalTalents.map(t=>t.id),hit.state.talents);
    assert.equal(check([step],hit.cost-1).length,0);
    assert.equal(check([{...step,field:[]}],hit.cost).length,0);
    assert.equal(check([{type:'upgrade',toZi:154,washes:0,cost:0,field:[held]},step],hit.cost).length,0);
}
function checkSeedPlanner() {
    importScripts('auto_wash2_unified_route_constructor.js');
    const initial = {...raw, tal_lucky:0};
    const ids = [271,250];
    const ctx = PersonalWashSearch.context(input(initial,ids,[],4800,154));
    const plan = PersonalWashSeedPlanner.create(ctx);
    const params = {zi0:153, lead:16, n:0, maxWash:1400, budget:4800};
    const upstream = AutoWash2UnifiedRouteConstructor.constructOnce(initial,ids,params);
    assert.ok(upstream.ok && upstream.exchanges > 0);
    const personal = plan(ids,params);
    assert.equal(personal.cost,upstream.cost);
    assert.equal(personal.washes,upstream.washes);
    const verified = PersonalWashSeedConstruction.replay(ctx,personal,153,personal.cost);
    assert.deepEqual(verified.finalTalents.map(t=>t.id),upstream.field);
    assert.equal(plan(ids,{...params,budget:personal.cost-1}),null);
}
async function checkAdditionalBranches() {
    const initial = {...raw,talents:[{id:271}]};
    const engine = new AutoWash2Engine.Engine(TALENT_DATA,initial);
    const roll = engine.wash(engine.initialState(initial),[0]);
    const other = roll.state.talents.find(id=>id!==271 && engine.quality(id)===4);
    const ctx = PersonalWashSearch.context(input(initial,[271,other],[],roll.cost,153));
    const real = global.AnchorRoutePlanner;
    const source = {key:'test-1',id:271}, second = {key:'test-2',id:other};
    const found = {verified:true,cost:roll.cost,washes:1,steps:[{type:'wash',count:1,keepIds:[271],
        after:{cost:roll.cost,zi:153,state:roll.state}}]};
    global.AnchorRoutePlanner = {scan:()=>[source,second],usableSources:()=>[source],
        search:(_raw,_anchors,_source,_pad,opts)=>opts.shouldCancel ? {sequence:{pool:[271,other],fixedLuck:true}}
            : {routes:[found]}};
    let winner;
    try {
        for (const _ of PersonalWashAnchor.search(ctx,roll.cost,r=>{winner=r;},()=>{})) {}
        assert.equal(winner.totalPills,roll.cost);
        assert.equal(PersonalWashTactical.replay(ctx,winner).totalPills,roll.cost);
        assert.equal(PersonalWashTactical.replay(ctx,{...winner,finalState:{...winner.finalState,seed:-1}}),null);
        for (const _ of PersonalWashAnchor.search(ctx,roll.cost-1,()=>assert.fail('over budget'),()=>{})) {}
    } finally {global.AnchorRoutePlanner=real;}
    const original=global.AutoWash2Optimizer, jobs=[];
    const grouped=PersonalWashSearch.context(input(raw,[271,250],[[262,264,276]],70,154));
    try {
        global.AutoWash2Optimizer = {...original,searchWashRoutes:async options=>{
            let work=0;while (!options.shouldCancel()) work++;
            jobs.push({ids:options.targetIds,work,cap:options.options.maxTotalPills});
            return {routes:[]};
        }};
        const incumbent={totalPills:50,finalTalents:[271,250,276].map(id=>({id}))};
        await PersonalWashTactical.search(grouped,incumbent,()=>assert.fail(),()=>{},async()=>{});
        assert.deepEqual(jobs.map(j=>j.ids.at(-1)),[276,262,264]);
        assert(jobs.every(j=>j.cap===49 && j.work>0));
        assert(jobs[0].work>jobs[1].work && jobs[1].work===jobs[2].work);
    } finally {global.AutoWash2Optimizer=original;}
}
async function checkEarlyCandidateRefinement() {
    const held = [271, 250];
    const initial = {...raw, zizhi:154, talents:held.map(id => ({id}))};
    const engine = new AutoWash2Engine.Engine(TALENT_DATA, initial);
    const firstWash = engine.wash(engine.initialState(initial), [0, 1]);
    const third = firstWash.state.talents.find(id => !held.includes(id) && engine.quality(id) === 4);
    assert.ok(third);
    const goals = [...held, third];
    const ctx = PersonalWashSearch.context(input(initial, goals, [], 100, 154));
    const first = {type:'wash', keep:held};
    const early = PersonalWashSearch.route(ctx, [first, {type:'wash', keep:goals}], 'start-candidate');
    const better = PersonalWashSearch.route(ctx, [first], 'searched');
    const caps = [], winners = [];
    const original = global.AutoWash2Optimizer;
    try {
        global.AutoWash2Optimizer = {...original, searchWashRoutes: async options => {
            caps.push(options.options.maxTotalPills);
            const count = caps.length - 1;
            const result = {routes:[count ? better : early], searchScope:{expandedNodes:count, rawWashesSimulated:count}};
            options.onCandidate(result);
            return result;
        }};
        await PersonalWashTactical.search(ctx, null, route => winners.push(route), () => {}, async () => {});
        assert.deepEqual(caps, [100, early.totalPills - 1]);
        assert.deepEqual(winners.map(route => route.totalPills), [early.totalPills, better.totalPills]);
        assert.match(winners[0].strategyLabel, /起步候选/);
    } finally { global.AutoWash2Optimizer = original; }
}
async function main() {
    // 青龙白虎 raises 54 Con above the 60 required for 五蕴皆空.
    const thresholdRole = {ID:1, Type:1, Sex:1, Level:100, ZiZhi:154, BornCon:54, Talents:[]};
    for (const [talents, eligible] of [[[],false],[[252],true]]) {
        let reply;
        global.postMessage = message => { reply = message; };
        const snapshot = {...raw, zizhi:154, role_id:1, role_raw:thresholdRole, talents};
        await self.onmessage({data:{type:'inspect', raw:snapshot, requestId:1}});
        assert.equal(reply.type, 'summary', reply.error);
        assert.equal(reply.summary.allowed.includes(239), eligible);
    }
    await checkStrategyWorkflow();
    checkConstructionReplay();
    checkSeedPlanner();
    await checkAdditionalBranches();
    await checkEarlyCandidateRefinement();
    let checks = 0;
    const engine = new AutoWash2Engine.Engine(TALENT_DATA,raw);
    const carrier = engine.purpleIds.find(id=>!engine.isShenmai(id) &&
        [...engine.allowed].some(low=>engine.quality(low)<4 && engine.talentType(low)===engine.talentType(id)));
    const low = [...engine.allowed].find(id=>engine.quality(id)<4 && engine.talentType(id)===engine.talentType(carrier));
    const pair = [low,carrier].map(id=>({id,locked:false}));
    for (const initial of [raw,{...raw,seed:19,zizhi:150},{...raw,seed:722,talents:pair}]) {
        for (const maxZi of [initial.zizhi,154]) {
            const budget = initial.talents.length ? 5 : 6;
            const rows = enumerate(initial,budget,maxZi);
            const blues = [...new Set(rows.flatMap(r=>r.state.talents))].filter(id=>engine.quality(id)===4);
            const sets = blues.slice(0,4).map(id=>[[id],[]]);
            sets.push([[271],[]], [[],[[271,272]]]);
            if (blues.length>1) sets.push([[blues[0]],[[blues[1],271].filter(id=>id!==blues[0])]]);
            for (const [required,groups] of sets) {
                const matches = rows.filter(({state:s})=>required.every(id=>s.talents.includes(id))
                    && groups.every(group=>group.some(id=>s.talents.includes(id))));
                const minimum = Math.min(...matches.map(r=>r.cost));
                for (const cap of new Set([budget,Math.max(0,Math.min(budget,minimum-1))])) {
                    const job = input(initial,required,groups,cap,maxZi);
                    const result = await run(job);
                    assert.equal(result.routes.length,minimum<=cap ? 1 : 0,
                        JSON.stringify({start:initial.zizhi,seed:initial.seed,required,groups,cap,maxZi,minimum}));
                    if (minimum<=cap) {
                        const route = result.routes[0];
                        assert.equal(route.totalPills,minimum);
                        assert.ok(route.verified && !route.verifiedOptimal);
                        const imported = PersonalWashSearch.reference(PersonalWashSearch.context(job),report(route));
                        assert.equal(imported.totalPills,minimum);
                    }
                    checks++;
                }
            }
        }
    }
    // A compatible non-goal purple can be exchanged twice with no paid wash.
    let chained = false;
    for (let seed=1;seed<=300 && !chained;seed++) {
        const start={...raw,seed,zizhi:154,talents:[248,249,250].map(id=>({id}))};
        const states=enumerate(start,0,154);
        const original=start.talents.map(t=>t.id);
        const goal=states.find(({state})=>state.talents.filter(id=>!original.includes(id)).length>=2);
        if (!goal) continue;
        const result=await run(input(start,goal.state.talents,[],0,154));
        assert.equal(result.routes[0].totalPills,0);
        assert.ok(result.routes[0].exchangeCount>=2);
        chained=true;
    }
    assert.ok(chained);
    // With these synthetic rolls only the last slot can be exchanged. The
    // target is the fifth draw; two same-name exchanges advance the luck RNG.
    const startChain = {...raw,zizhi:154,luck_seed:118,luck_seed_inited:true,
        talents:[211,184,171,264].map(id => ({id}))};
    const chainJob = input(startChain,[271],[],0,154);
    const [five] = (await run(chainJob)).routes;
    assert.ok(five.verified);
    assert.equal(five.totalPills,0);
    assert.equal(five.totalWashes,0);
    assert.equal(five.exchangeCount,5);
    assert.deepEqual(five.steps.filter(s => s.type === 'exchange').map(s => s.after.talents.at(-1).id),
        [264,267,264,264,271]);
    const abbreviated = report(five).replace(/锁定「[^」]+」，置换「/g,'点击置换「');
    const replayCtx = PersonalWashSearch.context(chainJob);
    const invalid = abbreviated.replace(/应得到「[^」]+」/,'应得到「错误的天赋」');
    assert.throws(() => PersonalWashSearch.reference(replayCtx,invalid),/置换结果不同/);
    const replayed = PersonalWashSearch.reference(replayCtx,invalid + '\n\n' + abbreviated.replace('路线 1','路线 2'));
    assert.equal(replayed.exchangeCount,5);
    assert.deepEqual(replayed.finalState,five.finalState);
    console.log('PASS',checks,'budget / goal comparisons, seven-layer workflow, five free exchanges and text replay');

    // Optional local replay: SAVE CHARACTER ROUTE... . No private fixture is bundled.
    const [savePath,roleName,...files] = process.argv.slice(2);
    if (!savePath) return;
    const save = JSON.parse(fs.readFileSync(savePath,'utf8'));
    const role = [save.MainRole,...Object.values(save.Roles)].find(r=>r?.Name===roleName);
    const start = AutoWash2Model.snapshot(save,role);
    for (const file of files) {
        const text = fs.readFileSync(file,'utf8');
        const ctx = PersonalWashSearch.context(input(start,[],[],20000,154));
        const route = PersonalWashSearch.reference(ctx,text);
        const ids = route.finalTalents.map(t=>t.id);
        const withTargets = PersonalWashSearch.context(input(start,ids,[],route.totalPills,154));
        const verified = PersonalWashSearch.reference(withTargets,text);
        assert.ok(verified.verified);
        assert.equal(PersonalWashSearch.reference(withTargets,report(verified)).totalPills,verified.totalPills);
        console.log(roleName,verified.totalPills,verified.totalWashes,verified.finalTalents.map(t=>t.name).join('、'));
    }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
