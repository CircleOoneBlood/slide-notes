'use strict';
let draggedCell=null;
let copiedNotebookCell=null;
function hasCopiedCell(){return copiedNotebookCell!==null;}
function copyNotebookCell(cell){
  copiedNotebookCell=structuredClone(cell);
  closeCellMenus();closeCellAddMenus();
  document.querySelectorAll('[data-paste-cell]').forEach(button=>{button.disabled=button.dataset.pasteBlocked==='true';});
  toast('Cell 已复制；切换页面后，在 ＋ 菜单中粘贴');
}
function pasteNotebookCell(index,target=null,side='bottom'){
  if(!copiedNotebookCell){toast('请先在 cell 的 ⋯ 菜单中选择“复制 cell”');return;}
  if(state.mode!=='edit')return;
  const cell=structuredClone(copiedNotebookCell);cell.id=uid();
  // A page's row/column IDs and drag offsets never travel with the clipboard.
  delete cell.layout;
  if(target){
    if(side==='right'){if(!insertBeside(target,cell))return;}
    else insertInColumn(target,cell);
  }else slide().cells.splice(index,0,cell);
  closeCellMenus();closeCellAddMenus();state.selectedCell=cell.id;
  dirty(cell.kind==='code');render();
  document.getElementById('cell-'+cell.id)?.scrollIntoView({block:'nearest'});
  toast('Cell 已粘贴');
  return cell;
}

function codeAction(icon,label,callback) {
  const button=document.createElement('button');button.type='button';button.className='code-action';
  button.innerHTML=uiIcon(icon);button.title=label;button.setAttribute('aria-label',label);button.onclick=callback;
  return button;
}
function closeCellMenus() {
  document.querySelectorAll('.code-settings').forEach(menu=>{
    menu.hidden=true;
    menu.querySelectorAll('[role="tooltip"]').forEach(tip=>tip.hidden=true);
    menu.parentElement.querySelector('[aria-label="Cell 更多设置"]')?.setAttribute('aria-expanded','false');
  });
}
document.addEventListener('pointerdown',event=>{
  if(!event.target.closest('.markdown-mode-menu,.markdown-edit'))document.querySelectorAll('.markdown-mode-menu').forEach(menu=>{menu.parentElement.querySelector('.markdown-edit')?.setAttribute('aria-expanded','false');menu.remove();});
  if(!event.target.closest('.code-settings,.code-more'))closeCellMenus();
  if(!event.target.closest('.cell-add-menu,.cell-add-beside'))closeCellAddMenus();
});
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape')return;
  const open=document.querySelector('.code-settings:not([hidden])');
  if(open){closeCellMenus();open.parentElement.querySelector('.code-more')?.focus();}
});

function renderNotebookCell(cell,index) {
  const isMarkdown=cell.kind==='markdown';
  const isHtml=cell.kind==='html';
  const runCell=()=>{
    if(isHtml){updateHtmlOutput(cell,true);save().catch(error=>toast(error.message));}
    else execute({target:cell.id});
  };
  const card=document.createElement('section');card.className='cell code-cell'+(isMarkdown?' markdown-cell':'');card.id='cell-'+cell.id;card.dataset.cell=cell.id;
  card.dataset.showCode=String(!!cell.showCode);card.dataset.display=cell.display;
  card.dataset.codeCollapsed=String(!!cell.codeCollapsed);
  card.classList.toggle('cell-selected',state.selectedCell===cell.id);
  card.addEventListener('pointerdown',()=>selectCell(cell.id));
  const shell=document.createElement('div');shell.className='code-shell';
  const editor=document.createElement('div');editor.className='code-editor-host';shell.append(editor);
  const actions=document.createElement('div');actions.className='code-actions';
  const edit=codeAction('square-pen','Markdown 视图',()=>showMarkdownModes());
  edit.classList.add('markdown-edit');
  const run=codeAction('play',isHtml?'渲染 HTML':'运行此 cell 及下游',runCell);run.classList.add(isHtml?'html-cell-run':'cell-run');run.disabled=!isHtml&&state.busy;
  const stop=codeAction('square','停止当前笔记计算',()=>$('#interrupt').click());stop.classList.add('cell-stop');stop.disabled=!state.busy;
  const collapse=codeAction('eye-off','隐藏代码',()=>setPythonCodeCollapsed(!cell.codeCollapsed));
  collapse.classList.add('cell-code-collapse');collapse.setAttribute('aria-controls','code-editor-'+cell.id);
  editor.id='code-editor-'+cell.id;
  const menu=document.createElement('div');menu.className='code-settings';menu.hidden=true;
  const more=codeAction('ellipsis','Cell 更多设置',()=>{
    const open=menu.hidden;closeCellMenus();closeCellAddMenus();menu.hidden=!open;more.setAttribute('aria-expanded',String(open));
    if(open)requestAnimationFrame(()=>{
      if(!menu.isConnected||menu.hidden)return;
      menu.style.maxWidth=Math.min(290,$('#main').clientWidth-20)+'px';
      menu.classList.toggle('code-settings-left',menu.getBoundingClientRect().left<$('#main').getBoundingClientRect().left+8);
      menu.scrollIntoView({block:'nearest',inline:'nearest'});
    });
  });more.classList.add('code-more');more.setAttribute('aria-expanded','false');
  if(isMarkdown)actions.append(edit,more);else if(isHtml)actions.append(run,collapse,more);else actions.append(run,stop,collapse,more);
  const aiAction=codeAction('sparkles','与 AI 讨论此 cell',()=>openCellAI(cell.id));aiAction.classList.add('cell-ai');actions.insertBefore(aiAction,more);
  shell.append(actions);

  menu.setAttribute('aria-label','Cell 设置');
  const heading=document.createElement('div');heading.className='code-settings-title';
  const number=document.createElement('span');number.textContent='CELL '+cellNumber(cell.id);
  const kind=document.createElement('span');kind.className='cell-kind-badge';kind.textContent=isMarkdown?'Markdown':isHtml?'HTML':'Python';
  heading.append(number,kind);menu.append(heading);
  function withHint(control,text,id) {
    const wrapper=document.createElement('div');wrapper.className='cell-setting-hint';
    const tip=document.createElement('div');tip.className='cell-setting-tooltip';tip.id=id;
    tip.setAttribute('role','tooltip');tip.textContent=text;tip.hidden=true;
    control.setAttribute('aria-describedby',id);wrapper.append(control,tip);
    const show=()=>{
      menu.querySelectorAll('[role="tooltip"]').forEach(other=>other.hidden=true);
      tip.classList.remove('tooltip-above');tip.hidden=false;
      if(tip.getBoundingClientRect().bottom>$('#main').getBoundingClientRect().bottom-8)tip.classList.add('tooltip-above');
    };
    wrapper.onpointerenter=show;wrapper.onpointerleave=()=>{tip.hidden=true;};
    wrapper.onfocusin=show;wrapper.onfocusout=event=>{if(!wrapper.contains(event.relatedTarget))tip.hidden=true;};
    return wrapper;
  }
  const displayLabel=document.createElement('div');displayLabel.className='cell-setting-label';displayLabel.id='display-label-'+cell.id;displayLabel.textContent='放映方式';menu.append(displayLabel);
  const display=document.createElement('div');display.className='cell-display-options';display.setAttribute('role','radiogroup');display.setAttribute('aria-labelledby',displayLabel.id);
  const modes=[
    ['normal','Slide','panels-top-left','随当前页面直接显示。'],
    ['fragment','Fragment','layers-2','放映时按下一步，依次显示此内容。'],
    ['skip','Skip','eye-off',isMarkdown?'放映时隐藏，编辑时仍可查看。':'放映时隐藏，代码仍参与计算。'],
  ];
  const modeButtons=[];
  function selectDisplay(value) {
    cell.display=value;card.dataset.display=value;
    modeButtons.forEach(option=>{const selected=option.dataset.value===value;option.setAttribute('aria-checked',String(selected));option.tabIndex=selected?0:-1;});
    dirty();renderSidebar();applyVisibility();
  }
  for(const [value,label,icon,hint] of modes){
    const option=document.createElement('button');option.type='button';option.className='cell-display-option';option.dataset.value=value;
    option.setAttribute('role','radio');option.setAttribute('aria-checked',String(cell.display===value));option.tabIndex=cell.display===value?0:-1;
    option.innerHTML=uiIcon(icon)+'<span>'+label+'</span>';option.onclick=()=>selectDisplay(value);
    option.onkeydown=event=>{
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
      event.preventDefault();event.stopPropagation();
      const current=modeButtons.indexOf(option),delta=['ArrowLeft','ArrowUp'].includes(event.key)?-1:1;
      const index=event.key==='Home'?0:event.key==='End'?2:(current+delta+3)%3;
      selectDisplay(modes[index][0]);modeButtons[index].focus();
    };
    modeButtons.push(option);display.append(withHint(option,hint,'display-hint-'+cell.id+'-'+value));
  }
  menu.append(display);
  if(!isMarkdown){
    const showCode=document.createElement('button');showCode.type='button';showCode.className='cell-code-toggle';
    showCode.setAttribute('role','switch');showCode.setAttribute('aria-checked',String(!!cell.showCode));showCode.setAttribute('aria-label','放映时显示代码');
    showCode.innerHTML='<span class="cell-toggle-label">'+uiIcon('code-xml')+'<span>放映时显示代码</span></span><span class="cell-switch-track" aria-hidden="true"><span></span></span>';
    showCode.onclick=()=>{cell.showCode=!cell.showCode;card.dataset.showCode=String(cell.showCode);showCode.setAttribute('aria-checked',String(cell.showCode));dirty();};
    const row=withHint(showCode,'开启后同时展示代码与运行结果；关闭后只展示运行结果。','code-hint-'+cell.id);
    row.classList.add('cell-code-toggle-row');menu.append(row);
  }
  menu.append(cellLayoutControls(cell,card,shell));
  const order=document.createElement('div');order.className='code-order';
  const orderLabel=document.createElement('span');orderLabel.textContent='调整顺序';order.append(orderLabel);
  order.append(button('↑','Cell 上移',()=>moveCell(index,-1),index===0),button('↓','Cell 下移',()=>moveCell(index,1),index===slide().cells.length-1));menu.append(order);
  shell.append(menu);
  const copy=codeAction('file-text','复制 cell',()=>copyNotebookCell(cell));copy.classList.add('cell-copy');
  const copyLabel=document.createElement('span');copyLabel.textContent='复制 cell';copy.append(copyLabel);menu.append(copy);
  const trash=codeAction('trash-2','删除 cell',()=>snapshotUndo('已删除 cell',()=>removeLayoutCell(cell),cell.kind==='code'));trash.classList.add('cell-delete');
  const trashLabel=document.createElement('span');trashLabel.textContent='删除 cell';trash.append(trashLabel);menu.append(trash);
  const timing=document.createElement('span');timing.className='cell-timing';timing.title='上次 Python 执行耗时（不含浏览器渲染）';if(cell.kind==='code')shell.append(timing);
  const status=document.createElement('span');status.className='cell-status';shell.append(status);
  const handle=codeAction('grip-vertical','拖动调整 cell 顺序',()=>{});handle.classList.add('cell-drag-handle');handle.draggable=true;
  handle.title='拖到同列 cell 的上方或下方排序；空隙内可微调位置';
  bindCellPointerDrag(handle,cell,card);
  handle.onkeydown=event=>{
    if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    const direction=['ArrowUp','ArrowLeft'].includes(event.key)?-1:1;
    if(['ArrowUp','ArrowDown'].includes(event.key)){
      const group=columnForCell(cell).cells,target=group[group.indexOf(cell)+direction];
      if(target)placeLayoutCell(cell,target,direction<0?'top':'bottom');
      else moveCellVertically(cell,direction*12);
    }else{
      const columns=rowColumns(rowForCell(cell).cells),at=columns.findIndex(column=>column.cells.includes(cell)),target=columns[at+direction]?.cells[0];
      if(target)placeLayoutCell(cell,target,direction<0?'left':'right');
    }
  };
  shell.append(handle);card.append(shell);
  renderCellAI(card,cell.id);
  const preview=document.createElement('div');preview.className='markdown-preview obsidian-markdown markdown-rendered';
  let markdownDispose=null,markdownView='live';
  const markdownViewKey=()=> 'slide-notes-md-view:'+JSON.stringify([new URL(location.href).searchParams.get('workspace')||'legacy',state.path,cell.id]);
  if(isMarkdown){try{const saved=localStorage.getItem(markdownViewKey());if(['live','source','reading'].includes(saved))markdownView=saved;}catch{}}
  card.dataset.markdownPath=state.path||'';
  const refreshMarkdown=()=>{
    if(!isMarkdown||!editor.hidden)return;
    markdownDispose?.();preview.innerHTML=renderNoteMarkdown(cell.source);
    markdownDispose=bindMarkdownPreview(preview,{read:()=>cell.source,enabled:()=>state.mode==='edit',commit:change=>{
      createEditor();card.codeEditor.dispatch({changes:change,userEvent:'input'});refreshMarkdown();save().catch(()=>{});
    }});
  };
  function createEditor() {
    if(card.codeEditor)return;
    card.codeEditor=NotebookCodeEditor.create({parent:editor,source:cell.source,
      label:`${isMarkdown?'Markdown':isHtml?'HTML':'Python'} cell ${cellNumber(cell.id)}`,
      language:isMarkdown?'markdown':isHtml?'html':'python',readonly:state.mode==='present',
      onChange:value=>{
        cell.source=value;dirty(cell.kind==='code','source:'+cell.id);
        if(isMarkdown){refreshMarkdown();if(state.panel==='outline')drawOutline();}
      },
      markdownMode:markdownView==='source'?'source':'live',
      markdownBlocks:isMarkdown?ObsidianMarkdown.blocks:undefined,renderMarkdown:isMarkdown?(source,documentSource,offset)=>renderNoteMarkdown(source,documentSource,state.path||'',offset):undefined,bindMarkdownPreview:isMarkdown?bindMarkdownPreview:undefined,
      onMarkdownModeChange:isMarkdown?mode=>{markdownView=mode;syncMarkdownModeLabel();try{localStorage.setItem(markdownViewKey(),mode);}catch{}}:undefined,
      onRun:()=>isMarkdown?setMarkdownEditing(false):runCell(),onBlur:renderSidebar});
  }
  function syncPythonCodeVisibility() {
    const collapsed=!!cell.codeCollapsed;
    card.dataset.codeCollapsed=String(collapsed);
    const visible=state.mode==='present'?!!cell.showCode:!collapsed;
    editor.hidden=!visible;
    const label=collapsed?'展开代码':'隐藏代码';
    collapse.innerHTML=uiIcon(collapsed?'code-xml':'eye-off');collapse.title=label;
    collapse.setAttribute('aria-label',label);collapse.setAttribute('aria-expanded',String(!collapsed));
    if(visible){createEditor();card.codeEditor.requestMeasure();}
  }
  function setPythonCodeCollapsed(collapsed,focusEditor=false) {
    if(state.mode!=='edit')return;
    if(!!cell.codeCollapsed!==collapsed){cell.codeCollapsed=collapsed;dirty();}
    syncPythonCodeVisibility();
    if(focusEditor&&!collapsed)card.codeEditor.focus();
    else collapse.focus();
    resizePlots();
  }
  function syncMarkdownModeLabel(){
    const mode=state.mode==='present'?'reading':markdownView,label={live:'实时预览',source:'源码模式',reading:'阅读视图'}[mode];
    edit.innerHTML=uiIcon(mode==='reading'?'eye':mode==='source'?'code-xml':'square-pen');edit.title=label+' · 选择 Markdown 视图';edit.setAttribute('aria-label',label+' · Markdown 视图');edit.setAttribute('aria-haspopup','menu');card.dataset.markdownMode=mode;
  }
  function setMarkdownView(mode,focus=true){
    if(state.mode==='present')mode='reading';else{markdownView=mode;try{localStorage.setItem(markdownViewKey(),mode);}catch{}}
    if(mode==='source')state.markdownEditing.add(cell.id);else state.markdownEditing.delete(cell.id);
    editor.hidden=mode==='reading';preview.hidden=mode!=='reading';card.classList.toggle('markdown-editing',mode!=='reading');
    if(mode==='reading'){refreshMarkdown();if(focus){save().catch(()=>{});edit.focus();}}
    else{createEditor();NotebookCodeEditor.setMarkdownMode(card.codeEditor,mode);card.codeEditor.requestMeasure();if(focus)card.codeEditor.focus();}
    syncMarkdownModeLabel();resizePlots();
  }
  function setMarkdownEditing(editing,focus=true){setMarkdownView(editing?'live':'reading',focus);}
  function showMarkdownModes(){
    const existing=$('.markdown-mode-menu',card);if(existing){existing.remove();edit.setAttribute('aria-expanded','false');return;}
    const menu=document.createElement('div');menu.className='markdown-mode-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','Markdown 视图');
    for(const [mode,label] of [['live','实时预览'],['source','源码模式'],['reading','阅读视图']]){
      const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('role','menuitemradio');button.setAttribute('aria-checked',String(mode===markdownView));
      button.onclick=()=>{menu.remove();edit.setAttribute('aria-expanded','false');setMarkdownView(mode);};menu.append(button);
    }
    menu.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();menu.remove();edit.setAttribute('aria-expanded','false');edit.focus();}};
    actions.append(menu);edit.setAttribute('aria-expanded','true');$('button',menu)?.focus();
  }
  if(isMarkdown){
    shell.append(preview);card.startEditing=()=>setMarkdownView(markdownView==='reading'?'live':markdownView);
    card.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='e'&&state.mode==='edit'){
      event.preventDefault();event.stopPropagation();setMarkdownView(editor.hidden?'live':'reading');
    }});
    setMarkdownView(state.mode==='present'?'reading':markdownView,false);
  }else{
    let output=state.outputs.get(cell.id);
    if(!output){output=document.createElement('div');output.className='cell-output';state.outputs.set(cell.id,output);}
    card.append(output);if(isHtml)updateHtmlOutput(cell);else updateOutput(cell);syncCodeCellStatus(card,cell);syncPythonCodeVisibility();
    card.startEditing=()=>setPythonCodeCollapsed(false,true);
  }
  return card;
}
function syncCodeCellStatus(card,cell) {
  const ms=state.runtime?.outputs[cell.id]?.durationMs;
  const time=$('.cell-timing',card);if(time)time.textContent=Number.isFinite(ms)?(ms<1?ms.toFixed(1):Math.round(ms))+'ms':'';
  const status=$('.cell-status',card);if(status)status.textContent=state.runtime?.errors[cell.id]?'运行失败':'';
}
function refreshCodeActions() {
  document.querySelectorAll('.cell-run').forEach(button=>button.disabled=state.busy);
  document.querySelectorAll('.cell-stop').forEach(button=>button.disabled=!state.busy);
}
function focusCellEditor(cell) {
  const card=document.getElementById('cell-'+cell.id);if(!card)return;
  if(card.startEditing)card.startEditing();
  else card.codeEditor?.focus();
  card.scrollIntoView({behavior:'smooth',block:'center'});
}
function destroyCodeEditors() {
  document.querySelectorAll('.code-cell').forEach(card=>{card.codeEditor?.destroy();card.codeEditor=null;});
}
