const testPaths = require('./paths.cjs');
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process'),{test}=require('node:test');
const root=testPaths.APP_ROOT,temp=fs.mkdtempSync(path.join(os.tmpdir(),'slide-notes-tree-'));
const panels=fs.readFileSync(root+'/static/panels.js','utf8');
const treeFunctions=panels.slice(panels.indexOf('function panelSearch('),panels.indexOf('async function previewFile('));
const fixture=`
const $=(q,root=document)=>root.querySelector(q),uiIcon=()=>'<svg></svg>',escapeHTML=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const managedWorkbench=false,state={panel:'files',path:'notebooks/root.json'},editorTabs={active:'notebooks/root.json'};
const explorer={mode:'notes',query:'',expanded:new Set(['']),directories:new Map(),serial:0,notesDirectory:'notebooks',workspace:'Fixture'};
const panelIcons={folder:'',notebook:'',file:'',search:''};
const notebookSessions=new Map(),notebookHistories=new Map();
let opened=[],previews=[],errors=[],pendingAPI=null,bubbledTreeKeys=0;
document.addEventListener('keydown',event=>{if(event.target.closest('#file-tree'))bubbledTreeKeys++;});
const installWorkspacePanelControls=()=>{},save=async()=>{},toast=message=>errors.push(message);
const moveAIChatFiles=async()=>{},remapAIChats=()=>{},remapEditorTabs=async()=>{};
const remapNotebookSidebar=()=>{};
const entries={
 '':[{kind:'directory',path:'notebooks/alpha',name:'alpha'},{kind:'directory',path:'notebooks/beta',name:'beta'},{kind:'notebook',path:'notebooks/root.json',name:'root.json',title:'Root',slides:1},{kind:'file',path:'notebooks/no-access',name:'no-access',unavailable:true}],
 'notebooks/alpha':[{kind:'directory',path:'notebooks/alpha/nested',name:'nested'},{kind:'notebook',path:'notebooks/alpha/a.json',name:'a.json',title:'A note',slides:2}],
 'notebooks/alpha/nested':[{kind:'notebook',path:'notebooks/alpha/nested/deep.json',name:'deep.json',title:'Deep note',slides:1}],
 'notebooks/beta':[]
};
const api=async url=>{if(pendingAPI)return pendingAPI(url);const u=new URL(url,'http://fixture');if(u.pathname==='/api/search')return {entries:entries['notebooks/alpha'].filter(e=>e.kind==='notebook')};return {notesDirectory:'notebooks',entries:structuredClone(entries[u.searchParams.get('path')||'']||[])};};
const previewFile=async path=>previews.push(path);
const openNotebook=async path=>{opened.push(path);editorTabs.active=path;await revealActiveFile({automatic:true});};
`;
const scenarios=`
(async()=>{
 const results=[];const assert=(ok,message)=>{if(!ok)throw Error(message||'assertion failed');};
 async function check(name,fn){try{await fn();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.stack});}}
 const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
 async function key(value,options={}){document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true,...options}));await settle();}
 const row=path=>fileTreeRows().find(e=>e.dataset.path===path),focused=()=>document.activeElement.dataset.path;
 const alpha='notebooks/alpha',nested=alpha+'/nested',deep=nested+'/deep.json';
 renderFiles($('#inspector-content'));await refreshFileRows();
 await check('tree roles, sibling counts, single tab stop and current editor',()=>{
  assert($('#file-tree').getAttribute('role')==='tree');assert(row(alpha).getAttribute('aria-level')==='1');
  assert(row(alpha).getAttribute('aria-setsize')==='4');assert(fileTreeRows().filter(r=>r.tabIndex===0).length===1);
  assert(row('notebooks/root.json').getAttribute('aria-current')==='page');assert(!fileTreeRows().some(e=>e.disabled));
 });
 await check('arrows navigate without opening notes or moving editor',async()=>{
  row(alpha).focus();await key('ArrowDown');assert(focused()==='notebooks/beta');
  await key('End');assert(focused()==='notebooks/root.json');await key('Home');assert(focused()===alpha);
  assert(opened.length===0&&editorTabs.active==='notebooks/root.json');
  assert(bubbledTreeKeys===0,'tree keys reached notebook shortcuts');
 });
 await check('right expands lazily, enters child; left collapses and returns to parent',async()=>{
  await key('ArrowRight');assert(explorer.expanded.has(alpha));assert(focused()===alpha);
  assert(row(alpha).getAttribute('aria-expanded')==='true');await key('ArrowRight');assert(focused()===nested);
  assert(row(nested).getAttribute('aria-level')==='2');await key('ArrowLeft');assert(focused()===alpha);
  await key('ArrowLeft');assert(!row(nested));assert(row(alpha).getAttribute('aria-expanded')==='false');
 });
 await check('typing focuses label; Enter opens exactly that notebook',async()=>{
  await key('r');assert(focused()==='notebooks/root.json');
  editorTabs.active=null;state.path=null;await key('Enter');assert(opened.at(-1)==='notebooks/root.json','Enter did not open root');assert(opened.length===1,'duplicate open');
 });
 await check('automatic reveal expands ancestors without stealing search focus',async()=>{
  $('#file-search').focus();editorTabs.active=deep;await revealActiveFile({automatic:true});
  assert(explorer.expanded.has(alpha)&&explorer.expanded.has(nested)&&row(deep));assert(document.activeElement===$('#file-search'));
  assert(row(deep).getAttribute('aria-current')==='page');
 });
 await check('polling refresh preserves tree focus, selection, scroll and tab stop',async()=>{
  row(deep).focus();$('#inspector-content').scrollTop=37;const scroll=$('#inspector-content').scrollTop;
  await refreshExplorer();assert(focused()===deep,'focus after refresh: '+focused());assert(row(deep).getAttribute('aria-selected')==='true','selection after refresh');
  assert($('#inspector-content').scrollTop===scroll,'scroll after refresh: '+$('#inspector-content').scrollTop+' / '+scroll);assert(fileTreeRows().filter(r=>r.tabIndex===0).length===1,'tab stop after refresh');
 });
 await check('unchanged polling keeps every row and performs zero DOM mutations',async()=>{
  const before=fileTreeRows(),mutations=[];
  const observer=new MutationObserver(records=>mutations.push(...records));
  observer.observe($('#file-tree'),{childList:true,subtree:true,attributes:true,characterData:true});
  await refreshExplorer();await settle();observer.disconnect();
  assert(fileTreeRows().every((item,index)=>item===before[index]),'row identity was replaced');
  assert(mutations.length===0,'unchanged refresh mutated '+mutations.map(m=>m.type+':'+m.attributeName).join(','));
 });
 await check('temporary refresh failures keep the previous tree usable',async()=>{
  const original=row(deep);pendingAPI=async()=>{throw Error('temporary refresh failure');};
  await refreshExplorer();pendingAPI=null;
  assert(row(deep)===original&&original.isConnected,'background error destroyed the existing tree');
  assert($('#file-tree .file-tree-notice').textContent==='temporary refresh failure');
  await refreshExplorer();assert(!$('#file-tree .file-tree-notice'),'successful retry kept the error');
 });
 await check('insertions, removals and metadata changes retain unaffected row nodes',async()=>{
  const original=row('notebooks/root.json'),other=row(alpha),oldTitle=entries[''][2].title;
  entries[''][2].title='Updated title';entries[''][2].slides=9;
  entries[''].splice(2,0,{kind:'file',path:'notebooks/imported.txt',name:'imported.txt'});
  await refreshExplorer();
  assert(row('notebooks/root.json')===original&&row(alpha)===other,'existing row replaced on insertion');
  assert(original.dataset.label==='Updated title'&&original.querySelector('.file-count').textContent==='9');
  entries[''].splice(2,1);entries[''][2].title=oldTitle;entries[''][2].slides=1;await refreshExplorer();
  assert(!row('notebooks/imported.txt')&&row('notebooks/root.json')===original,'existing row replaced on removal');
 });
 await check('simultaneous directory loads share a single in-flight request',async()=>{
  let release,calls=0;pendingAPI=()=>{calls++;return new Promise(resolve=>release=resolve);};resetFileDirectoryCache();
  const tasks=[loadDirectory(''),loadDirectory(''),loadDirectory('')];
  assert(calls===1,'duplicate directory requests: '+calls);pendingAPI=null;
  release({notesDirectory:'notebooks',entries:structuredClone(entries[''])});await Promise.all(tasks);
 });
 await check('visible sibling directories load concurrently',async()=>{
  const expanded=explorer.expanded;explorer.expanded=new Set(['',alpha,'notebooks/beta']);resetFileDirectoryCache();
  const releases=new Map();pendingAPI=url=>{
   const path=new URL(url,'http://fixture').searchParams.get('path')||'';
   if(!path)return Promise.resolve({notesDirectory:'notebooks',entries:structuredClone(entries[''])});
   return new Promise(resolve=>releases.set(path,resolve));
  };
  const task=refreshFileRows();await settle();
  const concurrent=releases.has(alpha)&&releases.has('notebooks/beta');pendingAPI=null;
  for(const [path,release] of releases)release({notesDirectory:'notebooks',entries:structuredClone(entries[path])});
  await task;explorer.expanded=expanded;assert(concurrent,'sibling directory requests were serialized');
  await refreshExplorer();
 });
 await check('async refresh does not steal focus moved to an editor while loading',async()=>{
  let release;pendingAPI=()=>new Promise(resolve=>release=resolve);resetFileDirectoryCache();
  const task=refreshFileRows();$('#external-editor').focus();pendingAPI=null;
  release({notesDirectory:'notebooks',entries:structuredClone(entries[''])});await task;
  assert(document.activeElement===$('#external-editor'));
 });
 await check('collapse all stays collapsed across periodic refresh',async()=>{
  await collapseFileTree();await refreshExplorer();assert(!row(deep)&&!row(nested));assert(explorer.expanded.size===1);
 });
 await check('disabling auto reveal leaves collapsed tree until manual reveal',async()=>{
  $('#auto-reveal-file').click();await settle();assert(!fileTreeState.autoReveal);
  await revealActiveFile({automatic:true});assert(!row(deep));await revealActiveFile();assert(focused()===deep);
 });
 await check('manual reveal clears search; automatic reveal preserves it',async()=>{
  explorer.query='A';$('#file-search').value='A';await refreshFileRows();assert(row(alpha+'/a.json'));
  await revealActiveFile({automatic:true});assert(explorer.query==='A');await revealActiveFile();
  assert(explorer.query===''&&$('#file-search').value===''&&focused()===deep);
 });
 await check('mode switch rejects stale directory responses',async()=>{
  let release;pendingAPI=()=>new Promise(resolve=>release=resolve);resetFileDirectoryCache();const task=refreshFileRows();
  explorer.mode='all';resetFileDirectoryCache();pendingAPI=null;
  release({notesDirectory:'notebooks',entries:[{kind:'file',path:'wrong-view',name:'wrong-view'}]});await task;
  await refreshFileRows();assert(!fileTreeRows().some(r=>r.dataset.path==='wrong-view'));explorer.mode='notes';
 });
 await check('file move remaps logical focus and selection',async()=>{
  await revealActiveFile();const original=row(deep);await remapFileState(alpha,'notebooks/renamed');
  assert(fileTreeState.focusPath==='notebooks/renamed/nested/deep.json');assert(fileTreeState.selectedPath===fileTreeState.focusPath);
  assert(row('notebooks/renamed/nested/deep.json')===original,'move replaced visible DOM');
  assert(original.fileEntry.path==='notebooks/renamed/nested/deep.json','handlers kept the old path');
 });
 await check('notes view never expands an active file outside its root',async()=>{
  editorTabs.active='outside/picture.png';explorer.expanded=new Set(['']);await revealActiveFile({automatic:true});
  assert(!explorer.expanded.has('outside'));await revealActiveFile();assert(errors.at(-1).includes('仅笔记'));
 });
 await check('empty tree is keyboard reachable and refresh errors remain visible',async()=>{
  pendingAPI=async()=>({notesDirectory:'notebooks',entries:[]});resetFileDirectoryCache();await refreshFileRows();
  assert($('#file-tree').tabIndex===0);pendingAPI=async()=>{throw Error('fixture failure');};resetFileDirectoryCache();await refreshFileRows();
  assert($('#file-tree').textContent==='fixture failure');pendingAPI=null;
 });
 $('#result').textContent=JSON.stringify(results);
})().catch(error=>$('#result').textContent=JSON.stringify([{ok:false,error:error.stack}]));
`;
test('file explorer keyboard, focus, reveal and async refresh in Chrome',t=>{
 try{
  const page=path.join(temp,'test.html');
  const css=fs.readFileSync(root+'/static/panels.css','utf8')+fs.readFileSync(root+'/static/file-actions.css','utf8');
  fs.writeFileSync(page,'<!doctype html><meta charset="utf-8"><style>'+css+'#inspector-content{height:100px;overflow:auto;width:260px}</style><div id="inspector-content"></div><input id="external-editor"><dialog id="new-notebook"><input></dialog><pre id="result"></pre><script>'+fixture+'</script><script>'+fs.readFileSync(root+'/static/file-actions.js','utf8')+'</script><script>'+fs.readFileSync(root+'/static/file-transfer.js','utf8')+'</script><script>'+fs.readFileSync(root+'/static/file-tree.js','utf8')+'</script><script>'+treeFunctions+'</script><script>'+scenarios+'</script>');
  const result=spawnSync(process.env.CHROME_BIN||'google-chrome',['--headless','--no-sandbox','--disable-gpu','--no-first-run','--user-data-dir='+path.join(temp,'profile'),'--allow-file-access-from-files','--virtual-time-budget=3000','--dump-dom','file://'+page],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
  if(result.error?.code==='ENOENT'){t.skip('Chrome unavailable; set CHROME_BIN');return;}
  assert.equal(result.status,0,result.stderr);
  const match=result.stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/);assert.ok(match,'browser did not report results');
  const results=JSON.parse(match[1].replaceAll('&quot;','"').replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&'));
  assert.deepEqual(results.filter(r=>!r.ok),[]);assert.equal(results.length,19);console.log('Verified '+results.length+' file explorer browser scenarios.');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
