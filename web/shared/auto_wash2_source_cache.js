/* Worker-only memoization of pure RNG draws. No change to RNG rules or UI engines. */
(function (root) {
    'use strict';
    const source = root.WashSourceEngine, caches = new WeakMap();
    class CachedEngine extends source.Engine {
        constructor(data, raw, options) {
            super(data, raw, options);
            let cache = caches.get(raw);
            if (!cache) { cache = new Map(); caches.set(raw, cache); }
            this.drawCache = cache;
        }
        draw(seed, purple, saltOffset = 0) {
            const key = `${seed}|${purple ? 1 : 0}|${saltOffset}`;
            let value = this.drawCache.get(key);
            if (!value) {
                value = super.draw(seed, purple, saltOffset);
                if (this.drawCache.size >= 120000) this.drawCache.clear();
                this.drawCache.set(key, value);
            }
            return value.slice();
        }
    }
    root.AutoWash2SourceCache = Object.freeze({UncachedEngine: source.Engine});
    root.WashSourceEngine = Object.freeze({...source, Engine: CachedEngine});
})(typeof window !== 'undefined' ? window : globalThis);
