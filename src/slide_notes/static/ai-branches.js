'use strict';
function aiBranchSnapshot(session){
 const clone=value=>JSON.parse(JSON.stringify(value));
 const own=[];
 for(const [index,message] of session.messages.entries()){
  if(['error','cancelled','streaming'].includes(message.status))continue;
  if(message.role==='user'){
   const next=session.messages.slice(index+1).find(item=>['user','assistant'].includes(item.role));
   if(next?.role==='assistant'&&['error','cancelled','streaming'].includes(next.status))continue;
  }
  own.push({role:message.role,content:(message.path?'讨论文件：'+message.path+'\n\n':'')+message.content,...(message.images?.length?{images:clone(message.images)}:{}),...(message.sources?.length?{sources:clone(message.sources)}:{}),...(message.pdfContext?{pdfContext:clone(message.pdfContext)}:{}),...(message.toolTrace?.length?{toolTrace:clone(message.toolTrace)}:{}),...(message.cellSelections?.length?{cellSelections:clone(message.cellSelections)}:{})});
 }
 const archive=[...(session.branch?.archive?clone(session.branch.archive):[]),...own];
 if(archive.length>240)throw Error('分支历史过长，请从历史菜单创建空白对话');
 const excerpts=own.slice(-16).map((message,index)=>{
  const messageIndex=archive.length-Math.min(own.length,16)+index;
  const text=message.content.length>450?message.content.slice(0,300)+' … '+message.content.slice(-150):message.content;
  const refs=[...(message.toolTrace||[]).filter(trace=>trace.tool==='read_pdf').map(trace=>`${trace.path} 已读 ${trace.pages?.join(',')} 页；下一页 ${trace.nextPage??'结束'}`),...(message.pdfContext?[`${message.pdfContext.path} · 第 ${message.pdfContext.page} 页`]:[]),...(message.sources||[]).map(source=>`${source.path}${source.kind==='selection-ref'?' · 选区 id='+source.id:''} · ${source.text?.slice(0,150)||source.kind}`),...(message.cellSelections||[]).map(selected=>`${selected.cell} · ${selected.text.slice(0,150)}`),...(message.images||[]).map(image=>`图片：${image.name||image.id}`)].join('\n');
  return `[消息 ${messageIndex} · ${message.role==='user'?'用户':'AI'}]：${text}${refs?'\n选区 / 附件：'+refs:''}`;
 }).join('\n\n');
 const inherited=session.branch?.summary?'更早分支的上下文摘录：\n'+session.branch.summary.slice(-3500)+'\n\n':'';
 const branch={version:1,parentId:session.id,parentTitle:session.title.slice(0,80),createdAt:Date.now(),parentMessageCount:session.messages.length,summary:(inherited+'父对话最近的上下文摘录（可能省略细节，准确原文可通过 read_branch_history 按消息索引读取）：\n'+excerpts).slice(-12000),archive};
 if(JSON.stringify(branch).length>1200000)throw Error('分支上下文过大，请从历史菜单创建空白对话');
 return branch;
}
function renderAIBranchOrigin(session,container){
 const box=$('.ai-branch-origin',container);if(!box)return;box.replaceChildren();box.hidden=!session.branch;if(!session.branch)return;
 const link=aiButton('分支自「'+session.branch.parentTitle+'」',()=>{
  const scope=aiState.scopes.get(session.scopeKey);
  if(scope?.conversations.some(chat=>chat.id===session.branch.parentId))activateAIConversation(scope,session.branch.parentId,container);
  else toast('父对话不在当前历史中，分支快照仍保留');
 },'git-compare');link.className='ai-branch-link';link.title='返回父对话；分支固定于创建时，后续消息互不影响';
 const preview=aiButton('上下文',()=>showAIBranchContext(session),'circle-help');preview.className='ai-branch-context';preview.title='查看继承的上下文';box.append(link,preview);
}
function showAIBranchContext(session){
 if(!session.branch)return;const dialog=aiDialog('分支继承的上下文'),note=document.createElement('p'),pre=document.createElement('pre');
 note.textContent=`继承自「${session.branch.parentTitle}」 · ${new Date(session.branch.createdAt).toLocaleString('zh-CN')}。本机整理上下文摘录，包含 ${session.branch.archive.length} 条固定历史。普通发送附带摘录；Agent 可按需读取原文。父对话之后的消息不会加入此分支。`;
 pre.textContent=session.branch.summary;dialog.append(note,pre);dialog.showModal();
}
