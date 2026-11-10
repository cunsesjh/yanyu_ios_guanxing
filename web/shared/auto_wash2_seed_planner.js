// 欧气种子路线规划器
// ==============
//
// 特别鸣谢 B站大佬「庸丶人」提供欧气种子路线、吞脉/跳脉及统一路线构造的研究方案。
// 本文件从获授权的研究实现中抽取为独立候选引擎；最终路线仍由 iosGuanxing
// 自己的 AutoWash2Seed 适配层和当前 WashSourceEngine 重新回放验证。
//
// 把「想要哪几条紫脉」反解成「一槽一槽照着点的步骤」，并给出 TXT 洗法。
//
// 依据（均在 qqjdat / wcsdat 上逐条实测）：
//   1. 保底进度达到阈值（3 槽 850 / 4 槽 900）的那一次插入保底紫；
//      每洗 +未锁槽数，跳脉那次少 1（少填一个槽，但被跳掉的抽签照样消耗 born 流）。
//   2. 欧气种子在**首次保底或首次置换**那一刻写下（`luck = born`），之后永久固定。
//   3. 这条流就是一条**紫脉队列**：每发生一次「保底」或「置换」都取走队首一条。
//   4. 跳脉只在**种子还没写下**时有效；种子固定后跳脉只能把保底次数往后挪 1~3 次。
//   5. 跳脉**不影响自然紫脉序**（born 流位置不变），所以自然紫照常洗即可。
//
// 依赖（与 anchor_route_planner.js 相同）：TALENT_DATA / ZZ_DATA / WashSourceEngine
(function (root) {
    'use strict';

    const asList = v => !v ? [] : Array.isArray(v) ? v : (typeof v === 'object' ? Object.values(v) : []);
    const nameOf = id => (root.TALENT_DATA[String(id)] || {}).name || ('#' + id);

    function ruleFor(zizhi) {
        const zz = root.ZZ_DATA[String(Number(zizhi))];
        if (!zz || !zz.num_talent) return null;
        return { slots: zz.num_talent, pity: Number(zz.bd_zz) || 0, eat: Number(zz.eat_xisui) || 0 };
    }
    function makeEngine(raw, zizhi) {
        const r = ruleFor(zizhi);
        return new root.AutoWash2Engine.Engine(root.TALENT_DATA, Object.assign({}, raw, { zizhi }), {
            slotCount: r.slots, pity: r.pity, eat: r.eat, eligibleZi: Number(zizhi),
            advancePerDraw: true,
        });
    }
    const positionsOf = (s, ids) => ids.map(id => s.talents.indexOf(id)).filter(i => i >= 0);
    // 跳脉选点规则：当前场上 ∩ 紧接着下一次洗髓的前 (槽数−1) 列
    function pickJump(e, s, needJump) {
        const nxt = e.wash(s, []).state.talents.slice(0, needJump);
        for (let i = 0; i < s.talents.length; i++) if (nxt.includes(s.talents[i])) return i;
        return -1;
    }
    // 做 jumps 次跳脉后洗到首条保底紫
    function runToFirstPity(raw, zizhi, jumps, cap = 6000) {
        const e = makeEngine(raw, zizhi);
        const rule = ruleFor(zizhi);
        let s = e.initialState(Object.assign({}, raw, { zizhi })), w = 0, cost = 0, done = 0, since = 0, pending = false;
        while (w < cap) {
            if (done < jumps && (pending || since === (done === 0 ? 7 : rule.slots))) {
                const p = pickJump(e, s, rule.slots - 1);
                if (p >= 0) {
                    const jr = e.wash(s, [p]);
                    s = jr.state;
                    cost += Number(jr.cost) || 0;
                    w++;
                    done++;
                    since = 0;
                    pending = false;
                    continue;
                }
                pending = true;
            }
            const r = e.wash(s, []); s = r.state; cost += Number(r.cost) || 0; w++; since++;
            if (r.pityPurpleId != null)
                return { seed: s.luckSeed, first: r.pityPurpleId, wash: w, cost, done, field: s.talents.slice() };
        }
        return null;
    }
    // 从种子抽出紫脉队列（= 置换脉序 = 后续保底紫的来源）
    function queueOf(raw, zizhi, seed, count) {
        const e = makeEngine(raw, zizhi);
        let s = seed; const out = [];
        for (let i = 0; i < 20000 && out.length < count; i++) {
            const [id, next] = e.draw(s, true); s = next;
            if (e.isAllowedAt(id, Number(zizhi))) out.push(id);
        }
        return out;
    }
    /**
     * 分析：首条保底紫 / 种子是否已固定 / 各档（跳几次 → 首条保底紫 + 种子 + 队列）
     */
    function analyze(raw, opts) {
        opts = opts || {};
        const zizhi = Number(opts.zizhi) || Number(raw.zizhi) || 153;
        const rule = ruleFor(zizhi);
        if (!rule) return { error: `资质 ${zizhi} 没有可洗槽位` };
        const maxJump = Number(opts.maxJump) || rule.slots * 6;
        const top = Number(opts.queueLength) || 20;
        const seedFixed = !!(raw.luck_seed_inited);
        const base = runToFirstPity(raw, zizhi, 0);
        if (!base) return { error: '6000 次洗髓内没有出现保底紫' };
        const archetypes = [];
        const jumpStep = Number(rule.slots) || 3;
        const probeEnd = Math.min(maxJump, jumpStep);
        const probe = new Map([[0, base]]);
        for (let j = 1; j <= probeEnd; j++) probe.set(j, runToFirstPity(raw, zizhi, j));
        let firstBoundary = probeEnd;
        const beforeEdge = probe.get(probeEnd - 1);
        const atEdge = probe.get(probeEnd);
        if (beforeEdge && atEdge
            && Number(beforeEdge.seed) === Number(atEdge.seed)) {
            firstBoundary = probeEnd - 1;
        }
        const jumpValues = [];
        for (let j = 0; j <= firstBoundary; j++) jumpValues.push(j);
        for (let j = firstBoundary + jumpStep; j <= maxJump; j += jumpStep) jumpValues.push(j);
        if (jumpValues[jumpValues.length - 1] !== maxJump) jumpValues.push(maxJump);
        for (const j of jumpValues) {
            const r = probe.get(j) || runToFirstPity(raw, zizhi, j);
            if (!r) continue;
            const last = archetypes[archetypes.length - 1];
            if (last && last.seed === r.seed) { last.jumpsTo.push(j); continue; }
            archetypes.push({ jumps: j, jumpsTo: [j], seed: r.seed, first: r.first, wash: r.wash,
                queue: queueOf(raw, zizhi, r.seed, top) });
        }
        return { zizhi, rule, seedFixed, base, archetypes };
    }

    /**
     * 生成能照着点的步骤（含可选置换路线），并做独立回放校验。
     * allowExchange: false 不用置换 / true 只换目标 / 'burn' 低进度也烧废紫
     */
    function buildPlan(raw, zizhi, arch, targets, allowExchange, opts) {
        opts = opts || {};
        // 用户方案：3 槽存档洗 3~4 条目标时，锁住第一条紫之后就开第 4 槽更省丹
        // （4 槽每洗进度 +3、3 槽 +2；锁定越多差距越大）。要不要开、什么时候开，最后由丹耗对比决定。
        // 开第 4 槽的时机由「已经锁住几条目标」决定：N=0 不开、N=1 锁第一条后开、
        // N=2/3 表示锁到第 2/3 条再开。实测时机很关键（用户案例是锁到第 3 条才开）。
        const upgradeTo = Number(opts.upgradeTo) || (opts.upgradeAfterFirstLock ? 154 : 0);
        const upgradeAt = upgradeTo ? (Number(opts.upgradeAtLockCount) || 1) : 0;
        let curZizhi = zizhi;
        let rule = ruleFor(curZizhi);
        let e = makeEngine(raw, curZizhi);
        const initRaw = Object.assign({}, raw, { zizhi: curZizhi });
        let s = e.initialState(initRaw);
        let upgraded = !upgradeTo;
        const steps = [];
        let lockIds = [], pending = 0, cursor = 0;
        const flush = () => {
            if (pending > 0) { steps.push({ type: 'wash', lockIds: lockIds.slice(), count: pending, field: s.talents.slice() }); pending = 0; }
        };
        const setLocks = ids => {
            const a = ids.slice().sort().join(','), b = lockIds.slice().sort().join(',');
            if (a !== b) { flush(); lockIds = ids.slice(); }
        };
        // 阶段 A：选种 —— 两条路，二选一
        //   ① 跳脉选档（arch.jumps 次跳脉）
        //   ② 锁法挪种子（前奏段：洗 switchAt 次不锁 → 锁 lockCount 条低阶脉 → 洗到首条保底紫 → 释放）
        //      两者本质相同（都挪动「种子写下的那一刻」），但锁法的调节粒度细得多。
        const prelude = opts.prelude || null;
        let done = 0, since = 0, pendingJump = false, guard = 0;
        if (prelude) {
            for (let i = 0; i < Number(prelude.switchAt) && guard++ < 40000; i++) {
                s = e.wash(s, []).state; pending++; cursor++;
            }
            flush();
            const lowsAll = [...new Set(s.talents.filter(id => e.quality(id) < 4))];
            const pick = Math.max(0, Number(prelude.lockPick) || 0) % Math.max(1, lowsAll.length);
            const lows = lowsAll.slice(pick).concat(lowsAll.slice(0, pick)).slice(0, Number(prelude.lockCount) || 1);
            setLocks(lows);
            let got = false, guard2 = 0;
            while (!got && guard2++ < 4000) {
                const r = e.wash(s, positionsOf(s, lockIds));
                s = r.state; pending++; cursor++;
                if (r.pityPurpleId != null) got = true;
            }
            flush();
            setLocks([]);                                   // 前奏段的锁只是用来挪种子，到手就释放
        }
        while (!prelude && done < arch.jumps && guard++ < 40000) {
            if (pendingJump || since === (done === 0 ? 7 : rule.slots)) {
                const p = pickJump(e, s, rule.slots - 1);
                if (p >= 0) {
                    const keep = s.talents[p];
                    setLocks([...lockIds, keep]);
                    s = e.wash(s, positionsOf(s, lockIds)).state; pending++; cursor++;
                    flush();
                    setLocks(lockIds.filter(id => id !== keep));
                    done++; since = 0; pendingJump = false;
                    continue;
                }
                pendingJump = true;
            }
            s = e.wash(s, positionsOf(s, lockIds)).state; pending++; since++; cursor++;
        }
        flush();
        // 阶段 B：逐条收集目标
        const want = new Set(targets), held = new Set();
        let queue = arch.queue;
        let qi = 0, exchanges = 0;
        const heldPos = () => positionsOf(s, [...held]);
        const lockIdsNow = extra => [...held, ...(extra != null ? [extra] : [])];
        const advanceQi = producedId => {
            for (let i = qi; i < queue.length; i++) if (queue[i] === producedId) { qi = i + 1; return; }
            qi = Math.min(qi + 1, queue.length);
        };
        let guardB = 0, padTries = 0;
        while (guardB++ < 100000) {
            for (const id of s.talents) if (want.has(id)) held.add(id);
            setLocks([...held]);
            // 锁住第一条紫之后就开第 4 槽：换引擎换规则（槽数/阈值/吃丹全变），
            // 并用新资质从当前欧气种子重算紫脉队列（可用紫集合会变大）。
            if (!upgraded && held.size >= upgradeAt && curZizhi !== upgradeTo) {
                flush();
                upgraded = true;
                steps.push({ type: 'upgrade', zi: upgradeTo, field: s.talents.slice() });
                curZizhi = upgradeTo;
                rule = ruleFor(curZizhi);
                e = makeEngine(raw, curZizhi);
                s = Object.assign({}, s, { zizhi: curZizhi });
                if (s.luckSeed != null) { queue = queueOf(raw, curZizhi, s.luckSeed, 20); qi = 0; }
                continue;
            }
            if (targets.every(id => held.has(id))) break;
            // 主动垫保底换目标（动态决策，用的是**当下**的队列指针）：
            //   还缺目标、槽位有富余 → 多锁几条低阶脉，把可洗压缩到 1 条；
            //   垫到保底紫出现 —— 挤出来的正好是缺的目标就收下（白捡一条），不是就放掉回到常规洗法。
            //   这正是「隐藏保底紫」在真实路线里的用法：探测到就拿来当锚点，不是目标就无视。
            const nextPity = queue[qi];
            const padWorth = nextPity !== undefined && want.has(nextPity) && !held.has(nextPity);
            if (opts.padForTarget && padWorth && padTries < 3 && held.size >= 1 && held.size + 1 < rule.slots) {
                const lows = [...new Set(s.talents.filter(id => e.quality(id) < 4))].filter(id => !held.has(id));
                const needMore = (rule.slots - 1) - held.size;
                if (lows.length >= needMore) {
                    padTries++;
                    const keep = lockIds.slice();                       // 记住回退点
                    const padLocks = [...held, ...lows.slice(0, needMore)];
                    flush(); setLocks(padLocks);
                    let padGot = null, g3 = 0;
                    while (padGot == null && g3++ < 1500) {
                        const r = e.wash(s, positionsOf(s, lockIds));
                        s = r.state; pending++; cursor++;
                        if (r.pityPurpleId != null) padGot = r.pityPurpleId;
                    }
                    if (padGot != null && want.has(padGot)) {          // 白捡到了缺的目标
                        advanceQi(padGot);
                        held.add(padGot); setLocks([...held]); flush();
                        continue;
                    }
                    if (padGot != null) advanceQi(padGot);             // 不是目标也要推进指针
                    // 不是目标 → 放掉这次垫洗（保留已锁目标，继续常规洗法）
                    setLocks(keep);
                    flush();
                }
            }
            if (held.size >= rule.slots) break;
            if (cursor > 60000) break;
            const lows = allowExchange === false ? []
                : [...new Set(s.talents.filter(id => e.quality(id) < 4))].filter(id => !held.has(id));
            let burn = null;
            for (const L of lows) {
                const locks = [...heldPos(), s.talents.indexOf(L)].sort((a, b) => a - b);
                if (locks.length >= rule.slots) continue;
                const trial = e.wash(s, locks);
                const newP = trial.state.talents.filter(id => e.quality(id) === 4 && !s.talents.includes(id));
                if (newP.length !== 1) continue;
                const pos = e.replaceablePositions(trial.state, [L])[0];
                if (pos === undefined) continue;
                const ex = e.replace(trial.state, pos, [L]);
                const isTargetOut = want.has(ex.addedId) && !held.has(ex.addedId);
                const cheapToReset = Number(s.talLucky || 0) < rule.pity / 4;
                if (!isTargetOut && !(allowExchange === 'burn' && cheapToReset)) continue;
                burn = { L, trial, ex };
                break;
            }
            if (burn) {
                flush();
                steps.push({ type: 'wash', lockIds: lockIdsNow(burn.L), count: 1, field: burn.trial.state.talents.slice() });
                s = burn.trial.state; cursor++; exchanges++;
                steps.push({ type: 'exchange', lockIds: lockIdsNow(burn.L), from: burn.ex.removedId, to: burn.ex.addedId, field: burn.ex.state.talents.slice() });
                advanceQi(burn.ex.addedId);
                if (want.has(burn.ex.addedId)) held.add(burn.ex.addedId);
                s = burn.ex.state;
                lockIds = [...held]; pending = 0;
                continue;
            }
            const rn = e.wash(s, heldPos());
            s = rn.state; pending++; cursor++;
            // 保底紫自然出现时队列也会前进，指针要跟上，否则 queue[qi] 不是真正的下一条
            if (rn.pityPurpleId != null) advanceQi(rn.pityPurpleId);
        }
        flush();
        return { steps, field: s.talents.slice(), washes: cursor, exchanges,
            reachedAll: targets.every(id => s.talents.includes(id)) };
    }

    // 独立重放整份计划（含置换步骤），并累计丹耗
    function replayPlan(raw, zizhi, steps) {
        let e = makeEngine(raw, zizhi);
        let s = e.initialState(Object.assign({}, raw, { zizhi }));
        let washes = 0, pills = 0, exchanges = 0;
        for (const st of steps) {
            if (st.type === 'upgrade') {
                // 开槽会换规则（槽数/阈值/吃丹），必须换引擎
                e = makeEngine(raw, st.zi);
                s = Object.assign({}, s, { zizhi: Number(st.zi) });
                continue;
            }
            if (st.type === 'exchange') {
                const lows = st.lockIds.filter(id => e.quality(id) < 4);
                const p = e.replaceablePositions(s, lows)[0];
                if (p === undefined) return { ok: false, error: '置换条件不成立（前面没有同类型低阶冲突脉）', field: s.talents.slice() };
                const r = e.replace(s, p, lows);
                if (r.addedId !== st.to) return { ok: false, error: `置换产出不符：预期 ${nameOf(st.to)}，实际 ${nameOf(r.addedId)}`, field: s.talents.slice() };
                s = r.state; exchanges++;
                continue;
            }
            for (let i = 0; i < st.count; i++) {
                const pos = positionsOf(s, st.lockIds);
                if (pos.length !== st.lockIds.length) return { ok: false, error: '锁定脉已不在场上', field: s.talents.slice() };
                const r = e.wash(s, pos);
                s = r.state; washes++; pills += Number(r.cost) || 0;
            }
        }
        return { ok: true, field: s.talents.slice(), washes, pills, exchanges };
    }

    /**
     * 反解：给定目标紫脉，挑最省的档 + 方案，返回可直接展示/导出的计划。
     */
    function solve(raw, targetIds, opts) {
        opts = opts || {};
        // The budget covers every part of solve(), including seed sweeping.
        // Previously it started after sweepSeeds(), allowing a nominal 1s
        // search to block the worker for tens of seconds.
        const timeBudget = Math.max(50, Number(opts.timeBudgetMs) || 8000);
        const startedAt = Date.now();
        const deadline = startedAt + timeBudget;
        // 目标是 4 槽时，规则必须按资质 154 算（阈值 900、吃丹 5、4 槽），
        // 所以分析/生成/回放统一用 154；计划开头再补一步「开启第4槽」。
        const wantSlots = Number(opts.slots) || 0;
        const effZizhi = Number(opts.zizhi) || (wantSlots === 4 ? 154 : (Number(raw.zizhi) || 153));
        const info = analyze(raw, Object.assign({}, opts, { zizhi: effZizhi }));
        if (info.error) return info;
        const targets = (targetIds || []).map(Number);
        const hits = [];
        info.archetypes.forEach((a, i) => {
            const obtainable = [a.first].concat(a.queue);
            const pos = targets.map(id => obtainable.indexOf(id));
            if (pos.some(p => p < 0)) return;
            hits.push({ arch: i, pos, events: Math.max.apply(null, pos) });
        });
        hits.sort((x, y) => x.events - y.events || x.arch - y.arch);
        if (!hits.length) return Object.assign({}, info, { noSolution: true });
        // 变体矩阵：置换策略 × 是否「锁住第一条紫后开第 4 槽」。全部真做一遍，最后按丹耗取最省。
        const maxPills = Math.max(0, Number(opts.maxPills) || 0);   // 0 = 不限制
        const wantSlots4 = Number(opts.slots) === 4;
        // 变体矩阵第二维：开第 4 槽的时机（0=不开；n=锁到第 n 条目标后再开）
        const upgradeOptions = Number(raw.zizhi) >= 154 ? [0] : [0, 1, 2, 3, 4].filter(n => n <= info.rule.slots);
        const firstField = asList(raw.talents).map(t => Number(t.id != null ? t.id : t));
        const evaluateOne = (arch, prelude, padFor) => {
            const variants = [];
            for (const allowExchange of [false, 'burn']) {
                for (const up of upgradeOptions) {
                    const plan = buildPlan(raw, info.zizhi, arch, targets, allowExchange,
                        { upgradeTo: up ? 154 : 0, upgradeAtLockCount: up || 1, prelude,
                          padForTarget: padFor === undefined ? !!opts.padForTarget : !!padFor });
                    // 要按 4 槽规划、但存档还是 3 槽：不开槽变体表示「先把第4槽开了再洗」，
                    // 所以在计划开头补一步开槽（保留这个策略与「锁到第 n 条后再开」对比）
                    if (wantSlots4 && Number(raw.zizhi) < 154 && !up)
                        plan.steps.unshift({ type: 'upgrade', zi: 154, field: firstField.slice() });
                    const check = replayPlan(raw, info.zizhi, plan.steps);
                    variants.push({ allowExchange, upgradeAtLockCount: up, plan, check });
                }
            }
            const okAll = variants.filter(v => v.check.ok && targets.every(id => v.check.field.includes(id)));
            // 丹耗上限：只看上限以内的方案（和「模拟洗脉最大耗丹数量」一致）
            const good = maxPills > 0 ? okAll.filter(v => v.check.pills <= maxPills) : okAll;
            const pick = (good.length ? good : (okAll.length ? okAll : variants))
                .sort((a, b) => a.check.pills - b.check.pills)[0];
            return { arch, prelude: prelude || null, variants, pick,
                ok: good.length > 0,
                feasible: okAll.length > 0,
                minPills: okAll.length ? Math.min.apply(null, okAll.map(v => v.check.pills)) : null };
        };
        const evaluate = archIndex => {
            const out = evaluateOne(info.archetypes[archIndex], null);
            out.archIndex = archIndex;
            return out;
        };
        // 锁法挪种子：扫一批「首条保底紫落点」，每个落点是一条新队列，取目标出现最早的前几个一起评比。
        // **默认关闭**：它要把上百个落点各模拟一遍（十几~几十秒），而目前的收益只有千分之几
        // （缺的是「主动垫保底 → 转自然」的策略，不是搜索空间）。需要深挖时用 opts.sweep = true 打开。
        let seedCandidates = [];
        if (opts.sweep) {
            try {
                const sweep = sweepSeeds(raw, targets, { zizhi: info.zizhi,
                    maxSwitch: Number(opts.maxSwitch) || 320, deadline });
                seedCandidates = (sweep.candidates || []).slice(0, Number(opts.seedCandidates) || 6);
            } catch (error) { seedCandidates = []; }
        }
        // 时间预算：种子候选是逐个真做计划再回放的，越多越慢。超预算就用已评出的最省收尾，
        // 避免把调用方（浏览器主线程）卡住几十秒。
        const evals = [];
        for (const hit of hits.slice(0, 3)) {
            if (Date.now() >= deadline && evals.length) break;
            evals.push(evaluate(hit.arch));
        }
        for (const sc of seedCandidates) {
            if (Date.now() >= deadline) break;          // 超预算：用已评结果收尾
            const arch = { jumps: 0, jumpsTo: [], seed: sc.seed, first: sc.first, wash: sc.wash, queue: sc.queue };
            const prelude = { switchAt: sc.switchAt, lockCount: sc.lockCount, lockPick: sc.lockPick || 0 };
            // 落点对了，队首才可能是目标 —— 所以「垫保底换目标」要在落点候选上一起开，
            // 两者本来就是一套：先扫落点换种子，再看队首是不是目标、是就垫出来白捡。
            const plain = evaluateOne(arch, prelude, false);
            plain.archIndex = '锁脉落点';
            plain.seedCandidate = sc;
            evals.push(plain);
            if (opts.padForTarget) {
                if (Date.now() >= deadline) break;
                const padded = evaluateOne(arch, prelude, true);
                padded.archIndex = '锁脉落点+垫';
                padded.seedCandidate = sc;
                evals.push(padded);
            }
        }
        const within = evals.filter(x => x.ok);
        const feasible = evals.filter(x => x.feasible);
        const winner = (within.length ? within : (feasible.length ? feasible : evals))
            .sort((a, b) => a.pick.check.pills - b.pick.check.pills)[0] || evals[0];
        const minPills = within.length ? null
            : (feasible.length ? Math.min.apply(null, feasible.map(x => x.minPills).filter(v => v != null)) : null);
        return Object.assign({}, info, { hits, evals, winner, seedCandidates, maxPills,
            overBudget: !within.length && !!feasible.length, minPills,
            timedOut: Date.now() >= deadline, noSolution: false });
    }

    /**
     * 生成 TXT 洗法（与该存档工具既有的「照着点」洗法格式一致）
     */
    function formatLog(raw, result, options) {
        options = options || {};
        const { winner, rule, zizhi } = result;
        const targets = options.targets || [];
        const roleLabel = options.roleLabel || `角色 ${raw.role_id || ''}`;
        const bag = Number(options.bagPills);
        const hasBag = options.hasBagPills === true;
        const check = winner.pick.check;
        const L = [];
        L.push(`${roleLabel}`);
        L.push(`目标：${targets.map(nameOf).join('、')}`);
        L.push(`跳脉档位：跳 ${winner.arch.jumpsTo.join(' 或 ')} 次（欧气种子 ${winner.arch.seed}）`);
        L.push(`首条保底紫：${nameOf(winner.arch.first)} @第 ${winner.arch.wash} 次`);
        L.push(`紫脉队列（后续保底紫与置换的来源）：${winner.arch.queue.slice(0, 12).map(nameOf).join(' → ')}`);
        L.push(`合计 ${check.pills} 丹；${check.washes} 次洗髓；${check.exchanges} 次手动置换` +
            (hasBag ? `；背包 ${bag} 丹${bag >= check.pills ? '（够）' : `（需额外补 ${check.pills - bag} 丹）`}` : ''));
        L.push('');
        let cum = 0;
        winner.pick.plan.steps.forEach((st, i) => {
            if (st.type === 'upgrade') {
                L.push(`${i + 1}. 开启第4槽（资质升到 154）`);
                return;
            }
            if (st.type === 'exchange') {
                const locks = st.lockIds.map(nameOf);
                L.push(`${i + 1}. ${locks.length ? '锁定 ' + locks.join('、') : '不锁脉'}；置换 ${nameOf(st.from)} → ${nameOf(st.to)}（置换不耗丹）` +
                    `（累计 ${cum} 丹${hasBag ? `，剩余 ${bag - cum} 丹` : ''}）`);
                L.push(`   场上：${st.field.map(nameOf).join(' · ')}`);
                return;
            }
            // 这一步的丹耗：锁 k 条时 eat + 2k − 1，不锁时 eat
            const k = st.count, locked = st.lockIds.length;
            const unit = locked ? rule.eat + 2 * locked - 1 : rule.eat;
            cum += unit * k;
            const head = st.lockIds.length ? `锁定 ${st.lockIds.map(nameOf).join('、')}` : '全部解锁';
            L.push(`${i + 1}. ${head}；点 ${k} 下（累计 ${cum} 丹${hasBag ? `，剩余 ${bag - cum} 丹` : ''}）`);
            L.push(`   场上：${st.field.map(nameOf).join(' · ')}`);
        });
        L.push('');
        L.push(`已从导入状态完整回放验证，最终场上：${check.field.map(nameOf).join(' · ')}。`);
        return L.join('\r\n');
    }

    /**
     * 只做「跳脉 + 洗到首条保底紫为止」这一段，并交出一个可以接着规划的起始状态。
     *
     * 依据用户方案：跳脉只需要改变**保底紫那一段**的洗法；首条保底紫到手之后，
     * 后面的目标完全可以改用锚点法（置换），比继续按队列顺序等保底省得多。
     * 所以这里只负责把「第一条保底紫」造出来，并给出后续段的起点。
     *
     * 档位优先挑「首条保底紫正好是目标之一」的 —— 这样跳脉段本身就交付一条目标。
     */
    function planJumpPhase(raw, targetIds, opts) {
        opts = opts || {};
        const zizhi = Number(opts.zizhi) || Number(raw.zizhi) || 153;
        // opts.info：外部已经 analyze 过就直接复用 —— 「逐档重扫」要跑十几次 planJumpPhase，
        // 每次重跑 analyze 会白烧几秒（实测 10 档从 21.6s 降到 3s 级）。
        const info = opts.info || analyze(raw, { zizhi, maxJump: opts.maxJump, queueLength: Number(opts.queueLength) || 12 });
        if (info.error) return info;
        const targets = (targetIds || []).map(Number);
        if (!targets.length) return { error: '没有目标紫脉' };
        // 档位选择：默认「首条保底紫正好是目标之一」的档，否则 0 跳档。
        // 但**统一搜索**会遍历所有档位（forceArchIndex），因为跳脉段只是给后续锚点段
        // 提供一个欧气链起点 —— 哪个档位总丹耗最低，必须和后续段一起算才知道。
        // （旧实现先单独定档再交棒，跳脉段并不知道锚点段能走多远。）
        const forced = Number.isInteger(opts.forceArchIndex) ? info.archetypes[opts.forceArchIndex] : null;
        const hit = info.archetypes.find(a => targets.includes(a.first));
        const arch = forced || hit || info.archetypes.find(a => a.jumps === 0) || info.archetypes[0];
        const rule = info.rule;
        const e = makeEngine(raw, zizhi);
        let s = e.initialState(Object.assign({}, raw, { zizhi }));
        const steps = [];
        let lockIds = [], pending = 0, pills = 0, cursor = 0;
        const flush = () => {
            if (pending > 0) { steps.push({ type: 'wash', lockIds: lockIds.slice(), count: pending, field: s.talents.slice() }); pending = 0; }
        };
        const setLocks = ids => {
            const a = ids.slice().sort().join(','), b = lockIds.slice().sort().join(',');
            if (a !== b) { flush(); lockIds = ids.slice(); }
        };
        const step = () => {
            for (const id of s.talents) if (targets.includes(id) && !lockIds.includes(id)) setLocks(lockIds.concat([id]));
            const r = e.wash(s, positionsOf(s, lockIds));
            s = r.state; pending++; cursor++; pills += Number(r.cost) || 0;
            return r;
        };
        // 跳脉段：洗 N 下 → 锁住那条即将重复的脉 → 洗 1 下 → 解锁
        let done = 0, since = 0, pendingJump = false, guard = 0;
        while (done < arch.jumps && guard++ < 40000) {
            if (pendingJump || since === (done === 0 ? 7 : rule.slots)) {
                const p = pickJump(e, s, rule.slots - 1);
                if (p >= 0) {
                    const keep = s.talents[p];
                    setLocks(lockIds.concat([keep]));
                    step();                                   // 这一步少填一个槽 = 跳脉
                    setLocks(lockIds.filter(id => id !== keep));
                    done++; since = 0; pendingJump = false;
                    continue;
                }
                pendingJump = true;
            }
            step(); since++;
        }
        // 洗到首条保底紫 —— 这一段结束后就交给锚点法接手
        let firstPurple = null, guard2 = 0;
        while (firstPurple == null && guard2++ < 6000) {
            const r = step();
            if (r.pityPurpleId != null) firstPurple = r.pityPurpleId;
        }
        flush();
        if (firstPurple == null) return { error: '6000 次洗髓内没有出现保底紫' };
        const remaining = targets.filter(id => !s.talents.includes(id));
        // 交接状态：转成规划器认的 raw 形状（seed/luck_seed/tal_lucky/talents…）
        const rawAfter = Object.assign({}, raw, {
            zizhi,
            seed: s.bornSeed, born_talent_rc: s.bornRC,
            luck_seed: s.luckSeed == null ? 0 : s.luckSeed, luck_seed_inited: s.luckSeed != null,
            tal_lucky: s.talLucky,
            talents: s.talents.map(id => ({ id, locked: false })),
        });
        return { arch, archIndex: info.archetypes.indexOf(arch), seed: arch.seed, firstPurple,
            steps, field: s.talents.slice(), remaining, rawAfter, pills, washes: cursor, rule,
            zizhi, seedFixed: info.seedFixed,
            // 供「统一搜索」遍历档位用：档位总数与本次用的是哪一档。
            archCount: info.archetypes.length, archetypes: info.archetypes };
    }

    /**
     * 隐藏保底紫扫描
     * ==============
     * 原理（用户实测 + 引擎核对）：
     *   · 自然紫的位置由 born 流抽签次数决定，在「条」坐标里随锁法变形；
     *   · 保底紫只看欧气累计「条」够不够阈值（3 槽 850），跟 born 流无关。
     *   所以只要某个自然紫间隙在「条」坐标里够长，把前面两条紫锁住、只留 1 条可洗
     *   （一次只 +1 条），850 条就能在目标紫到来之前攒够 —— 于是**间隙里会多出
     *   一条保底紫**，等于白捡一条紫脉。
     *
     * 用户规则（并修正了上界）：
     *   · 间隙 < 820 条：太短，锁完也放不下 850 条 → 跳过；
     *   · 间隙 > 850 条（= 保底阈值）：欧气从间隙起点归零后累加，**必然跨过 850**，
     *     保底紫本来就自然会出现 → 不存在「隐藏」，跳过；
     *   · 所以真正值得实搜的只有 **820 < 间隙 < 850** 这一段窄窗口。
     *
     * @param {object} raw  起始状态
     * @param {object} opts { zizhi, threshold=阈值-30, limit=10, cap=4000 }
     * @returns {object} { rule, threshold, upper, sequence, gaps, findings }
     */
    // 保底紫在「进场条数」上的实际触发点（实测口径，2026-10 与使用者对齐）：
    //   3 槽 855 条（= 285 洗 × 3）、4 槽 900 条。rule.pity（850/900）是计数阈值，
    //   触发发生在阈值跨过的那一洗，折算成进场条数就是 855/900。
    const PITY_FIRE = Object.freeze({ 153: 855, 154: 900 });
    function findHiddenPities(raw, opts) {
        opts = opts || {};
        const zizhi = Number(opts.zizhi) || Number(raw.zizhi) || 153;
        const rule = ruleFor(zizhi);
        if (!rule) return { error: `资质 ${zizhi} 没有可洗槽位` };
        // 上界 = 实际触发点（进场条数）；下界默认 = 上界 − 35（挤脉损耗经验值）
        const upper = Number(opts.upper) || PITY_FIRE[zizhi] || rule.pity;
        const threshold = Number(opts.threshold) || Math.max(0, upper - 35);
        const limit = Number(opts.limit) || 10;
        const cap = Number(opts.cap) || 4000;
        const mk = () => makeEngine(raw, zizhi);
        const initRaw = Object.assign({}, raw, { zizhi });

        // ① 不锁任何脉，扫出紫脉序列及其「条」坐标
        const sequence = [];
        {
            const e = mk();
            let s = e.initialState(initRaw), bars = 0, washes = 0;
            while (washes < cap && sequence.length < limit) {
                const r = e.wash(s, []);
                s = r.state; washes++; bars += rule.slots;
                if (r.pityPurpleId != null) sequence.push({ id: r.pityPurpleId, wash: washes, bars, pity: true });
                for (const p of (r.generatedEvents || []))
                    if (e.quality(p.id) === 4 && p.id !== r.pityPurpleId)
                        sequence.push({ id: p.id, wash: washes, bars, pity: false });
            }
        }
        const naturals = sequence.filter(x => !x.pity);

        // ② 逐个间隙：够长就做「锁前面两条紫」的实搜
        const simulate = (prevId, p1Id, p2Id) => {
            const e = mk();
            let s = e.initialState(initRaw), bars = 0, washes = 0;
            let locked = [], stage = 0, hitP1 = null, between = [];
            while (washes < cap * 2) {
                const locks = locked.map(id => s.talents.indexOf(id)).filter(i => i >= 0);
                if (locks.length !== locked.length) return { error: '锁定脉被洗掉' };
                const need = rule.slots - locks.length;
                const r = e.wash(s, locks);
                s = r.state; washes++; bars += need;
                const pities = r.pityPurpleId != null ? [{ id: r.pityPurpleId, pity: true }] : [];
                const nat = (r.generatedEvents || [])
                    .filter(p => e.quality(p.id) === 4 && p.id !== r.pityPurpleId)
                    .map(p => ({ id: p.id, pity: false }));
                const arrived = pities.concat(nat);
                if (stage === 0 && s.talents.includes(prevId)) { locked = [prevId]; stage = 1; continue; }
                if (stage === 1) {
                    if (arrived.some(x => x.id === p1Id)) {
                        locked = [prevId, p1Id]; stage = 2; hitP1 = { wash: washes, bars };
                        continue;
                    }
                    // p1 还没来就先别管其它紫
                } else if (stage === 2) {
                    for (const x of arrived) {
                        if (x.id === p2Id) return { p1: hitP1, p2: { wash: washes, bars }, between, need };
                        between.push({ id: x.id, wash: washes, bars, pity: x.pity });
                    }
                }
            }
            return { error: '超时' };
        };

        const gaps = [];
        for (let i = 1; i < naturals.length; i++) {
            const p1 = naturals[i - 1], p2 = naturals[i];
            const gap = p2.bars - p1.bars;
            // 间隙起点前面那条紫（自然的或保底的都行）——用户操作是「锁前面两条紫」
            const prev = sequence.filter(x => x.bars < p1.bars).pop();
            // 下界：太短放不下；上界：超过保底阈值的话，保底紫本来就自然会出现（不叫隐藏）
            const worthSearching = gap > threshold && gap < upper;
            const entry = { from: p1, to: p2, bars: gap, washes: p2.wash - p1.wash, prev,
                worthSearching, reason: gap <= threshold ? '太短' : (gap >= upper ? `≥${upper} 条，保底紫本来就会自然出现` : '') };
            if (entry.worthSearching && prev) {
                const out = simulate(prev.id, p1.id, p2.id);
                entry.hidden = out.error ? null : (out.between || []).filter(x => x.pity);
                entry.between = out.error ? null : (out.between || []);
                entry.error = out.error || null;
                entry.afterLock = out.p1 && out.p2 ? { bars: out.p2.bars - out.p1.bars, washes: out.p2.wash - out.p1.wash } : null;
            }
            gaps.push(entry);
        }
        const findings = gaps.filter(g => g.hidden && g.hidden.length);
        return { zizhi, rule, threshold, upper, sequence, gaps, findings };
    }

    /**
     * 锁法挪种子
     * ==========
     * 欧气种子是在**第一次欧气事件**那一刻写下的（`luck = born`，此后永久落盘）——
     * 第一次置换会写，首条保底紫也会写。所以只要用锁法把那一刻挪到别的洗髓次数上，
     * 就能换到另一个 born 位置 → 另一个种子 → **另一整条紫脉队列**。
     * （队列 = 落盘 luckSeed 起的 DRAW 链：DRAW[0] 是下一次欧气事件的结果，
     *   保底紫和置换共用这一条链。）
     *
     * 具体做法：先完全不锁洗 a 次，然后锁住 m 条低阶脉继续洗（每次进度 +m'），
     * 首条保底紫就会落在不同的洗髓次数上。a 连续变化就能细粒度地扫种子 ——
     * 这比跳脉（只在那 20 来个档位里跳）自由得多。
     *
     * @returns {Array} 候选，按「目标在队列里出现得多早」排序
     */
    function simulateFirstPityWithLock(raw, zizhi, switchAt, lockCount, opts) {
        opts = opts || {};
        const rule = ruleFor(zizhi);
        if (!rule) return null;
        const e = makeEngine(raw, zizhi);
        let s = e.initialState(Object.assign({}, raw, { zizhi }));
        let w = 0, locked = [];
        while (w < 4000) {
            const locks = locked.map(id => s.talents.indexOf(id)).filter(i => i >= 0);
            if (locks.length !== locked.length) return null;      // 锁定脉丢了，这次配置作废
            const r = e.wash(s, locks);
            s = r.state; w++;
            if (r.pityPurpleId != null) {
                const first = r.pityPurpleId, seed = s.luckSeed, firstWash = w;
                // 首条保底紫到手后释放前奏锁，继续不锁洗一段，收集**自然紫脉**。
                // 自然出紫比保底便宜得多，是目标的重要来源，预筛必须把它们算进来。
                const naturals = [];
                const natLimit = Number(opts.naturalLimit) || 8;
                let g = 0;
                for (; g < 1500 && naturals.length < natLimit; g++) {
                    const rr = e.wash(s, []);
                    s = rr.state;
                    for (const ev of (rr.generatedEvents || []))
                        if (e.quality(ev.id) === 4 && ev.id !== rr.pityPurpleId)
                            naturals.push({ id: ev.id, wash: firstWash + g + 1 });
                }
                return { seed, first, wash: firstWash, locked: locked.slice(), naturals, naturalEnd: firstWash + g };
            }
            if (w === switchAt && lockCount > 0) {
                // **锁哪一条很关键**：引擎抽到已在场上的脉会跳过重抽，所以锁不同的脉 →
                // 重抽概率不同 → born 流消耗不同 → 首条保底紫那一刻的 born 位置不同 → **种子不同**。
                // 所以除了「洗 a 次后锁 m 条」，还要遍历「锁哪几条」（lockPick 轮换起点）。
                const lows = [...new Set(s.talents.filter(id => e.quality(id) < 4))];
                const pick = Math.max(0, Number(opts.lockPick) || 0) % Math.max(1, lows.length);
                const rotated = lows.slice(pick).concat(lows.slice(0, pick));
                const chosen = rotated.slice(0, lockCount);
                if (chosen.length < lockCount) return null;       // 场上低阶脉不够，换别的 a
                locked = chosen;
            }
        }
        return null;
    }

    function sweepSeeds(raw, targetIds, opts) {
        opts = opts || {};
        const zizhi = Number(opts.zizhi) || Number(raw.zizhi) || 153;
        const rule = ruleFor(zizhi);
        if (!rule) return { error: `资质 ${zizhi} 没有可洗槽位` };
        const targets = (targetIds || []).map(Number);
        const maxSwitch = Number(opts.maxSwitch) || 400;
        const step = Math.max(1, Number(opts.step) || 1);
        const deadline = Math.max(0, Number(opts.deadline) || 0);
        const expired = () => deadline > 0 && Date.now() >= deadline;
        // 同一个欧气种子可能有多条走法（洗 a 次后锁 m 条，a/m 不同但落到同一个 born 位置）。
        // 它们的**种子相同、后续路线完全相同**，但前奏段的丹耗可能差很多：
        //   前奏花费 = a × 吃丹 + (保底紫洗髓数 − a) × (吃丹 + 2m − 1)
        // 所以按种子去重时，要留**前奏最便宜**的那条，而不是先遇到的那条。
        const bestBySeed = new Map();
        const lockPicks = Math.max(1, Number(opts.lockPicks) || 3);      // 锁哪一条也要遍历
        for (let m = 1; m < rule.slots; m++) {
            if (expired()) break;
            for (let lp = 0; lp < lockPicks; lp++) {
                if (expired()) break;
                for (let a = 0; a <= maxSwitch; a += step) {
                    if (expired()) break;
                    // 第一遍：只跑到首条保底紫（不收集自然紫，便宜得多）
                    const r = simulateFirstPityWithLock(raw, zizhi, a, m, { naturalLimit: 0, lockPick: lp });
                    if (!r) continue;
                    const key = String(r.seed);
                    const preludeCost = a * rule.eat + Math.max(0, r.wash - a) * (rule.eat + 2 * m - 1);
                    const prev = bestBySeed.get(key);
                    if (prev && prev.preludeCost <= preludeCost) continue;   // 已有更省的同种子走法
                    bestBySeed.set(key, { a, m, lp, r, preludeCost });
                }
            }
        }
        const candidates = [];
        for (const e of bestBySeed.values()) {
            if (expired()) break;
            const { a, m, r, preludeCost } = e;
            const lp = e.lp || 0;
            const queue = queueOf(raw, zizhi, r.seed, 20);
            const obtainable0 = [r.first].concat(queue);
            // 粗筛：至少要有 1 个目标能靠「首条保底紫 + 队列」拿到，否则不值得再花钱补自然紫
            if (!targets.some(id => obtainable0.indexOf(id) >= 0)) continue;
            // 第二遍：补自然紫（数量少得多）
            const r2 = simulateFirstPityWithLock(raw, zizhi, a, m, { naturalLimit: Number(opts.naturalLimit) || 8, lockPick: e.lp || 0 });
            const naturals = (r2 && r2.naturals) || [];
            const naturalIds = naturals.map(x => x.id);
            const obtainable = obtainable0.concat(naturalIds);
            const pos = targets.map(id => obtainable.indexOf(id));
            if (pos.some(p => p < 0)) continue;                 // 三条来源都拿不到才算不可行
            const natSet = new Set(naturalIds);
            const missCount = targets.filter(id => !natSet.has(id)).length;
            const natHits = targets.filter(id => natSet.has(id)).length;
            const cadence = rule.pity / Math.max(1, rule.slots);
            const arrivals = targets.map(id => {
                const nat = naturals.find(x => x.id === id);
                if (nat) return nat.wash;
                const qi2 = obtainable0.indexOf(id);
                return qi2 < 0 ? Infinity : r.wash + qi2 * cadence;
            });
            if (arrivals.some(v => !isFinite(v))) continue;
            const lastArrival = Math.max.apply(null, arrivals);
            const spanArrival = lastArrival - Math.min.apply(null, arrivals);
            // 落点优劣的估算总丹耗 = 前奏花费 + 后面还要洗的那些（按吃丹粗估）。
            // 只看「最后一条目标到手要等多久」会漏掉「前奏更省但到手稍晚」的落点 ——
            // 实测差的正是这种：前奏 971 丹的落点比前奏 1198 丹的更划算。
            const estCost = preludeCost + lastArrival * rule.eat;
            candidates.push({ switchAt: a, lockCount: m, lockPick: lp, wash: r.wash, first: r.first, seed: r.seed,
                queue, naturals, naturalIds, pos, missCount, natHits, arrivals, lastArrival, spanArrival,
                preludeCost, estCost, events: Math.max.apply(null, pos) });
        }
        // 按**估算总丹耗**排（前奏花费 + 后续洗髓），不再只看「最后一条目标到手时间」
        candidates.sort((x, y) => x.estCost - y.estCost || x.lastArrival - y.lastArrival
            || x.missCount - y.missCount || x.events - y.events || x.wash - y.wash);
        return { zizhi, rule, candidates, scanned: bestBySeed.size, timedOut: expired() };
    }

    /**
     * 隐藏保底紫路线（定向法）
     * ======================
     * 用户方法：**先探测**哪些自然紫间隙里藏着保底紫（820 < 间隔 < 850）；
     *   · 藏的这条如果正好是**目标脉** → 就用它当锚点：锁住前面两条紫、只留 1 条可洗，
     *     垫洗到把它挤出来（它本身就是目标，等于白捡一条，而且此时欧气种子已经写下、
     *     后面的队列完全确定）；
     *   · 如果它不是目标脉 → **直接无视**，不要为它花力气。
     *
     * 这比「盲目扫几百个落点」高效得多：只跟着已探明的结构走。
     */
    function buildHiddenPlan(raw, zizhi, targets, finding, opts) {
        opts = opts || {};
        const rule = ruleFor(zizhi);
        let e = makeEngine(raw, zizhi);          // ⑤ 里会换成 154 资质的引擎
        let s = e.initialState(Object.assign({}, raw, { zizhi }));
        const want = new Set(targets), held = new Set();
        const steps = [];
        let lockIds = [], pending = 0, pills = 0, cursor = 0;
        const flush = () => {
            if (pending > 0) { steps.push({ type: 'wash', lockIds: lockIds.slice(), count: pending, field: s.talents.slice() }); pending = 0; }
        };
        const setLocks = ids => {
            const a = ids.slice().sort().join(','), b = lockIds.slice().sort().join(',');
            if (a !== b) { flush(); lockIds = ids.slice(); }
        };
        const lockHeld = () => { for (const id of s.talents) if (want.has(id)) held.add(id); };
        const step = () => {
            const r = e.wash(s, positionsOf(s, lockIds));
            s = r.state; pending++; cursor++; pills += Number(r.cost) || 0;
            return r;
        };
        const hiddenIds = (finding.hidden || []).filter(h => want.has(h.id)).map(h => h.id);
        // ① 洗到「前一条紫」出现并锁住
        let guard = 0;
        while (!s.talents.includes(finding.prev.id) && guard++ < 4000) step();
        if (!s.talents.includes(finding.prev.id)) return null;
        lockHeld(); setLocks([...held, finding.prev.id]);
        // ② 洗到间隙起点那条紫出现，也锁住（此时锁 2 条 → 每次只 +1 条）
        guard = 0;
        while (!s.talents.includes(finding.from.id) && guard++ < 4000) step();
        if (!s.talents.includes(finding.from.id)) return null;
        lockHeld(); setLocks([...held, finding.prev.id, finding.from.id]);
        // ③ 垫洗到隐藏保底紫被挤出来（它本身是目标）
        guard = 0;
        let got = null;
        while (guard++ < 3000) {
            const r = step();
            if (r.pityPurpleId != null) { got = r.pityPurpleId; break; }
        }
        if (got == null) return null;
        lockHeld();
        if (want.has(got)) { held.add(got); setLocks([...held]); }
        // ④ 剩下的目标照常收（谁到场就锁谁）
        guard = 0;
        while (guard++ < 100000) {
            lockHeld(); setLocks([...held]);
            if (targets.every(id => held.has(id))) break;
            if (held.size >= rule.slots) break;
            if (cursor > 60000) break;
            step();
        }
        // ⑤ 3 槽收满却还缺目标 → **开第 4 槽继续收**。
        //    实测案例（步惊云 7,993 丹）最后就是这一步：锁满混元/金仙/顶天之后开 4 槽，
        //    再洗 9 下把「天生神力」收掉。旧实现到 ④ 就 break（held.size >= 3），
        //    所以永远只能给 3 个目标 —— 这是「只到 3/4」的根因。
        if (zizhi === 153 && targets.some(id => !held.has(id)) && held.size >= rule.slots) {
            // 先留一份「3 目标收满」的快照：4 槽收尾若凑不齐，就回滚，别把白洗的丹耗算进方案里
            const snap = { s, cursor, pills, stepCount: steps.length, held: [...held], lockIds: lockIds.slice(), pending };
            e = makeEngine(raw, 154);
            s = e.upgradeToFour(Object.assign({}, s, { zizhi: 154 }));
            // replayPlan 认的字段是 zi（不是 toZi）
            steps.push({ type: 'upgrade', zi: 154, field: s.talents.slice() });
            lockIds = [];
            pending = 0;
            let g4 = 0;
            // 只给一小段窗口：4 槽 3 锁时每洗 10 丹，洗太久会把丹耗拉爆
            // （实测案例最后只用了 9 洗）
            const fourthWash = Math.max(0, Number(opts.fourthWash) || 300);
            while (g4++ < fourthWash) {
                lockHeld(); setLocks([...held]);
                if (targets.every(id => held.has(id))) break;
                if (cursor > 60000) break;
                if (held.size >= 4) break;
                step();
            }
            if (!targets.every(id => held.has(id))) {
                // 没凑齐 → 回滚到 3 目标状态（开槽本身 0 丹，但白洗的丹耗不能算）
                s = snap.s; cursor = snap.cursor; pills = snap.pills;
                steps.length = snap.stepCount;
                held.clear(); snap.held.forEach(id => held.add(id));
                lockIds = snap.lockIds; pending = snap.pending;
            }
        }
        flush();
        return { steps, field: s.talents.slice(), washes: cursor, pills, hiddenGot: got,
            hiddenWanted: hiddenIds, finding: { from: finding.from, to: finding.to, bars: finding.bars, prev: finding.prev, hidden: finding.hidden } };
    }

    function planHiddenPityRoute(raw, targetIds, opts) {
        opts = opts || {};
        const zizhi = Number(opts.zizhi) || Number(raw.zizhi) || 153;
        const rule = ruleFor(zizhi);
        if (!rule) return { error: `资质 ${zizhi} 没有可洗槽位` };
        const targets = (targetIds || []).map(Number);
        const scan = findHiddenPities(raw, { zizhi, threshold: opts.threshold,
            limit: Number(opts.limit) || 10, cap: Number(opts.cap) || 2500 });
        if (scan.error) return scan;
        // 只保留「藏的那条正好是目标脉」的间隙；不是目标的无视
        const usable = (scan.findings || []).filter(f => (f.hidden || []).some(h => targets.includes(h.id)));
        const plans = [];
        for (const f of usable) {
            const p = buildHiddenPlan(raw, zizhi, targets, f, opts);
            if (!p) continue;
            const check = replayPlan(raw, zizhi, p.steps);
            p.check = check;
            p.ok = check.ok && targets.every(id => check.field.includes(id));
            plans.push(p);
        }
        plans.sort((a, b) => (a.ok === b.ok ? a.pills - b.pills : (a.ok ? -1 : 1)));
        return { zizhi, rule, targets, scan, usable, plans,
            note: usable.length ? '' : '扫描到的隐藏保底紫都不是目标脉 → 按规则无视，不为它们花力气' };
    }

    /**
     * 跳脉法（跳脉落点）× 隐藏保底 联合规划（2026-10 新增）
     * ================================
     * 使用者纠正的关键一点：**跳脉法同时改「欧气种子」和「保底紫序列」**，
     * 所以不能只在基准序列上找隐藏保底紫 —— 每换一个档位，紫序和「哪个间隙里藏着哪条紫」
     * 都会跟着变。实测步惊云：
     *   · 基准档（不跳）：金仙→神力 间隙里藏的是「剑术无双」（不是目标）；
     *   · 跳 8 档（首条保底 九阴鬼脉）：同一间隙藏的是「岿然顶天」★ —— 目标！
     * 也就是说：**隐藏保底紫只有在挑对种子时才值钱**，必须逐落点重扫。
     *
     * 做法：
     *   for 每个跳脉档位 i:
     *       phase   = 跳脉段（跳到该档位、拿到首条保底紫）
     *       findings = findHiddenPities(phase.rawAfter)   ← 用**这一档的**种子重扫
     *       plan     = buildHiddenPlan(该档的可用间隙)     ← 锁前两条、垫洗挤出保底
     *       total    = 跳段丹耗 + 隐藏保底段丹耗
     *   按「拿到的目标数 → 总丹耗」排序。
     *
     * 与 planHiddenPityRoute 的区别：后者只扫当前状态，不遍历跳脉档位，
     * 所以永远发现不了「跳 8 档才有顶天」这种机会。
     */
    function planHiddenPityJumpRoutes(raw, targetIds, opts) {
        opts = opts || {};
        const zizhi = Number(opts.zizhi) || Number(raw.zizhi) || 153;
        const rule = ruleFor(zizhi);
        if (!rule) return { error: `资质 ${zizhi} 没有可洗槽位` };
        const targets = (targetIds || []).map(Number);
        if (targets.length < 2) return { error: '至少要 2 个目标' };
        const info = analyze(raw, { zizhi, maxJump: Number(opts.maxJump) || 240 });
        if (info.error) return info;
        const out = {
            zizhi, rule, targets, archCount: info.archetypes.length,
            routes: [], best: null, scanned: 0, note: '',
        };
        const archLimit = Math.max(1, Math.min(Number(opts.archLimit) || 12, info.archetypes.length));
        const deadline = Date.now() + Math.max(1000, Number(opts.timeMs) || 15000);
        for (let i = 0; i < archLimit; i++) {
            if (Date.now() > deadline) { out.timedOut = true; break; }
            out.scanned++;
            let phase = null;
            try {
                phase = planJumpPhase(raw, targets, {
                    zizhi, forceArchIndex: i, maxJump: Number(opts.maxJump) || 240, info,
                });
            } catch (err) { continue; }
            if (!phase || phase.error) continue;
            const remaining = (phase.remaining && phase.remaining.length) ? phase.remaining : targets.slice();
            let hp = null;
            try {
                hp = planHiddenPityRoute(phase.rawAfter, remaining, {
                    zizhi, threshold: opts.threshold, limit: Number(opts.pityLimit) || 10,
                    cap: Number(opts.cap) || 2500,
                });
            } catch (err) { continue; }
            if (!hp || !hp.plans || !hp.plans.length) continue;
            for (const p of hp.plans) {
                const field = p.field || [];
                const got = targets.filter(id => field.includes(id));
                out.routes.push({
                    variant: 'jump',
                    archIndex: i, jumps: phase.arch.jumps, firstPurple: phase.firstPurple, seed: phase.seed,
                    phasePills: Number(phase.pills) || 0, phaseWashes: Number(phase.washes) || 0,
                    phaseSteps: phase.steps || [],
                    pills: Number(p.pills) || 0, washes: Number(p.washes) || 0,
                    steps: p.steps || [], field,
                    hiddenGot: p.hiddenGot, finding: p.finding, hiddenWanted: p.hiddenWanted,
                    got: got.length, missing: targets.filter(id => !field.includes(id)),
                    totalPills: (Number(phase.pills) || 0) + (Number(p.pills) || 0),
                    totalWashes: (Number(phase.washes) || 0) + (Number(p.washes) || 0),
                    ok: got.length === targets.length && (!p.check || p.check.ok !== false),
                });
            }
        }
        out.routes.sort((a, b) => (b.got - a.got) || (a.totalPills - b.totalPills));
        // 不完整路线可以留在 routes 里供诊断，但不能作为“最优方案”
        // 返回给统一构造器或界面。
        out.best = out.routes.find(route => route.ok
            && Number(route.got) === targets.length) || null;
        if (!out.routes.length) {
            out.note = '逐档扫完：没有任何档位的隐藏保底紫落在目标上（或该档建不出路线）。';
        } else if (!out.best) {
            out.note = '隐藏保底路线没有凑齐全部目标，不参与最优路线比较。';
        }
        return out;
    }

    /**
     * 跳脉法 · 锁脉落点 × 隐藏保底（v2.2.0 按实测案例补的第二种落点）
     * ============================================================
     * 命名规则（使用者定的）：**「跳脉」和「锁脉」是同一种方法 —— 跳脉法**，
     * 两者只是「把首条保底紫挪到哪个落点」的两种手段，不要当成两个方法。
     *   · 跳脉落点：洗 7 洗 → 锁一条即将重复的脉洗 1 下 → 解锁，重复 N 次（档位离散）；
     *   · 锁脉落点：空洗 a 洗 → 锁一条低阶脉再洗 d 洗 → 解锁（落点连续，粒度细）。
     * 两者都在干同一件事：挪动「欧气种子写下的那一刻」。
     *
     * 实测案例（步惊云 7,993 丹）走的是锁脉落点：
     *   ① 空洗 a 洗 → ② 锁住一条低阶脉再洗 d 洗 → ③ 解锁、继续空洗到首条保底紫。
     * 锁着洗时每洗只推进 2 条，于是首条保底紫落在别的洗数上 → 写下另一个种子 →
     * 后面整条紫序换掉（混元/金仙能提前出现）。种子定下之后，再用「锁两条、每洗 +1 条」
     * 把保底紫挤进间隙（隐藏保底），最后 3 槽收满时开第 4 槽把最后一条收掉（案例只花 9 洗）。
     */
    function lockShiftState(raw, zizhi, a, d, lowId) {
        const e = makeEngine(raw, zizhi);
        let s = e.initialState(Object.assign({}, raw, { zizhi }));
        let cost = 0, washes = 0, firstPity = null, pityWash = null;
        const wash = keepIds => {
            const keep = positionsOf(s, keepIds);
            if (keep.length !== keepIds.length) return null;
            const r = e.wash(s, keep); s = r.state; cost += r.cost; washes++;
            if (r.pityPurpleId != null && firstPity == null) { firstPity = r.pityPurpleId; pityWash = washes; }
            return r;
        };
        for (let i = 0; i < a; i++) if (!wash([])) return null;
        if (!s.talents.includes(lowId)) return null;
        for (let i = 0; i < d; i++) if (!wash([lowId])) return null;
        let guard = 0;
        while (firstPity == null && guard++ < 1500) if (!wash([])) return null;
        const rawAfter = Object.assign({}, raw, {
            zizhi, seed: s.bornSeed, born_talent_rc: s.bornRC,
            luck_seed: s.luckSeed == null ? 0 : s.luckSeed, luck_seed_inited: s.luckSeed != null,
            tal_lucky: s.talLucky, talents: s.talents.map(id => ({ id, locked: false })),
        });
        return { rawAfter, cost, washes, firstPity, pityWash, seed: s.luckSeed };
    }

    function planLockShiftRoutes(raw, targetIds, opts) {
        opts = opts || {};
        const zizhi = Number(opts.zizhi) || Number(raw.zizhi) || 153;
        const rule = ruleFor(zizhi);
        if (!rule) return { error: `资质 ${zizhi} 没有可洗槽位` };
        const targets = (targetIds || []).map(Number);
        if (targets.length < 2) return { error: '至少要 2 个目标' };
        // ★ 锁脉法两条分支：
        //   ① 3/4槽起手：空洗到「紫脉前 250 条」
        //   ② 3槽起手：空洗到「紫脉前 200 条」→ 开4槽（bornSeed 变、保底紫约推后 50 条）
        const openFour = !!(opts.openFour) && zizhi < 154;
        const barsBefore = openFour ? 200 : 250;
        const aFix = (() => {
            if (opts.aMax != null) return Math.max(0, Number(opts.aMax));
            const base = runToFirstPity(raw, zizhi, 0);
            const pityWash = base ? Number(base.wash) : 0;
            return Math.max(0, pityWash - Math.ceil(barsBefore / rule.slots));
        })();
        const openFourAt = openFour
            ? Math.max(0, Math.min(aFix,
                opts.openFourAt != null ? Number(opts.openFourAt) || 0 : aFix))
            : aFix;
        const deadline = Date.now() + Math.max(1000, Number(opts.timeMs) || 15000);
        const budget = Math.max(0, Number(opts.budget) || 0);
        const headBudget = Math.max(0, Number(opts.headBudget) || 0);
        const bestCost = Math.max(0, Number(opts.bestCost) || 0);
        // 已经找到最优路线后，前置炼丹一旦达到这个值，整条候选就不可能再更省。
        // 这里先剪掉，避免把高丹耗种子继续做链校验和完整回放。
        const exceedsKnownLimit = value => {
            const pills = Number(value) || 0;
            return (bestCost > 0 && pills >= bestCost)
                || (headBudget > 0 && pills > headBudget);
        };
        const progressCb = typeof opts.progressCb === 'function' ? opts.progressCb : null;
        const out = { zizhi, rule, targets, routes: [], best: null, scanned: 0, prunedSeed: 0, prunedBound: 0, timedOut: false, note: '' };
        // 同一欧气种子视为同一个种子方案；luckSeed 已决定后续欧气链。
        // 去重后只保留前置丹耗最低的代表，再送后续收尾/倒插阶段。
        const seenSeed = new Map();   // seed -> route
        // ★ 锁脉法（锁 d 洗后解锁）：空洗到「紫脉前 250/200 条」→ 沿 born 流扫低阶脉，每条都「锁它洗 d 洗后解锁」
        //   d 从 0 扫到「锁 d 洗期间就出保底」为止，按种子去重。落点位置是主导、锁哪条脉是补漏。
        let e = makeEngine(raw, zizhi);
        let sBase = e.initialState(Object.assign({}, raw, { zizhi }));
        let sBasePills = 0;
        for (let i = 0; i < openFourAt; i++) {
            const r = e.wash(sBase, []);
            sBase = r.state;
            sBasePills += Number(r.cost) || 0;
        }
        if (openFour) {
            e = makeEngine(raw, 154);
            sBase = e.upgradeToFour(Object.assign({}, sBase, { zizhi: 154 }));
            for (let i = openFourAt; i < aFix; i++) {
                const r = e.wash(sBase, []);
                sBase = r.state;
                sBasePills += Number(r.cost) || 0;
            }
        }
        // 锁 X 洗 d 洗后解锁，d 从 0 扫到锁出保底为止，按「种子+落点」去重
        const scanLock = (X, startState, walkOffset, prefixPills) => {
            out.scanned++;
            if (exceedsKnownLimit(prefixPills)) {
                out.prunedBound++;
                return;
            }
            if (progressCb && (out.scanned === 1 || out.scanned % 10 === 0)) {
                try { progressCb({ scanned: out.scanned, aFix, lowId: X, openFour }); } catch (err) { }
            }
            // ★ 增量扫保底：每槽位数量洗前进 1 个落点。
            //   3槽：0,1,2,3,6,9...；4槽：0,1,2,3,4,8,12...
            const dStep = openFour
                ? Number(ruleFor(154).slots) || 4
                : Number(rule.slots) || 3;
            lockD: for (let d = 0; d <= 200; d = (d < dStep ? d + 1 : d + dStep)) {
                if (Date.now() > deadline) { out.timedOut = true; break; }
                let s2 = startState; let seed = null, firstPity = null; let pityDuringLock = false; let pityWash = 0;
                let phasePills = 0, phaseWashes = 0;
                for (let i = 0; i < d; i++) {
                    const keep = s2.talents.includes(X) ? [s2.talents.indexOf(X)] : [];
                    const r2 = e.wash(s2, keep); s2 = r2.state;
                    phasePills += Number(r2.cost) || 0;
                    phaseWashes++;
                    if (r2.pityPurpleId != null && firstPity == null) { firstPity = r2.pityPurpleId; seed = s2.luckSeed; pityDuringLock = true; pityWash = phaseWashes; }
                    if (exceedsKnownLimit(Number(prefixPills) + phasePills)) {
                        out.prunedBound++;
                        break lockD;
                    }
                }
                if (firstPity == null) {
                    for (let k = 1; k <= 2000; k++) {
                        const r3 = e.wash(s2, []); s2 = r3.state;
                        phasePills += Number(r3.cost) || 0;
                        phaseWashes++;
                        if (r3.pityPurpleId != null) { firstPity = r3.pityPurpleId; seed = s2.luckSeed; pityWash = phaseWashes; break; }
                        if (exceedsKnownLimit(Number(prefixPills) + phasePills)) {
                            out.prunedBound++;
                            break lockD;
                        }
                    }
                }
                if (exceedsKnownLimit(Number(prefixPills) + phasePills)) {
                    out.prunedBound++;
                    break lockD;
                }
                if (seed == null) continue;
                const pityPos = aFix + walkOffset + pityWash;   // 真实保底紫落点洗数（含锁洗 + 解锁后洗到保底）
                const routeZi = openFour ? 154 : zizhi;
                const dedupKey = String(Number(seed) || 0);
                const route = {
                    dedupKey,
                    variant: 'lock', a: aFix + walkOffset, d, lowId: X, seed,
                    openFour, openFourAt, zi: openFour ? 154 : zizhi,
                    firstPurple: firstPity, firstPityWash: pityPos,
                    phasePills, preludePills: Number(prefixPills) + phasePills,
                    phaseWashes: pityPos,
                    got: 0, totalPills: Number.MAX_SAFE_INTEGER, ok: false,
                };
                const oldRoute = seenSeed.get(dedupKey);
                if (!oldRoute || Number(route.preludePills)
                    < Number(oldRoute.preludePills)) {
                    seenSeed.set(dedupKey, route);
                    if (oldRoute) out.prunedSeed++;
                } else {
                    out.prunedSeed++;
                }
                if (pityDuringLock) break;   // 锁到保底了，后面 d 不再出新种子
            }
        };
        // ① 场上（空洗 a 后）的低阶脉——实测锁的就是场上这条（步惊云锁健步如飞）
        for (const X of sBase.talents) {
            if (e.quality(X) >= 4) continue;
            scanLock(X, sBase, 0, sBasePills);
        }
        // ② 沿 born 流扫（空洗 a 之后、保底紫之前）新出现的低阶脉
        let sWalk = sBase;
        let walkPills = 0;
        for (let w = 1; w <= 400; w++) {
            if (Date.now() > deadline) { out.timedOut = true; break; }
            const rw = e.wash(sWalk, []); sWalk = rw.state;
            walkPills += Number(rw.cost) || 0;
            if (exceedsKnownLimit(sBasePills + walkPills)) {
                out.prunedBound++;
                break;
            }
            if (rw.pityPurpleId != null) break;
            for (const ev of (rw.generatedEvents || [])) {
                const X = Number(ev.id);
                if (e.quality(X) >= 4) continue;
                scanLock(X, sWalk, w, sBasePills + walkPills);
            }
        }
        out.routes = Array.from(seenSeed.values());
        out.routes.sort((x, y) => (x.seed - y.seed) || (x.lowId - y.lowId));
        out.best = out.routes[0] || null;
        if (!out.routes.length) out.note = '锁脉落点扫完：没有可用的锁脉落点。';
        return out;
    }

    /**
     * 跳脉法（统一入口）· 两种落点一起算
     * ==================================
     * 命名规则：**跳脉和锁脉是同一种方法（跳脉法）的两种落点**，不拆成两个方法对外暴露。
     *   · 跳脉落点：档位离散（跳 0/2/5/8… 次），一次挪 1~3 次保底；
     *   · 锁脉落点：落点连续（空洗 a 洗 + 锁脉 d 洗），粒度细得多。
     *
     * 两种落点各自都会「换种子 → 用该种子的隐藏保底紫 → 开 4 槽收尾」，
     * 最后按「拿到的目标数 → 总丹耗」合并排序，`variant` 标明用的是哪种落点。
     */
    function planJumpMethodRoutes(raw, targetIds, opts) {
        opts = opts || {};
        const zizhi = Number(opts.zizhi) || Number(raw.zizhi) || 153;
        const rule = ruleFor(zizhi);
        if (!rule) return { error: `资质 ${zizhi} 没有可洗槽位` };
        const targets = (targetIds || []).map(Number);
        if (targets.length < 2) return { error: '至少要 2 个目标' };
        let jump = null, lock = null;
        try {
            jump = planHiddenPityJumpRoutes(raw, targets, Object.assign({}, opts, {
                zizhi, timeMs: Number(opts.jumpTimeMs) || Number(opts.timeMs) || 12000,
            }));
        } catch (err) { jump = null; }
        try {
            lock = planLockShiftRoutes(raw, targets, Object.assign({}, opts, {
                zizhi, timeMs: Number(opts.lockTimeMs) || Number(opts.lockTimeMs) || Number(opts.timeMs) || 12000,
            }));
        } catch (err) { lock = null; }
        if (!jump && !lock) return { zizhi, rule, targets, routes: [], best: null, note: '跳脉法两条落点都没跑起来。' };
        const routes = [].concat((jump && jump.routes) || [], (lock && lock.routes) || []);
        // ★ 第三种种子来源：**槽位**（3 槽 / 4 槽写下的欧气种子不同，见 dev/check_liu_9482.js）。
        //   对每个槽位跑一遍「置换优先」执行器，得到的路线也放进同一张表里比价。
        const exchangeRoutes = [];
        if (opts.withExchange !== false && typeof planExchangeFromSlots === 'function') {
            for (const r of planExchangeFromSlots(raw, targets, opts)) exchangeRoutes.push(r);
        }
        for (const r of exchangeRoutes) routes.push(r);
        routes.sort((a, b) => (b.got - a.got) || (a.totalPills - b.totalPills));
        const full = routes.find(route => route.ok
            && Number(route.got) === targets.length) || null;
        return {
            zizhi, rule, targets, routes, best: full,
            scanned: Number((jump && jump.scanned) || 0) + Number((lock && lock.scanned) || 0),
            prunedSeed: Number((lock && lock.prunedSeed) || 0),
            prunedBound: Number((lock && lock.prunedBound) || 0),
            timedOut: !!(jump && jump.timedOut) || !!(lock && lock.timedOut),
            variantCounts: {
                jump: ((jump && jump.routes) || []).length,
                lock: ((lock && lock.routes) || []).length,
                exchange: exchangeRoutes.length,
            },
            note: full ? '' : (routes.length
                ? '跳脉法候选未凑齐全部目标，不参与最优路线比较。'
                : ((jump && jump.note) || (lock && lock.note) || '')),
        };
    }

    /**
     * 「槽位落点」× 置换优先（第三种换种子来源）
     * ==========================================
     * 实测（dev/check_liu_9482.js）：同一份存档、同一状态，只改起手槽位，
     * 写下的欧气种子就不同 —— 3 槽第 734 洗「剑术无双」/ 种子 1497212010，
     * 4 槽第 556 洗「玄阳神脉」/ 种子 265210737，整条紫序跟着换。
     * 所以「3 槽还是 4 槽起手」也是一次换种子，要和跳脉落点、锁脉落点一起比价。
     */
    function planExchangeFromSlots(raw, targetIds, opts) {
        opts = opts || {};
        const targets = (targetIds || []).map(Number);
        const out = [];
        const Planner = root.AnchorRoutePlanner;
        if (!Planner || typeof Planner.exchangeFirstPlan !== 'function') return out;
        const configs = Array.isArray(opts.exchangeConfigs) && opts.exchangeConfigs.length
            ? opts.exchangeConfigs
            : [{ zi: 153, lead: 60 }, { zi: 154, lead: 60 }, { zi: 154, lead: 20 }];
        for (const cfg of configs) {
            let r = null;
            try { r = Planner.exchangeFirstPlan(raw, targets, Object.assign({}, cfg, { maxWash: 15000 })); }
            catch (err) { r = null; }
            if (!r || !r.ok) continue;
            out.push({
                variant: 'exchange', zi: r.zi, lead: cfg.lead,
                pills: r.cost, washes: r.washes, steps: r.steps, field: r.field,
                exchanges: r.exchanges, burns: r.burns,
                stagePills: r.cost, stageWashes: r.washes,
                hiddenGot: null, finding: null,
                got: targets.filter(id => r.field.includes(id)).length,
                missing: targets.filter(id => !r.field.includes(id)),
                totalPills: r.cost, totalWashes: r.washes,
                ok: true,
            });
        }
        out.sort((a, b) => a.totalPills - b.totalPills);
        return out;
    }

    root.AutoWash2SeedPlanner = Object.freeze({ analyze, solve, buildPlan, replayPlan, formatLog,
        planJumpPhase, findHiddenPities, planHiddenPityRoute, buildHiddenPlan, sweepSeeds, simulateFirstPityWithLock,
        runToFirstPity, queueOf, ruleFor, pickJump, planHiddenPityJumpRoutes, planLockShiftRoutes,
        planExchangeFromSlots, planJumpMethodRoutes });
})(typeof window !== 'undefined' ? window : globalThis);
