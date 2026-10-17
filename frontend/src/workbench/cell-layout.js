'use strict';
const MIN_CELL_WIDTH=20,MAX_ROW_COLUMNS=4;
const CELL_EDGES=[['left','左侧','snapLeft'],['right','右侧','snapRight'],['top','上侧','snapTop'],['bottom','下侧','snapBottom']];
let cancelCellResize=null;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
function cellRows(cells=slide().cells){
  const rows=[];
  cells.forEach((cell,index)=>{
    const previous=rows.at(-1),id=cell.layout?.row;
    if(id && previous?.id===id)previous.cells.push(cell);
    else rows.push({id,start:index,cells:[cell]});
  });return rows;
}
function rowForCell(cell){return cellRows().find(row=>row.cells.includes(cell));}
// A row contains independent columns; legacy cells each start their own column.
function rowColumns(cells){
  const columns=[];
  for(const cell of cells){
    const previous=columns.at(-1),id=cell.layout?.column;
    if(id&&previous?.id===id)previous.cells.push(cell);
    else columns.push({id,cells:[cell]});
  }
  return columns;
}
function columnForCell(cell){return rowColumns(rowForCell(cell).cells).find(column=>column.cells.includes(cell));}
function horizontalCells(cell){return rowColumns(rowForCell(cell).cells).map(column=>column.cells[0]);}
function columnBox(cell){const heads=horizontalCells(cell);return rowBoxes(heads)[heads.indexOf(columnForCell(cell).cells[0])];}
function writeColumnBoxes(columns,boxes){columns.forEach((column,i)=>writeBoxes(column.cells,column.cells.map(()=>boxes[i])));}
function rowBoxes(cells){
  const explicit=cells.map(cell=>({x:Number(cell.layout?.x),width:Number(cell.layout?.width)}));
  if(explicit.every((box,i)=>Number.isFinite(box.x)&&box.x>=0&&box.width>=MIN_CELL_WIDTH&&box.x+box.width<=100.001&&(!i||box.x>=explicit[i-1].x+explicit[i-1].width-.001)))return explicit;
  const widths=cells.map(cell=>clamp(Number(cell.layout?.width)||100,MIN_CELL_WIDTH,100));
  if(cells.length===1)return [{x:0,width:widths[0]}];
  const sum=widths.reduce((a,b)=>a+b,0),extra=100-cells.length*MIN_CELL_WIDTH;
  const excess=widths.map(width=>Math.max(0,width/sum*100-MIN_CELL_WIDTH)),total=excess.reduce((a,b)=>a+b,0);
  let x=0;return excess.map(value=>{const width=MIN_CELL_WIDTH+(total?value/total:1/cells.length)*extra;const box={x,width};x+=width;return box;});
}
function writeBoxes(cells,boxes){cells.forEach((cell,i)=>{
  const x=Number(boxes[i].x.toFixed(4)),width=Number(Math.min(boxes[i].width,100-x).toFixed(4));
  cell.layout={...cell.layout,x,width};
});}
function packRow(cells){
  if(!cells.length)return;
  const columns=rowColumns(cells),heads=columns.map(column=>column.cells[0]);
  const boxes=rowBoxes(heads.map(cell=>({...cell,layout:{width:cell.layout?.width}})));
  if(columns.length===1)boxes[0]={x:0,width:100};writeColumnBoxes(columns,boxes);
}
function renderCellRows(){
  const elements=[];
  for(const entry of cellRows()){
    const row=document.createElement('div');row.className='cell-row';row.layoutCells=entry.cells;
    const columns=rowColumns(entry.cells);row.dataset.count=columns.length;
    columns.forEach(group=>{
      const column=document.createElement('div');column.className='cell-column';column.layoutCells=group.cells;
      group.cells.forEach(cell=>column.append(renderCell(cell,slide().cells.indexOf(cell))));row.append(column);
    });
    elements.push(insertionPoint(entry.start),row);
  }elements.push(insertionPoint(slide().cells.length));return elements;
}
function updateCellRows(){
  document.querySelectorAll('.cell-row').forEach(row=>{
    const columns=rowColumns(row.layoutCells),boxes=rowBoxes(columns.map(column=>column.cells[0])),gap=20;
    const tooNarrow=boxes.some(box=>row.clientWidth*box.width/100-(columns.length>1?gap:0)<170);
    const stacked=document.body.classList.contains('resizing-cells')?row.classList.contains('cell-row-stacked'):tooNarrow;
    row.classList.toggle('cell-row-stacked',stacked);
    const edges=[...new Set([0,100,...boxes.flatMap(box=>[box.x,box.x+box.width])].map(value=>Number(value.toFixed(4))))].sort((a,b)=>a-b);
    row.style.gridTemplateColumns=stacked?'minmax(0,1fr)':edges.slice(1).map((end,i)=>`minmax(0,${end-edges[i]}fr)`).join(' ');
    columns.forEach((group,i)=>{
      const column=row.children[i],box=boxes[i],start=edges.indexOf(Number(box.x.toFixed(4))),end=edges.indexOf(Number((box.x+box.width).toFixed(4)));
      column.style.gridColumn=stacked?'1':`${start+1} / ${end+1}`;column.style.gridRow=stacked?'auto':'1';
      column.style.marginLeft=stacked||!i?'0':'10px';column.style.marginRight=stacked||i===columns.length-1?'0':'10px';
      group.cells.forEach((cell,cellIndex)=>{
        const card=document.getElementById('cell-'+cell.id);if(!card)return;
        card.style.marginTop=`${(cellIndex?(stacked?24:(cell.layout?.gapBefore??24)):0)+(stacked?0:(cell.layout?.y||0))}px`;
        card.style.minHeight=cell.layout?.height?`${cell.layout.height}px`:'';
        for(const [side,,key] of CELL_EDGES){
          const handle=$(`.cell-resize-${side}`,card),enabled=cell.layout?.[key]!==false,vertical=['top','bottom'].includes(side);
          if(handle){handle.hidden=stacked;handle.dataset.snap=String(enabled);handle.setAttribute('aria-valuenow',String(Math.round(vertical?(cell.layout?.y||0)+(side==='bottom'?card.offsetHeight:0):side==='left'?box.x:box.x+box.width)));}
        }
      });
    });
  });resizePlots();
}
let observedCellWidth=-1;
new ResizeObserver(entries=>{const width=entries[0].contentRect.width;if(width!==observedCellWidth){observedCellWidth=width;updateCellRows();}}).observe($('#cells'));
function showSnapGuide(position,vertical=false){
  let guide=$('#cell-snap-guide');if(position===null){guide?.remove();return;}
  if(!guide){guide=document.createElement('div');guide.id='cell-snap-guide';guide.setAttribute('aria-hidden','true');$('#cells').append(guide);}
  guide.classList.toggle('horizontal',vertical);
  guide.style.left=vertical?'':(position-$('#cells').getBoundingClientRect().left)+'px';
  guide.style.top=vertical?(position-$('#cells').getBoundingClientRect().top)+'px':'';
}
function verticalCellBox(card){
  const rect=card.getBoundingClientRect(),row=card.closest('.cell-row').getBoundingClientRect();
  const saved=card.style.minHeight;card.style.minHeight='0';
  const minimum=Math.max(62,card.getBoundingClientRect().height);card.style.minHeight=saved;
  const y=Number(document.getElementById(card.id).style.marginTop.replace('px',''))||0;
  return {y,height:rect.height,minimum,base:rect.top-row.top-y};
}
function resizeCellVerticalBoundary(cell,side,requested,{magnet=true,box=null}={}){
  const card=document.getElementById('cell-'+cell.id),row=card.closest('.cell-row'),rect=row.getBoundingClientRect();
  box ||= verticalCellBox(card);
  const key=side==='top'?'snapTop':'snapBottom',minimum=Math.min(10000,box.minimum);
  const min=side==='top'?0:box.y+minimum,max=side==='top'?10000:box.y+10000;
  let position=clamp(requested,min,max),snapped=null;
  if(magnet&&cell.layout?.[key]!==false){
    const candidates=[0];
    row.querySelectorAll('.cell:not([hidden])').forEach(other=>{
      if(other.closest('.cell-column')===card.closest('.cell-column'))return;const bounds=other.getBoundingClientRect();
      candidates.push(bounds.top-rect.top-box.base,bounds.bottom-rect.top-box.base);
    });
    const nearest=candidates.filter(value=>value>=min&&value<=max).sort((a,b)=>Math.abs(a-position)-Math.abs(b-position))[0];
    if(nearest!==undefined&&Math.abs(nearest-position)<=10){position=nearest;snapped=rect.top+box.base+position;}
  }
  const y=side==='top'?position:box.y,height=side==='top'?clamp(box.y+box.height-y,minimum,10000):position-y;
  setCellVerticalGap(cell,y);cell.layout.height=Number(height.toFixed(2));
  updateCellRows();showSnapGuide(snapped,true);
}
function resizeCellBoundary(cell,side,requested,{magnet=true}={}){
  const columns=rowColumns(rowForCell(cell).cells),cells=columns.map(column=>column.cells[0]),boxes=rowBoxes(cells),i=columns.findIndex(column=>column.cells.includes(cell)),box=boxes[i],end=box.x+box.width;
  const before=boxes[i-1],after=boxes[i+1],key=side==='left'?'snapLeft':'snapRight';
  const enabled=magnet&&cell.layout?.[key]!==false;
  const linked=enabled&&(side==='left'?before&&cells[i-1].layout?.snapRight!==false&&Math.abs(before.x+before.width-box.x)<.002:after&&cells[i+1].layout?.snapLeft!==false&&Math.abs(end-after.x)<.002);
  const min=side==='left'?(before?(linked?before.x+MIN_CELL_WIDTH:before.x+before.width):0):box.x+MIN_CELL_WIDTH;
  const max=side==='right'?(after?(linked?after.x+after.width-MIN_CELL_WIDTH:after.x):100):end-MIN_CELL_WIDTH;
  let position=clamp(requested,min,max),snapped=null;
  const card=document.getElementById('cell-'+cell.id),row=card.closest('.cell-row'),rect=row.getBoundingClientRect();
  const offset=side==='left'?(i?10:0):(i===cells.length-1?0:-10);
  if(enabled){
    const candidates=[0,100,...boxes.flatMap((other,j)=>j===i?[]:[other.x,other.x+other.width])];
    document.querySelectorAll('.cell-row:not([hidden]) .cell:not([hidden])').forEach(other=>{
      if(other.closest('.cell-row')===row)return;
      const bounds=other.getBoundingClientRect();candidates.push((bounds.left-rect.left-offset)/rect.width*100,(bounds.right-rect.left-offset)/rect.width*100);
    });
    const nearest=candidates.filter(value=>value>=min-.001&&value<=max+.001).sort((a,b)=>Math.abs(a-position)-Math.abs(b-position))[0];
    if(nearest!==undefined&&Math.abs(nearest-position)*rect.width/100<=10){position=clamp(nearest,min,max);snapped=rect.left+position/100*rect.width+offset;}
  }
  if(side==='left'){
    if(linked)before.width=position-before.x;
    box.x=position;box.width=end-position;
  }else{
    if(linked){const afterEnd=after.x+after.width;after.x=position;after.width=afterEnd-position;}
    box.width=position-box.x;
  }
  writeColumnBoxes(columns,boxes);updateCellRows();showSnapGuide(snapped);
}
function removeLayoutCell(cell){
  const {cells}=rowForCell(cell),columns=rowColumns(cells),heads=columns.map(column=>column.cells[0]),boxes=rowBoxes(heads);
  const column=columns.find(item=>item.cells.includes(cell)),i=columns.indexOf(column);
  slide().cells.splice(slide().cells.indexOf(cell),1);
  if(column.cells.length>1)return;
  const packed=Math.abs(boxes[0].x)<.002&&Math.abs(boxes.at(-1).x+boxes.at(-1).width-100)<.002&&boxes.every((box,j)=>!j||Math.abs(box.x-boxes[j-1].x-boxes[j-1].width)<.002);
  const survivors=cells.filter(item=>item!==cell);
  if(packed)packRow(survivors);
  else writeColumnBoxes(columns.filter(item=>item!==column),boxes.filter((_,j)=>j!==i));
}
function insertBeside(target,cell,side='right'){
  const columns=rowColumns(rowForCell(target).cells);if(columns.length>=MAX_ROW_COLUMNS)return false;
  const boxes=rowBoxes(columns.map(column=>column.cells[0])),i=columns.findIndex(column=>column.cells.includes(target)),box=boxes[i],rowId=target.layout?.row||uid();
  const at=i+(side==='right'?1:0),anchor=side==='right'?columns[i].cells.at(-1):columns[i].cells[0];
  const gapStart=side==='right'?box.x+box.width:(boxes[i-1]?boxes[i-1].x+boxes[i-1].width:0);
  const gapEnd=side==='right'?(boxes[i+1]?.x??100):box.x;
  columns.splice(at,0,{id:uid(),cells:[cell]});
  if(gapEnd-gapStart>=MIN_CELL_WIDTH)boxes.splice(at,0,{x:gapStart,width:gapEnd-gapStart});
  else if(box.width>=2*MIN_CELL_WIDTH){const half=box.width/2,other={x:side==='right'?box.x+half:box.x,width:half};box.width=half;if(side==='left')box.x+=half;boxes.splice(at,0,other);}
  else boxes.splice(0,boxes.length,...columns.map((_,j)=>({x:j*100/columns.length,width:100/columns.length})));
  columns.forEach(column=>{const columnId=column.id||uid();column.cells.forEach(item=>item.layout={...item.layout,row:rowId,column:columnId});});
  writeColumnBoxes(columns,boxes);
  slide().cells.splice(slide().cells.indexOf(anchor)+(side==='right'?1:0),0,cell);return true;
}
function insertInColumn(target,cell,side='bottom'){
  const column=columnForCell(target),box=columnBox(target),rowId=target.layout?.row||uid(),columnId=column.id||uid();
  column.cells.forEach(item=>item.layout={...item.layout,row:rowId,column:columnId});
  cell.layout={...cell.layout,row:rowId,column:columnId,...box,y:0};delete cell.layout.gapBefore;
  slide().cells.splice(slide().cells.indexOf(target)+(side==='bottom'?1:0),0,cell);
}
function addCellBeside(target,kind='code',side='right'){
  const cell={id:uid(),kind,display:'normal',showCode:false,source:kind==='code'?'# 输入 Python；最后一个表达式会作为输出\n':kind==='html'?'<h2>HTML 交互</h2>\n<p>在这里编写 HTML、CSS 和 JavaScript。</p>\n':'在这里写下你的想法。支持 $x^2$ 和 Markdown。'};
  if(side==='bottom')insertInColumn(target,cell);else if(!insertBeside(target,cell))return;
  if(kind==='markdown')state.markdownEditing.add(cell.id);
  state.selectedCell=cell.id;dirty(kind==='code');render();focusCellEditor(cell);
}
function placeLayoutCell(cell,target,side){
  if(!cell||!target||cell===target)return;
  const horizontal=['left','right'].includes(side),columns=rowColumns(rowForCell(target).cells),sourceColumn=columnForCell(cell);
  // Moving a sole cell within its row reorders existing columns without splitting widths.
  const sameRow=rowForCell(target).cells.includes(cell);
  if(!horizontal&&sourceColumn.cells.includes(target)){
    const original=sourceColumn.cells,start=slide().cells.indexOf(original[0]);
    const gaps=original.map((item,i)=>(item.layout?.y||0)+(i?(item.layout?.gapBefore??24):0));
    const ordered=original.filter(item=>item!==cell);
    ordered.splice(ordered.indexOf(target)+(side==='bottom'?1:0),0,cell);
    if(ordered.every((item,i)=>item===original[i]))return;
    slide().cells.splice(start,original.length,...ordered);
    ordered.forEach((item,i)=>setCellVerticalGap(item,gaps[i]));
  }else if(horizontal&&sameRow&&sourceColumn.cells.length===1){
    const source=columns.find(column=>column.cells.includes(cell)),slots=rowBoxes(columns.map(column=>column.cells[0]));
    const start=slide().cells.indexOf(columns[0].cells[0]),length=rowForCell(target).cells.length;
    columns.splice(columns.indexOf(source),1);const at=columns.findIndex(column=>column.cells.includes(target))+(side==='right'?1:0);columns.splice(at,0,source);
    slide().cells.splice(start,length,...columns.flatMap(column=>column.cells));writeColumnBoxes(columns,slots);
  }else{
    if(horizontal&&columns.length>=MAX_ROW_COLUMNS)return;
    removeLayoutCell(cell);
    if(horizontal)insertBeside(target,cell,side);else insertInColumn(target,cell,side);
  }
  state.selectedCell=cell.id;dirty();render();document.querySelector(`#cell-${cell.id} .cell-drag-handle`)?.focus();
}
function moveLayoutCell(cell,target,after){placeLayoutCell(cell,target,after?'bottom':'top');}
function closeCellAddMenus(){document.querySelectorAll('.cell-add-menu').forEach(menu=>{menu.hidden=true;menu.parentElement.querySelector('.cell-add-beside')?.setAttribute('aria-expanded','false');});}
function cellLayoutControls(cell,card,shell){
  const section=document.createElement('div');section.className='cell-layout-settings';
  const heading=document.createElement('span');heading.className='cell-layout-label';heading.textContent='边界吸附';section.append(heading);
  const toggles=document.createElement('div');toggles.className='cell-snap-options';
  for(const [side,label,key] of CELL_EDGES){
    const toggle=document.createElement('button');toggle.type='button';toggle.dataset.side=side;toggle.setAttribute('aria-label',label+'吸附');
    const sync=()=>{const enabled=cell.layout?.[key]!==false;toggle.setAttribute('aria-pressed',String(enabled));toggle.innerHTML=uiIcon(enabled?'link-2':'unlink-2')+'<span>'+label+'</span>';toggle.title=enabled?'自动吸附相邻边界；点击解除这一侧':'这一侧已解除吸附；点击恢复';};
    toggle.onclick=()=>{cell.layout={...cell.layout,[key]:cell.layout?.[key]===false};sync();dirty();updateCellRows();};sync();toggles.append(toggle);
  }
  const center=document.createElement('span');center.className='cell-snap-center';center.setAttribute('aria-hidden','true');toggles.append(center);
  section.append(toggles);
  const menu=document.createElement('div');menu.className='cell-add-menu';menu.hidden=true;menu.setAttribute('role','menu');menu.setAttribute('aria-label','添加 cell');
  const add=codeAction('plus','添加相邻 cell',()=>{const open=menu.hidden;closeCellMenus();closeCellAddMenus();menu.hidden=!open;add.setAttribute('aria-expanded',String(open));if(open)$('button:not(:disabled)',menu).focus();});
  add.classList.add('cell-add-beside');add.setAttribute('aria-haspopup','menu');add.setAttribute('aria-expanded','false');add.title='在下方或右侧添加 Python、文字或 HTML';
  for(const [side,position] of [['bottom','下方'],['right','右侧']]){
    const heading=document.createElement('div');heading.className='cell-add-heading';heading.textContent='在'+position+'添加';menu.append(heading);
    for(const [kind,label,icon] of [['code','Python','square-code'],['markdown','文字 / Markdown','square-m'],['html','HTML','code-xml']]){
      const action=document.createElement('button');action.type='button';action.setAttribute('role','menuitem');action.setAttribute('aria-label',position+'添加 '+label);action.innerHTML=uiIcon(icon)+'<span>'+label+'</span>';action.onclick=()=>addCellBeside(cell,kind,side);
      action.disabled=side==='right'&&rowColumns(rowForCell(cell).cells).length>=MAX_ROW_COLUMNS;menu.append(action);
    }
    const paste=document.createElement('button');paste.type='button';paste.textContent='粘贴 cell';paste.setAttribute('role','menuitem');paste.setAttribute('aria-label',position+'粘贴 cell');
    paste.dataset.pasteCell='true';paste.dataset.pasteBlocked=String(side==='right'&&rowColumns(rowForCell(cell).cells).length>=MAX_ROW_COLUMNS);
    paste.disabled=!(typeof hasCopiedCell==='function'&&hasCopiedCell())||paste.dataset.pasteBlocked==='true';paste.onclick=()=>pasteNotebookCell(null,cell,side);menu.append(paste);
  }
  menu.onkeydown=event=>{const buttons=[...menu.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(document.activeElement);if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();event.stopPropagation();buttons[(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeCellAddMenus();add.focus();}};
  $('.code-actions',shell).insertBefore(add,$('.code-more',shell));shell.append(menu);
  for(const [side,label] of CELL_EDGES){
    const vertical=['top','bottom'].includes(side);
    const handle=document.createElement('div');handle.className=(vertical?'cell-height-resizer':'cell-width-resizer')+' cell-resize-'+side;handle.tabIndex=0;
    handle.setAttribute('role','separator');handle.setAttribute('aria-orientation',vertical?'horizontal':'vertical');handle.setAttribute('aria-label','调整 cell '+label[0]+'边界');handle.setAttribute('aria-controls',card.id);handle.setAttribute('aria-valuemin','0');handle.setAttribute('aria-valuemax',vertical?'20000':'100');
    handle.title='拖动边界；Alt 临时解除吸附；方向键微调';card.append(handle);
    handle.onkeydown=event=>{
      if(!(vertical?['ArrowUp','ArrowDown']:['ArrowLeft','ArrowRight']).includes(event.key))return;
      event.preventDefault();event.stopPropagation();
      if(vertical){const box=verticalCellBox(card);resizeCellVerticalBoundary(cell,side,box.y+(side==='bottom'?box.height:0)+(event.key==='ArrowDown'?12:-12),{magnet:!event.altKey,box});}
      else {const box=columnBox(cell);resizeCellBoundary(cell,side,(side==='left'?box.x:box.x+box.width)+(event.key==='ArrowRight'?2:-2),{magnet:!event.altKey});}
      showSnapGuide(null);dirty();
    };
    handle.ondblclick=()=>{
      if(vertical){cell.layout={...cell.layout};if(side==='top'){delete cell.layout.y;delete cell.layout.gapBefore;}delete cell.layout.height;}
      else {const columns=rowColumns(rowForCell(cell).cells);writeColumnBoxes(columns,columns.map((_,i)=>({x:i*100/columns.length,width:100/columns.length})));}
      dirty();updateCellRows();
    };
    handle.onpointerdown=event=>{
      if(event.button!==0||state.mode!=='edit')return;event.preventDefault();event.stopPropagation();cancelCellResize?.();clearTimeout(saveTimer);closeCellMenus();closeCellAddMenus();
      const {cells}=rowForCell(cell),box=vertical?verticalCellBox(card):columnBox(cell),before=cells.map(item=>item.layout?structuredClone(item.layout):undefined),width=card.closest('.cell-row').getBoundingClientRect().width,startX=event.clientX,startY=event.clientY;
      let changed=false;const restore=()=>cells.forEach((item,i)=>{if(before[i])item.layout=structuredClone(before[i]);else delete item.layout;});
      handle.setPointerCapture(event.pointerId);document.body.classList.add('resizing-cells');
      document.body.classList.toggle('resizing-cells-vertical',vertical);
      const move=e=>{
        changed ||= Math.abs(vertical?e.clientY-startY:e.clientX-startX)>1;restore();
        if(vertical)resizeCellVerticalBoundary(cell,side,box.y+(side==='bottom'?box.height:0)+e.clientY-startY,{magnet:!e.altKey,box});
        else resizeCellBoundary(cell,side,(side==='left'?box.x:box.x+box.width)+(e.clientX-startX)/width*100,{magnet:!e.altKey});
      };
      const finish=cancel=>{
        handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',abort);handle.removeEventListener('lostpointercapture',abort);window.removeEventListener('keydown',key);
        if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);document.body.classList.remove('resizing-cells','resizing-cells-vertical');cancelCellResize=null;showSnapGuide(null);
        if(cancel)restore();else if(changed)dirty();updateCellRows();if(state.epoch!==state.savedEpoch&&(cancel||!changed))save().catch(()=>{});
      };
      const up=()=>finish(false),abort=()=>finish(true),key=e=>{if(e.key==='Escape'){e.preventDefault();finish(true);}};
      cancelCellResize=abort;handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',abort);handle.addEventListener('lostpointercapture',abort);window.addEventListener('keydown',key);
    };
  }return section;
}
let cellDragOffset=0,cellDropIntent=null;
function beginCellDrag(cell,card,event){cellDragOffset=event.clientY-card.getBoundingClientRect().top;cellDropIntent=null;}
function clearCellDropPreview(){
  document.querySelectorAll('[data-drop-side]').forEach(card=>{delete card.dataset.dropSide;delete card.dataset.dropLabel;});
  document.querySelectorAll('.cell-insert.cell-row-drop').forEach(el=>el.classList.remove('cell-row-drop'));
  $('#cell-move-preview')?.remove();cellDropIntent=null;showSnapGuide(null);
}
function cellDropSide(card,event){const rect=card.getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width,y=(event.clientY-rect.top)/rect.height;return [['left',x],['right',1-x],['top',y],['bottom',1-y]].sort((a,b)=>a[1]-b[1])[0][0];}
function previewCellMove(cell,event){
  const card=document.getElementById('cell-'+cell.id),row=card.closest('.cell-row'),rect=card.getBoundingClientRect(),box=verticalCellBox(card),rowRect=row.getBoundingClientRect();
  let y=clamp(event.clientY-cellDragOffset-rowRect.top-box.base,0,10000),guide=null;
  if(!event.altKey){
    const candidates=[];
    if(cell.layout?.snapTop!==false)candidates.push({y:0,guide:rowRect.top+box.base});
    row.querySelectorAll('.cell:not([hidden])').forEach(other=>{
      if(other.closest('.cell-column')===card.closest('.cell-column'))return;
      const bounds=other.getBoundingClientRect();
      for(const position of [bounds.top,bounds.bottom]){
        if(cell.layout?.snapTop!==false)candidates.push({y:position-rowRect.top-box.base,guide:position});
        if(cell.layout?.snapBottom!==false)candidates.push({y:position-rowRect.top-box.base-rect.height,guide:position});
      }
    });
    const nearest=candidates.filter(item=>item.y>=0&&item.y<=10000).sort((a,b)=>Math.abs(a.y-y)-Math.abs(b.y-y))[0];
    if(nearest&&Math.abs(nearest.y-y)<=10){y=nearest.y;guide=nearest.guide;}
  }
  const preview=document.createElement('div');preview.id='cell-move-preview';preview.setAttribute('aria-hidden','true');
  const bounds=$('#cells').getBoundingClientRect();
  Object.assign(preview.style,{left:`${rect.left-bounds.left}px`,top:`${rowRect.top+box.base+y-bounds.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});
  $('#cells').append(preview);showSnapGuide(guide,true);cellDropIntent={cell,y:Number(y.toFixed(2))};
}
function previewCellPlacement(cell,target,side){
  const row=rowForCell(target),columns=rowColumns(row.cells);
  if(['left','right'].includes(side)&&columns.length>=MAX_ROW_COLUMNS&&!(row.cells.includes(cell)&&columnForCell(cell).cells.length===1))return false;
  const card=document.getElementById('cell-'+target.id);card.dataset.dropSide=side;
  card.dataset.dropLabel={left:'左侧并排',right:'右侧并排',top:'插入这一列上方',bottom:'插入这一列下方'}[side];
  cellDropIntent={cell,target,side};return true;
}
function updateCellDrop(event){
  if(!draggedCell||state.mode!=='edit')return;clearCellDropPreview();
  const cell=slide().cells.find(item=>item.id===draggedCell);if(!cell)return;
  const insertion=event.target.closest('[data-insertion-index]');
  if(insertion){cellDropIntent={cell,index:Number(insertion.dataset.insertionIndex)};insertion.classList.add('cell-row-drop');}
  else{
    const card=event.target.closest('.cell');
    if(card&&card.dataset.cell!==draggedCell){
      const target=slide().cells.find(item=>item.id===card.dataset.cell);previewCellPlacement(cell,target,cellDropSide(card,event));
    }else{
      const row=event.target.closest('.cell-row');
      const column=event.target.closest('.cell-column')||(row&&[...row.children].find(el=>{const r=el.getBoundingClientRect();return event.clientX>=r.left&&event.clientX<=r.right;}));
      if(column){
        const source=document.getElementById('cell-'+cell.id),others=[...column.querySelectorAll(':scope > .cell:not([hidden])')].filter(el=>el!==source);
        const next=others.find(el=>event.clientY<el.getBoundingClientRect().top),previous=others.filter(el=>event.clientY>=el.getBoundingClientRect().bottom).at(-1);
        if(column===source.closest('.cell-column')&&(!previous||previous.compareDocumentPosition(source)&Node.DOCUMENT_POSITION_FOLLOWING)&&(!next||source.compareDocumentPosition(next)&Node.DOCUMENT_POSITION_FOLLOWING))previewCellMove(cell,event);
        else{
          const anchor=next||previous||others.at(-1);
          if(anchor)previewCellPlacement(cell,slide().cells.find(item=>item.id===anchor.dataset.cell),next?'top':'bottom');
        }
      }
    }
  }
  if(cellDropIntent){event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';}else if(event.dataTransfer)event.dataTransfer.dropEffect='none';
}
$('#cells').addEventListener('dragover',updateCellDrop);
$('#cells').addEventListener('dragleave',event=>{if(!$('#cells').contains(event.relatedTarget))clearCellDropPreview();});
$('#cells').addEventListener('drop',event=>{
  if(!draggedCell||state.mode!=='edit'||!cellDropIntent)return;
  event.preventDefault();const intent=cellDropIntent;draggedCell=null;clearCellDropPreview();
  if(intent.target)placeLayoutCell(intent.cell,intent.target,intent.side);
  else if(intent.index!==undefined){
    const original=slide().cells.indexOf(intent.cell);removeLayoutCell(intent.cell);intent.cell.layout={x:0,width:100};
    slide().cells.splice(intent.index-(original<intent.index?1:0),0,intent.cell);state.selectedCell=intent.cell.id;dirty();render();
  }else{
    intent.cell.layout={...intent.cell.layout,y:intent.y};state.selectedCell=intent.cell.id;dirty();render();
  }
});

// Keep neighbors stationary during the gesture; crossing their centers previews a new order.
function captureColumnPositions(cell){
  const column=document.getElementById('cell-'+cell.id).closest('.cell-column'),origin=column.getBoundingClientRect().top;
  return columnForCell(cell).cells.map(item=>{const el=document.getElementById('cell-'+item.id),rect=el.getBoundingClientRect();return {cell:item,el,top:rect.top-origin,height:rect.height};});
}
function moveCellVertically(cell,delta){
  const boxes=captureColumnPositions(cell),index=boxes.findIndex(box=>box.cell===cell);
  applyColumnPositions(boxes,independentPositions(boxes,index,boxes[index].top+delta),index);dirty();updateCellRows();
}
function setCellVerticalGap(cell,gap){
  const first=columnForCell(cell).cells[0]===cell;
  cell.layout={...cell.layout,y:first?Number(gap.toFixed(2)):0};
  if(first)delete cell.layout.gapBefore;else cell.layout.gapBefore=Number(gap.toFixed(2));
}
function independentPositions(boxes,index,requested){
  const tops=boxes.map(box=>box.top),minimum=index?boxes[index-1].top+boxes[index-1].height:0;
  const maximum=index+1<boxes.length?boxes[index+1].top-boxes[index].height:minimum+10000;
  tops[index]=clamp(requested,minimum,Math.max(minimum,Math.min(maximum,minimum+10000)));
  return tops;
}
function applyColumnPositions(boxes,tops,index){
  for(let i=index;i<boxes.length;i++){
    const baseline=i?tops[i-1]+boxes[i-1].height:0;
    setCellVerticalGap(boxes[i].cell,Math.max(0,tops[i]-baseline));
  }
}
function bindCellPointerDrag(handle,cell,card){
  handle.draggable=false;
  handle.onpointerdown=event=>{
    if(event.button!==0||state.mode!=='edit')return;
    event.preventDefault();event.stopPropagation();cancelCellResize?.();closeCellMenus();closeCellAddMenus();clearTimeout(saveTimer);
    const column=card.closest('.cell-column'),row=card.closest('.cell-row'),main=$('#main'),columnRect=column.getBoundingClientRect();
    const boxes=captureColumnPositions(cell);
    const index=boxes.findIndex(box=>box.cell===cell),startX=event.clientX,startY=event.clientY,startScroll=main.scrollTop;
    const sourceRect=card.getBoundingClientRect();let latest=event,frame=0,started=false,finished=false,positions=null;
    handle.setPointerCapture(event.pointerId);
    const resetTransforms=()=>{card.style.transform='';};
    const draw=()=>{
      frame=0;if(finished||!started)return;
      const bounds=main.getBoundingClientRect(),edge=44;
      if(latest.clientY>bounds.bottom-edge)main.scrollTop+=Math.min(18,(latest.clientY-bounds.bottom+edge)/3);
      else if(latest.clientY<bounds.top+edge)main.scrollTop-=Math.min(18,(bounds.top+edge-latest.clientY)/3);
      const deltaY=latest.clientY-startY+main.scrollTop-startScroll;
      // Hit-testing ignores the moving source and its previews.
      const target=document.elementFromPoint(latest.clientX,latest.clientY),targetRow=target?.closest('.cell-row');
      resetTransforms();positions=null;
      const sameColumn=latest.clientX>=columnRect.left&&latest.clientX<=columnRect.right&&targetRow===row&&!row.classList.contains('cell-row-stacked');
      if(sameColumn){
        clearCellDropPreview();
        const others=boxes.filter((_,i)=>i!==index),pointerY=latest.clientY-columnRect.top+main.scrollTop-startScroll;
        let slot=others.findIndex(box=>pointerY<box.top+box.height/2);if(slot<0)slot=others.length;
        if(slot!==index){
          const anchor=others[slot]||others.at(-1);
          previewCellPlacement(cell,anchor.cell,slot<others.length?'top':'bottom');
          card.style.transform=`translate3d(0,${deltaY}px,0)`;
          frame=requestAnimationFrame(draw);return;
        }
        let requested=boxes[index].top+deltaY;
        if(!latest.altKey){
          const candidates=[];
          if(cell.layout?.snapTop!==false)candidates.push(0);
          row.querySelectorAll('.cell:not([hidden])').forEach(other=>{
            if(other.closest('.cell-column')===column)return;const r=other.getBoundingClientRect(),origin=columnRect.top-(main.scrollTop-startScroll);
            for(const position of [r.top-origin,r.bottom-origin]){
              if(cell.layout?.snapTop!==false)candidates.push(position);
              if(cell.layout?.snapBottom!==false)candidates.push(position-sourceRect.height);
            }
          });
          const nearest=candidates.sort((a,b)=>Math.abs(a-requested)-Math.abs(b-requested))[0];
          if(nearest!==undefined&&Math.abs(nearest-requested)<=10)requested=nearest;
        }
        positions=independentPositions(boxes,index,requested);
        card.style.transform=`translate3d(0,${deltaY}px,0)`;
      }else{
        card.style.transform=`translate3d(${latest.clientX-startX}px,${deltaY}px,0)`;
        if(target)updateCellDrop({target,clientX:latest.clientX,clientY:latest.clientY,altKey:latest.altKey,preventDefault(){}});else clearCellDropPreview();
      }
      frame=requestAnimationFrame(draw);
    };
    const move=e=>{
      latest=e;
      if(!started&&Math.hypot(e.clientX-startX,e.clientY-startY)>=4){
        started=true;draggedCell=cell.id;cellDragOffset=startY-sourceRect.top;card.classList.add('cell-moving');document.body.classList.add('moving-cells');
      }
      if(started&&!frame)frame=requestAnimationFrame(draw);
    };
    const finish=cancel=>{
      if(finished)return;
      if(started&&!cancel){cancelAnimationFrame(frame);draw();}
      finished=true;cancelAnimationFrame(frame);const intent=cellDropIntent;
      handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',abort);handle.removeEventListener('lostpointercapture',abort);window.removeEventListener('keydown',key);
      if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
      resetTransforms();card.classList.remove('cell-moving');document.body.classList.remove('moving-cells');draggedCell=null;cancelCellResize=null;clearCellDropPreview();
      if(started&&!cancel){
        if(positions){applyColumnPositions(boxes,positions,index);state.selectedCell=cell.id;dirty();updateCellRows();}
        else if(intent?.target)placeLayoutCell(cell,intent.target,intent.side);
        else if(intent?.index!==undefined){const original=slide().cells.indexOf(cell);removeLayoutCell(cell);cell.layout={x:0,width:100};slide().cells.splice(intent.index-(original<intent.index?1:0),0,cell);state.selectedCell=cell.id;dirty();render();}
      }
      if(state.epoch!==state.savedEpoch)save().catch(()=>{});
    };
    const up=e=>{latest=e;finish(false);},abort=()=>finish(true),key=e=>{if(e.key==='Escape'){e.preventDefault();finish(true);}};
    cancelCellResize=abort;handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',abort);handle.addEventListener('lostpointercapture',abort);window.addEventListener('keydown',key);
  };
}
