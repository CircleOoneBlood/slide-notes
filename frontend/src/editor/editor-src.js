import {EditorState} from '@codemirror/state';
import {EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands';
import {foldGutter, indentOnInput, bracketMatching, syntaxHighlighting, HighlightStyle, indentUnit} from '@codemirror/language';
import {python} from '@codemirror/lang-python';
import {markdown} from '@codemirror/lang-markdown';
import {html} from '@codemirror/lang-html';
import {tags, highlightTree, classHighlighter} from '@lezer/highlight';
import {javascriptLanguage} from '@codemirror/lang-javascript';
import {cssLanguage} from '@codemirror/lang-css';
import {markdownLivePreview} from '../markdown/markdown-live-preview.js';
export {setMarkdownMode, getMarkdownMode} from '../markdown/markdown-live-preview.js';

const colors=HighlightStyle.define([
  {tag:tags.heading,color:'#4774a9',fontWeight:'bold'},
  {tag:tags.strong,fontWeight:'bold'},
  {tag:tags.emphasis,fontStyle:'italic'},
  {tag:[tags.link,tags.url],color:'#246bf0'},
  {tag:tags.monospace,color:'#17814a'},
  {tag:tags.comment,color:'#8794a7'},
  {tag:tags.keyword,color:'#8300b5'},
  {tag:[tags.operator,tags.punctuation],color:'#8455ef'},
  {tag:tags.number,color:'#087f83'},
  {tag:[tags.string,tags.docString],color:'#17814a'},
  {tag:[tags.function(tags.variableName),tags.function(tags.propertyName)],color:'#246bf0'},
  {tag:tags.definition(tags.variableName),color:'#142039'},
  {tag:tags.variableName,color:'#142039'},
  {tag:[tags.bool,tags.null,tags.className],color:'#ab4a18'},
]);
const theme=EditorView.theme({
  '&':{fontFamily:'var(--code-font)',fontSize:'14px',backgroundColor:'#fff',color:'#172138'},
  '&.cm-focused':{outline:'none'},
  '.cm-scroller':{fontFamily:'inherit',lineHeight:'1.6',maxHeight:'520px',overflow:'auto'},
  '.cm-content':{padding:'9px 0 15px',minHeight:'54px',caretColor:'#203044'},
  '.cm-line':{padding:'0 12px 0 8px'},
  '.cm-gutters':{backgroundColor:'#fff',color:'#919baa',border:'none',paddingLeft:'5px'},
  '.cm-lineNumbers':{minWidth:'34px'},
  '.cm-lineNumbers .cm-gutterElement':{padding:'0 7px 0 5px'},
  '.cm-foldGutter':{borderRight:'1px solid #dce0e6',width:'14px'},
  '.cm-foldGutter .cm-gutterElement':{padding:'0 3px 0 0',cursor:'pointer'},
  '.cm-activeLineGutter':{backgroundColor:'transparent',color:'#5579a7'},
  '.cm-selectionBackground,&.cm-focused .cm-selectionBackground':{backgroundColor:'#dce9ff'},
  '.cm-matchingBracket':{backgroundColor:'#e7edf8',outline:'1px solid #bbcae1'},
  '.cm-foldPlaceholder':{backgroundColor:'#f3f5fa',color:'#7890b2',border:'1px solid #dbe2ed',borderRadius:'3px'},
});

const markdownColors=HighlightStyle.define([
  {tag:tags.heading,class:'md-heading-text'},
  {tag:tags.strong,class:'md-strong'},
  {tag:tags.emphasis,class:'md-emphasis'},
  {tag:tags.strikethrough,class:'md-strikethrough'},
  {tag:[tags.link,tags.url],class:'md-link'},
  {tag:tags.monospace,class:'md-inline-code'},
  {tag:[tags.processingInstruction,tags.meta],class:'md-formatting'},
]);
const markdownTheme=EditorView.theme({
  '&':{fontFamily:'var(--font-text, var(--ui-font, sans-serif))',fontSize:'var(--font-text-size, 16px)',color:'var(--text-normal, #222)',backgroundColor:'transparent'},
  '.cm-scroller':{lineHeight:'var(--line-height-normal, 1.5)',maxHeight:'none'},
  '.cm-content':{padding:'0',minHeight:'1.5em',caretColor:'var(--text-normal, #222)'},
  '.cm-line':{padding:'0'},
  '.md-formatting':{color:'var(--text-faint, #ababab)'},
  '.md-strong':{fontWeight:'var(--bold-weight, 700)'},
  '.md-emphasis':{fontStyle:'italic'},
  '.md-strikethrough':{textDecoration:'line-through'},
  '.md-link':{color:'var(--link-color, #705dcf)',textDecoration:'underline'},
  '.md-inline-code':{fontFamily:'var(--font-monospace, var(--code-font, monospace))',fontSize:'var(--code-size, .875em)',backgroundColor:'var(--code-background, #f7f7f7)',borderRadius:'4px'},
  '.md-heading':{fontFamily:'var(--font-text, var(--ui-font, sans-serif))',fontWeight:'var(--heading-weight, 600)',lineHeight:'var(--line-height-tight, 1.3)',paddingTop:'var(--p-spacing, 1rem)'},
  '.md-heading-1':{fontSize:'var(--h1-size, 1.618em)'},
  '.md-heading-2':{fontSize:'var(--h2-size, 1.462em)'},
  '.md-heading-3':{fontSize:'var(--h3-size, 1.318em)'},
  '.md-heading-4':{fontSize:'var(--h4-size, 1.188em)'},
  '.md-heading-5':{fontSize:'var(--h5-size, 1.076em)'},
  '.md-heading-6':{fontSize:'var(--h6-size, 1em)'},
  '&.markdown-source-view':{fontFamily:'var(--font-monospace, var(--code-font, monospace))'},
  '.markdown-preview-block':{whiteSpace:'normal',overflowWrap:'anywhere'},
});

export function create({parent,source,label,language="python",readonly=false,onChange,onRun,onBlur,onUpdate,markdownBlocks,renderMarkdown,bindMarkdownPreview,markdownMode='live',onMarkdownModeChange}) {
  return new EditorView({parent,state:EditorState.create({doc:source,extensions:[
    language==='markdown'?[EditorState.allowMultipleSelections.of(true),markdownLivePreview({markdownBlocks,renderMarkdown,bindMarkdownPreview,markdownMode,onMarkdownModeChange})]:[],
    language==='markdown'?[]:[lineNumbers(),highlightActiveLineGutter(),foldGutter()],history(),drawSelection(),
    indentOnInput(),indentUnit.of('    '),bracketMatching(),language === "markdown" ? [markdown({codeLanguages:info=>/^(py|python|python3)$/i.test(info)?python().language:/^(js|javascript|jsx|json)$/i.test(info)?javascriptLanguage:/^css$/i.test(info)?cssLanguage:/^html$/i.test(info)?html().language:null}),EditorView.lineWrapping] : language === 'html' ? html() : python(),syntaxHighlighting(language==='markdown'?markdownColors:colors),theme,language==='markdown'?markdownTheme:[],
    EditorState.readOnly.of(readonly),EditorView.editable.of(!readonly),
    EditorView.contentAttributes.of({'aria-label':label,'aria-multiline':'true',role:'textbox',spellcheck:'false'}),
    keymap.of([{key:'Shift-Enter',run:view=>{if(language==='markdown'){if(!readonly)view.dispatch(view.state.replaceSelection('\n'),{scrollIntoView:true,userEvent:'input'});return true;}if(!readonly)onRun?.();return true;}},indentWithTab,...defaultKeymap,...historyKeymap]),
    EditorView.updateListener.of(update=>{if(update.docChanged)onChange?.(update.state.doc.toString());if(onUpdate&&(update.docChanged||update.selectionSet||update.focusChanged||update.viewportChanged))onUpdate(update.view,update.focusChanged);}),
    EditorView.domEventHandlers({blur:()=>{onBlur?.();return false;}}),
  ]})});
}

export function highlightCode(source,language){
  const parser=/^(py|python|python3)$/i.test(language)?python().language.parser:
    /^(js|javascript|jsx|ts|typescript|json)$/i.test(language)?javascriptLanguage.parser:
    /^(html|xml)$/i.test(language)?html().language.parser:/^css$/i.test(language)?cssLanguage.parser:null;
  const escape=text=>text.replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
  if(!parser)return escape(source);
  let result='',cursor=0;
  highlightTree(parser.parse(source),classHighlighter,(from,to,classes)=>{
    result+=escape(source.slice(cursor,from))+'<span class="'+classes+'">'+escape(source.slice(from,to))+'</span>';cursor=to;
  });
  return result+escape(source.slice(cursor));
}

