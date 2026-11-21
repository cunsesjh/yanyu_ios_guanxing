"""Local progress and verified routes for one imported snapshot. No game session data."""
from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3

from .hengshan_export import origin, write_zip

def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


class HengshanJournal:
    def __init__(self, root):
        self.path = Path(root) / 'hengshan-sequences.sqlite3'
        with closing(self.connect()) as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS batches(scope TEXT PRIMARY KEY, config TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS marks(scope TEXT, task TEXT, budget INTEGER, cap INTEGER,
                    status TEXT, PRIMARY KEY(scope,task,budget));
                CREATE TABLE IF NOT EXISTS routes(scope TEXT, task TEXT, washes INTEGER, summary TEXT, route TEXT,
                    PRIMARY KEY(scope,task));
            ''')

    def connect(self):
        return sqlite3.connect(self.path, timeout=10)

    @staticmethod
    def summaries(db, owner):
        # Older summaries did not include the disciple key. Read only the two
        # missing fields from those routes, without rewriting any saved result.
        sql = """SELECT task,summary,
            CASE WHEN json_type(summary,'$.studentKey') IS NULL THEN json_extract(route,'$.initial.key') END,
            CASE WHEN json_type(summary,'$.source') IS NULL THEN json_extract(route,'$.initial.source') END
            FROM routes WHERE scope=?"""
        rows = []
        for task, raw, key, source in db.execute(sql, (owner,)):
            row = json.loads(raw)
            if 'studentKey' not in row or 'source' not in row:
                row.update(origin(row, row.get('studentKey', key), row.get('source', source)))
            rows.append(dict(task=task, **row))
        return rows

    def export(self, scope, owner, msg, stream):
        if not scope or msg.get('scope') != scope:
            raise ValueError('存档已切换，请重新打开结果。')
        tasks, rule = msg.get('tasks'), msg.get('rule')
        if (not isinstance(rule, str) or not rule or not isinstance(tasks, list) or not tasks or
                any(not isinstance(t, str) or not re.fullmatch('[a-f0-9]{64}', t) for t in tasks)):
            raise ValueError('请选择要导出的已复验路线。')
        tasks = list(dict.fromkeys(tasks))
        with closing(self.connect()) as db:
            db.execute('BEGIN')

            def selected():
                for i in range(0, len(tasks), 100):
                    chunk = tasks[i:i+100]
                    sql = 'SELECT task,route FROM routes WHERE scope=? AND task IN (' + ','.join('?' for _ in chunk) + ')'
                    data = dict(db.execute(sql, (owner or scope, *chunk)))
                    if len(data) != len(chunk):
                        raise ValueError('部分路线已不可用，请重新筛选后导出。')
                    for task in chunk:
                        route = json.loads(data.pop(task))
                        if route.get('rule') != rule or route.get('verified') is not True:
                            raise ValueError('所选路线与当前规则不一致，未生成导出包。')
                        yield route
            write_zip(stream, selected())

    def run(self, scope, msg, route_scope=None):
        route_scope = route_scope or scope
        if not scope:
            raise ValueError('请先在首页导入存档。')
        op = msg.get('op')
        if op != 'open' and msg.get('scope') != scope:
            raise ValueError('存档已切换，请回到新存档的恒山页面。')
        with closing(self.connect()) as db, db:
            if op == 'open':
                row = db.execute('SELECT config FROM batches WHERE scope=?', (scope,)).fetchone()
                return dict(scope=scope, config=json.loads(row[0]) if row else None,
                            marks=[dict(task=t, budget=b, cap=c, status=s) for t,b,c,s in db.execute(
                                'SELECT task,budget,cap,status FROM marks WHERE scope=?', (scope,))],
                            routes=self.summaries(db, route_scope))
            if op == 'batch':
                cfg = msg.get('config')
                if not isinstance(cfg, dict) or not isinstance(cfg.get('selected'), list) or not isinstance(cfg.get('groups'), list):
                    raise ValueError('批次配置无效。')
                db.execute('INSERT OR REPLACE INTO batches VALUES(?,?)', (scope, encode(cfg)))
                return {}
            task = msg.get('task')
            if not isinstance(task, str) or not re.fullmatch('[a-f0-9]{64}', task):
                raise ValueError('弟子及天赋组标识无效。')
            if op == 'route':
                row = db.execute('SELECT route FROM routes WHERE scope=? AND task=?', (route_scope, task)).fetchone()
                if row is None:
                    raise ValueError('没有找到这条路线。')
                return json.loads(row[0])
            if op == 'save-route':
                r = msg.get('route')
                if not isinstance(r, dict) or r.get('verified') is not True or not isinstance(r.get('moves'), list):
                    raise ValueError('仅能保存复验成功的路线。')
                moves = r['moves']
                if any(type(m) is not int or m not in (-1, 0, 1, 2) for m in moves):
                    raise ValueError('路线含无效操作。')
                w = sum(m >= 0 for m in moves)
                if w > 100 or r.get('washes') != w or r.get('days') != len(moves) - w:
                    raise ValueError('路线天数或洗练次数不一致。')
                summary = {k:r[k] for k in ('name','date','batch','targets','groupName','washes','days','level','finalTalents','rule')}
                initial = r.get('initial') or {}
                summary.update(origin(r, initial.get('key'), initial.get('source')))
                db.execute('''INSERT INTO routes VALUES(?,?,?,?,?) ON CONFLICT(scope,task) DO UPDATE SET
                    washes=excluded.washes, summary=excluded.summary, route=excluded.route WHERE excluded.washes < routes.washes''',
                           (route_scope,task,w,encode(summary),encode(r)))
                stored = db.execute('SELECT summary FROM routes WHERE scope=? AND task=?', (route_scope,task)).fetchone()
                result = json.loads(stored[0])
                result.setdefault('source', summary['source'])
                result.setdefault('studentKey', summary['studentKey'])
                return result
            if op == 'mark':
                st,b,c = msg.get('status'),msg.get('budget'),msg.get('cap')
                if st not in ('banned','limited','exhausted') or type(b) is not int or not 0<=b<=100 or type(c) is not int or not 1<=c<=100000000:
                    raise ValueError('批次进度无效。')
                db.execute('''INSERT INTO marks VALUES(?,?,?,?,?) ON CONFLICT(scope,task,budget) DO UPDATE SET
                    cap=MAX(excluded.cap, marks.cap), status=CASE WHEN marks.status='limited' THEN excluded.status ELSE marks.status END''',
                           (scope,task,b,c,st))
                return {}
            raise ValueError('不支持的批次操作。')
