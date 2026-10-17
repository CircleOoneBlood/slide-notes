const testPaths = require('./paths.cjs');
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process'),{test}=require('node:test');
const root=testPaths.APP_ROOT;
test('local CC/API settings switch in real Chrome',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'slide-notes-cc-settings-'));
 try{
  const source=fs.readFileSync(root+'/static/ai.js','utf8');
  const settings=source.slice(source.indexOf('async function showAISettings(){'),source.indexOf('function remapAIChats('));
  const fixture=`
  const $=(q,root=document)=>root.querySelector(q),managedWorkbench=false;
  const aiState={config:{provider:'api',baseUrl:'https://example.com/v1',model:'',hasKey:true,claudePath:'',claudeModel:'',claudeAvailable:true,claudeDetectedPath:'/home/test/.local/bin/claude'},sessions:new Map()};
  const loadAIConfig=async()=>aiState.config,refreshAI=()=>{},toast=message=>{throw Error(message)};
  const aiDialog=title=>{const dialog=document.createElement('dialog');document.body.append(dialog);return dialog;};
  const saved=[],requests=[];
  const api=async(route,body)=>{saved.push(body);return {...aiState.config,...body};};
  const aiStream=async(route,body)=>requests.push({route,body});
  `;
  const tests=`
  (async()=>{const checks=[];function check(name,ok){checks.push({name,ok:!!ok});}
   await showAISettings();const dialog=$('dialog'),form=$('form',dialog);
   check('API mode initially requires a model',form.elements.model.required&&!$('[data-api-settings]').hidden);
   form.elements.provider.value='claude-code';form.elements.provider.onchange();
   check('local mode accepts blank model and hides API credentials',form.reportValidity()&&!form.elements.model.required&&form.elements.model.disabled&&$('[data-api-settings]').hidden&&!$('[data-claude-settings]').hidden);
   check('local detection is visible',$('[data-claude-status]').textContent.includes('/home/test/.local/bin/claude'));
   await form.onsubmit({preventDefault(){}});
   check('saving local preserves API config without sending a key',saved.at(-1).provider==='claude-code'&&saved.at(-1).baseUrl==='https://example.com/v1'&&!Object.hasOwn(saved.at(-1),'apiKey'));
   await $('[data-test]').onclick();
   check('test sends no notes',requests.length===1&&requests[0].route==='/api/ai/test'&&Object.keys(requests[0].body).join(',')==='requestId');
   check('success names the local provider',$('.ai-setting-status').textContent.includes('本地 Claude Code'));
   form.elements.provider.value='api';form.elements.provider.onchange();
   check('switching back restores required API model',!form.reportValidity()&&form.elements.model.required&&!form.elements.model.disabled&&!$('[data-api-settings]').hidden);
   form.elements.model.value='glm-test';check('API form is valid again',form.reportValidity());
   $('#result').textContent=JSON.stringify(checks);
  })().catch(error=>$('#result').textContent=JSON.stringify([{name:error.stack,ok:false}]));`;
  const page=path.join(temp,'settings.html');fs.writeFileSync(page,'<!doctype html><meta charset="utf-8"><pre id="result"></pre><script>'+fixture+'</script><script>'+settings+'</script><script>'+tests+'</script>');
  const result=spawnSync(process.env.CHROME_BIN||'google-chrome',['--headless','--no-sandbox','--disable-gpu','--no-first-run','--user-data-dir='+path.join(temp,'profile'),'--virtual-time-budget=2000','--dump-dom','file://'+page],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stderr);const match=result.stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/);assert.ok(match);
  const rows=JSON.parse(match[1].replaceAll('&quot;','"').replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&'));
  assert.deepEqual(rows.filter(row=>!row.ok),[]);assert.equal(rows.length,8);console.log('Verified 8 CC/API settings scenarios.');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
