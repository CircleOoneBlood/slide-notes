const testPaths = require('./paths.cjs');
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const handlers={};const controls=new Map();let flushed=0,captured=null;
const rect={left:100,right:500,top:20,bottom:300,width:400};
const widget={key:'mo:point',name:'point',type:'slider',minimum:-2,maximum:2,step:.01};
const input={dataset:{key:widget.key},parentElement:{querySelector:()=>({textContent:''})}};
const plot={style:{},_fullLayout:{xaxis:{type:'linear',range:[-2,2]}},
 querySelector:()=>({getBoundingClientRect:()=>rect}),addEventListener:(type,fn)=>{handlers[type]=fn;},
 setPointerCapture:id=>{captured=id;},hasPointerCapture:id=>captured===id,releasePointerCapture:()=>{captured=null;}};
const ctx={state:{controls,runtime:{outputs:{params:{result:{widgets:[widget]}}}}},document:{querySelectorAll:()=>[input]},flushControls:()=>{flushed++;}};
vm.createContext(ctx);
const source=fs.readFileSync(testPaths.STATIC_ROOT+'/app.js','utf8');
vm.runInContext(source.slice(source.indexOf('function bindPlotDragX('),source.indexOf('function updateOutput(')),ctx);
ctx.bindPlotDragX(plot,{widget:'point'});
function event(x,y=80,id=1){return {clientX:x,clientY:y,pointerId:id,button:0,preventDefault(){},stopImmediatePropagation(){}};}
handlers.pointerdown(event(50));assert.equal(flushed,0);
handlers.pointerdown(event(300));assert.equal(controls.get(widget.key),0);assert.equal(captured,1);
handlers.pointermove(event(375));assert.equal(controls.get(widget.key),.75);assert.equal(input.value,.75);
handlers.pointermove(event(600));assert.equal(controls.get(widget.key),2);
handlers.pointermove(event(200,80,2));assert.equal(controls.get(widget.key),2);
handlers.pointerup({...event(250),type:'pointerup'});assert.equal(controls.get(widget.key),-.5);assert.equal(captured,null);
handlers.pointermove(event(450));assert.equal(controls.get(widget.key),-.5);
ctx.bindPlotDragX(plot,null);handlers.pointerdown(event(300));assert.equal(controls.get(widget.key),-.5);
console.log('Plot drag: bounds, live motion, control sync, coalescing, final position, pointer identity and opt-out passed.');
