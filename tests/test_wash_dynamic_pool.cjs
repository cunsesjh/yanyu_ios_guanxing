const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../web');
const sandbox = {console, TextEncoder, setTimeout: () => 0};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const context = vm.createContext(sandbox);
for (const file of [
    'shared/data.js', 'shared/born_talent_data.js', 'shared/battle_talent_data.js',
    'shared/life_hedao_data.js', 'shared/extra_attr_data.js', 'shared/equip_data.js',
    'shared/kongfu_data.js', 'role/role.js', 'shared/wash_role_context.js',
    'shared/wash_source_engine.js',
]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename: file});
}

const role = {
    ID: 1, Name: '属性动态测试', Type: 1, Sex: 1, ZiZhi: 154, Level: 100, Age: 30, MenPai: 0,
    Str: 0, BornStr: 0, StrGift: 0, Con: 0, BornCon: 54, ConGift: 0,
    Dex: 0, BornDex: 0, DexGift: 0, Int: 0, BornInt: 0, IntGift: 0,
    BornTalent: {ID: 285}, Talents: [], Equips: [], Taolus: [], Neis: [], Qings: [],
    LifeSkills: [], LifeProps: [], HeDaoSkill: [], JingMais: [],
};
const baseStats = sandbox.WashRoleContext.roleStats(role, []);
const withQingLong = sandbox.WashRoleContext.roleStats(role, [252]);
assert.equal(baseStats.con, 54);
assert.equal(withQingLong.con, 66, 'gx role model applies 青龙白虎 Con effect');
assert.equal(sandbox.WashRoleContext.roleStats(role, [173, 187]).con, 59,
    'same-type Con talents do not stack; the first slot contributes');
assert.equal(sandbox.WashRoleContext.roleStats(role, [187, 173]).con, 64,
    'reordering same-type Con talents changes which contribution is effective');

const engine = new sandbox.WashSourceEngine.Engine(sandbox.TALENT_DATA, {
    role_id: 1, sex: 1, vip: 1, role_level: 100, zizhi: 154,
    role_stats: baseStats, role_raw: role,
    global_vars: {talent_MuRenYinJi: 1, num_ZhuangGu: 9},
});
assert.equal(engine.allowedForState({talents: []}).has(239), false,
    'five aggregates stay out of the pool below 60 Con');
assert.equal(engine.allowedForState({talents: [252]}).has(239), true,
    'five aggregates enter the pool while 青龙白虎 raises Con to 66');
assert.equal(engine.allowedForState({talents: []}).has(235), false,
    '壮骨酒 still respects its separate global-variable condition');

const sequenceEngine = new sandbox.WashSourceEngine.Engine(sandbox.TALENT_DATA, {
    role_id: 1, sex: 1, vip: 1, role_level: 100, zizhi: 154,
    role_stats: baseStats, role_raw: role,
    global_vars: {talent_MuRenYinJi: 1, num_ZhuangGu: 9},
});
const sequence = [252, 239, 170, 171];
let fullRoleStatsCalls = 0;
const roleStatsForSequence = sequenceEngine.roleStatsFor.bind(sequenceEngine);
sequenceEngine.roleStatsFor = state => {
    fullRoleStatsCalls += 1;
    return roleStatsForSequence(state);
};
sequenceEngine.draw = (_seed, purple) => {
    assert.equal(purple, false);
    return [sequence.shift(), 1];
};
const unlockedInSameWash = sequenceEngine.wash({
    bornSeed: 1, luckSeed: null, bornRC: 0, talLucky: 0, talents: [],
}, []);
assert.deepEqual(Array.from(unlockedInSameWash.state.talents), [252, 239, 170, 171],
    'a qualifying Con talent unlocks 五蕴皆空 later in the same wash');
assert.equal(fullRoleStatsCalls, 1,
    'the full role model runs only when the attribute-gated talent is drawn');

const washedOffSequenceEngine = new sandbox.WashSourceEngine.Engine(sandbox.TALENT_DATA, {
    role_id: 1, sex: 1, vip: 1, role_level: 100, zizhi: 154,
    role_stats: baseStats, role_raw: role,
    global_vars: {talent_MuRenYinJi: 1, num_ZhuangGu: 9},
});
const removedSequence = [239, 170, 171, 172, 173];
washedOffSequenceEngine.draw = () => [removedSequence.shift(), 1];
const afterWashOff = washedOffSequenceEngine.wash({
    bornSeed: 1, luckSeed: null, bornRC: 0, talLucky: 0, talents: [252],
}, []);
assert.equal(afterWashOff.state.talents.includes(239), false,
    'a washed-off Con bonus no longer qualifies 五蕴皆空');
assert.equal(afterWashOff.draws, 5, 'the now-ineligible talent is discarded and the draw continues');

role.Equips = [{ID: 5000, EnMans: [{Key: 'con', Value: 6}]}];
assert.equal(sandbox.WashRoleContext.roleStats(role, []).con, 60,
    'saved equipment bonuses are part of the baseline used for eligibility');

console.log('dynamic wash eligibility tests passed');
