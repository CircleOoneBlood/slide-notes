'use strict';
// Streamed text remains immutable message data. This module only prepares its
// visual Markdown and patches changed DOM nodes; it never executes model HTML.
const NoteAIResponse=(()=>{
 let serial=0;
 function prepare(source,streaming){
  const pending=[],prefix='AIPENDING'+(++serial)+'TOKEN';let result='',at=0;
  const closed=(from,end)=>{for(let i=from;i<source.length;i++){if(source.startsWith(end,i))return i;if(source[i]==='\\')i++;}return -1;};
  while(at<source.length){
   // Fenced and indented code are literal, including any dollar/TeX syntax.
   if(at===0||source[at-1]==='\n'){
    const fence=/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(source.slice(at));
    if(fence){
     const mark=fence[1],end=new RegExp('^ {0,3}'+mark[0]+'{'+mark.length+',}[ \\t]*(?:\\r?\\n|$)','m'),rest=source.slice(at+fence[0].length),match=end.exec(rest);
     const length=match?fence[0].length+match.index+match[0].length:source.length-at;result+=source.slice(at,at+length);at+=length;continue;
    }
    const indented=/^(?: {4}|\t)[^\n]*(?:\n|$)/.exec(source.slice(at));
    if(indented){result+=indented[0];at+=indented[0].length;continue;}
   }
   if(source[at]==='`'){
    const ticks=/^`+/.exec(source.slice(at))[0];let end=source.indexOf(ticks,at+ticks.length);
    while(end>=0&&(source[end-1]==='`'||source[end+ticks.length]==='`'))end=source.indexOf(ticks,end+ticks.length);
    const to=end<0?source.length:end+ticks.length;result+=source.slice(at,to);at=to;continue;
   }
   let opening,ending,display=false;
   if(source.startsWith('\\[',at)){opening='\\[';ending='\\]';display=true;}
   else if(source.startsWith('\\(',at)){opening='\\(';ending='\\)';}
   else if(source[at]==='$'){opening=source.startsWith('$$',at)?'$$':'$';ending=opening;display=opening==='$$';}
   if(opening){
    const start=at+opening.length,end=closed(start,ending);
    if(end<0&&!display&&opening==='$'&&(!source[start]||/[\s\d]/.test(source[start]))){result+=source[at++];continue;}
    if(end<0){
     const marker=prefix+pending.length+'END';pending.push({marker,source:source.slice(at),display});
     result+=(display?'\n\n':'')+marker+(display?'\n\n':'');break;
    }
    const tex=source.slice(start,end);
    result+=display?'\n\n$$\n'+tex+'\n$$\n\n':'$'+tex+'$';at=end+ending.length;continue;
   }
   if(source[at]==='\\'&&at+1<source.length){result+=source.slice(at,at+2);at+=2;continue;}
   result+=source[at++];
  }
  return {source:result,pending,streaming};
 }
 function morph(parent,fragment){
  const children=[...fragment.childNodes];
  for(let i=0;i<children.length;i++){
   const fresh=children[i],old=parent.childNodes[i];
   if(!old){parent.append(fresh);continue;}
   if(old.nodeType!==fresh.nodeType||old.nodeName!==fresh.nodeName){old.replaceWith(fresh);continue;}
   if(old.nodeType===3){if(old.data!==fresh.data)old.data=fresh.data;continue;}
   if(old.nodeType!==1)continue;
   for(const attribute of [...old.attributes])if(!fresh.hasAttribute(attribute.name))old.removeAttribute(attribute.name);
   for(const attribute of [...fresh.attributes])if(old.getAttribute(attribute.name)!==attribute.value)old.setAttribute(attribute.name,attribute.value);
   morph(old,fresh);
  }
  while(parent.childNodes.length>children.length)parent.lastChild.remove();
 }
 function render(body,message){
  const streaming=message.status==='streaming',source=String(message.content||'');
  body.classList.add('ai-response-markdown','obsidian-markdown');body.dataset.streaming=String(streaming);
  if(!source){body.textContent=message.toolStatus||'正在等待回复…';body._aiResponseKey=null;return;}
  const key=(streaming?'stream:':'final:')+source;if(body._aiResponseKey===key)return;
  const prepared=prepare(source,streaming);
  let html=typeof ObsidianMarkdown!=='undefined'?ObsidianMarkdown.render(prepared.source):markdown(prepared.source);
  html=DOMPurify.sanitize(html,{
   FORBID_TAGS:['img','iframe','video','audio','object','embed','form','input','style','script'],
   CUSTOM_ELEMENT_HANDLING:{tagNameCheck:/^mjx-[a-z0-9-]+$/,attributeNameCheck:/^(?:class|style|jax|display|size|space|texclass|width|height|data-[a-z0-9-]+)$/},
   ADD_ATTR:['jax','display','size','space','texclass'],
  });
  const template=document.createElement('template');template.innerHTML=html;
  for(const item of prepared.pending){
   const walker=document.createTreeWalker(template.content,NodeFilter.SHOW_TEXT);let node;
   while((node=walker.nextNode())){
    const index=node.data.indexOf(item.marker);if(index<0)continue;
    const tail=node.splitText(index);tail.deleteData(0,item.marker.length);
    const label=document.createElement(streaming?'span':'code');label.className='ai-math-pending';
    label.textContent=streaming?'公式生成中…':item.source;
    if(streaming){label.setAttribute('role','status');label.setAttribute('aria-label','公式尚在生成，完整后自动排版');}
    tail.parentNode.insertBefore(label,tail);break;
   }
  }
  for(const link of template.content.querySelectorAll('a')){link.target='_blank';link.rel='noopener noreferrer';}
  morph(body,template.content);body._aiResponseKey=key;
  if(!body._aiCopyBound){
   body.addEventListener('click',async event=>{
    const button=event.target.closest?.('.copy-code-button');if(!button||!body.contains(button))return;
    const code=button.closest('.el-pre')?.querySelector('pre code');if(!code)return;
    try{await navigator.clipboard.writeText(code.textContent.replace(/\n$/,''));button.textContent='已复制';setTimeout(()=>{if(button.isConnected)button.textContent='复制';},1200);}
    catch{button.title='请选中代码后复制';}
   });body._aiCopyBound=true;
  }
 }
 return {prepare,render};
})();
