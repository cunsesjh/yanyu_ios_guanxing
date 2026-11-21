const assert=require('node:assert/strict');
const C=require('../web/hengshan/sequence_core.js');
const D={candidates:[1,2,3,4,5,6]}, names=['','甲Ⅰ','乙Ⅰ','丙Ⅰ','过渡Ⅰ','刻苦训练Ⅱ','丙Ⅱ'];
const calls=[];
const E={talentName:(_,id)=>names[id],advanceDay:(_,s)=>({state:{...s,level:100,currentTime:s.currentTime+86400,talents:s.talents.length===2?[...s.talents,6]:s.talents}}),
    replacementChain(_,s,slot){calls.push(slot);const next=s.talents.slice();let id=4;
        if(s.seed===10 && slot===0)id=4;else if(s.seed===11 && slot===2 && s.talents[0]===4)id=3;
        else if(s.seed===12 && slot===0 && s.talents[2]===3)id=1;else id=5;next[slot]=id;
        return {steps:[{id,talents:next,nextSeed:s.seed+1}]};}};
const ctx=C.context(E,D),goal=['甲','乙','丙'];const s={key:'test',level:100,exp:8,seed:10,talents:[1,2,4],currentTime:1000,specials:[{id:1,exp:7},{id:2,exp:1},{id:4,exp:2}]};
function run(s,budget,cap){const it=ctx.search(s,goal,budget,cap);for(;;){const x=it.next();if(x.done)return x.value;}}
assert.equal(run(s,2,10000).status,'exhausted');const best=run(s,3,10000);assert.deepEqual(best.moves,[0,2,0]);assert.deepEqual(best.final.specials,[{id:2,exp:1},{id:3,exp:0},{id:1,exp:0}]);assert.deepEqual(s.talents,[1,2,4]);
assert.equal(run(s,3,1).status,'limited');assert.equal(run({...s,talents:[1,2,5]},3,10000).status,'banned');
assert.deepEqual(run({...s,level:79,talents:[1,2]},0,100).moves,[-1]);assert.deepEqual(run({...s,talents:[6,2,1]},0,1).moves,[]);
assert.throws(()=>ctx.targets(['甲','乙','刻苦训练']));assert.throws(()=>ctx.replay(s,[1],goal),/刻苦/);assert.throws(()=>ctx.replay(s,best.moves,goal,{...best.final,seed:0}),/回放/);
assert.equal(ctx.replay(s,best.moves,goal,best.final).washes,3);
const reorders=C.context({...E,replacementChain:()=>({steps:[{id:3,nextSeed:12,talents:[2,4,3]}]})},D);const shifted=reorders.replay(s,[0],['乙','过渡','丙']);assert.equal(shifted.steps[0].drawn,'丙Ⅰ');assert.deepEqual(shifted.final.talents,[2,4,3]);
const times=[Date.parse('2026-11-20T04:59:59+08:00')/1000,Date.parse('2026-11-20T05:00:00+08:00')/1000];assert.deepEqual(times.map(t=>C.shopDate(t)),['2026-11-19','2026-11-20']);
const log=[];const shopE={shopRefresh(d,sd,st){log.push([st.seed,st.refreshes]);const seed=st.seed+1;return {state:{seed,refreshes:st.refreshes+1},students:Array.from({length:5},(_,i)=>({name:String(i),seed,talents:[1]}))};}};
const raw=[{name:'现有',seed:11,talents:[2]}],start={seed:10,refreshes:1};const all=C.shopPlan(shopE,{}, {},raw,start,times[1],3,[true,true,false]);
assert.deepEqual(log,[[10,0],[11,1],[12,0]]);assert.equal(all.length,16);assert.equal(all[0].date,'2026-11-20');assert.equal(all[0].batch,'当前剩余（已手动刷新）');assert.equal(all[6].batch,'手动刷新');assert.equal(all[11].s.currentTime,times[1]+86400*2);assert.equal(new Set(all.map(x=>x.key)).size,all.length);assert.equal(raw[0].key,undefined);
log.length=0;const corrected=C.shopPlan(shopE,{}, {},raw,start,times[1],1,[true],true);assert.deepEqual(log,[[10,0],[11,0]]);assert.equal(corrected.length,10);assert.equal(corrected[0].batch,'补算今日自动刷新');assert.equal(corrected[5].batch,'手动刷新');
assert.equal(C.reusable({status:'found',washes:3},2,1),false);assert.equal(C.reusable({status:'exhausted',budget:3},2,1),true);assert.equal(C.reusable({status:'limited',cap:100,budget:4},4,101),false);
console.log('Hengshan sequence: minimum washes, intermediate states, milestones, exclusions, cap, replay, shop dates/refresh chain and reuse passed.');