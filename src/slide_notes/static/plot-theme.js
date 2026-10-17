'use strict';

function themePlotFigure(source) {
  const figure=structuredClone(source);
  const layout=figure.layout ||= {};
  // Upgrade only the original demo's palette; authored trace colors remain intact.
  const legacySurface=figure.data?.find(trace=>trace.type==='surface' &&
    JSON.stringify(trace.colorscale)===JSON.stringify([[0,'#e8eee2'],[0.45,'#aac3a0'],[1,'#537955']]));
  if(legacySurface){
    legacySurface.colorscale=[[0,'#edf6ff'],[0.45,'#b5d6f8'],[1,'#5b91d0']];
    for(const trace of figure.data){
      if(trace.type==='scatter3d' && trace.line?.color==='#b89b6a')trace.line.color='#7197c9';
      if(trace.type==='scatter3d' && trace.marker?.color==='#c4814c')trace.marker.color='#1e4eb9';
    }
  }
  layout.paper_bgcolor ??= '#fff';
  layout.plot_bgcolor ??= '#fff';
  layout.colorway ??= ['#4f86ec','#7db4ec','#365eb1','#65a8ca','#a9c9f4','#567c9d'];
  layout.font={family:'PT Sans, Noto Sans CJK SC, sans-serif',size:13,color:'#63758f',...layout.font};
  if(layout.font.color==='#76856d')layout.font.color='#63758f';
  const axisStyle={gridcolor:'#e5edf8',zerolinecolor:'#c9d8ed',linecolor:'#c9d8ed',tickfont:{color:'#879ab6',size:11}};
  for(const name of Object.keys(layout).filter(key=>/^[xy]axis\d*$/.test(key))){
    layout[name]={...axisStyle,...layout[name]};
  }
  for(const name of Object.keys(layout).filter(key=>/^scene\d*$/.test(key))){
    const scene=layout[name];scene.bgcolor ??= '#fff';
    for(const axis of ['xaxis','yaxis','zaxis'])scene[axis]={...axisStyle,backgroundcolor:'#f8faff',...scene[axis]};
  }
  return figure;
}
