// Trace the pinned MathJax 3.2 TeX parser without inserting commands into TeX
// or changing its MathML tree. Offsets are UTF-16 positions in the input.
export function traceMathSource(options) {
  let active = null;
  const push = options.pushParser;
  const factory = options.nodeFactory;
  const create = factory.create;
  const span = units => units.length ? [Math.min(...units.map(u=>u[0])),Math.max(...units.map(u=>u[1]))] : null;
  const range = (parser,from,to) => span(parser.noteSource.units.slice(from,to));
  const mark = (node,where) => {
    if(node?.attributes && where && where[1]>where[0]) {
      node.attributes.set('data-tex-from',where[0]);node.attributes.set('data-tex-to',where[1]);
    }
  };
  options.pushParser = function(parser) {
    const parent=this.parser;
    push.call(this,parser);
    if(!active)return;
    let units;
    if(!parent) units=Array.from({length:parser.string.length},(_,i)=>[i,i+1]);
    else {
      const candidates=parent.noteSource?.arguments||[];
      for(let i=candidates.length-1;i>=0;i--) {
        const candidate=candidates[i],at=candidate.value.indexOf(parser.string);
        if(!candidate.used && at>=0 && parser.string.length){units=candidate.units.slice(at,at+parser.string.length);candidate.used=true;break;}
      }
      const origin=parent.noteSource?.frames.at(-1)?.origin;
      units ||= Array.from({length:parser.string.length},()=>origin||[0,active.length]);
    }
    parser.noteSource={units,frames:[],arguments:[]};
    const parse=parser.parse,getArgument=parser.GetArgument;
    parser.parse=function(kind,input) {
      if(kind!=='character')return parse.call(this,kind,input);
      const from=this.i-String(input[1]).length;
      const frame={origin:range(this,from,this.i),from};this.noteSource.frames.push(frame);
      try{return parse.call(this,kind,input);}
      finally{this.noteSource.frames.pop();}
    };
    parser.GetArgument=function(...args) {
      let from=this.i;while(/\s/.test(this.string[from]||'')&&from<this.string.length)from++;
      const braced=this.string[from]==='{',value=getArgument.apply(this,args);
      if(typeof value==='string') {
        const start=from+(braced?1:0),end=this.i-(braced?1:0);
        let mapped=this.noteSource.units.slice(start,end);
        if(mapped.length!==value.length)mapped=Array.from({length:value.length},()=>range(this,from,this.i)||[0,active.length]);
        this.noteSource.arguments.push({value,units:mapped,used:false});
      }
      return value;
    };
    Object.defineProperty(parser,'string',{
      get(){return this._string;},
      set(value){
        const previous=this._string,old=this.noteSource.units;let prefix=0,suffix=0;
        while(prefix<previous.length&&prefix<value.length&&previous[prefix]===value[prefix])prefix++;
        while(suffix<previous.length-prefix&&suffix<value.length-prefix&&previous.at(-suffix-1)===value.at(-suffix-1))suffix++;
        const origin=this.noteSource.frames.at(-1)?.origin||span(old.slice(prefix,previous.length-suffix))||[0,active.length];
        const generated=value.length-prefix-suffix;
        const mapped=[...old.slice(0,prefix),...Array.from({length:generated},()=>origin),...old.slice(previous.length-suffix)];
        // Macro expansion often reinserts its arguments. Preserve their exact
        // provenance, including repeated equal arguments in source order.
        let after=prefix;
        for(const argument of this.noteSource.arguments) {
          if(!argument.value)continue;
          let at=value.indexOf('{'+argument.value+'}',after);
          if(at>=0)at++;
          else at=value.indexOf(argument.value,after);
          if(at<0||at+argument.value.length>value.length-suffix)continue;
          mapped.splice(at,argument.value.length,...argument.units);after=at+argument.value.length;
        }
        this.noteSource.units=mapped;this._string=value;
      },configurable:true,
    });
  };
  factory.create=function(...args) {
    const node=create.apply(this,args),parser=options.parser;
    if(active&&parser?.noteSource && args[0]!=='text') {
      const frame=parser.noteSource.frames.at(-1);
      // Composite nodes get the union of their final children below. A token
      // created inside a command belongs to that command's consumed source.
      const where=args[0]==='token'&&frame?span([frame.origin,range(parser,Math.max(0,parser.i-1),parser.i)].filter(Boolean)):frame?.origin;
      mark(node,where);
    }
    return node;
  };
  function annotate(node,environments) {
    for(const child of node.childNodes||[])annotate(child,environments);
    if(!node.attributes)return;
    const ranges=[];
    const from=node.attributes.getExplicit('data-tex-from'),to=node.attributes.getExplicit('data-tex-to');
    if(from!==undefined&&to!==undefined)ranges.push([Number(from),Number(to)]);
    for(const child of node.childNodes||[]){const a=child.attributes?.getExplicit('data-tex-from'),b=child.attributes?.getExplicit('data-tex-to');if(a!==undefined&&b!==undefined)ranges.push([Number(a),Number(b)]);}
    let where=span(ranges);
    if(node.kind==='mtable'&&where){const env=environments.filter(e=>e[0]<=where[0]&&e[1]>=where[1]).sort((a,b)=>(a[1]-a[0])-(b[1]-b[0]))[0];if(env)where=env;}
    mark(node,where);
  }
  return {
    begin(source){active=source;},
    annotate(root){
      if(!active)return;
      const environments=[],stack=[];
      for(const match of active.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)) {
        if(match[1]==='begin')stack.push({name:match[2],from:match.index});
        else{const item=stack.pop();if(item?.name===match[2])environments.push([item.from,match.index+match[0].length]);}
      }
      annotate(root,environments);
    },
    end(){active=null;},
  };
}
