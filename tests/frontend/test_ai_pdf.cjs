const testPaths = require('./paths.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
function fixture(reply){
 const handlers=[],uploads=[],sent=[],registrations=[];let context;
 const frame={dataset:{aiReady:'true'},contentWindow:{postMessage(data){sent.push(data);queueMicrotask(()=>handlers[0]({origin:'http://localhost',source:frame.contentWindow,data:{type:'slide-notes:pdf-context-result',id:data.id,...reply}}));}}};
 const tab={kind:'pdf',path:'paper.pdf',title:'Paper',view:{frame}};
 context=vm.createContext({console,URL,crypto:webcrypto,AbortController,setTimeout,clearTimeout,location:{origin:'http://localhost'},window:{addEventListener(type,callback){if(type==='message')handlers.push(callback);}},document:{addEventListener(){}},editorTabs:{active:tab.path,items:[tab]},aiState:{sessions:new Map()},$:(selector,root)=>root?.frame,api:async(route,body)=>{if(route.endsWith('pdf-context')){registrations.push(body);return {id:'reference-id',path:body.source.path,page:body.source.page,pageCount:body.source.pageCount,fingerprint:body.source.fingerprint};}uploads.push(body);return {id:'page-image'};}});
 vm.runInContext(fs.readFileSync(testPaths.STATIC_ROOT+'/ai-pdf.js','utf8'),context);
 const session={cell:null,path:'paper.pdf',request:{controller:new AbortController()}};context.session=session;context.sources=[];context.images=[];
 return {context,frame,tab,session,uploads,sent,registrations,run:code=>vm.runInContext(code,context)};
}
const page={page:2,pageCount:9,text:'PAGE TWO',rects:[[0,0,600,800]],fingerprint:'version',data:'data:image/png;base64,AAAA'};
test('PDF context is registered once and sends only a page reference',async()=>{
 const f=fixture({source:page});const reference=await f.run('collectAIPDFContext(session,sources,images)');
 assert.equal(reference.path,'paper.pdf');assert.equal(reference.page,2);assert.equal(f.context.sources.length,0);assert.equal(f.registrations[0].source.text,'PAGE TWO');assert.equal(f.registrations[0].source.image.id,'page-image');assert.equal(f.uploads.length,1);
 f.tab.aiPDFPage={page:2,pageCount:9,fingerprint:'version'};
 const again=await f.run('collectAIPDFContext(session,sources,images)');assert.equal(again,reference);assert.equal(f.uploads.length,1);assert.equal(f.sent.length,1);assert.equal(f.registrations.length,1);
 f.tab.aiPDFPage={page:3,pageCount:9,fingerprint:'version'};await f.run('collectAIPDFContext(session,sources,images)');assert.equal(f.sent.length,2);
 f.tab.aiPDFPage={page:2,pageCount:9,fingerprint:'changed'};await f.run('collectAIPDFContext(session,sources,images)');assert.equal(f.sent.length,3);
});
test('manual PDF selection takes priority and cell sessions never capture unrelated PDF',async()=>{
 const f=fixture({source:page});f.context.sources=[{path:'paper.pdf',kind:'text',text:'selected'}];await f.run('collectAIPDFContext(session,sources,images)');assert.equal(f.sent.length,0);
 f.context.sources=[];f.session.cell='one';await f.run('collectAIPDFContext(session,sources,images)');assert.equal(f.sent.length,0);
});
test('unready or invalid automatic snapshots fall back to a location without fabricated page content',async()=>{
 const f=fixture({source:page});f.frame.dataset.aiReady='';assert.equal(await f.run('collectAIPDFContext(session,sources,images)'),undefined);
 assert.equal(JSON.stringify(f.session.request.pdfReadTarget),JSON.stringify({path:'paper.pdf'}));assert.equal(f.sent.length,0);assert.equal(f.registrations.length,0);
 f.tab.aiPDFPage={page:4,pageCount:9};await f.run('collectAIPDFContext(session,sources,images)');assert.equal(f.session.request.pdfReadTarget.page,4);
 const bad=fixture({source:{...page,rects:['oops']}});await bad.run('collectAIPDFContext(session,sources,images)');assert.equal(bad.session.request.pdfReadTarget.page,2);assert.equal(bad.registrations.length,0);
 const text=fixture({source:{...page,data:undefined}});text.context.images=Array(8).fill({id:'existing'});await text.run('collectAIPDFContext(session,sources,images)');assert.equal(text.sent[0].includeImage,true);assert.equal(text.uploads.length,0);assert.equal(text.registrations[0].source.text,'PAGE TWO');
 const empty=fixture({source:{...page,data:undefined,text:''}});await empty.run('collectAIPDFContext(session,sources,images)');assert.equal(empty.session.request.pdfReadTarget.page,2);assert.equal(empty.registrations.length,0);
});
test('automatic reader and upload errors retain manual attachments and use only a valid location hint',async()=>{
 const f=fixture({error:'PDF reader failed'});f.tab.aiPDFPage={page:3,pageCount:9};const sources=[{path:'other.pdf',kind:'text',text:'MANUAL EXCERPT'}],images=[{id:'manual-image'}];f.context.sources=sources;f.context.images=images;
 await f.run('collectAIPDFContext(session,sources,images)');assert.equal(f.session.request.pdfReadTarget.page,3);assert.equal(f.context.sources,sources);assert.equal(f.context.images,images);assert.equal(f.registrations.length,0);
 const failed=fixture({source:page});failed.context.api=async()=>{throw Error('upload unavailable');};await failed.run('collectAIPDFContext(session,sources,images)');assert.equal(failed.session.request.pdfReadTarget.page,2);
 const selected=fixture({source:page});selected.frame.dataset.aiReady='';selected.context.sources=[{path:'paper.pdf',kind:'text',text:'SELECTED'}];await selected.run('collectAIPDFContext(session,sources,images)');assert.equal(selected.session.request.pdfReadTarget,undefined);assert.equal(selected.context.sources[0].text,'SELECTED');assert.equal(selected.sent.length,0);
});
test('automatic snapshot timeout is bounded and releases request bookkeeping before path fallback',async()=>{
 const f=fixture({source:page});f.tab.aiPDFPage={page:2,pageCount:9};f.frame.contentWindow.postMessage=data=>f.sent.push(data);const waits=[];
 f.context.setTimeout=(callback,delay)=>{waits.push(delay);return setTimeout(callback,0);};
 await f.run('collectAIPDFContext(session,sources,images)');assert.ok(waits[0]<=2500);assert.equal(f.session.request.pdfReadTarget.page,2);assert.equal(f.run('aiPDFContextRequests.size'),0);assert.equal(f.registrations.length,0);
});
test('cancelled, switched-file and replaced requests cannot continue through automatic fallback',async()=>{
 const cancelled=fixture({source:page});cancelled.frame.contentWindow.postMessage=()=>cancelled.session.request.controller.abort();await cancelled.run('collectAIPDFContext(session,sources,images)');assert.equal(cancelled.session.request.pdfReadTarget,undefined);assert.equal(cancelled.run('aiPDFContextRequests.size'),0);
 const switched=fixture({source:page}),post=switched.frame.contentWindow.postMessage;switched.frame.contentWindow.postMessage=data=>{switched.context.editorTabs.active='other.pdf';post(data);};await switched.run('collectAIPDFContext(session,sources,images)');assert.equal(switched.session.request.controller.signal.aborted,true);assert.equal(switched.session.request.pdfReadTarget,undefined);assert.equal(switched.registrations.length,0);
 const replaced=fixture({error:'reader failed'}),old=replaced.session.request,oldPost=replaced.frame.contentWindow.postMessage;replaced.frame.contentWindow.postMessage=data=>{replaced.session.request={controller:new AbortController()};oldPost(data);};await replaced.run('collectAIPDFContext(session,sources,images)');assert.equal(old.controller.signal.aborted,true);assert.equal(replaced.session.request.pdfReadTarget,undefined);
});
test('PDF text batches are atomic and never upload cropped images',async()=>{
 const f=fixture({source:page});Object.assign(f.session,{key:'chat',scopeKey:'scope',title:'Chat',sources:[],images:[]});
 f.context.aiState.scopes=new Map([['scope',{ready:true}]]);f.context.aiState.sessions.set('chat',f.session);
 f.context.persistAI=()=>{};f.context.refreshAI=()=>{};
 f.run("aiPDFTargets=()=>[{key:'chat'}]");
 f.context.tab=f.tab;const source={page:1,rects:[[0,0,20,10]],text:'first',fingerprint:'version',kind:'pdf-elements',elements:[{index:0,from:0,to:5}]};
 f.context.data={targetKey:'chat',sources:[source,{...source,page:2}]};await f.run('attachAIPDFSelection(tab,data)');assert.equal(f.session.sources.length,2);assert.equal(f.session.sources[1].elements[0].index,0);assert.equal(f.uploads.length,0);
 f.context.data={targetKey:'chat',sources:[source,{...source,text:''}]};await assert.rejects(f.run('attachAIPDFSelection(tab,data)'),/没有可选文字/);assert.equal(f.session.sources.length,2);
 f.context.data={targetKey:'chat',source:{...source,data:'data:image/png;base64,AAAA'}};await assert.rejects(f.run('attachAIPDFSelection(tab,data)'),/只接收原文引用/);assert.equal(f.uploads.length,0);
 f.context.data={targetKey:'chat',sources:Array(19).fill(source)};await assert.rejects(f.run('attachAIPDFSelection(tab,data)'),/20/);assert.equal(f.session.sources.length,2);
});
