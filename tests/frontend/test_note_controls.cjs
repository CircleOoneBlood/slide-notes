const testPaths = require('./paths.cjs');
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// Exercise actual control handlers without requiring a live notebook/browser.
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.dataset = {}; this.style = {setProperty:(k,v)=>{this.styles[k]=v;}}; this.styles={}; this.classList={toggle:(name,on)=>{const names=new Set((this.className||'').split(' ').filter(Boolean));if(on)names.add(name);else names.delete(name);this.className=[...names].join(' ');}};
  }
  append(...items) { for(const item of items) {item.parent=this;this.children.push(item);} }
  setAttribute(k,v) {this[k]=v;}
  matches(selector) {return selector.startsWith('.') ? (this.className||'').split(' ').includes(selector.slice(1)) : this.tagName===selector;}
  closest(selector) {return this.matches(selector)?this:this.parent?.closest(selector);}
  querySelector(selector) {for(const item of this.children) {if(item.matches(selector))return item;const found=item.querySelector(selector);if(found)return found;}return null;}
  querySelectorAll(selector) {const results=[];for(const item of this.children){if(item.matches(selector))results.push(item);results.push(...item.querySelectorAll(selector));}return results;}
  set value(v) {this._value=String(v);}
  get value() {return this._value;}
}
const state={controls:new Map()};let flushed=0;
const ctx={document:{createElement:tag=>new Element(tag)},state,refreshCodeActions(){},flushControls(){flushed++;}};
vm.createContext(ctx);
const source=fs.readFileSync(testPaths.STATIC_ROOT+'/app.js','utf8');
vm.runInContext(source.slice(source.indexOf('function syncNoteStepper('),source.indexOf('function updateOutput(')),ctx);
const spec={key:'rollout:k',label:'Forward rollout',minimum:0,maximum:8,step:1,value:0};
const control=ctx.createNoteControl(spec,true);
const input=control.querySelector('input');const next=control.querySelector('.stepper-next');const reset=control.querySelector('.stepper-reset');
assert.equal(control.querySelector('output').textContent,'k = 0 / 8');
assert.ok(reset.disabled);assert.ok(!next.disabled);
next.onclick();assert.equal(state.controls.get(spec.key),1);assert.equal(input.value,'1');
// Rapid clicks accumulate locally even before Python returns.
for(let i=0;i<7;i++)next.onclick();
assert.equal(state.controls.get(spec.key),8);assert.ok(next.disabled);assert.equal(next.textContent,'已完成');
assert.equal(input.styles['--step-progress'],'100%');
reset.onclick();assert.equal(state.controls.get(spec.key),0);assert.ok(!next.disabled);assert.ok(reset.disabled);
input.value=4;input.oninput();assert.equal(state.controls.get(spec.key),4);assert.equal(input.styles['--step-progress'],'50%');
const slider=ctx.createNoteControl({...spec,key:'ordinary:x',step:0.1},false);
slider.querySelector('input').value=1.2;slider.querySelector('input').oninput();
assert.equal(state.controls.get('ordinary:x'),1.2);assert.equal(slider.querySelector('output').textContent,'1.20');
assert.ok(flushed>0);
console.log('Notebook stepper: next, end, reset, seek, rapid clicks and ordinary slider passed.');

const ticks=control.querySelectorAll('.stepper-tick');
assert.equal(ticks.length,9);
assert.equal(ticks.map(t=>t.textContent).join(','),'0,1,2,3,4,5,6,7,8');
ticks[6].onclick();assert.equal(state.controls.get(spec.key),6);
assert.ok(ticks[6].matches('.stepper-current'));
assert.ok(ticks[5].matches('.stepper-reached'));
assert.ok(!ticks[7].matches('.stepper-reached'));
assert.equal(control.querySelector('span'),null);
assert.equal(control.querySelector('output').hidden,true);
console.log('Timeline nodes 0–8, seek and hidden description passed.');
