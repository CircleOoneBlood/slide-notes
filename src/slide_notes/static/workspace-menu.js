'use strict';
const managedWorkbench=!!document.body.dataset.managedWorkbench;
let workbenchReady=false;
async function workspaceRequest(path,body){
 const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const result=await response.json();if(!response.ok)throw Error(result.error||'操作失败');return result;
}
function syncWorkbenchAvailability(hasDocument){
 restoreNotebookSidebar();
 const hasWorkspace=!managedWorkbench||new URL(location.href).searchParams.has('workspace');
 document.body.classList.toggle('without-notebook',!hasDocument);
 $('#workbench-empty').hidden=hasDocument;
 $('#workbench-empty-label').textContent=hasWorkspace?'工作区已就绪，开始一本新笔记。':'文字、公式与代码，在同一页开始。';
 $('#welcome-new-note').hidden=!hasWorkspace;$('#welcome-open-note').hidden=!hasWorkspace;
 for(const id of ['document-title','mode-edit','mode-present','run-all','export','add-slide','variables-button','outline-button','graph-button'])$('#'+id).disabled=!hasDocument;
 $('#files-button').disabled=false;$('#packages-button').disabled=!hasWorkspace;
 if(!hasDocument){$('#document-title').value='';$('#document-title').placeholder='Slide Notes';$('#save-status').textContent='';$('#slide-count').textContent='—';$('#status-document').textContent=hasWorkspace?'工作区':'未打开工作区';}
}
async function rememberWorkbench(){
 if(!managedWorkbench)return;
 const workspace=new URL(location.href).searchParams.get('workspace');
 if(workspace)await workspaceRequest('/api/app/session',{workspace,notebook:state.path,editors:editorSession()});
}
async function initWorkspaceWorkbench(){
 const url=new URL(location.href),info=await workspaceRequest('/api/app/home');
 drawWelcomeRecent(info.recent);
 let key=url.searchParams.get('workspace');
 if(!key){
  key=info.session?.workspace;
  // Upgrade from versions which only recorded recent folders.
  if(!info.session&&info.recent[0]?.exists){const opened=await workspaceRequest('/api/app/open',{path:info.recent[0].path});key=opened.id;}
  if(key){url.searchParams.set('workspace',key);history.replaceState(null,'',url);}
  else {syncWorkbenchAvailability(false);return;}
 }
 try{
  // Restoring a session stays in this document instead of loading every script
  // and painting the empty welcome page a second time.
  workspaceKey=key;
  explorer.hideConfig=localStorage.getItem('slide-notes-hide-workspace-config:'+key)!=='false';
  fileTreeState.autoReveal=localStorage.getItem('slide-notes-auto-reveal:'+key)!=='false';
  restoreExpanded();
  const workspace=await workspaceRequest('/api/app/workspace?workspace='+encodeURIComponent(key));
  explorer.workspace=workspace.name;explorer.notesDirectory=workspace.notesDirectory||'';explorer.selectedDirectory=explorer.notesDirectory;$('#status-document').textContent=workspace.path;
  const restored=info.session?.editors?.[key];
  if(restored)await restoreEditorSession(restored,workspace.notebookAliases||{},url.searchParams.get('notebook'));
  if(!editorTabs.active){
   const previous=url.searchParams.get('notebook')||info.session?.notebooks?.[key];
   const preferred=workspace.notebookAliases?.[previous]||previous;
   const notes=(await api('/api/search?notes=1')).entries.filter(e=>e.kind==='notebook');
   const selected=notes.find(e=>e.path===preferred)||notes[0];
   if(selected)await openNotebook(selected.path);
   else {syncWorkbenchAvailability(false);await rememberWorkbench();$('#status-document').textContent=workspace.path;}
  }
  workbenchReady=true;pollMetrics();
 }catch(error){
  url.searchParams.delete('workspace');url.searchParams.delete('notebook');history.replaceState(null,'',url);
  syncWorkbenchAvailability(false);toast('未能恢复工作区：'+error.message+'。可从左侧文件夹重新打开。');
 }
}
window.addEventListener('focus',()=>{if(managedWorkbench&&workbenchReady&&!openingNotebook&&!editorTabs.switching)rememberWorkbench().catch(()=>{});});

let showWorkspaceDialog, switchWorkspace, openNoteDialog, drawWelcomeRecent, openWorkspaceMenu;
function installWorkspacePanelControls(container){
 if(!managedWorkbench)return;
 const toolbar=document.createElement('div');toolbar.className='workspace-panel-controls';
 const button=document.createElement('button');button.id='workspace-switcher';button.setAttribute('aria-haspopup','menu');button.title='打开、切换或管理工作区';
 button.innerHTML=uiIcon('folder')+'<span></span>'+uiIcon('chevron-down');$('span',button).textContent=new URL(location.href).searchParams.has('workspace')?explorer.workspace:'打开工作区';
 button.onclick=()=>openWorkspaceMenu(button);button.onkeydown=event=>{if(event.key==='ArrowDown'){event.preventDefault();openWorkspaceMenu(button).then(()=>$('#workspace-file-menu button:not(:disabled)')?.focus());}};toolbar.append(button);container.prepend(toolbar);
}
(()=>{
 let creating=false,folder=null,browseSerial=0,notes=[];
 const menu=$('#workspace-file-menu');let trigger=null;
 function closeMenu(focus=false){menu.hidden=true;trigger?.setAttribute('aria-expanded','false');if(focus)trigger?.focus();}
 function action(label,callback,disabled=false,detail=''){
  const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.disabled=disabled;
  const title=document.createElement('span');title.textContent=label;button.append(title);
  if(detail){const small=document.createElement('small');small.textContent=detail;button.append(small);button.title=detail;}
  button.onclick=()=>{closeMenu();Promise.resolve().then(callback).catch(error=>toast(error.message));};menu.append(button);return button;
 }
 function divider(label){const el=document.createElement(label?'div':'hr');if(label){el.className='menu-label';el.textContent=label;}else el.setAttribute('role','separator');menu.append(el);}
 async function openMenu(button){
  if(!menu.hidden&&trigger===button){closeMenu();return;}trigger=button;
  menu.replaceChildren();menu.hidden=false;trigger.setAttribute('aria-expanded','true');
  const rect=button.getBoundingClientRect();menu.style.left=Math.min(rect.left,innerWidth-310)+'px';menu.style.top=(rect.bottom+6)+'px';
  const hasWorkspace=!managedWorkbench||new URL(location.href).searchParams.has('workspace');
  if(managedWorkbench){action('打开工作区…',()=>showWorkspaceDialog(false));action('新建工作区…',()=>showWorkspaceDialog(true));divider();}
  action('打开笔记…',openNoteDialog,!hasWorkspace);
  action('新建笔记…',()=>newNoteIn(explorer.selectedDirectory||''),!hasWorkspace);
  const printable=!!state.doc&&!$('#notebook-editor').hidden;
  action('导出笔记 JSON',()=>$('#export').click(),!printable);
  action('导出 PDF / 打印…',()=>openNotebookPrintDialog('all'),!printable);
  if(managedWorkbench){
   divider();action('Python 运行环境…',showEnvironment,!hasWorkspace);
   action('添加示例笔记',async()=>{await save();await workspaceRequest('/api/app/examples',{workspace:new URL(location.href).searchParams.get('workspace')});await refreshExplorer();await openNoteDialog();},!hasWorkspace);
   action('关闭工作区',async()=>{await save();await workspaceRequest('/api/app/session',{workspace:null});location.assign('/');},!hasWorkspace);
   divider('最近打开');
   try{const data=await workspaceRequest('/api/app/home');if(menu.hidden)return;
    if(!data.recent.length)divider('暂无最近工作区');
    for(const entry of data.recent.slice(0,8))action(entry.name,()=>switchWorkspace(entry.path),!entry.exists,entry.path+(entry.exists?'':' · 目录不存在'));
   }catch(error){divider(error.message);}
  }
 }
 openWorkspaceMenu=openMenu;
 document.addEventListener('pointerdown',e=>{if(!e.target.closest('#workspace-file-menu,#workspace-switcher'))closeMenu();});
 menu.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();closeMenu(true);}if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const buttons=[...menu.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();}};
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!menu.hidden){closeMenu(true);e.preventDefault();}});
 showWorkspaceDialog=function(create){creating=create;$('#dialog-title').textContent=create?'新建工作区':'打开工作区';$('#workspace-form button[type=submit]').textContent=create?'创建':'打开';$('#create-hint').hidden=!create;$('#workspace-input').value='';$('#dialog-error').textContent='';$('#workspace-dialog').showModal();$('#workspace-input').focus();}
 switchWorkspace=async function(path,create=false){await save();await rememberWorkbench();const opened=await workspaceRequest('/api/app/open',{path,create});location.assign('/?workspace='+opened.id);}
 $('#workspace-form').onsubmit=async e=>{e.preventDefault();const button=$('#workspace-form button[type=submit]');button.disabled=true;try{await switchWorkspace($('#workspace-input').value.trim(),creating);}catch(error){$('#dialog-error').textContent=error.message;}finally{button.disabled=false;}};
 $('[data-close]',$('#workspace-dialog')).onclick=()=>$('#workspace-dialog').close();
 async function browse(path){const serial=++browseSerial;$('#select-folder').disabled=true;try{
  const result=await workspaceRequest('/api/app/directories'+(path?'?path='+encodeURIComponent(path):''));if(serial!==browseSerial)return;
  folder=result;$('#folder-path').value=folder.path;$('#folder-list').replaceChildren();$('#folder-error').textContent='';
  for(const entry of folder.entries){const button=document.createElement('button');button.innerHTML=uiIcon('folder');const name=document.createElement('span');name.textContent=entry.name;button.append(name);button.onclick=()=>browse(entry.path);$('#folder-list').append(button);}
  $('#select-folder').disabled=false;
 }catch(error){if(serial===browseSerial)$('#folder-error').textContent=error.message;}}
 $('#browse').onclick=()=>{$('#folder-browser').showModal();browse($('#workspace-input').value||undefined);};
 $('#parent-folder').onclick=()=>browse(folder?.parent);$('#go-folder').onclick=()=>browse($('#folder-path').value);
 $('#folder-path').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();browse(e.target.value);}};
 $('#cancel-browser').onclick=()=>$('#folder-browser').close();
 $('#select-folder').onclick=()=>{if(!folder)return;$('#workspace-input').value=folder.path+(creating?'/新工作区':'');$('#folder-browser').close();$('#workspace-input').focus();};
 openNoteDialog=async function(){notes=(await api('/api/search?notes=1')).entries.filter(e=>e.kind==='notebook');$('#open-note-search').value='';drawNotes();$('#open-note-dialog').showModal();$('#open-note-search').focus();}
 function drawNotes(){const list=$('#open-note-list'),query=$('#open-note-search').value.toLowerCase();list.replaceChildren();
  for(const entry of notes.filter(e=>(e.title+' '+e.path).toLowerCase().includes(query))){const button=document.createElement('button');const title=document.createElement('strong'),path=document.createElement('small');title.textContent=entry.title;path.textContent=entry.path;button.append(title,path);button.onclick=async()=>{try{await openNotebook(entry.path);$('#open-note-dialog').close();}catch(error){toast(error.message);}};list.append(button);}
  if(!list.children.length){const empty=document.createElement('p');empty.textContent='没有匹配的笔记';list.append(empty);}
 }
 drawWelcomeRecent=function(entries){const list=$('#welcome-recent');list.replaceChildren();for(const entry of entries.slice(0,5)){const button=document.createElement('button');button.className='welcome-recent-item';button.textContent=entry.name;button.title=entry.path;button.disabled=!entry.exists;const path=document.createElement('small');path.textContent=entry.path;button.append(path);button.onclick=()=>switchWorkspace(entry.path).catch(error=>toast(error.message));list.append(button);}if(!entries.length){const text=document.createElement('p');text.textContent='打开的工作区会显示在这里';list.append(text);}};
 $('#welcome-open').onclick=()=>showWorkspaceDialog(false);$('#welcome-create').onclick=()=>showWorkspaceDialog(true);$('#welcome-new-note').onclick=()=>newNoteIn('');$('#welcome-open-note').onclick=()=>openNoteDialog().catch(error=>toast(error.message));
 $('#open-note-search').oninput=drawNotes;$('#cancel-open-note').onclick=()=>$('#open-note-dialog').close();
 async function refreshEnvironment(){const key=new URL(location.href).searchParams.get('workspace');if(!key)return;const env=await workspaceRequest('/api/app/environment?workspace='+encodeURIComponent(key));$('#environment-status').textContent=env.status==='ready'?'Python 环境已就绪':env.message||'等待初始化';$('#environment-log').textContent=env.python+'\n'+env.log.join('\n');$('#environment-retry').hidden=!['error','missing'].includes(env.status);}
 async function showEnvironment(){$('#environment-dialog').showModal();await refreshEnvironment();}
 $('#environment-close').onclick=()=>$('#environment-dialog').close();$('#environment-retry').onclick=async()=>{try{await workspaceRequest('/api/app/initialize',{workspace:new URL(location.href).searchParams.get('workspace')});await refreshEnvironment();}catch(error){toast(error.message);}};
 setInterval(()=>{if($('#environment-dialog').open)refreshEnvironment().catch(error=>{$('#environment-status').textContent=error.message;});},2000);
})();
