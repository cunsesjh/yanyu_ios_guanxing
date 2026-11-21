/* 恒山弟子的单槽刷新 / 逐日升级搜索。内核、界面和复验均不接触游戏存档。 */
(function (root) {
    'use strict';
    const BAN = '刻苦训练', DAY = -1, RULE = 'hengshan-sequence-v1';
    const presets = [ ['胆小鬼','狩猎传承','自幼习武'], ['胆小鬼','飞毛腿','小偷小摸'], ['胆小鬼','天生福星','自幼习武'], ['胆小鬼','天生福星','商贾世家'], ['胆小鬼','天生福星','能言善道'] ];
    const clone = x => JSON.parse(JSON.stringify(x));
    const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
    const stable = x => JSON.stringify(canonical(x));
    function integer(x, min, max, label) {
        if (!Number.isSafeInteger(x) || x < min || x > max) throw Error(label + '应为 ' + min + '～' + max + ' 的整数');
        return x;
    }
    function context(E, D) {
        const names = new Map(), short = new Map();
        function label(id) { if (!names.has(id)) names.set(id, E.talentName(D, id)); return names.get(id); }
        function name(id) { if (!short.has(id)) short.set(id, label(id).replace(/[ⅠⅡⅢⅣⅤ]+$/u, '').trim()); return short.get(id); }
        const held = s => s.talents.map(name);
        const banned = s => held(s).includes(BAN);
        function targets(xs) {
            const catalog = new Set(D.candidates.map(name));
            if (!Array.isArray(xs) || xs.length !== 3 || new Set(xs).size !== 3 || xs.some(n => n === BAN || !catalog.has(n))) throw Error('每组须选择三个不同的可洗天赋，不能包含刻苦训练');
            return xs.slice().sort();
        }
        function step(s, move) {
            if (move === DAY) {
                if (s.level >= 100) throw Error('已满级，不能继续推进天数');
                const r = E.advanceDay(D, s), n = r && r.state && {...s, ...r.state};
                if (!n || !(n.currentTime > s.currentTime) || !(n.level >= s.level && n.level <= 100)) throw Error('升级内核未返回有效的下一天');
                return n;
            }
            return wash(s,move).state;
        }
        function wash(s,move) {
            integer(move, 0, s.talents.length - 1, '槽位');
            const r = E.replacementChain(D, s, move, 1).steps[0];
            if (!r || !Number.isSafeInteger(r.nextSeed) || !Array.isArray(r.talents) || r.talents.length !== s.talents.length || !r.talents.includes(r.id)) throw Error('刷新内核未返回有效槽位');
            const old = s.talents[move], specials = (s.specials || []).filter(v => { const id = Number(v.id ?? v.ID); return id !== Number(old) && id !== Number(r.id); });
            return {drawn:r.id,state:{...s, seed:r.nextSeed, talents:r.talents.slice(), specials:[...specials, {id:Number(r.id), exp:0}]}};
        }
        // A linked path and explicit stack avoid recursion limits for long growth sequences.
        function* search(initial, group, maxWashes, maxNodes, progress = {}) {
            const goal = targets(group); integer(maxWashes, 0, 100, '洗练次数'); integer(maxNodes, 1, 100000000, '状态上限');
            Object.assign(progress, {pass:0, nodes:0, rejected:0});
            if (banned(initial)) return {status:'banned'};
            const hits = s => held(s).filter(n => goal.includes(n)).length;
            for (let pass = 0; pass <= maxWashes; pass++) {
                progress.pass = pass;
                const seen = new Map(), stack = [{s:initial, left:pass, path:null}];
                while (stack.length) {
                    if (progress.nodes >= maxNodes) return {status:'limited'};
                    const {s, left, path} = stack.pop(); progress.nodes++; yield;
                    if (banned(s)) { progress.rejected++; continue; }
                    const missing = goal.filter(n => !held(s).includes(n)).length;
                    if (!missing) { const moves=[]; for (let p=path;p;p=p.prev) moves.push(p.move); return {status:'found', moves:moves.reverse(), final:s}; }
                    if (missing > left + Math.max(0, 3 - s.talents.length)) continue;
                    const k = stable(s);
                    if (seen.has(k) && seen.get(k) >= left) continue;
                    // Eviction only causes extra work, never a false negative.
                    if (seen.size >= 32000) seen.delete(seen.keys().next().value);
                    seen.set(k, left);
                    if (s.level < 100) stack.push({s:step(s,DAY),left,path:{prev:path,move:DAY}});
                    if (!left) continue;
                    const next = s.talents.map((_,move) => ({s:step(s,move),move}));
                    next.sort((a,b) => hits(b.s)-hits(a.s) || a.move-b.move);
                    for (let i=next.length-1;i>=0;i--) stack.push({s:next[i].s, left:left-1,path:{prev:path,move:next[i].move}});
                }
            }
            return {status:'exhausted'};
        }
        function replay(initial, moves, group, expectedFinal) {
            const goal=targets(group); let s=initial, days=0, washes=0; const rows=[];
            if (banned(s) || !Array.isArray(moves)) throw Error('路线起点或操作列表无效');
            for (const m of moves) {
                const prev=s, result=m===DAY?null:wash(prev,m); s=result?result.state:step(prev,m);
                if (banned(s)) throw Error('路线中出现刻苦训练');
                if (m===DAY) {
                    days++;
                    const last=rows[rows.length-1];
                    if (last && last.type==='day') {last.days++; last.to=s.level;}
                    else rows.push({type:'day',days:1,from:prev.level,to:s.level});
                } else { washes++; rows.push({type:'wash',day:days,slot:m,level:s.level,old:label(prev.talents[m]),drawn:label(result.drawn)}); }
            }
            if (goal.some(n => !held(s).includes(n)) || (expectedFinal && stable(s)!==stable(expectedFinal))) throw Error('路线回放未能重现最终状态或三个目标');
            return {moves,steps:rows,days,washes,final:s,finalTalents:s.talents.map(label)};
        }
        return {name,label,held,banned,targets,step,search,replay};
    }
    const SECOND_DAY=86400, GAME_OFFSET=10800;
    function shopDate(t, d=0) { return new Date((Math.floor((t+GAME_OFFSET)/SECOND_DAY)*SECOND_DAY + d*SECOND_DAY +18000)*1000).toISOString().slice(0,10); }
    function shopPlan(E, D, S, rows, shop, time, days, manual, reconcile=false) {
        integer(days,1,120,'预测天数');
        if (!shop || !(shop.seed>0) || !Number.isFinite(time) || time<=0) throw Error('存档缺少商店种子或游戏日期');
        if (!Array.isArray(manual) || manual.length!==days) throw Error('请逐日确定刷新计划');
        let state=clone(shop); const list=[], start=Math.floor((time+GAME_OFFSET)/SECOND_DAY)*SECOND_DAY - GAME_OFFSET;
        function add(items,d,kind){const date=shopDate(time,d);items.forEach((raw,i)=>{const s={...raw}; delete s.raw; s.key='gx-shop:'+date+':'+kind+':'+s.seed+':'+i; s.source='shop-preview';s.currentTime=d?start+d*SECOND_DAY:time;s.nextDailyAt=s.currentTime+SECOND_DAY;list.push({key:s.key,s,date,batch:kind});});}
        function nextBatch(){const r=E.shopRefresh(D,S,clone(state));const ns=r && (r.state||r.nextState||r.next_state);if (!ns || !(ns.seed>0) || !Array.isArray(r.students) || r.students.length!==5) throw Error('商店内核未返回完整批次，已停止预测');state=clone(ns);return r.students;}
        function draw(d,kind){add(nextBatch(),d,kind);}
        if(reconcile){state.refreshes=0;rows=nextBatch();state.refreshes=0;}
        for(let d=0;d<days;d++){
            if (!d) add(rows,d,reconcile?'补算今日自动刷新':shop.refreshes>=1?'当前剩余（已手动刷新）':'当前剩余');
            else {state.refreshes=0;draw(d,'每日自动刷新');}
            if(manual[d] && (d>0 || reconcile || !(shop.refreshes>=1))) draw(d,'手动刷新');
        }
        return list;
    }
    function reusable(mark, budget, cap) {
        if (!mark) return false;
        if (mark.status==='found') return mark.washes<=budget;
        if (mark.status==='banned') return true;
        if (mark.status==='exhausted') return mark.budget>=budget;
        return mark.status==='limited' && mark.budget===budget && mark.cap>=cap;
    }
    const api={DAY,BAN,RULE,presets,stable,integer,clone,context,shopPlan,shopDate,reusable};
    root.HengshanSequence=api;
    if(typeof module==='object' && module.exports) module.exports=api;
})(globalThis);