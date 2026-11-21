/* Directory of verified Hengshan routes. Pagination counts disciples, not routes. */
(function () {
    'use strict';
    const PAGE_SIZE = 10;
    const SOURCES = {enrolled:'在册', shop:'商店'};
    const order = Object.keys(SOURCES);
    const compare = new Intl.Collator('zh-CN', {numeric:true}).compare;
    function make(tag, text, cls) {
        const n=document.createElement(tag);
        if(text!==undefined)n.textContent=text;
        if(cls)n.className=cls;
        return n;
    }
    function groupRoutes(rows) {
        const groups=new Map(), duplicates=new Map();
        for (const r of rows) {
            const source=r.source, key=JSON.stringify([source,r.date,r.batch,r.name,r.studentKey]);
            let g=groups.get(key);
            if(!g){
                g={key,source,date:r.date,batch:r.batch,name:r.name,startKey:r.studentKey,routes:[]};
                groups.set(key,g);
            }
            g.routes.push(r);
        }
        const people=[...groups.values()].sort((a,b)=>order.indexOf(a.source)-order.indexOf(b.source) ||
            compare(a.date,b.date) || compare(a.name,b.name) || compare(a.batch,b.batch) || compare(a.startKey,b.startKey));
        for(const g of people){
            const label=JSON.stringify([g.source,g.date,g.batch,g.name]);
            if(!duplicates.has(label))duplicates.set(label,[]);
            duplicates.get(label).push(g);
            g.routes.sort((a,b)=>a.washes-b.washes || a.days-b.days || compare(a.groupName,b.groupName) || compare(a.task,b.task));
        }
        for(const list of duplicates.values())if(list.length>1)list.forEach((g,i)=>{g.nameTag='同名 '+(i+1)+'/'+list.length;});
        return people;
    }
    window.createHengshanResultBrowser=function ({openRoute,closeRoute,exportRoutes,onError}) {
        const el=id=>document.getElementById('sq'+id);
        let people=[], filtered=[], rows=[], matches=[], page=0, personKey=null, routeTask=null, busy=false;
        function button(cls,label,meta,click){
            const b=make('button',undefined,'btn '+cls);b.type='button';b.append(label,make('span',meta,'seq-meta'));b.onclick=click;return b;
        }
        function forgetRoute(){routeTask=null;closeRoute();}
        function showPlans(person){
            const panel=el('Plans');panel.replaceChildren();
            el('PlansTitle').textContent=person?person.name+' · 命中方案':'天赋方案';
            if(!person){forgetRoute();panel.append(make('p','有匹配的弟子时，这里会列出他的天赋方案。','hengshan-message'));return;}
            if(!person.routes.some(r=>r.task===routeTask))forgetRoute();
            for(const r of person.routes){
                const label=make('span',undefined,'seq-person-label');label.append(make('span',r.groupName));
                if(!r.targets.every(t=>r.groupName.includes(t)))label.append(make('span',r.targets.join('、'),'seq-meta'));
                const b=button('seq-plan',label,r.washes+' 次洗练 · '+r.days+' 天',async()=>{
                    routeTask=r.task;
                    for(const other of panel.children)other.setAttribute('aria-pressed',String(other===b));
                    try{await openRoute(r.task);}catch(e){if(routeTask===r.task){forgetRoute();b.setAttribute('aria-pressed','false');onError(e);}}
                });
                b.setAttribute('aria-pressed',String(r.task===routeTask));panel.append(b);
            }
        }
        function paint(){
            const total=filtered.length,pages=Math.max(1,Math.ceil(total/PAGE_SIZE));
            page=Math.min(Math.max(page,0),pages-1);
            const visible=filtered.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);
            const person=visible.find(g=>g.key===personKey)||visible[0];
            personKey=person?.key??null;
            const dir=el('People'),fragment=document.createDocumentFragment();let source=null;
            for(const g of visible){
                if(g.source!==source){source=g.source;fragment.append(make('h4',SOURCES[source]+'弟子','seq-result-source'));}
                const label=make('span',undefined,'seq-person-label');label.append(make('span',g.name+(g.nameTag?'（'+g.nameTag+'）':'')));
                if(source==='shop')label.append(make('span',[g.date,g.batch].filter(Boolean).join(' · '),'seq-meta'));
                const b=button('seq-person',label,g.routes.length+' 条路线',()=>{
                    personKey=g.key;
                    for(const other of dir.querySelectorAll('button'))other.setAttribute('aria-pressed',String(b===other));
                    showPlans(g);
                });
                b.setAttribute('aria-pressed',String(g.key===personKey));fragment.append(b);
            }
            dir.replaceChildren(fragment);
            if(!total)dir.append(make('p',people.length?'没有匹配的弟子或天赋方案。':'尚无已复验路线。','as-result-empty'));
            el('Pager').hidden=pages<=1;el('Prev').disabled=page===0;el('Next').disabled=page+1>=pages;
            el('Page').textContent='第 '+(page+1)+' / '+pages+' 页';
            el('ResultCount').textContent='当前 '+total+' 名弟子 · '+matches.length+' 条路线 / 共 '+people.length+' 名 · '+rows.length+' 条';
            showPlans(person);exportState();
        }
        function refilter(reset) {
            const terms=el('ResultsFind').value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean), source=el('ResultSource').value;
            filtered=[];matches=[];
            for(const g of people){
                if(source!=='all'&&source!==g.source)continue;
                const hits=g.routes.filter(r=>{
                    if(!terms.length)return true;
                    const text=[SOURCES[g.source],r.date,r.name,r.batch,r.groupName,...r.targets].join(' ').toLocaleLowerCase();
                    return terms.every(t=>text.includes(t));
                });
                if(hits.length){filtered.push({...g,routes:hits});matches.push(...hits);}
            }
            if(reset){page=0;personKey=null;forgetRoute();}
            else {const i=filtered.findIndex(g=>g.key===personKey);if(i>=0)page=Math.floor(i/PAGE_SIZE);}
            paint();
        }
        function toExport(){return el('Bulk').querySelector('input:checked').value==='all'?rows:matches;}
        function exportState(){
            el('ExportFiltered').textContent=matches.length+' 条';el('ExportAll').textContent=rows.length+' 条';
            el('BulkExport').disabled=busy||!toExport().length;
        }
        el('Prev').onclick=()=>{page--;personKey=null;paint();};el('Next').onclick=()=>{page++;personKey=null;paint();};
        el('ResultsFind').oninput=el('ResultSource').onchange=()=>refilter(true);
        el('Bulk').addEventListener('change',exportState);
        el('BulkExport').onclick=async()=>{
            if(busy)return;
            const tasks=toExport().map(r=>r.task);if(!tasks.length)return;
            busy=true;exportState();el('ExportNote').textContent='正在整理 '+tasks.length+' 条路线…';
            try{await exportRoutes(tasks);el('ExportNote').textContent='已生成 '+tasks.length+' 条路线的 ZIP，请在保存窗口选择位置。';}
            catch(e){el('ExportNote').textContent='导出失败：'+e.message;}
            finally{busy=false;exportState();}
        };
        return {update(list){rows=list.filter(row=>Object.hasOwn(SOURCES,row.source));people=groupRoutes(rows);refilter(false);}};
    };
})();
