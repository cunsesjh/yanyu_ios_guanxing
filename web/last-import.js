/*
 * APK-WEB-SHIM —— 烟雨存档导出 APK 的「内嵌网页适配层」
 * =====================================================
 * 本文件是唯一真源，由 同步网页.ps1 原样复制成 assets/web/last-import.js。
 *
 * 运行时 App 会在这段代码**前面**拼一行赋值语句（把刚抓到的存档交给网页），
 * 格式与 PC 版 export-plain\write_last_import.ps1 生成的完全一致 ——
 * 网页 home.js 的 initializeHome() 本来就在读这个变量，所以网页源码一行都不用改。
 *
 * 职责：
 *   1. 存档持久化和配额不足时的压缩统一由 shared/save_decrypt.js 处理
 *   2. 界面适配：保留网页的手动导入入口，并提示自动导入方式。
 *
 * 加载位置：index.html 里的 <script src="./last-import.js">，在 shared/save_decrypt.js
 *          之后、home.js 之前执行（顺序由 index.html 保证，勿动）。
 */
(function () {
    'use strict';

    var MARK = 'APK-WEB-SHIM';

    // 供排障：控制台里 window.__YANYU_APK__ 有值即表示 shim 生效
    window.__YANYU_APK__ = MARK;

    /* ------------------------------------------------------------------
     * 2. 界面适配：保留原生文件选择器对应的手动导入入口
     * ------------------------------------------------------------------ */

    function hasStoredSave() {
        var saved = typeof loadShareStore === 'function' && loadShareStore();
        return !!(saved && saved.data);
    }

    function applyGuideMessage() {
        var msg = document.getElementById('homeImportMessage');
        if (!msg) return;
        // home.js 已给出导入结果或错误时不要覆盖
        if (msg.textContent) return;
        msg.classList.remove('is-error');
        msg.textContent = hasStoredSave()
            ? '存档已导入，选择下方板块开始观星。'
            : '请选择上方的 dat.json；导入后即可使用下方全部功能。';
    }

    function applyUi() {
        applyGuideMessage();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(applyUi, 0);
        });
    } else {
        applyUi();
        setTimeout(applyUi, 0);
    }
})();
