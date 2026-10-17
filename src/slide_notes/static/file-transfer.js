'use strict';
const fileTransferType='application/x-slide-notes-file';
let workspaceFileClipboard=null;
function fileDownloadURL(entry){
 const url=new URL('/api/files/export',location.href);url.searchParams.set('path',entry.path);
 if(workspaceKey!=='legacy')url.searchParams.set('workspace',workspaceKey);
 return url.href;
}
function downloadWorkspaceFile(entry){
 const link=document.createElement('a');link.href=fileDownloadURL(entry);link.download=entry.name+(entry.kind==='directory'?'.zip':'');
 document.body.append(link);link.click();link.remove();
}
function syncFileClipboard(){
 for(const row of fileTreeRows())row.classList.toggle('file-cut',workspaceFileClipboard?.operation==='move'&&row.dataset.path===workspaceFileClipboard.path);
}
function setFileClipboard(entry,cut=false){
 if(!entry?.path||entry.path===explorer.notesDirectory||entry.unavailable)return;
 workspaceFileClipboard={path:entry.path,name:entry.name,kind:entry.kind,operation:cut?'move':'copy',workspace:workspaceKey};syncFileClipboard();
}
function copyWorkspaceFile(entry,cut=false){setFileClipboard(entry,cut);navigator.clipboard?.writeText(entry.path).catch(()=>{});}
function focusedFileEntry(target=document.activeElement){
 const row=target?.closest?.('.file-row');
 return row?{path:row.dataset.path,name:row.dataset.path.split('/').at(-1),kind:row.dataset.kind}:null;
}
async function transferWorkspaceFile(path,directory,copy=false){
 const destination=joinPath(directory,path.split('/').at(-1));
 if(!copy)return moveFile(path,destination);
 if(fileActionBusy)return;fileActionBusy=true;
 try{
  await save();const impact=await api('/api/files/impact?path='+encodeURIComponent(path));
  const result=await api('/api/files/mutate',{operation:'copy',path,destination,revision:impact.revision});
  explorer.expanded.add(directory);fileTreeState.focusPath=result.path;fileTreeState.selectedPath=result.path;rememberExpanded();
  await refreshExplorer();return result;
 }finally{fileActionBusy=false;}
}
async function pasteWorkspaceFile(directory=selectedFileDirectory()){
 const item=workspaceFileClipboard;if(!item||item.workspace!==workspaceKey||fileActionBusy)return;
 await transferWorkspaceFile(item.path,directory,item.operation==='copy');
 if(item.operation==='move'&&workspaceFileClipboard===item)workspaceFileClipboard=null;
 syncFileClipboard();
}
function isExternalFileTransfer(transfer){return !fileDragPath&&[...transfer?.types||[]].includes('Files');}
function bindFileDropTarget(node,directory){
 const active=()=>node.id!=='inspector-content'||state.panel==='files'&&!!$('#file-tree',node);
 node.ondragover=event=>{
  if(!active()||!fileDragPath&&!isExternalFileTransfer(event.dataTransfer))return;
  event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=fileDragPath&&!event.ctrlKey&&!event.altKey?'move':'copy';node.classList.add('file-drop-target');
 };
 node.ondragleave=event=>{if(!node.contains(event.relatedTarget))node.classList.remove('file-drop-target');};
 node.ondrop=event=>{
  if(!active()||!fileDragPath&&!isExternalFileTransfer(event.dataTransfer))return;
  event.preventDefault();event.stopPropagation();document.querySelectorAll('.file-drop-target').forEach(el=>el.classList.remove('file-drop-target'));
  const dest=directory(),path=fileDragPath;
  if(path){transferWorkspaceFile(path,dest,event.ctrlKey||event.altKey).catch(error=>toast(error.message));return;}
  // Capture File/Entry handles during the drop event, before its protected
  // data store becomes inaccessible to asynchronous code.
  const items=[...event.dataTransfer.items||[]].filter(item=>item.kind==='file');
  const handles=items.map(item=>({entry:item.webkitGetAsEntry?.(),file:item.getAsFile()}));
  if(!handles.length)handles.push(...[...event.dataTransfer.files].map(file=>({file})));
  importWorkspaceHandles(handles,dest).catch(error=>toast(error.message));
 };
}
// Dropping outside the directory tree must not navigate away from an unsaved
// notebook, nor turn another tool panel into an invisible import target.
document.addEventListener('dragover',event=>{if(!event.defaultPrevented&&isExternalFileTransfer(event.dataTransfer)){event.preventDefault();event.dataTransfer.dropEffect='none';}});
document.addEventListener('drop',event=>{if(!event.defaultPrevented&&isExternalFileTransfer(event.dataTransfer)){event.preventDefault();toast('请将文件拖到目录树中的文件夹或空白处导入。');}});
async function readDroppedEntry(entry,prefix=''){
 const path=joinPath(prefix,entry.name);
 if(entry.isFile){const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));return [{path,file}];}
 const result=[{path,directory:true}],reader=entry.createReader();
 while(true){const batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!batch.length)break;
  for(const child of batch)result.push(...await readDroppedEntry(child,path));
 }return result;
}
async function importWorkspaceHandles(handles,directory){
 if(fileActionBusy)throw Error('文件操作正在进行，请稍后重试');fileActionBusy=true;
 const errors=[];let imported=0;
 try{
  await save();
  const roots=new Map();
  for(const handle of handles){
   const files=handle.entry?await readDroppedEntry(handle.entry):handle.file?[{path:handle.file.webkitRelativePath||handle.file.name,file:handle.file}]:[];
   for(const item of files){const name=item.path.split('/')[0];if(!roots.has(name))roots.set(name,[]);roots.get(name).push(item);}
  }
  for(const [name,items] of roots){
   const folder=items.some(item=>item.directory||item.path.includes('/'));let root=joinPath(directory,name);
   try{
    if(folder)root=(await api('/api/files/import-directory',{path:root})).path;
    for(const item of items){
     const path=folder?root+item.path.slice(name.length):root;
     if(item.directory){if(path!==root)await api('/api/files/mutate',{operation:'mkdir',path});continue;}
     if(item.file.size>100*1024*1024)throw Error(item.file.name+' 超过单文件 100 MB 限制');
     const url=new URL('/api/files/import',location.href);url.searchParams.set('path',path);if(workspaceKey!=='legacy')url.searchParams.set('workspace',workspaceKey);
     const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:item.file});
     const data=await response.json();if(!response.ok)throw Error(data.error||'文件导入失败');imported++;
    }
   }catch(error){errors.push(name+'：'+error.message);}
  }
  explorer.expanded.add(directory);rememberExpanded();
  if(explorer.mode==='notes'){explorer.mode='all';localStorage.setItem('slide-notes-files-mode','all');renderFiles($('#inspector-content'));}
  await refreshExplorer();toast('已导入 '+imported+' 个文件'+(errors.length?'；'+errors.join('；'):''));
 }finally{fileActionBusy=false;}
}
function chooseWorkspaceFiles(directory=selectedFileDirectory(),folders=false){
 const input=document.createElement('input');input.type='file';input.multiple=true;if(folders)input.webkitdirectory=true;
 input.hidden=true;document.body.append(input);
 input.onchange=()=>{const files=[...input.files];input.remove();importWorkspaceHandles(files.map(file=>({file})),directory).catch(error=>toast(error.message));};
 input.oncancel=()=>input.remove();input.click();
}
function installFileTransferTargets(container){
 bindFileDropTarget(container,()=>fileRoot());
 const list=$('#file-tree',container);
 list.oncontextmenu=event=>{if(event.target.closest('.file-row'))return;event.preventDefault();showFileMenu(event,{kind:'directory',path:fileRoot(),name:explorer.workspace});};
 const tools=$('.files-tools',container),button=document.createElement('button');button.className='icon-button';button.type='button';button.title='导入文件';button.setAttribute('aria-label','导入文件');button.innerHTML=uiIcon('upload');button.onclick=()=>chooseWorkspaceFiles();tools.insertBefore(button,$('#refresh-files',container));
}
document.addEventListener('keydown',event=>{
 if(!event.target.closest?.('#file-tree,.files-tools')||event.target.closest('input,textarea,[contenteditable]')||event.isComposing)return;
 const key=event.key.toLowerCase(),entry=focusedFileEntry(event.target);
 if((event.ctrlKey||event.metaKey)&&['c','x'].includes(key)&&entry){setFileClipboard(entry,key==='x');event.stopPropagation();}
 if(event.key==='Escape'){workspaceFileClipboard=null;syncFileClipboard();}
});
for(const type of ['copy','cut'])document.addEventListener(type,event=>{
 const entry=focusedFileEntry(event.target);if(!entry){workspaceFileClipboard=null;syncFileClipboard();return;}
 if(!entry.path||entry.path===explorer.notesDirectory)return;
 setFileClipboard(entry,type==='cut');event.clipboardData.setData(fileTransferType,JSON.stringify(workspaceFileClipboard));event.clipboardData.setData('text/plain',entry.path);event.preventDefault();event.stopPropagation();
});
document.addEventListener('paste',event=>{
 if(!event.target.closest?.('#file-tree,.files-tools')||event.target.closest('input,textarea,[contenteditable]'))return;
 const files=[...event.clipboardData?.files||[]],entry=focusedFileEntry(event.target),directory=entry?.kind==='directory'?entry.path:entry?parentPath(entry.path):selectedFileDirectory();
 if(files.length){event.preventDefault();event.stopPropagation();importWorkspaceHandles(files.map(file=>({file})),directory).catch(error=>toast(error.message));return;}
 const raw=event.clipboardData?.getData(fileTransferType);let item;
 try{item=raw&&JSON.parse(raw);}catch{}
 if(item?.workspace===workspaceKey&&typeof item.path==='string'&&['move','copy'].includes(item.operation))workspaceFileClipboard=item;
 else if(!workspaceFileClipboard||event.clipboardData?.getData('text/plain')!==workspaceFileClipboard.path){
  if(event.clipboardData?.types.length){event.preventDefault();toast('剪贴板未提供可导入的文件内容，请直接拖入或使用“导入文件”。');}
  return;
 }
 event.preventDefault();event.stopPropagation();pasteWorkspaceFile(directory).catch(error=>toast(error.message));
});
