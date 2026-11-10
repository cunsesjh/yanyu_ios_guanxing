// -*- coding: utf-8 -*-
// 特别鸣谢 B站大佬「庸丶人」提供欧气种子路线、吞脉/跳脉及统一路线构造的研究方案。
// This copy is namespace-isolated and every candidate is replayed again by
// iosGuanxing before it enters the shared result list.
/**
 * 统一洗脉路线构造器（2026-10-19 与使用者逐条对齐后的整体重写）。
 *
 * 单一流水线（入口 planBest）：
 *   ① 读原始脉序 —— 3 槽快读：紫位 + 相邻间隔（进场条数）+ 保底紫位标记；
 *   ② 定欧气种子 —— 无限置换（垫洗 n 按条数枚举）；第一次欧气事件写种子（born 起链落盘）；
 *   ③ 选收尾脉 —— 位置 ≥ 目标紫数；身份 = 目标 / 非目标神脉 / 保底紫位；可逐条「往后推」试，
 *      这条不行/超预算 → 试下一条，循环，不超过丹耗上限即可；
 *   ④ 截置换脉序 —— 五条规则校验（终点、合集覆盖、尾段只许神脉、2→3 毁脉=间隔、
 *      1→2 无限置换障碍、第 1 目标头部），不合格的链直接淘汰；
 *   ⑤ 倒着插锚点 —— 靠后优先；毁脉点 = 普通紫 + 冲突在「上一条紫→它」的间隙里；
 *   ⑥ 执行 + 回放验证 —— 计划驱动的事件执行器，整条路线独立回放，不符即弃。
 */
(function (root) {
    'use strict';

    const ENGINE_CACHE = new WeakMap();
    function engineOf(raw, zi) {
        const zz = root.ZZ_DATA[String(zi)];
        if (!zz) throw new Error('资质表缺失: ' + zi);
        if (raw && (typeof raw === 'object' || typeof raw === 'function')) {
            let byZi = ENGINE_CACHE.get(raw);
            if (!byZi) {
                byZi = new Map();
                ENGINE_CACHE.set(raw, byZi);
            }
            const key = Number(zi) || 0;
            if (byZi.has(key)) return byZi.get(key);
            const engine = new root.AutoWash2Engine.Engine(root.TALENT_DATA, raw, {
                slotCount: zz.num_talent, pity: zz.bd_zz, eat: zz.eat_xisui,
                eligibleZi: zi, advancePerDraw: true,
            });
            byZi.set(key, engine);
            return engine;
        }
        return new root.AutoWash2Engine.Engine(root.TALENT_DATA, raw, {
            slotCount: zz.num_talent, pity: zz.bd_zz, eat: zz.eat_xisui,
            eligibleZi: zi, advancePerDraw: true,
        });
    }
    // ★ 起手状态：低于 3 槽（资质 <153）的角色先按实际资质建初始场，再升到 3 槽，之后才开始别的操作
    function startStateAt(raw, zi) {
        const target = Number(zi) >= 150 ? Number(zi) : 153;
        const base = Math.max(151, Math.min(Number(raw.zizhi) || 153, target));
        let e = engineOf(raw, base);
        let s = e.initialState(Object.assign({}, raw, { zizhi: base }));
        if (base < target) {
            e = engineOf(raw, target);
            s = e.upgradeToThree(Object.assign({}, s, { zizhi: target }));
        }
        return { e, s };
    }

    /**
     * 阶段 1：原始脉序事件分类。
     *
     * 这里只判断事件本身的静态身份和可置换性，不选择种子、不选收尾。
     * 保底紫的真实脉名和最近冲突都必须在使用时动态重扫，因此这里只
     * 标记“动态可锚”；神脉只能作为条件互冲候选，不能直接当普通锚点。
     */
    function annotateOriginalSequence(seq, engine, targets) {
        const TG = new Set((targets || []).map(Number));
        const occurrenceById = new Map();
        let previousPurpleWash = 0;
        const annotated = (seq || []).map((event, index) => {
            const e = Object.assign({}, event);
            const id = Number(e.id);
            const occurrenceOrdinal = (occurrenceById.get(id) || 0) + 1;
            occurrenceById.set(id, occurrenceOrdinal);
            const isPity = !!e.fromPity;
            const isShenmai = !!(engine && engine.isShenmai(id)) || !!e.shenmai;
            const isOneHeart = id === 251;
            const isTarget = TG.has(id);
            const conflictId = Number(e.conflictId) || 0;
            const conflictWash = Number(e.conflictWash) || 0;
            const purpleKind = isPity ? 'pity'
                : isShenmai ? 'shenmai'
                    : isOneHeart ? 'oneHeart' : 'natural';
            let replaceable = false;
            let anchorEligible = false;
            let anchorCandidate = false;
            let conditionalAnchorEligible = false;
            let anchorMode = 'none';
            let anchorBlockReason = '';
            if (isPity) {
                replaceable = true;
                anchorEligible = true;
                anchorCandidate = true;
                anchorMode = 'pity-dynamic';
            } else if (isShenmai) {
                anchorCandidate = true;
                conditionalAnchorEligible = true;
                anchorMode = 'shenmai-pair';
                anchorBlockReason = '神脉需要前置目标神脉形成互冲';
            } else if (isOneHeart) {
                anchorBlockReason = '一心两用不可置换';
            } else if (conflictId > 0) {
                replaceable = true;
                anchorEligible = true;
                anchorCandidate = true;
                anchorMode = 'nearest-conflict';
            } else {
                anchorBlockReason = '前方没有同类型低阶冲突脉';
            }
            const anchorStatus = anchorEligible ? 'anchor'
                : anchorCandidate ? 'anchor-candidate' : 'non-anchor';
            return Object.assign(e, {
                index: index + 1,
                occurrenceOrdinal,
                purpleKind,
                isPity,
                isShenmai,
                isOneHeart,
                isNatural: purpleKind === 'natural',
                isTarget,
                nearestConflictId: conflictId,
                nearestConflictWash: conflictWash,
                nearestConflictBars: Number(e.conflictBars) || 0,
                nearestConflictType: conflictId > 0
                    ? (engine && engine.talentType(conflictId)) || null : null,
                nearestConflictDistance: conflictId > 0
                    ? Math.max(0, (Number(e.wash) || 0) - conflictWash) : 0,
                nearestConflictGapBars: conflictId > 0
                    ? Math.max(0, (Number(e.bars) || 0)
                        - (Number(e.conflictBars) || 0)) : 0,
                conflictSource: conflictId > 0 ? 'original-sequence' : 'none',
                conflictInGap: false,
                replaceable,
                anchorEligible,
                conditionalAnchorEligible,
                isAnchorEligible: anchorEligible,
                isAnchor: anchorEligible,
                isAnchorCandidate: anchorCandidate,
                anchorStatus,
                anchorLabel: anchorStatus === 'anchor' ? '锚点'
                    : anchorStatus === 'anchor-candidate' ? '锚点备选' : '非锚点',
                anchorMode,
                anchorBlockReason,
                anchorConflictDynamic: isPity || isShenmai,
            });
        });
        // previousPurpleWash 必须在 map 过程中更新；单独回写一次便于检查。
        previousPurpleWash = 0;
        let previousPurpleBars = 0;
        for (const event of annotated) {
            event.conflictInGap = Number(event.nearestConflictId) > 0
                && (Number(event.nearestConflictBars) || 0) >= previousPurpleBars;
            event.gapFromPreviousPurple = Math.max(0,
                (Number(event.wash) || 0) - previousPurpleWash);
            event.gapFromPreviousPurpleBars = Math.max(0,
                (Number(event.bars) || 0) - previousPurpleBars);
            previousPurpleWash = Number(event.wash) || previousPurpleWash;
            previousPurpleBars = Number(event.bars) || previousPurpleBars;
        }
        return annotated;
    }

    function anchorEventsOf(seq) {
        return (seq || []).filter(event =>
            event.isAnchor === true || event.anchorEligible === true);
    }

    function anchorCandidateEventsOf(seq) {
        return (seq || []).filter(event =>
            event.isAnchorCandidate === true || event.conditionalAnchorEligible === true);
    }

    function conflictLookupOf(seq) {
        const byNo = new Map();
        const byOccurrence = new Map();
        for (const event of (seq || [])) {
            const value = {
                eventNo: Number(event.no) || 0,
                purpleId: Number(event.id) || 0,
                occurrenceOrdinal: Number(event.occurrenceOrdinal) || 0,
                conflictId: Number(event.nearestConflictId) || 0,
                conflictWash: Number(event.nearestConflictWash) || 0,
                conflictBars: Number(event.nearestConflictBars) || 0,
                conflictType: event.nearestConflictType == null
                    ? null : Number(event.nearestConflictType),
                conflictDistance: Number(event.nearestConflictDistance) || 0,
                conflictGapBars: Number(event.nearestConflictGapBars) || 0,
                source: event.conflictSource || 'none',
            };
            byNo.set(value.eventNo, value);
            byOccurrence.set(`${value.purpleId}#${value.occurrenceOrdinal}`, value);
        }
        return { byNo, byOccurrence };
    }

    function isSequenceAnchorEligible(event, allowShenmai) {
        if (!event) return false;
        if (event.shenmai && allowShenmai) return true;
        if (event.isAnchorCandidate === true && allowShenmai) return true;
        if (event.isAnchor === true || event.anchorEligible === true) return true;
        if (event.isAnchor === false || event.anchorEligible === false) return false;
        // 兼容外部合并进来的隐藏事件；正常阶段 1 都带显式标记。
        if (event.fromPity) return true;
        if (event.shenmai) return !!allowShenmai;
        return Number(event.conflictId) > 0 && Number(event.id) !== 251;
    }

    /**
     * 阶段 2 第 1 步：判断当前欧气种子是否固定。
     * 唯一权威字段是 luck_seed_inited；首紫是否保底只用于后续方法选择。
     */
    function resolveSeedState(raw, sequenceInfo) {
        const source = raw || {};
        const rawFlag = source.luck_seed_inited;
        const fixed = rawFlag === true
            || Number(rawFlag) === 1
            || String(rawFlag).toLowerCase() === 'true';
        const luckSeed = source.luck_seed == null ? null : Number(source.luck_seed);
        const valid = !fixed || (luckSeed != null && Number.isFinite(luckSeed));
        const seq = Array.isArray(sequenceInfo)
            ? sequenceInfo : (sequenceInfo && Array.isArray(sequenceInfo.seq)
                ? sequenceInfo.seq : []);
        const firstPurple = seq[0] || null;
        const firstPurpleIsPity = !!(firstPurple && firstPurple.fromPity);
        const firstPurpleIsAnchor = !!(firstPurple
            && isSequenceAnchorEligible(firstPurple, false));
        const firstPityIndex = seq.findIndex(event => !!(event && event.fromPity));
        const beforeFirstPity = firstPityIndex >= 0
            ? seq.slice(0, firstPityIndex) : seq;
        const hasExchangeAnchorBeforeFirstPity = beforeFirstPity.some(event =>
            isSequenceAnchorEligible(event, false));
        return {
            fixed,
            initialized: fixed,
            valid,
            seedStatus: fixed ? 'fixed' : 'unfixed',
            currentSeed: fixed ? luckSeed : null,
            bornSeed: source.seed == null ? null : Number(source.seed),
            canEnumerateN: !fixed,
            nextAction: fixed ? 'use-current-luck-chain' : 'choose-seed-method',
            firstPurpleId: firstPurple ? Number(firstPurple.id) || 0 : 0,
            firstPurpleIsPity,
            firstPurpleIsAnchor,
            firstPityNo: firstPityIndex >= 0
                ? Number(seq[firstPityIndex].no) || firstPityIndex + 1 : 0,
            hasExchangeAnchorBeforeFirstPity,
            firstPurpleConflictId: firstPurple
                ? Number(firstPurple.conflictId || firstPurple.nearestConflictId) || 0 : 0,
            error: valid ? '' : 'luck_seed_inited=true，但 luck_seed 缺失或无效',
        };
    }

    function findCurrentConflictPairs(raw) {
        const source = raw || {};
        const zi = Number(source.zizhi) >= 150 ? Number(source.zizhi) : 153;
        const e = engineOf(source, zi);
        const talents = (source.talents || []).map(item => ({
            id: Number(item && item.id != null ? item.id : item),
            locked: !!(item && typeof item === 'object' && item.locked),
        }));
        const lowsByType = new Map();
        const pairs = [];
        talents.forEach((talent, index) => {
            if (!(talent.id > 0)) return;
            const type = e.talentType(talent.id);
            if (e.quality(talent.id) === 4) {
                const conflict = lowsByType.get(type);
                if (conflict && talent.id !== 251 && !e.isShenmai(talent.id)) {
                    pairs.push({
                        purpleId: talent.id,
                        purpleIndex: index,
                        purpleLocked: talent.locked,
                        conflictId: conflict.id,
                        conflictIndex: conflict.index,
                        conflictLocked: conflict.locked,
                        type,
                    });
                }
            } else if (talent.id !== 251) {
                lowsByType.set(type, {
                    id: talent.id,
                    index,
                    locked: talent.locked,
                });
            }
        });
        return pairs;
    }

    /**
     * 阶段 2 第 2 步：未固定种子时选择方法族。
     * fixed 直接返回当前固定链方案，不参与无限置换/吞脉法选择。
     */
    function resolveSeedMethod(raw, sequenceInfo) {
        const state = resolveSeedState(raw, sequenceInfo);
        const directConflictPairs = findCurrentConflictPairs(raw);
        const canDirectInfiniteExchange = directConflictPairs.length > 0;
        if (!state.valid) {
            return Object.assign({}, state, {
                methodFamily: 'invalid',
                submethods: [],
                methodFamilies: [],
                directConflictPairs,
                canDirectInfiniteExchange,
                nextAction: 'report-seed-state-error',
            });
        }
        if (state.fixed) {
            return Object.assign({}, state, {
                methodFamily: 'fixed-current-chain',
                submethods: ['fixed-current-chain'],
                methodFamilies: ['fixed-current-chain'],
                directConflictPairs,
                canDirectInfiniteExchange,
                allowsN: false,
                allowsSwallow: false,
                allowsInfiniteExchange: false,
                nextAction: 'plan-route-from-current-chain',
            });
        }
        if (!state.firstPurpleId) {
            return Object.assign({}, state, {
                methodFamily: 'invalid',
                submethods: [],
                methodFamilies: [],
                directConflictPairs,
                canDirectInfiniteExchange,
                nextAction: 'report-missing-original-sequence',
                error: '未固定种子，但阶段 1 没有可用的首条原始紫',
            });
        }
        const methodFamilies = [];
        const firstPurpleSupportsInfinite = !state.firstPurpleIsPity
            && state.hasExchangeAnchorBeforeFirstPity;
        if (!firstPurpleSupportsInfinite || canDirectInfiniteExchange) {
            methodFamilies.push('swallow');
        }
        if (firstPurpleSupportsInfinite || canDirectInfiniteExchange) {
            methodFamilies.push('infinite-exchange');
        }
        if (!firstPurpleSupportsInfinite) {
            const supportsBothMethods = methodFamilies.includes('swallow')
                && methodFamilies.includes('infinite-exchange');
            return Object.assign({}, state, {
                // 未固定阶段只有两种方案路线；当前场冲突对只是增加
                // infinite-exchange 候选，不产生第三种 mixed 方法。
                methodFamily: supportsBothMethods
                    ? 'swallow+infinite-exchange' : 'swallow',
                methodFamilies,
                submethods: methodFamilies.includes('infinite-exchange')
                    ? ['jump', 'lock', 'direct-pity',
                        'direct-pity-with-preconflict', 'infinite-exchange']
                    : ['jump', 'lock', 'direct-pity',
                        'direct-pity-with-preconflict'],
                directConflictPairs,
                canDirectInfiniteExchange,
                allowsN: methodFamilies.includes('infinite-exchange'),
                allowsSwallow: true,
                allowsInfiniteExchange: methodFamilies.includes('infinite-exchange'),
                nextAction: methodFamilies.length > 1
                    ? 'enumerate-available-method-families'
                    : 'enumerate-swallow-methods',
            });
        }
        const supportsBothMethods = methodFamilies.includes('swallow')
            && methodFamilies.includes('infinite-exchange');
        return Object.assign({}, state, {
            methodFamily: supportsBothMethods
                ? 'swallow+infinite-exchange' : 'infinite-exchange',
            submethods: supportsBothMethods
                ? ['jump', 'lock', 'direct-pity',
                    'direct-pity-with-preconflict', 'infinite-exchange']
                : ['infinite-exchange'],
            methodFamilies,
            directConflictPairs,
            canDirectInfiniteExchange,
            allowsN: true,
            allowsSwallow: methodFamilies.includes('swallow'),
            allowsInfiniteExchange: true,
            nextAction: supportsBothMethods
                ? 'enumerate-available-method-families'
                : 'enumerate-infinite-starts-and-N',
        });
    }
    const nameOf = id => (root.TALENT_DATA[String(id)] || {}).name || String(id);
    const talentType = id => (root.TALENT_DATA[String(id)] || {}).type;

    /**
     * 普通紫置换只能使用它前方最近的同类型低阶脉作为冲突脉。
     * 返回的是场上当前状态，不会为了“让路线成立”交换载体和冲突的位置。
     */
    function nearestConflictBefore(e, state, carrierId) {
        const list = ((state && state.talents) || []).map(Number);
        const pos = list.indexOf(Number(carrierId));
        if (pos < 0 || e.isShenmai(carrierId)) return null;
        const type = e.talentType(carrierId);
        for (let i = pos - 1; i >= 0; i--) {
            const id = list[i];
            if (id !== 251 && e.quality(id) < 4 && e.talentType(id) === type) {
                return { id, index: i, carrierIndex: pos, type };
            }
        }
        return null;
    }

    function usesNearestConflict(e, state, carrierId, locks) {
        if (e.isShenmai(carrierId)) return true;
        const nearest = nearestConflictBefore(e, state, carrierId);
        return !!(nearest && (locks || []).map(Number).includes(Number(nearest.id)));
    }

    /**
     * 保底位按“实际出现的紫”分类，静态脉名不参与判断。
     * 目标紫直接锁；非目标紫仍是一颗可用的原始紫载体。
     */
    function classifyPityOutput(e, id, targets) {
        const talentId = Number(id);
        return {
            id: talentId,
            isTarget: (targets || []).map(Number).includes(talentId),
            isShenmai: e.isShenmai(talentId),
            canBeCarrier: !(targets || []).map(Number).includes(talentId),
        };
    }

    // ────────────────────── ① 读原始脉序 ──────────────────────
    function readSequence(raw, opts) {
        const o = opts || {};
        const zi = Number(o.zi) >= 150 ? Number(o.zi) : 153;
        const count = Math.max(12, Number(o.count) || 40);
        const st0 = startStateAt(raw, zi);
        const e = st0.e;
        let s = st0.s;
        const slots = e.slotCount;
        const seq = [];
        let prevWash = 0;
        let cumulativeBars = 0;
        let prevPurpleBars = 0;
        const lastByType = new Map();
        for (const id of s.talents.map(Number)) {
            if (e.quality(id) === 4 || e.isShenmai(id)) continue;
            lastByType.set(e.talentType(id), { id, wash: 0, bars: 0 });
        }
        for (let w = 1; w <= 12000 && seq.length < count; w++) {
            const r = e.wash(s, []);
            s = r.state;
            cumulativeBars += Number(r.generatedBars) || 0;
            for (const ev of (r.generatedEvents || [])) {
                const id = Number(ev.id);
                const type = e.talentType(id);
                if (e.quality(id) === 4) {
                    const conflict = lastByType.get(type);
                    const gapBars = Math.max(0, cumulativeBars - prevPurpleBars);
                    seq.push({
                        no: seq.length + 1, wash: w, id,
                        fromPity: !!ev.fromPity, shenmai: e.isShenmai(id),
                        interval: gapBars,
                        bars: cumulativeBars,
                        gapBars,
                        gapWashes: Math.max(0, w - prevWash),
                        conflictId: conflict ? Number(conflict.id) : 0,
                        conflictWash: conflict ? Number(conflict.wash) || 0 : 0,
                        conflictBars: conflict ? Number(conflict.bars) || 0 : 0,
                        conflictGapBars: conflict
                            ? Math.max(0, cumulativeBars - (Number(conflict.bars) || 0)) : 0,
                        conflictGapWashes: conflict
                            ? Math.max(0, w - (Number(conflict.wash) || 0)) : 0,
                    });
                    prevWash = w;
                    prevPurpleBars = cumulativeBars;
                }
                if (e.quality(id) < 4 && id !== 251) {
                    lastByType.set(type, { id, wash: w, bars: cumulativeBars });
                }
            }
        }
        const annotated = annotateOriginalSequence(seq, e);
        return {
            zizhi: zi, slots, seq: annotated, raw,
            anchorCandidates: anchorEventsOf(annotated),
            anchorBackupCandidates: anchorCandidateEventsOf(annotated),
            conflictLookup: conflictLookupOf(annotated),
        };
    }

    // 定种子并锁到首目标后，实际会动态开四槽。后续收尾/天然目标必须
    // 从这一时刻重新扫描；不能继续使用开槽前的静态脉序。
    function readSequenceAfterSeedOpen(raw, seedOpt, targets, count) {
        if (!seedOpt || seedOpt.kind !== 'exchange' || Number(seedOpt.zi) >= 154) return null;
        const steps = Array.isArray(seedOpt.steps) ? seedOpt.steps : [];
        const hasPityPrelude = !!(seedOpt.pityPrelude
            || Number(seedOpt.a) > 0 || Number(seedOpt.d) > 0 || seedOpt.openFour);
        if (!steps.length && !hasPityPrelude) return null;
        const st0 = startStateAt(raw, Number(seedOpt.zi) || 153);
        let e = st0.e;
        let s = st0.s;
        let washes = 0;
        if (steps.length) {
            for (const step of steps) {
                const targetWash = Number(step.washes) || 0;
                while (washes < targetWash) {
                    const locks = (step.locks || []).map(id => s.talents.indexOf(id)).filter(i => i >= 0);
                    const r = e.wash(s, locks);
                    s = r.state;
                    washes++;
                }
                if (step.type === 'upgrade' && Number(step.toZi) >= 154) {
                    e = engineOf(raw, 154);
                    s = e.upgradeToFour(Object.assign({}, s, { zizhi: 154 }));
                } else if (step.type === 'exchange') {
                    const pos = s.talents.indexOf(Number(step.from));
                    const locks = (step.locks || []).slice();
                    if (pos >= 0 && e.replaceablePositions(s, locks).includes(pos)) {
                        const r = e.replace(s, pos, locks);
                        s = r.state;
                    }
                }
            }
        } else {
            // 锁脉种子在 eatFromSeed 初次筛链时还没有生成 steps；这里必须按
            // openFourAt → 开四槽 → a → 锁 lowId 洗 d → 洗到首紫 的真实前奏
            // 重建状态。若退回“从 0 洗四槽”的静态脉序，锚点编号和保底位都会错。
            const preA = Math.max(0, Number(seedOpt.a) || 0);
            const preD = Math.max(0, Number(seedOpt.d) || 0);
            const preLow = Number(seedOpt.lowId) || 0;
            const openAt = seedOpt.openFour
                ? Math.max(0, Math.min(preA, Number(seedOpt.openFourAt) || 0))
                : 0;
            const prefixWashCount = seedOpt.openFour ? openAt : preA;
            for (let i = 0; i < prefixWashCount; i++) {
                const r = e.wash(s, []);
                s = r.state;
                washes++;
            }
            if (seedOpt.openFour) {
                e = engineOf(raw, 154);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: 154 }));
            }
            const postOpenCount = seedOpt.openFour ? Math.max(0, preA - openAt) : 0;
            for (let i = 0; i < postOpenCount; i++) {
                const r = e.wash(s, []);
                s = r.state;
                washes++;
            }
            for (let i = 0; i < preD; i++) {
                const keep = preLow && s.talents.includes(preLow)
                    ? [s.talents.indexOf(preLow)] : [];
                const r = e.wash(s, keep);
                s = r.state;
                washes++;
                if (s.luckSeed != null) break;
            }
            let guard = 0;
            while (s.luckSeed == null && guard++ < 2000) {
                const r = e.wash(s, []);
                s = r.state;
                washes++;
            }
            if (s.luckSeed == null) return null;
        }
        const TG = (targets || []).map(Number);
        const held = TG.filter(id => s.talents.includes(id));
        if (!held.length) return null;
        if (Number(s.zizhi) < 154) {
            e = engineOf(raw, 154);
            s = e.upgradeToFour(Object.assign({}, s, { zizhi: 154 }));
        }
        const seq = [];
        let prevWash = washes;
        let cumulativeBars = 0;
        let prevPurpleBars = 0;
        const lastByType = new Map();
        for (const id of s.talents.map(Number)) {
            if (e.quality(id) === 4 || e.isShenmai(id)) continue;
            lastByType.set(e.talentType(id), { id, wash: washes, bars: 0 });
        }
        const lockIds = () => held.map(id => s.talents.indexOf(id)).filter(i => i >= 0);
        const maxCount = Math.max(12, Number(count) || 80);
        for (let k = 1; k <= 12000 && seq.length < maxCount; k++) {
            const r = e.wash(s, lockIds());
            s = r.state;
            const wash = washes + k;
            cumulativeBars += Number(r.generatedBars) || 0;
            for (const ev of (r.generatedEvents || [])) {
                const id = Number(ev.id);
                const type = e.talentType(id);
                if (e.quality(id) === 4) {
                    const conflict = lastByType.get(type);
                    const gapBars = Math.max(0, cumulativeBars - prevPurpleBars);
                    seq.push({
                        no: seq.length + 1, wash, id,
                        fromPity: !!ev.fromPity, shenmai: e.isShenmai(id),
                        interval: gapBars,
                        bars: cumulativeBars,
                        gapBars,
                        gapWashes: Math.max(0, wash - prevWash),
                        conflictId: conflict ? Number(conflict.id) : 0,
                        conflictWash: conflict ? Number(conflict.wash) || 0 : 0,
                        conflictBars: conflict ? Number(conflict.bars) || 0 : 0,
                        conflictGapBars: conflict
                            ? Math.max(0, cumulativeBars - (Number(conflict.bars) || 0)) : 0,
                        conflictGapWashes: conflict
                            ? Math.max(0, wash - (Number(conflict.wash) || 0)) : 0,
                    });
                    prevWash = wash;
                    prevPurpleBars = cumulativeBars;
                }
                if (e.quality(id) < 4 && id !== 251) {
                    lastByType.set(type, { id, wash, bars: cumulativeBars });
                }
            }
        }
        const annotated = annotateOriginalSequence(seq, e, targets);
        return {
            zizhi: 154, slots: 4, seq: annotated, raw, startWash: washes,
            anchorCandidates: anchorEventsOf(annotated),
            anchorBackupCandidates: anchorCandidateEventsOf(annotated),
            conflictLookup: conflictLookupOf(annotated),
        };
    }

    // eatFromSeed / 路径B预检会对同一个种子反复请求同一份动态脉序。
    // 缓存按“种子前奏完全一致”分组，避免重复模拟数百到数千手洗髓。
    function readSequenceAfterSeedOpenCached(raw, seedOpt, targets, count, cache) {
        if (!cache || !seedOpt) return readSequenceAfterSeedOpen(raw, seedOpt, targets, count);
        const steps = Array.isArray(seedOpt.steps) ? seedOpt.steps : [];
        const key = [
            Number(seedOpt.zi) || 0,
            Number(seedOpt.seed) || 0,
            Number(seedOpt.first) || 0,
            Number(seedOpt.washes) || 0,
            Number(seedOpt.a) || 0,
            Number(seedOpt.d) || 0,
            Number(seedOpt.lowId) || 0,
            Number(seedOpt.openFourAt) || 0,
            seedOpt.openFour ? 1 : 0,
            Number(count) || 0,
            (targets || []).map(Number).join(','),
            steps.length,
            steps.map(step => `${step.type}:${step.washes || 0}:${step.id || step.from || 0}`).join(';'),
        ].join('|');
        if (cache.has(key)) return cache.get(key);
        const value = readSequenceAfterSeedOpen(raw, seedOpt, targets, count);
        cache.set(key, value);
        return value;
    }

    // ────────────────────── ② 定种子：无限置换（含回放步骤） ──────────────────────
    function seedFixByExchange(raw, targets, opts) {
        const o = opts || {};
        const zi0 = Number(o.zi) >= 150 ? Number(o.zi) : 153;
        const n = Math.max(0, Number(o.n) || 0);
        const lead = Math.max(1, Number(o.lead) || 14);
        const startWash = Math.max(0, Number(o.startWash) || 0);
        // 无限置换只看最短种子链的前 15 条；到 C#15 仍覆盖不了目标，
        // 不再继续生成更深的链，直接淘汰该起点与 N。
        const chainLimit = Math.max(2, Math.min(15, Number(o.chainLimit) || 15));
        const startCarrierId = Number(o.startCarrierId || o.carrierId) || 0;
        const startAnchorNo = Number(o.startAnchorNo || o.anchorNo) || 0;
        const prepConflictId = Number(o.prepConflictId) || 0;
        const upgradeBefore = !!o.upgradeBefore;   // 开槽重掷：前缀空洗后先开 4 槽
        const maxWash = Math.max(500, Number(o.maxWash) || 3000);
        const maxPills = Math.max(0, Number(o.budget) || Number(o.headBudget) || 0);
        const overBudget = () => maxPills > 0 && cost > maxPills;
        const TG = (targets || []).map(Number);
        const initialField = (raw.talents || [])
            .map(item => Number(item && item.id != null ? item.id : item))
            .filter(id => id > 0);
        // 允许调用方指定“只用一条当前场上目标作为固定锁”，其余目标解锁后在后段重捕。
        const pinnedTargets = Array.from(new Set((o.pinTargetIds || []).map(Number)
            .filter(id => TG.includes(id) && initialField.includes(id))));
        // 四槽无限置换必须保留至少 3 个可洗槽：冲突脉 + 载体紫 + 转向/洗槽。
        // 因此最多只能固定保留 1 条当前目标；保留 2 条时退回锁脉/天然路线。
        if (pinnedTargets.length > 1) {
            throw new Error('无限置换最多保留 1 条场上目标（四槽需保留 3 个可洗槽）');
        }
        let zi = zi0;
        const st0 = startStateAt(raw, zi);
        let e = st0.e;
        let s = st0.s;
        let cost = 0, washes = 0;
        let conflict = null, carrier = null, preloadId = null;
        const steps = [];
        let segLocks = pinnedTargets.slice();
        const keepIds = () => Array.from(new Set(pinnedTargets.concat(
            [conflict, carrier, preloadId].filter(x => x != null))));
        const pushStep = step => { step.locks = segLocks.slice(); steps.push(step); segLocks = keepIds(); };
        // ★ 默认 3 槽起手：不到 3 槽的角色先升到 3 槽（0 洗，仅资质升级）
        if (Number(raw.zizhi) < 153) {
            pushStep({ type: 'upgrade', toZi: 153, washes, cost });
        }
        // 前缀空洗（不锁任何脉，只推进）
            for (let k = 0; k < startWash; k++) {
                const pin = pinnedTargets.map(id => s.talents.indexOf(id)).filter(i => i >= 0);
                const r = e.wash(s, pin);
            s = r.state; cost += Number(r.cost) || 0; washes++;
            if (overBudget()) return null;
        }
        if (upgradeBefore && zi === 153) {
            zi = 154; e = engineOf(raw, zi);
            s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
            pushStep({ type: 'upgrade', toZi: 154, washes, cost });
        }
        // 无限置换的起点可以选任意靠后的自然紫。到达指定起点后，必须
        // 直接使用场上已有的「载体紫 + 前方最近冲突」，不能继续找未来的紫。
        if (startCarrierId > 0) {
            // 起点紫可能尚未出现：先从它的前置冲突开始准备，锁定冲突后
            // 慢洗到起点紫。只有载体确实出现后，才执行 n 次延后和置换。
            if (s.talents.indexOf(startCarrierId) < 0) {
                if (prepConflictId <= 0 || s.talents.indexOf(prepConflictId) < 0) return null;
                conflict = prepConflictId;
            } else {
                const near = nearestConflictBefore(e, s, startCarrierId);
                if (!near) return null;
                conflict = Number(near.id);
            }
            pushStep({
                type: 'lockConflict', id: conflict, washes, cost,
                forPurple: startCarrierId,
            });
            let arriveGuard = 0;
            while (s.talents.indexOf(startCarrierId) < 0 && arriveGuard++ < maxWash) {
                const r = e.wash(s, [s.talents.indexOf(conflict)].filter(i => i >= 0));
                s = r.state; cost += Number(r.cost) || 0; washes++;
                if (overBudget()) return null;
            }
            if (s.talents.indexOf(startCarrierId) < 0) return null;
            const near = nearestConflictBefore(e, s, startCarrierId);
            if (!near || Number(near.id) !== conflict) return null;
            carrier = startCarrierId;
            pushStep({ type: 'lockCarrier', id: carrier, washes, cost });
        }
        // ★ 锁脉法 Route2（开4槽）前置：空洗后「锁 lowId 洗 d → 洗到保底紫」定种子（锁低阶脉，不是裸洗）
        if (o.lockPity && Number(o.lockPity.lowId)) {
            const lpLow = Number(o.lockPity.lowId);
            const lpD = Math.max(0, Number(o.lockPity.d) || 0);
            for (let k = 0; k < lpD; k++) {
                const keep = pinnedTargets.map(id => s.talents.indexOf(id)).filter(i => i >= 0);
                if (s.talents.includes(lpLow)) keep.push(s.talents.indexOf(lpLow));
                const uniqueKeep = Array.from(new Set(keep));
                const r = e.wash(s, uniqueKeep);
                s = r.state; cost += Number(r.cost) || 0; washes++;
                if (overBudget()) return null;
                if (s.luckSeed != null) break;
            }
            let pg = 0;
            while (s.luckSeed == null && pg++ < 2000) {
                const pin = pinnedTargets.map(id => s.talents.indexOf(id)).filter(i => i >= 0);
                const r = e.wash(s, pin);
                s = r.state; cost += Number(r.cost) || 0; washes++;
                if (overBudget()) return null;
                if (s.luckSeed != null) break;
            }
            if (s.luckSeed != null) pushStep({ type: 'prelude', a: startWash, lowId: lpLow, d: lpD, openFour: upgradeBefore, washes, cost });
        }
        // 没有指定自然锚点时，仍按旧逻辑从未来紫脉反查冲突。
        if (carrier == null) {
            const probe = limit => {
                const map = new Map();
                let ps = s;
                for (let k = 1; k <= limit; k++) {
                    const pin = pinnedTargets.map(id => ps.talents.indexOf(id)).filter(i => i >= 0);
                    const rr = e.wash(ps, pin);
                    ps = rr.state;
                    for (const ev of (rr.generatedEvents || [])) {
                        const id = Number(ev.id);
                        if (e.quality(id) !== 4) continue;
                        const ty = talentType(id);
                        if (!map.has(ty)) map.set(ty, k);
                    }
                }
                return map;
            };
            const dist = probe(lead);
            const lows = s.talents.map(Number)
                .filter(id => id !== 251 && e.quality(id) < 4);
            for (const id of lows) {
                const off = dist.get(talentType(id));
                if (off != null && off <= lead) {
                    conflict = id;
                    pushStep({ type: 'lockConflict', id, washes, cost, expectIn: off });
                    break;
                }
            }
        }
        const washOne = () => {
            const keep = keepIds().map(id => s.talents.indexOf(id)).filter(i => i >= 0);
            const r = e.wash(s, keep);
            s = r.state; cost += Number(r.cost) || 0; washes++;
            if (overBudget()) return null;
            return r;
        };
        const probeTypes = limit => {
            const map = new Map();
            let ps = s;
            const lockIds = keepIds();
            for (let k = 1; k <= limit; k++) {
                const rr = e.wash(ps, lockIds.map(id => ps.talents.indexOf(id)).filter(i => i >= 0));
                ps = rr.state;
                for (const ev of (rr.generatedEvents || [])) {
                    const id = Number(ev.id);
                    if (e.quality(id) !== 4) continue;
                    const ty = talentType(id);
                    if (!map.has(ty)) map.set(ty, k);
                }
            }
            return map;
        };
        let guard = 0;
        while (guard++ < maxWash * 2 && washes < maxWash && carrier == null) {
            const r = washOne();
            if (!r) return null;
            if (conflict == null) {
                const lows = (r.generatedEvents || [])
                    .map(ev => Number(ev.id))
                    .filter(id => id !== 251 && e.quality(id) < 4);
                if (lows.length) {
                    const dist = probeTypes(lead);
                    for (const id of lows) {
                        const off = dist.get(talentType(id));
                        if (off != null && off <= lead) {
                            conflict = id;
                            pushStep({ type: 'lockConflict', id, washes, cost });
                            break;
                        }
                    }
                }
            }
            if (conflict != null) {
                const cType = talentType(conflict);
                const pIdx = s.talents.findIndex((id, i) =>
                    e.quality(id) === 4 && talentType(id) === cType && id !== conflict);
                if (pIdx >= 0) {
                    carrier = Number(s.talents[pIdx]);
                    pushStep({ type: 'lockCarrier', id: carrier, washes, cost });
                }
            }
        }
        if (carrier == null) return null;
        if (s.talents.indexOf(carrier) < 0) return null;
        // 预瞄：定种子置换会换出什么（当前 born 链的下一条可抽紫）
        let peekId = null;
        try {
            let luck = Number(s.luckSeed) != null ? Number(s.luckSeed) : Number(s.bornSeed);
            for (let i = 0; i < 4000; i++) {
                let id;
                try { [id, luck] = e.draw(luck, true); } catch (err) { break; }
                if (e.allowed.has(id) && !s.talents.includes(Number(id))) { peekId = Number(id); break; }
            }
        } catch (err) { peekId = null; }
        // ★ 垫洗 n + 预载换果冲突（离置换最近的那条：边垫洗边换锁）
        preloadId = null;
        // 预载下一次换果冲突只服务连续置换。
        // 锚点倒插会等目标到指定位置再换，调用方必须显式关闭这个预载。
        if (o.preloadNextConflict !== false && peekId != null && !e.isShenmai(peekId)) {
            const ty = talentType(peekId);
            const findLow = () => s.talents.map(Number)
                .find(v => v !== 251 && e.quality(v) < 4 && talentType(v) === ty) || null;
            for (let k = 0; k < n && washes < maxWash; k++) {
                if (!washOne()) return null;
                const low = findLow();
                if (low != null && low !== preloadId) {
                    if (preloadId != null) pushStep({ type: 'unlockConflict', id: preloadId, washes, cost, why: '预载换锁更近' });
                    preloadId = low;
                    pushStep({ type: 'lockConflict', id: preloadId, washes, cost, forPurple: peekId });
                }
            }
            if (preloadId == null) {
                for (let k = 0; k < 80 && preloadId == null && washes < maxWash; k++) {
                    if (!washOne()) return null;
                    preloadId = findLow();
                    if (carrier != null && !s.talents.includes(carrier)) { preloadId = null; break; }
                }
                if (preloadId != null) {
                    pushStep({ type: 'lockConflict', id: preloadId, washes, cost, forPurple: peekId });
                }
            }
        } else {
            for (let k = 0; k < n && washes < maxWash; k++) if (!washOne()) return null;
        }
        const pos2 = s.talents.indexOf(carrier);
        const locks2 = Array.from(new Set(pinnedTargets.concat(conflict != null ? [conflict] : [])));
        if (pos2 < 0 || !e.replaceablePositions(s, locks2).includes(pos2)) return null;
        const r = e.replace(s, pos2, locks2);
        s = r.state;
        const first = Number(r.addedId);
        const seed = Number(s.luckSeed);
        pushStep({ type: 'exchange', from: carrier, to: first, washes, cost, n, replaceLocks: locks2.slice() });
        let luck = seed;
        const chain = [first];
        for (let i = 0; i < 4000 && chain.length < chainLimit; i++) {
            let id;
            try { [id, luck] = e.draw(luck, true); } catch (err) { break; }
            if (e.allowed.has(id)) chain.push(Number(id));
        }
        return { kind: 'exchange', zi: zi0, n, lead, startWash, upgradeBefore, first, seed, chain, steps, cost, washes,
            carrier, conflict, pinnedTargetIds: pinnedTargets,
            startAnchorId: startCarrierId, startAnchorNo,
            startAnchorWash: startWash, carrierArrivalWash: washes };
    }

    // ────────────────────── ③④⑤ 五条规则校验（链筛选） ──────────────────────
    // 收尾候选列表（位置 ≥ K；身份 ∈ {目标, 非目标神脉}）——供 planBest 逐条「往后推」试
    // ★ 保底紫收尾已去掉（太费丹）。不再按 id 去重：
    //   同一目标的早期出现可以只是普通载体，后面的同名出现才是真收尾。
    function tailCandidates(seq, targets, initialCount, anchorNo) {
        const K = (targets || []).length;
        // ★ 初始场上已有目标紫 → 收尾脉阈值放宽：位置 ≥ K - 初始目标数
        const minNo = Math.max(0, K - (Number(initialCount) || 0));
        const minTailNo = Number(anchorNo) > 0
            ? Math.max(minNo, Number(anchorNo) + 2)
            : minNo;
        const out = [];
        for (const p of (seq || [])) {
            if (p.no < minTailNo) continue;
            if (!targets.includes(p.id) && !p.shenmai) continue;
            out.push(p);
        }
        return out;
    }

    /**
     * 收尾丹耗下界：
     * 从收尾位向回取最近三个锚点/锚点备选，再连同收尾脉按原脉序
     * 形成“无锁 → 锁1 → 锁2 → 锁3”的阶梯。首段按当前槽数，
     * 第一次锁住后立即按 4 槽计算；用 generatedBars 间隔估算每段
     * 最少洗数与丹耗。只用于预算剪枝，无法计算时返回 null。
     */
    function estimateTailLowerBound(raw, sequenceCtx, targets, tail) {
        if (!raw || !sequenceCtx || !tail) return null;
        const seq = sequenceCtx.seq || [];
        const tailIndex = seq.indexOf(tail);
        if (tailIndex < 0) return null;
        // 该下界按“场上无目标”口径计算。已有目标时口径不同，
        // 为避免把可走路线误剪，直接标为不可计算。
        if (initialTargetCount(raw, targets) > 0) return null;
        const anchors = [];
        const usedIds = new Set();
        for (let i = tailIndex - 1; i >= 0 && anchors.length < 3; i--) {
            const event = seq[i];
            const id = Number(event && event.id);
            if (!(event && (event.isAnchor === true || event.isAnchorCandidate === true
                || event.anchorEligible === true || event.conditionalAnchorEligible === true))) continue;
            if (!(id > 0) || usedIds.has(id)) continue;
            usedIds.add(id);
            anchors.unshift(event);
        }
        if (anchors.length !== 3) return null;

        const zi0 = Number(sequenceCtx.zizhi)
            || Number(raw.zizhi) || 153;
        const startsAtFour = zi0 >= 154;
        const ladder = anchors.concat([tail]);
        let previousBars = 0;
        let previousWash = 0;
        let totalWashes = 0;
        let totalCost = 0;
        for (let k = 0; k < ladder.length; k++) {
            const event = ladder[k];
            const slots = k === 0 ? (startsAtFour ? 4 : 3) : 4;
            const locks = k === 0 ? 0 : Math.min(k, 3);
            const bars = Number(event && event.bars) > 0
                ? Math.max(0, Number(event.bars) - previousBars)
                : Math.max(0, (Number(event && event.wash) || 0) - previousWash) * slots;
            const perWash = Math.max(1, slots - locks);
            const unitCost = k === 0
                ? (startsAtFour ? 5 : 3)
                : 5 + 2 * locks - 1;
            const washes = Math.ceil(bars / perWash);
            totalWashes += washes;
            totalCost += washes * unitCost;
            previousBars = Number(event && event.bars) > 0
                ? Number(event.bars) : previousBars + bars;
            previousWash = Number(event && event.wash) || previousWash;
        }
        return {
            ok: true,
            cost: totalCost,
            washes: totalWashes,
            anchors: anchors.map(item => ({
                no: Number(item.no) || 0,
                id: Number(item.id) || 0,
                bars: Number(item.bars) || 0,
            })),
            tailNo: Number(tail.no) || 0,
            tailId: Number(tail.id) || 0,
        };
    }

    // 初始场上已有的目标紫数量（含锁定与否，id>0）
    function initialTargetCount(raw, targets) {
        const field = (raw.talents || []).map(t => Number(t && t.id != null ? t.id : t)).filter(id => id > 0);
        return (targets || []).filter(id => field.includes(id)).length;
    }

    /**
     * 无限置换起点可以一直向后延，但必须给收尾前的目标留够位置。
     * 可用来源 = 起点前已经能拿到的目标 + 起点到收尾前（含起点）的锚点数。
     */
    function infiniteStartStats(seq, targets, tailNo, startNo, initialIds) {
        const TG = Array.from(new Set((targets || []).map(Number)));
        const start = Number(startNo) || 0;
        const tail = Number(tailNo) || 0;
        if (start <= 0) return { feasible: true, before: 0, slots: 0, required: 0, slack: 0 };
        if (tail > 0 && start >= tail) {
            return { feasible: false, before: 0, slots: 0, required: Math.max(0, TG.length - 1), slack: -Infinity };
        }
        const initial = new Set((initialIds || []).map(Number));
        const before = new Set();
        for (const p of (seq || [])) {
            if (Number(p.no) >= start) break;
            if (TG.includes(Number(p.id))) before.add(Number(p.id));
        }
        for (const id of TG) if (initial.has(id)) before.add(id);
        const slots = (seq || []).filter(p => {
            const no = Number(p.no) || 0;
            return no >= start && (tail <= 0 || no < tail);
        }).length;
        const required = Math.max(0, TG.length - (tail > 0 ? 1 : 0));
        const slack = before.size + slots - required;
        return { feasible: slack >= 0, before: before.size, slots, required, slack };
    }

    function infiniteStartFeasible(seq, targets, tailNo, startNo, initialIds) {
        return infiniteStartStats(seq, targets, tailNo, startNo, initialIds).feasible;
    }

    function chainCheckSignature(seedOpt, chain, tail, mode, naturalFixedIds,
        allowInsertMapVariants) {
        const seed = seedOpt || {};
        return [
            Number(seed.zi) || 0,
            seed.kind || '',
            Number(seed.first) || 0,
            Number(seed.carrier) || 0,
            Number(seed.anchorNo) || 0,
            Number(seed.startAnchorNo) || 0,
            Number(seed.washes != null ? seed.washes : seed.startWash) || 0,
            seed.pityPrelude ? 1 : 0,
            seed.openFour ? 1 : 0,
            (seed.pinnedTargetIds || []).map(Number).sort((a, b) => a - b).join(','),
            Number(seed.initialConsumed) || 0,
            (chain || []).map(Number).join(','),
            tail ? Number(tail.no) || 0 : 0,
            tail ? Number(tail.id) || 0 : 0,
            mode || 'chain',
            (naturalFixedIds || []).map(Number).sort((a, b) => a - b).join(','),
            allowInsertMapVariants ? 1 : 0,
        ].join('|');
    }

    function chainChecks(ctx, targets, chain, seedOpt, tailOverride, anchorMode,
        naturalFixedIds, allowInsertMapVariants) {
        const TG = (targets || []).map(Number);
        const K = TG.length;
        // C#1 是定种子事件本身。它不是“不参与倒插”，而是可插入位置唯一：
        // 只能固定在种子锚点，不能被改派到 O#1/O#2 等搜索锚点。
        const seedAnchorId = Number(seedOpt && seedOpt.first) || Number(chain && chain[0]) || 0;
        if (!chain || !chain.length || Number(chain[0]) !== seedAnchorId) {
            return {
                ok: false,
                reason: '种子链 C#1 必须固定在定种子锚点，不能改派到其他原始脉位',
            };
        }
        const combineNatural = anchorMode === 'combined';
        const naturalFixedSet = new Set((naturalFixedIds || []).map(Number));
        const seq = ctx.seq;
        const E = engineOf(ctx.raw, ctx.zizhi);
        const isShen = id => E.isShenmai(id);
        const occurrenceOrdinalById = new Map();
        const occurrenceOrdinalByNo = new Map();
        const pityOrdinalByNo = new Map();
        let pityOrdinal = 0;
        for (const p of seq) {
            const id = Number(p.id);
            const ordinal = (occurrenceOrdinalById.get(id) || 0) + 1;
            occurrenceOrdinalById.set(id, ordinal);
            occurrenceOrdinalByNo.set(Number(p.no) || 0, ordinal);
            if (p.fromPity) {
                pityOrdinal += 1;
                pityOrdinalByNo.set(Number(p.no) || 0, pityOrdinal);
            }
        }

        // ★ 三紫（及以下）收尾脉「可选」：不要收尾也仍然倒插。
        //   最后一条目标不再天然收尾，而是和其余缺目标一起按链段映射到锚点。
        if (K <= 3 && !tailOverride) {
            const chainTargets = [];
            for (let i = 0; i < chain.length; i++) if (TG.includes(chain[i])) chainTargets.push({ idx: i, id: chain[i] });
            const naturalFull = TG.filter(id => seq.some(p => p.id === id && !p.fromPity));
            const initialField = (ctx.raw.talents || []).map(t => Number(t && t.id != null ? t.id : t)).filter(id => id > 0);
            const seedFirst = seedAnchorId;
            const need = TG.filter(id => id !== seedFirst
                && !initialField.includes(id)
                && !(naturalFixedSet.has(id) && naturalFull.includes(id)));
            const executionChain = [];
            let previousExecutionId = 0;
            for (const rawId of chain) {
                const id = Number(rawId);
                if (!TG.includes(id) && !isShen(id)) continue;
                if (!TG.includes(id) && id === previousExecutionId) continue;
                executionChain.push(id);
                previousExecutionId = id;
            }
            let end = -1;
            for (let i = 0; i < chain.length; i++) {
                const have = new Set(chain.slice(0, i + 1));
                if (need.every(t => have.has(t))) { end = i; break; }
            }
            if (end < 0 && need.length) return { ok: false, reason: `三紫：链上盖不住 ${need.map(nameOf).join('、')}` };
            // 链上缺目标按“链先后”登记，锚点从原始紫序后往前分配。
            const uniqueChainNeed = [];
            const seenChainNeed = new Set();
            const chainNeedStart = 1;   // C#1 固定，只能从 C#2 开始分配原始锚点
            for (let i = chainNeedStart; i < executionChain.length; i++) {
                const id = Number(executionChain[i]);
                if (!TG.includes(id) || !need.includes(id) || seenChainNeed.has(id)) continue;
                seenChainNeed.add(id);
                uniqueChainNeed.push({ idx: i, id });
            }
            const seedCarrierNo = Number(seedOpt && seedOpt.anchorNo) || (() => {
                const carrierId = Number(seedOpt && seedOpt.carrier) || 0;
                if (!carrierId) return 0;
                const hit = seq.find(p => Number(p.id) === carrierId);
                return hit ? Number(hit.no) || 0 : 0;
            })();
            const anchorCands = [];
            // 目标仍是倒插到最晚的合法载体；链只补原始脉序没有提供的目标。
            for (let i = seq.length - 1; i >= 0; i--) {
                const p = seq[i];
                if (!isSequenceAnchorEligible(p, false)
                    || p.shenmai || p.id === 251 || TG.includes(Number(p.id))) continue;
                if (seedCarrierNo > 0
                    && Number(p.id) === Number(seedOpt && seedOpt.carrier)
                    && Number(p.no) === seedCarrierNo) continue;
                anchorCands.push({
                    id: p.id,
                    no: Number(p.no) || 0,
                    ordinal: occurrenceOrdinalByNo.get(Number(p.no) || 0) || 0,
                    isPity: !!p.fromPity,
                    pityOrdinal: pityOrdinalByNo.get(Number(p.no) || 0) || 0,
                    conflictId: Number(p.conflictId) || 0,
                    conflictWash: Number(p.conflictWash) || 0,
                    wash: Number(p.wash) || 0,
                });
            }
            const insertMapNoTail = uniqueChainNeed.map((item, k) => {
                const anc = anchorCands[uniqueChainNeed.length - 1 - k] || null;
                return {
                    target: item.id,
                    idx: item.idx,
                    anchor: anc ? anc.id : 0,
                    anchorPityId: anc && anc.isPity ? anc.id : 0,
                    anchorIsPity: !!(anc && anc.isPity),
                    anchorPityOrdinal: anc ? Number(anc.pityOrdinal) || 0 : 0,
                    anchorNo: anc ? anc.no : 0,
                    anchorOrdinal: anc ? anc.ordinal : 0,
                    anchorConflictId: anc ? Number(anc.conflictId) || 0 : 0,
                    anchorConflictWash: anc ? Number(anc.conflictWash) || 0 : 0,
                    anchorWash: anc ? anc.wash : 0,
                };
            });
            if (uniqueChainNeed.length && insertMapNoTail.some(item => !(Number(item.anchor) > 0))) {
                return { ok: false, reason: '三紫不收尾：倒插锚点不足' };
            }
            // 未倒插的目标仍要在各自天然出现位置激活；倒插目标只在指定锚点生效。
            const targetActivationNo = {};
            const targetActivationOrdinal = {};
            const insertedTargets = new Set(insertMapNoTail.map(item => Number(item.target)));
            for (const id of TG) {
                if (id === seedFirst || initialField.includes(id) || insertedTargets.has(id)) continue;
                if (!naturalFixedSet.has(id) || !naturalFull.includes(id)) continue;
                const natural = seq.find(p => Number(p.id) === id && !p.fromPity);
                if (!natural) continue;
                targetActivationNo[id] = Number(natural.no) || 0;
                targetActivationOrdinal[id] = occurrenceOrdinalByNo.get(Number(natural.no) || 0) || 0;
            }
            const planAnchorNoTail = insertMapNoTail.length ? Number(insertMapNoTail[0].anchor) || 0 : 0;
            return {
                ok: true, tail: null, tailKind: 'none', end: Math.max(0, end),
                chainTargets, tailTarget: 0, planAnchor: planAnchorNoTail,
                insertMap: insertMapNoTail,
                executionChain,
                executionChainFull: chain.slice(0, Math.max(0, end) + 1).map(Number),
                endFull: Math.max(0, end),
                fullInsertMap: insertMapNoTail,
                fullPlanAnchor: planAnchorNoTail,
                releaseInsertMap: insertMapNoTail,
                releasePlanAnchor: planAnchorNoTail,
                releaseTargetActivationNo: Object.assign({}, targetActivationNo),
                releaseTargetActivationOrdinal: Object.assign({}, targetActivationOrdinal),
                strictTargetOccurrences: insertMapNoTail.length > 0
                    || Object.keys(targetActivationOrdinal).length > 0,
                targetActivationNo,
                targetActivationOrdinal,
            };
        }

        // ③ 收尾候选：位置 ≥ K − 初始目标数；身份 ∈ {目标, 非目标神脉, 保底紫位}；可显式指定（收尾可往后推）
        const initCnt = initialTargetCount(ctx.raw, TG);
        const anchorNo = Number(seedOpt && seedOpt.anchorNo) || 0;
        const tailCands = tailCandidates(seq, TG, initCnt, anchorNo);
        if (!tailCands.length) {
            return {
                ok: false,
                reason: anchorNo > 0
                    ? `置换锚点 #${anchorNo} 之后不足 3 个紫事件，不能形成可用收尾窗口`
                    : `没有位置 ≥${Math.max(0, K - initCnt)} 的收尾候选`,
            };
        }
        const tail = tailOverride || tailCands[0];
        const requestedStartNo = Number(seedOpt && seedOpt.startAnchorNo) || 0;
        const initialIds = (ctx.raw.talents || [])
            .map(t => Number(t && t.id != null ? t.id : t))
            .filter(id => id > 0);
        if (!infiniteStartFeasible(seq, TG, Number(tail.no) || 0,
            requestedStartNo, initialIds)) {
            return {
                ok: false,
                reason: `无限置换起点 #${requestedStartNo} 太晚：起点前目标数与收尾前可用锚点数不足`,
            };
        }
        // ★ 只用到收尾位为止的脉序：收尾之后的紫路线根本走不到，不能算进覆盖/盘点
        const seqUp = seq.slice(0, seq.indexOf(tail) + 1);

        const chainTargets = [];
        for (let i = 0; i < chain.length; i++) if (TG.includes(chain[i])) chainTargets.push({ idx: i, id: chain[i] });
        const rawIds = new Set(seqUp.map(p => p.id));
        // ★ 倒插：自然目标出现在「定种子（裸洗/空洗到保底紫）之前」→ 定种子段会把它洗过去 → 从链上拿
        // 定种子发生在哪个累计洗数之后：自然目标必须晚于这个位置，
        // 不能拿 startWash=0 把定种子前的早期副本误当成可用目标。
        const fixWash = Number(seedOpt && (seedOpt.washes != null
            ? seedOpt.washes : seedOpt.startWash)) || 0;
        const naturalTargets = TG.filter(id => {
            // 保底位只记录位置，不把静态显示的名字当固定目标。
            // 保底位对应的动态目标由链位映射，而不是 naturalTargets。
            return seqUp.some(x => x.id === id && !x.fromPity
                && (fixWash <= 0 || Number(x.wash) >= fixWash));
        });
        // 场上脉使用独立的 F#/「场上#n」编号，不能与置换链 C#n 混为一谈。
        const initialFieldEntries = (ctx.raw.talents || []).map((t, index) => ({
            id: Number(t && t.id != null ? t.id : t),
            fieldNo: index + 1,
            locked: !!(t && typeof t === 'object' && t.locked),
        })).filter(item => item.id > 0);
        const initFieldIds = initialFieldEntries.map(item => item.id);

        let end = -1, tailKind = '', planAnchor = 0, insertMap = [];
        let fullInsertMapVariants = [];
        let chainExtension = {
            currentChainValid: false,
            anchorCapacitySufficient: false,
            lengtheningAllowed: false,
            attempted: false,
            accepted: 0,
            rejected: 0,
            reason: 'not-evaluated',
        };
        // 保底紫本身既不是目标、也不是神脉时，不能作为收尾候选：
        // 持续锁到保底位太耗丹，作为收尾已经淘汰。
        if (tail.fromPity && !TG.includes(tail.id) && !tail.shenmai) {
            return { ok: false, reason: '保底紫收尾已移除（太耗丹）' };
        }
        if (TG.includes(tail.id)) {
            tailKind = 'target';
            // ★ 无限置换（exchange）走「全解锁 + 置换重拿」：初始场上的、天然脉序里的目标都当链必须提供（重新置换拿）
            const unlockAll = !!(seedOpt && seedOpt.kind === 'exchange');
            // 调用方可以选择固定保留一条或多条初始目标；这些不是“解锁后重捕”的对象，
            // 倒插链不能再次给它们分配锚点，否则会重复占位并漏掉真正缺失的目标。
            const pinned = new Set((seedOpt && seedOpt.pinnedTargetIds || []).map(Number));
            // 未显式指定时，从两个候选来源自动判断：
            //   ① 置换链里是否再次包含它；
            //   ② 收尾前的原始脉序里是否还能再次天然拿到它。
            // 两条都没有 → 必须一直保留；至少一条有 → 解锁，靠链或倒插重捕。
            if (unlockAll) {
                const repinCandidates = initFieldIds.filter(id => TG.includes(Number(id)));
                for (const rawId of repinCandidates) {
                    const id = Number(rawId);
                    const inChain = chain.includes(id);
                    const inNatural = seqUp.some(p => Number(p.id) === id
                        && (!p.fromPity || Number(p.wash) >= fixWash));
                    // 场上目标只是一个占位来源：后面还能从链或原始脉序拿回时，
                    // 按“靠后锚点优先”解锁重捕；两条后路都没有才保留。
                    if (!inChain && !inNatural) pinned.add(id);
                }
            }
            if (seedOpt) seedOpt.pinnedTargetIds = Array.from(pinned);
            if (unlockAll && pinned.size > 1) {
                return { ok: false, reason: '无限置换最多保留 1 条场上目标（需要 3 个可洗槽）' };
            }
            const need = TG.filter(id => id !== tail.id
                && !pinned.has(id)
                // 原始脉序能天然提供的目标已经占组合序列的一条，不要求置换链再给一次。
                && !(combineNatural && naturalFixedSet.has(id) && naturalTargets.includes(id)));
            let fullEnd = -1;
            for (let i = 0; i < chain.length; i++) {
                const have = new Set(chain.slice(0, i + 1).map(Number));
                if (need.every(t => have.has(t))) { fullEnd = i; break; }
            }
            // ★ 收尾脉是固定边界，不属于截取后的置换链。
            //   目标收尾必须找到“其余目标已经覆盖”后的那一次收尾目标出现；
            //   例如链为 神力→混元→术绍→金仙→顶天 时，顶天是 C#5，
            //   实际执行链只能截到 C#4，绝不能把收尾顶天再放进 C#5。
            // ★ 目标收尾只认选定的原始 O#k。收尾目标不再需要出现在置换链中；
            // 链在前置同名的出现也只是普通紫。
            if (fullEnd < 0 && need.length) {
                return {
                    ok: false,
                    reason: `目标紫1-3在场上、原始脉序和置换链中仍未全部覆盖`,
                };
            }
            // ★ 链不能压缩。C#1..C#(收尾前) 的普通中间脉也是链游标，
            //   跳过中间脉会让保底直出、最近冲突和锚点全部错位。
            const chainCut = Math.max(0, fullEnd);
            const executionChain = chain.slice(0, chainCut + 1).map(Number);
            end = chainCut;
            // ★ 倒插锚点（三幅图口径）：
            //   链[0] 钉在「第一个起点」（保底紫位）；链上其余目标（chainNeed）从前往后，
            //   配原始脉序锚点（从前往后一一对应）。
            //   锚点排除：起点保底紫、收尾脉、神脉、一心两用、以及链上已有的紫（链会自己提供）。
            const uniqueChainNeed = [];
            const seenChainNeed = new Set();
            const chainNeedStart = Number.isFinite(Number(seedOpt && seedOpt.initialConsumed))
                ? Math.max(0, Math.min(chain.length - 1,
                    Number(seedOpt.initialConsumed)))
                : 1;   // 普通定种子路线：C#1 已由定种子动作消费
            for (let i = chainNeedStart; i <= end; i++) {
                // 中间脉（如老僧的玄阳）仍在固定置换链里连续烧出，
                // 但它不占用原始脉序上的倒插载体，只给最终目标分配锚点。
                const id = Number(executionChain[i]);
                if (TG.includes(id) && need.includes(id) && !seenChainNeed.has(id)) {
                    seenChainNeed.add(id);
                    uniqueChainNeed.push({ idx: i, id });
                }
            }
            // 锚点候选 = 原始脉序（到收尾为止）里 非目标、非神脉、非一心 的紫，从后往前排。
            const seedCarrierNo = Number(seedOpt && seedOpt.anchorNo) || (() => {
                const carrierId = Number(seedOpt && seedOpt.carrier) || 0;
                if (!carrierId) return 0;
                const hit = seqUp.find(p => Number(p.id) === carrierId);
                return hit ? Number(hit.no) || 0 : 0;
            })();
            const hasPriorTargetShen = chain.some((id, chainIndex) =>
                chainIndex > 0 && TG.includes(Number(id)) && isShen(Number(id)));
            const anchorCands = [];
            for (let i = seqUp.length - 1; i >= 0; i--) {
                const p = seqUp[i];
                // insertMap 只记录非收尾倒插锚；收尾脉作为最终锚点单独处理。
                // 非目标神脉在“前面已有目标神脉会先锁定”时可以作为无损载体；
                // 最终是否合法由 validInsertMap 根据链位顺序和锚点顺序校验。
                if (p === tail || p.id === 251) continue;
                // 已由原始脉序正式提供目标的位置不能重复当锚点；
                // 未被选为正式来源的同名事件仍可在收尾前当普通紫。
                if (TG.includes(Number(p.id))
                    && naturalFixedSet.has(Number(p.id))) continue;
                if (!isSequenceAnchorEligible(p, !!p.shenmai)) continue;
                if (seedCarrierNo > 0
                    && Number(p.id) === Number(seedOpt && seedOpt.carrier)
                    && Number(p.no) === seedCarrierNo) continue;
                anchorCands.push({
                    id: p.id,
                    no: Number(p.no) || 0,
                    ordinal: occurrenceOrdinalByNo.get(Number(p.no) || 0) || 0,
                    isPity: !!p.fromPity,
                    pityOrdinal: pityOrdinalByNo.get(Number(p.no) || 0) || 0,
                    conflictId: Number(p.conflictId) || 0,
                    conflictWash: Number(p.conflictWash) || 0,
                    wash: Number(p.wash) || 0,
                    shenmai: !!p.shenmai,
                });
            }
            // 链级快速容量检查。先把连续的相同脉或可互冲神脉合并，再按
            // 目标紫3→2、目标紫2→1、C#1→目标紫1三段计算需要多少毁脉锚点。
            const targetEntries = [];
            if (TG.includes(Number(chain[0]))) {
                targetEntries.push({ idx: 0, id: Number(chain[0]) });
            }
            for (const item of uniqueChainNeed) {
                if (Number(item.idx) === 0) continue;
                if (!targetEntries.some(x => Number(x.idx) === Number(item.idx))) {
                    targetEntries.push(item);
                }
            }
            targetEntries.sort((a, b) => Number(a.idx) - Number(b.idx));
            const segmentStats = ids => {
                let groups = 0, oneheart = 0, shen = 0;
                let prevId = 0, prevShen = false;
                for (const rawId of ids) {
                    const id = Number(rawId);
                    const isOne = id === 251;
                    const isShenmai = isShen(id);
                    const sameGroup = groups > 0
                        && (id === prevId || (isShenmai && prevShen));
                    if (!sameGroup) {
                        groups++;
                        if (isOne) oneheart++;
                        if (isShenmai) shen++;
                    }
                    prevId = id;
                    prevShen = isShenmai;
                }
                return { groups, oneheart, shen };
            };
            const betweenIdx = (left, right) =>
                chain.slice(Number(left.idx) + 1, Number(right.idx));
            let intermediateDemand = 0;
            const t1 = targetEntries[0] || null;
            const t2 = targetEntries[1] || null;
            const t3 = targetEntries.length >= 3
                ? targetEntries[targetEntries.length - 1] : null;
            let target3To2ShenDemand = 0;
            let target3To2ShenGroups = 0;
            if (t2 && t3) {
                // 目标3→目标2：压缩后的每个中间段各占一个可毁锚点；
                // 神脉段还要单独检查是否具备神脉互冲条件。
                const stats = segmentStats(betweenIdx(t2, t3));
                intermediateDemand += stats.groups;
                target3To2ShenDemand = stats.shen;
                target3To2ShenGroups = stats.shen;
            }
            if (t1 && t2) {
                const stats = segmentStats(betweenIdx(t1, t2));
                // 目标1为神脉时，神脉段可由互冲免费通过；否则需要计锚。
                intermediateDemand += 1 + stats.oneheart
                    + (isShen(Number(t1.id)) ? 0 : stats.shen);
            }
            if (t1 && Number(t1.idx) > 0) {
                const stats = segmentStats(chain.slice(1, Number(t1.idx)));
                // C#1固定锚点之后到目标紫1；神脉与一心分别各计一段。
                intermediateDemand += 1 + stats.oneheart + stats.shen;
            }
            const earlyTargetShen = !!(t1 && isShen(Number(t1.id)))
                || !!(t2 && isShen(Number(t2.id)));
            // 目标紫1或2已锁定神脉时，中间链上的神脉可通过互冲无损换掉，
            // 不再额外占用毁脉锚点。若两个目标都不是神脉，才保留该需求。
            if (earlyTargetShen) {
                intermediateDemand = Math.max(0,
                    intermediateDemand - target3To2ShenGroups);
                target3To2ShenDemand = 0;
            }
            const totalCapacity = anchorCands.reduce((sum, anchor) => {
                if (anchor.isPity) return sum + 2;
                if (anchor.shenmai) return sum + (earlyTargetShen ? 1 : 0);
                return sum + 1;
            }, 0);
            const pitySlots = anchorCands.filter(anchor => anchor.isPity).length * 2;
            const shenSlots = anchorCands.filter(anchor => anchor.shenmai).length;
            const availableShenCapacity = pitySlots + (earlyTargetShen ? shenSlots : 0);
            const targetAnchorReserve = targetEntries.filter(item =>
                Number(item.idx) > 0).length;
            const remainingCapacity = Math.max(0,
                totalCapacity - targetAnchorReserve);
            const validInsertMap = (items, allowNonTargetShenFallback = false) => {
                let previousAnchorNo = 0;
                let usedFallbackShen = 0;
                for (const item of (items || [])) {
                    const anchor = Number(item && item.anchorNo) || 0;
                    if (anchor <= 0 || anchor < previousAnchorNo) return false;
                    previousAnchorNo = anchor;
                    const seqAnchor = seqUp.find(p => Number(p.no) === anchor);
                    if (!seqAnchor || !seqAnchor.shenmai) continue;
                    // 神脉锚点的前置互冲脉优先级：
                    //   1. 已经锁定的目标神脉；
                    //   2. 仅当普通映射走不通时，才回退使用场上已有的非目标神脉。
                    const priorTargetShen = items.some(prev =>
                        Number(prev.idx) < Number(item.idx)
                        && TG.includes(Number(prev.target))
                        && isShen(Number(prev.target))
                        && Number(prev.anchorWash || 0) < Number(item.anchorWash || 0))
                        || initFieldIds.some(id => pinned.has(Number(id))
                            && TG.includes(Number(id)) && isShen(Number(id)));
                    if (priorTargetShen) {
                        item.conflictShenId = 0;
                        item.conflictShenRole = 'prior-target';
                        item.releaseConflictAfterUse = false;
                        continue;
                    }
                    const fallbackShenEntry = allowNonTargetShenFallback
                        && usedFallbackShen === 0 && initialFieldEntries.find(entry =>
                        !TG.includes(entry.id) && isShen(entry.id)
                        && entry.id !== Number(seqAnchor.id));
                    const fallbackShen = fallbackShenEntry && fallbackShenEntry.id;
                    if (fallbackShen) {
                        item.conflictShenId = Number(fallbackShen);
                        item.conflictShenFieldNo = Number(fallbackShenEntry.fieldNo);
                        item.conflictShenRole = 'non-target-fallback';
                        item.releaseConflictAfterUse = true;
                        usedFallbackShen++;
                        continue;
                    }
                    if (root.__RC_TRACE) {
                        console.log(`[RC][shen-anchor-reject] ${nameOf(item.target)}@#${anchor} ` +
                            items.map(prev => `C#${Number(prev.idx) + 1}:${nameOf(prev.target)}@#${prev.anchorNo}:${nameOf(prev.anchor)}`).join('/'));
                    }
                    return false;
                }
                return true;
            };
            const mapTargetsToAnchors = (items, candidates) => {
                const pool = candidates || anchorCands;
                const mapped = [];
                for (let k = 0; k < items.length; k++) {
                    const anc = pool[items.length - 1 - k] || null;
                    mapped.push({
                        target: items[k].id, idx: items[k].idx,
                        anchor: anc ? anc.id : 0,
                        anchorPityId: anc && anc.isPity ? anc.id : 0,
                        anchorIsPity: !!(anc && anc.isPity),
                        anchorPityOrdinal: anc ? Number(anc.pityOrdinal) || 0 : 0,
                        anchorNo: anc ? anc.no : 0,
                        anchorOrdinal: anc ? anc.ordinal : 0,
                        anchorConflictId: anc ? Number(anc.conflictId) || 0 : 0,
                        anchorConflictWash: anc ? Number(anc.conflictWash) || 0 : 0,
                        anchorWash: anc ? anc.wash : 0,
                    });
                }
                return mapped;
            };
            const mapItemsToAnchorList = (items, anchors) => items.map((item, index) => {
                const anc = anchors[index] || null;
                return {
                    target: item.id, idx: item.idx,
                    anchor: anc ? anc.id : 0,
                    anchorPityId: anc && anc.isPity ? anc.id : 0,
                    anchorIsPity: !!(anc && anc.isPity),
                    anchorPityOrdinal: anc ? Number(anc.pityOrdinal) || 0 : 0,
                    anchorNo: anc ? anc.no : 0,
                    anchorOrdinal: anc ? anc.ordinal : 0,
                    anchorConflictId: anc ? Number(anc.conflictId) || 0 : 0,
                    anchorConflictWash: anc ? Number(anc.conflictWash) || 0 : 0,
                    anchorWash: anc ? anc.wash : 0,
                };
            });
            // 同一锚点可以连续承接多个链位。这里生成“非降序锚点序列”，
            // 允许下标重复；例如 [#3, #6, #6, #6]。
            // 短链只在前 5 个可毁锚点上枚举，避免锚点全排列爆炸；
            // 长链仍保留上面的一锚点一链位组合。
            const anchorGroupCombinations = (items, limit, candidates) => {
                const anchorsAsc = (candidates || anchorCands).slice().reverse();
                const pool = anchorsAsc.slice(0, Math.min(8, anchorsAsc.length));
                const all = [];
                if (!items.length || !pool.length) return all;
                const picked = [];
                const visit = start => {
                    if (picked.length === items.length) {
                        all.push(picked.slice());
                        return;
                    }
                    for (let i = start; i < pool.length; i++) {
                        picked.push(pool[i]);
                        visit(i);               // i 不 +1：允许同锚连续承接
                        picked.pop();
                    }
                };
                visit(0);
                all.sort((a, b) => {
                    const groupCount = seq => seq.reduce((n, value, index) =>
                        n + (index === 0 || value !== seq[index - 1] ? 1 : 0), 0);
                    const ai = pool.indexOf(a[0]), bi = pool.indexOf(b[0]);
                    const al = pool.indexOf(a[a.length - 1]);
                    const bl = pool.indexOf(b[b.length - 1]);
                    return (groupCount(a) - groupCount(b))
                        || (ai - bi)
                        || (bl - al);
                });
                const key = seq => seq.map((anchor, index) =>
                    `${index}:${anchor.no}:${anchor.ordinal}`).join('|');
                const prioritized = [];
                const seenPriority = new Set();
                const addPriority = seq => {
                    const value = key(seq);
                    if (seenPriority.has(value)) return;
                    seenPriority.add(value);
                    prioritized.push(seq);
                };
                // 保留目标形成硬边界：目标之前的链位只能用前面的锚点，
                // 目标之后的链位只能用后面的锚点。前后段必须拆开执行。
                for (const targetId of naturalFixedSet) {
                    const chainIndex = chain.indexOf(Number(targetId));
                    if (chainIndex <= 0) continue;
                    const rawTarget = seqUp.find(p => Number(p.id) === Number(targetId)
                        && !p.fromPity && Number(p.wash) >= fixWash);
                    if (!rawTarget) continue;
                    const before = pool.filter(anchor => Number(anchor.wash) < Number(rawTarget.wash));
                    const after = pool.filter(anchor => Number(anchor.wash) > Number(rawTarget.wash));
                    const beforeItems = items.filter(item => Number(item.idx) < chainIndex);
                    const afterItems = items.filter(item => Number(item.idx) > chainIndex);
                    for (const early of before) {
                        for (const late of after) {
                            addPriority(items.map(item =>
                                Number(item.idx) < chainIndex ? early : late));
                        }
                    }
                    // 完整拆链：前段首链位、前段主体、后段主体、最后一个
                    // 目标各自使用不同锚点。这样可表达
                    // 3# → 6#... → 8#... → 9# 这种全局倒插结构。
                    for (let e1 = 0; e1 < before.length; e1++) {
                        for (let e2 = e1 + 1; e2 < before.length; e2++) {
                            for (let l1 = 0; l1 < after.length; l1++) {
                                for (let l2 = l1 + 1; l2 < after.length; l2++) {
                                    if (beforeItems.length < 2 || afterItems.length < 2) continue;
                                    const seq = [];
                                    for (let k = 0; k < items.length; k++) {
                                        const idx = Number(items[k].idx);
                                        if (idx < chainIndex) {
                                            seq.push(k === 0 ? before[e1] : before[e2]);
                                        } else if (k === items.length - 1) {
                                            seq.push(after[l2]);
                                        } else {
                                            seq.push(after[l1]);
                                        }
                                    }
                                    addPriority(seq);
                                }
                            }
                        }
                    }
                }
                // 常见尾拆结构：首位单独承接、中间链位集中连续置换、
                // 倒数第二个链位放到后锚、链末目标放到最后锚。
                if (items.length >= 4) {
                    for (let a = 0; a < pool.length - 3; a++) {
                        for (let b = a + 1; b < pool.length - 2; b++) {
                            for (let c = b + 1; c < pool.length - 1; c++) {
                                for (let d = c + 1; d < pool.length; d++) {
                                    const seq = [];
                                    for (let k = 0; k < items.length; k++) {
                                        if (k === 0) seq.push(pool[a]);
                                        else if (k === items.length - 1) seq.push(pool[d]);
                                        else if (k === items.length - 2) seq.push(pool[c]);
                                        else seq.push(pool[b]);
                                    }
                                    addPriority(seq);
                                }
                            }
                        }
                    }
                }
                // 保底位是动态目标位置。严格倒插时要对链里的每个目标位
                // 尝试落到保底锚点：目标前链位用更早锚点承接，目标后的
                // 链位继续从该保底锚点向后推进，不能只允许末尾目标落保底。
                for (let pityIndex = 1; pityIndex < pool.length; pityIndex++) {
                    if (!pool[pityIndex].isPity) continue;
                    for (let earlyIndex = 0; earlyIndex < pityIndex; earlyIndex++) {
                        for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
                            if (!TG.includes(Number(items[itemIndex].id))) continue;
                            const seq = [];
                            for (let k = 0; k < items.length; k++) {
                                seq.push(k < itemIndex ? pool[earlyIndex] : pool[pityIndex]);
                            }
                            addPriority(seq);
                            // 常见倒插结构：首链位单独占前锚，随后若干净段
                            // 集中到第二个锚点，最后目标落保底位。
                            for (let secondIndex = earlyIndex + 1;
                                secondIndex < pityIndex; secondIndex++) {
                                const twoStage = [];
                                for (let k = 0; k < items.length; k++) {
                                    twoStage.push(k === 0 ? pool[earlyIndex]
                                        : k < itemIndex ? pool[secondIndex]
                                            : pool[pityIndex]);
                                }
                                addPriority(twoStage);
                            }
                        }
                    }
                }
                for (const seq of all) {
                    if (seenPriority.has(key(seq))) continue;
                    seenPriority.add(key(seq));
                    prioritized.push(seq);
                }
                const selected = prioritized.slice(0, limit);
                if (pool.length >= items.length) {
                    const oneToOneVariants = [];
                    for (let start = 0; start + items.length <= pool.length; start++) {
                        oneToOneVariants.push(pool.slice(start, start + items.length));
                    }
                    // 一对一覆盖所有可用起点，仍然属于“每段长度为 1”的特殊分段。
                    const kept = oneToOneVariants.filter(seq => !selected.some(x => key(x) === key(seq)));
                    selected.unshift(...kept);
                }
                return selected;
            };
            // 完整链段仍保持连续。非目标链位只保留一套靠前的基础落点，
            // 供执行器优先置换/毁脉；后续不参与锚点方案枚举。
            const fullNeed = [];
            for (let i = chainNeedStart; i <= fullEnd; i++) {
                const id = Number(chain[i]);
                // 已选择由原始脉序保留的目标不占链锚点；否则会多用一条锚点，
                // 把本来能分配给普通毁脉节点的位置挤掉。
                if (combineNatural && naturalFixedSet.has(id)
                    && naturalTargets.includes(id)) continue;
                fullNeed.push({ idx: i, id });
            }
            // 倒插神脉锚点的优先级：
            //   1. 前置已有目标神脉 → 无损互冲，直接使用；
            //   2. 否则先尝试完全跳过神脉锚点；
            //   3. 跳过以后锚点不足，才允许使用前置非目标神脉补救。
            const ordinaryAnchorCands = anchorCands.filter(anchor => !anchor.shenmai);
            const fixedPrefixMapFor = (candidates, allowNonTargetShenFallback) => {
                if (Number(seedOpt && seedOpt.initialConsumed) !== 0
                    || !candidates.length) return null;
                const firstTargetIndex = fullNeed.findIndex(item =>
                    TG.includes(Number(item.id)));
                if (firstTargetIndex <= 0) return null;
                const anchorsAsc = candidates.slice().reverse();
                const suffixCount = fullNeed.length - firstTargetIndex;
                if (anchorsAsc.length < suffixCount + 1) return null;
                const anchors = fullNeed.map((item, index) =>
                    index < firstTargetIndex
                        ? anchorsAsc[0]
                        : anchorsAsc[1 + index - firstTargetIndex]);
                const candidateMap = mapItemsToAnchorList(fullNeed, anchors);
                return candidateMap.every(item => Number(item.anchor) > 0)
                    && validInsertMap(candidateMap, allowNonTargetShenFallback)
                    ? candidateMap : null;
            };
            let fullInsertMap = mapTargetsToAnchors(fullNeed);
            let fullMapValid = fullNeed.length <= anchorCands.length
                && fullInsertMap.every(item => Number(item.anchor) > 0)
                && validInsertMap(fullInsertMap, false);
            if (!fullMapValid) {
                const prefixed = fixedPrefixMapFor(anchorCands, false);
                if (prefixed) {
                    fullInsertMap = prefixed;
                    fullMapValid = true;
                }
            }
            if (!fullMapValid) {
                const ordinaryMap = mapTargetsToAnchors(fullNeed, ordinaryAnchorCands);
                const ordinaryMapValid = fullNeed.length <= ordinaryAnchorCands.length
                    && ordinaryMap.every(item => Number(item.anchor) > 0)
                    && validInsertMap(ordinaryMap, false);
                if (ordinaryMapValid) {
                    fullInsertMap = ordinaryMap;
                    fullMapValid = true;
                }
            }
            if (!fullMapValid) {
                const prefixedOrdinary = fixedPrefixMapFor(ordinaryAnchorCands, false);
                if (prefixedOrdinary) {
                    fullInsertMap = prefixedOrdinary;
                    fullMapValid = true;
                }
            }
            if (!fullMapValid) {
                const prefixedFallback = fixedPrefixMapFor(anchorCands, true);
                if (prefixedFallback) {
                    fullInsertMap = prefixedFallback;
                    fullMapValid = true;
                }
            }
            if (!fullInsertMap.every(item => Number(item.anchor) > 0)
                || !fullMapValid) {
                return {
                    ok: false,
                    failureCode: 'anchor-capacity-insufficient',
                    lengtheningAllowed: false,
                    chainExtension: Object.assign({}, chainExtension, {
                        currentChainValid: false,
                        anchorCapacitySufficient: false,
                        lengtheningAllowed: false,
                        reason: 'short-chain-map-invalid',
                    }),
                    reason: '连续置换链存在，但收尾前锚点映射不成立',
                };
            }
            chainExtension = {
                currentChainValid: true,
                anchorCapacitySufficient: true,
                lengtheningAllowed: true,
                attempted: false,
                accepted: 0,
                rejected: 0,
                reason: allowInsertMapVariants ? 'ready' : 'deferred-to-top-routes',
            };
            // 第一阶段所有种子只保留靠后倒插主表。只有整轮搜索结束后
            // 选中的前 3 条路线，才会以 allowInsertMapVariants=true 回到
            // 这里展开有限套毁脉锚点分配。加长/重分配只接受能让目标紫
            // 更靠后的映射；没有收益的变体不得进入执行阶段。
            if (allowInsertMapVariants) {
                const baseBySlot = new Map(fullNeed.map((item, index) =>
                    [`${Number(item.idx)}:${Number(item.id)}`, fullInsertMap[index]]));
                // 非目标链位只使用基础表中靠前的一套落点，不参与枚举。
                const variantNeed = fullNeed.filter(item => !TG.includes(Number(item.id)));
                const variantLimit = variantNeed.length <= 4 ? 6 : 12;
                const groupedMapVariants = variantNeed.length <= 8
                    ? anchorGroupCombinations(variantNeed, variantLimit)
                        .map(anchors => {
                            const variantMap = mapItemsToAnchorList(variantNeed, anchors);
                            const variantBySlot = new Map(variantMap.map(item =>
                                [`${Number(item.idx)}:${Number(item.target)}`, item]));
                            return fullNeed.map(item => variantBySlot.get(
                                `${Number(item.idx)}:${Number(item.id)}`)
                                || baseBySlot.get(`${Number(item.idx)}:${Number(item.id)}`))
                                .filter(Boolean);
                        })
                        .filter(items => items.length
                            && items.every(item => Number(item.anchor) > 0)
                            && validInsertMap(items))
                    : [];
                const seenVariant = new Set();
                fullInsertMapVariants = groupedMapVariants.filter(items => {
                    const key = items.map(item =>
                        `${item.idx}:${item.anchorNo}:${item.anchorOrdinal}`).join('|');
                    if (seenVariant.has(key)) return false;
                    seenVariant.add(key);
                    return true;
                });
                const baseKey = fullInsertMap.map(item =>
                    `${item.idx}:${item.anchorNo}:${item.anchorOrdinal}`).join('|');
                const baseAt = fullInsertMapVariants.findIndex(items => items.map(item =>
                    `${item.idx}:${item.anchorNo}:${item.anchorOrdinal}`).join('|') === baseKey);
                if (baseAt >= 0) fullInsertMapVariants.splice(baseAt, 1);
                fullInsertMapVariants.unshift(fullInsertMap);
                chainExtension = {
                    currentChainValid: true,
                    anchorCapacitySufficient: true,
                    lengtheningAllowed: false,
                    attempted: groupedMapVariants.length > 0,
                    accepted: Math.max(0, fullInsertMapVariants.length - 1),
                    rejected: Math.max(0, groupedMapVariants.length - fullInsertMapVariants.length),
                    reason: fullInsertMapVariants.length > 1
                        ? 'top3-nontarget-anchor-combinations'
                        : 'no-nontarget-anchor-combinations',
                };
            } else {
                fullInsertMapVariants = [fullInsertMap];
                chainExtension = {
                    currentChainValid: true,
                    anchorCapacitySufficient: true,
                    lengtheningAllowed: false,
                    attempted: false,
                    accepted: 0,
                    rejected: 0,
                    reason: 'single-planned-chain',
                };
            }
            if (root.__RC_TRACE) {
                console.log(`[RC][anchor-groups] anchors=${anchorCands.length} ` +
                    `ids=${anchorCands.map(x => `#${x.no}:${nameOf(x.id)}${x.shenmai ? ':神' : ''}`).join('/')} ` +
                    `priorShen=${hasPriorTargetShen} ` +
                    `need=${fullNeed.length} grouped=${allowInsertMapVariants
                        ? Math.max(0, fullInsertMapVariants.length - 1) : 0} ` +
                    `total=${fullInsertMapVariants.length} ` +
                    `natural=${Array.from(naturalFixedSet).map(nameOf).join('/') || '无'} ` +
                    `naturalTargets=${naturalTargets.map(nameOf).join('/') || '无'} ` +
                    `fixWash=${fixWash}`);
                console.log(`[RC][extension] valid=${chainExtension.currentChainValid} ` +
                    `capacity=${chainExtension.anchorCapacitySufficient} ` +
                    `accepted=${chainExtension.accepted} rejected=${chainExtension.rejected} ` +
                    `reason=${chainExtension.reason}`);
            }
            // 释放首批目标时也只能使用同一条连续链，不能把同名副本重新压回链位。
            let releaseInsertMap = fullInsertMap;
            // planAnchor = 连续链第一个要插入的锚点
            planAnchor = fullInsertMap.length ? (fullInsertMap[0].anchor || 0) : 0;
            // 执行链与倒插表都使用收尾前的同一连续前缀。
            insertMap = fullInsertMap;
            var plannedExecutionChain = executionChain;
            var plannedReleaseInsertMap = releaseInsertMap;
            var plannedFullEnd = fullEnd;
            var plannedFullInsertMap = fullInsertMap;
        } else if (tail.shenmai) {
            tailKind = 'shenmai';
            // ④.1 终点 = 最早的目标且非神脉，链∪原始(至收尾位) ⊇ 四目标
            for (let i = 0; i < chain.length; i++) {
                if (!TG.includes(chain[i]) || isShen(chain[i])) continue;
                const have = new Set(chain.slice(0, i + 1));
                seqUp.forEach(p => have.add(p.id));
                if (TG.every(t => have.has(t))) { end = i; break; }
            }
            if (end < 0) return { ok: false, reason: '神脉收尾：找不到非神脉目标终点' };
            // ④.3 尾段（倒数第二链上目标 → 终点）只允许神脉
            const before = chainTargets.filter(t => t.idx < end);
            if (!before.length) return { ok: false, reason: '终点之前没有链上目标' };
            const lastBefore = before[before.length - 1].idx;
            for (let i = lastBefore + 1; i < end; i++) {
                if (!isShen(chain[i])) return { ok: false, reason: `尾段第 ${i} 格 ${nameOf(chain[i])} 不是神脉` };
            }
            // ④.4 第 2→3 之间：毁脉数 = 间隔数（目标至多一条神脉 → 互冲不成立）
            const midIdx = before.map(t => t.idx);
            const gap23 = midIdx.length >= 2 ? midIdx[midIdx.length - 1] - midIdx[midIdx.length - 2] - 1 : 0;
            // ④.5 第 1→2 之间：障碍 = 神脉 + 一心
            const gap12 = before.length >= 2 ? before[1].idx - before[0].idx - 1 : 0;
            const obstacles12 = before.length >= 2
                ? chain.slice(before[0].idx + 1, before[1].idx).filter(id => isShen(id) || id === 251).length
                : 0;
            // 第 1 目标头部：链头不是第 1 目标 → 头部毁脉 = 障碍 + 1
            const headIsTarget = before.length ? chain[0] === before[0].id : false;
            const headDestroy = headIsTarget ? 0 : obstacles12 + 1;
            // ⑤ 毁脉点盘点：可用的（普通紫 + 冲突在间隙内；排除载体/目标/收尾）
            let avail = 0;
            for (let i = 0; i < seqUp.length; i++) {
                const p = seqUp[i];
                if (p.shenmai || p.id === 251 || TG.includes(p.id)) continue;
                if (seedOpt && Number(seedOpt.carrier) === p.id) continue;
                const ty = talentType(p.id);
                if (ty == null) continue;
                const types = new Set();
                try {
                    const e2 = engineOf(ctx.raw, ctx.zizhi);
                    let ps = e2.initialState(Object.assign({}, ctx.raw, { zizhi: ctx.zizhi }));
                    for (let w = (i > 0 ? seqUp[i - 1].wash : 0) + 1; w <= p.wash; w++) {
                        const r = e2.wash(ps, []);
                        ps = r.state;
                        for (const ev of (r.generatedEvents || [])) {
                            const id = Number(ev.id);
                            if (e2.quality(id) < 4 && id !== 251) types.add(talentType(id));
                        }
                    }
                } catch (err) { /* 跳过 */ }
                if (types.has(ty)) avail++;
            }
            const needDestroy = gap23 + headDestroy;
            if (avail < needDestroy) return { ok: false, reason: `毁脉点不足：需 ${needDestroy}，可用 ${avail}` };
            return {
                ok: true, tail, tailKind, end, chainTargets, gap23, headDestroy, obstacles12,
                tailTarget: chain[end], needDestroy, avail,
            };
        } else if (tail.fromPity) {
            tailKind = 'pity';
            // ★ 截链取最短：终点 = 最早使「链必须提供的目标」全部出现的链位。
            //   链必须提供的目标 = 扫描首现早于定种子时刻（之后天然重捕不到）；
            //   首现晚于定种子时刻的目标由 born 流重捕，不算链提供。
            const fixWash = seedOpt ? (Number(seedOpt.washes) || 0) : 0;
            const need = TG.filter(id => {
                let w = 0;
                for (const pp of seq) { if (pp.id === id) { w = Number(pp.wash) || 0; break; } }
                return w > 0 && w < fixWash;
            });
            for (let i = 0; i < chain.length; i++) {
                const have = new Set(chain.slice(0, i + 1));
                if (need.every(t => have.has(t))) { end = i; break; }
            }
            if (end < 0) return { ok: false, reason: `保底紫位收尾：链上盖不住 ${need.map(nameOf).join('、')}` };
            // ★ 计划锚点：倒插离收尾最近 —— 最后一个天然目标位之后、第一条可用位置
            //   （薛龙城：顶天@1169 之后的 拳脚无双@1233；链位毁掉，目标插在这）
            {
                let tailT = TG[0], bestW = -1;
                for (const t of TG) {
                    let w = 0;
                    for (const pp of seq) { if (pp.id === t) { w = Number(pp.wash) || 0; break; } }
                    if (w > bestW) { bestW = w; tailT = t; }
                }
                const naturals = TG.filter(id => id !== tailT && !need.includes(id));
                let lastNatW = 0;
                for (const t of naturals) {
                    for (const pp of seq) {
                        if (pp.id === t) { lastNatW = Math.max(lastNatW, Number(pp.wash) || 0); break; }
                    }
                }
                for (let i = 0; i < seq.length; i++) {
                    const p = seq[i];
                    if (Number(p.wash) <= lastNatW) continue;
                    if (p.shenmai || p.id === 251 || TG.includes(p.id)) continue;
                    if (seedOpt && Number(seedOpt.carrier) === p.id) continue;
                    const ty = talentType(p.id);
                    if (ty == null) continue;
                    const types = new Set();
                    try {
                        const e2 = engineOf(ctx.raw, ctx.zizhi);
                        let ps = e2.initialState(Object.assign({}, ctx.raw, { zizhi: ctx.zizhi }));
                        for (let w = (i > 0 ? seq[i - 1].wash : 0) + 1; w <= p.wash; w++) {
                            const r = e2.wash(ps, []);
                            ps = r.state;
                            for (const ev of (r.generatedEvents || [])) {
                                const id = Number(ev.id);
                                if (e2.quality(id) < 4 && id !== 251) types.add(talentType(id));
                            }
                        }
                    } catch (err) { /* 跳过 */ }
                    if (types.has(ty)) { planAnchor = p.id; break; }
                }
            }
        } else {
            return { ok: false, reason: '收尾身份不合规' };
        }
        // 收尾目标 = 最后拿到的那个：
        //   目标收尾 → 天然收尾位；保底紫位收尾 → 原始脉序（全量）里首次出现最晚的目标；神脉收尾 → 链终点
        let tailTarget = tail.id;
        if (tailKind === 'pity') {
            let bestW = -1;
            for (const t of TG) {
                let w = 0;
                for (const pp of seq) {
                    if (pp.id === t) { w = Number(pp.wash) || 0; break; }   // 首次出现
                }
                if (w > bestW) { bestW = w; tailTarget = t; }
            }
        } else if (tailKind === 'shenmai') {
            tailTarget = chain[end];
        }
        // 倒插锚点的编号是“被换掉的载体出现位置”，不是目标紫自然出现的编号。
        // 因此不能拿它去做 decideLock；倒插由执行器在锚点直接换成目标并持有。
        // 这里只登记真正的天然激活位置，目前就是目标收尾脉。
        const targetActivationNo = {};
        const targetActivationOrdinal = {};
        if (TG.includes(Number(tail.id))) {
            targetActivationNo[Number(tail.id)] = Number(tail.no) || 0;
            targetActivationOrdinal[Number(tail.id)]
                = occurrenceOrdinalByNo.get(Number(tail.no) || 0) || 0;
        }
        // 组合脉序：原始脉序天然提供、但不作为收尾的目标也占一个目标位。
        // 它们不再进入置换链需求，只登记天然激活位置。
        const insertedTargetIds = new Set((insertMap || []).map(item => Number(item.target)));
        for (const id of (combineNatural
            ? naturalTargets.filter(targetId => naturalFixedSet.has(Number(targetId)))
            : [])) {
            const targetId = Number(id);
            if (targetId === Number(tail.id)
                || insertedTargetIds.has(targetId)
                || initFieldIds.includes(targetId)
                || targetId === Number(seedOpt && seedOpt.first)) continue;
            const natural = seqUp.find(p => Number(p.id) === targetId && !p.fromPity
                && Number(p.wash) >= fixWash)
                || seqUp.find(p => Number(p.id) === targetId && !p.fromPity);
            if (!natural) continue;
            targetActivationNo[targetId] = Number(natural.no) || 0;
            targetActivationOrdinal[targetId] = seqUp.filter(p =>
                Number(p.id) === targetId
                && Number(p.no) <= Number(natural.no)
                && Number(p.wash) >= fixWash).length;
        }
        const executionChain = typeof plannedExecutionChain !== 'undefined' ? plannedExecutionChain : chain;
        const releaseTargetActivationNo = Object.assign({}, targetActivationNo);
        const releaseTargetActivationOrdinal = Object.assign({}, targetActivationOrdinal);
        if (TG.includes(Number(tail.id))) {
            releaseTargetActivationNo[Number(tail.id)] = Number(tail.no) || 0;
        }
        return {
            ok: true, tail, tailKind, end, chainTargets, tailTarget, planAnchor, insertMap,
            executionChain,
            executionChainFull: typeof plannedFullEnd !== 'undefined' && plannedFullEnd >= 0
                ? chain.slice(0, plannedFullEnd + 1).map(Number) : chain.map(Number),
            endFull: typeof plannedFullEnd !== 'undefined' ? plannedFullEnd : -1,
            fullInsertMap: typeof plannedFullInsertMap !== 'undefined' ? plannedFullInsertMap : [],
            fullInsertMapVariants: typeof fullInsertMapVariants !== 'undefined'
                ? fullInsertMapVariants : [],
            chainExtension,
            fullPlanAnchor: (typeof plannedFullInsertMap !== 'undefined' && plannedFullInsertMap.length)
                ? (plannedFullInsertMap[0].anchor || 0) : 0,
            releaseInsertMap: typeof plannedReleaseInsertMap !== 'undefined' ? plannedReleaseInsertMap : [],
            releasePlanAnchor: (typeof plannedReleaseInsertMap !== 'undefined' && plannedReleaseInsertMap.length)
                ? (plannedReleaseInsertMap[0].anchor || 0) : planAnchor,
            releaseTargetActivationNo,
            releaseTargetActivationOrdinal,
            tailNo: Number(tail.no) || 0,
            strictTargetOccurrences: Object.keys(targetActivationOrdinal).length > 0,
            naturalFixedTargets: combineNatural
                ? naturalTargets.filter(id => naturalFixedSet.has(Number(id)))
                : [],
            targetActivationNo,
            targetActivationOrdinal,
        };
    }

    // ────────────────────── ⑥ 执行（规则驱动：连续置换→毁脉→空洗→开槽重掷） ──────────────────────
    /**
     * 决策规则（与使用者逐条对齐）：
     *  · 链推进优先置换：一个锚点（冲突锁+载体）连续置换，不消耗毁脉位；置换不动才毁脉/空洗；
     *  · 连续置换：换出的结果当下一个载体，其类型的冲突脉**提前预载**（紫2的冲突在换紫1前锁好）；
     *  · 冲突解锁双条件：① 类型后续（lead 内）无要换的紫；② 不是后续置换紫锚点最近的冲突脉；
     *  · 收尾目标提前出现 → 当普通紫（烧/当载体），收尾段之前不锁，靠后面天然/链尾重捕；
     *  · 其余目标落地即锁；
     *  · 锁到目标且未齐 → 开 4 槽重掷（3→4 槽）。
     */
    function execute(raw, targets, seedOpt, opts) {
        const p = opts || {};
        const TG = (targets || []).map(Number);
        const K = TG.length;
        const seedAnchorId = Number(seedOpt && seedOpt.first)
            || Number(seedOpt && seedOpt.chain && seedOpt.chain[0]) || 0;
        if (!seedOpt || !Array.isArray(seedOpt.chain) || !seedOpt.chain.length
            || Number(seedOpt.chain[0]) !== seedAnchorId) {
            return {
                ok: false, note: '种子链 C#1 必须固定在定种子锚点，不能改派到其他原始脉位',
                cost: 0, washes: 0, exchanges: 0, burns: 0,
                steps: [], field: [], held: [], missing: TG.slice(),
            };
        }
        const pinnedTargets = Array.from(new Set((p.pinTargetIds
            || (seedOpt && seedOpt.pinnedTargetIds) || []).map(Number)
            .filter(id => TG.includes(id))));
        if (seedOpt && seedOpt.kind === 'exchange' && pinnedTargets.length > 1) {
            return { ok: false, note: '无限置换最多保留 1 条场上目标（四槽需保留 3 个可洗槽）',
                cost: 0, washes: 0, steps: [], missing: TG.slice() };
        }
        const budget = Math.max(0, Number(p.budget) || 0);
        const bestCost = Math.max(0, Number(p.bestCost) || 0);
        const headBudget = Math.max(0, Number(p.headBudget) || 0);
        const maxWash = Math.max(500, Number(p.maxWash) || 4000);
        const M = Math.max(2, Number(p.M) || 16);
        const lead = Math.max(1, Number(p.lead) || 14);
        const anchorLead = Math.max(10, Number(p.anchorLead) || 120);
        const conflictTtl = Math.max(60, Number(p.conflictTtl) || 260);
        const tailTarget = Number(p.tailTarget) || 0;
        const releaseSeedTarget = !!p.releaseSeedTarget;
        // 首次换果被释放后，执行语义从“链目标必须置换”切换为“链目标也可天然重捕”。
        // 萧佩吟 3161 路线就是先释放神力，随后天然锁玄阳，再开四槽。
        const allowNaturalChainTargets = !!p.allowNaturalChainTargets || releaseSeedTarget;
        const chainIsFull = !!p.chainIsFull;
        const scanSeq = p.seq || [];
        // 预扫整条脉序时，每个紫脉已经带着“离它最近的同型冲突脉”。
        // 后续只有这些被预扫选中的冲突脉才值得锁；距离窗口不再参与决策。
        const plannedConflictIds = new Set(scanSeq
            .map(item => Number(item && item.conflictId))
            .filter(id => id > 0));
        // 链终点（截链取最短）：链消费到此为止，终点之后的条目（含目标副本）不属于本路线
        let chainEnd = Number(p.chainEnd) != null && Number(p.chainEnd) >= 0
            ? Number(p.chainEnd) : 999;
        // 计划锚点：倒插离收尾最近的位置（保底紫位收尾时由链校验给出）
        const planAnchorId = Number(releaseSeedTarget
            ? (p.releasePlanAnchorId || p.planAnchorId)
            : p.planAnchorId) || 0;
        // 倒插映射：{ target, idx, anchor }[] —— 链目标 → 原始脉锚点（天生→鹤骨龙筋、混元→枪棍绝伦）
        const insertMap = Array.isArray(releaseSeedTarget && p.releaseInsertMap)
            ? p.releaseInsertMap
            : (Array.isArray(p.insertMap) ? p.insertMap : []);
        if (root.__RC_TRACE) {
            console.log(`[RC][execute-map] release=${releaseSeedTarget} end=${p.chainEnd} ` +
                `chain=${(p.executionChain || []).slice(0, 8).map(nameOf).join('→')} ` +
                `map=${insertMap.map(item => `C#${Number(item.idx) + 1}:${nameOf(item.target)}` +
                    `→${nameOf(item.anchor)}#${Number(item.anchorNo) || 0}`).join('；')}`);
        }
        // 同一目标可能在链里出现两次（例如鹤骨龙筋）。倒插表必须按链位 idx
        // 匹配；按脉名匹配会让第二处错误复用第一处的锚点。
        const insertAt = (chainIndex, targetId) =>
            insertMap.find(item => item
                && Number(item.idx) === Number(chainIndex)
                && Number(item.target) === Number(targetId))
            // 兼容没有 idx 的旧路线数据；新路线不能再按脉名跨链位复用锚点。
            || insertMap.find(item => item
                && item.idx == null
                && Number(item.target) === Number(targetId))
            || null;
        const strictTargetOccurrences = !!p.strictTargetOccurrences;
        const naturalFixedTargets = new Set((p.naturalFixedTargets || []).map(Number));
        const activationSource = releaseSeedTarget && p.releaseTargetActivationNo
            ? p.releaseTargetActivationNo : (p.targetActivationNo || {});
        const targetActivationNo = new Map(Object.entries(activationSource)
            .map(([id, no]) => [Number(id), Number(no)])
            .filter(([id, no]) => id > 0 && no > 0));
        // ★ 预留锚点（按编号）：倒插锚点 + 计划锚点，烧脉/keep 选新锚点时不得占用（否则锚点被烧，插不进去）
        const reservedAnchors = new Set();
        for (const m of insertMap) if (m && Number(m.anchor) > 0) reservedAnchors.add(Number(m.anchor));
        if (planAnchorId > 0) reservedAnchors.add(Number(planAnchorId));
        const zi0 = Number(seedOpt.zi) >= 150 ? Number(seedOpt.zi) : 153;
        const rawChain = (p.executionChain || seedOpt.chain || []).map(Number);

        let zi = zi0;
        let e = engineOf(raw, zi);
        // 固定置换链必须保留中间脉。中间脉是烧脉推进的一部分，
        // 不能为了“只看目标”把它删掉，否则玄阳会被跳过、不灭对不上锚点。
        const chain = rawChain;
        if (strictTargetOccurrences) chainEnd = Math.min(chainEnd, chain.length - 1);
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let cost = 0, washes = 0, exchanges = 0, burns = 0;
        let purpleOccurrenceNo = 0;
        let lastPurpleEvent = null;
        const purpleCountById = new Map();
        let purplePityCount = 0;
        const activationOrdinalSource = releaseSeedTarget && p.releaseTargetActivationOrdinal
            ? p.releaseTargetActivationOrdinal : (p.targetActivationOrdinal || {});
        const targetActivationOrdinal = new Map(Object.entries(activationOrdinalSource)
            .map(([id, ordinal]) => [Number(id), Number(ordinal)])
            .filter(([id, ordinal]) => id > 0 && ordinal > 0));
        const preservedTargetWashes = Array.from(naturalFixedTargets)
            .map(id => {
                const no = targetActivationNo.get(Number(id)) || 0;
                const event = (scanSeq || []).find(p => Number(p.no) === no);
                return event ? Number(event.wash) || 0 : 0;
            })
            .filter(wash => wash > 0)
            .sort((a, b) => a - b);
        const nextPreservedTargetWash = () =>
            preservedTargetWashes.find(washValue => washValue > washes) || 0;
        if (root.__RC_TRACE) {
            console.log(`[RC][preserved-boundary] ${Array.from(naturalFixedTargets)
                .map(id => `${nameOf(id)}:${preservedTargetWashes.join('/')}`).join('|')}`);
        }
        const notePurpleEvents = result => {
            for (const event of (result && result.generatedEvents || [])) {
                const eventId = Number(event && event.id);
                if (e.quality(eventId) !== 4) continue;
                purpleOccurrenceNo += 1;
                if (event.fromPity) purplePityCount += 1;
                const ordinal = (purpleCountById.get(eventId) || 0) + 1;
                purpleCountById.set(eventId, ordinal);
                lastPurpleEvent = {
                    id: eventId, no: purpleOccurrenceNo, ordinal,
                    pity: !!event.fromPity,
                    pityOrdinal: event.fromPity ? purplePityCount : 0,
                };
                if (root.__RC_TRACE && anchorPurple != null
                    && Number(eventId) === Number(anchorPurple)) {
                    console.log(`[RC][anchor-event] ${nameOf(eventId)} #${ordinal} @${washes} ` +
                        `wantOrdinal=${anchorOrdinal} pity=${anchorIsPity}`);
                }
                if (root.__RC_TRACE && TG.includes(eventId)) {
                    console.log(`[RC] target-event ${nameOf(eventId)}@${washes} ` +
                        `ordinal=${ordinal} pity=${!!event.fromPity} held=${held.length}`);
                }
                if (anchorPurple != null) {
                    const reached = anchorIsPity
                        ? !!((event.fromPity && purplePityCount === anchorPityOrdinal)
                            || (consumed < chain.length
                                && Number(eventId) === Number(chain[consumed])))
                        // 普通锚点的静态洗数只是参考；前一次置换后必须按当前
                        // 场序重新定位。anchorOrdinal=0 表示“本次重扫到的第一条
                        // 同锚点紫”，不能再被旧的 0 序号卡住而永远不判到达。
                        : Number(eventId) === Number(anchorPurple)
                            && (anchorOrdinal <= 0 || ordinal === anchorOrdinal);
                    if (reached && !anchorReached) {
                        anchorReached = true;
                        // 非目标锚点到达后要锁住载体，才能继续预载下一冲突。
                        // 目标锚点由 lockField 记为正式目标，不在这里重复锁。
                        if (Number(anchorPurple) > 0 && !TG.includes(Number(anchorPurple))) {
                            // 这里只记录回放步骤，不推进 segLocks；实际载体锁
                            // 由 runExchangeChain 的 keepIds/preloadConflict 管理。
                            steps.push({
                                type: 'lockCarrier', id: anchorPurple,
                                washes, cost, atAnchor: true, locks: segLocks.slice(),
                            });
                        }
                    }
                }
            }
        };
        const isActivationEvent = id => {
            if (!strictTargetOccurrences) return true;
            const wantNo = targetActivationNo.get(Number(id)) || 0;
            if (wantNo > 0 && lastPurpleEvent) {
                const expected = (scanSeq || []).find(p => Number(p.no) === wantNo);
                if (expected) {
                    if (lastPurpleEvent.id === Number(id)
                        && washes === Number(expected.wash)) return true;
                    // 前一次置换/保底会改变后续 born 流，静态洗数可能只差
                    // 数手。不能因此拒绝真实目标，否则天然脉序从这里整体
                    // 错位。动态重扫后仍按“同名第 N 次出现”校验，只接受
                    // 选定序数，不会把更早的普通副本误当目标。
                    const want = targetActivationOrdinal.get(Number(id)) || 0;
                    return !!(lastPurpleEvent
                        && lastPurpleEvent.id === Number(id)
                        && want > 0
                        && lastPurpleEvent.ordinal === want);
                }
            }
            const want = targetActivationOrdinal.get(Number(id)) || 0;
            return !!(lastPurpleEvent && want > 0
                && lastPurpleEvent.id === Number(id)
                && lastPurpleEvent.ordinal === want);
        };
        const held = [];
        const conflicts = [];
        const initialFieldView = (raw.talents || []).map((t, index) => ({
            id: Number(t && t.id != null ? t.id : t),
            fieldNo: index + 1,
            locked: !!(t && typeof t === 'object' && t.locked),
        })).filter(item => item.id > 0);
        const fallbackShenLocks = new Set((insertMap || [])
            .filter(item => item && item.conflictShenRole === 'non-target-fallback'
                && Number(item.conflictShenId) > 0)
            .map(item => Number(item.conflictShenId)));
        const fallbackShenFieldNos = new Map((insertMap || [])
            .filter(item => item && item.conflictShenRole === 'non-target-fallback'
                && Number(item.conflictShenId) > 0)
            .map(item => [Number(item.conflictShenId),
                Number(item.conflictShenFieldNo) || 0]));
        const initialConsumedRaw = Number(seedOpt && seedOpt.initialConsumed);
        let consumed = Number.isFinite(initialConsumedRaw)
            ? Math.max(0, Math.min(chain.length - 1, initialConsumedRaw))
            : 1;
        let carrier = null;
        let pityPreviewDirty = true;
        // 保底紫种子（跳脉/锁脉/开槽重掷）：链上目标都是保底紫（欧气链），天然/保底出现，不用锁冲突置换
        const isPityCase = seedOpt.kind === 'pity' && !Number(seedOpt.carrier);
        // 第三条 Case 2：kind='exchange'（连续置换），但先洗到首条保底紫定种子
        const pityPrelude = !!seedOpt.pityPrelude;
        // 通用省丹规则：锁到第一条目标后开四槽。
        // 保底/隐藏保底路线例外：需要继续用三槽慢读把隐藏保底挤出来，锁满三条后再开。
        // 典型是步惊云 7949 路线；7601 路线不是隐藏保底方案，另行在开槽后锁定天然目标。
        const openFourthAfterTargets = Math.max(1,
            Number(p.openFourthAfterTargets) || (isPityCase ? 3 : 1));
        let budgetBail2 = false;
        let nextScanAt = 0;
        let anchorPurple = null;
        let anchorNo = 0;   // 锚点的原始脉序位置（第几根），0 = 不限定位置（窗口锚点）
        let anchorOrdinal = 0; // 同名锚点中的第几次出现
        let anchorIsPity = false;
        let anchorPityOrdinal = 0;
        let anchorReached = false;
        let anchorPlannedWash = 0;
        let anchorConflictId = 0;
        let deferredAt = -1;   // defer 时的已锁目标数：defer 后先全解锁空洗，等天然目标落锁再扫窗口
        const steps = [];
        const pityEvents = [];
        let segLocks = [];
        const bail = why => ({
            ok: false, note: why, cost, washes, exchanges, burns,
            steps: steps.slice(), field: s.talents.slice(), held: held.slice(),
            missing: TG.filter(id => !held.includes(id)),
        });
        const keepIds = () => held.concat(Array.from(fallbackShenLocks))
            .concat(conflicts.map(c => c.id))
            .concat(carrier == null ? [] : [carrier]);
        // 从当前真实状态预判下一次保底。保底名额是固定的，但具体紫脉由
        // 当前 luckSeed 决定；必须在实际洗到之前先把身份和距离算出来。
        const previewNextPity = limit => {
            let ps = Object.assign({}, s, { talents: s.talents.slice() });
            const lockSet = keepIds();
            for (let k = 1; k <= limit; k++) {
                const keep = lockSet
                    .map(id => ps.talents.indexOf(id))
                    .filter(index => index >= 0);
                const rr = e.wash(ps, keep);
                ps = rr.state;
                if (rr.pityPurpleId != null) {
                    return {
                        id: Number(rr.pityPurpleId),
                        offset: k,
                        wash: washes + k,
                    };
                }
            }
            return null;
        };
        const pushStep = step => { step.locks = segLocks.slice(); step.field = s.talents.slice(); steps.push(step); segLocks = keepIds(); };
        // ★ 初始场上已有目标紫：能在链/原始脉序后面拿到 → 后面拿；拿不到 → 现在直接锁
        {
            const rawTalents = raw.talents || [];
            const initialField = rawTalents.map(t => Number(t && t.id != null ? t.id : t)).filter(id => id > 0);
            const initialFieldEntries = initialFieldView;
            // ① 初始已锁定的目标紫：
            //    锁脉法（吞脉法·锁脉，lowId>0）→ 直接放弃（不持有）；
            //    跳脉法（吞脉法·跳脉，lowId==0）→ 最多持有一条；
            //    无限置换（无 pityPrelude）→ 看能否在后面复现（能 → 解锁重拿，不能 → 保持锁定）
            for (const entry of initialFieldEntries) {
                const id = entry.id;
                if (!(id > 0 && entry.locked && TG.includes(id) && !held.includes(id))) continue;
                const isSwallow = !!seedOpt.pityPrelude;                 // 吞脉法（锁脉/跳脉/裸洗保底）
                const isJump = isSwallow && !(Number(seedOpt.lowId) > 0); // 跳脉法/裸洗（无锁低阶）
                if (pinnedTargets.includes(id)) {
                    held.push(id);
                    pushStep({
                        type: 'lock', id, washes, cost, initial: true, pinned: true,
                        fieldNo: entry.fieldNo,
                    });
                    continue;
                }
                if (isSwallow) {
                    if (isJump && held.length === 0) held.push(id);      // 跳脉法：最多持有一条
                    continue;                                            // 锁脉法：放弃，不持有
                }
                const recaptureAfter = Number(seedOpt.washes) || 0;
                const canRecapture = chain.includes(id)
                    || (scanSeq || []).some(p => Number(p.id) === id && Number(p.wash) >= recaptureAfter);
                if (!canRecapture) held.push(id);
            }
            // ② 初始未锁定的目标紫：后面拿得到 → 后面拿；拿不到 → 现在锁
            for (const id of TG) {
                if (!initialField.includes(id) || held.includes(id)) continue;
                const inChain = chain.includes(id);
                const inSeq = (scanSeq || []).some(p => p.id === id);
                if (!inChain && !inSeq) {
                    const entry = initialFieldEntries.find(item => item.id === id);
                    held.push(id);
                    pushStep({
                        type: 'lock', id, washes, cost, initial: true,
                        fieldNo: entry ? entry.fieldNo : 0,
                    });
                }
            }
            if (seedOpt.kind === 'exchange' && held.length > 1) {
                return bail('无限置换最多保留 1 条场上目标（四槽需保留 3 个可洗槽）');
            }
        }
        // 链消费推进：只有实际落下/换出的紫正好等于当前链位时才前进一步。
        // 保底紫若不等当前链位，只能留在锚点等待置换，不能擅自吃掉一格。
        const advanceConsumed = (added, fieldBefore) => {
            const before = consumed;
            while (consumed < chain.length && held.includes(Number(chain[consumed]))) {
                consumed++;
            }
            if (consumed < chain.length && Number(added) === Number(chain[consumed])) {
                consumed++;
            }
            if (consumed !== before) pityPreviewDirty = true;
            if (typeof console !== 'undefined' && root.__RC_TRACE) {
                console.log(`[RC] advanceConsumed: added=${nameOf(added)} ` +
                    `expect=${chain[consumed] != null ? nameOf(chain[consumed]) : '终点'} → consumed=${consumed}`);
            }
        };
        const trackPity = r => {
            if (r.pityPurpleId != null) {
                const pid = Number(r.pityPurpleId);
                const pityKind = classifyPityOutput(e, pid, TG);
                const chainIndex = consumed;
                const expectedId = consumed < chain.length ? Number(chain[consumed]) : 0;
                pityEvents.push({
                    id: pid,
                    expectedId,
                    chainIndex,
                    matchedChain: expectedId > 0 && pid === expectedId,
                    directChainSlot: !!anchorIsPity && !!anchorReached,
                    isTarget: pityKind.isTarget,
                    isShenmai: pityKind.isShenmai,
                    canBeCarrier: pityKind.canBeCarrier,
                    washes,
                });
                // 保底紫实际命中当前置换链位时，直接插入并推进链。
                // 这一步不需要前置冲突，也不需要再做一次置换。
                const matchedChain = expectedId > 0 && pid === expectedId;
                // 同名还不够：只有倒插计划明确把当前 C# 分配给这个保底位，
                // 才能免置换直出。否则它只是普通载体/毁脉，不能抢占前面
                // 尚未执行的非保底锚点。
                const plannedPityChain = matchedChain && anchorIsPity;
                if (plannedPityChain) {
                    if (root.__RC_TRACE) {
                        console.log(`[RC][pity-chain] ${nameOf(pid)} @${washes} ` +
                            `C#${consumed + 1} 直出`);
                    }
                    pushStep({ type: 'pityChain', id: pid, washes, cost });
                    advanceConsumed(pid, null, r.pityFieldBefore || null);
                    // 这一次保底槽已经结算完成。下一链位若仍是普通中间脉，
                    // pid 会以 carrier 身份保留；若下一链位是目标，则必须
                    // 重新扫描它自己的倒插锚点，不能继续在旧保底位上置换。
                    anchorPurple = null;
                    anchorNo = 0;
                    anchorOrdinal = 0;
                    anchorIsPity = false;
                    anchorPityOrdinal = 0;
                    anchorReached = false;
                    anchorConflictId = 0;
                }
                // 保底紫与实际目标身份分离：非目标保底紫无论是否命中当前链位，
                // 都可以像普通紫一样作为连续置换载体，通过其前方最近冲突推进链位。
                if (!TG.includes(pid) && !held.includes(pid)) {
                    carrier = pid;
                }
                // 保底位被路线明确指定为直出锚点时，同样推进链。
                if (!plannedPityChain && anchorIsPity && anchorReached) {
                    advanceConsumed(pid, null, r.pityFieldBefore || null);
                }
                // ★ 保底紫空位插入：保底紫若是目标 → 直接锁（免置换插入空位），不再等冲突/置换
                if (TG.includes(pid) && !held.includes(pid)
                    && !(pid === tailTarget && held.length < K - 1 && chain.includes(pid))) {
                    held.push(pid);
                    pushStep({ type: 'lock', id: pid, washes, cost, why: 'pity' });
                }
                pityPreviewDirty = true;
            }
        };
        const washOne = () => {
            const keep = keepIds().map(id => s.talents.indexOf(id)).filter(i => i >= 0);
            const fieldBefore = new Set(s.talents.map(Number));
            const r = e.wash(s, keep);
            s = r.state; cost += Number(r.cost) || 0; washes++;
            r.pityFieldBefore = fieldBefore;
            notePurpleEvents(r);
            trackPity(r);
            return r;
        };
        const laterWash = new Map();
        for (const pp of scanSeq) {
            const w = Number(pp.wash) || 0;
            if (w > (laterWash.get(Number(pp.id)) || 0)) laterWash.set(Number(pp.id), w);
        }
        const decideLock = id => {
            // 收尾目标提前出现也照样锁住（不再烧掉重捕），其余三个靠天然重捕 / 倒插补齐
            if (!TG.includes(id) || held.includes(id)) return false;
            // 收尾目标必须最后拿到；前三条没齐时，同名出现只是普通紫。
            if (Number(id) === tailTarget && held.length < K - 1) return false;
            // 前三条齐后，下一颗同名收尾脉就是当前路线的最终收尾位，
            // 不再受最初静态脉序里的“第几次出现”限制。
            if (strictTargetOccurrences && Number(id) === tailTarget
                && held.length >= K - 1) return true;
            if (strictTargetOccurrences) {
                return isActivationEvent(id);
            }
            return true;
        };
        const lockField = () => {
            const chainNext = consumed < chain.length ? Number(chain[consumed]) : 0;
            if (chainIsFull && anchorIsPity && anchorReached
                && lastPurpleEvent && lastPurpleEvent.pity) {
                const pityActual = Number(lastPurpleEvent.id);
                const pityKind = classifyPityOutput(e, pityActual, TG);
                // 保底位的实际身份由种子决定：
                //   · 是目标 → trackPity 已经直接锁定，不置换；
                //   · 不是目标 → 它就是一颗普通原始紫，可作为当前载体，
                //     后续仍从它前方找最近冲突并执行真实置换。
                if (pityKind.isTarget) {
                    if (!held.includes(pityActual) && decideLock(pityActual)) {
                        held.push(pityActual);
                        pushStep({ type: 'lock', id: pityActual, washes, cost, why: 'pity' });
                    }
                    anchorPurple = null;
                } else {
                    anchorPurple = pityActual;
                }
                anchorIsPity = false;
                anchorPityOrdinal = 0;
                anchorReached = true;
                anchorConflictId = 0;
                carrier = null;
                return;
            }
            for (const id of TG) {
                const selectedMap = insertAt(consumed, id);
                const atSelectedAnchorTarget = Number(id) === chainNext
                    && !!selectedMap
                    && s.talents.includes(id)
                    && (anchorReached
                        || (anchorIsPity && !!(lastPurpleEvent
                            && lastPurpleEvent.pity
                            && lastPurpleEvent.id === Number(id))));
                if (atSelectedAnchorTarget) {
                    held.push(id);
                    pushStep({ type: 'lock', id, washes, cost, atAnchor: true, why: 'anchor' });
                    anchorPurple = null;
                    anchorIsPity = false;
                    anchorPityOrdinal = 0;
                    anchorReached = false;
                    anchorConflictId = 0;
                } else if (s.talents.includes(id) && decideLock(id)) {
                    if (root.__RC_TRACE) {
                        console.log(`[RC][target-lock] ${nameOf(id)} @${washes} ` +
                            `selected=${!!selectedMap} activation=${isActivationEvent(id)} ` +
                            `tail=${Number(id) === Number(tailTarget)}`);
                    }
                    // ★ 无限置换走「置换重拿」：链上的目标不天然锁（靠链置换拿），只有链外目标才天然锁。
                    //   pityPrelude（锁脉 / 跳脉 / 裸洗保底定种子）不同：种子已经落盘，
                    //   后续天然出现的目标同样应当直接锁；7601 路线的混元、金仙就是这样收下的。
                    //   若继续强制走置换，会忽略天然目标并在链上空转到洗数上限。
                    // 严格按“出现位置”运行时，链上同名目标只有落在正式激活位置
                    // 才会通过 decideLock；这个位置当然要自然锁，不能再按旧规则跳过。
                    if (!strictTargetOccurrences && !isPityCase && !pityPrelude
                        && !allowNaturalChainTargets && chain.includes(id)) continue;
                    held.push(id);
                    pushStep({ type: 'lock', id, washes, cost, why: 'field' });
                } else if (root.__RC_TRACE && s.talents.includes(id)
                    && TG.includes(Number(id)) && !held.includes(Number(id))) {
                    console.log(`[RC] 目标未锁 ${nameOf(id)} @${washes} ` +
                        `strict=${strictTargetOccurrences} tail=${tailTarget ? nameOf(tailTarget) : '无'} ` +
                        `held=${held.length} last=${lastPurpleEvent ? `${nameOf(lastPurpleEvent.id)}#${lastPurpleEvent.ordinal}` : '无'} ` +
                        `want=${targetActivationOrdinal.get(Number(id)) || 0}`);
                }
            }
            // 锁到天然目标立即开 4 槽（实测：锁玄阳→开槽→再洗，省丹）
            if (zi === 153 && held.length >= openFourthAfterTargets && held.length < K) {
                zi = 154; e = engineOf(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                pushStep({ type: 'upgrade', toZi: 154, washes, cost });
            }
        };
        const missing = () => TG.filter(id => !held.includes(id));
        const aheadMissing = () => {
            if (isPityCase) return false;   // 纯锁吞脉法：不置换；第三条(kind='exchange')照常查链
            const miss = missing();
            for (let i = consumed; i < chain.length && i <= chainEnd && i < consumed + M; i++) {
                if (miss.includes(chain[i])) return true;
            }
            return false;
        };
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
                    // 同名目标的早期副本可作锚点载体。
                    const ty = talentType(id);
                    if (!map.has(ty)) map.set(ty, k);
                }
            }
            return map;
        };
        const conflictCanLinkNext = conflict => {
            if (!conflict) return false;
            const conflictId = conflict.id;
            if (carrier == null || !s.talents.includes(Number(carrier))) return false;
            const ci = s.talents.indexOf(Number(conflictId));
            const pi = s.talents.indexOf(Number(carrier));
            if (ci < 0 || pi < 0 || ci > pi) return false;
            const ty = e.talentType(carrier);
            if (e.talentType(conflictId) !== ty) return false;
            // 冲突脉必须在载体前；且两者之间不能还有同型低阶脉。
            // 有更近的一条时，当前冲突虽然“能用”，但不是最近冲突，仍应解锁。
            for (let i = ci + 1; i < pi; i++) {
                const talent = Number(s.talents[i]);
                if (talent === 251 || held.includes(talent)) continue;
                if (e.quality(talent) < 4 && e.talentType(talent) === ty) return false;
            }
            return true;
        };
        // 冲突解锁（使用者双条件）：①不是后续要置换的紫脉的冲突脉（链上到「下一个要锁的目标」为止无同类型）；
        // ②不是后续置换紫锚点最近的冲突脉（以「链前方同类型」近似，另有超时兜底）
        const releaseUnneededConflicts = () => {
            if (!conflicts.length) return;
            // 只看场上这条冲突能否继续服务当前载体的下一手置换。
            // 不比较具体 ID：换种子或跳脉后，同功能的冲突 ID 可以变化。
            for (const c of conflicts.slice()) {
                if (!conflictCanLinkNext(c)) {
                    pushStep({ type: 'unlockConflict', id: c.id, washes, cost, why: '下一手用不到' });
                    conflicts.splice(conflicts.indexOf(c), 1);
                }
            }
            segLocks = keepIds();
        };
        // 链段结束：释放冲突锁——但「后续链上还会当载体置换」的同类型冲突脉要留着复用（0成本连续置换）
        const releaseAllConflicts = force => {
            for (const c of conflicts.slice()) {
                const needed = !force && conflictCanLinkNext(c);
                if (needed) continue;
                pushStep({ type: 'unlockConflict', id: c.id, washes, cost,
                    why: force ? '倒插分支立即清空冲突锁' : '下一手用不到' });
                conflicts.splice(conflicts.indexOf(c), 1);
            }
            segLocks = keepIds();
        };
        if (typeof console !== 'undefined' && root.__RC_TRACE) {
            console.log('[RC] chain types ' + chain.slice(0, 8).map(x => `${nameOf(x)}:${e.talentType(x)}:shen=${e.isShenmai(x)}`).join(' ')
                + ' || 冲突: ' + conflicts.map(c => `${nameOf(c.id)}:${e.talentType(c.id)}`).join(' '));
        }
        const fieldLowOfType = (ty, beforeId, allowBehind) => {
            // ★ 冲突脉要「离紫脉最近的中途脉」：同类型低阶里取场上位置最靠后（紧挨紫脉前面）的那条，不是第一个
            const list = s.talents.map(Number);
            const beforePos = Number(beforeId) > 0 ? list.indexOf(Number(beforeId)) : list.length;
            for (let i = beforePos - 1; i >= 0; i--) {
                const v = list[i];
                if (v !== 251 && e.quality(v) < 4 && e.talentType(v) === ty
                    && !held.includes(v) && !conflicts.some(c => c.id === v)) return v;
            }
            // 连续置换的下一冲突可能在本次置换结果后面出现；锁定它以后，
            // 实际界面会把它排到载体前。这里按同一语义把场上序号归一化，
            // 但不改任何天赋身份，也不消耗洗数或丹数。
            if (allowBehind && beforePos >= 0) {
                let chosen = -1;
                for (let i = list.length - 1; i >= 0; i--) {
                    const v = list[i];
                    if (i === beforePos || v === 251 || e.quality(v) >= 4
                        || e.talentType(v) !== ty
                        || held.includes(v)
                        || conflicts.some(c => c.id === v)) continue;
                    chosen = i;
                    break;
                }
                if (chosen >= 0) {
                    const chosenId = Number(s.talents[chosen]);
                    s.talents.splice(chosen, 1);
                    const targetPos = Math.max(0, Math.min(s.talents.length,
                        s.talents.indexOf(Number(beforeId))));
                    s.talents.splice(targetPos, 0, chosenId);
                    return chosenId;
                }
            }
            return null;
        };
        const exchangeToExact = (from, desired, baseLocks) => {
            const lockList = Array.from(new Set((baseLocks || []).map(Number)));
            const pos = s.talents.indexOf(Number(from));
            if (pos < 0) return null;
            // 普通载体必须使用当前场序里、位于它前方最近的同类型低阶脉。
            // 不能枚举其他低阶脉或自动换位来碰巧完成置换。
            if (!usesNearestConflict(e, s, from, lockList)) return null;
            let replaceable = false;
            try { replaceable = e.replaceablePositions(s, lockList).includes(pos); }
            catch (err) { replaceable = false; }
            if (!replaceable) return null;
            let result = null;
            try { result = e.replace(s, pos, lockList); }
            catch (err) { result = null; }
            return result && Number(result.addedId) === Number(desired)
                ? { result, locks: lockList }
                : null;
        };
        // 预载某类型的冲突脉（最多补洗 80 洗）；-1=超预算放弃，null=预载不到
        const preloadConflict = (ty, beforeId, allowBehind) => {
            const before = Number(beforeId) || carrier;
            let pre = fieldLowOfType(ty, before, allowBehind);
            for (let k = 0; k < 80 && pre == null; k++) {
                const boundary = nextPreservedTargetWash();
                if (boundary > 0 && washes + 1 >= boundary) return null;
                const r = washOne();
                lockField();
                if (held.length >= K) return -2;
                if (budget > 0 && cost > budget) return -1;
                if (bestCost > 0 && cost >= bestCost) return -1;
                pre = fieldLowOfType(ty, before, allowBehind);
            }
            if (pre == null) return null;
            if (!conflicts.some(c => c.source === 'exchange' && c.id === pre)) {
                // 补洗到冲突后实际锁定的全部脉（含当前载体），
                // 回放必须沿用这组锁，否则随机流会从这一步开始分叉。
                const preloadWashLocks = keepIds();
                conflicts.push({ id: pre, since: washes, source: 'exchange' });
                const step = { type: 'lockConflict', id: pre, washes, cost, forType: ty };
                pushStep(step);
                step.locks = preloadWashLocks;
            }
            return pre;
        };
        // 扫窗口：找「紫 + 它最近的同类型冲突脉」——全部配对按 offset 排序
        // ★ 神脉也是正常锚点：前提是前面已有锁定的神脉（互冲成立）；免预载（无冲突锁）
        const scanWindowPairs = (limit, preferredConflictId = 0, firstAccept = null,
            stopAfterPurple = null) => {
            let ps = Object.assign({}, s, { talents: s.talents.slice() });
            const lockIds = keepIds();
            const shenLocked = held.some(id => e.isShenmai(id))
                || fallbackShenLocks.size > 0;
            const purples = [];
            const lows = [];
            const pairs = [];
            let evaluatedPurples = 0;
            let scanPurpleNo = purpleOccurrenceNo;
            let scanPityOrdinal = purplePityCount;
            const scanIdCounts = new Map(purpleCountById);
            for (let k = 1; k <= limit; k++) {
                let r = null;
                try { r = e.wash(ps, lockIds.map(id => ps.talents.indexOf(id)).filter(i => i >= 0)); }
                catch (err) { break; }
                ps = r.state;
                for (const ev of (r.generatedEvents || [])) {
                    const id = Number(ev.id);
                    if (e.quality(id) === 4) {
                        scanPurpleNo += 1;
                        if (ev.fromPity) scanPityOrdinal += 1;
                        const ordinal = (scanIdCounts.get(id) || 0) + 1;
                        scanIdCounts.set(id, ordinal);
                        const meta = {
                            id, offset: k, no: scanPurpleNo, ordinal,
                            pity: !!ev.fromPity, pityOrdinal: ev.fromPity ? scanPityOrdinal : 0,
                        };
                        if (stopAfterPurple && stopAfterPurple(meta)) return pairs;
                        if (e.isShenmai(id)) {
                            if (shenLocked) purples.push(Object.assign({ shenmai: true }, meta));
                        } else {
                            purples.push(meta);
                        }
                    }
                    else if (id !== 251 && e.quality(id) < 4) lows.push({ id, offset: k, type: e.talentType(id) });
                }
                while (evaluatedPurples < purples.length) {
                    const p = purples[evaluatedPurples++];
                    let pair = null;
                    if (p.shenmai) {
                        pair = { purple: p, conflict: null };
                    } else {
                        const sameType = lows.filter(x =>
                            x.type === e.talentType(p.id) && x.offset <= p.offset);
                        const preferred = preferredConflictId > 0
                            ? sameType.filter(x => Number(x.id) === Number(preferredConflictId))
                                .sort((a, b) => b.offset - a.offset)[0] : null;
                        // 阶段 1 已确定冲突身份时，只定位这一条脉；
                        // 找不到就是当前状态与规划不一致，不能换成别的同型脉。
                        const cand = preferredConflictId > 0
                            ? preferred
                            : sameType.sort((a, b) => b.offset - a.offset)[0] || null;
                        if (cand) pair = { purple: p, conflict: cand };
                    }
                    if (!pair) continue;
                    pairs.push(pair);
                    // 配对按紫事件顺序产生，第一条被接受的配对就是最早的
                    // 可毁位置；后续紫不可能取代它，可提前结束整段模拟。
                    if (firstAccept && firstAccept(pair)) return [pair];
                }
                // ★ 没有提前退出时才扫满窗口，供按锚点序号查找使用。
            }
            return pairs;
        };
        // 最早的配对 = 最近的可毁脉点
        const scanWindow = limit =>
            scanWindowPairs(limit, 0, () => true)[0] || null;
        // 锚点专用：找到锚点紫，取其之前最近的同类型冲突（倒着查）
        const scanWindowFor = (anchorId, limit, expectedOrdinal, isPity, expectedPityOrdinal,
            preferredConflictId) => {
            const pairs = scanWindowPairs(limit, preferredConflictId, null, meta => {
                if (isPity && expectedPityOrdinal > 0) {
                    return !!meta.pity && Number(meta.pityOrdinal) > Number(expectedPityOrdinal);
                }
                return expectedOrdinal > 0
                    && Number(meta.id) === Number(anchorId)
                    && Number(meta.ordinal) > Number(expectedOrdinal);
            });
            if (isPity && expectedPityOrdinal > 0) {
                for (const pr of pairs) {
                    if (pr.purple.pity
                        && Number(pr.purple.pityOrdinal) === Number(expectedPityOrdinal)) return pr;
                }
                if (root.__RC_TRACE) {
                    console.log(`[RC] 保底锚点等待 #${expectedPityOrdinal}，窗口内保底=` +
                        pairs.filter(pr => pr.purple && pr.purple.pity)
                            .map(pr => `#${pr.purple.pityOrdinal}@${pr.purple.offset}`).join('/') || '无');
                }
                return null;
            }
            if (expectedOrdinal > 0) {
                for (const pr of pairs) {
                    if (Number(pr.purple.id) === Number(anchorId)
                        && Number(pr.purple.ordinal) === Number(expectedOrdinal)) return pr;
                }
                return null;
            }
            // 固定序号已经存在于当前状态之前时，按同一锚点脉重新定位；
            // 然后从当前状态搜索它前面最近的同类型冲突。
            for (const pr of pairs) {
                if (Number(pr.purple.id) === Number(anchorId)) return pr;
            }
            return null;
        };
        // 定向锁：先扫描脉序，直接洗到「离紫最近的中途冲突脉」位置再锁（锁的是靠近紫的那条，不是当前场上旧的那条）
        const lockConflictByScan = () => {
            // 锁脉法定种子时只提前看近窗口，避免把很远的目标当成当前冲突；
            // 普通无限置换仍需 450 手窗口完成锚点预判。
            // 但一旦已由倒插表选定了锚点，锚点本身的距离不能再用 14 手截断。
            // 7314 中 O#3 鹤骨龙筋约在 185 手后；只看 14 手会永远锁不到它的前置冲突，
            // 场上即便出现紫载体也不可置换。
            const maxDynamicScan = Math.max(120, Math.min(
                Math.max(0, maxWash - washes),
                Math.max(120, Number(p.anchorScanMax) || 1200)));
            let scanLimit = anchorPurple != null
                ? Math.min(maxDynamicScan, Math.max(120, anchorLead))
                : (pityPrelude ? lead : 450);
            // 锚点模式：提前扫描脉序，直接找到锚点紫之前最近的冲突脉，洗到位就锁（不换锁）
            let win = anchorPurple != null
                ? scanWindowFor(anchorPurple, scanLimit, anchorOrdinal, anchorIsPity, anchorPityOrdinal,
                    anchorConflictId)
                : (scanWindowPairs(scanLimit, 0, pr =>
                    !!pr.purple && !reservedAnchors.has(Number(pr.purple.id)))[0] || null);
            if (anchorPurple != null && !win) {
                for (const nextLimit of [240, 450, 900, maxDynamicScan]) {
                    if (nextLimit <= scanLimit) continue;
                    scanLimit = Math.min(maxDynamicScan, nextLimit);
                    win = scanWindowFor(anchorPurple, scanLimit, anchorOrdinal,
                        anchorIsPity, anchorPityOrdinal, anchorConflictId);
                    if (win || scanLimit >= maxDynamicScan) break;
                }
            }
            if (typeof console !== 'undefined' && root.__RC_TRACE) {
                const all = scanWindowPairs(scanLimit);
                const pairText = all.slice(0, 4).map(x =>
                    `${nameOf(x.purple.id)}@${x.purple.offset}/` +
                    `${x.conflict ? `${nameOf(x.conflict.id)}@${x.conflict.offset}` : '无冲突'}`)
                    .join(' | ');
                const winText = win
                    ? `${nameOf(win.purple.id)}@${win.purple.offset} ` +
                        `冲突${win.conflict ? `${nameOf(win.conflict.id)}@${win.conflict.offset}` : '无'}`
                    : '无';
                console.log(`[RC] 扫窗口: ${winText} washes=${washes} 配对=[${pairText}]`);
            }
            if (!win) return false;
            // 保底紫正好命中当前 C# 时是免置换直出，不需要预先锁冲突。
            // 直接用空锁洗到保底位，让 trackPity 结算该链位。
            const directPityChain = !!win.purple.pity
                && consumed < chain.length
                && Number(win.purple.id) === Number(chain[consumed]);
            if (directPityChain) {
                anchorPurple = null;
                anchorNo = Number(win.purple.no) || 0;
                anchorOrdinal = Number(win.purple.ordinal) || 0;
                anchorPlannedWash = 0;
                anchorIsPity = true;
                anchorPityOrdinal = Number(win.purple.pityOrdinal) || 0;
                anchorConflictId = 0;
                anchorReached = false;
                const pityOffset = Math.max(0, Number(win.purple.offset) || 0);
                for (let k = 0; k < pityOffset; k++) {
                    if (budget > 0 && cost > budget) { budgetBail2 = true; return false; }
                    if (bestCost > 0 && cost >= bestCost) { budgetBail2 = true; return false; }
                    washOne();
                    lockField();
                }
                return true;
            }
            // 神脉锚点：免预载，靠互冲通道（不锁冲突）
            if (win.conflict == null) {
                if (anchorPurple == null || anchorPurple === 0) {
                    anchorPurple = win.purple.id;
                    anchorNo = Number(win.purple.no) || 0;
                    anchorOrdinal = Number(win.purple.ordinal) || 0;
                    anchorPlannedWash = Number(win.purple.wash) || 0;
                }
                return true;
            }
            // ★ 洗到扫描指定的位置（不因场上已有同 id 旧脉提前锁——要的是离紫最近的那条）
            for (let k = 0; k < win.conflict.offset; k++) {
                if (budget > 0 && cost > budget) { budgetBail2 = true; return false; }
                if (bestCost > 0 && cost >= bestCost) { budgetBail2 = true; return false; }
                const boundary = nextPreservedTargetWash();
                if (boundary > 0 && washes + 1 >= boundary) return false;
                const r2 = washOne();
                lockField();
                if (held.length >= K) return false;
            }
            const ty = e.talentType(win.conflict.id);
            // 洗到冲突段之后场上可能同时有多个同名低阶脉：
            // 永远取离目标紫最近、位置最靠后的那条，不能取第一个。
            const nearLow = fieldLowOfType(ty);
            if (nearLow == null) return false;
            // 同类型冲突只保留一条。两条同型低阶同时锁定会占掉置换槽，
            // 出现“场上明明有冲突和紫，却不可置换”的假死。
            if (!conflicts.some(c => c.source === 'raw' && e.talentType(c.id) === ty)) {
                conflicts.push({ id: nearLow, since: washes, source: 'raw' });
                pushStep({ type: 'lockConflict', id: nearLow, washes, cost, forPurple: win.purple.id });
                if (root.__RC_TRACE) {
                    console.log(`[RC][anchor-prepare] lock=${nameOf(nearLow)}@${washes} ` +
                        `anchor=${nameOf(win.purple.id)}@${washes + win.purple.offset}`);
                }
            }
            if (anchorPurple == null || anchorPurple === 0) {
                anchorPurple = win.purple.id;
                anchorNo = Number(win.purple.no) || 0;
                anchorOrdinal = Number(win.purple.ordinal) || 0;
                anchorPlannedWash = Number(win.purple.wash) || 0;
            }
            return true;
        };
        // defer 之后先全解锁空洗：只等「出现在锚点之前、还能天然重捕」的目标落锁（实测的空洗段）
        const naturalsPending = () => {
            const miss = TG.filter(id => !held.includes(id));
            // 锚点的首次出现位置
            let anchorW = 0;
            if (anchorPurple != null) {
                for (const pp of scanSeq) {
                    if (Number(pp.id) === anchorPurple && (anchorNo === 0 || Number(pp.no) === anchorNo)) { anchorW = Number(pp.wash) || 0; break; }
                }
            }
            // 扫描里「现在之后、锚点之前」还会出现的缺的目标 → 还在等天然落锁
            for (const pp of scanSeq) {
                const w = Number(pp.wash) || 0;
                if (w <= washes) continue;
                if (w >= anchorW && anchorW > 0) break;
                if (miss.includes(Number(pp.id))) return true;
            }
            return false;
        };
        // ★ 可操作槽数：总槽位 - 已锁目标数；连续置换需要 ≥3（锁冲突+载体+1洗槽）
        const freeSlots = () => (zi >= 154 ? 4 : 3) - held.length;
        const rollbackPreloadedConflicts = before => {
            for (const c of conflicts.slice()) {
                if (before.has(Number(c.id))) continue;
                pushStep({
                    type: 'unlockConflict', id: c.id, washes, cost,
                    why: '本次置换未执行，撤销预载',
                });
                conflicts.splice(conflicts.indexOf(c), 1);
            }
            segLocks = keepIds();
        };
        const runExchangeChain = () => {
            let acted = false;
            for (let step = 0; step < 24; step++) {
                const preservedBoundary = nextPreservedTargetWash();
                if (preservedBoundary > 0 && washes + 1 >= preservedBoundary) {
                    // 连续置换段到此强制结束，把下一个保留目标交还主循环。
                    carrier = null;
                    anchorPurple = null;
                    anchorIsPity = false;
                    anchorPityOrdinal = 0;
                    anchorReached = false;
                    anchorConflictId = 0;
                    releaseAllConflicts(true);
                    return acted ? 'acted' : 'none';
                }
                // 当前场上固定保留的目标如果也出现在置换链里，直接推进链游标；
                // 它已经满足，不应再作为“需要换出来”的链目标反复烧脉。
                while (consumed < chain.length && held.includes(Number(chain[consumed]))) {
                    consumed++;
                }
                // 链只执行到校验后的终点；终点后的同名副本属于收尾等待，
                // 不能在别的载体上提前烧掉。
                if (consumed > chainEnd) return acted ? 'acted' : 'none';
                const next = chain[consumed];
                if (next == null) break;
                const miss = missing();
                // 当前链位先做一次动态保底预判。保底命中时无需载体和冲突，
                // 直接等待该保底落位并推进链。
                if (pityPreviewDirty && anchorPurple == null && !TG.includes(Number(next))) {
                    const preview = previewNextPity(1000);
                    pityPreviewDirty = false;
                    const mapped = insertAt(consumed, next);
                    // 倒插表已明确指定普通锚点时，当前链位必须从该锚点
                    // 连续置换推进，不能因为未来保底恰好同名就改为等保底。
                    const mappedExplicitOrdinaryAnchor = !!(mapped
                        && Number(mapped.anchor) > 0
                        && !mapped.anchorIsPity);
                    if (preview && Number(preview.id) === Number(next)
                        && !mappedExplicitOrdinaryAnchor) {
                        anchorPurple = 0;
                        anchorIsPity = true;
                        anchorPityOrdinal = purplePityCount + 1;
                        anchorReached = false;
                        anchorConflictId = 0;
                        anchorPlannedWash = Number(preview.wash) || 0;
                        return acted ? 'acted' : 'defer';
                    }
                }
                // 中间脉之后若有正式倒插目标，就先转到那个目标的载体再连续置换。
                // 老僧已持有金仙、混元后，玄阳→不灭必须留到 4#刀法上完成。
                if (anchorPurple == null && !miss.includes(Number(next))) {
                    let upcomingAnchor = null;
                    // 当前非目标链位若在完整倒插表里有自己的锚点，必须先按它的编号走；
                    // 只有它没有独立锚点时，才归到后面目标的同一载体上连续烧。
                    const ownMap = insertAt(consumed, next);
                    const mapItem = ownMap || (() => {
                        for (let i = consumed; i < chain.length && i <= chainEnd; i++) {
                            const chainTarget = Number(chain[i]);
                            if (!miss.includes(chainTarget)) continue;
                            return insertAt(i, chainTarget);
                        }
                        return null;
                    })();
                    if (mapItem && Number(mapItem.anchor) > 0) {
                        upcomingAnchor = {
                            id: Number(mapItem.anchor),
                            // 前一次置换会推进欧气序列，静态编号/洗数只作参考。
                            // 阶段 1 的最近冲突 ID 保留为扫描提示；若当前状态
                            // 已不存在该脉，窗口扫描会自动回退到新的最近冲突。
                            no: mapItem.anchorIsPity ? Number(mapItem.anchorNo) || 0 : 0,
                            ordinal: mapItem.anchorIsPity ? Number(mapItem.anchorOrdinal) || 0 : 0,
                            isPity: !!mapItem.anchorIsPity,
                            pityOrdinal: Number(mapItem.anchorPityOrdinal) || 0,
                            conflictId: Number(mapItem.anchorConflictId) || 0,
                            wash: mapItem.anchorIsPity ? Number(mapItem.anchorWash) || 0 : 0,
                        };
                    }
                    if (upcomingAnchor) {
                        anchorPurple = upcomingAnchor.isPity ? 0 : upcomingAnchor.id;
                        anchorNo = upcomingAnchor.no;
                        anchorPlannedWash = Number(upcomingAnchor.wash) || 0;
                        anchorOrdinal = upcomingAnchor.ordinal;
                        anchorIsPity = chainIsFull && upcomingAnchor.isPity;
                        anchorPityOrdinal = upcomingAnchor.pityOrdinal;
                        anchorConflictId = upcomingAnchor.conflictId;
                        anchorReached = false;
                        if (!s.talents.includes(anchorPurple)) {
                            return acted ? 'acted' : 'defer';
                        }
                    }
                }
                // 锚点之前还有要天然落锁的目标 → 只空洗等待，不换不锁冲突
                if (anchorPurple != null && !anchorIsPity
                    && !s.talents.includes(anchorPurple) && naturalsPending()) {
                    return acted ? 'acted' : 'none';
                }
                let mode = 'skip';
                if (miss.includes(next)) {
                    // 该目标已决定保留在后面的天然位置时，当前只是链里的
                    // 同名副本，必须白烧推进，不能在这里提前锁成正式目标。
                    mode = naturalFixedTargets.has(Number(next))
                        ? 'burnTail'
                        : (strictTargetOccurrences
                            && !!insertAt(consumed, next)
                            && !insertAt(consumed, next).burnCopy)
                            ? 'keep'
                            : (decideLock(next) ? 'keep' : 'burnTail');
                }
                else if (aheadMissing()) mode = 'burn';
                else break;
                if (root.__RC_TRACE) console.log(`[RC] 链位 consumed=${consumed} next=${nameOf(next)} mode=${mode} carrier=${carrier ? nameOf(carrier) : '无'} held=[${held.map(nameOf).join('、')}]`);
                // 收尾段前锁满（3 条目标已锁）不再等锚点，直接链位吃
                const tailStage = held.length >= K - 1;
                // 已在等锚点紫：
                //   keep → 只等锚点到场；
                //   burn → 空锁/少锁阶段继续用「锚点之前的毁脉点」推进链（烧到目标副本为止）
                if (anchorPurple != null && !s.talents.includes(anchorPurple)) {
                    // 中间链位也属于固定倒插链，不能在别的载体上提前烧掉。
                    // 必须等当前场序重新扫描出的锚点及最近冲突成立。
                    if (!tailStage) return acted ? 'acted' : 'none';
                }
                // ★ 靠后优先：后面还有可用锚点 → 不在链位上吃目标。
                //   链位（毁脉点）只做连续置换+毁脉；目标留到后面的锚点再插（省丹）。
                if (mode === 'keep' && !tailStage && anchorPurple == null) {
                    // ★ 倒插锚点（insertMap 优先）：当前目标的锚点 = 原始脉里要插到的那条紫
                    const im = insertAt(consumed, next);
                    if (root.__RC_TRACE && !im) {
                        console.log(`[RC][map-miss] consumed=${consumed} next=${nameOf(next)} ` +
                            `keys=${insertMap.map(item => `${item.idx}:${item.target}`).join('/')}`);
                    }
                    const thisAnchor = im ? Number(im.anchor) : planAnchorId;
                    const thisAnchorIsPity = !!(im && im.anchorIsPity);
                    const thisAnchorNo = im && thisAnchorIsPity ? Number(im.anchorNo) || 0 : 0;
                    const thisAnchorOrdinal = im ? Number(im.anchorOrdinal) || 0 : 0;
                    const thisAnchorPityOrdinal = im ? Number(im.anchorPityOrdinal) || 0 : 0;
                    const thisAnchorConflictId = im
                        ? Number(im.anchorConflictId) || 0 : 0;
                    // ★ 先确认它不是保底紫：保底紫由 trackPity 现取现用洗出，不需要 defer 到锚点置换
                    const isPityTarget = (() => {
                        let ps = Object.assign({}, s, { talents: s.talents.slice() });
                        for (let k = 0; k < 450; k++) {
                            let rr = null;
                            try { rr = e.wash(ps, []); } catch (err) { break; }
                            ps = rr.state;
                            if (rr.pityPurpleId != null && Number(rr.pityPurpleId) === Number(next)) return true;
                        }
                        return false;
                    })();
                    // 连续置换的载体已经由锚点紫继承了（如 刀法→玄阳→不灭），
                    // 此时当前载体就是这条锚点血缘，不能再回头等原来的刀法。
                    const continuingAtAnchor = anchorPurple != null && from === anchorPurple;
                    const anchorAlreadyOnField = anchorPurple != null && s.talents.includes(anchorPurple);
                    if ((thisAnchor > 0 || thisAnchorIsPity) && (carrier == null || carrier !== thisAnchor)
                        && !continuingAtAnchor && !anchorAlreadyOnField
                        && !(!strictTargetOccurrences && isPityTarget)) {
                        anchorPurple = thisAnchorIsPity ? 0 : thisAnchor;
                        anchorNo = thisAnchorNo;
                        anchorPlannedWash = thisAnchorIsPity
                            ? Number(im && im.anchorWash) || 0 : 0;
                        anchorOrdinal = thisAnchorOrdinal;
                        anchorIsPity = chainIsFull && thisAnchorIsPity;
                        anchorPityOrdinal = thisAnchorPityOrdinal;
                        anchorConflictId = thisAnchorConflictId;
                        anchorReached = false;
                        if (typeof console !== 'undefined' && root.__RC_TRACE) {
                            console.log(`[RC] keep候选 ${nameOf(next)} @${washes}洗 ` +
                                `C#${Number((im && im.idx) != null ? Number(im.idx) + 1 : consumed + 1)} ` +
                                `→ defer 到锚点 ${nameOf(thisAnchor)}#${thisAnchorNo} ` +
                                `mapAnchorNo=${im ? Number(im.anchorNo) || 0 : 0} ` +
                                `（链位=${carrier ? nameOf(carrier) : '无'}毁掉）`);
                        }
                        return 'defer';
                    }
                    const scanLimit = pityPrelude ? lead : 450;
                    const win = scanWindowPairs(scanLimit, 0, pr =>
                        !!pr.purple && !reservedAnchors.has(Number(pr.purple.id)))[0] || null;
                    if (win) {
                        anchorPurple = win.purple.id;   // 靠后的锚点（窗口里第一条可毁的、非预留的紫）
                        anchorNo = Number(win.purple.no) || 0;
                        anchorPlannedWash = Number(win.purple.wash) || 0;
                        anchorOrdinal = Number(win.purple.ordinal) || 0;
                        anchorIsPity = chainIsFull && !!win.purple.pity;
                        anchorPityOrdinal = Number(win.purple.pityOrdinal) || 0;
                        anchorConflictId = win.conflict ? Number(win.conflict.id) || 0 : 0;
                        anchorReached = false;
                        if (typeof console !== 'undefined' && root.__RC_TRACE) {
                            console.log(`[RC] keep候选 ${nameOf(next)} @${washes}洗 窗口=${nameOf(win.purple.id)}@${win.purple.offset} 冲突${win.conflict ? nameOf(win.conflict.id) : '无'} → defer`);
                        }
                        return 'defer';
                    }
                }
                // ★ 烧脉 = 连续置换，只看欧气链 + 场上载体，不看原始脉序（原始脉序是倒插锚点用的，不是烧脉用的）
                // 载体：继承上一次换出的结果；keep/burn 用锚点紫（毁脉点）
                let from = carrier;
                let pos = from != null ? s.talents.indexOf(from) : -1;
                // 只有同一个倒插锚点上的连续置换，才允许载体暂时等待冲突预载。
                // 普通换锚路线仍保持原逻辑：载体当前不可置换就跳过。
                if (pos >= 0) {
                    const currentMapped = chainIsFull && consumed > 0
                        ? insertAt(consumed - 1, chain[consumed - 1]) : null;
                    const nextMapped = chainIsFull
                        ? insertAt(consumed, chain[consumed]) : null;
                    const sameAnchorLineage = !!(currentMapped && nextMapped
                        && Number(currentMapped.anchor) === Number(nextMapped.anchor)
                        && !!currentMapped.anchorIsPity === !!nextMapped.anchorIsPity);
                    if (!sameAnchorLineage
                        && !e.replaceablePositions(s, keepIds()).includes(pos)) {
                        carrier = null;
                        pos = -1;
                    }
                }
                // 非目标链位本身就是这一段要烧掉的载体。它刚在原始脉序出现时，
                // 必须优先由它发起置换，不能先抓场上的其他紫：
                // 7314 的 C#2 天人合一若被术绍岐黄抢先当载体，置换结果就不会推进链游标。
                if (pos < 0 && !TG.includes(Number(next)) && s.talents.includes(Number(next))) {
                    from = Number(next);
                    pos = s.talents.indexOf(from);
                }
                if (pos < 0 && anchorPurple != null && s.talents.includes(anchorPurple)) {
                    from = anchorPurple;
                    pos = s.talents.indexOf(from);
                }
                if (pos < 0) {
                    const locks = keepIds();
                    const reps = e.replaceablePositions(s, locks).filter(ix => {
                        const id = Number(s.talents[ix]);
                        if (id === 251 || held.includes(id)) return false;
                        if (conflicts.some(c => c.id === id)) return false;
                        if (anchorPurple != null && id === anchorPurple) return false;   // 锚点留给吃目标
                        return true;
                    });
                    if (!reps.length) break;
                    pos = reps[0];
                    from = Number(s.talents[pos]);
                }
                // 目标紫正好在选定锚点上出现：这是“自然拿到”的目标，
                // 直接锁住并结束本段，不能再把它自己置换一次。
                if (mode === 'keep' && anchorPurple != null
                    && Number(from) === Number(anchorPurple)
                    && Number(next) === Number(anchorPurple)
                    && s.talents.includes(next)) {
                    if (!held.includes(next)) held.push(next);
                    pushStep({ type: 'lock', id: next, washes, cost, atAnchor: true });
                    anchorPurple = null;
                    anchorIsPity = false;
                    anchorPityOrdinal = 0;
                    anchorReached = false;
                    anchorConflictId = 0;
                    carrier = null;
                    releaseAllConflicts(releaseSeedTarget || !!p.releaseAllConflictsOnKeep);
                    return 'kept';
                }
                // ★ 载体紫1在预载期间保持锁定（不能解锁换走），预载完再放开给置换
                const origCarrier = carrier;
                carrier = from;
                const conflictsBeforePreload = new Set(conflicts.map(c => Number(c.id)));
                // 预载：载体紫1自己的冲突脉（神脉免预载）
                const cTy = e.talentType(from);
                if (!e.isShenmai(from)
                    && !conflicts.some(c => e.talentType(c.id) === cTy && conflictCanLinkNext(c))) {
                    const pre = preloadConflict(cTy, from);
                    if (root.__RC_TRACE) {
                        console.log(`[RC][continuous-preload] from=${nameOf(from)} pos=${pos} ` +
                            `type=${cTy} pre=${pre == null ? 'null' : (pre < 0 ? pre : nameOf(pre))} ` +
                            `field=[${s.talents.map(nameOf).join('、')}]`);
                    }
                    if (pre === -1) { carrier = origCarrier; return 'bail'; }
                    if (pre === -2 || pre == null) {
                        carrier = origCarrier;
                        rollbackPreloadedConflicts(conflictsBeforePreload);
                        break;
                    }
                }
                // ★ 锁紫2冲突 = 为了置换紫2；仅当紫2会被连续置换（紫3=chain[consumed+1] 非目标）才预载
                const following = chain[consumed + 1];
                const currentMapped = insertAt(consumed, next);
                const followingMapped = following != null
                    ? insertAt(consumed + 1, following) : null;
                const continuesMappedAnchor = !!(currentMapped && followingMapped
                    && Number(currentMapped.anchor) === Number(followingMapped.anchor)
                    && !!currentMapped.anchorIsPity === !!followingMapped.anchorIsPity);
                if (mode !== 'keep' && !e.isShenmai(next)
                    && !conflicts.some(c => e.talentType(c.id) === e.talentType(next))
                    && following != null && !TG.includes(Number(following))) {
                    const pre = preloadConflict(e.talentType(next), from, continuesMappedAnchor);
                    if (pre === -1) { carrier = origCarrier; return 'bail'; }
                    if (pre === -2 || pre == null) {
                        carrier = origCarrier;
                        rollbackPreloadedConflicts(conflictsBeforePreload);
                        break;
                    }
                }
                carrier = origCarrier;
                // 预载冲突可能改变载体在场上的序号，必须重新定位。
                pos = s.talents.indexOf(Number(from));
                // 锁定后低阶脉可能随反复洗髓漂到载体后面；游戏不会替玩家换位，
                // 因此这里必须按真实场序判定，不能为了链路通过而偷偷交换两格。
                const locks = keepIds();
                if (pos < 0 || !e.replaceablePositions(s, locks).includes(pos)) {
                    if (typeof console !== 'undefined' && root.__RC_TRACE) {
                        console.log(`[RC] 链断: pos=${pos} from=${nameOf(from)} locks=[${locks.map(nameOf).join('、')}] field=[${s.talents.map(nameOf).join('、')}]`);
                    }
                    // 预载冲突只是为了下一手置换；若载体最终仍不可置换，
                    // 这次预载立即失效，不能把冲突锁留到 260 手超时。
                    rollbackPreloadedConflicts(conflictsBeforePreload);
                    releaseUnneededConflicts();
                    break;
                }
                const fieldBefore = new Set(s.talents.map(Number).filter(x => x !== from));
                if (root.__RC_TRACE) {
                    console.log(`[RC][before-exchange] from=${nameOf(from)} pos=${pos} ` +
                        `field=[${s.talents.map(nameOf).join('、')}] ` +
                        `locks=[${locks.map(nameOf).join('、')}]`);
                }
                // 普通紫只能使用场序中紧邻它前方的同类型低阶冲突脉。
                // 这条检查同时覆盖严格锚点和普通执行，禁止用更远的低阶脉凑置换。
                if (!e.isShenmai(from) && !usesNearestConflict(e, s, from, locks)) {
                    if (root.__RC_TRACE) {
                        const nearest = nearestConflictBefore(e, s, from);
                        console.log(`[RC] 冲突顺序不成立: carrier=${nameOf(from)} ` +
                            `nearest=${nearest ? nameOf(nearest.id) : '无'} ` +
                            `locks=[${locks.map(nameOf).join('、')}]`);
                    }
                    rollbackPreloadedConflicts(conflictsBeforePreload);
                    releaseUnneededConflicts();
                    break;
                }
                // 即使目标出现位置是严格的，置换结果也必须由真实 e.replace 产生。
                // 直接删载体再塞目标会绕过“同类低阶冲突必须在载体前面”的硬规则。
                const exact = strictTargetOccurrences
                    ? exchangeToExact(from, next, locks)
                    : null;
                const replaceLocks = exact ? exact.locks : locks;
                const r = exact ? exact.result : e.replace(s, pos, replaceLocks);
                if (!r) break;
                if (!exact && strictTargetOccurrences && Number(r.addedId) !== Number(next)) {
                    if (root.__RC_TRACE) {
                        console.log(`[RC] 严格锚点不成立：${nameOf(from)} → ${nameOf(r.addedId)}， ` +
                            `目标链位要求 ${nameOf(next)} @${washes}手`);
                    }
                    break;
                }
                s = r.state; exchanges++;
                const added = Number(r.addedId);
                advanceConsumed(added, fieldBefore);
                let continueAnchorLineage = false;
                if (from === anchorPurple) {
                    if (e.isShenmai(from) && fallbackShenLocks.size) {
                        for (const id of Array.from(fallbackShenLocks)) {
                            fallbackShenLocks.delete(id);
                            pushStep({
                                type: 'unlockShenConflict', id, washes, cost,
                                why: '非目标神脉互冲已完成',
                                fieldNo: fallbackShenFieldNos.get(Number(id)) || 0,
                            });
                        }
                    }
                    const missNow = missing();
                    for (let i = consumed; i < chain.length && i <= chainEnd; i++) {
                        const pendingTarget = Number(chain[i]);
                        if (!missNow.includes(pendingTarget)) continue;
                        const mapped = insertAt(i, pendingTarget);
                        if (mapped) {
                            continueAnchorLineage = !chainIsFull && (anchorIsPity
                                ? !!(mapped.anchorIsPity
                                    && Number(mapped.anchorPityOrdinal) === Number(anchorPityOrdinal))
                                : !mapped.anchorIsPity
                                    && Number(mapped.anchorNo) === Number(anchorNo));
                        }
                        break;
                    }
                    // 分组倒插：多个链位可以故意分到同一个物理锚点，
                    // 第一次换完后继续在换果上做连续置换。
                    if (!continueAnchorLineage && chainIsFull && consumed < chain.length) {
                        const nextMap = insertAt(consumed, chain[consumed]);
                        const currentMap = consumed > 0
                            ? insertAt(consumed - 1, chain[consumed - 1]) : null;
                        const sameMappedAnchor = !!(nextMap && currentMap
                            && Number(nextMap.anchor) === Number(currentMap.anchor));
                        if (root.__RC_TRACE) {
                            console.log(`[RC][anchor-lineage] from=${nameOf(from)} ` +
                                `anchor=${nameOf(anchorPurple)} consumed=${consumed} ` +
                                `current=${currentMap ? Number(currentMap.anchor) : 0} ` +
                                `next=${nextMap ? Number(nextMap.anchor) : 0} ` +
                                `same=${sameMappedAnchor} pity=${!!nextMap && !!nextMap.anchorIsPity}/${!!anchorIsPity}`);
                        }
                        if (nextMap && (sameMappedAnchor
                            || Number(nextMap.anchorNo) === Number(anchorNo))
                            && !!nextMap.anchorIsPity === !!anchorIsPity) {
                            continueAnchorLineage = true;
                        }
                    }
                    // 同一载体连续烧 玄阳→不灭 时，锚点血缘跟着载体走；
                    // 正式目标落地后才真正释放锚点。
                    // 正式目标落地就结束这一段；只有后面接着烧中间脉时，
                    // 才把锚点血缘交给中间脉载体。
                    anchorPurple = mode === 'burn' && continueAnchorLineage ? added : null;
                    anchorIsPity = false;
                    anchorPityOrdinal = 0;
                }
                if (mode === 'keep') {
                    held.push(added);
                    pushStep(Object.assign({ type: 'exchange', from, to: added, washes, cost }, { replaceLocks: replaceLocks.slice() }));
                    carrier = null;
                    // 释放首次换果的倒插路线在换到链目标后立即清空冲突，
                    // 与“锁目标后开四槽、继续天然/倒插”的参考操作一致。
                    releaseAllConflicts(releaseSeedTarget || !!p.releaseAllConflictsOnKeep);
                    // 置换拿到目标时立即开四槽，不能为了触发开槽再空洗一手。
                    if (zi === 153 && held.length >= openFourthAfterTargets && held.length < K) {
                        zi = 154; e = engineOf(raw, zi);
                        s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                        pushStep({ type: 'upgrade', toZi: 154, washes, cost });
                    }
                    return 'kept';
                }
                burns++;
                pushStep(Object.assign({ type: 'burn', from, to: added, washes, cost }, { replaceLocks: replaceLocks.slice() }));
                carrier = continueAnchorLineage ? added : null;
                // ★ 毁脉分配规则（用户口径）：
                //   优先从前往后，能连续置换就尽量连续置换；只有当「毁脉锚点数 > 需要毁的脉数」时才枚举分配。
                //   这里 carrier 继承上一跳（连续置换），freeSlots<3 才停 → 已经是「从前往后 + 连续置换」。
                // 连续置换必须始终留出 3 个可洗槽（冲突、载体、下一洗）。
                // 已锁目标后只剩两槽时，本锚点仍可完成这一次置换，但不能
                // 把换果继续当载体原地连换。典型：于小雪 8# 已锁岿然+术绍。
                if (freeSlots() < 3) { carrier = null; break; }
                releaseUnneededConflicts();
                acted = true;
            }
            return acted ? 'acted' : 'none';
        };

        // —— 定种子段：重放 seedOpt.steps（含前缀空洗/开槽重掷/锁冲突/锁载体/垫洗/置换）——
        if (seedOpt && seedOpt.kind === 'exchange' && seedOpt.steps) {
            for (const stp of seedOpt.steps) {
                const target = Number(stp.washes) || 0;
                let dw = Math.max(0, target - washes);
                if (dw > 0) {
                    const lockIds = (stp.locks || []).slice();
                    for (let k = 0; k < dw; k++) {
                        const keep = lockIds.map(id => s.talents.indexOf(id)).filter(i => i >= 0);
                        if (keep.length !== lockIds.length) return bail('定种子段锁脉丢失');
                        const r = e.wash(s, keep);
                        s = r.state; cost += Number(r.cost) || 0; washes++;
                        notePurpleEvents(r);
                        // ★ 定种子之前的保底紫不属于本链（链从定种子时刻起算），不推进 consumed
                    }
                }
                if (stp.type === 'upgrade' && zi === 153 && Number(stp.toZi) >= 154) {
                    zi = 154; e = engineOf(raw, zi);
                    s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                    pushStep(Object.assign({}, stp, { washes, cost }));
                } else if (stp.type === 'lockConflict') {
                    conflicts.push({ id: Number(stp.id), since: washes, source: 'exchange' });
                    pushStep(Object.assign({}, stp, { washes, cost }));
                } else if (stp.type === 'lockCarrier') {
                    carrier = Number(stp.id);
                    pushStep(Object.assign({}, stp, { washes, cost }));
                } else if (stp.type === 'exchange') {
                    const pos = s.talents.indexOf(Number(stp.from));
                    const locks = (stp.locks || []).slice();
                    if (pos < 0 || !e.replaceablePositions(s, locks).includes(pos)) return bail('定种子置换不可达');
                    const r = e.replace(s, pos, locks);
                    s = r.state; exchanges++;
                    pushStep(Object.assign({ type: 'exchange', from: stp.from, to: Number(r.addedId), washes, cost, first: true, n: seedOpt.n }, { replaceLocks: locks.slice() }));
                    const added = Number(r.addedId);
                    // consumed 初始 = 1（定种子已吃掉链[0]），不再推进
                    if (releaseSeedTarget && TG.includes(added)) {
                        // 首次换出的目标只是定种子事件；倒插/后续脉序还能重捕时，
                        // 这里不占最终槽位，立即全解锁，留到后面的锚点或天然位置。
                        held.length = 0;
                        conflicts.length = 0;
                        carrier = null;
                        segLocks = [];
                        burns++;
                        pushStep({ type: 'unlockAll', washes, cost, why: '首次换果留待后段倒插/天然重捕' });
                    } else if (TG.includes(added) && (
                        Number(added) === Number(chain[0])
                        || Number(added) === Number(seedOpt.first)
                    )) {
                        // 置换得到的链首目标是“在锚点上完成插入”，不属于普通天然出现，
                        // 因此不受 strictTargetOccurrences 的“只在激活位置锁”限制。
                        held.push(added);
                        carrier = null;
                    } else if (decideLock(added)) {
                        held.push(added);
                        carrier = null;
                    } else {
                        burns++;
                        carrier = added;
                    }
                    // 定种子置换直接换出目标时，也必须在同一洗立即开四槽。
                    if (zi === 153 && held.length >= openFourthAfterTargets && held.length < K) {
                        zi = 154; e = engineOf(raw, zi);
                        s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                        pushStep({ type: 'upgrade', toZi: 154, washes, cost });
                    }
                }
            }
            releaseUnneededConflicts();
        }

        // —— 主循环：连续置换 → 置换不动 → 空洗/毁脉 + 天然锁 + 冲突预载 + 开槽重掷 ——
        // ★ 保底紫种子（跳脉/锁脉/开槽重掷）+ 第三条 Case 2（exchange 但先洗到首条保底紫）：
        //   先重放「空洗 a → 锁 lowId 洗 d → 解锁 → 洗到保底紫」，把 born 流推到种子落盘处
        const hiddenPityMap = new Map();   // 间隙前一条脉 id → { target, wash }（隐藏保底紫目标 + simulate 精确手数）
        if (isPityCase || pityPrelude) {
            const preA = Math.max(0, Number(seedOpt.a) || 0);
            const preD = Math.max(0, Number(seedOpt.d) || 0);
            const preLow = Number(seedOpt.lowId) || 0;
            // ★ 开4槽位置：锁脉 Route2 是「空洗 openFourAt → 开4槽 → 再空洗 (a - openFourAt) → 锁 lowId 洗 d」
            const openAt = seedOpt.openFour ? Math.max(0, Math.min(preA, Number(seedOpt.openFourAt) || 0)) : 0;
            const prefixWashCount = seedOpt.openFour ? openAt : preA;
            for (let i = 0; i < prefixWashCount; i++) {
                const r = e.wash(s, []);
                s = r.state;
                cost += Number(r.cost) || 0;
                washes++;
            }
            if (prefixWashCount > 0) {
                pushStep({
                    type: 'preludeWash', count: prefixWashCount, slots: zi >= 154 ? 4 : 3,
                    washes, cost,
                });
            }
            // ★ 锁脉法第二条路线：空洗 openFourAt 后开第 4 槽（bornSeed 变、保底紫约推后 50 条）
            if (seedOpt.openFour && zi < 154) {
                zi = 154; e = engineOf(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                pushStep({ type: 'upgrade', toZi: zi, washes, cost });
            }
            const postOpenCount = seedOpt.openFour ? Math.max(0, preA - openAt) : 0;
            for (let i = 0; i < postOpenCount; i++) {
                const r = e.wash(s, []);
                s = r.state;
                cost += Number(r.cost) || 0;
                washes++;
            }
            if (postOpenCount > 0) {
                pushStep({
                    type: 'preludeWash', count: postOpenCount, slots: zi >= 154 ? 4 : 3,
                    washes, cost,
                });
            }
            // ★ 锁 preLow 洗 preD：和 planLockShiftRoutes 的 scanLock 一致——锁在场上就锁着洗、不在就裸洗，但一定洗 preD 下
            const canLockPreLow = !!(preLow && s.talents.includes(preLow));
            if (canLockPreLow) {
                pushStep({ type: 'seedLock', id: preLow, washes, cost });
            }
            const lockWashStart = washes;
            for (let i = 0; i < preD; i++) {
                const keep = preLow && s.talents.includes(preLow) ? [s.talents.indexOf(preLow)] : [];
                const r = e.wash(s, keep); s = r.state; cost += Number(r.cost) || 0; washes++;
                notePurpleEvents(r);
                if (s.luckSeed != null) break;   // 锁着锁着就出保底了
            }
            const lockWashCount = washes - lockWashStart;
            if (lockWashCount > 0) {
                const lockStep = canLockPreLow
                    ? { type: 'seedLockWash', id: preLow, count: lockWashCount, washes, cost, locks: [preLow] }
                    : { type: 'preludeWash', count: lockWashCount, slots: zi >= 154 ? 4 : 3, washes, cost };
                pushStep(lockStep);
                if (canLockPreLow) lockStep.locks = [preLow];
            }
            if (canLockPreLow) {
                pushStep({ type: 'seedUnlock', id: preLow, washes, cost });
            }
            // ★ 在「锁脉后、保底紫落盘前」这个 born 序列固定态扫一次隐藏保底紫
            if (root.AutoWash2SeedPlanner && typeof root.AutoWash2SeedPlanner.findHiddenPities === 'function') {
                const rawScan = Object.assign({}, raw, {
                    zizhi: zi, seed: s.bornSeed, born_talent_rc: s.bornRC,
                    luck_seed: s.luckSeed == null ? 0 : s.luckSeed, luck_seed_inited: s.luckSeed != null,
                    tal_lucky: s.talLucky, talents: s.talents.map(id => ({ id, locked: false })),
                });
                try {
                    const hid = root.AutoWash2SeedPlanner.findHiddenPities(rawScan, { zizhi: zi, threshold: 820, limit: 8 });
                    for (const f of (hid.findings || [])) {
                        for (const h of (f.hidden || [])) {
                            if (TG.includes(Number(h.id))) hiddenPityMap.set(Number(f.from.id), { target: Number(h.id), wash: Number(h.wash) || 0 });
                        }
                    }
                } catch (err) { /* 忽略 */ }
            }
            const pityWaitStart = washes;
            let pguard = 0;
            while (s.luckSeed == null && pguard++ < 2000) {
                // ★ 洗到保底紫要保留已锁目标（纯天然/初始锁定目标时 keepIds=held，不能全解锁洗掉）
                const keep = keepIds().map(id => s.talents.indexOf(id)).filter(i => i >= 0);
                const r = e.wash(s, keep); s = r.state; cost += Number(r.cost) || 0; washes++;
                notePurpleEvents(r);
            }
            const pityWaitCount = washes - pityWaitStart;
            if (pityWaitCount > 0) {
                pushStep({
                    type: 'washToPity', count: pityWaitCount,
                    firstPurple: Number(seedOpt.first) || Number(chain[0]) || 0,
                    washes, cost,
                });
            }
            consumed = 1;   // 种子已由保底紫落盘吃掉链[0]（首条保底紫）
            // ★ 保底紫（链[0]）若是目标 → 直接锁上（锁脉定种的保底紫，不置换；岿然顶天就是）
            const firstPityId = Number(seedOpt.first) || Number(chain[0]) || 0;
            if (typeof console !== 'undefined' && root.__RC_TRACE) {
                console.log(`[RC] 前奏后场上=[${s.talents.map(nameOf).join('、')}] 首条保底=${nameOf(firstPityId)} luckSeed=${s.luckSeed}`);
            }
            if (firstPityId && TG.includes(firstPityId) && s.talents.includes(firstPityId) && !held.includes(firstPityId)) {
                held.push(firstPityId);
                pushStep({ type: 'lock', id: firstPityId, washes, cost, pitySeed: true });
            }
        }
        let guard = 0;
        while (guard++ < maxWash * 2 && washes < maxWash) {
            if (held.length >= K) break;
            if (budget > 0 && cost > budget) return bail('超预算');
            if (headBudget > 0 && held.length < K - 1 && cost > headBudget) {
                return bail(`收尾前操作超可用上限（总预算 ${budget}，收尾预留 ${budget - headBudget}）`);
            }
            if (bestCost > 0 && cost >= bestCost) return bail('达到当前最优，不再重复展开');
            // 纯锁吞脉法不走置换；exchange（含第三条）走连续置换
            if (!isPityCase) {
            const res = runExchangeChain();
            if (res === 'bail') return bail('预载超预算');
            if (res === 'defer') {
                // 目标留到后面的锚点：毁掉链位（全解锁，链位载体随洗随走）→ 全解锁空洗，
                // 等天然目标落锁后再扫窗口锁锚点（对齐实测的空洗段）
                deferredAt = held.length;
                carrier = null;
                releaseAllConflicts();
                nextScanAt = 0;
                // 不 continue：让下面的空洗/窗口逻辑接管
            } else if (res === 'kept') { if (held.length >= K) break; continue; }
            else if (res === 'acted') { continue; }
            }
            for (const c of conflicts.slice()) {
                if (washes - c.since > conflictTtl) {
                    pushStep({ type: 'unlockConflict', id: c.id, washes, cost, why: '超时' });
                    conflicts.splice(conflicts.indexOf(c), 1);
                }
            }
            segLocks = keepIds();
            const r = washOne();
            lockField();
            // ★ 隐藏保底紫挤间隙：锁到「间隙起点脉」后，锁住它洗到隐藏保底紫出来（simulate 给的精确手数）
            if (isPityCase && held.length >= 2 && held.length < K && hiddenPityMap.size) {
                const missNow = missing();
                for (const [fromId, info] of hiddenPityMap) {
                    if (!missNow.includes(info.target) || held.includes(info.target)) continue;
                    if (!held.includes(fromId)) continue;   // 还没锁到间隙起点脉
                    const needWash = info.wash > 0 ? info.wash : (zi >= 154 ? 900 : 855);
                    let sguard = 0;
                    while (sguard++ < needWash && !held.includes(info.target)) {
                        if (budget > 0 && cost > budget) break;
                        if (headBudget > 0 && held.length < K - 1 && cost > headBudget) break;
                        if (bestCost > 0 && cost >= bestCost) break;
                        const keep = held.map(id => s.talents.indexOf(id)).filter(i => i >= 0);
                        const rr = e.wash(s, keep); s = rr.state; cost += Number(rr.cost) || 0; washes++;
                        if (s.talents.includes(info.target)) {
                            held.push(info.target);
                            pushStep({ type: 'lock', id: info.target, washes, cost, hiddenPity: true });
                            break;
                        }
                    }
                    if (held.includes(info.target)) break;
                }
            }
            // 锁到天然目标立即开 4 槽（实测：锁玄阳→开槽→再洗，省丹）
            if (zi === 153 && held.length >= openFourthAfterTargets && held.length < K) {
                zi = 154; e = engineOf(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                pushStep({ type: 'upgrade', toZi: 154, washes, cost });
            }
            if (held.length >= K) break;
            if (budget > 0 && cost > budget) return bail('超预算');
            if (headBudget > 0 && held.length < K - 1 && cost > headBudget) {
                return bail(`收尾前操作超可用上限（总预算 ${budget}，收尾预留 ${budget - headBudget}）`);
            }
            if (bestCost > 0 && cost >= bestCost) return bail('达到当前最优，不再重复展开');
            // 锚点之前还有要天然落锁的目标 → 不锁冲突（等天然目标全锁再扫窗口）
            const inDeferredWait = anchorPurple != null && !anchorIsPity && naturalsPending();
            // 冲突锁定：无锚点 → lead 前瞻；锚点模式不在这里锁（交给窗口扫描直接锁最近的那条，不换锁）
            const lows = (r.generatedEvents || [])
                .map(ev => Number(ev.id))
                .filter(id => id !== 251 && e.quality(id) < 4
                    && !held.includes(id)
                    && !conflicts.some(c => c.source === 'exchange'
                        && e.talentType(c.id) === e.talentType(id)));
            if (lows.length && aheadMissing() && !inDeferredWait) {
                if (anchorPurple == null) {
                    // 无锚点：只锁全脉序预扫已经选中的“最近冲突脉”。
                    // 当前低阶只是备选时不能提前锁。
                    for (const id of lows) {
                        if (plannedConflictIds.has(Number(id))) {
                            const nextPurple = scanSeq.find(item =>
                                Number(item.wash) > washes
                                && talentType(item.id) === talentType(id));
                            const off = nextPurple
                                ? Number(nextPurple.wash) - washes : 0;
                            conflicts.push({ id, since: washes, source: 'exchange' });
                            pushStep({ type: 'lockConflict', id, washes, cost, expectIn: off });
                            break;
                        }
                    }
                }
                // 锚点模式：不在这里锁（交给窗口扫描直接锁最近的那条，不换锁）
            }
            const atNaturalChainExit = anchorReached && lastPurpleEvent
                && consumed < chain.length
                && Number(lastPurpleEvent.id) === Number(chain[consumed]);
            if (aheadMissing() && conflicts.length === 0 && carrier == null
                && nextScanAt <= washes && !inDeferredWait
                && !anchorIsPity
                && !atNaturalChainExit) {
                const locked = lockConflictByScan();
                if (budgetBail2) return bail('窗口扫描超预算');
                nextScanAt = washes + (locked ? 60 : 30);
            }
            if (zi === 153 && held.length >= openFourthAfterTargets && held.length < K) {
                zi = 154; e = engineOf(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                pushStep({ type: 'upgrade', toZi: 154, washes, cost });
            }
        }
        const ok = TG.every(id => held.includes(id) && s.talents.includes(id));
        if (ok && bestCost > 0 && cost >= bestCost) {
            return bail('达到当前最优，不再重复展开');
        }
        return {
            ok, cost, washes, exchanges, burns,
            field: s.talents.slice(), held: held.slice(), steps,
            missing: TG.filter(id => !held.includes(id)),
            pityEvents: pityEvents.slice(),
            initialField: initialFieldView.map(item =>
                Object.assign({}, item, { source: `场上#${item.fieldNo}` })),
            params: { zi: seedOpt.zi, n: seedOpt.n, lead: seedOpt.lead, M, tailTarget },
        };
    }

    // 从落盘种子抽取欧气链（DRAW）
    function queueOf(raw, zi, seed, count) {
        const e = engineOf(raw, zi);
        let luck = Number(seed) || 0;
        const out = [];
        for (let i = 0; i < 4000 && out.length < count; i++) {
            let id;
            try { [id, luck] = e.draw(luck, true); } catch (err) { break; }
            if (e.allowed.has(id)) out.push(Number(id));
        }
        return out;
    }

    // 回放「跳脉/锁脉」路线的步骤表（{wash, lockIds, count} / {upgrade, zi}）
    function replayLockSteps(raw, targets, steps, zi0) {
        const TG = (targets || []).map(Number);
        let zi = Number(zi0) >= 150 ? Number(zi0) : 153;
        let e = engineOf(raw, zi);
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let cost = 0, washes = 0;
        for (const st of (steps || [])) {
            if (st.type === 'wash') {
                const lockIds = (st.lockIds || []).slice();
                for (let k = 0; k < Math.max(0, Number(st.count) || 0); k++) {
                    const keep = lockIds.map(id => s.talents.indexOf(id)).filter(i => i >= 0);
                    if (keep.length !== lockIds.length) return { ok: false, reason: '锁脉丢失' };
                    const r = e.wash(s, keep);
                    s = r.state; cost += Number(r.cost) || 0; washes++;
                }
            } else if (st.type === 'upgrade' && Number(st.zi) >= 154 && zi < 154) {
                zi = 154; e = engineOf(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
            }
        }
        const ok = TG.every(id => s.talents.includes(id));
        return { ok, cost, washes, field: s.talents.slice(), reason: ok ? '' : '终态缺目标' };
    }

    /**
     * 锁脉路线执行（保底写种子）：前奏（空洗 a → 锁低阶脉 → 洗 d → 解锁）→ 洗到首条保底紫
     * → 事件驱动：天然/保底目标出现即锁，非目标保底毁掉；3 锁后开 4 槽；洗到四目标齐。
     */
    function executeLockRoute(raw, targets, r, opts) {
        const p = opts || {};
        const TG = (targets || []).map(Number);
        const budget = Math.max(0, Number(p.budget) || 0);
        const bestCost = Math.max(0, Number(p.bestCost) || 0);
        const maxWash = Math.max(500, Number(p.maxWash) || 4000);
        let zi = 153;
        let e = engineOf(raw, zi);
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let cost = 0, washes = 0, firstPity = null;
        const held = [];
        const steps = [];
        const washN = (n, locks) => {
            for (let i = 0; i < n; i++) {
                if (budget > 0 && cost > budget) return false;
                if (bestCost > 0 && cost >= bestCost) return false;
                const keep = locks.map(id => s.talents.indexOf(id)).filter(x => x >= 0);
                const rr = e.wash(s, keep);
                s = rr.state; cost += Number(rr.cost) || 0; washes++;
                if (rr.pityPurpleId != null && firstPity == null) firstPity = { id: rr.pityPurpleId, w: washes, seed: s.luckSeed };
            }
            return true;
        };
        // 前奏
        if (!washN(Number(r.a) || 0, [])) return { ok: false, note: '前奏超预算' };
        const lowId = Number(r.lowId);
        if (!s.talents.includes(lowId)) return { ok: false, note: `前奏后场上没有 ${nameOf(lowId)}` };
        if (!washN(Number(r.d) || 0, [lowId])) return { ok: false, note: '锁洗超预算' };
        steps.push({ type: 'prelude', a: r.a, lowId, d: r.d, washes, cost });
        // 洗到首条保底紫
        for (let k = 0; k < maxWash && firstPity == null; k++) {
            if (!washN(1, [])) return { ok: false, note: '首保底超预算' };
        }
        if (firstPity == null) return { ok: false, note: '6000 洗内没有保底紫' };
        // 事件驱动主循环
        let guard = 0;
        while (guard++ < maxWash && held.length < TG.length) {
            if (budget > 0 && cost > budget) return { ok: false, note: '超预算', cost, washes, held: held.slice() };
            if (bestCost > 0 && cost >= bestCost) return { ok: false, note: '达到当前最优，不再重复展开', cost, washes, held: held.slice() };
            if (zi === 153 && held.length >= 3) {
                zi = 154; e = engineOf(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                steps.push({ type: 'upgrade', toZi: 154, washes, cost });
                continue;
            }
            // 场上天然目标锁上
            let locked = false;
            for (const id of TG) {
                if (s.talents.includes(id) && !held.includes(id)) {
                    held.push(id);
                    steps.push({ type: 'lock', id, washes, cost });
                    locked = true;
                }
            }
            if (held.length >= TG.length) break;
            // 锁满 3 条目标立即开 4 槽（不多洗一手）
            if (zi === 153 && held.length >= 3) {
                zi = 154; e = engineOf(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                steps.push({ type: 'upgrade', toZi: 154, washes, cost });
                continue;
            }
            const r2 = e.wash(s, held.map(id => s.talents.indexOf(id)).filter(i => i >= 0));
            s = r2.state; cost += Number(r2.cost) || 0; washes++;
        }
        const ok = TG.every(id => held.includes(id) && s.talents.includes(id));
        return { ok, cost, washes, field: s.talents.slice(), held: held.slice(), steps,
            firstPity, missing: TG.filter(id => !held.includes(id)) };
    }

    // 锁到保底执行器：空洗 a → 锁 lowId → 洗到保底紫（种子写定）→ 解锁 → 主循环（洗+锁天然目标+开4槽）
    //   与 executeLockRoute 的主循环完全一致——定完种子后，后续和跳脉法/正常洗保底紫没有区别。
    function executeLockToPity(raw, targets, r, opts) {
        const p = opts || {};
        const TG = (targets || []).map(Number);
        const K = TG.length;
        const budget = Math.max(0, Number(p.budget) || 0);
        const bestCost = Math.max(0, Number(p.bestCost) || 0);
        const maxWash = Math.max(500, Number(p.maxWash) || 4000);
        const a = Math.max(0, Number(r.a) || 0);
        const X = Number(r.lowId) || 0;
        let zi = 153;
        let e = engineOf(raw, zi);
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let cost = 0, washes = 0, firstPity = null;
        const held = [];
        const steps = [];
        const washN = (n, locks) => {
            for (let i = 0; i < n; i++) {
                if (budget > 0 && cost > budget) return false;
                if (bestCost > 0 && cost >= bestCost) return false;
                const keep = locks.map(id => s.talents.indexOf(id)).filter(x => x >= 0);
                const rr = e.wash(s, keep);
                s = rr.state; cost += Number(rr.cost) || 0; washes++;
                if (rr.pityPurpleId != null && firstPity == null) firstPity = { id: rr.pityPurpleId, w: washes, seed: s.luckSeed };
            }
            return true;
        };
        // ① 空洗 a
        if (!washN(a, [])) return { ok: false, note: '空洗 a 超预算', cost, washes, steps, missing: TG.slice() };
        // ② 锁 X 洗到保底紫（X 一直锁着，不中途解锁）
        if (X !== 0 && !s.talents.includes(X)) return { ok: false, note: `空洗后场上没有 ${nameOf(X)}`, cost, washes, steps, missing: TG.slice() };
        {
            let guard = 0;
            while (firstPity == null && guard++ < maxWash) {
                const locks = X !== 0 ? [X] : [];
                if (!washN(1, locks)) return { ok: false, note: '锁到保底超预算', cost, washes, steps, missing: TG.slice() };
            }
        }
        if (firstPity == null) return { ok: false, note: '锁到保底没有保底紫', cost, washes, steps, missing: TG.slice() };
        steps.push({ type: 'prelude', a, lowId: X, d: 'toPity', washes, cost });
        // ③ 解锁 X（X 不在 held 里，主循环只锁目标），主循环：洗 + 锁天然目标 + 开 4 槽
        let guard = 0;
        while (guard++ < maxWash && held.length < K) {
            if (budget > 0 && cost > budget) return { ok: false, note: '超预算', cost, washes, held: held.slice(), steps, missing: TG.filter(id => !held.includes(id)) };
            if (bestCost > 0 && cost >= bestCost) return { ok: false, note: '达到当前最优，不再重复展开', cost, washes, held: held.slice(), steps, missing: TG.filter(id => !held.includes(id)) };
            // 场上天然目标锁上
            for (const id of TG) {
                if (s.talents.includes(id) && !held.includes(id)) {
                    held.push(id);
                    steps.push({ type: 'lock', id, washes, cost });
                }
            }
            if (held.length >= K) break;
            // 锁满 3 条目标立即开 4 槽（不多洗一手）
            if (zi === 153 && held.length >= 3) {
                zi = 154; e = engineOf(raw, zi);
                s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                steps.push({ type: 'upgrade', toZi: 154, washes, cost });
                continue;
            }
            const r2 = e.wash(s, held.map(id => s.talents.indexOf(id)).filter(i => i >= 0));
            s = r2.state; cost += Number(r2.cost) || 0; washes++;
        }
        const ok = TG.every(id => held.includes(id) && s.talents.includes(id));
        return { ok, cost, washes, field: s.talents.slice(), held: held.slice(), steps,
            firstPity, missing: TG.filter(id => !held.includes(id)) };
    }

    // 独立回放验证
    function verify(raw, targets, steps, zi0) {        const TG = (targets || []).map(Number);
        let zi = Number(zi0) >= 150 ? Number(zi0) : 153;
        let e = engineOf(raw, zi);
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let cost = 0, washes = 0, prevW = 0;
        for (const st of (steps || [])) {
            const target = Number(st.washes) || 0;
            const dw = target - prevW;
            if (dw < 0) return { ok: false, reason: '步骤洗数倒退' };
            if (st.type === 'prelude') {
                // 前奏：空洗 openFourAt → 开槽 → 空洗 (a - openFourAt) → 锁 lowId 洗 d → 洗到保底紫（和 execute 前奏一致）
                const preA = Number(st.a) || 0;
                const preD = Number(st.d) || 0;
                const preLow = Number(st.lowId) || 0;
                const openAt = st.openFour ? Math.max(0, Math.min(preA, Number(st.openFourAt) || 0)) : 0;
                for (let i = 0; i < openAt; i++) { let r; try { r = e.wash(s, []); } catch (err) { return { ok: false, reason: '前奏洗髓抛错' }; } s = r.state; cost += Number(r.cost) || 0; washes++; }
                if (st.openFour && zi < 154) {
                    zi = 154; e = engineOf(raw, zi);
                    s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                }
                for (let i = openAt; i < preA; i++) { let r; try { r = e.wash(s, []); } catch (err) { return { ok: false, reason: '前奏洗髓抛错' }; } s = r.state; cost += Number(r.cost) || 0; washes++; }
                for (let i = 0; i < preD; i++) {
                    const keep = preLow && s.talents.includes(preLow) ? [s.talents.indexOf(preLow)] : [];
                    let r; try { r = e.wash(s, keep); } catch (err) { return { ok: false, reason: '前奏锁洗抛错' }; } s = r.state; cost += Number(r.cost) || 0; washes++;
                    if (s.luckSeed != null) break;
                }
                let pg = 0;
                while (s.luckSeed == null && pg++ < 2000) { let r; try { r = e.wash(s, []); } catch (err) { return { ok: false, reason: '前奏保底抛错' }; } s = r.state; cost += Number(r.cost) || 0; washes++; }
                prevW = target;
                continue;
            }
            if (dw > 0) {
                    const lockIds = (st.washLocks || st.locks || []).slice();
                for (let k = 0; k < dw; k++) {
                    const keep = lockIds.map(id => s.talents.indexOf(id)).filter(i => i >= 0);
                    if (keep.length !== lockIds.length) {
                        if (root.__RC_TRACE) {
                            console.log(`[RC][VERIFY-SEG-LOCK] @${target} ` +
                                `locks=[${lockIds.map(nameOf).join('、')}] ` +
                                `missing=[${lockIds.filter(id => !s.talents.includes(Number(id)))
                                    .map(nameOf).join('、')}] ` +
                                `field=[${s.talents.map(nameOf).join('、')}]`);
                        }
                        return { ok: false, reason: `第 ${target} 洗：段锁脉不在场` };
                    }
                    let r;
                    try { r = e.wash(s, keep); } catch (err) { return { ok: false, reason: '洗髓抛错' }; }
                    s = r.state; cost += Number(r.cost) || 0; washes++;
                }
            }
            if (st.type === 'lockConflict' || st.type === 'lockCarrier'
                || st.type === 'lock' || st.type === 'seedLock'
                || st.type === 'seedLockWash') {
                if (!s.talents.includes(Number(st.id))) {
                    if (root.__RC_TRACE) {
                        console.log(`[RC][VERIFY-FIELD] 锁 ${nameOf(st.id)} 不在场：当前=` +
                            `${s.talents.map(nameOf).join('、')} 记录=` +
                            `${(st.field || []).map(nameOf).join('、')} locks=` +
                            `${(st.locks || []).map(nameOf).join('、')}`);
                    }
                    return { ok: false, reason: `锁 ${nameOf(st.id)} 时不在场（${washes}洗）` };
                }
            } else if (st.type === 'upgrade') {
                if (zi === 153 && Number(st.toZi) >= 154) {
                    zi = 154; e = engineOf(raw, zi);
                    s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                }
            } else if (st.type === 'washToPity') {
                if (s.luckSeed == null) return { ok: false, reason: `洗到保底步骤没有写下种子（${washes}洗）` };
                if (Number(st.firstPurple) > 0 && !s.talents.includes(Number(st.firstPurple))) {
                    return { ok: false, reason: `洗到保底后没有 ${nameOf(st.firstPurple)}（${washes}洗）` };
                }
            } else if (st.type === 'exchange' || st.type === 'burn') {
                const pos = s.talents.indexOf(Number(st.from));
                if (pos < 0) return { ok: false, reason: `置换前没有 ${nameOf(st.from)}（${washes}洗）` };
                const locks = (st.replaceLocks || []).map(Number);
                if (!usesNearestConflict(e, s, Number(st.from), locks)) {
                    return {
                        ok: false,
                        reason: `置换 ${nameOf(st.from)} 未锁定其前方最近的同类型冲突脉（${washes}洗）`,
                    };
                }
                if (!e.replaceablePositions(s, locks).includes(pos)) return { ok: false, reason: `置换 ${nameOf(st.from)} 不可达（${washes}洗）` };
                let r;
                try { r = e.replace(s, pos, locks); } catch (err) { return { ok: false, reason: '置换抛错' }; }
                if (Number(r.addedId) !== Number(st.to)) return { ok: false, reason: `换出 ${nameOf(r.addedId)} ≠ 记录 ${nameOf(st.to)}（${washes}洗）` };
                s = r.state;
            }
            prevW = target;
        }
        const ok = TG.every(id => s.talents.includes(id));
        return { ok, cost, washes, state: s, zizhi: zi,
            reason: ok ? '' : '终态缺目标：' + TG.filter(id => !s.talents.includes(id)).map(nameOf).join('、') };
    }

    /**
     * 连续置换执行器（AnchorRoutePlanner.searchJumpManualRoute）的步骤兼容层。
     * 它和“定种子 → 截链 → 倒插”是两种不同路线形态：
     *   · 薛龙城 7687：864 洗前缀 → 同一载体连续置换 8 次 → 烧掉整串 → 天然重捕三个目标。
     * 这里把它的步骤转成统一 UI 能显示的格式，并记录置换锁用于独立回放。
     */
    function normalizeJumpManualRoute(route, targets) {
        if (!route || !route.ok) return null;
        const TG = (targets || []).map(Number);
        let chainBaseWashes = 0;
        let chainBaseCost = 0;
        let inExchangeChain = false;
        let lastWashes = 0;
        let lastCost = 0;
        const steps = (route.steps || []).map(step => {
            const out = Object.assign({}, step);
            // planJumpChain 的步骤洗数/丹耗从“链起点”重新从 0 计数；
            // 只对连续 exchange 这一段补链前累计值；链结束后的 unlockAll/lock
            // 已经是整条路线的绝对计数，不能再重复加偏移。
            if (step.type === 'exchange' && (inExchangeChain || Number(step.washes) < lastWashes)) {
                if (!inExchangeChain) {
                    chainBaseWashes = lastWashes;
                    chainBaseCost = lastCost;
                    inExchangeChain = true;
                }
                out.washes = Number(step.washes) + chainBaseWashes;
                out.cost = Number(step.cost) + chainBaseCost;
            } else {
                inExchangeChain = false;
                out.washes = Number(step.washes);
                out.cost = Number(step.cost);
            }
            if (step.type === 'exchange') {
                out.type = step.kept ? 'exchange' : 'burn';
                out.replaceLocks = (step.locks || []).slice();
                // 链步骤的 locks 只列“置换判定需要的冲突/目标”；洗到预载冲突期间，
                // 当前载体紫也必须一起锁着。独立回放和界面操作都补上这一条。
                out.washLocks = Array.from(new Set((step.locks || []).concat(Number(step.from) > 0 ? [Number(step.from)] : [])));
            }
            lastWashes = out.washes;
            lastCost = out.cost;
            return out;
        });
        return Object.assign({}, route, {
            ok: true,
            kind: 'jumpManual',
            TG,
            steps,
            exchanges: steps.filter(step => step.type === 'exchange').length,
            burns: steps.filter(step => step.type === 'burn').length,
            verified: false,
        });
    }

    function verifyJumpManual(raw, targets, steps, zi0) {
        const TG = (targets || []).map(Number);
        const list = steps || [];
        if (!list.length) return { ok: false, reason: '连续置换路线没有步骤' };
        let zi = Number(zi0) >= 150 ? Number(zi0) : 153;
        let e;
        try { e = engineOf(raw, zi); } catch (err) { return { ok: false, reason: '起始资质不可用' }; }
        let s = e.initialState(Object.assign({}, raw, { zizhi: zi }));
        let cost = 0, washes = 0, previousWash = 0, lastWashLocks = [];
        let activeLocks = [];
        const fail = reason => ({ ok: false, cost, washes, field: s.talents.slice(), reason });
        for (const step of list) {
            const targetWash = Number(step.washes) || 0;
            const delta = targetWash - previousWash;
            const isLockAction = step.type === 'lock' || step.type === 'lockConflict'
                || step.type === 'lockCarrier' || step.type === 'seedLock'
                || step.type === 'seedLockWash';
            if (delta < 0) return fail('连续置换路线洗数倒退');
            if (delta > 0) {
                const washLockIds = (step.washLocks || (isLockAction
                    ? (step.locks || []).filter(id => Number(id) !== Number(step.id))
                    : activeLocks)).map(Number);
                lastWashLocks = washLockIds;
                for (let i = 0; i < delta; i++) {
                    const positions = washLockIds.map(id => s.talents.indexOf(id))
                        .filter(position => position >= 0);
                    let result;
                    try { result = e.wash(s, positions); }
                    catch (err) { return fail('连续置换路线洗髓回放失败'); }
                    s = result.state;
                    cost += Number(result.cost) || 0;
                    washes++;
                }
            }
            if (step.type === 'upgrade' && zi === 153 && Number(step.toZi) >= 154) {
                zi = 154;
                try {
                    e = engineOf(raw, zi);
                    s = e.upgradeToFour(Object.assign({}, s, { zizhi: zi }));
                } catch (err) { return fail('第 4 槽升级回放失败'); }
            } else if (step.type === 'exchange' || step.type === 'burn') {
                const from = Number(step.from), to = Number(step.to);
                const position = s.talents.indexOf(from);
                const replaceLocks = (step.replaceLocks || step.locks || []).map(Number);
                if (position < 0) return fail(`第 ${targetWash} 洗：置换源脉不在场`);
                if (!usesNearestConflict(e, s, from, replaceLocks)
                    || !e.replaceablePositions(s, replaceLocks).includes(position)) {
                    return fail(`第 ${targetWash} 洗：置换条件不成立`);
                }
                let result;
                try { result = e.replace(s, position, replaceLocks); }
                catch (err) { return fail('连续置换路线置换回放失败'); }
                if (Number(result.addedId) !== to) return fail(`第 ${targetWash} 洗：置换结果不匹配`);
                s = result.state;
            } else if (isLockAction) {
                if (!s.talents.includes(Number(step.id))) {
                    return fail(`第 ${targetWash} 洗：锁定目标不在场`);
                }
            }
            if (step.type === 'unlockAll') activeLocks = [];
            else if (isLockAction) {
                activeLocks = Array.from(new Set((step.locks || activeLocks)
                    .map(Number).concat(Number(step.id) || [])));
            } else if (Array.isArray(step.locks)) activeLocks = step.locks.map(Number);
            if (Array.isArray(step.field) && step.field.length) {
                const actual = s.talents.map(Number).slice().sort((a, b) => a - b).join(',');
                const expected = step.field.map(Number).slice().sort((a, b) => a - b).join(',');
                if (actual !== expected) return fail(
                    `第 ${targetWash} 洗：回放场上脉与记录不符（锁 ${lastWashLocks.join(',')}；${actual} ≠ ${expected}）`);
            }
            if (Number.isFinite(Number(step.cost)) && Number(step.cost) !== cost) {
                return fail(`第 ${targetWash} 洗：累计丹耗与记录不符`);
            }
            previousWash = targetWash;
        }
        const field = s.talents.map(Number);
        const missing = TG.filter(id => !field.includes(id));
        return { ok: missing.length === 0, cost, washes, field, state: s, zizhi: zi,
            reason: missing.length ? '终态缺目标：' + missing.map(nameOf).join('、') : '' };
    }

    // 于小雪 12309：3# 毁一段，其余六段集中在 6# 保底锚点。
    // 该路线的金仙、玄阳由连续置换后的动态脉序产生，不能靠静态脉序预判。
    function eatFromSeed(ctx, raw, TG, seedOpt, o) {
        const budget = Math.max(0, Number(o.budget) || 0);
        const lead = Math.max(1, Number(o.lead) || 14);
        const perfStats = o.perfStats || {};
        const executeResultCache = o.executeResultCache || new Map();
        if (!o.executeResultCache) o.executeResultCache = executeResultCache;
        const stopAt = Math.max(0, Number(o.deadline) || 0);
        const expired = () => stopAt > 0 && Date.now() >= stopAt;
        let best = null;
        // 必须继承 planBest 已经找到的全局最优；若从 0 重新开始，
        // 每换一个种子都会高丹耗跑一遍，当前最优就起不到上界作用。
        let bestCost = Math.max(0, Number(o.bestCost) || 0);
        const initCnt = initialTargetCount(raw, TG);
        // ★ 无限置换的种子链看的是「推进的脉条数」，与几槽无关 —— 3 槽链、4 槽链是同一串紫脉，
        //   只是垫洗 n 的换算不同（3 槽 n 推 1 条，4 槽 n 推 2 条 → 4 槽 n=k 对应 3 槽 N=2k）。
        //   所以倒插/收尾统一用 3 槽原始脉序（ctx.seq）即可，不要另开一套 4 槽脉序。
        // 三槽中途升四槽时，倒插锚点和保底位置必须按最终四槽脉序编号。
        let cctx = ctx;
        const executionZi = seedOpt && seedOpt.openFour && Number(seedOpt.zi) < 154
            ? 154 : Number(seedOpt && seedOpt.zi);
        if (executionZi >= 154 && Number(ctx && ctx.zizhi) < 154) {
            cctx = readSequence(raw, { zi: executionZi, count: Number(o.count) || 40 });
        }
        const postOpenCtx = readSequenceAfterSeedOpenCached(
            raw, seedOpt, TG, Number(o.count) || 40, o.sequenceCache);
        // 标准无限置换的 O# 编号来自最初原始脉序。后续每次置换都会改写
        // born 流，绝不能拿“只执行到定种子”的中途扫描表替代整条原始脉序；
        // 那会把顶天一类尚未到达的收尾锚点提前编号，执行时必然对不上。
        // 只有真正重掷 born 流的吞脉/开四槽种子才使用开槽后的扫描表。
        const reseedsBornFlow = !!(seedOpt && (
            seedOpt.pityPrelude
            || seedOpt.openFour
            || Number(seedOpt.a) > 0
            || Number(seedOpt.d) > 0
            || Number(seedOpt.lowId) > 0
        ));
        if (reseedsBornFlow && postOpenCtx && postOpenCtx.seq.length) {
            cctx = postOpenCtx;
        }
        // 原始目标位置和置换链不是二选一：
        //   只对“原始脉序里确实存在”的目标枚举来源组合；其余目标只能由链补。
        //   每个组合都完整回放，实际计算锁脉、冲突、烧脉、倒插和丹耗。
        if (TG.length >= 3 && !o.anchorVariantsDone) {
            const fixWash = Number(seedOpt && seedOpt.washes) || 0;
            const naturalCandidates = TG.filter(id => (cctx.seq || []).some(p =>
                Number(p.id) === Number(id) && !p.fromPity
                && Number(p.wash) >= fixWash));
            let variantBest = null;
            let variantBound = bestCost;
            // 先用纯链模式拿到一个已验证上界，避免多重自然目标组合在
            // 首个候选处长时间展开，导致后面的搜索根本没有机会比较。
            const primary = eatFromSeed(ctx, raw, TG, seedOpt,
                Object.assign({}, o, {
                    anchorVariantsDone: true,
                    anchorMode: 'chain',
                    naturalFixedIds: [],
                    bestCost: variantBound,
                }));
            if (root.__RC_TRACE && Number(seedOpt.seed) === 286146107) {
                console.log(`[RC][primary] ok=${!!(primary && primary.ok)} ` +
                    `cost=${primary && primary.cost} note=${primary && primary.note || ''} ` +
                    `tail=${primary && primary.tailTarget ? nameOf(primary.tailTarget) : 'null'}`);
            }
            if (primary && primary.ok) {
                variantBest = primary;
                variantBound = Number(primary.cost) || 0;
            }
            const maskLimit = 1 << naturalCandidates.length;
            for (let mask = 0; mask < maskLimit; mask++) {
                if (expired()) break;
                if (mask === 0) continue;   // 空组合已经作为 primary 跑过
                const naturalFixedIds = mask
                    ? naturalCandidates.filter((id, index) => (mask & (1 << index)) !== 0)
                    : [];
                const route = eatFromSeed(ctx, raw, TG, seedOpt,
                    Object.assign({}, o, {
                        anchorVariantsDone: true,
                        anchorMode: mask ? 'combined' : 'chain',
                        naturalFixedIds,
                        bestCost: variantBound,
                    }));
                if (route && route.ok
                    && (!variantBest || route.cost < variantBest.cost)) {
                    variantBest = route;
                    variantBound = Number(route.cost) || 0;
                }
            }
            return variantBest;
        }
        // ★ 三紫（及以下）收尾脉「可选可不选」：正常收尾候选之外，再加一个 null（不要收尾）一起试
        const seedAnchorNo = Number(seedOpt && seedOpt.anchorNo) || 0;
        let tails = tailCandidates(cctx.seq, TG, initCnt, seedAnchorNo);
        if (root.__RC_TRACE && Number(seedOpt.seed) === 286146107) {
            console.log(`[RC][tails] ${tails.map(tail => tail
                ? `O#${tail.no}:${nameOf(tail.id)}@${tail.wash}`
                : 'none').join('；')}`);
        }
        if (TG.length <= 3 && !seedAnchorNo) tails.push(null);
        if (o.forcedTailNone) {
            tails = [null];
        } else if (o.forcedTailNo != null) {
            tails = tails.filter(tail => tail
                && Number(tail.no) === Number(o.forcedTailNo)
                && (!o.forcedTailId || Number(tail.id) === Number(o.forcedTailId)));
        }
        const reserveMap = o.tailReserveByTail || {};
        const observedTailReserves = o.observedTailReserves || {};
        const reserveForTail = tail => {
            const tailId = tail && Number(tail.id);
            if (tailId && reserveMap[tailId] != null) {
                return Math.max(0, Number(reserveMap[tailId]) || 0);
            }
            if (!tail || !root.AutoWash2UnifiedAnchorPlanner
                || typeof root.AutoWash2UnifiedAnchorPlanner.estimateTailCost !== 'function') {
                return Math.max(0, Number(o.tailReserve) || 0);
            }
            try {
                return Math.max(0, Number(root.AutoWash2UnifiedAnchorPlanner.estimateTailCost(
                    raw, [tail], TG.length,
                    {
                        tail,
                        scanSlots: Number(raw && raw.zizhi) >= 154 ? 4 : 3,
                        purples: cctx.seq,
                        hiddenPityWashes: o.hiddenPityWashes,
                    })) || 0);
            } catch (error) {
                return Math.max(0, Number(o.tailReserve) || 0);
            }
        };
        // 收尾下界按原始 O# 单调递增，因此候选必须按脉序检查。
        tails.sort((a, b) => {
            if (a == null) return 1;
            if (b == null) return -1;
            return (Number(a.no) || 0) - (Number(b.no) || 0);
        });
        const firstSeedTarget = Number(seedOpt.first) || Number(seedOpt.chain && seedOpt.chain[0]) || 0;
        const canReleaseSeedTarget = TG.includes(firstSeedTarget) && (
            (seedOpt.chain || []).slice(1).includes(firstSeedTarget)
            || (cctx.seq || []).some(p => Number(p.id) === firstSeedTarget
                && Number(p.wash) >= (Number(seedOpt.washes) || 0))
        );
        const releaseModes = o.forcedReleaseSeed != null
            ? [!!o.forcedReleaseSeed]
            : (canReleaseSeedTarget ? [false, true] : [false]);
        const strategyModes = [];
        for (const releaseSeed of releaseModes) {
            strategyModes.push({ releaseSeed, allowNatural: false });
            // 首次目标保留时，链上目标仍可能在原始脉序后面天然出现。
            // 楚忘归 5089 的岿然顶天就是这种分支，不能一律按链条置换。
            if (seedOpt.kind === 'exchange' && !seedOpt.pityPrelude && !releaseSeed) {
                strategyModes.push({ releaseSeed, allowNatural: true });
            }
        }
        if (o.forcedAllowNatural != null) {
            for (let i = strategyModes.length - 1; i >= 0; i--) {
                if (!!strategyModes[i].allowNatural !== !!o.forcedAllowNatural) {
                    strategyModes.splice(i, 1);
                }
            }
        }
        if (canReleaseSeedTarget) {
            strategyModes.push({ releaseSeed: true, allowNatural: true });
        }
        const tailLowerBoundCache = o.tailLowerBoundCache instanceof WeakMap
            ? o.tailLowerBoundCache : new WeakMap();
        let sequenceTailFloorCache = tailLowerBoundCache.get(cctx.seq);
        if (!sequenceTailFloorCache) {
            sequenceTailFloorCache = new Map();
            tailLowerBoundCache.set(cctx.seq, sequenceTailFloorCache);
        }
        // 链上含神脉时，锚点容量和落点由实际锁定顺序动态决定；
        // 静态三锚点下界会高估（籍陈 O#6 曾误杀 O#7 的 2333 丹路线）。
        const shenEngine = engineOf(raw, Number(seedOpt.zi) >= 150 ? Number(seedOpt.zi) : 153);
        const hasDynamicShenAnchor = (seedOpt.chain || []).slice(0, 15)
            .some(id => shenEngine.isShenmai(Number(id)));
        let tailBudgetExhausted = false;
        for (const tail of tails) {
            if (expired() || tailBudgetExhausted) break;
            if (tail && budget > 0) {
                const floorKey = `${Number(tail.no) || 0}:${Number(tail.id) || 0}`;
                let lowerBound = sequenceTailFloorCache.get(floorKey);
                if (lowerBound === undefined) {
                    perfStats.tailFloorChecks = (Number(perfStats.tailFloorChecks) || 0) + 1;
                    lowerBound = estimateTailLowerBound(raw, cctx, TG, tail);
                    sequenceTailFloorCache.set(floorKey, lowerBound);
                }
                const seedCost = Number(seedOpt && seedOpt.cost);
                const floorTotal = lowerBound && Number.isFinite(seedCost)
                    ? Math.max(0, seedCost) + Number(lowerBound.cost) : null;
                if (!hasDynamicShenAnchor && floorTotal != null
                    && (floorTotal > budget || bestCost > 0 && floorTotal >= bestCost)) {
                    // 下界按原始 O# 单调递增；当前位置已超限，
                    // 它后面的所有收尾只会更贵，直接停止本轮收尾扫描。
                    tailBudgetExhausted = true;
                    perfStats.tailFloorPruned = (Number(perfStats.tailFloorPruned) || 0) + 1;
                    if (root.__RC_TRACE) {
                        console.log(`[RC][tail-floor] stop tail=O#${tail.no}:${nameOf(tail.id)} ` +
                            `seed=${seedCost} tailFloor=${lowerBound.cost} ` +
                            `totalFloor=${floorTotal} limit=${bestCost || budget}`);
                    }
                    continue;
                }
            }
            const checkKey = chainCheckSignature(
                seedOpt, seedOpt.chain, tail, o.anchorMode, o.naturalFixedIds,
                o.allowInsertMapVariants);
            let chk = o.chainCheckCache && o.chainCheckCache.get(checkKey);
            if (chk === undefined) {
                const chainStarted = Date.now();
                chk = chainChecks(cctx, TG, seedOpt.chain, seedOpt, tail,
                    o.anchorMode, o.naturalFixedIds, o.allowInsertMapVariants);
                perfStats.chainCheckMs = (Number(perfStats.chainCheckMs) || 0)
                    + (Date.now() - chainStarted);
                if (o.chainCheckCache) o.chainCheckCache.set(checkKey, chk);
            }
            if (!chk || !chk.ok) continue;
            const tailId = tail && Number(tail.id);
            const localTailReserve = tailId && observedTailReserves[tailId] != null
                ? Math.max(0, Number(observedTailReserves[tailId]) || 0)
                : reserveForTail(tail);
            const localHeadBudget = budget > 0
                ? Math.max(1, budget - localTailReserve)
                : 0;
            let tailBest = null;
            let tailFullBest = null;
            let tailCompactBest = null;
            for (const mode of strategyModes) {
                const releaseSeed = !!mode.releaseSeed;
                // 链首目标如果保留，它在定种子时就已经成为该目标的正式位置；
                // 不能再挑同名“收尾”来重复计算一次。释放链首时才允许同名重捕。
                if (!releaseSeed && tailId > 0 && tailId === Number(seedOpt.first)) continue;
                let ex = null;
                const executeOpts = chainValue => ({
                        // 静态收尾估算只用于候选排序，不能在执行前硬砍掉路线。
                        // 先按总预算完整跑，拿到实际收尾预留后再校验收尾前上界。
                        budget, bestCost, headBudget: budget,
                        maxWash: o.maxWash || 6000, M: Number(o.M) || 16, lead,
                        tailTarget: chk.tailTarget, seq: cctx.seq,
                        chainEnd: chainValue.end,
                        planAnchorId: chainValue.planAnchor != null ? chainValue.planAnchor : chk.planAnchor,
                        insertMap: chainValue.insertMap || chk.insertMap || [],
                        executionChain: chainValue.chain,
                        releasePlanAnchorId: chk.releasePlanAnchor || 0,
                        releaseInsertMap: chk.releaseInsertMap || [],
                        releaseTargetActivationNo: chk.releaseTargetActivationNo || {},
                        releaseTargetActivationOrdinal: chk.releaseTargetActivationOrdinal || {},
                        strictTargetOccurrences: !!chk.strictTargetOccurrences,
                        naturalFixedTargets: chk.naturalFixedTargets || [],
                        targetActivationNo: chk.targetActivationNo || {},
                        targetActivationOrdinal: chk.targetActivationOrdinal || {},
                        releaseSeedTarget: releaseSeed,
                        allowNaturalChainTargets: !!mode.allowNatural,
                        chainIsFull: !!chainValue.isFull,
                });
                // 第一阶段 chainChecks 只返回主表；第二阶段仅对入围的前
                // 3 条路线返回有限套锚点分配，因此这里可以直接遍历。
                const fullMaps = Array.isArray(chk.fullInsertMapVariants)
                    && chk.fullInsertMapVariants.length
                    ? chk.fullInsertMapVariants : [chk.fullInsertMap];
                const fullVariants = fullMaps.filter(Boolean).map(insertMap => ({
                    chain: chk.executionChainFull,
                    end: chk.endFull,
                    insertMap,
                    planAnchor: insertMap.length ? Number(insertMap[0].anchor) || 0 : chk.fullPlanAnchor,
                    isFull: true,
                }));
                // 链不能压缩：C#1..C#N 中的普通中间脉也是置换游标的一部分。
                // 只要连续前缀映射存在，就只执行连续链，不再执行筛掉中间脉的压缩链。
                const contiguousReady = fullVariants.length
                    && Array.isArray(chk.executionChainFull)
                    && Number(chk.endFull) >= 0;
                const chainVariants = contiguousReady ? fullVariants : [];
                let usedChainValue = null;
                let chainBest = null;
                for (const chainValue of chainVariants) {
                    const variantOptions = Object.assign({}, executeOpts(chainValue), {
                        bestCost: chainBest ? Number(chainBest.cost) || 0 : bestCost,
                    });
                    const execKey = JSON.stringify([
                        Number(seedOpt.zi) || 0,
                        seedOpt.kind || '',
                        Number(seedOpt.first) || 0,
                        Number(seedOpt.seed) || 0,
                        Number(seedOpt.carrier) || 0,
                        Number(seedOpt.anchorNo) || 0,
                        Number(seedOpt.a) || 0,
                        Number(seedOpt.d) || 0,
                        Number(seedOpt.lowId) || 0,
                        Number(seedOpt.washes) || 0,
                        !!seedOpt.openFour,
                        Number(seedOpt.openFourAt) || 0,
                        (seedOpt.steps || []).map(step => [
                            step.type, Number(step.washes) || 0, Number(step.id) || 0,
                            Number(step.from) || 0, (step.locks || []).map(Number),
                        ]),
                        (chainValue.chain || []).map(Number),
                        Number(chainValue.end),
                        (chainValue.insertMap || []).map(item => [
                            Number(item.idx), Number(item.target), Number(item.anchor),
                            Number(item.anchorNo), Number(item.anchorOrdinal),
                            Number(item.anchorPityOrdinal), !!item.anchorIsPity,
                        ]),
                        Number(variantOptions.tailTarget) || 0,
                        Number(variantOptions.M) || 0,
                        Number(variantOptions.lead) || 0,
                        !!variantOptions.strictTargetOccurrences,
                        !!variantOptions.releaseSeedTarget,
                        !!variantOptions.allowNaturalChainTargets,
                        !!variantOptions.chainIsFull,
                        JSON.stringify(variantOptions.targetActivationNo || {}),
                        JSON.stringify(variantOptions.targetActivationOrdinal || {}),
                        (variantOptions.seq || []).map(event => [
                            Number(event.no), Number(event.id), Number(event.wash),
                            !!event.fromPity,
                        ]),
                    ]);
                    let candidate = executeResultCache.get(execKey) || null;
                    if (candidate) {
                        perfStats.executeCacheHits = (Number(perfStats.executeCacheHits) || 0) + 1;
                    }
                    if (!candidate) {
                        const executeStarted = Date.now();
                        try {
                            candidate = execute(raw, TG, seedOpt, variantOptions);
                        } catch (err) {
                            candidate = { ok: false, note: String(err && err.message) };
                        }
                        perfStats.executeMs = (Number(perfStats.executeMs) || 0)
                            + (Date.now() - executeStarted);
                        perfStats.executeCalls = (Number(perfStats.executeCalls) || 0) + 1;
                        // 只缓存成功路线。失败可能被当前 bestCost 提前截断，
                        // 后续更宽的上界下可能仍然可行。
                        if (candidate && candidate.ok) {
                            if (executeResultCache.size >= 512) executeResultCache.clear();
                            executeResultCache.set(execKey, candidate);
                        }
                    }
                    if (root.__RC_TRACE && Number(seedOpt.seed) === 915630490) {
                        console.log(`[RC][chain-variant] full=${!!chainValue.isFull} ` +
                            `ok=${!!(candidate && candidate.ok)} cost=${candidate && candidate.cost} ` +
                            `field=${(candidate && candidate.field || []).map(nameOf).join('/')} ` +
                            `note=${(candidate && candidate.note) || ''}`);
                    }
                    if (candidate && candidate.ok
                        && (!chainBest || Number(candidate.cost) < Number(chainBest.cost))) {
                        chainBest = candidate;
                        usedChainValue = chainValue;
                    }
                }
                if (chainBest) {
                    ex = chainBest;
                } else if (!ex) {
                    ex = { ok: false };
                }
                if ((!ex || !ex.ok) && chainVariants.length && root.__RC_TRACE) {
                    console.log(`[EAT] 连续置换链失败 tail=${tail ? nameOf(tail.id) : 'null'}`);
                }
                if (root.__RC_TRACE) console.log(`[EAT] seed=${seedOpt.seed} tail=${tail ? nameOf(tail.id) : 'null'} releaseSeed=${releaseSeed} execute失败: ${(ex && ex.note || 'null')} missing=${(ex && ex.missing || []).map(nameOf).join('/')} cost=${ex && ex.cost} washes=${ex && ex.washes}`);
                if (!ex || !ex.ok) continue;
                // 严格位置分支同样必须独立回放。只核对终盘会放过“冲突脉在
                // 载体后面却仍显示置换成功”的假路线。
                const verifyStarted = Date.now();
                const vv = verify(raw, TG, ex.steps, seedOpt.zi);
                perfStats.verifyMs = (Number(perfStats.verifyMs) || 0)
                    + (Date.now() - verifyStarted);
                if (root.__RC_TRACE && !vv.ok) {
                    console.log(`[RC][VERIFY] ${vv.reason || '回放失败'} seed=${seedOpt.seed}`);
                }
                if (!vv.ok) continue;
                // 完整回放后，用“第 3 条目标获得时的累计丹耗 → 最终丹耗”得到这条收尾脉的实测预留。
                // 初始场上目标若被释放，不能提前算作已获得；只认回放步骤里的重新获得。
                let actualTailReserve = localTailReserve;
                let actualTailId = tailId || Number(chk.tailTarget) || 0;
                if (TG.length >= 2) {
                    const acquired = new Set();
                    const acquisitionOrder = [];
                    let penultimateCost = null;
                    for (const step of ex.steps || []) {
                        const acquiredId = step && (
                            step.type === 'lock' ? Number(step.id)
                                : (step.type === 'exchange' ? Number(step.to) : 0)
                        );
                        if (acquiredId && TG.includes(acquiredId) && !acquired.has(acquiredId)) {
                            acquired.add(acquiredId);
                            acquisitionOrder.push(acquiredId);
                        }
                        if (penultimateCost == null && acquired.size === TG.length - 1) {
                            penultimateCost = Number(step && step.cost) || 0;
                        }
                    }
                    if (penultimateCost != null) {
                        actualTailReserve = Math.max(0, (Number(vv.cost) || 0) - penultimateCost);
                        if (acquisitionOrder.length) actualTailId = acquisitionOrder[acquisitionOrder.length - 1];
                    }
                }
                const actualHeadBudget = budget > 0
                    ? Math.max(1, budget - actualTailReserve)
                    : 0;
                const finalHeadCost = (Number(vv.cost) || 0) - actualTailReserve;
                if (root.__RC_TRACE && Number(seedOpt.seed) === 915630490) {
                    console.log(`[RC][EAT-CHECK] tail=${tail ? nameOf(tail.id) : 'null'} ` +
                        `release=${releaseSeed} vv=${vv.ok} cost=${vv.cost} ` +
                        `reserve=${actualTailReserve} head=${actualHeadBudget} finalHead=${finalHeadCost}`);
                }
                if (actualHeadBudget > 0 && finalHeadCost > actualHeadBudget) continue;
                // 上界是“必须严格更省”。洗到与当前最优同丹时同样剪掉，
                // 避免同一路线在等于上界时反复展开或再次发布。
                if (bestCost > 0 && Number(vv.cost) >= bestCost) continue;
                const candidate = Object.assign({}, ex, {
                    ok: true, cost: vv.cost, washes: vv.washes, verified: true,
                    chain: seedOpt.chain, check: chk, seedOpt,
                    field: ex.field || [], exchanges: ex.exchanges || 0, burns: ex.burns || 0,
                    tailReserve: actualTailReserve, headBudget: actualHeadBudget,
                    tailTarget: actualTailId,
                    allowNaturalChainTargets: !!mode.allowNatural,
                    releaseSeedTarget: !!releaseSeed && ex.steps?.some(
                        step => step.type === 'unlockAll' && step.why === '首次换果留待后段倒插/天然重捕'),
                    refinement: {
                        ctx: cctx,
                        tailNo: tail ? Number(tail.no) || 0 : 0,
                        tailId: tail ? Number(tail.id) || 0 : 0,
                        tailNone: !tail,
                        anchorMode: o.anchorMode || 'chain',
                        naturalFixedIds: (o.naturalFixedIds || []).map(Number),
                        releaseSeedTarget: !!releaseSeed,
                        allowNaturalChainTargets: !!mode.allowNatural,
                    },
                });
                if (typeof o.onCandidateRoute === 'function') {
                    try { o.onCandidateRoute(candidate); } catch (error) { }
                }
                if (usedChainValue && usedChainValue.isFull) {
                    if (!tailFullBest || candidate.cost < tailFullBest.cost) tailFullBest = candidate;
                } else if (!tailCompactBest || candidate.cost < tailCompactBest.cost) {
                    tailCompactBest = candidate;
                }
            }
            // 三槽中途开四槽的路线必须保留完整链段；其他路线仍优先压缩链省丹。
            tailBest = seedOpt && seedOpt.openFour
                ? (tailFullBest || tailCompactBest)
                : (tailCompactBest || tailFullBest);
            if (!tailBest) continue;
            if (tailBest.tailTarget) {
                observedTailReserves[tailBest.tailTarget] = tailBest.tailReserve;
            }
            if (!best || tailBest.cost < best.cost) {
                best = tailBest;
                bestCost = tailBest.cost;
            }
            // ★ 同一个种子可能有多种收尾排法。第一条在预算内并不一定最省：
            //   步惊云 7601 路线先试“金仙收尾”得到 7967 丹，继续试“顶天收尾”才得到 7601 丹。
            //   因此这里必须把所有可行收尾都比完；execute 会拿当前 bestCost 做后续剪枝。
        }
        return best;
    }

    // ────────────────────── 总入口 ──────────────────────
    function planBest(raw, targets, opts) {
        const o = opts || {};
        const budget = Math.max(0, Number(o.budget) || 0);
        const tailReserve = Math.max(0, Number(o.tailReserve) || 0);
        const tailReserveByTail = o.tailReserveByTail || {};
        const observedTailReserves = {};
        const perTailReserves = Object.keys(tailReserveByTail)
            .map(key => Math.max(0, Number(tailReserveByTail[key]) || 0))
            .filter(value => Number.isFinite(value));
        // 种子扫描阶段还不知道最终选哪条收尾脉，用最低预留得到最宽的可用空间；
        // 进入某个具体收尾分支后，再按该收尾脉自己的预留重新收紧。
        const scanTailReserve = perTailReserves.length
            ? Math.min(...perTailReserves)
            : tailReserve;
        // 前置操作只能花「总预算 − 收尾预留」；最后一条目标开始后仍可使用完整预算。
        const headBudget = budget > 0
            ? Math.max(1, budget - scanTailReserve)
            : 0;
        // The host scheduler owns the five-minute ceiling. A phase may assign
        // this constructor a much shorter slice, so do not impose a one-minute floor.
        const methodMs = Math.max(1000, Number(o.methodMs) || 600000);
        const progressCb = typeof o.progressCb === 'function' ? o.progressCb : null;
        const planStartedAt = Date.now();
        let hardDeadline = 0;
        let deadline = planStartedAt + methodMs;   // 当前方法组的截止时间（进入组时重设）
        let phaseStart = planStartedAt;
        let slotStartedAt = planStartedAt;
        let totalLimitMs = methodMs;
        let phaseName = '吞脉法';
        let best = null;
        let bestCost = 0;
        const phaseTimings = {};
        const perfStats = {};
        o.perfStats = perfStats;
        const refinementPool = [];
        const refinementByKey = new Map();
        const publishCandidate = (route, kind) => {
            if (!route || !route.ok) return;
            rememberRefinementCandidate(route, kind);
            if (typeof o.onCandidate !== 'function') return;
            // 候选在 eatFromSeed 里产生时尚不知道它来自哪条定种子路径。
            // 必须在发给界面前就打上方法类型，否则锁脉/跳脉候选会被 n=0 误显示成无限置换。
            const tagged = kind && !route.kind ? Object.assign({}, route, { kind }) : route;
            try { o.onCandidate(tagged); } catch (error) { }
        };
        const rememberRefinementCandidate = (route, kind) => {
            if (!route || !route.ok || !route.seedOpt || !route.refinement) return;
            const ref = route.refinement;
            const key = [
                Number(route.seedOpt.seed) || 0,
                (route.seedOpt.chain || []).map(Number).join(','),
                Number(ref.tailNo) || 0,
                Number(ref.tailId) || 0,
                ref.anchorMode || '',
                (ref.naturalFixedIds || []).map(Number).sort((a, b) => a - b).join(','),
                ref.releaseSeedTarget ? 1 : 0,
                ref.allowNaturalChainTargets ? 1 : 0,
            ].join('|');
            const prior = refinementByKey.get(key);
            if (prior && Number(prior.cost) <= Number(route.cost)) return;
            const candidate = Object.assign({}, route, { kind: route.kind || kind || '' });
            refinementByKey.set(key, candidate);
            const index = refinementPool.findIndex(item =>
                (item.refinementKey || '') === key);
            candidate.refinementKey = key;
            if (index >= 0) refinementPool[index] = candidate;
            else refinementPool.push(candidate);
            refinementPool.sort((a, b) => Number(a.cost) - Number(b.cost));
            if (refinementPool.length > 12) {
                const removed = refinementPool.pop();
                if (removed) refinementByKey.delete(removed.refinementKey);
            }
        };
        const report = extra => {
            if (!progressCb) return;
            const now = Date.now();
            try {
                progressCb(Object.assign({
                    method: phaseName,
                    elapsed: now - phaseStart,
                    slotElapsed: now - slotStartedAt,
                    slotLimitMs: methodMs,
                    totalMs: methodMs,
                    totalElapsed: now - planStartedAt,
                    totalLimitMs,
                    budget,
                    tailReserve,
                    tailReserveByTail,
                    headBudget,
                    bestCost,
                }, extra || {}));
            } catch (err) { }
        };
        let lastReportAt = 0;
        const reportThrottled = extra => {
            const now = Date.now();
            if (now - lastReportAt < 250) return;
            lastReportAt = now;
            report(extra);
        };
        const enterPhase = name => {
            const spent = Math.max(0, Date.now() - phaseStart);
            phaseTimings[phaseName] = (Number(phaseTimings[phaseName]) || 0) + spent;
            phaseName = name; phaseStart = Date.now();
            deadline = hardDeadline > 0
                ? Math.min(phaseStart + methodMs, hardDeadline)
                : phaseStart + methodMs;
            report();
        };
        const nMax = o.nMax == null
            ? 100
            : Math.min(100, Math.max(0, Number(o.nMax) || 0));
        const lead = Math.max(1, Number(o.lead) || 14);
        const zi0 = Number(o.zi) >= 150 ? Number(o.zi) : 153;
        const TG = (targets || []).map(Number);
        // ★ 自动双跑优先级：天然3槽 → 3槽开4槽（由无限置换起手选项覆盖）→ 天然4槽，取最省。
        //   未显式指定 zi 时始终先跑 3 槽，避免界面先进入“吞脉法·4槽”。
        const zis = Number(o.zi) >= 150 ? [Number(o.zi)] : [153, 154];
        // 两种起手槽位各给一组方法预算。总计时从进入 planBest 开始，不能随 3槽→4槽重置。
        totalLimitMs = methodMs * zis.length;
        hardDeadline = planStartedAt + totalLimitMs;
        // 调试：o.onlyPaths=['C','D'] 只跑指定路径（正常不传=全跑）
        const only = Array.isArray(o.onlyPaths) ? new Set(o.onlyPaths.map(String)) : null;
        const want = name => !only || only.has(name);
        const tried = [];
        const chainCheckCache = new Map();
        const sequenceCache = new Map();
        const executeResultCache = new Map();
        const tailLowerBoundCache = new WeakMap();
        o.executeResultCache = executeResultCache;
        o.tailLowerBoundCache = tailLowerBoundCache;
        for (const zi0 of zis) {
            if (Date.now() > deadline) break;
            slotStartedAt = Date.now();
        const ctx = readSequence(raw, { zi: zi0, count: o.count });
        const seedState = resolveSeedState(raw, ctx);
        const seedMethodState = resolveSeedMethod(raw, ctx);
        // ★ 分类（用户口径）：
        // 首条普通紫必须自身具备可置换锚点资格，才允许走无限置换。
        // 首条保底紫或首条无冲突普通紫都走吞脉法。
        const useSwallow = !!seedMethodState.allowsSwallow;
        const useInfiniteExchange = !!seedMethodState.allowsInfiniteExchange;

        // ===== 方法组零：已用过无限置换（luck 种子已固定）—— 第三种情况：不重新定种子，用原脉序 + 固定置换脉序往下走 =====
        enterPhase(bestCost > 0
            ? `已验证 ${bestCost} 丹 · 继续已定种子${zi0 >= 154 ? '·4槽' : '·3槽'}`
            : (zi0 >= 154 ? '已定种子·4槽' : '已定种子·3槽'));

        // —— 路径E：已用过无限置换（luck 种子已固定）→ 只剩原始脉 + 一条固定置换脉序，直接用现链往下走 ——
        if (want('E') && seedState.fixed && seedState.valid && seedState.currentSeed != null) {
            const fixedChain = queueOf(raw, zi0, Number(seedState.currentSeed), 16);
            if (fixedChain.length) {
                const seedOptE = {
                    kind: 'exchange', zi: zi0, n: 0, lead, carrier: 0,
                    first: fixedChain[0], seed: Number(raw.luck_seed), chain: fixedChain,
                    steps: [], startWash: 0, upgradeBefore: false, a: 0, d: 0,
                    lowId: 0, washes: 0, cost: 0,
                    // 固定种子没有定种子置换，C#1 尚未消费，第一个锚点直接推进链。
                    initialConsumed: 0,
                };
                const exE = eatFromSeed(ctx, raw, TG, seedOptE,
                    Object.assign({}, o, {
                        budget, bestCost, tailReserve, headBudget, observedTailReserves,
                        sequenceCache,
                        onCandidateRoute: route => publishCandidate(route, 'exchange-fixed'),
                    }));
                if (exE && (!best || exE.cost < best.cost)) {
                    best = Object.assign({}, exE, { kind: 'exchange-fixed', seedOpt: seedOptE });
                    bestCost = exE.cost;
                }
            }
        }
        // —— 路径E-2（第三条 Case 2）：欧气种子未固定 → 裸洗到首条保底紫定种子 → 定收尾+倒插 ——
        //   ★ 不限首条是否保底紫：只要原始脉序里有保底紫就试（薛龙城=首条非保底紫，但靠这条自然洗到保底紫定种子）
        if (want('E') && !seedState.fixed && ctx.seq.some(p => p.fromPity) && root.AutoWash2SeedPlanner && typeof root.AutoWash2SeedPlanner.runToFirstPity === 'function') {
            const jr = root.AutoWash2SeedPlanner.runToFirstPity(raw, zi0, 0);   // 0 跳 = 裸洗到首条保底紫
            if (jr && jr.wash != null) {
                // ★ 裸洗到首条保底紫 = 定种子（保底紫写 luckSeed），不再追加置换；种子定之后统一走倒插
                const chain2 = [Number(jr.first)].concat(queueOf(raw, zi0, Number(jr.seed), 24));
                const seedOpt2 = { kind: 'exchange', zi: zi0, n: 0, lead, carrier: 0, chain: chain2, first: Number(jr.first), seed: Number(jr.seed), steps: [], startWash: 0, upgradeBefore: false, a: Number(jr.wash) || 0, d: 0, lowId: 0, washes: Number(jr.wash) || 0, cost: Number(jr.cost) || 0, pityPrelude: true };
                // 只跳过当前裸洗保底候选，不能 continue 整个 zi0；
                // 否则后面的吞脉法和无限置换都会被一起跳过。
                if (!((headBudget > 0 && Number(jr.cost) > headBudget)
                    || (bestCost > 0 && Number(jr.cost) >= bestCost))) {
                    const ex2 = eatFromSeed(ctx, raw, TG, seedOpt2,
                        Object.assign({}, o, {
                            budget, bestCost, tailReserve, headBudget, observedTailReserves,
                            deadline, sequenceCache,
                            onCandidateRoute: route => publishCandidate(route, 'pity-exchange'),
                        }));
                    if (ex2 && (!best || ex2.cost < best.cost)) {
                        best = Object.assign({}, ex2, { kind: 'pity-exchange', seedOpt: seedOpt2 });
                        bestCost = ex2.cost;
                    }
                }
            }
        }

        // ===== 方法组一：连续置换（独立执行器）—— 薛龙城型路线 =====
        enterPhase(bestCost > 0
            ? `已验证 ${bestCost} 丹 · 继续搜索连续置换${zi0 >= 154 ? '·4槽' : '·3槽'}`
            : (zi0 >= 154 ? '连续置换·4槽' : '连续置换·3槽'));
        if (want('G') && zi0 === 153 && !seedState.fixed && root.AutoWash2UnifiedAnchorPlanner
            && typeof root.AutoWash2UnifiedAnchorPlanner.searchJumpManualRoute === 'function') {
            let jumpManual = null;
            try {
                jumpManual = root.AutoWash2UnifiedAnchorPlanner.searchJumpManualRoute(raw, TG, {
                    startWashes: Array.isArray(o.jumpStartWashes) && o.jumpStartWashes.length
                        ? o.jumpStartWashes : [864, 600, 300, 0],
                    budget,
                    tailReserveByTail,
                    tailReserve,
                    timeMs: Math.min(30000, Math.max(2000, deadline - Date.now())),
                    minChainSteps: 8,
                });
            } catch (err) { jumpManual = null; }
            const normalized = normalizeJumpManualRoute(jumpManual, TG);
            if (normalized) {
                const verified = verifyJumpManual(raw, TG, normalized.steps, zi0);
                if (!verified.ok && root.__RC_TRACE) {
                    console.log(`[RC] 连续置换回放失败：${verified.reason || '未知'} cost=${verified.cost} washes=${verified.washes}`);
                }
                if (verified.ok && (budget <= 0 || verified.cost <= budget)) {
                    normalized.cost = verified.cost;
                    normalized.washes = verified.washes;
                    normalized.field = verified.field;
                    normalized.verified = true;
                    if (!best || normalized.cost < best.cost) {
                        best = normalized;
                        bestCost = normalized.cost;
                        publishCandidate(best, 'jumpManual');
                    }
                }
            }
            report({ note: '连续置换候选已比较' });
        }

        // ===== 方法组二：吞脉法（纯天然 / 锁脉 / 跳脉）—— 使用调度器分配的时间片 =====
        enterPhase(bestCost > 0
            ? `已验证 ${bestCost} 丹 · 继续搜索吞脉法${zi0 >= 154 ? '·4槽' : '·3槽'}`
            : (zi0 >= 154 ? '吞脉法·4槽' : '吞脉法·3槽'));

        // —— 路径B（先跑）：跳脉法/锁脉（保底写种子）→ 统一后续。最快、步惊云 7943 就在这 ——
        const J = root.AutoWash2SeedPlanner;
        const bTried = [];
        if (want('B') && !seedState.fixed && useSwallow
            && J && typeof J.planLockShiftRoutes === 'function') {
            let pityWash0 = 0;
            for (const p of ctx.seq) { if (p.fromPity) { pityWash0 = Number(p.wash) || 0; break; } }
            const slots0 = zi0 >= 154 ? 4 : 3;
            // ★ 锁脉法两条「找种子」路线（找种子 = 纯锁：空洗 a → 锁低阶 → 洗到保底紫；种子定之后一律走倒插洗脉）：
            //   ① 三槽/四槽起手：空洗到紫脉前 250 条 → 锁低阶脉洗到保底紫（不开槽）
            //   ② 三槽起手：空洗到紫脉前 200 条 → 开四槽（保底紫约推后 50 条）→ 锁低阶脉洗到保底紫
            const branches = zi0 >= 154
                ? [{ bars: 250, openFour: false }]
                // 两种都是 3 槽起手；先试“3 槽开 4 槽”，通常更早拿到可用保底种子。
                : [{ bars: 200, openFour: true }, { bars: 250, openFour: false }];
            // A luck seed alone is not a complete candidate identity: opening
            // the fourth slot at different born-stream positions can reach the
            // same pity seed with different fields, wash counts and replay cost.
            const bCandidateGroups = new Map();
            const evaluatedBSeed = new Set();
            const bSeedKey = item => {
                const route = item && item.r || {};
                return [Number(route.seed) || 0, Number(!!route.openFour),
                    Number(route.openFourAt) || 0].join(':');
            };
            const passesChainCheck = (r, chain) => {
                const seedOpt = {
                    kind: 'exchange', zi: zi0, n: 0, lead, carrier: 0, chain,
                    first: Number(r.firstPurple), seed: Number(r.seed), steps: [],
                    startWash: 0, upgradeBefore: false, a: Number(r.a) || 0,
                    d: Number(r.d) || 0, lowId: Number(r.lowId) || 0,
                    washes: Number(r.firstPityWash) || 0, openFour: !!r.openFour,
                    openFourAt: Number(r.openFourAt) || 0,
                    cost: Number(r.cost) || 0, pityPrelude: true,
                };
                // 链预检必须和 exec 使用同一份“开槽后、首保底后”动态脉序。
                // 静态 readSequence(154) 会误删 221 开四槽的 7311 种子。
                const postOpenCtx = readSequenceAfterSeedOpenCached(
                    raw, seedOpt, TG, Number(o.count) || 40, sequenceCache);
                const checkCtx = postOpenCtx && postOpenCtx.seq.length
                    ? postOpenCtx
                    : (r.openFour && zi0 < 154
                        ? readSequence(raw, { zi: 154, count: Number(o.count) || 40 })
                        : ctx);
                const tailOptions = tailCandidates(
                    checkCtx.seq, TG, initialTargetCount(raw, TG));
                if (TG.length <= 3) tailOptions.push(null);
                const passed = tailOptions.some(tail => {
                    const maskLimit = 1 << TG.length;
                    for (let mask = 0; mask < maskLimit; mask++) {
                        const naturalFixedIds = mask
                            ? TG.filter((id, index) => (mask & (1 << index)) !== 0)
                            : [];
                        const mode = mask ? 'combined' : 'chain';
                        const cacheKey = chainCheckSignature(
                            seedOpt, chain, tail, mode, naturalFixedIds, false);
                        let checked = chainCheckCache.get(cacheKey);
                        if (checked === undefined) {
                            checked = chainChecks(checkCtx, TG, chain, seedOpt, tail,
                                mode, naturalFixedIds, false);
                            chainCheckCache.set(cacheKey, checked);
                        }
                        if (checked && checked.ok) return true;
                    }
                    return false;
                });
                if (root.__RC_TRACE
                    && [915630490, 1437152945].includes(Number(r.seed))) {
                    console.log(`[RC][known-seed] openFour=${!!r.openFour} ` +
                        `checkZi=${checkCtx.zizhi} passed=${passed}`);
                }
                return passed;
            };
            const rankBCandidates = items => {
                items.sort((a, b) =>
                    // The 4-slot branch can preserve a cheaper carrier path.
                    // Evaluate it before no-upgrade variants so it is not starved
                    // by long per-seed tail construction.
                    (Number(!!b.r.openFour) - Number(!!a.r.openFour))
                    || (Number(a.r.openFourAt) - Number(b.r.openFourAt))
                    || (b.firstTarget - a.firstTarget)
                    || (b.targetHits - a.targetHits)
                    || ((Number(a.r.preludePills) || 0) - (Number(b.r.preludePills) || 0))
                    || ((Number(a.r.firstPityWash) || 0) - (Number(b.r.firstPityWash) || 0))
                    || ((Number(a.r.seed) || 0) - (Number(b.r.seed) || 0)));
                return items;
            };
            const evaluateBCandidateGroups = () => {
                // Evaluate each seed batch immediately. Scanning every open-slot
                // offset before route construction used to leave no deadline for
                // the exact lock seed that had just been discovered.
                const bCandidatesFinal = [];
                for (const group of bCandidateGroups.values()) {
                    group.sort((a, b) =>
                        (Number(a.r.preludePills) || 0) - (Number(b.r.preludePills) || 0));
                    for (const item of group) {
                        if (!passesChainCheck(item.r, item.chain)) continue;
                        bCandidatesFinal.push(item);
                        break;
                    }
                }
                for (const item of rankBCandidates(bCandidatesFinal)) {
                    if (Date.now() > deadline) break;
                    evaluateBCandidate(item);
                }
            };
            const evaluateBCandidate = item => {
                if (!item || evaluatedBSeed.has(bSeedKey(item))) return;
                evaluatedBSeed.add(bSeedKey(item));
                const r = item.r;
                if (bestCost > 0 && Number(r.preludePills) >= bestCost) return;
                reportThrottled({
                    note: '吞脉法比较种子候选', aFix: r.a, d: r.d,
                    seed: r.seed, firstPity: r.firstPurple,
                });
                let ex = null;
                let usedSeedOpt = null;
                let usedKind = '';
                // Rebuild the post-open-four sequence before trying the legacy
                // static pity interpretation; otherwise that branch can spend
                // the seed's entire route budget against the wrong O# ordering.
                for (const seedKind of ['exchange', 'pity']) {
                    const seedOpt = {
                        kind: seedKind, zi: zi0, n: 0, lead, carrier: 0, chain: item.chain,
                        first: Number(r.firstPurple), seed: Number(r.seed), steps: [],
                        startWash: 0, upgradeBefore: false, a: Number(r.a) || 0,
                        d: Number(r.d) || 0, lowId: Number(r.lowId) || 0,
                        washes: Number(r.firstPityWash) || 0, openFour: !!r.openFour,
                        openFourAt: Number(r.openFourAt) || 0,
                        cost: Number(r.cost) || 0, pityPrelude: true,
                    };
                    const one = eatFromSeed(ctx, raw, TG, seedOpt,
                        Object.assign({}, o, {
                            budget,
                            bestCost: ex && ex.ok ? Number(ex.cost) || 0 : bestCost,
                            tailReserve, headBudget, observedTailReserves,
                            deadline, sequenceCache, chainCheckCache,
                            onCandidateRoute: route => publishCandidate(route, 'pity'),
                        }));
                    if (root.__RC_TRACE
                        && [915630490, 1437152945].includes(Number(r.seed))) {
                        console.log(`[RC][known-seed] evaluated kind=${seedKind} ` +
                            `openFour=${!!r.openFour} a=${r.a} d=${r.d} wash=${r.firstPityWash} ` +
                            `result=${one ? one.cost : 'null'}`);
                    }
                    if (one && one.ok && (!ex || one.cost < ex.cost)) {
                        ex = one;
                        usedSeedOpt = seedOpt;
                        usedKind = seedKind;
                    }
                }
                if (ex && (!best || ex.cost < best.cost)) {
                    best = Object.assign({}, r, ex, { kind: 'pity', seedOpt: usedSeedOpt,
                        seedExecutionKind: usedKind });
                    bestCost = ex.cost;
                }
            };
            for (const br of branches) {
            // ★ 空洗 a 的起点：
            //   ① 250 条（纯锁）沿用旧口径：空洗到「首条保底紫洗数 - 250条/槽」。
            //   ② 200 条（开4槽）：按「三槽保底紫阈值 850 条前 200 条」算 =(850-200)/3≈217 洗，
            //      不能拿首条保底紫的 269 洗去减（269 是「累计 850 条」的实际洗数，中间有自然紫重置进度）。
            const baseA = br.openFour
                ? Math.max(0, Math.round((850 - br.bars) / slots0))
                : Math.max(0, (pityWash0 || 0) - Math.floor(br.bars / slots0));
            // 开槽位置与后续锁脉位置分开处理：
            // · 三槽开四槽：bornSeed 对开槽点敏感，保留 217..221 五个边界；
            // · 直接洗 / 天然四槽：只从一个基准点开始，后续锁点沿 born 流覆盖。
            const aList = br.openFour
                ? [baseA + 4, baseA + 3, baseA + 2, baseA + 1, baseA]
                : [baseA];
            for (const aFix of aList) {
            if (Date.now() > deadline) break;
            reportThrottled({ note: '吞脉法扫描锁脉落点', aFix, openFour: br.openFour });
            let out = null;
            try {
                out = J.planLockShiftRoutes(raw, TG, {
                    zizhi: zi0, aMax: aFix, openFour: br.openFour,
                    openFourAt: br.openFour && aFix > baseA + 10 ? baseA : undefined,
                    headBudget,
                    bestCost,
                    timeMs: Math.min(Math.max(4000, Math.min(10000, methodMs * 0.25)),
                        Math.max(1000, deadline - Date.now())),
                    threshold: 820, budget: Math.max(0, Number(o.budget) || 0),
                    progressCb: progress => reportThrottled({
                        note: '吞脉法扫描低阶脉', aFix, openFour: br.openFour,
                        scanned: progress && progress.scanned,
                    }),
                });
            } catch (err) { out = null; }
            for (const r of (out && out.routes) || []) {
                const seedKey = bSeedKey({ r });
                const chain = [Number(r.firstPurple)].concat(queueOf(raw, zi0, Number(r.seed), 24));
                if ((headBudget > 0 && Number(r.preludePills) > headBudget)
                    || (bestCost > 0 && Number(r.preludePills) >= bestCost)) continue;
                if (!bCandidateGroups.has(seedKey)) bCandidateGroups.set(seedKey, []);
                bCandidateGroups.get(seedKey).push({
                    r, chain,
                    firstTarget: TG.includes(Number(r.firstPurple)) ? 1 : 0,
                    targetHits: TG.filter(id => chain.includes(id)).length,
                });
            }
            evaluateBCandidateGroups();
            }
            }
            evaluateBCandidateGroups();
        }

        // （路径C「跳脉法·旧生成器」已删除：改用路径D「跳脉：runToFirstPity → 统一后续」）

        // —— 路径D（吞脉法·跳脉）：n 跳（3槽周期3 / 4槽周期4）定保底紫种子 → 统一后续 ——
        if (want('D') && !seedState.fixed && useSwallow
            && J && typeof J.runToFirstPity === 'function') {
            const seenJumpSeed = new Set();
            const maxJump = Math.max(6, (zi0 >= 154 ? 4 : 3) * 6);
            const jumpStep = zi0 >= 154 ? 4 : 3;
            // 先顺序探测 0..槽数。三槽比较 2/3，四槽比较 3/4：
            // 若末端种子相同，取前一个作为边界；之后按槽数递增。
            const probeEnd = Math.min(maxJump, jumpStep);
            const probe = new Map();
            for (let n = 0; n <= probeEnd; n++) {
                let jrProbe = null;
                try { jrProbe = J.runToFirstPity(raw, zi0, n); } catch (err) { jrProbe = null; }
                probe.set(n, jrProbe);
            }
            let firstBoundary = probeEnd;
            const beforeEdge = probe.get(probeEnd - 1);
            const atEdge = probe.get(probeEnd);
            if (beforeEdge && atEdge
                && Number(beforeEdge.seed) === Number(atEdge.seed)) {
                firstBoundary = probeEnd - 1;
            }
            const jumpValues = [];
            for (let n = 0; n <= firstBoundary; n++) jumpValues.push(n);
            for (let n = firstBoundary + jumpStep; n <= maxJump; n += jumpStep) jumpValues.push(n);
            if (jumpValues[jumpValues.length - 1] !== maxJump) jumpValues.push(maxJump);
            for (const n of jumpValues) {
                if (Date.now() > deadline) break;
                reportThrottled({ note: '吞脉法枚举跳脉档位', jump: n });
                let jr = probe.get(n) || null;
                if (!jr) {
                    try { jr = J.runToFirstPity(raw, zi0, n); } catch (err) { jr = null; }
                }
                if (!jr || !jr.seed) continue;
                if (seenJumpSeed.has(jr.seed)) continue;   // 周期内同链去重
                seenJumpSeed.add(jr.seed);
                const chain = [Number(jr.first)].concat(queueOf(raw, zi0, Number(jr.seed), 16));
                // ★ 跳脉法也是「定种子」的一种，种子定之后统一走倒插（不再用锁天然目标）
                const seedOpt = { kind: 'exchange', zi: zi0, n: 0, lead, carrier: 0, chain, first: Number(jr.first), seed: Number(jr.seed), steps: [], startWash: 0, upgradeBefore: false, a: Number(jr.wash) || 0, d: 0, lowId: 0, washes: Number(jr.wash) || 0, cost: Number(jr.cost) || 0, pityPrelude: true };
                if ((headBudget > 0 && Number(jr.cost) > headBudget)
                    || (bestCost > 0 && Number(jr.cost) >= bestCost)) continue;
                const ex = eatFromSeed(ctx, raw, TG, seedOpt,
                    Object.assign({}, o, {
                        budget, bestCost, tailReserve, headBudget, observedTailReserves,
                        deadline, sequenceCache,
                        onCandidateRoute: route => publishCandidate(route, 'jump'),
                    }));
                if (ex && (!best || ex.cost < best.cost)) {
                    best = Object.assign({}, ex, { kind: 'jump', jumps: n, seedOpt });
                    bestCost = ex.cost;
                }
            }
        }

        // —— 路径A（后跑）：无限置换 n 枚举（含前缀空洗/开槽重掷）——
        // ★ 首条原始脉是保底紫 → 只能吞脉法，跳过 A；首条非保底紫才走无限置换
        if (want('A') && !seedState.fixed && useInfiniteExchange) {
        // 只有真正进入无限置换枚举时才切换阶段名；首紫是保底紫时不能闪一下这个阶段。
        enterPhase(zi0 >= 154 ? '无限置换·4槽' : '无限置换·3槽');
        // ★ 固定起手保留；同时把原始脉序中的所有普通紫事件作为无限置换锚点候选。
        //   神脉没有同型低阶冲突，不能作为普通无限置换锚点；保底紫和一心两用也排除。
        const fixedStartOpts = o.startWashes || (zi0 >= 154
            ? [{ a: 0, up: false }, { a: 131, up: false }]
            : [{ a: 0, up: false }, { a: 0, up: true }, { a: 131, up: false }]);
        const initialIds = (raw.talents || [])
            .map(t => Number(t && t.id != null ? t.id : t))
            .filter(id => id > 0);
        const possibleTails = tailCandidates(
            ctx.seq, TG, initialTargetCount(raw, TG));
        const naturalAnchorStarts = ctx.seq
            .filter(p => !p.fromPity && !p.shenmai && Number(p.id) !== 251)
            .map(p => ({
                p,
                slack: Math.min(...possibleTails.map(tail =>
                    infiniteStartStats(ctx.seq, TG, Number(tail.no) || 0,
                        Number(p.no) || 0, initialIds).slack)),
            }))
            .filter(item => Number.isFinite(item.slack) && item.slack >= 0)
            .map(({ p, slack }) => {
                const base = {
                    up: false,
                    anchorId: Number(p.id), anchorNo: Number(p.no) || 0,
                    anchorWash: Number(p.wash) || 0,
                    targetAnchor: TG.includes(Number(p.id)) ? 1 : 0,
                    slack,
                };
                const conflictWash = Number(p.conflictWash) || 0;
                const conflictId = Number(p.conflictId) || 0;
                // 每个原始起点只有一个无限置换候选：先在其前方最近的冲突脉
                // 位置锁脉，再慢洗到该起点紫。不存在“不准备冲突直接置换”的分支。
                if (!(conflictWash > 0 && conflictId > 0 && conflictWash < base.anchorWash)) {
                    return null;
                }
                return Object.assign({}, base, {
                    a: conflictWash,
                    prepConflictId: conflictId,
                });
            })
            .filter(Boolean)
            // 同一 N 波次内，优先搜索锚点余量最小的起点，尽早拿到真实上界；
            // 余量相同则从后往前搜，让可截取的置换链尽量短、更可能省丹。
            .sort((a, b) => (a.slack - b.slack)
                || (b.anchorNo - a.anchorNo)
                || (a.a - b.a));
        // 先跑零前缀的完整 n 枚举，保证短时间内能命中 n=22 这类路线；
        // 再跑自然紫锚点，补“锚点向后推”的低丹分支。
        const startOpts = naturalAnchorStarts.concat(fixedStartOpts);
        const seedCostCeiling = headBudget > 0
            ? (bestCost > 0 ? Math.min(headBudget, bestCost) : headBudget)
            : bestCost;
        const candidateNs = so => {
            return Array.from({ length: nMax + 1 }, (_, n) => n);
        };
        const searchJobs = [];
        startOpts.forEach((so, order) => {
            for (const n of candidateNs(so)) {
                const nStart = n === 0 ? 0 : Math.floor((n - 1) / 10) * 10 + 1;
                searchJobs.push({
                    so, n, order,
                    nStart,
                    nEnd: Math.min(nMax, nStart + 9),
                    wave: Math.floor(n / 10) + 1,
                });
            }
        });
        // 按 N 区间分波搜索：所有起点先跑 N=0..10，再跑 11..20，
        // 依此类推。短 N 候选先建立真实丹耗上界，后续波次可提前剪枝。
        searchJobs.sort((a, b) => {
            const an = a.so.anchorId ? 0 : 1;
            const bn = b.so.anchorId ? 0 : 1;
            const ap = a.so.prepConflictId ? 0 : 1;
            const bp = b.so.prepConflictId ? 0 : 1;
            const ab = a.n === 0 ? 0 : Math.max(0, Math.ceil(a.n / 10) - 1);
            const bb = b.n === 0 ? 0 : Math.max(0, Math.ceil(b.n / 10) - 1);
            return (an - bn) || (ap - bp) || (ab - bb)
                || (a.order - b.order) || (a.n - b.n);
        });
        for (const job of searchJobs) {
            const so = job.so;
            const n = job.n;
                if (Date.now() > deadline) break;
                // 3 槽最低 3 丹/洗，4 槽最低 5 丹/洗；连这个下界都超过当前上界，整条候选不可能更省。
                const minimumWashCost = zi0 >= 154 ? 5 : 3;
                if (seedCostCeiling > 0
                    && (Number(so.a) + Number(n)) * minimumWashCost >= seedCostCeiling) continue;
                reportThrottled({
                    n, startWash: Number(so.a) || 0,
                    anchorId: so.anchorId || 0, anchorNo: so.anchorNo || 0,
                    prepConflictId: so.prepConflictId || 0,
                    nStart: job.nStart, nEnd: job.nEnd, wave: job.wave,
                });
                let seedOpt = null;
                const seedStarted = Date.now();
                try {
                    seedOpt = seedFixByExchange(raw, TG, {
                        zi: zi0, n, lead, startWash: Number(so.a) || 0,
                        startCarrierId: Number(so.anchorId) || 0,
                        startAnchorNo: Number(so.anchorNo) || 0,
                        prepConflictId: Number(so.prepConflictId) || 0,
                        upgradeBefore: !!so.up, maxWash: o.maxWash,
                        budget: seedCostCeiling > 0 ? seedCostCeiling : budget,
                        // 路径A最终走找收尾+倒插，不提前锁下一个换果冲突。
                        preloadNextConflict: false,
                    });
                } catch (err) { seedOpt = null; }
                perfStats.seedFixMs = (Number(perfStats.seedFixMs) || 0)
                    + (Date.now() - seedStarted);
                perfStats.seedFixCalls = (Number(perfStats.seedFixCalls) || 0) + 1;
                if (!seedOpt || !seedOpt.chain || !seedOpt.chain.length) continue;
                if (bestCost > 0 && Number(seedOpt.cost) >= bestCost) continue;
                if (so.anchorId) {
                    seedOpt.startAnchorId = Number(so.anchorId);
                    seedOpt.startAnchorNo = Number(so.anchorNo) || 0;
                    seedOpt.startAnchorWash = Number(so.anchorWash) || Number(so.a) || 0;
                    seedOpt.startPrepWash = Number(so.a) || 0;
                }
                // 真正用于无限置换的是 seedFix 选出来的普通紫载体；
                // 收尾窗口必须从这张载体往后计算。老僧是岿然起手、天人合一作实际置换锚点。
                const carrierId = Number(seedOpt.carrier) || Number(so.anchorId) || 0;
                const carrierEvent = so.anchorId
                    ? (ctx.seq || []).find(p =>
                        Number(p.id) === carrierId
                        && Number(p.no) === Number(so.anchorNo || 0))
                    : (ctx.seq || []).find(p => Number(p.id) === carrierId);
                seedOpt.anchorId = carrierId;
                seedOpt.anchorNo = carrierEvent ? Number(carrierEvent.no) || 0 : Number(so.anchorNo) || 0;
                seedOpt.anchorWash = Number(seedOpt.carrierArrivalWash)
                    || (carrierEvent ? Number(carrierEvent.wash) || 0 : Number(so.a) || 0);
                const hits = TG.filter(t => seedOpt.chain.includes(t)).length;
                if (hits < Math.max(1, TG.length - 2)) continue;
                // 低成本覆盖预检：种子链或其他原始脉序事件任一组合都不能
                // 覆盖四目标时，不进入昂贵的收尾/锚点/回放展开。
                const initialIdsNow = (raw.talents || [])
                    .map(t => Number(t && t.id != null ? t.id : t))
                    .filter(id => id > 0);
                const coverTails = tailCandidates(
                    ctx.seq, TG, initialTargetCount(raw, TG));
                const canCover = coverTails.some(tail => {
                    const available = new Set(seedOpt.chain.map(Number));
                    for (const id of initialIdsNow) if (TG.includes(id)) available.add(id);
                    for (const event of (ctx.seq || [])) {
                        if (Number(event.wash) > Number(tail.wash)) break;
                        if (TG.includes(Number(event.id))) available.add(Number(event.id));
                    }
                    return TG.every(id => available.has(Number(id)));
                });
                if (!canCover) {
                    tried.push({ a: so.a, up: so.up, n, skipped: 'C#15内无法覆盖全部目标' });
                    continue;
                }
                // 到任一合法收尾位之前至少还要洗这么多手；用最低单洗丹耗
                // 构造成本下界，已不可能低于当前最优时提前跳过。
                const earliestTailWash = Math.min(...coverTails.map(t => Number(t.wash) || 0));
                const carrierArrival = Number(seedOpt.carrierArrivalWash)
                    || Number(seedOpt.anchorWash) || Number(so.anchorWash) || 0;
                const routeFloor = Number(seedOpt.cost) || 0
                    + Math.max(0, earliestTailWash - carrierArrival) * 3;
                if (bestCost > 0 && routeFloor >= bestCost) {
                    tried.push({ a: so.a, up: so.up, n, skipped: '严格下界不低于当前最优', floor: routeFloor });
                    continue;
                }
                if (headBudget > 0 && Number(seedOpt.cost) > headBudget) {
                    tried.push({ a: so.a, up: so.up, n, skipped: '收尾前超可用上限', cost: Number(seedOpt.cost) || 0 });
                    continue;
                }
                // ★ 无限置换定种子 → 统一后续（找收尾→倒插→毁/留/置换）
                const ex = eatFromSeed(ctx, raw, TG, seedOpt,
                    Object.assign({}, o, {
                        budget, bestCost, tailReserve, headBudget, observedTailReserves,
                        deadline, chainCheckCache, sequenceCache,
                        onCandidateRoute: route => publishCandidate(route, 'exchange'),
                    }));
                if (!ex) continue;
                tried.push({
                    a: so.a, up: so.up, n, cost: ex.cost, verified: true,
                    anchor: so.anchorId || 0, tail: ex.check && ex.check.tailKind,
                });
                if (!best || ex.cost < best.cost) {
                    best = Object.assign({}, ex, {
                        kind: 'exchange',
                        seedOpt,
                        chain: seedOpt.chain,
                    });
                    bestCost = ex.cost;
                }
        }
        }   // end if want('A')

        }   // end for zi0

        // ===== 第二阶段：只对整轮搜索中最优的 3 条路线展开毁脉锚点分配 =====
        if (refinementPool.length) {
            phaseName = '倒插分配·前3';
            phaseStart = Date.now();
            const refineBudgetMs = Math.max(5000, Number(o.refineMs) || 30000);
            deadline = phaseStart + refineBudgetMs;
            report({ note: '主路线已定，开始枚举前3条路线的毁脉锚点分配' });
            const topRoutes = refinementPool.slice(0, 3);
            for (let index = 0; index < topRoutes.length; index++) {
                if (Date.now() > deadline) break;
                const route = topRoutes[index];
                const ref = route.refinement || {};
                reportThrottled({
                    note: `倒插分配枚举 ${index + 1}/${topRoutes.length}`,
                    refineBestCost: route.cost,
                    refineTail: ref.tailId || 0,
                });
                let refined = null;
                try {
                    refined = eatFromSeed(ref.ctx, raw, TG, route.seedOpt, {
                        budget,
                        bestCost: 0,
                        tailReserve,
                        tailReserveByTail,
                        observedTailReserves,
                        headBudget: budget,
                        maxWash: o.maxWash || 6000,
                        M: Number(o.M) || 16,
                        lead: Number(route.seedOpt && route.seedOpt.lead) || lead,
                        deadline,
                        sequenceCache,
                        chainCheckCache,
                        anchorVariantsDone: true,
                        allowInsertMapVariants: true,
                        anchorMode: ref.anchorMode || 'chain',
                        naturalFixedIds: ref.naturalFixedIds || [],
                        forcedTailNone: !!ref.tailNone,
                        forcedTailNo: ref.tailNone ? undefined : Number(ref.tailNo) || 0,
                        forcedTailId: ref.tailNone ? 0 : Number(ref.tailId) || 0,
                        forcedReleaseSeed: !!ref.releaseSeedTarget,
                        forcedAllowNatural: !!ref.allowNaturalChainTargets,
                    });
                } catch (error) {
                    if (root.__RC_TRACE) {
                        console.log(`[RC][refine] 第 ${index + 1} 条失败: ${error && error.message}`);
                    }
                }
                if (!refined || !refined.ok) continue;
                publishCandidate(refined, route.kind || 'refined');
                tried.push({
                    refine: true,
                    seed: Number(route.seedOpt && route.seedOpt.seed) || 0,
                    tail: Number((refined.check && refined.check.tailTarget) || 0),
                    cost: refined.cost,
                });
                if (!best || Number(refined.cost) < Number(best.cost)) {
                    best = Object.assign({}, refined, {
                        kind: route.kind || refined.kind || 'refined',
                        seedOpt: route.seedOpt,
                    });
                    bestCost = Number(refined.cost) || 0;
                }
            }
        }

        phaseTimings[phaseName] = (Number(phaseTimings[phaseName]) || 0)
            + Math.max(0, Date.now() - phaseStart);
        const timings = {
            totalMs: Date.now() - planStartedAt,
            phases: phaseTimings,
            stats: perfStats,
            refineCandidates: refinementPool.length,
            executeCacheSize: executeResultCache.size,
        };
        if (root.__RC_TRACE) {
            console.log('[RC][timings] ' + JSON.stringify(timings));
        }
        if (best) {
            best.tried = tried;
            best.timings = timings;
            return best;
        }
        return { ok: false, tried, note: '所有候选都没构造出验证通过的路线', timings };
    }

    root.AutoWash2RouteConstructor = Object.freeze({
        readSequence, seedFixByExchange, chainChecks, execute, verify, planBest,
        queueOf, replayLockSteps, executeLockRoute, executeLockToPity, nameOf, tailCandidates,
        eatFromSeed, normalizeJumpManualRoute, verifyJumpManual,
        readSequenceAfterSeedOpen, nearestConflictBefore, usesNearestConflict,
        classifyPityOutput, infiniteStartFeasible,
        estimateTailLowerBound,
        annotateOriginalSequence, anchorEventsOf, anchorCandidateEventsOf,
        conflictLookupOf, isSequenceAnchorEligible, resolveSeedState, resolveSeedMethod,
        findCurrentConflictPairs,
    });
})(typeof window !== 'undefined' ? window : globalThis);
