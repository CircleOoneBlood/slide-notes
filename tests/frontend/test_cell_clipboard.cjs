const testPaths = require('./paths.cjs');
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
let page={cells:[]},id=0,renders=0;const dirty=[];
const ctx={structuredClone,document:{addEventListener(){},querySelectorAll:()=>[],getElementById:()=>({scrollIntoView(){}})},state:{mode:'edit',selectedCell:null},slide:()=>page,uid:()=>`copy${++id}`,closeCellAddMenus(){},toast(){},dirty:value=>dirty.push(value),render:()=>{renders++;}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(testPaths.STATIC_ROOT+'/code-cell.js','utf8'),ctx);
assert.equal(ctx.hasCopiedCell(),false);
for(const kind of ['code','markdown','html']){
 const original={id:'original',kind,source:kind==='html'?'<script>const a=1;</script>':'x = 1',display:'fragment',showCode:true,codeCollapsed:true,layout:{row:'oldrow',column:'oldcolumn',x:64,width:36,y:100,gapBefore:90}};
 const sourcePage={cells:[original]};page=sourcePage;ctx.copyNotebookCell(original);
 // Copy is a snapshot; later source edits and page navigation cannot alter it.
 const saved=original.source;original.source='changed after copy';
 page={cells:[{id:'target',kind:'markdown',source:'Keep me'}]};
 const pasted=ctx.pasteNotebookCell(1);
 assert.equal(page.cells[1],pasted);assert.equal(page.cells[0].source,'Keep me');
 assert.equal(pasted.source,saved);assert.equal(pasted.kind,kind);assert.equal(pasted.display,'fragment');
 assert.equal(pasted.showCode,true);assert.equal(pasted.codeCollapsed,true);assert.notEqual(pasted.id,original.id);assert.equal(pasted.layout,undefined);
 assert.equal(sourcePage.cells.length,1);assert.equal(sourcePage.cells[0].source,'changed after copy');
 assert.equal(ctx.state.selectedCell,pasted.id);assert.equal(dirty.at(-1),kind==='code');
 const second=ctx.pasteNotebookCell(2);assert.notEqual(second.id,pasted.id);
 pasted.source='edit first paste';assert.equal(second.source,saved);
}
ctx.state.mode='present';const before=page.cells.length;assert.equal(ctx.pasteNotebookCell(0),undefined);assert.equal(page.cells.length,before);
assert.equal(renders,6);
console.log('Cell clipboard: cross-page copy/paste for Python, Markdown and HTML; immutable copy, fresh IDs, settings, repeated paste, layout isolation and presentation guard passed.');
