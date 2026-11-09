// Isolated dependency for the AutoWash2 unified constructor. It deliberately
// does not replace the existing anchor planner used by the legacy module.
// 原锚点路线规划器作者：dz。
(function (root) {
    'use strict';
    const MAX_DIVERGENCE_BRANCHES = 3;
    function divergenceBranches(variants) {
        const selected = variants.slice(0, MAX_DIVERGENCE_BRANCHES);
        const fourSlot = variants.find(node => node.zi === 154);
        if (fourSlot && !selected.some(node => node.zi === 154)) {
            selected[selected.length - 1] = fourSlot;
        }
        return selected;
    }
    const clone = s => root.WashSourceEngine.cloneState(s);
    function engine(raw, zi, options={}) {
        const zz = root.ZZ_DATA[String(zi)];
        if (!zz || (zz.num_talent < 3 && !(options.allowTwoSlot && Number(zi)===152))) throw new Error('第一版需要三槽或四槽资质。');
        return new root.AutoWash2Engine.Engine(root.TALENT_DATA, raw, {
            slotCount: zz.num_talent, pity: zz.bd_zz, eat: zz.eat_xisui,
            eligibleZi: zi, advancePerDraw: true,
        });
    }
    /**
     * 场上同类型低阶脉取「离载体最近」的那条。
     * 若给定 beforeId，只查它前面的槽位；否则从后往前找。
     * 同名低阶脉会在种子流里反复出现，锁最早那条通常会让后续洗数虚增。
     */
    function nearestLowOfTypeInField(e, talents, type, beforeId) {
        const list = (talents || []).map(Number);
        const rawBefore = beforeId == null ? -1 : list.indexOf(Number(beforeId));
        const limit = rawBefore >= 0 ? rawBefore : list.length;
        for (let i = limit - 1; i >= 0; i--) {
            const id = list[i];
            if (id !== 251 && e.quality(id) < 4 && e.talentType(id) === Number(type)) return id;
        }
        return null;
    }
    // 保底锚点代表导入状态之后第几次保底，不绑定无锁预览的名字或种子。
    const eventKey = e => e.fromPity ? `p:${e.pityNo}` : `r:${e.bornRC}:${e.id}`;
    function scan(raw, count = 12) {
        const e = engine(raw, raw.zizhi);
        let s = e.initialState(raw), previousRC = s.bornRC, pityNo = 0;
        let prevWash = 0, slots = e.slotCount;
        const items = [];
        for (let w = 1; w <= 12000 && items.length < count; w++) {
            const r = e.wash(s, []); s = r.state;
            for (const ev of r.generatedEvents) if (e.quality(ev.id) === 4) {
                if (ev.fromPity) ev.pityNo = ++pityNo;
                items.push({ ...ev, key: eventKey(ev), no: items.length + 1, wash: w,
                    name: e.name(ev.id), gap: ev.bornRC - previousRC,
                    // 「间隔」= 上一条紫到这条紫之间的**进场条数**（无锁 = 洗数差 × 槽数）。
                    // 隐藏保底窗口（3 槽 820~854 / 4 槽 865~899）和保底触发点（855/900）
                    // 都用这个单位；bornRC 会算进挤脉重抽，两者口径不同，别混用。
                    interval: (w - prevWash) * slots });
                previousRC = ev.bornRC;
                prevWash = w;
            }
        }
        return items;
    }
    function snapshot(n) { return { state: clone(n.s), zi: n.zi, origins: n.o.slice(), seen: n.seen, cost: n.cost,
        pityCount: n.pityCount, poolStarted: n.poolStarted, draws: n.draws, poolDraws: n.poolDraws }; }
    function makeContext(raw, anchors) {
        const cache = new Map();
        return { raw, anchors, byKey: new Map(anchors.map((a,i) => [a.key, i])),
            e(zi) { if (!cache.has(zi)) cache.set(zi, engine(raw, zi)); return cache.get(zi); } };
    }
    function start(ctx) {
        const s=ctx.e(ctx.raw.zizhi).initialState(ctx.raw);
        return { s, zi: Number(ctx.raw.zizhi),
            o: s.talents.map(() => -1), seen: 0, cost: 0, draws: 0, poolDraws: 0, poolStarted: false,
            pityCount: 0, pityEvents: [], exchanges: 0, washes: 0, trace: null };
    }
    function washOne(ctx, n, keep) {
        const r = ctx.e(n.zi).wash(n.s, keep);
        const o = keep.map(i => n.o[i]);
        let seen = n.seen, pityCount = n.pityCount, pityEvents = n.pityEvents;
        for (const ev of r.generatedEvents) {
            if (ev.fromPity) {
                ev.pityNo = ++pityCount;
                pityEvents = [...pityEvents, { no: pityCount, id: ev.id, wash: n.washes + 1,
                    bornRC: ev.bornRC, purpleDraws: r.purpleDraws }];
            }
            const origin = ctx.byKey.has(eventKey(ev)) ? ctx.byKey.get(eventKey(ev)) : -1;
            o.push(origin);
            if (origin >= 0) seen |= 1 << origin;
        }
        return { ...n, s: r.state, o, seen, pityCount, pityEvents, cost: n.cost + r.cost, washes: n.washes + 1,
            poolDraws: n.poolDraws + (r.purpleDraws || 0), draws: n.draws + (n.poolStarted ? r.purpleDraws || 0 : 0) };
    }
    function missed(ctx, n) {
        return ctx.anchors.some((a,i) => (n.seen & (1 << i)) ? !n.o.includes(i)
            : a.fromPity ? n.pityCount >= a.pityNo : n.s.bornRC >= a.bornRC);
    }
    function record(before, after, action) {
        if (action.type === 'wash') action = { ...action, pityEvents: after.pityEvents.slice(before.pityCount) };
        after.trace = { prev: before.trace, action: { ...action, before: snapshot(before), after: snapshot(after) } };
        return after;
    }
    function keepIds(n, keep) { return keep.map(i => n.s.talents[i]); }
    function macro(ctx, n, keep, count, why) {
        const ids = keepIds(n, keep);
        let x = n;
        for (let i = 0; i < count; i++) {
            const k = ids.map(id => x.s.talents.indexOf(id));
            if (k.some(v => v < 0)) throw new Error('锁定脉丢失');
            if (x.o.some((v,j) => v>=0 && !k.includes(j))) throw new Error('垫洗将洗掉已捕获的锚点，请减少 n。');
            x = washOne(ctx, x, k);
            if (missed(ctx, x)) throw new Error('准备步骤已越过所选锚点');
        }
        return count ? record(n, x, { type: 'wash', keepIds: ids, count, why }) : n;
    }
    function prepareSource(ctx, source) {
        const initial = start(ctx), e = ctx.e(initial.zi);
        const conflicts = e.allIds.filter(id => e.allowed.has(id) && (e.isShenmai(source.id)
            ? e.isShenmai(id) && id !== source.id
            : e.quality(id) < 4 && e.talentType(id) === e.talentType(source.id)));
        if (!conflicts.length) throw new Error('这个起点没有可用冲突脉（如一心两用），无法初始化置换。');
        // 无锁预读至起点，按出现事件从近到远尝试，不能按脉名寻找最早的同名脉。
        // 锁脉会改变去重和保底，最近一次未必能捕获指定 RC；必须实际重演准备过程。
        const candidates = initial.s.talents.filter(id => conflicts.includes(id))
            .map(id => ({ id, node: initial, captured: false }));
        let scan = initial;
        for (let w=0; w<12000 && scan.s.bornRC<source.bornRC; w++) {
            const r=e.wash(scan.s,[]);
            scan=washOne(ctx,scan,[]);
            const captured=r.generatedEvents.some(ev=>eventKey(ev)===source.key);
            if (!missed(ctx,scan)) for (const ev of r.generatedEvents) {
                if (!conflicts.includes(ev.id) || ev.bornRC>=source.bornRC) continue;
                candidates.push({id:ev.id,node:scan,captured});
            }
            if (captured || missed(ctx,scan)) break;
        }
        for (let i=candidates.length-1; i>=0; i--) {
            const candidate=candidates[i], conflict=candidate.id;
            let n={...candidate.node}, found=candidate.captured, loops=0;
            if (n.washes) n=record(initial,n,{type:'wash',keepIds:[],count:n.washes,why:'无锁洗到起点紫前最近可用冲突脉'});
            const beforeSource=n;
            while (!found && loops<12000 && n.s.bornRC<source.bornRC) {
                const k=[n.s.talents.indexOf(conflict)];
                if (n.o.some((v,j)=>v>=0 && !k.includes(j))) break;
                const r=e.wash(n.s,k);
                n=washOne(ctx,n,k);loops++;
                found=r.generatedEvents.some(ev=>eventKey(ev)===source.key);
                if (missed(ctx,n)) break;
            }
            const pos=n.s.talents.indexOf(source.id);
            if (!found || missed(ctx,n) || !e.replaceablePositions(n.s,[conflict]).includes(pos)) continue;
            if (loops) n=record(beforeSource,n,{type:'wash',keepIds:[conflict],count:loops,why:`捕获原始紫 #${source.no}`});
            return {n,conflict};
        }
        throw new Error('起点紫之前未找到能捕获指定原始紫并置换的前置冲突脉。');
    }
    function initialize(ctx, source, pad) {
        let {n,conflict}=prepareSource(ctx,source);
        const e=ctx.e(n.zi);
        let keep = n.s.talents.map((id,i) => id === conflict || id === source.id ? i : -1).filter(i => i >= 0);
        if (e.slotCount === 4) {
            const pos = n.s.talents.findIndex((id,i) => !keep.includes(i) && e.quality(id) < 4);
            if (pos < 0) throw new Error('四槽起点未找到可用于垫洗的第三条锁脉。');
            keep.push(pos); keep.sort((a,b) => a-b);
        }
        if (n.s.luckSeed != null && pad > 0)
            throw new Error('此前已触发保底或欧气已固定，只能使用 n=0 的固定序列。');
        n = macro(ctx, n, keep, pad, `无限置换垫洗 n=${pad}`);
        if (pad > 0 && n.s.luckSeed != null)
            throw new Error('垫洗中触发保底，欧气已固定；此 n 不能当作重新初始化的无限置换序列。');
        const pos = n.s.talents.indexOf(source.id);
        const r = e.replace(n.s, pos, [conflict]);
        const o = n.o.slice(); const origin = o.splice(pos,1)[0]; o.push(origin);
        const next = { ...n, s:r.state, o, poolStarted:true, draws:n.draws+r.purpleDraws,
            poolDraws:n.poolDraws+r.purpleDraws, exchanges:n.exchanges+1 };
        return record(n, next, { type:'exchange', position:pos, keepIds:[conflict], from:r.removedId, to:r.addedId });
    }
    function actions(n) {
        const out = [];
        for (let t = n.trace; t; t=t.prev) out.push(t.action);
        return out.reverse();
    }
    function exchangeNode(ctx, n, pos, locks) {
        const r=ctx.e(n.zi).replace(n.s,pos,locks),o=n.o.slice(),origin=o.splice(pos,1)[0];o.push(origin);
        return record(n,{...n,s:r.state,o,poolStarted:true,draws:n.draws+r.purpleDraws,
            poolDraws:n.poolDraws+r.purpleDraws,exchanges:n.exchanges+1},
            {type:'exchange',position:pos,keepIds:locks,from:r.removedId,to:r.addedId});
    }
    /**
     * 开启第4槽／升到三槽。
     *
     * 必须**同时改 state.zizhi**：引擎的 `wash()` / `replace()` 是按 `state.zizhi`
     * 决定槽数和紫池资格的，只改 `node.zi`（选哪套引擎）并不会让场上真的多出一个槽位。
     * 上游只改 `node.zi`，于是「开槽」实际没生效 —— 场上永远少一个槽，
     * 而多条紫的路线恰恰需要一个空槽来放「同类型低阶冲突脉」，所以四目标永远无解。
     */
    function upgradeNode(ctx, n, zi) {
        const e=ctx.e(zi);
        const s=Number(zi)>=154?e.upgradeToFour(n.s):e.upgradeToThree(n.s);
        return record(n,{...n,zi:Number(zi),s},{type:'upgrade',toZi:Number(zi)});
    }
    // n 保留标准单条垫洗的编号。改变开槽和锁法时，必须回到同一个自然种子停点，
    // 不能把新的点击次数当成另一条序列，也不能让保底偷偷初始化欧气。
    function padVariants(ctx, initial, source, sequence, targets, captured=null) {
        const first=initial.trace.action,steps=actions(initial),padStep=steps.findIndex(a=>a.why?.startsWith('无限置换垫洗 n='));
        if(padStep<0)return [];
        const base=captured||prefixNode(ctx,steps.slice(0,padStep)),end=first.before.state;
        if(base.s.luckSeed!=null||end.luckSeed!=null)return [];
        const required=steps[padStep].keepIds.filter(id=>id===source.id||first.keepIds.includes(id)||base.o[base.s.talents.indexOf(id)]>=0);
        if(required.some(id=>!base.s.talents.includes(id)))return [];
        const usefulTypes=new Set(sequence.pool.filter(id=>!targets.includes(id)).map(id=>ctx.e(154).talentType(id)));
        const variants=[],keys=new Set();
        function finish(n) {
            if(n.s.bornRC!==end.bornRC||n.s.bornSeed!==end.bornSeed||n.s.luckSeed!=null||missed(ctx,n)||n.pityCount!==base.pityCount)return;
            const e=ctx.e(n.zi),pos=n.s.talents.indexOf(source.id),locks=n.s.talents.filter(id=>e.quality(id)<4||first.keepIds.includes(id));
            if(!e.replaceablePositions(n.s,locks).includes(pos))return;
            const next=exchangeNode(ctx,n,pos,locks);
            // 保持首手和首手后的欧气种子一致；同名跳过变化不能冒充原序列洗法。
            if(next.s.talents.at(-1)!==first.to||next.s.luckSeed!==initial.s.luckSeed)return;
            const key=[next.zi,root.WashSourceEngine.stateKey(next.s),next.o.join(',')].join('|');
            if(!keys.has(key)){keys.add(key);variants.push(next);}
        }
        for(const zi of base.zi===153?[153,154]:[base.zi]) {
            const ready=zi===base.zi?base:upgradeNode(ctx,base,zi),e=ctx.e(zi);
            if(required.length>=e.slotCount)continue;
            let scan=ready,w=0;
            const candidates=[];
            function remember(n,count) {
                for(const id of n.s.talents)if(!required.includes(id)&&e.quality(id)<4)
                    candidates.push({id,node:n,count,useful:usefulTypes.has(e.talentType(id))});
            }
            remember(scan,0);
            while(w<12000&&scan.s.bornRC<end.bornRC&&scan.s.luckSeed==null) {
                scan=washOne(ctx,scan,required.map(id=>scan.s.talents.indexOf(id)));w++;
                if(missed(ctx,scan))break;
                remember(scan,w);
                if(scan.s.bornRC===end.bornRC)finish(record(ready,{...scan},{type:'wash',keepIds:required,count:w,why:'同序列少锁快洗到置换停点'}));
            }
            // 最近的事件先比较；同名冲突每次出现的种子不同，不能按名字去重。
            const shortlisted=candidates.filter((a,i)=>a.useful||i>=candidates.length-8).reverse().slice(0,80);
            for(const c of shortlisted) {
                const ids=[...required,c.id];if(ids.length>=e.slotCount)continue;
                const before=c.count?record(ready,{...c.node},{type:'wash',keepIds:required,count:c.count,why:'同序列少锁快洗，准备提前冲突'}):ready;
                let n=before,count=0;
                while(count<12000&&n.s.bornRC<end.bornRC&&n.s.luckSeed==null) {
                    n=washOne(ctx,n,ids.map(id=>n.s.talents.indexOf(id)));count++;
                    if(missed(ctx,n))break;
                }
                if(count)finish(record(before,n,{type:'wash',keepIds:ids,count,why:'同序列提前锁冲突，精确到置换停点'}));
            }
        }
        // 不同前置冲突都保留少量候选，避免最便宜停点缺少后续操作空间。
        const groups=new Map();
        variants.sort((a,b)=>a.cost-b.cost||a.exchanges-b.exchanges||a.washes-b.washes);
        for(const n of variants) {
            const e=ctx.e(n.zi),key=n.s.talents.filter(id=>e.quality(id)<4&&usefulTypes.has(e.talentType(id))).map(id=>e.talentType(id)).sort().join(',');
            const group=groups.get(key)||[];if(group.length<2)group.push(n);groups.set(key,group);
        }
        return [...groups.values()].flat().sort((a,b)=>a.cost-b.cost).slice(0,12);
    }
    function usableSources(raw, anchors, purples) {
        const limit=anchors.length?Math.min(...anchors.map(a=>a.bornRC)):Infinity;
        const e=engine(raw,raw.zizhi);
        // 起点紫必须是**能用普通置换初始化无限置换序列**的自然紫：
        // 它自己前面要能找到「同类型低阶脉」当冲突（prepareSource 的要求）。
        // 神脉不能当起点 —— 单条神脉只能被另一条神脉冲，而 initialize 要靠
        // 「同类型低阶冲突脉」把起点紫换出去，神脉没有这类冲突可锁；
        // 实测以神脉作起点会直接抛「起点紫之前未找到能捕获指定原始紫并置换的前置冲突脉」。
        return purples.filter(a=>!a.fromPity&&!e.isShenmai(a.id)&&a.bornRC<=limit&&e.allIds.some(id=>e.allowed.has(id)&&
            (e.isShenmai(a.id)?e.isShenmai(id)&&id!==a.id:e.quality(id)<4&&e.talentType(id)===e.talentType(a.id))));
    }

    /**
     * 自动挑锚点：按目标顺序贪心，每个目标取**最早的可行锚点**。
     *
     * 「早」是关键 —— 丹耗只花在洗到锚点之间的路上，锚点越早越省；
     * 与其一路洗到「天然就是该目标」的那条紫（可能在 RC 5000 之后），
     * 不如在更早的紫位上直接置换过去（置换免费、不耗丹、不推进洗髓种子）。
     *
     * 每条候选必须同时满足：
     *   1) 不是保底紫、不是一心两用（引擎禁止它作置换起点）、没被前面的槽用掉；
     *   2) **神脉属性与目标一致** —— 单条神脉不能被普通紫置换（只有 ≥2 条神脉才互冲），
     *      所以「目标不是神脉」时不能拿神脉当锚点，反之亦然；
     *   3) 它要么本来就是该目标，要么不是别的槽还需要的目标（别把人家要用的紫吃掉）。
     * 第一个锚点之前要留得出置换起点，因此锚点从紫序第 2 条起挑。
     *
     * 返回 { anchors, reason }：成功时 anchors 与 targets 按下标一一对应。
     */
    /**
     * 自动挑锚点。
     *
     * 锚点的本义是**位置**：锚点只提供一个槽位，最终**目标紫脉会被置换到这个位置上**。
     * 所以锚点位上原本是哪条紫都行 —— 它可以是目标本身，也可以被置换成任意目标
     * （**置换出来的脉不限类型**，只要该位置前面有同类型的低阶冲突脉垫着即可）。
     * 隐藏保底紫同样可以当锚点。
     *
     * 但「最早一串位置」并不总是最好的：位置太靠前会让**置换起点**（source）没有立足之地
     * （起点必须在首个锚点之前，且要能先锁住一条同类型低阶冲突脉），搜索会直接无解。
     * 实测：萧佩吟用「紫序 #3/#4/#5」出不了路线，用「#4/#5/#6」出 2697 丹。
     *
     * 因此分工：
     *   ① 主选：**按目标类型匹配**（旧行为，稳定、已被大量案例验证过）；
     *   ② 兜底：类型匹配凑不齐时（目标类型在自然紫序里没有对应物），
     *      退化为**按位置挑**（只要求位置可用），让跨类型置换也能成为锚点。
     *      这正是「混元奇脉/转世金仙/岿然顶天」这类组合过去直接报「凑不出锚点」的原因。
     *
     * 返回 { anchors, reason, byOrder }：成功时 anchors 与 targets 按下标一一对应。
     */
    function tailLadderCost(anchorsInOrder, opts) {
        opts = opts || {};
        if(!anchorsInOrder||!anchorsInOrder.length)return 0;
        const sortedByWash=anchorsInOrder.slice().sort((x,y)=>(Number(x&&x.wash)||0)-(Number(y&&y.wash)||0));
        const scanSlots=Math.max(1,Number(opts.scanSlots)||3);
        const eat4=5;
        // 隐藏保底紫：**必须先扫出来再算阶梯**（使用者规则）。
        // findings 里 hidden[k].wash 是「垫洗后保底紫落点」的洗数，落点比天然紫更早，
        // 用它把该段缩短，阶梯才不会被长间隔虚高（步惊云 #4→#5 段 285 洗就是靠这个跳过）。
        const hiddenWashes=(Array.isArray(opts.hiddenPityWashes)?opts.hiddenPityWashes:[])
            .map(Number).filter(x=>Number.isFinite(x)).sort((a,b)=>a-b);
        let prevWash=0, cost=0;
        for(let k=0;k<sortedByWash.length;k++){
            let w=Number(sortedByWash[k]&&sortedByWash[k].wash)||0;
            // 这一段里如果有保底落点，本段终点取「最早能到的那个落点」
            if(hiddenWashes.length){
                const hit=hiddenWashes.find(hw=>hw>prevWash&&hw<w);
                if(hit!=null)w=hit;
            }
            const bars=Math.max(0,w-prevWash)*scanSlots;      // 这一段要推进的条数
            // 第 1 段：3 槽 0 锁（3 条/洗、3 丹/洗）；之后每锁一条：4 槽、k 锁
            const slots=k===0?3:4;
            const locks=k===0?0:Math.min(k,3);
            const perWash=Math.max(1,slots-locks);            // 每洗推进几条
            const unit=(k===0?3:(eat4+2*locks-1));            // 每洗丹耗
            cost+=Math.round(bars/perWash*unit);
            prevWash=w;
        }
        return cost;
            }

    function autoAnchors(raw, purples, targetIds, opts) {
        opts = opts || {};
        const wanted=(targetIds||[]).map(Number);
        // 锚点法原先限定 3~4 个目标。放宽到 2：
        //   统一搜索里「跳脉段」会先交付 1 个目标，剩 2 个交给锚点段；
        //   若这里仍要求 ≥3，统一路线就永远凑不出锚点，跳脉与锚点也就接不起来。
        // 2 目标时锚点法照样成立（两个位置 + 置换），只是路线更短。
        if(wanted.length<2||wanted.length>4)return {anchors:[],reason:'锚点路线需要 2~4 个目标。'};
        if(!purples||!purples.length)return {anchors:[],reason:'没有可用的原始紫序。'};
        let e;
        try { e=engine(raw,raw.zizhi); } catch(err){ return {anchors:[],reason:err.message}; }
        const needed=new Set(wanted);
        // 「能当置换起点」＝ 同类型有低阶脉可以锁在前面（起点不能是神脉，见 initialize()）。
        // ⚠ 保底紫**可以**当置换起点/锚点（使用者规则：收尾脉前面的脉，包括保底紫，都能拿来置换），
        //   以前这里一律 `!a.fromPity` 把保底紫排除了，于是步惊云永远选不到 #5 枪棍绝伦（保底紫），
        //   尾段只能从 #4 起算 344 洗（实际从 #5 起算只有 59 洗）。
        const exchangeable=(a)=>{
            const id=Number(a&&a.id);
            if(!a||e.isShenmai(id))return false;
            return e.allIds.some(x=>e.allowed.has(x)&&e.quality(x)<4&&e.talentType(x)===e.talentType(id));
        };
        const canBeSource=(a)=>!!a&&!a.fromPity&&exchangeable(a);   // 旧语义（自然紫起点）保留给其它调用
        /**
         * 挑一遍锚点。
         * allowPity=false：只用自然紫；
         * allowPity=true ：**保底紫也能当锚点**（使用者规则）。
         */
        const pick = (allowPity) => {
            const usable=(a)=>a&&(allowPity||!a.fromPity)&&Number(a.id)!==251;
            /**
             * 这条紫能不能承载这个目标（**使用者规则，2026-10 修**）：
             *   · 天然就是它 → 行（直接洗出来锁住）；
             *   · 是别的目标 → 不行（会把那个目标顶掉）；
             *   · 目标是神脉 → 只有当这条紫也是神脉时才换得动（神脉互冲）；
             *   · 普通目标 → 这条紫必须**真的能被置换**（canBeSource：非保底、非神脉、
             *     且同类型有低阶脉可以锁在前面）。
             * 以前只要求「神脉性一致」，于是会把「天人合一」这种没有同类型低阶脉的紫
             * 选成「术绍岐黄」的锚点 —— 根本换不动，路线必然失败。
             */
            const canHost=(a,want)=>{
                const pid=Number(a&&a.id);
                if(pid===want)return true;
                if(needed.has(pid))return false;
                // 中间锚点：只要这条紫真能被置换就行（保底紫也算，使用者规则）。
                // 置换池能吐神脉，所以神脉目标也可以从普通紫换出来，这里不额外限制。
                return exchangeable(a)&&(allowPity||!a.fromPity);
            };
            /**
             * 收尾锚点的候选（**使用者规则**）：只能是
             *   · 目标本身（天然洗出来），或
             *   · 非目标神脉 —— 且只有「目标是神脉」时才有意义（两神脉互冲，确定能换）。
             * 普通紫当收尾要靠置换池抽签，不保证出目标，所以一律不做收尾。
             */
            const canBeTail=(a,want)=>{
                const pid=Number(a&&a.id);
                if(pid===want)return true;
                if(needed.has(pid))return false;
                return e.isShenmai(want)&&e.isShenmai(pid);
            };
            /**
             * ① 收尾优先（**使用者规则，2026-10**）：
             *    「收尾锚点永远只有两种 —— 目标脉本身，或非目标神脉。」
             *    原因：到收尾时另外 N−1 个目标已经锁死 3 格，最后一步必须**确定能成**：
             *      · 目标本身 → 天然洗出来，必然到手；
             *      · 非目标神脉 → 神脉互冲，两神脉直接互换，也是确定的；
             *      · 普通紫 → 要靠置换池抽签，不保证出目标（天人合一被选成术绍的锚点就是这种错）。
             *    其余目标放在收尾锚点**之前**，各自找「真能置换」的位置。
             *
             *    ② 收尾脉还要**按丹数上限挑**（使用者补充规则）：
             *    「洗到第 N 条紫」本身就有一个下限 —— 3 槽无锁时每洗推进 3 条、每洗 3 丹，
             *    即 1 丹/条，所以洗到洗数 w 的这条紫至少要约 w×3 丹。
             *    下限已经超过上限的收尾位置直接排除：那种尾巴永远走不到，
             *    选它只会把锚点、尾段预留、搜索边界全部算虚。
             */
            const budget=Math.max(0,Number(opts.budget)||0);
            /**
             * 这条锚点阶梯的**最低丹耗**（使用者例子，2026-10）：
             *   8 条紫、每条间隔 100 条、#8 收尾，最低就是：
             *     ① 3 槽无锁洗到 #5：400 条 ÷3 = 133 洗 × 3 丹 ≈ 500 丹
             *     ② 开 4 槽、锁 #5 洗到 #6：100 条 ÷3 = 33 洗 × 6 丹 = 200 丹
             *     ③ 锁 #5#6 洗到 #7：100 条 ÷2 = 50 洗 × 8 丹 = 400 丹
             *     ④ 锁 #5#6#7 洗到 #8：100 条 ÷1 = 100 洗 × 10 丹 = 1,000 丹
             *   合计 ≈ 2,100 丹 —— **这个下限超过上限的收尾位置，根本不用去选**。
             * 所以用一个「分段阶梯」算，而不是拍脑袋的 1 丹/条。
             */
            const minLadderCost=(anchorsInOrder)=>tailLadderCost(anchorsInOrder,opts);
            const tailFloorCost=w=>Math.max(0,Number(w)||0)*3;   // 兼容旧字段的下界
            const pickTailFirst=()=>{
                let best=null, bestAny=null;
                for(let ti=0;ti<wanted.length;ti++){
                    const want=wanted[ti];
                    for(let ci=0;ci<purples.length;ci++){
                        const a=purples[ci];
                        if(!usable(a))continue;
                        if(!canBeTail(a,want))continue;
                        const pid=Number(a.id);
                        const isNatural=pid===want;
                        const u=new Set([ci]);
                        const picked=[];
                        let ok=true;
                        // ⚠ 其余目标要取**最靠近收尾脉**的合法位置（从 ci−1 往前找），
                        //   取最早的会把尾段拉长：实测步惊云若把第三个目标放在 #4（472 洗），
                        //   尾段 #4→#6 = 344 洗；放在 #5（757 洗）则只有 59 洗 = 1,770 丹。
                        for(let k=wanted.length-1;k>=0;k--){
                            if(k===ti)continue;
                            const w=wanted[k];
                            let idx=-1;
                            for(let i=ci-1;i>=0;i--){
                                if(u.has(i)||!usable(purples[i]))continue;
                                if(canHost(purples[i],w)){idx=i;break;}
                            }
                            if(idx<0){ok=false;break;}
                            u.add(idx);picked.push(idx);
                        }
                        if(!ok)continue;
                        const anchors=picked.map(i=>purples[i]).concat([a]);
                        const reach=Math.max.apply(null,anchors.map(x=>Number(x&&x.wash)||0));
                        // 打分：**尾段越短越好**（尾段每洗 10 丹、每洗只推进 1 条，是全程最贵的一段），
                        // 再看路线总长度。这样「隐藏保底紫顶在目标前 9 条」的收尾才会被选中
                        // （步惊云：神力尾段 9 条 = 90 丹，而不是从金仙算的 177 条 = 1,770 丹）。
                        const before=Math.max.apply(null,picked.map(i=>Number(purples[i]&&purples[i].wash)||0));
                        const tailGap=Math.max(0,(Number(a.wash)||0)-before);
                        const score=tailGap*1000+reach;
                        const cand={anchors,reach,tailGap,score,isNatural,
                            tailWash:Number(a.wash)||0,minCost:minLadderCost(anchors)};
                        if(!bestAny||cand.minCost<bestAny.minCost)bestAny=cand;
                        // 丹数上限：这条收尾的**最低阶梯丹耗**已经超预算 → 不可能走到，跳过
                        if(budget>0&&cand.minCost>budget)continue;
                        if(!best||score<best.score||(score===best.score&&isNatural&&!best.isNatural))
                            best=cand;
                    }
                }
                return best||bestAny;
            };
            const tailFirst=pickTailFirst();
            if(tailFirst)return {anchors:tailFirst.anchors,reason:'',byOrder:false,
                tailKind:tailFirst.isNatural?'natural':'shenmai',tailGap:tailFirst.tailGap,
                tailWash:tailFirst.tailWash,minCost:tailFirst.minCost,naturalCount:tailFirst.naturalCount,
                tailFloorCost:tailFirst.minCost};
            // ① 主选：按目标类型匹配 + 序号递增。
            const byType=[];
            {
                const u=new Set(); let cursor=1;                  // 0 号留给置换起点
                for(const want of wanted){
                    const idx=purples.findIndex((a,i)=>i>=cursor&&!u.has(i)&&usable(a)&&canHost(a,want));
                    if(idx<0)break;
                    u.add(idx);byType.push(idx);cursor=idx+1;
                }
            }
            if(byType.length===wanted.length && (canBeSource(purples[0])||byType.some(i=>canBeSource(purples[i]))))
                return {anchors:byType.map(i=>purples[i]),reason:'',byOrder:false};
            // ② 兜底：类型匹配凑不齐 → 按位置挑（最早一段可用位置）。
            const sourceBudget=i=>canBeSource(purples[i])||purples.slice(0,i).some(canBeSource);
            let firstOk=0;
            while(firstOk<purples.length && !(usable(purples[firstOk])&&sourceBudget(firstOk))) firstOk++;
            const byOrder=[]; const u2=new Set();
            for(let k=0;k<wanted.length;k++){
                const want=wanted[k];
                const idx=purples.findIndex((a,i)=>i>=firstOk&&!u2.has(i)&&usable(a)&&canHost(a,want));
                if(idx<0)break;
                u2.add(idx);byOrder.push(idx);
            }
            if(byOrder.length!==wanted.length)return null;
            return {anchors:byOrder.map(i=>purples[i]),reason:'',byOrder:true};
        };
        // 自然紫与「含保底紫」两套都算出来，再按**阶梯丹耗**择优：
        //   保底紫也能当锚点（使用者规则），而含保底紫往往能把尾段大幅缩短
        //   （步惊云 3 号锚点用 #5 枪棍绝伦(保底紫) → 尾段 59 洗；只用自然紫 → 344 洗）。
        const natural = pick(false);
        const withPity = pick(true);
        if (typeof opts.onPick === 'function') {
            try {
                opts.onPick({ natural, withPity });
            } catch (e) { /* 调试钩子不影响主流程 */ }
        }
        const cands = [natural, withPity].filter(Boolean);
        if (!cands.length) {
            return {anchors:[],reason:`原始紫里凑不出 ${wanted.length} 个可用锚点（自然紫与保底紫都试过了）。`};
        }
        const budgetForPick = Math.max(0, Number(opts.budget) || 0);
        const costOf = c => Number(c.minCost != null ? c.minCost : Infinity);
        // ⚠ 不用「阶梯下限 > 预算」做硬淘汰：阶梯是按**天然一路洗过去**估的，
        //   实际路线靠置换 / 隐藏保底能跳过很多段（步惊云 #5#6#7#8 的阶梯 > 8,000，
        //   但真实方案 7,949 丹）。预算只在排序里当第二权重。
        void budgetForPick;
        let pool = cands.slice();
        // 择优：按阶梯丹耗（有预算时优先 ≤ 预算的）。
        // ⚠ 「天然命中数优先」已回退：会把收尾推到更深的紫，尾段口径随之改变（见上）。
        const natOf = c => Number(c.naturalCount || 0);
        void natOf;
        pool = pool.slice().sort((a, b) => costOf(a) - costOf(b));
        const chosen = pool[0];
        return Object.assign({}, chosen, {
            usedPityAnchor: chosen === withPity && chosen.anchors.some(a => a && a.fromPity),
        });
    }

    /**
     * 「纯天然顺锁」策略 —— 确定性、不用搜索。
     *
     * 适用场景：目标本身就在原始紫序里依序出现（实测薛龙城四目标全天然：
     * #3 混元奇脉 RC927、#12 天生神力 RC5502、#13 岿然顶天 RC5636、#16 转世金仙 RC6400）。
     *
     * 做法：3 槽起手 → 无锁洗到某个目标出现就锁定 → 锁满槽位就开第 4 槽 → 继续洗下一个，
     * 直到目标齐或超预算。**锁住的槽不重抽**，所以每洗推进 RC 数 = 槽数 − 锁数，
     * 这是纯天然路线无法回避的成本。
     *
     * 为什么需要它：状态搜索在 6000 节点内也收敛不到这种「跨 1300+ 洗、16 条紫」的长路线
     * （实测 expanded=6000、bounded=true、routes=0），但这条路是确定性的、直接就能算出来。
     *
     * 返回 { ok, cost, washes, field, steps, overBudget }；ok=true 表示四目标齐全。
     */
    function greedyNaturalPlan(raw, targets, opts) {
        opts = opts || {};
        const TG = (targets || []).map(Number);
        if (TG.length < 2 || TG.length > 4) return null;
        const budget = Number(opts.budget) || 0;
        let zi = Number(raw.zizhi) || 153;
        if (zi < 153) zi = 153;                       // 未满三槽先按三槽规划
        let e;
        try { e = engine(raw, zi); } catch (err) { return null; }
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let cost = 0, washes = 0, overBudget = false;
        const locked = [];
        const steps = [];
        const pending = TG.slice();
        const keepOf = () => locked.map(id => s.talents.indexOf(id)).filter(i => i >= 0).sort((a, b) => a - b);
        // 无锁前缀：先空洗 prefix 次（3 槽 0 锁，每洗只要 eat = 3 丹，是最便宜的推进手段）。
        // 实战方案靠它把天赋流推到合适位置，让目标在后面密集出现 —— 薛龙城参考方案用 864 洗。
        const prefix = Math.max(0, Math.floor(Number(opts.prefix) || 0));
        for (let i = 0; i < prefix; i++) {
            const r = e.wash(s, []);
            s = r.state; cost += Number(r.cost) || 0; washes++;
            if (budget > 0 && cost > budget) { overBudget = true; break; }
        }
        if (prefix > 0) steps.push({ type: 'prefix', washes: prefix, cost, after: s.talents.slice() });
        let guard = 0;
        while (!overBudget && pending.length && guard++ < 40000) {
            const keep = keepOf();
            if (keep.length !== locked.length) return null;    // 锁定的脉被洗掉了，路线作废
            const r = e.wash(s, keep);
            s = r.state; cost += Number(r.cost) || 0; washes++;
            // 有新目标出现 → 锁定它
            let hit = null;
            for (const id of pending) if (s.talents.includes(id)) { hit = id; break; }
            if (hit != null) {
                locked.push(hit);
                pending.splice(pending.indexOf(hit), 1);
                steps.push({ type: 'lock', id: hit, washes, cost, after: s.talents.slice() });
            }
            if (budget > 0 && cost > budget) { overBudget = true; break; }
            // 锁满当前槽位数 → 需要开第 4 槽才有空位继续洗
            if (locked.length >= e.slotCount && zi === 153) {
                zi = 154;
                e = engine(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: 154 }));
                steps.push({ type: 'upgrade', toZi: 154, washes, cost, after: s.talents.slice() });
            }
        }
        const ok = TG.every(id => s.talents.includes(id));
        return { ok, cost, washes, field: s.talents.slice(), steps, overBudget, prefix,
            missing: TG.filter(id => !s.talents.includes(id)), naturalOnly: true };
    }

    /**
     * 「天然 + 置换混合」策略 —— 本轮的核心。
     *
     * 关键机制：`replace` 是**纯函数**，所以每一步都能先**试算**「如果现在对某个可置换位置做
     * 置换，产出会不会正好是还缺的目标」，会就立刻执行 —— **置换 0 洗、不耗丹**。
     *
     * 为什么这能大幅省钱：纯天然顺锁的瓶颈是「锁着等深位目标」，每洗 4~10 丹；
     * 薛龙城要等 1,453 洗拿天生神力 = 5,812 丹，占一半开销。而只要欧气池在某个更早的
     * 时刻能通过置换产出该目标，就能**免费**拿到它。
     *
     * 每步顺序：
     *   ① 先试算所有可置换位置 → 有能直接产出「还缺的目标」的，就换（免费）
     *   ② 没有 → 无锁/带锁洗一次，看是否有目标天然出现，出现就锁
     *   ③ 锁满当前槽位 → 开第 4 槽
     * 直到目标齐、或超预算、或洗到上限。
     */
    function greedyHybridPlan(raw, targets, opts) {
        opts = opts || {};
        const TG = (targets || []).map(Number);
        if (TG.length < 2 || TG.length > 4) return null;
        const budget = Number(opts.budget) || 0;
        const maxWash = Number(opts.maxWash) || 30000;
        // opts.tailId：把某一条目标**留给天然**（收尾脉），其余目标照常用置换/链提前拿。
        // 这是「收尾脉扫描」的执行器 —— 收尾脉一旦定死，其余 N−1 条就只是普通目标。
        const tailId = opts.tailId != null ? Number(opts.tailId) : null;
        if (tailId != null && !TG.includes(tailId)) return null;
        let zi = Number(raw.zizhi) || 153;
        if (zi < 153) zi = 153;
        let e;
        try { e = engine(raw, zi); } catch (err) { return null; }
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let cost = 0, washes = 0, overBudget = false;
        const locked = [];
        const sacrificial = [];        // 为置换而临时锁住的「非目标紫」，不是最终目标
        const waitingTypes = [];       // 已锁冲突脉的类型，等在后面洗出同类型的紫
        const steps = [];
        const pending = tailId == null ? TG.slice() : TG.filter(id => id !== tailId);
        let tailPending = tailId != null;
        const keepOf = () => locked.map(id => s.talents.indexOf(id)).filter(i => i >= 0).sort((a, b) => a - b);
        const prefix = Math.max(0, Math.floor(Number(opts.prefix) || 0));
        for (let i = 0; i < prefix; i++) {
            const r = e.wash(s, []);
            s = r.state; cost += Number(r.cost) || 0; washes++;
            if (budget > 0 && cost > budget) { overBudget = true; break; }
        }
        if (prefix > 0) steps.push({ type: 'prefix', washes: prefix, cost, after: s.talents.slice() });
        let guard = 0, exchanges = 0;
        while (!overBudget && (pending.length || tailPending) && guard++ < maxWash) {
            const keep = keepOf();
            if (keep.length !== locked.length) return null;
            // ① 免费置换：试算有没有位置能直接产出「还缺的目标」
            let took = false;
            // ①' 定向置换链：不是只试一步，而是**连续推演欧气池** ——
            //     反复 replace（纯函数）看第几次会产出还缺的目标。
            //     置换 0 洗、不耗丹，所以「烧」几次无所谓；关键是**算出来**要烧几次，
            //     而不是逐洗撞运气（实测撞不上）。这正是参考方案「9 次置换 7 次白烧」的做法。
            try {
                const chainMax = Math.max(2, Number(opts.exchangeChain) || 8);
                let cur = s;
                const outs = [];
                let hit = null;
                for (let i = 1; i <= chainMax; i++) {
                    // ★ 坑：replaceablePositions/replace 的第二参是**脉 id**，不是下标
                    //   （wash 的 keep 才是下标）。早期这里传的是 keepOf() 的下标，
                    //   引擎永远查不到锁住的冲突脉 → 返回空 → 定向置换链一次都跑不起来，
                    //   所有确定性方案都退化成「纯天然」（步惊云 76,394 丹 / 0 次置换）。
                    if (!locked.every(x => cur.talents.includes(x))) break;
                    const lockIds = locked.slice();
                    const positions = e.replaceablePositions(cur, lockIds);
                    if (!positions.length) break;
                    let chosen = null, trial2 = null;
                    for (const pos of positions) {
                        // 只能换「非目标的紫」—— 目标不能动；为置换临时锁住的紫**可以**换
                        // （它们本来就锁着等这一刻；早期写成 locked.includes 会把这些紫也跳过，
                        //   导致永远换不出去）。
                        const t0id = Number(cur.talents[pos]);
                        if (TG.includes(t0id)) continue;
                        let t2;
                        try { t2 = e.replace(cur, pos, lockIds); } catch (err) { continue; }
                        chosen = pos; trial2 = t2; break;
                    }
                    if (chosen == null || trial2 == null) break;
                    outs.push({ from: cur.talents[chosen], to: Number(trial2.addedId) });
                    if (pending.includes(Number(trial2.addedId))) { hit = Number(trial2.addedId); cur = trial2.state; break; }
                    cur = trial2.state;
                }
                if (hit != null) {
                    // 落地整条链：逐步重放，确保与推演一致
                    let real = s;
                    for (const o of outs) {
                        const lockR = locked.slice();
                        const posR = real.talents.findIndex((id, idx) =>
                            id === o.from && e.replaceablePositions(real, lockR).includes(idx)
                            && !TG.includes(Number(id)));
                        if (posR < 0) { hit = null; break; }
                        let rr;
                        try { rr = e.replace(real, posR, lockR); } catch (err) { hit = null; break; }
                        real = rr.state;
                    }
                    if (hit != null) {
                        s = real; exchanges += outs.length;
                        locked.push(hit);
                        pending.splice(pending.indexOf(hit), 1);
                        // ★ 关键：置换成功后**释放冲突脉**，把那格还回去。
                        //   配对时占的「冲突 + 紫」两格，换完就变成「目标」一格，
                        //   冲突脉没必要继续锁着 —— 不释放的话 4 槽装不下 4 目标。
                        for (const id of locked.slice()) {
                            if (e.quality(id) < 4) locked.splice(locked.indexOf(id), 1);
                        }
                        for (const id of sacrificial.slice()) {
                            if (TG.includes(Number(id))) sacrificial.splice(sacrificial.indexOf(id), 1);
                        }
                        waitingTypes.length = 0;
                        steps.push({ type: 'exchangeChain', count: outs.length, id: hit,
                            burns: outs.length - 1, washes, cost, after: s.talents.slice() });
                        took = true;
                    }
                }
            } catch (err) { /* 链不可用就退回单步试算 */ }
            if (!took) try {
                // 同上：replaceablePositions/replace 收**脉 id**
                for (const pos of e.replaceablePositions(s, locked.slice())) {
                    let trial;
                    try { trial = e.replace(s, pos, locked.slice()); } catch (err) { continue; }
                    if (!pending.includes(Number(trial.addedId))) continue;
                    const removed = s.talents[pos];
                    const hitId = Number(trial.addedId);
                    s = trial.state; exchanges++;
                    locked.push(hitId);
                    pending.splice(pending.indexOf(hitId), 1);
                    steps.push({ type: 'exchange', from: removed, id: hitId,
                        washes, cost, after: s.talents.slice() });
                    took = true;
                    break;
                }
            } catch (err) { /* 置换不可用就跳过 */ }
            if (took) {
                if (locked.length >= e.slotCount && zi === 153) {
                    zi = 154; e = engine(raw, zi);
                    s = e.upgradeToFour(Object.assign({}, s, { zizhi: 154 }));
                    steps.push({ type: 'upgrade', toZi: 154, washes, cost, after: s.talents.slice() });
                }
                continue;
            }
            // ★ 3 槽放不下「已锁目标 + 冲突位」时立刻开第 4 槽。
            //   旧实现只在**置换成功之后**才升级，而置换又需要冲突位 ——
            //   死锁：没冲突→不置换→不升级→永远 3 槽，每洗 1 条磨到超预算
            //   （实测柳如意锁 2 条后 3,333 洗 / 0 置换 / 12,003 丹）。
            if (zi === 153 && locked.length + 1 >= e.slotCount) {
                zi = 154;
                e = engine(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: 154 }));
                steps.push({ type: 'upgrade', toZi: 154, washes, cost, after: s.talents.slice() });
                continue;
            }
            // ② 洗一次，看是否有目标天然出现
            const r = e.wash(s, keep);
            s = r.state; cost += Number(r.cost) || 0; washes++;
            let lockedTarget = false;
            for (const id of pending.slice()) {
                if (s.talents.includes(id)) {
                    locked.push(id);
                    pending.splice(pending.indexOf(id), 1);
                    steps.push({ type: 'lock', id, washes, cost, after: s.talents.slice() });
                    lockedTarget = true;
                    break;
                }
            }
            if (budget > 0 && cost > budget) { overBudget = true; break; }
            // ②' 收尾脉：只靠天然拿（它就是要「留到最后自然出现」的那一条）。
            //    前面的目标靠置换免费收，所以这里通常已经锁了 N−1 条，只剩 1 个可洗槽 ——
            //    也正因为如此，收尾脉必须**近**：深了每洗都在 1 个可洗槽上磨，必超预算。
            if (tailPending && s.talents.includes(tailId)) {
                locked.push(tailId);
                tailPending = false;
                lockedTarget = true;
                steps.push({ type: 'lock', id: tailId, washes, cost, after: s.talents.slice(), tail: true });
            }
            // ③ 顺带锁「低阶冲突脉」—— 关键补充。
            //    引擎要求置换前场上有一条已锁的同类型低阶脉；只锁目标的话
            //    replaceablePositions() 永远是空，一次置换都做不出来。
            //    （参考方案里的 枪棍好手／刀法高手／拳脚好手 就是这类冲突源。）
            if (!lockedTarget) {
                // ③ 顺带锁「低阶冲突脉」，但**必须严格判定它真能带来收益**：
                //    早期版本「见低阶就锁 / 先锁紫再找冲突」都把目标位挤掉了，
                //    柳如意/聂风直接退化成无方案。现在的条件：
                //      a) 锁上之后还剩格子继续洗；
                //      b) 场上已有一条**非目标的紫**与它同类型（紫在冲突之后才换得动）；
                //      c) 锁上之后用「定向置换链」推演，能在若干步内换出还缺的目标。
                const room = locked.length + 1 < e.slotCount;
                if (room) {
                    // ⚠ 顺序是硬条件：冲突脉必须排在**紫之前**（引擎按位置判定），
                    //   早期只要求「场上有同类型紫」，冲突在后面时一次都换不动 ——
                    //   实测步惊云就是被这条卡住：所有确定性方案都退化成纯天然。
                    const pairs = [];
                    for (let pi = 0; pi < s.talents.length; pi++) {
                        const purpleId = s.talents[pi];
                        if (e.quality(purpleId) !== 4 || TG.includes(Number(purpleId)) || Number(purpleId) === 251) continue;
                        for (let li = 0; li < pi; li++) {
                            const lowId = s.talents[li];
                            if (Number(lowId) === 251 || locked.includes(lowId) || e.quality(lowId) >= 4) continue;
                            if (e.talentType(lowId) !== e.talentType(purpleId)) continue;
                            pairs.push({ lowId, purplePos: pi });
                        }
                    }
                    for (const cand of pairs) {
                        if (![...locked, cand.lowId].every(x => s.talents.includes(x))) continue;
                        let useful = false;
                        try {
                            const chainMax2 = Math.max(2, Number(opts.exchangeChain) || 8);
                            let c2 = s;
                            for (let k = 0; k < chainMax2; k++) {
                                // 同坑：传 id 才查得到锁住的冲突脉
                                const kN = [...locked, cand.lowId];
                                if (!kN.every(x => c2.talents.includes(x))) break;
                                const ps = e.replaceablePositions(c2, kN);
                                if (!ps.length) break;
                                let nxt = null;
                                for (const pos of ps) {
                                    if (TG.includes(Number(c2.talents[pos])) || c2.talents[pos] === cand.lowId) continue;
                                    let t2;
                                    try { t2 = e.replace(c2, pos, kN); } catch (err) { continue; }
                                    nxt = t2; break;
                                }
                                if (!nxt) break;
                                if (pending.includes(Number(nxt.addedId))) { useful = true; break; }
                                c2 = nxt.state;
                            }
                        } catch (err) { useful = false; }
                        if (!useful) continue;
                        locked.push(cand.lowId);
                        steps.push({ type: 'lockConflict', id: cand.lowId, washes, cost, after: s.talents.slice() });
                        break;
                    }
                }
            }
            if (locked.length >= e.slotCount && zi === 153) {
                zi = 154; e = engine(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: 154 }));
                steps.push({ type: 'upgrade', toZi: 154, washes, cost, after: s.talents.slice() });
            }
        }
        const ok = TG.every(id => s.talents.includes(id));
        return { ok, cost, washes, field: s.talents.slice(), steps, overBudget, prefix,
            exchanges, hybrid: true, tailId, tailNatural: tailId != null,
            missing: TG.filter(id => !s.talents.includes(id)) };
    }

    /** 混合策略的前缀档位扫描：取目标齐全且最省的一条。 */
    function greedyHybridBest(raw, targets, opts) {
        opts = opts || {};
        const prefixes = Array.isArray(opts.prefixes) && opts.prefixes.length
            ? opts.prefixes
            : [0, 100, 200, 300, 400, 500, 600, 700, 800, 864, 900, 1000, 1200];
        let best = null;
        for (const px of prefixes) {
            let r = null;
            try { r = greedyHybridPlan(raw, targets, { budget: opts.budget, prefix: px }); } catch (err) { continue; }
            if (!r || !r.ok) continue;
            if (!best || r.cost < best.cost) best = r;
        }
        return best;
    }

    /**
     * 「置换优先」执行器（v2.2.1，按用户给的柳如意 9,482 丹实测路线学）
     * ============================================================
     * 实测路线长这样（4 槽起手，5 次置换、其中 2 次白烧，1,362 洗 / 9,482 丹）：
     *   锁「拳脚好手」（同类型低阶）→ 锁「拳脚无双」（紫）→ 把紫**置换**成「岿然顶天」；
     *   再白烧两次推进池子 → 收尾把「玄阳神脉」置换为「转世金仙」。
     * 也就是说：**目标是靠置换免费换来的，不是等天然**；洗只用来推进「下一个可置换的紫」。
     *
     * 这个执行器就是这套时序：
     *   ① 场上目标出现就锁（占槽）
     *   ② 只要有「非目标紫 + 它前面已锁的同类型低阶脉」→ 立刻置换（0 丹 0 洗）；
     *      换出来是目标就锁，不是目标就是**白烧**（继续推进池子）
     *   ③ 没得换时，先给「下一条紫的类型」预锁一条同类型低阶脉（紫必须在冲突后面才换得动）
     *   ④ 否则洗一次（锁住已有目标）
     *
     * opts: { zi（153/154，默认 154 = 4 槽起手）, budget, maxWash, refresh（预锁刷新间隔） }
     * 返回 { ok, cost, washes, exchanges, burns, field, steps, missing }
     */
    function exchangeFirstPlan(raw, targets, opts) {
        opts = opts || {};
        const TG = (targets || []).map(Number);
        if (TG.length < 2 || TG.length > 4) return null;
        let zi = Number(opts.zi) || 154;
        if (zi < 153) zi = 154;
        let e;
        try { e = engine(raw, zi); } catch (err) { return null; }
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        const budget = Number(opts.budget) || 0;
        const maxWash = Number(opts.maxWash) || 40000;
        const refresh = Math.max(5, Number(opts.refresh) || 40);
        const conflictTtl = Math.max(20, Number(opts.conflictWash) || 260);
        let cost = 0, washes = 0, exchanges = 0, burns = 0;
        const held = [];              // 已锁目标
        const conflicts = [];         // 临时锁住的冲突脉（{id, since, type}）
        let lockedPending = null;     // 为「延迟置换」临时锁住的非目标紫（换出去就清空）
        const steps = [];
        const allLocked = () => held.concat(conflicts.map(c => c.id)).concat(lockedPending == null ? [] : [lockedPending]);
        const keep = () => allLocked().map(id => s.talents.indexOf(id)).filter(i => i >= 0);
        const dropConflict = why => {
            if (!conflicts.length) return false;
            const c = conflicts.shift();
            steps.push({ type: 'unlockConflict', id: c.id, washes, cost, why: why || '' });
            return true;
        };
        // 预判「下一条紫是什么类型、还有几洗」，给「预锁冲突」用
        // （先锁一条同类型低阶脉，紫一到就能换；锁早了会白占槽位并拖慢推进）
        // ⚠ 引擎状态 s 的字段是 bornSeed/luckSeed/bornRC/talLucky，而 initialState() 认的是
        //    seed/luck_seed/born_talent_rc/tal_lucky —— 直接把 s 传进去会退化成「空状态」，
        //    预判就全错（实测会一直去锁枪棍冲突，而来的一直是别的类型）。这里必须转换。
        const rawOf = st => Object.assign({}, raw, {
            zizhi: st.zizhi, seed: st.bornSeed,
            born_talent_rc: st.bornRC,
            luck_seed: st.luckSeed == null ? 0 : st.luckSeed,
            luck_seed_inited: st.luckSeed != null,
            tal_lucky: st.talLucky,
            talents: (st.talents || []).map(id => ({ id, locked: false })),
        });
        let lookahead = null, nextLookAt = 0;
        let targetWash = {};                 // 0 锁投影里各目标的天然洗数（越深越难拿）
        const refreshTypes = () => {
            lookahead = null;
            targetWash = {};
            try {
                const e2 = engine(raw, zi);
                let s2 = e2.initialState(rawOf(s));
                const keep2 = keep();
                for (let i = 0; i < 1500; i++) {
                    const r = e2.wash(s2, keep2);
                    s2 = r.state;
                    for (const ev of (r.generatedEvents || [])) {
                        if (e2.quality(ev.id) !== 4) continue;
                        const pid = Number(ev.id);
                        if (TG.includes(pid) && targetWash[pid] == null) targetWash[pid] = i + 1;
                        if (!lookahead) lookahead = { id: pid, type: e2.talentType(pid), inWashes: i + 1 };
                    }
                    if (lookahead && Object.keys(targetWash).length >= TG.length) break;
                }
            } catch (err) { lookahead = null; }
            nextLookAt = washes + refresh;
        };
        refreshTypes();
        let guard = 0;
        const capacity = () => e.slotCount - 1;            // 永远留 1 个空槽给置换
        const lead = Math.max(1, Number(opts.lead) || 30); // 紫还有几洗时才去锁冲突
        const trace = typeof opts.onStep === 'function' ? opts.onStep : null;
        const emit = ev => { if (trace) trace(Object.assign({ washes, cost, field: s.talents.slice(), locks: allLocked() }, ev)); };
        while (guard++ < maxWash && washes < maxWash) {
            if (TG.every(id => s.talents.includes(id))) break;
            if (budget > 0 && cost > budget) break;
            // ⚠ 3 槽起手必须找机会开第 4 槽：4 个目标 + 置换用的冲突位在 3 槽里放不下。
            //   旧实现从不升级 → zi=153 的配置永远拿不全目标，只能一路洗到 maxWash
            //   （实测柳如意 zi=153 → 87,000 丹 / 只有 2 个目标）。
            // 使用者口径：**锁到第一条目标就开第 4 槽**（3 槽 2 锁时每洗只推进 1 条，
            // 4 槽 2 锁是 2 条/洗，丹耗每条约 6 → 4，越早开越省）。
            // 例外：需要「隐藏保底紫」的场合（步惊云那种）要留在 3 槽久一点，
            // 所以开槽阈值做成 opts.upgradeAt（默认 1，传 2 即旧行为）。
            const upgradeAt = Math.max(1, Number(opts.upgradeAt) || 1);
            if (zi === 153 && (held.length >= upgradeAt || capacity() <= 0)) {
                zi = 154;
                e = engine(raw, 154);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: 154 }));
                steps.push({ type: 'upgrade', toZi: 154, washes, cost, why: '开第 4 槽（3 槽放不下 4 目标 + 冲突位）' });
                refreshTypes();
            }
            // 冲突脉过期 → 释放（否则会把槽位永久占死）
            if (conflicts.length && washes - conflicts[0].since > conflictTtl) dropConflict('超时');
            if (keep().length !== allLocked().length) {
                if (opts && opts.onDebug) {
                    opts.onDebug({ washes, cost, field: s.talents.slice(), locked: allLocked() });
                }
                return null;                                  // 锁住的脉被洗掉了
            }
            // ① 收割场上目标（锁满为止，必要先腾冲突位）
            for (const id of TG) {
                if (s.talents.includes(id) && !held.includes(id)) {
                    while (held.length + conflicts.length >= capacity() && conflicts.length) dropConflict('腾位给目标');
                    if (held.length + conflicts.length < capacity()) {
                        held.push(id);
                        steps.push({ type: 'lockTarget', id, washes, cost });
                    }
                }
            }
            // ② 置换：任何可置换的**非目标紫**（已锁的冲突脉也不能动，动了就锁丢了）
            const lockIds = allLocked();
            const reps = e.replaceablePositions(s, lockIds).filter(p => {
                const pid = Number(s.talents[p]);
                return !TG.includes(pid) && !lockIds.includes(pid);
            });
            if (reps.length) {
                const p = reps[0];
                const from = Number(s.talents[p]);
                // ★ 延迟搜索（实测路线的关键）：首条保底紫还没来时，born 流会随洗髓推进，
                //   所以「现在换」和「再洗 d 洗再换」产出不同。把紫先锁住，逐个 d 试算
                //   「洗 d 洗后置换会得到什么」，挑第一个出目标（或最近目标）的 d 落地。
                //   参考路线就是这么做的：锁拳脚好手 + 拳脚无双，洗 115 洗，才把紫换成岿然顶天。
                let bestDelay = null;
                const delayLook = Math.max(0, Number(opts.delayLook) || 0);
                if (delayLook > 0 && !held.includes(from)) {
                    const locks2 = lockIds.concat([from]);
                    let sim = e.initialState(rawOf(s));
                    const hits = [];      // 这段窗口里能换出来的目标（可能有多个）
                    for (let d = 0; d <= delayLook; d++) {
                        const pos = sim.talents.indexOf(from);
                        if (pos < 0) break;
                        let ok = false;
                        try { ok = e.replaceablePositions(sim, locks2).includes(pos); } catch (err) { ok = false; }
                        if (!ok) break;
                        let trial = null;
                        try { trial = e.replace(sim, pos, locks2); } catch (err) { trial = null; }
                        if (trial && TG.includes(Number(trial.addedId)) && !held.includes(Number(trial.addedId))) {
                            hits.push({ d, to: Number(trial.addedId) });
                        }
                        const r2 = e.wash(sim, locks2.map(id2 => sim.talents.indexOf(id2)).filter(i2 => i2 >= 0));
                        sim = r2.state;
                    }
                    // 打分挑一个落地：收益 = 这个目标「天然要多深才能拿到」（越深越该靠置换白拿），
                    // 代价 = 为了等这个窗口要多洗的丹（d × 当前每洗价格）。
                    // 只按「最深优先」会为一条极深的脉白等几百洗，实测反而更贵。
                    if (hits.length) {
                        const perWash = (() => {
                            try { const probe = e.wash(e.initialState(rawOf(s)), keep()); return Number(probe.cost) || 0; }
                            catch (err) { return 8; }
                        })();
                        const prefer = Array.isArray(opts.prefer) ? opts.prefer.map(Number) : [];
                        const rank = id2 => { const k = prefer.indexOf(id2); return k < 0 ? prefer.length : k; };
                        const score = h => {
                            const natural = targetWash[h.to] == null ? 1200 : targetWash[h.to];
                            return natural - (h.d * perWash);
                        };
                        // opts.prefer 给了先后次序就按它（同一目标优先），否则按「收益 − 等待代价」排
                        hits.sort((a, b) => {
                            const d2 = rank(a.to) - rank(b.to);
                            return d2 || (score(b) - score(a)) || (a.d - b.d);
                        });
                        if (score(hits[0]) > 0 || prefer.length) bestDelay = hits[0];
                    }
                }
                if (bestDelay) {
                    // 落地：先锁紫、再洗 d 洗，然后把紫换成目标
                    lockedPending = from;
                    const locks3 = allLocked();
                    for (let i = 0; i < bestDelay.d; i++) {
                        const r2 = e.wash(s, keep());
                        s = r2.state; cost += Number(r2.cost) || 0; washes++;
                    }
                    const pos2 = s.talents.indexOf(from);
                    let ok2 = false;
                    try { ok2 = pos2 >= 0 && e.replaceablePositions(s, allLocked()).includes(pos2); } catch (err) { ok2 = false; }
                    if (ok2) {
                        const r3 = e.replace(s, pos2, allLocked());
                        s = r3.state; exchanges++;
                        const added3 = Number(r3.addedId);
                        lockedPending = null;
                        if (TG.includes(added3)) {
                            if (!held.includes(added3) && held.length < capacity()) held.push(added3);
                            steps.push({ type: 'exchange', from, to: added3, washes, cost, delay: bestDelay.d });
                        } else {
                            burns++;
                            steps.push({ type: 'burn', from, to: added3, washes, cost, delay: bestDelay.d });
                        }
                        // 步骤必须按真实操作顺序记录：先置换，再释放冲突。
                        // 旧顺序会写成“先解锁、后置换”，界面回放看起来不可执行。
                        while (conflicts.length) dropConflict('换完释放');
                        emit({ ev: 'replaceDelayed', from, to: added3, delay: bestDelay.d, isTarget: TG.includes(added3) });
                        refreshTypes();
                        continue;
                    }
                    lockedPending = null;
                }
                const r = e.replace(s, p, lockIds);
                s = r.state; exchanges++;
                const added = Number(r.addedId);
                emit({ ev: 'replace', from, to: added, isTarget: TG.includes(added) });
                if (TG.includes(added)) {
                    if (!held.includes(added) && held.length < capacity()) held.push(added);
                    steps.push({ type: 'exchange', from, to: added, washes, cost });
                } else {
                    burns++;
                    steps.push({ type: 'burn', from, to: added, washes, cost });
                }
                // 先记录置换，再记录换完后的冲突释放。
                while (conflicts.length) dropConflict('换完释放');
                refreshTypes();
                continue;
            }
            // ③ 预锁冲突：**只在紫快到时**锁一条同类型低阶脉（锁早了白占槽位）
            if (washes >= nextLookAt) refreshTypes();
            if (!conflicts.length && lookahead && lookahead.inWashes <= lead && held.length + conflicts.length < capacity()) {
                const idx = s.talents.findIndex(id => e.quality(id) < 4 && !held.includes(id)
                    && !conflicts.some(c => c.id === id) && e.talentType(id) === lookahead.type);
                if (idx >= 0) {
                    const lowId = Number(s.talents[idx]);
                    conflicts.push({ id: lowId, since: washes, type: lookahead.type });
                    emit({ ev: 'lockConflict', id: lowId, type: lookahead.type, expectIn: lookahead.inWashes });
                    steps.push({ type: 'lockConflict', id: lowId, washes, cost, expectIn: lookahead.inWashes });
                    refreshTypes();
                    continue;
                }
            }
            // ④ 洗一次（⚠ 锁表可能在本轮里变过：必须**重新算**锁位，否则刚锁上的目标会被洗掉）
            const r = e.wash(s, keep());
            s = r.state; cost += Number(r.cost) || 0; washes++;
            if (lookahead) lookahead.inWashes--;
            // 锁着冲突却在等的紫没来、来的是别的类型 → 立刻释放冲突重试
            // （锁着洗会拖慢推进，紫的到达洗数会往后漂，所以不能靠固定的 TTL 硬等）
            if (conflicts.length) {
                const arrived = (r.generatedEvents || []).filter(ev => e.quality(ev.id) === 4);
                if (arrived.length && !arrived.some(ev => e.talentType(ev.id) === conflicts[0].type)) {
                    emit({ ev: 'conflictMiss', arrived: arrived.map(x => x.id), want: conflicts[0].type });
                    dropConflict('来的紫类型不对');
                    refreshTypes();
                }
            }
        }
        const field = s.talents.slice();
        const missing = TG.filter(id => !field.includes(id));
        // 收尾：最后一个目标是「洗到就停」拿到的，可能还没锁 —— 补一步锁定，
        // 免得玩家多看一步不知道该不该锁（锁定 0 丹，多锁一格的洗价也不再发生）。
        if (!missing.length) {
            for (const id of TG) {
                if (!held.includes(id) && s.talents.includes(id)) {
                    held.push(id);
                    steps.push({ type: 'lockTarget', id, washes, cost, final: true });
                }
            }
        }
        return { ok: missing.length === 0, cost, washes, exchanges, burns, field, steps, missing, zi };
    }

    /**
     * 「置换优先」多配置择优（对外用这个）。
     *
     * 实测：同一套执行器，`lead`（提前几洗锁冲突）与 `delayLook`（要不要等几洗再换）
     * 对结果影响极大 —— 柳如意 lead=40+delay=120 → 15,048 丹；lead=60 → 32,979 丹。
     * 所以固定一组参数会吃亏，这里跑几组常用组合取最省。
     */
    function exchangeFirstBest(raw, targets, opts) {
        opts = opts || {};
        const configs = Array.isArray(opts.configs) && opts.configs.length ? opts.configs : [
            { zi: 154, lead: 40, delayLook: 120 },
            { zi: 154, lead: 120, delayLook: 0 },
            // 3 槽起手：锁到第一条目标就开 4 槽（upgradeAt=1）通常更省丹，
            // 但像薛龙城那种「先空洗很久挑种子」的，留到第 2 条再开更省 —— 两档都比一次。
            { zi: 153, lead: 60, delayLook: 0, upgradeAt: 1 },
            { zi: 153, lead: 60, delayLook: 0, upgradeAt: 2 },
            { zi: 153, lead: 324, delayLook: 0, upgradeAt: 1 },
            { zi: 153, lead: 864, delayLook: 0, upgradeAt: 1 },
        ];
        const deadline = Date.now() + Math.max(1000, Number(opts.timeMs) || 40000);
        let best = null;
        for (const cfg of configs) {
            if (Date.now() > deadline) break;
            let r = null;
            try {
                r = exchangeFirstPlan(raw, targets, Object.assign({}, cfg, { maxWash: Number(opts.maxWash) || 15000 }));
            } catch (err) { r = null; }
            if (!r || !r.ok) continue;
            if (!best || r.cost < best.cost) best = Object.assign({}, r, { lead: cfg.lead, delayLook: cfg.delayLook || 0 });
        }
        return best;
    }

    /**
     * 收尾脉 × 前缀 双向扫描：把每条目标轮流钉成收尾脉，各跑一遍前缀档位，
     * 取「目标齐全且最省」的那条。**确定性计算**（不搜索），几十~几百毫秒。
     */
    function tailExchangeBest(raw, targets, opts) {
        opts = opts || {};
        const TG = (targets || []).map(Number);
        if (TG.length < 2 || TG.length > 4) return [];
        const prefixes = Array.isArray(opts.prefixes) && opts.prefixes.length
            ? opts.prefixes
            : [0, 100, 200, 300, 400, 500, 600, 700, 800, 864, 900, 1000, 1200];
        const budget = Number(opts.budget) || 0;
        const only = Array.isArray(opts.tails) && opts.tails.length ? opts.tails.map(Number) : TG;
        const out = [];
        for (const tailId of only) {
            if (!TG.includes(Number(tailId))) continue;
            let best = null;
            for (const px of prefixes) {
                let r = null;
                try { r = greedyHybridPlan(raw, TG, { budget, prefix: px, tailId: Number(tailId) }); }
                catch (err) { continue; }
                if (!r || !r.ok) continue;
                if (!best || r.cost < best.cost) best = r;
            }
            if (best) out.push(best);
        }
        out.sort((a, b) => a.cost - b.cost || a.exchanges - b.exchanges);
        return out;
    }

    /**
     * 无锁前缀档位扫描：对每个前缀长度跑一遍「纯天然顺锁」，取目标齐全且最省的那条。
     *
     * 为什么要扫：前缀长度决定天赋流被推到哪，直接决定后面目标是否聚拢。
     * 薛龙城参考方案就是前缀 864 洗把目标聚到 191/29/92 洗内出现（7687 丹）；
     * 而前缀 0 的朴素顺锁要 11765 丹。这段是**确定性计算**（只洗不算搜索），几十毫秒就能扫完。
     */
    function greedyNaturalBest(raw, targets, opts) {
        opts = opts || {};
        const prefixes = Array.isArray(opts.prefixes) && opts.prefixes.length
            ? opts.prefixes
            : [0, 100, 200, 300, 400, 500, 600, 700, 800, 864, 900, 1000, 1200];
        let best = null;
        for (const px of prefixes) {
            let r = null;
            try { r = greedyNaturalPlan(raw, targets, { budget: opts.budget, prefix: px }); } catch (err) { continue; }
            if (!r || !r.ok) continue;
            if (!best || r.cost < best.cost) best = r;
        }
        return best;
    }

    /**
     * 判断「紫序第 index 条紫」这个位置**换得动吗**（能不能当置换位）。
     *
     * 引擎要求：被换的紫前面必须有一条**同类型低阶脉**且已锁定。
     * 光查 allIds 里「存在这个类型的低阶脉」是不够的 —— 那条低阶脉必须
     * **在紫序里出现在这条紫之前**。实测薛龙城（前缀 864 后）紫序第 2 条是
     * 术绍岐黄(type265)，全表里虽有精通医理(type265)，但洗到它之前根本没出现过，
     * 于是这个锚点永远换不动 → 搜索所有分支被拒 → expanded=2 提前退出。
     *
     * 这里用「实际洗一遍」来判定：从起始态无锁推进，看同类型低阶脉是否先于该紫出现。
     */
    function slotExchangeable(raw, purples, index, zi) {
        const arr = purples || [];
        const slot = arr[index];
        if (!slot) return false;
        let e;
        try { e = engine(raw, zi || raw.zizhi); } catch (err) { return false; }
        const id = Number(slot.id);
        if (e.isShenmai(id)) return true;              // 神脉走互冲，不需要同类低阶
        if (id === 251) return false;                  // 一心两用没有低阶冲突
        const lows = e.allIds.filter(x => e.allowed.has(x) && e.quality(x) < 4
            && e.talentType(x) === e.talentType(id));
        if (!lows.length) return false;                // 这个类型根本没有低阶脉
        // 实际推进：统计紫色序号，检查低阶脉是否先到
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi || raw.zizhi }));
        let purpleSeen = 0, w = 0;
        while (w < 12000) {
            const r = e.wash(s, []);
            s = r.state; w++;
            for (const ev of r.generatedEvents) {
                if (e.quality(ev.id) !== 4) {
                    if (lows.includes(Number(ev.id))) return true;   // 低阶脉先到 → 换得动
                    continue;
                }
                purpleSeen++;
                if (purpleSeen > index) return false;                 // 已经越过该紫还没见到低阶脉
            }
        }
        return false;
    }

    /**
     * 无锁前缀洗：在**锁定任何脉之前**先空洗 count 次。
     *
     * 这是最便宜地推进天赋流的手段 —— 3 槽 0 锁时每洗只要 `eat`（=3 丹），
     * 而锁住 1 条就要 `eat+1`、锁 2 条要 `eat+3`。实战方案（薛龙城 7687 丹）正是
     * 先无锁洗 864 次把流推到合适位置，开 4 槽后目标就在 191/29/92 洗内密集出现；
     * 而「先锁再长洗」的同目标路线要 11765 丹 —— 差 4000 丹。
     *
     * 返回 { raw, cost, washes }：raw 是洗完后的可继续规划状态。
     */
    function washPrefix(raw, count, zi) {
        const z = Number(zi) || Number(raw.zizhi) || 153;
        const n = Math.max(0, Math.floor(Number(count) || 0));
        const e = engine(raw, z);
        let s = e.initialState(Object.assign({}, raw, { zizhi: z }));
        let cost = 0;
        for (let i = 0; i < n; i++) {
            const r = e.wash(s, []);
            s = r.state;
            cost += Number(r.cost) || 0;
        }
        const inited = s.luckSeed != null;
        return {
            raw: Object.assign({}, raw, {
                zizhi: z,
                seed: s.bornSeed,
                born_talent_rc: s.bornRC,
                luck_seed_inited: inited,
                luck_seed: inited ? Number(s.luckSeed) : 0,
                tal_lucky: s.talLucky,
                talents: s.talents.map(id => ({ id, locked: false })),
            }),
            cost,
            washes: n,
        };
    }

    /**
     * 估算「锁着洗到某个 RC」需要多少次 —— 成本换算修正。
     *
     * 每洗推进的 RC 数 = **槽数 − 已锁条数**（锁住的槽不会重抽），
     * 所以锁着洗比无锁洗慢：3 槽锁 1 条时每洗只推 3，不是 4。
     * 拿无锁扫描出的 `wash` 次数直接当锁着洗的次数会**低估**（实测薛龙城
     * 估 953 洗、实际 1453 洗）。这里按锁数做换算。
     */
    function estimateLockedWashes(raw, targetRC, lockedCount, zi) {
        const z = Number(zi) || Number(raw.zizhi) || 153;
        let slots = 3;
        try { slots = Math.max(1, Number(engine(raw, z).slotCount) || 3); } catch (err) { /* 默认 */ }
        const perWash = Math.max(1, slots - Math.max(0, Number(lockedCount) || 0));
        const from = Number(raw && raw.born_talent_rc) || 0;
        const span = Math.max(0, Number(targetRC) - from);
        return Math.ceil(span / perWash);
    }

    /**
     * 估算「收尾段」的丹耗 —— 尾紫回推预留。
     *
     * 4 紫里最后一紫通常靠**天然洗出**（或末位神脉互冲），它前面的 3 条目标都已锁住，
     * 所以这段的每洗单价是固定的 `eat + 2·(N−1) − 1`；丹耗 ≈ 尾段条数 × 单价。
     * 把这段先算出来、从总上限里减掉，剩下的预算再拿去搜前 N−1 条，
     * 搜索空间小一截、剪枝更狠 —— 这正是「尾紫回推预留」的意义。
     *
     * ⚠ 2026-10 修正（使用者指出）：旧实现用「最后两个锚点的**紫序号差**」当条数，
     *   单位就是错的 —— 步惊云 #4→#6 序号差 2，算出 16 丹，实际这一段要 1,770 丹。
     *   正确做法：
     *     尾段洗数 = (最后一紫的洗数 − 上一条紫的洗数) × 扫描槽数 ÷ 收尾段每洗条数
     *     收尾段每洗条数 = 4 − (N−1) = 1（4 槽锁 3 条时每洗只推进 1 条）
     *     每洗丹耗 = eat(4槽) + 2·(N−1) − 1 = 10
     *   实测：柳如意 尾段 16 洗 ×3 条 = 48 条 → 48 洗 × 10 = **480 丹**；
     *         步惊云 尾段 59 洗 ×3 条 = 177 条 → 177 洗 × 10 = **1,770 丹**。
     *   若这段里能塞进**隐藏保底紫**（锁 prev + 锁 from 垫洗），尾段就缩成
     *   「洗到保底」的那几洗：步惊云实测 9 条 → **90 丹**，所以隐藏保底紫也要能当锚点。
     */
    function estimateTailCost(raw, anchors, targetCount, opts) {
        opts = opts || {};
        if(!anchors||(!opts.tail&&anchors.length<2))return 0;
        const N=Number(targetCount)||anchors.length;
        const tailSlots=4;                              // 收尾段一律按 4 槽算
        const locked=Math.max(1,N-1);                   // 收尾时已锁 N−1 条
        const barsPerWash=Math.max(1,tailSlots-locked); // 每洗推进几条（4 槽 3 锁 = 1）
        let eat=5;
        try {
            if(typeof ZZ_DATA!=='undefined'&&ZZ_DATA&&ZZ_DATA['154']&&Number(ZZ_DATA['154'].eat_xisui)>0)
                eat=Number(ZZ_DATA['154'].eat_xisui);
        } catch(err){ /* 默认 5 */ }
        const unit=eat+2*locked-1;                      // 每洗丹耗（4 槽 3 锁 = 10）
        // ⚠ 锚点数组是按「目标顺序」排的（autoAnchors / naturalFirstAnchors 都这样），
        //   直接取最后两个元素会拿错——naturalFirst 里末两个可能是 #3 和 #20。
        //   收尾段必须按**洗数**取最靠后的两条。
        const sorted=anchors.slice().sort((x,y)=>(Number(x&&x.wash)||0)-(Number(y&&y.wash)||0));
        // 统一构造器会分别试多条收尾脉；此时必须计算**当前这条收尾脉**的预留，
        // 不能拿锚点列表里另选的一条（步惊云金仙 1460，神力因隐藏保底紫才是 90）。
        const a=opts.tail || sorted[sorted.length-1];
        const before=sorted.filter(x=>x!==a&&(Number(x&&x.wash)||0)<(Number(a&&a.wash)||0));
        const b=before[before.length-1] || sorted[sorted.length-2];
        const washA=Number(a&&a.wash);
        if(!Number.isFinite(washA))return 0;
        // ⚠ 起算点（使用者规则 2026-10）：
        //   · 默认 **从上一条紫起算** —— 因为你不能保证那条紫会成为锚点（它可能只是路过的紫）；
        //   · 只有在「按具体路线逐条计算」时（opts.mode==='route'），才可以用上一条锚点，
        //     因为那时锚点已经是这条分支里确定的位置。
        let washB=NaN;
        if(opts.mode==='route'){
            washB=Number(b&&b.wash);
        }else{
            const purples=opts.purples;
            const no=Number(a&&a.no);
            if(purples&&no>=2&&purples[no-2])washB=Number(purples[no-2].wash);   // 紫序里紧挨着的前一条
            if(!Number.isFinite(washB))washB=Number(b&&b.wash);                   // 回退：上一条锚点
        }
        if(!Number.isFinite(washB))return 0;
        const scanSlots=Math.max(1,Number(opts.scanSlots)||3);   // 紫序是按几槽扫出来的
        const washDelta=Math.max(0,washA-washB);
        if(washDelta<=0)return 0;
        const bars=washDelta*scanSlots;                 // 尾段条数
        let tailWashes=bars/barsPerWash;
        // 隐藏保底紫塞得进这段间隙时，尾段缩成「垫洗到保底」的那几洗
        let hiddenBars=Number(opts.hiddenBars);
        if(!Number.isFinite(hiddenBars)||hiddenBars<=0){
            // 也支持直接给「保底落点洗数」：取落在这段间隙里的最早一个
            const hw=(Array.isArray(opts.hiddenPityWashes)?opts.hiddenPityWashes:[])
                .map(Number).filter(x=>Number.isFinite(x)&&x>washB&&x<washA).sort((x,y)=>x-y)[0];
            if(hw!=null)hiddenBars=(hw-washB)*scanSlots;
        }
        if(Number.isFinite(hiddenBars)&&hiddenBars>0) tailWashes=Math.min(tailWashes,hiddenBars/barsPerWash);
        return Math.round(tailWashes*unit);
    }

    /**
     * 「天然目标优先」的锚点挑法（与 autoAnchors / tailFirstAnchors 并列的第三条策略）。
     *
     * 思路来自实战方案：**大部分目标其实是天然洗出来的**，只有洗得太深的才值得用置换拿。
     *   实测聂风四目标：转世金仙(紫序#6)、岿然顶天(#10)、九阴鬼脉(#13) 全是天然出现，
     *   只有天人合一(#35，第 5084 洗) 太深 —— 那条用一次置换更省。
     *   原 autoAnchors 按「类型能对上」挑位置，会把锚点选到 #3/#4/#6/#7，
     *   完全没覆盖 #10/#13，于是这种方案根本表达不出来。
     *
     * 规则：
     *   ① 每个目标只要在紫序里出现，就直接用它自己出现的位置当锚点（天然获得，不置换）；
     *   ② 剩下来在紫序里找不到的目标，才在未占用的位置里挑一个拿来做置换位；
     *   ③ 位置不重复；置换位排除保底紫与一心两用（不能置换）。
     */
    function naturalFirstAnchors(raw, purples, targetIds, opts) {
        const wanted=(targetIds||[]).map(Number);
        const N=wanted.length;
        if(N<2||N>4)return null;
        if(!purples||purples.length<N)return null;
        // ④ 天然目标也要看**代价**：等一条天然紫出来的丹耗 ≈ 它的洗脉次数 × 每洗单价。
        //    四紫里最后一条必然是原始紫（收尾），所以「第3锚点→第4锚点」那段丹耗是可以先算出来的；
        //    同理，任何一条天然目标的丹耗都能估。估算超过预算允许份额的，就不该干等它，
        //    直接当置换目标、留一个置换位。
        //    实测柳如意：转世金仙首次在 #9（RC 7040）、术绍岐黄 #20（RC 14364）、
        //    混元奇脉 #22（RC 14642）—— 三紫全「等天然」早已超过 10000 丹预算。
        let eatPerWash=3;
        try { const e=engine(raw,raw.zizhi); eatPerWash=Math.max(1,Number(e.eat)||3); } catch(err){ /* 用默认 */ }
        const budget=Number(opts&&opts.budget)||0;
        // 天然目标最多允许吃掉预算的这个比例（其余留给开槽、锁脉、置换）
        const naturalShare=Number(opts&&opts.naturalShare)||0.5;
        const maxNaturalWash=budget>0 ? Math.floor(budget*naturalShare/eatPerWash) : Infinity;
        const cheapEnough=(a)=>!isFinite(maxNaturalWash)||Number(a.wash||0)<=maxNaturalWash;
        const used=new Set();
        const picks=new Array(N).fill(-1);
        // ① 天然目标优先（且必须「等得起」）
        for(let t=0;t<N;t++){
            const idx=purples.findIndex((a,i)=>a&&!used.has(i)&&Number(a.id)===wanted[t]&&cheapEnough(a));
            if(idx>=0){ used.add(idx); picks[t]=idx; }
        }
        const naturalCount=picks.filter(i=>i>=0).length;
        // ② 剩下找不到/等不起的目标 → 挑未占用位置做置换位。
        // ⚠ 必须排在「可当置换起点的紫」之后：
        //   引擎要求 起点.bornRC <= 首个锚点.bornRC，且起点不能是神脉/保底紫。
        //   若把置换位放在最前面（例如聂风的 #1 混元奇脉是神脉），
        //   usableSources 就一个都剩不下，搜索直接开不了。
        let e=null;
        try { e=engine(raw,raw.zizhi); } catch(err){ e=null; }
        const canBeSource=(a)=>{
            const id=Number(a&&a.id);
            if(!a||a.fromPity||!e||e.isShenmai(id))return false;
            if(Number(id)===251)return false;
            return e.allIds.some(x=>e.allowed.has(x)&&e.quality(x)<4&&e.talentType(x)===e.talentType(id));
        };
        let startAt=0;
        if(e){
            const srcIdx=purples.findIndex(canBeSource);
            if(srcIdx>=0) startAt=srcIdx+1;            // 置换位必须在起点之后
        }
        for(let t=0;t<N;t++){
            if(picks[t]>=0)continue;
            // 置换位可以落在保底紫上（使用者规则：保底紫也能当锚点去置换）
            const idx=purples.findIndex((a,i)=>i>=startAt&&a&&!used.has(i)
                &&Number(a.id)!==251&&!wanted.includes(Number(a.id))
                &&slotExchangeable(raw,purples,i,raw.zizhi));
            if(idx<0)return null;
            used.add(idx); picks[t]=idx;
        }
        if(picks.some(i=>i<0))return null;
        return {
            anchors:picks.map(i=>purples[i]),
            natural:picks.map((i,t)=>Number(purples[i].id)===wanted[t]),
            naturalCount,
            maxNaturalWash,
            eatPerWash,
        };
    }

    /**
     * 「收尾脉优先」的锚点挑法（与 autoAnchors 并行的一条策略，结果作为备选方案）。
     *
     * 判据（使用者给的规则）：
     *   · 目标数 N 时，**收尾脉**在原始紫序中的位置 i 需满足 `i >= N-1` —— 即它前面
     *     至少还有 N-1 条紫，给其余的 N-1 个目标留出置换位；
     *   · 收尾脉本身必须是**目标脉**（或目标之一的神脉），因为它天然留着、不参与置换；
     *   · 前面那 N-1 条里挑最早可用的当其余目标的锚点 —— **保底紫也可以**（使用者规则：
     *     收尾脉前面的脉、包括保底紫，都能当锚点去置换；search() 支持并校验 pityNo）。
     *
     * 为什么不直接换掉旧策略：旧策略在本工程里已有大量验证过的路线
     * （萧佩吟 4 目标 3159、于小雪 3 目标 3601），换掉风险太大。
     * 所以把它做成**并列备选**，由调用方两条都跑、按丹耗取省。
     */
    function tailFirstAnchors(raw, purples, targetIds) {
        const wanted=(targetIds||[]).map(Number);
        const N=wanted.length;
        if(N<2||N>4)return null;
        if(!purples||purples.length<N)return null;
        let e;
        try { e=engine(raw,raw.zizhi); } catch(err){ return null; }
        const needed=new Set(wanted);
        for(let i=N-1;i<purples.length;i++){
            const tail=purples[i];
            // 收尾脉必须是目标脉本身（天然保留，不再置换）
            if(!tail||!needed.has(Number(tail.id)))continue;
            if(Number(tail.id)===251)continue;               // 一心两用不能当收尾
            const picks=[];
            for(let j=0;j<i&&picks.length<N-1;j++){
                const a=purples[j];
                // 保底紫也收：使用者规则「收尾脉前面的脉，包括保底紫，都可以当锚点」
                if(!a||Number(a.id)===251)continue;
                picks.push(j);
            }
            if(picks.length!==N-1)continue;
            const idxs=[...picks,i];
            return {
                anchors:idxs.map(k=>purples[k]),
                tailIndex:i, tailId:Number(tail.id),
                reason:'',
            };
        }
        return null;
    }

    /**
     * 收尾脉扫描 · 候选枚举（纯计算，不跑搜索）。
     *
     * 使用者的纠正（上一轮交接）：**收尾脉一旦定死，其余 N−1 条就只是「普通目标」**，
     * 不再有「谁当收尾」的自由度 —— 所以收尾脉是一个**可枚举的决策变量**，
     * 应当由近到远逐条去试，而不是让贪心边走边定。
     *
     * 每条候选给出：
     *   · tailIndex / id / no —— 收尾脉在原始紫序里的位置（必须**本身就是目标**，
     *     天然留着、不参与置换；一心两用没有低阶冲突，不能当收尾）；
     *   · anchorIdx —— 它前面**最早的 N−1 个可用位置**（非保底、非一心两用）；
     *   · targets —— 锚点与目标的配对（收尾脉钉死自己的目标，其余同类型优先）；
     *   · floorCost —— 到这条收尾脉的**下界**（无锁全速洗到它 × 每洗单价 eat），
     *     提前终止只看它；
     *   · estimateCost —— 「一路锁着洗到收尾脉」的**估算**（分段累加，逐档实测推进速度），
     *     只用来排序/展示，**不能**当剪枝依据。
     *
     * 为什么下界和估算要分开：提前终止必须**可靠**。估算按「锚点之间一直锁着」算，
     * 是上界性质；置换能把前面几条免费拿到、让每洗保持 0 锁，实际路线可能远低于它 ——
     * 拿估算去 break 会把本来能成的收尾脉误判掉（上一轮反复踩的就是这类坑）。
     */
    // 实测「锁 k 条时每洗推进多少 RC」—— 引擎的 RC 步进不是「槽数−锁数」
    // （实测 3 槽 0 锁 ≈ 4.8、锁 1 ≈ 3.2、锁 2 ≈ 1.6），套公式会算歪，所以直接量。
    const advanceCache = new Map();
    function measureAdvance(raw, zi, lockedCount) {
        const key = `${zi}|${lockedCount}|${raw.seed}|${raw.born_talent_rc}`;
        if (advanceCache.has(key)) return advanceCache.get(key);
        let value = 0;
        try {
            const e = engine(raw, zi);
            let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
            for (let i = 0; i < 40; i++) s = e.wash(s, []).state;      // 热身：先攒出低阶脉
            const keep = [];
            for (let i = 0; i < s.talents.length && keep.length < lockedCount; i++) {
                if (e.quality(s.talents[i]) < 4) keep.push(i);
            }
            if (keep.length === lockedCount) {
                const before = s.bornRC;
                for (let i = 0; i < 40; i++) s = e.wash(s, keep).state;
                value = (s.bornRC - before) / 40;
            }
        } catch (err) { value = 0; }
        advanceCache.set(key, value);
        return value;
    }

    function tailEstimate(raw, purples, anchorIdx, tailIndex, e) {
        const zi = Math.max(153, Number(raw.zizhi) || 153);
        const startRC = Number(raw.born_talent_rc) || 0;
        const points = anchorIdx.map(k => Number(purples[k].bornRC)).concat([Number(purples[tailIndex].bornRC)]);
        let cost = 0, washes = 0, prevRC = startRC, ziNow = zi, locked = 0;
        for (let seg = 0; seg < points.length; seg++) {
            // 3 槽最多锁 2 条还能洗；要锁着 3 条继续推进必须先开第 4 槽
            if (locked >= 3 && ziNow === 153) ziNow = 154;
            const adv = measureAdvance(raw, ziNow, locked);
            const span = Math.max(0, Number(points[seg]) - prevRC);
            const segWashes = adv > 0 ? span / adv : 0;
            let eat = 3;
            try { eat = Math.max(1, Number(engine(raw, ziNow).eat) || 3); } catch (err) { /* 默认 */ }
            const unit = locked ? eat + 2 * locked - 1 : eat;
            washes += segWashes;
            cost += segWashes * unit;
            prevRC = points[seg];
            locked++;
        }
        return { cost: Math.round(cost), washes: Math.round(washes), slots: ziNow };
    }


    /**
     * 锚点 ↔ 目标配对：收尾脉钉死自己的目标，前面 N−1 个锚点分剩下的。
     * 优先「同类型」（锚点位上原本就是这种类型的紫，置换落点最自然），
     * 凑不上就退化为按目标优先顺序分配。
     */
    function assignTailTargets(e, purples, anchorIdx, targets, tailId) {
        const rest = (targets || []).map(Number).filter(id => id !== Number(tailId));
        const out = [];
        for (let pos = 0; pos < anchorIdx.length; pos++) {
            const a = purples[anchorIdx[pos]];
            let pick = rest.findIndex(id => { try { return e.talentType(id) === e.talentType(a.id); } catch (err) { return false; } });
            if (pick < 0) pick = 0;
            out.push(rest.splice(pick, 1)[0]);
        }
        return out.concat([Number(tailId)]);
    }

    function tailScanCandidates(raw, targets, opts) {
        opts = opts || {};
        const TG = (targets || []).map(Number);
        const N = TG.length;
        if (N < 2 || N > 4) return { candidates: [], purples: [], reason: '收尾脉扫描需要 2~4 个目标。' };
        const zi = Math.max(153, Number(raw.zizhi) || 153);
        const counted = Object.assign({}, raw, { zizhi: zi });
        const purples = (opts.purples && opts.purples.length)
            ? opts.purples.slice()
            : scan(counted, Math.max(N + 2, Number(opts.count) || 24));
        let e;
        try { e = engine(raw, zi); } catch (err) { return { candidates: [], purples, reason: err.message }; }
        const budget = Math.max(0, Number(opts.budget) || 0);
        const maxTails = Math.max(1, Number(opts.maxTails) || 8);
        const eat = Math.max(1, Number(e.eat) || 3);
        // 第一个锚点之前**必须**留得出一条可当置换起点的自然紫
        // （起点不能是保底紫、不能是神脉，且要有同类型低阶脉当冲突）。
        // 实测步惊云：紫序 #1 是保底玄阳、#2 是玄阳神脉 —— 锚点从 #2 起就一个起点都剩不下，
        // 搜索连开都开不了（tried=0）。所以锚点要排在 firstSource 之后。
        const canSource = a => !!a && !a.fromPity && !e.isShenmai(a.id) && e.allIds.some(id =>
            e.allowed.has(id) && e.quality(id) < 4 && e.talentType(id) === e.talentType(a.id));
        let firstSource = -1;
        for (let j = 0; j < purples.length; j++) if (canSource(purples[j])) { firstSource = j; break; }
        const candidates = [];
        let stop = '';
        if (firstSource < 0) return { candidates, purples, reason: '紫序里没有可作置换起点的自然紫（全是保底/神脉）。' };
        for (let i = N - 1; i < purples.length; i++) {
            const tail = purples[i];
            if (!tail || !TG.includes(Number(tail.id)) || Number(tail.id) === 251) continue;
            const idxs = [];
            for (let j = firstSource + 1; j < i && idxs.length < N - 1; j++) {
                const a = purples[j];
                // 保底紫也能当锚点（使用者规则）；起点仍必须是自然紫（见 firstSource）
                if (!a || Number(a.id) === 251) continue;
                idxs.push(j);
            }
            if (idxs.length !== N - 1) continue;
            const assign = assignTailTargets(e, purples, idxs, TG, Number(tail.id));
            const floorCost = Math.round(Number(tail.wash || 0) * eat);
            const est = tailEstimate(counted, purples, idxs, i, e);
            const entry = {
                no: Number(tail.no), id: Number(tail.id), tailIndex: i,
                anchorIdx: idxs, anchors: idxs.map(k => purples[k]).concat([tail]),
                targets: assign,
                floorCost, tailWash: Number(tail.wash) || 0, tailRC: Number(tail.bornRC) || 0,
                estimateCost: est.cost, estimateWashes: est.washes, slots: est.slots,
            };
            // 由近到远：**下界**一旦超预算，后面只会更贵（洗得更深），提前终止是安全的。
            // 但至少留一条：界面要能显示「这条组合到底要多少丹」，而不是只说「超预算」。
            if (budget > 0 && floorCost > budget) {
                if (!candidates.length) { entry.overBudget = true; candidates.push(entry); }
                stop = `收尾脉 #${tail.no} 光洗到它就要 ≥${floorCost} 丹，已超预算 ${budget} 丹，提前终止`;
                break;
            }
            candidates.push(entry);
            if (candidates.length >= maxTails) { stop = `已取满 ${maxTails} 条收尾脉`; break; }
        }
        return {
            candidates, purples, stop,
            reason: candidates.length ? '' : '紫序里没有「本身是目标、前面又留得出 N−1 个置换位」的收尾脉。',
        };
    }

    /**
     * 收尾脉扫描 · 主循环（交接文档第七节）。
     *
     *   for 每条候选收尾脉 T（由近到远）:
     *       if (到 T 的下界丹耗 > 预算) break;
     *       route = buildWithExchanges(T)
     *       if (route && route.ok && route.cost <= 预算) 收下
     *
     * 为什么这条思路可能成：置换**不耗丹、0 洗**。只要能把「岿然顶天」「混元奇脉」这类
     * 深位目标在前期用置换拿到，收尾脉就能落到更近的位置，总成本从 7 万掉到 1 万以内。
     * 参考方案的 6,893 / 7,687 / 9,482 全是这么来的。
     *
     * buildWithExchanges 有两套实现：
     *   ① **确定性执行器**（默认，快）：greedyHybridPlan({tailId}) —— 目标轮流钉成收尾脉，
     *      其余的靠「定向置换链」免费拿，收尾脉只等天然。每条几十毫秒，可以全枚举 + 前缀档位。
     *   ② **状态搜索**（opts.searchNodes > 0 才开）：用搜索验证同一条收尾脉还能不能更省。
     *      它慢得多（每次几千节点要几十秒），所以只在①全都不行时才值得开。
     */
    function tailScanPlan(raw, targets, opts) {
        opts = opts || {};
        const prep = tailScanCandidates(raw, targets, opts);
        const out = {
            candidates: prep.candidates, purples: prep.purples, stop: prep.stop || '',
            tried: [], plans: [], routes: [], route: null, kind: null, reason: prep.reason || '',
            timedOut: false, exhaustive: !!opts.exhaustive,
        };
        if (!prep.candidates.length) return out;
        const budget = Math.max(1, Number(opts.budget) || 50000);
        const deadline = Date.now() + Math.max(1000, Number(opts.timeMs) || 90000);
        const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => { };
        const prefixes = Array.isArray(opts.prefixes) && opts.prefixes.length
            ? opts.prefixes : [0, 100, 200, 300, 400, 500, 600, 700, 800, 864, 900, 1000, 1200];
        // —— ① 确定性执行器：每条收尾脉 × 前缀档位 ——
        for (const cand of prep.candidates) {
            if (Date.now() > deadline) { out.timedOut = true; break; }
            const attempt = {
                no: cand.no, id: cand.id, floorCost: cand.floorCost, estimateCost: cand.estimateCost,
                ok: false, cost: null, washes: null, exchanges: null, prefix: null, ms: 0,
            };
            const t0 = Date.now();
            let best = null;
            for (const px of prefixes) {
                let r = null;
                // 这里**不用 budget 剪枝**：先让每条收尾脉把完整方案算出来（ok），
                // 再按预算比价。带预算剪枝会把「超预算但更省」的方案直接变成 ok=false，
                // 使用者就只看到「没方案」，看不到「其实要花多少丹」。
                try { r = greedyHybridPlan(raw, targets, { budget: 0, prefix: px, tailId: cand.id }); }
                catch (err) { r = null; }
                if (!r || !r.ok) continue;
                if (!best || r.cost < best.cost) best = r;
            }
            attempt.ms = Date.now() - t0;
            if (best) {
                attempt.ok = true; attempt.cost = best.cost; attempt.washes = best.washes;
                attempt.exchanges = best.exchanges; attempt.prefix = best.prefix;
                out.plans.push(Object.assign({}, best, {
                    tailNo: cand.no, tailId: cand.id, tailFloorCost: cand.floorCost,
                    tailEstimateCost: cand.estimateCost,
                }));
            }
            out.tried.push(attempt);
            progress({ tailNo: cand.no, tailId: cand.id, attempt, found: out.plans.length, stage: 'plan' });
            if (best && best.cost <= budget && !out.exhaustive) break;   // 由近到远：第一条能进预算的就收
        }
        out.plans.sort((a, b) => a.cost - b.cost || a.exchanges - b.exchanges || a.washes - b.washes);
        // 预算内的确定性方案优先；都超预算就把最省的一条标出来（让使用者看到差距）
        const inBudget = budget > 0 ? out.plans.filter(p => p.cost <= budget) : out.plans;
        if (inBudget.length) { out.route = inBudget[0]; out.kind = 'plan'; }
        else if (out.plans.length) { out.route = out.plans[0]; out.kind = 'plan'; }
        // —— ② 状态搜索（可选，慢）：确定性执行器没进预算时才开 ——
        const nodesPerTail = Math.max(0, Number(opts.searchNodes) || 0);
        if (nodesPerTail > 0 && Date.now() < deadline && (!out.route || out.route.cost > budget)) {
            const padLimit = Math.max(1, Number(opts.padLimit) || 8);
            const maxSources = Math.max(1, Number(opts.maxSources) || 1);
            for (const cand of prep.candidates) {
                if (Date.now() > deadline) { out.timedOut = true; break; }
                const attempt = { no: cand.no, id: cand.id, tried: 0, nodes: 0, bounded: 0, filtered: 0, sources: 0, found: 0, error: '' };
                let sources = [];
                try { sources = usableSources(raw, cand.anchors, prep.purples) || []; }
                catch (err) { attempt.error = err.message; sources = []; }
                attempt.sources = sources.length;
                for (const source of sources.slice(0, maxSources)) {
                    for (let pad = 0; pad < padLimit; pad++) {
                        if (Date.now() > deadline) { out.timedOut = true; break; }
                        let res = null;
                        try {
                            res = search(raw, cand.anchors, source, pad, {
                                targets: cand.targets, depth: 20, maxNodes: nodesPerTail,
                                sequenceBasis: 'theory2', maxCost: budget,
                            }, () => { });
                        } catch (err) { attempt.error = err.message; continue; }
                        attempt.tried++;
                        attempt.nodes += Number(res.expanded) || 0;
                        if (res.bounded) attempt.bounded++;
                        if (res.filtered) attempt.filtered++;
                        if (res.routes && res.routes.length) {
                            attempt.found += res.routes.length;
                            for (const r of res.routes) {
                                out.routes.push(Object.assign({}, r, {
                                    tailNo: cand.no, tailId: cand.id, tailFloorCost: cand.floorCost,
                                }));
                            }
                        }
                        if (attempt.found) break;
                    }
                    if (attempt.found) break;
                }
                out.tried.push(Object.assign({ stage: 'search' }, attempt));
                progress({ tailNo: cand.no, tailId: cand.id, attempt, found: out.routes.length, stage: 'search' });
                if (out.timedOut) break;
                if (attempt.found) break;
            }
            out.routes.sort((a, b) => a.cost - b.cost || a.exchanges - b.exchanges || a.washes - b.washes);
            out.routes.splice(3);
            const sr = out.routes[0];
            if (sr && (!out.route || sr.cost < out.route.cost)) { out.route = sr; out.kind = 'search'; }
        }
        if (!out.route && !out.reason) {
            out.reason = out.timedOut
                ? `试了 ${out.tried.length} 条收尾脉到点中断，没有成功。`
                : `试了 ${out.tried.length} 条收尾脉，都没有跑出完整路线` +
                (out.tried.some(t => t.bounded) ? '（搜索时多数 bounded=true，是节点预算不够）' : '') + '。';
        }
        return out;
    }

    // 沿已验证的置换链先做一次有限的直接推演，避免简单的连续置换
    // 被大量“刷另一条冲突”的分支挤掉。没有完成就仍交给原搜索。
    function guidedShortcut(ctx, node, guide, targets, depth, maxCost) {
        let n=node;
        const valid=x=>!missed(ctx,x)&&x.cost<maxCost&&x.draws<=depth;
        const required=(x,changing=-1)=>{
            const e=ctx.e(x.zi),keep=x.o.map((v,i)=>v>=0?i:-1).filter(i=>i>=0);
            for(const pos of keep.slice())if((pos===changing||!targets.includes(x.s.talents[pos]))&&!e.isShenmai(x.s.talents[pos])) {
                const conflict=x.s.talents.findIndex((id,i)=>i<pos&&e.quality(id)<4&&e.talentType(id)===e.talentType(x.s.talents[pos]));
                if(conflict<0)return null;if(!keep.includes(conflict))keep.push(conflict);
            }
            return keep.sort((a,b)=>a-b).map(i=>x.s.talents[i]);
        };
        const segment=(base,end,ids,count,why)=>count?record(base,{...end},{type:'wash',keepIds:ids,count,why}):base;
        for(let action=n.exchanges;action<guide.length;action++) {
            const next=guide[action],e=ctx.e(n.zi);
            let pos=n.o.findIndex((v,i)=>v===next.origin&&n.s.talents[i]===next.from);
            if(pos<0) {
                if(next.origin<0||n.o.includes(next.origin))return null;
                const ids=required(n);if(!ids||ids.length>=e.slotCount)return null;
                const before=n,candidates=[];let scan=n;
                const needs=id=>e.quality(id)<4&&e.talentType(id)===e.talentType(next.from);
                const remember=(x,count)=>{
                    for(const id of x.s.talents)if(needs(id))candidates.push({node:x,id,count});
                };
                remember(scan,0);
                for(let w=1;w<=12000;w++) {
                    scan=washOne(ctx,scan,ids.map(id=>scan.s.talents.indexOf(id)));
                    if(!valid(scan))break;
                    if(scan.o.includes(next.origin)||scan.pityCount!==before.pityCount)break;
                    remember(scan,w);
                }
                // 神脉无需普通前置冲突，直接捕获；普通紫比较最近的准备事件。
                if(e.isShenmai(next.from)) {
                    let x=before,w=0;
                    while(!x.o.includes(next.origin)&&w<12000&&valid(x)) {
                        x=washOne(ctx,x,ids.map(id=>x.s.talents.indexOf(id)));w++;
                    }
                    if(!valid(x)||!x.o.includes(next.origin))return null;
                    n=segment(before,x,ids,w,'同序列少锁捕获神脉锚点');
                } else {
                    let cheapest=null;
                    for(const c of candidates.slice(-8).reverse()) {
                        const ready=segment(before,c.node,ids,c.count,'同序列晚锁，准备后续紫前冲突');
                        const locks=[...ids.filter(id=>id!==c.id),c.id];
                        if(locks.length>=e.slotCount)continue;
                        let x=ready,w=0;
                        while(!x.o.includes(next.origin)&&w<12000&&valid(x)) {
                            x=washOne(ctx,x,locks.map(id=>x.s.talents.indexOf(id)));w++;
                        }
                        const at=x.o.indexOf(next.origin);
                        if(!valid(x)||at<0||x.s.talents[at]!==next.from||
                            !e.replaceablePositions(x.s,locks).includes(at))continue;
                        if(!cheapest||x.cost<cheapest.cost)
                            cheapest=segment(ready,x,locks,w,'同序列锁好前置冲突，捕获紫脉锚点');
                    }
                    if(!cheapest)return null;n=cheapest;
                }
                pos=n.o.indexOf(next.origin);
            }
            if(n.s.talents[pos]!==next.from)return null;
            // 新紫追加到末尾。若它还要继续换，先备好它的冲突再按下置换。
            if(!targets.includes(next.to)&&!e.isShenmai(next.to)&&
                !n.s.talents.some(id=>e.quality(id)<4&&e.talentType(id)===e.talentType(next.to))) {
                const ids=required(n,pos);if(!ids||ids.length>=e.slotCount)return null;
                const before=n;let x=n,w=0;
                while(w<12000&&valid(x)) {
                    x=washOne(ctx,x,ids.map(id=>x.s.talents.indexOf(id)));w++;
                    if(!valid(x)||x.pityCount!==before.pityCount)return null;
                    if(x.s.talents.some(id=>e.quality(id)<4&&e.talentType(id)===e.talentType(next.to)))break;
                }
                if(!x.s.talents.some(id=>e.quality(id)<4&&e.talentType(id)===e.talentType(next.to)))return null;
                n=segment(before,x,ids,w,'同序列提前准备下一紫的冲突');pos=n.o.indexOf(next.origin);
            }
            const locks=n.s.talents.filter(id=>e.quality(id)<4);
            if(!e.replaceablePositions(n.s,locks).includes(pos))return null;
            const changed=exchangeNode(ctx,n,pos,locks);
            if(changed.s.talents.at(-1)!==next.to||!valid(changed))return null;n=changed;
        }
        return complete(n,targets,ctx.anchors.length)?n:null;
    }
    function sequenceInfo(ctx, initial, depth, basisZi=null) {
        const base=initial.trace.action.before.state, sequenceZi=Number(basisZi)||initial.zi,
            pe=sequenceZi===152?engine(ctx.raw,152,{allowTwoSlot:true}):ctx.e(sequenceZi), pool=[];
        let luck=base.luckSeed==null?base.bornSeed:base.luckSeed;
        for(let i=0;i<10000&&pool.length<depth;i++) {
            let id;[id,luck]=pe.draw(luck,true);
            if(pe.allowed.has(id))pool.push(id);
        }
        return {pool,seed:base.luckSeed==null?base.bornSeed:base.luckSeed,fixedLuck:base.luckSeed!=null,
            basisZi:sequenceZi,basisSlotCount:pe.slotCount,
            b0:initial.trace.action.before.cost>0?[base.talents[base.talents.length-1]]:[]};
    }
    // 初筛只回答“这条理论紫池有没有机会进入实际搜索”，不把它当作成功证明。
    // 一心两用没有冲突脉，出现后会直接占掉一个可用槽位；因此它能否出现，
    // 取决于置换起点到第一个锚点之间还有多少个原始紫可以被消化。
    function prefilterSequence(ctx, initial, anchors, source, sequence, targets) {
        const e=ctx.e(initial.zi), targetIds=targets.map(Number);
        const anchorIds=new Set(anchors.map(a=>Number(a.id)));
        const required=targetIds.filter(id=>!anchorIds.has(id));
        const pool=Array.isArray(sequence.pool)?sequence.pool.map(Number):[];
        const possible=new Set([...anchorIds,...pool,
            ...initial.s.talents.filter((id,i)=>initial.o[i]>=0).map(Number)]);
        // ⚠ 只有**神脉**目标才必须出现在「锚点或置换紫池」里 —— 单条神脉不能被普通紫置换，
        // 所以池里没有它就真的拿不到。普通紫目标不适用这条：锚点只是个位置，目标会被**置换**上来，
        // 而置换抽的是**欧气池**，垫洗 n 次即可把它挪到想要的位置
        // （实测：于小雪 锁混元奇脉→洗 19 次 就能把 鹤骨龙筋 换成 岿然顶天，而岿然顶天并不在初始紫池里）。
        // 旧版对所有目标一刀切要求「必须出现在初始紫池」，会把这类可行路线直接滤掉。
        const missing=required.filter(id=>e.isShenmai(id)&&!possible.has(id));
        if(missing.length)return {ok:false,missing,reason:`锚点及本段置换紫池缺少神脉目标：${missing.map(id=>e.name(id)).join('、')}。`};
        // 所有目标都已由锚点保留时，不需要从紫池中寻找“第一个目标”，
        // 也就没有一心占槽的前缀约束。
        if(!required.length)return {ok:true,required,oneMind:0,maxOneMind:0,distance:0};
        const firstTarget=pool.findIndex(id=>required.includes(id));
        const prefix=firstTarget<0?pool:pool.slice(0,firstTarget);
        const oneMind=prefix.reduce((n,id)=>n+(id===251?1:0),0);
        const ordered=anchors.slice().sort((a,b)=>Number(a.bornRC)-Number(b.bornRC));
        const firstAnchor=ordered[0];
        const sourceNo=Number(source&&source.no),anchorNo=Number(firstAnchor&&firstAnchor.no);
        // scan() 给出的 no 是自然紫顺序；没有 no 的旧调用按 0 处理，
        // 仍保留目标存在性筛选，不误杀旧存档。
        const distance=Number.isFinite(sourceNo)&&Number.isFinite(anchorNo)
            ?Math.max(0,anchorNo-sourceNo):0;
        const maxOneMind=distance;
        if(oneMind>maxOneMind)return {ok:false,missing:[],oneMind,maxOneMind,distance,
            reason:`一心两用在首个目标前出现 ${oneMind} 次，起点到首个锚点仅允许 ${maxOneMind} 次。`};
        return {ok:true,required,oneMind,maxOneMind,distance};
    }
    function replay(raw, anchors, route, targets) {
        const ctx = makeContext(raw, anchors);
        let n = start(ctx);
        for (const a of route) {
            if (JSON.stringify(snapshot(n)) !== JSON.stringify(a.before)) throw new Error('回放起点不一致');
            if (a.type === 'wash') {
                for (let i=0; i<a.count; i++) {
                    const k = a.keepIds.map(id => n.s.talents.indexOf(id));
                    if (k.some(v => v<0)) throw new Error('回放锁脉不存在');
                    if (n.o.some((v,i) => v>=0 && !k.includes(i))) throw new Error('回放洗掉了锚点');
                    n = washOne(ctx,n,k);
                    if (missed(ctx,n)) throw new Error('回放错过锚点');
                }
            } else if (a.type === 'exchange') {
                // 可达性硬校验：置换前必须在**真实状态**上确认这个位置换得动。
                //   普通紫：前面有同类型低阶脉且已锁（引擎 replaceablePositions 负责）
                //   神脉　：场上 ≥2 条不同名神脉（引擎同样负责，同 id 会去重）
                // 引擎的 replaceablePositions 在「全锁 / 无冲突」时返回空，
                // 所以这一步同时把「可洗槽用尽后还想普通置换」这种游戏里点不出来的情况挡掉。
                const e0=ctx.e(n.zi);
                const pos0=e0.replaceablePositions(n.s, a.keepIds);
                if (!pos0.includes(a.position)) throw new Error('回放置换在游戏里不可达（无已锁同类型冲突脉 / 神脉不足）');
                const r=ctx.e(n.zi).replace(n.s,a.position,a.keepIds);
                if (r.removedId !== a.from || r.addedId !== a.to) throw new Error('回放置换结果不符');
                const o=n.o.slice(), v=o.splice(a.position,1)[0];o.push(v);
                n={...n,s:r.state,o,poolStarted:true,draws:n.draws+r.purpleDraws,
                    poolDraws:n.poolDraws+r.purpleDraws,exchanges:n.exchanges+1};
            } else if (a.type === 'upgrade') {
                if (n.zi !== 153 || a.toZi !== 154) throw new Error('回放开槽不符');
                n=upgradeNode(ctx,n,154);
            } else throw new Error('未知动作');
            if (a.type === 'wash' && JSON.stringify(n.pityEvents.slice(a.before.pityCount)) !== JSON.stringify(a.pityEvents))
                throw new Error('回放保底结果不一致');
            if (JSON.stringify(snapshot(n)) !== JSON.stringify(a.after)) throw new Error('回放状态或丹耗不一致');
        }
        if (!complete(n, targets, anchors.length)) throw new Error('回放没有达成目标和锚点要求');
        return { verified:true, cost:n.cost, washes:n.washes, exchanges:n.exchanges, pities:n.pityCount, final:snapshot(n) };
    }
    function complete(n, targets, count) {
        return targets.every(id => n.s.talents.includes(id)) && new Set(n.o.filter(v => v>=0)).size === count
            && n.o.every((v,i) => v<0 || targets.includes(n.s.talents[i]));
    }
    function prefixNode(ctx, steps) {
        let n=start(ctx);
        for(const a of steps) {
            const before=n;
            if(a.type==='wash') {
                for(let w=0;w<a.count;w++) n=washOne(ctx,n,a.keepIds.map(id=>n.s.talents.indexOf(id)));
            } else if(a.type==='upgrade') n=upgradeNode(ctx,n,a.toZi);
            else {
                const r=ctx.e(n.zi).replace(n.s,a.position,a.keepIds),o=n.o.slice(),v=o.splice(a.position,1)[0];o.push(v);
                n={...n,s:r.state,o,poolStarted:true,draws:n.draws+r.purpleDraws,
                    poolDraws:n.poolDraws+r.purpleDraws,exchanges:n.exchanges+1};
            }
            n=record(before,n,a.type==='wash'?{type:'wash',keepIds:a.keepIds,count:a.count,why:a.why}:a.type==='upgrade'?{type:'upgrade',toZi:a.toZi}:
                {type:'exchange',position:a.position,keepIds:a.keepIds,from:a.from,to:a.to});
        }
        return n;
    }
    function firstLockBranch(ctx, reference) {
        const steps=reference.steps||[];
        for(let i=0;i<steps.length;i++) {
            const a=steps[i];
            if(a.type!=='wash'||!a.keepIds?.length||a.before.seen!==0)continue;
            // 首次锁脉可能发生在第一次手动置换之前：这是捕获第一个原始紫的
            // 准备段，必须把它也作为“保留三槽／立即开四槽”的共同快照。
            const e=ctx.e(a.before.zi),hasConflict=a.keepIds.some(id=>e.quality(id)<4);
            if(!hasConflict)continue;
            const base=prefixNode(ctx,steps.slice(0,i));
            if(base.zi!==153)return {index:i,base,action:a};
            const four=upgradeNode(ctx,base,154);
            return {index:i,base,four,action:a};
        }
        return null;
    }
    function prepareFirstLock(ctx, node, action, source) {
        // 起点可以在锚点前，此时 origin 为 -1。必须按原始紫出现事件捕获，
        // 不能用“新增锚点”判断是否已经洗到无限置换起点。
        const keepIds=action.keepIds.slice();
        if(keepIds.some(id=>!node.s.talents.includes(id)))return null;
        let n=node,count=0,found=false;
        while(!found&&n.s.bornRC<source.bornRC&&count<12000) {
            const keep=keepIds.map(id=>n.s.talents.indexOf(id));
            if(keep.some(v=>v<0))return null;
            const r=ctx.e(n.zi).wash(n.s,keep);
            n=washOne(ctx,n,keep);count++;
            found=r.generatedEvents.some(ev=>eventKey(ev)===source.key);
            if(missed(ctx,n))return null;
        }
        if(!found||n.s.luckSeed!=null||!ctx.e(n.zi).replaceablePositions(n.s,keepIds).includes(n.s.talents.indexOf(source.id)))return null;
        return record(node,n,{type:'wash',keepIds,count,why:'首次锁冲突脉，捕获置换起点紫'});
    }
    // 同一序列内沿已验证路线的“捕获锚点／置换”检查点做有限推演。
    // 仅跟置换链会漏掉暂时不置换的锚点（例如小雪的阳脉），也会把
    // “紫前多锁一个冲突”的分支按眼前丹耗剪掉，错过后面的连续置换。
    function milestoneVariants(ctx, nodes, reference, targets, depth, maxCost) {
        const stages=[];
        let exchange=0;
        for(const a of reference.steps) {
            if(a.type==='exchange')stages.push({kind:'exchange',index:exchange++,origin:a.before.origins[a.position],from:a.from,to:a.to});
            else if(a.type==='wash'&&a.before.seen!==a.after.seen) {
                for(const origin of a.after.origins.filter(v=>v>=0&&!(a.before.seen&(1<<v))))
                    stages.push({kind:'capture',origin,id:a.after.state.talents[a.after.origins.indexOf(origin)]});
            }
        }
        const rank=(a,b)=>a.cost-b.cost||a.exchanges-b.exchanges||a.washes-b.washes;
        const valid=n=>!missed(ctx,n)&&n.cost<maxCost&&n.draws<=depth;
        const segment=(a,b,ids,count,why)=>count?record(a,{...b},{type:'wash',keepIds:ids,count,why}):a;
        const mandatory=n=>n.o.map((v,i)=>v>=0?n.s.talents[i]:null).filter(v=>v!=null);
        function support(n, ids, index) {
            const e=ctx.e(n.zi);ids=ids.slice();
            for(const id of ids.slice())if(e.quality(id)===4&&!e.isShenmai(id)) {
                const pos=n.s.talents.indexOf(id),origin=n.o[pos];
                const changing=stages.slice(index).some(s=>s.kind==='exchange'&&s.origin===origin&&s.from===id);
                if(targets.includes(id)&&!changing)continue;
                const low=n.s.talents.find((v,i)=>i<pos&&e.quality(v)<4&&e.talentType(v)===e.talentType(id));
                if(low==null)return null;
                if(!ids.includes(low))ids.push(low);
            }
            return n.s.talents.filter(id=>ids.includes(id));
        }
        function select(candidates, next) {
            candidates.sort(rank);
            const groups=new Map(),seen=new Set(),unique=[];
            for(const n of candidates) {
                const state=[n.zi,root.WashSourceEngine.stateKey(n.s),n.o.join(','),n.seen,n.draws,n.pityCount].join('|');
                if(seen.has(state))continue;seen.add(state);unique.push(n);
                const e=ctx.e(n.zi),type=next?.kind==='exchange'?e.talentType(next.to):null;
                const ready=type!=null&&n.s.talents.some(id=>e.quality(id)<4&&e.talentType(id)===type);
                const key=[n.zi,ready].join('|');
                if(!groups.has(key))groups.set(key,n);
            }
            const result=[...groups.values()].slice(0,MAX_DIVERGENCE_BRANCHES);
            for(const n of unique)if(result.length<MAX_DIVERGENCE_BRANCHES&&!result.includes(n))result.push(n);
            return result;
        }
        function capture(base, step, index) {
            if(base.o.includes(step.origin))return [base];
            const e=ctx.e(base.zi),ids=support(base,mandatory(base),index);
            if(!ids)return [];
            const needed=targets.includes(step.id)||e.isShenmai(step.id)?[]:[e.talentType(step.id)];
            const next=stages[index+1];
            const optional=next?.kind==='exchange'&&next.origin===step.origin&&!targets.includes(next.to)&&!e.isShenmai(next.to)
                ?[e.talentType(next.to)]:[];
            const variants=[];
            function attempt(ready, locks) {
                if(locks.length>=e.slotCount)return;
                let x=ready,w=0;
                while(!x.o.includes(step.origin)&&w<12000&&valid(x)) {
                    x=washOne(ctx,x,locks.map(id=>x.s.talents.indexOf(id)));w++;
                }
                const pos=x.o.indexOf(step.origin);
                if(!valid(x)||pos<0||x.s.talents[pos]!==step.id)return;
                if(needed.length&&!e.replaceablePositions(x.s,locks).includes(pos))return;
                variants.push(segment(ready,x,locks,w,'同序列捕获紫脉锚点'));
            }
            function prepare(base, locks, types) {
                if(!types.length){attempt(base,locks);return;}
                const type=types[0];
                if(locks.some(id=>e.quality(id)<4&&e.talentType(id)===type)) {
                    prepare(base,locks,types.slice(1));return;
                }
                if(locks.length>=e.slotCount-1)return;
                const candidates=[];
                const remember=(n,count)=>{
                    for(const id of n.s.talents)if(e.quality(id)<4&&e.talentType(id)===type&&!locks.includes(id))
                        candidates.push({id,node:n,count});
                };
                let scan=base;remember(scan,0);
                for(let w=1;w<=12000&&valid(scan);w++) {
                    scan=washOne(ctx,scan,locks.map(id=>scan.s.talents.indexOf(id)));
                    if(!valid(scan)||scan.seen!==base.seen||scan.pityCount!==base.pityCount)break;
                    remember(scan,w);
                }
                // 每种准备顺序只比较紫前最近的有限个停点。
                for(const candidate of candidates.slice(-8).reverse()) {
                    const ready=segment(base,candidate.node,locks,candidate.count,'同序列快洗到前置冲突');
                    const keep=ready.s.talents.filter(id=>locks.includes(id)||id===candidate.id);
                    if(keep.length<e.slotCount)prepare(ready,keep,types.slice(1));
                }
            }
            prepare(base,ids,needed);
            if(optional.length) {
                prepare(base,ids,[...optional,...needed]);
                prepare(base,ids,[...needed,...optional]);
            }
            return select(variants,next);
        }
        function exchangeStep(base, step, index) {
            const e=ctx.e(base.zi),pos=base.o.findIndex((v,i)=>v===step.origin&&base.s.talents[i]===step.from);
            if(pos<0)return [];
            const ids=support(base,[...mandatory(base),step.from],index);
            if(!ids)return [];
            const result=[];
            function attempt(n) {
                const locks=n.s.talents.filter(id=>e.quality(id)<4);
                const at=n.o.findIndex((v,i)=>v===step.origin&&n.s.talents[i]===step.from);
                if(!e.replaceablePositions(n.s,locks).includes(at))return;
                const x=exchangeNode(ctx,n,at,locks);
                if(x.s.talents.at(-1)===step.to&&valid(x))result.push(x);
            }
            if(targets.includes(step.to)||e.isShenmai(step.to)||base.s.talents.some(id=>e.quality(id)<4&&e.talentType(id)===e.talentType(step.to)))
                attempt(base);
            else {
                if(ids.length>=e.slotCount)return [];
                let n=base;
                for(let w=1;w<=12000&&valid(n);w++) {
                    n=washOne(ctx,n,ids.map(id=>n.s.talents.indexOf(id)));
                    if(!valid(n)||n.seen!==base.seen||n.pityCount!==base.pityCount)break;
                    if(n.s.talents.some(id=>e.quality(id)<4&&e.talentType(id)===e.talentType(step.to))) {
                        attempt(segment(base,n,ids,w,'同序列提前准备连续置换冲突'));break;
                    }
                }
            }
            return result;
        }
        for(let i=0;i<stages.length&&nodes.length;i++) {
            const step=stages[i];
            nodes=select(nodes.flatMap(n=>step.kind==='exchange'&&n.exchanges>step.index?[n]
                :step.kind==='capture'?capture(n,step,i):exchangeStep(n,step,i)),stages[i+1]);
        }
        return nodes.filter(n=>complete(n,targets,ctx.anchors.length));
    }
    function lateCapture(ctx, steps, index) {
        const capture=steps[index];
        // 起点及 n 垫洗已单独准备，不能绕过首次置换重新解释序列编号。
        if(!capture.before.poolStarted)return null;
        const origin=capture.after.origins.find(v=>v>=0&&!(capture.before.seen&(1<<v)));
        if(origin==null)return null;
        const id=capture.after.state.talents[capture.after.origins.indexOf(origin)];
        const e=ctx.e(capture.before.zi),typ=e.talentType(id);
        if(e.isShenmai(id))return null;
        const conflicts=capture.keepIds.filter(v=>e.quality(v)<4&&e.talentType(v)===typ);
        if(!conflicts.length)return null;
        // 从前一个非洗髓动作之后开始重排准备，保留本段其他锁脉和已捕获锚点。
        // 不解锁仍需使用的前置冲突，不跨过置换或开槽去套用同一原始流。
        let begin=index;
        while(begin>0&&steps[begin-1].type==='wash')begin--;
        const base=prefixNode(ctx,steps.slice(0,begin));
        const fixed=capture.keepIds.filter(v=>!conflicts.includes(v));
        if(fixed.some(v=>!base.s.talents.includes(v))||base.o.some((v,i)=>v>=0&&!fixed.includes(base.s.talents[i])))return null;
        const candidates=base.s.talents.filter(v=>e.quality(v)<4&&e.talentType(v)===typ).map(v=>({id:v,node:base,count:0}));
        let scan=base;
        for(let w=1;w<=12000&&scan.cost<capture.after.cost;w++) {
            const r=e.wash(scan.s,fixed.map(v=>scan.s.talents.indexOf(v)));
            scan=washOne(ctx,scan,fixed.map(v=>scan.s.talents.indexOf(v)));
            if(!missed(ctx,scan))for(const ev of r.generatedEvents) {
                if(e.quality(ev.id)<4&&e.talentType(ev.id)===typ)candidates.push({id:ev.id,node:scan,count:w});
            }
            if(missed(ctx,scan)||scan.seen!==base.seen||scan.pityCount!==base.pityCount)break;
        }
        // 按具体出现事件从近到远验证。保底名、去重、自然锚点与排列都以重算为准。
        for(let c=candidates.length-1;c>=0;c--) {
            const candidate=candidates[c],keep=[...fixed,candidate.id];
            if(keep.length>=e.slotCount)continue;
            let n=candidate.count?record(base,{...candidate.node},{type:'wash',keepIds:fixed,count:candidate.count,why:'洗到后续紫前最近可用冲突脉'}):base;
            const ready=n;
            let w=0;
            while(!n.o.includes(origin)&&w<12000&&n.cost<capture.after.cost) {
                n=washOne(ctx,n,keep.map(v=>n.s.talents.indexOf(v)));w++;
                if(missed(ctx,n)||((n.seen!==base.seen||n.pityCount!==base.pityCount)&&!n.o.includes(origin)))break;
            }
            const pos=n.o.indexOf(origin);
            if(pos<0||missed(ctx,n)||n.s.talents[pos]!==id||!e.replaceablePositions(n.s,[candidate.id]).includes(pos)||n.cost>=capture.after.cost)continue;
            if(w)n=record(ready,n,{type:'wash',keepIds:keep,count:w,why:'延后锁冲突后捕获紫脉锚点'});
            return n;
        }
        return null;
    }
    class Heap {
        constructor(){this.a=[];}
        push(v){const a=this.a;let i=a.length;a.push(v);while(i){const p=(i-1)>>1;if(a[p].priority<=v.priority)break;a[i]=a[p];i=p;}a[i]=v;}
        pop(){const a=this.a,first=a[0],v=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let c=i*2+1;if(c+1<a.length&&a[c+1].priority<a[c].priority)c++;if(a[c].priority>=v.priority)break;a[i]=a[c];i=c;}a[i]=v;}return first;}
        get size(){return this.a.length;}
    }
    function search(raw, anchors, source, pad, opts={}, progress=()=>{}, prepared=null) {
        if (anchors.some(a => a.fromPity && (!Number.isInteger(a.pityNo) || a.pityNo < 1 || a.key !== eventKey(a))))
            throw new Error('保底锚点信息已过期，请重新读取原始紫。');
        if (source.fromPity) throw new Error('保底紫可以作为锚点；它已固定欧气，不能用来初始化新的无限置换序列。请选更早的自然紫起点。');
        // 目标数放宽到 2~4：统一搜索里「跳脉段」先交付 1 个目标，剩下的 2 个
        // 要交给锚点段处理；原先只允许 3／4 个，统一路线就永远接不上。
        if (!anchors.length || anchors.length !== opts.targets.length || ![2,3,4].includes(anchors.length)) throw new Error('请选取数量相同的两／三／四个目标和原始紫锚点。');
        if (new Set(anchors.map(a=>a.key)).size !== anchors.length || new Set(opts.targets).size!==anchors.length) throw new Error('锚点和目标不能重复。');
        if (source.bornRC > Math.min(...anchors.map(a=>a.bornRC))) throw new Error('第一版的置换起点需在首个锚点或它之前。');
        const ctx=prepared?prepared.ctx:makeContext(raw,anchors), targets=opts.targets.map(Number), initial=prepared?prepared.node:initialize(ctx,source,pad);
        const heap=new Heap(), visited=new Map(), routes=[];
        const maxNodes=Math.min(60000,Math.max(prepared?1:500,Number(opts.maxNodes)||10000));
        const depth=Math.min(40,Math.max(1,Number(opts.depth)||20));
        // ⚠ 序列信息多抽一段（至少 48 条）：prefilterSequence 用「锚点 ∪ 本段紫池」判断
        //   神脉目标能不能拿到，池子只看到 depth（默认 20）条时，像「混元奇脉」这种
        //   在池子里排到 30 多位的神脉会被误判成「池里没有」→ 整条搜索被判 filtered，展开 0。
        const sequence=prepared?prepared.sequence:sequenceInfo(ctx,initial,Math.max(depth,48),opts.sequenceBasis==='theory2'?152:null);
        const guide=prepared?.guide;
        if(pad===0)sequence.b0=[];
        // 只有开槽前后紫池资格相同，才能用这一段池安全排除缺目标的序列。
        // 一心、冲突和操作时序仍交给真实状态搜索，不用目标排列充当成功证明。
        const pe=ctx.e(initial.zi), later=ctx.e(initial.zi===153?154:initial.zi);
        const samePool=pe.purpleIds.every(id=>pe.allowed.has(id)===later.allowed.has(id));
        const prefilter=opts.prefilter!==false&&samePool
            ?prefilterSequence(ctx,initial,anchors,source,sequence,targets):{ok:true};
        if(!prefilter.ok) return {routes:[],expanded:0,bounded:false,
            filtered:true,pad,depth,maxNodes,sequence,prefilter,
            reason:prefilter.reason};
        const maxCost=Math.max(1,Number(opts.maxCost)||50000), full=(1<<anchors.length)-1;
        const lastRC=Math.max(-Infinity,...anchors.filter(a=>!a.fromPity).map(a=>a.bornRC));
        const lastPity=Math.max(0,...anchors.filter(a=>a.fromPity).map(a=>a.pityNo));
        let expanded=0, bounded=false;
        // 丹耗上限触发的「超预算」信号：整条搜索里**曾经走到过**的最深状态成本。
        // 若最终 routes 为空、而 bestSeenCost 顶到了 maxCost 附近，就说明是预算卡的，
        // 而不是这条路根本不存在 —— 这样界面能明确提示「超出预设丹数，放弃这条路线」。
        let bestSeenCost=0, budgetHit=false;
        function accept(n) {
            const route=actions(n), checked=replay(raw,anchors,route,targets);
            routes.push({...checked,steps:route,pad,depthUsed:n.draws,source:{no:source.no,id:source.id,key:source.key,bornRC:source.bornRC},sequence,
                variant:prepared?.variant||null});
            routes.sort((a,b)=>a.cost-b.cost||a.exchanges-b.exchanges||a.pad-b.pad||a.washes-b.washes);routes.splice(3);
            progress({expanded,queued:heap.size,pad,found:routes.length,candidate:routes[0]});
        }
        function push(n) {
            // 丹耗上限＝**硬剪枝**：整条路线累计超过预设（3 目标 3000 / 4 目标 8000 或用户填的值）
            // 就直接丢弃，不再展开。这样「保留非目标神脉等互冲」这类高消耗分支会被上限自然砍掉，
            // 而上限放宽时搜索仍会去比价 —— 即「让搜索算，超预算就放弃这条路线」。
            if (missed(ctx,n) || n.draws>depth || n.cost>maxCost) return;
            // 记录搜索实际达到的最大丹耗；顶到上限就标记 budgetHit（供「超预算」提示用）。
            if(n.cost>bestSeenCost) bestSeenCost=n.cost;
            if(n.cost>=maxCost*0.98) budgetHit=true;
            // 非目标普通紫若已没有在前的低阶冲突，锚点又不能洗掉，就永久无法改变。
            // 在这里拒绝，避免搜索花大量时间尝试紫后补冲突的死路。
            const e=ctx.e(n.zi), low=n.s.talents.filter(id=>e.quality(id)<4);
            const replaceable=new Set(e.replaceablePositions(n.s,low));
            if(n.o.some((v,i)=>v>=0&&!targets.includes(n.s.talents[i])&&!e.isShenmai(n.s.talents[i])&&!replaceable.has(i)))return;
            if (routes.length && n.cost >= routes[0].cost) return;
            const key=[n.zi,root.WashSourceEngine.stateKey(n.s),n.o.join(','),n.seen,n.draws,n.pityCount].join('|');
            if ((visited.get(key) ?? Infinity)<=n.cost) return;
            visited.set(key,n.cost);
            // 已生成完整路线立即回放，避免高丹耗的保底收尾被留在队列中直到节点预算耗尽。
            if (complete(n,targets,anchors.length)) { accept(n); return; }
            const matched=n.s.talents.filter((id,i)=>n.o[i]>=0&&targets.includes(id)).length;
            const captured=n.o.filter(v=>v>=0).length;
            // 有界启发式探索；排序结果只代表已经验证的路线，不作全局最优保证。
            // 同名中间紫也会推进序列，给这类合法进展一点优先级，避免全预算耗在起点附近。
            n.priority=n.cost+(targets.length-matched)*1500+(anchors.length-captured)*3000-Math.min(depth,n.draws)*500;
            if(guide)n.priority=n.cost+(guide.length-n.exchanges)*3000+(anchors.length-captured)*1500;
            // ② 置换链优先：刚做完一次置换的状态，下一步大概率还是「继续换同一条紫」
            //   （参考方案里柳如意 5 连换、薛龙城 8 连换）。旧启发式只看丹耗/捕获数，
            //   会把「继续推进池子」的分支排到很后面，导致链走两步就断。
            const lastAction=n.trace&&n.trace.action;
            if(lastAction&&lastAction.type==='exchange')n.priority-=1200;
            // 已经攒了 ≥2 条目标时，锁数越多每洗推进越慢（4−锁数），所以优先「不再多锁」的分支。
            if(captured>=2)n.priority+=0;
            heap.push(n);
        }
        push(initial);
        while(heap.size && expanded<maxNodes) {
            const n=heap.pop();expanded++;
            // 已找到更省丹的路线后，这些状态的后续洗法也不会更省丹。
            if(routes.length && n.cost>=routes[0].cost)continue;
            if (expanded%200===0) progress({expanded,queued:heap.size,pad,found:routes.length});
            const e=ctx.e(n.zi);
            const locks=n.s.talents.filter(id=>e.quality(id)<4);
            // 神脉「免费通道」：场上神脉 ≥2（不同 id 才能互冲）时，replaceablePositions 会
            // 把所有神脉位都列出来；这条路**不占可洗槽、不耗丹**，
            // 所以即使锁满了目标紫（可洗槽=0）也允许再推进一步 ——
            // 这就是「4 紫最后一条不一定是天然紫、也可能是神脉换出来」的来源。
            const shenOnField=n.s.talents.filter(id=>e.isShenmai(id)).length;
            const upcomingTypes=new Set();
            for (const pos of e.replaceablePositions(n.s,locks)) {
                // 置换抽到的若是**非目标神脉**，这条链并非不可续 —— 后面的 wash 分支
                // 会把它当「普通未锁脉」洗掉（不锁就洗 = 放弃该槽位），紫序照常前进，
                // 再接「锁冲突 → 洗紫 → 普通置换」。所以这里不去掉该分支，照常入队。
                const isShenPos=e.isShenmai(n.s.talents[pos]);
                const shenFree=isShenPos&&shenOnField>=2;   // 神脉互冲：不占可洗槽、不耗丹
                const r=e.replace(n.s,pos,locks), o=n.o.slice(), v=o.splice(pos,1)[0];o.push(v);
                if(guide) {
                    const next=guide[n.exchanges];
                    if(!next)continue;
                    // guide 可以只给 to（池序 guide）：按「置换紫池的顺序」剪枝。
                    // 完整 guide 还会钉住来源槽位与被换掉的紫，行为与原来一致。
                    if(next.to!==r.addedId)continue;
                    if(next.origin!==undefined&&next.origin!==v)continue;
                    if(next.from!==undefined&&next.from!==r.removedId)continue;
                }
                // 下一次置换的新紫排到末尾：先锁好它的冲突脉，才能再继续换。
                if(!e.isShenmai(r.addedId))upcomingTypes.add(e.talentType(r.addedId));
                const node=record(n,{...n,s:r.state,o,poolStarted:true,draws:n.draws+r.purpleDraws,
                    poolDraws:n.poolDraws+r.purpleDraws,exchanges:n.exchanges+1},
                    {type:'exchange',position:pos,keepIds:locks,from:r.removedId,to:r.addedId});
                if(shenFree) node.shenmaiFree=true;   // 标记：这是一次不占槽的神脉推进
                push(node);
            }
            // 三紫也可能需要第四槽提前准备后续紫脉的冲突脉。
            if(n.zi===153) push(upgradeNode(ctx,n,154));
            // 收齐锚点后，若还有空余槽，仍可洗冲突脉／神脉支点。
            // 所有锚点继续强制锁定，不能借洗掉锚点换取操作空间。
            const mandatory=n.o.map((v,i)=>v>=0?i:-1).filter(i=>i>=0);
            const optional=n.s.talents.map((id,i)=>!mandatory.includes(i)?i:-1).filter(i=>i>=0);
            for(let mask=0;mask<(1<<optional.length);mask++) {
                const keep=[...mandatory,...optional.filter((v,i)=>mask&(1<<i))].sort((a,b)=>a-b);
                if(keep.length>=e.slotCount)continue;
                // 洗掉非目标普通锚点的前置冲突会把它永久锁死，直接跳过整段垫洗。
                if(mandatory.some(pos=>!targets.includes(n.s.talents[pos])&&!e.isShenmai(n.s.talents[pos])&&
                    !keep.some(i=>i<pos&&e.quality(n.s.talents[i])<4&&e.talentType(n.s.talents[i])===e.talentType(n.s.talents[pos]))))continue;
                const ids=keepIds(n,keep);
                const retained=ids.filter(id=>e.quality(id)===4);
                // 只为后续到场的紫准备普通冲突；已保留的普通紫不能借后补冲突续换。
                const types=new Set(upcomingTypes);
                if(guide)for(const next of guide.slice(n.exchanges,n.exchanges+3))
                    if(!e.isShenmai(next.to))types.add(e.talentType(next.to));
                ctx.anchors.forEach((a,i)=>{
                    if(!(n.seen&(1<<i))&&!a.fromPity&&!e.isShenmai(a.id))types.add(e.talentType(a.id));
                });
                // 未捕获的保底锚点会接当前紫池下一条，名字不能沿用无锁扫描的参考值。
                if(ctx.anchors.some((a,i)=>a.fromPity&&!(n.seen&(1<<i)))){
                    let luck=e.hooks.seedLuck(n.s);
                    for(let d=0;d<10000;d++){
                        const next=e.draw(luck,true);luck=next[1];
                        if(!e.allowed.has(next[0])||ids.includes(next[0]))continue;
                        if(!e.isShenmai(next[0]))types.add(e.talentType(next[0]));
                        break;
                    }
                }
                const preparationIds=new Set(e.allIds.filter(id=>e.allowed.has(id)&&e.quality(id)<4&&types.has(e.talentType(id))&&!ids.includes(id)));
                const shenSupport=retained.some(v=>e.isShenmai(v));
                if(n.seen===full&&!preparationIds.size&&!shenSupport)continue;
                let x=n, w=0;
                const emitted=new Set();
                const lateEvents=new Map(),guideStop=guide?.[n.exchanges]?.rc??Infinity;
                while(w<12000 && (n.seen===full || x.s.bornRC<=lastRC || x.pityCount<lastPity) &&
                    x.cost<Math.min(maxCost,routes.length?routes[0].cost:Infinity) && x.draws<=depth && x.s.bornRC<guideStop) {
                    const k=ids.map(id=>x.s.talents.indexOf(id));
                    const oldSeen=x.seen, oldPity=x.pityCount;
                    x=washOne(ctx,x,k);w++;
                    if(missed(ctx,x))break;
                    const capture=x.seen!==oldSeen;
                    const interesting=x.s.talents.filter((id,i)=>i>=ids.length &&
                        (preparationIds.has(id) ||
                         (e.isShenmai(id) && retained.some(v=>e.isShenmai(v)&&v!==id))));
                    const fresh=interesting.some(id=>!emitted.has(id));
                    const pity=x.pityCount!==oldPity;
                    // 紫到场之后的低阶脉不能覆盖此前的准备停点；否则最后一次
                    // 合法前置冲突会被紫后补冲突的死路吞掉（尤其是保底整洗）。
                    if(guide&&!capture&&!pity&&x.s.bornRC<=guideStop)
                        for(const id of interesting)lateEvents.set(id,{node:{...x},count:w});
                    if(capture||fresh||pity) {
                        push(record(n,{...x},{type:'wash',keepIds:ids,count:w,why:capture?'捕获紫脉锚点':pity?'保底推进置换紫池':'准备冲突脉／神脉支点'}));
                        interesting.forEach(id=>emitted.add(id));
                    }
                    if(capture||pity)break;
                }
                if(guide)for(const candidate of lateEvents.values())push(record(n,candidate.node,
                    {type:'wash',keepIds:ids,count:candidate.count,why:'同序列比较较晚的冲突准备'}));
            }
        }
        bounded=heap.size>0;
        let refinementExpanded=0,lockExpanded=0,firstLockOptimization=null;
        // 开槽分歧需要重新探索后续锁法；深入模式不能仍被固定的6000节点截断。
        let lockBudget=Math.min(maxNodes*2,6000);
        if(!prepared&&opts.optimizeLocks!==false&&!routes.length) {
            const e=ctx.e(initial.zi),locks=initial.s.talents.filter(id=>e.quality(id)<4),replaceable=new Set(e.replaceablePositions(initial.s,locks));
            const needsPreparation=initial.o.some((v,i)=>v>=0&&!targets.includes(initial.s.talents[i])&&!e.isShenmai(initial.s.talents[i])&&!replaceable.has(i));
            if(needsPreparation) {
                const variants=padVariants(ctx,initial,source,sequence,targets).filter(n=>{
                    const ve=ctx.e(n.zi),legal=new Set(ve.replaceablePositions(n.s,n.s.talents.filter(id=>ve.quality(id)<4)));
                    return n.o.every((v,i)=>v<0||targets.includes(n.s.talents[i])||ve.isShenmai(n.s.talents[i])||legal.has(i));
                });
                for(const node of divergenceBranches(variants)) {
                    if(lockBudget<=0)break;
                    const r=search(raw,anchors,source,pad,{...opts,prefilter:false,maxNodes:Math.min(maxNodes,lockBudget,3000)},()=>{}, {ctx,node,sequence});
                    lockBudget-=r.expanded;lockExpanded+=r.expanded;expanded+=r.expanded;bounded=bounded||r.bounded;
                    if(r.routes.length) {
                        routes.push(...r.routes);routes.sort((a,b)=>a.cost-b.cost||a.exchanges-b.exchanges||a.pad-b.pad||a.washes-b.washes);routes.splice(3);
                        progress({expanded,queued:0,pad,found:routes.length,candidate:routes[0]});
                    }
                }
            }
        }
        if(!prepared&&routes.length) {
            // 先保证找到原有路线，再从其晚锁捕获状态继续精确推演；不让新增停点
            // 挤占主搜索预算，也不沿用已经改变的收尾洗次。只接纳完整回放且更省丹的结果。
            const refined=new Set();
            let remaining=Math.min(maxNodes,1500);
            for(let pass=0;pass<anchors.length;pass++) {
                const best=routes[0];let improved=false;
                for(let i=0;i<best.steps.length;i++) {
                    if(remaining<=0)break;
                    const a=best.steps[i];
                    if(a.type!=='wash'||a.before.seen===a.after.seen)continue;
                    const node=lateCapture(ctx,best.steps,i);
                    if(!node)continue;
                    const key=[node.zi,root.WashSourceEngine.stateKey(node.s),node.o.join(','),node.seen,node.draws,node.pityCount].join('|');
                    if(refined.has(key))continue;refined.add(key);
                    const r=search(raw,anchors,source,pad,{...opts,prefilter:false,maxNodes:remaining,maxCost:Math.min(maxCost,best.cost-1)},()=>{}, {ctx,node,sequence});
                    remaining-=r.expanded;refinementExpanded+=r.expanded;
                    expanded+=r.expanded;bounded=bounded||r.bounded;
                    if(r.routes.length) {
                        routes.push(...r.routes);routes.sort((a,b)=>a.cost-b.cost||a.exchanges-b.exchanges||a.pad-b.pad||a.washes-b.washes);routes.splice(3);
                        improved=routes[0].cost<best.cost;
                        progress({expanded,queued:0,pad,found:routes.length,candidate:routes[0]});
                    }
                }
                if(!improved||remaining<=0)break;
            }
        }
        if(!prepared&&routes.length&&opts.optimizeLocks!==false) {
            // 固定已证实的置换顺序及锚点去向，再比较提前冲突、少锁推进、开槽时机。
            // 只有收尾的完整回放更便宜才替换原路线；未成功仍保留原结果。
            const reference=routes[0],guide=reference.steps.filter(a=>a.type==='exchange')
                .map(a=>({origin:a.before.origins[a.position],from:a.from,to:a.to,rc:a.before.state.bornRC}));
            const nextType=ctx.e(154).talentType(guide[1]?.to);
            const pads=padVariants(ctx,initial,source,sequence,targets).sort((a,b)=>{
                const useful=n=>n.s.talents.some(id=>ctx.e(n.zi).quality(id)<4&&ctx.e(n.zi).talentType(id)===nextType);
                return Number(useful(b))-Number(useful(a))||a.cost-b.cost;
            });
            // 用户关心的第一个锁脉点单独比较：两个分支必须从同一实际快照开始，
            // 3 槽沿原置换链回放，4 槽从同一快照开槽后重新搜索锁法。
            const firstBranch=firstLockBranch(ctx,reference);
            if(firstBranch?.four) {
                const captured=prepareFirstLock(ctx,firstBranch.four,firstBranch.action,source);
                // 先捕获源紫，再回到原 n 的 bornSeed/RC；不能从刚出紫的状态
                // 直接置换并贴上旧 n。捕获节点可以不是锚点。
                const aligned=captured?padVariants(ctx,initial,source,sequence,targets,captured):[];
                const completed=milestoneVariants(ctx,divergenceBranches(aligned),reference,targets,depth,Math.min(maxCost,reference.cost));
                firstLockOptimization={captured:!!captured,aligned:aligned.length,verified:completed.length};
                for(const node of completed)accept(node);
            }
            // 每个洗脉段都可能是开槽分歧点。旧逻辑只取“置换后第一段洗脉”，
            // 会漏掉“先锁枪棍好手，再洗到枪棍绝伦，随后立即开4槽”的等序列分支。
            // 这里保留每个洗脉动作的起点，guidedShortcut 会从该节点继续回放同一置换链，
            // 最终以真实槽位和丹耗验证，而不是把理论点击次数直接当成结果。
            const variantBases=[...pads,...reference.steps.map((a,i)=>({a,i})).filter(({a})=>a.type==='wash'&&(
                a.before.poolStarted
                || a.before.state.talents.some(id=>ctx.e(a.before.zi).quality(id)===4)
                || a.after.state.talents.some(id=>ctx.e(a.after.zi).quality(id)===4)
            ))
                .reverse().map(({i})=>prefixNode(ctx,reference.steps.slice(0,i))),
                initial];
            const variants=[];
            for(const node of variantBases) {
                // 首换前的所有分支由 padVariants 精确定位；未定位的快照不能
                // 交给后续搜索，否则会改成另一条置换序列。
                if(!node.poolStarted)continue;
                variants.push(node);
                // guidedShortcut 只复用置换链，不会在节点内部主动插入开槽动作；
                // 显式加入同一节点的4槽快照，才能比较“枪棍紫出现后立即开4槽”。
                if(node.zi===153) variants.push(upgradeNode(ctx,node,154));
            }
            const sourceType=ctx.e(154).talentType(source.id);
            const isFreshFourSlot=node=>node.zi===154&&!node.poolStarted&&node.s.talents.some(id=>
                ctx.e(node.zi).quality(id)<4&&ctx.e(node.zi).talentType(id)===sourceType);
            variants.sort((a,b)=>Number(isFreshFourSlot(b))-Number(isFreshFourSlot(a)));
            let remaining=lockBudget;
            for(let i=0;i<variants.length&&remaining>0;i++) {
                const node=variants[i];
                const shortcut=guidedShortcut(ctx,node,guide,targets,depth,Math.min(maxCost,routes[0].cost));
                if(shortcut)accept(shortcut);
                // 已完成首次开槽分支时，继续按检查点比较其他快照，避免又把
                // 预算耗在不保留中间锚点的无约束搜索上。
                if(firstLockOptimization?.verified) {
                    for(const end of milestoneVariants(ctx,[node],reference,targets,depth,Math.min(maxCost,routes[0].cost)))accept(end);
                    continue;
                }
                // 首个原始紫尚未置换、且刚在紫脉段后开4槽时，后续锁法可能
                // 与原3槽路线不同；这里做一次不带旧 guide 的完整分支搜索。
                const freshFourSlot = node.zi===154 && !node.poolStarted && node.s.talents.includes(source.id);
                const budget=Math.min(remaining,freshFourSlot?6000:(i===0?2000:1000));
                const best=routes[0],preparedSearch=freshFourSlot?{ctx,node,sequence}:{ctx,node,sequence,guide};
                const r=search(raw,anchors,source,pad,{...opts,prefilter:false,maxNodes:budget,maxCost:Math.min(maxCost,best.cost-1)},()=>{},preparedSearch);
                remaining-=r.expanded;lockExpanded+=r.expanded;expanded+=r.expanded;bounded=bounded||r.bounded;
                if(r.routes.length) {
                    routes.push(...r.routes);routes.sort((a,b)=>a.cost-b.cost||a.exchanges-b.exchanges||a.pad-b.pad||a.washes-b.washes);routes.splice(3);
                    progress({expanded,queued:0,pad,found:routes.length,candidate:routes[0]});
                }
            }
        }
        return { routes, expanded, refinementExpanded, lockExpanded, firstLockOptimization, bounded, pad, depth, maxNodes, sequence,
            maxCost, budgetHit, bestSeenCost,
            overBudget: !routes.length && budgetHit,
            reason:routes.length?'所有展示路线均已从导入状态回放验证。'
                :(budgetHit
                    ? `在 ${maxCost} 丹上限内没有可回放路线；搜索已顶到上限，说明更省的方案需要更高预算。`
                    :'在所设深度和节点范围内未找到可回放路线；这不等于绝对无解。') };
    }

    /**
     * 动态前瞻执行器（v3，使用者 2026-10 方案）。
     *
     * 前两版的教训：
     *   · v1/v2 按「0 锁扫描出来的静态锚点表」走 —— 一旦锁上目标，紫序时间线整体后移，
     *     锚点紫早被冲掉，满屏 missAnchor（实测只拿到 1~2 个目标）。
     *
     * v3 不再用静态表，改成**每步都问引擎**：
     *   · 用**当前锁集**往前模拟，得到「下一条紫是什么、什么类型」；
     *   · 洗的路上，见到该类型的低阶脉就先锁住（当冲突）；
     *   · 紫一到：是目标就锁；不是目标就试着换 —— 池子吐出的若是还缺的目标就留下，
     *     否则让它冲掉（毁脉），继续等下一条。
     *
     * 返回 { ok, cost, washes, exchanges, burns, field, held, steps, got, missing }
     */
    function planThenExecuteDynamic(raw, targets, opts) {
        opts = opts || {};
        const TG = (targets || []).map(Number);
        if (TG.length < 2 || TG.length > 4) return null;
        const budget = Number(opts.budget) || 0;
        const probeMax = Math.max(40, Number(opts.probe) || 400);
        const maxWash = Math.max(2000, Number(opts.maxWash) || 20000);
        let zi = Number(raw.zizhi) >= 154 ? 154 : 153;
        let e;
        try { e = engine(raw, zi); } catch (err) { return null; }
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let cost = 0, washes = 0, exchanges = 0, burns = 0, misses = 0;
        const held = [];
        // 使用者口径：**能连续置换的前提是「锁定到洗脉结束的目标紫最多 1 条」**——
        //   4 槽里留 3 格给「待换紫 + 它的冲突 + 下一条的冲突」，链才推得动。
        //   （神脉冲突还能额外推进一条置换脉序，这里先不细分。）
        const heldCap = Math.max(1, Number(opts.heldCap) || 1);
        const canLockMore = () => held.length < heldCap;
        let conflictId = null;
        let pending = null;              // { id, type }
        let lastAdded = null;            // 上一次置换换出来的紫（链的下一步）
        let conflict2 = null;             // 为「链的下一步」预先锁好的冲突脉
        const steps = [];
        const locks = () => held.concat(conflictId == null ? [] : [conflictId]).concat(conflict2 == null ? [] : [conflict2]);
        const keep = () => locks().map(id => s.talents.indexOf(id)).filter(i => i >= 0);
        const freeSlots = () => e.slotCount - held.length - (conflictId == null ? 0 : 1);
        const upgradeIfNeeded = () => {
            if (zi === 153 && freeSlots() < 1) {
                zi = 154; e = engine(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: 154 }));
                steps.push({ type: 'upgrade', toZi: 154, washes, cost });
            }
        };

        let guard = 0;
        while (held.length < TG.length && guard++ < maxWash) {
            if (budget > 0 && cost > budget) break;
            upgradeIfNeeded();
            // ① 前瞻：用当前锁集问引擎「下一条紫是什么」
            if (!pending) {
                try {
                    let ps = s;
                    const kk = keep();
                    for (let k = 0; k < probeMax; k++) {
                        const r = e.wash(ps, kk);
                        ps = r.state;
                        const ev = (r.generatedEvents || []).find(x => e.quality(x.id) === 4);
                        if (ev) { pending = { id: Number(ev.id), type: e.talentType(ev.id) }; break; }
                    }
                } catch (err) { pending = null; }
                if (!pending) break;                       // 后面没有紫了
            }
            // ② 真实洗一洗
            const before = keep();
            const r = e.wash(s, before);
            s = r.state; cost += Number(r.cost) || 0; washes++;
            if (conflict2 != null && s.talents.indexOf(conflict2) < 0) conflict2 = null;
            // ③ 路上出现「下一条紫的同类型低阶脉」→ 先锁住当冲突
            for (const ev of (r.generatedEvents || [])) {
                const id = Number(ev.id);
                if (e.quality(id) >= 4) continue;
                if (conflictId != null) continue;
                if (TG.includes(id) || held.includes(id)) continue;
                if (e.talentType(id) !== pending.type) continue;
                if (freeSlots() < 1) continue;
                conflictId = id;
                steps.push({ type: 'lockConflict', id, forPurple: pending.id, washes, cost });
            }
            // ★ 场上已有可换组合就立刻换（使用者 2026-10 的关键点）：
            //   不必等「计划中的下一条紫」——只要场上同时有「非目标紫 + 它前面的同类型低阶脉」，
            //   就先试算池子会吐什么：是缺的目标就落地换掉，链就能在这里接上。
            //   薛龙城的 8 连换正是靠这点：换出「转世金仙」时，「金仙冲突脉」已经在场上了。
            if (held.length < TG.length) {
                for (let pi = s.talents.length - 1; pi >= 0; pi--) {
                    const pid = Number(s.talents[pi]);
                    if (e.quality(pid) !== 4 || TG.includes(pid) || held.includes(pid)) continue;
                    let lowPos = -1;
                    for (let li = 0; li < pi; li++) {
                        const lv = Number(s.talents[li]);
                        if (e.quality(lv) < 4 && e.talentType(lv) === e.talentType(pid) && !held.includes(lv)) { lowPos = li; break; }
                    }
                    if (lowPos < 0) continue;
                    const lowId2 = Number(s.talents[lowPos]);
                    const lockTmp = held.concat([lowId2]);
                    if (!e.replaceablePositions(s, lockTmp).includes(pi)) continue;
                    let trial2 = null;
                    try { trial2 = e.replace(s, pi, lockTmp); } catch (err) { continue; }
                    if (!trial2) continue;
                    const addId = Number(trial2.addedId);
                    const isNeeded = TG.includes(addId) && !held.includes(addId);
                    const roomNow = freeSlots() >= (isNeeded ? 0 : 0);
                    if (!isNeeded) continue;              // 只做「能出缺目标」的置换
                    if (!roomNow) continue;
                    s = trial2.state; exchanges++;
                    if (canLockMore()) held.push(addId);
                    conflictId = lowId2;
                    steps.push({ type: 'exchange', from: pid, to: addId, washes, cost, onField: true });
                    break;
                }
            }
            // ④ 那条紫到了
            const purpleEv = (r.generatedEvents || []).map(x => Number(x.id)).find(id => id === pending.id)
                || (s.talents.includes(pending.id) ? pending.id : null);
            if (purpleEv != null) {
                const pos = s.talents.indexOf(pending.id);
                if (TG.includes(pending.id) && !held.includes(pending.id) && pos >= 0) {
                    // 只有在「锁上之后仍留得出冲突位 + 紫位」时才锁目标（否则后面换不动，
                    // 参考方案柳如意就是长期只锁 1~2 条、留 2 格给置换链）。
                    const minFree = Math.max(0, Number(opts.minFreeSlots == null ? 2 : opts.minFreeSlots));
                    if (freeSlots() >= minFree && held.length < TG.length) {
                        if (canLockMore()) held.push(pending.id);
                        steps.push({ type: 'lock', id: pending.id, washes, cost });
                    }
                } else if (pos >= 0) {
                    // 非目标紫：试着换（冲突必须在它前面）
                    let ok = false;
                    if (conflictId != null) {
                        const cpos = s.talents.indexOf(conflictId);
                        const lockNow = locks();
                        if (cpos >= 0 && cpos < pos && e.replaceablePositions(s, lockNow).includes(pos)) {
                            // ★ 换之前就把「链的下一步」的冲突准备好：
                            //   纯函数试算一次，看池子会吐出哪条紫，再把那条紫的同类型低阶脉锁住。
                            //   这样换完之后立刻能继续换（参考方案就是这么连换 5~8 次的）。
                            if (conflict2 == null && freeSlots() >= 1) {
                                try {
                                    const trial = e.replace(s, pos, lockNow);
                                    const nextId = Number(trial.addedId);
                                    if (!(TG.includes(nextId) && held.includes(nextId))) {
                                        const nt = e.talentType(nextId);
                                        const low2 = s.talents.map(Number).find(v =>
                                            e.quality(v) < 4 && e.talentType(v) === nt && !held.includes(v) && v !== conflictId);
                                        if (low2 != null) conflict2 = low2;
                                    }
                                } catch (err) { conflict2 = null; }
                            }
                            let rr = null;
                            try { rr = e.replace(s, pos, lockNow); } catch (err) { rr = null; }
                            if (rr) {
                                const added = Number(rr.addedId);
                                lastAdded = added;   // 供冲突轮转用：链要从这条新紫继续
                                if (TG.includes(added) && !held.includes(added)) {
                                    s = rr.state; exchanges++;
                                    held.push(added);
                                    steps.push({ type: 'exchange', from: pending.id, to: added, washes, cost });
                                    ok = true;
                                } else {
                                    // 垃圾：不落地（等价于毁脉），只把它当白烧推进一步
                                    s = rr.state; exchanges++; burns++;
                                    steps.push({ type: 'burn', from: pending.id, to: added, washes, cost });
                                    ok = true;   // 池子推进了一格，但目标没变
                                    if (!TG.includes(added)) {
                                        // 留在场上当普通紫，下一洗自然冲掉
                                    }
                                }
                            }
                        }
                    }
                    if (!ok) misses++;
                    // ★ 冲突轮转：换完不立刻释放，而是**接着把新紫继续换下去**（参考方案的连换）。
                    //   新紫的类型若和当前冲突同类型，直接复用；否则在场上找一个同类型低阶脉补上。
                    //   这样一条链能在同一条紫上连续推进池子（薛龙城 8 连换、柳如意 5 换）。
                    for (let chain = 0; chain < 8; chain++) {
                        // ⚠ 链的下一步是「上一次置换换出来的那条紫」，不是 pending（那条已经被换掉了）。
                        if (lastAdded == null) break;
                        let curPos = s.talents.findIndex(v => Number(v) === Number(lastAdded));
                        if (curPos < 0) break;
                        const curId = Number(s.talents[curPos]);
                        if (TG.includes(curId) && held.includes(curId)) break;   // 已经是目标，别动
                        const curType = e.talentType(curId);
                        // 冲突优先复用：当前冲突 → 预先为下一步锁好的 conflict2 → 场上现找
                        let low = null;
                        for (const cand of [conflictId, conflict2]) {
                            if (cand == null) continue;
                            const cp = s.talents.indexOf(cand);
                            if (cp >= 0 && cp < curPos && e.talentType(cand) === curType) { low = cand; break; }
                        }
                        if (low == null) {
                            low = s.talents.slice(0, curPos).map(Number).find(v =>
                                e.quality(v) < 4 && e.talentType(v) === curType && !held.includes(v));
                        }
                        if (low == null) break;
                        conflictId = low;
                        const lockNow2 = locks();
                        if (!e.replaceablePositions(s, lockNow2).includes(curPos)) break;
                        let rr2 = null;
                        try { rr2 = e.replace(s, curPos, lockNow2); } catch (err) { break; }
                        if (!rr2) break;
                        const added2 = Number(rr2.addedId);
                        s = rr2.state; exchanges++;
                        if (TG.includes(added2) && !held.includes(added2)) {
                            held.push(added2);
                            steps.push({ type: 'exchange', from: curId, to: added2, washes, cost, chain: true });
                            lastAdded = added2;
                            break;
                        }
                        burns++;
                        steps.push({ type: 'burn', from: curId, to: added2, washes, cost, chain: true });
                        // 继续换这条新紫
                        lastAdded = added2;
                    }
                }
                // ★ 冲突脉不能随手解锁：场上若还有「同类型的非目标紫」等着换，就必须留着，
                //   否则那条紫再也换不动（使用者 2026-10：紫和冲突同场时冲突不能解锁）。
                if (conflictId != null) {
                    const stillNeeded = s.talents.some(v => {
                        const id = Number(v);
                        return e.quality(id) === 4 && !TG.includes(id) && !held.includes(id)
                            && e.talentType(id) === e.talentType(conflictId);
                    });
                    if (!stillNeeded) conflictId = null;
                }
                pending = null;
            }
        }
        // ★ 神脉收尾：验过的实际顺序是「玄阳 → 玄阳 → 金仙」——
        //   第一次换出来还是同名神脉，神脉可以**再推进一次**，第二次就换到目标。
        if (tailIsShen && held.includes(tailId)) {
            let pos = s.talents.indexOf(tailId);
            const locks = Array.from(new Set(held));
            for (let hop = 0; hop < 3 && pos >= 0; hop++) {
                if (!e.replaceablePositions(s, locks).includes(pos)) break;
                let rr = null;
                try { rr = e.replace(s, pos, locks); } catch (err) { break; }
                const added = Number(rr.addedId);
                const fromId = Number(s.talents[pos]);
                s = rr.state;
                steps.push({ type: 'exchange', from: fromId, to: added, locks, field: s.talents.slice(), washes, cost, afterTail: true });
                noteExchange(pos, TG.includes(added));
                if (added !== fromId) {
                    if (TG.includes(added) && !held.includes(added)) held.push(added);
                    break;
                }
                pos = s.talents.indexOf(added);
            }
        }
        const got = TG.filter(id => held.includes(id)).length;
        return {
            ok: got === TG.length, cost, washes, exchanges, burns, misses,
            field: s.talents.slice(), held: held.slice(), steps,
            got, missing: TG.filter(id => !held.includes(id)),
        };
    }

    /**
     * 用**指定欧气种子**重扫保底紫（使用者 2026-10 规则）。
     *
     * 实测：保底紫的**洗数位置不变**（同一角色同一段洗髓），但**身份完全由种子决定**：
     *   柳如意 基准 剑术无双@734 → 鹤骨龙筋@1877；
     *          种子 987654 → 术绍岐黄@734 → 转世金仙@1877。
     * 所以「跳脉 / 无限置换 / 任何一次置换」改掉 luck_seed 之后，
     * 后续所有保底紫都必须用这个函数重扫，不能沿用初始扫描结果。
     *
     * @param raw   角色原始状态（会以 seed 覆盖 luck_seed）
     * @param seed  Number，新的欧气种子
     * @param count 扫多少条紫，默认 14
     */
    function pityPurplesForSeed(raw, seed, count) {
        const e0 = Number(raw && raw.zizhi) >= 153 ? Number(raw.zizhi) : 153;
        const shifted = Object.assign({}, raw, {
            zizhi: e0,
            luck_seed: Number(seed) || 0,
            luck_seed_inited: true,
        });
        let seq = [];
        try { seq = scan(shifted, Number(count) || 14); } catch (err) { return []; }
        return seq.filter(p => p.fromPity).map(p => ({ id: Number(p.id), name: p.name, wash: Number(p.wash), no: Number(p.no) }));
    }

    /**
     * 读「置换脉序（欧气池）」的下一条：用合成场连续 replace，不耗丹、不推进洗髓。
     * 池子只取决于当前 luckSeed，所以读完不影响真实状态。
     */
    /**
     * 合成场推算「下一次置换会吐什么」（只作参考）。
     *
     * ⚠ 种子口径（2026-10 实测对齐）：引擎里置换的起点是
     *   `luckSeed ?? bornSeed`——种子没固定时第一次置换用**当时的 bornSeed** 起链并落盘，
     *   之后每次欧气事件（保底/置换）都从落盘的 luckSeed 接着取。
     *   所以：
     *     · luckSeed == null（还没定种子）→ 从当前 bornSeed 起抽（第一次置换会这么干）；
     *     · luckSeed != null → 从落盘的链头抽，DRAW[0] 是**下一次**欧气事件的结果，
     *       不含定种子那次置换的换果（它在链头之前，已被消耗）。
     *   合成场的「跳过已在场上的脉」与实际路线不同，结果只当参考，
     *   **以 seedChainOf（实际路线读取）为准**。
     */
    function peekLuckPool(e, s, count) {
        const out = [];
        let pair = null;
        for (const id of e.allIds) {
            if (!e.allowed.has(id) || e.quality(id) !== 4) continue;
            const low = e.allIds.find(x => e.allowed.has(x) && e.quality(x) < 4 && e.talentType(x) === e.talentType(id));
            if (low != null) { pair = { purple: Number(id), low: Number(low) }; break; }
        }
        if (!pair) return out;
        let luck = s.luckSeed != null ? Number(s.luckSeed) : Number(s.bornSeed);
        for (let i = 0; i < (count || 1); i++) {
            let r = null;
            try {
                r = e.replace({
                    bornSeed: s.bornSeed, luckSeed: luck, bornRC: s.bornRC,
                    talLucky: 0, zizhi: s.zizhi, talents: [pair.low, pair.purple],
                }, 1, [pair.low]);
            } catch (err) { break; }
            out.push(Number(r.addedId));
            luck = Number(r.state.luckSeed);
        }
        return out;
    }

    /**
     * 池子驱动执行器（使用者 2026-10 方案）。
     *
     * 和之前几版最大的区别：**先读置换脉序再动手**。
     *   · peekLuckPool() 直接读出「下一次置换会吐什么」；
     *   · 吐的是缺的目标 → 架好冲突换上去；吐的是垃圾 → 白烧推一格（也是必要的推进）；
     *   · 换完种子变了，池子也跟着变 → 每一步都重新读。
     *
     * 连换前提（使用者口径）：锁定到洗脉结束的目标紫最多 1 条，
     * 其余 3 格留给「待换紫 + 它的冲突 + 下一条的冲突」。
     */
    function planPoolDriven(raw, targets, opts) {
        opts = opts || {};
        const TG = (targets || []).map(Number);
        if (TG.length < 2 || TG.length > 4) return null;
        const budget = Number(opts.budget) || 0;
        const maxWash = Math.max(2000, Number(opts.maxWash) || 20000);
        const heldCap = Math.max(1, Number(opts.heldCap) || 1);
        const maxChain = Math.max(1, Number(opts.maxChain) || 12);
        let zi = Number(raw.zizhi) >= 154 ? 154 : 153;
        let e;
        try { e = engine(raw, zi); } catch (err) { return null; }
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let cost = 0, washes = 0, exchanges = 0, burns = 0, misses = 0;
        const held = [];
        let conflictId = null;      // 临时锁住的前置冲突脉（同类型低阶）
        const steps = [];
        const keep = () => held.map(id => s.talents.indexOf(id)).filter(i => i >= 0);
        const awaitPurple = id => {
            let okp = s.talents.includes(Number(id));
            for (let k = 0; k < 1500 && !okp; k++) {
                const r = washOne();
                okp = (r.generatedEvents || []).some(x => Number(x.id) === Number(id)) || s.talents.includes(Number(id));
                if (budget > 0 && cost > budget) break;
            }
            return okp ? Number(id) : null;
        };
        const freeSlots = () => e.slotCount - held.length;
        const canLockMore = () => held.length < heldCap;

        // 找一个「场上非目标紫 + 它前面的同类型低阶脉」
        const findPair = () => {
            for (let pi = s.talents.length - 1; pi >= 0; pi--) {
                const pid = Number(s.talents[pi]);
                if (e.quality(pid) !== 4 || TG.includes(pid) || held.includes(pid)) continue;
                for (let li = 0; li < pi; li++) {
                    const lv = Number(s.talents[li]);
                    if (e.quality(lv) < 4 && e.talentType(lv) === e.talentType(pid) && !held.includes(lv)) {
                        return { pos: pi, purple: pid, low: lv };
                    }
                }
            }
            return null;
        };

        let guard = 0;
        while (held.length < TG.length && guard++ < maxWash) {
            if (budget > 0 && cost > budget) break;
            if (zi === 153 && held.length + 1 >= e.slotCount) {
                zi = 154; e = engine(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: 154 }));
                steps.push({ type: 'upgrade', toZi: 154, washes, cost });
                continue;
            }
            // ① 先看池子下一条
            const peek = peekLuckPool(e, s, 1)[0];
            // ② 场上有没有可换的紫
            const pair = findPair();
            if (pair) {
                const locks = held.concat([pair.low]);
                if (!e.replaceablePositions(s, locks).includes(pair.pos)) { misses++; continue; }
                let r = null;
                try { r = e.replace(s, pair.pos, locks); } catch (err) { r = null; }
                if (!r) { misses++; continue; }
                const added = Number(r.addedId);
                s = r.state; exchanges++;
                const needed = TG.includes(added) && !held.includes(added);
                if (needed && canLockMore()) {
                    held.push(added);
                    steps.push({ type: 'exchange', from: pair.purple, to: added, washes, cost });
                } else {
                    burns++;
                    steps.push({ type: 'burn', from: pair.purple, to: added, washes, cost });
                }
                continue;
            }
            // ③ 没得换 → 用**前瞻窗口**精确凑场：
            //    探出「下一条紫 P」和「它同类型低阶脉最早哪洗出现」，
            //    先洗到低阶脉出现并锁住，再洗到 P 出现，然后置换。
            //    （低阶脉本来就能预测，之前只记 quality===4 才漏掉了它们。）
            {
                const win = probeWindow(e, s, keep(), 300);
                const P = (win.purples || []).find(x => !TG.includes(x.id) && !held.includes(x.id));
                if (P) {
                    const low = win.lowsByType.get(P.type);
                    let conflictLocked = false;
                    if (low && low.offset < P.offset && freeSlots() >= 1) {
                        // 洗到低阶脉出现
                        for (let k = 0; k < low.offset; k++) {
                            const rr = e.wash(s, keep());
                            s = rr.state; cost += Number(rr.cost) || 0; washes++;
                            if ((rr.generatedEvents || []).some(x => Number(x.id) === low.id)) {
                                conflictId = low.id;
                                conflictLocked = true;
                                steps.push({ type: 'lockConflict', id: low.id, forPurple: P.id, washes, cost });
                                break;
                            }
                        }
                        if (freeSlots() < 1) { conflictId = null; conflictLocked = false; }
                    }
                    // 洗到那条紫出现（锁着冲突洗，时间线会变，所以逐洗检查）
                    let appear = s.talents.includes(P.id);
                    for (let k = 0; k < 300 && !appear; k++) {
                        const rr = e.wash(s, keep());
                        s = rr.state; cost += Number(rr.cost) || 0; washes++;
                        appear = (rr.generatedEvents || []).some(x => Number(x.id) === P.id) || s.talents.includes(P.id);
                        if (budget > 0 && cost > budget) break;
                    }
                    if (appear) {
                        const pos3 = s.talents.indexOf(P.id);
                        const lowId3 = conflictId;
                        if (pos3 >= 0 && lowId3 != null && s.talents.indexOf(lowId3) >= 0
                            && s.talents.indexOf(lowId3) < pos3) {
                            const locks3 = held.concat([lowId3]);
                            if (e.replaceablePositions(s, locks3).includes(pos3)) {
                                let rr3 = null;
                                try { rr3 = e.replace(s, pos3, locks3); } catch (err) { rr3 = null; }
                                if (rr3) {
                                    const added3 = Number(rr3.addedId);
                                    s = rr3.state; exchanges++;
                                    if (TG.includes(added3) && !held.includes(added3) && canLockMore()) {
                                        held.push(added3);
                                        steps.push({ type: 'exchange', from: P.id, to: added3, washes, cost });
                                    } else {
                                        burns++;
                                        steps.push({ type: 'burn', from: P.id, to: added3, washes, cost });
                                    }
                                } else misses++;
                            } else misses++;
                        } else misses++;
                    } else misses++;
                    conflictId = null;
                    continue;
                }
            }
            // ③ 没得换 → 洗一洗（顺便收天然目标）
            const r = e.wash(s, keep());
            s = r.state; cost += Number(r.cost) || 0; washes++;
            for (const ev of (r.generatedEvents || [])) {
                const id = Number(ev.id);
                if (e.quality(id) !== 4) continue;
                if (TG.includes(id) && !held.includes(id) && canLockMore()) {
                    held.push(id);
                    steps.push({ type: 'lock', id, washes, cost });
                }
            }
        }
        const got = TG.filter(id => held.includes(id)).length;
        return {
            ok: got === TG.length, cost, washes, exchanges, burns, misses,
            field: s.talents.slice(), held: held.slice(), steps,
            got, missing: TG.filter(id => !held.includes(id)),
        };
    }

    /**
     * 前瞻窗口：用当前锁集往前模拟，把**紫脉和低阶脉**的出现位置都记下来。
     * 低阶脉当然也能预测 —— 引擎每次 wash 都会给出 generatedEvents（含白/绿/蓝），
     * 之前只看了 quality===4 的紫，把低阶脉漏掉了，所以「什么时候锁冲突」只能靠猜。
     */
    function probeWindow(e, s, keepIds, maxWashes) {
        const purples = [];
        const lowsByType = new Map();     // type → { id, offset }
        let ps = s;
        for (let k = 1; k <= (maxWashes || 300); k++) {
            let r = null;
            try { r = e.wash(ps, keepIds); } catch (err) { break; }
            ps = r.state;
            for (const ev of (r.generatedEvents || [])) {
                const id = Number(ev.id);
                if (e.quality(id) === 4) {
                    purples.push({ id, offset: k, type: e.talentType(id) });
                } else if (id !== 251) {
                    const ty = e.talentType(id);
                    if (!lowsByType.has(ty)) lowsByType.set(ty, { id, offset: k });
                }
            }
            if (purples.length >= 2) break;      // 看到两条紫就够决策了
        }
        return { purples, lowsByType };
    }

    /**
     * 排程器（使用者 2026-10 方案）：
     *   · 用**当前锁集**探窗口，紫脉和低阶脉的出现位置一起拿到；
     *   · 锁得越少、推进越快，出现位置会变（同跳脉原理）→ 所以每次锁集变化都重探；
     *   · 窗口里没出现就**往后延长再探**（使用者：没出就接着往后搜几条），直到上限。
     *
     * 一轮：读池子 → 探窗口 → 选载体紫 P → 找 P 类型的低阶脉 → 锁低阶脉 → 洗到 P → 置换
     */
    function planTimeline(raw, targets, opts) {
        opts = opts || {};
        const TG = (targets || []).map(Number);
        if (TG.length < 2 || TG.length > 4) return null;
        const budget = Number(opts.budget) || 0;
        const window0 = Math.max(60, Number(opts.window) || 240);
        const windowMax = Math.max(window0, Number(opts.windowMax) || 1200);
        const maxWash = Math.max(2000, Number(opts.maxWash) || 20000);
        const heldCap = Math.max(1, Number(opts.heldCap) || 1);
        const maxSteps = Math.max(4, Number(opts.maxSteps) || 24);
        let zi = Number(raw.zizhi) >= 154 ? 154 : 153;
        let e;
        try { e = engine(raw, zi); } catch (err) { return null; }
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let cost = 0, washes = 0, exchanges = 0, burns = 0, misses = 0;
        const held = [];
        const steps = [];
        const keep = () => held.map(id => s.talents.indexOf(id)).filter(i => i >= 0);
        const freeSlots = () => e.slotCount - held.length;
        const canLock = () => held.length < heldCap;

        const washOne = () => {
            const r = e.wash(s, keep());
            s = r.state; cost += Number(r.cost) || 0; washes++;
            return r;
        };
        const lockTargetsIn = r2 => {
            for (const ev of (r2.generatedEvents || [])) {
                const id = Number(ev.id);
                if (e.quality(id) === 4 && TG.includes(id) && !held.includes(id) && canLock()) {
                    held.push(id);
                    steps.push({ type: 'lock', id, washes, cost });
                }
            }
        };

        for (let step = 0; step < maxSteps && held.length < TG.length; step++) {
            if (budget > 0 && cost > budget) break;
            if (zi === 153 && held.length + 1 >= e.slotCount) {
                zi = 154; e = engine(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: 154 }));
                steps.push({ type: 'upgrade', toZi: 154, washes, cost });
            }
            // ① 探窗口（不够就延长）
            let win = probeWindow(e, s, keep(), window0);
            let w = window0;
            while (!(win.purples || []).some(x => !TG.includes(x.id) && !held.includes(x.id)) && w < windowMax) {
                w = Math.min(windowMax, w * 2);
                win = probeWindow(e, s, keep(), w);
            }
            const P = (win.purples || []).find(x => !TG.includes(x.id) && !held.includes(x.id));
            if (!P) {
                // 窗口里没有紫：洗一段再探（低锁时会更快出）
                const r0 = washOne(); lockTargetsIn(r0);
                if (budget > 0 && cost > budget) break;
                continue;
            }
            // ② 先锁 P 类型的低阶脉（若在 P 之前出现）
            const low = win.lowsByType.get(P.type);
            let conflict = null;
            if (low && low.offset < P.offset && freeSlots() >= 1) {
                for (let k = 0; k < low.offset; k++) {
                    const rr = washOne();
                    lockTargetsIn(rr);
                    if ((rr.generatedEvents || []).some(x => Number(x.id) === low.id)) { conflict = low.id; break; }
                }
                if (conflict != null) steps.push({ type: 'lockConflict', id: conflict, forPurple: P.id, washes, cost });
            }
            // ③ 洗到 P 出现（锁集变了，时间线会变 → 逐洗检查，超了再延长）
            let appear = s.talents.includes(P.id);
            let guard = 0;
            while (!appear && guard++ < windowMax) {
                const rr = washOne();
                lockTargetsIn(rr);
                appear = (rr.generatedEvents || []).some(x => Number(x.id) === P.id) || s.talents.includes(P.id);
                if (budget > 0 && cost > budget) break;
            }
            // ④ 置换
            if (appear) {
                const pos = s.talents.indexOf(P.id);
                const locks = conflict != null ? held.concat([conflict]) : held.slice();
                if (pos >= 0 && e.replaceablePositions(s, locks).includes(pos)) {
                    let rr = null;
                    try { rr = e.replace(s, pos, locks); } catch (err) { rr = null; }
                    if (rr) {
                        const added = Number(rr.addedId);
                        s = rr.state; exchanges++;
                        if (TG.includes(added) && !held.includes(added) && canLock()) {
                            held.push(added);
                            steps.push({ type: 'exchange', from: P.id, to: added, washes, cost });
                        } else {
                            burns++;
                            steps.push({ type: 'burn', from: P.id, to: added, washes, cost });
                        }
                    } else misses++;
                } else misses++;
            } else misses++;
        }
        const got = TG.filter(id => held.includes(id)).length;
        return {
            ok: got === TG.length, cost, washes, exchanges, burns, misses,
            field: s.talents.slice(), held: held.slice(), steps,
            got, missing: TG.filter(id => !held.includes(id)),
        };
    }

    /**
     * 按「萧佩吟方案」的骨架执行，**n（载体紫的垫洗次数）是唯一搜索维度**。
     *
     * 骨架（使用者提供的四条参考方案提炼）：
     *   ① 洗到「低阶脉 L + 同类型载体紫 P」能凑上的局面：**先锁 L，再洗到 P**
     *      （低阶脉比紫多得多，先锁低阶脉才凑得成；反过来经常失手）
     *   ② 锁 P → 垫洗 n 次 → 解锁 P（留 L）→ 置换 P   ← 这一步写种子，决定整条池子
     *   ③ 全解锁 → 洗到第一个天然目标 → 锁 → 开第 4 槽
     *   ④ 循环：找下一条非目标紫 P → 锁 P 类型的低阶脉 → 洗到 P → 置换
     *      换出目标就锁（最多锁 3 条），否则当白烧继续
     *   ⑤ 收尾：锁住 3 条目标后，洗到最后一个目标（天然）
     */
    function nSeedPlanOnce(raw, targets, n, opts) {
        const a = Math.max(0, Number(opts && opts.startWash) || 0);
        const TG = (targets || []).map(Number);
        const budget = Number(opts && opts.budget) || 0;
        const maxWash = Number(opts && opts.maxWash) || 12000;
        let zi = 153;
        let e;
        try { e = engine(raw, zi); } catch (err) { return null; }
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let cost = 0, washes = 0, exchanges = 0, burns = 0;
        const held = [];
        const steps = [];
        let conflictHold = null;          // 已锁住的冲突脉（必须进 keep，否则下一洗就冲掉）
        let carrierHold = null;           // 垫洗期间必须锁住载体紫，否则 n 洗之后就冲掉了
        const keep = () => held
            .concat(conflictHold == null ? [] : [conflictHold])
            .concat(carrierHold == null ? [] : [carrierHold])
            .map(id => s.talents.indexOf(id)).filter(i => i >= 0);
        const freeSlots = () => e.slotCount - held.length;
        const washOne = () => { const r = e.wash(s, keep()); s = r.state; cost += Number(r.cost) || 0; washes++; return r; };
        const lockIfTarget = r => {
            for (const ev of ((r && r.generatedEvents) || [])) {
                const id = Number(ev.id);
                if (e.quality(id) === 4 && TG.includes(id) && !held.includes(id) && held.length < 3) {
                    held.push(id); steps.push({ type: 'lock', id, washes, cost });
                    return true;
                }
            }
            return false;
        };
        /** 探窗口：下一条非目标紫 + 它类型的低阶脉 */
        const probe = (maxW) => {
            let ps = s; const kk = keep();
            // ⚠ 场上**当前已有**的低阶脉也算（参考方案用的就是场上的「筋骨坚实」，
            //   它不在未来窗口里，offset 记 0）。漏掉这一步会让每一条紫都找不到冲突。
            const lows = s.talents.map((id, idx) => {
                const v = Number(id);
                if (e.quality(v) >= 4 || v === 251 || held.includes(v)) return null;
                return { id: v, type: e.talentType(v), offset: 0, onField: true };
            }).filter(Boolean);
            const purples = [];   // 窗口内所有紫脉
            for (let k = 1; k <= maxW; k++) {
                let r = null;
                try { r = e.wash(ps, kk); } catch (err) { break; }
                ps = r.state;
                for (const ev of (r.generatedEvents || [])) {
                    const id = Number(ev.id);
                    if (e.quality(id) === 4) {
                        if (!TG.includes(id) && !held.includes(id)) purples.push({ id, type: e.talentType(id), offset: k });
                    } else if (id !== 251) {
                        lows.push({ id, type: e.talentType(id), offset: k });
                    }
                }
                if (purples.length && k > purples[0].offset + 120) break;
            }
            // 选「能凑成对」的那条紫：它类型的低阶脉必须**排在它前面**
            for (const pu of purples) {
                const lo = lows.find(x => x.type === pu.type && x.offset < pu.offset);
                if (lo) return { purple: pu, low: lo };
            }
            return { purple: purples[0] || null, low: null };
        };

        // ⓪ 起始空洗 a 次（参考方案：先空洗 131 手，让局面自己凑出合适的低阶脉）
        for (let k = 0; k < a; k++) { washOne(); if (budget > 0 && cost > budget) break; }
        if (a > 0) steps.push({ type: 'startWash', count: a, washes, cost });
        const dbg = {};
        // ① 第一次：先锁低阶脉、再洗到载体紫、垫洗 n、置换
        {
            const w = probe(400);
            dbg.purple = w.purple && w.purple.id; dbg.low = w.low && w.low.id; dbg.lowOff = w.low && w.low.offset;
            if (w.purple) {
                // 冲突脉**已经在场上**时直接用它（offset=0，否则下面的 for 一次都不执行，conflict 永远是 null）
                let conflict = (w.low && (w.low.onField || w.low.offset === 0)) ? w.low.id : null;
                if (conflict != null) conflictHold = conflict;   // 先锁上，洗向紫的途中才不会掉
                if (conflict == null && w.low && w.low.offset < w.purple.offset) {
                    for (let k = 0; k < w.low.offset; k++) {
                        const r = washOne(); lockIfTarget(r);
                        if ((r.generatedEvents || []).some(x => Number(x.id) === w.low.id)) { conflict = w.low.id; break; }
                    }
                }
                let appear = s.talents.includes(w.purple.id);
                for (let k = 0; k < 300 && !appear; k++) {
                    const r = washOne(); lockIfTarget(r);
                    appear = (r.generatedEvents || []).some(x => Number(x.id) === w.purple.id) || s.talents.includes(w.purple.id);
                    if (budget > 0 && cost > budget) break;
                }
                dbg.conflict = conflict; dbg.appear = appear;
                // ⚠ 这里**不能**解锁冲突脉：垫洗 n 手里它会一直锁着，否则垫完就不在场了，
                //   置换直接失败（之前 0 次置换就是这个原因）。
                if (appear) {
                    // 锁载体紫 → 垫洗 n → 解锁载体紫（留冲突）→ 置换
                    carrierHold = w.purple.id;    // ★ 关键：垫洗期间必须锁住它
                    for (let k = 0; k < Math.max(0, n); k++) { washOne(); }
                    carrierHold = null;           // 解锁载体紫（冲突仍锁着）
                    if (conflict != null) conflictHold = conflict;
                    const pos = s.talents.indexOf(w.purple.id);
                    const locks = conflict != null ? held.concat([conflict]) : held.slice();
                    if (pos >= 0 && e.replaceablePositions(s, locks).includes(pos)) {
                        let r = null;
                        try { r = e.replace(s, pos, locks); } catch (err) { r = null; }
                        if (r) {
                            const added = Number(r.addedId);
                            s = r.state; exchanges++;
                            if (TG.includes(added) && !held.includes(added) && held.length < 3) held.push(added);
                            else burns++;
                            steps.push({ type: 'exchange', from: w.purple.id, to: added, washes, cost, first: true });
                            conflictHold = null;
                        }
                    }
                }
            }
        }
        // ③ 全解锁，洗到第一个天然目标
        held.length = 0;
        for (let k = 0; k < 900; k++) {
            const r = washOne();
            if (lockIfTarget(r)) break;
            if (budget > 0 && cost > budget) break;
        }
        // 开第 4 槽
        if (zi === 153) {
            zi = 154; e = engine(raw, zi);
            s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
        }
        // ④ 循环：锁冲突 → 洗到紫 → 置换
        for (let round = 0; round < 12 && held.length < TG.length; round++) {
            if (budget > 0 && cost > budget) break;
            const w = probe(300);
            if (!w.purple) { const r = washOne(); lockIfTarget(r); continue; }
            let conflict = null;
            const fieldLow = s.talents.map(Number).find((v, i) => {
                return e.quality(v) < 4 && e.talentType(v) === w.purple.type && !held.includes(v)
                    && i < s.talents.length;
            });
            if (fieldLow != null) conflict = fieldLow;
            else if (w.low && w.low.offset < w.purple.offset) {
                for (let k = 0; k < w.low.offset; k++) {
                    const r = washOne();
                    if ((r.generatedEvents || []).some(x => Number(x.id) === w.low.id)) { conflict = w.low.id; break; }
                }
            }
            let appear = s.talents.includes(w.purple.id);
            for (let k = 0; k < 260 && !appear; k++) {
                const r = washOne(); lockIfTarget(r);
                appear = (r.generatedEvents || []).some(x => Number(x.id) === w.purple.id) || s.talents.includes(w.purple.id);
                if (budget > 0 && cost > budget) break;
            }
            if (!appear || conflict == null) { burns++; continue; }
            const pos = s.talents.indexOf(w.purple.id);
            const locks = held.concat([conflict]);
            if (pos < 0 || !e.replaceablePositions(s, locks).includes(pos)) { burns++; continue; }
            let r = null;
            try { r = e.replace(s, pos, locks); } catch (err) { r = null; }
            if (!r) { burns++; continue; }
            const added = Number(r.addedId);
            s = r.state; exchanges++;
            if (TG.includes(added) && !held.includes(added) && held.length < 3) {
                held.push(added);
                steps.push({ type: 'exchange', from: w.purple.id, to: added, washes, cost });
            } else { burns++; steps.push({ type: 'burn', from: w.purple.id, to: added, washes, cost }); }
        }
        // ⑤ 收尾：洗到最后一个目标
        for (let k = 0; k < 1200 && held.length < TG.length; k++) {
            const r = washOne();
            if (lockIfTarget(r)) { }
            if (budget > 0 && cost > budget) break;
        }
        const got = TG.filter(id => held.includes(id)).length;
        return { ok: got === TG.length, cost, washes, exchanges, burns, got, dbg,
            field: s.talents.slice(), held: held.slice(), steps,
            missing: TG.filter(id => !held.includes(id)), n };
    }

    /** 枚举 n，取最省且四目标齐的那条。 */
    function nSeedPlan(raw, targets, opts) {
        opts = opts || {};
        const nMax = Math.max(0, Number(opts.nMax) || 40);
        const nStep = Math.max(1, Number(opts.nStep) || 1);
        let best = null;
        const tried = [];
        for (let n = 0; n <= nMax; n += nStep) {
            const r = nSeedPlanOnce(raw, targets, n, opts);
            if (!r) continue;
            tried.push({ n, ok: r.ok, cost: r.cost, got: r.got });
            if (r.ok && (!best || r.cost < best.cost)) best = r;
        }
        if (best) best.tried = tried;
        return best || { ok: false, tried, note: '所有 n 都没凑齐四个目标' };
    }

    /** a（起始空洗）× n（垫洗）二维枚举，取最省的完整方案。 */
    function anSeedPlan(raw, targets, opts) {
        opts = opts || {};
        const aMax = Math.max(0, Number(opts.aMax) || 200);
        const aStep = Math.max(1, Number(opts.aStep) || 10);
        const nMax = Math.max(0, Number(opts.nMax) || 40);
        const nStep = Math.max(1, Number(opts.nStep) || 1);
        const deadline = Date.now() + Math.max(2000, Number(opts.timeMs) || 90000);
        let best = null;
        const tried = [];
        for (let a = 0; a <= aMax; a += aStep) {
            for (let n = 0; n <= nMax; n += nStep) {
                if (Date.now() > deadline) break;
                const r = nSeedPlanOnce(raw, targets, n, Object.assign({}, opts, { startWash: a }));
                if (!r) continue;
                tried.push({ a, n, ok: r.ok, cost: r.cost, got: r.got });
                if (r.ok && (!best || r.cost < best.cost)) best = Object.assign({ a }, r);
            }
            if (Date.now() > deadline) break;
        }
        if (best) { best.tried = tried; return best; }
        return { ok: false, tried, note: 'a×n 全枚举都没凑齐四个目标' };
    }

    /**
     * 池子定位执行器（使用者 2026-10 思路）。
     *
     * 一句话：**种子定下后，池子里目标的位置是固定的**，执行器只需
     * ① 洗到三个载体紫 / 收尾脉；② 在载体紫上「烧掉垃圾、落到目标」。
     * 成本只由「洗到载体」决定，置换与毁脉都是 0 丹。
     *
     * 与之前贪心版的关键区别：**换不换由池子决定** ——
     *   池子下一条是缺的目标才换；不是就洗过去（不浪费载体、不浪费槽位）。
     */
    function poolPlanOnce(raw, targets, n, opts) {
        opts = opts || {};
        const startA = Math.max(0, Number(opts.startWash) || 0);
        const midCap = Math.max(1, Number(opts.midCap) || 2);        // 中段最多锁几条目标
        const releaseFirst = !!opts.releaseFirst;                   // 第一次置换的目标是否释放
        const TG = (targets || []).map(Number);
        // ★ 四目标里有一条是**收尾脉**：它前面出现的同名额脉只是普通紫，不能锁。
        //   只有其余三条「非收尾目标」才需要在前面锁定。
        const tailId = Number(opts.tailId) || null;
        const lockSet = tailId ? TG.filter(x => x !== tailId) : TG.slice();
        // ★ 收尾脉（除神脉）在它最终位置之前的**原始脉序或置换链**里出现，都视为普通脉（非目标）
        const isPoolTarget = id => TG.includes(Number(id)) && Number(id) !== tailId;
        const budget = Number(opts.budget) || 0;
        const maxWash = Number(opts.maxWash) || 12000;
        // ★ 第三种改种子手段：保底紫前开槽重掷（换 bornSeed → 保底紫与欧气链重排）
        const openSlotAt = opts.openSlotAt == null ? null : Math.max(0, Number(opts.openSlotAt));
        // ★ 跳脉法模式：锚定保底紫/种子之前禁用无限置换（见 jumpMethodPolicy）
        const jumpAnchor = !!opts.jumpAnchor;
        // ★ 推进链（使用者口径）：3 可洗槽时可「原地连续置换」不停推进置换脉序；
        //   2 可洗槽只能推进一条；冲突是神脉时可多推进一条。
        const advanceChain = opts.advanceChain !== false;
        let anchored = !jumpAnchor;
        let zi = Number(opts.startZi) === 154 ? 154 : 153;
        let e;
        try { e = engine(raw, zi); } catch (err) { return null; }
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let cost = 0, washes = 0, exchanges = 0, burns = 0, advances = 0;
        // ★ 术语区分（使用者口径）：
        //   · 推进置换脉序 advances：在**同一个紫脉位置**上连续置换（紫位还在，只是脉序前进一格）
        //   · 毁脉 burns：**放弃这个紫位**（不再在它上面置换，换出来的东西也不保留）
        let lastExchangePos = -1;
        const noteExchange = (pos, kept) => {
            exchanges++;
            if (pos === lastExchangePos) advances++;        // 同一紫位连续换 = 推进脉序
            else if (!kept) burns++;                        // 换完放弃这个紫位 = 毁脉
            lastExchangePos = pos;
        };
        const held = [];
        const steps = [];
        let conflictHold = null, carrierHold = null;
        const dbg = [];
        let wantType = null;
        let stopChainHere = false;   // A/B 判定：该在该非目标脉上停链毁脉   // 「跳过的那条紫」的类型：下次该类型的低阶脉一出现就锁住，等下一次同类型紫
        // ★ 使用者口径：脉序里的位置只是显示上的重排，不影响实际操作。
        //   所以置换前把「冲突脉」与「紫脉」在数组里对调即可（等价于游戏里的自动换位）。
        const orderForReplace = (st, purpleId, conflictId) => {
            const pi = st.talents.indexOf(purpleId);
            const ci = st.talents.indexOf(conflictId);
            if (pi < 0 || ci < 0 || ci < pi) return st;
            const t = st.talents.slice();
            t[pi] = conflictId; t[ci] = purpleId;
            return Object.assign({}, st, { talents: t });
        };
        const keep = () => held.concat(conflictHold == null ? [] : [conflictHold])
            .concat(carrierHold == null ? [] : [carrierHold])
            .map(id => s.talents.indexOf(id)).filter(i => i >= 0);
        // ★ 连续置换（原地推进脉序）——独立脚本已验证：薛龙城可连做 9 次到混元奇脉
        // ★ 连续置换（严格按使用者图示）：
        //   [冲突A(锁)][紫P1(锁)][普通脉]
        //   → 第③格洗出「P2 的冲突 B」并锁定
        //   → 置换 P1（用 A 当冲突）→ P1 变 P2
        //   → 角色互换：解锁 A，锁住 P2，B 就是 P2 的冲突
        //   → 洗出 P3 的冲突 C …如此循环（位置无影响）
        const runAdvanceChain = startId => {
            let curId = startId;
            const typeOf = id => e.talentType(Number(id));
            const lowOfType = (ty, beforeId) => nearestLowOfTypeInField(e, s.talents, ty, beforeId);
            let done = 0;
            for (let step = 0; step < 12; step++) {
                if (curId == null || !s.talents.includes(curId)) break;
                // ① 当前紫的冲突
                let confId = lowOfType(typeOf(curId), curId);
                if (confId == null) break;
                conflictHold = confId; carrierHold = curId;
                // ② 预先洗出「池子下一条紫」的冲突脉并锁定（关键：提前锁）
                let nxType = null, preloaded = null;
                try { const nx = peekN(1); if (nx.length) nxType = typeOf(nx[0].id); } catch (err) { }
                if (nxType != null) {
                    preloaded = lowOfType(nxType);
                    for (let k = 0; k < 60 && preloaded == null; k++) {
                        const rr = washOne(); lockTargetIn(rr);
                        if (!s.talents.includes(curId)) break;
                        preloaded = lowOfType(nxType);
                        if (budget > 0 && cost > budget) break;
                    }
                }
                if (!s.talents.includes(curId)) break;
                // ③ 置换（用当前紫的冲突）
                const s2 = orderForReplace(s, curId, confId);
                const pos2 = s2.talents.indexOf(curId);
                const locks2 = Array.from(new Set(held.concat([confId])));
                if (pos2 < 0 || !e.replaceablePositions(s2, locks2).includes(pos2)) break;
                let rr2 = null;
                try { rr2 = e.replace(s2, pos2, locks2); } catch (err) { break; }
                const added = Number(rr2.addedId);
                s = rr2.state;
                const keep2 = isPoolTarget(added) && !held.includes(added) && held.length < 3;
                if (keep2) held.push(added);
                noteExchange(pos2, keep2);
                steps.push({ type: 'exchange', locks: locks2, field: s.talents.slice(),
                    from: curId, to: added, washes, cost, chain: true, advance: !keep2, kept: keep2 });
                done++;
                curId = added;
                // ④ 角色互换：旧冲突解锁，新紫与「预载的冲突」接管
                conflictHold = preloaded;
                carrierHold = added;
                if (keep2) break;
                if (budget > 0 && cost > budget) break;
            }
            return done;
        };
        const freeSlots = () => e.slotCount - held.length;
        const washOne = () => { const r = e.wash(s, keep()); s = r.state; cost += Number(r.cost) || 0; washes++; return r; };
        let freeTargets = 0;   // ★ 保底位上白捡到的目标数（= 多出来的槽位）
        const lockTargetIn = r => {
            for (const ev of ((r && r.generatedEvents) || [])) {
                const id = Number(ev.id);
                if (e.quality(id) === 4 && lockSet.includes(id) && !held.includes(id) && held.length < midCap) {
                    held.push(id);
                    if (ev && ev.fromPity) freeTargets++;   // 这条是保底紫直接给的目标
                    steps.push({ type: 'lock', locks: held.concat(conflictHold==null?[]:[conflictHold]), field: s.talents.slice(), id, washes, cost, fromPity: !!(ev && ev.fromPity) }); return true;
                }
            }
            return false;
        };
        /** 探窗口：下一条非目标紫 + 能凑上的低阶脉（场上或未来） */
        const probe = maxW => {
            let ps = s; const kk = keep();
            const lows = s.talents.map(id => {
                const v = Number(id);
                if (e.quality(v) >= 4 || v === 251 || held.includes(v)) return null;
                return { id: v, type: e.talentType(v), offset: 0, onField: true };
            }).filter(Boolean);
            const purples = [];
            for (let k = 1; k <= Math.max(maxW, 400); k++) {
                let r = null;
                try { r = e.wash(ps, kk); } catch (err) { break; }
                ps = r.state;
                for (const ev of (r.generatedEvents || [])) {
                    const id = Number(ev.id);
                    if (e.quality(id) === 4) { if (!held.includes(id)) purples.push({ id, type: e.talentType(id), offset: k, isTarget: TG.includes(id) }); }
                    else if (id !== 251) lows.push({ id, type: e.talentType(id), offset: k });
                }
                // 收集到 3 条紫（或扫满 400 洗）再决策：
                //   第 1 条紫常常「冲突还没出现」，第 2、3 条才有——只看第一条会漏掉可换的。
                if (purples.length >= 3) break;
            }
            const first = purples[0] || null;
            // ★ 使用者规则：冲突脉永远选「紫脉前面、离紫脉最近」的那条。
            //   锁得越早，锁着洗的时间越长（推进变慢、单价变高），所以取 offset 最大的那个。
            // ★ 允许「冲突脉和紫在**同一洗**出现」（offset 相等）：595 记录的 527 洗就是
            //   刀法宗师 + 刀法绝伦 同时在场，锁上冲突立刻能换。之前用 `<` 把这种最优解排除了，
            //   只能退而求其次选 +99 那条远的刀法宗师。
            const low = first ? (lows.filter(x => x.type === first.type && x.offset <= first.offset)
                .sort((a, b) => b.offset - a.offset)[0] || null) : null;
            return { purple: first, low, purples, lows };
        };
        /** 读池子下一条（用当前 luckSeed，不耗丹） */
        const peek = () => {
            let pair = null;
            for (const id of e.allIds) {
                if (!e.allowed.has(id) || e.quality(id) !== 4) continue;
                const low = e.allIds.find(x => e.allowed.has(x) && e.quality(x) < 4 && e.talentType(x) === e.talentType(id));
                if (low != null) { pair = { purple: Number(id), low: Number(low) }; break; }
            }
            if (!pair) return null;
            let luck = Number(s.luckSeed) || 0;
            try {
                const r = e.replace({ bornSeed: s.bornSeed, luckSeed: luck, bornRC: s.bornRC, talUckyUnused: 0,
                    talLucky: 0, zizhi: s.zizhi, talents: [pair.low, pair.purple] }, 1, [pair.low]);
                return { id: Number(r.addedId), next: Number(r.state.luckSeed) };
            } catch (err) { return null; }
        };

        // 往后看 k 条置换脉（用同一套 pair 推演，只推进池子、不动场上）
        const peekN = k => {
            const out = [];
            let luck = Number(s.luckSeed) || 0;
            for (let step = 0; step < k; step++) {
                let pair = null;
                for (const id of e.allIds) {
                    if (!e.allowed.has(id) || e.quality(id) !== 4) continue;
                    const low = e.allIds.find(x => e.allowed.has(x) && e.quality(x) < 4 && e.talentType(x) === e.talentType(id));
                    if (low != null) { pair = { purple: Number(id), low: Number(low) }; break; }
                }
                if (!pair) break;
                try {
                    const r = e.replace({ bornSeed: s.bornSeed, luckSeed: luck, bornRC: s.bornRC, talUckyUnused: 0,
                        talLucky: 0, zizhi: s.zizhi, talents: [pair.low, pair.purple] }, 1, [pair.low]);
                    out.push({ id: Number(r.addedId) });
                    luck = Number(r.state.luckSeed);
                } catch (err) { break; }
            }
            return out;
        };
        // ⓪ 起始空洗（参考方案先空洗 131 手，等局面凑出合适的低阶脉）
        for (let k = 0; k < startA; k++) { washOne(); if (budget > 0 && cost > budget) break; }
        if (startA > 0) steps.push({ type: 'startWash', locks: held.concat(conflictHold==null?[]:[conflictHold]), field: s.talents.slice(), count: startA, washes, cost });
        // ★ 保底紫前开槽重掷：0 锁洗到 openSlotAt，然后开第 4 槽（换 bornSeed，重排保底紫与欧气链）
        if (openSlotAt != null && openSlotAt >= washes) {
            const need = Math.max(0, openSlotAt - washes);
            for (let k = 0; k < need && washes < maxWash; k++) { washOne(); if (budget > 0 && cost > budget) break; }
            zi = 154;
            try { e = engine(raw, zi); } catch (err) { return null; }
            s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
            steps.push({ type: 'upgrade', locks: [], field: s.talents.slice(), toZi: zi, washes, cost, reroll: true });
            anchored = true;      // 槽位一换，保底紫与欧气链就定下来了
            // ★ 使用者口径：**开槽之后不能再洗**（有就是有没有就是没有）。
            //   所以开槽这一刻先看场上：如果有「下一条紫的同类型低阶脉」，立刻锁（0 洗）；
            //   没有就说明这个开槽点不合适（由外层搜索换点）。
            try {
                const nw0 = probe(300);
                if (nw0.purple) {
                    const onFieldLow = s.talents.map(Number).find(v => e.quality(v) < 4 && v !== 251 &&
                        e.talentType(v) === e.talentType(nw0.purple.id) && !held.includes(v));
                    if (onFieldLow != null) {
                        conflictHold = onFieldLow;
                        steps.push({ type: 'lockConflict', id: onFieldLow, forPurple: nw0.purple.id, locks: held.slice(), field: s.talents.slice(), washes, cost, atReroll: true });
                    }
                }
            } catch (err) { }
        }
        // ① 第一次置换：锁冲突 → 洗到载体紫 → 垫洗 n → 换
        {
            const w = probe(300);
            if (w.purple) {
                let conflict = (w.low && (w.low.onField || w.low.offset === 0)) ? w.low.id : null;
                if (conflict != null) conflictHold = conflict;
                let appear = s.talents.includes(w.purple.id);
                for (let k = 0; k < 300 && !appear; k++) {
                    const r = washOne(); lockTargetIn(r);
                    appear = (r.generatedEvents || []).some(x => Number(x.id) === w.purple.id) || s.talents.includes(w.purple.id);
                    if (budget > 0 && cost > budget) break;
                }
                if (appear && conflict != null) {
                    carrierHold = w.purple.id;
                    steps.push({ type: 'lock', id: w.purple.id, locks: held.concat(conflict == null ? [] : [conflict]),
                        field: s.talents.slice(), washes, cost, carrier: true });
                    for (let k = 0; k < Math.max(0, n); k++) washOne();
                    carrierHold = null;
                    steps.push({ type: 'unlock', id: w.purple.id, locks: held.concat(conflict == null ? [] : [conflict]).concat([w.purple.id]),
                        field: s.talents.slice(), washes, cost, carrier: true });
                    const pos = s.talents.indexOf(w.purple.id);
                    const locks = Array.from(new Set(held.concat([conflict])));
                    if (pos >= 0 && e.replaceablePositions(s, locks).includes(pos)) {
                        let r = null;
                        try { r = e.replace(s, pos, locks); } catch (err) { r = null; }
                        if (r) {
                            const added = Number(r.addedId);
                            noteExchange(pos, TG.includes(added) && !releaseFirst && held.length < midCap);
                            s = r.state;
                            // 毁脉口径：换出来的东西**不保留**（释放/不是目标）= 放弃一个原始紫位置
                            if (isPoolTarget(added) && !held.includes(added) && !releaseFirst && held.length < midCap) held.push(added);
                            steps.push({ type: 'exchange', locks: held.concat([conflict]), field: s.talents.slice(), from: w.purple.id, to: added, washes, cost, first: true, released: releaseFirst });
                            // ★ 第一次置换后：如果保留置换机器（releaseFirst=false），立刻接管做连续置换
                            if (advanceChain && !releaseFirst) {
                                const ty0 = e.talentType(added);
                                const conf0 = s.talents.map(Number).find(v => e.quality(v) < 4 && v !== 251 && e.talentType(v) === ty0) || null;
                                const cont = (conf0 != null) ? added : (conf0 == null && s.talents.includes(added) ? added : null);
                                if (cont != null) runAdvanceChain(cont);
                                // ★ 使用者口径（薛龙城四紫.txt 第 13 步）：连续置换结束后
                                //   **全部解锁**（「当前未锁定任何脉」），0 锁洗更快、单价更低，
                                //   靠后面的锚点天然把剩下的目标洗出来，最后再收尾。
                                if (held.length >= 1) {
                                    held.length = 0;
                                    conflictHold = null;
                                    carrierHold = null;
                                    steps.push({ type: 'unlockAll', locks: [], field: s.talents.slice(), washes, cost, afterChain: true });
                                }
                            }
                        }
                    }
                }
                conflictHold = null;
            }
        }
        // ①.5 第一次置换后是否**全部解锁**：
        //   · 萧佩吟路线：换出的是目标/收尾脉，换完 0 锁洗更快 → 全解锁；
        //   · 薛龙城路线：换完要在**同一个紫位上继续推进脉序**，
        //     全解锁会把「非目标紫 + 它的冲突脉」这台置换机器拆掉 → 不能解锁。
        // 萧佩吟口径 releaseFirst=true（第一次换出的目标/收尾脉先放掉，0 锁洗更快）→ 全解锁；
        // 薛龙城口径 releaseFirst=false（要保留置换机器继续推进）→ 不解锁。
        if (releaseFirst) {
            held.length = 0;
            conflictHold = null;
            carrierHold = null;
            steps.push({ type: 'unlockAll', locks: [], field: s.talents.slice(), washes, cost });
        }
        // ② 主循环：按池子决定换不换
        for (let round = 0; round < 40 && held.length < lockSet.length; round++) {
            if (budget > 0 && cost > budget) break;
            // ★ 使用者口径：**锁定第一条目标紫后就开第 4 槽**（这里没有保底紫干扰）。
            //   593 洗的参考记录里，354 洗锁玄阳后下一行就已经是 4 槽（每洗 6 丹）。
            if (zi === 153 && held.length >= 1) {
                zi = 154; e = engine(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                steps.push({ type: 'upgrade', locks: held.concat(conflictHold==null?[]:[conflictHold]), field: s.talents.slice(), toZi: zi, washes, cost });
            }
            // ★ 使用者口径（最简单高效的排查方式）：
            //   在当前锁集下**一路洗到出紫**，把沿途所有脉都记下来，
            //   然后取「离这条紫最近的那一条同类型低阶脉（白绿蓝皆可）」当冲突脉。
            const w = probe(300);
            if (!w.purple) { const r = washOne(); lockTargetIn(r); continue; }
            const P = w.purple;
            // 天然出现的「非收尾目标」：洗过去锁上（它不是载体，不需要换）
            if (lockSet.includes(P.id)) {
                let appear = s.talents.includes(P.id);
                for (let k = 0; k < 320 && !appear; k++) {
                    const r = washOne();
                    appear = (r.generatedEvents || []).some(x => Number(x.id) === P.id) || s.talents.includes(P.id);
                    if (appear) lockTargetIn(r);
                    if (budget > 0 && cost > budget) break;
                }
                continue;
            }
            // ★ 接入跳脉法判据：锚定前不许置换，只能「锁非收尾目标」或「毁脉」
            let policy = null;
            try { policy = jumpMethodPolicy(P.id, { anchored, tailId, targets: TG, held }); } catch (err) { policy = null; }
            if (policy && !policy.exchange) {
                if (policy.lock && lockSet.includes(P.id) && !held.includes(P.id) && held.length < midCap) {
                    let appear = s.talents.includes(P.id);
                    for (let k = 0; k < 320 && !appear; k++) {
                        const r = washOne();
                        appear = (r.generatedEvents || []).some(x => Number(x.id) === P.id) || s.talents.includes(P.id);
                        if (appear) lockTargetIn(r);
                        if (budget > 0 && cost > budget) break;
                    }
                } else {
                    // 毁脉：洗过这条紫（放弃这个原始紫位置）
                    steps.push({ type: 'destroy', id: P.id, locks: held.slice(), field: s.talents.slice(), washes, cost });
                    for (let k = 0; k < 320; k++) {
                        const r = washOne();
                        if ((r.generatedEvents || []).some(x => Number(x.id) === P.id)) break;
                        if (budget > 0 && cost > budget) break;
                    }
                }
                continue;
            }
            const pk = peek();
            const needIt = pk && isPoolTarget(pk.id) && !held.includes(pk.id);
            try { dbg.push({ round, wash: washes, cost, purple: P.id, pOff: P.offset, peek: pk && pk.id, needIt, lowId: w.low && w.low.id, lowOff: w.low && w.low.offset, held: held.slice() }); } catch (e) {}
            // ★ 毁脉判据：池子下一条不是缺的目标，但**毁掉一条**之后就轮到缺的目标 → 就毁
            // ★ 毁脉推进：池子里「缺的目标」在第 d 格（d ≤ 4）时就值得毁，一直毁到它出现
            // ★ 连续置换的前提（使用者口径）：
            //   欧气种子已固定，且**可洗槽 ≥ 3**（总槽数 − 已锁目标数；
            //   锁着的非目标紫与它的冲突脉不占这个额度，它们是置换机器本身）。
            //   ≥3 时可连续推进；只有 2 时可推进一条。
            const canChain = (e.slotCount - held.length) >= 3;
            // ★ A/B 成本比较（使用者口径）：
            //   如果置换脉序的**下面两条都是目标**，就不要继续换进去 ——
            //   那两条各要占一个紫槽、还得靠锚点洗出来，成本比「现在这条非目标主动毁脉」高。
            //   所以：在非目标脉上主动毁脉停链，让后面两条天然洗出来。
            try {
                const nx2 = peekN(2);
                if (nx2.length >= 2 && isPoolTarget(nx2[0].id) && isPoolTarget(nx2[1].id)
                    && !held.includes(nx2[0].id) && !held.includes(nx2[1].id)) {
                    // 还要确认：这两条在**原始脉序**里都拿不到（必须靠置换出来），才值得在这里停链
                    let nat = { purples: [] };
                    try { nat = probe(600); } catch (err) { }
                    const inNatural = id => (nat.purples || []).some(pp => Number(pp.id) === Number(id));
                    if (!inNatural(nx2[0].id) && !inNatural(nx2[1].id)) stopChainHere = true;
                }
            } catch (err) { }
            const chainMax = canChain ? 8 : 1;
            let burnFor = null, burnDepth = 0;
            if (stopChainHere) { burnFor = null; }
            else if (!needIt) {
                const nx = peekN(chainMax);
                const idx = nx.findIndex(x => isPoolTarget(x.id) && !held.includes(x.id));
                if (idx >= 0) { burnFor = nx[idx].id; burnDepth = idx + 1; }
            }
            if (!needIt && !burnFor) {               // 毁也不划算 → 洗过去（不浪费载体）
                wantType = P.type;                   // 记住这个类型：下次它的低阶脉出现就先锁上
                for (let k = 0; k < 320; k++) {
                    const r = washOne();
                    if ((r.generatedEvents || []).some(x => Number(x.id) === P.id)) break;
                    if (budget > 0 && cost > budget) break;
                }
                continue;
            }
            // ★ 使用者口径（595 记录实测）：锁冲突脉的提前量 ≈ 30~40 洗
            //   （132 锁/142 出紫 = 10 洗；379 锁/391 出紫 = 12 洗；494 锁/527 出紫 = 33 洗）。
            //   太早锁（实测 109 洗）会让 3 锁持续太久，紫被推后 60 洗、白烧 400+ 丹。
            //   所以：最近的冲突脉若离紫 > 40 洗，**先不锁** —— 往前洗到「紫前 35 洗」再重扫。
            // ★ 使用者口径：置换结束后，**场上原有的冲突脉**要跟下一条置换脉序比对；
            //   如果它正好是下一条紫的冲突类型，可以直接保留（不用解锁、不用再洗），
            //   它甚至可能同时是某条原始紫的最近冲突脉。
            //   所以候选里「已在场上」的那条要**优先**（offset 0 且现成）。
            const cands = (w.lows || []).filter(x => x.type === P.type && x.offset <= P.offset)
                .sort((x, y) => ((y.onField ? 1 : 0) - (x.onField ? 1 : 0)) || (y.offset - x.offset));
            const nearest = cands[0] || null;
            const lead = nearest ? (P.offset - nearest.offset) : 99999;
            if (!nearest || lead > 40) {
                const advance = Math.max(1, Math.min(200, (P.offset || 40) - 35));
                for (let k = 0; k < advance; k++) {
                    const r = washOne(); lockTargetIn(r);
                    if (budget > 0 && cost > budget) break;
                }
                continue;
            }
            // ★★ 使用者口径：锁集一变就必须重算窗口（3 槽 0 锁 ≡ 4 槽 1 锁，看的是**可洗槽数**）。
            //   所以：先锁冲突 → 立刻用新锁集重探 → 再洗到紫 → 置换。
            let conflict = null;
            if (nearest.onField || nearest.offset === 0) {
                conflict = nearest.id; conflictHold = conflict;
                steps.push({ type: 'lockConflict', id: conflict, forPurple: P.id, washes, cost, locks: held.slice(), field: s.talents.slice() });
            } else {
                // ⚠ 只认「离紫最近的那一次」出现：同一条低阶脉在窗口里会多次出现，
                //   如果一见就锁，会锁到更早的那一次（实测 +65 而不是 +99）。
                //   所以等到接近目标 offset 时才允许锁（允许 ±2 洗的漂移）。
                for (let k = 0; k < nearest.offset + 2; k++) {
                    const r = washOne();
                    if (k + 1 >= nearest.offset - 2 && (r.generatedEvents || []).some(x => Number(x.id) === nearest.id)) {
                        conflict = nearest.id; conflictHold = conflict;
                        steps.push({ type: 'lockConflict', id: conflict, forPurple: P.id, washes, cost, locks: held.slice(), field: s.talents.slice() });
                        break;
                    }
                    if (budget > 0 && cost > budget) break;
                }
            }
            if (conflict == null) { conflictHold = null; continue; }   // 没锁到 → 下一轮重探
            // ★ 锁上冲突后**重新探窗**（锁集变了，条数推进也变了），
            //   用新窗口算这条紫实际还有几洗到，而不是沿用旧投影的 offset。
            let purpleOffset = 0;
            try {
                const w2 = probe(400);
                const p2 = (w2.purples || []).find(x => Number(x.id) === Number(P.id));
                if (p2) purpleOffset = Number(p2.offset) || 0;
                else if (!s.talents.includes(P.id)) { conflictHold = null; continue; }   // 紫已经不在了 → 放弃
            } catch (err) { purpleOffset = 0; }
            // ★ 连续置换的前置条件（使用者口径）：
            //   ① 载体紫是非目标紫；② 置换链下一条也是非目标紫（收尾脉视为普通紫）；
            //   ③ 可洗槽 > 3（4 槽 − 已锁目标 = 4）→ 可以连续置换。
            //   三条都满足时，**先把下一条紫的冲突脉洗出来**，再置换 ——
            //   否则换完接不上（实测：洗 16 手金仙的冲突脉才出现）。
            try {
                const nx0 = peekN(1);
                const carrierNonTarget = !isPoolTarget(P.id);
                const nextNonTarget = nx0.length && !isPoolTarget(nx0[0].id);
                const freeNow = e.slotCount - held.length;
                if (carrierNonTarget && nextNonTarget && freeNow > 3) {
                    const nextType = e.talentType(nx0[0].id);
                    const hasConf = () => s.talents.some(v => e.quality(Number(v)) < 4 && Number(v) !== 251 && e.talentType(Number(v)) === nextType);
                    for (let k = 0; k < 60 && !hasConf(); k++) {
                        const rr = washOne(); lockTargetIn(rr);
                        if (budget > 0 && cost > budget) break;
                    }
                    if (hasConf()) steps.push({ type: 'waitConflict', forNext: nx0[0].id, locks: held.slice(), field: s.talents.slice(), washes, cost });
                }
            } catch (err) { }
            let appear = s.talents.includes(P.id);
            for (let k = 0; k < purpleOffset + 60 && !appear; k++) {
                const r = washOne();
                appear = (r.generatedEvents || []).some(x => Number(x.id) === P.id) || s.talents.includes(P.id);
                if (budget > 0 && cost > budget) break;
            }
            if (appear && conflict != null) {
                const pos = s.talents.indexOf(P.id);
                const locks = Array.from(new Set(held.concat([conflict])));
                if (pos >= 0 && e.replaceablePositions(s, locks).includes(pos)) {
                    const useLocks = Array.from(new Set(locks.slice()));      // 置换**实际用**的锁集（含冲突脉）
                    // ★ 使用者口径：这个检索要在**置换之前**做 ——
                    //   看看置换脉序的第二条是不是又是这个类型，是的话这条冲突脉还能接着用，
                    //   那就保留它、继续洗（不必马上解锁）。
                    let keepConflictPre = false;
                    try {
                        const nxs = peekN(2);
                        if (nxs.length >= 1 && e.talentType(nxs[0].id) === e.talentType(conflict)) keepConflictPre = true;
                        if (nxs.length >= 2 && e.talentType(nxs[1].id) === e.talentType(conflict)) keepConflictPre = true;
                    } catch (err) { }
                    if (keepConflictPre && held.length >= 3) keepConflictPre = false;   // 3 条紫锁满要让位
                    let r = null;
                    try { r = e.replace(s, pos, locks); } catch (err) { r = null; }
                    if (r) {
                        const added = Number(r.addedId);
                        s = r.state;
                        // ★ 使用者规则：置换结束后，用掉的冲突脉在解锁前要确认两件事
                        //   ① 它是不是**下一条置换脉序**的冲突脉（类型对得上就留着）；
                        //   ② 它是不是**下一条原始紫最近的冲突脉**。
                        //   两条都不满足 → 才解锁。
                        let keepConflict = false;
                        try {
                            const nx1 = peekN(1);
                            if (nx1.length && e.talentType(nx1[0].id) === e.talentType(conflict)) keepConflict = true;
                        } catch (err) { }
                        if (!keepConflict) {
                            try {
                                const nw = probe(300);
                                if (nw.purple) {
                                    const near = (nw.lows || []).filter(x => x.type === nw.purple.type && x.offset <= nw.purple.offset)
                                        .sort((x, y) => ((y.onField ? 1 : 0) - (x.onField ? 1 : 0)) || (y.offset - x.offset))[0];
                                    if (near && Number(near.id) === Number(conflict)) keepConflict = true;
                                }
                            } catch (err) { }
                        }
                        // ③ 3 条紫锁满要解锁（没空槽可洗）
                        if (keepConflict && held.length >= 3) keepConflict = false;
                        conflictHold = (keepConflict || keepConflictPre) ? conflict : null;
                        const keptIt = TG.includes(added) && !held.includes(added) && held.length < 3;
                        if (keptIt) {
                            held.push(added);
                            steps.push({ type: 'exchange', locks: useLocks, field: s.talents.slice(), from: P.id, to: added, washes, cost });
                        } else { steps.push({ type: 'burn', locks: useLocks, field: s.talents.slice(), from: P.id, to: added, washes, cost }); }
                        noteExchange(pos, keptIt);
                    }
                }
            }

            conflictHold = null;
        }
        // 记录进入收尾阶段时的指纹（用于对比抽签流是否一致）
        const tailFP = { bornRC: s.bornRC, luckSeed: s.luckSeed, bornSeed: s.bornSeed, talents: s.talents.slice(), washes, cost, held: held.slice() };
        // ③ 收尾：先凑齐非收尾的三条，再洗出收尾脉本身
        for (let k = 0; k < 1500 && held.length < lockSet.length; k++) {
            const r = washOne();
            for (const ev of (r.generatedEvents || [])) {
                const id = Number(ev.id);
                if (e.quality(id) === 4 && lockSet.includes(id) && !held.includes(id)) {
                    steps.push({ type: 'lock', locks: held.concat(conflictHold==null?[]:[conflictHold]), field: s.talents.slice(), id, washes, cost });
                    held.push(id);
                }
            }
            if (budget > 0 && cost > budget) break;
        }
        // ★ 使用者口径：**神脉也可以当收尾脉**，而且锁完它还能再推进一次置换序列，
        //   用来把还没拿到的目标补上（柳如意：收尾用混元奇脉这种神脉，再换一次拿天生神力）。
        const tailIsShen = (() => {
            try { return tailId != null && typeof isShenmai === 'function' ? !!isShenmai(tailId) : false; } catch (e) { return false; }
        })();
        // ④ 收尾脉：先洗；洗不到就**用置换拿**（柳如意：飘逸 → 混元奇脉）
        if (tailId != null) {
            for (let k = 0; k < 1500 && !held.includes(tailId); k++) {
                const r = washOne();
                if ((r.generatedEvents || []).some(x => Number(x.id) === tailId) || s.talents.includes(tailId)) {
                    if (held.length < TG.length) { held.push(tailId); steps.push({ type: 'lock', locks: held.concat(conflictHold==null?[]:[conflictHold]), field: s.talents.slice(), id: tailId, washes, cost, tail: true }); }
                    break;
                }
                if (budget > 0 && cost > budget) break;
            }
            // 洗不到 → 试置换：拿场上任意紫 + 一条同类型低阶脉当冲突（神脉结果不需要冲突）
            if (!held.includes(tailId)) {
                const tyT = e.talentType(tailId);
                const needShen = (() => { try { return typeof isShenmai === 'function' ? !!isShenmai(tailId) : false; } catch (e) { return false; } })();
                dbg.push({ round: 'tailSeek', tail: tailId, field: s.talents.slice(), held: held.slice() });
                for (let attempt = 0; attempt < 3 && !held.includes(tailId); attempt++) {
                    const purples = s.talents.map(Number).filter(v => e.quality(v) === 4 && !held.includes(v));
                    if (!purples.length) break;
                    const carrier = purples[0];
                    let conf = null;
                    if (!needShen) {
                        conf = s.talents.map(Number).find(v => e.quality(v) < 4 && v !== 251 && e.talentType(v) === tyT) || null;
                        if (conf == null) {
                            for (let k = 0; k < 120 && conf == null; k++) {
                                const r = washOne();
                                conf = s.talents.map(Number).find(v => e.quality(v) < 4 && v !== 251 && e.talentType(v) === tyT) || null;
                                if (budget > 0 && cost > budget) break;
                            }
                        }
                    }
                    const locks = Array.from(new Set(held.concat(conf == null ? [] : [conf])));
                    const s2 = conf == null ? s : orderForReplace(s, carrier, conf);
                    const pos2 = s2.talents.indexOf(carrier);
                    const okPos = pos2 >= 0 && e.replaceablePositions(s2, locks).includes(pos2);
                    dbg.push({ round: 'tailEx', carrier, conf, pos2, okPos, locks: locks.slice() });
                    if (!okPos) break;
                    let rr = null;
                    try { rr = e.replace(s2, pos2, locks); } catch (err) { break; }
                    const added = Number(rr.addedId);
                    const fromId = Number(carrier);
                    s = rr.state;
                    steps.push({ type: 'exchange', from: fromId, to: added, locks, field: s.talents.slice(), washes, cost, tailSeek: true });
                    noteExchange(pos2, added === tailId);
                    if (added === tailId) { held.push(tailId); break; }
                }
            }
        }
        const got = TG.filter(id => held.includes(id)).length;
        // ★ 保底位上白捡的目标数（= 多出来的槽位）
        const freeTargetsFinal = steps.filter(x => x.type === 'lock' && x.fromPity).length;
        return { ok: got === TG.length, cost, washes, exchanges, advances, burns, got, tailFP, freeTargets: freeTargetsFinal,
            field: s.talents.slice(), held: held.slice(), steps, n, dbg,
            missing: TG.filter(id => !held.includes(id)) };
    }

    /** 枚举 n，取最省且四目标齐的。 */
    function poolSeedPlan(rawInput, targets, opts) {
        opts = opts || {};
        const raw = sanitizeRouteRaw(rawInput);
        // 可用丹数 = 总预算 − 收尾脉预留（前面操作超了就不搜）
        {
            const tr = Math.max(0, Number(opts.tailReserve) || 0);
            const b0 = Math.max(0, Number(opts.budget) || 0);
            if (tr > 0 && b0 > 0) opts = Object.assign({}, opts, { budget: Math.max(1, b0 - tr) });
        }
        const nMax = Math.max(0, Number(opts.nMax) || 40);
        const nStep = Math.max(1, Number(opts.nStep) || 1);
        const deadline = Date.now() + Math.max(2000, Number(opts.timeMs) || 60000);
        let best = null; const tried = [];
        const aList = Array.isArray(opts.startWashes) && opts.startWashes.length ? opts.startWashes : [0, 60, 100, 131, 160, 200];
        const midCaps = Array.isArray(opts.midCaps) && opts.midCaps.length ? opts.midCaps : [1, 2, 3];
        const releases = Array.isArray(opts.releases) && opts.releases.length ? opts.releases : [false, true];
        for (const mc of midCaps) for (const rel of releases) for (const a of aList) {
        for (let n = 0; n <= nMax; n += nStep) {
            if (Date.now() > deadline) break;
            const r = poolPlanOnce(raw, targets, n, Object.assign({}, opts, { startWash: a, midCap: mc, releaseFirst: rel }));
            if (!r) continue;
            tried.push({ a, n, mc, rel, ok: r.ok, cost: r.cost, got: r.got });
            if (r.ok && (!best || r.cost < best.cost)) best = Object.assign({ a, midCap: mc, releaseFirst: rel }, r);
        }
        }
        if (best) { best.tried = tried; return best; }
        return { ok: false, tried, note: '所有 a×n 组合都没凑齐四目标' };
    }

    /**
     * 用引擎把「步骤表」重放一遍，逐洗校验（独立复算，不信生成器自己的账）。
     * 步骤表里每步带 { type, washes, locks, from, to, field }：
     *   · washes 是累计洗数，相邻两步之差 = 这段洗了几手；
     *   · locks 是这段洗髓期间锁着的脉 id。
     * 返回 { ok, cost, washes, reason }
     */
    function verifyTimeline(raw, steps) {
        let zi = 153;
        let e;
        try { e = engine(raw, zi); } catch (err) { return { ok: false, reason: '引擎起不来' }; }
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let prevW = 0, cost = 0, washes = 0;
        for (const st of (steps || [])) {
            const target = Number(st.washes) || 0;
            let dw = target - prevW;
            if (dw < 0) return { ok: false, reason: '步骤洗数倒退' };
            if (dw > 0) {
                const keep = (st.locks || []).map(id => s.talents.indexOf(id));
                if (keep.some(i => i < 0)) return { ok: false, reason: `第 ${target} 洗：锁定脉不在场` };
                for (let k = 0; k < dw; k++) {
                    let r = null;
                    try { r = e.wash(s, keep.filter(i => i >= 0)); } catch (err) { return { ok: false, reason: '洗髓抛错：' + err.message }; }
                    s = r.state; cost += r.cost; washes++;
                }
            }
            if (st.type === 'upgrade' && zi === 153) {
                zi = 154; e = engine(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
            }
            if (st.type === 'exchange') {
                const locks = (st.locks || []).map(Number);
                const pos = s.talents.indexOf(Number(st.from));
                if (pos < 0) return { ok: false, reason: `第 ${target} 洗：置换前场上没有该脉` };
                if (!e.replaceablePositions(s, locks).includes(pos)) return { ok: false, reason: `第 ${target} 洗：不可置换` };
                let r = null;
                try { r = e.replace(s, pos, locks); } catch (err) { return { ok: false, reason: '置换抛错：' + err.message }; }
                if (Number(r.addedId) !== Number(st.to)) return { ok: false, reason: `第 ${target} 洗：换出 ${r.addedId} ≠ 记录 ${st.to}` };
                s = r.state;
            }
            prevW = target;
            if (Array.isArray(st.field) && st.field.length) {
                const mine = s.talents.map(Number).slice().sort((a, b) => a - b).join(',');
                const want = st.field.map(Number).slice().sort((a, b) => a - b).join(',');
                if (mine !== want) return { ok: false, reason: `第 ${target} 洗：场上与步骤表不符` };
            }
        }
        return { ok: true, cost, washes };
    }

    /**
     * 时间线方案：枚举 (起始空洗 a × 垫洗 n × 锁冲突提前量 lead)，
     * 每个参数跑一遍执行器生成步骤表，再**用 verifyTimeline 独立重放验证**，
     * 只保留验证通过且四目标齐的，按丹耗取最省。
     */
    function timelinePlan(raw, targets, opts) {
        opts = opts || {};
        const aList = Array.isArray(opts.startWashes) && opts.startWashes.length ? opts.startWashes : [0, 100, 131];
        const nMax = Math.max(0, Number(opts.nMax) || 30);
        const leadList = Array.isArray(opts.leads) && opts.leads.length ? opts.leads : [10, 25, 40];
        const deadline = Date.now() + Math.max(2000, Number(opts.timeMs) || 90000);
        let best = null;
        const tried = [];
        for (const a of aList) {
            for (let n = 0; n <= nMax; n++) {
                for (const lead of leadList) {
                    if (Date.now() > deadline) break;
                    let r = null;
                    try {
                        r = poolPlanOnce(raw, targets, n, Object.assign({}, opts, {
                            startWash: a, leadLimit: lead,
                        }));
                    } catch (err) { r = null; }
                    if (!r || !r.ok) { tried.push({ a, n, lead, ok: false }); continue; }
                    const v = verifyTimeline(raw, r.steps);
                    tried.push({ a, n, lead, ok: !!v.ok, cost: v.ok ? v.cost : null });
                    if (!v.ok) continue;
                    const out = Object.assign({}, r, { cost: v.cost, washes: v.washes, verified: true, a, n, lead });
                    if (!best || out.cost < best.cost) best = out;
                }
                if (Date.now() > deadline) break;
            }
            if (Date.now() > deadline) break;
        }
        if (best) { best.tried = tried; return best; }
        return { ok: false, tried, note: '所有 (a,n,lead) 组合都没生成出「验证通过且四目标齐」的时间线' };
    }

    /**
     * 第三种改种子手段：**保底紫前开槽重掷**。
     *   · 跳脉法：换种子（跳脉档位）
     *   · 锁脉法：锁一条低阶脉改推进节奏
     *   · 开槽重掷：在保底紫到来之前开第 4 槽 —— 槽位变了 bornSeed 也变，
     *     保底紫的落点和整条欧气链随之重排（薛龙城 7,687 丹就是靠这个起手）。
     *
     * 枚举 openSlotAt（默认取保底紫前一洗的若干候选）× 垫洗 n，
     * 每个候选都跑一遍执行器并**用引擎重放验证**，返回最省的完整方案。
     */
    function planSlotRerollRoutes(raw, targets, opts) {
        opts = opts || {};
        const budget = Math.max(0, Number(opts.budget) || 0) || 12000;
        const nMax = Math.max(0, Number(opts.nMax) || 20);
        const tailId = Number(opts.tailId) || null;
        const deadline = Date.now() + Math.max(2000, Number(opts.timeMs) || 60000);
        // 候选开槽点：调用方给，或者按保底紫节奏推（默认 0 / 200 / 400 / 600 / 800 附近）
        let list = Array.isArray(opts.openSlots) && opts.openSlots.length
            ? opts.openSlots.slice()
            : [0, 200, 400, 560, 700, 860, 1000];
        list = list.map(x => Math.max(0, Number(x) || 0)).sort((a, b) => a - b);
        const routes = [];
        for (const a of list) {
            for (let n = 0; n <= nMax; n++) {
                if (Date.now() > deadline) break;
                let r = null;
                try {
                    r = poolPlanOnce(raw, targets, n, Object.assign({}, opts, {
                        budget, startWash: a, openSlotAt: a, tailId,
                    }));
                } catch (err) { r = null; }
                if (!r || !r.steps || !r.steps.length) continue;
                let v = { ok: false };
                try { v = verifyTimeline(raw, r.steps); } catch (err) { v = { ok: false }; }
                routes.push({
                    variant: 'reroll', openSlotAt: a, n,
                    got: r.got, totalPills: v.ok ? v.cost : r.cost,
                    washes: v.ok ? v.washes : r.washes,
                    exchanges: r.exchanges, steps: r.steps,
                    verified: !!v.ok, ok: !!r.ok && !!v.ok,
                });
                if (r.ok) break;              // 该开槽点已经四目标齐，不用再加大 n
            }
            if (Date.now() > deadline) break;
        }
        routes.sort((x, y) => (y.got - x.got) || (x.totalPills - y.totalPills));
        if (!routes.length) return null;
        const best = routes.find(x => x.ok) || routes[0];
        return {
            variant: 'reroll', routes, best, zizhi: Number(raw.zizhi) || 0, targets,
            note: best.ok ? '' : '开槽重掷：没有凑齐四目标的组合（返回最接近的一条）',
        };
    }

    /**
     * 跳脉法规则（使用者口径，2026-10 定稿）：
     *
     *   一、跳脉法有三种「锚定保底紫 / 换种子」的手段：
     *       ① 跳脉（跳到指定档位）
     *       ② 锁脉（锁一条低阶脉，改变推进节奏）
     *       ③ 保底紫前开槽重掷（开第 4 槽 → bornSeed 变 → 保底紫与欧气链重排）
     *
     *   二、**保底紫序列与欧气种子定下来之前，不得使用无限置换**。
     *       原因：无限置换会把 luckSeed 推着走，保底紫与欧气链跟着变，
     *       之前锚定好的起点就作废了。
     *
     *   三、保底紫之前的自然紫，按两种身份分别处理：
     *       · 「非收尾目标紫」→ 可以锁定（留到收尾），**也可以当普通脉毁掉**；
     *       · 普通紫           → 只能毁脉（放弃这个原始紫位置，换置换脉序前进一格）。
     *
     *   四、起点锚定好（种子固定）之后，连起点那条脉也可以毁掉。
     *
     * 这个函数返回当前局面下「允不允许用无限置换」以及「这条紫该怎么处理」。
     *   ctx = { anchored: boolean, tailId, targets, held }
     */
    function jumpMethodPolicy(talentId, ctx) {
        ctx = ctx || {};
        const anchored = !!ctx.anchored;                 // 保底紫序列 + 种子是否已定
        const tailId = Number(ctx.tailId) || null;
        const targets = (ctx.targets || []).map(Number);
        const held = (ctx.held || []).map(Number);
        const id = Number(talentId);
        const isTarget = targets.includes(id);
        const isTail = tailId != null && id === tailId;

        if (!anchored) {
            // 还没锚定：禁止无限置换，自然紫只能「锁（若是非收尾目标）或毁」
            if (isTarget && !isTail && !held.includes(id)) {
                return { exchange: false, lock: true, destroy: true,
                    reason: '跳脉法：保底紫未锚定前不得无限置换；这条是非收尾目标紫，可锁可毁' };
            }
            return { exchange: false, lock: false, destroy: true,
                reason: '跳脉法：保底紫未锚定前不得无限置换；这条是普通紫，只能毁脉' };
        }
        // 已锚定：按常规（无限置换可用）
        if (isTarget && !isTail && !held.includes(id)) {
            return { exchange: true, lock: true, destroy: false, reason: '已锚定：非收尾目标紫，锁定' };
        }
        return { exchange: true, lock: false, destroy: true, reason: '已锚定：无限置换可用' };
    }

    /**
     * 「推进置换脉序」机制（使用者原文，2026-10 定稿）
     *
     *   普通置换（3 可洗槽可连续推进至一心/首条神脉；2 可洗槽只能推进一条；
     *            冲突神脉可以多推进一条）：
     *
     *     [冲突A(锁)] [紫P1(锁)] [普通脉]
     *   ↓ 第③格洗出：紫P2 的冲突 B 并锁定
     *     [冲突A(锁)] [紫P1(锁)] [冲突B(锁)]
     *   ↓ 置换 P1 → 用 A 当冲突   紫P1 变紫P2
     *     [冲突A(锁)] [冲突B(锁)] [紫P2]      ← 仅位置变化，可无视
     *   ↓ 角色互换：现在 P2 是要换的紫，B 是它的冲突
     *   ↓ 解锁冲突A，锁定紫P2
     *     [冲突A] [冲突B(锁)] [紫P2(锁)]      ← 第①格空出来洗下一条的冲突
     *   ↓ 洗出紫P3的冲突脉 C 并锁定
     *     [冲突B(锁)] [紫P2(锁)] [冲突C(锁)]
     *   ↓ 置换 P2 → 用 B 当冲突   紫P2 变紫P3
     *     [冲突B(锁)] [冲突C(锁)] [紫P3]
     *   ↓ 如此循环可不停推进置换脉序
     *
     * 三个要点（实现时必须满足）：
     *   ① 每一轮都要留 **1 个可洗槽** 去洗「下一条紫的冲突脉」；
     *   ② 每轮结束要**解锁上一轮的冲突脉**，否则槽位不够（这就是上图的「解锁冲突A」）；
     *   ③ 位置变化可无视，只认「当前紫 + 它的冲突」这一对。
     *
     * 与「毁脉」的区别：推进过程中紫位始终保留（一直在那一格上换），
     * 只有放弃紫位（不再在它上面置换）才算毁脉。
     */
    const ADVANCE_CHAIN_RULES = Object.freeze({
        continuous: '原地连续置换，不停推进置换脉序，紫位始终保留',
        needsFreeSlot: 1,
        unlockPreviousConflict: true,
        maxSteps: {
            threeWashable: '连续推进（直到一心/首条神脉）',
            twoWashable: '只能推进一条',
            godConflictBonus: '冲突是神脉时可多推进一条',
        },
    });

    /**
     * 连续置换链（使用者图示的完整实现，位置无影响）：
     *
     *   [冲突A(锁)][紫P1(锁)][普通脉]
     *   → 第③格洗出「P2 的冲突 B」并锁定
     *   → 置换 P1（用 A 当冲突）→ P1 变 P2
     *   → 角色互换：解锁 A，锁住 P2（B 就是 P2 的冲突）
     *   → 洗出 P3 的冲突 C …如此循环
     *
     * 每换一次查一次：命中「缺的目标」就停；不可换（神脉/一心）也停。
     * 返回值里的 steps 可直接给界面/操作清单用。
     */
        function planJumpChain(raw, targets, opts) {
        opts = opts || {};
        const TG = (targets || []).map(Number);
        const tailId = Number(opts.tailId) || null;
        const isPoolTarget = id => TG.includes(Number(id)) && Number(id) !== tailId;
        const budget = Math.max(0, Number(opts.budget) || 0) || 20000;
        let e;
        try { e = engine(raw, Number(opts.zizhi) || 154); } catch (err) { return null; }
        let s = opts.startState ? Object.assign({}, opts.startState)
            : e.initialState(Object.assign({}, raw, { zizhi: Number(opts.zizhi) || 154 }));
        let cost = 0, washes = 0, exchanges = 0, advances = 0;
        const steps = [], held = [];
        let stoppedAt = null;
        let conflict = null, carrier = null;
        const typeOf = id => e.talentType(Number(id));
        const isShen = id => (typeof e.isShenmai === 'function' ? e.isShenmai(Number(id)) : false);
        const lowOfType = (ty, beforeId) => nearestLowOfTypeInField(e, s.talents, ty, beforeId);
        const keep = () => Array.from(new Set(held.concat(conflict == null ? [] : [conflict]).concat(carrier == null ? [] : [carrier])))
            .map(id => s.talents.indexOf(id)).filter(i => i >= 0);
        const washOne = () => { const r = e.wash(s, keep()); s = r.state; cost += Number(r.cost) || 0; washes++; return r; };
        const orderForReplace = (st, purpleId, conflictId) => {
            const pi = st.talents.indexOf(purpleId), ci = st.talents.indexOf(conflictId);
            if (pi < 0 || ci < 0 || ci < pi) return st;
            const t = st.talents.slice(); t[pi] = conflictId; t[ci] = purpleId;
            return Object.assign({}, st, { talents: t });
        };
        const peekNext = () => {
            let pair = null;
            for (const id of e.allIds) {
                if (!e.allowed.has(id) || e.quality(id) !== 4) continue;
                const low = e.allIds.find(x => e.allowed.has(x) && e.quality(x) < 4 && e.talentType(x) === e.talentType(id));
                if (low != null) { pair = { purple: Number(id), low: Number(low) }; break; }
            }
            if (!pair) return null;
            try {
                const r = e.replace({ bornSeed: s.bornSeed, luckSeed: Number(s.luckSeed) || 0, bornRC: s.bornRC,
                    talUckyUnused: 0, talLucky: 0, zizhi: s.zizhi, talents: [pair.low, pair.purple] }, 1, [pair.low]);
                return Number(r.addedId);
            } catch (err) { return null; }
        };

        carrier = Number(opts.carrierId) || s.talents.map(Number).find(v => e.quality(v) === 4) || null;
        conflict = Number(opts.conflictId) || (carrier == null ? null : lowOfType(typeOf(carrier), carrier));
        const maxSteps = Math.max(1, Number(opts.maxSteps) || 12);
        for (let step = 0; step < maxSteps && carrier != null && conflict != null; step++) {
            // ① 预先锁「换出来的那条紫」的冲突脉（神脉免预载）
            const nextId = peekNext();
            if (nextId == null) break;
            const shen = isShen(nextId);
            // ★ 如果下一条就是「停止锚点」（比如 不灭肉身），换完就停 → **不需要预载冲突脉**
            const willStop = opts.stopAtId != null && Number(nextId) === Number(opts.stopAtId);
            let pre = null;
            if (!shen && !willStop) {
                pre = lowOfType(typeOf(nextId));
                for (let k = 0; k < 80 && pre == null; k++) {
                    washOne();
                    if (!s.talents.includes(carrier)) break;
                    pre = lowOfType(typeOf(nextId));
                    if (budget > 0 && cost > budget) break;
                }
                if (pre == null) break;
            }
            if (!s.talents.includes(carrier)) break;
            // ② 置换（用当前紫的冲突）
            const s2 = orderForReplace(s, carrier, conflict);
            const pos = s2.talents.indexOf(carrier);
            const locks = Array.from(new Set(held.concat([conflict])));
            if (pos < 0 || !e.replaceablePositions(s2, locks).includes(pos)) break;
            let r = null;
            try { r = e.replace(s2, pos, locks); } catch (err) { break; }
            const added = Number(r.addedId);
            s = r.state;
            const kept = isPoolTarget(added) && !held.includes(added) && held.length < 3;
            if (kept) held.push(added);
            else if (step > 0) advances++;
            exchanges++;
            steps.push({ type: 'exchange', from: carrier, to: added, washes, cost, locks,
                field: s.talents.slice(), kept, advance: !kept, preloaded: pre, shen });
            carrier = added;
            // ★ 到了「锚点脉」就停止置换（参考方案：不灭肉身出现后不再换，改成毁掉/另作打算）
            if (opts.stopAtId != null && Number(added) === Number(opts.stopAtId)) { stoppedAt = Number(added); break; }
            conflict = shen ? lowOfType(typeOf(added), added) : pre;
            if (kept) break;
            if (conflict == null) break;
            if (budget > 0 && cost > budget) break;
        }
        return { ok: held.length > 0, cost, washes, exchanges, advances, steps, stoppedAt,
            field: s.talents.slice(), held: held.slice(), state: s };
    }

    /**
     * 「跳脉法 + 连续置换 + 毁脉 + 晚期置换」整条路线（薛龙城 7,687 验证版）。
     */
    function planJumpManualRoute(rawInput, targets, opts) {
        opts = opts || {};
        // ★ 这条路线假设从**空场**开始：如果 raw 里带了场上已洗出的脉，会污染抽签流，先清掉
        const raw = Object.assign({}, rawInput);
        if (Array.isArray(raw.talents) && raw.talents.length) raw.talents = [];
        // 同理：vip=0 会让引擎的抽签退化（实测 0/4、洗不到载体紫），这里兜底成 1
        raw.vip = Math.max(1, Number(raw.vip) || 0);
        // ★ 置换池也要从头开始：页面里洗过/换过之后 luck_seed 会被推进，
        //   带着它跑这条路线会整体错位（实测 0/4 或 2/4）。路线按「导入状态」起算，池子归零。
        raw.luck_seed = 0;
        raw.luck_seed_inited = false;
        const TG = (targets || []).map(Number);
        const tailId = Number(opts.tailId) || null;
        const isPoolTarget = id => TG.includes(Number(id)) && Number(id) !== tailId;
        const startWash = Math.max(0, Number(opts.startWash) || 0);
        const budget = Math.max(0, Number(opts.budget) || 0) || 20000;
        // ★ 起手槽位可配：柳如意必须 4 槽起手（3 槽起手会写下另一个种子，整条紫序不同）
        const startZi = Number(opts.startZi) === 154 ? 154 : 153;
        let e;
        try { e = engine(raw, startZi); } catch (err) { return null; }
        let s = e.initialState(Object.assign({}, raw, { zizhi: startZi }));
        let cost = 0, washes = 0;
        const steps = [], held = [];
        const typeOf = id => e.talentType(Number(id));
        const keepOn = st => held.map(id => st.talents.indexOf(id)).filter(i => i >= 0);
        const wash1 = () => { const r = e.wash(s, keepOn(s)); s = r.state; cost += Number(r.cost) || 0; washes++; return r; };
        const washTo = id => {
            let got = s.talents.includes(Number(id));
            const b = washes;
            for (let k = 0; k < 900 && !got; k++) {
                const r = wash1();
                got = (r.generatedEvents || []).some(x => Number(x.id) === Number(id)) || s.talents.includes(Number(id));
                if (budget > 0 && cost > budget) break;
            }
            return { got, delta: washes - b };
        };
        for (let i = 0; i < startWash; i++) wash1();
        steps.push({ type: 'startWash', count: startWash, washes, cost, locks: [], field: s.talents.slice(), startZi });
        if (startZi !== 154) {
            e = engine(raw, 154);
            s = e.upgradeToFour(Object.assign({}, s, { zizhi: 154 }));
            steps.push({ type: 'upgrade', toZi: 154, washes, cost, locks: [], field: s.talents.slice() });
        } else {
            e = engine(raw, 154);
        }
        // ★ 与链内部同口径：**先扫窗口找到第一条紫**，再找它同类型的低阶脉当冲突
        let scan = null;
        {
            let ps = Object.assign({}, s, { talents: s.talents.slice() });
            let up = null; const lows = [];
            for (let k = 1; k <= 120; k++) {
                let r = null;
                try { r = e.wash(ps, keepOn(ps)); } catch (err) { break; }
                ps = r.state;
                for (const ev of (r.generatedEvents || [])) {
                    const id = Number(ev.id);
                    if (e.quality(id) === 4) { if (!up) up = { id, offset: k }; }
                    else if (id !== 251) lows.push({ id, offset: k, type: typeOf(id) });
                }
                if (up && k >= up.offset) break;
            }
            if (up) {
                const onField = nearestLowOfTypeInField(e, s.talents, typeOf(up.id), null);
                const cand = onField != null ? { id: onField, offset: 0 }
                    : (lows.filter(x => x.type === typeOf(up.id) && x.offset <= up.offset).sort((x, y) => y.offset - x.offset)[0] || null);
                if (cand) scan = { purple: up, conflict: cand };
            }
        }
        let conflict = null, purple = null;
        if (scan) {
            conflict = scan.conflict.id;
            // 锁冲突（若不在场上，先洗到它出现）
            if (scan.conflict.offset > 0) {
                for (let k = 0; k < scan.conflict.offset + 5; k++) {
                    const r = wash1();
                    if ((r.generatedEvents || []).some(x => Number(x.id) === conflict)) break;
                }
            }
            if (s.talents.includes(conflict)) {
                held.push(conflict);
                steps.push({ type: 'lockConflict', id: conflict, forPurple: scan.purple.id, washes, cost, locks: [], field: s.talents.slice() });
                for (let k = 0; k < 300 && purple == null; k++) {
                    const r = wash1();
                    if ((r.generatedEvents || []).some(x => Number(x.id) === scan.purple.id)) purple = scan.purple.id;
                }
            }
        }        // ★ 兜底：扫描没配出「紫+冲突」时，直接洗到任意一条紫，再洗它的同类型低阶脉
        if (purple == null) {
            for (let k = 0; k < 300 && purple == null; k++) {
                const r = wash1();
                purple = s.talents.map(Number).find(v => e.quality(v) === 4) || null;
            }
            if (purple != null) {
                const ty = typeOf(purple);
                conflict = nearestLowOfTypeInField(e, s.talents, ty, purple);
                for (let k = 0; k < 200 && conflict == null; k++) {
                    wash1();
                    if (!s.talents.includes(purple)) { purple = s.talents.map(Number).find(v => e.quality(v) === 4) || null; if (purple == null) break; }
                    conflict = nearestLowOfTypeInField(e, s.talents, typeOf(purple), purple);
                }
                if (conflict != null && !held.includes(conflict)) {
                    held.push(conflict);
                    steps.push({ type: 'lockConflict', id: conflict, forPurple: purple, washes, cost, locks: [], field: s.talents.slice(), fallback: true });
                }
            }
        }
        if (purple == null) return { ok: false, reason: '洗不到载体紫（场上=' + s.talents.join(',') + ' 洗=' + washes + ' 丹=' + cost + '）', cost, washes, steps, held: held.slice(), field: s.talents.slice() };
        // 连续置换链的返回步骤只记录“链内”相对洗数；先把载体锁上的这一刻记下来，
        // 独立回放和界面才能知道链开始前场上已经有载体紫（薛龙城枪棍绝伦）。
        steps.push({
            type: 'lockCarrier', id: purple, washes, cost,
            locks: held.slice(), field: s.talents.slice(),
        });
        const chain = planJumpChain(raw, TG, {
            startState: s, zizhi: 154, tailId,
            carrierId: purple, conflictId: conflict,
            maxSteps: Math.max(1, Number(opts.minChainSteps) || 8) + 4,
            budget, stopAtId: opts.chainStopId,
        });
        if (chain) {
            s = chain.state; washes += chain.washes; cost += chain.cost;
            (chain.steps || []).forEach(x => steps.push(x));
        }
        held.length = 0;
        steps.push({ type: 'unlockAll', washes, cost, locks: [], field: s.talents.slice() });
        const isShen = id => (typeof e.isShenmai === 'function' ? e.isShenmai(Number(id)) : false);
        const rest = (opts.restTargets && opts.restTargets.length ? opts.restTargets
            : TG.filter(id => id !== tailId && !isShen(id))).map(Number);
        // restExact=true 时严格按传入顺序洗（search 会用两种顺序各试一次）
        for (const id of rest) {
            if (held.includes(id)) continue;
            const g = washTo(id);
            if (!g.got) break;
            held.push(id);
            steps.push({ type: 'lock', id, delta: g.delta, washes, cost, locks: held.slice(), field: s.talents.slice() });
        }
        let ps = Object.assign({}, s, { talents: s.talents.slice() });
        let nxt = null; const lows = [];
        for (let k = 1; k <= 300; k++) {
            let r = null;
            try { r = e.wash(ps, keepOn(ps)); } catch (err) { break; }
            ps = r.state;
            for (const ev of (r.generatedEvents || [])) {
                const id = Number(ev.id);
                if (e.quality(id) === 4) { if (!nxt) nxt = { id, offset: k }; }
                else if (id !== 251) lows.push({ id, offset: k, type: typeOf(id) });
            }
            if (nxt && k >= nxt.offset) break;
        }
        if (nxt) {
            const cands = lows.filter(x => x.type === typeOf(nxt.id) && x.offset <= nxt.offset).sort((a, b) => b.offset - a.offset);
            const conf = cands[0] || null;
            if (conf) {
                for (let k = 0; k < conf.offset; k++) wash1();
                held.push(conf.id);
                steps.push({ type: 'lockConflict', id: conf.id, forPurple: nxt.id, delta: conf.offset, washes, cost, locks: held.slice(), field: s.talents.slice() });
                let pur = null;
                for (let k = 0; k < 40 && pur == null; k++) {
                    const r = wash1();
                    if ((r.generatedEvents || []).some(x => Number(x.id) === nxt.id)) pur = nxt.id;
                }
                if (pur != null) {
                    const t = s.talents.slice();
                    const pi = t.indexOf(pur), ci = t.indexOf(conf.id);
                    if (ci > pi) { t[pi] = conf.id; t[ci] = pur; }
                    const s2 = Object.assign({}, s, { talents: t });
                    const pos = s2.talents.indexOf(pur);
                    const locks = Array.from(new Set(held.concat([conf.id])));
                    if (e.replaceablePositions(s2, locks).includes(pos)) {
                        const r = e.replace(s2, pos, locks);
                        s = r.state;
                        const added = Number(r.addedId);
                        held.splice(held.indexOf(conf.id), 1);
                        if (isPoolTarget(added)) held.push(added);
                        steps.push({ type: 'exchange', from: pur, to: added, washes, cost, locks, field: s.talents.slice(), kept: isPoolTarget(added) });
                    }
                }
            }
        }
        // ★ 使用者规则（2026-10）：前面操作的可用丹数 = 总预算 − 收尾脉预留；
        //   到这里如果已经超了，这条路线直接放弃，不再浪费收尾段的搜索。
        {
            const headBudget = Number(opts.headBudget) || 0;
            if (headBudget > 0 && cost > headBudget) {
                const gotHead = TG.filter(id => held.includes(id) || s.talents.includes(id)).length;
                return { ok: false, got: gotHead, cost, washes, steps, held: held.slice(), field: s.talents.slice(),
                    reason: `前面操作 ${cost} 丹已超可用上限 ${headBudget}（预算 ${budget} − 收尾预留 ${budget - headBudget}）` };
            }
        }
        if (tailId != null) {
            const g = washTo(tailId);
            if (g.got) {
                held.push(tailId);
                steps.push({ type: 'lock', id: tailId, delta: g.delta, washes, cost, locks: held.slice(), field: s.talents.slice(), tail: true });
            }
        }
        // ★ 用上保底紫 = 多一个槽位：数一下有几个目标是「保底位上白捡的」
        let freeTargets = 0;
        try {
            const pityWash = steps.filter(st => st.type === 'lock' && st.tail).map(st => Number(st.washes) || 0);
            for (const id of TG) {
                const st = steps.find(x => (x.type === 'lock' || x.type === 'lockConflict') && Number(x.id) === Number(id));
                if (!st) continue;
                // 该目标在锁定时的洗数，是否与某条保底紫的落点接近（±3 洗内算白捡）
                const w = Number(st.washes) || 0;
                const nearPity = (pityWash.some(pw => Math.abs(pw - w) <= 3)) || steps.some(x => x.type === 'exchange' && Number(x.to) === Number(id) && false);
                if (nearPity) freeTargets++;
            }
        } catch (e) { freeTargets = 0; }
        const got = TG.filter(id => held.includes(id) || s.talents.includes(id)).length;
        return { ok: got === TG.length, cost, washes, steps, held: held.slice(), field: s.talents.slice(), got };
    }

    /**
     * 跳脉法整路线搜索：枚举 起始空洗 × 链停止锚点，跑 planJumpManualRoute，取最省的完整方案。
     */
    function searchJumpManualRoute(raw, targets, opts) {
        opts = opts || {};
        const TG = (targets || []).map(Number);
        const tailId = Number(opts.tailId) || null;
        const budget = Math.max(0, Number(opts.budget) || 0) || 20000;
        const deadline = Date.now() + Math.max(2000, Number(opts.timeMs) || 60000);
        const startList = Array.isArray(opts.startWashes) && opts.startWashes.length
            ? opts.startWashes.map(Number)
            : [864, 0, 600, 300];   // 只留 4 个起手档位：864 是常见最优，其余覆盖浅起手
        let stopList = [null];
        try {
            const e = engine(raw, 154);
            for (const id of e.allIds) {
                if (!e.allowed.has(id) || e.quality(id) !== 4) continue;
                const n = Number(id);
                if (TG.includes(n) || n === tailId) continue;
                stopList.push(n);
            }
        } catch (err) { }
        if (Array.isArray(opts.chainStops) && opts.chainStops.length) stopList = opts.chainStops.map(x => x == null ? null : Number(x));
        // 收尾脉候选：调用方给了就用它；没给就把四个目标都当收尾试一遍
        // 可用丹数 = 总预算 − 收尾脉预留（使用者口径）
        const tailReserve = Math.max(0, Number(opts.tailReserve) || 0);
        const tailReserveByTail = opts.tailReserveByTail || {};
        const headBudgetForTail = tail => {
            const tailId = tail && Number(tail.id);
            const reserve = tailId && tailReserveByTail[tailId] != null
                ? Math.max(0, Number(tailReserveByTail[tailId]) || 0)
                : tailReserve;
            return reserve > 0 ? Math.max(0, budget - reserve) : 0;
        };
        // 收尾候选 = 目标 + 非目标神脉（使用者口径：非目标神脉也能收尾）
        const tailList = (opts.tailId != null) ? [Number(opts.tailId)]
            : (function () { try { return tailCandidates(raw, TG, { count: Number(opts.tailScan) || 30 }); } catch (e) { return TG.slice(); } })();
        let best = null;
        const tried = [];
        let firstError = '';
        const reasonCount = {};
        const noteReason = r2 => {
            const lastStep = (r2 && r2.steps && r2.steps.length) ? r2.steps[r2.steps.length - 1] : null;
            const key = (r2 && r2.reason) ? r2.reason
                : `未完成：got=${r2 && r2.got}，步骤=${(r2 && r2.steps || []).length}，最后一步=${lastStep ? lastStep.type : '无'}，洗=${r2 && r2.washes}，丹=${r2 && r2.cost}`;
            reasonCount[key] = (reasonCount[key] || 0) + 1;
            return key;
        };
        outer:
        for (const tail of tailList) {
            const tailHeadBudget = headBudgetForTail(tail);
            for (const a of startList) {
                for (const stop of stopList) {
                    if (Date.now() > deadline) break outer;
                    let r = null;
                    const naturalRest = TG.filter(id => id !== tail && !(typeof engine === 'function' && (() => { try { const ee = engine(raw, 154); return typeof ee.isShenmai === 'function' ? ee.isShenmai(id) : false; } catch (e) { return false; } })()));
                    const restOrders = naturalRest.length > 1 ? [naturalRest, naturalRest.slice().reverse()] : [naturalRest];
                    for (const ro of restOrders) {
                        try {
                            r = planJumpManualRoute(raw, TG, Object.assign({}, opts, {
                                tailId: tail, startWash: a, chainStopId: stop,
                                budget, headBudget: tailHeadBudget,
                                restTargets: ro, restExact: true, startZi: opts.startZi,
                            }));
                        } catch (err) { r = null; if (!firstError) firstError = 'throw: ' + err.message; }
                        if (r && r.ok) break;
                    }
                    if (!r) { tried.push({ tail, a, stop, ok: false }); if (!firstError) firstError = '返回 null'; continue; }
                    tried.push({ tail, a, stop, ok: !!r.ok, cost: r.cost, got: r.got });
                    if (!r.ok && a >= 800) noteReason(r);
                    // 同价时优先「白捡更多」的路线（=多一个槽位）
                    const better = r.ok && (!best || r.cost < best.cost
                        || (r.cost === best.cost && (r.freeTargets || 0) > (best.freeTargets || 0)));
                    if (better) best = Object.assign({}, r, { startWash: a, chainStopId: stop, tailId: tail });
                }
            }
        }
        if (best) { best.tried = tried; return best; }
        const top = Object.entries(reasonCount).sort((a, b) => b[1] - a[1]).slice(0, 2)
            .map(([k, v]) => `${k} ×${v}`).join(' ； ');
        return { ok: false, tried, firstError, reasonCount, reason: '跳脉法整路线：没有凑齐四目标的组合' + (top ? `（主要原因：${top}）` : '') };
    }

    /**
     * 洗脉方案的**两层结构**（使用者口径）：
     *
     *   第一层：定种子 —— 只有两种方式
     *     · exchange（无限置换）：用置换把 luckSeed 推到想要的欧气链（萧佩吟）
     *     · jump（跳脉法）      ：跳脉 / 锁脉 / 保底紫前开槽重掷，换种子并重扫保底紫（步惊云）
     *     · both                ：两者皆可，取更省的（薛龙城）
     *   目标都一样：**抽出欧气链 + 定下保底紫序列**。
     *
     *   第二层：用种子 —— 只有一种方式
     *     · anchor（锚点法）：按锚点锁目标 → 洗到载体紫 → 置换 → 最后洗收尾脉
     *     严格来说，所有方案在种子定好之后都是锚点法；
     *     所以「跳脉法 vs 锚点法」不是并列关系，而是「定种子 vs 用种子」。
     */
    const SEED_STRATEGIES = Object.freeze({
        exchange: '无限置换（用置换推 luckSeed）',
        jump: '跳脉法（重掷种子 + 重扫保底紫序列）',
        both: '两者皆可（取更省的）',
        executor: '锚点法（种子定好之后，按锚点锁目标 → 置换 → 收尾）',
    });

    /** 路线统一入口清洗：清场上脉、vip 兜底、置换池归零（这些都会让抽签流错位）。 */
    function sanitizeRouteRaw(rawInput) {
        const raw = Object.assign({}, rawInput);
        if (Array.isArray(raw.talents) && raw.talents.length) raw.talents = [];
        raw.vip = Math.max(1, Number(raw.vip) || 0);
        raw.luck_seed = 0;
        raw.luck_seed_inited = false;
        return raw;
    }

    /**
     * 先判断「这个角色该用哪种定种子方式」，免得两种都白跑。
     *
     * 判据（使用者口径）：
     *   看自然脉序里，**从开始到四条目标的最后一条**之间有没有保底紫
     *     · 没有 → 保底紫插不进来，跳脉法无从谈起 → 只用无限置换（萧佩吟）
     *     · 有   → 保底紫会干扰，两种都值得试（步惊云 / 薛龙城）
     *
     * 返回 { strategy: 'exchange' | 'both', pityBefore: number, reason }
     */
    function strategyHint(raw, targets, opts) {
        opts = opts || {};
        const TG = (targets || []).map(Number);
        let purples = [];
        try { purples = scan(raw, Math.max(20, Number(opts.scan) || 80)) || []; } catch (err) { purples = []; }
        if (!purples.length) return { strategy: 'both', pityBefore: 0, reason: '扫不到紫脉，两种都试' };
        // 四条目标各自首次出现的位置
        const posOf = id => purples.findIndex(pp => Number(pp.id) === Number(id));
        const targetPos = TG.map(posOf).filter(i => i >= 0);
        const lastTarget = targetPos.length ? Math.max(...targetPos) : purples.length - 1;
        // 最后一条目标之前的保底紫
        const pityBefore = purples.slice(0, lastTarget + 1).filter(pp => pp.fromPity).length;
        const firstIsPity = !!(purples[0] && purples[0].fromPity);
        if (firstIsPity) {
            return { strategy: 'jump', pityBefore, firstIsPity,
                reason: '第一条紫就是保底紫：无限置换做不起来，只能跳脉法' };
        }
        if (pityBefore === 0) {
            return { strategy: 'exchange', pityBefore,
                reason: '收尾之前没有保底紫：跳脉法无从谈起，只用无限置换' };
        }
        return { strategy: 'both', pityBefore,
            reason: '收尾之前有 ' + pityBefore + ' 条保底紫：两种都试，取更省' };
    }


    /**
     * 保底紫 / 隐藏保底紫「用上没」——按**这条路线实际用的洗法**判断（使用者口径 A）。
     *
     * 为什么不自己再模拟一遍：不同洗法（裸洗 / 锁着洗 / 带锁置换推进）下，
     * 首条保底紫落到的洗数和身份都不一样（步惊云：裸洗是 269 洗，锁着洗是 289 洗「一心两用」）。
     * 所以直接读路线自己算出来的结果，才和实际一致。
     *
     * 输入 plan 可以是这几种之一：
     *   · 跳脉×隐藏保底 的 best（带 seed / firstPityWash / hiddenGot）
     *   · planJumpManualRoute 的返回值（带 field / steps）
     * 输出 { usable, id, wash, seed, why }
     */
    function hiddenUsableFromPlan(plan, targets) {
        const TG = (targets || []).map(Number);
        if (!plan || typeof plan !== 'object') return { usable: false, why: '没有可用的路线结果' };

        // ① 跳脉×隐藏保底那条：它自己已经算过「白捡了哪条」
        if (plan.hiddenGot != null) {
            const id = Number(plan.hiddenGot);
            const isTarget = TG.includes(id);
            let isShen = false;
            try { isShen = typeof isShenmai === 'function' ? !!isShenmai(id) : false; } catch (e) { isShen = false; }
            return {
                usable: isTarget || isShen, id,
                wash: Number(plan.firstPityWash) || null,
                seed: plan.seed != null ? Number(plan.seed) : null,
                why: (isTarget || isShen)
                    ? '首条保底紫（按本路线的洗法）变成了' + (isShen ? '神脉' : '目标紫')
                    : '首条保底紫不是目标、也不是神脉 → 放弃',
            };
        }

        // ② 跳脉法整路线：从它自己的 steps 里找「非目标的保底紫后来变成目标」的痕迹
        const steps = Array.isArray(plan.steps) ? plan.steps : [];
        for (const s of steps) {
            const id = Number(s && (s.to != null ? s.to : s.id));
            if (!id) continue;
            if (TG.includes(id)) {
                return { usable: true, id, wash: Number(s.washes) || null, seed: null,
                    why: '路线中途用上了这条保底紫（变成了目标）' };
            }
        }
        return { usable: false, why: '这条路线没有用上任何保底紫' };
    }

    /**
     * 单次贪心推进器 v2（使用者口径 2026-10）：
     *   边洗边决定「锁 / 置换 / 毁脉」，始终留出可洗槽；
     *   ① 神脉判定用模块级 isShenmai（不依赖引擎实例方法）
     *   ② 置换失败会记原因，不静默跳过
     *   ③ 普通目标缺冲突时，先在场上锁一条同类型低阶脉，等紫出现再换
     */
    function planGreedyRoute(rawInput, targets, opts) {
        opts = opts || {};
        const raw = sanitizeRouteRaw(rawInput);
        const TG = (targets || []).map(Number);
        if (!TG.length) return null;
        const budget = Math.max(0, Number(opts.budget) || 0) || 20000;
        const startZi = Number(opts.startZi) === 154 ? 154 : 153;
        const startWash = Math.max(0, Number(opts.startWash) || 0);
        const tailId = Number(opts.tailId) || null;
        const maxWashes = Math.max(50, Number(opts.maxWashes) || 3000);
        let e;
        try { e = engine(raw, startZi); } catch (err) { return null; }
        let s = e.initialState(Object.assign({}, raw, { zizhi: startZi }));
        let cost = 0, washes = 0, exchanges = 0;
        const steps = [], held = [], dbg = [];
        let conflictHold = null;           // ③ 为普通目标预锁的同类型低阶脉
        const typeOf = id => e.talentType(Number(id));
        const isShen = id => {
            const v = Number(id);
            try { if (typeof isShenmai === 'function') return !!isShenmai(v); } catch (err) { }
            try { if (typeof e.isShenmai === 'function') return !!e.isShenmai(v); } catch (err) { }
            return false;
        };
        const isTarget = id => TG.includes(Number(id));
        const keepOn = () => {
            const out = held.map(id => s.talents.indexOf(id));
            if (conflictHold != null) out.push(s.talents.indexOf(conflictHold));
            return out.filter(i => i >= 0);
        };
        const wash1 = () => { const r = e.wash(s, keepOn()); s = r.state; cost += Number(r.cost) || 0; washes++; return r; };
        const push = (type, extra) => steps.push(Object.assign({ type, washes, cost, locks: held.slice(), field: s.talents.slice() }, extra || {}));

        for (let i = 0; i < startWash; i++) wash1();
        push('startWash', { count: startWash, startZi });

        const pending = () => TG.filter(id => !held.includes(id));
        const lowOfType = (ty, beforeId) => nearestLowOfTypeInField(e, s.talents, ty, beforeId);

        for (let k = 0; k < maxWashes && held.length < TG.length; k++) {
            if (budget > 0 && cost > budget) break;
            const r = wash1();
            const gen = ((r && r.generatedEvents) || []).map(x => Number(x.id));

            // ① 目标：收尾脉最后拿，其余直接锁
            for (const id of gen) {
                if (!isTarget(id) || held.includes(id)) continue;
                const missing = pending();
                if (id === tailId && missing.length > 1) continue;
                held.push(id);
                push('lock', { id, target: true });
            }
            if (held.length >= TG.length) break;
            // 通用省丹规则：先锁一条目标，再开第四槽；
            // 依赖隐藏保底的专门执行器另有策略，不走这里的贪心路线。
            if (Number(e.slotCount) === 3 && held.length >= 1) {
                e = engine(raw, 154);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: 154 }));
                push('upgrade', { toZi: 154 });
            }

            // ② 置换：场上有非目标紫就换；缺冲突时先锁低阶脉
            // ③ 置换规则（引擎实测）：冲突脉必须是**载体紫同类型**的非紫脉，
            //   而且要在它之前锁定；换出来的结果由脉序决定，不由类型决定。
            const washable = (Number(e.slotCount) || 4) - held.length;
            if (washable < 3) continue;
            const missing = pending();
            if (!missing.length) break;
            const carriers = s.talents.map(Number).filter(v => e.quality(v) === 4 && !held.includes(v));
            if (!carriers.length) continue;
            let done = false;
            for (const carrier of carriers) {
                const ty = typeOf(carrier);
                const conf = lowOfType(ty, carrier);
                if (conf == null || held.includes(conf)) continue;
                const locks = Array.from(new Set(held.concat([conf])));
                const pi = s.talents.indexOf(carrier), ci = s.talents.indexOf(conf);
                if (pi < 0 || ci < 0) continue;
                const t = s.talents.slice(); t[pi] = conf; t[ci] = carrier;
                const s2 = Object.assign({}, s, { talents: t });
                const pos = s2.talents.indexOf(carrier);
                if (pos < 0 || !e.replaceablePositions(s2, locks).includes(pos)) continue;
                let rr = null;
                try { rr = e.replace(s2, pos, locks); }
                catch (err) { dbg.push({ wash: washes, why: 'replace 抛错: ' + err.message, carrier, conf }); continue; }
                if (!rr) { dbg.push({ wash: washes, why: 'replace 空', carrier, conf }); continue; }
                const added = Number(rr.addedId);
                s = rr.state;
                exchanges++;
                const keep = isTarget(added) && !held.includes(added) && (added !== tailId || pending().length === 1);
                if (keep) held.push(added);
                push('exchange', { from: carrier, to: added, locks, kept: keep, conflict: conf });
                done = true;
                break;
            }
            if (done) continue;
        }

        const got = TG.filter(id => held.includes(id)).length;
        return { ok: got === TG.length, cost, washes, exchanges, got, steps, dbg, held: held.slice(),
            field: s.talents.slice(),
            reason: got === TG.length ? '' : '只拿到 ' + got + '/' + TG.length + '（缺 ' + TG.filter(id => !held.includes(id)).join(',') + '）' };
    }

    /**
     * 收尾脉的选取规则（使用者口径 2026-10 定稿）：
     *
     *   收尾脉 = **任一目标** 或 **任一神脉**，注意「神脉」不要求是目标 ——
     *   非目标神脉（九阴鬼脉 / 玄阳神脉 / 混元奇脉 ……）同样可以当收尾脉。
     *
     *   理由：神脉锁上之后还能**再推进一次置换序列**，
     *        所以一条非目标神脉当收尾，等于「多给一次把最后一条目标换出来的机会」。
     *        柳如意就是这种走法：混元奇脉收尾 → 玄阳→玄阳 → 换出转世金仙。
     */
    const TAIL_RULES = Object.freeze({
        targetsAreTails: true,        // 目标本身可以当收尾脉
        nonTargetShenTails: true,     // 非目标神脉也可以当收尾脉
        shenGivesExtraAdvance: true,  // 神脉收尾后允许再推进一次置换
        minPositionByTargetCount: true,   // 收尾脉在原始脉序里的位置必须 ≥ 目标紫数
        mustRescanPityAfterSeed: true,  // 「种子固定后，需扫描保底紫的变化，来决定它是否可以当收尾脉」
        ruleText: '种子固定后，需扫描保底紫的变化，来决定它是否可以当收尾脉',
        // ★ 非目标神脉当收尾时的额外要求（使用者 2026-10）：
        //   · 置换脉序里**最后一个目标必须是「目标中的非神脉」**
        //   · 且它之前（置换脉序 ∪ 可操作原始脉序）必须已包含**其余三个目标**
        nonTargetShenTailNeedsNormalLastTarget: true,
        note: '收尾脉 = 任一目标 或 任一神脉（含非目标）；位置 ≥ 目标紫数（4目标→≥4）；种子固定后，需扫描保底紫的变化，来决定它是否可以当收尾脉；神脉收尾后可再推进一次置换',
    });

    /**
     * 从脉序里挑出可以当收尾脉的候选项（使用者规则 2026-10）。
     *
     * 规则原话（使用者 2026-10）：「种子固定后，需扫描保底紫的变化，来决定它是否可以当收尾脉」
     *
     * 判定顺序：
     *   ① **先洗到首条保底紫，拿到它写下的欧气种子**
     *      —— 保底紫的洗数位置不变、身份完全由种子决定（见 pityPurplesForSeed 的注释），
     *         所以必须用**种子固定后重扫**的脉序，不能用初始扫描结果。
     *         柳如意：固定前 #3 是「玄阳神脉@556」，固定后同位置变成「天生神力」——
     *         玄阳的真实位置是 #7（887），而不是 #3。
     *   ② 在重扫后的脉序上，保留 **目标** 或 **神脉**（神脉不要求是目标）
     *   ③ 且它在重扫脉序里的位置（首次出现）**≥ 目标紫数**
     *      （4 目标 → 第 4 条及以后；3 目标 → 第 3 条及以后）
     *
     * @return 收尾候选 id 数组
     */
    function tailCandidates(raw, targets, opts) {
        opts = opts || {};
        const TG = (targets || []).map(Number);
        const N = TG.length;
        const zi = Number(raw && raw.zizhi) >= 154 ? 154 : 153;
        let e0 = null;
        try { e0 = engine(raw, zi); } catch (e) { e0 = null; }
        const isShen = id => { try { return e0 && typeof e0.isShenmai === 'function' ? !!e0.isShenmai(Number(id)) : false; } catch (e) { return false; } };

        // ① 洗到首条保底紫，拿种子
        let seed = null;
        try {
            let st = e0.initialState(Object.assign({}, raw, { zizhi: zi }));
            for (let w = 1; w <= 3000 && seed == null; w++) {
                const r = e0.wash(st, []);
                st = r.state;
                for (const ev of (r.generatedEvents || [])) {
                    if (ev.fromPity) { seed = Number(st.luckSeed); break; }
                }
            }
        } catch (err) { seed = null; }

        // ② 用该种子重扫脉序（没有种子就退回初始扫描）
        let seq = [];
        try {
            seq = scan(Object.assign({}, raw, {
                zizhi: zi,
                luck_seed: seed == null ? Number(raw.luck_seed) || 0 : seed,
                luck_seed_inited: seed != null ? true : !!raw.luck_seed_inited,
            }), Math.max(20, Number(opts.count) || 30)) || [];
        } catch (err) { seq = []; }

        const firstPos = new Map();
        seq.forEach((p0, i) => {
            const id = Number(p0 && p0.id);
            if (!id || firstPos.has(id)) return;
            firstPos.set(id, i + 1);
        });
        const out = [], seen = new Set();
        seq.forEach((p0, i) => {
            const id = Number(p0 && p0.id);
            if (!id || seen.has(id)) return;
            const pos = firstPos.get(id) || (i + 1);
            if (pos < N) return;                       // ③ 位置先够
            if (!(TG.includes(id) || isShen(id))) return;   // ② 目标或神脉
            seen.add(id);
            out.push(id);
        });
        if (!out.length) TG.forEach(id => { if (!seen.has(id)) { seen.add(id); out.push(id); } });
        return out;
    }

    /**
     * 术语（使用者口径 2026-10，必须分清）：
     *
     *   · **原始脉序**：按洗数排出来的紫（含保底紫）。
     *       - 普通紫：**固定不变**，和欧气种子无关；
     *       - 保底紫：**洗数位置固定，身份随欧气种子改变**。
     *     所以**只有保底紫需要扫描**——种子一换，就要重扫保底紫变成了哪条
     *     （见 pityPurplesForSeed）。
     *
     *   · **种子链（置换脉序）**：欧气池里依次换出来的那串紫（peekLuckPool）。
     *     整条由 luckSeed 决定；置换一次、开槽一次，种子链就整条换掉。
     *
     *   定种子（置换 / 开槽 / 垫洗）改的是**种子链**，同时也改掉**保底紫的身份**；
     *   普通紫始终不变。
     */
    const SEQUENCE_TERMS = Object.freeze({
        originalSequence: '原始脉序：按洗数排的紫（含保底紫）；普通紫固定不变，只有保底紫的身份随欧气种子改变（洗数位置不变）',
        seedChain: '种子链（置换脉序）：欧气池依次换出来的紫（peekLuckPool），整条由 luckSeed 决定',
        rescanPity: '因为只有保底紫的身份会随种子变，所以种子固定后必须重扫保底紫（pityPurplesForSeed）',
        chooseBy: '定种子（置换/开槽/垫洗）改的是种子链，同时改变保底紫的身份；普通紫不变',
        nonTargetShenTail: '非目标神脉当收尾：置换脉序里最后一个目标必须是目标中的非神脉；它之前的「置换脉序 ∪ 可操作原始脉序」必须已含其余三个目标',
        seedFixMeans: '固定种子的手段（同级）：跳脉法的跳脉/锁脉/保底紫前开槽重掷；无限置换的置换/开4槽再洗；垫洗是它们的前置调节',
        rescanSeedTiming: '重扫用的种子 = 固定种子动作之后、下一条保底写种子之前的 luckSeed（保底紫抽完会写下新种子，那个新种子不能用来重扫）',
        operableSequence: '定种子（跳脉/锁脉/置换/开4槽，可先垫洗）之后，必须用该种子重扫原始脉序；重扫出来的那份才是「可操作的原始脉序」，固定前扫的只能当参考',
    });

    /**
     * 「可操作的原始脉序」——使用者规则（2026-10 定稿）：
     *
     *   ⓿ **重扫用哪个种子**（关键，错一步整条脉序就废）：
     *        用「**固定种子的动作之后、下一条保底写种子之前**」的那个 luckSeed。
     *        保底紫自己抽完会**写下新种子**，那个新种子是给后面用的，
     *        拿它重扫会把刚拿到的那条保底紫换成别的（柳如意就会把术绍岐黄扫成鹤骨龙筋）。
     *        实测（柳如意）：
     *          447 洗 置换拳脚无双→岿然顶天  → luckSeed = 925373591  ← 重扫用这个
     *          748 洗 保底出术绍岐黄          → luckSeed 变成 733460092（不能用）
     *        用 925373591 重扫：#3 = 术绍岐黄 ✓
     *        用 733460092 重扫：#3 = 鹤骨龙筋 ✗
     *
     *   ① **固定欧气种子的手段**（全部同级，都是手段、不是步骤）：
     *        · 跳脉法：**跳脉 / 锁脉 / 保底紫前开槽重掷**（前置可垫洗）
     *        · 无限置换：**置换 / 开 4 槽再洗**（前置可垫洗）
     *      垫洗本身不是独立手段，它是这些手段的**前置调节**。
     *   ② 种子一旦固定，**必须用该种子重新扫描原始脉序**；
     *   ③ 重扫出来的那一份，才是**可操作的原始脉序**；
     *      固定前扫的那份只能当参考，**不能拿来规划路线**。
     *
     * 原因：原始脉序里**普通紫固定不变**，但**保底紫的身份随欧气种子改变**（洗数位置不变）。
     *      种子没固定时，保底紫的身份是不确定的，所以那份序列不可操作。
     *
     * @param raw   角色原始状态
     * @param seed  固定下来的欧气种子
     * @param opts  { zizhi, count }
     * @return [{ id, name, wash, no, fromPity }]
     */
    function operableOriginalSequence(raw, seed, opts) {
        opts = opts || {};
        const zi = Number(opts.zizhi) >= 154 ? 154 : (Number(raw && raw.zizhi) >= 154 ? 154 : 153);
        let seq = [];
        try {
            seq = scan(Object.assign({}, raw, {
                zizhi: zi,
                luck_seed: Number(seed) || 0,
                luck_seed_inited: seed != null,
            }), Math.max(10, Number(opts.count) || 30)) || [];
        } catch (err) { seq = []; }
        return seq;
    }

    /**
     * 判断「非目标神脉当收尾」这条路是否成立（使用者规则 2026-10）。
     *
     * 条件：
     *   ① 收尾脉是**神脉且不是目标**；
     *   ② 置换脉序里**最后一个目标**必须是「目标中的非神脉」
     *      （神脉目标不能当最后一个，因为它自己也要靠推进）；
     *   ③ 那个最后目标之前，「置换脉序 ∪ 可操作原始脉序」的合集里
     *      必须已经包含**其余三个目标**。
     *
     * @param tailId   收尾脉 id
     * @param targets  目标 id 数组
     * @param chain    置换脉序 id 数组
     * @param original 可操作原始脉序 [{id, wash}]
     * @param isShen   神脉判定函数
     * @return { ok, lastTargetIndex, missing, reason }
     */
    function nonTargetShenTailCheck(tailId, targets, chain, original, isShen) {
        const TG = (targets || []).map(Number);
        const shen = typeof isShen === 'function' ? isShen : () => false;
        if (tailId == null || !shen(tailId)) return { ok: false, reason: '收尾脉不是神脉' };
        if (TG.includes(Number(tailId))) return { ok: false, reason: '收尾脉是目标，不适用本规则' };
        const normalTargets = TG.filter(id => !shen(id));
        if (!normalTargets.length) return { ok: false, reason: '目标里没有非神脉，无法当最后一条' };
        const ch = ((chain || []).map(x => (x && x.to != null ? Number(x.to) : Number(x))));
        const origin = new Set(((original || []).map(x => (x && x.id != null ? Number(x.id) : Number(x)))));
        const tried = [];
        // ★ 逐个「非神脉目标」当最后一个目标试
        for (const lastId of normalTargets) {
            const idxInChain = ch.lastIndexOf(lastId);
            if (idxInChain < 0) { tried.push({ lastId, ok: false, why: '置换脉序里没有它' }); continue; }
            const before = new Set(ch.slice(0, idxInChain));
            origin.forEach(id => before.add(id));
            const missing = TG.filter(id => id !== lastId && !before.has(id));
            tried.push({ lastId, idxInChain, missing });
            if (!missing.length) return { ok: true, lastTargetIndex: idxInChain, lastTargetId: lastId, missing: [], tried, reason: '满足' };
        }
        const best = tried.reduce((a, b) => (!a || (b.missing || []).length < (a.missing || []).length ? b : a), null);
        return { ok: false, tried, missing: best ? best.missing : TG, reason: '没有哪个非神脉目标能在它之前凑齐其余三条' };
    }


    /**
     * 取「种子链（置换脉序）」——使用者规则 2026-10：
     *
     *   **必须从实际执行的路线里取**，不能用 peekLuckPool 那种「合成场推算」，
     *   因为真实置换结果还取决于当时的场上、锁了谁、bornRC。
     *
     *   柳如意实测：合成推算 = 术绍/鹤骨/混元/玄阳/金仙（错）
     *              实际路线 = 岿然顶天/鹤骨龙筋/混元/玄阳/金仙（对）
     *
     * @param run  任意规划结果（带 steps 数组）
     * @return [{ from, to, washes, kept }]
     */
    function exchangeChainOf(run) {
        const steps = (run && run.steps) || [];
        return steps
            .filter(s => s && s.type === 'exchange' && s.to != null)
            .map(s => ({ from: Number(s.from), to: Number(s.to), washes: Number(s.washes) || 0, kept: !!s.kept }));
    }

    /**
     * 读「种子链（置换脉序）」——使用者规则 2026-10 定稿：
     *
     *   ① **第 1 条 = 定种子那次置换的结果**（定种子动作本身产生的那条紫）；
     *   ② 后续条目 = **实际置换读取**出来的（按顺序，一条条换出来的结果）；
     *   ③ 与 DRAW(种子) 抽出来的池子**不一致时，以实际读取为准**——
     *      DRAW 只当参考（池子是理论序列，实际能不能换、换出什么，以引擎实跑为准）。
     *
     *   柳如意实测（1,081 洗 / 5,757 丹 的读取记录）：
     *     岿然顶天(447) → 鹤骨龙筋(750) → 混元奇脉(941) → 玄阳神脉(976)
     *     → 转世金仙(1075) → 不灭肉身(1075)
     *
     *   ★ 种子口径（2026-10-19 干净实测钉死）：
     *     置换时 bornSeed=1553749989，置换后 luckSeed=925373591。
     *     DRAW(born@置换时=1553749989) = [岿然顶天、术绍岐黄、鹤骨龙筋、混元奇脉、
     *     玄阳神脉、转世金仙、不灭肉身…] —— 与实测完全一致（第 0 条岿然顶天=定种子换果，
     *     第 1 条术绍岐黄=首条保底，第 2 条起=后续置换）。
     *     所以「DRAW(925373591) 从术绍岐黄开始」不是两条链——925373591 是**置换之后**
     *     的链头（第 0 条已被定种子置换消耗），从它抽自然从第 1 条开始。
     *     抽取未来序列一律用「落盘的 luckSeed（定种子动作之后的链头）」；
     *     DRAW[0] = 下一次欧气事件的结果，不含定种子那次换果。
     */
    function seedChainOf(a, b, c) {
        // 传路线结果：直接取它实际发生的置换（第 1 条就是定种子那次的换果）
        if (a && typeof a === 'object' && Array.isArray(a.steps)) {
            return exchangeChainOf(a).map(x => x.to);
        }
        const raw = a, targets = b, opts = c || {};
        let run = null;
        try { run = planGreedyRoute(raw, targets, opts); } catch (err) { run = null; }
        return run ? exchangeChainOf(run).map(x => x.to) : [];
    }

    /**
     * DRAW 读池子（只作参考，和实际读取不一致时以实际为准）。
     * ⚠ seed 必须是「落盘的 luckSeed」（定种子动作之后的链头）：DRAW[0] 是下一次
     * 欧气事件的结果。要连定种子换果一起看，得从 born@定种子时 起抽（见 seedChainOf 注释）。
     */
    function drawSeedChain(raw, seed, count) {
        const zi = Number(raw && raw.zizhi) >= 154 ? 154 : 153;
        let e = null;
        try { e = engine(raw, zi); } catch (err) { return []; }
        let luck = Number(seed) || 0;
        const out = [];
        for (let i = 0; i < 4000 && out.length < (Number(count) || 15); i++) {
            let id;
            try { [id, luck] = e.draw(luck, true); } catch (err) { break; }
            if (e.allowed.has(id)) out.push(Number(id));
        }
        return out;
    }

root.AutoWash2UnifiedAnchorPlanner=Object.freeze({engine,scan,search,replay,eventKey,usableSources,prefilterSequence,autoAnchors,tailFirstAnchors,naturalFirstAnchors,estimateTailCost,washPrefix,estimateLockedWashes,greedyNaturalPlan,greedyNaturalBest,greedyHybridPlan,greedyHybridBest,slotExchangeable,tailScanCandidates,tailScanPlan,tailExchangeBest,exchangeFirstPlan,exchangeFirstBest,tailLadderCost,planThenExecuteDynamic,pityPurplesForSeed,planPoolDriven,peekLuckPool,probeWindow,planTimeline,nSeedPlan,nSeedPlanOnce,anSeedPlan,poolPlanOnce,poolSeedPlan,jumpMethodPolicy,ADVANCE_CHAIN_RULES,verifyTimeline,timelinePlan,planJumpChain,planSlotRerollRoutes,planJumpManualRoute,searchJumpManualRoute,SEED_STRATEGIES,sanitizeRouteRaw,strategyHint,hiddenUsableFromPlan,planGreedyRoute,TAIL_RULES,tailCandidates,SEQUENCE_TERMS,operableOriginalSequence,nonTargetShenTailCheck,exchangeChainOf,seedChainOf,drawSeedChain});
})(typeof window!=='undefined'?window:globalThis);
;
