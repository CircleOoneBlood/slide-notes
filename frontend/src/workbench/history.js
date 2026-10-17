'use strict';
const notebookHistories=new Map();
let applyingHistory=false;
function historySnapshot(){return {doc:structuredClone(state.doc),active:state.active,selected:state.selectedCell};}
function ensureNotebookHistory(){
  if(!state.doc||!state.path)return null;
  if(!notebookHistories.has(state.path))notebookHistories.set(state.path,{past:[],future:[],baseline:historySnapshot(),group:null,time:0});
  return notebookHistories.get(state.path);
}
function rememberHistorySource(history,group){
  history.source=null;
  // Only native cell editors use this group: each callback changes that cell's
  // source, then immediately records it. Structural changes use other groups.
  if(typeof group!=='string'||!group.startsWith('source:'))return;
  const id=group.slice(7),slides=state.doc.slides;
  for(let page=0;page<slides.length;page++){
    const cells=slides[page].cells,index=cells.findIndex(cell=>cell.id===id);
    if(index<0)continue;
    const baselineCell=history.baseline.doc.slides[page]?.cells[index];
    if(baselineCell?.id===id)history.source={document:state.doc,slides,page,cells,index,cell:cells[index],baseline:history.baseline,baselineCell,slideCount:slides.length,cellCount:cells.length};
    return;
  }
}
function recordDocumentChange(group){
  const history=ensureNotebookHistory();if(!history||applyingHistory)return;
  const now=Date.now();
  const source=history.source;
  if(group&&history.group===group&&now-history.time<=900&&source&&source.document===state.doc&&
    source.baseline===history.baseline&&source.slides===state.doc.slides&&source.slideCount===state.doc.slides.length&&
    source.cells===state.doc.slides[source.page]?.cells&&source.cellCount===source.cells.length&&
    source.cell===source.cells[source.index]&&source.cell.source!==source.baselineCell.source){
    // The group's first edit already made a detached snapshot. Keep its source
    // current without serializing and cloning every other cell on every key.
    source.baselineCell.source=source.cell.source;
    history.baseline.active=state.active;history.baseline.selected=state.selectedCell;
    history.future=[];history.time=now;return;
  }
  if(JSON.stringify(history.baseline.doc)===JSON.stringify(state.doc))return;
  if(!group||history.group!==group||now-history.time>900){history.past.push(history.baseline);if(history.past.length>50)history.past.shift();}
  history.future=[];history.baseline=historySnapshot();history.group=group;history.time=now;
  rememberHistorySource(history,group);
}
function applyDocumentHistory(redo=false){
  cancelCellResize?.();closeSlideContext();closeCellMenus();closeCellAddMenus();
  const history=ensureNotebookHistory();if(!history)return;
  const from=redo?history.future:history.past,to=redo?history.past:history.future;
  if(!from.length)return;
  to.push(historySnapshot());const entry=from.pop();
  state.doc=structuredClone(entry.doc);state.active=Math.min(entry.active,state.doc.slides.length-1);state.selectedCell=entry.selected;
  state.controls.clear();history.baseline=historySnapshot();history.group=null;history.source=null;
  applyingHistory=true;
  try{dirty(true);render();}finally{applyingHistory=false;}
}
window.addEventListener('keydown',event=>{
  if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
  const key=event.key.toLowerCase();if(key!=='z'&&key!=='y')return;
  if(event.target.closest('input,textarea,select,[contenteditable],dialog[open]'))return;
  event.preventDefault();applyDocumentHistory(key==='y'||event.shiftKey);
});
