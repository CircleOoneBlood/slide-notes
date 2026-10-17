'use strict';
function markdownRelativePath(href,sourcePath=state.path||''){
 const raw=String(href||'').split('#')[0];
 if(!raw||/^[a-z][a-z\d+.-]*:/i.test(raw)||raw.startsWith('//')||raw.includes('\\'))return null;
 let decoded;try{decoded=decodeURIComponent(raw);}catch{return null;}
 if(/[\u0000-\u001f]/.test(decoded))return null;
 const parts=decoded.startsWith('/')?[]:sourcePath.split('/').slice(0,-1);
 for(const part of decoded.split('/')){
  if(!part||part==='.')continue;
  if(part==='..'){if(!parts.length)return null;parts.pop();}else parts.push(part);
 }
 return parts.join('/');
}
function resolveMarkdownFile(href,{sourcePath=state.path||'',embed=false}={}){
 const path=markdownRelativePath(href,sourcePath);if(!path)return '';
 const workspace=new URL(location.href).searchParams.get('workspace');
 if(embed&&/\.(?:png|jpe?g|webp|gif|bmp|ico|avif|svg)$/i.test(path))return '/api/image?'+new URLSearchParams({path,...(workspace?{workspace}:{})});
 if(embed&&/\.pdf$/i.test(path))return '/api/pdf?'+new URLSearchParams({path,...(workspace?{workspace}:{})});
 return '#'+encodeURIComponent(href);
}
function renderNoteMarkdown(source,documentSource=source,sourcePath=state.path||'',sourceOffset=0){
 return ObsidianMarkdown.render(source,{documentSource,sourcePath,sourceOffset,resolveFile:resolveMarkdownFile});
}
function bindMarkdownPreview(root,options){
 const dispose=ObsidianMarkdown.bindPreview(root,{...options,sourcePath:()=>state.path||''});
 const measure=()=>options.measure?.();root.addEventListener('obsidian-render-measure',measure);
 hydrateMarkdownEmbeds(root).catch(()=>{});return()=>{dispose?.();root.removeEventListener('obsidian-render-measure',measure);};
}
function syncNotebookResourcePaths(remap){
 const root=$('#cells');
 for(const body of root.querySelectorAll('[data-markdown-source-path]'))body.dataset.markdownSourcePath=remap(body.dataset.markdownSourcePath);
 const sourcePath=node=>node.closest('[data-markdown-source-path]')?.dataset.markdownSourcePath||state.path||'';
 for(const image of root.querySelectorAll('img[data-href],.image-embed[data-href] img')){
  const href=image.dataset.href||image.closest('.image-embed').dataset.href;
  const url=resolveMarkdownFile(href,{embed:true,sourcePath:sourcePath(image)});
  if(url&&image.getAttribute('src')!==url)image.setAttribute('src',url);
 }
 for(const anchor of root.querySelectorAll('a.internal-link[data-href]')){
  const url=resolveMarkdownFile(anchor.dataset.href,{embed:anchor.classList.contains('embed-link'),sourcePath:sourcePath(anchor)});
  if(url&&anchor.getAttribute('href')!==url)anchor.setAttribute('href',url);
 }
 for(const frame of root.querySelectorAll('.markdown-pdf-embed')){
  const host=frame.closest('.markdown-embed[data-href]');if(!host)continue;
  const path=markdownRelativePath(host.dataset.href,sourcePath(host));if(!path||!path.toLowerCase().endsWith('.pdf'))continue;
  const title=path.split('/').at(-1),url='/pdf-reader.html?'+new URLSearchParams({file:resolveMarkdownFile(path,{embed:true,sourcePath:''}),name:title});
  if(frame.getAttribute('src')!==url){frame.title=title;frame.src=url;}
 }
}
async function openMarkdownLink({href,sourcePath=state.path||'',tag=false}){
 if(typeof href!=='string'||/^[a-z][a-z\d+.-]*:/i.test(href)||href.startsWith('//'))throw Error('不支持的笔记链接');
 if(tag){await showMarkdownTag(href);return;}
 const [file,anchor]=href.split('#');
 if(!file){locateMarkdownAnchor(anchor);return;}
 const path=markdownRelativePath(file,sourcePath);if(!path)throw Error('链接超出当前 Workspace');
 const target=await markdownTarget(file,sourcePath);
 await openEditor(/\.pdf$/i.test(target)?'pdf':/\.(?:png|jpe?g|webp|gif|bmp|ico|avif|svg)$/i.test(target)?'image':'notebook',target);
 if(anchor)locateMarkdownAnchor(anchor);
}
async function markdownTarget(file,sourcePath=state.path||''){
 const path=markdownRelativePath(file,sourcePath);if(!path)throw Error('链接超出当前 Workspace');
 if(/\.(?:pdf|png|jpe?g|webp|gif|bmp|ico|avif|svg|json)$/i.test(path))return path;
 const result=await api('/api/search?notes=1'),stem=value=>value.replace(/\.(?:json|md)$/i,'');
 const candidates=(result.entries||[]).filter(entry=>entry.kind!=='marimo'&&(stem(entry.path)===stem(path)||stem(entry.path)===stem(file)||entry.title===stem(file)||stem(entry.path.split('/').at(-1))===stem(file.split('/').at(-1))));
 const exact=candidates.filter(entry=>stem(entry.path)===stem(path));
 if(exact.length===1)return exact[0].path;
 if(candidates.length!==1)throw Error(candidates.length?'有多个同名笔记，请在链接中写明路径':'未找到链接的笔记');
 return candidates[0].path;
}
async function showMarkdownTag(tag){
 const dialog=document.createElement('dialog'),heading=document.createElement('h3'),close=document.createElement('button'),list=document.createElement('div');
 heading.textContent=tag;close.textContent='关闭';close.onclick=()=>dialog.close();dialog.append(heading,close,list);dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
 list.textContent='正在查找笔记…';const result=await api('/api/search?notes=1');if(!dialog.isConnected)return;
 const notes=result.entries.filter(entry=>entry.kind==='notebook'||entry.path?.toLowerCase().endsWith('.json'));
 list.replaceChildren();let matches=0;
 const escaped=tag.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp('(^|[^\\p{L}\\p{N}_])'+escaped+'(?=$|[^\\p{L}\\p{N}_/-])','u');
 for(let start=0;start<notes.length;start+=12){
  if(!dialog.isConnected)return;
  const records=await Promise.allSettled(notes.slice(start,start+12).map(async note=>({note,...await api('/api/document?path='+encodeURIComponent(note.path))})));
  for(const record of records){if(record.status!=='fulfilled')continue;const {note,document:doc}=record.value;
   if(!doc.slides.some(page=>page.cells.some(cell=>cell.kind==='markdown'&&ObsidianMarkdown.blocks(cell.source).some(block=>block.type!=='code'&&pattern.test(block.source.replace(/`[^`]*`/g,''))))))continue;
   const button=document.createElement('button');button.textContent=doc.title||note.path;button.title=note.path;button.style.display='block';button.onclick=()=>{dialog.close();openEditor('notebook',note.path).catch(error=>toast(error.message));};list.append(button);matches++;
  }
 }
 if(!matches)list.textContent='没有包含此标签的笔记';
}
function locateMarkdownAnchor(anchor){
 if(!anchor)return;
 let name;try{name=decodeURIComponent(anchor);}catch{return;}
 for(const [index,page] of (state.doc?.slides||[]).entries()){
  for(const cell of page.cells){if(cell.kind!=='markdown')continue;
   const headings=[...cell.source.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match=>match[1].replace(/[*_`]/g,''));
   if((name.startsWith('^')&&cell.source.split(/\r?\n/).some(line=>line.trimEnd().endsWith(' '+name)||line.trim()===name))||headings.includes(name)){
    if(state.active!==index){state.active=index;render();}
    document.getElementById('cell-'+cell.id)?.scrollIntoView({block:'center',behavior:'smooth'});return;
   }
  }
 }
 toast('未找到链接中的标题或块，已打开笔记');
}
async function hydrateMarkdownEmbeds(root){
 const sourcePath=state.path||'';
 for(const host of root.querySelectorAll('.markdown-embed[data-href]:not([data-embed-loading])')){
  host.dataset.embedLoading='true';const href=host.dataset.href;
  try{
   const path=await markdownTarget(href.split('#')[0],sourcePath);if(!host.isConnected)continue;
   if(path.toLowerCase().endsWith('.pdf')){
    const frame=document.createElement('iframe');frame.className='markdown-pdf-embed';frame.title=path.split('/').at(-1);frame.src='/pdf-reader.html?'+new URLSearchParams({file:resolveMarkdownFile(path,{embed:true,sourcePath:''}),name:frame.title});frame.style.cssText='width:100%;height:400px;border:0';host.append(frame);continue;
   }
   if(!path.toLowerCase().endsWith('.json'))continue;
   const result=await api('/api/document?path='+encodeURIComponent(path));if(!host.isConnected)continue;
   let cellSources=result.document.slides.flatMap(page=>page.cells.filter(cell=>cell.kind==='markdown').map(cell=>cell.source));
   const anchor=href.split('#')[1];if(anchor){
    const name=decodeURIComponent(anchor);
    if(name.startsWith('^'))cellSources=cellSources.flatMap(source=>source.split(/\n\s*\n/).filter(block=>block.trimEnd().endsWith(name)));
    else cellSources=cellSources.flatMap(source=>{const headings=[...source.matchAll(/^(#{1,6})\s+(.+)$/gm)],at=headings.findIndex(match=>match[2].replace(/[*_`]/g,'')===name);if(at<0)return [];const match=headings[at],next=headings.slice(at+1).find(other=>other[1].length<=match[1].length);return [source.slice(match.index,next?.index??source.length)];});
   }
   const body=document.createElement('div');body.className='markdown-embed-content obsidian-markdown';
   body.dataset.markdownSourcePath=path;
   body.innerHTML=ObsidianMarkdown.render(cellSources.join('\n\n'),{sourcePath:path,resolveFile:resolveMarkdownFile});
   host.append(body);ObsidianMarkdown.bindPreview(body,{read:()=>cellSources.join('\n\n'),enabled:()=>false,sourcePath:()=>body.dataset.markdownSourcePath});
  }catch{host.classList.add('is-unresolved');}
 }
}
document.addEventListener('obsidian-open-link',event=>{
 const detail=event.detail||{},card=event.target.closest?.('.cell');
 const sessionPath=card?.dataset.markdownPath||state.path||'';
 openMarkdownLink({...detail,sourcePath:detail.sourcePath||sessionPath}).catch(error=>toast(error.message));
});
