/*
 * hengshan_shop_view.js — 恒山页页签切换 + 商店候选池
 * 职责：
 *   1) 页签栏（弟子推演 / 自动推演弟子）切换与激活态维护；
 *   2) 商店候选池：当前存档里的商店候选 + 今日尚未刷新时用引擎推算的下一批，
 *      供「自动推演弟子」扫描。候选本身在「弟子推演」的下拉框里已可选，
 *      因此不再单独提供商店浏览页。
 * 加载顺序：必须在 hengshan.js 之后（页面底部）。
 */
(function () {
    'use strict';

    var DATA = window.HENGSHAN_TALENT_DATA;
    var SHOP_DATA = window.HENGSHAN_SHOP_DATA;
    var E = window.HengshanStudentEngine;

    var TOOLS = ['manual', 'auto'];

    /* 每日可刷新次数（游戏内商店每天可手动刷新 1 次） */
    var DAILY_REFRESH_LIMIT = 1;

    function el(id) { return document.getElementById(id); }

    /* —— 页签切换 —— */
    function switchHengshanTool(tool) {
        var target = TOOLS.indexOf(String(tool)) >= 0 ? String(tool) : 'manual';
        var views = document.querySelectorAll('.hengshan-view');
        for (var v = 0; v < views.length; v += 1) {
            views[v].hidden = views[v].getAttribute('data-hengshan-view') !== target;
        }
        var buttons = document.querySelectorAll('#tabBar [data-hengshan-tool]');
        for (var b = 0; b < buttons.length; b += 1) {
            buttons[b].classList.toggle('is-active', buttons[b].getAttribute('data-hengshan-tool') === target);
        }
        document.documentElement.dataset.hengshanView = target;
        /* 通知 hengshan.js 刷新顶部导出按钮的可见性/文案 */
        try {
            window.dispatchEvent(new CustomEvent('yyjh:feature-change'));
        } catch (error) { /* 无 DOM 环境忽略 */ }
        return target;
    }
    window.switchHengshanTool = switchHengshanTool;

    /* —— 商店候选池 —— */

    /* 存档里真实存在的商店候选 */
    function getCurrentCandidates() {
        var list = [];
        try {
            if (window.HengshanShopState && typeof window.HengshanShopState.getBackpackStudents === 'function') {
                list = window.HengshanShopState.getBackpackStudents() || [];
            }
        } catch (error) { list = []; }
        return list;
    }

    function getShopState() {
        try {
            if (window.HengshanShopState && typeof window.HengshanShopState.getShopState === 'function') {
                return window.HengshanShopState.getShopState();
            }
        } catch (error) { /* ignore */ }
        return null;
    }

    /*
     * 推算"再刷新一次"会出现的那批候选。
     * 引擎接口：shopRefresh(talentData, shopData, state) -> 下一批候选
     * state 形如 { seed, refreshes, npc }，来自 collectStudentGroups 的 shopState。
     * 返回结构可能是数组或 { students: [...] }，这里两种都兼容。
     */
    function predictRefreshBatch(state) {
        if (!E || typeof E.shopRefresh !== 'function') return [];
        if (!state || !Number.isFinite(Number(state.seed)) || Number(state.seed) <= 0) return [];
        var used = Math.max(0, Number(state.refreshes) || 0);
        if (used >= DAILY_REFRESH_LIMIT) return [];   // 今日刷新机会已用完
        var nextState = {
            seed: Number(state.seed),
            refreshes: used,
            npc: state.npc || {}
        };
        var raw;
        try {
            raw = E.shopRefresh(DATA, SHOP_DATA, nextState);
        } catch (error) { return []; }
        if (Array.isArray(raw)) return raw;
        if (raw && Array.isArray(raw.students)) return raw.students;
        return [];
    }

    /*
     * 引擎 shopRefresh 返回的候选已经是完全规范化的
     * （自带 key / seed / talents / dailyBaseExp / levelGrowth 等），
     * 不需要再用存档候选当模板去补齐——早期那样做会让它继承模板的占位种子。
     * 这里只做标记：source 改成 shop-preview（供界面标注「刷新」、
     * 并让 prepareRecruit 生效），其余一律沿用引擎返回值。
     */
    function withTemplate(student, index, day) {
        if (!student) return null;
        var seed = Number(student.seed);
        /* 没有有效种子就不合成，避免产生"预测必然出错"的候选 */
        if (!Number.isFinite(seed) || seed <= 0) return null;
        var merged = Object.assign({}, student);
        merged.source = 'shop-preview';
        merged.key = String(day ? ('future-' + day + '-') : '')
            + String(student.key || ('preview-' + index + '-' + seed));
        merged.name = student.name || ('刷新候选 ' + (index + 1));
        merged.level = Math.max(1, Number(student.level) || 1);
        merged.exp = Math.max(0, Number(student.exp) || 0);
        merged.talents = ((student.talents) || []).map(Number).filter(function (id) { return id > 0; });
        if (day) merged.shopDay = day;
        return merged;
    }

    function normalizeRefreshResult(raw, fallbackState) {
        var students = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.students) ? raw.students : []);
        var returnedState = raw && !Array.isArray(raw) && (raw.nextState || raw.next_state || raw.state);
        var seed = Number(returnedState && returnedState.seed);
        if (!(seed > 0)) seed = Number(raw && !Array.isArray(raw) && (raw.nextSeed || raw.next_seed || raw.seed));
        /* 商店候选在刷新时共用刷新后的占位种子；旧内核只返回候选数组时以此继续推演。 */
        if (!(seed > 0) && students.length) seed = Number(students[0] && students[0].seed);
        return {
            students: students,
            state: {
                seed: seed > 0 ? seed : Number(fallbackState && fallbackState.seed),
                refreshes: 0,
                npc: (returnedState && returnedState.npc)
                    || (raw && !Array.isArray(raw) && raw.npc)
                    || (fallbackState && fallbackState.npc)
                    || {}
            }
        };
    }

    function predictFutureShopStudents(days, initialState) {
        var count = [3, 5, 10, 30].indexOf(Number(days)) >= 0 ? Number(days) : 5;
        var start = initialState || getShopState();
        if (!E || typeof E.shopRefresh !== 'function') return [];
        if (!start || !(Number(start.seed) > 0)) return [];
        var state = { seed: Number(start.seed), refreshes: 0, npc: start.npc || {} };
        var result = [];
        for (var day = 1; day <= count; day += 1) {
            var raw;
            try {
                raw = E.shopRefresh(DATA, SHOP_DATA, {
                    seed: state.seed,
                    refreshes: 0,
                    npc: state.npc
                });
            } catch (error) { break; }
            var normalized = normalizeRefreshResult(raw, state);
            if (!normalized.students.length || !(Number(normalized.state.seed) > 0)) break;
            normalized.students.forEach(function (student, index) {
                var prepared = withTemplate(student, index, day);
                if (prepared) result.push(prepared);
            });
            state = normalized.state;
        }
        return result;
    }

    /* 供自动模拟取用：当前候选 + （未刷新时）推算批 */
    function getShopScanStudents() {
        var current = getCurrentCandidates();
        var predicted = predictRefreshBatch(getShopState())
            .map(function (student, index) { return withTemplate(student, index); })
            .filter(Boolean);
        if (!predicted.length) return current.slice();
        /* 按 key 去重，避免与当前候选重复 */
        var seen = Object.create(null);
        current.forEach(function (s) { seen[String(s.key)] = true; });
        return current.concat(predicted.filter(function (s) {
            return !seen[String(s.key)];
        }));
    }

    /* —— 事件绑定 —— */
    function bindEvents() {
        var tabBar = el('tabBar');
        if (tabBar) {
            tabBar.addEventListener('click', function (event) {
                var btn = event.target.closest && event.target.closest('[data-hengshan-tool]');
                if (!btn) return;
                switchHengshanTool(btn.getAttribute('data-hengshan-tool'));
            });
        }
    }

    function init() {
        if (!el('tabBar')) return;
        bindEvents();
        var fromQuery = new URLSearchParams(window.location.search).get('tool');
        var initial = TOOLS.indexOf(fromQuery) >= 0 ? fromQuery : 'manual';
        switchHengshanTool(initial);
    }

    /* 供无头冒烟 / 页面调试使用 */
    window.HengshanShopView = Object.freeze({
        switchTool: switchHengshanTool,
        getShopScanStudents: getShopScanStudents,
        getCurrentCandidates: getCurrentCandidates,
        predictRefreshBatch: predictRefreshBatch,
        predictFutureShopStudents: predictFutureShopStudents,
        normalizeRefreshResult: normalizeRefreshResult,
        getShopState: getShopState
    });

    if (typeof document === 'undefined') return;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
