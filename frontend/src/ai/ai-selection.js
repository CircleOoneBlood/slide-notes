'use strict';
// Keep full selections in the local workspace. Conversation history carries previews and IDs.
async function registerAISelectionEntries(selections){
 if(!selections.length)return [];
 const result=await api('/api/ai/selections',{selections});
 if(!Array.isArray(result.sources)||result.sources.length!==selections.length||result.sources.some(source=>source.kind!=='selection-ref'||!source.id))throw Error('选区引用保存失败，请重新选择');
 return result.sources;
}
async function snapshotAISelectedCells(session){
 const path=session.path,cells=[...session.selectedCells],generation=(session.selectionGeneration||0)+1;
 session.selectionGeneration=generation;session.selectionReference=null;
 if(!cells.length){persistAI(session);refreshAI(session);return;}
 session.selectionUploads=(session.selectionUploads||0)+1;refreshAI(session);
 try{
  if(state.path===path)await save();
  const [reference]=await registerAISelectionEntries([{kind:'note-cells',path,cells,...(state.path===path?{revision:state.revision}:{})}]);
  if(session.selectionGeneration!==generation)return;
  if(session.path===path)session.selectionReference=reference;
  else if(session.fileContexts[path]?.selectedCells.join('|')===cells.join('|'))session.fileContexts[path].selectionReference=reference;
  persistAI(session);
 }catch(error){if(session.selectionGeneration===generation)toast('选区快照未保存：'+error.message);}
 finally{session.selectionUploads--;refreshAI(session);}
}
async function prepareAISelectionReferences(session,scope,sources,cellSelections){
 const reused=[];
 const pending=sources.filter(source=>['pdf-elements','text'].includes(source.kind)&&!source.image);
 pending.push(...cellSelections.map(selected=>({...selected,kind:'cell-text',textKind:selected.kind})));
 if(!cellSelections.length&&session.path.toLowerCase().endsWith('.json')&&['cell','cells'].includes(scope.scope)){
  const cells=scope.scope==='cells'?scope.cells:[scope.cell],cached=session.selectionReference;
  if(cached?.path===session.path&&cached.cells?.join('|')===cells.join('|'))reused.push(cached);
  else pending.push({kind:'note-cells',path:session.path,cells,...(state.path===session.path?{revision:state.revision}:{})});
 }
 if(sources.length-sources.filter(source=>pending.includes(source)).length+pending.length+reused.length>20)throw Error('每条消息最多附加 20 个选区，请减少附件');
 const references=await registerAISelectionEntries(pending);
 const kept=sources.filter(source=>!pending.includes(source));sources.splice(0,sources.length,...kept,...reused,...references);cellSelections.splice(0);
}
async function openAINoteSelectionSource(source){
 await openEditor('notebook',source.path);
 const id=source.cell||source.cells?.[0],index=state.doc?.slides.findIndex(page=>page.cells.some(cell=>cell.id===id));
 if(index<0||index==null)throw Error('原 cell 已不存在；选区快照仍可由 agent 读取');
 if(state.active!==index){state.active=index;render();}
 const card=document.getElementById('cell-'+id);card?.scrollIntoView({block:'center',behavior:'smooth'});
 if(source.sourceRevision!==state.revision){toast('笔记已变化，已返回对应 cell；原选区快照仍保留');return;}
 if(source.targetKind==='cell-text'&&source.textKind==='source'&&!source.stale&&card?.codeEditor){
  const view=card.codeEditor;if(source.to<=view.state.doc.length){view.focus();view.dispatch({selection:{anchor:source.from,head:source.to},scrollIntoView:true});}
 }
}
