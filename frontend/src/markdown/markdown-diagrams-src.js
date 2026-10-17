import mermaid from 'mermaid';

mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'default',
  fontFamily:'ui-sans-serif, system-ui, sans-serif',maxTextSize:50000,
  flowchart:{htmlLabels:false},suppressErrorRendering:true});
let serial=0;
export async function hydrate(root){
  for(const block of root.querySelectorAll('.mermaid-block:not([data-diagram-rendered])')){
    block.dataset.diagramRendered='pending';
    const source=block.querySelector('.mermaid-source')?.textContent||'';
    if(!source.trim())continue;
    try{
      const result=await mermaid.render('note-mermaid-'+(++serial),source);
      if(!block.isConnected)continue;
      // Strict Mermaid plus the same local sanitizer as Markdown. No bindFunctions
      // (click callbacks), foreignObject HTML, external images, or scripts.
      const svg=globalThis.DOMPurify.sanitize(result.svg,{USE_PROFILES:{svg:true,svgFilters:true},FORBID_TAGS:['foreignObject','image','script','a'],FORBID_ATTR:['href','xlink:href','onload']});
      block.innerHTML=svg;block.dataset.diagramRendered='ready';
      block.dispatchEvent(new CustomEvent('obsidian-render-measure',{bubbles:true}));
    }catch{
      block.dataset.diagramRendered='error';
      const label=document.createElement('small');label.textContent='图表语法不完整，保留源码';label.className='math-error';block.append(label);
    }
  }
}
