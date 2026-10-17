'use strict';
let slideContext=null,slideContextTrigger=null;
function closeSlideContext(restoreFocus=false){
  slideContext?.remove();slideContext=null;
  if(restoreFocus&&slideContextTrigger?.isConnected)slideContextTrigger.focus();
  slideContextTrigger=null;
}
function deleteSlideAt(index){
  if(state.doc.slides.length<=1||index<0||index>=state.doc.slides.length)return;
  closeSlideContext();const activeId=slide().id;
  snapshotUndo('',()=>{
    state.doc.slides.splice(index,1);
    const remaining=state.doc.slides.findIndex(page=>page.id===activeId);
    state.active=remaining>=0?remaining:Math.min(index,state.doc.slides.length-1);
  },true);
  $('#slide-list .slide-tab.active')?.focus();
}
function openSlideContext(event,index,trigger){
  event.preventDefault();closeSlideContext();closeCellMenus();closeCellAddMenus();
  slideContextTrigger=trigger;
  const menu=document.createElement('div');menu.className='slide-context-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','页面操作');menu.tabIndex=-1;
  const print=document.createElement('button');print.type='button';print.setAttribute('role','menuitem');print.innerHTML=uiIcon('download')+'<span>导出此页 PDF / 打印…</span>';print.onclick=()=>{closeSlideContext();openNotebookPrintDialog('page',index);};menu.append(print);
  const action=document.createElement('button');action.type='button';action.setAttribute('role','menuitem');action.innerHTML=uiIcon('trash-2')+'<span>删除页面</span>';
  action.disabled=state.doc.slides.length===1;
  action.title=action.disabled?'至少保留一个页面':'删除此页面（Ctrl+Z 撤销）';action.onclick=()=>deleteSlideAt(index);menu.append(action);
  document.body.append(menu);slideContext=menu;
  const rect=trigger.getBoundingClientRect();
  const x=event.clientX||rect.left+12,y=event.clientY||rect.top+20;
  menu.style.left=clamp(x,8,innerWidth-menu.offsetWidth-8)+'px';menu.style.top=clamp(y,8,innerHeight-menu.offsetHeight-8)+'px';
  print.focus();
  menu.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeSlideContext(true);}if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const items=[...menu.querySelectorAll('button:not(:disabled)')],at=items.indexOf(document.activeElement);items[(at+(e.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();}};
}
document.addEventListener('pointerdown',event=>{if(slideContext&&!slideContext.contains(event.target))closeSlideContext();});
window.addEventListener('resize',()=>closeSlideContext());
document.addEventListener('scroll',()=>closeSlideContext(),true);
