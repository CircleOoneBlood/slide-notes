'use strict';
// Baselines belong to conversations, and advance only after a successful response.
const aiChangeFields=['kind','source','display','showCode','layout','slide','slideName'];
function aiSnapshot(document,revision,scope){
 const scopeIds=scope.scope==='cells'?[...scope.cells]:scope.scope==='cell'?[scope.cell]:[];
 const cells=[];
 for(const page of document.slides||[])for(const [position,cell] of page.cells.entries()){
  if(scope.scope!=='notebook'&&!scopeIds.includes(cell.id))continue;
  cells.push({id:cell.id,slide:page.id,slideName:page.name||'',position,kind:cell.kind,source:cell.source,display:cell.display||'normal',showCode:cell.showCode??false,layout:structuredClone(cell.layout??null)});
 }
 return {version:1,revision,title:document.title||'',coverage:scope.scope==='notebook'?'all':'partial',scopeIds,cells};
}
function localAIDocument(session){
 if(state.path===session.path&&state.doc?.slides)return {document:state.doc,revision:state.revision};
 if(typeof notebookSessions==='object'){const cached=notebookSessions.get(session.path);if(cached?.source){try{return {document:JSON.parse(cached.source),revision:null};}catch{}}}
 return null;
}
function ensureAIChangeBaseline(session){
 if(session.changeBaseline||!session.path.toLowerCase().endsWith('.json'))return;
 const current=localAIDocument(session);if(!current)return;
 const snapshot=aiSnapshot(current.document,current.revision,aiScope(session));
 if(JSON.stringify(snapshot).length>220000)return;
 session.changeBaseline=snapshot;persistAI(session);
}
function aiCanonical(value){
 if(Array.isArray(value))return value.map(aiCanonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,aiCanonical(value[key])]));
 return value;
}
function aiCellHash(cell){
 if(!cell)return 'missing';let result=2166136261;
 for(const char of JSON.stringify(aiCanonical(cell)))result=Math.imul(result^char.codePointAt(0),16777619)>>>0;
 return result.toString(16);
}
function aiLocalChanges(session,snapshot){
 const baseline=session.changeBaseline;if(!baseline||!snapshot)return [];
 const before=new Map(baseline.cells.map(cell=>[cell.id,cell])),after=new Map(snapshot.cells.map(cell=>[cell.id,cell]));
 const allowed=new Set([...after.keys(),...snapshot.scopeIds,...(snapshot.coverage==='all'?before.keys():[])]),changes=[];
 if(snapshot.coverage==='all'&&baseline.title!==snapshot.title)changes.push({id:'__title__',kind:'title',origin:'manual',fields:['title'],before:{source:baseline.title},after:{source:snapshot.title}});
 const common=new Set([...before.keys()].filter(id=>after.has(id)));
 const order=(cells,cell)=>[...cells.values()].filter(c=>c.slide===cell.slide&&common.has(c.id)).sort((a,b)=>a.position-b.position).map(c=>c.id);
 for(const id of new Set([...before.keys(),...after.keys()])){
  if(!allowed.has(id))continue;const old=before.get(id),current=after.get(id);
  const fields=aiChangeFields.filter(key=>!old||!current||JSON.stringify(aiCanonical(old[key]))!==JSON.stringify(aiCanonical(current[key])));
  if(old&&current&&old.slide===current.slide&&order(before,old).indexOf(id)!==order(after,current).indexOf(id))fields.push('position');
  if(!fields.length)continue;
  const record=session.changeOrigins?.[id];
  const kind=!current?'deleted':!old?(baseline.coverage==='all'||baseline.scopeIds.includes(id)?'added':'context-added'):fields.every(key=>['slide','slideName','position'].includes(key))?'moved':'modified';
  changes.push({id,kind,origin:record?(record.beforeHash===aiCellHash(old)&&record.afterHash===aiCellHash(current)?'agent':'mixed'):'manual',fields,before:old,after:current});
 }
 return changes;
}
async function prepareAIChanges(session,scope,referenceMode=false){
 if(!session.path.toLowerCase().endsWith('.json'))return null;
 const current=state.path===session.path?{document:structuredClone(state.doc),revision:state.revision}:await api('/api/document?path='+encodeURIComponent(session.path));
 const snapshot=aiSnapshot(current.document,current.revision,scope);
 if(JSON.stringify(snapshot).length>220000){if(referenceMode)return null;throw Error('修改基线过大，请缩小 cell 范围');}
 if(!session.changeBaseline){session.changeBaseline=structuredClone(snapshot);persistAI(session);}
 return {snapshot,baseline:structuredClone(session.changeBaseline),origins:structuredClone(session.changeOrigins||{}),excluded:[...(session.excludedChanges||[])]};
}
function acknowledgeAIChanges(session,snapshot,excluded=[]){
 if(!snapshot)return;
 const next=structuredClone(snapshot),old=session.changeBaseline;
 // Excluding a diff does not discard it; it will be offered again next turn.
 if(old){for(const id of excluded){
  if(id==='__title__'){next.title=old.title;continue;}
  next.cells=next.cells.filter(cell=>cell.id!==id);const previous=old.cells.find(cell=>cell.id===id);if(previous)next.cells.push(structuredClone(previous));
 }}
 session.changeBaseline=next;
 session.changeOrigins=Object.fromEntries(Object.entries(session.changeOrigins||{}).filter(([id])=>excluded.includes(id)));
 session.excludedChanges=[];
}
function recordAIAgentChanges(event,requestSession){
 const before=new Map((event.beforeCells||[]).map(cell=>[cell.id,cell]));
 const full=aiSnapshot(event.document,event.revision,{scope:'notebook'}),after=new Map(full.cells.map(cell=>[cell.id,cell]));
 const changed=new Set(event.changedIds||before.keys());
 for(const session of aiState.sessions.values()){
  if(session.path!==event.path||!session.changeBaseline)continue;
  session.changeOrigins||={};
  for(const id of changed){const prior=session.changeOrigins[id];session.changeOrigins[id]={beforeHash:prior?.beforeHash||aiCellHash(before.get(id)),afterHash:aiCellHash(after.get(id))};}
  if(session===requestSession){
   const snapshot=aiSnapshot(event.document,event.revision,session.request?.changeScope||aiScope(session));
   acknowledgeAIChanges(session,snapshot,session.request?.changeExcluded||[]);
   if(session.request)session.request.changeSnapshot=snapshot;
  }
  persistAI(session);
 }
}
function aiRuntimeLabel(session){
 if(state.path!==session.path)return '运行状态将在发送时核对';
 return !state.runtime?'尚未运行':state.runtimeDirty?'运行结果可能过期':'已有运行结果';
}
function renderAIChangeSummary(session,panel){
 const box=$('.ai-change-summary',panel);if(!box)return;box.replaceChildren();
 if(!session.path.toLowerCase().endsWith('.json'))return;
 ensureAIChangeBaseline(session);const current=localAIDocument(session);
 if(!current)return;
 const changes=aiLocalChanges(session,aiSnapshot(current.document,current.revision,aiScope(session)));
 const included=changes.filter(change=>!session.excludedChanges?.includes(change.id));
 const button=aiButton(changes.length?`已修改 ${included.length} 项${included.length!==changes.length?' · 部分未附':''}`:'修改跟踪中',()=>showAIChanges(session),'git-compare');
 button.className='ai-changes-button';button.title='查看本对话上次发送以来的变化';box.append(button);
 const runtime=document.createElement('span');runtime.className='ai-runtime-badge';runtime.textContent=aiRuntimeLabel(session);box.append(runtime);
}
async function showAIChanges(session){
 try{
  const current=state.path===session.path?localAIDocument(session):await api('/api/document?path='+encodeURIComponent(session.path));
  if(!current)return;ensureAIChangeBaseline(session);
  const changes=aiLocalChanges(session,aiSnapshot(current.document,current.revision,aiScope(session))),dialog=aiDialog('本对话中的笔记修改');
  const note=document.createElement('p');note.className='ai-changes-note';note.textContent='比较本对话上次成功发送或开始跟踪时的内容。取消勾选只是不附带该项差异，当前内容仍按对话范围发送。';dialog.append(note);
  if(!changes.length){const empty=document.createElement('p');empty.textContent='还没有新的修改。修改 cell 后，这里会显示前后内容。';dialog.append(empty);}
  for(const change of changes){
   const section=document.createElement('section');section.className='ai-change-card';const header=document.createElement('label'),checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=!session.excludedChanges.includes(change.id);checkbox.disabled=session.busy;
   checkbox.onchange=()=>{session.excludedChanges=session.excludedChanges.filter(id=>id!==change.id);if(!checkbox.checked)session.excludedChanges.push(change.id);persistAI(session);refreshAI(session);};
   const label=document.createElement('strong');label.textContent=(change.id==='__title__'?'笔记名称':aiCellLabel(change.id,session.path))+' · '+({modified:'修改',added:'新增',deleted:'删除',moved:'移动','context-added':'新加入范围',title:'修改'}[change.kind]);header.append(checkbox,label);
   const origin=document.createElement('small');origin.textContent={manual:'你的编辑',agent:'Agent 修改',mixed:'你与 Agent 均有修改'}[change.origin];section.append(header,origin);
   const fields=document.createElement('p');fields.className='ai-changes-note';fields.textContent='变化：'+change.fields.map(key=>({source:'内容',kind:'类型',display:'显示方式',showCode:'代码可见性',layout:'布局',slide:'页面',slideName:'页面名称',position:'顺序',title:'名称'}[key]||key)).join('、');section.append(fields);
   const columns=document.createElement('div');columns.className='ai-diff-columns';
   for(const [title,cell] of [['修改前',change.before],['修改后',change.after]]){const column=document.createElement('div'),heading=document.createElement('strong'),pre=document.createElement('pre');heading.textContent=title;pre.textContent=cell?(change.fields.includes('source')||change.kind==='title'?cell.source.slice(0,20000):JSON.stringify(Object.fromEntries(change.fields.map(key=>[key,cell[key]])),null,2)):'（不存在）';column.append(heading,pre);columns.append(column);}
   section.append(columns);dialog.append(section);
  }
  dialog.showModal();
 }catch(error){toast(error.message);}
}
let aiChangeRefreshTimer=null;
function queueAIChangeRefresh(){
 clearTimeout(aiChangeRefreshTimer);aiChangeRefreshTimer=setTimeout(()=>{for(const session of aiState.sessions.values())for(const host of aiContainers(session)){const panel=$('.ai-panel',host);if(panel)renderAIChangeSummary(session,panel);}},180);
}
