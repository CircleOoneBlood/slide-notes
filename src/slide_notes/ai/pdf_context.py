"""Workspace-local page snapshots. Chat history carries references, not pixels."""
import hashlib
import json
import os
from pathlib import PurePosixPath
import re
import tempfile
from slide_notes.ai.sources import sources, document_path
from slide_notes.ai.images import read_image


def reference(value):
    if not isinstance(value,dict) or set(value)!={'id','path','page','pageCount','fingerprint'}:
        raise ValueError('PDF 上下文引用无效')
    identity=value['id'];path=value['path'];page=value['page'];count=value['pageCount'];fingerprint=value['fingerprint']
    if not isinstance(identity,str) or not re.fullmatch(r'[0-9a-f]{64}',identity):raise ValueError('PDF 上下文 ID 无效')
    if not isinstance(path,str) or len(path)>1000 or not path.lower().endswith('.pdf') or PurePosixPath(path).is_absolute() or '..' in PurePosixPath(path).parts or '\\' in path or any(ord(c)<32 for c in path):raise ValueError('PDF 上下文路径无效')
    if type(page) is not int or type(count) is not int or not 1<=page<=count<=100000 or not isinstance(fingerprint,str) or len(fingerprint)>100:raise ValueError('PDF 上下文页码或指纹无效')
    return {key:value[key] for key in ('id','path','page','pageCount','fingerprint')}


def version(workspace,path):
    stat=workspace.editable_path(path).stat()
    return [stat.st_dev,stat.st_ino,stat.st_size,stat.st_mtime_ns]


def register(workspace,body):
    page=sources([body.get('source')])[0]
    if page['kind']!='pdf-page':raise ValueError('仅允许缓存明确提供的 PDF 页面')
    page['path']=document_path(workspace,page['path'])
    if page.get('image'):read_image(workspace,page['image']['id'])
    record={'source':page,'version':version(workspace,page['path'])}
    data=json.dumps(record,ensure_ascii=False,sort_keys=True).encode()
    identity=hashlib.sha256(data).hexdigest()
    with workspace.lock:
        target=workspace.editable_path('sessions/pdf-context/'+identity+'.json');target.parent.mkdir(parents=True,exist_ok=True)
        if not target.exists():
            fd,name=tempfile.mkstemp(prefix='.page-',dir=target.parent)
            try:
                with os.fdopen(fd,'wb') as stream:stream.write(data)
                os.replace(name,target)
            finally:
                if os.path.exists(name):os.unlink(name)
    return reference({'id':identity,**{key:page[key] for key in ('path','page','pageCount','fingerprint')}})


def resolve(workspace,value,current_path=None):
    ref=reference(value)
    if current_path is not None and ref['path']!=current_path:raise ValueError('PDF 上下文不属于当前文档')
    target=workspace.editable_path('sessions/pdf-context/'+ref['id']+'.json')
    try:
        with target.open('rb') as stream:data=stream.read(80001)
        if len(data)>80000 or hashlib.sha256(data).hexdigest()!=ref['id']:raise ValueError('PDF 页面缓存损坏')
        record=json.loads(data);page=sources([record['source']])[0]
        if ref['path']!=page['path'] and version(workspace,ref['path'])==record['version']:page['path']=ref['path']
        if any(ref[key]!=page[key] for key in ('path','page','pageCount','fingerprint')):raise ValueError('PDF 页面缓存与引用不一致')
        if current_path is not None and record['version']!=version(workspace,current_path):raise ValueError('PDF 已更新，请重新打开 PDF 后发送')
        return page
    except (OSError,KeyError,TypeError,json.JSONDecodeError):
        raise ValueError('PDF 页面缓存不可用，请重新打开 PDF 后发送') from None


def unique_pages(pages):
    """Deduplicate old attachment snapshots too, keeping their first position."""
    unique={}
    for page in pages:
        key=(page['path'],page['page'],page['fingerprint'],page['text'])
        unique[key]=page
    return list(unique.values())
