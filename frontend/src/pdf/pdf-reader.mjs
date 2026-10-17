import {setupPDFSelection} from '/pdf-selection.mjs';
import {setupPDFPageContext} from '/pdf-ai-context.mjs';
const $=selector=>document.querySelector(selector);
const status=$('#reader-status');
for(const el of document.querySelectorAll('[data-icon]'))el.innerHTML=`<svg aria-hidden="true"><use href="/icons.svg#${el.dataset.icon}"></use></svg>`;
const params=new URLSearchParams(location.search);
let loadingTask,viewer,pdfDocument,eventBus,linkService,saveTimer,findTimer,resizeObserver,passwordCallback,lastLocation;
let selectionRevision='';
let ready=false,restoring=true,cancelled=false;
const selectionUI=setupPDFSelection({getViewer:()=>viewer,getDocument:()=>pdfDocument,isReady:()=>ready,getRevision:()=>selectionRevision});
const aiPageContext=setupPDFPageContext({getViewer:()=>viewer,getDocument:()=>pdfDocument,isReady:()=>ready});
const name=params.get('name')||'PDF';$('#filename').textContent=name;$('#filename').title=name;document.title=name+' · PDF';
function fail(message){status.hidden=false;status.classList.add('error');status.textContent=message;}
function readPosition(key){try{return JSON.parse(localStorage.getItem(key));}catch{return null;}}
function storePosition(){
 clearTimeout(saveTimer);
 if(!ready||restoring||!lastLocation)return;
 const position=lastLocation;
 try{localStorage.setItem(storageKey,JSON.stringify({fingerprint:pdfDocument.fingerprints[0],page:position.pageNumber,top:position.top,left:position.left,scale:viewer.currentScaleValue,rotation:viewer.pagesRotation}));}catch{/* Storage can be unavailable in private browsing. */}
}
let storageKey='';
function toggleSearch(open){$('#searchbar').hidden=!open;$('#search-toggle').setAttribute('aria-expanded',String(open));if(open){$('#find-query').focus();$('#find-query').select();}else{clearTimeout(findTimer);eventBus?.dispatch('findbarclose',{source:window});$('#viewerContainer').focus();}}
function find(previous=false,type='again'){
 if(!ready)return;
 clearTimeout(findTimer);const query=$('#find-query').value;
 eventBus.dispatch('find',{source:window,type,query,caseSensitive:false,entireWord:false,highlightAll:true,findPrevious:previous,matchDiacritics:false});
 if(!query)$('#find-result').textContent='';
}
function goPage(value){if(!ready)return;const page=Math.max(1,Math.min(pdfDocument.numPages,Number(value)||1));viewer.currentPageNumber=page;$('#page-number').value=page;}
function zoom(factor){if(!ready)return;const target=Math.max(.25,Math.min(5,viewer.currentScale*factor));viewer.updateScale({scaleFactor:target/viewer.currentScale,drawingDelay:120});}
function fit(){if(!ready)return;const value=viewer.currentScaleValue;if(['page-width','page-fit','auto'].includes(value))viewer.currentScaleValue=value;viewer.update();}
$('#previous').onclick=()=>goPage(viewer.currentPageNumber-1);$('#next').onclick=()=>goPage(viewer.currentPageNumber+1);
$('#page-number').onchange=e=>goPage(e.target.value);$('#page-number').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();goPage(e.target.value);$('#viewerContainer').focus();}};
$('#zoom-in').onclick=()=>zoom(1.2);$('#zoom-out').onclick=()=>zoom(1/1.2);
$('#zoom').onchange=e=>{if(ready&&e.target.value!=='custom')viewer.currentScaleValue=e.target.value;};
$('#rotate').onclick=()=>{viewer.pagesRotation=(viewer.pagesRotation+90)%360;fit();};
$('#search-toggle').onclick=()=>toggleSearch($('#searchbar').hidden);
$('#find-close').onclick=()=>toggleSearch(false);$('#find-next').onclick=()=>find();$('#find-previous').onclick=()=>find(true);
$('#find-query').oninput=()=>{clearTimeout(findTimer);findTimer=setTimeout(()=>find(false,''),180);};
$('#find-query').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();find(e.shiftKey);}if(e.key==='Escape'){e.preventDefault();toggleSearch(false);}};
$('#outline-toggle').onclick=()=>{const open=$('#outline').hidden;$('#outline').hidden=!open;document.body.classList.toggle('outline-open',open);$('#outline-toggle').setAttribute('aria-expanded',String(open));};
window.addEventListener('keydown',e=>{
 if(!ready||$('#password-dialog').open)return;
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'){e.preventDefault();toggleSearch(true);return;}
 if(e.target.closest('input,select,textarea,[contenteditable]'))return;
 if(e.ctrlKey||e.metaKey){if(['+','=','-','0'].includes(e.key)){e.preventDefault();if(e.key==='0'){viewer.currentScaleValue='page-width';}else zoom(e.key==='-'?1/1.2:1.2);}return;}
 if(e.key==='Escape'&&!$('#searchbar').hidden){e.preventDefault();toggleSearch(false);}
 if(e.key==='PageDown'||e.key==='PageUp'){e.preventDefault();goPage(viewer.currentPageNumber+(e.key==='PageDown'?1:-1));}
});
$('#viewerContainer').addEventListener('wheel',e=>{if(ready&&(e.ctrlKey||e.metaKey)){e.preventDefault();zoom(Math.exp(-e.deltaY*.003));}},{passive:false});
$('#password-form').onsubmit=e=>{e.preventDefault();const password=$('#password').value;$('#password').value='';$('#password-dialog').close();passwordCallback?.(password);};
function cancelPassword(){cancelled=true;$('#password-dialog').close();loadingTask?.destroy();fail('已取消打开此 PDF。关闭标签后重新打开可再次输入密码。');}
$('#password-cancel').onclick=cancelPassword;$('#password-dialog').oncancel=e=>{e.preventDefault();cancelPassword();};
window.addEventListener('pagehide',()=>{storePosition();clearTimeout(findTimer);resizeObserver?.disconnect();loadingTask?.destroy();});
async function buildOutline(items,parent=$('#outline-items')){
 if(!items?.length){parent.textContent='此 PDF 没有文档目录';return;}
 for(const entry of items){
  const button=document.createElement('button');button.textContent=entry.title||'未命名章节';
  button.onclick=()=>{if(entry.dest)linkService.goToDestination(entry.dest).catch(error=>fail('无法定位此章节：'+error.message));else if(entry.url){try{const url=new URL(entry.url,location.href);if(['http:','https:','mailto:'].includes(url.protocol))window.open(url.href,'_blank','noopener,noreferrer');}catch{}}};
  if(entry.items?.length){const details=document.createElement('details'),summary=document.createElement('summary'),children=document.createElement('div');summary.append(button);details.append(summary,children);parent.append(details);await buildOutline(entry.items,children);}else parent.append(button);
 }
}
async function start(){
 const url=new URL(params.get('file')||'',location.origin);
 if(url.origin!==location.origin||url.pathname!=='/api/pdf'||!url.searchParams.has('path'))throw Error('PDF 地址无效，请从工作区文件列表打开。');
 const versionURL='/api/ai/selection-version?'+url.searchParams;
 async function sourceVersion(){const response=await fetch(versionURL);if(!response.ok)throw Error('无法核对 PDF 版本，请重新打开文件');return (await response.json()).revision;}
 selectionRevision=await sourceVersion();
 $('#external').href=url.href;const download=new URL(url);download.searchParams.set('download','1');$('#download').href=download.href;
 storageKey='slide-notes-pdf:'+url.searchParams.toString();
 const pdfjs=await import('/vendor/pdfjs/pdf.mjs');globalThis.pdfjsLib=pdfjs;
 const {PDFViewer,EventBus,PDFLinkService,PDFFindController,LinkTarget,DownloadManager}=await import('/vendor/pdfjs/pdf_viewer.mjs');
 pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdfjs/pdf.worker.mjs';
 eventBus=new EventBus();linkService=new PDFLinkService({eventBus,externalLinkTarget:LinkTarget.BLANK,externalLinkRel:'noopener noreferrer'});
 const findController=new PDFFindController({eventBus,linkService});
 viewer=new PDFViewer({container:$('#viewerContainer'),viewer:$('#viewer'),eventBus,linkService,findController,downloadManager:new DownloadManager(),textLayerMode:1,annotationMode:pdfjs.AnnotationMode.ENABLE,imageResourcesPath:'/vendor/pdfjs/images/',maxCanvasPixels:16_777_216,maxCanvasDim:8192});
 linkService.setViewer(viewer);
 eventBus.on('pagesinit',()=>{
  ready=true;selectionUI.ready();
  for(const id of ['page-number','zoom','zoom-in','zoom-out','search-toggle','rotate'])$('#'+id).disabled=false;
  $('#page-count').textContent='/ '+pdfDocument.numPages;$('#page-number').max=pdfDocument.numPages;
  const previous=readPosition(storageKey);const saved=previous?.fingerprint===pdfDocument.fingerprints[0]?previous:null;
  viewer.pagesRotation=[0,90,180,270].includes(saved?.rotation)?saved.rotation:0;
  const scale=saved?.scale;
  viewer.currentScaleValue=['page-width','page-fit','auto'].includes(scale)?scale:Number.isFinite(Number(scale))&&Number(scale)>=.25&&Number(scale)<=5?Number(scale):'page-width';
  if(saved?.page>0&&saved.page<=pdfDocument.numPages){viewer.scrollPageIntoView({pageNumber:saved.page,destArray:[null,{name:'XYZ'},Number(saved.left)||0,Number(saved.top)||0,null],allowNegativeOffset:true});}
  $('#page-number').value=viewer.currentPageNumber;$('#previous').disabled=viewer.currentPageNumber<=1;$('#next').disabled=viewer.currentPageNumber>=pdfDocument.numPages;
  aiPageContext.changed();
  requestAnimationFrame(()=>{restoring=false;});
 });
 eventBus.on('pagerendered',event=>{selectionUI.rendered();if(event.error){fail('此页未能完整显示：'+event.error.message+'。可尝试使用浏览器阅读器打开。');}else if(!status.classList.contains('error')){status.hidden=true;document.body.dataset.rendered='true';}});
 eventBus.on('pagechanging',event=>{$('#page-number').value=event.pageNumber;$('#previous').disabled=event.pageNumber<=1;$('#next').disabled=event.pageNumber>=viewer.pagesCount;aiPageContext.changed();});
 eventBus.on('rotationchanging',()=>selectionUI.viewChanged());
 eventBus.on('scalechanging',event=>{selectionUI.viewChanged();const scale=viewer.currentScaleValue;const select=$('#zoom');if([...select.options].some(option=>option.value===String(scale)&&option.value!=='custom'))select.value=String(scale);else{const custom=$('#custom-scale');custom.hidden=false;custom.textContent=Math.round(event.scale*100)+'%';select.value='custom';}});
 eventBus.on('updateviewarea',({location})=>{lastLocation=location;clearTimeout(saveTimer);saveTimer=setTimeout(storePosition,180);});
 eventBus.on('updatefindmatchescount',({matchesCount})=>{$('#find-result').textContent=matchesCount.total?matchesCount.current+' / '+matchesCount.total:'';});
 eventBus.on('updatefindcontrolstate',({state,matchesCount})=>{$('#find-result').textContent=!$('#find-query').value?'':state===1?'未找到':state===3?'搜索中…':matchesCount.total?matchesCount.current+' / '+matchesCount.total:'';});
 resizeObserver=new ResizeObserver(()=>{if($('#viewerContainer').clientWidth&&$('#viewerContainer').clientHeight)fit();});resizeObserver.observe($('#viewerContainer'));
 loadingTask=pdfjs.getDocument({url:url.href,cMapUrl:'/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/pdfjs/standard_fonts/',wasmUrl:'/vendor/pdfjs/wasm/',iccUrl:'/vendor/pdfjs/iccs/',enableXfa:false,disableAutoFetch:true,disableStream:true});
 loadingTask.onProgress=({loaded,total})=>{if(!ready&&total)status.textContent='正在加载 PDF · '+Math.min(100,Math.round(loaded/total*100))+'%';};
 loadingTask.onPassword=(callback,reason)=>{passwordCallback=callback;$('#password-hint').textContent=reason===pdfjs.PasswordResponses.INCORRECT_PASSWORD?'密码不正确，请重试':'输入密码以打开文档';$('#password-dialog').showModal();$('#password').focus();};
 pdfDocument=await loadingTask.promise;
 if(await sourceVersion()!==selectionRevision)throw Error('PDF 在加载期间已变化，请重新打开');
 linkService.setDocument(pdfDocument);viewer.setDocument(pdfDocument);
 buildOutline(await pdfDocument.getOutline());
}
start().catch(error=>{if(!cancelled)fail('无法打开 PDF：'+error.message+'\n可尝试使用右上角的浏览器阅读器或下载原文件。');});
