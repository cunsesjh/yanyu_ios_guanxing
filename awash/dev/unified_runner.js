#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// This helper lives under <app>/awash/dev; runtime assets live at <app>/web.
const ROOT = path.resolve(__dirname, '..', '..');
const SHARED = path.join(ROOT, 'web', 'shared');

function usage() {
    console.log(`统一构造器独立执行环境

用法:
  node dev/unified_runner.js --save <dat.json> --list
  node dev/unified_runner.js --save <dat.json> --role 拜妮娜 --sequence
  node dev/unified_runner.js --save <dat.json> --role 拜妮娜 --targets "转世金仙,混元奇脉,岿然顶天" --budget 3000

参数:
  --save <path>          dat.json 或所在快照目录
  --role <name|id>       角色名或 ID
  --targets <list>       目标紫脉，逗号分隔；顺序就是规划顺序
  --budget <number>      总丹耗上限
  --vip <0|1|2>          VIP，默认 1
  --list                 列出存档角色
  --sequence             输出原始紫脉序列
  --count <number>       扫描条数，默认 30
  --n-max <number>       第一轮 N 上限，默认 100
  --fallback-n-max <n>   扩展 N 上限，默认 300
  --method-ms <ms>       每组方法时限，默认 300000
  --refine-ms <ms>       前三条路线细化时限，默认 30000
  --only-paths <list>    仅跑指定方法，如 A 或 A,B
  --json                 输出机器可读 JSON
  --quiet                不打印进度
`);
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        if (['list', 'sequence', 'json', 'quiet', 'help', 'v2Only', 'trace', 'discover'].includes(key)) {
            out[key] = true;
            continue;
        }
        const value = argv[i + 1];
        if (value == null || value.startsWith('--')) throw new Error(`${arg} 缺少参数`);
        out[key] = value;
        i++;
    }
    return out;
}

function findSavePath(input) {
    if (!input) throw new Error('请提供 --save');
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) throw new Error(`存档不存在: ${resolved}`);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
        const candidate = path.join(resolved, 'dat.json');
        if (!fs.existsSync(candidate)) throw new Error(`目录里没有 dat.json: ${resolved}`);
        return candidate;
    }
    return resolved;
}

function asList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'object') {
        return Object.keys(value)
            .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))
            .map(key => value[key]);
    }
    return [];
}

function collectRoles(save) {
    const roles = [];
    const seen = new Set();
    const push = (tag, role, prefix) => {
        if (!role || typeof role !== 'object' || role.ID == null) return;
        const key = `${prefix}:${role.ID}`;
        if (seen.has(key)) return;
        seen.add(key);
        roles.push({ tag, key, role });
    };
    push('主角', save.MainRole, 'main');
    asList(save.Roles).forEach(role => push('随从', role, 'role'));
    asList(save.Leavers).forEach(role => push('离队', role, 'leave'));
    return roles;
}

function normalizeRoleTalents(role) {
    return asList(role && role.Talents).map(item => ({
        id: Number(item && (item.ID != null ? item.ID : item.id)),
        locked: !!(item && (item.Lock != null ? item.Lock : item.lock)),
    })).filter(item => Number.isFinite(item.id) && item.id > 0);
}

function computeRoleStats(role) {
    const giftCoef = 0.00006;
    const baseAttr = key => {
        const cap = key.charAt(0).toUpperCase() + key.slice(1);
        const raw = Number(role[cap] || 0);
        const born = Number(role[`Born${cap}`] || 0);
        const gift = Number(role[`${cap}Gift`] || 0);
        return Math.floor((raw + born) * (1 + giftCoef * gift));
    };
    return {
        str_val: baseAttr('str'),
        dex: baseAttr('dex'),
        con: baseAttr('con'),
        int_val: baseAttr('int'),
    };
}

function buildRaw(save, role, meta, vip) {
    const born = role.BornTalent || {};
    const luck = role.LuckTalent || {};
    const zizhi = Number(role.ZiZhi) || 153;
    return {
        mode: 'seed',
        zizhi: zizhi < 153 ? 153 : zizhi,
        sex: Number(role.Sex) || 1,
        vip: Number(vip),
        seed: Number(born.S) || Number(role.S) || 0,
        luck_seed: luck.S == null ? 0 : Number(luck.S),
        luck_seed_inited: luck.S != null,
        role_id: Number(role.ID) || 0,
        salt: Number(save.CenterID || 278440) % 1000000,
        talents: normalizeRoleTalents(role),
        tal_lucky: Number(role.TalLucky) || 0,
        total_wash: 0,
        total_talent_bars: 0,
        total_pills: 0,
        bag_pills: 0,
        has_bag_pills: false,
        gold_count: 0,
        pity_count: 0,
        quality_counts: { 1: 0, 2: 0, 3: 0, 4: 0 },
        last_purple_total_pills: null,
        exchange_count: 0,
        str_gift: Number(role.StrGift) || 0,
        con_gift: Number(role.ConGift) || 0,
        dex_gift: Number(role.DexGift) || 0,
        int_gift: Number(role.IntGift) || 0,
        role_level: Number(role.Level) || 90,
        role_stats: computeRoleStats(role),
        global_vars: save.globalVariable || {},
        born_talent_rc: Number(born.RC) || 0,
        save_channel: String(meta.channel || ''),
    };
}

function loadUnified() {
    const sandbox = {
        console,
        TextEncoder,
        TextDecoder,
        URL,
        setTimeout,
        clearTimeout,
        performance,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    for (const file of [
        path.join(SHARED, 'sequence_rules.js'),
        path.join(SHARED, 'data.js'),
        path.join(SHARED, 'wash_route_engine.js'),
        path.join(SHARED, 'wash_source_engine.js'),
        path.join(SHARED, 'route_constructor.js'),
        path.join(ROOT, 'sequence.js'),
        path.join(ROOT, 'infinite_seed_frontier.js'),
    ]) {
        vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    }
    if (!context.RouteConstructor) throw new Error('统一构造器加载失败');
    return context;
}

function selectRole(roles, wanted) {
    const query = String(wanted || '').trim();
    if (!query) throw new Error('请提供 --role');
    const numeric = Number(query);
    return roles.find(item => String(item.role.Name || '').trim() === query)
        || roles.find(item => Number.isFinite(numeric) && Number(item.role.ID) === numeric)
        || roles.find(item => String(item.role.Name || '').includes(query));
}

function resolveTargets(context, targetText) {
    const values = String(targetText || '').split(/[,，]/)
        .map(value => value.trim()).filter(Boolean);
    if (!values.length) throw new Error('请提供 --targets');
    const byName = new Map();
    const byId = new Map();
    for (const item of Object.values(context.TALENT_DATA || {})) {
        if (!item) continue;
        byName.set(String(item.name || '').trim(), Number(item.id));
        byId.set(Number(item.id), item);
    }
    return values.map(value => {
        if (/^\d+$/.test(value)) {
            const id = Number(value);
            if (!byId.has(id)) throw new Error(`未知天赋 ID: ${id}`);
            return id;
        }
        const id = byName.get(value);
        if (!id) throw new Error(`未知紫脉: ${value}`);
        return id;
    });
}

function nameOf(context, id) {
    return context.RouteConstructor.nameOf(Number(id));
}

function formatSequence(context, sequence) {
    return sequence.seq.map(item => ({
        no: item.no,
        name: context.RouteConstructor.nameOf(item.id),
        id: Number(item.id),
        wash: Number(item.wash) || 0,
        interval: Number(item.interval) || 0,
        pity: !!item.fromPity,
        field: !!item.field,
        conflict: item.conflictId ? nameOf(context, item.conflictId) : '',
        conflict_id: Number(item.conflictId) || 0,
        conflict_wash: Number(item.conflictWash) || 0,
    }));
}

function summarizeRoute(context, route) {
    if (!route || !route.ok) {
        return {
            ok: false,
            note: route && route.note || '无可行路线',
            tried: route && route.tried ? route.tried.length : 0,
        };
    }
    const seed = route.seedOpt || {};
    return {
        ok: true,
        cost: Number(route.cost) || 0,
        washes: Number(route.washes) || 0,
        exchanges: Number(route.exchanges) || 0,
        burns: Number(route.burns) || 0,
        kind: route.kind || '',
        methodFamily: route.methodFamily || '',
        methodBranch: route.methodBranch || '',
        tailNo: Number(route.tailNo) || 0,
        tailId: Number(route.tailTarget || route.tailId) || 0,
        tailName: nameOf(context, route.tailTarget || route.tailId),
        seed: {
            n: Number(seed.n) || 0,
            carrier: Number(seed.carrier) || 0,
            carrierName: nameOf(context, seed.carrier),
            anchorNo: Number(seed.anchorNo) || 0,
            anchorWash: Number(seed.anchorWash) || 0,
            first: Number(seed.first) || 0,
            firstName: nameOf(context, seed.first),
            pinned: (seed.pinnedTargetIds || []).map(id => ({
                id: Number(id),
                name: nameOf(context, id),
            })),
            chain: (seed.chain || []).map((id, index) => ({
                no: index + 1,
                id: Number(id),
                name: nameOf(context, id),
            })),
        },
        insertMap: ((route.check && route.check.fullInsertMap)
            || (route.check && route.check.insertMap) || []).map(item => ({
            chainNo: Number(item.idx) + 1,
            target: nameOf(context, item.target),
            anchor: nameOf(context, item.anchor),
            anchorNo: Number(item.anchorNo) || 0,
        })),
        steps: (route.steps || []).map((step, index) => ({
            no: index + 1,
            type: step.type,
            id: step.id || 0,
            idName: step.id ? nameOf(context, step.id) : '',
            from: step.from || 0,
            fromName: step.from ? nameOf(context, step.from) : '',
            to: step.to || 0,
            toName: step.to ? nameOf(context, step.to) : '',
            washes: Number(step.washes) || 0,
            cost: Number(step.cost) || 0,
            why: step.why || '',
            field: (step.field || []).map(id => nameOf(context, id)),
        })),
    };
}

function printRoute(context, route) {
    if (!route.ok) {
        console.log(`未找到路线: ${route.note}`);
        return;
    }
    console.log(`结果: ${route.cost}丹 / ${route.washes}洗 / ${route.exchanges}置换 / ${route.burns}白烧`);
    console.log(`方法: ${route.methodFamily || '-'} ${route.methodBranch || ''}`.trim());
    console.log(`收尾: O#${route.tailNo} ${route.tailName}`);
    console.log(`种子: N=${route.seed.n} 锚点O#${route.seed.anchorNo} ${route.seed.carrierName}` +
        ` 首目标=${route.seed.firstName}` +
        (route.seed.pinned.length ? ` 前置保留=${route.seed.pinned.map(x => x.name).join('/')}` : ''));
    console.log('置换链: ' + route.seed.chain.map(item => `C#${item.no} ${item.name}`).join(' → '));
    console.log('倒插: ' + (route.insertMap.map(item =>
        `C#${item.chainNo} ${item.target}→O#${item.anchorNo} ${item.anchor}`).join('；') || '无'));
    console.log('操作:');
    for (const step of route.steps) {
        const action = step.fromName
            ? `${step.fromName}→${step.toName || step.idName}`
            : (step.idName || step.type);
        console.log(`  ${step.no}. ${step.type} ${action} @${step.washes}洗 / 累计${step.cost}丹` +
            (step.field.length ? ` | ${step.field.join('、')}` : ''));
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        usage();
        return;
    }
    const savePath = findSavePath(args.save);
    const metaPath = path.join(path.dirname(savePath), 'dat.meta.json');
    const meta = fs.existsSync(metaPath)
        ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
    const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));
    const roles = collectRoles(save);
    const context = loadUnified();
    context.__RC_TRACE = process.env.RC_TRACE === '1';

    if (args.list) {
        const result = roles.map(item => ({
            key: item.key,
            tag: item.tag,
            id: Number(item.role.ID),
            name: item.role.Name || '',
            zizhi: Number(item.role.ZiZhi) || 0,
        }));
        if (args.json) console.log(JSON.stringify(result, null, 2));
        else result.forEach(item => console.log(`${item.key}\t${item.tag}\t${item.id}\t${item.name}\t资质${item.zizhi}`));
        return;
    }

    const selected = selectRole(roles, args.role);
    if (!selected) throw new Error(`未找到角色: ${args.role}`);
    const raw = buildRaw(save, selected.role, meta, args.vip == null ? 1 : args.vip);
    const sequence = context.RouteConstructor.readSequence(raw, {
        zi: raw.zizhi,
        count: Math.max(12, Number(args.count) || 30),
    });

    if (args.sequence) {
        const result = {
            role: selected.role.Name || '',
            id: Number(selected.role.ID),
            raw,
            sequence: formatSequence(context, sequence),
        };
        if (args.json) console.log(JSON.stringify(result, null, 2));
        else {
            console.log(`${selected.role.Name} · 资质${raw.zizhi} · seed=${raw.seed}`);
            result.sequence.forEach(item => console.log(
                `O#${item.no}\t${item.name}\t${item.wash}洗` +
                `${item.conflict ? `\t冲突=${item.conflict}@${item.conflict_wash}` : ''}` +
                `${item.pity ? '\t保底' : ''}${item.field ? '\t场上' : ''}`));
        }
        return;
    }

    const targets = resolveTargets(context, args.targets);
    const budget = Math.max(0, Number(args.budget) || 0);
    if (!budget) throw new Error('请提供 --budget');
    const opts = {
        budget,
        tailReserve: 0,
        tailReserveByTail: {},
        hiddenPityWashes: [],
        methodMs: Math.max(60000, Number(args.methodMs) || 300000),
        nMax: Math.max(0, Number(args.nMax) || 100),
        fallbackNMax: Math.max(0, Number(args.fallbackNMax) || 300),
        count: Math.max(12, Number(args.count) || 30),
        manualStartWashes: [864, 131, 0],
        refineMs: Math.max(5000, Number(args.refineMs) || 30000),
    };
    if (args.onlyPaths) {
        opts.onlyPaths = String(args.onlyPaths).split(',')
            .map(value => value.trim()).filter(Boolean);
    }
    let lastProgress = '';
    let lastProgressAt = 0;
    if (!args.quiet) {
        opts.progressCb = progress => {
            const now = Date.now();
            if (now - lastProgressAt < 1000) return;
            const text = [
                progress.method || progress.phase || '',
                progress.tailNo ? `O#${progress.tailNo}` : '',
                progress.anchorNo ? `锚点O#${progress.anchorNo}` : '',
                progress.n != null ? `N=${progress.n}` : '',
                progress.bestCost ? `最优${progress.bestCost}` : '',
            ].filter(Boolean).join(' · ');
            if (text && text !== lastProgress) {
                console.error(`[progress ${new Date().toLocaleTimeString()}] ${text}`);
                lastProgress = text;
                lastProgressAt = now;
            }
        };
    }
    const best = context.RouteConstructor.planBest(raw, targets, opts);
    const summary = summarizeRoute(context, best);
    if (args.json) {
        console.log(JSON.stringify({
            role: selected.role.Name || '',
            id: Number(selected.role.ID),
            raw,
            targets: targets.map(id => ({ id, name: nameOf(context, id) })),
            result: summary,
        }, null, 2));
    } else {
        printRoute(context, summary);
    }
    if (!best || !best.ok) process.exitCode = 2;
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`错误: ${error && error.message || error}`);
        if (process.env.DEBUG) console.error(error && error.stack || error);
        process.exitCode = 1;
    }
}

module.exports = {
    parseArgs,
    findSavePath,
    asList,
    collectRoles,
    normalizeRoleTalents,
    computeRoleStats,
    buildRaw,
    loadUnified,
    selectRole,
    resolveTargets,
    nameOf,
};
