/* Same embedded WASM as the manual page, in an independent worker. */
self.window=self;
importScripts('../shared/hengshan_engine_b64.js','../shared/hengshan_talent_data.js','../shared/hengshan_shop_data.js','../shared/hengshan_offline_boot.js','../shared/algorithm_wasm_bridge.js','../shared/wasm_algorithm_api.js','sequence_core.js');
let it=null, progress=null, paused=false, scheduled=false, last=0;
function schedule(){if (!scheduled && it && !paused) {scheduled=true; setTimeout(tick,0);}}
function tick(){
    scheduled=false;if(!it || paused)return;
    try {
        const until=performance.now()+45;
        do {const r=it.next();if(r.done){it=null;postMessage({type:'result',...r.value,...progress});return;}} while(performance.now()<until);
        if(performance.now()-last>=230){last=performance.now();postMessage({type:'progress',...progress});}
        schedule();
    } catch(e){it=null;postMessage({type:'error',message:e.message});}
}
self.onmessage=async ({data:m})=>{
    try {
        if(m.type==='pause'){paused=true;return;}
        if(m.type==='resume'){paused=false;schedule();return;}
        await WasmAlgorithmAPI.ready; progress={}; last=0;
        it=HengshanSequence.context(HengshanStudentEngine,HENGSHAN_TALENT_DATA).search(m.initial,m.targets,m.budget,m.cap,progress);
        schedule();
    } catch(e){postMessage({type:'error',message:e.message});}
};