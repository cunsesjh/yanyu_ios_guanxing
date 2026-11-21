import json
from contextlib import closing
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zipfile import ZipFile

from desktop.server import LocalSite
from desktop.hengshan_journal import HengshanJournal


class JournalRoundTrip(unittest.TestCase):
    def test_legacy_results_keep_identity_and_export_only_the_selected_account(self):
        with tempfile.TemporaryDirectory() as folder:
            store=HengshanJournal(folder)
            goal=['甲','乙','丙']
            route=dict(verified=True,rule='v1',name='同名弟子',date='',batch='背包',targets=goal,
                       groupName='方案',days=0,level=100,finalTalents=goal,washes=0,moves=[],steps=[])
            def add(task,owner,key):
                return store.run('snapshot',dict(op='save-route',scope='snapshot',task=task,
                    route={**route,'initial':dict(key=key,source='backpack')}),owner)
            a,b,c='a'*64,'b'*64,'c'*64
            add(a,'owner-1','bag-1');add(b,'owner-1','bag-2');add(c,'owner-2','bag-3')
            # Old installations have only the full route's initial state.
            with closing(store.connect()) as db, db:
                db.execute("UPDATE routes SET summary=json_remove(summary,'$.studentKey','$.source')")
            summaries=store.run('snapshot',{'op':'open'},'owner-1')['routes']
            self.assertEqual({(r['source'],r['studentKey']) for r in summaries},
                             {('backpack','bag-1'),('backpack','bag-2')})
            stream=BytesIO(); msg=dict(scope='snapshot',rule='v1',tasks=[b,b,a])
            store.export('snapshot','owner-1',msg,stream)
            with ZipFile(stream) as z:
                self.assertIn('2 名弟子，2 条路线',z.read('索引.html').decode())
                self.assertEqual({json.loads(z.read(n))['initial']['key'] for n in z.namelist()
                                  if n.endswith('/路线.json')},{'bag-1','bag-2'})
            for invalid in [dict(scope='different'),dict(tasks=[a,c]),dict(rule='old'),dict(tasks=[])]:
                with self.assertRaises(ValueError):
                    store.export('snapshot','owner-1',{**msg,**invalid},BytesIO())

    def test_resume_reuse_and_separate_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            def open_site(data, owner='alpha'):
                s = LocalSite(folder, journal_root=folder)
                s.set_snapshot(data,sequence_owner=owner)
                return s

            def post(s, op, **args):
                request = Request(s.url + 'api/hengshan-sequence',
                                  json.dumps(dict(op=op, **args)).encode(),
                                  {'Origin': s.origin, 'Content-Type': 'application/json'})
                with urlopen(request, timeout=5) as response:
                    return json.load(response)

            site = open_site({'example': 1})
            try:
                scope = post(site, 'open')['scope']
                cfg = {'selected':['one'], 'groups':[['a','b','c']]}
                post(site,'batch',scope=scope, config=cfg)
                task='a'*64
                post(site,'mark',scope=scope,task=task,status='limited',budget=4,cap=10)
                route=dict(verified=True,rule='test',name='测试',date='',batch='在册',targets=['a','b','c'],groupName='目标',days=1,level=80,finalTalents=['a','b','c'],washes=1,moves=[-1,0])
                post(site,'save-route',scope=scope,task=task,route=route)
                post(site,'save-route',scope=scope,task=task,route={**route,'washes':2,'moves':[-1,1,0]})
            finally:
                site.close()
            site=open_site({'example': 1})
            try:
                restored=post(site,'open')
                self.assertEqual(restored['config'],cfg)
                self.assertEqual((restored['routes'][0]['washes'],restored['marks'][0]['cap']),(1,10))
                self.assertEqual(post(site,'route',scope=scope,task=task)['moves'],[-1,0])
                site.set_snapshot({'example': 2},sequence_owner='alpha')
                other=post(site,'open')
                self.assertEqual(len(other['routes']),1)
                self.assertIsNone(other['config']);self.assertEqual(other['marks'],[])
                site.set_snapshot({'example': 2},sequence_owner='beta')
                self.assertEqual(post(site,'open')['routes'],[])
                site.clear_snapshot()
                with self.assertRaises(HTTPError) as error:
                    post(site,'open')
                self.assertEqual(error.exception.code,400)
                error.exception.close()
                self.assertTrue((Path(folder)/'hengshan-sequences.sqlite3').is_file())
            finally:
                site.close()
