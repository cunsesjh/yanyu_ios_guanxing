(function (root) {
    'use strict';

    function roleWithWashTalents(role, talentIds) {
        const bornId = Number(role && role.BornTalent && role.BornTalent.ID) || 0;
        const seenTypes = new Set();
        const current = [];
        for (const id of [bornId, ...(talentIds || []).map(Number)]) {
            if (!id) continue;
            const config = root.TALENT_DATA[String(id)] || root.BORN_TALENT_DATA?.[String(id)];
            const type = Number(config && config.type) || id;
            if (seenTypes.has(type)) continue;
            seenTypes.add(type);
            if (id !== bornId) current.push({ID: id, Lock: false});
        }
        return {...role, Talents: current};
    }

    function roleStats(role, talentIds) {
        if (!role || !root.YYJHRoleAttributeModel) return null;
        return root.YYJHRoleAttributeModel.compute(roleWithWashTalents(role, talentIds));
    }

    root.WashRoleContext = Object.freeze({roleStats});
})(typeof globalThis !== 'undefined' ? globalThis : self);
