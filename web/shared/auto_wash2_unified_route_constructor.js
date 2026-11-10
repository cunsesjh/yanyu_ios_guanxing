// -*- coding: utf-8 -*-
/**
 * 庸丶人统一路线构造器移植版（L1 脉序快照 + G1 枚举构造器）。
 *
 * 目标：把「洗出一条路线」统一成
 *   （定欧气链 → 事件驱动执行 → 置换决策 → 独立回放验证），
 *   用确定性构造代替 4 目标锚点 A*（分钟~小时级 → 秒级），
 *   并能复现人工最优路线（柳如意 9,482 丹 / 1,362 洗）。
 *
 * 策略（照 check_liu_9482.js 的人工时序泛化）：
 *   ① 事件驱动走流：洗一次 → 处理本洗事件；
 *      · 天然目标出现 → 锁（natural capture）；
 *      · 低阶脉 L 出现且无冲突 → 前瞻：L 类型的紫在 lead 洗内会出现 → 锁 L 当冲突；
 *      · 冲突类型的紫 P 出现 → 成为载体；
 *   ② 载体就位：
 *      · 欧气种子未固定 → 锁载体 → 垫洗 n → 置换（定种子，第 1 条置换 = 池子队首）；
 *      · 已固定 → 置换决策（见 ③）；
 *   ③ 置换决策（池子前瞻 M）：
 *      · 换出缺的目标 → keep；
 *      · 否则池子后 M 条内有缺的目标 → 白烧推进；
 *      · 否则跳过（冲突/载体释放，紫随流水冲掉）；
 *   ④ 换完释放冲突；冲突超时（TTL）也释放。
 *
 * 枚举维度（都是小空间）：起手槽位 zi0、定种子垫洗 n、冲突前瞻 lead。
 * 每条路线用 verifySteps 独立重放验证后才接受。
 */
(function (root) {
    'use strict';

    function engine(raw, zi) {
        const zz = root.ZZ_DATA[String(zi)];
        if (!zz) throw new Error('资质表缺失: ' + zi);
        return new root.AutoWash2Engine.Engine(root.TALENT_DATA, raw, {
            slotCount: zz.num_talent, pity: zz.bd_zz, eat: zz.eat_xisui,
            eligibleZi: zi, advancePerDraw: true,
        });
    }

    const nameOf = id => (root.TALENT_DATA[String(id)] || {}).name || `#${id}`;

    // ───────────────────────── L1 脉序快照 ─────────────────────────
    const _scanCache = new Map();
    /**
     * 无锁连洗扫描紫序（缓存按 种子/salt/roleId/zizhi/count 键控，全员共用一份）。
     * @return [{ id, name, wash, no, fromPity, bornRC, gap, key }]
     */
    function baselineScan(raw, count = 40, zi) {
        const zi0 = Number(zi) >= 150 ? Number(zi) : (Number(raw.zizhi) >= 154 ? 154 : 153);
        const key = [Number(raw.seed) || 0, Number(raw.salt) || 0, Number(raw.role_id) || 0,
            zi0, Number(count) || 0, Number(raw.luck_seed) || 0, !!raw.luck_seed_inited].join('|');
        if (_scanCache.has(key)) return _scanCache.get(key);
        const e = engine(raw, zi0);
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi0 }));
        let previousRC = s.bornRC, pityNo = 0;
        const items = [];
        for (let w = 1; w <= 12000 && items.length < count; w++) {
            const r = e.wash(s, []);
            s = r.state;
            for (const ev of r.generatedEvents) {
                if (e.quality(ev.id) !== 4) continue;
                if (ev.fromPity) ev.pityNo = ++pityNo;
                items.push({
                    id: Number(ev.id), name: e.name(ev.id), wash: w, no: items.length + 1,
                    fromPity: !!ev.fromPity, bornRC: ev.bornRC, gap: ev.bornRC - previousRC,
                    key: ev.fromPity ? `p:${ev.pityNo}` : `r:${ev.bornRC}:${ev.id}`,
                });
                previousRC = ev.bornRC;
            }
        }
        _scanCache.set(key, items);
        return items;
    }

    /** 欧气池：从指定 luckSeed 出发的「被接受的紫脉」序列（只作决策参考）。 */
    function poolOf(raw, luckSeed, count = 40) {
        const zi0 = Number(raw.zizhi) >= 154 ? 154 : 153;
        const e = engine(raw, zi0);
        let luck = Number(luckSeed) || 0;
        const out = [];
        for (let i = 0; i < 4000 && out.length < count; i++) {
            let id;
            try { [id, luck] = e.draw(luck, true); } catch (err) { break; }
            if (e.allowed.has(id)) out.push(Number(id));
        }
        return out;
    }

    // ───────────────────────── G1 构造器 ─────────────────────────
    function fail(why, extra) {
        return Object.assign({ ok: false, note: why || '未凑齐' }, extra || {});
    }

    /**
     * 单次构造（确定性执行，无搜索）。
     * @param raw     角色状态（importSnapshot 风格）
     * @param targets 目标紫 id 数组
     * @param params  { zi0, n, lead, M, upgradeAt, budget, bestCost, maxWash, conflictTtl }
     */
    function constructOnce(rawInput, targets, params) {
        const p = params || {};
        const raw = Object.assign({}, rawInput);
        const TG = (targets || []).map(Number);
        if (TG.length < 2 || TG.length > 4) return fail('目标数需 2~4');
        const budget = Math.max(0, Number(p.budget) || 0);
        const bestCost = Math.max(0, Number(p.bestCost) || 0);
        const maxWash = Math.max(500, Number(p.maxWash) || 3000);
        const lead = Math.max(1, Number(p.lead) || 40);
        const M = Math.max(0, Number(p.M) || 2);
        const n = Math.max(0, Number(p.n) || 0);
        const conflictTtl = Math.max(60, Number(p.conflictTtl) || 260);
        const upgradeAt = Math.max(1, Number(p.upgradeAt) || 1);

        let zi = Number(p.zi0) >= 154 ? 154 : 153;
        let e = engine(raw, zi);
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let cost = 0, washes = 0, exchanges = 0, burns = 0;
        const held = [];
        let conflict = null, conflictSince = 0, carrier = null;
        const steps = [];
        const seedInited = () => s.luckSeed != null || !!raw.luck_seed_inited;
        // 中途放弃时也带全诊断信息
        const bail = why => ({
            ok: false, note: why, cost, washes, exchanges, burns,
            steps: steps.slice(), field: s.talents.slice(), held: held.slice(),
            missing: TG.filter(id => !held.includes(id)), luckSeed: s.luckSeed,
        });

        const keep = () => held.concat(conflict == null ? [] : [conflict])
            .concat(carrier == null ? [] : [carrier])
            .map(id => s.talents.indexOf(id)).filter(i => i >= 0);
        const keepIds = () => held.concat(conflict == null ? [] : [conflict])
            .concat(carrier == null ? [] : [carrier]);

        // 步骤记录：locks = 本步骤之前那段洗髓期间锁着的脉；replaceLocks = 置换时锁着的脉
        let segLocks = [];
        const pushStep = step => {
            step.locks = segLocks.slice();
            step.field = (step.field || s.talents).slice();
            step.lockedIds = [...new Set(held.concat(
                conflict == null ? [] : [conflict],
                carrier == null ? [] : [carrier]))];
            steps.push(step);
            segLocks = keepIds();
        };

        const washOne = () => {
            const r = e.wash(s, keep());
            s = r.state;
            cost += Number(r.cost) || 0;
            washes++;
            return r;
        };
        const lockNatural = r => {
            for (const ev of (r.generatedEvents || [])) {
                const id = Number(ev.id);
                if (e.quality(id) === 4 && TG.includes(id) && !held.includes(id)) {
                    held.push(id);
                    pushStep({ type: 'lock', id, washes, cost });
                }
            }
        };

        // 池子前瞻：从当前欧气种子抽 count 条「不在当前场上的紫」（近似；实际以 replace 为准）
        const poolHeads = count => {
            if (s.luckSeed == null) return [];
            let luck = Number(s.luckSeed) || 0;
            const onField = new Set(s.talents.map(Number));
            const heads = [];
            for (let i = 0; i < 4000 && heads.length < count; i++) {
                let id;
                try { [id, luck] = e.draw(luck, true); } catch (err) { break; }
                if (!e.allowed.has(id)) continue;
                const nid = Number(id);
                if (onField.has(nid)) continue;
                heads.push(nid);
            }
            return heads;
        };

        // ③ 置换决策回合：可能连做几手（神脉互冲可连续换）
        // 返回 'acted' | 'skip' | 'none'
        const tryExchangeRound = () => {
            let acted = false;
            for (let iter = 0; iter < 4; iter++) {
                const locks = held.concat(conflict == null ? [] : [conflict]);
                const reps = e.replaceablePositions(s, locks).filter(pos => {
                    const id = Number(s.talents[pos]);
                    if (id === 251) return false;
                    if (held.includes(id)) return false;
                    if (conflict != null && id === conflict) return false;
                    return true;
                });
                if (!reps.length) return acted ? 'acted' : 'none';
                const pos = reps[0];
                const heads = poolHeads(M + 1);
                const missing = TG.filter(id => !held.includes(id) && !s.talents.includes(id));
                const decide = heads.length && missing.includes(heads[0]) ? 'keep'
                    : (heads.slice(1).some(h => missing.includes(h)) ? 'burn' : 'skip');
                if (decide === 'skip') return acted ? 'acted' : 'skip';
                const from = Number(s.talents[pos]);
                const r = e.replace(s, pos, locks);
                s = r.state;
                exchanges++;
                const added = Number(r.addedId);
                if (TG.includes(added) && !held.includes(added)) {
                    held.push(added);
                    pushStep(Object.assign({ type: 'exchange', from, to: added, washes, cost },
                        { replaceLocks: locks.slice() }));
                } else {
                    burns++;
                    pushStep(Object.assign({ type: 'burn', from, to: added, washes, cost },
                        { replaceLocks: locks.slice() }));
                }
                acted = true;
            }
            return acted ? 'acted' : 'none';
        };

        // 前瞻：各类型下一条「非目标」紫的距离（一次模拟，本洗内共用）
        // ⚠ 每洗都要按当前场上重新算锁位：keep 位置会随洗髓漂移
        // ⚠ 目标紫靠天然捕获，不给它锁冲突（实测：给术绍岐黄锁冲突会拖慢整条路线）
        const nextPurpleByType = limit => {
            const map = new Map();
            let ps = s;
            const lockIds = keepIds();
            for (let k = 1; k <= limit; k++) {
                const rr = e.wash(ps, lockIds.map(id => ps.talents.indexOf(id)).filter(i => i >= 0));
                ps = rr.state;
                for (const ev of (rr.generatedEvents || [])) {
                    const id = Number(ev.id);
                    if (e.quality(id) !== 4) continue;
                    if (TG.includes(id)) continue;                 // 目标紫：天然捕获，不预锁冲突
                    const ty = e.talentType(id);
                    if (!map.has(ty)) map.set(ty, k);
                }
            }
            return map;
        };

        let guard = 0;
        while (guard++ < maxWash * 2 && washes < maxWash) {
            if (held.length >= TG.length) break;
            if (budget > 0 && cost > budget) return bail('超预算');
            if (bestCost > 0 && cost > bestCost) return bail('超当前最优');

            // 开第 4 槽（3 槽起手时）
            if (zi === 153 && (held.length >= upgradeAt || held.length + (conflict != null ? 1 : 0) + 1 >= e.slotCount)) {
                zi = 154;
                e = engine(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                pushStep({ type: 'upgrade', toZi: 154, washes, cost });
                continue;
            }

            // ① 场上天然目标 → 锁
            for (const id of TG) {
                if (s.talents.includes(id) && !held.includes(id)) {
                    held.push(id);
                    pushStep({ type: 'lock', id, washes, cost });
                }
            }
            if (held.length >= TG.length) break;

            // ② 种子已固定 → 置换决策
            if (seedInited()) {
                const res = tryExchangeRound();
                if (res === 'acted') { conflict = null; segLocks = keepIds(); continue; }
                if (res === 'skip' && conflict != null) {
                    // 决策为跳过：记录冲突释放（否则回放器不知道锁集变了）
                    pushStep({ type: 'unlockConflict', id: conflict, washes, cost, why: '跳过置换' });
                    conflict = null;
                    carrier = null;
                    segLocks = keepIds();
                }
            }

            // 冲突超时 → 释放
            if (conflict != null && washes - conflictSince > conflictTtl) {
                pushStep({ type: 'unlockConflict', id: conflict, washes, cost, why: '超时' });
                conflict = null;
                carrier = null;
                segLocks = keepIds();
            }

            // ③ 洗一次，处理本洗事件
            const r = washOne();
            lockNatural(r);
            if (held.length >= TG.length) break;
            if (budget > 0 && cost > budget) return bail('超预算');
            if (bestCost > 0 && cost > bestCost) return bail('超当前最优');

            // 低阶脉出现且没有冲突 → 前瞻锁冲突
            if (conflict == null && carrier == null) {
                const lows = (r.generatedEvents || [])
                    .map(ev => Number(ev.id))
                    .filter(id => id !== 251 && e.quality(id) < 4 && !held.includes(id));
                if (lows.length) {
                    const purpleDist = nextPurpleByType(lead);
                    for (const id of lows) {
                        const ty = e.talentType(id);
                        const off = purpleDist.get(ty);
                        if (off != null && off <= lead) {
                            conflict = id;
                            conflictSince = washes;
                            pushStep({ type: 'lockConflict', id, washes, cost, expectIn: off });
                            break;
                        }
                    }
                }
            }

            // 载体紫出现（冲突类型）→ 定种子（未固定时）
            if (conflict != null && !seedInited()) {
                const cType = e.talentType(conflict);
                const pIdx = s.talents.findIndex((id, i) =>
                    e.quality(id) === 4 && e.talentType(id) === cType
                    && id !== conflict && !held.includes(id));
                if (pIdx >= 0) {
                    const Pid = Number(s.talents[pIdx]);
                    // 种子轨迹探测模式：只推垫洗、记录每洗后的 bornSeed，不置换（供枚举筛选）
                    if (p.probeSeeds != null) {
                        const seeds = [Number(s.bornSeed)];
                        carrier = Pid;
                        for (let k = 1; k <= p.probeSeeds; k++) {
                            const rr = washOne();
                            seeds.push(Number(s.bornSeed));
                            if (budget > 0 && cost > budget * 4) break;
                        }
                        carrier = null;
                        return Object.assign(bail('probe'), {
                            probe: { seeds, carrier: Pid, conflict, washAt: washes, zi },
                        });
                    }
                    // 定种子：锁载体 → 垫洗 n → 置换
                    carrier = Pid;
                    pushStep({ type: 'lockCarrier', id: Pid, washes, cost });
                    segLocks = keepIds();
                    let padAbort = false;
                    for (let k = 0; k < n; k++) {
                        if (budget > 0 && cost > budget) { padAbort = true; break; }
                        if (bestCost > 0 && cost > bestCost) { padAbort = true; break; }
                        const rr = washOne();
                        lockNatural(rr);
                    }
                    carrier = null;
                    if (padAbort) return bail('垫洗超预算');
                    const pos = s.talents.indexOf(Pid);
                    const locks = held.concat([conflict]);
                    if (pos >= 0 && e.replaceablePositions(s, locks).includes(pos)) {
                        const rr = e.replace(s, pos, locks);
                        s = rr.state;
                        exchanges++;
                        const added = Number(rr.addedId);
                        if (TG.includes(added) && !held.includes(added)) {
                            held.push(added);
                            pushStep(Object.assign({ type: 'exchange', from: Pid, to: added, washes, cost, first: true, n },
                                { replaceLocks: locks.slice() }));
                        } else {
                            burns++;
                            pushStep(Object.assign({ type: 'burn', from: Pid, to: added, washes, cost, first: true, n },
                                { replaceLocks: locks.slice() }));
                        }
                    }
                    carrier = null;
                    segLocks = keepIds();
                    conflict = null;
                    segLocks = keepIds();
                }
            }
        }

        const ok = TG.every(id => held.includes(id));
        return {
            ok, cost, washes, exchanges, burns,
            field: s.talents.slice(), held: held.slice(), steps,
            missing: TG.filter(id => !held.includes(id)),
            params: { zi0: p.zi0, n, lead, M, upgradeAt },
            luckSeed: s.luckSeed,
        };
    }

    /** 独立回放验证：用引擎把步骤表重放一遍（不信构造器自己的账）。 */
    function verifySteps(rawInput, targets, steps, zi0) {
        const TG = (targets || []).map(Number);
        let zi = Number(zi0) >= 154 ? 154 : 153;
        let e;
        try { e = engine(rawInput, zi); } catch (err) { return { ok: false, reason: '引擎起不来' }; }
        let s = e.initialState(Object.assign({}, rawInput, { zizhi: zi }));
        let cost = 0, washes = 0, prevW = 0;
        for (const st of (steps || [])) {
            const target = Number(st.washes) || 0;
            const dw = target - prevW;
            if (dw < 0) return { ok: false, reason: '步骤洗数倒退' };
            if (dw > 0) {
                const lockIds = (st.locks || []).slice();
                for (let k = 0; k < dw; k++) {
                    // ⚠ 每洗都要重算锁位：锁着的脉会被引擎挪到队首，索引漂移
                    const keep = lockIds.map(id => s.talents.indexOf(id)).filter(i => i >= 0);
                    if (keep.length !== lockIds.length) return { ok: false, reason: `第 ${target} 洗：段锁脉不在场` };
                    let r;
                    try { r = e.wash(s, keep); } catch (err) { return { ok: false, reason: '洗髓抛错：' + err.message }; }
                    s = r.state; cost += Number(r.cost) || 0; washes++;
                }
            }
            if (st.type === 'upgrade' && st.toZi === 154 && zi === 153) {
                zi = 154; e = engine(rawInput, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
            } else if (st.type === 'lock' || st.type === 'lockConflict' || st.type === 'lockCarrier') {
                if (!s.talents.includes(Number(st.id))) return { ok: false, reason: `锁 ${nameOf(st.id)} 时不在场（${washes}洗）` };
            } else if (st.type === 'exchange' || st.type === 'burn') {
                const pos = s.talents.indexOf(Number(st.from));
                if (pos < 0) return { ok: false, reason: `置换前没有 ${nameOf(st.from)}（${washes}洗）` };
                const locks = (st.replaceLocks || []).map(Number);
                if (!e.replaceablePositions(s, locks).includes(pos)) {
                    return { ok: false, reason: `置换 ${nameOf(st.from)} 不可达（${washes}洗）` };
                }
                let r;
                try { r = e.replace(s, pos, locks); }
                catch (err) { return { ok: false, reason: '置换抛错：' + err.message }; }
                if (Number(r.addedId) !== Number(st.to)) {
                    return { ok: false, reason: `置换 ${nameOf(st.from)}→${nameOf(st.to)} 实际换出 ${nameOf(r.addedId)}（${washes}洗）` };
                }
                s = r.state;
            } else if (st.type === 'unlockConflict') {
                // 无状态变化
            }
            prevW = target;
        }
        const ok = TG.every(id => s.talents.includes(id));
        return { ok, cost, washes, reason: ok ? '' : '终态缺目标：' + TG.filter(id => !s.talents.includes(id)).map(nameOf).join('、') };
    }

    /** 枚举维度构造最优路线（n 先按欧气池初筛，再完整构造 + 独立回放验证）。 */
    function constructBest(raw, targets, opts) {
        const o = opts || {};
        const budget = Math.max(0, Number(o.budget) || 0);
        const timeMs = Math.max(3000, Number(o.timeMs) || 60000);
        const deadline = Date.now() + timeMs;
        const nMax = Math.max(0, Number(o.nMax) || 200);
        const leads = Array.isArray(o.leads) && o.leads.length ? o.leads.map(Number) : [28, 20, 32, 16, 24, 8];
        const M = Math.max(0, Number(o.M) || 2);
        const ziList = Array.isArray(o.ziList) && o.ziList.length ? o.ziList.map(Number) : [154, 153];
        const upgradeAt = Number(o.upgradeAt) || 1;
        const maxWash = Math.max(1000, Number(o.maxWash) || 4000);
        const topN = Math.max(1, Number(o.topN) || 60);
        const TG = (targets || []).map(Number);

        // ① 每个 (zi0, lead) 跑一次「种子轨迹探测」，拿 0..nMax 垫洗后的 bornSeed
        // ② 每个 n 抽欧气池，初筛：目标在池子里的深度（天然目标不在池里，允许缺 1~2 条）
        // ③ 只对最有希望的 n 跑完整构造 + verifySteps
        const candidates = [];
        const tried = [];
        for (const zi0 of ziList) {
            for (const lead of leads) {
                if (Date.now() > deadline) break;
                let seeds = null, seedInited = !!raw.luck_seed_inited;
                if (!seedInited) {
                    let pr = null;
                    try {
                        pr = constructOnce(raw, TG, { zi0, n: 0, lead, M, upgradeAt, budget: 0, maxWash: 3000, probeSeeds: nMax });
                    } catch (err) { pr = null; }
                    if (pr && pr.probe && pr.probe.seeds && pr.probe.seeds.length) seeds = pr.probe.seeds;
                    else continue;                     // 该 (zi0, lead) 走不到定种子点
                }
                const scored = [];
                if (seedInited) {
                    scored.push({ n: 0, pool: poolOf(raw, raw.luck_seed, 12) });
                } else {
                    for (let n = 0; n < seeds.length; n++) {
                        const pool = poolOf(raw, seeds[n], 12);
                        const hits = TG.filter(t => pool.includes(t)).length;
                        if (hits < Math.max(1, TG.length - 2)) continue;   // 池里至少要有 2 条目标
                        const last = Math.max(...TG.map(t => pool.indexOf(t)));
                        scored.push({ n, pool, last, hits });
                    }
                }
                // 命中数优先、再看目标深度（n=115 那种「4 目标全在池里」的组合排前面）
                scored.sort((a, b) => (b.hits - a.hits) || (a.last - b.last) || (a.n - b.n));
                for (const cand of scored.slice(0, topN)) candidates.push({ zi0, lead, n: cand.n, hits: cand.hits, last: cand.last });
            }
        }
        // 全局按「池子质量」排序：命中数多、目标浅的先构造（秒级出第一条路线）
        candidates.sort((a, b) => (b.hits - a.hits) || (a.last - b.last) || (a.n - b.n));

        // ③ 完整构造 + 验证
        let best = null;
        let bestCost = 0;
        const startMs = Date.now();
        let firstFoundMs = 0;
        for (const c of candidates) {
            if (Date.now() > deadline) break;
            let r = null;
            try {
                r = constructOnce(raw, TG, { zi0: c.zi0, n: c.n, lead: c.lead, M, upgradeAt, budget, bestCost, maxWash });
            } catch (err) { r = fail('抛错: ' + err.message); }
            if (!r || !r.ok) continue;
            const v = verifySteps(raw, TG, r.steps, c.zi0);
            tried.push({ zi0: c.zi0, n: c.n, lead: c.lead, cost: r.cost, verified: !!v.ok });
            if (!v.ok) continue;         // 独立回放不过 → 丢弃
            if (!best || v.cost < best.cost) {
                best = Object.assign({}, r, { cost: v.cost, washes: v.washes, verified: true });
                bestCost = v.cost;
            }
            if (!firstFoundMs) firstFoundMs = Date.now() - startMs;
        }
        if (best) { best.tried = tried; best.firstFoundMs = firstFoundMs; return best; }
        return { ok: false, tried, note: '所有 (zi0, lead, n) 候选都没凑齐四目标' };
    }

    root.AutoWash2UnifiedRouteConstructor = Object.freeze({
        engine, baselineScan, poolOf, constructOnce, constructBest, verifySteps,
        nameOf,
    });
})(typeof window !== 'undefined' ? window : globalThis);
