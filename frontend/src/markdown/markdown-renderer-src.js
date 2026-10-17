/**
 * Note's independent implementation of Obsidian-compatible reading Markdown.
 * No application source is copied from Obsidian. Source offsets always refer
 * to the caller's original string, including CRLF and hidden comments.
 */
import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import {mathFlow} from './markdown-math-flow.js';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import {defaultHandlers} from 'mdast-util-to-hast';
import Prism from 'prismjs';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-jsx.js';
import 'prismjs/components/prism-tsx.js';
import 'prismjs/components/prism-yaml.js';
import 'prismjs/components/prism-sql.js';
import 'prismjs/components/prism-markdown.js';

function obsidianMathSyntax(){
  // Obsidian accepts TeX on the opening/closing $$ lines. Keep micromark's
  // container handling while allowing a closing fence after the last TeX token.
  for(const extension of this.data().micromarkExtensions||[]){
    if(extension.flow?.[36])extension.flow[36]=mathFlow;
  }
}
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(obsidianMathSyntax);
const tasks = new Map();
const copies = new Map();
let serial = 0;
let defaults = {};
let documentDefinitions={source:null,items:[]};
const generatedAttributes = ['data-task-token', 'data-copy-token', 'data-math-token', 'data-callout-generated'];
const escapePrefix='\uE000'+Math.random().toString(36).slice(2)+'\uE001';
const escapedCharacters=['[',']','=','^','#','!'];
function restoreEscapes(value){let result=String(value).replace(/\u2063 */g,'');for(const character of escapedCharacters)result=result.replaceAll(escapePrefix+character.charCodeAt(0)+'\uE002',character);return result;}
const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character]));
const text = value => ({type:'text', value:String(value)});
const element = (tagName, properties={}, children=[]) => ({type:'element', tagName, properties, children});
const walk = (node, fn) => { if (node.children) for (const child of [...node.children]) walk(child, fn); fn(node); };
const token = () => `om-${Date.now().toString(36)}-${(++serial).toString(36)}-${Math.random().toString(36).slice(2)}`;
function retain(map, key, value) { map.set(key,value); if(map.size>10000)map.delete(map.keys().next().value); return key; }
function purify(html, forbidGenerated=false) {
  const purifier = globalThis.DOMPurify;
  if (!purifier?.sanitize) return escapeHTML(html);
  return purifier.sanitize(html, {
    USE_PROFILES:{html:true, svg:true, svgFilters:false, mathMl:true},
    FORBID_TAGS:['script','style','iframe','object','embed','form','textarea','select','option'],
    FORBID_ATTR:['srcdoc','autofocus','contenteditable',...(forbidGenerated?generatedAttributes:[])],
    ADD_ATTR:['target','rel','data-href','data-callout','data-callout-fold','data-callout-metadata','data-task',...generatedAttributes],
    ALLOW_DATA_ATTR:true,
  });
}
function safeURL(value, image=false) {
  const href=String(value||'').trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return '';
  const compact=href.replace(/[\s\u0000-\u0020]/g,'');
  if (/^(?:javascript|vbscript|file|filesystem|blob):/i.test(compact)) return '';
  if (/^data:/i.test(compact)) return image && /^data:image\/(?:png|gif|jpe?g|webp|avif);base64,[a-z\d+/=]+$/i.test(compact)?href:'';
  if (/^[a-z][a-z\d+.-]*:/i.test(compact) && !/^(?:https?|mailto|tel):/i.test(compact))return '';
  return href;
}

export function configure(options={}) { defaults={...defaults,...options}; }

function formulaSourceMap(source,node) {
  if(!node.position)return null;
  const start=node.position.start.offset,raw=source.slice(start,node.position.end.offset);
  const opening=/^\$+/.exec(raw),closing=/\$+\s*$/.exec(raw);
  if(!opening||!closing)return null;
  let at=opening[0].length;const starts=[],ends=[];
  for(const character of node.value.split('')) {
    if(/\s/.test(character)) {starts.push(start+at);while(at<closing.index&&/\s/.test(raw[at]))at++;ends.push(start+at);continue;}
    while(at<closing.index&&/\s/.test(raw[at]))at++;
    if(at>=closing.index||raw[at]!==character)return null;
    starts.push(start+at);ends.push(start+ ++at);
  }
  if(raw.slice(at,closing.index).trim())return null;
  return {starts,ends};
}

// Mask comments without shifting any subsequent UTF-16 offset. Comments inside
// code/math remain literal. This also covers comments spanning blank lines.
function maskComments(source) {
  if(!source.includes('%%'))return source;
  const protectedRanges=[];
  walk(parser.parse(source), node => {
    if (['code','inlineCode','math','inlineMath','html'].includes(node.type)&&node.position)
      protectedRanges.push([node.position.start.offset,node.position.end.offset]);
  });
  return source.replace(/%%[\s\S]*?%%/g,(value,offset)=>protectedRanges.some(([from,to])=>offset>=from&&offset<to)?value:'\u2063'+' '.repeat(value.length-1));
}
function parse(source) {
  const tree=parser.parse(maskComments(source));
  walk(tree,node=>{
    if(node.type==='math'&&node.meta){
      // Fence metadata is parsed as a Markdown string upstream, which unescapes
      // TeX backslashes/entities. Recover that first TeX line verbatim instead.
      const opening=source.slice(node.position.start.offset,node.position.end.offset).split(/\r\n|\r|\n/,1)[0].replace(/^\${2,}/,'').trim();
      node.value=opening+'\n'+node.value;node.meta=null;
    }
    if(node.type==='inlineMath'&&node.position&&source.slice(node.position.start.offset,node.position.end.offset).startsWith('$$')){
      node.type='math';delete node.data;
    }
    if(node.type!=='text'||!node.position)return;
    const raw=source.slice(node.position.start.offset,node.position.end.offset);
    const punctuation=/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;
    if(!raw.includes('\\')||raw.replace(punctuation,'$1')!==node.value)return;
    node.value=raw.replace(punctuation,(_match,character)=>escapedCharacters.includes(character)?escapePrefix+character.charCodeAt(0)+'\uE002':character);
  });
  // A compact $$...$$ is a display block even when micromark first encounters
  // it as text math. Lift it out of paragraphs instead of producing div-in-p.
  const lift=node=>{
    if(!node.children)return;
    for(const child of node.children)lift(child);
    node.children=node.children.flatMap(child=>{
      if(child.type!=='paragraph'||!child.children.some(item=>item.type==='math'))return [child];
      const result=[];let pending=[];
      const flush=()=>{
        if(pending.some(item=>item.type!=='text'||item.value.trim()))result.push({...child,children:pending,position:{start:pending[0].position?.start||child.position.start,end:pending.at(-1).position?.end||child.position.end}});
        pending=[];
      };
      for(const item of child.children){if(item.type==='math'){flush();result.push(item);}else pending.push(item);}
      flush();return result;
    });
  };
  lift(tree);
  return tree;
}

/** Return complete, contiguous chunks; whitespace is never thrown away. */
export function blocks(source) {
  source=String(source??'');
  const children=parse(source).children;
  if (!children.length) return source?[{from:0,to:source.length,source,type:'paragraph'}]:[];
  return children.map((node,index)=>{
    const from=index===0?0:node.position.start.offset;
    const to=index+1<children.length?children[index+1].position.start.offset:source.length;
    const isCallout=node.type==='blockquote'&&/^\[![\w-]+(?:\|[^\]]*)?\][+-]?/.test(node.children?.[0]?.children?.[0]?.value||'');
    const inlineMath=[];
    walk(node,child=>{if(child.type==='inlineMath'&&child.position)inlineMath.push({from:child.position.start.offset,to:child.position.end.offset});});
    return {from,to,source:source.slice(from,to),type:isCallout?'callout':node.type,inlineMath};
  });
}

function splitFirstLine(children) {
  const first=[],rest=[];let split=false;
  for(const child of children){
    if(split){rest.push(child);continue;}
    if(child.type==='break'){split=true;continue;}
    if(child.type==='text'&&/[\r\n]/.test(child.value)){
      const match=/\r\n|\r|\n/.exec(child.value),at=match.index;
      if(at)first.push({...child,value:child.value.slice(0,at)});
      if(at+match[0].length<child.value.length)rest.push({...child,value:child.value.slice(at+match[0].length)});
      split=true;
    }else first.push(child);
  }
  return [first,rest];
}

function inlineTokens(value,inlineNotes=[]) {
  const output=[];
  const pattern=/(!?)\[\[([^\]\n]+)\]\]|(^|[\s])#([\p{L}\p{N}_/-]+)|==/gu;
  let cursor=0,match;
  while((match=pattern.exec(value))){
    let at=match.index;
    if(match[3]!==undefined)at+=match[3].length;
    if(at>cursor)output.push(text(value.slice(cursor,at)));
    if(match[2]!==undefined){
      const pieces=match[2].split('|'),href=pieces.shift().trim(),alias=pieces.join('|');
      output.push({type:match[1]?'obsidianEmbed':'obsidianLink',href,alias:alias||href.split('#')[0]||href});
    }else if(match[4]!==undefined){
      if(/^\d+$/.test(match[4]))output.push(text('#'+match[4]));
      else output.push({type:'obsidianTag',value:'#'+match[4]});
    }else output.push({type:'obsidianHighlightDelimiter',canOpen:pattern.lastIndex===value.length||!/\s/.test(value[pattern.lastIndex]),canClose:at===0||!/\s/.test(value[at-1])});
    cursor=pattern.lastIndex;
  }
  if(cursor<value.length)output.push(text(value.slice(cursor)));
  return output;
}
function inlineFootnotes(children,definitions,source){
  const result=[];let pending=null,depth=0,pendingOffset=null;
  const emit=child=>(pending||result).push(child);
  for(const child of children){
    if(child.type!=='text'){emit(child);continue;}
    let cursor=0;
    while(cursor<child.value.length){
      if(!pending){
        const start=child.value.indexOf('^[',cursor);
        if(start<0){emit({...child,value:child.value.slice(cursor)});break;}
        if(start>cursor)emit({...child,value:child.value.slice(cursor,start)});
        const rawStart=child.position?.start.offset??0,rawEnd=child.position?.end.offset??rawStart;
        const raw=source.slice(rawStart,rawEnd),candidates=[];
        for(let at=0;(at=raw.indexOf('^[',at))>=0;at+=2){let slashes=0;for(let back=at-1;back>=0&&raw[back]==='\\';back--)slashes++;if(slashes%2===0)candidates.push(at);}
        const ordinal=(child.value.slice(0,start).match(/\^\[/g)||[]).length;
        pendingOffset=rawStart+(candidates[ordinal]??start);
        pending=[];depth=1;cursor=start+2;
      }else{
        let end=cursor;
        for(;end<child.value.length;end++){
          if(child.value[end]==='\\'){end++;continue;}
          if(child.value[end]==='[')depth++;
          if(child.value[end]===']'&&!--depth)break;
        }
        if(end>cursor)pending.push({...child,value:child.value.slice(cursor,end)});
        if(depth){cursor=child.value.length;continue;}
        const identifier=`inline-${++serial}`;
        definitions.push({type:'footnoteDefinition',identifier,children:[{type:'paragraph',children:highlight(pending.flatMap(item=>item.type==='text'?inlineTokens(item.value):[item]))}]});
        result.push({type:'footnoteReference',identifier,obsidianOffset:pendingOffset});pending=null;cursor=end+1;
      }
    }
  }
  if(pending)result.push(text('^['),...pending);
  return result;
}
function highlight(children) {
  const output=[]; let pending=null;
  for(const child of children){
    if(child.type==='obsidianHighlightDelimiter'){
      if(pending&&child.canClose){output.push({type:'obsidianHighlight',children:pending});pending=null;}
      else if(!pending&&child.canOpen)pending=[];
      else (pending||output).push(text('=='));
    }else (pending||output).push(child);
  }
  if(pending)output.push(text('=='),...pending);
  return output;
}
function prepare(tree, source, renderId,registerTasks=true) {
  const inlineNotes=[];
  walk(tree,node=>{
    if(node.type==='listItem'&&registerTasks){
      const offset=node.position?.start.offset;
      const match=source.slice(offset).match(/^(?:[-+*]|\d+[.)])[\t ]+\[([^\]\r\n])\](?=[\t ]|\r?\n|$)/);
      if(match){
        const markerOffset=offset+match[0].lastIndexOf('[')+1;
        const marker=match[1];
        if(node.checked==null){
          const paragraph=node.children?.[0],first=paragraph?.children?.[0];
          if(first?.type==='text')first.value=first.value.replace(/^\[[^\]\r\n]\][\t ]?/, '');
        }
        node.checked=marker!==' ';
        const id=retain(tasks,token(),{source,offset:markerOffset,marker,renderId});
        node.data={...node.data,hProperties:{...node.data?.hProperties,'data-task-token':id,'data-task':marker,className:['task-list-item',...(node.checked?['is-checked']:[])]}};
      }
    }
    if(node.type==='blockquote'){
      const paragraph=node.children?.[0],first=paragraph?.children?.[0];
      const match=first?.type==='text'&&first.value.match(/^\[!([\w-]+)(?:\|([^\]]*))?\]([+-]?)(?:[\t ]+|(?=[\r\n]|$))/);
      if(match){
        first.value=first.value.slice(match[0].length);
        const [title,rest]=splitFirstLine(paragraph.children);
        node.type='obsidianCallout';node.calloutType=match[1].toLowerCase();node.metadata=match[2]||'';node.fold=match[3];
        node.title=title.some(child=>child.type!=='text'||child.value.trim())?title:[text(match[1].charAt(0).toUpperCase()+match[1].slice(1).replace(/-/g,' '))];
        node.children=[...(rest.length?[{...paragraph,children:rest}]:[]),...node.children.slice(1)];
      }
    }
    if(node.children&&!['code','inlineCode','html'].includes(node.type)){
      node.children=highlight(inlineFootnotes(node.children,inlineNotes,source).flatMap(child=>child.type==='text'?inlineTokens(child.value):[child]));
    }
    if(['paragraph','heading'].includes(node.type)&&node.children?.length){
      const last=node.children.at(-1);
      const match=last.type==='text'&&last.value.match(/(?:^|[\t ])\^([A-Za-z0-9-]+)[\t ]*$/);
      if(match){last.value=last.value.slice(0,match.index);node.data={...node.data,hProperties:{...node.data?.hProperties,id:match[1], 'data-block-id':match[1]}};}
    }
    if(node.type==='heading'){
      const heading=plain(node).trim();
      node.data={...node.data,hProperties:{...node.data?.hProperties,id:node.data?.hProperties?.id||heading,'data-heading':heading}};
    }
    if(node.children){
      node.children=node.children.filter((child,index,children)=>{
        const blockId=child.data?.hProperties?.['data-block-id'];
        if(child.type==='paragraph'&&!blockId&&child.children.every(item=>item.type==='break'||item.type==='text'&&!restoreEscapes(item.value).trim()))return false;
        if(child.type!=='paragraph'||!blockId||plain(child).trim()||!index)return true;
        const previous=children[index-1];
        if(['definition','footnoteDefinition'].includes(previous.type))return true;
        previous.data={...previous.data,hProperties:{...previous.data?.hProperties,id:blockId,'data-block-id':blockId}};
        return false;
      });
    }
  });
  if(tree.children)tree.children.push(...inlineNotes);
}

const calloutPaths={
  note:'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L9 17l-4 1 1-4Z',
  info:'M12 16v-4m0-4h.01M22 12a10 10 0 11-20 0 10 10 0 0120 0',
  warning:'m10.3 3.9-8 14a2 2 0 001.7 3.1h16a2 2 0 001.7-3.1l-8-14a2 2 0 00-3.4 0M12 9v4m0 4h.01',
  success:'m20 6-11 11-5-5',
  question:'M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3m.1 4h.01M22 12a10 10 0 11-20 0 10 10 0 0120 0',
  quote:'M3 21c3 0 5-3 5-7V7H2v7h4m8 7c3 0 5-3 5-7V7h-6v7h4',
};
function calloutIcon(type){
  const kind=/^(?:tip|hint|important|success|check|done)$/.test(type)?'success':/^(?:warning|caution|attention|danger|error|failure|fail|missing|bug)$/.test(type)?'warning':/^(?:question|help|faq)$/.test(type)?'question':/^(?:quote|cite)$/.test(type)?'quote':/^(?:info|todo|abstract|summary|tldr|example)$/.test(type)?'info':'note';
  return element('svg',{viewBox:'0 0 24 24',width:18,height:18,fill:'none',stroke:'currentColor',strokeWidth:2,strokeLinecap:'round',strokeLinejoin:'round',ariaHidden:'true'},[element('path',{d:calloutPaths[kind]})]);
}
function fileURL(href, embed, options) {
  try {
    const resolved=options.resolveFile?.(href,{embed,sourcePath:options.sourcePath});
    return safeURL(typeof resolved==='string'?resolved:resolved?.url,embed);
  }catch{return '';}
}
function plain(node){return restoreEscapes(node.value??node.children?.map(plain).join('')??node.alias??node.href??node.alt??node.identifier??'');}
function footnoteNumbers(tree){
  const named=new Map(),inline=new Map();let number=0;
  const visit=node=>{
    if(node.type==='footnoteDefinition')return;
    if(node.type==='footnoteReference'){
      if(node.obsidianOffset!=null){if(!inline.has(node.obsidianOffset))inline.set(node.obsidianOffset,++number);}
      else{const id=String(node.identifier).toUpperCase();if(!named.has(id))named.set(id,++number);}
    }
    if(node.title&&Array.isArray(node.title))node.title.forEach(visit);
    if(node.children)node.children.forEach(visit);
  };
  visit(tree);return{named,inline};
}

/** Render an isolated cell or a region, retaining full-document definitions. */
export function render(source, options={}) {
  source=String(source??'');
  options={...defaults,...options};
  const documentSource=String(options.documentSource??source);
  let tree=parse(source);
  const renderId=token(),formulas=new Map(),footerNumbers=new Map();
  const sourceOffset=Number.isInteger(options.sourceOffset)?options.sourceOffset:Math.max(0,documentSource.indexOf(source));
  let numbering;
  if(documentSource!==source){
    if(documentDefinitions.source!==documentSource){
      const fullTree=parse(documentSource),items=fullTree.children.filter(node=>['definition','footnoteDefinition'].includes(node.type)).map(node=>({type:node.type,identifier:node.identifier,source:documentSource.slice(node.position.start.offset,node.position.end.offset)}));
      prepare(fullTree,documentSource,'',false);
      documentDefinitions={source:documentSource,items,numbering:footnoteNumbers(fullTree)};
    }
    numbering=documentDefinitions.numbering;
    const definitions=documentDefinitions.items;
    const known=new Set(tree.children.filter(node=>['definition','footnoteDefinition'].includes(node.type)).map(node=>`${node.type}:${node.identifier}`));
    const additional=definitions.filter(node=>!known.has(`${node.type}:${node.identifier}`));
    // References are recognized by micromark during parsing, so definitions
    // must be present then, rather than merely appended to a finished AST.
    if(additional.length)tree=parse(source+'\n\n'+additional.map(node=>node.source).join('\n\n'));
    const extra={type:'root',children:tree.children.filter(node=>node.position?.start.offset>=source.length)};
    tree.children=tree.children.filter(node=>node.position?.start.offset<source.length);
    prepare(tree,source,renderId);
    prepare(extra,'',renderId);
    tree.children.push(...extra.children);
  }else {prepare(tree,source,renderId);numbering=footnoteNumbers(tree);}
  const handlers={
    html(_state,node){return {type:'raw',value:purify(node.value,true)};},
    text(_state,node){
      const value=restoreEscapes(node.value),lines=value.split(/\r\n|\r|\n/);
      return lines.length===1?text(value):lines.flatMap((line,index)=>index?[element('br'),text('\n'),text(line)]:[text(line)]);
    },
    code(_state,node){
      // Character references in a fence's info string are decoded by Markdown.
      // Retain only the language token, so an encoded space cannot add classes.
      const language=String(node.lang||'').trim().split(/\s+/,1)[0].toLowerCase(), aliases={js:'javascript',ts:'typescript',py:'python',sh:'bash',shell:'bash',html:'markup',xml:'markup',md:'markdown',yml:'yaml'};
      if(language==='mermaid')return element('div',{className:['mermaid-block']},[element('pre',{className:['mermaid-source']},[text(node.value)])]);
      const grammar=Prism.languages[aliases[language]||language];
      const highlighted=grammar?Prism.highlight(node.value,grammar,aliases[language]||language):escapeHTML(node.value);
      const id=retain(copies,token(),node.value);
      return element('div',{...node.data?.hProperties,className:['el-pre']},[
        element('button',{type:'button',className:['copy-code-button'],'data-copy-token':id,ariaLabel:'复制代码'},[text('复制')]),
        element('pre',{className:language?[`language-${language}`]:[]},[element('code',{className:language?[`language-${language}`]:[]},[{type:'raw',value:highlighted+'\n'}])]),
      ]);
    },
    inlineMath(_state,node){const id=token();formulas.set(id,{tex:node.value,display:false,sourceMap:formulaSourceMap(source,node)});return element('span',{className:['math','math-inline'],'data-math-token':id});},
    math(_state,node){const id=token();formulas.set(id,{tex:node.value,display:true,sourceMap:formulaSourceMap(source,node)});return element('div',{className:['math','math-block'],'data-math-token':id});},
    obsidianHighlight(state,node){
      const first=node.children[0],colorMap={'🔴':'red','🟥':'red','🟠':'orange','🟧':'orange','🟡':'yellow','🟨':'yellow','🟢':'green','🟩':'green','🔵':'blue','🟦':'blue','🟣':'purple','🟪':'purple'};
      const prefix=first?.type==='text'&&Array.from(first.value)[0],color=colorMap[prefix];
      const children=color?[{...first,value:first.value.slice(prefix.length).replace(/^\uFE0F/,'')},...node.children.slice(1)]:node.children;
      return element('mark',color?{'data-highlight':color,'data-color':color}:{},state.all({children}));
    },
    obsidianTag(_state,node){return element('a',{className:['tag'],href:'#'+encodeURIComponent(node.value.slice(1)),'data-href':node.value},[text(node.value)]);},
    obsidianLink(_state,node){return element('a',{className:['internal-link'],href:fileURL(node.href,false,options)||'#','data-href':node.href},[text(node.alias)]);},
    obsidianEmbed(_state,node){
      const dimensions=node.alias.match(/^(\d+)(?:x(\d+))?$/),target=node.href.split('#')[0];
      const isImage=/\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(target);
      const resolved=fileURL(node.href,true,options);
      if(isImage&&resolved){
        const properties={src:resolved,alt:dimensions?target:node.alias,loading:'lazy',referrerPolicy:'no-referrer'};
        if(dimensions){properties.width=Math.min(10000,Number(dimensions[1]));if(dimensions[2])properties.height=Math.min(10000,Number(dimensions[2]));}
        return element('span',{className:['internal-embed','image-embed','is-loaded'],'data-href':node.href},[element('img',properties)]);
      }
      return element('span',{className:['internal-embed','markdown-embed'],'data-href':node.href},[element('a',{className:['internal-link','embed-link'],href:resolved||'#','data-href':node.href},[text(dimensions?node.href:node.alias)])]);
    },
    obsidianCallout(state,node){
      const collapsed=node.fold==='-',foldable=!!node.fold;
      const titleProperties={className:['callout-title']};
      if(foldable)Object.assign(titleProperties,{role:'button',tabIndex:0,ariaExpanded:String(!collapsed),'data-callout-generated':'true'});
      return element('div',{...node.data?.hProperties,className:['callout',...(foldable?['is-collapsible']:[]),...(collapsed?['is-collapsed']:[])], 'data-callout':node.calloutType,'data-callout-fold':node.fold,'data-callout-metadata':node.metadata},[
        element('div',titleProperties,[element('div',{className:['callout-icon']},[calloutIcon(node.calloutType)]),element('div',{className:['callout-title-inner']},state.all({children:node.title})),...(foldable?[element('div',{className:['callout-fold'],ariaHidden:'true'},[text('›')])]:[])]),
        element('div',{className:['callout-content'],...(collapsed?{hidden:true}:{})},state.all(node)),
      ]);
    },
    image(_state,node){
      const url=/^(?:https?:|data:)/i.test(node.url)?safeURL(node.url,true):(fileURL(node.url,true,options)||(options.resolveFile?'':safeURL(node.url,true)));
      const dimensions=(node.alt||'').match(/\|(\d+)(?:x(\d+))?$/);
      return element('img',{src:url,...(url&&!/^(?:https?:|data:)/i.test(node.url)?{'data-href':node.url}:{}),alt:dimensions?node.alt.slice(0,dimensions.index):node.alt||'',...(node.title?{title:node.title}:{}),...(dimensions?{width:Math.min(10000,Number(dimensions[1])),...(dimensions[2]?{height:Math.min(10000,Number(dimensions[2]))}:{})}:{}),loading:'lazy',referrerPolicy:'no-referrer'});
    },
    link(state,node){
      const url=safeURL(node.url);
      const external=/^(?:https?:|mailto:|tel:)/i.test(url);
      return element('a',{href:url||'#',className:[external?'external-link':'internal-link'],...(external?{target:'_blank',rel:'noopener noreferrer'}:{'data-href':node.url}),...(node.title?{title:node.title}:{})},state.all(node));
    },
    linkReference(state,node){const definition=state.definitionById.get(String(node.identifier).toUpperCase());return definition?handlers.link(state,{...node,...definition,type:'link'}):text(plain(node));},
    imageReference(state,node){const definition=state.definitionById.get(String(node.identifier).toUpperCase());return definition?handlers.image(state,{...node,...definition,type:'image'}):text(node.alt||'');},
    footnoteReference(state,node){
      const result=defaultHandlers.footnoteReference(state,node),link=result.children[0];
      const number=node.obsidianOffset!=null?numbering.inline.get(sourceOffset+node.obsidianOffset):numbering.named.get(String(node.identifier).toUpperCase());
      if(number){link.children=[text(number)];footerNumbers.set(link.properties.href.slice(1),number);}
      return result;
    },
  };
  const processor=unified().use(remarkRehype,{allowDangerousHtml:true,handlers,clobberPrefix:renderId+'-',footnoteLabel:'脚注',footnoteBackLabel:'返回正文'}).use(rehypeStringify,{allowDangerousHtml:true});
  const hast=processor.runSync(tree);
  walk(hast,node=>{
    if(node.type==='element'&&node.properties){
      if(node.properties.id==='footnote-label')node.properties.id=renderId+'-footnote-label';
      if(node.properties.ariaDescribedBy)node.properties.ariaDescribedBy=node.properties.ariaDescribedBy.map(id=>id==='footnote-label'?renderId+'-footnote-label':id);
      if(node.tagName==='li'&&footerNumbers.has(node.properties.id))node.properties.value=footerNumbers.get(node.properties.id);
    }
    if(node.type==='element'&&node.tagName==='li'&&node.properties?.['data-task-token']){
      const id=node.properties['data-task-token'];
      walk(node,child=>{if(child.type==='element'&&child.tagName==='input'&&child.properties?.type==='checkbox'&&!child.properties['data-task-token']){
        child.properties.disabled=false;child.properties.className=['task-list-item-checkbox'];child.properties['data-task-token']=id;child.properties.ariaLabel='切换任务完成状态';
      }});
    }
  });
  let html=purify(processor.stringify(hast));
  // MathJax's separately configured safe renderer is the sole producer of these
  // replacement fragments. User HTML is already sanitized at this point.
  for(const [id,formula]of formulas){
    let rendered;
    try{rendered=globalThis.ObsidianMath?.render(formula.tex,formula.display,{sourceMap:!!formula.sourceMap});}catch{/* Show source on unsupported TeX. */}
    if(rendered&&formula.sourceMap)rendered=rendered.replace(/data-tex-from="(\d+)" data-tex-to="(\d+)"/g,(_all,from,to)=>{
      const a=formula.sourceMap.starts[Number(from)],b=formula.sourceMap.ends[Number(to)-1];
      return a!==undefined&&b!==undefined?`data-math-from="${a}" data-math-to="${b}"`:'';
    });
    if(!rendered)rendered=`<code class="math-error">${escapeHTML(formula.tex)}</code>`;
    const pattern=new RegExp(`(<(?:span|div)[^>]*data-math-token="${id}"[^>]*>)(</(?:span|div)>)`);
    html=html.replace(pattern,(_match,start,end)=>start+rendered+end);
  }
  return html;
}

/** Bind reading interactions; source changes are minimal transactions. */
export function bindPreview(root,{read,commit,enabled=()=>true,measure=()=>{},sourcePath=''}={}) {
  const allowed=()=>typeof enabled==='function'?enabled():!!enabled;
  const notify=()=>{try{measure();}catch{/* Detached widgets need no measuring. */}};
  const click=async event=>{
    const target=event.target?.closest?.('input[type="checkbox"][data-task-token],.callout-title[data-callout-generated],button[data-copy-token],a.internal-link,a.tag');
    if(!target||!root.contains(target))return;
    if(target.matches('input')){
      event.stopPropagation();
      const task=tasks.get(target.dataset.taskToken),source=String(read?.()??'');
      if(!allowed()||!task||source!==task.source||source[task.offset]!==task.marker){event.preventDefault();target.checked=task?task.marker!==' ':!target.checked;return;}
      try{
        const result=commit?.({from:task.offset,to:task.offset+1,insert:target.checked?'x':' '});
        if(result?.then)await result;
        const next=source.slice(0,task.offset)+(target.checked?'x':' ')+source.slice(task.offset+1);
        if(String(read?.()??'')===next){
          for(const related of tasks.values())if(related.renderId===task.renderId&&related.source===source){related.source=next;if(related.offset===task.offset)related.marker=next[task.offset];}
        }
        target.closest('li')?.classList.toggle('is-checked',target.checked);
        target.closest('li')?.setAttribute('data-task',target.checked?'x':' ');
        notify();
      }catch{target.checked=task.marker!==' ';}
      return;
    }
    if(target.classList.contains('callout-title')){
      event.preventDefault();event.stopPropagation();
      const callout=target.closest('.callout'),collapsed=callout.classList.toggle('is-collapsed');
      target.setAttribute('aria-expanded',String(!collapsed));
      for(const child of callout.children)if(child.classList.contains('callout-content'))child.hidden=collapsed;
      notify();return;
    }
    if(target.matches('button[data-copy-token]')){
      event.preventDefault();event.stopPropagation();
      const value=copies.get(target.dataset.copyToken);if(value==null)return;
      try{await navigator.clipboard.writeText(value);target.textContent='已复制';setTimeout(()=>{if(target.isConnected)target.textContent='复制';},1400);}catch{target.textContent='复制失败';}
      return;
    }
    const href=target.dataset.href;if(!href)return;
    event.preventDefault();event.stopPropagation();
    if(href.startsWith('#')&&!target.classList.contains('tag')){
      let id;try{id=decodeURIComponent(href.slice(1)).replace(/^\^/,'');}catch{return;}
      const destination=[...root.querySelectorAll('[id]')].find(node=>node.id===id||node.textContent?.trim()===id);
      if(destination){destination.scrollIntoView({block:'nearest'});return;}
    }
    root.dispatchEvent(new CustomEvent('obsidian-open-link',{bubbles:true,detail:{href,sourcePath:typeof sourcePath==='function'?sourcePath():sourcePath,tag:target.classList.contains('tag'),newTab:event.metaKey||event.ctrlKey}}));
  };
  const key=event=>{if((event.key==='Enter'||event.key===' ')&&event.target?.matches?.('.callout-title[data-callout-generated]')){event.preventDefault();event.target.click();}};
  root.addEventListener('click',click);root.addEventListener('keydown',key);
  try{globalThis.ObsidianDiagrams?.hydrate(root);}catch{/* Keep source visible if diagrams are unavailable. */}
  return()=>{root.removeEventListener('click',click);root.removeEventListener('keydown',key);};
}
