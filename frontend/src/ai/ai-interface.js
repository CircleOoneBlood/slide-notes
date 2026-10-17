'use strict';
const aiResponseModes=[
 {value:'edit',label:'笔记协作',icon:'zap',description:'可浏览、检索工作区，读取 PDF 任意页，创建和编辑笔记；软件与配置保持只读。'},
 {value:'ask',label:'文档问答',icon:'message-circle',description:'可自行跨页读取、全文检索 PDF，并将结果写入笔记；原文档内容只读。'},
 {value:'suggest',label:'修改建议',icon:'square-pen',description:'生成前后对比，由你审阅并应用。'}
];
function aiAvailableModes(session){if(!session.path)return aiResponseModes.filter(mode=>mode.value==='edit');return aiResponseModes.filter(mode=>session.path.toLowerCase().endsWith('.json')?mode.value!=='ask':mode.value==='ask');}
function aiInterfaceMode(session){const modes=aiAvailableModes(session);return modes.find(mode=>mode.value===session.responseMode)||modes[0];}
function sizeAIInput(input){input.style.height='auto';input.style.height=Math.min(200,Math.max(66,input.scrollHeight||66))+'px';}
function fillAISuggestion(session,panel,text){
 const input=$('.ai-input',panel);input.value=text;session.draft=text;persistAI(session);sizeAIInput(input);input.focus();renderAICommands(session,panel);refreshAIInterface(session,panel);
}
function renderAIWelcome(session,transcript){
 const empty=document.createElement('div');empty.className='ai-empty ai-welcome';
 const hero=document.createElement('div');hero.className='ai-welcome-hero';
 const brand=document.createElement('div');brand.className='ai-welcome-brand';brand.innerHTML=uiIcon('sparkles');
 const name=document.createElement('span');name.textContent=aiState.config?.provider==='claude-code'?'Claude · Notes':'Note Assistant';brand.append(name);
 // A small pixel notebook mascot, drawn in SVG rather than copying the extension's logo.
 const mascot=document.createElement('div');mascot.className='ai-note-mascot';mascot.setAttribute('aria-hidden','true');
 mascot.innerHTML='<svg viewBox="0 0 64 64" width="64" height="64"><path fill="currentColor" d="M14 10h32v6h6v38H14zM8 16h6v32H8z"/><path fill="#faf9f6" d="M20 16h20v6H20zM20 28h6v6h-6zM38 28h6v6h-6zM26 40h12v6H26z"/></svg>';
 const title=document.createElement('strong');title.textContent=session.branch?'沿着这条思路继续':session.cell?'从这个 cell 开始':!session.path?'从工作区开始':session.path.toLowerCase().endsWith('.json')?'让思路成为清晰的笔记':'阅读文档，连接笔记';
 const description=document.createElement('p');description.textContent=session.branch?'已继承分支上下文，原对话仍然保留。':session.cell?'文字、公式和代码，放在同一个上下文里讨论。':session.path.toLowerCase().endsWith('.json')?'理解推导，整理结构，完善代码。':'可自主跨页阅读、检索资料，并整理到笔记。';
 hero.append(brand,mascot,title,description);empty.append(hero);
 const suggestions=document.createElement('div');suggestions.className='ai-welcome-suggestions';
 for(const text of ['解释当前内容','检查逻辑与推导',...(session.path.toLowerCase().endsWith('.json')?['整理笔记结构']:[])]){
  const button=aiButton(text,()=>fillAISuggestion(session,transcript.closest('.ai-panel'),text),'arrow-up-right');suggestions.append(button);
 }
 empty.append(suggestions);
 if(localStorage.getItem('slide-notes-ai-mode-tip:'+aiWorkspace())!=='hidden'){
  const mode=aiInterfaceMode(session),card=document.createElement('section');card.className='ai-mode-card';
  const heading=document.createElement('div');heading.className='ai-mode-card-heading';heading.innerHTML=uiIcon(mode.icon);
  const label=document.createElement('strong');label.textContent=mode.label+(mode.value==='edit'?'已启用':'模式');
  const close=aiButton('',()=>{localStorage.setItem('slide-notes-ai-mode-tip:'+aiWorkspace(),'hidden');card.remove();},'x');close.title='隐藏模式说明';close.setAttribute('aria-label',close.title);heading.append(label,close);
  const text=document.createElement('p');text.textContent=mode.description+' Python 由你手动运行。';card.append(heading,text);empty.append(card);
 }
 transcript.append(empty);
}
function closeAIInterfaceMenus(panel,restore=false){
 for(const menu of panel.querySelectorAll('.ai-popup')){menu.aiTrigger?.setAttribute('aria-expanded','false');if(restore)menu.aiTrigger?.focus();menu.remove();}
}
function createAIInterfaceMenu(panel,trigger,className,label){
 const existing=$('.'+className,panel);closeAIInterfaceMenus(panel);if(existing)return null;
 const menu=document.createElement('div');menu.className='ai-popup '+className;menu.setAttribute('role','menu');menu.setAttribute('aria-label',label);menu.aiTrigger=trigger;
 trigger.setAttribute('aria-expanded','true');$('.ai-composer',panel).append(menu);
 menu.onkeydown=event=>{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeAIInterfaceMenus(panel,true);}
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)&&!event.target.matches('input,select')){
   event.preventDefault();event.stopPropagation();const buttons=[...menu.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(document.activeElement);
   buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();
  }
 };
 return menu;
}
function changeAIResponseMode(session,panel,value){
 if(session.busy)return;session.responseMode=value;persistAI(session);closeAIInterfaceMenus(panel);refreshAI(session);$('.ai-input',panel).focus();
}
function showAIResponseModes(session,panel,trigger){
 const menu=createAIInterfaceMenu(panel,trigger,'ai-mode-menu','笔记操作模式');if(!menu)return;
 for(const mode of aiAvailableModes(session)){
  const button=aiButton(mode.label,()=>changeAIResponseMode(session,panel,mode.value),mode.icon);button.setAttribute('role','menuitemradio');button.setAttribute('aria-checked',String(mode.value===aiInterfaceMode(session).value));
  const description=document.createElement('small');description.textContent=mode.description;button.append(description);menu.append(button);
 }
 $('button',menu)?.focus();
}
function showAIModelMenu(session,panel,trigger){
 const menu=createAIInterfaceMenu(panel,trigger,'ai-model-menu','对话模型');if(!menu)return;
 const local=aiState.config?.provider==='claude-code',label=document.createElement('div');label.className='ai-popup-label';label.textContent=local?'本次对话的 Claude 模型':'本次对话的模型';menu.append(label);
 function choose(model){if(session.busy)return;session.modelOverride=model;persistAI(session);closeAIInterfaceMenus(panel);refreshAI(session);trigger.focus();}
 const choices=[['',local?'使用本地 CC 默认模型':'使用 API 默认模型'],...(local?[['sonnet','Sonnet'],['opus','Opus']]:[])];
 for(const [value,label] of choices){const button=aiButton(label,()=>choose(value));button.setAttribute('role','menuitemradio');button.setAttribute('aria-checked',String((session.modelOverride||'')===value));menu.append(button);}
 const custom=document.createElement('label');custom.className='ai-model-custom';custom.textContent='其他模型 ID';const input=document.createElement('input');input.type='text';input.maxLength=200;input.value=session.modelOverride||'';input.placeholder='填写账户可用的模型 ID';input.setAttribute('aria-label','其他模型 ID');custom.append(input);menu.append(custom);
 const apply=aiButton('使用此模型',()=>choose(input.value.trim()),'check');menu.append(apply);input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();choose(input.value.trim());}};
 if(local){
  const label=document.createElement('label');label.className='ai-model-custom';label.textContent='思考强度';const select=document.createElement('select');select.setAttribute('aria-label','Claude 思考强度');
  for(const [value,text] of [['','使用 CC 默认'],['low','Low'],['medium','Medium'],['high','High'],['xhigh','XHigh'],['max','Max']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}
  select.value=session.claudeEffort||'';select.onchange=()=>{session.claudeEffort=select.value;persistAI(session);refreshAI(session);};label.append(select);menu.append(label);
 }
 $('button',menu)?.focus();
}
function installAIComposerInterface(session,panel,form,controls){
 panel.classList.add('ai-note-interface');
 const input=$('.ai-input',form);sizeAIInput(input);input.addEventListener('input',()=>{sizeAIInput(input);refreshAIInterface(session,panel);});
 const hint=$('.ai-selection-hint',controls);
 const slash=aiButton('',()=>{
  const menu=$('.ai-command-menu',panel);if(!menu.hidden){menu.hidden=true;return;}
  if(!input.value.trim())fillAISuggestion(session,panel,'/');else{session.helpOpen=!session.helpOpen;renderAIHelp(session,panel);input.focus();}
 },'square-slash');slash.className='ai-slash-button';slash.title='笔记命令 /';slash.setAttribute('aria-label',slash.title);controls.insertBefore(slash,hint);
 const context=aiButton('',()=>{if(!session.cell)followAIContext(session,currentAIDocumentPath()||'');showAIContext(session);},'file-text');context.className='ai-context-chip';context.title='默认提及当前主页面文件，点击查看上下文';context.setAttribute('aria-label',context.title);controls.insertBefore(context,hint);
 const mode=aiButton('',()=>showAIResponseModes(session,panel,mode),'zap');mode.className='ai-response-mode';mode.setAttribute('aria-haspopup','menu');mode.setAttribute('aria-expanded','false');controls.insertBefore(mode,$('.ai-stop',controls));
 const footer=document.createElement('div');footer.className='ai-composer-footer';
 const model=aiButton('',()=>showAIModelMenu(session,panel,model));model.className='ai-model-chip';model.setAttribute('aria-haspopup','menu');model.setAttribute('aria-expanded','false');
 const shortcut=document.createElement('span');shortcut.className='ai-input-shortcut';shortcut.textContent='Enter 发送 · Shift Enter 换行';footer.append(model,shortcut);form.append(footer);
 form.addEventListener('keydown',event=>{if(event.altKey&&event.key.toLowerCase()==='m'&&!session.busy){event.preventDefault();event.stopPropagation();const modes=aiAvailableModes(session),index=modes.indexOf(aiInterfaceMode(session));changeAIResponseMode(session,panel,modes[(index+1)%modes.length].value);}});
 refreshAIInterface(session,panel);
}
function refreshAIInterface(session,panel){
 const mode=aiInterfaceMode(session),button=$('.ai-response-mode',panel);if(!button)return;
 if(session.busy)closeAIInterfaceMenus(panel);
 panel.dataset.responseMode=mode.value;button.innerHTML=uiIcon(mode.icon)+'<span>'+mode.label+'</span>'+uiIcon('chevron-down');button.title=mode.description+' Alt+M 切换';button.disabled=session.busy;
 const model=$('.ai-model-chip',panel),local=aiState.config?.provider==='claude-code';
 const name=session.modelOverride||(local?aiState.config.claudeModel||'Claude 默认':aiState.config?.model||'选择模型');
 model.textContent=name+(local&&session.claudeEffort?' · '+session.claudeEffort[0].toUpperCase()+session.claudeEffort.slice(1):'');model.title='选择模型与思考强度（仅此对话）';model.disabled=session.busy;
 const context=$('.ai-context-chip',panel),path=session.cell?session.path:currentAIDocumentPath()||'';
 const pdf=typeof editorTabs==='object'?editorTabs.items.find(tab=>tab.kind==='pdf'&&tab.path===path):null;
 const label=session.cell?aiCellLabel(session.cell,session.path):(path.split('/').at(-1)||'当前工作区')+(pdf?.aiPDFPage?' · 第 '+pdf.aiPDFPage.page+' 页':'');
 const span=$('span',context);if(span)span.textContent=label;context.title=(session.busy&&path!==session.path?'下轮默认提及：':'默认提及：')+path+(pdf?'；发送时附带当前页文字和截图，手动选区优先':'');context.disabled=session.busy||!path;
 const send=$('.ai-send',panel);send.innerHTML=uiIcon('arrow-up');send.setAttribute('aria-label','发送消息');send.title='发送消息';send.disabled=!path||session.busy||!!session.imageUploads||(!session.draft.trim()&&!session.images.length&&!session.sources.length&&!session.cellSelections.length);
 const star=$('.ai-bookmark',panel);if(star){star.setAttribute('aria-pressed',String(!!session.bookmarked));star.title=session.bookmarked?'取消收藏对话':'收藏对话';}
}
document.addEventListener('pointerdown',event=>{if(!event.target.closest('.ai-composer'))for(const panel of document.querySelectorAll('.ai-note-interface'))closeAIInterfaceMenus(panel);});
document.addEventListener('keydown',event=>{
 if(!event.ctrlKey||event.key!=='Escape')return;
 const session=aiState.sessions.get(aiState.targetKey)||aiState.sessions.get(aiState.sidebarKey);if(!session)return;
 const input=aiContainers(session).map(host=>$('.ai-input',host)).find(input=>input&&!input.closest('.minimized')&&!input.closest('[hidden]'));
 if(input){event.preventDefault();event.stopPropagation();if(document.activeElement===input)input.blur();else input.focus();}
});
