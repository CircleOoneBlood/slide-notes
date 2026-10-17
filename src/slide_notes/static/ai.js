'use strict';
const aiState={sessions:new Map(),scopes:new Map(),expanded:new Set(),windows:new Map(),picking:null,sidebarKey:null,targetKey:null,config:null,configLoading:null};
const aiWorkspace=()=>new URL(location.href).searchParams.get('workspace')||'legacy';
function aiKey(path,cell){return 'slide-notes-ai-v1:'+JSON.stringify([aiWorkspace(),path,cell||'notebook']);}
function aiScopeKey(path,cell){return cell?'slide-notes-ai-v2:'+JSON.stringify([aiWorkspace(),path,cell]):'slide-notes-ai-v3:'+JSON.stringify([aiWorkspace(),'workspace']);}
function makeAISession(scope,saved={}){
 const path=scope.workspace?(saved.contextPath??scope.path??''):scope.path;
 const id=typeof saved.id==='string'&&saved.id.length<=100?saved.id:crypto.randomUUID();
 const messages=Array.isArray(saved.messages)?saved.messages.filter(message=>message&&['user','assistant'].includes(message.role)&&typeof message.content==='string').slice(-60):[];
 for(const message of messages)if(message.status==='streaming')message.status='cancelled';
 const fallback=messages.find(message=>message.role==='user')?.content.trim().replace(/\s+/g,' ').slice(0,40)||(scope.cell?'Cell '+cellNumber(scope.cell)+' 对话':'全局对话');
 const session={responseMode:path.toLowerCase().endsWith('.json')&&saved.responseMode==='ask'?'edit':['edit','ask','suggest'].includes(saved.responseMode)?saved.responseMode:'edit',modelOverride:typeof saved.modelOverride==='string'?saved.modelOverride:'',claudeEffort:saved.claudeEffort||'',bookmarked:!!saved.bookmarked,branch:saved.branch||null,changeBaseline:saved.changeBaseline||null,changeOrigins:saved.changeOrigins||{},excludedChanges:saved.excludedChanges||[],id,key:scope.key+':'+id,scopeKey:scope.key,path,workspace:!!scope.workspace,fileContexts:saved.fileContexts||{},selectionReference:saved.selectionReference||null,cell:scope.cell,title:typeof saved.title==='string'?saved.title.slice(0,80):fallback,customTitle:!!saved.customTitle,messages,cellSelections:Array.isArray(saved.cellSelections)?saved.cellSelections:[],sources:Array.isArray(saved.sources)?saved.sources:[],images:Array.isArray(saved.images)?saved.images:[],draft:typeof saved.draft==='string'?saved.draft:'',selectedCells:Array.isArray(saved.selectedCells)?[...new Set(saved.selectedCells.filter(id=>typeof id==='string'))]:(scope.cell?[scope.cell]:[]),createdAt:Number(saved.createdAt)||Date.now(),updatedAt:Number(saved.updatedAt)||Date.now(),busy:false};
 aiState.sessions.set(session.key,session);return session;
}
function loadAIScope(path,cell=null){
 const key=aiScopeKey(path,cell);if(aiState.scopes.has(key))return aiState.scopes.get(key);
 let saved;try{saved=JSON.parse(localStorage.getItem(key));}catch{}
 if(!cell&&!saved){
  const records=new Map();let active;
  for(const prefix of ['slide-notes-ai-v2:','slide-notes-ai-v1:'])for(const oldKey of Object.keys(localStorage)){
   if(!oldKey.startsWith(prefix))continue;
   try{
    const parts=JSON.parse(oldKey.slice(prefix.length));if(parts[0]!==aiWorkspace()||parts[2]!=='notebook')continue;
    if(prefix==='slide-notes-ai-v1:'&&localStorage.getItem('slide-notes-ai-v2:'+JSON.stringify(parts)))continue;
    const old=JSON.parse(localStorage.getItem(oldKey));if(!old||typeof old!=='object')continue;
    const chats=Array.isArray(old.conversations)?old.conversations:[{...old,id:old.id||crypto.randomUUID()}];
    for(const record of chats){if(records.has(record.id))continue;records.set(record.id,{...record,messages:(record.messages||[]).map(message=>({...message,path:message.path||parts[1]})),contextPath:parts[1]});if(parts[1]===path&&(old.active===record.id||!active))active=record.id;}
   }catch{}
  }
  if(records.size)saved={conversations:[...records.values()],active:active||[...records.keys()][0]};
 }
 const scope={key,path:path||'',workspace:!cell,cell,active:null,conversations:[],ready:false,revision:null,version:0,hasLocal:!!saved};aiState.scopes.set(key,scope);
 if(Array.isArray(saved?.conversations))for(const record of saved.conversations){if(!record||typeof record!=='object'||scope.conversations.some(session=>session.id===record.id))continue;scope.conversations.push(makeAISession(scope,record));}
 if(!scope.conversations.length){let legacy;try{legacy=JSON.parse(localStorage.getItem(aiKey(path,cell)));}catch{}scope.hasLocal=scope.hasLocal||!!legacy;scope.conversations.push(makeAISession(scope,legacy&&typeof legacy==='object'?legacy:{}));}
 scope.active=scope.conversations.some(session=>session.id===saved?.active)?saved.active:scope.conversations[0].id;
 if(scope.hasLocal)persistAIScope(scope);return scope;
}
function currentAIDocumentPath(){return state.path||(typeof editorTabs==='object'?editorTabs.items.find(tab=>tab.path===editorTabs.active&&['pdf','image'].includes(tab.kind))?.path:null);}

function followAIContext(session,path){
 if(!session.workspace||session.busy||session.path===path)return;
 if(session.path){
  session.fileContexts[session.path]={selectionReference:session.selectionReference,selectedCells:[...session.selectedCells],changeBaseline:session.changeBaseline,changeOrigins:session.changeOrigins,excludedChanges:session.excludedChanges};
 }
 const context=Object.hasOwn(session.fileContexts,path)?session.fileContexts[path]:{};
 session.path=path;session.selectionReference=context.selectionReference||null;session.selectedCells=context.selectedCells||[];session.changeBaseline=context.changeBaseline||null;session.changeOrigins=context.changeOrigins||{};session.excludedChanges=context.excludedChanges||[];
 aiState.picking=null;session.helpOpen=false;persistAI(session);
}
function currentAISession(cell=null,path=currentAIDocumentPath()){
 if(cell&&!path)return null;
 const scope=loadAIScope(path,cell),session=scope.conversations.find(session=>session.id===scope.active);
 if(session&&!cell&&scope.ready)followAIContext(session,path||'');return session;
}
function aiSessionForContainer(container,cell){
 if(cell)return currentAISession(cell,container.dataset.aiPath||state.path);
 const session=currentAISession();
 if(session)aiState.sidebarKey=session.key;return session;
}
function aiScopeSnapshot(scope){return {active:scope.active,conversations:scope.conversations.map(session=>({id:session.id,contextPath:session.path,fileContexts:session.fileContexts,selectionReference:session.selectionReference,title:session.title,responseMode:session.responseMode,modelOverride:session.modelOverride,claudeEffort:session.claudeEffort,bookmarked:session.bookmarked,customTitle:session.customTitle,createdAt:session.createdAt,updatedAt:session.updatedAt,messages:session.messages.slice(-60),draft:session.draft,images:session.images,sources:session.sources,cellSelections:session.cellSelections,selectedCells:session.selectedCells,branch:session.branch,changeBaseline:session.changeBaseline,changeOrigins:session.changeOrigins,excludedChanges:session.excludedChanges}))};}
function persistAIScope(scope){
 if(!scope)return;
 try{localStorage.setItem(scope.key,JSON.stringify(aiScopeSnapshot(scope)));}catch{toast('浏览器备份空间不足，请检查工作区历史是否保存成功');}
 if(scope.ready){scope.version++;queueAIScopeSave(scope);}
}
function queueAIScopeSave(scope){
 clearTimeout(scope.saveTimer);if(scope.paused)return;
 scope.saveTimer=setTimeout(()=>{scope.saveTimer=null;flushAIScope(scope);},500);
}
async function flushAIScope(scope){
 if(!scope.ready||scope.paused)return;
 if(scope.savePromise){scope.saveAgain=true;return scope.savePromise;}
 const version=scope.version,data=aiScopeSnapshot(scope),revision=scope.revision;scope.saveAgain=false;
 scope.savePromise=api('/api/ai/sessions',{...(scope.workspace?{scope:'workspace'}:{path:scope.path,cell:scope.cell}),data,revision}).then(result=>{
  scope.revision=result.revision;scope.file=result.file;scope.saveError=null;
 }).catch(error=>{scope.saveError=error.message;toast('对话历史保存失败：'+error.message+'；浏览器备份已保留');}).finally(()=>{
  scope.savePromise=null;if(!scope.paused&&(scope.saveAgain||scope.version!==version))queueAIScopeSave(scope);
 });return scope.savePromise;
}
function hydrateAIScope(scope){
 if(scope.loading)return scope.loading;
 scope.loading=api('/api/ai/sessions?'+new URLSearchParams(scope.workspace?{scope:'workspace'}:{path:scope.path,...(scope.cell?{cell:scope.cell}:{})})).then(result=>{
  const local=scope.conversations,active=scope.active,remote=result.data,merged=new Map();
  if(remote?.conversations)for(const record of remote.conversations){const session=makeAISession(scope,record);merged.set(session.id,session);}
  if(!remote||scope.hasLocal)for(const session of local){const disk=merged.get(session.id);if(!disk||session.updatedAt>disk.updatedAt){merged.set(session.id,session);aiState.sessions.set(session.key,session);}}
  for(const session of local)if(!merged.has(session.id))aiState.sessions.delete(session.key);
  scope.conversations=[...merged.values()];
  scope.active=scope.hasLocal&&merged.has(active)?active:merged.has(remote?.active)?remote.active:scope.conversations[0].id;
  scope.revision=result.revision;scope.file=result.file;scope.ready=true;persistAIScope(scope);
 }).finally(()=>{scope.loading=null;});return scope.loading;
}
async function moveAIChatFiles(path,destination){
 const scopes=[...aiState.scopes.values()].filter(scope=>scope.workspace||scope.path===path||scope.path.startsWith(path+'/'));
 for(const scope of scopes){scope.paused=true;clearTimeout(scope.saveTimer);}
 try{
  await Promise.all(scopes.map(scope=>scope.savePromise));
  const result=await api('/api/ai/sessions/move',{path,destination});
  for(const scope of scopes){const moved=result.moved.find(item=>scope.workspace?item.scope==='workspace':item.previous===scope.path&&item.cell===scope.cell);scope.revision=moved?.revision??null;scope.file=moved?.file;}
 }finally{for(const scope of scopes)scope.paused=false;}
}
function persistAI(session){session.updatedAt=Date.now();persistAIScope(aiState.scopes.get(session.scopeKey));}
function activateAIConversation(scope,id,container){
 if(!scope.conversations.some(session=>session.id===id))return;
 scope.active=id;if(!scope.cell)aiState.sidebarKey=scope.key+':'+id;aiState.targetKey=scope.key+':'+id;aiState.picking=null;persistAIScope(scope);syncAISelection();renderAI(container,scope.cell);$('.ai-input',container)?.focus();
}
function newAIConversation(session,container,blank=false){
 try{
  const scope=aiState.scopes.get(session.scopeKey);
  const branch=!blank&&typeof aiBranchSnapshot==='function'?aiBranchSnapshot(session):null;
  const inherited=branch?JSON.parse(JSON.stringify({branch,responseMode:session.responseMode,modelOverride:session.modelOverride,claudeEffort:session.claudeEffort,contextPath:session.path,fileContexts:session.fileContexts,selectionReference:session.selectionReference,selectedCells:session.selectedCells,changeBaseline:session.changeBaseline,changeOrigins:session.changeOrigins})):{};
  const next=makeAISession(scope,{title:branch?'新分支':'新对话',...inherited});scope.conversations.push(next);activateAIConversation(scope,next.id,container);if(branch&&session.busy)toast('已从已完成消息创建分支，进行中的回复不计入分支');
 }catch(error){toast(error.message);}
}
function renderAIHistory(session,container,menu){
 const scope=aiState.scopes.get(session.scopeKey);menu.replaceChildren();
 const heading=document.createElement('div');heading.className='ai-history-heading';heading.textContent=session.cell?'此 cell 的对话':'Workspace 的对话';menu.append(heading);
 const blank=aiButton('新建空白对话',()=>newAIConversation(session,container,true),'plus');blank.className='ai-history-blank';menu.append(blank);
 if(scope.file){const location=document.createElement('small');location.className='ai-history-location';location.textContent=scope.file;menu.append(location);}
 if(scope.saveError)menu.append(aiButton('重试保存历史',()=>flushAIScope(scope)));
 for(const chat of [...scope.conversations].sort((a,b)=>Number(b.bookmarked)-Number(a.bookmarked)||b.updatedAt-a.updatedAt)){
  const row=aiButton(chat.title.trim()||'未命名对话',()=>activateAIConversation(scope,chat.id,container));row.className='ai-history-item';row.classList.toggle('active',chat.id===scope.active);row.setAttribute('aria-current',chat.id===scope.active?'true':'false');
  const info=document.createElement('small');info.textContent=(chat.bookmarked?'收藏 · ':'')+(chat.branch?'分支自「'+chat.branch.parentTitle+'」':chat.busy?'正在回复…':new Date(chat.updatedAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}));row.append(info);
  const preview=document.createElement('p');preview.textContent=chat.messages.filter(message=>message.role==='user').at(-1)?.content.slice(0,100)||chat.draft||'暂无消息';row.append(preview);menu.append(row);
 }
}
function aiCellWindowState(cell,path=state.path){
 const key=aiKey(path,cell);if(!aiState.windows.has(key))aiState.windows.set(key,{minimized:false,maximized:false});return aiState.windows.get(key);
}
function aiCellWindow(cell,path=state.path){
 const key=aiKey(path,cell);let container=[...document.querySelectorAll('[data-ai-window]')].find(item=>item.dataset.aiWindow===key);
 if(!container){
  let dock=document.getElementById('ai-cell-dock');
  if(!dock){dock=document.createElement('div');dock.id='ai-cell-dock';dock.className='ai-cell-dock';dock.setAttribute('aria-label','Cell AI 对话窗口');document.body.append(dock);}
  container=document.createElement('div');container.className='cell-ai-chat ai-cell-window';container.id='cell-ai-window-'+encodeURIComponent(key);container.dataset.aiWindow=key;container.dataset.aiPath=path;container.dataset.aiCell=cell;
  container.setAttribute('role','region');container.setAttribute('aria-label','Cell '+cellNumber(cell)+' AI 对话');dock.append(container);
 }
 return container;
}
function updateAICellWindow(container,cell){
 const view=aiCellWindowState(cell,container.dataset.aiPath||state.path);container.classList.toggle('minimized',view.minimized);container.classList.toggle('maximized',view.maximized&&!view.minimized);
 const title=$('.ai-chat-title',container);if(title){title.readOnly=view.minimized;title.title=view.minimized?'点击恢复对话窗口':'点击编辑对话名称';}
 const minimize=$('.ai-window-minimize',container);if(minimize){minimize.title=view.minimized?'恢复窗口':'收起窗口';minimize.setAttribute('aria-label',minimize.title);minimize.setAttribute('aria-expanded',String(!view.minimized));minimize.innerHTML=uiIcon(view.minimized?'chevron-up':'minus');}
 const maximize=$('.ai-window-maximize',container);if(maximize){maximize.title=view.maximized?'还原窗口':'展开窗口';maximize.setAttribute('aria-label',maximize.title);maximize.setAttribute('aria-pressed',String(view.maximized));}
}
function syncAICellWindows(){
 for(const container of document.querySelectorAll('[data-ai-window]'))container.hidden=state.mode==='present'||!aiState.expanded.has(container.dataset.aiWindow);
}
function animateAICellWindow(container,before=null,closing=false){
 if(!container.animate||typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches)return null;
 const after=container.getBoundingClientRect();
 const frames=closing?[{opacity:1,transform:'translateY(0) scale(1)'},{opacity:0,transform:'translateY(14px) scale(.98)'}]:before&&after.width&&after.height?[
  {transformOrigin:'top left',transform:`translate(${before.left-after.left}px,${before.top-after.top}px) scale(${before.width/after.width},${before.height/after.height})`},{transformOrigin:'top left',transform:'none'}
 ]:[{opacity:0,transform:'translateY(18px) scale(.98)'},{opacity:1,transform:'translateY(0) scale(1)'}];
 container.aiAnimation?.cancel();container.aiAnimation=container.animate(frames,{duration:closing?140:220,easing:'cubic-bezier(.2,.8,.2,1)'});return container.aiAnimation;
}
function openCellAI(cell){
 const key=aiKey(state.path,cell),opening=!aiState.expanded.has(key)||aiCellWindowState(cell).minimized;aiState.expanded.add(key);aiCellWindowState(cell).minimized=false;
 const container=aiCellWindow(cell);container.hidden=false;renderAI(container,cell);updateAICellWindow(container,cell);
 const session=currentAISession(cell),owner=document.getElementById('cell-'+cell);if(session&&typeof captureAICellSelection==='function'){captureAICellSelection(session,owner);refreshAI(session);}
 if(opening)animateAICellWindow(container);
 const card=document.getElementById('cell-'+cell);$('.cell-ai',card)?.setAttribute('aria-expanded','true');$('.ai-input',container)?.focus();
}
function closeCellAI(cell,path=state.path){
 const key=aiKey(path,cell);aiState.expanded.delete(key);
 if(aiState.picking===currentAISession(cell,path)?.key){aiState.picking=null;syncAISelection();}
 const container=[...document.querySelectorAll('[data-ai-window]')].find(item=>item.dataset.aiWindow===key),animation=container&&!container.hidden&&animateAICellWindow(container,null,true);
 if(animation)animation.finished.catch(()=>{}).then(()=>syncAICellWindows());else syncAICellWindows();
 const card=state.path===path?document.getElementById('cell-'+cell):null;if(card){$('.cell-ai',card)?.setAttribute('aria-expanded','false');$('.cell-ai',card)?.focus();}
}
function toggleAICellWindow(cell,kind,path=state.path){
 const container=aiCellWindow(cell,path),before=container.getBoundingClientRect?.();
 const view=aiCellWindowState(cell,path);
 if(kind==='minimized')view.minimized=!view.minimized;else{view.maximized=!view.maximized;view.minimized=false;}
 if(view.minimized&&aiState.picking===currentAISession(cell,path)?.key){aiState.picking=null;syncAISelection();}
 updateAICellWindow(container,cell);animateAICellWindow(container,before);if(!view.minimized)$('.ai-input',container)?.focus();
}
function renderCellAI(card,cell){
 const trigger=$('.cell-ai',card),key=aiKey(state.path,cell),open=aiState.expanded.has(key);
 trigger.setAttribute('aria-controls','cell-ai-window-'+encodeURIComponent(key));trigger.setAttribute('aria-expanded',String(open));
 if(open){const container=aiCellWindow(cell);renderAI(container,cell);updateAICellWindow(container,cell);}
}
function aiContainers(session){return [...document.querySelectorAll('[data-ai-session]')].filter(container=>container.dataset.aiSession===session?.key&&container.querySelector('.ai-panel'));}

async function loadAIConfig(){
 if(!aiState.configLoading)aiState.configLoading=api('/api/ai/config').then(result=>{aiState.config=result;return result;}).finally(()=>{aiState.configLoading=null;});
 return aiState.configLoading;
}
function aiButton(label,callback,icon){const el=document.createElement('button');el.type='button';if(icon)el.innerHTML=uiIcon(icon);const span=document.createElement('span');span.textContent=label;el.append(span);el.onclick=callback;return el;}
function aiCommands(session){return [
 {name:'summarize',description:'总结内容与结论',details:'梳理当前上下文的主题、结构、关键观点与结论。选择 cell 后只总结所选内容；未选择时使用当前对话的默认范围。',example:'/summarize 用三句话概括',prompt:'请总结本轮提供内容的核心内容、结构和关键结论。',mode:'chat'},
 {name:'explain',description:'解释 cell 的作用与思路',details:'解释文字、公式或 Python 代码的含义、执行思路及相互关系。可用 ＋ 选择一个或多个 cell，并在命令后补充希望重点理解的部分。',example:'/explain 重点解释公式推导',prompt:'请解释本轮提供内容的含义、作用和关键思路。',mode:'chat'},
 {name:'check',description:'检查逻辑与潜在问题',details:'检查当前上下文中的逻辑、数学推导、代码依赖与潜在错误，并给出改进方向。结果作为对话回复展示。',example:'/check 检查边界条件',prompt:'请检查本轮提供内容的逻辑、数学推导和代码依赖，指出可能的问题。',mode:'chat'},
 {name:'improve',description:'生成可审阅的修改建议',details:'在保留原意和结构的基础上生成 cell 修改建议。回复后可查看修改前后的内容，确认应用；命令不会直接修改笔记。',example:'/improve 保留现有变量名',prompt:'请在保留原意和结构的基础上，提出本轮提供的 cell 内容的必要改进。',mode:'suggest'},
 {name:'help',description:'浏览命令与使用说明',details:'显示可滚动的命令列表，点击每个命令展开用途与用法。也可在 /help 后写命令名，直接展开对应说明。',example:'/help improve',help:true},
].filter(command=>session.path.toLowerCase().endsWith('.json')||command.mode!=='suggest');}
function showAIHelp(session,commandName=''){
 session.helpOpen=true;session.helpCommand=commandName.trim().replace(/^\//,'');session.draft='';persistAI(session);
 for(const host of aiContainers(session)){$('.ai-input',host).value='';refreshAI(session,host);}
}
function renderAIHelp(session,panel){
 const help=$('.ai-command-help',panel);if(!help)return;help.hidden=!session.helpOpen;if(!session.helpOpen)return;
 if(!help.children.length){
  const heading=document.createElement('div');heading.className='ai-help-heading';const title=document.createElement('strong');title.textContent='命令帮助';
  const close=aiButton('关闭',()=>{session.helpOpen=false;help.hidden=true;$('.ai-input',panel).focus();},'x');heading.append(title,close);
  const list=document.createElement('div');list.className='ai-help-list';list.setAttribute('role','region');list.setAttribute('aria-label','命令说明列表');list.tabIndex=0;
  for(const command of aiCommands(session)){
   const item=document.createElement('details');item.dataset.command=command.name;
   const summary=document.createElement('summary'),name=document.createElement('code'),description=document.createElement('span');name.textContent='/'+command.name;description.textContent=command.description;summary.append(name,description);
   const body=document.createElement('div');body.className='ai-help-description';const text=document.createElement('p');text.textContent=command.details;const example=document.createElement('code');example.textContent=command.example;
   const use=aiButton('使用此命令',()=>{const input=$('.ai-input',panel);input.value='/'+command.name+' ';session.draft=input.value;session.helpOpen=false;help.hidden=true;persistAI(session);renderAICommands(session,panel);input.focus();});
   body.append(text,example,use);item.append(summary,body);list.append(item);
  }help.append(heading,list);
 }
 if(session.helpCommand){const item=[...help.querySelectorAll('details')].find(item=>item.dataset.command===session.helpCommand);if(item){item.open=true;item.scrollIntoView({block:'nearest'});}session.helpCommand='';}
}
function aiCommand(session,value){const match=value.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);if(!match)return null;const command=aiCommands(session).find(item=>item.name===match[1]);return command?{...command,extra:match[2]||''}:null;}
function highlightAICommand(menu,scroll=false){[...menu.querySelectorAll('button')].forEach((button,index)=>{const active=index===Number(menu.dataset.active||0);button.classList.toggle('active',active);if(active&&scroll)button.scrollIntoView({block:'nearest'});});}
function renderAICommands(session,panel){
 const menu=$('.ai-command-menu',panel),input=$('.ai-input',panel);if(!menu||!input)return;
 const match=input.value.match(/^\/([^\s]*)$/),commands=match?aiCommands(session).filter(command=>command.name.includes(match[1])):[];
 menu.replaceChildren();menu.hidden=!commands.length||session.busy;menu.dataset.active='0';
 let group;
 for(const command of commands){
  const nextGroup=command.help?'Help':'Notebook';
  if(nextGroup!==group){const heading=document.createElement('div');heading.className='ai-command-group';heading.textContent=nextGroup;menu.append(heading);group=nextGroup;}
  const button=aiButton('/'+command.name,()=>{input.value='/'+command.name+' ';session.draft=input.value;persistAI(session);menu.hidden=true;input.focus();});
  button.setAttribute('role','menuitem');button.title='/'+command.name+' · '+command.description;
  const description=document.createElement('small');description.textContent=command.description;button.append(description);menu.append(button);
 }highlightAICommand(menu);
 if(!menu.hidden&&panel.isConnected){const top=$('.ai-composer',panel).getBoundingClientRect().top;const boundary=panel.closest('#inspector-content')?.getBoundingClientRect().top||0;menu.style.maxHeight=Math.max(100,Math.min(320,top-boundary-12))+'px';}
}
document.addEventListener('pointerdown',event=>{if(!event.target.closest('.ai-composer'))for(const menu of document.querySelectorAll('.ai-command-menu'))menu.hidden=true;if(!event.target.closest('.ai-tools'))for(const menu of document.querySelectorAll('.ai-history-menu')){menu.hidden=true;menu.parentElement.querySelector('[aria-label="对话历史"]')?.setAttribute('aria-expanded','false');}});
function submitAIInput(session,value){
 if(session.busy||session.imageUploads||session.selectionUploads||(!value.trim()&&!session.images.length&&!session.sources.length&&!session.cellSelections.length))return;
 const command=aiCommand(session,value);
 if(command?.help){showAIHelp(session,command.extra);return;}
 if(value.trim().startsWith('/')&&!command){toast('未知命令，输入 / 查看可用命令');return;}
 sendAI(session,command?command.prompt+(command.extra?'\n用户补充：'+command.extra:''):value,command?.mode||(aiInterfaceMode(session).value==='suggest'?'suggest':'chat'));
}
function aiScope(session){
 if(!session.path)return {scope:'workspace'};
 if(session.selectedCells.length)return {scope:'cells',cells:[...session.selectedCells]};
 return session.cell?{scope:'cell',cell:session.cell}:{scope:'notebook'};
}
function aiCellLabel(id,path=state.path){if(path!==state.path)return 'Cell '+id.slice(0,8);const cell=allCells().find(cell=>cell.id===id);return cell?'Cell '+cellNumber(id):'已删除的 cell';}
function renderAIAttachments(session,panel){
 const box=$('.ai-attachments',panel);if(!box)return;box.replaceChildren();
 for(const id of session.selectedCells){
  const chip=aiButton(aiCellLabel(id,session.path),()=>{session.selectedCells=session.selectedCells.filter(value=>value!==id);persistAI(session);refreshAI(session);if(typeof snapshotAISelectedCells==='function')snapshotAISelectedCells(session);},'x');
  chip.className='ai-cell-chip';chip.title='移除 '+aiCellLabel(id,session.path);chip.setAttribute('aria-label',chip.title);chip.disabled=session.busy;box.append(chip);
 }
 const picking=aiState.picking===session.key||!!(typeof editorTabs==='object'&&editorTabs.items.some(tab=>tab.path===editorTabs.active&&tab.aiPDFSelecting===session.key));
 const hint=$('.ai-selection-hint',panel);hint.textContent=picking?'拖框或单点选择 · Esc 完成':session.selectedCells.length?'已选 '+session.selectedCells.length+' 个 cell'+(session.selectionReference&&state.path===session.path&&session.selectionReference.sourceRevision!==state.revision?' · 来源已变化':''):!session.path.toLowerCase().endsWith('.json')?'框选文档内容加入':session.cell?'默认使用绑定的 cell':'默认提及当前主页面文件';
 const add=$('.ai-add-cells',panel);add.disabled=session.busy||!!session.selectionUploads||!currentAIDocumentPath();add.innerHTML=uiIcon(picking?'check':'plus');add.title=picking?'完成选择':'拖框或单点选择上下文';add.setAttribute('aria-label',add.title);add.setAttribute('aria-pressed',String(picking));
 const input=$('.ai-input',panel);input.placeholder='输入问题，或输入 / 选择命令…';
}
function activeAISelection(){
 const session=aiState.picking&&aiState.sessions.get(aiState.picking);
 return session&&state.doc&&state.path===session.path&&!session.busy&&state.mode==='edit'&&(session.cell||state.panel==='ai')?session:null;
}
function syncAISelection(){
 const session=activeAISelection();if(!session){aiState.picking=null;if(typeof cancelAICellMarquee==='function')cancelAICellMarquee();}
 document.body.classList.toggle('ai-selecting-cells',!!session);
 for(const card of document.querySelectorAll('#cells .cell')){
  const selecting=!!session,selected=!!session?.selectedCells.includes(card.dataset.cell);
  card.classList.toggle('ai-cell-selectable',selecting);card.classList.toggle('ai-cell-picked',selecting&&selected);
  if(selecting){if(!card.hasAttribute('data-ai-tabindex'))card.dataset.aiTabindex=card.getAttribute('tabindex')??'';card.tabIndex=0;}
  else if(card.hasAttribute('data-ai-tabindex')){if(card.dataset.aiTabindex)card.setAttribute('tabindex',card.dataset.aiTabindex);else card.removeAttribute('tabindex');delete card.dataset.aiTabindex;}
 }
}
function toggleAISelection(session){
 if(session.busy||state.path!==session.path||state.mode!=='edit')return;
 aiState.picking=aiState.picking===session.key?null:session.key;syncAISelection();
 for(const candidate of aiState.sessions.values())refreshAI(candidate);
}
function toggleAISelectedCell(session,id){
 session.selectedCells=session.selectedCells.includes(id)?session.selectedCells.filter(cell=>cell!==id):[...session.selectedCells,id];
 persistAI(session);syncAISelection();refreshAI(session);if(typeof snapshotAISelectedCells==='function')snapshotAISelectedCells(session);
}
function aiSelectionCard(event){return event.target.closest('.cell-ai-chat,.code-actions,.code-settings')?null:event.target.closest('#cells .cell');}
document.addEventListener('click',event=>{
 const session=activeAISelection(),card=session&&aiSelectionCard(event);if(!card)return;
 event.preventDefault();event.stopImmediatePropagation();
 if(typeof consumeAICellSelectionClick==='function'&&consumeAICellSelectionClick())return;
 toggleAISelectedCell(session,card.dataset.cell);
},true);
document.addEventListener('dblclick',event=>{
 if(activeAISelection()&&aiSelectionCard(event)){event.preventDefault();event.stopImmediatePropagation();}
},true);
document.addEventListener('keydown',event=>{
 const session=activeAISelection();if(!session)return;
 if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();toggleAISelection(session);return;}
 if(event.target.matches('#cells .cell')&&['Enter',' '].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();toggleAISelectedCell(session,event.target.dataset.cell);}
},true);
function aiImageURL(image){return '/api/ai/images?'+new URLSearchParams({workspace:aiWorkspace(),id:image.id});}
function renderAIImages(images,box,remove){
 box.replaceChildren();
 for(const image of images||[]){
  const item=document.createElement('div');item.className='ai-image-item';
  const link=document.createElement('a');link.href=aiImageURL(image);link.target='_blank';link.rel='noopener';link.title='打开 '+(image.name||'图片');link.onclick=event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;if(typeof showImagePreview==='function'){event.preventDefault();showImagePreview(link.href,image.name||'图片');}};
  const preview=document.createElement('img');preview.src=link.href;preview.alt=image.name||'图片';preview.loading='lazy';link.append(preview);item.append(link);
  if(remove){const button=aiButton('',()=>remove(image),'x');button.title='移除图片';button.setAttribute('aria-label',button.title);item.append(button);}
  box.append(item);
 }
}
function readAIImage(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('无法读取剪贴板图片'));reader.readAsDataURL(file);});}
async function pasteAIImages(session,event){
 const clipboard=event.clipboardData;if(!clipboard)return;
 const files=Array.from(clipboard.items||[]).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
 if(!files.length)files.push(...Array.from(clipboard.files||[]).filter(file=>file.type.startsWith('image/')));
 if(!files.length)return;
 event.preventDefault();
 if(session.busy){toast('请等当前回复完成后再粘贴图片');return;}
 if(session.images.length+session.sources.filter(source=>source.image).length+(session.imageUploads||0)+files.length>8){toast('每条消息最多附加 8 张图片');return;}
 session.imageUploads=(session.imageUploads||0)+files.length;refreshAI(session);
 for(const file of files){
  try{
   if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type))throw Error('仅支持 PNG、JPEG、WebP 和 GIF 图片');
   if(file.size>3000000)throw Error('图片不能超过 3 MB，请缩小后重新粘贴');
   const image=await api('/api/ai/images',{data:await readAIImage(file),name:(file.name||'粘贴图片').slice(0,200)});
   session.images.push(image);persistAI(session);
  }catch(error){toast('粘贴图片失败：'+error.message);}
  finally{session.imageUploads--;refreshAI(session);}
 }
}
function renderAI(container,cell=null){
 const session=aiSessionForContainer(container,cell),scope=session&&aiState.scopes.get(session.scopeKey);
 if(scope&&!scope.ready){
  container.replaceChildren();delete container.dataset.aiSession;const loading=document.createElement('div');loading.className='ai-empty';loading.textContent='正在读取 sessions/ 中的对话历史…';container.append(loading);
  hydrateAIScope(scope).then(()=>{if(container.isConnected)renderAI(container,cell);}).catch(error=>{if(!loading.isConnected)return;loading.textContent='读取对话历史失败：'+error.message;loading.append(aiButton('重试',()=>renderAI(container,cell)));});return;
 }
 if(session&&typeof ensureAIChangeBaseline==='function')ensureAIChangeBaseline(session);
 if(container.dataset.aiSession===session?.key&&container.querySelector('.ai-panel')){refreshAI(session,container);return;}
 container.replaceChildren();container.dataset.aiSession=session?.key||'';
 const panel=document.createElement('div');panel.className='ai-panel';container.append(panel);
 const tools=document.createElement('div');tools.className='ai-tools';
 const title=document.createElement('input');title.className='ai-chat-title';title.type='text';title.maxLength=80;title.setAttribute('aria-label','对话名称');title.placeholder='未命名对话';title.value=session?.title||'AI 对话';title.title='点击编辑对话名称';title.disabled=!session;
 title.oninput=()=>{session.title=title.value;session.customTitle=true;persistAI(session);};
 title.onblur=()=>{if(!session)return;session.title=title.value.trim()||'未命名对话';title.value=session.title;persistAI(session);};
 title.onclick=()=>{if(session?.cell&&aiCellWindowState(session.cell,session.path).minimized)toggleAICellWindow(session.cell,'minimized',session.path);};
 title.onkeydown=event=>{if(event.key==='Enter'||event.key==='Escape'){event.preventDefault();title.blur();}};tools.append(title);
 const actions=document.createElement('div');actions.className='ai-header-actions';
 function action(label,callback,icon){const button=aiButton('',callback,icon);button.title=label;button.setAttribute('aria-label',label);return button;}
 const settingsAction=action('AI 设置',()=>showAISettings(),'settings-2');
 if(session){
  const bookmark=action('收藏对话',()=>{session.bookmarked=!session.bookmarked;persistAI(session);refreshAIInterface(session,panel);},'bookmark');bookmark.className='ai-bookmark';bookmark.setAttribute('aria-pressed',String(session.bookmarked));actions.append(bookmark);
  const create=action('新对话',()=>newAIConversation(session,container),'square-pen');create.title='从当前对话创建分支；空白对话在历史菜单中';
  const history=document.createElement('div');history.className='ai-history-menu';history.hidden=true;history.setAttribute('aria-label','对话历史');
  const toggle=action('对话历史',()=>{history.hidden=!history.hidden;toggle.setAttribute('aria-expanded',String(!history.hidden));if(!history.hidden)renderAIHistory(session,container,history);},'history');toggle.setAttribute('aria-expanded','false');
  history.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();history.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus();}};
  actions.append(toggle,create);tools.append(history);
 }
 actions.append(settingsAction);
 if(session?.cell){
  const minimize=action('收起窗口',()=>toggleAICellWindow(session.cell,'minimized',session.path),'minus');minimize.className='ai-window-minimize';
  const maximize=action('展开窗口',()=>toggleAICellWindow(session.cell,'maximized',session.path),'move-diagonal');maximize.className='ai-window-maximize';actions.append(minimize,maximize);
 }
 actions.append(action('关闭对话',()=>{
  if(session?.cell)closeCellAI(session.cell,session.path);else{state.panel=null;renderInspector();resizePlots();}
 },'x'));
 tools.append(actions);panel.append(tools);
 if(!session){const empty=document.createElement('p');empty.className='ai-empty';empty.textContent='打开一本笔记，开始 AI 对话。也可以在 PDF 中划选文字或框选图片加入对话。';panel.append(empty);return;}
 const origin=document.createElement('div');origin.className='ai-chat-origin';panel.append(origin);
 const branchOrigin=document.createElement('div');branchOrigin.className='ai-branch-origin';branchOrigin.hidden=true;panel.append(branchOrigin);
 panel.addEventListener('focusin',()=>{aiState.targetKey=session.key;});panel.addEventListener('pointerdown',()=>{aiState.targetKey=session.key;});
 const transcript=document.createElement('div');transcript.className='ai-transcript';transcript.setAttribute('aria-label','AI 对话');panel.append(transcript);
 const form=document.createElement('form');form.className='ai-composer';
 const input=document.createElement('textarea');input.className='ai-input';input.setAttribute('aria-label','向 AI 提问');input.placeholder=session.cell?'讨论这个 cell…':'讨论当前笔记…';input.title='可直接粘贴图片（每张最多 3 MB，每条最多 8 张）';input.rows=3;input.maxLength=16000;input.value=session.draft;
 input.onpaste=event=>pasteAIImages(session,event);
 input.oninput=()=>{session.draft=input.value;persistAI(session);renderAICommands(session,panel);};
 input.onkeydown=e=>{
  if(e.isComposing)return;
  const menu=$('.ai-command-menu',panel),buttons=[...menu.querySelectorAll('button')];
  if(!menu.hidden&&buttons.length){
   if(e.key==='Escape'){e.preventDefault();e.stopPropagation();menu.hidden=true;return;}
   if(['ArrowUp','ArrowDown','Tab'].includes(e.key)||(e.key==='Enter'&&!e.shiftKey&&!aiCommand(session,input.value))){
    e.preventDefault();const current=Number(menu.dataset.active||0);
    if(e.key==='Tab'||e.key==='Enter')buttons[current].click();
    else{menu.dataset.active=String((current+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length);highlightAICommand(menu,true);}return;
   }
  }
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(!session.busy)form.requestSubmit();}
 };
 const controls=document.createElement('div');controls.className='ai-composer-actions';
 const add=aiButton('',()=>startAIContextSelection(session).catch(error=>toast(error.message)),'plus');add.className='ai-add-cells';add.title='拖框或单点选择上下文';add.setAttribute('aria-label',add.title);
 const hint=document.createElement('span');hint.className='ai-selection-hint';
 const attachments=document.createElement('div');attachments.className='ai-attachments';attachments.setAttribute('aria-label','已选 cell');
 const selectedText=document.createElement('div');selectedText.className='ai-cell-selection-attachments';
 const sources=document.createElement('div');sources.className='ai-source-attachments';sources.setAttribute('aria-label','文档选区附件');
 const images=document.createElement('div');images.className='ai-image-attachments';images.setAttribute('aria-label','待发送图片');
 const uploadStatus=document.createElement('div');uploadStatus.className='ai-image-status';uploadStatus.setAttribute('role','status');
 const send=document.createElement('button');send.type='submit';send.className='ai-send';send.innerHTML=uiIcon('send')+'<span>发送</span>';
 const stop=aiButton('停止',()=>cancelAI(session),'square');stop.className='ai-stop';stop.hidden=true;
 const help=document.createElement('div');help.className='ai-command-help';help.hidden=true;
 const commands=document.createElement('div');commands.className='ai-command-menu';commands.setAttribute('aria-label','AI 命令');commands.setAttribute('role','menu');commands.hidden=true;
 const changes=document.createElement('div');changes.className='ai-change-summary';
 controls.append(add,hint,stop,send);form.append(changes,attachments,selectedText,sources,images,uploadStatus,input,help,commands,controls);form.onsubmit=e=>{e.preventDefault();submitAIInput(session,input.value);};panel.append(form);installAIComposerInterface(session,panel,form,controls);
 const info=document.createElement('div');info.className='ai-provider-note';panel.append(info);
 if(session.cell)updateAICellWindow(container,session.cell);
 refreshAI(session,container);loadAIConfig().then(()=>refreshAI(session)).catch(error=>{if(info.isConnected)info.textContent=error.message;});
}
function renderAITranscript(session,container){
 if(!session)return;
 if(!container){for(const host of aiContainers(session))renderAITranscript(session,host);return;}
 const transcript=$('.ai-transcript',container);if(!transcript)return;
 const nearBottom=transcript.scrollHeight-transcript.scrollTop-transcript.clientHeight<90;
 if(transcript._aiSessionKey!==session.key){transcript.replaceChildren();transcript._aiMessages=new WeakMap();transcript._aiSessionKey=session.key;}
 if(!session.messages.length){transcript.replaceChildren();renderAIWelcome(session,transcript);return;}
 const cache=transcript._aiMessages;let index=0;
 for(const message of session.messages){
  // Keep completed history and the active response mounted while deltas arrive.
  const {content,status,toolStatus,toolTrace,...details}=message;
  const signature=JSON.stringify([details,message.role==='user'||typeof NoteAIResponse==='undefined'?content:null,typeof NoteAIResponse==='undefined'||status==='error'||status==='cancelled'?status:null,status==='streaming'&&message.mode==='suggest',aiState.config?.provider]);
  const cached=cache.get(message);
  if(cached?.signature===signature){
   if(message.role==='assistant'&&!message.proposal&&!(status==='streaming'&&message.mode==='suggest')&&typeof NoteAIResponse!=='undefined')NoteAIResponse.render(cached.body,message);
   else if(status==='streaming')cached.body.textContent=message.mode==='suggest'?'正在生成可预览的修改建议…':content||toolStatus||'正在等待回复…';
   if(typeof updateAIToolTrace==='function')updateAIToolTrace(cached.article,message);
   if(transcript.children[index]!==cached.article)transcript.insertBefore(cached.article,transcript.children[index]||null);index++;continue;
  }
  const article=document.createElement('article');article.className='ai-message '+message.role;
  const label=document.createElement('div');label.className='ai-message-label';label.textContent=message.role==='user'?'你':aiState.config?.provider==='claude-code'?'Claude':'Note Assistant';article.append(label);
  const body=document.createElement('div');body.className='ai-message-body';
  if(message.role==='user'||message.status==='streaming'&&message.mode==='suggest'){body.textContent=message.mode==='suggest'&&message.role==='assistant'?'正在生成可预览的修改建议…':message.content||'';}
  else if(message.proposal){body.textContent=message.proposal.summary;article.append(aiButton(message.applied?'已应用 · 可 Ctrl+Z 撤销':'查看 '+message.proposal.changes.length+' 项修改',()=>showAIProposal(session,message)));}
  else if(typeof NoteAIResponse!=='undefined')NoteAIResponse.render(body,message);
  else {body.innerHTML=DOMPurify.sanitize(markdown(message.content),{FORBID_TAGS:['img','iframe','video','audio','object','embed','form','input']});for(const a of body.querySelectorAll('a')){a.target='_blank';a.rel='noopener noreferrer';}}
  article.insertBefore(body,article.children[1]||null);
  if(message.role==='user'&&message.path){const file=document.createElement('small');file.className='ai-message-cells';file.textContent=message.path.split('/').at(-1);file.title=message.path;article.append(file);}
  if(message.role==='user'&&message.images?.length){const images=document.createElement('div');images.className='ai-message-images';renderAIImages(message.images,images);article.append(images);}
  if(message.role==='user'&&message.cellSelections?.length){const selected=document.createElement('div');selected.className='ai-message-selections';renderAICellSelections(message.cellSelections,selected);article.append(selected);}
  if(message.changeReport?.changes?.length){const label=document.createElement('small');label.className='ai-agent-operations';label.textContent='已附 '+message.changeReport.changes.length+' 项修改差异';article.append(label);}
  if(message.operations?.length){const operations=document.createElement('small');operations.className='ai-agent-operations';operations.textContent='已保存 '+message.operations.length+' 项内容操作';article.append(operations);}
  const visibleSources=message.sources?.filter(source=>source.kind!=='pdf-page');
  if(message.role==='user'&&visibleSources?.length){const sources=document.createElement('div');sources.className='ai-message-sources';renderAISources(visibleSources,sources);article.append(sources);}
  if(message.role==='user'&&Array.isArray(message.contextCells)&&message.contextCells.length){const refs=document.createElement('div');refs.className='ai-message-cells';refs.textContent=message.contextCells.join(' · ');article.append(refs);}
  if(message.status==='error'||message.status==='cancelled'){const error=document.createElement('small');error.className='ai-error';error.textContent=message.error||'已停止生成，保留已收到的内容';article.append(error);}
  if(typeof updateAIToolTrace==='function')updateAIToolTrace(article,message);
  cache.set(message,{article,body,signature});
  transcript.insertBefore(article,transcript.children[index]||null);index++;
 }
 while(transcript.children.length>index)transcript.children[transcript.children.length-1].remove();
 if(nearBottom)transcript.scrollTop=transcript.scrollHeight;
}
function refreshAI(session,container){
 if(!session)return;
 if(!container){for(const host of aiContainers(session))refreshAI(session,host);return;}
 renderAITranscript(session,container);const panel=$('.ai-panel',container);if(!panel)return;
 const title=$('.ai-chat-title',panel);if(title&&document.activeElement!==title)title.value=session.title;
 if(session.cell)updateAICellWindow(container,session.cell);
 syncAISelection();renderAIAttachments(session,panel);
 if(typeof renderAIChangeSummary==='function')renderAIChangeSummary(session,panel);
 renderAISources(session.sources,$('.ai-source-attachments',panel),source=>{if(session.busy)return;session.sources=session.sources.filter(item=>item!==source);persistAI(session);refreshAI(session);});
 renderAIOrigin(session,panel);
 if(typeof renderAIBranchOrigin==='function')renderAIBranchOrigin(session,container);
 renderAICellSelections(session.cellSelections,$('.ai-cell-selection-attachments',panel),selected=>{if(session.busy)return;session.cellSelections=session.cellSelections.filter(item=>item!==selected);persistAI(session);refreshAI(session);});
 renderAIImages(session.images,$('.ai-image-attachments',panel),image=>{if(session.busy)return;session.images=session.images.filter(item=>item!==image);persistAI(session);refreshAI(session);});
 $('.ai-image-status',panel).textContent=session.selectionUploads?'正在保存选区引用…':session.imageUploads?'正在保存图片…':'';
 $('.ai-send',panel).disabled=session.busy||!!session.imageUploads||!!session.selectionUploads;$('.ai-stop',panel).hidden=!session.busy;
 renderAICommands(session,panel);renderAIHelp(session,panel);
 const note=$('.ai-provider-note',panel);note.textContent=aiState.config?.provider==='claude-code'?'本地 Claude Code · '+(aiState.config.claudeModel||'使用 CC 默认模型')+' · 仅发送后调用':aiState.config?.model?aiState.config.model+' · 仅点击发送后调用 API':'先在设置中选择本地 Claude Code 或兼容 API';
 refreshAIInterface(session,panel);
}
async function aiStream(route,body,request,onEvent){
 const url=new URL(route,location.origin);const workspace=new URL(location.href).searchParams.get('workspace');if(workspace)url.searchParams.set('workspace',workspace);
 const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:request.controller.signal});
 if(!response.ok){const error=await response.json();throw Error(error.error||'AI 请求失败');}
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',done=false;
 while(true){const part=await reader.read();buffer+=decoder.decode(part.value||new Uint8Array(),{stream:!part.done});let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);for(const line of event.split('\n'))if(line.startsWith('data:')){const data=JSON.parse(line.slice(5));if(data.type==='error')throw Error(data.error);if(data.type==='done')done=true;onEvent(data);}}if(part.done)break;}
 if(!done&&!request.controller.signal.aborted)throw Error('连接提前结束，未收到完整回复');
}
function queueAIRefresh(session){if(session.refreshTimer)return;session.refreshTimer=setTimeout(()=>{session.refreshTimer=null;refreshAI(session);},60);}
async function sendAI(session,prompt,mode){
 if(!session.cell)followAIContext(session,currentAIDocumentPath()||'');
 if(session.busy||session.imageUploads||session.selectionUploads||(!prompt.trim()&&!session.images.length&&!session.sources.length&&!session.cellSelections.length))return;
 if(typeof cancelAICellMarquee==='function')cancelAICellMarquee();
 const scope=aiScope(session),images=[...session.images],sources=[...session.sources],cellSelections=session.cellSelections.map(selected=>({...selected,stale:selected.kind==='source'&&state.path===session.path?allCells().find(cell=>cell.id===selected.cell)?.source.slice(selected.from,selected.to)!==selected.text:false}));
 const request={id:crypto.randomUUID(),controller:new AbortController()};session.request=request;session.busy=true;refreshAI(session);
 let assistant;
 try{
  await save();if(request.controller.signal.aborted)return;
  const config=aiState.config||await loadAIConfig();if(config.provider!=='claude-code'&&!config.model){showAISettings();throw Error('请先完成 AI 设置');}
  const referenceMode=mode==='chat'&&typeof prepareAISelectionReferences==='function';
  if(referenceMode)await prepareAISelectionReferences(session,scope,sources,cellSelections);
  if(request.controller.signal.aborted)return;
  const pdfContext=typeof collectAIPDFContext==='function'?await collectAIPDFContext(session,sources,images):undefined;
  if(request.controller.signal.aborted)return;
  const history=session.messages.filter(m=>m.status!=='error'&&m.status!=='cancelled'&&m.status!=='streaming').slice(-20).map(m=>({role:m.role,content:(m.path?'讨论文件：'+m.path+'\n\n':'')+m.content,...(m.images?.length?{images:m.images}:{}),...(m.sources?.length?{sources:m.sources}:{}),...(m.pdfContext?{pdfContext:m.pdfContext}:{}),...(m.toolTrace?.length?{toolTrace:m.toolTrace}:{}),...(m.cellSelections?.length?{cellSelections:m.cellSelections}:{}),...(m.changeReport?{changeReport:m.changeReport}:{})}));
  const changePack=typeof prepareAIChanges==='function'?await prepareAIChanges(session,scope,referenceMode):null;request.changeScope=scope;request.changeSnapshot=changePack?.snapshot;request.changeExcluded=changePack?.excluded||[];
  const revision=changePack?.snapshot?.revision??(!session.path.toLowerCase().endsWith('.json')?null:state.path===session.path?state.revision:(await api('/api/ai/context?'+new URLSearchParams({path:session.path,...scope,...(scope.cells?{cells:JSON.stringify(scope.cells)}:{})}))).revision);
  if(request.controller.signal.aborted)return;
  if(request.pdfReadTarget&&(session.request!==request||session.path!==request.pdfReadTarget.path||editorTabs.active!==request.pdfReadTarget.path)){request.controller.abort();return;}
  if(!session.customTitle&&!session.messages.some(message=>message.role==='user'))session.title=prompt.trim().replace(/\s+/g,' ').slice(0,40)||(sources.length?'PDF 选区讨论':images.length?'图片对话':'新对话');
  session.messages.push({role:'user',content:prompt,path:session.path,images,sources,...(pdfContext?{pdfContext}:{}),cellSelections,contextCells:scope.scope==='cells'?scope.cells.map(id=>aiCellLabel(id,session.path)):scope.scope==='cell'?[aiCellLabel(scope.cell,session.path)]:null});assistant={role:'assistant',content:'',status:'streaming',mode,revision,path:session.path};session.messages.push(assistant);session.draft='';session.images=[];session.sources=[];session.cellSelections=[];
  for(const host of aiContainers(session))$('.ai-input',host).value='';persistAI(session);refreshAI(session);
  await aiStream('/api/ai/chat',{path:session.path,revision,...scope,prompt,images,sources,...(referenceMode?{selectionContext:'references'}:{}),...(pdfContext?{pdfContext}:{}),...(request.pdfReadTarget?{pdfReadTarget:request.pdfReadTarget}:{}),cellSelections,mode,permission:'notes-only',model:session.modelOverride||'',claudeEffort:session.claudeEffort||'',messages:history,requestId:request.id,...(session.branch?{branch:session.branch}:{}),...(changePack?{changeBaseline:changePack.baseline,changeOrigins:changePack.origins,excludedChanges:changePack.excluded}:{})},request,event=>{
   if(event.type==='meta'&&event.changeReport){session.messages[session.messages.indexOf(assistant)-1].changeReport=event.changeReport;}
   if(event.type==='guard'){guardAIAgentWrite(event,request);}
   if(event.type==='mutation'){applyAIAgentMutation(event,session,assistant);}
   if(event.type==='tool-summary'){assistant.toolTrace=(assistant.toolTrace||[]).concat(event.summary).slice(-48);while(JSON.stringify(assistant.toolTrace).length>15000)assistant.toolTrace.shift();}
   if(event.type==='workspace-mutation'){request.workspaceSync=(request.workspaceSync||Promise.resolve()).then(()=>applyAIWorkspaceMutation(event,session,assistant)).catch(error=>toast('文件已保存，界面同步失败：'+error.message));}
   if(event.type==='tool'){assistant.toolStatus=event.status==='running'?'正在'+({read_selection:'读取选区',inspect_note:'读取笔记',read_pdf:'读取 PDF 页面',search_pdf:'检索 PDF',list_workspace:'浏览工作区',search_workspace:'检索工作区',read_file:'读取文件',run_command:'执行隔离命令',save_generated_file:'保存生成文件',read_image:'读取图片',create_note:'创建笔记',write_text_file:'保存内容文件',manage_files:'整理文件',read_branch_history:'读取分支历史',apply_note_operations:'保存笔记修改',agent_capabilities:'检查可用操作'}[event.name]||'处理工具调用')+'…':'';if(event.status!=='running'){if(request.workspaceSync)request.workspaceSync.finally(()=>releaseAIWriteLock(request.id));else releaseAIWriteLock(request.id);}}
   if(event.type==='delta'){assistant.content+=event.text;}
   if(event.type==='done'){assistant.content=event.text;assistant.proposal=event.proposal;assistant.status='complete';if(typeof acknowledgeAIChanges==='function')acknowledgeAIChanges(session,request.changeSnapshot,changePack?.excluded||[]);}
   if(event.type==='done')refreshAI(session);else queueAIRefresh(session);
  });
 }catch(error){if(assistant){assistant.status=request.controller.signal.aborted?'cancelled':'error';assistant.error=request.controller.signal.aborted?'已停止生成':error.message;}else if(!request.controller.signal.aborted)toast(error.message);}
 finally{if(request.workspaceSync)await request.workspaceSync;if(typeof releaseAIWriteLock==='function')releaseAIWriteLock(request.id);if(session.request===request){session.busy=false;session.request=null;}if(!session.cell)followAIContext(session,currentAIDocumentPath()||'');persistAI(session);refreshAI(session);}
}
function cancelAI(session){const request=session.request;if(!request)return;request.controller.abort();api('/api/ai/cancel',{requestId:request.id}).catch(()=>{});}
function aiDialog(title){const dialog=document.createElement('dialog');dialog.className='ai-dialog';const heading=document.createElement('div');heading.className='ai-dialog-heading';const h=document.createElement('h2');h.textContent=title;const close=aiButton('关闭',()=>dialog.close(),'x');heading.append(h,close);dialog.append(heading);dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);return dialog;}
async function showAIContext(session){
 if(session.path.toLowerCase().endsWith('.pdf')){
  const dialog=aiDialog('本轮 PDF 上下文'),info=document.createElement('p'),tab=typeof editorTabs==='object'?editorTabs.items.find(tab=>tab.path===session.path):null,selected=session.sources.filter(source=>source.path===session.path);
  info.textContent=selected.length?'本轮优先使用已添加的 PDF 选区。':'自动关联'+(tab?.aiPDFPage?'第 '+tab.aiPDFPage.page+' / '+tab.aiPDFPage.pageCount+' 页':'当前页')+'作为上下文；同一页复用本地缓存，不重复作为消息附件。翻页后切换到新页面。Agent 也可自行读取其他页、全文检索和创建笔记。';
  dialog.append(info);if(selected.length){const sources=document.createElement('div');renderAISources(selected,sources);dialog.append(sources);}dialog.showModal();return;
 }
 try{const scope=aiScope(session);await save();const result=await api('/api/ai/context?'+new URLSearchParams({path:session.path,...scope,...(scope.cells?{cells:JSON.stringify(scope.cells)}:{})}));const dialog=aiDialog('本轮发送的笔记内容');const info=document.createElement('p');info.textContent=result.path+' · '+result.characters+' 字符；另附本对话最近 20 条完整消息。'+(session.branch?'此外附带固定的父对话上下文摘录，Agent 可按需读取分支历史。':'');const pre=document.createElement('pre');pre.textContent=JSON.stringify(result.context,null,2);dialog.append(info,pre);dialog.showModal();}catch(error){toast(error.message);}
}
function showAIProposal(session,message){
 const dialog=aiDialog('审阅 AI 修改建议');const summary=document.createElement('p');summary.textContent=message.proposal.summary;dialog.append(summary);
 for(const change of message.proposal.changes){const section=document.createElement('section');section.className='ai-diff';const h=document.createElement('h3');h.textContent=(change.kind==='code'?'Python':'Markdown')+' · Cell '+change.cell;const columns=document.createElement('div');columns.className='ai-diff-columns';for(const [label,source] of [['修改前',change.before],['修改后',change.after]]){const column=document.createElement('div');const title=document.createElement('strong');title.textContent=label;const pre=document.createElement('pre');pre.textContent=source;column.append(title,pre);columns.append(column);}section.append(h,columns);dialog.append(section);}
 const error=document.createElement('p');error.className='ai-error';const apply=aiButton(message.applied?'已应用':'应用全部修改',async()=>{
  if(state.path!==message.path||state.revision!==message.revision||state.epoch!==state.savedEpoch){error.textContent='笔记已切换或内容已变化，请返回原笔记重新生成建议。';return;}
  const changes=message.proposal.changes;
  if(changes.some(change=>allCells().find(c=>c.id===change.cell)?.source!==change.before)){error.textContent='cell 已发生变化，请重新生成建议。';return;}
  apply.disabled=true;
  try{ensureNotebookHistory();for(const change of changes)allCells().find(c=>c.id===change.cell).source=change.after;dirty(true,'ai-proposal');render();await save();message.applied=true;persistAI(session);refreshAI(session);dialog.close();}catch(e){error.textContent=e.message+'；修改仍在编辑器中，可 Ctrl+Z 撤销。';}
 });apply.className='ai-primary';apply.disabled=message.applied||!message.proposal.changes.length;dialog.append(error,apply);dialog.showModal();
}
async function showAISettings(){
 let config;try{config=await loadAIConfig();}catch(error){toast(error.message);return;}
 const dialog=aiDialog('AI 设置');dialog.classList.add('ai-settings');
 const form=document.createElement('form');form.innerHTML=`
 <label>服务<select name="provider"><option value="api">GLM / 兼容 API</option><option value="claude-code">本地 Claude Code</option></select></label>
 <div data-api-settings><label>API Base URL<input name="baseUrl" type="url" autocomplete="off"></label><label>模型名称<input name="model" placeholder="例如 glm-4.7，以服务控制台为准" autocomplete="off"></label><label>API Key<input name="apiKey" type="password" autocomplete="off"></label><p class="ai-setting-note">Key 仅保存在本机应用配置中，不写入笔记，也不会在设置接口中回传。</p><div class="ai-setting-actions"><button type="button" data-preset>智谱 GLM 地址</button><button type="button" data-clear>清除 Key</button></div></div>
 <div data-claude-settings hidden><label>Claude Code 可执行文件<input name="claudePath" placeholder="留空自动查找本机 claude" autocomplete="off"></label><label>Claude 模型（可选）<input name="claudeModel" placeholder="留空使用本地 CC 默认模型" autocomplete="off"></label><p class="ai-setting-note">复用本机 Claude Code 登录与服务配置，无需在 Note 填写 Key。首次使用请先在终端运行 claude 完成登录。CC 只通过 Note 的笔记工具保存修改，不执行终端命令或笔记代码。</p><p class="ai-setting-note" data-claude-status></p></div>
 <div class="ai-setting-actions"><button type="button" data-test>保存并测试连接</button><button type="submit" class="ai-primary">保存设置</button></div><p class="ai-setting-status" role="status"></p>`;
 form.elements.provider.value=config.provider||'api';form.elements.baseUrl.value=config.baseUrl;form.elements.model.value=config.model;
 form.elements.claudePath.value=config.claudePath||'';form.elements.claudeModel.value=config.claudeModel||'';
 form.elements.apiKey.placeholder=config.hasKey?'已配置；留空保留原 Key':'填写 API Key；无鉴权本地服务可留空';
 function syncProvider(){const local=form.elements.provider.value==='claude-code';$('[data-api-settings]',form).hidden=local;$('[data-claude-settings]',form).hidden=!local;form.elements.baseUrl.required=!local;form.elements.baseUrl.disabled=local;form.elements.model.required=!local;form.elements.model.disabled=local;
  $('[data-claude-status]',form).textContent=config.claudeAvailable?'已检测到：'+config.claudeDetectedPath:'未检测到可执行文件；可填写绝对路径后保存。';}
 form.elements.provider.onchange=syncProvider;syncProvider();
 const status=$('.ai-setting-status',form);let testing=null;
 if(managedWorkbench&&!new URL(location.href).searchParams.has('workspace')){$('[data-test]',form).disabled=true;status.textContent='打开工作区后可测试连接';}
 $('[data-preset]',form).onclick=()=>{form.elements.baseUrl.value='https://open.bigmodel.cn/api/paas/v4';};
 async function saveSettings(clear=false){const body={provider:form.elements.provider.value,baseUrl:form.elements.baseUrl.value,model:form.elements.model.value,claudePath:form.elements.claudePath.value,claudeModel:form.elements.claudeModel.value};if(clear||form.elements.apiKey.value)body.apiKey=clear?'':form.elements.apiKey.value;aiState.config=await api('/api/ai/config',body);config=aiState.config;syncProvider();form.elements.apiKey.value='';form.elements.apiKey.placeholder=aiState.config.hasKey?'已配置；留空保留原 Key':'填写 API Key';for(const session of aiState.sessions.values())refreshAI(session);}
 form.onsubmit=async e=>{e.preventDefault();try{await saveSettings();status.textContent='设置已保存';}catch(error){status.textContent=error.message;}};
 $('[data-clear]',form).onclick=async()=>{try{await saveSettings(true);status.textContent='已清除本机 Key';}catch(error){status.textContent=error.message;}};
 $('[data-test]',form).onclick=async()=>{if(!form.reportValidity()||testing)return;const button=$('[data-test]',form);button.disabled=true;status.textContent='正在发送测试请求（不包含笔记内容，使用当前服务额度）…';const request={id:crypto.randomUUID(),controller:new AbortController()};testing=request;
  try{await saveSettings();await aiStream('/api/ai/test',{requestId:request.id},request,()=>{});status.textContent='连接成功 · '+(aiState.config.provider==='claude-code'?'本地 Claude Code · '+(aiState.config.claudeModel||'默认模型'):aiState.config.model);}catch(error){status.textContent=request.controller.signal.aborted?'已停止测试':error.message;}finally{testing=null;button.disabled=false;}
 };
 dialog.addEventListener('close',()=>{if(testing){testing.controller.abort();api('/api/ai/cancel',{requestId:testing.id}).catch(()=>{});}});dialog.append(form);dialog.showModal();
}
function remapAIChats(remap){
 for(const prefix of ['slide-notes-ai-v1:','slide-notes-ai-v2:'])for(const key of Object.keys(localStorage)){
  if(!key.startsWith(prefix))continue;let parts;try{parts=JSON.parse(key.slice(prefix.length));}catch{continue;}
  if(!Array.isArray(parts)||parts[0]!==aiWorkspace())continue;const path=remap(parts[1]);if(path===parts[1])continue;
  const next=prefix+JSON.stringify([parts[0],path,parts[2]]);localStorage.setItem(next,localStorage.getItem(key));localStorage.removeItem(key);
 }
 for(const [key,scope] of [...aiState.scopes]){
  if(scope.workspace){
   for(const session of scope.conversations){
    session.path=remap(session.path);
    for(const context of Object.values(session.fileContexts))if(context.selectionReference)context.selectionReference.path=remap(context.selectionReference.path);
    session.fileContexts=Object.fromEntries(Object.entries(session.fileContexts).map(([path,context])=>[remap(path),context]));
    for(const record of [session,...session.messages,...(session.branch?.archive||[])]){
     if(record.selectionReference)record.selectionReference.path=remap(record.selectionReference.path);
     if(record.pdfContext)record.pdfContext.path=remap(record.pdfContext.path);
     for(const trace of record.toolTrace||[])if(trace.path)trace.path=remap(trace.path);
     if(record.path)record.path=remap(record.path);
     for(const selection of [...(record.cellSelections||[]),...(record.sources||[])])selection.path=remap(selection.path);
    }
   }
   persistAIScope(scope);continue;
  }
  const path=remap(scope.path);if(path===scope.path)continue;aiState.scopes.delete(key);scope.path=path;scope.key=aiScopeKey(path,scope.cell);aiState.scopes.set(scope.key,scope);
  for(const session of scope.conversations){cancelAI(session);aiState.sessions.delete(session.key);session.path=path;session.scopeKey=scope.key;const previousKey=session.key;session.key=scope.key+':'+session.id;if(aiState.sidebarKey===previousKey)aiState.sidebarKey=session.key;if(aiState.targetKey===previousKey)aiState.targetKey=session.key;for(const record of [session,...session.messages]){if(record.selectionReference)record.selectionReference.path=remap(record.selectionReference.path);if(record.path)record.path=path;for(const selection of record.cellSelections||[])selection.path=remap(selection.path);}aiState.sessions.set(session.key,session);}
  persistAIScope(scope);
 }
 aiState.picking=null;
 for(const key of [...aiState.expanded]){const prefix='slide-notes-ai-v1:';const [workspace,path,cell]=JSON.parse(key.slice(prefix.length));const next=remap(path);if(next!==path){aiState.expanded.delete(key);const nextKey=prefix+JSON.stringify([workspace,next,cell]);aiState.expanded.add(nextKey);if(aiState.windows.has(key)){aiState.windows.set(nextKey,aiState.windows.get(key));aiState.windows.delete(key);}for(const container of document.querySelectorAll('[data-ai-window]'))if(container.dataset.aiWindow===key){container.dataset.aiWindow=nextKey;container.dataset.aiPath=next;container.id='cell-ai-window-'+encodeURIComponent(nextKey);}}}
 syncAISelection();
}
