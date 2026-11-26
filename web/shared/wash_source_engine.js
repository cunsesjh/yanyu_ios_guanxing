/*
 * wash_source_engine.js —— 主线程的源码洗脉引擎（薄封装）
 * ------------------------------------------------------------------
 * 历史上这里曾经有第二份、不完整的引擎实现（写死 4 槽 / 5 丹 / 900 保底，
 * 不认资质，也不按 RC 推进 salt）。它和后台 worker 用的
 * wash_route_engine.js 是两份代码，于是同一份存档在界面上会出现两条互相矛盾的脉序：
 *
 *   - 主线程推演的「紫脉脉序」按 4 槽 + 保底 900 算 ⇒ 3 槽角色（如步惊云 153）
 *     从第一洗就与游戏不一致，而且完全不认 BornTalent.RC 的 salt 偏移；
 *   - 后台 A* 路线却按真实资质、真实 RC 算。
 *
 * 现在只保留 wash_route_engine.js 一份实现（含资质分档、RC 推进与 previewSequence），
 * 本文件只做自检，不再重复实现算法。
 * 加载顺序：wash_route_engine.js 必须在本文件之前加载。
 */
(function (root) {
    'use strict';

    const engine = root.WashSourceEngine;
    if (!engine || typeof engine.Engine !== 'function') {
        console.error('[wash_source_engine] 未找到 WashSourceEngine：请确认 wash_route_engine.js 已在本文件之前加载');
        return;
    }
    if (typeof engine.Engine.prototype.previewSequence !== 'function'
        || typeof engine.Engine.prototype.slotCountFor !== 'function') {
        console.error('[wash_source_engine] wash_route_engine.js 版本过旧：缺少 previewSequence / slotCountFor');
    }
})(typeof window !== 'undefined' ? window : globalThis);
