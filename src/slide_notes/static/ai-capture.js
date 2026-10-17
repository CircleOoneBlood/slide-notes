'use strict';
// Capture positions belong to document elements, never to the browser viewport.
let aiNotebookCapture=null,aiCaptureMark=null,aiCaptureFrame=null;
// Selection references cell IDs and PDF text items. Old screenshot cards remain navigable.
async function startAIContextSelection(session){
 if(session.busy)throw Error('对话正在回复，请稍后添加');
 aiState.targetKey=session.key;removeAICaptureMark();
 const tab=typeof editorTabs==='object'&&editorTabs.items.find(tab=>tab.path===editorTabs.active);
 if(tab?.kind==='pdf'){
  aiState.picking=null;syncAISelection();const frame=$('iframe',tab.view);
  if(!frame?.dataset.aiReady)throw Error('PDF 还在加载，请稍后重试');
  frame.contentWindow.postMessage({type:'slide-notes:pdf-select',targetKey:session.key},location.origin);frame.focus();return;
 }
 if(tab?.kind==='image'){toast('图片可直接粘贴到对话；框选用于笔记和 PDF 文字');return;}
 if(!state.doc||!state.path)throw Error('请先打开笔记或 PDF');
 toggleAISelection(session);
}
let aiCellMarquee=null,aiCellClickPending=false;
function consumeAICellSelectionClick(){const pending=aiCellClickPending;aiCellClickPending=false;return pending;}
function cancelAICellMarquee(restore=true){
 const drag=aiCellMarquee;if(!drag)return;aiCellMarquee=null;cancelAnimationFrame(drag.frame);drag.box.remove();
 if(drag.main.hasPointerCapture?.(drag.pointer))drag.main.releasePointerCapture(drag.pointer);
 if(restore){drag.session.selectedCells=drag.baseline;syncAISelection();refreshAI(drag.session);}
}
function updateAICellMarquee(){
 const drag=aiCellMarquee;if(!drag)return;
 const pane=drag.main.getBoundingClientRect(),start=[pane.left+drag.start[0]-drag.main.scrollLeft,pane.top+drag.start[1]-drag.main.scrollTop];
 const end=[Math.max(pane.left,Math.min(pane.right,drag.x)),Math.max(pane.top,Math.min(pane.bottom,drag.y))];
 const rect=[Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.max(start[0],end[0]),Math.max(start[1],end[1])];
 drag.moved ||= Math.hypot(end[0]-start[0],end[1]-start[1])>=4;
 drag.box.hidden=!drag.moved;Object.assign(drag.box.style,{left:Math.max(pane.left,rect[0])+'px',top:Math.max(pane.top,rect[1])+'px',width:Math.max(0,rect[2]-Math.max(pane.left,rect[0]))+'px',height:Math.max(0,rect[3]-Math.max(pane.top,rect[1]))+'px'});
 if(!drag.moved)return;
 const ids=[...drag.baseline];
 for(const card of document.querySelectorAll('#cells .cell')){
  const b=card.getBoundingClientRect();
  if(b.width>0&&b.height>0&&b.right>=rect[0]&&b.left<=rect[2]&&b.bottom>=rect[1]&&b.top<=rect[3]&&!ids.includes(card.dataset.cell))ids.push(card.dataset.cell);
 }
 if(ids.join('|')!==drag.session.selectedCells.join('|')){drag.session.selectedCells=ids;syncAISelection();refreshAI(drag.session);}
}
function scrollAICellMarquee(){
 const drag=aiCellMarquee;if(!drag)return;const r=drag.main.getBoundingClientRect();
 const speed=value=>Math.sign(value)*Math.min(18,Math.abs(value)*.45);
 const dy=drag.y<r.top+32?speed(drag.y-r.top-32):drag.y>r.bottom-32?speed(drag.y-r.bottom+32):0;
 const dx=drag.x<r.left+24?speed(drag.x-r.left-24):drag.x>r.right-24?speed(drag.x-r.right+24):0;
 if(dx||dy){drag.main.scrollBy(dx,dy);updateAICellMarquee();}drag.frame=requestAnimationFrame(scrollAICellMarquee);
}
document.addEventListener('pointerdown',event=>{
 const session=activeAISelection(),main=document.getElementById('main');
 if(!session||event.button!==0||!main?.contains(event.target)||event.target.closest('.cell-ai-chat,.page-topline,.page-heading'))return;
 event.preventDefault();event.stopImmediatePropagation();cancelAICellMarquee();aiCellClickPending=false;
 const r=main.getBoundingClientRect(),box=document.createElement('div');box.className='ai-capture-box';box.hidden=true;document.body.append(box);
 aiCellMarquee={session,main,box,baseline:[...session.selectedCells],pointer:event.pointerId,start:[event.clientX-r.left+main.scrollLeft,event.clientY-r.top+main.scrollTop],x:event.clientX,y:event.clientY,card:event.target.closest('#cells .cell'),moved:false};
 main.setPointerCapture(event.pointerId);scrollAICellMarquee();
},true);
document.addEventListener('pointermove',event=>{
 const drag=aiCellMarquee;if(!drag||drag.pointer!==event.pointerId)return;event.preventDefault();event.stopImmediatePropagation();drag.x=event.clientX;drag.y=event.clientY;updateAICellMarquee();
},true);
document.addEventListener('pointerup',event=>{
 const drag=aiCellMarquee;if(!drag||drag.pointer!==event.pointerId)return;event.preventDefault();event.stopImmediatePropagation();drag.x=event.clientX;drag.y=event.clientY;updateAICellMarquee();
 cancelAICellMarquee(false);aiCellClickPending=true;setTimeout(()=>{aiCellClickPending=false;},0);
 if(!drag.moved&&drag.card)toggleAISelectedCell(drag.session,drag.card.dataset.cell);else{persistAI(drag.session);syncAISelection();refreshAI(drag.session);if(typeof snapshotAISelectedCells==='function')snapshotAISelectedCells(drag.session);}
},true);
document.addEventListener('click',event=>{
 if(activeAISelection()&&document.getElementById('main')?.contains(event.target)&&!event.target.closest('.cell-ai-chat,.page-topline,.page-heading')){event.preventDefault();event.stopImmediatePropagation();}
},true);
document.addEventListener('pointercancel',()=>cancelAICellMarquee(),true);
document.addEventListener('scroll',()=>{if(aiCellMarquee)updateAICellMarquee();},true);
function captureFingerprint(data){let hash=2166136261;for(const char of JSON.stringify(data)){hash^=char.codePointAt(0);hash=Math.imul(hash,16777619);}return (hash>>>0).toString(16);}
function notebookCaptureAnchor(source){
 if(state.path!==source.path||!state.doc||document.getElementById('notebook-editor').hidden)return null;
 const page=state.doc.slides.find(page=>page.id===source.slide);if(!page||slide()?.id!==source.slide)return null;
 const data=source.cell?page.cells.find(cell=>cell.id===source.cell):page;
 const element=source.cell?document.getElementById('cell-'+source.cell):document.getElementById('cells');
 return element&&data?{element,data}:null;
}
function paintAINotebookCapture(){
 aiCaptureFrame=null;const mark=aiCaptureMark;if(!mark)return;
 if(mark.source.kind==='image-region'){paintAIImageCapture(mark);return;}
 const anchor=notebookCaptureAnchor(mark.source),main=document.getElementById('main');
 if(!anchor){mark.box.hidden=true;if(mark===aiNotebookCapture)cancelAINotebookCapture();return;}
 if(mark.source.fingerprint&&captureFingerprint(anchor.data)!==mark.source.fingerprint){mark.box.hidden=true;if(mark.status)mark.status.textContent='来源内容已变化 · 保留原截图快照';return;}
 const r=anchor.element.getBoundingClientRect(),clip=main.getBoundingClientRect(),[x1,y1,x2,y2]=mark.source.rects[0];
 const left=r.left+x1*r.width,top=r.top+y1*r.height,right=r.left+x2*r.width,bottom=r.top+y2*r.height;
 const l=Math.max(left,clip.left),t=Math.max(top,clip.top),rr=Math.min(right,clip.right),b=Math.min(bottom,clip.bottom);
 mark.box.hidden=rr<=l||b<=t;Object.assign(mark.box.style,{left:l+'px',top:t+'px',width:Math.max(0,rr-l)+'px',height:Math.max(0,b-t)+'px'});
}
function queueAINotebookCapturePaint(){if(!aiCaptureFrame)aiCaptureFrame=requestAnimationFrame(paintAINotebookCapture);}
function removeAICaptureMark(){aiCaptureMark?.box.remove();aiCaptureMark=null;}
function cancelAINotebookCapture(){
 const capture=aiNotebookCapture;if(!capture)return;capture.cancelled=true;if(capture.source.kind==='image-region'){const view=aiImageAnchor(capture.source);if(view)view.onImageGeometry=queueAINotebookCapturePaint;}capture.layer.remove();capture.toolbar.remove();capture.box.remove();if(aiCaptureMark===capture)removeAICaptureMark();aiNotebookCapture=null;
}
async function openAINotebookSource(source){
 cancelAINotebookCapture();await openEditor('notebook',source.path);const index=state.doc.slides.findIndex(page=>page.id===source.slide);
 if(index<0)throw Error('原页面已不存在，截图快照仍保留');if(state.active!==index){state.active=index;render();}
 const anchor=notebookCaptureAnchor(source);if(!anchor)throw Error('原 cell 已不存在，截图快照仍保留');
 if(source.fingerprint&&captureFingerprint(anchor.data)!==source.fingerprint){removeAICaptureMark();toast('来源内容或布局已变化；已打开原位置，截图快照仍保留');anchor.element.scrollIntoView({block:'center',behavior:'smooth'});return;}
 removeAICaptureMark();const box=document.createElement('div');box.className='ai-capture-box';document.body.append(box);aiCaptureMark={box,source};
 const r=anchor.element.getBoundingClientRect(),main=document.getElementById('main'),clip=main.getBoundingClientRect(),rect=source.rects[0];main.scrollTop+=r.top+((rect[1]+rect[3])/2)*r.height-(clip.top+clip.height/2);paintAINotebookCapture();
}
document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(aiNotebookCapture||aiCaptureMark){event.preventDefault();cancelAINotebookCapture();removeAICaptureMark();}}});
document.addEventListener('scroll',queueAINotebookCapturePaint,true);
window.addEventListener('resize',()=>{aiNotebookCapture?.positionLayer();queueAINotebookCapturePaint();});
new MutationObserver(queueAINotebookCapturePaint).observe(document.getElementById('notebook-editor'),{childList:true,subtree:true});

new ResizeObserver(queueAINotebookCapturePaint).observe(document.getElementById("main"));
new MutationObserver(queueAINotebookCapturePaint).observe(document.getElementById('image-editors'),{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});

function aiImageAnchor(source){
 const tab=editorTabs.items.find(tab=>tab.kind==='image'&&tab.path===source.path);
 if(!tab?.view||editorTabs.active!==source.path)return null;
 return tab.view;
}
function paintAIImageCapture(mark){
 const view=aiImageAnchor(mark.source),image=view?.imageElement,stage=view?.imageStage;
 if(!image?.naturalWidth){mark.box.hidden=true;if(mark===aiNotebookCapture)cancelAINotebookCapture();return;}
 if(mark.source.fingerprint&&view.imageFingerprint!==mark.source.fingerprint){mark.box.hidden=true;if(mark.status)mark.status.textContent='原图已变化 · 保留截图快照';return;}
 const r=image.getBoundingClientRect(),clip=stage.getBoundingClientRect(),[x1,y1,x2,y2]=mark.source.rects[0],sx=r.width/mark.source.width,sy=r.height/mark.source.height;
 const left=Math.max(clip.left,r.left+x1*sx),top=Math.max(clip.top,r.top+y1*sy),right=Math.min(clip.left+stage.clientWidth,r.left+x2*sx),bottom=Math.min(clip.top+stage.clientHeight,r.top+y2*sy);
 mark.box.hidden=right<=left||bottom<=top;Object.assign(mark.box.style,{left:left+'px',top:top+'px',width:Math.max(0,right-left)+'px',height:Math.max(0,bottom-top)+'px'});
}
function aiImagePoint(image,event){const r=image.getBoundingClientRect();return [Math.max(0,Math.min(image.naturalWidth,(event.clientX-r.left)*image.naturalWidth/r.width)),Math.max(0,Math.min(image.naturalHeight,(event.clientY-r.top)*image.naturalHeight/r.height))];}
async function openAIImageSource(source){
 cancelAINotebookCapture();await openEditor('image',source.path);const view=aiImageAnchor(source);await view?.fileLoaded;
 if(!view?.imageElement.naturalWidth)throw Error('原图无法加载，截图快照仍保留');
 removeAICaptureMark();if(view.imageFingerprint!==source.fingerprint||view.imageElement.naturalWidth!==source.width||view.imageElement.naturalHeight!==source.height){toast('原图已变化，截图快照仍保留');return;}
 view.zoomImage(1);const image=view.imageElement,stage=view.imageStage,rect=source.rects[0],bounds=image.getBoundingClientRect(),clip=stage.getBoundingClientRect();stage.scrollLeft+=bounds.left+(rect[0]+rect[2])/2-clip.left-stage.clientWidth/2;stage.scrollTop+=bounds.top+(rect[1]+rect[3])/2-clip.top-stage.clientHeight/2;
 const box=document.createElement('div');box.className='ai-capture-box';document.body.append(box);aiCaptureMark={box,source};view.onImageGeometry=queueAINotebookCapturePaint;paintAIImageCapture(aiCaptureMark);
}
