'use strict';
function purgeResultPlots(result) {
  result.querySelectorAll('.plot').forEach(plot=>{if(plot.data)Plotly.purge(plot);});
}
function queueMoEvent(key,value) {
  state.controls.set(key,value);flushControls();
}
function moSelection(event) {
  const points=(event?.points||[]).map(point=>{
    const selected={};
    for(const key of ['x','y','z','curveNumber','pointNumber','pointIndex','label','value','customdata']){
      if(point[key]!==undefined)selected[key]=point[key];
    }
    return selected;
  });
  const selection={points,indices:points.map(p=>p.pointIndex??p.pointNumber).filter(i=>Number.isInteger(i))};
  if(event?.range)selection.range=event.range;
  if(event?.lassoPoints)selection.lasso=event.lassoPoints;
  return selection;
}
function renderMoPlot(host,spec,errorBox) {
  let plot=host.querySelector('.plot');
  if(!plot){plot=document.createElement('div');plot.className='plot';host.replaceChildren(plot);}
  plot.dataset.moKey=spec.key;
  const signature=JSON.stringify(spec.figure);
  if(plot.moFigure===signature)return;
  plot.moFigure=signature;plot.moUpdating=true;
  const figure=themePlotFigure(structuredClone(spec.figure));
  figure.layout ||= {};delete figure.layout.width;figure.layout.autosize=true;
  figure.layout.uirevision ||= spec.key;
  Plotly.react(plot,figure.data,figure.layout,{responsive:true,displaylogo:false}).then(()=>{
    plot.moUpdating=false;
    if(plot.moBound)return;plot.moBound=true;
    const send=event=>{if(!plot.moUpdating&&plot.isConnected)queueMoEvent(plot.dataset.moKey,moSelection(event));};
    plot.on('plotly_selected',send);plot.on('plotly_click',send);
    plot.on('plotly_deselect',()=>{if(!plot.moUpdating&&plot.isConnected)queueMoEvent(plot.dataset.moKey,{});});
  }).catch(error=>{plot.moUpdating=false;plot.moFigure=null;errorBox.hidden=false;errorBox.textContent='mo 图形显示失败：'+error.message;});
}
function renderMoWidget(host,spec,errorBox) {
  if(spec.type==='plotly'){renderMoPlot(host,spec,errorBox);return;}
  let input=host.querySelector('input,select');
  if(!input){
    const label=document.createElement('label');label.className='mo-control mo-'+spec.type;
    const name=document.createElement('span');name.className='mo-control-label';name.innerHTML=markdown(spec.label);
    input=document.createElement(spec.type==='dropdown'?'select':'input');
    input.dataset.key=spec.key;input.setAttribute('aria-label',spec.label||spec.name||spec.type);
    if(spec.type==='dropdown'){
      if(spec.allowNone){const option=document.createElement('option');option.value='';option.textContent='—';label.dataset.allowNone='true';input.append(option);}
      for(const [index,value] of spec.options.entries()){
        const option=document.createElement('option');option.value=String(index);option.textContent=value;input.append(option);
      }
    }else{
      input.type={slider:'range',number:'number',checkbox:'checkbox',text:spec.inputType||'text'}[spec.type];
      if(['slider','number'].includes(spec.type)){
        if(spec.minimum!==null)input.min=spec.minimum;
        if(spec.maximum!==null)input.max=spec.maximum;
        input.step=spec.step;
      }
      if(spec.type==='text'){
        input.placeholder=spec.placeholder;
        if(spec.maxLength!==null)input.maxLength=spec.maxLength;
      }
    }
    const output=document.createElement('output');output.className='mo-control-value';output.hidden=spec.type!=='slider';
    const changed=()=>{
      const current=host.moSpec;
      let value=spec.type==='checkbox'?input.checked:input.value;
      if(spec.type==='slider'||spec.type==='number'){
        if(!input.value||!input.checkValidity())return;
        value=Number(input.value);
        output.textContent=String(current.steps?.length?current.steps[value]:value);
      }
      if(spec.type==='dropdown')value=input.value===''?[]:[current.options[Number(input.value)]];
      queueMoEvent(current.key,value);
    };
    if((spec.type==='slider'||spec.type==='number'||spec.type==='text')&&!spec.debounce)input.oninput=changed;
    else input.onchange=changed;
    if(spec.type==='slider')input.addEventListener('input',()=>{output.textContent=String(spec.steps?.length?spec.steps[Number(input.value)]:Number(input.value));});
    label.append(name,input,output);host.replaceChildren(label);
  }
  host.moSpec=spec;input.disabled=spec.disabled;
  // Keep the thumb/input stable while a previous event is returning from Python.
  if(!state.controls.has(spec.key)&&document.activeElement!==input){
    if(spec.type==='checkbox')input.checked=spec.value;
    else if(spec.type==='dropdown')input.value=spec.value.length?String(spec.options.indexOf(spec.value[0])):'';
    else input.value=spec.value;
  }
  const output=host.querySelector('output');
  if(output&&document.activeElement!==input)output.textContent=String(spec.steps?.length?spec.steps[spec.value]:spec.value);
}
function renderMarimoOutput(result,content,errorBox) {
  if(result.dataset.kind!=='marimo'||result.moHtml!==content.html){
    purgeResultPlots(result);
    result.innerHTML='<div class="mo-output">'+DOMPurify.sanitize(content.html,{
      ADD_TAGS:['marimo-ui-element','marimo-tex'],ADD_ATTR:['object-id','random-id'],
      FORBID_TAGS:['script','iframe','style'],
    })+'</div>';
    result.moHtml=content.html;
    result.querySelectorAll('marimo-tex').forEach(element=>{
      const text=element.textContent,display=text.startsWith('||[');
      const formula=/^\|\|[([]/.test(text)?text.slice(3,-3):text;
      element.innerHTML=katex.renderToString(formula,{displayMode:display,throwOnError:false,trust:false});
    });
  }
  const specs=new Map(content.widgets.map(spec=>[spec.id,spec]));
  result.querySelectorAll('marimo-ui-element').forEach(host=>{
    const spec=specs.get(host.getAttribute('object-id'));
    if(spec)renderMoWidget(host,spec,errorBox);
  });
}
