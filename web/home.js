(function () {
    'use strict';

    function renderHomeState(data) {
        var shared = data ? { data: data } : (typeof loadShareStore === 'function' ? loadShareStore() : null);
        var hasSave = !!(shared && shared.data);
        var status = document.getElementById('homeSaveStatus');
        var mainRole = document.getElementById('homeMainRole');
        if (status) status.textContent = hasSave ? '导入成功' : '未导入';
        if (mainRole) {
            mainRole.textContent = hasSave && typeof getArchiveMainRoleName === 'function'
                ? getArchiveMainRoleName(shared.data)
                : '—';
        }
        return hasSave;
    }

    function setMessage(message, isError) {
        var element = document.getElementById('homeImportMessage');
        if (!element) return;
        element.textContent = message;
        element.classList.toggle('is-error', !!isError);
        element.classList.toggle('is-success', !isError && message === '导入成功');
    }

    async function handleImport(file) {
        if (!file) return;
        if (typeof _importFeedback === 'function') _importFeedback(true);
        setMessage('正在读取存档…', false);
        try {
            // 统一入口：.yanyu（本地解密）或明文 JSON，其余一律拒绝
            var result = await decryptSaveFile(file);
            if (typeof saveShareStore !== 'function' || !saveShareStore(result.data, {
                version: result.version,
                platform: result.platform || '',
                channel: '',
                format: result.format || 'json'
            })) {
                throw new Error('浏览器无法保存存档，请检查本地存储权限或剩余空间');
            }
            renderHomeState(result.data);
            setMessage('导入成功', false);
        } catch (error) {
            var message = error && error.message ? String(error.message) : '';
            if (message === 'SAVE_FILE_UNSUPPORTED') setMessage('存档失败', true);
            else if (message === 'PLAIN_JSON_INVALID') setMessage('不是有效的存档文件（缺少必要字段）', true);
            else setMessage(message || '数据错误', true);
        } finally {
            if (typeof _importFeedback === 'function') _importFeedback(false);
        }
    }

    function initializeHome() {
        renderHomeState();

        // 自动加载通道（由 export-plain\write_last_import.ps1 生成 bin\web\last-import.js）
        //   新版：window.__latestYanyuB64（密文，本地解密；必要时询问授权码）
        //   兼容：window.__latestPlainSave（老的明文 json）
        var autoYanyu = (typeof window !== 'undefined' && window.__latestYanyuB64) ? window.__latestYanyuB64 : '';
        var autoSave = (typeof window !== 'undefined' && window.__latestPlainSave) ? window.__latestPlainSave : null;
        if (autoYanyu && typeof decryptSaveBytes === 'function' && typeof _b64ToBytes === 'function') {
            decryptSaveBytes(_b64ToBytes(autoYanyu),
                (typeof window !== 'undefined' && window.__latestYanyuName) || '', true)
                .then(function (result) {
                    if (typeof saveShareStore === 'function' && saveShareStore(result.data, {
                        version: result.version,
                        platform: result.platform || '',
                        channel: '',
                        format: result.format || 'json'
                    })) {
                        renderHomeState();
                    } else {
                        setMessage('浏览器无法保存存档，请允许本地存储或释放空间后重试；本地 dat.json 不受影响。', true);
                    }
                })
                .catch(function (err) {
                    var message = err && err.message ? String(err.message) : '';
                    if (message === 'YANYU_CODE_WRONG') setMessage('授权码不对，请重新导入存档', true);
                    else if (message === '已取消导入') setMessage('已取消导入，可手动选择存档', true);
                    else setMessage(message || '自动导入失败，请手动选择存档', true);
                    if (typeof console !== 'undefined' && console.warn) {
                        console.warn('[last-import]', err && err.message ? err.message : err);
                    }
                });
        } else if (autoSave && typeof saveShareStore === 'function') {
            var ok = saveShareStore(autoSave.data || autoSave, {
                version: '明文',
                platform: autoSave.platform || '',
                channel: '',
                format: 'plain-json'
            });
            if (ok) renderHomeState();
            else setMessage('浏览器无法保存存档，请允许本地存储或释放空间后重试；本地 dat.json 不受影响。', true);
        }

        var input = document.getElementById('saveFileInput');
        if (input) input.addEventListener('change', function (event) {
            var file = event.target.files && event.target.files[0];
            handleImport(file);
            event.target.value = '';
        });

        var resetButton = document.getElementById('btnResetWebsite');
        if (resetButton) resetButton.addEventListener('click', function () {
            if (typeof clearWebsiteState === 'function') clearWebsiteState();
            renderHomeState();
            setMessage('重置成功', false);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeHome);
    } else {
        initializeHome();
    }
    setTimeout(function () {
        if (typeof prewarmSql === 'function') prewarmSql();
    }, 200);
})();
