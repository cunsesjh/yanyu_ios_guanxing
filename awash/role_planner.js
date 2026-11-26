#!/usr/bin/env node
'use strict';

function currentConflictPairs(raw, context) {
    const zi = Number(raw && raw.zizhi) || 153;
    const zz = context.ZZ_DATA[String(zi)];
    if (!zz) return [];
    const engine = new context.WashSourceEngine.Engine(
        context.TALENT_DATA,
        raw,
        {
            slotCount: Number(zz.num_talent) || 0,
            pity: Number(zz.bd_zz) || 0,
            eat: Number(zz.eat_xisui) || 0,
            eligibleZi: zi,
            advancePerDraw: true,
            dlcMode: !!raw.dlc_mode,
        }
    );
    const state = engine.initialState(
        Object.assign({}, raw, { zizhi: zi })
    );
    const pairs = [];
    state.talents.forEach((carrierId, index) => {
        const id = Number(carrierId);
        if (!(id > 0) || id === 251 || engine.quality(id) !== 4
            || engine.isShenmai(id)) return;
        const type = engine.talentType(id);
        for (let left = index - 1; left >= 0; left--) {
            const conflictId = Number(state.talents[left]);
            if (conflictId === 251 || engine.quality(conflictId) >= 4
                || engine.talentType(conflictId) !== type) continue;
            if (engine.replaceablePositions(state, [conflictId])
                .includes(index)) {
                pairs.push({ conflictId, carrierId: id });
            }
            break;
        }
    });
    const shenmai = state.talents
        .map((id, index) => ({ id: Number(id), index }))
        .filter(item => item.id > 0 && engine.isShenmai(item.id));
    if (shenmai.length >= 2) {
        for (const carrier of shenmai) {
            const partner = shenmai.find(item =>
                item.id !== carrier.id);
            if (!partner
                || !engine.replaceablePositions(
                    state, [partner.id]
                ).includes(carrier.index)) continue;
            pairs.push({
                conflictId: partner.id,
                carrierId: carrier.id,
                shenmaiPair: true,
            });
        }
    }
    return pairs;
}

function beforeFirstPity(seq) {
    const firstPityIndex = seq.findIndex(item =>
        item && item.fromPity);
    return firstPityIndex >= 0
        ? seq.slice(0, firstPityIndex) : seq;
}

function hasOrdinaryAnchorBeforeFirstPity(seq) {
    return beforeFirstPity(seq).some(item => {
        if (!item || item.field || item.fromPity || item.shenmai
            || Number(item.id) === 251) return false;
        if (item.isAnchor === false || item.anchorEligible === false) {
            return false;
        }
        if (item.isAnchor === true || item.anchorEligible === true) {
            return true;
        }
        return Number(item.conflictId) > 0;
    });
}

function isShenmaiEvent(item) {
    if (!item) return false;
    const id = Number(item.id);
    return item.shenmai === true || item.isShenmai === true
        || id === 248 || id === 249 || id === 250;
}

function hasShenmaiMutualAnchorBeforeFirstPity(seq) {
    return beforeFirstPity(seq).filter(isShenmaiEvent).length >= 2;
}

function hasExchangeAnchorBeforeFirstPity(seq) {
    return hasOrdinaryAnchorBeforeFirstPity(seq)
        || hasShenmaiMutualAnchorBeforeFirstPity(seq);
}

function selectPlan(raw, sequenceInfo, options) {
    const o = options || {};
    const context = o.context || sequenceInfo.context;
    const pairs = currentConflictPairs(raw, context);
    const canDirectInfiniteExchange = pairs.length > 0;
    if (raw.luck_seed_inited) {
        return {
            methodOrder: ['fixed-current-chain'],
            preferredMethod: 'fixed-current-chain',
            allowsInfiniteExchange: false,
            allowsPity: false,
            canDirectInfiniteExchange,
            directConflictPairs: pairs,
        };
    }
    const seq = (sequenceInfo && sequenceInfo.seq) || [];
    const first = seq[0] || null;
    const firstSupportsInfinite = !!first && !first.fromPity
        && Number(first.conflictId) > 0;
    const hasLaterPity = seq.some(item => item.fromPity);
    const hasOrdinaryPrePityAnchor =
        hasOrdinaryAnchorBeforeFirstPity(seq);
    const hasShenmaiPrePityAnchor =
        hasShenmaiMutualAnchorBeforeFirstPity(seq);
    const hasPrePityAnchor = hasOrdinaryPrePityAnchor
        || hasShenmaiPrePityAnchor;
    const allowsInfiniteExchange = firstSupportsInfinite
        || hasPrePityAnchor || canDirectInfiniteExchange;
    const allowsPity = !firstSupportsInfinite || hasLaterPity;
    const methodOrder = [];
    if (allowsInfiniteExchange) methodOrder.push('infinite-exchange');
    if (allowsPity) methodOrder.push('pity');
    return {
        methodOrder,
        preferredMethod: methodOrder[0] || null,
        allowsInfiniteExchange,
        allowsPity,
        hasOrdinaryAnchorBeforeFirstPity: hasOrdinaryPrePityAnchor,
        hasShenmaiMutualAnchorBeforeFirstPity: hasShenmaiPrePityAnchor,
        hasExchangeAnchorBeforeFirstPity: hasPrePityAnchor,
        canDirectInfiniteExchange,
        directConflictPairs: pairs,
    };
}

module.exports = {
    currentConflictPairs,
    hasOrdinaryAnchorBeforeFirstPity,
    hasShenmaiMutualAnchorBeforeFirstPity,
    hasExchangeAnchorBeforeFirstPity,
    selectPlan,
};
