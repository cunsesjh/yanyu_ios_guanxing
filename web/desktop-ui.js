/* Common desktop navigation; simulator code and save data stay unchanged. */
(function () {
    'use strict';
    var script = document.currentScript;
    var root = new URL('./', script.src);
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
})();
