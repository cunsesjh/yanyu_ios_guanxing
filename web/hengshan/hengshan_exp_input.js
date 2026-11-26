/* Allow the one-day level simulation to use a caller-selected base experience. */
(function () {
    'use strict';

    function bind() {
        var button = document.getElementById('btnAdvanceUnlock');
        var input = document.getElementById('upgradeExpAmount');
        if (!button || !input) return;
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
                var message = document.getElementById('studentMessage');
                if (message) {
                    message.textContent = '已按 ' + amount.toLocaleString() + ' 基础经验推演并应用；弟子经验与等级已同步更新，导入存档未改变。';
                    message.classList.remove('is-error');
                }
            } catch (error) {
                var message = document.getElementById('studentMessage');
                if (message) {
                    message.textContent = '升级节点推演失败：' + (error && error.message || String(error));
                    message.classList.add('is-error');
                }
            }
        }, true);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
