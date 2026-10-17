const testPaths = require('./paths.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const code=fs.readFileSync(path.join(testPaths.STATIC_ROOT,'history.js'),'utf8');

function fixture(){
  const state={path:'temporary.json',active:0,selectedCell:'a',controls:new Map(),doc:{title:'Temporary history',slides:[{id:'s1',cells:[{id:'a',kind:'markdown',source:'A'},{id:'b',kind:'code',source:'B'}]},{id:'s2',cells:[{id:'c',kind:'markdown',source:'C'}]}]}};
  let time=1000;const calls={clone:0,stringify:0};let context;
  context=vm.createContext({state,Date:{now:()=>time},structuredClone:value=>{calls.clone++;return structuredClone(value);},JSON:{stringify:value=>{calls.stringify++;return JSON.stringify(value);}},window:{addEventListener(){}},cancelCellResize:null,closeSlideContext(){},closeCellMenus(){},closeCellAddMenus(){},dirty:()=>vm.runInContext('recordDocumentChange()',context),render(){}});
  const run=command=>vm.runInContext(command,context);run(code);run('ensureNotebookHistory()');
  const history=()=>run('ensureNotebookHistory()');
  const cell=id=>state.doc.slides.flatMap(slide=>slide.cells).find(cell=>cell.id===id);
  const type=(id,source)=>{cell(id).source=source;context.testGroup='source:'+id;run('recordDocumentChange(testGroup)');};
  return {state,calls,run,history,cell,type,advance:amount=>time+=amount,undo:()=>run('applyDocumentHistory()'),redo:()=>run('applyDocumentHistory(true)')};
}

test('continuous source edits share an undo group and keep detached snapshots',()=>{
  const f=fixture();f.type('a','AB');const before=f.history().past[0];f.type('a','ABC');f.type('a','ABCD');
  assert.equal(f.history().past.length,1);assert.equal(before.doc.slides[0].cells[0].source,'A');
  assert.equal(f.history().baseline.doc.slides[0].cells[0].source,'ABCD');
  f.undo();assert.equal(f.cell('a').source,'A');f.redo();assert.equal(f.cell('a').source,'ABCD');
});

test('source fast path avoids whole-document clone and serialization per key',()=>{
  const f=fixture();f.type('a','AB');const before={...f.calls};
  for(let i=0;i<100;i++)f.type('a','AB'+i);
  assert.deepEqual(f.calls,before);assert.equal(f.history().past.length,1);
  assert.equal(f.history().baseline.doc.slides[0].cells[0].source,'AB99');
});

test('pause and switching source cell preserve existing undo boundaries',()=>{
  const f=fixture();f.type('a','AA');f.advance(901);f.type('a','AAA');f.type('b','BB');f.type('a','AAAA');
  assert.equal(f.history().past.length,4);
  f.undo();assert.equal(f.cell('a').source,'AAA');assert.equal(f.cell('b').source,'BB');
  f.undo();assert.equal(f.cell('b').source,'B');f.undo();assert.equal(f.cell('a').source,'AA');f.undo();assert.equal(f.cell('a').source,'A');
});

test('source snapshots follow active page and selected cell without sharing past',()=>{
  const f=fixture();f.type('a','AA');f.state.active=1;f.state.selectedCell='c';f.type('a','AAA');
  assert.equal(f.history().baseline.active,1);assert.equal(f.history().baseline.selected,'c');
  assert.equal(f.history().past[0].active,0);assert.equal(f.history().past[0].selected,'a');
  f.undo();assert.equal(f.state.active,0);f.redo();assert.equal(f.state.active,1);assert.equal(f.state.selectedCell,'c');
});

test('non-source mutations still take full snapshots and separate groups',()=>{
  const f=fixture();f.type('a','AA');f.state.doc.title='Renamed';f.run('recordDocumentChange()');
  f.cell('a').layout={height:120};f.run("recordDocumentChange('layout')");f.type('a','AAA');f.type('a','AAAA');
  assert.equal(f.history().past.length,4);f.undo();assert.equal(f.cell('a').source,'AA');assert.equal(f.cell('a').layout.height,120);
  f.undo();assert.equal(f.cell('a').layout,undefined);assert.equal(f.state.doc.title,'Renamed');f.undo();assert.equal(f.state.doc.title,'Temporary history');
});

test('replaced documents and reordered cells cannot reuse cached source references',()=>{
  const f=fixture();f.type('a','AA');f.state.doc=structuredClone(f.state.doc);f.state.doc.title='Replacement';f.type('a','AAA');
  assert.equal(f.history().baseline.doc.title,'Replacement');
  f.state.doc.slides[0].cells.reverse();f.type('a','AAAA');
  assert.equal(f.history().baseline.doc.slides[0].cells[0].id,'b');assert.equal(f.history().baseline.doc.slides[0].cells[1].source,'AAAA');
  f.undo();assert.equal(f.state.doc.title,'Temporary history');assert.equal(f.state.doc.slides[0].cells[0].id,'a');
});

test('unchanged input keeps redo history, and a real edit after undo clears it',()=>{
  const f=fixture();f.type('a','AA');f.undo();assert.equal(f.history().future.length,1);
  f.type('a','A');assert.equal(f.history().future.length,1);f.type('b','BB');assert.equal(f.history().future.length,0);f.redo();assert.equal(f.cell('b').source,'BB');
});

test('ungrouped changes remain capped at fifty undo entries',()=>{
  const f=fixture();for(let i=0;i<60;i++){f.state.doc.title='Title '+i;f.run('recordDocumentChange()');}
  assert.equal(f.history().past.length,50);for(let i=0;i<50;i++)f.undo();assert.equal(f.state.doc.title,'Title 9');
});

test('notebook histories remain independent across paths',()=>{
  const f=fixture();f.type('a','AA');const first=f.state.doc;
  f.state.path='second.json';f.state.doc=structuredClone(first);f.run('ensureNotebookHistory()');f.type('a','Second');f.undo();assert.equal(f.cell('a').source,'AA');
  f.state.path='temporary.json';f.state.doc=first;f.undo();assert.equal(f.cell('a').source,'A');
});
