(function (root) {
    'use strict';

    const MAX_RANDOM = 2047483645;
    const WHALE_MASK48 = (1n << 48n) - 1n;
    const WHALE_MULTIPLIER = 0x5deece66dn;
    const WHALE_INCREMENT = 0xbn;
    const QUALITY_WEIGHT = Object.freeze({ 1: 560, 2: 374, 3: 64, 4: 2 });
    const PITY = 900;
    const SLOT_COUNT = 4;
    // 资质 → 槽位 / 每洗丹耗基数 / 保底阈值。
    // 这三个值都必须按资质分档，写死成 154 的 4 槽 / 5 丹 / 900 保底会让
    // 0–3 槽角色（例如步惊云 153）整条脉序从第一洗就错。
    const ZZ_RULES = Object.freeze({
        150: Object.freeze({ slots: 0, baseCost: 1, pity: 0 }),
        151: Object.freeze({ slots: 1, baseCost: 1, pity: 700 }),
        152: Object.freeze({ slots: 2, baseCost: 2, pity: 800 }),
        153: Object.freeze({ slots: 3, baseCost: 3, pity: 850 }),
        154: Object.freeze({ slots: 4, baseCost: 5, pity: 900 }),
    });

    const APK_TALENT_INSERTION_ORDER = Object.freeze([
        ...range(170, 211), ...range(230, 254), 400, 401, ...range(255, 280),
        ...range(281, 285), ...range(402, 420),
        290, 297, 298, 291, 299, 300, 292, 295, 296, 293, 301, 302, 294,
        ...range(303, 317), 332, ...range(318, 331), ...range(333, 370),
    ].map(String));

    function range(start, end) {
        const result = [];
        for (let value = start; value <= end; value++) result.push(value);
        return result;
    }

    function u32(value) {
        return value >>> 0;
    }

    function rol(value, bits) {
        return u32((value << bits) | (value >>> (32 - bits)));
    }

    function getU32(bytes, start) {
        return u32(bytes[start]
            | (bytes[start + 1] << 8)
            | (bytes[start + 2] << 16)
            | (bytes[start + 3] << 24));
    }

    function stringHash(text) {
        const bytes = new TextEncoder().encode(String(text));
        const length = bytes.length;
        let hash = length;
        let a;
        let b;
        if (length >= 4) {
            a = getU32(bytes, 0);
            hash = u32(hash ^ getU32(bytes, length - 4));
            b = getU32(bytes, (length >>> 1) - 2);
            hash = u32(hash ^ b);
            hash = u32(hash - rol(b, 14));
            b = u32(b + getU32(bytes, (length >>> 2) - 1));
        } else if (length > 0) {
            a = bytes[0];
            hash = u32(hash ^ bytes[length - 1]);
            b = bytes[length >>> 1];
            hash = u32(hash ^ b);
            hash = u32(hash - rol(b, 14));
        } else {
            return 0;
        }
        a = u32(a ^ hash);
        a = u32(a - rol(hash, 11));
        b = u32(b ^ a);
        b = u32(b - rol(a, 25));
        hash = u32(hash ^ b);
        hash = u32(hash - rol(b, 16));
        return hash;
    }

    class LuaNode {
        constructor() {
            this.key = null;
            this.value = false;
            this.next = null;
        }
    }

    class LuaTable {
        constructor() {
            this.nodes = [];
            this.freeTop = 0;
        }

        get mask() {
            return this.nodes.length ? this.nodes.length - 1 : 0;
        }

        main(key) {
            return stringHash(key) & this.mask;
        }

        resizeFor() {
            const keys = this.nodes.filter(node => node.value).map(node => node.key);
            const total = keys.length + 1;
            const bits = total === 1 ? 1 : Math.ceil(Math.log2(total));
            this.nodes = Array.from({ length: 1 << bits }, () => new LuaNode());
            this.freeTop = this.nodes.length;
            keys.forEach(key => this.insert(key));
        }

        insert(key) {
            if (!this.nodes.length) this.resizeFor();
            let index = this.main(key);
            let node = this.nodes[index];
            if (node.value) {
                while (true) {
                    if (this.freeTop === 0) {
                        this.resizeFor();
                        this.insert(key);
                        return;
                    }
                    this.freeTop -= 1;
                    if (this.nodes[this.freeTop].key === null) break;
                }
                const freeIndex = this.freeTop;
                const collideIndex = this.main(node.key);
                if (collideIndex !== index) {
                    let predecessor = collideIndex;
                    while (this.nodes[predecessor].next !== index) predecessor = this.nodes[predecessor].next;
                    this.nodes[predecessor].next = freeIndex;
                    const free = this.nodes[freeIndex];
                    free.value = node.value;
                    free.key = node.key;
                    free.next = node.next;
                    node.next = null;
                    node.value = false;
                    let cursor = freeIndex;
                    while (this.nodes[cursor].next !== null) {
                        const nextIndex = this.nodes[cursor].next;
                        if (this.nodes[nextIndex].value && this.main(this.nodes[nextIndex].key) === index) {
                            this.nodes[cursor].next = this.nodes[nextIndex].next;
                            this.nodes[nextIndex].next = node.next;
                            node.next = nextIndex;
                        } else {
                            cursor = nextIndex;
                        }
                    }
                } else {
                    const free = this.nodes[freeIndex];
                    free.next = node.next;
                    node.next = freeIndex;
                    index = freeIndex;
                    node = free;
                }
            }
            node.key = key;
            node.value = true;
        }

        pairs() {
            return this.nodes.filter(node => node.value).map(node => node.key);
        }
    }

    function apkPairsOrder() {
        const table = new LuaTable();
        APK_TALENT_INSERTION_ORDER.forEach(key => table.insert(key));
        return table.pairs();
    }

    function luaRandom(seed, upper) {
        const limit = BigInt(Math.trunc(Number(upper)));
        if (limit <= 0n) throw new Error('原生随机数上限必须大于 0');
        const seed32 = BigInt.asUintN(32, BigInt(Math.trunc(Number(seed))));
        let state = ((seed32 << 16n) | 0x330en) & WHALE_MASK48;
        state = (state * WHALE_MULTIPLIER + WHALE_INCREMENT) & WHALE_MASK48;
        const raw = state >> 17n;
        return Number(raw % limit) + 1;
    }

    function weightedDraw(seed, weights, roleId, salt) {
        const total = weights.reduce((sum, value) => sum + value, 0);
        const nextSeed = luaRandom(Number(seed) + total + Number(roleId) + Number(salt), MAX_RANDOM);
        const point = nextSeed % total + 1;
        let cumulative = 0;
        for (let index = 0; index < weights.length; index++) {
            cumulative += weights[index];
            if (point <= cumulative) return [index, nextSeed];
        }
        throw new Error('源码权重抽取越界');
    }

    function numeric(value, fallback = 0) {
        const result = Number(value);
        return Number.isFinite(result) ? result : fallback;
    }

    function normalizeLimit(config, name) {
        if (config && config.limits && Object.prototype.hasOwnProperty.call(config.limits, name)) {
            return config.limits[name];
        }
        return config ? config[name] : undefined;
    }

    function clampZiZhi(value, fallback = 154) {
        return Math.max(150, Math.min(154, Math.trunc(numeric(value, fallback))));
    }

    function allowed(config, source, zi) {
        if (!numeric(config && config.weight)) return false;
        const vipLimit = normalizeLimit(config, 'vip_limit');
        if (vipLimit != null && numeric(vipLimit) > source.vip) return false;
        const charLimit = normalizeLimit(config, 'char_limit');
        if (charLimit != null
            && !(numeric(charLimit) === 101 && source.roleId === 1)
            && numeric(charLimit) !== source.roleId) return false;
        const sexLimit = normalizeLimit(config, 'sex_limit');
        if (sexLimit != null && numeric(sexLimit) !== source.sex) return false;
        const zzLimit = normalizeLimit(config, 'zz_limit');
        if (zzLimit != null) {
            if (Array.isArray(zzLimit)) {
                if (!zzLimit.slice(0, 4).map(Number).includes(zi)) return false;
            } else if (numeric(zzLimit) !== zi) return false;
        }
        const parLimit = normalizeLimit(config, 'par_limit');
        if (Array.isArray(parLimit) && source.globalVars[String(parLimit[0])] !== parLimit[1]) return false;
        const levelLimit = normalizeLimit(config, 'lv_limit');
        if (levelLimit != null && source.roleLevel > numeric(levelLimit)) return false;
        const statLimit = normalizeLimit(config, 'sx_limit');
        if (statLimit != null) {
            const limits = Array.isArray(statLimit) && Array.isArray(statLimit[0])
                ? statLimit
                : [statLimit];
            const aliases = { str: 'str_val', con: 'con', dex: 'dex', int: 'int_val' };
            for (const entry of limits) {
                if (!Array.isArray(entry) || entry.length < 2) return false;
                const rawName = String(entry[0] || '').trim();
                const statName = aliases[rawName] || rawName;
                if (numeric(source.roleStats[statName]) < numeric(entry[1])) return false;
            }
        }
        return true;
    }

    // —— 默认结构性钩子（现行算法）——
    // 未来版本若改变保底判定 / 欧气种子初始化 / 计数器步进 / 紫脉累加规则，
    // 只需传入对应 hook 覆盖默认实现，wash() 主体无需改动（可插拔核心）
    function defaultPityActive(ctx) { return ctx.pity > 0 && ctx.luckyBefore >= ctx.pity; }
    function defaultSeedLuck(state) { return state.luckSeed == null ? state.bornSeed : state.luckSeed; }
    function defaultSaltOffset(ctx) { return ctx.advance ? ctx.bornRC : 0; }
    function defaultAdvanceRc(ctx) { return ctx.advance ? ctx.bornRC + 1 : ctx.bornRC; }
    function defaultTalLuckyAfter(ctx) { return ctx.newPurple ? 0 : ctx.luckyBefore + ctx.need; }

    function cloneState(state) {
        return {
            bornSeed: numeric(state.bornSeed),
            luckSeed: state.luckSeed == null ? null : numeric(state.luckSeed),
            bornRC: numeric(state.bornRC),
            talLucky: numeric(state.talLucky),
            zizhi: clampZiZhi(state.zizhi, 154),
            talents: (state.talents || []).map(Number),
        };
    }

    function stateKey(state) {
        return `${clampZiZhi(state.zizhi, 154)}|${state.bornSeed}|${state.luckSeed == null ? '-' : state.luckSeed}|${numeric(state.bornRC)}|${state.talLucky}|${state.talents.join(',')}`;
    }

    class Engine {
        constructor(talentData, initialState, options = {}) {
            this.source = {
                vip: numeric(initialState.vip, 1),
                roleId: numeric(initialState.role_id),
                salt: numeric(initialState.salt) % 1000000,
                sex: numeric(initialState.sex, 1),
                roleLevel: numeric(initialState.role_level, 90),
                roleStats: initialState.role_stats || {},
                globalVars: initialState.global_vars || {},
            };
            const ordered = apkPairsOrder()
                .map(key => talentData[String(key)])
                .filter(item => item && numeric(item.weight));
            if (ordered.length !== 114) {
                throw new Error(`天赋数据快照不一致：预期 114 条，实际 ${ordered.length} 条`);
            }
            this.config = new Map(ordered.map(item => [numeric(item.id), item]));
            this.allIds = ordered.map(item => numeric(item.id));
            // qualityWeight 可覆盖：未来版本若改变「品质→权重」映射，传入 options.qualityWeight 即可
            this.qualityWeight = (options.qualityWeight && typeof options.qualityWeight === 'object')
                ? options.qualityWeight : QUALITY_WEIGHT;
            this.allWeights = ordered.map(item => Number(this.qualityWeight[numeric(item.weight)]) || numeric(item.weight));
            const purples = ordered.filter(item => numeric(item.weight) === 4);
            this.purpleIds = purples.map(item => numeric(item.id));
            this.purpleWeights = purples.map(() => 2);
            // 起始资质（决定槽位 / 保底 / 丹耗）。
            // 有些调用方只给 slotCount / eligibleZi、不给 zizhi（例如洗脉注册表的
            // toRaw() 就只带种子与槽位）—— 这时必须把资质从 options 里补回来，
            // 否则会静默退回 154（4 槽），3 槽角色的整条脉序又会算错。
            this.initialZiZhi = clampZiZhi(
                initialState.zizhi != null ? initialState.zizhi
                    : (options.zizhi != null ? options.zizhi : options.eligibleZi),
                154);
            // —— 可插拔参数：默认值 = 154 资质下的现行值，不传则行为与改动前逐位一致 ——
            this.slotCount = Number.isFinite(Number(options.slotCount)) ? Number(options.slotCount) : SLOT_COUNT;
            // 显式给了 pity 就以它为准（注册表会传当前资质的 bd_zz），否则按资质分档查表
            this.pity = Number.isFinite(Number(options.pity)) ? Number(options.pity) : null;
            this.eat = Number.isFinite(Number(options.eat)) ? Number(options.eat) : 5;
            this.eligibleZi = Number.isFinite(Number(options.eligibleZi)) ? Number(options.eligibleZi) : 154;
            // 每次抽取后推进 RC（salt 偏移 + RC 自增）。当前算法为 true；
            // 旧内核不推进 RC，故缺省 false 以保持旧调用点逐位不变。
            this.advancePerDraw = !!options.advancePerDraw;
            const eligibleTalentIds = Array.isArray(options.eligibleTalentIds)
                ? options.eligibleTalentIds.map(Number).filter(id => id > 0)
                : null;
            this.externalAllowed = eligibleTalentIds ? new Set(eligibleTalentIds.filter(id => this.config.has(id))) : null;
            // allowed = 该角色「最终可洗到」的可选天赋集合。必须按招式资质门槛算：
            // 用 154 过滤会把 0–3 槽角色能洗出的紫脉挡掉，脉序直接少一大截。
            this.allowed = new Set(ordered.filter(item => allowed(item, this.source, this.eligibleZi)).map(item => numeric(item.id)));
            this.hooks = {
                pityActive: defaultPityActive,
                seedLuck: defaultSeedLuck,
                saltOffset: defaultSaltOffset,
                advanceRc: defaultAdvanceRc,
                talLuckyAfter: defaultTalLuckyAfter,
                ...((options.hooks && typeof options.hooks === 'object') ? options.hooks : {}),
            };
            this.dlcMode = !!options.dlcMode;
            const channel = String(options.saveChannel || initialState.save_channel || initialState.channel || '').trim().toLowerCase();
            this.international = options.international != null
                ? !!options.international
                : (channel === '国际服' || channel === '國際服' || channel === 'oversea' || channel === 'international');
            // 73420 起普通洗脉按 RC 做 salt 偏移并自增（旧档不参与）
            this.useBornRC = this.international
                || this.advancePerDraw
                || (typeof SequenceRules !== 'undefined' && typeof SequenceRules.washRC === 'function'
                    ? SequenceRules.washRC(initialState)
                    : false);
        }

        initialState(raw) {
            const zizhi = clampZiZhi(raw.zizhi, this.initialZiZhi || 154);
            const slots = this.slotCountFor(zizhi);
            return {
                bornSeed: numeric(raw.seed),
                luckSeed: raw.luck_seed_inited ? numeric(raw.luck_seed) : null,
                bornRC: numeric(raw.born_talent_rc != null ? raw.born_talent_rc : raw.bornTalentRC),
                talLucky: numeric(raw.tal_lucky),
                zizhi,
                // ⚠ 必须保留 `0` —— 它是「锁定着的空槽」占位符，不是「没这条脉」。
                // 空脉截断（simulator 里三脉神脉／四脉空脉两处）就是靠 {id:0, locked:true}
                // 表达「这一格锁住、不参与本次刷新」的；早先这里 filter(id > 0) 会把它丢掉，
                // 于是那一格被当成空槽重新抽，多洗出一条脉，顺序校验必然失败
                // （实测火工老僧刀法绝伦：期望前缀 [181,263]，实际 [180,181,263]）。
                // 只滤掉负数／NaN 这类真正的非法值。
                talents: (raw.talents || [])
                    .map(item => numeric(item && item.id != null ? item.id : item))
                    .filter(id => Number.isFinite(id) && id >= 0)
                    .slice(0, slots),
            };
        }

        slotCountFor(zizhi) {
            return ZZ_RULES[clampZiZhi(zizhi, 154)]?.slots ?? SLOT_COUNT;
        }

        ruleFor(zizhi) {
            return ZZ_RULES[clampZiZhi(zizhi, 154)] || ZZ_RULES[154];
        }

        isAllowedAt(configOrId, zizhi) {
            const config = typeof configOrId === 'object' ? configOrId : this.config.get(numeric(configOrId));
            if (!config) return false;
            const id = numeric(config.id);
            if (this.externalAllowed && this.externalAllowed.has(id)) return true;
            if (!allowed(config, this.source, zizhi)) return false;
            if (!this.externalAllowed) return true;
            return !allowed(config, this.source, this.initialZiZhi) && allowed(config, this.source, zizhi);
        }

        allowedSet(zizhi) {
            return new Set(this.allIds.filter(id => this.isAllowedAt(id, zizhi)));
        }

        // Keep the public API expected by simulator.js and its older callers.
        // The set is scoped by the requested aptitude, while the full state is
        // retained in the signature for adapters that specialize this method.
        allowedForState(state, zizhi = state && state.zizhi) {
            return this.allowedSet(clampZiZhi(zizhi, this.initialZiZhi || 154));
        }

        upgradeToThree(sourceState) {
            const state = cloneState(sourceState);
            if (state.zizhi >= 153) return state;
            state.zizhi = 153;
            state.talents = state.talents.slice(0, 3);
            return state;
        }

        upgradeToFour(sourceState) {
            const state = cloneState(sourceState);
            if (state.zizhi >= 154) return state;
            state.zizhi = 154;
            state.talents = state.talents.slice(0, SLOT_COUNT);
            return state;
        }

        quality(id) {
            return numeric(this.config.get(numeric(id))?.weight);
        }

        talentType(id) {
            const item = this.config.get(numeric(id));
            return numeric(item && item.type, numeric(id));
        }

        isShenmai(id) {
            const talentId = numeric(id);
            return talentId === 248 || talentId === 249 || talentId === 250
                || this.talentType(talentId) === 248;
        }

        hasOrdinaryPurpleSuccessor(id) {
            const talentId = numeric(id);
            if (this.quality(talentId) === 4 || this.isShenmai(talentId)) return false;
            const type = this.talentType(talentId);
            return this.purpleIds.some(candidate => this.allowed.has(candidate)
                && !this.isShenmai(candidate) && this.talentType(candidate) === type);
        }

        name(id) {
            return this.config.get(numeric(id))?.name || `天赋 #${id}`;
        }

        draw(seed, purple, saltOffset = 0) {
            const ids = purple ? this.purpleIds : this.allIds;
            const weights = purple ? this.purpleWeights : this.allWeights;
            const [index, nextSeed] = weightedDraw(seed, weights, this.source.roleId, this.source.salt + numeric(saltOffset));
            return [ids[index], nextSeed];
        }

        wash(sourceState, keepPositions) {
            const state = cloneState(sourceState);
            const rule = this.ruleFor(state.zizhi);
            const slotCount = this.slotCountFor(state.zizhi);
            if (!slotCount) throw new Error('当前资质没有可洗脉槽位');
            // 锁定顺序由场上槽位决定，调用者不能通过倒序传索引把冲突移到紫前。
            const positions = [...new Set((keepPositions || []).map(Number))].sort((a, b) => a - b);
            if (positions.some(index => !Number.isInteger(index) || index < 0 || index >= state.talents.length)
                || positions.length > slotCount) {
                throw new Error('锁定槽位无效');
            }
            const kept = positions.map(index => state.talents[index]);
            // 槽位全锁时不抛错：与上游内核一致，原样返回、本次不抽签
            // （need = 0 ⇒ generatedBars 0、talLucky 不推进、丹耗按全锁档计）。
            // 后台 A* 的每条路径都有 canWash() 前置守卫，这里不再需要断言。
            const need = slotCount - kept.length;
            const talents = kept.slice();
            let born = state.bornSeed;
            let luck = state.luckSeed;
            let bornRC = numeric(state.bornRC);
            let luckyBefore = state.talLucky;
            if (this.dlcMode) luckyBefore += Math.max(1, 3 * kept.length);
            // pity<=0 表示「无保底机制」，不能当成「永远保底」
            const advance = this.advancePerDraw || this.international;
            // 显式 pity（注册表按当前资质传入）优先；否则按资质分档查 ZZ_RULES
            const pityThreshold = this.dlcMode ? 300 : (this.pity != null ? this.pity : rule.pity);
            let pityActive = !!this.hooks.pityActive({
                luckyBefore,
                pity: pityThreshold,
            });
            let newPurple = false;
            let draws = 0;
            let pityPurpleId = null;                 // 本次由保底触发的紫脉
            let purpleDraws = 0;
            const generatedEvents = [];              // 实际接受的抽取，供锚点路线按出现事件识别同名紫脉
            while (talents.length < slotCount) {
                let candidate;
                let fromPity = false;
                if (pityActive) {
                    if (luck == null) luck = born;
                    [candidate, luck] = this.draw(luck, true);
                    fromPity = true;
                } else {
                    [candidate, born] = this.draw(born, false, this.hooks.saltOffset({ advance, bornRC }));
                    bornRC = this.hooks.advanceRc({ advance, bornRC });
                }
                draws += 1;
                if (fromPity && this.allowed.has(candidate)) purpleDraws += 1;
                if (draws > 100000) throw new Error('源码洗脉抽取未收敛');
                if (!this.isAllowedAt(candidate, state.zizhi) || talents.includes(candidate)) continue;
                if (this.quality(candidate) === 4 && newPurple) continue;
                talents.push(candidate);
                generatedEvents.push({ id: candidate, bornRC, fromPity, luckSeed: fromPity ? luck : null });
                if (this.quality(candidate) === 4) {
                    if (fromPity && pityPurpleId == null) pityPurpleId = candidate;
                    newPurple = true;
                    pityActive = false;
                }
            }
            return {
                state: {
                    bornSeed: born,
                    luckSeed: luck,
                    bornRC,
                    talLucky: this.hooks.talLuckyAfter({ newPurple, luckyBefore, need }),
                    zizhi: state.zizhi,
                    talents,
                },
                cost: kept.length ? this.eat + 2 * kept.length - 1 : this.eat,
                draws,
                generatedBars: need,
                keepIds: kept,
                pityPurpleId,
                generatedEvents,
                purpleDraws,
            };
        }

        /**
         * 脉序推演：从初始状态连洗，收集出现过的紫脉与置换冲突信息。
         *
         * maxWashes 是「洗髓次数」上限（一次洗髓 = 一次重新抽满空槽），与
         * wasmPreviewSequence(maxWashes) 的调用口径一致 —— 界面上写「已预测 N 次洗髓」。
         *
         * 每条紫脉带两组坐标，与游戏 / 内核口径一致：
         *   wash_no / wash_times = 第几次洗髓（w）
         *   earlier_conflict_*   = 同类型「最近一次」出现，gap 为相差的洗髓次数
         */
        previewSequence(maxWashes, initialRaw, keepPositions = []) {
            const raw = initialRaw || {};
            const limit = Math.max(0, Math.trunc(Number(maxWashes) || 0));
            let state = this.initialState(raw);
            const keepAll = [...new Set((keepPositions || []).map(Number))].sort((a, b) => a - b);
            const keepCount = keepAll.length;
            const purples = [];
            // 场上初始脉播种「最近一次同类型」（washNo=0 / 初始槽位），作为置换冲突候选
            const lastByType = new Map();
            for (const id of state.talents) {
                const talentId = numeric(id);
                if (!talentId || this.isShenmai(talentId)) continue;
                lastByType.set(this.talentType(talentId), {
                    washNo: 0,
                    isPurple: this.quality(talentId) === 4,
                    id: talentId,
                    name: this.name(talentId),
                });
            }
            let w = 0;
            const MAX_ITER = 500000;
            while (w < MAX_ITER && w < limit) {
                w += 1;
                // 首洗用原始锁定索引；其后锁定脉已被引擎排到最前，改用 [0..k-1]，
                // 否则锁定索引漂移会错锁新洗出的随机脉。
                const useKeep = (w === 1 || !keepCount)
                    ? keepAll
                    : Array.from({ length: keepCount }, (_, i) => i);
                const result = this.wash(state, useKeep);
                state = result.state;
                const newTail = state.talents.slice(keepCount); // 本次新抽天赋（不含锁定保留脉）
                const need = newTail.length;
                if (need === 0) break; // 全部锁定，无新条 → 终止
                for (let i = 0; i < need; i += 1) {
                    const talentId = numeric(newTail[i]);
                    const type = this.talentType(talentId);
                    const quality = this.quality(talentId);
                    const washNo = w;
                    const isPity = result.pityPurpleId != null && talentId === numeric(result.pityPurpleId);
                    if (this.isShenmai(talentId)) {
                        // 神脉占位，交给上层的 shenmai 配对逻辑
                        if (quality === 4) {
                            purples.push({
                                talent_id: talentId,
                                talent_name: this.name(talentId),
                                wash_no: washNo,
                                wash_times: washNo,
                                was_pity: isPity,
                                earlier_conflict_name: '',
                                earlier_conflict_wash_no: 0,
                                earlier_conflict_wash_times: 0,
                                earlier_conflict_is_purple: false,
                                earlier_conflict_gap: null,
                                can_exchange: false,
                                block_reason: '',
                            });
                        }
                        continue;
                    }
                    const last = lastByType.get(type);
                    if (quality === 4) {
                        let earlier = null;
                        let canExchange = false;
                        let blockReason = '';
                        if (isPity) {
                            blockReason = '保底脉，无法固定定向冲突';
                        } else if (last) {
                            earlier = last;
                            if (last.isPurple) {
                                canExchange = false;
                                blockReason = '前置同类也是紫脉';
                            } else {
                                canExchange = true;
                            }
                        } else {
                            blockReason = `下一紫「${this.name(talentId)}」无同类冲突，无法置换`;
                        }
                        purples.push({
                            talent_id: talentId,
                            talent_name: this.name(talentId),
                            wash_no: washNo,
                            wash_times: washNo,
                            was_pity: isPity,
                            earlier_conflict_name: earlier ? earlier.name : '',
                            earlier_conflict_wash_no: earlier ? earlier.washNo : 0,
                            earlier_conflict_wash_times: earlier ? earlier.washNo : 0,
                            earlier_conflict_is_purple: earlier ? earlier.isPurple : false,
                            earlier_conflict_gap: earlier ? Math.max(0, washNo - earlier.washNo) : null,
                            can_exchange: canExchange,
                            block_reason: blockReason,
                        });
                    }
                    // 更新「最近一次」同类型（普通脉，含普通紫）
                    lastByType.set(type, {
                        washNo,
                        isPurple: quality === 4,
                        id: talentId,
                        name: this.name(talentId),
                    });
                }
            }
            return { purples, luck_pool: [] };
        }

        replaceablePositions(state, lockedIds = []) {
            const locked = new Set((lockedIds || []).map(Number));
            const shenmaiPositions = state.talents
                .map((id, index) => ({ id, index }))
                .filter(item => this.isShenmai(item.id))
                .map(item => item.index);
            const multiShenmai = shenmaiPositions.length >= 2;
            const seenType = new Map();
            const result = [];
            state.talents.forEach((id, index) => {
                const type = this.talentType(id);
                if (this.isShenmai(id) && multiShenmai) {
                    result.push(index);
                    if (!seenType.has(type)) seenType.set(type, index);
                    return;
                }
                if (seenType.has(type)) {
                    const earlierId = state.talents[seenType.get(type)];
                    if (this.quality(id) === 4 && !this.isShenmai(id)
                        && this.quality(earlierId) < 4 && locked.has(earlierId)) result.push(index);
                } else {
                    seenType.set(type, index);
                }
            });
            return result;
        }

        replace(sourceState, position, lockedIds = []) {
            const state = cloneState(sourceState);
            if (!this.replaceablePositions(state, lockedIds).includes(position)) {
                throw new Error('置换失败：普通紫脉需要在它之前有同类型、非紫且已锁定的冲突脉；后补冲突脉不能续换');
            }
            const talents = state.talents.slice();
            const removedId = talents.splice(position, 1)[0];
            // 置换走欧气紫池，不耗丹、不推进洗髓种子
            let luck = this.hooks.seedLuck(state);
            let draws = 0;
            let purpleDraws = 0;
            while (true) {
                let candidate;
                [candidate, luck] = this.draw(luck, true);
                draws += 1;
                if (this.allowed.has(candidate)) purpleDraws += 1;
                if (draws > 100000) throw new Error('源码置换抽取未收敛');
                if (this.isAllowedAt(candidate, state.zizhi) && !talents.includes(candidate)) {
                    talents.push(candidate);
                    return {
                        state: {
                            bornSeed: state.bornSeed,
                            luckSeed: luck,
                            bornRC: numeric(state.bornRC),
                            talLucky: 0,
                            zizhi: state.zizhi,
                            talents,
                        },
                        removedId,
                        addedId: candidate,
                        draws,
                        purpleDraws,
                    };
                }
            }
        }
    }

    root.WashSourceEngine = Object.freeze({
        APK_TALENT_INSERTION_ORDER,
        QUALITY_WEIGHT,
        PITY,
        ZZ_RULES,
        SLOT_COUNT,
        apkPairsOrder,
        luaRandom,
        weightedDraw,
        cloneState,
        stateKey,
        slotCountForZiZhi: zizhi => ZZ_RULES[clampZiZhi(zizhi, 154)]?.slots ?? SLOT_COUNT,
        Engine,
    });
})(typeof window !== 'undefined' ? window : globalThis);
