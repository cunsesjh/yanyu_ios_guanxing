/* Allow the one-day level simulation to use a caller-selected base experience. */
(function () {
    'use strict';

    function bind() {
        var button = document.getElementById('btnAdvanceUnlock');
        var input = document.getElementById('upgradeExpAmount');
        if (!button || !input) return;

        function preview() {
            var summary = document.getElementById('unlockResult');
            var student = window.HengshanDayOps && window.HengshanDayOps.get();
            var amount = Math.trunc(Number(input.value));
            if (!summary || !student || !Number.isSafeInteger(amount) || amount < 1 || amount > 1000000000) {
                if (summary) summary.textContent = '请输入 1 至 1,000,000,000 之间的整数经验值。';
                return;
            }
            try {
                var dayStudent = Object.assign({}, student, { dailyBaseExp: amount, dailyExtraExp: 0 });
                var result = window.HengshanStudentEngine.advanceDay(window.HENGSHAN_TALENT_DATA, dayStudent);
                if (!result || !result.state) throw new Error(result && result.error || '内核返回空响应');
                var action = result.action || {};
                var talentBonus = Number(action.talentExpBonus) || 0;
                var extraExp = Number(action.dailyExtraExp) || 0;
                var gained = Number(action.expGained);
                if (!Number.isFinite(gained)) gained = amount + extraExp + talentBonus;
                summary.textContent = '本次预计获得 ' + gained.toLocaleString() + ' 经验，预计到 ' + result.state.level + ' 级';
            } catch (error) {
                summary.textContent = '升级推演失败：' + (error && error.message || String(error));
            }
        }

        input.addEventListener('input', preview);
        input.addEventListener('change', preview);
        button.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopImmediatePropagation();
            var amount = Math.trunc(Number(input.value));
            if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000000) {
                var message = document.getElementById('studentMessage');
                if (message) {
                    message.textContent = '请输入 1 至 1,000,000,000 之间的整数经验值。';
                    message.classList.add('is-error');
                }
                return;
            }
            try {
                var student = window.HengshanDayOps && window.HengshanDayOps.get();
                if (!student) throw new Error('请先选择弟子。');
                var dayStudent = Object.assign({}, student, { dailyBaseExp: amount, dailyExtraExp: 0 });
                var result = window.HengshanStudentEngine.advanceDay(window.HENGSHAN_TALENT_DATA, dayStudent);
                if (!result || !result.state) throw new Error(result && result.error || '内核返回空响应');
                window.HengshanDayOps.apply(result.state);
                preview();
            } catch (error) {
                var message = document.getElementById('studentMessage');
                if (message) {
                    message.textContent = '升级节点推演失败：' + (error && error.message || String(error));
                    message.classList.add('is-error');
                }
            }
        }, true);
        preview();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
