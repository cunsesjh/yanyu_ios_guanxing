/* Re-run successful routes through an isolated instance of the real manual tab.
 * The user's current disciple, history and shop selection are never modified. */
(function(){
    'use strict';
    const core=HengshanSequence;
    const yieldUI=()=>new Promise(r=>setTimeout(r,0));
    let frame=null, ready=null;
    function manual(){
        if (ready) return ready;
        frame=document.createElement('iframe'); frame.hidden=true; frame.title='手动推演复验';
        ready=new Promise((resolve,reject)=>{
            frame.onload=async()=>{try{const w=frame.contentWindow;await w.WasmAlgorithmAPI.ready;
                if (!w.HengshanDayOps || !w.HengshanPageState) throw Error('手动推演页未就绪');resolve(w);
            }catch(e){reject(e);}};
            frame.onerror=()=>reject(Error('手动推演页未能加载'));
        });
        frame.src='index.html?tool=manual&sequenceReplay=1';document.body.append(frame);return ready;
    }
    function close(){if (frame) frame.remove();frame=null;ready=null;}
    async function verify(ctx, entry, initial, goal, moves, final, checkpoint=async()=>{}){
        const replay=ctx.replay(initial,moves,goal,final);
        const w=await manual();await checkpoint();const d=w.document, el=id=>d.getElementById(id);
        w.HengshanShopState.loadCandidates([core.clone(entry.s)],null);
        w.dispatchEvent(new w.CustomEvent('hengshan-shop-bag-changed',{detail:{preferredKey:entry.key}}));
        el('btnResetStudent').click();
        let expected=initial;
        const check=i=>{if(core.stable(w.HengshanDayOps.get())!==core.stable(expected))throw Error('第 '+i+' 步与手动推演不一致，未保存路线');};
        check(0);
        for(let i=0;i<moves.length;i++){
            if(i%8===0){await yieldUI();await checkpoint();}
            const m=moves[i];expected=ctx.step(expected,m);
            if(m===core.DAY) el('btnAdvanceUnlock').click();
            else {
                el('refreshSlot').value=String(m);el('refreshSlot').dispatchEvent(new w.Event('change',{bubbles:true}));
                el('refreshAdvanceCount').value='1';el('btnSimulateRefresh').click();
                const apply=el('refreshRows').querySelector('[data-refresh-step="1"]');
                if(!apply) throw Error('手动推演页未返回槽位刷新结果');apply.click();
            }
            check(i+1);
        }
        return replay;
    }
    window.HengshanSequenceVerify={verify,close};
})();