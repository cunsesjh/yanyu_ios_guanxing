(function(){
    'use strict';
    if (new URLSearchParams(location.search).has('sequenceReplay')) return;
    const C=HengshanSequence, el=id=>document.getElementById('sq'+id);
    const DEFAULT_SHOP_DAYS = 7;
    const set=(id,text)=>{el(id).textContent=text;}, uiTick=()=>new Promise(r=>setTimeout(r,0));
    const node=(tag,text)=>{const q=document.createElement(tag);if(text!==undefined)q.textContent=text;return q;};
    function button(text,fn,cls='btn btn-wash-custom'){const b=node('button',text);b.type='button';b.className=cls;b.onclick=()=>attempt(fn);return b;}
    function check(text,value,fn,disabled=false){const l=node('label'),i=node('input');l.className='as-check';i.type='checkbox';i.checked=value;i.disabled=disabled;i.onchange=()=>attempt(()=>fn(i.checked));l.append(i,document.createTextNode(text));return l;}
    const notice=(s,bad=false)=>{set('Notice',s);el('Notice').classList.toggle('is-error',bad);};
    async function attempt(fn){try{await fn();}catch(e){notice(e.message||String(e),true);}}
    const sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
    let scope='', ctx, rule='', enrolled=[], shop=[], shopState=null, time=0, manual=[], entries=[], groups=[], saved=null, booting=null, ok=false;
    let calendar={first:'',last:'',furthest:'',canExtend:false}, manualDefault=true, dateBlocked=false;
    let datePicker;
    const selected=new Set(), draft=new Set(), marks=new Map(), routes=new Map(), starts=new Map();
    let worker=null, cancelWorker=null, session=null, currentResult=0, resultBrowser=null, poolDirty=false;
    const isShop=student=>student.source==='shop'||student.source==='shop-preview';
    const request=(op,args)=>fetch('../api/hengshan-sequence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op,scope,...args})});
    async function db(op,args={}){
        const r=await request(op,args);
        if (!(r.headers.get('Content-Type')||'').includes('application/json')) throw Error('本地断点服务不可用，请从桌面版观星打开此页');
        const data=await r.json(); if(!r.ok) throw Error(data.error||'无法读写本地断点');return data;
    }
    function controls(){el('Setup').disabled=!ok||!!session;el('Start').disabled=!ok||!!session||dateBlocked||!selected.size;el('Resume').disabled=!ok||!!session||!saved;el('Pause').disabled=!session||session.stopped;el('Stop').disabled=!session||session.stopped;el('Pause').textContent=session?.paused?'继续':'暂停';}
    function groupKey(ts){return C.stable(ts.slice().sort());}
    function addMark(m){const list=marks.get(m.task)||[];list.push(m);marks.set(m.task,list);}
    function config(){return {days:manual.length,reconcile:el('Reconcile').checked,manual:manual.slice(),manualDefault,selected:[...selected],groups:C.clone(groups),budget:Number(el('Budget').value),cap:Number(el('Cap').value),from:el('From').value,to:el('To').value};}
    function restore(c){
        groups=c?.groups ? c.groups.map(g=>({...g,targets:ctx.targets(g.targets)})) : C.presets.map(t=>({name:t.join(' · '),targets:t.slice(),on:true}));
        el('Budget').value=c?.budget??4;el('Cap').value=c?.cap??500000;el('Days').value=c?.days??DEFAULT_SHOP_DAYS;
        el('Reconcile').checked=c?.reconcile===true;
        manualDefault=typeof c?.manualDefault==='boolean'?c.manualDefault:(c?.manual?.length?c.manual.some(Boolean):true);
        manual=Array.from({length:Number(el('Days').value)},(_,i)=>c?.manual?.[i]??manualDefault);
        el('From').value=c?.from||'';el('To').value=c?.to||'';
        selected.clear();(c?.selected||[]).forEach(k=>selected.add(k));
        updateShop();renderGroups();renderTalents();
    }
    function updateShop(){
        const n=C.integer(Number(el('Days').value),1,120,'预测天数');manual=Array.from({length:n},(_,i)=>manual[i]??manualDefault);
        const reconcile=el('Reconcile').checked, used=!reconcile&&shopState?.refreshes>=1;
        if(used)manual[0]=false;
        let prediction=[], reason='';
        try{prediction=C.shopPlan(HengshanStudentEngine,HENGSHAN_TALENT_DATA,HENGSHAN_SHOP_DATA,shop,shopState,time,n,manual,reconcile);}
        catch(e){reason=e.message+'；仅显示存档里的弟子。';prediction=shop.map(s=>({s,key:String(s.key),date:time?C.shopDate(time):'',batch:'当前商店'}));}
        const first=time>0?C.shopDate(time):'';
        calendar={first,last:reason?(prediction.length?first:''):C.shopDate(time,n-1),
            furthest:first?C.shopDate(time,119):'',canExtend:!reason};
        const coverage=!reason?'可筛招募日：'+first+' 至 '+calendar.last+'（含存档当日，共 '+n+' 天）。':
            (calendar.last?'仅可查看 '+first+' 的当前商店。':'暂无可筛选的商店日期。');
        set('Coverage',(first?'存档游戏日：'+first+'。':'未读到存档游戏日。')+coverage);
        const old=new Map(entries.map(e=>[e.key,e]));entries=enrolled.concat(prediction);const keys=new Set(entries.map(e=>e.key));
        for(const k of selected)if(!keys.has(k))selected.delete(k);
        // If a refresh plan changes the actual candidate, do not retain a tick on a different person.
        for(const e of entries)if(selected.has(e.key)&&old.has(e.key)&&C.stable(old.get(e.key).s)!==C.stable(e.s))selected.delete(e.key);
        starts.clear();const ul=el('ManualDays');ul.replaceChildren();if(reason)ul.textContent=reason;
        else for(let i=0;i<n;i++)ul.append(check(C.shopDate(time,i)+(i===0&&used?'（已刷新）':''),manual[i],v=>{manual[i]=v;updateShop();},i===0&&used));
        renderStudents();
    }
    function recruitRange(){
        const from=el('From').value,to=el('To').value,range={from,to};
        const error=(message,days)=>({...range,invalid:true,message,days});
        if(!from&&!to)return {...range,message:'日期只筛选商店。只选开始日表示从这天起，只选结束日表示截至这天。'};
        if([from,to].some(d=>d&&d.length!==10))return error('请选择四位年份的招募日期。');
        if(from&&to&&from>to)return error('招募开始日晚于结束日，请调整起止日期。');
        if(!calendar.last)return error('当前存档没有可筛选的商店日期。请清空日期或更换存档。');
        if((from&&from<calendar.first)||(to&&to<calendar.first))return error('日期早于存档游戏日 '+calendar.first+'。请改用更早的存档，或调整招募日期。');
        const end=to||from;
        if(end>calendar.last){
            if(!calendar.canExtend)return error('当前只能查看 '+calendar.first+' 的存档商店，无法预测之后的日期。');
            if(end>calendar.furthest)return error('这份存档最多预测 120 天，最远到 '+calendar.furthest+'。请缩短区间，或改用更晚的存档。');
            const days=(Date.parse(end+'T00:00:00Z')-Date.parse(calendar.first+'T00:00:00Z'))/86400000+1;
            return error('当前预测只到 '+calendar.last+'。要包含 '+end+'，需从存档日起预测 '+days+' 天。',days);
        }
        return {...range,message:'商店招募日 '+(from||calendar.first)+' 至 '+(to||calendar.last)+'（含首尾）。'};
    }
    function inRecruitRange(entry, range) {
        if (range.invalid) return false;
        const {from, to} = range;
        if (!from && !to) return true;
        return entry.date && (!from || entry.date >= from) && (!to || entry.date <= to);
    }
    function filtered(range){
        const q=el('Find').value.trim();
        return entries.filter(e=>{
            if(isShop(e.s)&&!inRecruitRange(e,range))return false;
            return !q||[e.s.name,...ctx.held(e.s)].some(v=>v.includes(q));
        });
    }
    function blocksStart(range){return !!range.invalid&&entries.some(e=>isShop(e.s)&&selected.has(e.key));}
    function countStudents(rows,range){
        const outside=selected.size-rows.filter(e=>selected.has(e.key)).length;
        set('Selected','列表 '+rows.length+' 名 · 共勾选 '+selected.size+' 名'+(outside?'（含列表外 '+outside+' 名）':''));
        el('None').disabled=!selected.size;
        dateBlocked=blocksStart(range);controls();
    }
    function renderStudents(){
        const range=recruitRange(),rows=filtered(range),list=el('Students'),frag=document.createDocumentFragment();
        datePicker.update(calendar,range);
        set('DateHint',range.message);el('DateHint').classList.toggle('is-error',!!range.invalid);
        el('Extend').hidden=!range.days;if(range.days)set('Extend','把预测延长到 '+range.days+' 天');
        el('All').disabled=!rows.length;
        el('OnlyEnrolled').disabled=!rows.some(e=>!isShop(e.s));
        el('OnlyShop').disabled=!rows.some(e=>isShop(e.s));
        for(const e of rows){
            const kind=e.date?e.date+' · '+e.batch:e.batch;
            frag.append(check(kind+'　'+e.s.name+'　'+e.s.level+' 级　'+ctx.held(e.s).join('、')+(ctx.banned(e.s)?'（刻苦训练，搜索时跳过）':''),selected.has(e.key),v=>{
                if(v)selected.add(e.key);else selected.delete(e.key);countStudents(rows,range);
            }));
        }
        list.replaceChildren(frag);if(!rows.length)list.textContent='当前筛选没有弟子。';
        countStudents(rows,range);
    }
    function selectResults(mode) {
        selected.clear();
        if (mode !== 'none') {
            for (const entry of filtered(recruitRange())) {
                if (mode === 'all' || isShop(entry.s) === (mode === 'shop')) selected.add(entry.key);
            }
        }
        renderStudents();
    }
    function renderGroups(){const box=el('Groups');box.replaceChildren();for(const g of groups){const wrap=node('span');wrap.className='seq-group';wrap.append(check(g.name,g.on,v=>{g.on=v;}));wrap.title=g.targets.join('、');if(g.custom)wrap.append(button('移除',()=>{groups=groups.filter(a=>a!==g);renderGroups();},'btn btn-reset'));box.append(wrap);}}
    function renderTalents(){const box=el('Talents'),q=el('TalentFind').value.trim();box.replaceChildren();const known=new Set();
        for (const cat of HengshanAutoSimCore.CATEGORIES) {const div=node('div');div.className='seq-talent-category';const items=[];for(const id of cat.ids){const n=ctx.name(id);if(n===C.BAN||known.has(n)||!n.includes(q))continue;known.add(n);const b=button(n,()=>{if(draft.has(n))draft.delete(n);else if(draft.size<3)draft.add(n);else throw Error('一组最多三个天赋，请先取消一项');renderTalents();},'as-talent');b.setAttribute('aria-pressed',String(draft.has(n)));items.push(b);}if(items.length){const grid=node('div');grid.className='as-talent-grid';grid.append(...items);div.append(node('h4',cat.name),grid);box.append(div);}}
        set('Draft',draft.size+'/3　'+[...draft].join('、'));el('AddGroup').disabled=draft.size!==3;
    }
    function addGroup(){const targets=ctx.targets([...draft]);if(groups.some(g=>groupKey(g.targets)===groupKey(targets)))throw Error('已有同一组三天赋');groups.push({name:el('GroupName').value.trim()||targets.join(' · '),targets,on:true,custom:true});draft.clear();el('GroupName').value='';renderGroups();renderTalents();}
    async function boot(){
        await WasmAlgorithmAPI.ready;ctx=C.context(HengshanStudentEngine,HENGSHAN_TALENT_DATA);
        const data=await db('open'), lastConfig=data.config;
        scope=data.scope;
        saved=lastConfig?.selected?.length ? lastConfig : null;
        rule=C.RULE+':'+await sha(HENGSHAN_ENGINE_WASM_B64+C.stable(HENGSHAN_TALENT_DATA));
        for(const m of data.marks)addMark(m);for(const r of data.routes)routes.set(r.task,r);
        readRoster();
        // Start a new selection even when this save has a batch to resume.
        restore({groups:lastConfig?.groups,budget:lastConfig?.budget,cap:lastConfig?.cap});
        renderResults();ok=true;controls();
        notice(entries.length?'已读取存档。勾选在册或商店弟子即可开始配置。':'当前存档没有可推演的弟子。');
    }
    function readRoster(){
        poolDirty=false;
        const all=HengshanPageState.getSimulationStudents();
        enrolled=all.filter(s=>s.source==='enrolled').map(s=>({key:String(s.key),s,date:'',batch:'在册'}));
        shop=HengshanShopView.getCurrentCandidates().filter(isShop);
        shopState=HengshanShopView.getShopState();
        time=Number((shop.find(s=>s.currentTime)||all.find(s=>s.currentTime)||{}).currentTime)||0;
    }
    function enter(){
        if(document.documentElement.dataset.hengshanView!=='sequence'){datePicker.close();return;}
        if(!booting)booting=boot().catch(e=>{booting=null;notice(e.message,true);});
        else if(ok&&poolDirty&&!session)attempt(()=>{readRoster();updateShop();});
    }
    async function startOf(e){let item=starts.get(e.key);if(!item){const initial=HengshanPageState.prepareSnapshot(e.s);item={initial,fingerprint:await sha(C.stable(initial))};starts.set(e.key,item);}return item;}
    async function taskId(e,start,targets){return sha(C.stable([rule,e.date,start.fingerprint,targets.slice().sort()]));}
    function counts(sess){const n=sess.count;set('Counts',`总计 ${n.total} 项，待处理 ${n.total-n.done} 项；新成功 ${n.found}，复用成功 ${n.reused}，预算内无解 ${n.exhausted}，达到上限 ${n.limited}，刻苦训练跳过 ${n.banned}。`);}
    function togglePause(){const s=session;if(!s||s.stopped)return;s.paused=!s.paused;worker?.postMessage({type:s.paused?'pause':'resume'});if(s.release){s.release();s.release=null;}controls();set('Progress',s.paused?'已暂停，当前项保留。':'正在继续…');}
    function stop(){const s=session;if(!s)return;s.stopped=true;if(s.release)s.release();if(cancelWorker)cancelWorker(Error('已停止'));controls();}
    async function gate(s){while(s.paused&&!s.stopped)await new Promise(r=>{s.release=r;});if(s.stopped)throw Error('已停止');}
    function search(s,payload,label){return new Promise((resolve,reject)=>{
        if(!worker)worker=new Worker('sequence_worker.js');cancelWorker=reject;
        worker.onerror=e=>reject(Error(e.message||'推演线程异常退出'));
        worker.onmessage=({data:m})=>{if(m.type==='error')reject(Error(m.message));else if(m.type==='result')resolve(m);else if(!s.paused)set('Progress',`${label} · 正在搜索 ${m.pass} 次洗练层，已检查 ${m.nodes.toLocaleString()} 个状态`);};
        worker.postMessage({type:'search',...payload});
    }).finally(()=>{cancelWorker=null;});}
    function shopInstructions(e){
        if(!e.date)return null;
        const from=C.shopDate(time), dates=[];
        for(let i=0;i<manual.length;i++){const d=C.shopDate(time,i);if(d>e.date)break;if(manual[i]&&(d<e.date||e.batch==='手动刷新'))dates.push(d);}
        return {from,date:e.date,batch:e.batch,alreadyRefreshed:!el('Reconcile').checked&&Number(shopState?.refreshes)>=1,reconcile:el('Reconcile').checked,manualDates:e.batch==='当前商店'?[]:dates};
    }
    function sourceLabel(r){return r.date?r.date+' · '+r.batch:r.batch;}
    async function saveRoute(s,e,g,task,start,moves,final){const r=await HengshanSequenceVerify.verify(ctx,e,start,g.targets,moves,final,()=>gate(s));await gate(s);
        const route={...r,verified:true,rule,name:e.s.name,date:e.date,batch:e.batch,shopPlan:shopInstructions(e),targets:g.targets,groupName:g.name,level:r.final.level,initial:start};
        const stored=await db('save-route',{task,route});routes.set(task,{...stored,task});return route;
    }
    function done(s,status){s.count[status]++;s.count.done++;counts(s);}
    async function run(resume){
        if(session||!ok)return;
        if(resume){
            if(!saved)throw Error('还没有可继续的批次');
            const current=config();
            restore(saved);
            if(selected.size!==new Set(saved.selected).size){
                restore(current);
                throw Error('上次批次有弟子已不在可选名单。请重新勾选，再开始批量推演。');
            }
            el('Cap').value=Math.max(Number(saved.cap),current.cap||0);
        }
        const range=recruitRange();if(blocksStart(range))throw Error(range.message);
        const cfg=config(), gs=cfg.groups.filter(g=>g.on), es=entries.filter(e=>selected.has(e.key));
        if(!es.length||!gs.length)throw Error('请至少勾选一名弟子和一个天赋组');
        C.integer(cfg.budget,0,100,'洗练次数');C.integer(cfg.cap,1,100000000,'状态上限');gs.forEach(g=>ctx.targets(g.targets));
        const s={paused:false,stopped:false,count:{total:es.length*gs.length,done:0,found:0,reused:0,exhausted:0,limited:0,banned:0}};session=s;controls();counts(s);
        try{
            await db('batch',{config:cfg});saved=cfg;await gate(s);set('Progress','正在核对同一起点的已有路线和断点…');
            const pending=[];let scanned=0;
            for(const g of gs)for(const e of es){await gate(s);const start=await startOf(e), task=await taskId(e,start,g.targets), r=routes.get(task);
                if(r && C.reusable({status:'found',washes:r.washes},cfg.budget,cfg.cap))done(s,'reused');
                else {const prior=(marks.get(task)||[]).find(m=>C.reusable(m,cfg.budget,cfg.cap));if(prior)done(s,prior.status);else pending.push({e,g,task,start});}
                if(++scanned%40===0)await uiTick();
            }
            for(let i=0;i<pending.length;i++){
                await gate(s);const {e,g,task,start}=pending[i], label=`待跑 ${i+1}/${pending.length} · ${e.date?e.date+' · ':''}${e.s.name} · ${g.name}`;set('Progress',label+' · 正在搜索');
                const r=await search(s,{initial:start.initial,targets:g.targets,budget:cfg.budget,cap:cfg.cap},label);await gate(s);
                if(r.status==='found'){set('Progress',label+' · 正在手动推演页逐步复验');await saveRoute(s,e,g,task,start.initial,r.moves,r.final);done(s,'found');renderResults();}
                else{const m={task,status:r.status,cap:cfg.cap,budget:cfg.budget};await db('mark',m);addMark(m);done(s,r.status);}
            }
            set('Progress','本批次已完成。达到上限的项目可调高状态上限后点「继续上次批次」。');
        }catch(e){set('Progress',s.stopped?'已停止，已完成项已保存；继续时从未完成项重跑。':'批次中断：'+e.message+'。已完成项已保存。');if(!s.stopped)throw e;}
        finally{worker?.terminate();worker=null;HengshanSequenceVerify.close();session=null;controls();enter();}
    }
    function renderResults(){resultBrowser.update([...routes.values()].filter(r=>r.rule===rule));}
    async function exportRoutes(tasks){
        const resp=await request('export',{tasks,rule});
        if(!resp.ok){const data=await resp.json().catch(()=>({}));throw Error(data.error||'无法生成路线包');}
        if(!(resp.headers.get('Content-Type')||'').startsWith('application/zip'))throw Error('未收到路线包，请重新打开桌面版');
        saveFile('恒山弟子路线_'+tasks.length+'条.zip',await resp.blob());
    }
    function lines(r){return r.steps.map(s=>s.type==='day'?`成长 ${s.days} 天：${s.from} → ${s.to} 级`:`第 ${s.day} 天 · ${s.level} 级，洗第 ${s.slot+1} 槽：${s.old} → ${s.drawn}`);}
    function download(r,ext,blob){saveFile(`${r.date||r.batch}_${r.name}_${r.targets.join(' ')}_路线.${ext}`.replace(/[<>:"/\\|?*]/g,'_'),blob);}
    function saveFile(name,blob){const a=node('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),15000);}
    function dateRanges(ds){const runs=[];for(const d of ds){const last=runs[runs.length-1];if(last && Date.parse(d)-Date.parse(last[1])===86400000)last[1]=d;else runs.push([d,d]);}return runs.map(([a,b])=>a===b?a:a+' 至 '+b).join('、');}
    function routeImage(r,head,body){const canvas=node('canvas');canvas.width=960;const g=canvas.getContext('2d'),font='18px "Microsoft YaHei",sans-serif';g.font=font;const wrapped=[];for(const line of [...head.slice(1),...body]){let text='';for(const char of line){if(text&&g.measureText(text+char).width>900){wrapped.push(text);text='';}text+=char;}wrapped.push(text);}canvas.height=105+32*wrapped.length;g.fillStyle='#152131';g.fillRect(0,0,canvas.width,canvas.height);g.fillStyle='#f1d490';g.font='bold 25px "Microsoft YaHei",sans-serif';g.fillText(head[0],24,40,910);g.font=font;g.fillStyle='#ebf1f8';wrapped.forEach((line,i)=>g.fillText(line,24,80+32*i));canvas.toBlob(blob=>{if(blob)download(r,'png',blob);else notice('路线图过长，请导出文字或 JSON',true);},'image/png');}
    async function showRoute(task){const id=++currentResult,r=await db('route',{task});if(id!==currentResult)return;const box=el('Route'), h=[`${r.name} · ${sourceLabel(r)}`,`目标：${r.targets.join('、')}`,`完成于 ${r.level} 级 · 洗练 ${r.washes} 次 · 推进 ${r.days} 天`,`最终天赋：${r.finalTalents.join('、')}`], steps=lines(r);
        if(r.shopPlan?.from)h.push('从 '+r.shopPlan.from+' 起，招募前需手动刷新的日期：'+(dateRanges(r.shopPlan.manualDates)||'无')+(r.shopPlan.alreadyRefreshed?'（存档当日已刷新）':'')+(r.shopPlan.reconcile?'；起点按补算一次今日自动刷新推演，请以游戏名单核对。':''));
        box.hidden=false;box.replaceChildren(node('h3',h[0]),...h.slice(1).map(s=>node('p',s)));const ol=node('ol');ol.className='as-plan-list';for(const line of steps)ol.append(node('li',line));box.append(steps.length?ol:node('p','起点已满足，无需操作。'));
        const bar=node('div');bar.className='seq-row';bar.append(button('导出路线文字',()=>download(r,'txt',new Blob([[...h,...steps].join('\r\n')],{type:'text/plain;charset=utf-8'}))),button('导出路线图',()=>routeImage(r,h,steps)),button('导出路线 JSON',()=>download(r,'json',new Blob([JSON.stringify(r,null,2)],{type:'application/json'}))));box.append(bar);box.scrollIntoView({block:'nearest'});
    }
    async function loadConfig(file){
        if(!file)return;if(file.size>2*1024*1024)throw Error('配置过大');const pack=JSON.parse((await file.text()).replace(/^\uFEFF/,'')),c=pack.config;
        if(pack.format!=='恒山弟子洗髓序列-v1'||!c||!Array.isArray(c.groups)||!Array.isArray(c.selected))throw Error('请选择本页面导出的批量配置');
        C.integer(c.days,1,120,'预测天数');C.integer(c.cap,1,100000000,'状态上限');C.integer(c.budget,0,100,'洗练次数');
        const dateInput=el('From').cloneNode();
        for(const date of [c.from,c.to]){
            if(date==null||date==='')continue;
            dateInput.value=date;
            if(typeof date!=='string'||date.length!==10||dateInput.value!==date)throw Error('配置里的招募日期无效，请检查开始日和结束日。');
        }
        if(!Array.isArray(c.manual)||c.manual.length!==c.days||c.manual.some(x=>typeof x!=='boolean'))throw Error('逐日刷新配置无效');
        c.groups.forEach(g=>{ctx.targets(g.targets);if(typeof g.name!=='string'||!g.name.trim())throw Error('天赋组需要名称');});
        const same=pack.scope===scope;restore({...c,selected:same?c.selected:[]});notice(same?'已载入配置。开始推演后才会更新本机批次断点。':'已载入其他存档的天赋组、预算和刷新计划，请重新勾选本存档的弟子。');
    }
    function bind(){
        datePicker=createHengshanDatePicker(el,()=>attempt(renderStudents));
        resultBrowser=createHengshanResultBrowser({openRoute:showRoute,exportRoutes,onError:e=>notice(e.message,true),
            closeRoute(){currentResult++;el('Route').hidden=true;el('Route').replaceChildren();}});
        for(const id of ['Find','From','To'])el(id).addEventListener(id==='Find'?'input':'change',()=>attempt(renderStudents));
        for(const [id,mode] of [['All','all'],['None','none'],['OnlyEnrolled','enrolled'],['OnlyShop','shop']]){
            el(id).onclick=()=>selectResults(mode);
        }
        el('ClearDates').onclick=()=>{el('From').value='';el('To').value='';renderStudents();};
        el('Extend').onclick=()=>attempt(()=>{const {days}=recruitRange();if(days){el('Days').value=days;updateShop();}});
        el('Days').onchange=el('Reconcile').onchange=()=>attempt(updateShop);for(const [id,value] of [['ManualAll',true],['ManualNone',false]])el(id).onclick=()=>attempt(()=>{manual=Array(C.integer(Number(el('Days').value),1,120,'预测天数')).fill(value);manualDefault=value;updateShop();});
        el('TalentFind').oninput=()=>attempt(renderTalents);el('AddGroup').onclick=()=>attempt(addGroup);el('Start').onclick=()=>attempt(()=>run(false));el('Resume').onclick=()=>attempt(()=>run(true));el('Pause').onclick=togglePause;el('Stop').onclick=stop;
        el('CfgOut').onclick=()=>attempt(()=>saveFile('恒山弟子批量配置.json',new Blob([JSON.stringify({format:'恒山弟子洗髓序列-v1',scope,config:config()},null,2)],{type:'application/json'})));
        el('CfgIn').onclick=()=>el('CfgFile').click();el('CfgFile').onchange=()=>attempt(async()=>{try{await loadConfig(el('CfgFile').files[0]);}finally{el('CfgFile').value='';}});
        window.addEventListener('hengshan-student-pool-changed',()=>{poolDirty=true;enter();});
        window.addEventListener('yyjh:feature-change',enter);enter();
    }
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
})();
