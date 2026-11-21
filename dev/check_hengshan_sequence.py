"""Exercise the actual Qt tab, worker, replay and resume with a synthetic roster, shop and backpack."""
import json
import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from PySide6.QtCore import QTimer, QUrl
from PySide6.QtWidgets import QApplication

ROOT=Path(__file__).resolve().parents[1]
os.environ.setdefault('IOSGUANXING_DISABLE_AUTO_UPDATE','1')
sys.path.insert(0,str(ROOT))
from desktop.app import MainWindow
from desktop.storage import Store

SCRIPT=r'''(async()=>{try{
 const $=id=>document.getElementById(id), wait=async(fn)=>{for(let i=0;i<700;i++){if(fn())return;await new Promise(r=>setTimeout(r,35));}throw Error('等待超时：'+$('sqNotice').textContent+' / '+$('sqProgress').textContent);};
 const expect=(test,msg)=>{if(!test)throw Error(msg);};
 await WasmAlgorithmAPI.ready;
 const C=HengshanSequence,ctx=C.context(HengshanStudentEngine,HENGSHAN_TALENT_DATA);
 const dateTime=1795122000, d0='2026-11-20',d1='2026-11-21',d2='2026-11-22';
 const bag={key:'smoke-bag',name:'不应显示的背包弟子',source:'backpack',level:100,exp:0,seed:1234567,talents:[1,4,7],specials:[{id:1,exp:0},{id:4,exp:0},{id:7,exp:0}],currentTime:dateTime,nextDailyAt:dateTime+86400};
 const shopState={seed:13456789,refreshes:0,npc:{}};
 const raw={...HengshanStudentEngine.shopRefresh(HENGSHAN_TALENT_DATA,HENGSHAN_SHOP_DATA,shopState).students[0],source:'shop',key:'shop-demo',currentTime:dateTime,nextDailyAt:dateTime+86400};
 HengshanShopState.loadCandidates([bag,raw],shopState);window.dispatchEvent(new CustomEvent('hengshan-shop-bag-changed',{detail:{preferredKey:bag.key}}));
 const student=HengshanPageState.getSimulationStudents().find(s=>s.name==='弟子03'&&s.source==='enrolled');
 expect(student,'真实存档在册弟子未读入');
 const base=HengshanPageState.prepareSnapshot(student), goal=ctx.held(ctx.step(base,0));
 expect(!goal.every(n=>ctx.held(base).includes(n))&&!goal.includes(C.BAN),'测试种子目标无效');

 const options=C.shopPlan(HengshanStudentEngine,HENGSHAN_TALENT_DATA,HENGSHAN_SHOP_DATA,[raw],shopState,dateTime,2,[true,true]);
 let shopSample;
 for(const entry of options){
   const initial=HengshanPageState.prepareSnapshot(entry.s);
   expect(initial.seed!==entry.s.seed,'测试未使用招募后种子');
   let state=initial;
   while(state.level<100&&state.talents.length<3&&!ctx.banned(state))state=ctx.step(state,C.DAY);
   if(!ctx.banned(state)&&state.talents.length===3){shopSample={entry,targets:ctx.held(state)};break;}
 }
 expect(shopSample,'测试商店缺少自然三天赋候选');
 const {entry,targets}=shopSample;
 const journal=async message=>{
   const response=await fetch('../api/hengshan-sequence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)});
   const data=await response.json();
   if(!response.ok)throw Error(data.error);
   return data;
 };
 const {scope}=await journal({op:'open'});
 await journal({op:'batch',scope,config:{days:30,manual:Array(30).fill(true),selected:[entry.key],groups:[{name:'旧商店方案',targets,on:true,custom:true}],budget:0,cap:2000,from:entry.date,to:entry.date,source:'shop'}});
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(HENGSHAN_ENGINE_WASM_B64+C.stable(HENGSHAN_TALENT_DATA)))),b=>b.toString(16).padStart(2,'0')).join('');
 const bagTargets=ctx.held(bag);
 await journal({op:'save-route',scope,task:'b'.repeat(64),route:{verified:true,name:bag.name,initial:bag,final:bag,date:'',batch:'背包',targets:bagTargets,groupName:'旧背包方案',washes:0,days:0,level:100,finalTalents:bagTargets,rule:C.RULE+':'+hash,moves:[]}});

 const before=C.stable(HengshanDayOps.get());document.querySelector('[data-hengshan-tool="sequence"]').click();await wait(()=>!$('sqSetup').disabled);
 const change=(id,value)=>{$(id).value=value;$(id).dispatchEvent(new Event('change'));};
 const find=text=>{$('sqFind').value=text;$('sqFind').dispatchEvent(new Event('input'));};
 const rows=()=>[...$('sqStudents').querySelectorAll('label')];
 const checked=()=>rows().filter(row=>row.querySelector('input').checked);
 const enrolledRow=row=>row.textContent.startsWith('在册　');
 const shopRows=()=>rows().filter(row=>!enrolledRow(row));
 expect($('sqDays').value==='7'&&$('sqCoverage').textContent.includes(d0+' 至 '+C.shopDate(dateTime,6))
   &&shopRows().length===66&&rows().length===96&&checked().length===0&&$('sqStart').disabled
   &&!$('sqFrom').value&&!$('sqTo').value,'旧批次覆盖了七天与空名单的默认值');
 expect(!$('sqSource')&&!$('sqResultSource').querySelector('[value=backpack]')&&
   !$('sqStudents').textContent.includes(bag.name)&&!$('sqPeople').querySelector('button'),'移除背包后仍有背包弟子或路线');
 const actions=Array.from($('sqStudents').previousElementSibling.querySelectorAll('button'));
 expect(actions.map(b=>b.textContent).join('、')==='全选、全选取消、仅在册、仅商店','选人按钮名称或数量错误');
 $('sqAll').click();expect(checked().length===96,'全选没有勾上在册和商店');
 $('sqOnlyEnrolled').click();expect(checked().length===30&&checked().every(enrolledRow),'仅在册保留了商店弟子');
 $('sqOnlyShop').click();expect(checked().length===66&&checked().every(row=>!enrolledRow(row)),'仅商店保留了在册弟子');
 find('无匹配弟子');
 expect(rows().length===0&&!$('sqNone').disabled,'搜索后无法清空隐藏的勾选');
 $('sqNone').click();find('');expect(checked().length===0&&$('sqStart').disabled,'全选取消没有清空所有弟子');
 change('sqDays','2');
 expect(document.querySelectorAll('.seq-guide li').length===5&&getComputedStyle(document.querySelector('.seq-guide')).listStyleType==='decimal'&&$('sqGuide').getBoundingClientRect().top<$('sqStudents').getBoundingClientRect().top,'顶部五步用法不可见');
 for(const id of ['sqShop','sqEditor','sqBudget','sqFind'])expect(!$(id).closest('details')&&$(id).getBoundingClientRect().height>0,'设置仍折叠：'+id);
 for(const [own,other] of [[$('sqGuide'),document.querySelector('#autoSimPanel h2')],[$('sqAll'),$('btnSimulateRefresh')],[$('sqStart'),$('btnAutoSimRun')],[$('sqNone'),$('btnResetStudent')],[$('sqBudget'),$('studentSelect')],[$('sqProgress'),$('studentMessage')],[$('sqFromPick').labels[0],$('studentSelect').labels[0]]]){
   for(const prop of ['fontSize','fontFamily','fontWeight'])expect(getComputedStyle(own)[prop]===getComputedStyle(other)[prop],'字体没有沿用恒山页面：'+own.id+' '+prop+' ('+getComputedStyle(own)[prop]+' / '+getComputedStyle(other)[prop]+')');
 }
 expect($('sqCoverage').textContent.includes(d0+' 至 '+d1)&&shopRows().length===16&&checked().length===0,'改预测范围自动勾选了弟子');
 expect(!$('sqImport')&&!$('sqFiles'),'旧助手路线导入入口仍存在');
 const day=date=>$('sqCalendarDays').querySelector('[data-date="'+date+'"]');
 function pickDate(name,date){
   $('sq'+name+'Pick').click();
   expect($('sqCalendar').open&&day(date)&&!day(date).disabled,'日历未开放可选日期 '+date);
   day(date).click();
   expect(!$('sqCalendar').open&&$('sq'+name).value===date&&$('sq'+name+'Value').textContent===date,'点选日期没有更新字段');
 }
 $('sqFromPick').click();
 expect($('sqCalendar').open&&day('2026-11-19').disabled&&$('sqCalendarPrev').disabled,'日历允许选早于存档的日期');
 day(d0).dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
 expect(document.activeElement===day(d1),'日历不能用方向键移动');
 $('sqCalendarNext').click();
 expect($('sqCalendarMonth').textContent==='2026 年 12 月'&&day('2026-12-01').classList.contains('is-beyond-forecast'),'日历翻月或延长预测标记无效');
 for(let i=0;i<5&&!$('sqCalendarNext').disabled;i++)$('sqCalendarNext').click();
 expect(!day(C.shopDate(dateTime,119)).disabled&&day(C.shopDate(dateTime,120)).disabled,'日历没限制最多预测 120 天');
 $('sqCalendarClose').click();
 expect(!$('sqCalendar').open&&!$('sqFrom').value,'关闭日历改动了日期');
 pickDate('From',d1);
 expect(shopRows().length===10&&checked().length===0,'只选开始日筛错或自动勾选了弟子');
 $('sqToPick').click();expect(day(d0).disabled,'日历允许结束日早于开始日');$('sqCalendarClose').click();
 pickDate('To',d1);
 $('sqFromPick').click();expect(day(d2).disabled,'日历允许开始日晚于结束日');$('sqCalendarClear').click();
 expect(!$('sqFrom').value&&$('sqTo').value===d1&&shopRows().length===16&&checked().length===0,'清空本栏改变了另一栏或勾选');
 pickDate('From',d1);
 expect(rows().length===40&&shopRows().length===10&&shopRows().every(r=>r.textContent.includes(d1)),'单日筛选漏掉在册或同日商店批次');
 $('sqOnlyShop').click();expect(checked().length===10&&checked().every(r=>r.textContent.includes(d1)),'仅商店没有按招募日勾选');
 change('sqFrom','');change('sqTo',d0);expect(shopRows().length===6,'只填结束日应包含存档当日剩余及手动批次');
 change('sqFrom',d1);expect($('sqStart').disabled&&$('sqOnlyShop').disabled&&$('sqDateHint').textContent.includes('晚于结束日'),'倒置日期仍可推演已勾选的商店弟子');
 $('sqOnlyEnrolled').click();expect(checked().length===30&&!$('sqStart').disabled&&!$('sqFromPick').disabled,'无效商店日期影响了在册或日历修正');
 change('sqFrom','2026-11-19');expect($('sqDateHint').textContent.includes('早于存档游戏日'),'存档之前的日期缺少提示');
 change('sqFrom',d0);$('sqOnlyShop').click();
 pickDate('To',d2);expect(!$('sqExtend').hidden&&$('sqStart').disabled,'预测不足时未提示如何补足天数');
 $('sqManualNone').click();$('sqExtend').click();
 expect($('sqDays').value==='3'&&$('sqCoverage').textContent.includes(d0+' 至 '+d2)&&shopRows().length===11&&!$('sqStart').disabled,'扩展后的区间没有包含首尾，或多算了手动刷新');
 change('sqTo',C.shopDate(dateTime,120));expect($('sqExtend').hidden&&$('sqDateHint').textContent.includes('最多预测 120 天'),'超过 120 天仍可扩展');
 $('sqClearDates').click();expect(!$('sqFrom').value&&!$('sqTo').value&&!$('sqStart').disabled,'清空日期未解除限制');
 const invalidConfig={format:'恒山弟子洗髓序列-v1',config:{days:2,cap:2000,budget:1,groups:[],selected:[],manual:[true,true],from:'2026-02-30'}};
 const configs=new DataTransfer();
 configs.items.add(new File([JSON.stringify(invalidConfig)],'错误招募日期.json'));
 $('sqCfgFile').files=configs.files;$('sqCfgFile').dispatchEvent(new Event('change'));
 await wait(()=>$('sqNotice').textContent.includes('招募日期无效'));
 expect($('sqDays').value==='3'&&!$('sqFrom').value,'无效配置改动了已有的预测或日期');
 $('sqResume').click();await wait(()=>$('sqProgress').textContent.startsWith('本批次已完成'));
 expect($('sqDays').value==='30'&&$('sqFrom').value===entry.date&&$('sqTo').value===entry.date&&
   $('sqCounts').textContent.includes('总计 1 项')&&$('sqCounts').textContent.includes('新成功 1'),'手动续跑未恢复旧商店批次');
 change('sqResultSource','shop');$('sqPlans').querySelector('button').click();await wait(()=>!$('sqRoute').hidden);
 expect($('sqRoute').textContent.includes(entry.date)&&$('sqRoute').textContent.includes('洗练 0 次'),'商店路线丢失招募日期或预算');
 expect(before===C.stable(HengshanDayOps.get()),'商店路线复验改动了手动页面');
 Array.from($('sqGroups').children).find(wrap=>wrap.textContent.includes('旧商店方案')).querySelector('button').click();

 $('sqClearDates').click();change('sqDays','2');find(student.name);$('sqOnlyEnrolled').click();
 $('sqBudget').value='1';$('sqCap').value='2000';$('sqGroups').querySelectorAll('input:checked').forEach(i=>i.click());
 for(const n of goal){const b=[...$('sqTalents').querySelectorAll('button')].find(b=>b.textContent===n);if(!b)throw Error('天赋按钮缺失：'+n);b.click();}
 $('sqGroupName').value='测试组三天赋';$('sqAddGroup').click();$('sqStart').click();$('sqPause').click();
 if(!$('sqProgress').textContent.includes('暂停'))throw Error('无法暂停');$('sqPause').click();
 await wait(()=>!$('sqStart').disabled);if(!$('sqCounts').textContent.includes('新成功 1'))throw Error('未命中：'+$('sqProgress').textContent+' / '+$('sqNotice').textContent+' / '+$('sqCounts').textContent);
 change('sqResultSource','enrolled');$('sqPlans').querySelector('button').click();await wait(()=>!$('sqRoute').hidden);
 if(!$('sqRoute').textContent.includes('洗第 1 槽')||!$('sqRoute').textContent.includes('洗练 1 次'))throw Error('成功路线缺少槽位或洗练次数');
 if(before!==C.stable(HengshanDayOps.get()))throw Error('手动推演页面状态被改动');
 $('sqNone').click();change('sqDays','7');
 $('sqResume').click();await wait(()=>!$('sqStart').disabled);
 expect($('sqCounts').textContent.includes('总计 1 项')&&$('sqCounts').textContent.includes('复用成功 1')&&$('sqDays').value==='2','七天默认覆盖了已保存批次');
 const downloads=[...$('sqRoute').querySelectorAll('button')];for(const b of downloads)b.click();$('sqCfgOut').click();
 find('');$('sqOnlyEnrolled').click();
 for(const n of ctx.held(base))Array.from($('sqTalents').querySelectorAll('button')).find(b=>b.textContent===n).click();
 $('sqGroupName').value='起点三天赋';$('sqAddGroup').click();$('sqStart').click();await wait(()=>!$('sqStart').disabled);
 expect($('sqCounts').textContent.includes('总计 60 项')&&$('sqCounts').textContent.includes('复用成功 1'),'在册批次未完成：'+$('sqProgress').textContent+' / '+$('sqCounts').textContent);
 change('sqResultSource','enrolled');expect($('sqResultCount').textContent.includes('30 名弟子 · 60 条路线'),'同名弟子或多方案归组错误：'+$('sqResultCount').textContent);
 expect($('sqPeople').querySelectorAll('button').length===10&&$('sqPlans').querySelectorAll('button').length===2,'分页或方案归组失败');
 const firstPage=$('sqPeople').textContent;$('sqNext').click();expect($('sqPage').textContent.includes('2 / 3')&&$('sqPeople').textContent!==firstPage,'翻页没有换弟子');
 const pick=$('sqPeople').querySelectorAll('button')[2];pick.click();expect(pick.getAttribute('aria-pressed')==='true','选择弟子失败');$('sqPlans').querySelector('button').click();await wait(()=>!$('sqRoute').hidden);
 $('sqBulkExport').click();await wait(()=>!$('sqBulkExport').disabled);expect($('sqExportNote').textContent.includes('60 条'),'筛选导出错误');
 $('sqResultsFind').value='同名';$('sqResultsFind').dispatchEvent(new Event('input'));expect($('sqRoute').hidden&&$('sqPeople').querySelectorAll('button').length===2&&$('sqPeople').textContent.includes('同名 2/2'),'同名结果未区分或还在显示上一个弟子的路线');
 change('sqResultSource','shop');expect(!$('sqPeople').querySelector('button')&&$('sqBulkExport').disabled,'没有匹配路线时仍可导出筛选');
 $('sqBulk').querySelector('input[value=all]').click();$('sqBulkExport').click();await wait(()=>!$('sqBulkExport').disabled);
 expect($('sqExportNote').textContent.includes('61 条'),'全量导出错误：'+$('sqExportNote').textContent);
 expect((await journal({op:'open'})).routes.some(r=>r.source==='backpack'),'隐藏背包时改动了旧路线');
 window.__seqReport={ok:true,goal,defaultDays:7,defaultSelected:0,restoredDays:30,shopRouteDate:entry.date,grouped:'30 enrolled / 60 routes',exportsFiltered:60,exportsAll:61};
 }catch(e){window.__seqReport={ok:false,message:String(e.stack||e)};}})();void 0;'''

def main():
    app=QApplication.instance() or QApplication(sys.argv)
    with tempfile.TemporaryDirectory() as folder:
        window=MainWindow(Store(folder),ROOT/'web')
        roster=[dict(ID=None if i<2 else i+1,Name='同名弟子' if i<2 else f'弟子{i+1:02d}',Level=100,S=1234567,SPData=[{'ID':n} for n in (1,4,7)]) for i in range(30)]
        window.site.set_snapshot(dict(MainRole={'Name':'测试'},Roles={},Rnds={},RealTime=1795122000,MySectData={'Student':roster}))
        window.stack.setCurrentWidget(window.view);window.show()
        phase={'sent':False,'closed':False};out={};clock=time.monotonic()
        window.profile.downloadRequested.disconnect(window.export_file)
        downloads=[]
        def accept_export(d):
            downloads.append(d)
            d.setDownloadDirectory(folder);d.setDownloadFileName(d.downloadFileName());d.accept()
        window.profile.downloadRequested.connect(accept_export)
        def done(value):
            if not value or phase['closed']:return
            report=json.loads(value)
            if report.get('ok') and (len(downloads)<6 or not all(d.isFinished() for d in downloads)):
                return
            phase['closed']=True;out.update(report);timer.stop();app.quit()
        def loaded(success):
            if not phase['sent'] and success and window.view.url().path().endswith('/hengshan/index.html'):
                phase['sent']=True;window.page.runJavaScript(SCRIPT)
            elif success and window.view.url().path()==window.site.prefix:
                window.page.runJavaScript("const startH=setInterval(()=>{if(loadShareStore()?.data?.MySectData){clearInterval(startH);location.href='hengshan/index.html';}},40)")
        window.view.loadFinished.connect(loaded);window.view.setUrl(QUrl(window.site.url))
        def poll():
            if time.monotonic()-clock>70:done(json.dumps({'ok':False,'message':'Qt smoke timed out'}));return
            if phase['sent']:window.page.runJavaScript('JSON.stringify(window.__seqReport||null)',0,lambda s:done(s) if s and s!='null' else None)
        timer=QTimer();timer.setInterval(125);timer.timeout.connect(poll);timer.start();app.exec();window.close()
        if out.get('ok'):
            files=list(Path(folder).glob('*'));png=next((p for p in files if p.suffix=='.png'),None)
            routes=[p for p in files if p.name.endswith('_路线.json')]
            out['exports']=bool(png and png.read_bytes().startswith(b'\x89PNG') and routes and json.loads(routes[0].read_text(encoding='utf-8'))['washes']==1 and any(p.suffix=='.txt' for p in files) and (Path(folder)/'恒山弟子批量配置.json').is_file())
            for count,persons in [(60,30),(61,31)]:
                with zipfile.ZipFile(Path(folder)/f'恒山弟子路线_{count}条.zip') as z:
                    records=[json.loads(z.read(n)) for n in z.namelist() if n.endswith('/路线.json')]
                    assert len(records)==count and len({r['initial']['key'] for r in records})==persons
                    assert all(r['initial']['source']!='backpack' for r in records)
                    assert sum(n.endswith('/路线.txt') for n in z.namelist())==count
                    assert f'{persons} 名弟子，{count} 条路线' in z.read('索引.html').decode('utf-8')
            out['ok']=out['exports']
        print(json.dumps(out,ensure_ascii=False));return 0 if out.get('ok') else 1
if __name__=='__main__':sys.exit(main())
