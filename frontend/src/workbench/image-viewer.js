'use strict';
function imageFileURL(path,download=false){const query=new URLSearchParams({path});const workspace=new URL(location.href).searchParams.get('workspace');if(workspace)query.set('workspace',workspace);if(download)query.set('download','1');return '/api/image?'+query;}
function imageViewer(url,name,downloadURL=url){
 const view=document.createElement('div');view.className='image-view';
 const toolbar=document.createElement('div');toolbar.className='image-view-toolbar';
 const info=document.createElement('span');info.className='image-view-info';info.textContent='正在加载…';toolbar.append(info);
 const button=(label,action,icon)=>{const item=document.createElement('button');item.type='button';item.title=label;item.setAttribute('aria-label',label);item.innerHTML=icon?uiIcon(icon):'';if(!icon)item.textContent=label;item.onclick=action;toolbar.append(item);return item;};
 let scale=1,fitting=true,drag=null;const controls=[];
 const stage=document.createElement('div');stage.className='image-view-stage';stage.tabIndex=0;stage.setAttribute('aria-label',name+' · 图片，可拖动平移');
 const content=document.createElement('div');content.className='image-view-content';const image=document.createElement('img');image.alt=name;image.draggable=false;content.append(image);stage.append(content);
 const percent=document.createElement('span');percent.className='image-view-percent';
 function paint(){if(!image.naturalWidth)return;image.style.width=image.naturalWidth*scale+'px';image.style.height=image.naturalHeight*scale+'px';content.style.width=image.naturalWidth*scale+64+'px';content.style.height=image.naturalHeight*scale+64+'px';percent.textContent=Math.round(scale*100)+'%';view.onImageGeometry?.();}
 function fit(){fitting=true;scale=Math.max(.01,Math.min(1,(stage.clientWidth-64)/image.naturalWidth,(stage.clientHeight-64)/image.naturalHeight));paint();stage.scrollTop=0;stage.scrollLeft=0;}
 function zoom(next,x,y){if(!image.naturalWidth)return;fitting=false;const r=stage.getBoundingClientRect(),before=image.getBoundingClientRect();x??=r.left+stage.clientWidth/2;y??=r.top+stage.clientHeight/2;const u=(x-before.left)/before.width,v=(y-before.top)/before.height;scale=Math.max(.01,Math.min(8,next));paint();const after=image.getBoundingClientRect();stage.scrollLeft+=after.left+u*after.width-x;stage.scrollTop+=after.top+v*after.height-y;}
 controls.push(button('缩小',()=>zoom(scale/1.25),'minus'));toolbar.append(percent);controls.push(button('放大',()=>zoom(scale*1.25),'plus'));controls.push(button('原始大小',()=>zoom(1)));controls.push(button('适应窗口',fit));
 const download=document.createElement('a');download.href=downloadURL;download.download=name;download.title='下载图片';download.setAttribute('aria-label','下载图片');download.innerHTML=uiIcon('download');toolbar.append(download);
 for(const control of controls)control.disabled=true;
 image.onload=()=>{info.textContent=image.naturalWidth+' × '+image.naturalHeight;for(const control of controls)control.disabled=false;fit();};image.onerror=()=>{info.textContent='无法加载图片，文件可能已移动或格式不受浏览器支持';};
 stage.addEventListener('wheel',event=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();zoom(scale*Math.exp(-event.deltaY*.002),event.clientX,event.clientY);},{passive:false});
 stage.onpointerdown=event=>{if(event.button!==0||!image.naturalWidth)return;event.preventDefault();stage.focus({preventScroll:true});drag={x:event.clientX,y:event.clientY,left:stage.scrollLeft,top:stage.scrollTop,pointer:event.pointerId};stage.setPointerCapture(event.pointerId);stage.classList.add('panning');};
 stage.onpointermove=event=>{if(!drag||drag.pointer!==event.pointerId)return;stage.scrollLeft=drag.left+drag.x-event.clientX;stage.scrollTop=drag.top+drag.y-event.clientY;};
 const stop=()=>{drag=null;stage.classList.remove('panning');};stage.onpointerup=stop;stage.onpointercancel=stop;stage.onlostpointercapture=stop;
 stage.onkeydown=event=>{if(event.ctrlKey||event.metaKey||event.altKey)return;const actions={'+':()=>zoom(scale*1.25),'=':()=>zoom(scale*1.25),'-':()=>zoom(scale/1.25),'0':()=>zoom(1),'f':fit};if(actions[event.key]){event.preventDefault();actions[event.key]();}};
 view.append(toolbar,stage);if(url)image.src=url;view.imageElement=image;view.imageStage=stage;view.imageInfo=info;view.zoomImage=zoom;view.fitImage=fit;view.imageScale=()=>scale;stage.addEventListener('scroll',()=>view.onImageGeometry?.(),{passive:true});
 const observer=new ResizeObserver(()=>{if(fitting&&image.naturalWidth&&stage.clientWidth&&stage.clientHeight)fit();});observer.observe(stage);view.imageObserver=observer;
 return view;
}
function imageView(tab){
 if(tab.view)return tab.view;const view=imageViewer('',tab.title,imageFileURL(tab.path,true));document.getElementById('image-editors').append(view);tab.view=view;
 view.fileLoaded=fetch(imageFileURL(tab.path)).then(async response=>{if(!response.ok)throw Error('无法加载图片');view.imageFingerprint=response.headers.get('X-Image-Fingerprint');const blob=await response.blob();if(tab.view!==view)return;view.imageBlobURL=URL.createObjectURL(blob);view.imageElement.src=view.imageBlobURL;await view.imageElement.decode();}).catch(()=>{if(view.isConnected)view.imageInfo.textContent='无法加载图片，请重新打开';});
 return view;
}
function showImagePreview(url,name){
 const dialog=document.createElement('dialog');dialog.className='image-preview-dialog';dialog.setAttribute('aria-label',name);
 const heading=document.createElement('div');heading.className='image-preview-heading';const title=document.createElement('strong');title.textContent=name;const close=document.createElement('button');close.type='button';close.setAttribute('aria-label','关闭图片');close.innerHTML=uiIcon('x');close.onclick=()=>dialog.close();heading.append(title,close);
 const view=imageViewer(url,name);dialog.append(heading,view);dialog.addEventListener('close',()=>{view.imageObserver.disconnect();dialog.remove();});dialog.onclick=event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}};document.body.append(dialog);dialog.showModal();
}
