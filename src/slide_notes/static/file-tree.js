'use strict';
// Tree focus belongs to a path, independently of the editor's active document.
const fileTreeState={focusPath:null,selectedPath:null,typeBuffer:'',typeTime:0,
 autoReveal:localStorage.getItem('slide-notes-auto-reveal:'+workspaceKey)!=='false'};
function fileTreeRows(){return [...($('#file-tree')?.querySelectorAll('.file-row:not(:disabled)')||[])];}
function resetFileDirectoryCache(){explorer.directories=new Map();}
function setFileTreeAttribute(element,name,value){
 if(value===null){if(element.hasAttribute(name))element.removeAttribute(name);}
 else if(element.getAttribute(name)!==String(value))element.setAttribute(name,String(value));
}
function selectFileTreeRow(row,focus=false){
 if(!row)return;
 fileTreeState.focusPath=row.dataset.path;fileTreeState.selectedPath=row.dataset.path;
 explorer.selectedDirectory=row.dataset.kind==='directory'?row.dataset.path:parentPath(row.dataset.path);
 for(const item of fileTreeRows()){
  setFileTreeAttribute(item,'tabindex',item===row?0:-1);
  setFileTreeAttribute(item,'aria-selected',item===row);
 }
 if(focus){row.focus({preventScroll:true});row.scrollIntoView({block:'nearest'});}
}
function commitFileTree(list,draw){
 // Check focus at commit time: an in-flight refresh must not steal it from an editor.
 const focused=list.contains(document.activeElement)?document.activeElement.closest('.file-row'):null;
 const previous=fileTreeState.focusPath||focused?.dataset.path;
 const scroller=$('#inspector-content'),scroll=scroller?.scrollTop;
 draw();
 const rows=fileTreeRows();let path=previous,row;
 while(path&&!row){row=rows.find(item=>item.dataset.path===path);path=parentPath(path);}
 row ||= rows.find(item=>item.dataset.path===editorTabs.active)||rows[0];
 setFileTreeAttribute(list,'tabindex',rows.length?-1:0);
 if(row){
  fileTreeState.focusPath=row.dataset.path;
  if(focused||!rows.some(item=>item.dataset.path===fileTreeState.selectedPath))fileTreeState.selectedPath=row.dataset.path;
  for(const item of rows){setFileTreeAttribute(item,'tabindex',item===row?0:-1);setFileTreeAttribute(item,'aria-selected',item.dataset.path===fileTreeState.selectedPath);}
  if(focused&&document.activeElement!==row)row.focus({preventScroll:true});
 }else fileTreeState.focusPath=null;
 if(focused&&!row)list.focus({preventScroll:true});
 if(scroller&&scroller.scrollTop!==scroll)scroller.scrollTop=scroll;
}
// Keep DOM identity through polling, sorting, imports and file moves. Unchanged
// snapshots perform no DOM writes, so hover, native focus and paint stay stable.
function reconcileFileTree(list,descriptors,notice=null){
 const existing=new Map([...list.querySelectorAll(':scope > .file-row')].map(row=>[row.dataset.path,row]));
 const wanted=descriptors.map(item=>fileRow(item.entry,item.depth,item.showPath,item.index,item.size,existing.get(item.entry.path)));
 if(notice){
  const node=list.querySelector(':scope > .file-tree-notice')||document.createElement('p');
  const className='file-tree-notice '+(notice.empty?'panel-empty':'panel-footnote');
  if(node.className!==className)node.className=className;
  if(node.textContent!==notice.text)node.textContent=notice.text;
  wanted.push(node);
 }
 const retained=new Set(wanted);
 for(const child of [...list.childNodes])if(!retained.has(child))child.remove();
 let next=list.firstChild;
 for(const node of wanted){if(node===next)next=next.nextSibling;else list.insertBefore(node,next);}
}
function remapFileTreeRows(remap){
 for(const row of $('#file-tree')?.querySelectorAll('.file-row')||[]){
  const path=remap(row.dataset.path);if(path===row.dataset.path)continue;
  // Handlers share this entry object; update it before the next server snapshot.
  const entry=row.fileEntry;
  if(entry){entry.path=path;entry.name=path.split('/').at(-1);}
  row.dataset.path=path;row.title=path;
 }
}
async function toggleFileTreeDirectory(path,expand=!explorer.expanded.has(path)){
 if(expand){await loadDirectory(path);explorer.expanded.add(path);}else explorer.expanded.delete(path);
 rememberExpanded();await refreshFileRows();
}
function installFileTree(list){
 list.setAttribute('role','tree');list.setAttribute('aria-label','工作区文件目录树');
 list.addEventListener('focusin',event=>{const row=event.target.closest('.file-row');if(row)selectFileTreeRow(row);});
 list.onkeydown=async event=>{
  if(event.defaultPrevented||event.isComposing||event.altKey||event.ctrlKey||event.metaKey)return;
  const row=event.target.closest('.file-row'),rows=fileTreeRows();if(!row||!rows.includes(row))return;
  if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End','Enter',' '].includes(event.key)&&event.key.length!==1)return;
  // Notebook shortcuts (including presentation arrows) must not handle tree navigation.
  event.preventDefault();event.stopPropagation();
  const index=rows.indexOf(row),path=row.dataset.path,isDir=row.dataset.kind==='directory';
  let target;
  try{
   switch(event.key){
    case 'ArrowDown':target=rows[Math.min(index+1,rows.length-1)];break;
    case 'ArrowUp':target=rows[Math.max(index-1,0)];break;
    case 'Home':target=rows[0];break;
    case 'End':target=rows.at(-1);break;
    case 'ArrowRight':
     event.preventDefault();
     if(isDir&&!explorer.expanded.has(path))await toggleFileTreeDirectory(path,true);
     else if(isDir&&Number(rows[index+1]?.dataset.depth)>Number(row.dataset.depth))target=rows[index+1];
     break;
    case 'ArrowLeft':
     event.preventDefault();
     if(isDir&&explorer.expanded.has(path))await toggleFileTreeDirectory(path,false);
     else target=rows.find(item=>item.dataset.path===parentPath(path));
     break;
    case 'Enter':case ' ':event.preventDefault();await row.onclick();break;
    default:{
     if(event.key.length!==1)return;
     const now=Date.now(),key=event.key.toLocaleLowerCase();
     fileTreeState.typeBuffer=now-fileTreeState.typeTime>800?'':fileTreeState.typeBuffer;
     const cycle=fileTreeState.typeBuffer===key;
     fileTreeState.typeBuffer=cycle?key:fileTreeState.typeBuffer+key;fileTreeState.typeTime=now;
     const start=fileTreeState.typeBuffer.length===1?index+1:index;
     target=Array.from({length:rows.length},(_,offset)=>rows[(start+offset)%rows.length])
      .find(item=>item.dataset.label.toLocaleLowerCase().startsWith(fileTreeState.typeBuffer));
    }
   }
   event.preventDefault();if(target)selectFileTreeRow(target,true);
  }catch(error){toast(error.message);}
 };
}
async function revealActiveFile({automatic=false}={}){
 const path=editorTabs.active,root=fileRoot();
 if(automatic&&!fileTreeState.autoReveal)return refreshFileRows();
 if(!path||root&&path!==root&&!path.startsWith(root+'/')){
  if(!automatic)toast(path?'当前文件不在“仅笔记”目录中，请切换到工作区文件。':'尚未打开文件');
  return refreshFileRows();
 }
 if(explorer.query&&!automatic){explorer.query='';const input=$('#file-search');if(input)input.value='';}
 // Automatic reveal leaves a user's active search intact.
 if(explorer.query)return refreshFileRows();
 for(let parent=parentPath(path);parent&&parent!==root;parent=parentPath(parent))explorer.expanded.add(parent);
 rememberExpanded();await refreshFileRows();
 const row=fileTreeRows().find(item=>item.dataset.path===path);
 if(row){if(!automatic)selectFileTreeRow(row,true);else row.scrollIntoView({block:'nearest'});}
}
async function collapseFileTree(){
 explorer.expanded=new Set(['']);rememberExpanded();await refreshFileRows();
}
function installFileTreeToolbar(container){
 const tools=document.createElement('div');tools.className='file-tree-tools';tools.setAttribute('role','group');tools.setAttribute('aria-label','目录树操作');
 for(const [id,icon,label,callback] of [
  ['reveal-active-file','locate-fixed','定位当前文件',()=>revealActiveFile()],
  ['collapse-file-tree','list-collapse','全部折叠',collapseFileTree],
  ['auto-reveal-file','focus','自动定位当前文件',()=>{fileTreeState.autoReveal=!fileTreeState.autoReveal;localStorage.setItem('slide-notes-auto-reveal:'+workspaceKey,String(fileTreeState.autoReveal));sync();if(fileTreeState.autoReveal)return revealActiveFile({automatic:true});}],
  ['hide-workspace-config','eye-off','隐藏配置文件',async()=>{
   explorer.hideConfig=explorer.hideConfig===false;localStorage.setItem('slide-notes-hide-workspace-config:'+workspaceKey,String(explorer.hideConfig));
   explorer.selectedDirectory=fileRoot();sync();await refreshExplorer();
  }]
 ]){
  const button=document.createElement('button');button.id=id;button.type='button';button.className='icon-button';button.title=label;button.setAttribute('aria-label',label);button.innerHTML=uiIcon(icon);
  button.onclick=()=>Promise.resolve().then(callback).catch(error=>toast(error.message));tools.append(button);
 }
 function sync(){
  $('#auto-reveal-file',tools).setAttribute('aria-pressed',String(fileTreeState.autoReveal));
  const hide=$('#hide-workspace-config',tools);hide.setAttribute('aria-pressed',String(explorer.hideConfig!==false));hide.disabled=explorer.mode==='notes';
  hide.title=explorer.mode==='notes'?'仅笔记视图已隐藏配置文件':'隐藏配置文件 · 保留 notebooks 和用户内容';
 }
 sync();$('.files-tools',container).after(tools);
}
