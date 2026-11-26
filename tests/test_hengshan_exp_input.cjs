const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const handlers = {};
const elements = {
    btnAdvanceUnlock: { addEventListener: (name, callback) => { handlers[name] = callback; } },
    upgradeExpAmount: { value: '200', addEventListener: (name, callback) => { handlers['input-' + name] = callback; } },
    unlockResult: { textContent: '' },
    studentMessage: { textContent: '', classList: { add() {}, remove() {} } },
};
let applied;
let passedStudent;
const context = {
    document: { readyState: 'complete', getElementById: id => elements[id] || null },
    window: {
        HengshanDayOps: {
            get: () => ({ level: 10, exp: 20, dailyBaseExp: 200, dailyExtraExp: 30 }),
            apply: state => { applied = state; },
        },
        HengshanStudentEngine: {
            advanceDay: (_data, student) => {
                passedStudent = student;
                return { state: { ...student, level: student.dailyBaseExp === 200 ? 39 : student.dailyBaseExp === 500 ? 41 : 42,
                    exp: student.exp + student.dailyBaseExp }, action: { expGained: student.dailyBaseExp } };
            },
        },
        HENGSHAN_TALENT_DATA: {},
    },
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'web/hengshan/hengshan_exp_input.js'), 'utf8'), context);
assert.match(elements.unlockResult.textContent, /200 经验，预计到 39 级/,
    'the level preview must reflect the default 200 experience input');
elements.upgradeExpAmount.value = '500';
handlers['input-input']();
assert.match(elements.unlockResult.textContent, /500 经验，预计到 41 级/,
    'the level preview must update immediately when the experience changes');
elements.upgradeExpAmount.value = '1250';
let stopped = false;
handlers.click({ preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
assert.equal(stopped, true, 'custom exp input must replace the fixed +200 handler');
assert.equal(passedStudent.dailyBaseExp, 1250, 'entered base experience must reach the student engine');
assert.equal(passedStudent.dailyExtraExp, 0, 'stale daily extra experience must not be added to this simulation');
assert.equal(applied.exp, 1270, 'updated experience must be applied to the simulated student');
console.log('hengshan experience input regression tests passed');
