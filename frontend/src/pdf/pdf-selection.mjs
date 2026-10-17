/* Source-linked PDF text selection. No canvas rendering or screenshot upload. */
export function setupPDFSelection({getViewer,getDocument,isReady,getRevision}){
 const container=document.querySelector('#viewerContainer'),selectButton=document.querySelector('#pdf-select');
 const menu=document.createElement('div');menu.className='pdf-selection-menu';menu.hidden=true;menu.setAttribute('role','region');menu.setAttribute('aria-label','PDF 选区操作');
 menu.innerHTML='<div class="pdf-selection-heading"><strong></strong><button type="button" class="selection-close" aria-label="取消选区">×</button></div><div class="selection-excerpt"></div><label class="selection-target"><span>加入</span><select aria-label="目标对话"></select></label><div class="selection-actions"><span role="status"></span><button type="button" class="selection-copy">复制文字</button><button type="button" class="selection-add">加入对话</button></div>';
 document.body.append(menu);
 const query=selector=>menu.querySelector(selector),target=query('select'),add=query('.selection-add'),notice=query('[role=status]'),pending=new Map(),contentCache=new WeakMap();
 let candidate=null,drag=null,selecting=false,destination=null,selectionTimer=null,pendingLocate=null,highlights=[],activeSources=[],repaintTimer=null,obstacles=[],busy=false,epoch=0;
 function post(data){if(window.parent!==window)window.parent.postMessage(data,location.origin);}
 function requestTargets(){post({type:'slide-notes:pdf-targets-request'});}
 function clearHighlights(){for(const item of highlights)item.remove();highlights=[];}
 function hide(){candidate=null;menu.hidden=true;notice.textContent='';}
 function mode(active,key=null){
  epoch++;selecting=active;destination=active?key:null;selectButton.setAttribute('aria-pressed',String(active));container.classList.toggle('pdf-select-mode',active);
  if(drag){cancelAnimationFrame(drag.frame);drag.box.remove();if(container.hasPointerCapture(drag.pointer))container.releasePointerCapture(drag.pointer);drag=null;}
  post({type:'slide-notes:pdf-select-state',targetKey:destination,active});
 }
 function viewportRect(viewport,rect){return [...viewport.convertToViewportPoint(rect[0],rect[1]),...viewport.convertToViewportPoint(rect[2],rect[3])];}
 function pdfRect(view,r){
  const bounds=view.div.getBoundingClientRect(),v=view.viewport;
  const a=v.convertToPdfPoint((r.left-bounds.left)*v.width/bounds.width,(r.top-bounds.top)*v.height/bounds.height),b=v.convertToPdfPoint((r.right-bounds.left)*v.width/bounds.width,(r.bottom-bounds.top)*v.height/bounds.height);
  return [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])];
 }
 function overlaps(a,b){return a.width>0&&a.height>0&&a.right>=b.left&&a.left<=b.right&&a.bottom>=b.top&&a.top<=b.bottom;}
 async function textItems(view){
  const doc=getDocument();let cache=contentCache.get(doc);if(!cache){cache=new Map();contentCache.set(doc,cache);}
  if(!cache.has(view.id))cache.set(view.id,doc.getPage(view.id).then(page=>page.getTextContent({disableNormalization:true})).then(content=>content.items.filter(item=>typeof item.str==='string')).catch(error=>{cache.delete(view.id);throw error;}));
  return cache.get(view.id);
 }
 function textRange(span,from,to){
  // Search highlighting may split an item into several text nodes. Offsets still refer to the original PDF.js item.
  const walker=document.createTreeWalker(span,NodeFilter.SHOW_TEXT),nodes=[];let node,offset=0;
  while((node=walker.nextNode())){nodes.push({node,start:offset,end:offset+node.length});offset+=node.length;}
  const first=nodes.find(n=>n.end>from),last=nodes.find(n=>n.end>=to);if(!first||!last)return null;
  const range=document.createRange();range.setStart(first.node,from-first.start);range.setEnd(last.node,to-last.start);return range;
 }
 async function excerpts({rect=null,range=null,click=false}){
  const selections=[];
  for(const page of container.querySelectorAll('.page')){
   if(rect&&!overlaps(page.getBoundingClientRect(),rect))continue;
   const layer=page.querySelector('.textLayer');if(!layer||range&&!range.intersectsNode(layer))continue;
   const view=getViewer().getPageView(Number(page.dataset.pageNumber)-1);if(!view?.viewport)continue;
   const mapping=view.textLayer?.highlighter,divs=mapping?.textDivs,items=await textItems(view);if(!items.length)continue;
   // Never guess source indices from nested marked-content or search-highlight DOM spans.
   if(!divs||divs.length!==items.length)throw Error('文字层正在加载，请稍后重新选择');
   const entry={...(getRevision?.()?{sourceRevision:getRevision()}:{}),page:view.id,fingerprint:getDocument().fingerprints[0]||'',kind:'pdf-elements',rects:[],text:'',elements:[]};let previous=null;
   for(let index=0;index<items.length;index++){
    const item=items[index],span=divs[index];if(!item.str||!span.isConnected)continue;
    if(span.textContent!==item.str)throw Error('PDF 文字层已变化，请重新打开后选择');
    if(rect&&!overlaps(span.getBoundingClientRect(),rect)||range&&!range.intersectsNode(span))continue;
    const runs=[];let begin=null;
    for(let from=0;from<item.str.length;){
     const to=from+String.fromCodePoint(item.str.codePointAt(from)).length,part=textRange(span,from,to);let hit=false;
     if(part){if(rect)hit=click||[...part.getClientRects()].some(r=>overlaps(r,rect));else hit=range.compareBoundaryPoints(Range.END_TO_START,part)<0&&range.compareBoundaryPoints(Range.START_TO_END,part)>0;}
     if(hit&&begin===null)begin=from;
     if(!hit&&begin!==null){runs.push([begin,from]);begin=null;}from=to;
    }
    if(begin!==null)runs.push([begin,item.str.length]);
    for(const [from,to] of runs){
     const part=textRange(span,from,to),r=part.getBoundingClientRect(),text=item.str.slice(from,to);
     entry.text+=(previous?(previous.eol||Math.abs(previous.rect.top-r.top)>Math.max(3,r.height*.5)?'\n':Math.abs(r.left-previous.rect.right)>1?' ':''):'')+text;
     entry.elements.push({index,from,to});entry.rects.push(pdfRect(view,r));previous={rect:r,eol:item.hasEOL&&to===item.str.length};
     if(entry.elements.length>200||entry.text.length>16000)throw Error('选区较大，请分段选择');
    }
   }
   if(entry.text.trim())selections.push(entry);if(selections.length>20)throw Error('选区较大，请分段选择');
  }
  return selections;
 }
 function paintSource(scroll=false){
  if(!isReady())return;clearHighlights();
  for(const source of activeSources){const view=getViewer().getPageView(source.page-1);if(!view?.viewport)continue;const bounds=view.div.getBoundingClientRect(),sx=bounds.width/view.viewport.width,sy=bounds.height/view.viewport.height;
   for(const rect of source.rects.slice(0,200)){
    if(!Array.isArray(rect)||rect.length!==4||!rect.every(Number.isFinite))continue;
    const r=viewportRect(view.viewport,rect),el=document.createElement('div');el.className='pdf-source-highlight';Object.assign(el.style,{left:Math.min(r[0],r[2])*sx+'px',top:Math.min(r[1],r[3])*sy+'px',width:Math.abs(r[2]-r[0])*sx+'px',height:Math.abs(r[3]-r[1])*sy+'px'});view.div.append(el);highlights.push(el);
   }
  }
  if(scroll)highlights[0]?.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
 }
 function show(selections,x,y){
  if(!selections.length)return;candidate={selections,x,y};activeSources=[...selections];paintSource();requestTargets();menu.hidden=false;notice.textContent='';add.disabled=false;
  query('strong').textContent='已选原文 · '+selections.length+' 页';query('.selection-excerpt').textContent=selections.map(s=>s.text).join('\n').slice(0,500);position();
 }
 function position(){
  if(!candidate)return;const width=Math.min(410,innerWidth-24);menu.style.width=width+'px';const height=menu.getBoundingClientRect().height;
  const candidates=[[candidate.x,candidate.y+12],[candidate.x-width-12,candidate.y+12],[candidate.x,candidate.y-height-12],[12,54],[innerWidth-width-12,54],[12,innerHeight-height-12]];let best=null;
  for(const [rawX,rawY] of candidates){const x=Math.max(12,Math.min(innerWidth-width-12,rawX)),y=Math.max(54,Math.min(innerHeight-height-12,rawY));let overlap=0;
   for(const r of obstacles)overlap+=Math.max(0,Math.min(x+width,r.right)-Math.max(x,r.left))*Math.max(0,Math.min(y+height,r.bottom)-Math.max(y,r.top));
   if(!best||overlap<best.overlap)best={x,y,overlap};if(overlap===0)break;
  }menu.style.left=best.x+'px';menu.style.top=best.y+'px';
 }
 async function selectedText(){
  if(selecting||busy||!isReady()||menu.contains(document.activeElement))return;
  const selection=getSelection();if(!selection||selection.isCollapsed||!selection.rangeCount)return;
  const range=selection.getRangeAt(0).cloneRange(),generation=epoch;
  try{const selections=await excerpts({range});if(generation!==epoch||selecting)return;const r=range.getBoundingClientRect();show(selections,r.left,Math.min(r.bottom,innerHeight-100));}catch(error){showStatus(error.message);}
 }
 let toastTimer;function showStatus(text){let el=document.querySelector('.pdf-selection-toast');if(!el){el=document.createElement('div');el.className='pdf-selection-toast';el.setAttribute('role','status');document.body.append(el);}el.textContent=text;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.remove(),3500);}
 async function attach(selections,key){
  if(window.parent===window)throw Error('请在 Note 工作区中加入对话');const id=crypto.randomUUID();
  // A multi-page selection is committed atomically, including attachment-limit checks.
  const title=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('加入超时，请检查对话窗口'));},20000);pending.set(id,{resolve,reject,timer});post({type:'slide-notes:pdf-add',id,targetKey:key,sources:selections});});
  selections.splice(0);return title;
 }
 selectButton.onclick=()=>{if(!isReady())return;hide();mode(!selecting,'__pdf__');if(selecting)showStatus('拖框或单点选择原文 · 自动加入对话 · Esc 完成');};
 function moveDrag(){
  if(!drag)return;const bounds=container.getBoundingClientRect(),a=[bounds.left+drag.start[0]-container.scrollLeft,bounds.top+drag.start[1]-container.scrollTop],b=[Math.max(bounds.left,Math.min(bounds.right,drag.x)),Math.max(bounds.top,Math.min(bounds.bottom,drag.y))];
  drag.rect={left:Math.min(a[0],b[0]),top:Math.min(a[1],b[1]),right:Math.max(a[0],b[0]),bottom:Math.max(a[1],b[1])};
  Object.assign(drag.box.style,{left:Math.max(bounds.left,drag.rect.left)+'px',top:Math.max(bounds.top,drag.rect.top)+'px',width:Math.max(0,drag.rect.right-Math.max(bounds.left,drag.rect.left))+'px',height:Math.max(0,drag.rect.bottom-Math.max(bounds.top,drag.rect.top))+'px'});
 }
 function scrollDrag(){if(!drag)return;const r=container.getBoundingClientRect(),delta=drag.y<r.top+30?drag.y-r.top-30:drag.y>r.bottom-30?drag.y-r.bottom+30:0;const dx=drag.x<r.left+24?drag.x-r.left-24:drag.x>r.right-24?drag.x-r.right+24:0;if(delta||dx){container.scrollBy(Math.sign(dx)*Math.min(18,Math.abs(dx)*.4),Math.sign(delta)*Math.min(18,Math.abs(delta)*.4));moveDrag();}drag.frame=requestAnimationFrame(scrollDrag);}
 container.addEventListener('pointerdown',event=>{
  if(!selecting||busy||event.button!==0)return;event.preventDefault();event.stopImmediatePropagation();epoch++;hide();getSelection()?.removeAllRanges();activeSources=[];clearHighlights();
  const r=container.getBoundingClientRect(),box=document.createElement('div');box.className='pdf-element-marquee';document.body.append(box);drag={start:[event.clientX-r.left+container.scrollLeft,event.clientY-r.top+container.scrollTop],x:event.clientX,y:event.clientY,box,pointer:event.pointerId};container.setPointerCapture(event.pointerId);moveDrag();scrollDrag();
 },true);
 container.addEventListener('pointermove',event=>{if(!drag||drag.pointer!==event.pointerId)return;event.preventDefault();drag.x=event.clientX;drag.y=event.clientY;moveDrag();});
 container.addEventListener('pointerup',async event=>{
  if(!drag){if(!selecting)setTimeout(selectedText,10);return;}if(drag.pointer!==event.pointerId)return;event.preventDefault();
  drag.x=event.clientX;drag.y=event.clientY;moveDrag();const current=drag,key=destination,generation=epoch;drag=null;cancelAnimationFrame(current.frame);current.box.remove();container.releasePointerCapture(event.pointerId);
  const rect=current.rect,click=Math.hypot(rect.right-rect.left,rect.bottom-rect.top)<4;if(click){rect.left=event.clientX-1;rect.top=event.clientY-1;rect.right=event.clientX+1;rect.bottom=event.clientY+1;}
  busy=true;
  try{const selections=await excerpts({rect,click});if(generation!==epoch)return;if(!selections.length){showStatus('此区域没有可选文字；扫描图片可手动截图后粘贴');return;}activeSources=[...selections];paintSource();const title=await attach(selections,key||'__pdf__');showStatus('原文已加入 '+title+' · 可继续框选');}
  catch(error){showStatus(error.message);}finally{busy=false;}
 });
 container.addEventListener('pointercancel',()=>mode(false));
 // Do not activate PDF links/form controls after a selection gesture.
 container.addEventListener('click',event=>{if(selecting){event.preventDefault();event.stopImmediatePropagation();}},true);
 document.addEventListener('selectionchange',()=>{clearTimeout(selectionTimer);if(!selecting&&!menu.contains(document.activeElement))hide();selectionTimer=setTimeout(selectedText,100);});
 document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target)&&!event.target.closest('.textLayer')&&!selecting){epoch++;hide();}});
 menu.addEventListener('pointerdown',event=>{if(event.target.closest('button'))event.preventDefault();});query('.selection-close').onclick=()=>{epoch++;hide();};target.onfocus=requestTargets;
 query('.selection-copy').onclick=async()=>{try{await navigator.clipboard.writeText(candidate.selections.map(s=>s.text).join('\n\n'));notice.textContent='已复制';}catch{notice.textContent='无法复制，请使用 Ctrl+C';}};
 add.onclick=async()=>{if(!candidate||busy)return;const selected=candidate;busy=true;add.disabled=true;query('.selection-close').disabled=true;notice.textContent='正在加入…';try{const title=await attach(selected.selections,target.value);notice.textContent='已加入 '+title;setTimeout(()=>{if(candidate===selected)hide();},1100);}catch(error){notice.textContent=error.message;}finally{busy=false;add.disabled=false;query('.selection-close').disabled=false;}};
 function locate(source){
  if(!isReady()){pendingLocate=source;return;}if(source.fingerprint&&source.fingerprint!==getDocument().fingerprints[0]){showStatus('PDF 文件已变化，原选区可能不再对应');return;}
  if(!Number.isInteger(source.page)||source.page<1||source.page>getDocument().numPages||!Array.isArray(source.rects))return;
  mode(false);activeSources=[source];getViewer().scrollPageIntoView({pageNumber:source.page});requestAnimationFrame(()=>paintSource(true));
 }
 function repaint(){clearTimeout(repaintTimer);if(activeSources.length)repaintTimer=setTimeout(()=>paintSource(),140);}
 window.addEventListener('message',event=>{
  if(event.source!==window.parent||event.origin!==location.origin)return;const data=event.data;if(!data)return;
  if(data.type==='slide-notes:pdf-targets'){
   obstacles=Array.isArray(data.obstacles)?data.obstacles.filter(r=>r&&['left','top','right','bottom'].every(key=>Number.isFinite(r[key]))):[];const previous=target.value;target.replaceChildren();
   for(const item of data.targets||[]){const option=document.createElement('option');option.value=item.key;option.textContent=item.label+(item.busy?'（回复中）':'');option.disabled=item.busy;target.append(option);}
   const option=document.createElement('option');option.value='__pdf__';option.textContent='此 PDF 的全局对话';target.append(option);target.value=[...target.options].some(o=>o.value===previous&&!o.disabled)?previous:data.preferred||'__pdf__';if(!target.value)target.value='__pdf__';position();
  }
  if(data.type==='slide-notes:pdf-select-stop')mode(false);
  if(data.type==='slide-notes:pdf-select'&&typeof data.targetKey==='string'&&isReady()){hide();mode(!(selecting&&destination===data.targetKey),data.targetKey);if(selecting)showStatus('拖框或单点选择原文 · 自动加入当前对话 · Esc 完成');}
  if(data.type==='slide-notes:pdf-added'){const request=pending.get(data.id);if(request){clearTimeout(request.timer);pending.delete(data.id);if(data.error)request.reject(Error(data.error));else request.resolve(data.title);}}
  if(data.type==='slide-notes:pdf-locate'&&data.source)locate(data.source);
 });
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&(selecting||candidate||activeSources.length)){event.preventDefault();event.stopPropagation();epoch++;hide();mode(false);activeSources=[];clearHighlights();}});
 function repositionCandidate(){if(!candidate)return;const source=candidate.selections[0];if(!source)return;const view=getViewer().getPageView(source.page-1);if(!view?.viewport)return;const b=view.div.getBoundingClientRect(),r=viewportRect(view.viewport,source.rects[0]);candidate.x=b.left+Math.min(r[0],r[2])*b.width/view.viewport.width;candidate.y=b.top+Math.max(r[1],r[3])*b.height/view.viewport.height;position();}
 container.addEventListener('scroll',()=>{moveDrag();repositionCandidate();},{passive:true});window.addEventListener('resize',()=>{moveDrag();repaint();repositionCandidate();});
 return {ready(){selectButton.disabled=false;post({type:'slide-notes:pdf-ready'});if(pendingLocate){locate(pendingLocate);pendingLocate=null;}},viewChanged(){clearHighlights();mode(false);repaint();repositionCandidate();},rendered(){repaint();}};
}
