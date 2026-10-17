const testPaths = require('./paths.cjs');
'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function harness(mode='edit') {
 const nodes=new Map();let active;
 class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.hidden=false;this.style={};this.className='';this.classList={add:(...a)=>{this.className=[...new Set([...this.className.split(' ').filter(Boolean),...a])].join(' ');},toggle:(n,on)=>{const set=new Set(this.className.split(' ').filter(Boolean));if(on)set.add(n);else set.delete(n);this.className=[...set].join(' ');}};}
  set id(value){this._id=value;nodes.set(value,this);}get id(){return this._id;}
  append(...items){items.forEach(i=>{i.parentElement=this;this.children.push(i);});}
  insertBefore(item,before){item.parentElement=this;this.children.splice(this.children.indexOf(before),0,item);}
  setAttribute(k,v){this.attributes[k]=v;}getAttribute(k){return this.attributes[k];}
  addEventListener(){}
  matches(s){return s.startsWith('.')?this.className.split(' ').includes(s.slice(1)):this.tagName===s;}
  querySelectorAll(s){return this.children.flatMap(c=>[...(c.matches(s)?[c]:[]),...c.querySelectorAll(s)]);}
  querySelector(s){return this.querySelectorAll(s)[0]||null;}
  focus(){active=this;}scrollIntoView(){}
 }
 const effects={created:0,dirty:[],runs:0,htmlRenders:0};
 const state={mode,busy:false,selectedCell:null,markdownEditing:new Set(),outputs:new Map()};
 const document={createElement:t=>new Element(t),addEventListener(){},querySelectorAll(){return [];},getElementById:id=>nodes.get(id),get activeElement(){return active;}};
 const context={document,state,structuredClone,closeCellAddMenus(){},uiIcon:n=>n,cellNumber:()=>1,selectCell(){},cellLayoutControls:()=>new Element('div'),bindCellPointerDrag(){},renderCellAI(){},renderSidebar(){},resizePlots(){},applyVisibility(){},updateOutput(){},updateHtmlOutput(){effects.htmlRenders++;},save:()=>Promise.resolve(),toast(){},dirty:(runtime=false)=>effects.dirty.push(runtime),execute:()=>effects.runs++,openCellAI(){},button:()=>new Element('button'),slide:()=>({cells:[1,2]}),$: (s,node)=>node?.querySelector(s),NotebookCodeEditor:{create:options=>{effects.created++;return {options,requestMeasure(){},focus(){options.parent.focus();},destroy(){}};}}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(testPaths.STATIC_ROOT+'/code-cell.js','utf8'),context);
 return {context,state,effects};
}
function cell(extra={}){return {id:'python',kind:'code',source:'x=1\nx',display:'normal',showCode:false,...extra};}

test('collapse and expand keep source, output nodes and controls intact without running Python',()=>{
 const h=harness();const c=cell();const card=h.context.renderNotebookCell(c,0);
 const output=h.state.outputs.get(c.id);const editor=card.querySelector('.code-editor-host');const toggle=card.querySelector('.cell-code-collapse');
 assert.equal(editor.hidden,false);assert.equal(h.effects.created,1);
 toggle.onclick();
 assert.equal(c.codeCollapsed,true);assert.equal(editor.hidden,true);assert.equal(toggle.getAttribute('aria-label'),'展开代码');
 assert.equal(h.state.outputs.get(c.id),output);assert.ok(card.children.includes(output));assert.equal(c.source,'x=1\nx');
 assert.deepEqual(h.effects.dirty,[false]);assert.equal(h.effects.runs,0);
 toggle.onclick();assert.equal(c.codeCollapsed,false);assert.equal(editor.hidden,false);assert.equal(h.effects.created,1);
 assert.equal(toggle.getAttribute('aria-expanded'),'true');assert.equal(c.showCode,false);
});

test('stored collapse state restores with lazy editor; C/focus path expands it',()=>{
 const h=harness();const c=JSON.parse(JSON.stringify(cell({codeCollapsed:true})));
 const card=h.context.renderNotebookCell(c,0);
 assert.equal(card.querySelector('.code-editor-host').hidden,true);assert.equal(h.effects.created,0);
 h.context.focusCellEditor(c);
 assert.equal(c.codeCollapsed,false);assert.equal(card.querySelector('.code-editor-host').hidden,false);assert.equal(h.effects.created,1);
 assert.equal(h.effects.runs,0);
});

test('presentation follows showCode independently of editing collapse preference',()=>{
 for(const collapsed of [false,true])for(const showCode of [false,true]){
  const h=harness('present');const c=cell({codeCollapsed:collapsed,showCode});const card=h.context.renderNotebookCell(c,0);
  assert.equal(card.querySelector('.code-editor-host').hidden,!showCode);
  assert.equal(c.codeCollapsed,collapsed);assert.equal(h.effects.created,showCode?1:0);
  card.querySelector('.cell-code-collapse').onclick();assert.equal(c.codeCollapsed,collapsed);assert.deepEqual(h.effects.dirty,[]);
 }
});


test('HTML has a local preview and HTML editor; running and editing never execute Python',()=>{
 const h=harness();const c=cell({kind:'html',source:'<button>Click</button>'});
 const card=h.context.renderNotebookCell(c,0);
 assert.equal(card.codeEditor.options.language,'html');assert.equal(h.effects.htmlRenders,1);
 assert.equal(card.querySelector('.cell-stop'),null);assert.equal(card.querySelector('.cell-timing'),null);
 card.querySelector('.html-cell-run').onclick();assert.equal(h.effects.htmlRenders,2);assert.equal(h.effects.runs,0);
 card.codeEditor.options.onRun();assert.equal(h.effects.htmlRenders,3);assert.equal(h.effects.runs,0);
 card.codeEditor.options.onChange('<h2>New</h2>');assert.equal(c.source,'<h2>New</h2>');
 assert.equal(h.effects.dirty.at(-1),false);
});


test('cell menu offers copy without modifying the source or running Python',()=>{
 const h=harness();const c=cell({kind:'html',source:'<h2>Hello</h2>'});const card=h.context.renderNotebookCell(c,0);
 const action=card.querySelector('.cell-copy');assert.ok(action);assert.equal(action.getAttribute('aria-label'),'复制 cell');
 action.onclick();assert.equal(h.context.hasCopiedCell(),true);assert.equal(c.source,'<h2>Hello</h2>');
 assert.equal(h.effects.runs,0);assert.deepEqual(h.effects.dirty,[]);
});
