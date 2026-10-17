const testPaths = require('./paths.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {test} = require('node:test');

// This fixture uses the shipped renderer, MathJax adapter and CM6 bundles. It
// deliberately has no application state, notebook files, server or remote API.
async function browserScenarios() {
  const results = [];
  const assert = (value, message = 'assertion failed') => { if (!value) throw Error(message); };
  const equal = (actual, expected, message = '') => assert(actual === expected, `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  const close = (actual, expected, epsilon = .06) => assert(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
  const tick = () => new Promise(resolve => setTimeout(resolve, 35));
  async function check(name, run) {
    try { await run(); results.push({name, ok:true}); }
    catch (error) { results.push({name, ok:false, error:error.stack || String(error)}); }
    document.querySelector('#result').textContent = JSON.stringify(results);
  }
  function fixture(source, options = {}) {
    const root = document.createElement('article');
    root.className = 'obsidian-markdown markdown-rendered';
    root.style.width = '720px';
    document.querySelector('#fixtures').append(root);
    let current = source, unbind;
    const changes = [];
    const draw = () => {
      unbind?.();
      root.innerHTML = ObsidianMarkdown.render(current, options);
      unbind = ObsidianMarkdown.bindPreview(root, {
        read:() => current, enabled:() => !options.readonly, sourcePath:options.sourcePath || '',
        commit(change) {
          changes.push(change);
          current = current.slice(0, change.from) + change.insert + current.slice(change.to);
          if (options.rerender !== false) draw();
        },
      });
    };
    draw();
    return {root, changes, read:() => current, stale:value => { current = value; }, remove() { unbind?.(); root.remove(); }};
  }
  function editor(source, options = {}) {
    const parent = document.createElement('section');
    parent.className = 'markdown-cell';
    document.querySelector('#fixtures').append(parent);
    const changes = [];
    const view = NotebookCodeEditor.create({
      parent, source, label:'temporary Markdown fixture', language:'markdown',
      markdownBlocks:ObsidianMarkdown.blocks,
      renderMarkdown:(region, documentSource) => ObsidianMarkdown.render(region, {documentSource}),
      bindMarkdownPreview:ObsidianMarkdown.bindPreview,
      onChange:value => changes.push(value), ...options,
    });
    return {parent, view, changes, read:() => view.state.doc.toString(), remove() { view.destroy(); parent.remove(); }};
  }
  const key = (view, name, extra = {}) => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {key:name, code:name.length === 1 ? `Key${name.toUpperCase()}` : name, bubbles:true, cancelable:true, ...extra}));

  await check('real renderer, MathJax and CM6 public interfaces load', () => {
    assert(ObsidianMarkdown.render && ObsidianMarkdown.blocks && ObsidianMarkdown.bindPreview);
    assert(ObsidianMath.render && NotebookCodeEditor.create);
    assert(!globalThis.katex, 'legacy KaTeX was loaded');
  });
  await check('reading text uses 16px sans with 24px line height', () => {
    const f = fixture('中文 English'); const style = getComputedStyle(f.root);
    equal(style.fontSize, '16px'); equal(style.lineHeight, '24px');
    assert(style.fontFamily.includes('ui-sans-serif') && style.fontFamily.includes('Inter'));
    equal(style.color, 'rgb(34, 34, 34)'); f.remove();
  });
  await check('six heading levels preserve default sizes and weights', () => {
    const f = fixture('# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six');
    const scales = [1.618,1.462,1.318,1.188,1.076,1];
    scales.forEach((scale,index) => {
      const heading = f.root.querySelector(`h${index + 1}`), style = getComputedStyle(heading);
      close(parseFloat(style.fontSize), scale * 16); equal(style.fontWeight, index ? '600' : '700');
    }); f.remove();
  });
  await check('inline and fenced code use 14px monospace, independent of prose', () => {
    const f = fixture('Text `x`\n\n```python\nx = 1\n```');
    for (const code of f.root.querySelectorAll('code')) {
      const style = getComputedStyle(code); equal(style.fontSize, '14px'); assert(style.fontFamily.includes('ui-monospace'));
    } f.remove();
  });
  await check('encoded whitespace in fenced languages cannot inject CSS classes', () => {
    for(const [language,expected,code] of [['js&#x20;audit-marker','js','const answer = 1;'],['python&#9;audit-marker','python','return 1'],['js&#10;audit-marker','js','const answer = 1;']]) {
      const source='```'+language+'\n'+code+'\n```',f=fixture(source);
      for(const node of f.root.querySelectorAll('pre,code'))equal(node.className,'language-'+expected);
      equal(f.root.querySelectorAll('.audit-marker').length,0);
      assert(f.root.querySelector('code .token.keyword'),'normal language highlighting was lost');
      equal(f.read(),source);f.remove();
    }
  });
  await check('ordinary newlines break while blank lines form paragraphs', () => {
    const f = fixture('first\nsecond\n\nthird'); equal(f.root.querySelectorAll('p').length, 2); equal(f.root.querySelectorAll('br').length, 1); f.remove();
  });
  await check('GFM table alignment, inline formatting and cell spacing survive', () => {
    const f = fixture('| Left | Right |\n| :--- | ---: |\n| **bold** | `code` |');
    equal(f.root.querySelectorAll('td').length, 2); assert(f.root.querySelector('td strong')); assert(f.root.querySelector('td code'));
    equal(getComputedStyle(f.root.querySelector('td')).padding, '4px 8px');
    equal(f.root.querySelectorAll('td')[1].getAttribute('align'), 'right'); f.remove();
  });
  await check('nested lists and strikethrough render without flattening', () => {
    const f = fixture('- outer\n  - ~~inner~~\n\n1. first\n2. second'); assert(f.root.querySelector('ul ul del')); equal(f.root.querySelectorAll('ol>li').length, 2); f.remove();
  });
  await check('repeated footnotes resolve to distinct references and return links', () => {
    const f = fixture('One[^same] and two[^same].\n\n[^same]: Definition **bold**');
    equal(f.root.querySelectorAll('sup>a[data-footnote-ref],sup.footnote-ref>a').length, 2); assert(f.root.querySelector('.footnotes, [data-footnotes]'));
    assert(f.root.querySelectorAll('[data-footnote-backref],.footnote-backref').length >= 2); assert(f.root.textContent.includes('Definition bold')); f.remove();
  });
  await check('inline footnotes become reading footnotes', () => {
    const f = fixture('Here ^[Inline note with **weight**] remains.'); assert(f.root.querySelector('sup')); assert(f.root.textContent.includes('Inline note with weight')); assert(!f.root.textContent.includes('^[')); f.remove();
  });
  await check('isolated live regions resolve definitions from the whole document', () => {
    const region = 'Here [link][target] and [^n].';
    const f = fixture(region, {documentSource:region + '\n\n[target]: https://example.invalid/document\n\n[^n]: Full document note'});
    equal(f.root.querySelector('a.external-link')?.getAttribute('href'), 'https://example.invalid/document'); assert(f.root.querySelector('sup')); f.remove();
  });
  await check('task toggles modify only the clicked repeated source marker', async () => {
    const source = '- [ ] same\r\n- [ ] same\r\n'; const f = fixture(source);
    f.root.querySelectorAll('input[type=checkbox]')[1].click(); await tick();
    equal(f.read(), '- [ ] same\r\n- [x] same\r\n'); equal(f.changes.length, 1);
    const change = f.changes[0]; equal(change.to - change.from, 1); equal(change.insert, 'x'); f.remove();
  });
  await check('rerendered tasks can toggle back without changing surrounding content', async () => {
    const source = 'Before\n\n- [ ] item **same**\n\nAfter'; const f = fixture(source);
    f.root.querySelector('input').click(); await tick(); f.root.querySelector('input').click(); await tick();
    equal(f.read(), source); equal(f.changes.length, 2); f.remove();
  });
  await check('custom task states display checked and retain their original source', () => {
    const source = '- [/] progressing\n- [-] cancelled'; const f = fixture(source);
    equal(f.root.querySelectorAll('input[type=checkbox]').length, 2);
    for (const input of f.root.querySelectorAll('input')) {
      assert(input.checked); assert(input.classList.contains('task-list-item-checkbox'));
      equal(getComputedStyle(input).accentColor, 'rgb(120, 82, 238)');
    }
    equal(f.read(), source); f.remove();
  });
  await check('readonly preview rejects task source writes', async () => {
    const source = '- [ ] protected'; const f = fixture(source, {readonly:true}); f.root.querySelector('input').click(); await tick();
    equal(f.read(), source); equal(f.changes.length, 0); assert(!f.root.querySelector('input').checked); f.remove();
  });
  await check('stale preview cannot apply a task transaction to changed source', async () => {
    const f = fixture('- [ ] old', {rerender:false}); f.stale('unrelated source'); f.root.querySelector('input').click(); await tick(); equal(f.read(), 'unrelated source'); equal(f.changes.length, 0); f.remove();
  });
  await check('folded callout title toggles content without rewriting Markdown', () => {
    const source = '> [!warning]- Careful **title**\n> Body content'; const f = fixture(source);
    const callout = f.root.querySelector('.callout'); equal(callout.dataset.callout, 'warning'); assert(callout.classList.contains('is-collapsed'));
    const title = callout.querySelector('.callout-title'); assert(title.querySelector('strong')); title.click();
    equal(title.getAttribute('aria-expanded'), 'true'); assert(!callout.querySelector('.callout-content').hidden); equal(f.read(), source); equal(f.changes.length, 0); f.remove();
  });
  await check('callout title is keyboard operable and plus starts expanded', () => {
    const f = fixture('> [!tip]+ Tip\n> Body'); const title = f.root.querySelector('.callout-title'); equal(title.getAttribute('aria-expanded'), 'true');
    title.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true})); equal(title.getAttribute('aria-expanded'), 'false'); f.remove();
  });
  await check('highlight preserves nested emphasis', () => {
    const f = fixture('==important **bold**== and ~~old~~'); assert(f.root.querySelector('mark strong')); assert(f.root.querySelector('del')); f.remove();
  });
  await check('colored highlight prefixes affect reading color without changing source', () => {
    const source = '==🔴Red== and ==🟦Blue **bold**=='; const f = fixture(source);
    const marks = [...f.root.querySelectorAll('mark')]; equal(marks.length, 2);
    equal(marks[0].getAttribute('data-highlight'), 'red'); equal(marks[1].getAttribute('data-highlight'), 'blue');
    equal(marks[0].textContent, 'Red'); assert(marks[1].querySelector('strong'));
    assert(getComputedStyle(marks[0]).backgroundColor !== getComputedStyle(marks[1]).backgroundColor); equal(f.read(), source); f.remove();
  });
  await check('wiki aliases dispatch workspace navigation with source path', () => {
    const f = fixture('[[Folder/Target#Heading|Alias]]', {sourcePath:'notebooks/current.json'}); let detail;
    f.root.addEventListener('obsidian-open-link', event => detail = event.detail);
    const link = f.root.querySelector('.internal-link'); equal(link.textContent, 'Alias'); link.click();
    equal(detail?.href, 'Folder/Target#Heading'); equal(detail?.sourcePath, 'notebooks/current.json'); f.remove();
  });
  await check('wiki image dimensions use the workspace resolver', () => {
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const f = fixture('![[picture.png|120x80]]', {resolveFile:href => href === 'picture.png' ? pixel : ''}); const image = f.root.querySelector('img');
    assert(image); equal(image.getAttribute('width'), '120'); equal(image.getAttribute('height'), '80'); equal(image.getAttribute('src'), pixel); f.remove();
  });
  await check('unresolved note embeds remain visible navigable references', () => {
    const f = fixture('![[Other note#Section]]'); const embed = f.root.querySelector('.internal-embed'); assert(embed); assert(embed.querySelector('.internal-link')); assert(embed.textContent.includes('Other note')); f.remove();
  });
  await check('tags exclude pure numbers and block identifiers stay hidden', () => {
    const f = fixture('Tagged #science #123\n\nBlock text ^block-123');
    equal(f.root.querySelectorAll('.tag').length, 1); assert(f.root.textContent.includes('#123')); assert(!f.root.textContent.includes('^block-123')); assert(f.root.querySelector('[data-block-id="block-123"],#block-123')); f.remove();
  });
  await check('inline and multiline comments hide without shifting later task offsets', async () => {
    const source = 'Before %%hidden%% after\n\n%%multiline\n\nsecret%%\n\n- [ ] last'; const f = fixture(source);
    assert(!f.root.textContent.includes('hidden') && !f.root.textContent.includes('secret')); f.root.querySelector('input').click(); await tick();
    equal(f.read(), source.replace('- [ ] last', '- [x] last')); f.remove();
  });
  await check('code protects literal comments, wiki syntax, highlights and dollars', () => {
    const literal = '%%keep%% [[note]] ==literal== $money$'; const f = fixture('`' + literal + '`\n\n```text\n' + literal + '\n```');
    equal(f.root.querySelectorAll('code').length, 2); for (const code of f.root.querySelectorAll('code')) assert(code.textContent.includes(literal));
    assert(!f.root.querySelector('.internal-link,mark,mjx-container')); f.remove();
  });
  await check('Prism highlights fences and unknown languages remain escaped', () => {
    const f = fixture('```python\ndef f(x):\n    return x + 1\n```\n\n```unknown\n<script>literal</script>\n```');
    equal(f.root.querySelector('.token.keyword')?.textContent, 'def'); assert(f.root.querySelector('code.language-unknown').textContent.includes('<script>literal</script>')); assert(!f.root.querySelector('script')); f.remove();
  });
  await check('MathJax produces inline and display CHTML without KaTeX', () => {
    const f = fixture('$x_1+\\frac{a}{b}$\n\n$$\n\\sum_{i=1}^{3} i\n$$');
    assert(f.root.querySelector('.math-inline mjx-container[jax="CHTML"]')); assert(f.root.querySelector('.math-block mjx-container[display="true"]'));
    assert(!f.root.querySelector('.katex')); assert(document.querySelector('#obsidian-math-styles')); f.remove();
  });
  await check('compact double-dollar formulas are separate display blocks', () => {
    const source = 'Before $$V(x)=\\min_u Q(x,u)$$ after\n\n$$x^2+1$$';
    const f = fixture(source);
    equal(f.root.querySelectorAll('.math-block mjx-container[display="true"]').length, 2);
    assert(!f.root.querySelector('.math-inline,p .math-block'));
    assert(f.root.textContent.includes('Before') && f.root.textContent.includes('after'));
    const blocks = ObsidianMarkdown.blocks(source);
    equal(blocks.filter(block => block.type === 'math').length, 2);
    equal(blocks.map(block => block.source).join(''), source); f.remove();
  });
  await check('same-line aligned fences preserve TeX rows and following table', () => {
    // Both the opening row break and escaped braces must survive Markdown's
    // fence-metadata parser verbatim, as they do in existing iLQR notes.
    const source = '$$\\begin{aligned} a&=\\{b\\}\\\\\nc&=d\n\\end{aligned}$$\n\nFollowing\n\n$$z^2$$\n\n| A | B |\n| --- | --- |\n| one | two |';
    const f = fixture(source);
    equal(f.root.querySelectorAll('.math-block').length, 2);
    assert(!f.root.querySelector('mjx-merror,[data-mjx-error],.math-error'));
    equal(f.root.querySelectorAll('mjx-mtable mjx-mtr').length, 2);
    assert(f.root.querySelector('table') && f.root.textContent.includes('Following'));
    equal(ObsidianMarkdown.blocks(source).map(block => block.source).join(''), source); f.remove();
  });
  await check('colorbox math with inner dollars stays a complete display formula', async () => {
    const body='\\colorbox{#FFF3B0}{$\\Delta l_k$}\n= \\ell_x^{\\top}\\delta x_k\n+ \\tfrac{1}{2}\\delta x_k^{\\top}\\ell_{xx}\\delta x_k';
    for(const formula of ['$$'+body+'$$','$$'+body.replaceAll('\n',' ')+'$$','$$\n'+body+'\n$$']) {
      const source=formula+'\n\nFollowing\n\n- [ ] after';const f=fixture(source);
      equal(f.root.querySelectorAll('.math-block mjx-container[display="true"]').length,1);
      assert(!f.root.querySelector('mjx-merror,[data-mjx-error],.math-error'));
      assert(!f.root.textContent.includes('$$') && !f.root.textContent.includes('\\tfrac'));
      equal(f.root.querySelectorAll('li').length,1,'plus terms became Markdown list items');
      const colored=f.root.querySelector('mjx-mpadded');assert(colored);
      equal(getComputedStyle(colored).backgroundColor,'rgb(255, 243, 176)');
      assert(f.root.textContent.includes('Following'));
      const blocks=ObsidianMarkdown.blocks(source);equal(blocks[0].type,'math');equal(blocks.map(block=>block.source).join(''),source);
      f.root.querySelector('input').click();await tick();equal(f.read(),source.replace('- [ ] after','- [x] after'));f.remove();
    }
    const source='Before\n\n$$'+body+'$$\n\nAfter';const f=editor(source);f.view.focus();f.view.dispatch({selection:{anchor:source.indexOf('ell_x')}});await tick();
    assert(f.parent.querySelector('.markdown-math-edit-preview mjx-mpadded'),'editing colorbox lost its full formula preview');
    assert(!f.parent.querySelector('.markdown-math-edit-preview li'));equal(f.read(),source);equal(f.changes.length,0);f.remove();
  });
  await check('flexible math fences retain containers, blank lines and task offsets', async () => {
    const source = '> $$\\begin{aligned}\r\n> a&=b\\\\\r\n> \r\n> c&=d\r\n> \\end{aligned}$$\r\n\r\n- $$x^2$$\r\n\r\n- [ ] after 😀';
    const f = fixture(source);
    assert(f.root.querySelector('blockquote .math-block') && f.root.querySelector('li .math-block'));
    assert(!f.root.querySelector('mjx-merror,[data-mjx-error],.math-error'));
    f.root.querySelector('input').click(); await tick();
    equal(f.read(), source.replace('- [ ] after', '- [x] after')); f.remove();
  });
  await check('notebook width and centered or scrolling display math work in both views', async () => {
    const source = '# Formula\n\n$$V(x)=\\min_u Q(x,u)$$\n\n$$' + Array(40).fill('x_k').join('+') + '$$';
    for (const width of [1100, 430]) for (const live of [false, true]) {
      const f = live ? editor(source) : fixture(source);
      const root = live ? f.parent : f.root;
      root.style.width = width + 'px';
      if (!live) { root.classList.add('markdown-preview'); const card=document.createElement('section');card.className='markdown-cell';card.style.width=width+'px';root.replaceWith(card);card.append(root); }
      await tick(); await document.fonts.ready;
      const content = live ? root.querySelector('.cm-content') : root;
      close(content.getBoundingClientRect().width, width, 2);
      for (const block of root.querySelectorAll('.math-block')) {
        const math=block.querySelector('mjx-math'),m=math.getBoundingClientRect(),b=block.getBoundingClientRect();
        if(m.width<=b.width) close((m.left+m.right)/2,(b.left+b.right)/2,2);
        else { assert(block.scrollWidth>block.clientWidth);assert(m.left>=b.left-2,'start of long formula is clipped');block.scrollLeft=block.scrollWidth;assert(block.scrollLeft>0); }
      }
      const card=!live?root.parentElement:null;f.remove();card?.remove();
    }
  });
  await check('math safe policy blocks javascript URLs and user CSS injection', () => {
    const f = fixture('$\\href{javascript:alert(1)}{x}+\\class{injected}{y}$');
    assert(!f.root.querySelector('[href^="javascript:"],.injected,script')); assert(f.root.querySelector('mjx-container,.math-error')); f.remove();
  });
  await check('malformed TeX stays contained and does not destroy following prose', () => {
    const f = fixture('$\\frac{broken$\n\nFollowing prose'); assert(f.root.textContent.includes('Following prose')); assert(f.root.querySelector('mjx-container,.math-error')); f.remove();
  });
  await check('HTML and dangerous Markdown URLs are sanitized', () => {
    const f = fixture('<img src="x" onerror="window.__unsafe=1"><script>window.__unsafe=2</script>\n\n[attack](javascript:alert(1))');
    assert(!f.root.querySelector('script,[onerror],[href^="javascript:"]')); assert(!window.__unsafe); f.remove();
  });
  await check('user HTML cannot forge generated task write capabilities', async () => {
    const source = '<input type="checkbox" data-task-token="forged">\n\n- [ ] valid'; const f = fixture(source);
    const forged = [...f.root.querySelectorAll('input')].find(input => !input.closest('.task-list-item'));
    if (forged) { forged.click(); await tick(); } equal(f.read(), source); equal(f.changes.length, 0); f.remove();
  });
  await check('rendering and source block partition preserve Unicode CRLF bytes', () => {
    const source = '\r\n# 标题 😀\r\n\r\n%%hidden%%\r\n\r\n- [ ] 内容\r\n'; const before = source;
    const blocks = ObsidianMarkdown.blocks(source); equal(blocks.map(block => source.slice(block.from, block.to)).join(''), source);
    ObsidianMarkdown.render(source); equal(source, before); assert(blocks.every(block => block.source === source.slice(block.from, block.to)));
  });
  await check('CM live preview keeps a single native source document and 16px text', async () => {
    const source = '# Heading\n\n| A | B |\n| --- | --- |\n| one | two |'; const f = editor(source); await tick();
    equal(f.read(), source); equal(f.changes.length, 0); assert(f.parent.querySelector('.markdown-preview-block table'));
    equal(f.parent.querySelectorAll('[contenteditable="true"]').length, 1); equal(getComputedStyle(f.view.scrollDOM).fontSize, '16px'); f.remove();
  });
  await check('editing boxed math keeps colored TeX and a centered live result below it', async () => {
    const formula='$$\\boxed{\\delta x_k=x_k-\\hat x_k},\\qquad\n\\boxed{\\delta u_k=u_k-\\hat u_k}.$$';
    const source='Before\n\n'+formula+'\n\nAfter';const f=editor(source);f.parent.style.width='720px';
    f.view.focus();f.view.dispatch({selection:{anchor:source.indexOf('x_k')}});await tick();await document.fonts.ready;
    const preview=()=>f.parent.querySelector('.markdown-math-edit-preview');
    assert(preview()?.querySelector('mjx-container[display="true"]'),'active formula lost its rendered result');
    assert(f.view.contentDOM.textContent.includes('\\boxed{\\delta'));
    equal(getComputedStyle(f.parent.querySelector('.md-math-command')).color,'rgb(255, 75, 75)');
    equal(getComputedStyle(f.parent.querySelector('.md-math-command'),'::selection').color,'rgb(255, 75, 75)');
    equal(getComputedStyle(f.parent.querySelector('.md-math-delimiter')).color,'rgb(172, 122, 245)');
    const math=preview().querySelector('mjx-math').getBoundingClientRect(),block=preview().querySelector('.math-block').getBoundingClientRect();
    close((math.left+math.right)/2,(block.left+block.right)/2,2);
    assert(preview().getBoundingClientRect().top>=f.parent.querySelector('.md-math-source').getBoundingClientRect().bottom);
    assert(!preview().querySelector('mjx-merror,[data-mjx-error],.math-error'));equal(f.read(),source);equal(f.changes.length,0);
    const previous=preview().innerHTML,at=source.indexOf('x_k');f.view.dispatch({changes:{from:at,to:at+3,insert:'z_k'},userEvent:'input'});await tick();
    assert(preview().innerHTML!==previous,'preview did not follow source edits');
    key(f.view,'z',{ctrlKey:true});await tick();equal(f.read(),source);
    f.view.dispatch({selection:{anchor:0}});await tick();assert(!preview());equal(f.parent.querySelectorAll('.math-block').length,1);
    NotebookCodeEditor.setMarkdownMode(f.view,'source');await tick();assert(!f.parent.querySelector('.math-block'));assert(f.parent.querySelector('.md-math-command'));equal(f.read(),source);
    f.remove();
  });
  await check('formula cursor highlights the exact occurrence, scripts, fraction and matrix entry', async () => {
    const source='Intro\n\n$$x_k+x_k+\\tfrac{1}{2}+\\begin{bmatrix}Q_{xx}&Q_{xu}\\\\Q_{ux}&Q_{uu}\\end{bmatrix}$$\n\nAfter';
    const f=editor(source);f.parent.style.width='900px';f.view.focus();
    const move=async at=>{f.view.dispatch({selection:{anchor:at}});await tick();const active=f.parent.querySelectorAll('.math-source-active');equal(active.length,1,'cursor highlight count at '+at);return active[0];};
    const origin=node=>Number(node.closest('[data-markdown-from]').dataset.markdownFrom)+Number(node.dataset.mathFrom);
    const first=source.indexOf('x_k'),second=source.indexOf('x_k',first+1);
    let active=await move(first);equal(origin(active),first);
    const preview=f.parent.querySelector('.markdown-math-edit-preview mjx-container');
    active=await move(second);equal(origin(active),second);assert(f.parent.querySelector('.markdown-math-edit-preview mjx-container')===preview,'moving cursor re-typeset the formula');
    active=await move(second+2);equal(origin(active),second+2,'subscript maps independently');
    active=await move(source.indexOf('tfrac')+2);equal(active.tagName.toLowerCase(),'mjx-mfrac');
    active=await move(source.indexOf('Q_{xu}'));equal(origin(active),source.indexOf('Q_{xu}'),'repeated matrix Q maps to its own entry');
    active=await move(source.indexOf('begin')+2);equal(active.tagName.toLowerCase(),'mjx-mtable');
    f.view.dispatch({selection:{anchor:first,head:second+3}});await tick();assert(f.parent.querySelectorAll('.math-source-active').length>=4,'selected source does not highlight its rendered symbols');
    equal(f.read(),source);equal(f.changes.length,0);
    f.view.dispatch({selection:{anchor:0}});await tick();assert(!f.parent.querySelector('.math-source-active'));
    await move(second);f.view.contentDOM.blur();await tick();assert(!f.parent.querySelector('.math-source-active'),'blur left a stale glow');
    f.remove();
  });
  await check('inline math edits in one sentence without a duplicated paragraph preview', async () => {
    const source='Intro\n\n一句话里的 **重点** $x_k+x_k$ 和 $\\frac{a}{b}$ 都保留在句子中。\n\nAfter';
    const f=editor(source);f.parent.style.width='900px';f.view.focus();
    const move=async position=>{f.view.dispatch({selection:{anchor:position}});await tick();};
    await move(source.indexOf('一句话'));
    equal(f.parent.querySelectorAll('.markdown-inline-math mjx-container').length,0);assert(f.parent.querySelector('.md-math-source'));
    assert(f.parent.querySelector('.md-strong'),'mixed prose lost Markdown formatting');
    assert(!f.parent.querySelector('.markdown-math-edit-preview'));
    equal(f.view.contentDOM.textContent.split('一句话里的').length,2,'prose appeared twice');
    await move(source.indexOf('x_k'));
    assert(f.parent.querySelector('.md-math-source'),'active formula is not editable colored TeX');
    equal(f.parent.querySelectorAll('.markdown-inline-math').length,0);
    assert(!f.parent.querySelector('.markdown-math-edit-preview'));
    await move(source.indexOf('frac')+1);assert(f.parent.querySelector('.md-math-command'));
    const at=source.indexOf('a}{b');f.view.dispatch({changes:{from:at,to:at+1,insert:'z'},selection:{anchor:at+1},userEvent:'input'});await tick();
    equal(f.read(),source.slice(0,at)+'z'+source.slice(at+1));assert(!f.parent.querySelector('.markdown-math-edit-preview'));
    key(f.view,'z',{ctrlKey:true});await tick();equal(f.read(),source);
    await move(source.indexOf('一句话'));equal(f.parent.querySelectorAll('.markdown-inline-math').length,0);
    assert(f.parent.querySelector('.md-math-source'));equal(f.parent.querySelectorAll('[contenteditable=true]').length,1);
    equal(f.read(),source);f.remove();
  });
  await check('mixed iLQR paragraphs keep prose and formulas on one layer for all selections', async () => {
    const source='Intro\n\n$g_{k+1}=\\nabla_x V$ 和 $H_{k+1}=\\nabla_x^2 V$ 是第\n$k+1$ 步值函数的梯度和 Hessian。反向递推（backward pass）\n时，它们已经由后一步算好并传回来。终端条件是\n$g_N=\\ell_{f,x}$，$H_N=\\ell_{f,xx}$。\n\nAfter';
    const f=editor(source);f.parent.style.width='520px';f.view.focus();
    const prose=source.indexOf('步值函数'),math=source.indexOf('nabla');f.view.dispatch({selection:{anchor:prose}});await tick();
    equal(f.parent.querySelectorAll('.markdown-inline-math').length,0);assert(!f.parent.querySelector('.markdown-math-edit-preview'));
    f.view.dispatch({selection:{anchor:math}});await tick();equal(f.parent.querySelectorAll('.markdown-inline-math').length,0);assert(f.parent.querySelector('.md-math-command'));assert(!f.parent.querySelector('.markdown-math-edit-preview'));
    f.view.dispatch({selection:{anchor:prose,head:prose+4}});await tick();equal(f.parent.querySelectorAll('.markdown-inline-math').length,0);assert(f.parent.querySelector('.md-math-source'));
    f.view.dispatch({selection:{anchor:math,head:prose+4}});await tick();assert(f.parent.querySelector('.md-math-command'));assert(!f.parent.querySelector('.markdown-math-edit-preview'));
    f.view.dispatch({selection:{anchor:0}});await tick();assert(!f.parent.querySelector('.markdown-math-edit-preview'));equal(f.read(),source);equal(f.changes.length,0);f.remove();
  });
  await check('rendered symbols click back to the exact repeated source occurrence', async () => {
    const source='Intro\n\n文字 $x_k+x_k$ 与 $\\frac{a}{b}$，后文。\n\n$$x_k+x_k+\\frac{a}{b}$$\n\nAfter';const f=editor(source);f.view.focus();
    for(const at of [source.indexOf('x_k',source.indexOf('x_k')+1),source.indexOf('a}{b'),source.lastIndexOf('x_k'),source.lastIndexOf('a}{b')]){
      f.view.dispatch({selection:{anchor:0}});await tick();
      const node=[...f.parent.querySelectorAll('[data-math-from]')].filter(node=>Number(node.closest('[data-markdown-from]').dataset.markdownFrom)+Number(node.dataset.mathFrom)===at).sort((a,b)=>Number(a.dataset.mathTo)-Number(b.dataset.mathTo))[0];assert(node,'mapped symbol missing');
      const r=node.getBoundingClientRect();node.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true,clientX:(r.left+r.right)/2,clientY:(r.top+r.bottom)/2}));document.dispatchEvent(new MouseEvent('mouseup',{button:0,bubbles:true}));node.dispatchEvent(new MouseEvent('click',{button:0,bubbles:true,cancelable:true,clientX:(r.left+r.right)/2,clientY:(r.top+r.bottom)/2}));await new Promise(resolve=>setTimeout(resolve,180));
      equal(f.view.state.selection.main.head,at,'preview click jumped to another occurrence');assert(f.view.hasFocus);
    }
    equal(f.read(),source);equal(f.changes.length,0);f.remove();
  });
  await check('inline math discovery protects code and escaped dollars and preserves exact offsets', async () => {
    const source='中文 😀 `literal $x$`、\\$escaped\\$ 与 $x_k$ 和 $x_k$。';
    const blocks=ObsidianMarkdown.blocks(source),ranges=blocks.flatMap(block=>block.inlineMath||[]);
    equal(ranges.length,2);equal(source.slice(ranges[0].from,ranges[0].to),'$x_k$');equal(source.slice(ranges[1].from,ranges[1].to),'$x_k$');
    const f=editor(source,{markdownMode:'source'});await tick();equal(f.parent.querySelectorAll('.md-math-source .md-math-delimiter, .md-math-source.md-math-delimiter').length,4);
    assert(!f.parent.querySelector('mjx-container'));equal(f.read(),source);f.remove();
  });
  await check('focused selection reveals table source and leaving it restores preview', async () => {
    const source = 'Plain\n\n| A | B |\n| --- | --- |\n| one | two |'; const f = editor(source); f.view.focus();
    f.view.dispatch({selection:{anchor:source.indexOf('| one')}}); await tick(); assert(!f.parent.querySelector('.markdown-preview-block table')); assert(f.view.contentDOM.textContent.includes('| one | two |'));
    f.view.dispatch({selection:{anchor:0}}); await tick(); assert(f.parent.querySelector('.markdown-preview-block table')); equal(f.read(), source); f.remove();
  });
  await check('source/live switches retain content, selection and native undo history', async () => {
    const source = 'Original **bold**'; const f = editor(source); f.view.focus();
    f.view.dispatch({changes:{from:0,to:8,insert:'Changed'},selection:{anchor:7},userEvent:'input'});
    NotebookCodeEditor.setMarkdownMode(f.view, 'source'); equal(NotebookCodeEditor.getMarkdownMode(f.view), 'source'); equal(f.view.state.selection.main.head, 7);
    NotebookCodeEditor.setMarkdownMode(f.view, 'live'); key(f.view, 'z', {ctrlKey:true}); await tick(); equal(f.read(), source);
    key(f.view, 'z', {ctrlKey:true,shiftKey:true}); await tick(); equal(f.read(), 'Changed **bold**'); f.remove();
  });
  await check('live task interaction participates in the native CM undo stack', async () => {
    const source = 'Intro\n\n- [ ] first\n- [ ] second'; const f = editor(source); await tick();
    f.parent.querySelectorAll('input[type=checkbox]')[1].click(); await tick(); equal(f.read(), 'Intro\n\n- [ ] first\n- [x] second');
    f.view.focus(); key(f.view, 'z', {ctrlKey:true}); await tick(); equal(f.read(), source); f.remove();
  });
  await check('readonly live editor keeps rendered tasks from changing source', async () => {
    const source = '- [ ] readonly'; const f = editor(source, {readonly:true}); await tick(); f.parent.querySelector('input[type=checkbox]').click(); await tick(); equal(f.read(), source); equal(f.changes.length, 0); f.remove();
  });
  await check('CJK source and composition events keep the same editing surface', async () => {
    const source = '中文输入 **保留**'; const f = editor(source, {markdownMode:'source'}); f.view.focus(); const surface = f.view.contentDOM;
    surface.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true,data:'笔记'}));
    surface.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true,data:'笔记'})); await tick();
    assert(f.view.contentDOM === surface, 'composition replaced the native editing surface'); equal(f.read(), source); f.remove();
  });

  const showcase = fixture('# Markdown · Notes\n\n正文使用 Obsidian 默认排版。**Bold**、*italic*、`inline code` 和 ==重点内容==。\n\n> [!tip]+ 工作区中的笔记\n> 支持双链 [[Project|项目笔记]]、任务与公式。\n\n- [x] 已完成内容\n- [ ] 下一步计划\n\n| 语法 | 显示 |\n| --- | --- |\n| Markdown | 阅读与实时预览 |\n| 数学 | MathJax CHTML |\n\n$$\nE=mc^2+\\sum_{k=1}^n k\n$$\n\n```python\ndef note(value):\n    return value + 1\n```');
  showcase.root.id = 'showcase';
  document.querySelector('#fixtures').style.display = 'none';
  document.body.prepend(showcase.root);
  document.querySelector('#result').textContent = JSON.stringify(results);
}

test('Obsidian-compatible Markdown and native Live Preview in Chrome', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'slide-notes-obsidian-md-'));
  try {
    const scripts = ['vendor/purify.js','obsidian-math.bundle.js','obsidian-markdown.bundle.js','editor.bundle.js'];
    for (const name of scripts) assert.ok(fs.existsSync(path.join(testPaths.STATIC_ROOT,name)), `Build required bundle: ${name}`);
    const url = name => 'file://' + path.join(testPaths.STATIC_ROOT,name);
    const styles = ['style.css','theme.css','code-cell.css','obsidian-markdown.css'].map(name => '<link rel="stylesheet" href="' + url(name) + '">').join('');
    const page = path.join(temporary,'test.html');
    const localMathStyles = 'ObsidianMath.installStyles();document.getElementById("obsidian-math-styles").textContent=document.getElementById("obsidian-math-styles").textContent.replaceAll("/vendor/mathjax",' + JSON.stringify(url('vendor/mathjax')) + ');';
    const scenarioSource = browserScenarios.toString().replace(/<\/script/gi, '<\\/script');
    fs.writeFileSync(page, '<!doctype html><meta charset="utf-8">' + styles + '<style>body{margin:32px;background:#fff}#showcase{max-width:720px;margin:auto}#result{font:10px monospace;white-space:pre-wrap;display:none}</style><main id="fixtures"></main><pre id="result">pending</pre>' + scripts.map(name => '<script src="' + url(name) + '"></script>').join('') + '<script>' + localMathStyles + '(' + scenarioSource + ')().catch(error=>document.querySelector("#result").textContent=JSON.stringify([{name:"fixture fatal",ok:false,error:error.stack}]))</script>');
    const chrome = process.env.CHROME_BIN || 'google-chrome';
    const screenshot = process.env.TEST_SCREENSHOT;
    const args = ['--headless','--no-sandbox','--disable-gpu','--no-first-run','--disable-background-networking','--user-data-dir=' + path.join(temporary,'profile'),'--allow-file-access-from-files','--window-size=1000,1400','--virtual-time-budget=8000','--dump-dom'];
    if (screenshot) args.push('--screenshot=' + (screenshot === '1' ? '/tmp/slide-notes-obsidian-md.png' : path.resolve(screenshot)));
    args.push('file://' + page);
    const run = spawnSync(chrome, args, {encoding:'utf8',timeout:45000,maxBuffer:8 * 1024 * 1024});
    if (run.error?.code === 'ENOENT') { t.skip('Chrome unavailable; set CHROME_BIN'); return; }
    assert.equal(run.status, 0, run.stderr);
    const match = run.stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/); assert.ok(match, 'Browser did not return scenario results');
    const decoded = match[1].replace(/&quot;/g,'"').replace(/&gt;/g,'>').replace(/&lt;/g,'<').replace(/&amp;/g,'&');
    let results;
    try { results = JSON.parse(decoded); }
    catch { throw Error('Browser scenarios did not complete: ' + decoded + '\n' + run.stderr.slice(-1500)); }
    assert.deepEqual(results.filter(result => !result.ok), []);
    assert.ok(results.length >= 30, 'Expected at least 30 independent browser scenarios');
    console.log('Verified ' + results.length + ' Obsidian Markdown browser scenarios.');
  } finally { fs.rmSync(temporary, {recursive:true,force:true}); }
});
