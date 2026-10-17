// Independent MathJax adapter. Obsidian's CHTML appearance without app globals.
import {mathjax} from 'mathjax-full/js/mathjax.js';
import {TeX} from 'mathjax-full/js/input/tex.js';
import {CHTML} from 'mathjax-full/js/output/chtml.js';
import {liteAdaptor} from 'mathjax-full/js/adaptors/liteAdaptor.js';
import {RegisterHTMLHandler} from 'mathjax-full/js/handlers/html.js';
import {SafeHandler} from 'mathjax-full/js/ui/safe/SafeHandler.js';
import {AllPackages} from 'mathjax-full/js/input/tex/AllPackages.js';
import {traceMathSource} from './markdown-math-source-map.js';

const adaptor=liteAdaptor();
SafeHandler(RegisterHTMLHandler(adaptor));
const output=new CHTML({fontURL:'/vendor/mathjax',adaptiveCSS:false});
const tex=new TeX({packages:AllPackages.filter(name=>!['action','setoptions'].includes(name)),maxBuffer:40000,maxMacros:1000,tags:'none'});
const mathDocument=mathjax.document('',{InputJax:tex,OutputJax:output,
  safeOptions:{allow:{URLs:'safe',classes:'safe',cssIDs:'none',styles:'safe'},classPattern:/^mjx-note-link-[A-Za-z][A-Za-z0-9_-]{0,79}$/,safeProtocols:{http:true,https:true,file:false,javascript:false,data:false}}});
const cache=new Map();
const sourceTrace=traceMathSource(tex.parseOptions);
tex.postFilters.add(({data})=>sourceTrace.annotate(data.root));
let css;
export function styles(){
  if(css===undefined){const element=output.styleSheet(mathDocument);css=adaptor.textContent(element);}
  return css;
}
export function installStyles(doc=globalThis.document){
  if(!doc||doc.getElementById('obsidian-math-styles'))return;
  const style=doc.createElement('style');style.id='obsidian-math-styles';style.textContent=styles();doc.head.append(style);
}
export function render(source,display=false,{sourceMap=false}={}){
  const key=(sourceMap?'mapped:':'')+(display?'display:':'inline:')+source;
  installStyles();
  if(cache.has(key))return cache.get(key);
  try{
    tex.reset();
    // Preserve the existing inert cross-formula group annotation in old notes.
    // This is an input compatibility shim; all formula layout uses MathJax.
    const provenance=[];let previous=0;
    const compatible=source.replace(/\\htmlData\s*\{math-link=([A-Za-z][A-Za-z0-9_-]{0,79})\}\s*\{/g,(match,id,at)=>{
      for(let i=previous;i<at;i++)provenance.push([i,i+1]);
      const replacement=`\\class{mjx-note-link-${id}}{`;
      for(let i=0;i<replacement.length;i++)provenance.push([at,at+match.length]);
      previous=at+match.length;return replacement;
    });
    if(previous)for(let i=previous;i<source.length;i++)provenance.push([i,i+1]);
    if(sourceMap)sourceTrace.begin(compatible);
    const node=mathDocument.convert(compatible,{display,em:16,ex:8,containerWidth:1200});
    let html=adaptor.outerHTML(node).replace(/class="([^"]*\bmjx-note-link-([A-Za-z][A-Za-z0-9_-]{0,79})\b[^"]*)"/g,'class="$1" data-math-link="$2"');
    if(sourceMap&&previous)html=html.replace(/data-tex-from="(\d+)" data-tex-to="(\d+)"/g,(_match,from,to)=>{
      const units=provenance.slice(Number(from),Number(to));
      return units.length?`data-tex-from="${Math.min(...units.map(unit=>unit[0]))}" data-tex-to="${Math.max(...units.map(unit=>unit[1]))}"`:'';
    });
    cache.set(key,html);if(cache.size>400)cache.delete(cache.keys().next().value);
    return html;
  }catch{
    const escaped=String(source).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    return '<span class="math-error" role="note">'+escaped+'</span>';
  }finally{sourceTrace.end();}
}
