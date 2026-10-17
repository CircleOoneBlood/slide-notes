const testPaths = require('./paths.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process'),{test}=require('node:test');

// Real shipped Markdown/MathJax/sanitizer and conversation refresh, with no
// server, saved notebook, provider request, login or account state.
async function scenarios(){
 const results=[],host=document.querySelector('#host'),body=document.querySelector('#response');
 const assert=(value,message='assertion failed')=>{if(!value)throw Error(message);};
 const equal=(a,b)=>assert(a===b,JSON.stringify(a)+' != '+JSON.stringify(b));
 const draw=(content,status='streaming')=>NoteAIResponse.render(body,{content,status});
 async function check(name,fn){try{await fn();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.stack});}}
 await check('prose, headings and emphasis compile before completion',()=>{
  draw('# 推导\n\n这是 **重点**。');assert(body.querySelector('h1'));equal(body.querySelector('strong').textContent,'重点');equal(body.dataset.streaming,'true');
 });
 await check('closed inline and display math survive sanitization',()=>{
  draw('使用 $x_k$：\n\n$$\\delta u=-Q_{uu}^{-1}Q_u$$');equal(body.querySelectorAll('mjx-container').length,2);assert(body.querySelector('mjx-msubsup, mjx-msup'));assert(!body.querySelector('mjx-merror,.math-error'));
  const math=body.querySelector('.math-block mjx-container'),r=math.getBoundingClientRect();assert(r.width>20&&r.height>10,'math lost layout');equal(getComputedStyle(math.parentElement).textAlign,'center');
 });
 await check('TeX bracket and parenthesis delimiters render',()=>{
  draw('行内 \\(x^2\\)，以及\n\\[\\frac{a}{b}\\]');equal(body.querySelectorAll('mjx-container').length,2);assert(body.querySelector('mjx-mfrac'));
 });
 await check('incomplete formula is buffered then rendered when closed',()=>{
  draw('已完成。\n\n$$\\frac{a}{');assert(body.querySelector('.ai-math-pending'));assert(!body.querySelector('mjx-merror,.math-error,mjx-container'));assert(!body.textContent.includes('\\frac'));
  draw('已完成。\n\n$$\\frac{a}{b}$$');assert(body.querySelector('mjx-mfrac'));assert(!body.querySelector('.ai-math-pending'));
 });
 await check('token by token deltas never expose partial TeX errors',()=>{
  const source='说明 $x_k^2$。\n\n$$\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}$$';
  for(let end=1;end<=source.length;end++){draw(source.slice(0,end));assert(!body.querySelector('mjx-merror,.math-error'),'partial math at '+end);}
  equal(body.querySelectorAll('mjx-container').length,2);
 });
 await check('stopping preserves unfinished math as readable source',()=>{
  const content='说明 $$\\frac{a}{';draw(content,'cancelled');assert(body.textContent.includes('$$\\frac{a}{'));assert(!body.querySelector('mjx-merror'));equal(body.dataset.streaming,'false');
 });
 await check('code streams with highlighting and TeX remains literal',()=>{
  draw('```python\nvalue = "$x$"\n# \\[literal\\]');const code=body.querySelector('pre code');assert(code);assert(code.querySelector('.token'));assert(code.textContent.includes('$x$'));assert(code.textContent.includes('\\[literal\\]'));assert(!body.querySelector('mjx-container,.ai-math-pending'));
 });
 await check('inline, indented code and escaped dollars remain literal',()=>{
  draw('`$x$` and \\$5\n\n    \\[example\\] $x$');equal(body.querySelectorAll('code').length,2);assert(!body.querySelector('mjx-container,.ai-math-pending'));
 });
 await check('copy button copies literal code without notebook interaction',async()=>{
  let copied;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copied=text;}}});draw('```python\nx = "$x$"\n```');body.querySelector('.copy-code-button').click();await Promise.resolve();equal(copied,'x = "$x$"');equal(body.querySelector('.copy-code-button').textContent,'已复制');
 });
 await check('currency without a closing delimiter stays readable',()=>{draw('费用 $10，含税。');assert(body.textContent.includes('$10'));assert(!body.querySelector('.ai-math-pending'));});
 await check('nested lists and tables compile during streaming',()=>{
  draw('- 一\n  - 二\n\n| 参数 | 值 |\n| --- | --- |\n| 增益 | $K$ |');assert(body.querySelector('ul ul'));assert(body.querySelector('table td mjx-container'));
 });
 await check('response typography separates prose and code',()=>{
  draw('正文\n\n```python\nx = 1\n```');const prose=getComputedStyle(body),code=getComputedStyle(body.querySelector('pre code'));equal(prose.fontSize,'16px');assert(prose.fontFamily.includes('Georgia'));equal(code.fontSize,'13px');assert(code.fontFamily.includes('monospace'));equal(getComputedStyle(body.querySelector('pre')).whiteSpace,'pre');
 });
 await check('untrusted HTML and links cannot execute or embed',()=>{
  draw('<img src=x onerror="window.hacked=1"><iframe src="https://example.com"></iframe><script>window.hacked=1</script>\n\n[bad](javascript:alert(1)) [good](https://example.com)\n\n$x$');
  assert(!body.querySelector('script,img,iframe,object,embed,input,form,[onerror],[onclick]'));assert(!window.hacked);assert(!body.querySelector('[href^="javascript:"]'));const link=body.querySelector('[href="https://example.com"]');equal(link.target,'_blank');assert(link.rel.includes('noopener'));assert(body.querySelector('mjx-container'));
 });
 await check('completed paragraphs retain DOM and selected text across deltas',()=>{
  draw('稳定段落。\n\n正在');const p=body.querySelector('p'),range=document.createRange();range.selectNodeContents(p);getSelection().removeAllRanges();getSelection().addRange(range);
  draw('稳定段落。\n\n正在生成 **内容**');assert(body.querySelector('p')===p);equal(getSelection().toString(),'稳定段落。');
  draw('稳定段落。\n\n正在生成 **内容**','complete');assert(body.querySelector('p')===p);getSelection().removeAllRanges();
 });
 await check('conversation refresh preserves history, active article and scrolled position',()=>{
  aiState.config={provider:'claude-code'};const first={role:'assistant',content:'历史消息\n\n$x$'.repeat(20),status:'complete'},active={role:'assistant',content:'新的 **回答**',status:'streaming'};
  const session={key:'stream-fixture',messages:[{role:'user',content:'<b>literal user</b>',sources:[{kind:'pdf-page',path:'old.pdf'}]},first,active]};renderAITranscript(session,host);
  const transcript=host.querySelector('.ai-transcript'),history=transcript.children[1],article=transcript.children[2],p=article.querySelector('p');transcript.scrollTop=0;
  active.content+='\n\n$$x^2$$';renderAITranscript(session,host);assert(transcript.children[1]===history);assert(transcript.children[2]===article);assert(article.querySelector('p')===p);equal(transcript.scrollTop,0);assert(article.querySelector('mjx-container'));assert(!transcript.children[0].querySelector('b'));assert(!transcript.querySelector('.ai-message-sources'),'legacy automatic PDF card repeated');
  active.status='complete';renderAITranscript(session,host);assert(transcript.children[2]===article);equal(article.querySelector('.ai-message-body').dataset.streaming,'false');
  session.messages=[first];renderAITranscript(session,host);equal(transcript.children.length,1);assert(transcript.children[0]===history);
 });
 await check('review suggestions do not leak partial structured output',()=>{
  const message={role:'assistant',mode:'suggest',content:'{"changes": [',status:'streaming'},session={key:'suggest-fixture',messages:[message]};renderAITranscript(session,host);assert(!host.textContent.includes('{"changes"'));
  message.status='complete';message.proposal={summary:'可审阅修改',changes:[]};renderAITranscript(session,host);assert(host.querySelector('button'));assert(host.textContent.includes('可审阅修改'));
 });
 await check('real SSE reader renders deltas before the done event',async()=>{
  const previous=window.fetch,encoder=new TextEncoder(),message={role:'assistant',content:'',status:'streaming'},session={key:'sse-fixture',messages:[message]};let sawCompiledDelta=false;
  const frames=[{type:'delta',text:'**已输出**\n\n$$x^2$$'},{type:'done',text:'**已输出**\n\n$$x^2$$\n\n完成。'}].map(event=>'data: '+JSON.stringify(event)+'\n\n');
  const bytes=encoder.encode(frames.join('')),chunks=[bytes.slice(0,19),bytes.slice(19,47),bytes.slice(47)];
  window.fetch=async()=>new Response(new ReadableStream({pull(controller){const chunk=chunks.shift();if(chunk)controller.enqueue(chunk);else controller.close();}}));
  try{await aiStream('/api/ai/chat',{}, {controller:new AbortController()},event=>{
   if(event.type==='delta'){message.content+=event.text;renderAITranscript(session,host);sawCompiledDelta=!!host.querySelector('strong')&&!!host.querySelector('mjx-container');}
   if(event.type==='done'){assert(sawCompiledDelta,'nothing compiled until done');message.content=event.text;message.status='complete';renderAITranscript(session,host);}
  });assert(host.textContent.includes('完成。'));}finally{window.fetch=previous;}
 });
 const showcase='# 理解 iLQR 的局部近似\n\n先将价值函数在当前轨迹附近展开，得到关于控制增量的 **二次模型**。\n\n$$\\Delta Q_k=\\frac12\\delta u_k^\\top Q_{uu}\\delta u_k+(Q_u+Q_{ux}\\delta x_k)^\\top\\delta u_k$$\n\n最优控制由 $\\delta u_k^*=k_k+K_k\\delta x_k$ 给出：\n\n- $k_k$ 调整当前控制。\n- $K_k$ 根据状态偏差反馈。\n\n```python\nk = -solve(Q_uu, Q_u)\nK = -solve(Q_uu, Q_ux)\n```';draw(showcase,'complete');host.hidden=true;
 document.querySelector('#result').textContent=JSON.stringify(results);
}
test('streaming AI responses in real Chrome',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'note-ai-response-'));
 try{
  const url=name=>'file://'+path.join(testPaths.STATIC_ROOT,name);
  const styles=['style.css','ai.css','ai-interface.css','obsidian-markdown.css','ai-response.css'].map(name=>'<link rel="stylesheet" href="'+url(name)+'">').join('');
  const scripts=['vendor/purify.js','obsidian-math.bundle.js','obsidian-markdown.bundle.js','ai-response.js','ai.js'].map(name=>'<script src="'+url(name)+'"></script>').join('');
  const page=path.join(temp,'test.html'),bootstrap='const $=(q,r=document)=>r.querySelector(q);const uiIcon=()=>"";ObsidianMath.installStyles();document.getElementById("obsidian-math-styles").textContent=document.getElementById("obsidian-math-styles").textContent.replaceAll("/vendor/mathjax",'+JSON.stringify(url('vendor/mathjax'))+');';
  fs.writeFileSync(page,'<!doctype html><meta charset="utf-8">'+styles+'<style>body{display:block;margin:30px;background:#faf9f6}#showcase{width:620px;margin:auto}.ai-transcript{height:220px}#result{display:none}</style><main class="ai-note-interface"><article id="showcase" class="ai-message assistant"><div id="response" class="ai-message-body"></div></article><div id="host"><div class="ai-transcript"></div></div></main><pre id="result">pending</pre>'+scripts+'<script>'+bootstrap+'('+scenarios.toString().replace(/<\/script/gi,'<\\/script')+')().catch(e=>document.querySelector("#result").textContent=JSON.stringify([{ok:false,error:e.stack}]))</script>');
  const args=['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run','--user-data-dir='+path.join(temp,'profile'),'--allow-file-access-from-files','--window-size=800,1100','--virtual-time-budget=5000','--dump-dom'];
  if(process.env.AI_RESPONSE_SCREENSHOT)args.push('--screenshot='+process.env.AI_RESPONSE_SCREENSHOT);
  const run=spawnSync(process.env.CHROME_BIN||'google-chrome',[...args,'file://'+page],{encoding:'utf8',timeout:45000,maxBuffer:5*1024*1024});assert.equal(run.status,0,run.stderr);
  const match=run.stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/);assert.ok(match,'Browser results missing');const rows=JSON.parse(match[1].replaceAll('&quot;','"').replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&'));
  assert.deepEqual(rows.filter(row=>!row.ok),[]);assert.equal(rows.length,17);console.log('Verified '+rows.length+' streaming response browser scenarios.');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
