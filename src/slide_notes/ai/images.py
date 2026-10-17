"""Local image attachments; session JSON stores small references, never base64."""
import base64
import hashlib
import os
import re
import tempfile

MAX_IMAGE = 3_000_000
MIMES = {'png':'image/png','jpg':'image/jpeg','webp':'image/webp','gif':'image/gif'}

def image_type(raw):
    if raw.startswith(b'\x89PNG\r\n\x1a\n'): return 'png'
    if raw.startswith(b'\xff\xd8\xff'): return 'jpg'
    if raw.startswith((b'GIF87a',b'GIF89a')): return 'gif'
    if raw.startswith(b'RIFF') and raw[8:12]==b'WEBP': return 'webp'
    raise ValueError('仅支持 PNG、JPEG、WebP 和 GIF 图片')

def attachments(value):
    if not isinstance(value,list) or len(value)>8: raise ValueError('每条消息最多附加 8 张图片')
    result=[]
    for item in value:
        if not isinstance(item,dict) or not isinstance(item.get('id'),str) or not re.fullmatch(r'[0-9a-f]{64}\.(png|jpg|webp|gif)',item['id']):
            raise ValueError('无效的图片附件')
        name=item.get('name','图片')
        if not isinstance(name,str) or len(name)>200: raise ValueError('图片名称无效')
        result.append({'id':item['id'],'name':name})
    return result

def read_image(workspace, identity):
    attachments([{'id':identity}])
    target=workspace.editable_path('sessions/assets/'+identity)
    with target.open('rb') as stream: raw=stream.read(MAX_IMAGE+1)
    kind=image_type(raw)
    if len(raw)>MAX_IMAGE or identity!=hashlib.sha256(raw).hexdigest()+'.'+kind: raise ValueError('图片附件损坏，请重新粘贴')
    return raw,MIMES[kind]

def upload_image(workspace, body):
    data=body.get('data')
    if not isinstance(data,str) or len(data)>4_000_100: raise ValueError('图片不能超过 3 MB')
    match=re.fullmatch(r'data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)',data)
    if not match: raise ValueError('图片数据无效')
    try: raw=base64.b64decode(match[2],validate=True)
    except ValueError: raise ValueError('图片数据无效') from None
    if not raw or len(raw)>MAX_IMAGE: raise ValueError('图片不能超过 3 MB')
    kind=image_type(raw)
    if MIMES[kind]!=match[1]: raise ValueError('图片格式与内容不一致')
    identity=hashlib.sha256(raw).hexdigest()+'.'+kind
    item=attachments([{'id':identity,'name':body.get('name','图片')}])[0]
    with workspace.lock:
        target=workspace.editable_path('sessions/assets/'+identity)
        target.parent.mkdir(parents=True,exist_ok=True)
        if not target.exists():
            fd,name=tempfile.mkstemp(prefix='.image-',dir=target.parent)
            try:
                with os.fdopen(fd,'wb') as stream: stream.write(raw)
                os.replace(name,target)
            finally:
                if os.path.exists(name): os.unlink(name)
    return item

def image_content(workspace, text, images):
    images=attachments(images)
    if not images: return text
    blocks=[{'type':'text','text':text}] if text else []
    for item in images:
        raw,mime=read_image(workspace,item['id'])
        blocks.append({'type':'image_url','image_url':{'url':'data:'+mime+';base64,'+base64.b64encode(raw).decode()}})
    return blocks
