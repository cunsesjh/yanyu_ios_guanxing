(function () {
    'use strict';

    const DAY_MS = 86400000;
    const arrowOffsets = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7};
    const iso = date => date.toISOString().slice(0, 10);
    const utcDate = date => new Date(date + 'T00:00:00Z');

    function adjacentMonth(month, offset) {
        const date = utcDate(month + '-01');
        date.setUTCMonth(date.getUTCMonth() + offset);
        return iso(date).slice(0, 7);
    }

    window.createHengshanDatePicker = function (el, onChange) {
        const fields = ['From', 'To'].map(name => ({
            name, input: el(name), trigger: el(name + 'Pick'), display: el(name + 'Value'),
            placeholder: el(name + 'Value').textContent
        }));
        const dialog = el('Calendar'), daysBody = el('CalendarDays');
        const prev = el('CalendarPrev'), next = el('CalendarNext'), clear = el('CalendarClear');
        let period, active, first, last, month;
        const selectable = date => Boolean(date && date >= first && date <= last);
        const tabStop = () => daysBody.querySelector('[tabindex="0"]');
        const close = () => { if (dialog.open) dialog.close(); };

        function select(value) {
            if (value && !selectable(value)) return;
            active.input.value = value;
            close();
            onChange();
        }

        function paint(focusDate = active.input.value) {
            const [year, number] = month.split('-').map(Number);
            el('CalendarMonth').textContent = year + ' 年 ' + number + ' 月';
            prev.disabled = month <= first.slice(0, 7);
            next.disabled = month >= last.slice(0, 7);

            const leading = (utcDate(month + '-01').getUTCDay() + 6) % 7;
            const end = utcDate(adjacentMonth(month, 1) + '-01');
            end.setUTCDate(0);
            const count = end.getUTCDate();
            const rows = document.createDocumentFragment();
            let row, firstAvailable, preferred;
            for (let cell = 0; cell < Math.ceil((leading + count) / 7) * 7; cell++) {
                if (cell % 7 === 0) {
                    row = document.createElement('tr');
                    rows.append(row);
                }
                const td = document.createElement('td');
                row.append(td);
                const number = cell - leading + 1;
                if (number < 1 || number > count) continue;

                const date = month + '-' + String(number).padStart(2, '0');
                const day = document.createElement('button');
                const beyondForecast = selectable(date) && date > period.last;
                day.className = 'btn';
                day.classList.toggle('is-beyond-forecast', beyondForecast);
                day.type = 'button';
                day.textContent = number;
                day.dataset.date = date;
                day.disabled = !selectable(date);
                day.tabIndex = -1;
                day.setAttribute('aria-label', date + (beyondForecast ? '（需延长预测）' : ''));
                day.setAttribute('aria-pressed', String(date === active.input.value));
                day.onclick = () => select(date);
                td.append(day);
                if (!day.disabled) {
                    firstAvailable ||= day;
                    if (date === focusDate) preferred = day;
                }
            }
            daysBody.replaceChildren(rows);
            (preferred || firstAvailable).tabIndex = 0;
        }

        function open(field) {
            if (dialog.open || field.trigger.disabled) return;
            active = field;
            first = period.first;
            last = period.canExtend ? period.furthest : period.last;
            const other = fields.find(item => item !== active).input.value;
            if (selectable(other)) {
                if (active.name === 'From') last = other;
                else first = other;
            }
            const focusDate = [active.input.value, other, first].find(selectable);
            month = focusDate.slice(0, 7);
            el('CalendarTitle').textContent = '选择' + el(active.name + 'Label').textContent;
            el('CalendarHint').textContent = '可选 ' + first + ' 至 ' + last + '。' +
                (last > period.last ? '带虚线的日期需要延长预测。' : '');
            clear.disabled = !active.input.value;
            paint(focusDate);
            dialog.showModal();
            tabStop().focus();
        }

        function moveMonth(offset, trigger) {
            month = adjacentMonth(month, offset);
            paint();
            if (trigger.disabled) tabStop().focus();
        }

        daysBody.onkeydown = event => {
            const offset = arrowOffsets[event.key], current = event.target.dataset.date;
            if (!offset || !current) return;
            event.preventDefault();
            const date = iso(new Date(utcDate(current).getTime() + offset * DAY_MS));
            if (!selectable(date)) return;
            if (date.slice(0, 7) !== month) {
                month = date.slice(0, 7);
                paint(date);
            } else {
                tabStop().tabIndex = -1;
                daysBody.querySelector('[data-date="' + date + '"]').tabIndex = 0;
            }
            tabStop().focus();
        };
        prev.onclick = () => moveMonth(-1, prev);
        next.onclick = () => moveMonth(1, next);
        el('CalendarClose').onclick = close;
        clear.onclick = () => select('');
        for (const field of fields) field.trigger.onclick = () => open(field);

        function update(calendar, range) {
            const available = Boolean(calendar.last);
            if (!available || period !== calendar) close();
            period = calendar;
            for (const field of fields) {
                field.trigger.disabled = !available;
                field.trigger.setAttribute('aria-invalid', String(!!range.invalid));
                field.display.textContent = field.input.value || field.placeholder;
            }
        }
        return {update, close};
    };
})();
