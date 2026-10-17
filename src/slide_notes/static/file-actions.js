'use strict';
let workspaceKey=new URL(location.href).searchParams.get('workspace')||'legacy';
let fileDragPath=null,fileActionBusy=false;
function restoreExpanded(){try{explorer.expanded=new Set(['',...JSON.parse(localStorage.getItem('slide-notes-folders:'+workspaceKey)||'[]')]);}catch{}}
function rememberExpanded(){localStorage.setItem('slide-notes-folders:'+workspaceKey,JSON.stringify([...explorer.expanded]));}
function fileRoot(){return explorer.mode==='notes'?(explorer.notesDirectory||''):'';}
function selectedFileDirectory(){const root=fileRoot(),selected=explorer.selectedDirectory;return selected&&(!root||selected===root||selected.startsWith(root+'/'))?selected:root;}
function notebookDirectory(directory){const root=explorer.notesDirectory||'';return directory&&(!root||directory===root||directory.startsWith(root+'/'))?directory:root;}
function parentPath(path){return path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';}
function joinPath(parent,name){return parent?parent+'/'+name:name;}
function validName(name){if(!name||name==='.'||name==='..'||/[\\/\x00]/.test(name))throw Error('名称不能包含路径分隔符');return name;}
async function refreshExplorer(){resetFileDirectoryCache();await refreshFileRows();}
async function createFolder(directory=selectedFileDirectory()){
 const name=prompt('新建文件夹名称');if(name===null)return;
 try{await api('/api/files/mutate',{operation:'mkdir',path:joinPath(directory,validName(name.trim()))});explorer.expanded.add(directory);rememberExpanded();await refreshExplorer();}catch(error){toast(error.message);}
}
function newNoteIn(directory){explorer.selectedDirectory=notebookDirectory(directory);const dialog=$('#new-notebook');dialog.showModal();$('input',dialog).focus();}
function installFileToolbar(container){
 const tools=$('.files-tools',container),refresh=$('#refresh-files',container);
 for(const [id,icon,label,callback] of [['new-folder-button','folder','新建文件夹',()=>createFolder()],['trash-files-button','trash-2','回收站',openTrash]]){
  const button=document.createElement('button');button.id=id;button.className='icon-button';button.title=label;button.setAttribute('aria-label',label);button.innerHTML=uiIcon(icon);button.onclick=callback;tools.insertBefore(button,refresh);
 }
 const root=$('.files-tools strong',container);root.tabIndex=0;root.title=fileRoot()||'工作区根目录';root.onclick=()=>{explorer.selectedDirectory=fileRoot();};
 root.oncontextmenu=e=>{e.preventDefault();showFileMenu(e,{kind:'directory',path:fileRoot(),name:explorer.notesDirectory||explorer.workspace});};
 bindFileDropTarget(root,()=>fileRoot());
}
function attachFileActions(row,entry){
 if(entry.unavailable)return;
 row.oncontextmenu=e=>{e.preventDefault();selectFileTreeRow(row);showFileMenu(e,entry);};
 row.onkeydown=e=>{if(e.key==='F2'){e.preventDefault();renameFile(entry);}if(e.key==='Delete'){e.preventDefault();deleteFile(entry);}if(e.key==='F10'&&e.shiftKey){e.preventDefault();const r=row.getBoundingClientRect();showFileMenu({clientX:r.left+20,clientY:r.bottom},entry);}};
 row.draggable=true;row.ondragstart=e=>{
  fileDragPath=entry.path;selectFileTreeRow(row);e.dataTransfer.setData(fileTransferType,JSON.stringify({workspace:workspaceKey,path:entry.path}));
  const name=(entry.name+(entry.kind==='directory'?'.zip':'')).replace(/[:\r\n]/g,'_'),url=fileDownloadURL(entry);
  e.dataTransfer.setData('DownloadURL',(entry.kind==='directory'?'application/zip':'application/octet-stream')+':'+name+':'+url);
  e.dataTransfer.setData('text/uri-list',url);e.dataTransfer.effectAllowed='copyMove';
 };
 row.ondragend=()=>{fileDragPath=null;document.querySelectorAll('.file-drop-target').forEach(el=>el.classList.remove('file-drop-target'));};
 bindFileDropTarget(row,()=>entry.kind==='directory'?entry.path:parentPath(entry.path));
 row.classList.toggle('file-cut',workspaceFileClipboard?.operation==='move'&&workspaceFileClipboard.path===entry.path);
}
function showFileMenu(event,entry){
 closeFileMenu();const menu=document.createElement('div');menu.id='file-context-menu';menu.setAttribute('role','menu');
 const directory=entry.kind==='directory'?entry.path:parentPath(entry.path),actions=[];
 if(entry.kind==='directory')actions.push(['新建笔记',()=>newNoteIn(entry.path)],['新建文件夹',()=>createFolder(entry.path)],['导入文件…',()=>chooseWorkspaceFiles(entry.path)],['导入文件夹…',()=>chooseWorkspaceFiles(entry.path,true)]);
 if(entry.path&&entry.path!==explorer.notesDirectory)actions.push(['复制',()=>copyWorkspaceFile(entry)],['剪切',()=>copyWorkspaceFile(entry,true)]);
 actions.push(['粘贴',()=>pasteWorkspaceFile(directory),!workspaceFileClipboard]);
 if(entry.path)actions.push([entry.kind==='directory'?'导出文件夹（ZIP）':'导出文件',()=>downloadWorkspaceFile(entry)]);
 if(entry.path&&entry.path!==explorer.notesDirectory)actions.push(['重命名',()=>renameFile(entry)],['移动到…',()=>{const dest=prompt('目标文件夹（相对于工作区，留空为根目录）',parentPath(entry.path));if(dest!==null)moveFile(entry.path,joinPath(dest.trim(),entry.name)).catch(error=>toast(error.message));}],['移到回收站',()=>deleteFile(entry)]);
 for(const [label,action,disabled] of actions){const button=document.createElement('button');button.type='button';button.disabled=!!disabled;button.setAttribute('role','menuitem');button.textContent=label;button.onclick=()=>{closeFileMenu();Promise.resolve().then(action).catch(error=>toast(error.message));};menu.append(button);}
 document.body.append(menu);const r=menu.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(event.clientX,innerWidth-r.width-8))+'px';menu.style.top=Math.max(8,Math.min(event.clientY,innerHeight-r.height-8))+'px';$('button',menu)?.focus();
 menu.onkeydown=e=>{if(e.key==='Escape')closeFileMenu();if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const buttons=[...menu.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);buttons[(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}};
}
function closeFileMenu(){$('#file-context-menu')?.remove();}
document.addEventListener('pointerdown',e=>{if(!e.target.closest('#file-context-menu'))closeFileMenu();});
async function renameFile(entry){
 if(entry.kind==='notebook'&&explorer.mode==='notes'){
  const title=prompt('笔记名称',entry.title);if(title===null||fileActionBusy)return;
  fileActionBusy=true;
  try{await save();const current=await api('/api/document?path='+encodeURIComponent(entry.path));const result=await api('/api/notebooks/rename',{path:entry.path,title:title.trim(),revision:current.revision});if(state.path===entry.path){state.doc.title=result.document.title;state.revision=result.revision;}await remapFileState(entry.path,result.path);if(state.path===result.path&&entry.path===result.path)await openNotebook(result.path);await refreshExplorer();}
  catch(error){toast(error.message);}finally{fileActionBusy=false;}return;
 }
 const name=prompt('新名称（保留文件扩展名）',entry.name);if(name===null)return;try{await moveFile(entry.path,joinPath(parentPath(entry.path),validName(name.trim())));}catch(error){toast(error.message);}
}
async function remapFileState(path,destination){
 const remap=key=>key===path||key.startsWith(path+'/')?destination+key.slice(path.length):key;
 remapNotebookSidebar(remap);
 for(const map of [notebookSessions,notebookHistories])for(const [key,value] of [...map]){const next=remap(key);if(next!==key){map.delete(key);map.set(next,value);}}
 explorer.expanded=new Set([...explorer.expanded].map(remap));explorer.expanded.add(parentPath(destination));explorer.selectedDirectory=remap(explorer.selectedDirectory||'');
 if(fileTreeState.focusPath)fileTreeState.focusPath=remap(fileTreeState.focusPath);
 if(fileTreeState.selectedPath)fileTreeState.selectedPath=remap(fileTreeState.selectedPath);
 if(workspaceFileClipboard)workspaceFileClipboard.path=remap(workspaceFileClipboard.path);
 remapFileTreeRows(remap);
 rememberExpanded();
 const current=state.path&&remap(state.path);if(current!==state.path)state.path=current;
 await moveAIChatFiles(path,destination);remapAIChats(remap);
 await remapEditorTabs(remap);
}

async function moveFile(path,destination){
 if(path===destination||fileActionBusy)return;fileActionBusy=true;
 try{
  await save();const impact=await api('/api/files/impact?path='+encodeURIComponent(path));await api('/api/files/mutate',{operation:'move',path,destination,revision:impact.revision});
  await remapFileState(path,destination);
  await refreshExplorer();
 }finally{fileActionBusy=false;fileDragPath=null;}
}
async function deleteFile(entry){
 if(fileActionBusy)return;fileActionBusy=true;
 try{
  await save();const impact=await api('/api/files/impact?path='+encodeURIComponent(entry.path));
  const details=entry.kind==='directory'?`包含 ${impact.notes} 个笔记、${impact.otherFiles} 个其他文件（包括仅笔记视图中隐藏的文件）。\n`:'';
  if(!confirm(`将“${entry.name}”移到回收站？\n${details}之后可以恢复。`))return;
  await api('/api/files/mutate',{operation:'trash',path:entry.path,revision:impact.revision});
  await removeDeletedEditors(entry.path);
  await refreshExplorer();
 }catch(error){toast(error.message);}finally{fileActionBusy=false;}
}
async function openTrash(){
 let dialog=$('#workspace-trash');if(!dialog){dialog=document.createElement('dialog');dialog.id='workspace-trash';document.body.append(dialog);}
 try{const data=await api('/api/files/trash');dialog.replaceChildren();const heading=document.createElement('h3');heading.textContent='回收站';dialog.append(heading);
 for(const item of data.entries){const row=document.createElement('div');row.className='trash-row';const name=document.createElement('span');name.textContent=item.path;const restore=document.createElement('button');restore.textContent='恢复';restore.onclick=async()=>{try{await api('/api/files/mutate',{operation:'restore',path:item.id});await refreshExplorer();await openTrash();}catch(error){toast(error.message);}};row.append(name,restore);dialog.append(row);}
 if(!data.entries.length){const p=document.createElement('p');p.textContent='回收站为空';dialog.append(p);}const close=document.createElement('button');close.textContent='关闭';close.onclick=()=>dialog.close();dialog.append(close);if(!dialog.open)dialog.showModal();
 }catch(error){toast(error.message);}
}
let refreshingFiles=false;
setInterval(async()=>{if(document.hidden||state.panel!=='files'||fileActionBusy||refreshingFiles||fileDragPath||$('#file-context-menu')||document.querySelector('dialog[open]'))return;refreshingFiles=true;try{await refreshExplorer();}finally{refreshingFiles=false;}},4000);
