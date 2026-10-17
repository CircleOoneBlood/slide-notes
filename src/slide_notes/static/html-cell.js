'use strict';
const htmlPageChannels = new Map();
function htmlCellBridge(token) {
  const listeners = new Map();
  const send = (op,topic,value) => parent.postMessage({type:'slide-notes-html-state',token,op,topic,value},'*');
  window.noteHtml = Object.freeze({
    init:(topic,defaults) => send('init',topic,defaults),
    setState:(topic,patch) => send('patch',topic,patch),
    subscribe(topic,callback) {
      if(typeof callback!=='function')throw new TypeError('subscribe needs a callback');
      if(!listeners.has(topic))listeners.set(topic,new Set());
      listeners.get(topic).add(callback);send('subscribe',topic);
      return () => listeners.get(topic)?.delete(callback);
    },
  });
  window.addEventListener('message',event=>{
    const data=event.data;
    if(event.source!==parent||data?.type!=='slide-notes-html-state-value'||data.token!==token)return;
    for(const callback of listeners.get(data.topic)||[]){
      try{callback(structuredClone(data.value));}catch(error){console.error(error);}
    }
  });
  let pending=false;
  function measure(){
    pending=false;const body=document.body;if(!body)return;
    const rect=body.getBoundingClientRect(),style=getComputedStyle(body);
    const height=Math.ceil(Math.max(body.scrollHeight,rect.height)+parseFloat(style.marginTop||0)+parseFloat(style.marginBottom||0));
    parent.postMessage({type:'slide-notes-html-size',token,height},'*');
  }
  function schedule(){if(!pending){pending=true;requestAnimationFrame(measure);}}
  function start(){new ResizeObserver(schedule).observe(document.body);schedule();document.fonts?.ready.then(schedule);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  window.addEventListener('load',schedule);
}
// Each HTML cell runs in its own opaque-origin frame. CSS/JS stay inside the cell.
function htmlCellDocument(source, token) {
  const bridge = `<script>(${htmlCellBridge.toString()})(${JSON.stringify(token)});<\/script>`;
  // Put the sizing bridge first, so a later author script cannot prevent its setup.
  const head=/<head\b[^>]*>/i.exec(source);
  if(head)return source.slice(0,head.index+head[0].length)+bridge+source.slice(head.index+head[0].length);
  const html=/<html\b[^>]*>/i.exec(source);
  if(html)return source.slice(0,html.index+html[0].length)+'<head><meta charset="UTF-8">'+bridge+'</head>'+source.slice(html.index+html[0].length);
  return '<!doctype html><html><head><meta charset="UTF-8">'+bridge+'</head><body>'+source+'</body></html>';
}
function renderHtmlOutput(container, source, title='HTML cell', force=false) {
  let frame=container.querySelector('iframe.html-cell-frame');
  if(!frame){
    purgeResultPlots(container);container.replaceChildren();
    frame=document.createElement('iframe');frame.className='html-cell-frame';
    frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');
    frame.style.cssText='display:block;width:100%;height:420px;border:0;';container.append(frame);
  }
  frame.title=title;
  if(force||frame.htmlCellSource!==source){
    frame.htmlCellSource=source;frame.htmlCellToken=crypto.randomUUID();
    frame.htmlCellTopics=new Set();
    frame.srcdoc=htmlCellDocument(source,frame.htmlCellToken);
  }
  return frame;
}
function updateHtmlOutput(cell,force=false) {
  const output=state.outputs.get(cell.id);if(!output)return;
  const frame=renderHtmlOutput(output,cell.source,`HTML cell ${cellNumber(cell.id)}`,force);
  const page=state.doc.slides.find(page=>page.cells.some(item=>item.id===cell.id));
  const scope=JSON.stringify([new URL(location.href).searchParams.get('workspace'),state.path,page?.id]);
  if(frame.htmlCellScope!==scope)frame.htmlCellTopics=new Set();
  frame.htmlCellScope=scope;
}
function handleHtmlStateMessage(frame,data,frames) {
  if(!frame.htmlCellScope||typeof data.topic!=='string'||!/^[a-zA-Z][\w-]{0,79}$/.test(data.topic))return;
  if(!['subscribe','init','patch'].includes(data.op))return;
  const key=JSON.stringify([frame.htmlCellScope,data.topic]);
  if(data.op!=='subscribe'){
    if(!data.value||typeof data.value!=='object'||Array.isArray(data.value))return;
    let encoded;try{encoded=JSON.stringify(data.value);}catch{return;}
    if(encoded.length>65536||Object.keys(data.value).length>80)return;
    const clean=Object.fromEntries(Object.entries(JSON.parse(encoded)).filter(([name])=>!['__proto__','prototype','constructor'].includes(name)));
    const previous=htmlPageChannels.get(key)||{};
    const next=data.op==='init'?{...clean,...previous}:{...previous,...clean};
    if(JSON.stringify(next).length>65536)return;
    htmlPageChannels.set(key,next);
    if(htmlPageChannels.size>200)htmlPageChannels.delete(htmlPageChannels.keys().next().value);
  }
  frame.htmlCellTopics ||= new Set();frame.htmlCellTopics.add(data.topic);
  const value=htmlPageChannels.get(key)||{};
  for(const target of frames){
    if(target.htmlCellScope!==frame.htmlCellScope||!target.htmlCellTopics?.has(data.topic))continue;
    if(data.op==='subscribe'&&target!==frame)continue;
    target.contentWindow.postMessage({type:'slide-notes-html-state-value',token:target.htmlCellToken,topic:data.topic,value},'*');
  }
}
window.addEventListener('message',event=>{
  const data=event.data;
  if(!data||!['slide-notes-html-size','slide-notes-html-state'].includes(data.type))return;
  const frames=[...document.querySelectorAll('iframe.html-cell-frame')];
  for(const frame of frames){
    if(event.source!==frame.contentWindow||data.token!==frame.htmlCellToken)continue;
    if(data.type==='slide-notes-html-state')handleHtmlStateMessage(frame,data,frames);
    else if(Number.isFinite(data.height))frame.style.height=Math.max(62,Math.min(10000,data.height))+'px';
    break;
  }
});
