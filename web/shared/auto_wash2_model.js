/* Independent save adapter: never writes simulator state or the imported save. */
(function (root) {
    'use strict';
    function snapshot(save, role, context = {}) {
        if (!role?.BornTalent || !Number.isFinite(Number(role.BornTalent.S))) {
            throw new Error('该人物缺少洗脉种子，请重新下载完整存档。');
        }
        const attr = key => Math.floor((Number(role[key] || 0) + Number(role['Born' + key] || 0))
            * (1 + 0.00006 * Number(role[key + 'Gift'] || 0)));
        const talentRows = Array.isArray(role.Talents) ? role.Talents
            : role.Talents && typeof role.Talents === 'object' ? Object.values(role.Talents) : [];
        return {
            seed: Number(role.BornTalent.S), born_talent_rc: Number(role.BornTalent.RC) || 0,
            luck_seed: Number(role.LuckTalent?.S) || 0, luck_seed_inited: role.LuckTalent?.S != null,
            tal_lucky: Number(role.TalLucky) || 0, zizhi: Number(role.ZiZhi ?? 153),
            role_id: Number(role.ID), sex: Number(role.Sex) || 1, role_level: Number(role.Level) || 90,
            salt: Number(save.CenterID || 0) % 1000000, vip: Number(context.vip ?? 1),
            role_stats: {str_val: attr('Str'), con: attr('Con'), dex: attr('Dex'), int_val: attr('Int')},
            role_raw: JSON.parse(JSON.stringify(role)),
            global_vars: JSON.parse(JSON.stringify(save.globalVariable || {})),
            save_channel: context.channel || '',
            talents: talentRows.filter(t => t && typeof t === 'object')
                .map(t => ({id: Number(t.ID ?? t.id), locked: !!(t.Lock ?? t.locked ?? t.lock)}))
                .filter(t => t.id > 0),
        };
    }
    function targets(raw, assignments, data) {
        const required = new Set(raw.talents.filter(t => t.locked && Number(data[t.id]?.weight) === 4).map(t => t.id));
        const groups = [[], [], [], []];
        for (const [id, group] of assignments) {
            if (required.has(id)) continue;
            if (group === -1) required.add(id);
            else if (groups[group]) groups[group].push(id);
        }
        // A preserved/required talent already satisfies any compatible group containing it.
        const compatibleGroups = groups.filter(g => g.length && !g.some(id => required.has(id)));
        const count = required.size + compatibleGroups.length;
        if (!count || count > 4) throw new Error('请选择 1–4 个目标：每条必选脉及每个兼容组各占一槽。');
        return {targetIds: [...required], compatibleGroups};
    }
    function combinations(selection) {
        let branches = [selection.targetIds];
        for (const group of selection.compatibleGroups || []) {
            branches = branches.flatMap(ids => group.map(id => [...new Set([...ids, id])]));
            if (branches.length > 256) throw new Error('兼容组组合超过 256 种，请减少组内候选后重试。');
        }
        return [...new Map(branches.map(ids => [ids.slice().sort((a, b) => a - b).join(','), ids])).values()];
    }
    root.AutoWash2Model = Object.freeze({snapshot, targets, combinations});
})(typeof globalThis !== 'undefined' ? globalThis : window);
