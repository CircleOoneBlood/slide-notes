'use strict';
const outlineView = {query:'',collapsed:new Set(),active:null};
const outlineKey = id => state.path + ':' + id;

function outlineHeadings(source) {
  const headings=[];
  marked.walkTokens(marked.lexer(source),token=>{
    if(token.type!=='heading')return;
    const text=document.createElement('span');
    text.innerHTML=DOMPurify.sanitize(marked.parseInline(token.text));
    headings.push({level:token.depth,title:text.textContent || '无标题'});
  });
  return headings;
}
function outlineSections() {
  return state.doc.slides.map((page,index)=>({page,index,headings:page.cells.flatMap(cell=>{
    const output=state.runtime?.outputs[cell.id]?.result;
    const source=cell.kind==='markdown'?cell.source:output?.kind==='markdown'?output.text:'';
    return outlineHeadings(source).map((heading,headingIndex)=>({...heading,cell,headingIndex}));
  })}));
}
function renderOutline(container) {
  container.replaceChildren();
  const search=panelSearch(outlineView.query,'搜索页面或标题…');
  $('input',search).oninput=event=>{
    outlineView.query=event.target.value;
    if(outlineView.query)state.doc.slides.forEach(page=>outlineView.collapsed.delete(outlineKey(page.id)));
    drawOutline();
  };
  container.append(search);
  const toolbar=document.createElement('div');toolbar.className='outline-toolbar';
  toolbar.innerHTML=`<span id="outline-count"></span><button aria-label="展开全部大纲" title="展开全部">${uiIcon('list-plus')}</button><button aria-label="折叠全部大纲" title="折叠全部">${uiIcon('list-minus')}</button>`;
  const buttons=toolbar.querySelectorAll('button');
  buttons[0].onclick=()=>{state.doc.slides.forEach(page=>outlineView.collapsed.delete(outlineKey(page.id)));drawOutline();};
  buttons[1].onclick=()=>{state.doc.slides.forEach(page=>outlineView.collapsed.add(outlineKey(page.id)));drawOutline();};
  container.append(toolbar);
  const list=document.createElement('nav');list.id='outline-list';list.setAttribute('aria-label','笔记大纲');container.append(list);
  drawOutline();
}
function drawOutline() {
  const list=$('#outline-list');if(!list)return;
  const sections=outlineSections(),query=outlineView.query.trim().toLowerCase();
  $('#outline-count').textContent=`${sections.length} 页 · ${sections.reduce((n,s)=>n+s.headings.length,0)} 个标题`;
  list.replaceChildren();
  for(const {page,index,headings} of sections) {
    const pageMatches=page.name.toLowerCase().includes(query);
    const matches=query && !pageMatches?headings.filter(h=>h.title.toLowerCase().includes(query)):headings;
    if(query && !pageMatches && !matches.length)continue;
    const collapsed=outlineView.collapsed.has(outlineKey(page.id));
    const group=document.createElement('div');group.className='outline-group';group.dataset.slide=page.id;
    const row=document.createElement('div');row.className='outline-slide-row';
    const toggle=document.createElement('button');toggle.className='outline-toggle';toggle.innerHTML=uiIcon(collapsed?'chevron-right':'chevron-down');
    toggle.setAttribute('aria-label',(collapsed?'展开':'收起')+'大纲：'+page.name);toggle.setAttribute('aria-expanded',String(!collapsed));toggle.disabled=!headings.length;
    toggle.onclick=()=>{if(collapsed)outlineView.collapsed.delete(outlineKey(page.id));else outlineView.collapsed.add(outlineKey(page.id));drawOutline();};
    const title=document.createElement('button');title.className='outline-page';
    title.innerHTML=`<span class="outline-page-number">${String(index+1).padStart(2,'0')}</span><span>${escapeHTML(page.name || '未命名页面')}</span>`;
    title.title=page.name;title.setAttribute('aria-current',index===state.active?'page':'false');title.onclick=()=>goToOutline(page.id);
    row.append(toggle,title);group.append(row);
    if(!collapsed)for(const heading of matches) {
      const button=document.createElement('button');button.className='outline-heading';button.dataset.cell=heading.cell.id;
      button.style.setProperty('--heading-level',String(heading.level-1));button.title=heading.title;
      const active=outlineView.active===outlineKey(heading.cell.id)+':'+heading.headingIndex;
      button.classList.toggle('active',active);button.setAttribute('aria-current',active?'location':'false');
      button.innerHTML=`<span class="outline-level">H${heading.level}</span><span class="outline-heading-text">${escapeHTML(heading.title)}</span>${heading.cell.display==='skip'?'<span class="outline-skip">Skip</span>':''}`;
      button.onclick=()=>goToOutline(page.id,heading.cell,heading.headingIndex);group.append(button);
    }
    list.append(group);
  }
  if(!list.children.length)list.innerHTML='<p class="panel-empty">没有匹配的页面或标题</p>';
}
function goToOutline(slideId,cell=null,headingIndex=0) {
  const index=state.doc.slides.findIndex(page=>page.id===slideId);if(index<0)return;
  const page=state.doc.slides[index];
  outlineView.active=cell?outlineKey(cell.id)+':'+headingIndex:null;
  if(cell && state.mode==='present') {
    if(cell.display==='skip')setMode('edit');
    else if(cell.display==='fragment') {
      const position=page.cells.indexOf(cell);
      const step=page.cells.slice(0,position+1).filter(c=>c.display==='fragment').length;
      state.fragment.set(page.id,Math.max(step,state.fragment.get(page.id)||0));
    }
  }
  state.selectedCell=cell?.id || null;navigate(index);
  if(!cell)return;
  const card=document.getElementById('cell-'+cell.id);
  const content=$('.markdown-preview, .result-markdown',card);
  const target=content?.querySelectorAll('h1,h2,h3,h4,h5,h6')[headingIndex] || card;
  target.scrollIntoView({behavior:'smooth',block:'start'});
  target.tabIndex=-1;target.focus({preventScroll:true});
  target.classList.add('outline-target');setTimeout(()=>target.classList.remove('outline-target'),1000);
}
