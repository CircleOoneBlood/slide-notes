const testPaths = require('./paths.cjs');
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {test}=require('node:test');
const source=fs.readFileSync(testPaths.STATIC_ROOT+'/ai.js','utf8');
function storage(){
 const values={};
 Object.defineProperties(values,{
  getItem:{value:key=>values[key]??null},
  setItem:{value:(key,value)=>{values[key]=String(value);}},
  removeItem:{value:key=>{delete values[key];}},
 });return values;
}
class Element{
 constructor(tag='div'){this.tag=tag;this.style={};this.children=[];this.dataset={};this.attributes={};this.className='';this.classes=new Set();this.classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name),contains:name=>this.classes.has(name),toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};}
 append(...children){this.children.push(...children);for(const child of children)child.parentElement=this;}
 insertBefore(child,before){const index=this.children.indexOf(before);if(index<0)this.append(child);else{this.children.splice(index,0,child);child.parentElement=this;}}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(item=>item!==this);}
 replaceChildren(...children){this.children=[];this.append(...children);}
 setAttribute(name,value){this.attributes[name]=String(value);}
 getAttribute(name){return this.attributes[name]??null;}
 hasAttribute(name){return name in this.attributes;}
 querySelectorAll(selector){const children=this.children.flatMap(child=>[child,...child.querySelectorAll('*')]);return selector==='*'?children:children.filter(child=>selector.startsWith('.')?child.className.split(' ').includes(selector.slice(1)):child.tag===selector);}
 querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
 addEventListener(){}focus(){}blur(){}scrollIntoView(){}
}
function environment(localStorage=storage()){
 const root=new Element(),updates=[],notices=[];
 const context=vm.createContext({URL,URLSearchParams,AbortController,crypto:webcrypto,localStorage,location:{href:'http://localhost/?workspace=workspace-one'},state:{doc:{},path:'notebooks/note.json',panel:'ai',mode:'edit',revision:'rev'},document:{body:new Element(),getElementById(id){return [this.body,...this.body.querySelectorAll('*')].find(item=>item.id===id)||null;},activeElement:null,createElement:tag=>new Element(tag),addEventListener(){},querySelectorAll(selector){if(selector==='[data-ai-session]')return [...root.children,...this.body.querySelectorAll('*').filter(item=>item.dataset.aiSession)];if(selector==='[data-ai-window]')return this.body.querySelectorAll('*').filter(item=>item.dataset.aiWindow);return [];}},$: (selector,parent)=>parent?.querySelector(selector),uiIcon:name=>name,cellNumber:id=>id,toast:message=>notices.push(message),console,updates,setTimeout,clearTimeout});
 vm.runInContext(fs.readFileSync(testPaths.STATIC_ROOT+'/ai-interface.js','utf8'),context);
 vm.runInContext(source,context);
 vm.runInContext(fs.readFileSync(testPaths.STATIC_ROOT+'/ai-branches.js','utf8'),context);
 vm.runInContext("refreshAI=(session,container)=>updates.push(session.key);loadAIConfig=()=>new Promise(()=>{});const originalLoadAIScope=loadAIScope;loadAIScope=(...args)=>{const scope=originalLoadAIScope(...args);scope.ready=true;return scope;};queueAIScopeSave=()=>{};",context);
 return {context,localStorage,root,notices,run:code=>vm.runInContext(code,context)};
}
test('migrates old chats without losing messages, drafts or selected cells',()=>{
 const store=storage(),legacy='slide-notes-ai-v1:'+JSON.stringify(['workspace-one','notebooks/note.json','notebook']);
 store.setItem(legacy,JSON.stringify({messages:[{role:'user',content:'旧消息'},{role:'assistant',content:'未完成',status:'streaming'}],draft:'旧草稿',selectedCells:['one','two']}));
 const env=environment(store),session=env.run('currentAISession()');
 assert.equal(session.messages[0].content,'旧消息');assert.equal(session.messages[1].status,'cancelled');assert.equal(session.draft,'旧草稿');assert.deepEqual([...session.selectedCells],['one','two']);
 assert(store.getItem(legacy));assert(store.getItem(session.scopeKey));
});
test('creates multiple isolated global/cell chats and restores active chat after reload',()=>{
 const env=environment(),container=new Element();env.context.container=container;
 const first=env.run("const first=currentAISession();first.title='原对话';first.customTitle=true;first.draft='待发送';first.messages.push({role:'user',content:'原消息'});persistAI(first);first");
 env.run('newAIConversation(first,container)');const second=env.run('currentAISession()');assert.notEqual(first.key,second.key);assert.equal(first.messages.length,1);assert.equal(first.draft,'待发送');assert.equal(second.messages.length,0);
 env.run("const cellChat=currentAISession('one');cellChat.title='Cell 专题';persistAI(cellChat);newAIConversation(cellChat,container)");
 assert.equal(env.run("loadAIScope(state.path,'one').conversations.length"),2);assert.equal(env.run("loadAIScope(state.path,'two').conversations.length"),1);assert.equal(env.run('currentAISession().key'),second.key);
 const restored=environment(env.localStorage);assert.equal(restored.run('currentAISession().id'),second.id);assert.equal(restored.run('loadAIScope(state.path).conversations[0].title'),'原对话');assert.equal(restored.run('loadAIScope(state.path).conversations[0].draft'),'待发送');assert.equal(restored.run("loadAIScope(state.path,'one').conversations.length"),2);
 restored.context.container=container;restored.context.firstId=first.id;restored.run('activateAIConversation(loadAIScope(state.path),firstId,container)');assert.equal(restored.run('currentAISession().title'),'原对话');
 const otherWorkspace=environment(env.localStorage);otherWorkspace.context.location.href='http://localhost/?workspace=workspace-two';assert.equal(otherWorkspace.run('currentAISession().messages.length'),0);
});
test('header has editable name and settings/new/history/close in order',()=>{
 const env=environment(),container=new Element();env.context.container=container;
 env.run('renderAI(container)');const tools=container.querySelector('.ai-tools'),title=tools.querySelector('input'),actions=tools.querySelector('.ai-header-actions');
 assert.deepEqual(actions.children.map(button=>button.attributes['aria-label']),['收藏对话','对话历史','新对话','AI 设置','关闭对话']);
 title.value='数学推导';title.oninput();title.onblur();assert.equal(env.run('currentAISession().title'),'数学推导');assert.equal(env.run('currentAISession().customTitle'),true);
 actions.children[2].onclick();assert.equal(env.run('loadAIScope(state.path).conversations.length'),2);
 const newActions=container.querySelector('.ai-header-actions');newActions.children[1].onclick();const rows=container.querySelectorAll('.ai-history-item');assert.equal(rows.length,2);
 rows.find(row=>row.children[0].textContent==='数学推导').onclick();assert.equal(env.run('currentAISession().title'),'数学推导');
});
test('moving a notebook preserves all conversations and active selections',()=>{
 const env=environment(),container=new Element();env.context.container=container;
 env.run("const first=currentAISession();first.messages.push({role:'assistant',content:'回复',path:state.path});persistAI(first);newAIConversation(first,container);const cell=currentAISession('one');newAIConversation(cell,container);aiState.expanded.add(aiKey(state.path,'one'))");
 const active=env.run('currentAISession().id');env.run("state.path='notebooks/moved.json';remapAIChats(path=>path==='notebooks/note.json'?state.path:path)");
 assert.equal(env.run('currentAISession().id'),active);assert.equal(env.run('loadAIScope(state.path).conversations.length'),2);assert.equal(env.run("loadAIScope(state.path,'one').conversations.length"),2);assert.equal(env.run('loadAIScope(state.path).conversations[0].messages[0].path'),'notebooks/moved.json');assert(env.run("aiState.expanded.has(aiKey(state.path,'one'))"));
 const restored=environment(env.localStorage);restored.context.state.path='notebooks/moved.json';assert.equal(restored.run('currentAISession().id'),active);assert.equal(restored.run("loadAIScope(state.path,'one').conversations.length"),2);
});
test('reply in a previous conversation cannot overwrite the new active chat',async()=>{
 const env=environment(),container=new Element();env.context.container=container;env.context.pending=[];env.context.save=async()=>{};
 env.run("aiState.config={model:'mock'};aiStream=(route,body,request,onEvent)=>new Promise(resolve=>pending.push({body,onEvent,resolve}));const first=currentAISession();const response=sendAI(first,'第一个问题','chat')");
 await new Promise(resolve=>setImmediate(resolve));assert.equal(env.context.pending.length,1);
 env.run('newAIConversation(first,container)');const active=env.run('currentAISession()');env.context.pending[0].onEvent({type:'done',text:'只属于第一个对话的回复'});env.context.pending[0].resolve();await env.run('response');
 assert.equal(env.run('currentAISession().key'),active.key);assert.equal(active.messages.length,0);assert.equal(env.run('first.messages.at(-1).content'),'只属于第一个对话的回复');assert.equal(env.context.pending[0].body.messages.length,0);
});
test('loads workspace history in a fresh browser without adding an empty conversation',async()=>{
 const env=environment();env.context.remote={active:'diskchat',conversations:[{id:'diskchat',title:'工作区历史',customTitle:true,createdAt:1,updatedAt:2,messages:[{role:'user',content:'磁盘消息'}],draft:'磁盘草稿',selectedCells:['one']}]};env.context.api=async()=>({data:env.context.remote,revision:'diskrevision',file:'sessions/note/global.json'});
 await env.run('const scope=loadAIScope(state.path);scope.ready=false;hydrateAIScope(scope)');
 assert.equal(env.run('currentAISession().title'),'工作区历史');assert.equal(env.run('currentAISession().draft'),'磁盘草稿');assert.equal(env.run('loadAIScope(state.path).conversations.length'),1);assert.equal(env.run('loadAIScope(state.path).revision'),'diskrevision');
});
test('merges browser-only conversations into workspace history',async()=>{
 const env=environment();env.run("const local=currentAISession();local.title='浏览器旧历史';local.draft='未发出的草稿';persistAI(local);const scope=loadAIScope(state.path);scope.hasLocal=true;scope.ready=false");
 env.context.api=async()=>({data:{active:'remote',conversations:[{id:'remote',title:'其他浏览器的历史',createdAt:1,updatedAt:2,messages:[],draft:'',selectedCells:[]}]},revision:'r1',file:'sessions/note/global.json'});
 await env.run('hydrateAIScope(scope)');assert.equal(env.run('scope.conversations.length'),2);assert.equal(env.run('currentAISession().draft'),'未发出的草稿');
});
test('serializes file saves using the latest revision and retains browser backup on conflict',async()=>{
 const env=environment();env.context.requests=[];env.context.queueCalls=[];env.context.api=(route,body)=>new Promise((resolve,reject)=>env.context.requests.push({route,body:structuredClone(body),resolve,reject}));
 env.run("queueAIScopeSave=scope=>queueCalls.push(scope.version);const session=currentAISession();const scope=loadAIScope(state.path);scope.revision='r1';session.title='第一版';persistAI(session);const saving=flushAIScope(scope);session.title='第二版';persistAI(session)");
 assert.equal(env.context.requests[0].body.revision,'r1');assert.equal(env.context.requests[0].body.data.conversations[0].title,'第一版');env.context.requests[0].resolve({revision:'r2',file:'sessions/note/global.json'});await env.run('saving');assert(env.context.queueCalls.length>0);
 env.run('const secondSave=flushAIScope(scope)');assert.equal(env.context.requests[1].body.revision,'r2');assert.equal(env.context.requests[1].body.data.conversations[0].title,'第二版');env.context.requests[1].reject(Error('修改冲突'));await env.run('secondSave');assert.equal(env.run('scope.saveError'),'修改冲突');assert(env.notices.some(message=>message.includes('浏览器备份')));assert(env.localStorage.getItem(env.run('scope.key')).includes('第二版'));
});

test('pasted images stay with their original conversation while uploading and survive reload',async()=>{
 const env=environment();let finish;env.context.api=()=>new Promise(resolve=>{finish=resolve;});env.run("readAIImage=async()=> 'data:image/png;base64,AAAA';const original=currentAISession();");
 const image={name:'截图.png',type:'image/png',size:100};env.context.event={clipboardData:{items:[{kind:'file',type:image.type,getAsFile:()=>image}]},preventDefault(){this.prevented=true;}};
 const pending=env.run('pasteAIImages(original,event)');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(env.run('original.imageUploads'),1);assert.equal(env.context.event.prevented,true);
 env.run("const scope=loadAIScope(state.path);const other=makeAISession(scope,{title:'另一个'});scope.conversations.push(other);scope.active=other.id;");
 finish({id:'a'.repeat(64)+'.png',name:image.name});await pending;
 assert.equal(env.run('original.images.length'),1);assert.equal(env.run('currentAISession().images.length'),0);assert.equal(env.run('original.imageUploads'),0);
 const restored=environment(env.localStorage);assert.equal(restored.run('loadAIScope(state.path).conversations[0].images[0].name'),image.name);
});
test('text paste remains native and failed image uploads preserve the draft',async()=>{
 const env=environment();env.run("const session=currentAISession();session.draft='保留文字';readAIImage=async()=> 'data:image/png;base64,AAAA';");
 let prevented=false;env.context.event={clipboardData:{items:[],files:[]},preventDefault(){prevented=true;}};
 await env.run('pasteAIImages(session,event)');assert.equal(prevented,false);
 env.context.api=async()=>{throw Error('保存失败');};env.context.event.clipboardData.items=[{kind:'file',type:'image/png',getAsFile:()=>({size:100,type:'image/png'})}];
 await env.run('pasteAIImages(session,event)');assert.equal(env.run('session.draft'),'保留文字');assert.equal(env.run('session.images.length'),0);assert.equal(env.run('session.imageUploads'),0);assert.match(env.notices[0],/保存失败/);
});
test('image-only send includes current images and multimodal conversation history',async()=>{
 const env=environment();env.context.save=async()=>{};env.context.sent=[];
 env.run("aiState.config={model:'fake'};aiStream=async(route,body,request,callback)=>{sent.push(body);callback({type:'done',text:'收到图片'});};const session=currentAISession();session.images=[{id:'a'.repeat(64)+'.png',name:'图片'}];session.messages=[{role:'user',content:'旧图',images:[{id:'b'.repeat(64)+'.png',name:'旧图'}]}];");
 await env.run("sendAI(session,'','chat')");const body=env.context.sent[0];assert.equal(body.prompt,'');assert.equal(body.images.length,1);assert.equal(body.messages[0].images.length,1);assert.equal(env.run('session.images.length'),0);assert.equal(env.run('session.messages[1].images.length'),1);
});

test('cell floating window minimizes, restores, maximizes and closes without losing draft',()=>{
 const env=environment();env.context.allCells=()=>[{id:'one'}];
 const card=new Element();card.id='cell-one';const trigger=new Element('button');trigger.className='cell-ai';card.append(trigger);env.context.document.body.append(card);
 env.run("openCellAI('one');const chat=currentAISession('one');chat.draft='保留草稿';persistAI(chat);");
 const dock=env.context.document.getElementById('ai-cell-dock'),window=dock.children[0];assert.equal(window.parentElement,dock);assert.equal(trigger.attributes['aria-expanded'],'true');
 env.run("toggleAICellWindow('one','minimized')");assert(window.classes.has('minimized'));assert.equal(window.querySelector('.ai-chat-title').readOnly,true);
 window.querySelector('.ai-chat-title').onclick();assert.equal(window.classes.has('minimized'),false);
 env.run("toggleAICellWindow('one','maximized')");assert(window.classes.has('maximized'));
 env.run("toggleAICellWindow('one','minimized')");assert.equal(window.classes.has('maximized'),false);
 env.run("closeCellAI('one')");assert.equal(window.hidden,true);assert.equal(trigger.attributes['aria-expanded'],'false');assert.equal(env.run("currentAISession('one').draft"),'保留草稿');
 env.run("openCellAI('one')");assert.equal(window.hidden,false);assert.equal(window.classes.has('minimized'),false);assert.equal(dock.children.length,1);
 env.run("state.path='notebooks/other.json';syncAICellWindows()");assert.equal(window.hidden,false);
});

test('workspace sidebar follows active file without replacing conversation or draft',()=>{
 const env=environment(),container=new Element();env.context.container=container;
 env.run('renderAI(container)');const original=container.dataset.aiSession;const session=env.run('aiState.sessions.get(aiState.sidebarKey)');session.draft='原稿';
 env.run("state.path='notebooks/other.json';renderAI(container)");assert.equal(container.dataset.aiSession,original);assert.equal(env.run('aiState.sessions.get(aiState.sidebarKey).draft'),'原稿');
 assert.equal(session.path,'notebooks/other.json');env.run("aiState.sidebarKey=null;renderAI(container)");assert.equal(container.dataset.aiSession,original);
});
test('cross-document send preserves original notebook scope and selected PDF sources',async()=>{
 const env=environment();env.context.save=async()=>{};env.context.sent=[];env.context.api=async()=>({revision:'original-revision'});
 env.run("aiState.config={model:'fake'};aiStream=async(route,body,request,callback)=>{sent.push(body);callback({type:'done',text:'收到选区'});};const session=currentAISession('one');session.sources=[{path:'sample.pdf',page:2,text:'能量 42',rects:[[1,2,30,40]],fingerprint:'abc'}];state.path='notebooks/other.json';");
 await env.run("sendAI(session,'','chat')");const body=env.context.sent[0];assert.equal(body.path,'notebooks/note.json');assert.equal(body.revision,'original-revision');assert.deepEqual([...body.cells],['one']);assert.equal(body.sources[0].path,'sample.pdf');assert.equal(env.run('session.sources.length'),0);assert.equal(env.run('session.messages[0].sources[0].text'),'能量 42');
});
test('PDF send waits for page snapshot and failure retains unsent draft',async()=>{
 const env=environment();env.context.save=async()=>{};env.run("state.path=null;editorTabs={active:'paper.pdf',items:[{kind:'pdf',path:'paper.pdf'}]};aiState.config={model:'fake'};const session=currentAISession();session.draft='解释当前内容';let captured=false;collectAIPDFContext=async(session,sources)=>{await Promise.resolve();sources.push({path:session.path,kind:'pdf-page',page:2,text:'PAGE TWO'});captured=true;};aiStream=async(route,body,request,callback)=>{if(!captured)throw Error('sent before capture');sent.push(body);callback({type:'done',text:'ok'});};");
 env.context.sent=[];await env.run("sendAI(session,session.draft,'chat')");assert.equal(env.context.sent[0].sources[0].text,'PAGE TWO');assert.equal(env.run('session.messages[0].sources[0].kind'),'pdf-page');
 env.run("session.messages=[];session.draft='keep';collectAIPDFContext=async()=>{throw Error('PDF 还在加载');};");env.context.sent=[];await env.run("sendAI(session,session.draft,'chat')");assert.equal(env.context.sent.length,0);assert.equal(env.run('session.draft'),'keep');assert.equal(env.run('session.messages.length'),0);assert.equal(env.run('session.busy'),false);
});
function captureEnvironment(){
 const env=environment();const query=env.context.document.querySelectorAll;env.context.document.querySelectorAll=selector=>selector==='.ai-attachment-menu'?env.root.querySelectorAll(selector):query(selector);env.context.window={addEventListener(){}};env.context.MutationObserver=env.context.ResizeObserver=class{observe(){}};
 vm.runInContext(fs.readFileSync(testPaths.STATIC_ROOT+'/ai-capture.js','utf8'),env.context);return env;
}
test('+ directly selects cells without a menu or changing conversation',()=>{
 const env=captureEnvironment(),container=new Element();env.root.append(container);env.context.container=container;env.run('renderAI(container)');
 container.querySelector('.ai-add-cells').onclick();assert.equal(container.querySelector('.ai-attachment-menu'),null);
 const key=env.run('aiState.sidebarKey');assert.equal(env.run('aiState.picking'),key);
 container.querySelector('.ai-add-cells').onclick();assert.equal(env.run('aiState.picking'),null);
 env.run("state.path='notebooks/other.json';renderAI(container)");container.querySelector('.ai-add-cells').onclick();assert.equal(env.run('aiState.picking'),key);assert.equal(env.run('aiState.sidebarKey'),key);
});
test('legacy screenshot backlink tracks document scroll and clips at the document pane',()=>{
 const env=captureEnvironment();let top=200;const data={id:'one',source:'original'},anchor={getBoundingClientRect:()=>({left:100,top,width:500,height:400})},pane={getBoundingClientRect:()=>({left:50,top:40,right:900,bottom:700})},box={style:{}};
 env.context.box=box;env.context.data=data;env.context.document.getElementById=id=>id==='notebook-editor'?{hidden:false}:id==='main'?pane:id==='cell-one'?anchor:null;env.context.slide=()=>({id:'page1'});env.context.state.doc={slides:[{id:'page1',cells:[data]}]};
 env.run("aiCaptureMark={box,source:{path:state.path,slide:'page1',cell:'one',rects:[[.1,.1,.6,.4]],fingerprint:captureFingerprint(data)}};paintAINotebookCapture()");assert.equal(box.style.top,'240px');assert.equal(box.style.left,'150px');
 top-=70;env.run('paintAINotebookCapture()');assert.equal(box.style.top,'170px');assert.equal(box.style.width,'250px');
 top=-100;env.run('paintAINotebookCapture()');assert.equal(box.style.top,'40px');assert.equal(box.style.height,'20px');
 data.source='changed';env.run('paintAINotebookCapture()');assert.equal(box.hidden,true);
});
test('legacy image backlink projects original pixels through zoom and pan',()=>{
 const env=captureEnvironment();let bounds={left:100,top:100,width:500,height:400};
 const view={imageFingerprint:'same',imageElement:{naturalWidth:1000,getBoundingClientRect:()=>bounds},imageStage:{clientWidth:900,clientHeight:700,getBoundingClientRect:()=>({left:0,top:0})}};
 env.context.editorTabs={active:'diagram.png',items:[{kind:'image',path:'diagram.png',view}]};env.context.mark={box:{style:{}},source:{kind:'image-region',path:'diagram.png',width:1000,height:800,rects:[[100,100,400,300]],fingerprint:'same'}};
 env.run('paintAIImageCapture(mark)');assert.equal(env.context.mark.box.style.left,'150px');assert.equal(env.context.mark.box.style.width,'150px');
 bounds={left:100,top:100,width:1000,height:800};env.run('paintAIImageCapture(mark)');assert.equal(env.context.mark.box.style.left,'200px');assert.equal(env.context.mark.box.style.width,'300px');
 bounds.left=30;bounds.top=20;env.run('paintAIImageCapture(mark)');assert.equal(env.context.mark.box.style.left,'130px');assert.equal(env.context.mark.box.style.top,'120px');
 view.imageFingerprint='changed';env.run('paintAIImageCapture(mark)');assert.equal(env.context.mark.box.hidden,true);
});
test('an image owns a conversation and directs selection to manual paste',()=>{
 const env=captureEnvironment();env.context.state.path=null;env.context.editorTabs={active:'diagram.png',items:[{kind:'image',path:'diagram.png'}]};
 assert.equal(env.run('currentAIDocumentPath()'),'diagram.png');assert.equal(env.run('currentAISession().path'),'diagram.png');assert.equal(env.run('aiCommands(currentAISession()).some(command=>command.mode==="suggest")'),false);
 const container=new Element();env.root.append(container);env.context.container=container;env.run('renderAI(container)');container.querySelector('.ai-add-cells').onclick();assert.equal(container.querySelector('.ai-attachment-menu'),null);assert(env.notices.at(-1).includes('粘贴'));assert.equal(env.run('aiState.picking'),null);
});

function changesEnvironment(){
 const env=environment();env.context.structuredClone=structuredClone;
 vm.runInContext(fs.readFileSync(testPaths.STATIC_ROOT+'/ai-changes.js','utf8'),env.context);
 env.run("state.doc={title:'Note',slides:[{id:'page',name:'Page',cells:[{id:'one',kind:'code',source:'x = 1',display:'normal'},{id:'two',kind:'markdown',source:'Other',display:'normal'}]}]};state.revision='rev1';const chat=currentAISession();ensureAIChangeBaseline(chat);");return env;
}
test('change baselines are per conversation, persistent, scoped and preserve removals',()=>{
 const env=changesEnvironment();env.run("state.doc.slides[0].cells[0].source='x = 2';const other=makeAISession(loadAIScope(state.path));ensureAIChangeBaseline(other)");
 assert.equal(env.run('aiLocalChanges(chat,aiSnapshot(state.doc,state.revision,aiScope(chat))).length'),1);
 assert.equal(env.run('aiLocalChanges(other,aiSnapshot(state.doc,state.revision,aiScope(other))).length'),0);
 env.run("chat.selectedCells=['two']");assert.equal(env.run('aiLocalChanges(chat,aiSnapshot(state.doc,state.revision,aiScope(chat))).length'),0);
 env.run("chat.selectedCells=['one'];state.doc.slides[0].cells.shift()");assert.equal(env.run('aiLocalChanges(chat,aiSnapshot(state.doc,state.revision,aiScope(chat)))[0].kind'),'deleted');
 env.run('persistAI(chat)');const restored=environment(env.localStorage);assert.equal(restored.run('currentAISession().changeBaseline.cells[0].source'),'x = 1');
});
test('successful send acknowledges frozen content while edits during generation remain pending',async()=>{
 const env=changesEnvironment();env.run("state.doc.slides[0].cells[0].source='x = 2';const frozen=aiSnapshot(state.doc,'rev2',aiScope(chat));state.doc.slides[0].cells[0].source='x = 3';acknowledgeAIChanges(chat,frozen)");
 assert.equal(env.run('chat.changeBaseline.cells[0].source'),'x = 2');assert.equal(env.run('aiLocalChanges(chat,aiSnapshot(state.doc,state.revision,aiScope(chat)))[0].after.source'),'x = 3');
 env.run("chat.excludedChanges=['one'];acknowledgeAIChanges(chat,aiSnapshot(state.doc,'rev3',aiScope(chat)),chat.excludedChanges)");assert.equal(env.run("chat.changeBaseline.cells.find(c=>c.id==='one').source"),'x = 2');assert.equal(env.run('chat.excludedChanges.length'),0);
});
test('agent writes advance their own chat and stay classified in other conversations',()=>{
 const env=changesEnvironment();env.run("const observer=makeAISession(loadAIScope(state.path));ensureAIChangeBaseline(observer);const before=aiSnapshot(state.doc,'rev1',{scope:'notebook'}).cells[0];const doc=structuredClone(state.doc);doc.slides[0].cells[0].source='x = 5';chat.request={changeScope:{scope:'notebook'}};recordAIAgentChanges({path:state.path,document:doc,revision:'rev2',beforeCells:[before],changedIds:['one']},chat);state.doc=doc");
 assert.equal(env.run('chat.changeBaseline.cells[0].source'),'x = 5');assert.equal(env.run('aiLocalChanges(observer,aiSnapshot(state.doc,state.revision,aiScope(observer)))[0].origin'),'agent');
 assert.equal(env.run('Object.keys(observer.changeOrigins).length'),1);
 env.run("state.doc.slides[0].cells[0].source='x = 6'");assert.equal(env.run('aiLocalChanges(observer,aiSnapshot(state.doc,state.revision,aiScope(observer)))[0].origin'),'mixed');
});
test('failed send retains baseline and retry attaches the same changes',async()=>{
 const env=changesEnvironment();env.run("state.doc.slides[0].cells[0].source='x = 2';save=async()=>{};aiState.config={model:'fake'};aiStream=async()=>{throw Error('provider failed')};");
 await env.run("sendAI(chat,'检查修改','chat')");assert.equal(env.run('chat.changeBaseline.cells[0].source'),'x = 1');assert.equal(env.run('chat.messages.at(-1).status'),'error');
 env.run("aiStream=async(route,body,request,onEvent)=>{updates.push(body);state.doc.slides[0].cells[0].source='x = 3';onEvent({type:'done',text:'OK'})}");
 await env.run("sendAI(chat,'再检查','chat')");assert.equal(env.run('chat.changeBaseline.cells[0].source'),'x = 2');assert.equal(env.run('aiLocalChanges(chat,aiSnapshot(state.doc,state.revision,aiScope(chat))).length'),1);
 assert.equal(env.context.updates.find(value=>value?.changeBaseline)?.changeBaseline.cells[0].source,'x = 1');
});

test('new chats branch with frozen history, inherited scope and baseline, and a clean transcript',()=>{
 const env=changesEnvironment();env.context.container=new Element();
 env.run("chat.title='方案 A';chat.selectedCells=['one'];chat.messages=[{role:'user',content:'使用蓝色方案'},{role:'assistant',content:'决定使用蓝色',status:'complete'},{role:'user',content:'未完成的问题'},{role:'assistant',content:'半条回复',status:'streaming'}];newAIConversation(chat,container);const fork=currentAISession()");
 assert.equal(env.run('fork.messages.length'),0);assert.equal(env.run('fork.draft'),'');assert.equal(env.run('fork.branch.parentId'),env.run('chat.id'));
 assert.equal(env.run('fork.branch.archive.length'),2);assert.equal(env.run('fork.branch.summary.includes("决定使用蓝色")'),true);assert.equal(env.run('fork.branch.summary.includes("半条回复")'),false);
 assert.equal(env.run('fork.selectedCells[0]'),'one');assert.equal(env.run('fork.changeBaseline.cells[0].source'),'x = 1');
 env.run("chat.messages[0].content='改为红色';chat.selectedCells.push('two');chat.changeBaseline.cells[0].source='x = 99';chat.messages.push({role:'assistant',content:'未来消息'});persistAI(chat)");
 assert.equal(env.run('fork.branch.archive[0].content'),'使用蓝色方案');assert.equal(env.run('fork.selectedCells.length'),1);assert.equal(env.run('fork.changeBaseline.cells[0].source'),'x = 1');
 const restored=environment(env.localStorage);assert.equal(restored.run('currentAISession().branch.archive[0].content'),'使用蓝色方案');
});
test('nested branches keep ancestors and blank chats reset inherited context',()=>{
 const env=changesEnvironment();env.context.container=new Element();
 env.run("chat.messages=[{role:'user',content:'祖先的问题'},{role:'assistant',content:'祖先决定'}];newAIConversation(chat,container);const fork=currentAISession();fork.messages=[{role:'user',content:'分支方向'},{role:'assistant',content:'分支决定'}];newAIConversation(fork,container);const child=currentAISession()");
 assert.equal(env.run('child.branch.archive.length'),4);assert.equal(env.run('child.branch.parentId'),env.run('fork.id'));
 env.run('newAIConversation(child,container,true)');assert.equal(env.run('currentAISession().branch'),null);assert.equal(env.run('currentAISession().messages.length'),0);assert.equal(env.run('currentAISession().changeBaseline.cells[0].source'),'x = 1');
});
test('branch request sends inherited digest separately from clean own history',async()=>{
 const env=changesEnvironment();env.context.container=new Element();
 env.run("chat.messages=[{role:'user',content:'父问题'},{role:'assistant',content:'父决定'}];newAIConversation(chat,container);const fork=currentAISession();save=async()=>{};aiState.config={model:'fake'};aiStream=async(route,body,request,onEvent)=>{updates.push(body);onEvent({type:'done',text:'分支回复'})}");
 await env.run("sendAI(fork,'沿这个方向继续','chat')");const payload=env.context.updates.find(item=>item?.branch);
 assert.equal(payload.messages.length,0);assert.equal(payload.branch.archive.length,2);assert(payload.branch.summary.includes('父决定'));assert.equal(env.run('fork.messages.length'),2);assert.equal(env.run('chat.messages.length'),2);
});

test('local Claude Code sends with default model and no Note API key',async()=>{
 const env=environment();env.context.save=async()=>{};env.context.sent=[];
 env.run("aiState.config={provider:'claude-code',claudeModel:'',model:'',hasKey:false};aiStream=async(route,body,request,onEvent)=>{sent.push({route,body});onEvent({type:'done',text:'本地 CC 回复'});};const ccSession=currentAISession();");
 await env.run("sendAI(ccSession,'用本地 CC 解释笔记','chat')");
 assert.equal(env.context.sent.length,1);assert.equal(env.context.sent[0].route,'/api/ai/chat');
 assert.equal(env.run('ccSession.messages.at(-1).content'),'本地 CC 回复');assert.equal(env.run('ccSession.busy'),false);
});

test('legacy ask sessions allow notebook collaboration without losing drafts or history',()=>{
 const env=environment();
 const session=env.run("const legacyScope=loadAIScope(state.path);makeAISession(legacyScope,{responseMode:'ask',draft:'未发送草稿',messages:[{role:'user',content:'旧问题'}]})");
 assert.equal(session.responseMode,'edit');assert.equal(session.draft,'未发送草稿');assert.equal(session.messages[0].content,'旧问题');
 env.context.legacy=session;assert.equal(env.run('aiInterfaceMode(legacy).label'),'笔记协作');assert.deepEqual([...env.run('aiAvailableModes(legacy).map(mode=>mode.value)')],['edit','suggest']);
});


test('workspace context keeps per-file selections and change baselines with identical cell IDs',()=>{
 const env=environment();env.run("const chat=currentAISession();chat.selectedCells=['one'];chat.changeBaseline={title:'A',cells:[{id:'one',source:'A'}]};chat.changeOrigins={one:{beforeHash:'1',afterHash:'2'}};chat.excludedChanges=['one'];chat.sources=[{path:'reference.pdf',text:'attachment'}];chat.draft='still here';state.path='notebooks/B.json';currentAISession();");
 assert.equal(env.run('chat.path'),'notebooks/B.json');assert.equal(env.run('chat.changeBaseline'),null);assert.equal(env.run('chat.selectedCells.length'),0);assert.equal(env.run('chat.draft'),'still here');assert.equal(env.run('chat.sources.length'),1);
 env.run("chat.changeBaseline={title:'B',cells:[{id:'one',source:'B'}]};persistAI(chat);state.path='notebooks/note.json';currentAISession()");
 assert.equal(env.run('chat.changeBaseline.title'),'A');assert.deepEqual([...env.run('chat.selectedCells')],['one']);assert.deepEqual([...env.run('chat.excludedChanges')],['one']);
 const restored=environment(env.localStorage);restored.run("state.path='notebooks/B.json'");assert.equal(restored.run('currentAISession().changeBaseline.title'),'B');
});
test('workspace round freezes its file during streaming and next round uses the new file',async()=>{
 const env=environment(),container=new Element();env.context.container=container;env.context.save=async()=>{};env.context.pending=[];
 env.run("aiState.config={model:'fake'};aiStream=(route,body,request,onEvent)=>new Promise(resolve=>pending.push({body,onEvent,resolve}));const chat=currentAISession();const response=sendAI(chat,'A question','chat');");
 await new Promise(resolve=>setImmediate(resolve));assert.equal(env.context.pending[0].body.path,'notebooks/note.json');
 env.run("state.path='notebooks/B.json';renderAI(container)");assert.equal(env.run('currentAISession().id'),env.run('chat.id'));assert.equal(env.run('chat.path'),'notebooks/note.json');
 env.context.pending[0].onEvent({type:'done',text:'A reply'});env.context.pending[0].resolve();await env.run('response');assert.equal(env.run('chat.path'),'notebooks/B.json');assert.equal(env.run('chat.messages[0].path'),'notebooks/note.json');
 env.run("const next=sendAI(chat,'B question','chat')");await new Promise(resolve=>setImmediate(resolve));assert.equal(env.context.pending[1].body.path,'notebooks/B.json');assert.match(env.context.pending[1].body.messages[0].content,/讨论文件：notebooks\/note.json/);
 env.context.pending[1].onEvent({type:'done',text:'B reply'});env.context.pending[1].resolve();await env.run('next');
});
test('all legacy notebook and PDF sidebar histories migrate once into a workspace',()=>{
 const store=storage();for(const [path,id] of [['notebooks/note.json','A'],['reference.pdf','B']])store.setItem('slide-notes-ai-v2:'+JSON.stringify(['workspace-one',path,'notebook']),JSON.stringify({active:id,conversations:[{id,title:id,draft:id,messages:[{role:'user',content:id}],createdAt:1,updatedAt:2}]}));
 const env=environment(store);assert.equal(env.run('loadAIScope(state.path).conversations.length'),2);assert.equal(env.run('currentAISession().id'),'A');
 env.run("state.path=null;editorTabs={active:'reference.pdf',items:[{kind:'pdf',path:'reference.pdf'}]};currentAISession()");assert.equal(env.run('currentAISession().id'),'A');assert.equal(env.run('currentAISession().path'),'reference.pdf');
 assert.equal(env.run('loadAIScope(state.path).conversations[1].messages[0].path'),'reference.pdf');
 const restored=environment(store);assert.equal(restored.run('loadAIScope(state.path).conversations.length'),2);
});

test('opening another file before hydration cannot replace newer disk messages with a local draft snapshot',async()=>{
 const env=environment();env.run("const local=currentAISession();local.title='Local old';local.messages=[{role:'user',content:'old'}];local.updatedAt=100;persistAIScope(loadAIScope(state.path));loadAIScope=originalLoadAIScope;loadAIScope(state.path).ready=false;state.path='notebooks/B.json';currentAISession()");
 assert.equal(env.run('local.updatedAt'),100);assert.equal(env.run('local.path'),'notebooks/note.json');
 env.context.api=async()=>({data:{active:env.run('local.id'),conversations:[{id:env.run('local.id'),contextPath:'notebooks/note.json',title:'Newer disk',createdAt:1,updatedAt:200,messages:[{role:'user',content:'new message'}],draft:'new draft'}]},revision:'disk-r2',file:'sessions/workspace.json'});
 await env.run('hydrateAIScope(loadAIScope(state.path))');assert.equal(env.run('currentAISession().messages[0].content'),'new message');assert.equal(env.run('currentAISession().path'),'notebooks/B.json');
});
