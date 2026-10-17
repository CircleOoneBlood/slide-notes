'use strict';
const panelIcons = Object.fromEntries(Object.entries({
  ai:'sparkles', files:'folder-tree', variables:'variable', packages:'package', outline:'list-tree', graph:'workflow',
  file:'file-text', folder:'folder', notebook:'notebook-text', search:'search',cpu:'cpu',memory:'memory-stick'
}).map(([name,icon])=>[name,uiIcon(icon)]));
for (const name of ['files','variables','packages','outline','graph','ai']) $('#' + name + '-button').innerHTML=panelIcons[name];
for(const [id,icon] of Object.entries({'toggle-sidebar':'panel-left','help-button':'circle-help','close-inspector':'x','expand-inspector':'move-diagonal','export':'download','slide-up':'arrow-up','slide-down':'arrow-down','delete-slide':'x'})) $('#'+id).innerHTML=uiIcon(icon);
$('#file-preview button').innerHTML=uiIcon('x');
$('#metric-cpu .metric-icon').innerHTML = panelIcons.cpu;
$('#metric-memory .metric-icon').innerHTML = panelIcons.memory;
$('#metric-kernel .metric-icon').innerHTML = panelIcons.notebook;
const explorer = {mode:localStorage.getItem('slide-notes-files-mode') || 'all', query:'',
  hideConfig:localStorage.getItem('slide-notes-hide-workspace-config:'+workspaceKey)!=='false',
  expanded:new Set(['']), directories:new Map(), results:[], serial:0, workspace:'WORKSPACE'};
const notebookSessions = new Map();
let openingNotebook = false, packageData = null, packageQuery = '', variableQuery = '';
const graphView = {direction:'vertical', selection:null, transform:null, signature:null, expanded:false};

async function loadNotebook(path,preloaded) {
  if (openingNotebook) return;
  openingNotebook = true;
  let managed=false;
  $('#main').inert=true; $('#document-title').disabled=true;
  try {
    await save();
    let requested = path ?? new URL(location.href).searchParams.get('notebook');
    if (requested === 'undefined' || requested === 'null') requested = null;
    const response = preloaded || await api('/api/document' + (requested ? '?path=' + encodeURIComponent(requested) : ''));
    if (typeof response.path !== 'string' || typeof response.workspace !== 'string') {
      throw new Error('后台服务仍是旧版，请在终端 Ctrl+C 后重新运行 ./start-notes.sh，再刷新页面。');
    }
    cacheNotebookSession();
    ++runSerial; clearTimeout(saveTimer); state.controls.clear();
    const cached = notebookSessions.get(response.path);
    Object.assign(state, {doc:response.document, path:response.path, revision:response.revision,
      epoch:0, savedEpoch:0, busy:false, mode:cached?.mode || 'edit', runtime:cached?.runtime || null,
      fragment:cached?.fragment || new Map(), cameras:cached?.cameras || new Map(),
      outputs:cached?.outputs || new Map(), markdownEditing:cached?.markdownEditing || new Set(),
      selectedCell:cached?.selectedCell || null,
      runtimeDirty:!!cached && cached.source !== JSON.stringify(response.document)});
    state.active = Math.min((cached?.active ?? Number(localStorage.getItem('slide-notes-active:' + state.path))) || 0,state.doc.slides.length-1);
    managed=!!response.managed;
    syncWorkbenchAvailability(true);
    explorer.workspace = response.workspace;explorer.notesDirectory=response.notesDirectory||'';
    graphView.selection = null; graphView.signature = null; graphView.transform = null;
    $('#toast').hidden = true;
    $('#run-all').disabled = false; $('#run-all').textContent = '运行全部'; $('#interrupt').hidden = true;
    $('#save-status').textContent = '已保存到本机';
    $('#status-document').textContent = state.path;
    $('#status-document').title = state.path;
    const url = new URL(location.href); url.searchParams.set('notebook',state.path); history.replaceState(null,'',url);
    render(); $('#main').scrollTo({top:cached?.scrollTop || 0,behavior:'instant'});
  if(!managed)await execute();
  else {
    const path=state.path,serial=runSerial;
    // Runtime results can arrive after the editable document. A slow kernel must
    // not hold up switching, and late results must never reach another notebook.
    api('/api/runtime?path='+encodeURIComponent(path)).then(snapshot=>{
      if(serial!==runSerial||state.path!==path)return;
      state.runtime=snapshot.state;state.runtimeDirty=snapshot.stale;
      if(state.runtime)for(const cell of allCells())updateOutput(cell);
    }).catch(error=>{if(serial===runSerial&&state.path===path){state.runtimeDirty=true;toast('运行结果暂不可用：'+error.message);}});
  }
  } finally { openingNotebook = false; $('#main').inert=false; $('#document-title').disabled=false; }

}

function panelSearch(value, label) {
  const wrapper = document.createElement('label'); wrapper.className = 'panel-search';
  wrapper.innerHTML = panelIcons.search;
  const input = document.createElement('input'); input.type = 'search'; input.placeholder = label;
  input.setAttribute('aria-label',label); input.value = value; wrapper.append(input);
  return wrapper;
}
function renderToolPanel(container) {
  if(state.panel==='ai')return renderAI(container);
  if (state.panel === 'files') return $('#file-tree',container) ? refreshFileRows() : renderFiles(container);
  if (state.panel === 'packages') return $('#package-list',container) ? drawPackages() : renderPackages(container);
  if (state.panel === 'variables') return $('#variable-list',container) ? drawVariables() : renderVariables(container);
  if (state.panel === 'graph') return renderGraph(container);
  if (state.panel === 'outline') return $('#outline-list',container) ? drawOutline() : renderOutline(container);
}
function renderFiles(container) {
  if(managedWorkbench&&!new URL(location.href).searchParams.has('workspace')){container.replaceChildren();installWorkspacePanelControls(container);const empty=document.createElement('p');empty.className='panel-footnote';empty.textContent='选择一个文件夹作为工作区';container.append(empty);return;}
  container.innerHTML = `<div class="file-modes" role="group" aria-label="文件显示模式"><button data-mode="all">工作区文件</button><button data-mode="notes">仅笔记</button></div><div class="files-tools"><strong>${panelIcons.folder}<span>${escapeHTML(explorer.mode==='notes'&&explorer.notesDirectory?explorer.notesDirectory:explorer.workspace)}</span></strong><button id="new-notebook-button" class="icon-button" aria-label="新建笔记" title="新建笔记">${uiIcon('plus')}</button><button id="refresh-files" class="icon-button" aria-label="刷新文件列表" title="刷新">${uiIcon('refresh-cw')}</button></div>`;
  container.querySelectorAll('[data-mode]').forEach(button => {
    button.setAttribute('aria-pressed',String(button.dataset.mode === explorer.mode));
    button.onclick = () => { explorer.mode = button.dataset.mode; explorer.selectedDirectory=fileRoot();resetFileDirectoryCache();fileTreeState.focusPath=null;fileTreeState.selectedPath=null; localStorage.setItem('slide-notes-files-mode', explorer.mode); renderFiles(container); };
  });
  const search = panelSearch(explorer.query, explorer.mode === 'notes' ? '搜索笔记…' : '搜索工作区文件…');
  $('input',search).id='file-search';
  let timer;
  $('input',search).oninput = event => { explorer.query = event.target.value; clearTimeout(timer); timer = setTimeout(refreshFileRows,150); };
  container.append(search);
  const list = document.createElement('div'); list.id = 'file-tree'; installFileTree(list); container.append(list);
  const foot = document.createElement('p'); foot.className = 'panel-footnote';
  foot.textContent = explorer.mode === 'notes' ? '点击笔记切换。可拖入系统文件和文件夹；导入后切换到工作区文件。' : '可拖入系统文件和文件夹，或选中目标文件夹后按 Ctrl+V。右键可复制、剪切、粘贴或导出。';
  container.append(foot);
  installFileToolbar(container);
  installFileTransferTargets(container);
  installFileTreeToolbar(container);
  installWorkspacePanelControls(container);
  $('#new-notebook-button').onclick = () => { const dialog = $('#new-notebook'); dialog.showModal(); $('input',dialog).focus(); };
  $('#refresh-files').onclick = () => { resetFileDirectoryCache(); refreshFileRows(); };
  revealActiveFile({automatic:true});
}
const directoryRequests=new WeakMap();
async function refreshFileRows() {
  const serial = ++explorer.serial;
  const list = $('#file-tree'); if (!list) return;
  try {
    if (explorer.query.trim()) {
      const response = await api('/api/search?' + new URLSearchParams({q:explorer.query,notes:explorer.mode === 'notes' ? '1' : '0',content:explorer.mode!=='notes'&&explorer.hideConfig!==false?'1':'0'}));
      if (serial !== explorer.serial || !list.isConnected) return;
      explorer.results = response.entries;
      const descriptors=response.entries.map((entry,index)=>({entry,depth:0,showPath:true,index,size:response.entries.length}));
      const notice=!descriptors.length?{empty:true,text:'没有匹配的文件'}:response.truncated?{text:'搜索范围较大，已显示前 20,000 个文件中的匹配项。'}:null;
      commitFileTree(list,()=>reconcileFileTree(list,descriptors,notice));
    } else {
      await loadDirectory('');
      if(serial!==explorer.serial||!list.isConnected)return;
      // Fetch visible siblings together; hidden descendants remain lazy.
      let pending=[''];const visited=new Set(pending);
      while(pending.length){
        const branches=pending.flatMap(parent=>(explorer.directories.get(parent)||[])
          .filter(entry=>entry.kind==='directory'&&explorer.expanded.has(entry.path)&&!visited.has(entry.path)));
        branches.forEach(entry=>visited.add(entry.path));
        await Promise.all(branches.map(async entry=>{
          try{await loadDirectory(entry.path);}catch{if(serial===explorer.serial)explorer.expanded.delete(entry.path);}
        }));
        if(serial!==explorer.serial||!list.isConnected)return;
        pending=branches.filter(entry=>explorer.expanded.has(entry.path)).map(entry=>entry.path);
      }
      const descriptors=[];appendDirectory(descriptors,'',0);
      commitFileTree(list,()=>reconcileFileTree(list,descriptors));
    }
  } catch (error) {
    if(serial!==explorer.serial||!list.isConnected)return;
    // Retain a usable tree if a background refresh fails transiently.
    const descriptors=[...list.querySelectorAll('.file-row')].map(row=>row.fileDescriptor).filter(Boolean);
    commitFileTree(list,()=>reconcileFileTree(list,descriptors,{text:error.message,empty:!descriptors.length}));
  }
}
async function loadDirectory(path) {
  const directories=explorer.directories;
  if(directories.has(path))return;
  let requests=directoryRequests.get(directories);
  if(!requests){requests=new Map();directoryRequests.set(directories,requests);}
  if(requests.has(path))return requests.get(path);
  const request=(async()=>{
    const result=await api('/api/files?'+new URLSearchParams({path,notes:explorer.mode==='notes'?'1':'0',content:explorer.mode!=='notes'&&explorer.hideConfig!==false?'1':'0'}));
    if(directories!==explorer.directories)return;
    explorer.notesDirectory=result.notesDirectory||'';directories.set(path,result.entries);
  })();
  requests.set(path,request);
  try{await request;}finally{requests.delete(path);}
}
function appendDirectory(descriptors,path,depth) {
  const entries=explorer.directories.get(path)||[];
  for (const [index,entry] of entries.entries()) {
    descriptors.push({entry,depth,showPath:false,index,size:entries.length});
    if (entry.kind === 'directory' && explorer.expanded.has(entry.path)) appendDirectory(descriptors,entry.path,depth + 1);
  }
}
function fileRow(data,depth,showPath=false,index=0,size=1,existing=null) {
  const row=existing||document.createElement('button');
  // Action closures keep one mutable entry rather than a stale response object.
  const entry=row.fileEntry||(row.fileEntry={});
  for(const key of Object.keys(entry))if(!(key in data))delete entry[key];
  Object.assign(entry,data);row.fileDescriptor={entry,depth,showPath,index,size};
  const label=entry.kind==='notebook'&&(showPath||explorer.mode==='notes')?entry.title:entry.name;
  const current=entry.path===editorTabs.active;
  const cut=workspaceFileClipboard?.operation==='move'&&workspaceFileClipboard.path===entry.path;
  const className='file-row '+entry.kind+(current?' current':'')+(cut?' file-cut':'');
  if(row.className!==className)row.className=className;
  const padding=(12+depth*15)+'px';if(row.style.paddingLeft!==padding)row.style.paddingLeft=padding;
  setFileTreeAttribute(row,'title',entry.path);setFileTreeAttribute(row,'data-path',entry.path);
  setFileTreeAttribute(row,'disabled',entry.unavailable?'':null);
  setFileTreeAttribute(row,'type','button');if(!existing)row.tabIndex=-1;
  setFileTreeAttribute(row,'data-kind',entry.kind);setFileTreeAttribute(row,'data-depth',depth);
  setFileTreeAttribute(row,'data-label',label);setFileTreeAttribute(row,'role','treeitem');
  setFileTreeAttribute(row,'aria-level',depth+1);setFileTreeAttribute(row,'aria-posinset',index+1);setFileTreeAttribute(row,'aria-setsize',size);
  setFileTreeAttribute(row,'aria-label',label);if(!existing)row.setAttribute('aria-selected','false');
  setFileTreeAttribute(row,'aria-disabled',entry.unavailable?'true':null);
  setFileTreeAttribute(row,'aria-expanded',entry.kind==='directory'?explorer.expanded.has(entry.path):null);
  setFileTreeAttribute(row,'aria-current',current?'page':null);
  const guides=depth?Array.from({length:depth},(_,i)=>`linear-gradient(#e2e7ef,#e2e7ef) ${16+i*15}px 0 / 1px 100% no-repeat`).join(','):'';
  if(row.style.getPropertyValue('--tree-guides')!==guides)row.style.setProperty('--tree-guides',guides);
  const isDir=entry.kind==='directory',isNote=entry.kind==='notebook';
  const markup=`<span class="tree-chevron">${isDir ? uiIcon(explorer.expanded.has(entry.path) ? 'chevron-down' : 'chevron-right') : ''}</span><span class="file-icon">${isDir ? panelIcons.folder : isNote || entry.kind === 'marimo' ? panelIcons.notebook : entry.kind === 'image' ? uiIcon('image') : panelIcons.file}</span><span class="file-label"><span>${escapeHTML(label)}</span>${showPath ? `<small>${escapeHTML(entry.path)}${entry.kind === 'marimo' ? ' · marimo 原版' : ''}</small>` : ''}</span>${isNote ? `<span class="file-count">${entry.slides}</span>` : ''}`;
  if(row.fileMarkup!==markup){row.innerHTML=markup;row.fileMarkup=markup;}
  row.onclick=async()=>{
    selectFileTreeRow(row);
    try{
      if(entry.kind==='directory'){explorer.selectedDirectory=entry.path;await toggleFileTreeDirectory(entry.path);}
      else if(entry.kind==='notebook'){if(entry.path!==state.path)await openNotebook(entry.path);}
      else await previewFile(entry.path);
    }catch(error){toast(error.message);}
  };
  // Rebind only when availability changes; all handlers read the shared entry.
  if(row.fileActionsAvailable!==!entry.unavailable){
    row.oncontextmenu=row.onkeydown=row.ondragstart=row.ondragend=row.ondragover=row.ondragleave=row.ondrop=null;
    row.draggable=!entry.unavailable;
    attachFileActions(row,entry);row.fileActionsAvailable=!entry.unavailable;
  }
  return row;
}
async function previewFile(path) {
  if(/\.pdf$/i.test(path))return openEditor('pdf',path);
  if(/\.(png|jpe?g|webp|gif|bmp|ico|avif|svg)$/i.test(path))return openEditor('image',path);
  const response = await api('/api/preview?path=' + encodeURIComponent(path));
  const dialog = $('#file-preview'); $('.preview-heading strong',dialog).textContent = response.entry.path;
  $('.preview-info',dialog).textContent = response.entry.kind === 'marimo' ?
    '原版 marimo 笔记 · 仍使用原版入口（项目根目录 ./start.sh edit）。此处为只读源码预览。' :
    response.entry.kind === 'template' ? '内置示例模板 · 用于初始化新笔记，不列入“仅笔记”。此处为只读预览。' :
    (response.binary ? '二进制文件 · 不支持文本预览' : '只读预览') + (response.truncated ? ' · 仅显示前 100 KB' : '');
  $('pre',dialog).textContent = response.content;
  dialog.showModal();
}
$('#file-preview button').onclick = () => $('#file-preview').close();
$('#cancel-notebook').onclick = () => $('#new-notebook').close();
$('#new-notebook form').onsubmit = async event => {
  event.preventDefault(); const form = event.target, submit = $('button[type=submit]',form); submit.disabled = true;
  try {
    await save();
    const response = await api('/api/notebooks',{title:form.elements.title.value,directory:notebookDirectory(explorer.selectedDirectory)});
    $('#new-notebook').close(); form.reset(); resetFileDirectoryCache();
    await openNotebook(response.path);
  } catch (error) { toast(error.message); }
  finally { submit.disabled = false; }
};

function renderPackages(container) {
  container.innerHTML = '<div class="package-environment"><span class="env-dot"></span><strong>Python environment</strong><span class="package-count"></span></div>';
  const search = panelSearch(packageQuery,'搜索已安装的包…'); container.append(search);
  const list = document.createElement('div'); list.id = 'package-list'; container.append(list);
  $('input',search).oninput = event => { packageQuery = event.target.value; drawPackages(); };
  container.insertAdjacentHTML('beforeend','<div id="environment-info" class="panel-footnote"></div>');
  if (packageData) drawPackages();
  else {
    list.innerHTML = '<p class="panel-empty">正在读取 Python 环境…</p>';
    api('/api/packages').then(data => { packageData = data; if (state.panel === 'packages') drawPackages(); })
      .catch(error => { if (list.isConnected) list.textContent = error.message; });
  }
}
function drawPackages() {
  const list = $('#package-list'); if (!list || !packageData) return;
  const packages = packageData.packages.filter(p => p.name.toLowerCase().includes(packageQuery.toLowerCase()));
  $('.package-count').textContent = packageData.packages.length;
  list.innerHTML = '<div class="table-head"><span>Package</span><span>Version</span></div>';
  for (const item of packages) {
    const row = document.createElement('div'); row.className = 'package-row'; row.title = item.summary;
    row.innerHTML = `<span class="package-cube">${panelIcons.packages}</span><span>${escapeHTML(item.name)}</span><code>${escapeHTML(item.version)}</code>`; list.append(row);
  }
  if (!packages.length) list.insertAdjacentHTML('beforeend','<p class="panel-empty">没有匹配的包</p>');
  $('#environment-info').textContent = `Python ${packageData.python} · 已安装的包（只读）\n${packageData.executable}`;
  $('#python-version').textContent = 'Python ' + packageData.python;
}
function renderVariables(container) {
  container.replaceChildren(); const search = panelSearch(variableQuery,'搜索变量…'); container.append(search);
  const list = document.createElement('div'); list.id = 'variable-list'; container.append(list);
  $('input',search).oninput = event => { variableQuery = event.target.value; drawVariables(); };
  drawVariables();
}
function drawVariables() {
  const list = $('#variable-list'); if (!list) return;
  list.innerHTML = `<div class="table-head variable-columns"><span>Name</span><span>Type</span><span>Value</span></div>`;
  if (!state.runtime) { list.insertAdjacentHTML('beforeend','<p class="panel-empty">运行笔记后显示变量</p>'); return; }
  if (state.runtimeDirty) list.insertAdjacentHTML('beforeend','<p class="panel-footnote">代码已修改，以下是上次运行的值。</p>');
  const vars = state.runtime.variables.filter(v => v.name.toLowerCase().includes(variableQuery.toLowerCase()));
  for (const value of vars) {
    const details = document.createElement('details'); details.className = 'variable-item';
    details.innerHTML = `<summary class="variable-columns"><span class="variable-name">${escapeHTML(value.name)}</span><span class="variable-type">${escapeHTML(value.type)}</span><code title="${escapeHTML(value.value)}">${escapeHTML(value.value.replaceAll('\n',' '))}</code></summary><div class="variable-expanded"><button data-cell="${value.cell}">Cell ${cellNumber(value.cell)} ↗</button><pre>${escapeHTML(value.value)}</pre></div>`;
    $('button',details).onclick = () => jumpToCell(value.cell); list.append(details);
  }
  if (!vars.length) list.insertAdjacentHTML('beforeend','<p class="panel-empty">没有匹配的变量</p>');
}

function graphLayout(nodes,edges) {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({rankdir:graphView.direction === 'horizontal' ? 'LR' : 'TB', nodesep:45,ranksep:90,marginx:24,marginy:24});
  graph.setDefaultEdgeLabel(() => ({}));
  nodes.forEach(node => graph.setNode(node.id,{width:180,height:76}));
  edges.forEach(edge => graph.setEdge(edge.from,edge.to));
  dagre.layout(graph);
  const positions = new Map(nodes.map(node => { const p=graph.node(node.id); return [node.id,{x:p.x-90,y:p.y-38}]; }));
  const routes = new Map(graph.edges().map(edge => [edge.v+':'+edge.w,graph.edge(edge).points]));
  return {positions,routes,width:Math.max(280,graph.graph().width || 0),height:Math.max(230,graph.graph().height || 0)};
}
function outputLines(node) {
  const values = node.outputs.length ? node.outputs : ['(no output)'];
  const lines = [''];
  for (const name of values) {
    let last = lines.length-1;
    if (lines[last].length + name.length > 25 && lines[last]) { lines.push(''); last++; }
    lines[last] += (lines[last] ? ', ' : '') + name;
  }
  return lines.slice(0,3).map(line => line.length > 27 ? line.slice(0,25)+'…' : line);
}
function renderGraph(container) {
  if (!state.runtime) { container.innerHTML = '<p class="panel-empty">运行笔记后显示依赖关系</p>'; return; }
  const nodes = state.runtime.graph, rawEdges = state.runtime.edges;
  const layout = graphLayout(nodes,rawEdges), grouped = new Map();
  for (const edge of rawEdges) {
    const id = edge.from + ':' + edge.to;
    if (!grouped.has(id)) grouped.set(id,{...edge,id,names:[]});
    grouped.get(id).names.push(edge.variable);
  }
  const signature = state.path + graphView.direction + JSON.stringify([nodes,rawEdges]);
  if (signature !== graphView.signature) { graphView.signature = signature; graphView.transform = null; }
  container.innerHTML = `<div class="graph-toolbar"><button data-direction="vertical">↓ Vertical Tree</button><button data-direction="horizontal">→ Horizontal Tree</button></div><div class="graph-canvas"><svg id="dependency-canvas" role="img" aria-label="Cell 依赖关系画布"><defs><marker id="dependency-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7" fill="#98a1b0"/></marker></defs><g id="graph-transform"></g></svg><div class="graph-controls"><button aria-label="放大依赖图">＋</button><button aria-label="缩小依赖图">−</button><button aria-label="适应画布">⛶</button></div><span class="graph-zoom">100%</span></div><div id="graph-details"></div>`;
  if (state.runtimeDirty) container.insertAdjacentHTML('afterbegin','<p class="panel-footnote">代码已修改，下图对应上次运行。</p>');
  container.querySelectorAll('[data-direction]').forEach(button => {
    button.setAttribute('aria-pressed',String(button.dataset.direction === graphView.direction));
    button.onclick = () => { graphView.direction = button.dataset.direction; renderGraph(container); };
  });
  const group = $('#graph-transform'), svg = $('#dependency-canvas'), canvas = $('.graph-canvas',container);
  let markup = '';
  for (const edge of grouped.values()) {
    const a = layout.positions.get(edge.from), b = layout.positions.get(edge.to); if (!a || !b) continue;
    const h = graphView.direction === 'horizontal';
    const x1 = a.x+(h?180:90), y1 = a.y+(h?38:76), x2 = b.x+(h?0:90), y2 = b.y+(h?38:0);
    const route = layout.routes.get(edge.id);
    const points = [{x:x1,y:y1}, ...route.slice(1,-1), {x:x2,y:y2}];
    let path = `M${points[0].x} ${points[0].y}`;
    for (let i=1;i<points.length-1;i++) {
      const p=points[i], next=points[i+1];
      path+=` Q${p.x} ${p.y} ${(p.x+next.x)/2} ${(p.y+next.y)/2}`;
    }
    path+=` L${x2} ${y2}`;
    const middle=points[Math.floor(points.length/2)];
    markup += `<g class="dependency-edge" data-edge="${edge.id}" tabindex="0" role="button" aria-label="${escapeHTML(edge.names.join(', '))} 依赖"><title>${escapeHTML(edge.names.join(', '))}</title><path class="edge-hit" d="${path}"/><path class="edge-line" d="${path}" marker-end="url(#dependency-arrow)"/><text x="${middle.x+8}" y="${middle.y-6}">${escapeHTML(edge.names.join(', ').slice(0,23))}</text></g>`;
  }
  for (const node of nodes) {
    const p = layout.positions.get(node.id), lines = outputLines(node);
    markup += `<g class="dependency-node ${state.runtime.errors[node.id] ? 'has-error' : ''}" data-node="${node.id}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="Cell ${cellNumber(node.id)} ${escapeHTML(node.outputs.join(', '))}"><title>${escapeHTML(node.slide + '\nOutputs: ' + node.outputs.join(', ') + '\nInputs: ' + node.inputs.join(', '))}</title><rect width="180" height="76" rx="5"/><circle class="node-port" cx="${graphView.direction==='horizontal'?0:90}" cy="${graphView.direction==='horizontal'?38:0}" r="3"/><circle class="node-port" cx="${graphView.direction==='horizontal'?180:90}" cy="${graphView.direction==='horizontal'?38:76}" r="3"/><text class="node-index" x="11" y="17">[${cellNumber(node.id)}]</text>${lines.map((line,i) => `<text class="node-outputs" x="90" y="${33+i*15}">${escapeHTML(line)}</text>`).join('')}</g>`;
  }
  group.innerHTML = markup;
  function transform() {
    const t = graphView.transform; group.setAttribute('transform',`translate(${t.x},${t.y}) scale(${t.scale})`);
    $('.graph-zoom',container).textContent = Math.round(t.scale*100)+'%';
  }
  function fit() {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const scale = Math.max(.18,Math.min(1.15,(width-22)/layout.width,(height-24)/layout.height));
    graphView.transform = {x:(width-layout.width*scale)/2,y:(height-layout.height*scale)/2,scale}; transform();
  }
  function zoom(factor,x=canvas.clientWidth/2,y=canvas.clientHeight/2) {
    const old = graphView.transform, scale = Math.max(.15,Math.min(2.8,old.scale*factor));
    graphView.transform = {scale,x:x-(x-old.x)*scale/old.scale,y:y-(y-old.y)*scale/old.scale}; transform();
  }
  if (!graphView.transform) fit(); else transform();
  const buttons = $('.graph-controls',container).children;
  buttons[0].onclick = () => zoom(1.2); buttons[1].onclick = () => zoom(1/1.2); buttons[2].onclick = fit;
  svg.onwheel = event => { event.preventDefault(); const r=svg.getBoundingClientRect(); zoom(event.deltaY<0?1.08:1/1.08,event.clientX-r.left,event.clientY-r.top); };
  let drag = null;
  svg.onpointerdown = event => {
    if (event.target.closest('[data-node],[data-edge]')) return;
    drag = {x:event.clientX,y:event.clientY,...graphView.transform,startX:graphView.transform.x,startY:graphView.transform.y,clientX:event.clientX,clientY:event.clientY}; svg.setPointerCapture(event.pointerId);
  };
  svg.onpointermove = event => { if (drag) { graphView.transform.x=drag.startX+event.clientX-drag.clientX; graphView.transform.y=drag.startY+event.clientY-drag.clientY; transform(); } };
  svg.onpointerup = () => { drag=null; };
  function select(selection) { graphView.selection=selection; highlight(); drawGraphDetails(nodes,grouped); }
  function highlight() {
    group.querySelectorAll('[data-node]').forEach(el => el.classList.toggle('selected', graphView.selection?.type==='node' && graphView.selection.id===el.dataset.node));
    group.querySelectorAll('[data-edge]').forEach(el => el.classList.toggle('selected', graphView.selection?.type==='edge' && graphView.selection.id===el.dataset.edge));
  }
  group.querySelectorAll('[data-node]').forEach(el => {
    el.onclick = () => { state.selectedCell=el.dataset.node; select({type:'node',id:el.dataset.node}); };
    el.ondblclick = () => jumpToCell(el.dataset.node);
    el.onkeydown = event => { if(event.key==='Enter') el.onclick(); };
  });
  group.querySelectorAll('[data-edge]').forEach(el => { el.onclick=()=>select({type:'edge',id:el.dataset.edge}); el.onkeydown=e=>{if(e.key==='Enter')el.onclick();}; });
  highlight(); drawGraphDetails(nodes,grouped);
}
function drawGraphDetails(nodes,edges) {
  const box = $('#graph-details'); if (!box) return;
  const selection=graphView.selection;
  if (!selection) { box.replaceChildren(); return; }
  function variableRows(names) {
    return names.map(name => {
      const value=state.runtime.variables.find(v=>v.name===name);
      return `<div class="graph-variable"><code>${escapeHTML(name)}</code><span>${escapeHTML(value?.type || '未定义')}</span><pre>${escapeHTML(value?.value || '—')}</pre></div>`;
    }).join('') || '<p class="panel-empty">—</p>';
  }
  if (selection.type==='node') {
    const node=nodes.find(n=>n.id===selection.id); if(!node){graphView.selection=null;return drawGraphDetails(nodes,edges);}
    box.innerHTML=`<div class="graph-detail-heading"><strong>Cell ${cellNumber(node.id)}</strong><button data-jump="${node.id}">定位代码 ↗</button></div><p class="graph-slide-name">${escapeHTML(node.slide)}</p><h4>↗ Outputs</h4>${variableRows(node.outputs)}<h4>↙ Inputs</h4>${variableRows(node.inputs)}`;
  } else {
    const edge=edges.get(selection.id); if(!edge){graphView.selection=null;return drawGraphDetails(nodes,edges);}
    box.innerHTML=`<div class="graph-detail-heading"><button data-jump="${edge.from}">Cell ${cellNumber(edge.from)}</button> → <button data-jump="${edge.to}">Cell ${cellNumber(edge.to)}</button></div><h4>Variables</h4>${variableRows(edge.names)}`;
  }
  box.querySelectorAll('[data-jump]').forEach(button => button.onclick=()=>{
    graphView.expanded=false; jumpToCell(button.dataset.jump);
  });
}
$('#expand-inspector').onclick = () => { graphView.expanded=!graphView.expanded; graphView.transform=null; renderInspector(); };

async function pollMetrics() {
  try {
    if (!document.hidden) {
      const data=await api('/api/metrics');
      if (![data.cpu,data.memory,data.kernelPercent].every(Number.isFinite)) throw new Error('指标不可用');
      $('.system-metrics').classList.remove('unavailable'); $('.system-metrics').title='本机实时资源占用';
      const values={cpu:data.cpu,memory:data.memory,kernel:data.kernelPercent};
      for(const [name,value] of Object.entries(values)) {
        const el=$('#metric-'+name); $('i',el).style.width=Math.max(0,Math.min(100,value))+'%';
        const text=name==='kernel' ? `Python 会话内存 ${(data.kernelMemory/1024**2).toFixed(0)} MB（全部笔记）` : name==='memory' ? `系统内存 ${data.memory}% · ${(data.memoryUsed/1024**3).toFixed(1)} / ${(data.memoryTotal/1024**3).toFixed(1)} GB` : `系统 CPU ${data.cpu}%`;
        el.title=text; el.setAttribute('aria-label',text);
      }
    }
  } catch {
    $('.system-metrics').title='暂时无法读取系统指标'; $('.system-metrics').classList.add('unavailable');
    document.querySelectorAll('.metric').forEach(el => { $('i',el).style.width='0%'; el.title='指标暂不可用'; el.setAttribute('aria-label','指标暂不可用'); });
  }
  setTimeout(pollMetrics,3500);
}
const slideResizer = $('#slide-sidebar-resizer');
let slideResizeDrag = null;
function setSlidesWidth(width,persist=false) {
  const min=148,max=Math.min(440,Math.floor(window.innerWidth*.48));
  const value=Math.round(Math.max(min,Math.min(max,Number.isFinite(width)?width:196)));
  document.documentElement.style.setProperty('--slides-width',value+'px');
  slideResizer.setAttribute('aria-valuemin',String(min));slideResizer.setAttribute('aria-valuemax',String(max));
  slideResizer.setAttribute('aria-valuenow',String(value));slideResizer.setAttribute('aria-valuetext',value+' 像素');
  if(persist)localStorage.setItem('slide-notes-slides-width',String(value));
  return value;
}
setSlidesWidth(Number(localStorage.getItem('slide-notes-slides-width')) || 196);
slideResizer.onpointerdown=event=>{
  if(event.button!==0)return;
  event.preventDefault();slideResizer.focus();
  slideResizeDrag={x:event.clientX,width:$('#sidebar').getBoundingClientRect().width};
  slideResizer.setPointerCapture(event.pointerId);document.body.classList.add('resizing-slides');
};
slideResizer.onpointermove=event=>{if(slideResizeDrag)setSlidesWidth(slideResizeDrag.width+event.clientX-slideResizeDrag.x);};
function finishSlideResize(){
  if(!slideResizeDrag)return;
  setSlidesWidth($('#sidebar').getBoundingClientRect().width,true);
  slideResizeDrag=null;document.body.classList.remove('resizing-slides');resizePlots();
}
slideResizer.onpointerup=finishSlideResize;
slideResizer.onpointercancel=finishSlideResize;
slideResizer.onlostpointercapture=finishSlideResize;
slideResizer.ondblclick=()=>setSlidesWidth(196,true);
slideResizer.onkeydown=event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();event.stopPropagation();
  const current=Number(slideResizer.getAttribute('aria-valuenow'));
  setSlidesWidth(event.key==='Home'?148:event.key==='End'?440:current+(event.key==='ArrowRight'?10:-10),true);
};
const toolResizer=$('#tool-panel-resizer');
const toolPanelDefaults={files:248,packages:248,variables:320,graph:360,outline:248,ai:380,help:248};
let toolResizeDrag=null;
function setToolPanelWidth(width,persist=false) {
  const min=190,max=Math.max(min,Math.min(620,window.innerWidth-58));
  const value=Math.round(Math.max(min,Math.min(max,Number.isFinite(width)?width:248)));
  document.documentElement.style.setProperty('--tool-panel-width',value+'px');
  toolResizer.setAttribute('aria-valuemin',String(min));toolResizer.setAttribute('aria-valuemax',String(max));
  toolResizer.setAttribute('aria-valuenow',String(value));toolResizer.setAttribute('aria-valuetext',value+' 像素');
  if(persist && state.panel)localStorage.setItem('slide-notes-panel-width:'+state.panel,String(value));
}
function syncToolPanelWidth() {
  toolResizer.hidden=!state.panel || (state.panel==='graph' && graphView.expanded);
  if(state.panel && !toolResizeDrag)setToolPanelWidth(Number(localStorage.getItem('slide-notes-panel-width:'+state.panel)) || toolPanelDefaults[state.panel]);
}
function finishToolResize() {
  if(!toolResizeDrag)return;
  setToolPanelWidth($('#inspector').getBoundingClientRect().width,true);
  toolResizeDrag=null;document.body.classList.remove('resizing-tools');
  refitToolGraph();
}
function refitToolGraph() {
  if(state.panel==='graph'){graphView.transform=null;renderGraph($('#inspector-content'));}
  resizePlots();
}
toolResizer.onpointerdown=event=>{
  if(event.button!==0)return;
  event.preventDefault();toolResizer.focus();
  toolResizeDrag={x:event.clientX,width:$('#inspector').getBoundingClientRect().width};
  toolResizer.setPointerCapture(event.pointerId);document.body.classList.add('resizing-tools');
};
toolResizer.onpointermove=event=>{if(toolResizeDrag)setToolPanelWidth(toolResizeDrag.width+(state.panel==='ai'?-1:1)*(event.clientX-toolResizeDrag.x));};
toolResizer.onpointerup=finishToolResize;
toolResizer.onpointercancel=finishToolResize;
toolResizer.onlostpointercapture=finishToolResize;
toolResizer.ondblclick=()=>{setToolPanelWidth(toolPanelDefaults[state.panel],true);refitToolGraph();};
toolResizer.onkeydown=event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();event.stopPropagation();
  const current=Number(toolResizer.getAttribute('aria-valuenow'));
  setToolPanelWidth(event.key==='Home'?190:event.key==='End'?620:current+(event.key==='ArrowRight'?10:-10)*(state.panel==='ai'?-1:1),true);
  refitToolGraph();
};
window.addEventListener('resize',()=>{
  setSlidesWidth(Number(localStorage.getItem('slide-notes-slides-width')) || 196);
  if(!toolResizeDrag)syncToolPanelWidth();
});
restoreExpanded();
init();
