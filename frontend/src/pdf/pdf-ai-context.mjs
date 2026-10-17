// Capture only the page displayed when the user sends an AI message.
export async function capturePDFPage(pdfDocument,viewer,{includeImage=true}={}) {
 const pageNumber=viewer.currentPageNumber,rotation=viewer.getPageView(pageNumber-1)?.viewport?.rotation;
 const page=await pdfDocument.getPage(pageNumber);
 const content=await page.getTextContent().catch(()=>({items:[]}));
 const fullText=content.items.filter(item=>typeof item.str==='string').map(item=>item.str+(item.hasEOL?'\n':' ')).join('').trim();
 const source={rotation:rotation??page.rotate,page:pageNumber,pageCount:pdfDocument.numPages,text:fullText.slice(0,16000),truncated:fullText.length>16000,rects:[[...page.view]],fingerprint:pdfDocument.fingerprints[0]||''};
 if(includeImage){
  const base=page.getViewport({scale:1,rotation:rotation??page.rotate});
  const scale=Math.min(1.75,1600/Math.max(base.width,base.height),Math.sqrt(2_000_000/(base.width*base.height)));
  const viewport=page.getViewport({scale,rotation:rotation??page.rotate});
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.ceil(viewport.width));canvas.height=Math.max(1,Math.ceil(viewport.height));
  await page.render({canvasContext:canvas.getContext('2d'),viewport,background:'rgb(255,255,255)'}).promise;
  source.data=canvas.toDataURL('image/png');if(source.data.length>4000000)source.data=canvas.toDataURL('image/jpeg',.88);
  canvas.width=canvas.height=0;
  if(source.data.length>4000000)throw Error('当前 PDF 页面截图过大，请框选需要解释的区域');
 }
 if(!source.text&&!source.data)throw Error('当前 PDF 页没有可提取文字，请移除一张图片附件以附带页面截图');
 return source;
}
export function setupPDFPageContext({getDocument,getViewer,isReady}) {
 const post=data=>{if(parent!==window)parent.postMessage(data,location.origin);};
 const pending=new Set();
 window.addEventListener('message',async event=>{
  const data=event.data;
  if(event.origin!==location.origin||event.source!==parent||data?.type!=='slide-notes:pdf-context-request'||typeof data.id!=='string'||data.id.length>100)return;
  if(pending.has(data.id))return;
  if(!isReady()||!getDocument()) {post({type:'slide-notes:pdf-context-result',id:data.id,error:'PDF 还在加载，请等当前页显示后再发送'});return;}
  if(pending.size>=4){post({type:'slide-notes:pdf-context-result',id:data.id,error:'正在读取 PDF 页面，请稍后重试'});return;}
  pending.add(data.id);
  try{post({type:'slide-notes:pdf-context-result',id:data.id,source:await capturePDFPage(getDocument(),getViewer(),{includeImage:data.includeImage!==false})});}
  catch(error){post({type:'slide-notes:pdf-context-result',id:data.id,error:'无法读取当前 PDF 页面：'+error.message});}
  finally{pending.delete(data.id);}
 });
 return {changed(){if(isReady()&&getDocument())post({type:'slide-notes:pdf-view-state',page:getViewer().currentPageNumber,pageCount:getDocument().numPages,fingerprint:getDocument().fingerprints[0]||'',rotation:getViewer().getPageView(getViewer().currentPageNumber-1)?.viewport?.rotation||0});}};
}
