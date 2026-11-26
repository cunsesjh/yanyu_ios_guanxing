#!/usr/bin/env node
'use strict';

function readLuckChain(context, raw, candidate, limit, cache) {
    const zizhi = Number(candidate.zizhi)
        || Number(raw.zizhi) || 153;
    const key = `${zizhi}:${Number(candidate.seed)}`;
    if (cache && cache.has(key)) {
        return cache.get(key).slice();
    }
    const zz = context.ZZ_DATA[String(zizhi)];
    if (!zz) return [];
    const engine = new context.WashSourceEngine.Engine(
        context.TALENT_DATA,
        candidate.checkpointRaw || raw,
        {
            slotCount: Number(zz.num_talent) || 0,
            pity: Number(zz.bd_zz) || 0,
            eat: Number(zz.eat_xisui) || 0,
            eligibleZi: zizhi,
            advancePerDraw: true,
        }
    );
    let luck = Number(candidate.seed);
    const chain = [];
    for (let index = 0;
        index < Math.max(1, Number(limit) || 15)
        && Number.isFinite(luck); index++) {
        let draw;
        try {
            draw = engine.draw(luck, true);
        } catch (error) {
            break;
        }
        luck = Number(draw[1]);
        const id = Number(draw[0]);
        if (engine.allowed.has(id)) chain.push(id);
    }
    if (cache) cache.set(key, chain.slice());
    return chain;
}

function scoreSeedChain(
    context, raw, candidate, targets, options
) {
    const o = options || {};
    const targetSet = new Set((targets || []).map(Number));
    const chain = readLuckChain(
        context, raw, candidate, o.chainLimit || 15,
        o.chainCache
    );
    const hits = count => new Set(
        chain.slice(0, count).filter(id => targetSet.has(id))
    ).size;
    const firstTarget = chain.findIndex(id => targetSet.has(id));
    return {
        candidate,
        chain,
        targetHits3: hits(Number(o.window) || 3),
        targetHits4: hits(4),
        targetHits5: hits(5),
        targetHits6: hits(6),
        targetHits7: hits(7),
        targetHits8: hits(8),
        firstTarget: firstTarget < 0 ? 999 : firstTarget + 1,
        preludePills: Number(
            candidate.preludePills != null
                ? candidate.preludePills : candidate.pills
        ) || 0,
    };
}

function compareSeedChainScores(a, b) {
    return (b.targetHits3 - a.targetHits3)
        || (b.targetHits4 - a.targetHits4)
        || (b.targetHits5 - a.targetHits5)
        || (b.targetHits6 - a.targetHits6)
        || (b.targetHits7 - a.targetHits7)
        || (b.targetHits8 - a.targetHits8)
        || (a.preludePills - b.preludePills)
        || (Number(a.candidate && a.candidate.seed)
            - Number(b.candidate && b.candidate.seed));
}

function indexPitySeedChains(
    context, raw, candidates, targets, options
) {
    const o = options || {};
    const chainCache = o.chainCache instanceof Map
        ? o.chainCache : new Map();
    let chainBuilds = 0;
    let chainCacheHits = 0;
    const scored = (candidates || []).map(candidate => {
        const zizhi = Number(candidate.zizhi)
            || Number(raw.zizhi) || 153;
        const key = `${zizhi}:${Number(candidate.seed)}`;
        const cached = chainCache.has(key);
        if (cached) chainCacheHits += 1;
        const item = scoreSeedChain(
            context,
            raw,
            candidate,
            targets,
            Object.assign({}, o, { chainCache })
        );
        if (!cached) {
            chainCache.set(key, item.chain.slice());
            chainBuilds += 1;
        }
        return item;
    });
    return {
        candidates: scored.map(item => Object.assign(
            {},
            item.candidate,
            {
                chain: item.chain.slice(),
                chainScore: {
                    firstTarget: item.firstTarget,
                    targetHits3: item.targetHits3,
                    targetHits4: item.targetHits4,
                    targetHits5: item.targetHits5,
                    targetHits6: item.targetHits6,
                    targetHits7: item.targetHits7,
                    targetHits8: item.targetHits8,
                },
            }
        )),
        scored,
        metrics: {
            chainBuilds,
            chainCacheHits,
            chainCacheSize: chainCache.size,
        },
    };
}

function orderPitySeedChains(
    context, raw, candidates, targets, options
) {
    const indexed = indexPitySeedChains(
        context, raw, candidates, targets, options
    );
    const scored = indexed.scored;
    scored.sort(compareSeedChainScores);
    return {
        candidates: scored.map(item => Object.assign(
            {},
            item.candidate,
            { chain: item.chain.slice() }
        )),
        scored,
        metrics: indexed.metrics,
    };
}

module.exports = {
    compareSeedChainScores,
    indexPitySeedChains,
    orderPitySeedChains,
    readLuckChain,
    scoreSeedChain,
};
