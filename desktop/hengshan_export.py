"""A self-contained, offline directory of verified routes."""
from html import escape
import json
import re
from urllib.parse import quote
from zipfile import ZipFile, ZIP_DEFLATED


SOURCES = {'enrolled': '在册', 'backpack': '背包', 'shop': '商店'}


def origin(row, key, source):
    if source in ('shop', 'shop-preview'):
        source = 'shop'
    elif source not in ('backpack', 'enrolled'):
        batch = row.get('batch', '')
        source = 'backpack' if batch == '背包' else (
            'shop' if row.get('date') or '商店' in batch else 'enrolled')
    return {'studentKey': str(key) if key is not None else '', 'source': source}


def safe_part(value):
    # The numeric folder prefix also disambiguates identical Windows filenames.
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(value))[:36].strip(' .') or '未命名'


def instructions(r, source):
    out = [r['name'] + ' · ' + SOURCES[source], '方案：' + r['groupName'],
           '目标：' + '、'.join(r['targets']),
           f"共洗练 {r['washes']} 次，推进 {r['days']} 天，结束于 {r['level']} 级。",
           '最终天赋：' + '、'.join(r['finalTalents'])]
    if source == 'shop':
        out.append('商店招募：' + ' · '.join(filter(None, (r['date'], r['batch']))))
        plan = r.get('shopPlan') or {}
        if plan.get('from'):
            out.append(f"从 {plan['from']} 起，招募前要手动刷新的日期：" +
                       ('、'.join(plan.get('manualDates', [])) or '无'))
            if plan.get('alreadyRefreshed'):
                out.append('存档当日的手动刷新已用过。')
            if plan.get('reconcile'):
                out.append('此路线的起点补算了一次当日自动刷新，请与游戏名单核对。')
    steps = r.get('steps', [])
    if r['moves'] and not steps:
        raise ValueError('路线缺少操作步骤，未导出不完整的结果。')
    out.extend(('', '操作步骤：' if steps else '起点已满足三个目标，无需操作。'))
    for i, s in enumerate(steps, 1):
        if s['type'] == 'day':
            line = f"成长 {s['days']} 天：{s['from']} → {s['to']} 级"
        else:
            line = f"第 {s['day']} 天 · {s['level']} 级，洗第 {s['slot']+1} 槽：{s['old']} → {s['drawn']}"
        out.append(f'{i}. {line}')
    return '\r\n'.join(out) + '\r\n'


def write_zip(stream, routes):
    people = {}
    with ZipFile(stream, 'w', compression=ZIP_DEFLATED, compresslevel=4) as z:
        for r in routes:
            start = r.get('initial') or {}
            meta = origin(r, start.get('key'), start.get('source'))
            src = meta['source']
            who = (src, r['date'], r['batch'], r['name'], meta['studentKey'])
            if who not in people:
                parts = [SOURCES[src]]
                if src == 'shop':
                    date = r['date']
                    parts.append(date if re.fullmatch(r'\d{4}-\d{2}-\d{2}', date or '') else '日期未记录')
                parts.append(f"{len(people)+1:04d}_{safe_part(r['name'])}")
                people[who] = ('/'.join(parts), [])
            base, links = people[who]
            path = f"{base}/{len(links)+1:03d}_{safe_part(r['groupName'])}/"
            z.writestr(path+'路线.txt', instructions(r, src).encode('utf-8-sig'))
            z.writestr(path+'路线.json', json.dumps(r, ensure_ascii=False, indent=2).encode('utf-8'))
            links.append((path, r['groupName'], r['washes'], r['days']))

        total = sum(len(links) for _, links in people.values())
        page = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
                '<title>恒山弟子 · 已复验路线</title><style>body{font:15px/1.65 "Microsoft YaHei",sans-serif;max-width:56rem;margin:2rem auto;padding:0 1rem;color:#213249}h1{font-size:1.35rem}h2{font-size:1.1rem}details{border-bottom:1px solid #d6dfe7;padding:.4rem 0}summary{cursor:pointer}a{color:#12647e}li{margin:.25rem 0}</style>',
                f'<h1>恒山弟子 · 已复验路线</h1><p>{len(people)} 名弟子，{total} 条路线。点弟子名查看方案，点「操作步骤」查看怎么洗。</p>']
        for src, label in SOURCES.items():
            group = sorted((k for k in people if k[0] == src), key=lambda k:(k[1], k[3], k[2], k[4]))
            if not group:
                continue
            page.append(f'<h2>{label}弟子 · {len(group)} 名</h2>')
            for who in group:
                base, links = people[who]
                title = ' · '.join(filter(None, (who[3], who[1], who[2] if src == 'shop' else '')))
                number = base.split('/')[-1].split('_', 1)[0]
                page.append(f'<details><summary>{number}　{escape(title)}（{len(links)} 条）</summary><ul>')
                for path, name, washes, days in sorted(links, key=lambda x:(x[2],x[3],x[1])):
                    page.append(f'<li>{escape(name)} · {washes} 次洗练 / {days} 天　' +
                                f'<a href="{quote(path+"路线.txt")}">操作步骤</a> · <a href="{quote(path+"路线.json")}">JSON</a></li>')
                page.append('</ul></details>')
        page.append('</html>')
        z.writestr('索引.html', '\n'.join(page).encode('utf-8'))
