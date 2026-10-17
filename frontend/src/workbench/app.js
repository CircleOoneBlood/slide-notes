/* A slide-first UI. Documents, kernel state and presentation progress stay separate. */
'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const icons = {
  sidebar: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16M5 8h2M5 12h2"/></svg>',
  graph: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v5M5 17v-5h14v5"/></svg>'
};
$('#toggle-sidebar').innerHTML = icons.sidebar;
$('#graph-button').innerHTML = icons.graph;
const state = {doc:null, path:null, revision:null, active:0, mode:'edit', panel:null, runtime:null,
  busy:false, selectedCell:null, epoch:0, savedEpoch:0, runtimeDirty:false, fragment: new Map(),
  outputs:new Map(), cameras:new Map(), markdownEditing:new Set(), controls:new Map()};
let saveTimer, savePromise, toastTimer, runSerial=0;
const uid = () => 'c' + crypto.randomUUID().replaceAll('-', '');
const slide = () => state.doc.slides[state.active];
const allCells = () => state.doc.slides.flatMap(s => s.cells);
const cellNumber = id => String(allCells().findIndex(c => c.id === id) + 1).padStart(2, '0');
const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function api(path, body) {
  const workspace=new URL(location.href).searchParams.get('workspace');
  if(workspace)path+=(path.includes('?')?'&':'?')+'workspace='+encodeURIComponent(workspace);
  const response = await fetch(path, body === undefined ? {} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  });
  const data = await response.json();
  if (response.status === 404 && path.startsWith('/api/')) throw new Error('后台服务仍是旧版，请在终端 Ctrl+C 后重新运行 ./start-notes.sh，再刷新页面。');
  if (!response.ok || data.ok === false) throw new Error(data.error || '请求失败');
  return data;
}
function toast(message, undo) {
  clearTimeout(toastTimer);
  const box = $('#toast');
  $('span', box).textContent = message;
  const button = $('button', box);
  button.hidden = !undo;
  button.onclick = () => { undo(); box.hidden = true; };
  box.hidden = false;
  toastTimer = setTimeout(() => { box.hidden = true; }, undo ? 12000 : 6000);
}
function dirty(runtime = false, historyGroup = null) {
  recordDocumentChange(historyGroup);
  state.epoch++;
  if(typeof queueAIChangeRefresh==='function')queueAIChangeRefresh();
  // An old deletion snapshot must not overwrite subsequent typing.
  $('#toast button').hidden = true;
  state.runtimeDirty ||= runtime;
  $('#save-status').textContent = '尚未保存';
  $('#save-status').classList.remove('error-status');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save().catch(() => {}), 550);
  if (runtime) {
    document.querySelectorAll('.cell-output').forEach(el => el.classList.add('cell-stale'));
  }
}
async function save() {
  clearTimeout(saveTimer);
  if (savePromise) { await savePromise; if (state.savedEpoch !== state.epoch) return save(); return; }
  if (state.savedEpoch === state.epoch) return;
  savePromise = (async () => {
    while (state.savedEpoch !== state.epoch) {
      const epoch = state.epoch;
      $('#save-status').textContent = '保存中…';
      const response = await api('/api/save', {path:state.path, document:structuredClone(state.doc), revision:state.revision});
      state.revision = response.revision;
      state.savedEpoch = epoch;
    }
    $('#save-status').textContent = '已保存到本机';
  })();
  try { await savePromise; }
  catch (error) {
    $('#save-status').textContent = '保存失败 · 请导出备份';
    $('#save-status').classList.add('error-status');
    toast(error.message); throw error;
  } finally { savePromise = null; }
}

// Permit only inert group IDs for linked formula highlighting; other HTML/URL
// extensions remain untrusted.
function mathLinkTrust(context) {
  const attributes=context.attributes||{},keys=Object.keys(attributes);
  return context.command==='\\htmlData'&&keys.length===1&&keys[0]==='data-math-link'&&
    /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(attributes['data-math-link']);
}
function syncMathLinkHighlight(target) {
  const root=$('#cells'),link=target?.closest?.('[data-math-link]');
  const key=link&&root.contains(link)&&link.closest('.katex,.MathJax')?link.dataset.mathLink:null;
  root.querySelectorAll('.katex [data-math-link],.MathJax [data-math-link]').forEach(element=>{
    element.classList.toggle('math-linked-active',!!key&&element.dataset.mathLink===key);
  });
}
$('#cells').addEventListener('pointerover',event=>syncMathLinkHighlight(event.target));
$('#cells').addEventListener('pointerout',event=>syncMathLinkHighlight(event.relatedTarget));
function markdown(source) { return renderNoteMarkdown(source); }

function renderSidebar() {
  $('#slide-count').textContent = String(state.doc.slides.length).padStart(2, '0');
  const list=$('#slide-list'),existing=new Map([...list.children].map(button=>[button.dataset.slideId,button]));
  const retained=new Set();
  state.doc.slides.forEach((s, i) => {
    let button=existing.get(s.id);
    if(!button){
      button=document.createElement('button');button.className='slide-tab';button.dataset.slideId=s.id;
      button.onclick=()=>navigate(Number(button.dataset.slideIndex));
      button.oncontextmenu=event=>openSlideContext(event,Number(button.dataset.slideIndex),button);
      button.onkeydown=event=>{if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10'))openSlideContext(event,Number(button.dataset.slideIndex),button);};
    }
    retained.add(button);button.dataset.slideIndex=String(i);button.classList.toggle('active',i===state.active);
    button.setAttribute('aria-current', i === state.active ? 'page' : 'false');
    const preview=(s.cells.find(c=>c.kind==='markdown'&&c.display!=='skip')?.source||'从一个 cell 开始').slice(0,700).replace(/[#*$>`]/g,'').slice(0,350);
    const markup=`<span class="slide-number">${String(i+1).padStart(2,'0')} / SLIDE</span><strong>${escapeHTML(s.name||'未命名页面')}</strong><div class="slide-preview">${escapeHTML(preview)}</div><div class="mini-cells">${s.cells.slice(0,12).map(c=>`<i class="${c.kind} ${c.display}"></i>`).join('')}</div>`;
    if(button.sidebarMarkup!==markup){button.innerHTML=markup;button.sidebarMarkup=markup;}
    if(list.children[i]!==button)list.insertBefore(button,list.children[i]||null);
  });
  for(const button of [...list.children])if(!retained.has(button))button.remove();
}
function navigate(index) {
  state.active = Math.max(0, Math.min(index, state.doc.slides.length - 1));
  localStorage.setItem('slide-notes-active:' + state.path, String(state.active));
  render();
  $('#main').scrollTop = 0;
}
function fragmentCount() { return slide().cells.filter(c => c.display === 'fragment').length; }
function next() {
  const count = state.fragment.get(slide().id) || 0;
  if (state.mode === 'present' && count < fragmentCount()) {
    state.fragment.set(slide().id, count + 1); applyVisibility();
    const fragments = slide().cells.filter(c => c.display === 'fragment');
    document.getElementById('cell-' + fragments[count].id)?.scrollIntoView({behavior:'smooth', block:'nearest'});
  } else if (state.active < state.doc.slides.length - 1) navigate(state.active + 1);
}
function previous() {
  const count = state.fragment.get(slide().id) || 0;
  if (state.mode === 'present' && count > 0) {
    state.fragment.set(slide().id, count - 1); applyVisibility();
  } else if (state.active > 0) navigate(state.active - 1);
}
function applyVisibility() {
  let index = 0, visible = 0;
  for (const cell of slide().cells) {
    if (cell.display === 'fragment') index++;
    const element = document.getElementById('cell-' + cell.id);
    element.hidden = state.mode === 'present' && (cell.display === 'skip' ||
      (cell.display === 'fragment' && index > (state.fragment.get(slide().id) || 0)));
    if (!element.hidden) visible++;
  }
  document.querySelectorAll('.cell-column').forEach(column=>{column.hidden=[...column.children].every(card=>card.hidden);});
  document.querySelectorAll('.cell-row').forEach(row=>{row.hidden=[...row.children].every(column=>column.hidden);});
  $('#empty-slide').hidden = visible > 0 || state.mode === 'edit';
  updateCellRows();
}
function render() {
  const history=ensureNotebookHistory();
  if(history){history.baseline.active=state.active;history.baseline.selected=state.selectedCell;}
  closeSlideContext();
  cancelCellResize?.();
  destroyCodeEditors();
  if (!slide().cells.some(c => c.id === state.selectedCell)) state.selectedCell = null;
  document.body.classList.toggle('present', state.mode === 'present');
  $('#mode-edit').setAttribute('aria-pressed', String(state.mode === 'edit'));
  $('#mode-present').setAttribute('aria-pressed', String(state.mode === 'present'));
  $('#document-title').value = state.doc.title;
  $('#document-title').title = state.doc.title;
  updateEditorTitle(state.path,state.doc.title);
  $('#document-title').readOnly = state.mode === 'present';
  $('#slide-name').value = slide().name;
  $('#slide-name').readOnly = state.mode === 'present';
  $('#page-eyebrow').textContent = `NOTEBOOK / ${String(state.active + 1).padStart(2,'0')}`;
  $('#mode-hint').textContent = state.mode === 'edit' ? 'F 放映 · C 编辑所选 cell · Shift + Enter 运行' : '← → 翻页 · C 编辑所选 cell · Esc 返回编辑';
  $('#slide-up').disabled = state.active === 0;
  $('#slide-down').disabled = state.active === state.doc.slides.length - 1;
  $('#delete-slide').disabled = state.doc.slides.length === 1;
  renderSidebar();
  $('#cells').replaceChildren(...renderCellRows());
  applyVisibility();
  syncAICellWindows();
  renderInspector();
}
function button(label, title, callback, disabled = false) {
  const el = document.createElement('button');
  el.className = 'icon-button';
  const glyph = {'↑':'arrow-up','↓':'arrow-down','×':'x','▷':'play','✎':'square-pen'}[label];
  if (glyph) el.innerHTML = uiIcon(glyph); else el.textContent = label;
  el.title = title;
  el.setAttribute('aria-label', title); el.disabled = disabled; el.onclick = callback;
  return el;
}
function snapshotUndo(_message, mutate, runtime = false) {
  mutate();dirty(runtime);render();
}
function renderCell(cell, index) {
  return renderNotebookCell(cell,index);
}
function moveCell(index, direction) {
  const cells = slide().cells;
  moveLayoutCell(cells[index],cells[index+direction],direction>0);
}
function insertionPoint(index) {
  const row = document.createElement('div'); row.className = 'cell-insert'; row.dataset.insertionIndex=String(index);
  const trigger = document.createElement('button'); trigger.textContent = '+';
  trigger.setAttribute('aria-label',index ? `在第 ${index} 个 cell 后插入` : '在页面开头插入 cell');
  trigger.setAttribute('aria-expanded','false');
  const menu = document.createElement('div'); menu.className = 'insert-menu'; menu.hidden = true;
  for (const [kind,label] of [['code','＋ Python'],['markdown','＋ Markdown'],['html','＋ HTML']]) {
    const action = document.createElement('button'); action.textContent = label;
    action.onclick = () => addCell(kind,index); menu.append(action);
  }
  const paste=document.createElement('button');paste.textContent='粘贴 cell';paste.dataset.pasteCell='true';
  paste.disabled=!hasCopiedCell();paste.onclick=()=>pasteNotebookCell(index);menu.append(paste);
  trigger.onclick = () => {
    const open = menu.hidden;
    document.querySelectorAll('.insert-menu').forEach(el => { el.hidden=true; el.previousElementSibling.setAttribute('aria-expanded','false'); });
    menu.hidden = !open; trigger.setAttribute('aria-expanded',String(open));
    if (open) $('button',menu).focus();
  };
  row.onkeydown = event => { if (event.key === 'Escape') { menu.hidden=true; trigger.setAttribute('aria-expanded','false'); trigger.focus(); } };
  row.append(trigger,menu); return row;
}
function selectCell(id) {
  state.selectedCell = id;
  document.querySelectorAll('.cell').forEach(el => el.classList.toggle('cell-selected',el.dataset.cell === id));
}
function addCell(kind, index = slide().cells.length) {
  const cell = {id:uid(), kind, display:'normal', showCode:false,
    source:kind === 'code' ? '# 输入 Python；最后一个表达式会作为输出\n' : kind === 'html' ? '<h2>HTML 交互</h2>\n<p>在这里编写 HTML、CSS 和 JavaScript。</p>\n' : '在这里写下你的想法。支持 $x^2$ 和 Markdown。'};
  slide().cells.splice(index,0,cell); state.selectedCell=cell.id;
  if (kind === 'markdown') state.markdownEditing.add(cell.id);
  dirty(kind === 'code'); render();
  focusCellEditor(cell);
}

// Discrete notebook controls can sit under a figure as a rollout stepper.
function syncNoteStepper(input, spec) {
  const control = input.closest('.control-stepper');
  if (!control) return;
  const current = Number(input.value);
  control.querySelector('output').textContent = `k = ${current} / ${spec.maximum}`;
  control.querySelector('.stepper-next').disabled = spec.disabled || current >= spec.maximum;
  control.querySelector('.stepper-next').textContent = current >= spec.maximum ? '已完成' : '下一步 →';
  control.querySelector('.stepper-reset').disabled = spec.disabled || current <= spec.minimum;
  const percent = 100 * (current - spec.minimum) / (spec.maximum - spec.minimum);
  input.style.setProperty('--step-progress', `${percent}%`);
  for (const tick of control.querySelectorAll('.stepper-tick')) {
    const at = Number(tick.dataset.value);
    tick.classList.toggle('stepper-reached', at <= current);
    tick.classList.toggle('stepper-current', at === current);
    tick.disabled = !!spec.disabled;
    tick.setAttribute('aria-pressed', String(at === current));
  }
}
function createNoteControl(spec, stepper) {
  const label = document.createElement(stepper ? 'div' : 'label');
  label.className = stepper ? 'control control-stepper' : 'control';
  const name = document.createElement('span'); name.textContent = spec.label;
  const input = document.createElement('input'); input.type = 'range';
  input.min = spec.minimum; input.max = spec.maximum; input.step = spec.step; input.value = spec.value;
  input.dataset.key = spec.key; input.setAttribute('aria-label', spec.label);
  const value = document.createElement('output'); value.textContent = Number(spec.value).toFixed(2);
  const changed = () => {
    value.textContent = Number(input.value).toFixed(2);
    if (stepper) syncNoteStepper(input, spec);
    state.controls.set(spec.key, Number(input.value));
    refreshCodeActions(); flushControls();
  };
  input.oninput = changed;
  if (stepper) {
    const actions = document.createElement('div'); actions.className = 'stepper-actions';
    const next = document.createElement('button'); next.type = 'button'; next.className = 'stepper-next';
    next.onclick = () => { input.value = Math.min(spec.maximum, Number(input.value) + spec.step); changed(); };
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'stepper-reset'; reset.textContent = '↺ 重置';
    reset.onclick = () => { input.value = spec.minimum; changed(); };
    actions.append(next, reset);
    // Keep the accessible name; the timeline itself carries the visible 0…N labels.
    name.hidden = true; value.hidden = true;
    const timeline = document.createElement('div'); timeline.className = 'stepper-timeline';
    const ticks = document.createElement('div'); ticks.className = 'stepper-ticks';
    const count = Math.min(100, Math.round((spec.maximum - spec.minimum) / spec.step));
    for (let index = 0; index <= count; index++) {
      const at = spec.minimum + index * spec.step;
      const tick = document.createElement('button'); tick.type = 'button'; tick.className = 'stepper-tick';
      tick.dataset.value = String(at); tick.textContent = String(Number(at.toFixed(8)));
      tick.style.left = `${100 * (at - spec.minimum) / (spec.maximum - spec.minimum)}%`;
      tick.setAttribute('aria-label', `k = ${at}`);
      tick.onclick = () => { input.value = at; changed(); };
      ticks.append(tick);
    }
    timeline.append(input, ticks);
    label.append(actions, timeline, value);
    syncNoteStepper(input, spec);
  } else label.append(name, input, value);
  return label;
}
// Opt-in horizontal dragging of a numeric widget from a 2D plot.
function bindPlotDragX(plot, spec) {
  plot.noteDragSpec = spec;
  plot.style.touchAction = spec ? 'none' : '';
  if (plot.noteDragBound) return;
  plot.noteDragBound = true;
  let pointer = null;
  const move = event => {
    const config = plot.noteDragSpec;
    if (!config) return;
    const area = plot.querySelector('.nsewdrag');
    const axis = plot._fullLayout?.xaxis;
    if (!area || !axis || (axis.type && axis.type !== 'linear')) return;
    const rect = area.getBoundingClientRect();
    if (!rect.width) return;
    const widget = Object.values(state.runtime?.outputs || {}).flatMap(output => output.result?.widgets || [])
      .find(widget => widget.name === config.widget && ['slider','number'].includes(widget.type));
    if (!widget || widget.disabled || widget.steps?.length) return;
    let value = axis.range[0] + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * (axis.range[1] - axis.range[0]);
    const step = widget.step || 0.01;
    const minimum = widget.minimum ?? Math.min(...axis.range);
    const maximum = widget.maximum ?? Math.max(...axis.range);
    value = Math.max(minimum, Math.min(maximum, Number((minimum + Math.round((value-minimum)/step)*step).toFixed(10))));
    // Keep the visible control in sync while Python processes the latest location.
    for (const input of document.querySelectorAll('input[data-key]')) {
      if (input.dataset.key !== widget.key) continue;
      input.value = value;
      const output = input.parentElement?.querySelector('output');
      if (output) output.textContent = String(value);
    }
    state.controls.set(widget.key, value);
    flushControls();
  };
  plot.addEventListener('pointerdown', event => {
    if (!plot.noteDragSpec || event.button !== 0 || pointer !== null) return;
    const area = plot.querySelector('.nsewdrag');
    if (!area) return;
    const rect = area.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
    pointer = event.pointerId;
    plot.setPointerCapture(pointer);
    event.preventDefault(); event.stopImmediatePropagation(); move(event);
  }, true);
  plot.addEventListener('pointermove', event => {
    if (event.pointerId !== pointer) return;
    event.preventDefault(); event.stopImmediatePropagation(); move(event);
  }, true);
  const finish = event => {
    if (event.pointerId !== pointer) return;
    if (event.type === 'pointerup') move(event);
    pointer = null;
    if (plot.hasPointerCapture(event.pointerId)) plot.releasePointerCapture(event.pointerId);
  };
  plot.addEventListener('pointerup', finish, true);
  plot.addEventListener('pointercancel', finish, true);
  plot.addEventListener('lostpointercapture', () => { pointer = null; });
}
function updateOutput(cell) {
  const container = state.outputs.get(cell.id);
  if (!container) return;
  const output = state.runtime?.outputs[cell.id];
  const error = state.runtime?.errors[cell.id];
  container.classList.toggle('cell-stale', state.runtimeDirty);
  if (!container.children.length) container.innerHTML = '<div class="control-row" hidden></div><pre class="stdout" hidden></pre><div class="result"></div><pre class="error-output" hidden></pre>';
  const controls = $('.control-row', container);
  const specs = output?.controls || [];
  const controlLayout = output?.result?.figure?.layout?.meta?.noteControls;
  const stepper = controlLayout?.style === 'stepper';
  // Move, rather than rebuild, so focused controls remain stable during updates.
  if (controlLayout?.position === 'bottom') container.insertBefore(controls, $('.error-output', container));
  else if (container.firstElementChild !== controls) container.prepend(controls);
  const signature = JSON.stringify({specs:specs.map(({value,...rest}) => rest), stepper});
  if (controls.dataset.signature !== signature) {
    controls.dataset.signature = signature;
    controls.replaceChildren(...specs.map(spec => createNoteControl(spec, stepper)));
  }
  controls.hidden = !specs.length;
  for (const input of controls.querySelectorAll('input')) {
    const spec = specs.find(s => s.key === input.dataset.key);
    input.disabled = !!spec.disabled;
    if (document.activeElement !== input && !state.controls.has(spec.key)) {
      input.value = spec.value;
      const outputValue = input.closest('.control').querySelector('output');
      outputValue.textContent = Number(spec.value).toFixed(2);
    }
    if (stepper) syncNoteStepper(input, spec);
  }
  const stdout = $('.stdout', container); stdout.textContent = output?.stdout || ''; stdout.hidden = !stdout.textContent;
  const errorBox = $('.error-output', container); errorBox.textContent = error || ''; errorBox.hidden = !error;
  const card = document.getElementById('cell-' + cell.id);
  if (card) syncCodeCellStatus(card,cell);
  const badge = document.querySelector(`#cell-${cell.id} .cell-status`);
  if (badge) badge.textContent = error ? '运行失败' : '';
  const result = $('.result', container), content = output?.result;
  if (!content) {
    purgeResultPlots(result);
    result.replaceChildren(); result.dataset.kind = ''; return;
  }
  if (content.kind === 'plotly') {
    if (result.dataset.kind !== 'plotly') { purgeResultPlots(result); result.replaceChildren(); const plot = document.createElement('div'); plot.className = 'plot'; result.append(plot); }
    const plot = result.firstElementChild;
    bindPlotDragX(plot, controlLayout?.dragX);
    const signature = JSON.stringify(content.figure);
    if (plot.noteFigureSignature === signature) { result.dataset.kind = content.kind; return; }
    plot.noteFigureSignature = signature;
    const figure = themePlotFigure(content.figure);
    figure.layout ||= {}; figure.layout.autosize = true;
    delete figure.layout.width;
    figure.layout.uirevision = cell.id;
    if (state.cameras.has(cell.id)) { figure.layout.scene ||= {}; figure.layout.scene.camera = state.cameras.get(cell.id); }
    const initial = !plot.data;
    Plotly.react(plot, figure.data, figure.layout, {responsive:true, displaylogo:false,
      modeBarButtonsToRemove:['toImage','sendDataToCloud']}).then(() => {
      if (initial) plot.on('plotly_relayout', event => {
        if (event['scene.camera']) state.cameras.set(cell.id, event['scene.camera']);
      });
    }).catch(error => { plot.noteFigureSignature = null; errorBox.hidden = false; errorBox.textContent = '图形显示失败：' + error.message; });
  } else if (content.kind === 'marimo') {
    renderMarimoOutput(result,content,errorBox);
  } else if (content.kind === 'markdown') {
    purgeResultPlots(result);
    result.innerHTML = '<div class="result-markdown">' + markdown(content.text) + '</div>';
  } else {
    purgeResultPlots(result);
    result.replaceChildren(); const pre = document.createElement('pre'); pre.className = 'result-text'; pre.textContent = content.text; result.append(pre);
  }
  result.dataset.kind = content.kind;
}
let plotResizeFrame=0;
function resizePlots() {
  if(plotResizeFrame)return;
  plotResizeFrame=requestAnimationFrame(()=>{
    plotResizeFrame=0;
    // Panel, cell and window observers can all fire before the same paint.
    const visible=[...document.querySelectorAll('.plot')].filter(plot=>plot.offsetWidth&&plot.data);
    visible.forEach(plot=>Plotly.Plots.resize(plot).catch(()=>{}));
  });
}
new ResizeObserver(resizePlots).observe($('#main'));
async function execute(options = {}) {
  if (state.busy) return;
  state.busy = true; const serial = ++runSerial; refreshCodeActions();
  $('#run-all').disabled = true; $('#run-all').textContent = '运行中…'; $('#interrupt').hidden = false;
  try {
    await save();
    allCells().filter(c => c.kind === 'html').forEach(cell => updateHtmlOutput(cell));
    const epoch = state.epoch;
    if (serial !== runSerial) return;
    const response = await api('/api/run', {...options, path:state.path});
    if (serial !== runSerial) return;
    state.runtime = response.state;
    state.runtimeDirty = state.epoch !== epoch;
    if(typeof queueAIChangeRefresh==='function')queueAIChangeRefresh();
    allCells().filter(c => c.kind === 'code').forEach(updateOutput);
    const errors = Object.keys(state.runtime.errors).length;
    $('#error-count').textContent = 'ⓧ ' + errors;
    renderInspector();
  } catch (error) {
    if (serial !== runSerial) return;
    toast(error.message);
  } finally {
    if (serial === runSerial) {
      state.busy = false; $('#run-all').disabled = false; $('#run-all').textContent = '运行全部'; $('#interrupt').hidden = true;
      refreshCodeActions(); flushControls();
    }
  }
}
function flushControls() {
  if (state.busy || !state.controls.size) return;
  const [key, value] = state.controls.entries().next().value;
  state.controls.delete(key);
  execute({control:{key,value}});
}
function jumpToCell(id) {
  const index = state.doc.slides.findIndex(s => s.cells.some(c => c.id === id));
  if (index < 0) return;
  graphView.expanded = false;
  state.selectedCell = id; state.mode = 'edit'; navigate(index);
  document.getElementById('cell-' + id)?.scrollIntoView({behavior:'smooth', block:'center'});
}
function renderInspector() {
  syncAISelection();
  const panel = $('#inspector'), container = $('#inspector-content'); panel.hidden = !state.panel;
  ['files','packages','outline','graph','variables','ai','help'].forEach(name => {
    const active = state.panel === name;
    $('#' + name + '-button').classList.toggle('active', active);
    $('#' + name + '-button').setAttribute('aria-pressed', String(active));
  });
  panel.dataset.panel = state.panel || '';
  document.body.classList.toggle('ai-sidebar-open',state.panel==='ai');
  document.body.classList.toggle('graph-expanded', state.panel === 'graph' && graphView.expanded);
  $('#expand-inspector').hidden = state.panel !== 'graph';
  syncToolPanelWidth();
  if (!state.panel) return;
  $('#inspector-title').textContent = {files:'FILES', packages:'PACKAGES', outline:'OUTLINE', graph:'DEPENDENCY GRAPH', variables:'VARIABLES', ai:'AI 助手', help:'使用说明'}[state.panel];
  if (state.panel === 'help') {
    container.innerHTML = '<div class="help-content"><p>每个页面容纳多个 cell。文字支持 Markdown 和公式，Python 的最后一个表达式会成为输出。</p><p><b>编辑：</b>Markdown 默认使用 Obsidian 式实时预览，光标所在结构显示源码，其余内容保持渲染。单元格模式按钮可选择实时预览、源码或阅读视图；Ctrl+Q 切换实时预览与源码，Ctrl+E 切换阅读与编辑。Shift + Enter 运行当前代码及下游。修改代码后需运行；拖动控件自动更新。</p><p><b>放映：</b>直接显示的 cell 一起出现；Fragment 用 → 逐个展开；Skip 只隐藏展示，仍参与计算。Esc 回到编辑。</p><p><b>控件接口</b></p><pre><code>x = note.slider("x", -2, 2,\n    step=0.05, value=0.8)</code></pre><p>文本输出：<code>note.markdown("**结果**")</code>。Plotly Figure 可以直接作为最后一个表达式。</p><p>一个变量只在一个 cell 中定义。跨 cell 变量引用会形成依赖。函数内部的全局变量也会计入。</p><p>笔记内容自动存到本机。滑杆数值与变量保留在当前 Python 会话；服务重启后恢复代码中的初值。导出按钮可保存 JSON 副本。</p><p>运行按钮旁的 ■ 可以中断计算。终端 Ctrl+C 同时停止服务和 Python。单次计算上限 20 秒。</p></div>';
    return;
  }
  renderToolPanel(container);
}
let shortcutFullscreen = false;
function setMode(mode, fullscreen = false) {
  state.mode = mode;
  if (mode === 'present') graphView.expanded = false;
  if (mode === 'present') save().catch(() => {});
  if (mode === 'edit' && document.fullscreenElement) { shortcutFullscreen=false; document.exitFullscreen().catch(() => {}); }
  render();
  if (mode === 'present' && fullscreen && !document.fullscreenElement) {
    shortcutFullscreen=true;
    document.documentElement.requestFullscreen().catch(() => { shortcutFullscreen=false; });
  }
}
function editSelectedCell() {
  const cell = allCells().find(c => c.id === state.selectedCell) || slide().cells.find(c => c.kind === 'code' && c.display !== 'skip') || slide().cells[0];
  if (!cell) { toast('当前页面还没有 cell，可在页面下方添加。'); return; }
  if (cell.kind === 'markdown') state.markdownEditing.add(cell.id);
  setMode('edit'); jumpToCell(cell.id);
  focusCellEditor(cell);
}
document.addEventListener('fullscreenchange',() => {
  if (!document.fullscreenElement && shortcutFullscreen) { shortcutFullscreen=false; state.mode='edit'; render(); }
});
$('#mode-edit').onclick = () => setMode('edit');
$('#mode-present').onclick = () => setMode('present');
$('#run-all').onclick = () => execute({force:true});
$('#interrupt').onclick = async () => {
  ++runSerial; state.controls.clear();
  try { await api('/api/interrupt', {path:state.path}); toast('计算已停止；再次运行会重建 Python 会话。'); }
  catch (error) { toast(error.message); }
  state.busy = false; state.runtimeDirty = true; refreshCodeActions();
  $('#run-all').disabled = false; $('#run-all').textContent = '运行全部'; $('#interrupt').hidden = true;
  document.querySelectorAll('.cell-output').forEach(el => el.classList.add('cell-stale'));
};
function syncSidebarToggle() {
  const collapsed=document.body.classList.contains('sidebar-collapsed');
  const toggle=$('#toggle-sidebar'),label=collapsed?'展开当前笔记页面目录':'收起当前笔记页面目录';
  toggle.disabled=!state.doc;
  toggle.setAttribute('aria-expanded',String(!collapsed));toggle.setAttribute('aria-label',label);toggle.title=label;
  toggle.innerHTML=uiIcon(collapsed?'panel-left-open':'panel-left-close');
}
$('#toggle-sidebar').onclick = () => {
  if(!state.doc||!state.path)return;
  document.body.classList.toggle('sidebar-collapsed');
  try{localStorage.setItem(notebookSidebarKey(state.path),document.body.classList.contains('sidebar-collapsed')?'collapsed':'expanded');}catch{}
  syncSidebarToggle();
  resizePlots();
};
function notebookSidebarKey(path){return 'slide-notes-notebook-sidebar:'+JSON.stringify([new URL(location.href).searchParams.get('workspace')||'legacy',path]);}
function restoreNotebookSidebar(){
  let collapsed=false;
  try{collapsed=!!state.doc&&!!state.path&&localStorage.getItem(notebookSidebarKey(state.path))==='collapsed';}catch{}
  document.body.classList.toggle('sidebar-collapsed',collapsed);syncSidebarToggle();
}
function remapNotebookSidebar(remap){
  const prefix='slide-notes-notebook-sidebar:',workspace=new URL(location.href).searchParams.get('workspace')||'legacy';
  try{for(const key of Object.keys(localStorage)){
    if(!key.startsWith(prefix))continue;let parts;try{parts=JSON.parse(key.slice(prefix.length));}catch{continue;}
    if(!Array.isArray(parts)||parts[0]!==workspace||typeof parts[1]!=='string')continue;
    const next=remap(parts[1]);if(next===parts[1])continue;
    localStorage.setItem(notebookSidebarKey(next),localStorage.getItem(key));localStorage.removeItem(key);
  }}catch{}
}
$('#document-title').oninput = event => { state.doc.title = event.target.value || '未命名笔记'; updateEditorTitle(state.path,state.doc.title); dirty(false,'document-title'); };
$('#document-title').onkeydown = event => { if(event.key === 'Enter'){event.preventDefault();event.target.blur();} };
$('#slide-name').oninput = event => { slide().name = event.target.value; dirty(false,'slide-title:'+slide().id); renderSidebar(); if(state.panel==='outline')drawOutline(); };
$('#add-slide').onclick = () => {
  state.doc.slides.push({id:uid(), name:'未命名页面', cells:[]}); state.active = state.doc.slides.length - 1;
  dirty(); render(); $('#slide-name').focus(); $('#slide-name').select();
};
$('#delete-slide').onclick = () => deleteSlideAt(state.active);
function moveSlide(direction) {
  const pages = state.doc.slides, i = state.active;
  [pages[i],pages[i+direction]] = [pages[i+direction],pages[i]];
  state.active += direction; dirty(); render();
}
$('#slide-up').onclick = () => moveSlide(-1); $('#slide-down').onclick = () => moveSlide(1);
['files','packages','outline','graph','variables','ai','help'].forEach(name => $('#' + name + '-button').onclick = () => {
  state.panel = state.panel === name ? null : name; renderInspector(); resizePlots();
});
$('#close-inspector').onclick = () => { state.panel = null; renderInspector(); resizePlots(); };
$('#export').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state.doc,null,2)],{type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = (state.doc.title || 'notebook') + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
};
window.addEventListener('keydown', event => {
  if (!state.doc || editorTabs.switching || !$('#workspace-file-menu').hidden) return;
  if (document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); save().catch(() => {}); return; }
  if (event.target.closest('input,textarea,select,[contenteditable]')) return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); setMode(state.mode === 'present' ? 'edit' : 'present',state.mode !== 'present'); return; }
  if (event.key.toLowerCase() === 'c') { event.preventDefault(); editSelectedCell(); return; }
  if (state.mode === 'present') {
    if (event.key === 'ArrowRight' || event.key === ' ') { event.preventDefault(); next(); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); previous(); }
    if (event.key === 'Escape') setMode('edit');
  }
});
window.addEventListener('beforeunload', event => {
  if (state.epoch !== state.savedEpoch) { event.preventDefault(); event.returnValue = ''; }
});
async function init() {
  try {
    document.body.classList.remove('sidebar-collapsed');
    syncSidebarToggle();
    state.panel = null;
    if(document.body.dataset.managedWorkbench){await initWorkspaceWorkbench();return;}
    await openNotebook();
    pollMetrics();
  } catch (error) { syncWorkbenchAvailability(false);toast('无法打开笔记：' + error.message); $('#save-status').textContent = '打开失败'; }
  finally {
    // Build one settled surface before exposing it: source fonts and the first
    // CodeMirror measurement must not visibly reflow a restored notebook.
    await document.fonts.ready;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    document.documentElement.classList.remove('workbench-loading');
    $('#workbench-loading').hidden=true;
  }
}
