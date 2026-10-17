const testPaths = require('./paths.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const calls=[],notices=[];const state={path:'note.json',revision:'r1'};
 const context=vm.createContext({console,state,save:async()=>{},persistAI:()=>{},refreshAI:()=>{},toast:message=>notices.push(message),api:async(route,body)=>new Promise(resolve=>calls.push({route,body,resolve}))});
 vm.runInContext(fs.readFileSync(testPaths.STATIC_ROOT+'/ai-selection.js','utf8'),context);
 const session={path:state.path,selectedCells:['one'],fileContexts:{}};context.session=session;
 const ref=(cells,id)=>({kind:'selection-ref',targetKind:'note-cells',path:'note.json',cells,id:id.repeat(64),sourceRevision:'r1',text:'original',characters:8,truncated:false,stale:false});
 return {context,state,session,calls,notices,ref,run:source=>vm.runInContext(source,context)};
}
test('out-of-order selection registrations cannot overwrite the latest selection',async()=>{
 const f=fixture();const first=f.run('snapshotAISelectedCells(session)');await new Promise(setImmediate);f.session.selectedCells=['two'];const second=f.run('snapshotAISelectedCells(session)');await new Promise(setImmediate);assert.equal(f.calls.length,2);
 f.calls[1].resolve({sources:[f.ref(['two'],'b')]});await second;f.calls[0].resolve({sources:[f.ref(['one'],'a')]});await first;
 assert.equal(f.session.selectionReference.id,'b'.repeat(64));assert.equal(f.session.selectionUploads,0);assert.equal(f.notices.length,0);
});
test('sending after edits reuses the frozen selection instead of recapturing it',async()=>{
 const f=fixture();const pending=f.run('snapshotAISelectedCells(session)');await new Promise(setImmediate);f.calls[0].resolve({sources:[f.ref(['one'],'a')]});await pending;
 f.state.revision='r2';f.context.sources=[];f.context.selected=[];await f.run("prepareAISelectionReferences(session,{scope:'cells',cells:['one']},sources,selected)");
 assert.equal(f.calls.length,1);assert.equal(f.context.sources[0].id,'a'.repeat(64));assert.equal(f.context.sources[0].sourceRevision,'r1');
});
test('a registration finishing after a tab switch belongs to its original file',async()=>{
 const f=fixture();const pending=f.run('snapshotAISelectedCells(session)');await new Promise(setImmediate);f.session.fileContexts['note.json']={selectedCells:['one']};f.session.path='other.json';f.session.selectedCells=[];
 f.calls[0].resolve({sources:[f.ref(['one'],'a')]});await pending;assert.equal(f.session.fileContexts['note.json'].selectionReference.id,'a'.repeat(64));assert.equal(f.session.selectionReference,null);
});
