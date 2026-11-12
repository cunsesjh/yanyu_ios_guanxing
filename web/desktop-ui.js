/* Common desktop navigation; simulator code and save data stay unchanged. */
(function () {
    'use strict';
    var script = document.currentScript;
    var root = new URL('./', script.src);
    // The native sidebar owns importing in the desktop app. This panel is only
    // for people opening the standalone index.html in a normal browser.
    document.querySelector('.archive-import-panel')?.remove();
    // Keep the existing select and its change handlers. Only replace Chromium's
    // native popup: hovering/scrolling must never commit a value.
    var picker = null;
    function closePicker() {
        if (!picker) return;
        picker.select.setAttribute('aria-expanded', 'false');
        picker.observer.disconnect();
        picker.panel.remove(); picker = null;
    }
    function openPicker(select) {
        if (picker && picker.select === select) { closePicker(); return; }
        closePicker();
        if (select.disabled || select.multiple || select.size > 1) return;
        var panel = document.createElement('div');
        panel.className = 'desktop-select-popup';
        panel.setAttribute('role', 'listbox');
        panel.setAttribute('aria-label', select.getAttribute('aria-label') || select.labels?.[0]?.textContent || '选择选项');
        var active = select.selectedIndex, items = [], typed = '', typedAt = 0;
        function focusItem(index) {
            active = index;
            items.forEach(function (button, i) { if (button) button.classList.toggle('focused', i === index); });
            items[index]?.scrollIntoView({block: 'nearest', behavior: 'instant'});
        }
        function commit(index) {
            if (select.options[index].disabled || select.options[index].parentElement.disabled) return;
            var changed = select.selectedIndex !== index;
            select.selectedIndex = index;
            closePicker(); select.focus({preventScroll: true});
            if (changed) {
                select.dispatchEvent(new Event('input', {bubbles: true}));
                select.dispatchEvent(new Event('change', {bubbles: true}));
            }
        }
        Array.from(select.options).forEach(function (option, index) {
            if (option.hidden) return;
            if (option.parentElement.tagName === 'OPTGROUP' && option === option.parentElement.firstElementChild) {
                var group = document.createElement('div'); group.className = 'desktop-select-group';
                group.textContent = option.parentElement.label; panel.appendChild(group);
            }
            var button = document.createElement('button');
            button.type = 'button'; button.tabIndex = -1; button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', String(index === select.selectedIndex));
            button.textContent = option.text; button.disabled = option.disabled || !!option.parentElement.disabled;
            button.addEventListener('mousedown', function (e) { e.preventDefault(); });
            button.addEventListener('click', function () { commit(index); });
            panel.appendChild(button); items[index] = button;
        });
        document.body.appendChild(panel);
        var rect = select.getBoundingClientRect(), width = Math.min(innerWidth - 16, Math.max(rect.width, 200));
        var below = innerHeight - rect.bottom - 8, above = rect.top - 8;
        panel.style.width = width + 'px';
        panel.style.left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + 'px';
        panel.style.maxHeight = Math.max(60, Math.min(320, Math.max(below, above))) + 'px';
        if (below >= Math.min(240, above)) panel.style.top = (rect.bottom + 4) + 'px';
        else panel.style.bottom = (innerHeight - rect.top + 4) + 'px';
        var observer = new MutationObserver(closePicker);
        observer.observe(select, {childList: true, subtree: true, attributes: true,
            attributeFilter: ['disabled', 'hidden', 'selected', 'label']});
        picker = {select: select, panel: panel, observer: observer, move: function (delta) {
            var index = active;
            do { index += delta; } while (index >= 0 && index < items.length && (!items[index] || items[index].disabled));
            if (items[index] && !items[index].disabled) focusItem(index);
        }, edge: function (last) {
            var candidates = items.map((button, i) => button && !button.disabled ? i : -1).filter(i => i >= 0);
            if (candidates.length) focusItem(last ? candidates[candidates.length - 1] : candidates[0]);
        }, type: function (key) {
            typed = Date.now() - typedAt > 700 ? key : typed + key; typedAt = Date.now();
            var index = items.findIndex(button => button && !button.disabled && button.textContent.toLowerCase().startsWith(typed.toLowerCase()));
            if (index >= 0) focusItem(index);
        }, commit: function () { if (items[active] && !items[active].disabled) commit(active); }};
        select.setAttribute('aria-expanded', 'true'); select.focus({preventScroll: true}); focusItem(active);
    }
    document.addEventListener('mousedown', function (event) {
        var select = event.target.closest('select');
        if (select && !select.multiple && select.size <= 1 && event.button === 0) {
            event.preventDefault(); openPicker(select);
        } else if (picker && !picker.panel.contains(event.target)) closePicker();
    }, true);
    document.addEventListener('keydown', function (event) {
        if (picker) {
            if (event.key === 'Escape' || event.key === 'Tab') { closePicker(); if (event.key === 'Escape') event.preventDefault(); }
            else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); picker.move(event.key === 'ArrowDown' ? 1 : -1); }
            else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); picker.commit(); }
            else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); picker.edge(event.key === 'End'); }
            else if (event.key === 'PageDown' || event.key === 'PageUp') { event.preventDefault(); for (var n = 0; n < 7; n++) picker.move(event.key === 'PageDown' ? 1 : -1); }
            else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) { event.preventDefault(); picker.type(event.key); }
        } else if (event.target.tagName === 'SELECT' && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault(); openPicker(event.target);
        }
    }, true);
    document.addEventListener('wheel', function (event) {
        if (picker && picker.panel.contains(event.target)) return;
        if (picker) closePicker();
        if (document.activeElement?.tagName === 'SELECT') document.activeElement.blur();
    }, {capture: true, passive: true});
    window.addEventListener('resize', closePicker);
    document.addEventListener('scroll', function (e) { if (picker && e.target !== picker.panel) closePicker(); }, true);
    // Each module opens at its header instead of inheriting a previous page's scroll.
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    window.addEventListener('load', function () {
        if (!location.hash) requestAnimationFrame(function () { window.scrollTo(0, 0); });
    }, {once: true});
    var pages = [
        ['首页', 'index.html'],
        ['洗髓模拟', 'wash/index.html'],
        ['装备模拟', 'equip/index.html'],
        ['恒山模拟', 'hengshan/index.html'],
        ['角色面板', 'role/index.html'],
        ['角色状态', 'role/status.html'],
        ['自动模拟', 'auto/index.html'],
        ['鬼市千宝阁', 'guishi/index.html'],
        ['恒山游货郎', 'guishi/index.html?page=hs']
    ];
    document.querySelectorAll('.sim-nav').forEach(function (nav) {
        nav.replaceChildren();
        nav.setAttribute('aria-label', '观星功能导航');
        pages.forEach(function (page) {
            var link = document.createElement('a');
            var target = new URL(page[1], root);
            link.href = target.href;
            link.textContent = page[0];
            var current = target.pathname === location.pathname &&
                (target.searchParams.get('page') || '') === (new URL(location.href).searchParams.get('page') || '');
            if (current) {
                link.className = 'active';
                link.setAttribute('aria-current', 'page');
            }
            nav.appendChild(link);
        });
    });
    if (location.pathname.endsWith('/guishi/index.html')) {
        var page = new URL(location.href).searchParams.get('page') === 'hs' ? 'hs' : 'ghost';
        document.querySelectorAll('.page').forEach(function (node) {
            node.classList.toggle('active', node.id === 'page-' + page);
        });
        ['btnGhostBack', 'btnHsBack'].forEach(function (id) {
            var button = document.getElementById(id);
            if (!button) return;
            var replacement = button.cloneNode(true);
            button.replaceWith(replacement);
            replacement.addEventListener('click', function () { location.href = new URL('index.html', root); });
        });
    }
})();
