'use strict';
let notebookPrintCancelled=false,notebookPrintBusy=false,notebookPrintFrame=null,notebookPrintPath=null;
function canPrintNotebook(){return !!state.doc&&!$('#notebook-editor').hidden&&!editorTabs.switching;}
function openNotebookPrintDialog(scope='all',index=state.active){
 if(!canPrintNotebook()||notebookPrintBusy)return;
 const dialog=$('#notebook-print-dialog');notebookPrintPath=state.path;
 $('#notebook-print-note').textContent=state.doc.title;
 $('#notebook-print-scope').value=scope;
 $('#notebook-print-page').replaceChildren(...state.doc.slides.map((page,i)=>{
  const option=document.createElement('option');option.value=String(i);option.textContent=`${i+1}. ${page.name}`;return option;
 }));
 $('#notebook-print-page').value=String(index);
 $('#notebook-print-page-label').hidden=scope!=='page';
 $('#notebook-print-status').textContent='';dialog.showModal();
}
function printWait(promise,milliseconds,message){
 let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),milliseconds);})]).finally(()=>clearTimeout(timer));
}
function printText(doc,tag,className,text){const element=doc.createElement(tag);element.className=className;element.textContent=text;return element;}
async function printPlotImage(doc,figure,width=900){
 const temporary=document.createElement('div');
 width=Math.round(Math.max(260,Math.min(1100,width)));
 const height=Math.round(Math.max(220,Math.min(700,figure.layout?.height||width*.6)));
 temporary.style.cssText=`position:fixed;left:-20000px;top:0;width:${width}px;height:${height}px`;document.body.append(temporary);
 try{
  const themed=themePlotFigure(figure);themed.layout.width=width;themed.layout.height=height;
  await printWait(Plotly.newPlot(temporary,themed.data,themed.layout,{staticPlot:true,displayModeBar:false}),15000,'图表渲染超时');
  const image=doc.createElement('img');image.className='print-plot';image.alt='Python 图形输出';
  image.src=await printWait(Plotly.toImage(temporary,{format:'png',width,height,scale:3}),15000,'图表导出超时');return image;
 }finally{Plotly.purge(temporary);temporary.remove();}
}
async function printCachedOutput(doc,original,width){
 const copy=doc.importNode(original,true),plots=[...original.querySelectorAll('.plot')],copies=[...copy.querySelectorAll('.plot')];
 for(let i=0;i<plots.length;i++)copies[i].replaceWith(await printPlotImage(doc,plots[i].printFigure,width));
 const fields=[...original.querySelectorAll('input,select,textarea')],targets=[...copy.querySelectorAll('input,select,textarea')];
 fields.forEach((field,i)=>{
  const sliderValue=field.type==='range'&&field.nextElementSibling?.tagName==='OUTPUT'?field.nextElementSibling.textContent:null;
  const value=sliderValue??(field.type==='checkbox'?(field.checked?'✓':'☐'):field.tagName==='SELECT'?[...field.selectedOptions].map(option=>option.textContent).join(', '):field.value);
  if(targets[i]?.nextElementSibling?.tagName==='OUTPUT')targets[i].nextElementSibling.remove();
  targets[i]?.replaceWith(printText(doc,'span','print-control',value));
 });
 copy.querySelectorAll('button,.modebar,.plotly-notifier').forEach(element=>element.remove());return copy;
}
async function printMarimoOutput(doc,content,width){
 const result=doc.createElement('div');result.className='mo-output';
 result.innerHTML=DOMPurify.sanitize(content.html,{ADD_TAGS:['marimo-ui-element','marimo-tex'],ADD_ATTR:['object-id','random-id'],FORBID_TAGS:['script','iframe','style']});
 for(const element of result.querySelectorAll('marimo-tex')){
  const text=element.textContent,display=text.startsWith('||['),formula=/^\|\|[([]/.test(text)?text.slice(3,-3):text;
  element.innerHTML=katex.renderToString(formula,{displayMode:display,throwOnError:false,trust:false});
 }
 const specs=new Map((content.widgets||[]).map(spec=>[spec.id,spec]));
 for(const host of result.querySelectorAll('marimo-ui-element')){
  const spec=specs.get(host.getAttribute('object-id'));if(!spec)continue;
  if(spec.type==='plotly')host.replaceWith(await printPlotImage(doc,spec.figure,width));
  else{
   const value=spec.type==='checkbox'?(spec.value?'✓':'☐'):Array.isArray(spec.value)?spec.value.join(', '):spec.steps?.length?spec.steps[spec.value]:spec.value;
   const control=doc.createElement('div');control.className='print-control';control.innerHTML=markdown(spec.label||spec.name||'');control.append(doc.createTextNode(' '+String(value??'')));host.replaceWith(control);
  }
 }
 return result;
}
async function printRuntimeOutput(doc,cell,snapshot,width){
 const original=snapshot.outputs.get(cell.id);
 const container=doc.createElement('div'),output=snapshot.runtime?.outputs?.[cell.id],error=snapshot.runtime?.errors?.[cell.id];
 if(!output&&!error){container.append(printText(doc,'p','print-placeholder','此 cell 尚未运行'));return container;}
 if(original?.children.length&&[...original.querySelectorAll('.plot')].every(plot=>plot.printFigure))return printCachedOutput(doc,original,width);
 for(const spec of output?.controls||[])container.append(printText(doc,'span','print-control',`${spec.label}: ${spec.value}`));
 if(output?.stdout)container.append(printText(doc,'pre','stdout',output.stdout));
 const content=output?.result;
 if(content?.kind==='plotly')container.append(await printPlotImage(doc,content.figure,width));
 else if(content?.kind==='marimo')container.append(await printMarimoOutput(doc,content,width));
 else if(content?.kind==='markdown'){
  const result=doc.createElement('div');result.className='result-markdown';result.innerHTML=markdown(content.text);container.append(result);
 }else if(content)container.append(printText(doc,'pre','result-text',content.text||''));
 if(error)container.append(printText(doc,'pre','error-output',error));return container;
}
function freezePrintOutput(original){
 const copy=original.cloneNode(true),plots=[...original.querySelectorAll('.plot')],targets=[...copy.querySelectorAll('.plot')];
 plots.forEach((plot,i)=>{if(plot.data)targets[i].printFigure=structuredClone({data:plot.data,layout:plot.layout});});
 const canvases=[...original.querySelectorAll('canvas')],clones=[...copy.querySelectorAll('canvas')];
 canvases.forEach((canvas,i)=>{
  if(canvas.closest('.plot'))return;
  const image=document.createElement('img');image.src=canvas.toDataURL('image/png');image.alt='图像输出';clones[i].replaceWith(image);
 });
 const fields=[...original.querySelectorAll('input,select,textarea')],copies=[...copy.querySelectorAll('input,select,textarea')];
 fields.forEach((field,i)=>{copies[i].value=field.value;if(field.type==='checkbox')copies[i].checked=field.checked;});
 return copy;
}
function snapshotNotebookPrint(){
 return {path:state.path,doc:structuredClone(state.doc),runtime:structuredClone(state.runtime),runtimeDirty:state.runtimeDirty,outputs:new Map([...state.outputs].map(([id,output])=>[id,freezePrintOutput(output)]))};
}
async function prepareNotebookPrint(snapshot,{scope='all',index=0,orientation='landscape'}={}){
 if(!['all','page'].includes(scope))throw Error('请选择打印范围');
 if(scope==='page'&&!snapshot.doc.slides[index])throw Error('所选页面已不存在');
 if(!['landscape','portrait'].includes(orientation))throw Error('请选择纸张方向');
 notebookPrintFrame?.remove();
 const frame=document.createElement('iframe');frame.className='notebook-print-frame';frame.style.width=(orientation==='landscape'?'1032px':'703px');frame.title='笔记打印文档';frame.setAttribute('aria-hidden','true');document.body.append(frame);notebookPrintFrame=frame;
 try{
  const doc=frame.contentDocument;doc.open();doc.write('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body></body></html>');doc.close();
  const base=doc.createElement('base');base.href=location.origin+'/';doc.head.append(base);
  doc.title=snapshot.doc.title+(scope==='page'?' - '+snapshot.doc.slides[index].name:'');
  const style=doc.createElement('style');style.textContent=`@page{size:A4 ${orientation};margin:12mm}`;doc.head.append(style);
  const loaded=['/vendor/katex/katex.min.css','/marimo-output.css','/notebook-paper.css','/obsidian-markdown.css'].map(href=>new Promise((resolve,reject)=>{
   const link=doc.createElement('link');link.rel='stylesheet';link.href=href;link.onload=resolve;link.onerror=()=>reject(Error('打印样式加载失败'));doc.head.append(link);
  }));
  await printWait(Promise.all(loaded),10000,'打印样式加载超时，请重试');
  const pages=snapshot.doc.slides.map((page,i)=>({page,index:i})).filter(item=>scope==='all'||item.index===Number(index));
  for(const entry of pages){
   const page=doc.createElement('section');page.className='print-page';page.dataset.slide=entry.page.id;
   const header=doc.createElement('header');header.className='print-header';
   const meta=doc.createElement('div');meta.className='print-meta';meta.append(printText(doc,'span','',snapshot.doc.title),printText(doc,'span','',`${entry.index+1} / ${snapshot.doc.slides.length}`));
   header.append(meta,printText(doc,'h1','',entry.page.name));
   if(snapshot.runtimeDirty&&entry.page.cells.some(cell=>cell.kind==='code'&&cell.display!=='skip'))header.append(printText(doc,'p','print-runtime-note','Python 输出可能已过期；以下保留当前运行结果。'));
   page.append(header);doc.body.append(page);
   for(const rowData of cellRows(entry.page.cells)){
    const visible=rowData.cells.filter(cell=>cell.display!=='skip');if(!visible.length)continue;
    const groups=rowColumns(visible),boxes=rowBoxes(groups.map(group=>group.cells[0]));
    const edges=[...new Set([0,100,...boxes.flatMap(box=>[box.x,box.x+box.width])].map(value=>Number(value.toFixed(4))))].sort((a,b)=>a-b);
    const row=doc.createElement('div');row.className='print-row';row.style.gridTemplateColumns=edges.slice(1).map((end,i)=>`minmax(0,${end-edges[i]}fr)`).join(' ');page.append(row);
    for(let i=0;i<groups.length;i++){
     const group=groups[i],box=boxes[i],column=doc.createElement('div');column.className='print-column';column.style.gridColumn=`${edges.indexOf(Number(box.x.toFixed(4)))+1} / ${edges.indexOf(Number((box.x+box.width).toFixed(4)))+1}`;column.style.gridRow='1';column.style.marginLeft=i?'10px':'0';column.style.marginRight=i===groups.length-1?'0':'10px';row.append(column);
     for(let at=0;at<group.cells.length;at++){
      const cell=group.cells[at],card=doc.createElement('section');card.className='print-cell';card.dataset.cell=cell.id;
      card.style.marginTop=((at?(cell.layout?.gapBefore??24):0)+(cell.layout?.y||0))+'px';
      if(cell.layout?.height)card.style.minHeight=cell.layout.height+'px';
      column.append(card);
      if(cell.kind==='markdown'){card.classList.add('result-markdown','obsidian-markdown','markdown-rendered');card.innerHTML=renderNoteMarkdown(cell.source,cell.source,snapshot.path);}
      else if(cell.kind==='html'){
       if(cell.showCode)card.append(printText(doc,'pre','print-code',cell.source));
       const original=snapshot.outputs.get(cell.id);
       if(original?.querySelector('iframe.html-cell-frame'))card.append(doc.importNode(original,true));
       else renderHtmlOutput(card,cell.source,'HTML cell');
      }
      else{
       if(cell.showCode)card.append(printText(doc,'pre','print-code',cell.source));
       card.append(await printRuntimeOutput(doc,cell,snapshot,card.clientWidth));
      }
     }
    }
   }
  }
  ObsidianMath.installStyles(doc);
  await printWait(ObsidianDiagrams.hydrate(doc.body),15000,'打印图表渲染超时');
  await printWait(doc.fonts.ready,10000,'打印字体加载超时，请重试');
  await Promise.all([...doc.images].map(async image=>{
   if(!image.complete)await printWait(new Promise(resolve=>{image.onload=resolve;image.onerror=resolve;}),10000,'图片加载超时').catch(()=>{});
   if(!image.complete||!image.naturalWidth)image.replaceWith(printText(doc,'p','print-placeholder',(image.alt||'图片')+'（未能加载）'));
  }));
  await new Promise(resolve=>frame.contentWindow.requestAnimationFrame(()=>frame.contentWindow.requestAnimationFrame(resolve)));
  return frame;
 }catch(error){frame.remove();if(notebookPrintFrame===frame)notebookPrintFrame=null;throw error;}
}
$('#notebook-print-scope').onchange=()=>{$('#notebook-print-page-label').hidden=$('#notebook-print-scope').value!=='page';};
$('#notebook-print-cancel').onclick=()=>{notebookPrintCancelled=true;$('#notebook-print-dialog').close();};
$('#notebook-print-dialog').addEventListener('cancel',()=>{notebookPrintCancelled=true;});
$('#notebook-print-form').onsubmit=async event=>{
 event.preventDefault();if(notebookPrintBusy)return;
 if(!canPrintNotebook()||state.path!==notebookPrintPath){$('#notebook-print-status').textContent='当前笔记已切换，请重新打开打印设置。';return;}
 notebookPrintCancelled=false;notebookPrintBusy=true;$('#notebook-print-submit').disabled=true;$('#notebook-print-status').textContent='正在准备文字、公式和图形…';
 try{
  const frame=await prepareNotebookPrint(snapshotNotebookPrint(),{scope:$('#notebook-print-scope').value,index:Number($('#notebook-print-page').value),orientation:$('#notebook-print-orientation').value});
  if(notebookPrintCancelled){frame.remove();if(notebookPrintFrame===frame)notebookPrintFrame=null;return;}
  frame.contentWindow.addEventListener('afterprint',()=>{frame.remove();if(notebookPrintFrame===frame)notebookPrintFrame=null;},{once:true});
  $('#notebook-print-dialog').close();frame.contentWindow.focus();frame.contentWindow.print();
 }catch(error){$('#notebook-print-status').textContent='打印准备失败：'+error.message;}
 finally{notebookPrintBusy=false;$('#notebook-print-submit').disabled=false;}
};
document.addEventListener('keydown',event=>{
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='p'&&canPrintNotebook()&&!document.querySelector('dialog[open]')){event.preventDefault();openNotebookPrintDialog('all');}
});
