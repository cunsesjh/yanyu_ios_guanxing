#!/usr/bin/env node
'use strict';

function runGlobalPitySearch(options) {
    const o = options || {};
    const roots = Array.isArray(o.roots) ? o.roots.slice() : [];
    const expand = typeof o.expand === 'function'
        ? o.expand : (() => []);
    const isComplete = typeof o.isComplete === 'function'
        ? o.isComplete : (() => false);
    const stateKey = typeof o.stateKey === 'function'
        ? o.stateKey : (node => String(node && node.stateKey || ''));
    const limits = o.limits || {};
    const startedAt = Date.now();
    const heap = [];
    const seen = new Map();
    const metrics = {
        rootCount: roots.length,
        expandedNodes: 0,
        generatedNodes: roots.length,
        uniqueStates: 0,
        incumbentUpdates: 0,
        exhausted: false,
        elapsedMs: 0,
    };
    let best = null;
    let sequence = 0;
    let stopReason = '';

    const before = (a, b) => {
        if (a.node.pillsUsed !== b.node.pillsUsed) {
            return a.node.pillsUsed < b.node.pillsUsed;
        }
        return a.sequence < b.sequence;
    };
    const push = item => {
        heap.push(item);
        let index = heap.length - 1;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (before(heap[parent], item)) break;
            heap[index] = heap[parent];
            index = parent;
        }
        heap[index] = item;
    };
    const pop = () => {
        if (!heap.length) return null;
        const first = heap[0];
        const last = heap.pop();
        if (heap.length) {
            let index = 0;
            while (true) {
                let child = index * 2 + 1;
                if (child >= heap.length) break;
                if (child + 1 < heap.length
                    && before(heap[child + 1], heap[child])) {
                    child += 1;
                }
                if (before(last, heap[child])) break;
                heap[index] = heap[child];
                index = child;
            }
            heap[index] = last;
        }
        return first;
    };
    const admit = node => {
        const key = stateKey(node);
        const cost = Number(node && node.pillsUsed) || 0;
        const prior = seen.get(key);
        if (prior != null && prior <= cost) return false;
        seen.set(key, cost);
        metrics.uniqueStates = seen.size;
        push({ node, sequence: sequence++ });
        metrics.generatedNodes++;
        return true;
    };

    for (const root of roots) admit(root);
    const initialUpperBound = Number(o.initialUpperBound);
    let upperBound = Number.isFinite(initialUpperBound)
        && initialUpperBound > 0 ? initialUpperBound : Infinity;

    while (heap.length) {
        if (limits.maxExpandedNodes != null
            && metrics.expandedNodes
                >= Number(limits.maxExpandedNodes)) {
            stopReason = 'max-expanded-nodes';
            break;
        }
        if (limits.maxRuntimeMs != null
            && Date.now() - startedAt
                >= Number(limits.maxRuntimeMs)) {
            stopReason = 'max-runtime';
            break;
        }
        const item = pop();
        const node = item && item.node;
        if (!node) break;
        const key = stateKey(node);
        if (seen.get(key) < node.pillsUsed) continue;
        if (node.pillsUsed >= upperBound) continue;
        if (isComplete(node)) {
            if (!best || node.pillsUsed < best.pillsUsed) {
                best = node;
                upperBound = node.pillsUsed;
                metrics.incumbentUpdates++;
                if (typeof o.onComplete === 'function') {
                    o.onComplete(node, metrics);
                }
            }
            continue;
        }
        metrics.expandedNodes++;
        const children = expand(node) || [];
        for (const child of children) {
            if (Number(child && child.pillsUsed) >= upperBound) {
                continue;
            }
            admit(child);
        }
    }

    metrics.elapsedMs = Date.now() - startedAt;
    if (!stopReason && !heap.length) {
        stopReason = 'global-pity-exhausted';
        metrics.exhausted = true;
    }
    return {
        best,
        metrics,
        stopReason,
    };
}

module.exports = {
    runGlobalPitySearch,
};
