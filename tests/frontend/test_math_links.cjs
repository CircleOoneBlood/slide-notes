const testPaths = require('./paths.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ctx=vm.createContext({console});vm.runInContext(fs.readFileSync(testPaths.STATIC_ROOT+'/obsidian-math.bundle.js','utf8'),ctx);
test('MathJax preserves only inert legacy formula groups without the former renderer',()=>{
 const output=ctx.ObsidianMath.render(String.raw`\htmlData{math-link=group-one}{x^2}`,true);
 assert(output.includes('data-math-link="group-one"'));assert(output.includes('jax="CHTML"'));assert(!output.includes('katex'));
 const unsafe=ctx.ObsidianMath.render(String.raw`\href{javascript:alert(1)}{x}`,false);assert(!unsafe.includes('javascript:'));
});
test('formula error preserves safe visible source and does not add arbitrary HTML',()=>{
 const output=ctx.ObsidianMath.render(String.raw`\class{arbitrary}{x}\href{file:///tmp/private}{y}`,false);
 assert(!output.includes('class="arbitrary"'));assert(!output.includes('file:///'));
});
test('source tracing preserves mathematical output and maps repeated symbols separately',()=>{
 for(const source of [String.raw`x_k+x_k`,String.raw`\tfrac{1}{2}+\frac{x}{y}`,String.raw`\begin{bmatrix}Q_{xx}&Q_{xu}\\Q_{ux}&Q_{uu}\end{bmatrix}`,String.raw`\colorbox{#FFF3B0}{$\Delta l_k$}`,String.raw`\htmlData{math-link=group-one}{x_k}+x_k`]) {
  const plain=ctx.ObsidianMath.render(source,true),mapped=ctx.ObsidianMath.render(source,true,{sourceMap:true});
  assert.equal(mapped.replace(/ data-tex-(?:from|to)="\d+"/g,''),plain,source);
  assert(mapped.includes('data-tex-from='),source);
  for(const match of mapped.matchAll(/data-tex-from="(\d+)" data-tex-to="(\d+)"/g))assert(+match[1]>=0&&+match[1]<+match[2]&&+match[2]<=source.length,source);
 }
 const output=ctx.ObsidianMath.render('x_k+x_k',true,{sourceMap:true});
 assert(output.includes('data-tex-from="0" data-tex-to="1"'));
 assert(output.includes('data-tex-from="4" data-tex-to="5"'));
});
