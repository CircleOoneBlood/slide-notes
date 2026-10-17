const testPaths = require('./paths.cjs');
'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
let listener;const frames=[];
const ctx={window:{addEventListener:(type,fn)=>{if(type==='message')listener=fn;}},document:{querySelectorAll:()=>frames,createElement:()=>({style:{},attrs:{},contentWindow:{},setAttribute(k,v){this.attrs[k]=v;}})},crypto:{randomUUID:()=>String(Math.random())},purgeResultPlots(){}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(testPaths.STATIC_ROOT+'/html-cell.js','utf8'),ctx);
const source='<!doctype html><html><head><title>Demo</title></head><body><button>test</button><script>window.counter=1;</script></body></html>';
const box={querySelector:()=>frames[0],replaceChildren:()=>{frames.length=0;},append:f=>frames.push(f)};
const frame=ctx.renderHtmlOutput(box,source,'Demo');
assert.equal(frame.attrs.sandbox,'allow-scripts');assert.equal(frame.attrs.referrerpolicy,'no-referrer');
assert.ok(!frame.attrs.sandbox.includes('allow-same-origin'));assert.ok(frame.srcdoc.includes('<script>window.counter=1;</script>'));
assert.ok(frame.srcdoc.indexOf('slide-notes-html-size')<frame.srcdoc.indexOf('<title>'));
const token=frame.htmlCellToken;ctx.renderHtmlOutput(box,source);assert.equal(frame.htmlCellToken,token);
ctx.renderHtmlOutput(box,source,'Demo',true);assert.notEqual(frame.htmlCellToken,token);
listener({source:{},data:{type:'slide-notes-html-size',token:frame.htmlCellToken,height:900}});assert.equal(frame.style.height,undefined);
listener({source:frame.contentWindow,data:{type:'slide-notes-html-size',token:'wrong',height:900}});assert.equal(frame.style.height,undefined);
listener({source:frame.contentWindow,data:{type:'slide-notes-html-size',token:frame.htmlCellToken,height:900}});assert.equal(frame.style.height,'900px');
listener({source:frame.contentWindow,data:{type:'slide-notes-html-size',token:frame.htmlCellToken,height:999999}});assert.equal(frame.style.height,'10000px');
const fragment=ctx.htmlCellDocument('<h2>Hi</h2>','x');assert.ok(fragment.startsWith('<!doctype html>'));assert.ok(fragment.includes('<body><h2>Hi</h2></body>'));
const script=/<script>([\s\S]*?)<\/script>/.exec(fragment)[1];new Function(script);
console.log('HTML cell: full documents/fragments, script preservation, sandbox, stable preview, force rerun, authenticated sizing and size limits passed.');

// Exercise the actual parent dispatcher and injected client bridge together.
const messages=[];
function makeClient(scope){
 const handlers={};let client;
 const parent={postMessage:data=>listener({source:client.window,data})};
 const window={addEventListener:(type,fn)=>{handlers[type]=fn;},postMessage:data=>handlers.message?.({source:parent,data})};
 client={window,parent,handlers};
 const frame={style:{},contentWindow:window,htmlCellToken:'token'+frames.length,htmlCellScope:scope};frames.push(frame);
 const context={window,parent,document:{readyState:'loading',addEventListener(){}},console,structuredClone};vm.createContext(context);
 vm.runInContext('('+ctx.htmlCellBridge.toString()+')('+JSON.stringify(frame.htmlCellToken)+')',context);
 return {api:window.noteHtml,frame};
}
frames.length=0;
const first=makeClient('notebookA:page1'),second=makeClient('notebookA:page1'),other=makeClient('notebookB:page1');
let left={},right={},isolated={};
first.api.subscribe('taylor',s=>{left=s;});second.api.subscribe('taylor',s=>{right=s;messages.push(s);});other.api.subscribe('taylor',s=>{isolated=s;});
first.api.init('taylor',{a:.6,N:2});assert.equal(left.a,.6);assert.equal(right.N,2);assert.equal(isolated.a,undefined);
second.api.setState('taylor',{a:1.25});assert.equal(left.a,1.25);assert.equal(right.a,1.25);assert.equal(right.N,2);
second.api.init('taylor',{a:0,N:0});assert.equal(right.a,1.25);assert.equal(right.N,2);
const third=makeClient('notebookA:page1');let late;third.api.subscribe('taylor',s=>{late=s;});assert.equal(late.a,1.25);
first.api.setState('taylor',{text:'x'.repeat(70000)});assert.equal(right.text,undefined);
first.api.setState('taylor',JSON.parse('{"__proto__":{"polluted":true}}'));assert.equal({}.polluted,undefined);
listener({source:first.frame.contentWindow,data:{type:'slide-notes-html-state',token:'wrong',topic:'taylor',op:'patch',value:{a:9}}});assert.equal(right.a,1.25);
let calls=0;const off=second.api.subscribe('other',()=>{calls++;});assert.equal(calls,1);off();first.api.setState('other',{test:true});assert.equal(calls,1);
console.log('HTML state: cross-cell sync, partial updates, late subscribers, defaults, notebook isolation, payload limits and forged sender rejection passed.');
