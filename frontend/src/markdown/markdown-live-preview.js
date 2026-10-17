import {EditorSelection, StateEffect, StateField} from '@codemirror/state';
import {Decoration, EditorView, ViewPlugin, WidgetType, keymap} from '@codemirror/view';
import {parser as markdownParser, GFM} from '@lezer/markdown';

// This is a new CM6 implementation. Source text remains the only editable
// document; preview decorations never become a second contenteditable surface.
const changeMarkdownMode = StateEffect.define();
const changePreviewFocus = StateEffect.define();
const changePointerSelection = StateEffect.define();
const parser = markdownParser.configure(GFM);
const modeField = StateField.define({
  create: () => 'live',
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(changeMarkdownMode)) value = effect.value;
    return value;
  },
});

export function setMarkdownMode(view, mode) {
  if (!view.state.field(modeField, false)) return false;
  view.dispatch({effects: changeMarkdownMode.of(mode === 'source' ? 'source' : 'live')});
  return true;
}

export function getMarkdownMode(view) {
  return view.state.field(modeField, false) || 'source';
}

function normalizeBlocks(source, resolve) {
  const supplied = resolve ? resolve(source) : null;
  const blocks = supplied || (() => {
    const result = [];
    for (let node = parser.parse(source).topNode.firstChild; node; node = node.nextSibling) {
      result.push({from: node.from, to: node.to, type: node.name});
    }
    return result;
  })();
  let previousEnd = 0;
  return blocks.filter(block => {
    if (!Number.isInteger(block.from) || !Number.isInteger(block.to) || block.from < previousEnd || block.to <= block.from || block.to > source.length) return false;
    previousEnd = block.to;
    return true;
  }).map(block => ({...block, source: source.slice(block.from, block.to)}));
}

function isComplex(block) {
  if (/^(paragraph|heading|ATXHeading[1-6]|SetextHeading[1-6]|Paragraph)$/i.test(block.type)) {
    // Renderer extensions that aren't part of the CommonMark syntax tree are
    // rendered as a whole, rather than approximated by regex decorations.
    return /!\[|!?\[\[|\$|==|%%|\[\^|<[^\s]|&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/i.test(block.source);
  }
  return true;
}

function selected(state, block, focused) {
  if (!focused) return false;
  return state.selection.ranges.some(range => range.empty
    ? range.head >= block.from && range.head <= block.to
    : range.from < block.to && range.to > block.from);
}

function sourceTextPosition(view, event) {
  // Mixed-font, wrapped text can confuse CM's rectangle scan: it may choose
  // the end of a text tile even while the pointer is over a Chinese character
  // earlier in that tile. Let the browser hit-test real editable text, then
  // map that DOM position back to the one authoritative source document.
  const doc = view.dom.ownerDocument;
  const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
  const range = caret ? null : doc.caretRangeFromPoint?.(event.clientX, event.clientY);
  const node = caret?.offsetNode || range?.startContainer;
  const offset = caret?.offset ?? range?.startOffset;
  if (!node || node.nodeType !== 3 || !view.contentDOM.contains(node) ||
      !node.parentElement.closest('.cm-line') ||
      node.parentElement.closest('.markdown-inline-math,.markdown-preview-block')) return null;
  const pos = view.posAtDOM(node, offset);
  // At a soft wrap the same offset has two visual caret locations. Preserve
  // the side on the row actually clicked instead of jumping to the other row.
  const before = view.coordsAtPos(pos, -1), after = view.coordsAtPos(pos, 1);
  const distance = rect => !rect ? Infinity : Math.max(rect.top - event.clientY, event.clientY - rect.bottom, 0);
  return {pos, assoc: distance(before) < distance(after) ? -1 : 1};
}

function renderedMathPosition(view, event, geometry) {
  const target = view.dom.ownerDocument.elementFromPoint(event.clientX, event.clientY);
  const box = target?.closest('.markdown-inline-math,.markdown-preview-block');
  if (!box || !view.contentDOM.contains(box)) return null;
  const container = target.closest('mjx-container') || target.closest('.math-block')?.querySelector('mjx-container');
  if (!box.classList.contains('markdown-inline-math') && !container) return null;
  const mapped = target.closest('[data-math-from][data-math-to]');
  const from = Number(box.dataset.markdownFrom), to = Number(box.dataset.markdownTo);
  if (mapped && !mapped.querySelector('[data-math-from]')) {
    const at = from + Number(mapped.dataset.mathFrom);
    if (Number.isInteger(at) && at >= from && at < to) return at;
  }
  if (container) {
    // Empty space between glyphs hits an mrow/math wrapper whose source range
    // covers the whole formula. Using that wrapper's start makes a growing
    // selection jump back to zero. Resolve the nearest actual glyph boundary.
    // Geometry is measured once per gesture and translated during scrolling.
    let measured = geometry.get(container);
    const origin = container.getBoundingClientRect();
    if (!measured) {
      measured = {left: origin.left, top: origin.top, glyphs: [...container.querySelectorAll('[data-math-from][data-math-to]')]
        .filter(node => !node.querySelector('[data-math-from]'))
        .map(node => ({from: from + Number(node.dataset.mathFrom), to: from + Number(node.dataset.mathTo), rect: node.getBoundingClientRect()}))
        .filter(glyph => glyph.rect.width > 0 && glyph.rect.height > 0 && glyph.from >= from && glyph.to <= to)};
      geometry.set(container, measured);
    }
    const x = event.clientX - (origin.left - measured.left), y = event.clientY - (origin.top - measured.top);
    let nearest = null, distance = Infinity;
    for (const glyph of measured.glyphs) {
      const rect = glyph.rect, dx = Math.max(rect.left - x, 0, x - rect.right), dy = Math.max(rect.top - y, 0, y - rect.bottom);
      const score = dx * dx + dy * dy;
      if (score < distance) { nearest = glyph; distance = score; }
    }
    if (nearest) return x > nearest.rect.right ? nearest.to : nearest.from;
  }
  // Empty space around a formula belongs to its nearest source boundary.
  const rect = box.getBoundingClientRect();
  return event.clientX < (rect.left + rect.right) / 2 ? from : to;
}

function revealPosition(view, block, event, element) {
  // MathJax glyphs already carry exact UTF-16 provenance. A rendered symbol
  // is not a prose word (e.g. ∇ comes from \nabla), so never estimate its
  // source position from the paragraph's line geometry.
  const mapped=event.target.closest?.('[data-math-from][data-math-to]');
  if(mapped&&element.contains(mapped)){
    const from=Number(mapped.dataset.mathFrom),to=Number(mapped.dataset.mathTo);
    if(Number.isInteger(from)&&Number.isInteger(to)&&from>=0&&from<to&&block.from+to<=block.to){
      view.dispatch({effects:changePreviewFocus.of(true),selection:{anchor:block.from+from}});view.focus();return;
    }
  }
  const source = view.state.sliceDoc(block.from, block.to);
  const rect = element.getBoundingClientRect();
  const lines = source.split('\n');
  const index = Math.min(lines.length - 1, Math.max(0, Math.floor((event.clientY - rect.top) / Math.max(rect.height, 1) * lines.length)));
  let offset = lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0);
  // Prefer the clicked word over a geometric estimate. This works for headings,
  // lists and tables without trying to reconstruct source from rendered HTML.
  const document = element.ownerDocument;
  const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
  const legacy = !caret && document.caretRangeFromPoint?.(event.clientX, event.clientY);
  const node = caret?.offsetNode || legacy?.startContainer;
  const nodeOffset = caret?.offset ?? legacy?.startOffset;
  if (node?.nodeType === 3 && element.contains(node)) {
    const text = node.textContent || '';
    const before = text.slice(0, nodeOffset).match(/\S*$/)?.[0] || '';
    const after = text.slice(nodeOffset).match(/^\S*/)?.[0] || '';
    const word = before + after;
    const lineOffset = word ? lines[index].indexOf(word) : -1;
    const sourceOffset = word ? source.indexOf(word, offset) : -1;
    if (lineOffset >= 0) offset += lineOffset + before.length;
    else if (sourceOffset >= 0) offset = sourceOffset + before.length;
  }
  const anchor = Math.max(block.from, Math.min(block.to, block.from + offset));
  view.dispatch({effects: changePreviewFocus.of(true), selection: {anchor}, scrollIntoView: true});
  view.focus();
}

export function markdownLivePreview({markdownBlocks, renderMarkdown, bindMarkdownPreview, markdownMode = 'live', onMarkdownModeChange} = {}) {
  let cachedSource = null, cachedBlocks = [];
  let pointerSelection = null;
  const pendingReveals = new Set();
  const cancelReveals = () => { for (const timer of pendingReveals) clearTimeout(timer); pendingReveals.clear(); };
  const blocksFor = source => {
    if (source !== cachedSource) {
      cachedSource = source;
      cachedBlocks = normalizeBlocks(source, markdownBlocks).map(block => {
        // Keep prose formatting independent of TeX punctuation. Masking retains
        // UTF-16 offsets while preventing e.g. x_k from starting emphasis.
        let prose = block.source;
        for (const range of block.inlineMath || []) {
          const from = range.from - block.from, to = range.to - block.from;
          prose = prose.slice(0, from) + prose.slice(from, to).replace(/[^\n\r]/g, 'x') + prose.slice(to);
        }
        return {...block, tree: parser.parse(prose), proseComplex: isComplex({...block, source: prose})};
      });
    }
    return cachedBlocks;
  };
  const mathNodes = new WeakMap();
  function highlightMathSource(view) {
    const active = new Set(), rendered = new Set();
    const apply = (className, desired) => {
      for (const old of view.dom.querySelectorAll('.' + className)) if (!desired.has(old)) old.classList.remove(className);
      for (const node of desired) if (!node.classList.contains(className)) node.classList.add(className);
    };
    if(!view.hasFocus||getMarkdownMode(view)!=='live') {
      apply('math-source-active', active); apply('math-rendered-selection', rendered); return;
    }
    const selection=view.state.selection.main;
    for(const box of view.dom.querySelectorAll('.markdown-preview-block,.markdown-inline-math')) {
      const editing = box.classList.contains('markdown-math-edit-preview');
      if (!editing && selection.empty) continue;
      if (selection.to < Number(box.dataset.markdownFrom) || selection.from > Number(box.dataset.markdownTo)) continue;
      const offset=Number(box.dataset.markdownFrom),from=selection.from-offset,to=selection.to-offset;
      let nodes=mathNodes.get(box);
      if (!nodes) { nodes=[...box.querySelectorAll('[data-math-from][data-math-to]')].filter(node=>node.tagName.toLowerCase()!=='mjx-math'); mathNodes.set(box,nodes); }
      let matches=nodes.filter(node=>{const a=Number(node.dataset.mathFrom),b=Number(node.dataset.mathTo);return selection.empty?from>=a&&from<b:from<b&&to>a;});
      if(selection.empty) {
        if(!matches.length&&from>0&&!/[$\s]/.test(view.state.doc.sliceString(selection.head-1,selection.head)))matches=nodes.filter(node=>Number(node.dataset.mathFrom)<from&&Number(node.dataset.mathTo)===from);
        matches.sort((a,b)=>(Number(a.dataset.mathTo)-Number(a.dataset.mathFrom))-(Number(b.dataset.mathTo)-Number(b.dataset.mathFrom))|| (a.contains(b)?1:b.contains(a)?-1:0));
        matches=matches.slice(0,1);
      }else {
        // Avoid comparing every selected MathJax node with every other node.
        // Ancestor removal is linear in selected nodes times tree depth.
        const selected = new Set(matches), ancestors = new Set();
        for (const node of matches) for (let parent=node.parentElement; parent&&parent!==box; parent=parent.parentElement)
          if (selected.has(parent)) ancestors.add(parent);
        matches=matches.filter(node=>!ancestors.has(node));
      }
      for(const node of matches)(editing ? active : rendered).add(node);
    }
    // A drag usually changes just the endpoint. Retain the existing fill on
    // unchanged glyphs instead of removing/readding all their classes per move.
    apply('math-source-active', active); apply('math-rendered-selection', rendered);
  }
  class MarkdownBlock extends WidgetType {
    constructor(block, documentSource, editingMath = false, inline = false) { super(); this.block = block; this.documentSource = documentSource; this.editingMath = editingMath; this.inline = inline; }
    eq(other) {
      return this.block.from === other.block.from && this.block.to === other.block.to && this.block.source === other.block.source && this.documentSource === other.documentSource && this.editingMath === other.editingMath && this.inline === other.inline;
    }
    toDOM(view) {
      const box = document.createElement(this.inline ? 'span' : 'div');
      box.className = (this.inline ? 'markdown-inline-math' : 'markdown-preview-block') + ' obsidian-markdown' + (this.editingMath ? ' markdown-math-edit-preview' : '');
      box.dataset.markdownFrom = String(this.block.from);
      box.dataset.markdownTo = String(this.block.to);
      box.setAttribute('aria-label', this.editingMath ? (this.block.type==='math'?'当前公式的实时排版预览，点击符号定位源码':'当前段落的实时排版预览，点击文字或公式定位源码') : 'Markdown 实时预览，点击编辑源码');
      box.innerHTML = renderMarkdown(this.block.source, this.documentSource, this.block.from);
      if (this.inline) {
        const formula = box.querySelector('.math-inline');
        if (formula) box.replaceChildren(formula);
      }
      if (bindMarkdownPreview && !this.inline) bindMarkdownPreview(box, {
        read: () => this.block.source,
        documentSource: () => view.state.doc.toString(),
        enabled: () => !view.state.readOnly,
        measure: () => view.requestMeasure(),
        commit: change => {
          if (view.state.readOnly || view.state.sliceDoc(this.block.from, this.block.to) !== this.block.source) return;
          if (!Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < 0 || change.to < change.from || change.to > this.block.source.length || typeof change.insert !== 'string') return;
          view.dispatch({changes: {from: this.block.from + change.from, to: this.block.from + change.to, insert: change.insert}, userEvent: 'input'});
        },
      });
      let press = null;
      const moved = event => {
        if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) press.moved = true;
      };
      const stopTracking = () => {
        box.ownerDocument.removeEventListener('mousemove', moved);
        box.ownerDocument.removeEventListener('mouseup', stopTracking);
      };
      this.stopTracking = stopTracking;
      box.addEventListener('mousedown', event => {
        clearTimeout(this.clickTimer); pendingReveals.delete(this.clickTimer);
        if (this.inline || event.button !== 0) return;
        stopTracking();
        press = {x: event.clientX, y: event.clientY, moved: false};
        box.ownerDocument.addEventListener('mousemove', moved);
        box.ownerDocument.addEventListener('mouseup', stopTracking);
      });
      box.addEventListener('click', event => {
        // Inline formulas participate in CM's native pointer selection. Other
        // widgets reveal source only after a genuine single click, leaving
        // browser drag selection, Shift and multiple clicks intact.
        if (this.inline) return;
        if (press?.moved || event.defaultPrevented || event.detail > 1 || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || view.state.readOnly) return;
        // Links and checkboxes retain their renderer interaction. All other
        // preview clicks reveal the source in the same native CM document.
        if (event.target.closest?.('a,button,input,summary,[data-markdown-interactive]')) return;
        const selection = box.ownerDocument.getSelection();
        if (selection && !selection.isCollapsed && Array.from({length: selection.rangeCount}, (_, index) => selection.getRangeAt(index)).some(range => range.intersectsNode(box))) return;
        cancelReveals();
        this.clickTimer = setTimeout(() => {
          pendingReveals.delete(this.clickTimer);
          if (box.isConnected && !event.defaultPrevented) revealPosition(view, this.block, event, box);
        }, 150);
        pendingReveals.add(this.clickTimer);
      });
      box.addEventListener('load', () => view.requestMeasure(), true);
      return box;
    }
    destroy() { clearTimeout(this.clickTimer); pendingReveals.delete(this.clickTimer); this.stopTracking?.(); }
    ignoreEvent(event) {
      if (event.target.closest?.('a,button,input,summary,[data-markdown-interactive]')) return true;
      return !this.inline && !(event.type === 'mousedown' && event.target.closest?.('mjx-container'));
    }
  }

  function decorations(state, focused) {
    if (!renderMarkdown) return Decoration.none;
    const sourceOnly = state.field(modeField) === 'source';
    const ranges = [];
    const source = state.doc.toString();
    const addMark = (from, to, className, attributes) => {
      if (to > from) ranges.push(Decoration.mark({class: className, attributes}).range(from, to));
    };
    const hide = (from, to) => { if (to > from) ranges.push(Decoration.replace({}).range(from, to)); };
    const markMath = block => {
      const end = block.from + block.source.trimEnd().length;
      addMark(block.from, end, 'md-math-source');
      for (const match of block.source.matchAll(/\\(?:[a-zA-Z]+|[^\s])|\$+|[{}_^&]|\d+(?:\.\d*)?/g)) {
        const value=match[0],className=value.startsWith('\\')?'md-math-command':value.startsWith('$')?'md-math-delimiter':/^\d/.test(value)?'md-math-number':'md-math-punctuation';
        addMark(block.from+match.index,block.from+match.index+value.length,className);
      }
    };
    for (const block of blocksFor(source)) {
      const active = selected(state, block, focused);
      const math = block.type === 'math';
      const inlineMath=block.inlineMath||[];
      const markInlineMath=()=>{for(const range of inlineMath)markMath({...range,source:source.slice(range.from,range.to)});};
      if (sourceOnly) { if(math)markMath(block);else markInlineMath(); continue; }
      // Prose must always remain real CM text, including the first click in an
      // unfocused paragraph. A whole-paragraph widget can only guess word/line
      // offsets and breaks on wrapped or repeated Chinese text.
      const nativeInline = inlineMath.length > 0 && !math && !block.proseComplex && /^(paragraph|heading)$/i.test(block.type);
      const inlineEditing = nativeInline || (active && inlineMath.length > 0 && !math);
      if (inlineEditing) for (const range of inlineMath) {
        const formula = {...range, source: source.slice(range.from, range.to)};
        // Editing a prose block has one stable, native source surface. Revealing
        // formulas one at a time leaves noneditable islands in the sentence and
        // changes its shape as the selection crosses each island.
        if (active) markMath(formula);
        else ranges.push(Decoration.replace({widget: new MarkdownBlock(formula, source, false, true)}).range(range.from, range.to));
      }
      if (isComplex(block) && !nativeInline) {
        if (!active) ranges.push(Decoration.replace({widget: new MarkdownBlock(block, source), block: true}).range(block.from, block.to));
        else {
          if(math){
            markMath(block);
            // Only standalone display math has a separate live result. Inline
            // formulas stay in their sentence on the native editing surface.
            ranges.push(Decoration.widget({widget:new MarkdownBlock(block,source,true),block:true,side:1}).range(block.from+block.source.trimEnd().length));
          }
          for (let position = state.doc.lineAt(block.from).from; position <= block.to;) {
            ranges.push(Decoration.line({class: 'md-active-block'}).range(position));
            const line = state.doc.lineAt(position);
            if (line.to >= block.to || line.to >= state.doc.length) break;
            position = line.to + 1;
          }
        }
        continue;
      }
      const heading = /^(?:#{1,6})\s/.exec(block.source)?.[0].trim().length || (/^.+\n(?:=+|-+)\s*$/s.test(block.source) ? (/\n=/.test(block.source) ? 1 : 2) : 0);
      if (heading) ranges.push(Decoration.line({class: `HyperMD-header HyperMD-header-${heading} md-heading md-heading-${heading}${active ? ' md-active-block' : ''}`}).range(state.doc.lineAt(block.from).from));
      else if (active) ranges.push(Decoration.line({class: 'md-active-block'}).range(state.doc.lineAt(block.from).from));
      block.tree.iterate({enter(node) {
        const from = block.from + node.from, to = block.from + node.to;
        const name = node.name;
        if (/^(HeaderMark|EmphasisMark|StrikethroughMark|CodeMark|LinkMark)$/.test(name)) {
          if (active) addMark(from, to, 'md-formatting');
          else if (name === 'HeaderMark' && node.from === 0) hide(from, to + (source[to] === ' ' ? 1 : 0));
          else hide(from, to);
        } else if (name === 'StrongEmphasis') addMark(from, to, 'cm-strong md-strong');
        else if (name === 'Emphasis') addMark(from, to, 'cm-em md-emphasis');
        else if (name === 'Strikethrough') addMark(from, to, 'cm-strikethrough md-strikethrough');
        else if (name === 'InlineCode') addMark(from, to, 'cm-inline-code md-inline-code');
        else if (name === 'Link') {
          const url = node.node.getChild('URL');
          const href = url ? block.source.slice(url.from, url.to).replace(/^<|>$/g, '') : '';
          addMark(from, to, 'cm-link md-link', href ? {'data-md-href': href} : undefined);
          if (!active) {
            const marks = node.node.getChildren('LinkMark');
            if (marks.length > 1) hide(block.from + marks[1].from, to);
          }
        } else if (name === 'URL' && node.node.parent?.name === 'Link' && !active) return false;
        else if (name === 'Escape' && !active) hide(from, from + 1);
      }});
    }
    // Links contribute an outer hidden destination plus token ranges inside it.
    // A replacement's hidden descendants are redundant and must not overlap.
    const replacements = ranges.filter(range => range.value.spec.widget === undefined && range.value.spec.class === undefined && range.from < range.to);
    const unique = ranges.filter(range => range.from === range.to || !replacements.some(other => other !== range && other.from <= range.from && other.to >= range.to && (other.from < range.from || other.to > range.to)));
    return Decoration.set(unique, true);
  }

  const previewField = StateField.define({
    create(state) { return {focused: false, pointer: false, decorations: decorations(state, false)}; },
    update(value, transaction) {
      let focused = value.focused, pointer = value.pointer, changed = false, modeChanged = false;
      for (const effect of transaction.effects) {
        if (effect.is(changePreviewFocus)) {
          // Focusing the surrounding contenteditable while selecting a widget
          // must not reveal the editor's old cursor position under the mouse.
          if (pointer !== 'widget' || !effect.value) focused = effect.value;
          changed = true;
        }
        if (effect.is(changePointerSelection)) { pointer = effect.value; changed = true; }
        if (effect.is(changeMarkdownMode)) { changed = true; modeChanged = true; }
      }
      if (!transaction.docChanged && !transaction.selection && !changed) return value;
      // A drag uses screen coordinates measured in the starting layout. Keep
      // replacements/formatting stable until mouseup, then reveal the selected
      // source. Never hold stale decorations across document or mode changes.
      if (pointer && !transaction.docChanged && !modeChanged)
        return {focused, pointer, decorations: value.decorations};
      return {focused, pointer: !transaction.docChanged && !modeChanged ? pointer : false, decorations: decorations(transaction.state, focused)};
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  });
  return [
    modeField.init(() => markdownMode === 'source' ? 'source' : 'live'),
    previewField,
    ViewPlugin.fromClass(class {
      constructor(view) {
        this.view = view; this.destroyed = false;
        this.finish = () => this.end(); this.press = event => this.start(event);
        // Capture also covers rendered block widgets, which deliberately let
        // the browser handle drag selection rather than forwarding it to CM.
        view.dom.addEventListener('mousedown', this.press, true);
      }
      start(event) {
        cancelReveals();
        if (event.button !== 0 || getMarkdownMode(this.view) !== 'live' || event.target.closest?.('a,button,input,summary,[data-markdown-interactive]')) return false;
        this.removeListeners();
        pointerSelection = null;
        const widget = event.target.closest?.('.markdown-preview-block');
        this.mathDrag = !!widget && !!event.target.closest?.('mjx-container') && event.detail <= 1;
        this.view.dispatch({effects: widget ? changePointerSelection.of('widget') : [changePointerSelection.of(true), changePreviewFocus.of(this.view.hasFocus)]});
        this.view.dom.ownerDocument.addEventListener('mouseup', this.finish);
        this.view.win.addEventListener('blur', this.finish);
        this.view.dom.ownerDocument.addEventListener('pointercancel', this.finish);
        return false;
      }
      removeListeners() {
        this.view.dom.ownerDocument.removeEventListener('mouseup', this.finish);
        this.view.win.removeEventListener('blur', this.finish);
        this.view.dom.ownerDocument.removeEventListener('pointercancel', this.finish);
      }
      end() {
        this.removeListeners();
        const revealSelection = this.mathDrag && pointerSelection && !pointerSelection.main.empty;
        // CM may finalize a click inside the existing selection on mouseup.
        // Apply live-preview changes only after that native handler completes.
        queueMicrotask(() => {
          if (!this.destroyed && this.view.state.field(previewField).pointer) {
            // Once the drag finishes, revealing the selected source also gives
            // the browser a real DOM range for copy and subsequent key input.
            this.view.dispatch({effects: revealSelection ? [changePointerSelection.of(false), changePreviewFocus.of(true)] : changePointerSelection.of(false)});
          }
          pointerSelection = null;
        });
      }
      destroy() { this.destroyed = true; cancelReveals(); this.removeListeners(); this.view.dom.removeEventListener('mousedown', this.press, true); }
    }),
    EditorView.mouseSelectionStyle.of((view, event) => {
      if (event.button !== 0 || getMarkdownMode(view) !== 'live') return null;
      // Compiled glyphs use source provenance; editable prose uses the
      // browser's character hit-test instead of matching word strings.
      let geometry = new WeakMap();
      const mathStart = renderedMathPosition(view, event, geometry);
      const type = event.detail || 1;
      const sourceHit = mathStart === null && type === 1 ? sourceTextPosition(view, event) : null;
      // Do not replace ordinary native source dragging just to fix an isolated
      // coordinate error. Only adapt a press when CM actually disagrees with
      // the browser's character hit-test (notably the last wrapped text tile).
      const sourceStart = sourceHit && sourceHit.pos !== view.posAtCoords({x:event.clientX,y:event.clientY},false) ? sourceHit : null;
      // Keep CM's gesture lifecycle, native DOM selection, existing-selection
      // dragging and multi-click behavior. Single source clicks only replace
      // its coordinate hit-test; compiled glyphs additionally need provenance.
      if (mathStart === null && sourceStart === null) return null;
      let start = mathStart ?? sourceStart.pos, initial = view.state.selection;
      const point = current => {
        // A gesture beginning in prose still treats a compiled inline widget
        // as one source unit, just like CM's native selection. Glyph-level
        // provenance is reserved for gestures beginning on compiled math.
        const math = mathStart !== null ? renderedMathPosition(view, current, geometry) : null;
        return math !== null ? {pos: math, assoc: 0} : sourceTextPosition(view, current) ||
          {pos: view.posAtCoords({x: current.clientX, y: current.clientY}, false), assoc: 0};
      };
      const rangeAt = at => type === 2 ? (view.state.wordAt(at) || EditorSelection.range(at, Math.min(at + 1, view.state.doc.length))) : type >= 3 ? (() => {
        const line = view.state.doc.lineAt(at);
        return EditorSelection.range(line.from, Math.min(line.to + 1, view.state.doc.length));
      })() : EditorSelection.cursor(at);
      return {
        get(current, extend, multiple) {
          const keep = selection => { pointerSelection = selection; return selection; };
          const {pos: end, assoc} = point(current), first = rangeAt(start), last = rangeAt(end);
          const range = end < start ? EditorSelection.range(first.to, last.from, undefined, undefined, assoc) : EditorSelection.range(first.from, last.to, undefined, undefined, assoc);
          if (extend) return keep(initial.replaceRange(initial.main.extend(range.from, range.to, assoc)));
          if (multiple) {
            if (type === 1 && initial.ranges.length > 1) {
              const existing = initial.ranges.findIndex(item => item.from <= end && item.to >= end);
              if (existing >= 0) return keep(EditorSelection.create(initial.ranges.filter((_, index) => index !== existing), Math.max(0, initial.mainIndex - (existing <= initial.mainIndex ? 1 : 0))));
            }
            return keep(initial.addRange(range));
          }
          return keep(EditorSelection.create([range]));
        },
        update(update) {
          if (update.docChanged) { start = update.changes.mapPos(start); initial = initial.map(update.changes); geometry = new WeakMap(); }
        },
      };
    }),
    EditorView.editorAttributes.compute([modeField, previewField], state => {
      const preview = state.field(previewField), main = state.selection.main;
      let nativeSelection = state.selection.ranges.length === 1;
      // CM's painted range uses its coordinate scanner to find wrapped row
      // edges. On mixed-font source that can paint a narrow vertical strip
      // despite a correct DOM selection. Paint real source with ::selection;
      // keep widget provenance highlighting and multiple-range drawing intact.
      if (nativeSelection && !main.empty) preview.decorations.between(main.from, main.to, (from, to, decoration) => {
        if (from < main.to && to > main.from && decoration.spec.widget) nativeSelection = false;
      });
      return {class:
        (state.field(modeField) === 'live' ? 'markdown-live-preview obsidian-markdown is-live-preview' : 'markdown-source-view obsidian-markdown') +
        (preview.pointer === 'widget' ? ' markdown-widget-selecting' : '') +
        (nativeSelection ? ' markdown-native-selection' : '')};
    }),
    EditorView.domEventHandlers({
      focus(event, view) { view.dispatch({effects: changePreviewFocus.of(true)}); return false; },
      blur(event, view) { view.dispatch({effects: changePreviewFocus.of(false)}); return false; },
      click(event, view) {
        const link = event.target.closest?.('[data-md-href]');
        if (!link || !(event.ctrlKey || event.metaKey)) return false;
        event.preventDefault();
        if (/^\s*(?:javascript|vbscript|data):/i.test(link.dataset.mdHref)) return true;
        view.dom.dispatchEvent(new CustomEvent('obsidian-open-link', {bubbles: true, detail: {href: link.dataset.mdHref}}));
        return true;
      },
    }),
    keymap.of([{key: 'Ctrl-q', preventDefault: true, run: view => view.composing ? false : setMarkdownMode(view, getMarkdownMode(view) === 'live' ? 'source' : 'live')}]),
    EditorView.updateListener.of(update => {
      if(update.docChanged||update.selectionSet||update.focusChanged||update.transactions.some(transaction=>transaction.effects.some(effect=>effect.is(changePreviewFocus)||effect.is(changeMarkdownMode)||effect.is(changePointerSelection))))highlightMathSource(update.view);
      if (onMarkdownModeChange && update.startState.field(modeField) !== update.state.field(modeField)) onMarkdownModeChange(update.state.field(modeField), update.view);
    }),
  ];
}
