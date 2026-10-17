"""Workspace-owned AI history files, independent of notebook source documents."""
from slide_notes.ai.selections import reference as selection_reference
from slide_notes.ai.tool_trace import clean_trace
from slide_notes.ai.changes import clean_baseline, clean_origins, clean_excluded, clean_report, snapshot_cells
from slide_notes.ai.branches import clean_branch
from slide_notes.ai.images import attachments
from slide_notes.ai.pdf_context import reference as pdf_reference
from slide_notes.ai.sources import document_path, sources, cell_selections
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

def context_path(value):
    # History survives deleted/moved files; validate the reference without opening it.
    if not isinstance(value,str) or len(value)>1000 or value.startswith('/') or '\\' in value or '..' in value.split('/') or any(ord(c)<32 for c in value):
        raise ValueError('无效的对话文件引用')
    return value

class SessionStorage:
    def directory(self, workspace, notebook):
        name=re.sub(r'[^\w.-]+','-',Path(notebook).stem).strip('.-')[:60] or 'notebook'
        digest=hashlib.sha256(notebook.encode()).hexdigest()[:16]
        return workspace.editable_path(f'sessions/{name}-{digest}')

    def target(self, workspace, notebook, cell):
        if cell is not None and (not isinstance(cell,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}',cell)):
            raise ValueError('无效的 cell 范围')
        directory=self.directory(workspace,notebook)
        return workspace.editable_path(directory.relative_to(workspace.root).as_posix()+'/'+('cell-'+cell if cell else 'global')+'.json')

    def read_file(self, target):
        if not target.exists(): return None,None
        raw=target.read_bytes()
        if len(raw)>5_000_000: raise ValueError('对话历史文件过大')
        try: data=json.loads(raw)
        except ValueError: raise ValueError('对话历史文件无法解析，未覆盖原文件') from None
        if not isinstance(data,dict) or data.get('type')!='slide-notes-ai-sessions' or not isinstance(data.get('conversations'),list):
            raise ValueError('对话历史文件格式不正确，未覆盖原文件')
        return data,hashlib.sha256(raw).hexdigest()

    def read(self, workspace, path, cell=None, scope=None):
        if scope=='workspace':
            if cell is not None: raise ValueError('工作区会话不能绑定 cell')
            with workspace.lock:
                target=workspace.editable_path('sessions/workspace.json')
                data,revision=self.read_file(target)
                if data is None:
                    # Copy legacy global histories once. Keep every original as a backup.
                    records=[];ids=set();root=workspace.editable_path('sessions')
                    if root.exists():
                        for directory in sorted(root.iterdir()):
                            if directory.is_symlink() or not directory.is_dir() or not re.search(r'-[0-9a-f]{16}$',directory.name): continue
                            file=workspace.editable_path(directory.relative_to(workspace.root).as_posix()+'/global.json')
                            old,_=self.read_file(file)
                            if old is None: continue
                            for record in old['conversations']:
                                record=dict(record);record.setdefault('contextPath',old.get('notebook',''))
                                for message in record.get('messages',[]):message.setdefault('path',old.get('notebook',''))
                                if record['id'] in ids: record['id']=directory.name[-16:]+'-'+record['id'][:80]
                                ids.add(record['id']);records.append(record)
                    if records:
                        data=self.clean({'conversations':records,'active':max(records,key=lambda item:item['updatedAt'])['id']},None,None)
                        revision=self.atomic_write(target,data)
                return {'data':data,'revision':revision,'file':'sessions/workspace.json'}
        notebook=document_path(workspace,path,cell)
        with workspace.lock:
            target=self.target(workspace,notebook,cell)
            data,revision=self.read_file(target)
            return {'data':data,'revision':revision,'file':target.relative_to(workspace.root).as_posix()}

    def clean(self, value, notebook, cell):
        if not isinstance(value,dict) or not isinstance(value.get('conversations'),list) or not value['conversations']:
            raise ValueError('对话历史不能为空')
        conversations=[];ids=set()
        for item in value['conversations']:
            if not isinstance(item,dict) or not isinstance(item.get('id'),str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}',item['id']) or item['id'] in ids:
                raise ValueError('对话 ID 无效或重复')
            ids.add(item['id'])
            if not isinstance(item.get('title'),str) or len(item['title'])>80 or not isinstance(item.get('draft',''),str) or len(item.get('draft',''))>16000:
                raise ValueError('对话名称或草稿无效')
            messages=item.get('messages',[]);selected=item.get('selectedCells',[])
            if not isinstance(messages,list) or len(messages)>60 or any(not isinstance(message,dict) or message.get('role') not in ('user','assistant') or not isinstance(message.get('content'),str) or len(message['content'])>160000 for message in messages):
                raise ValueError('对话消息格式无效')
            for message in messages:
                if 'toolTrace' in message:message['toolTrace']=clean_trace(message['toolTrace'])
                if 'changeReport' in message:message['changeReport']=clean_report(message['changeReport'])
                if 'images' in message: message['images']=attachments(message['images'])
                if 'pdfContext' in message:
                    if message['role']!='user':raise ValueError('仅用户消息可关联 PDF 上下文')
                    message['pdfContext']=pdf_reference(message['pdfContext'])
                if 'sources' in message: message['sources']=sources(message['sources'])
                if 'cellSelections' in message: message['cellSelections']=cell_selections(message['cellSelections'])
            if 'branch' in item:item['branch']=clean_branch(item['branch'])
            if item.get('responseMode','edit') not in ('edit','ask','suggest'):raise ValueError('对话模式无效')
            if item.get('claudeEffort','') not in ('','low','medium','high','xhigh','max'):raise ValueError('思考强度无效')
            if not isinstance(item.get('modelOverride',''),str) or len(item.get('modelOverride',''))>200 or any(ord(c)<32 for c in item.get('modelOverride','')):raise ValueError('对话模型无效')
            if not isinstance(item.get('bookmarked',False),bool):raise ValueError('收藏状态无效')
            if 'changeBaseline' in item:item['changeBaseline']=clean_baseline(item['changeBaseline'])
            if 'changeOrigins' in item:item['changeOrigins']=clean_origins(item['changeOrigins'])
            if 'excludedChanges' in item:item['excludedChanges']=clean_excluded(item['excludedChanges'])
            if 'contextPath' in item:item['contextPath']=context_path(item['contextPath'])
            if item.get('selectionReference') is not None:item['selectionReference']=selection_reference(item['selectionReference'])
            if 'fileContexts' in item:
                contexts=item['fileContexts']
                if not isinstance(contexts,dict) or len(contexts)>100:raise ValueError('对话跟踪文件过多')
                cleaned={}
                for path,record in contexts.items():
                    context_path(path)
                    if not isinstance(record,dict):raise ValueError('文件修改跟踪无效')
                    selected=record.get('selectedCells',[])
                    if not isinstance(selected,list) or len(selected)>1000 or any(not isinstance(i,str) or len(i)>100 for i in selected):raise ValueError('所选 cell 无效')
                    cleaned[path]={'changeBaseline':clean_baseline(record.get('changeBaseline')),'changeOrigins':clean_origins(record.get('changeOrigins')),'excludedChanges':clean_excluded(record.get('excludedChanges',[])),'selectedCells':selected}
                    if record.get('selectionReference') is not None:cleaned[path]['selectionReference']=selection_reference(record['selectionReference'])
                item['fileContexts']=cleaned
            if 'images' in item: item['images']=attachments(item['images'])
            if 'sources' in item: item['sources']=sources(item['sources'])
            if 'cellSelections' in item: item['cellSelections']=cell_selections(item['cellSelections'])
            if not isinstance(selected,list) or len(selected)>1000 or any(not isinstance(identity,str) or len(identity)>100 for identity in selected):
                raise ValueError('所选 cell 无效')
            for field in ('createdAt','updatedAt'):
                if not isinstance(item.get(field),(int,float)) or not 0<item[field]<10**15: raise ValueError('对话时间无效')
            conversations.append({key:item[key] for key in ('id','title','customTitle','createdAt','updatedAt','messages','draft','selectedCells','images','sources','cellSelections','changeBaseline','changeOrigins','excludedChanges','branch','responseMode','modelOverride','claudeEffort','bookmarked','contextPath','fileContexts','selectionReference') if key in item})
        if value.get('active') not in ids: raise ValueError('当前对话不存在')
        return {'type':'slide-notes-ai-sessions','version':2 if notebook is None else 1,'notebook':notebook,'cell':cell,'scope':'workspace' if notebook is None else 'document','active':value['active'],'conversations':conversations}

    def atomic_write(self, target, data):
        raw=(json.dumps(data,ensure_ascii=False,indent=2)+'\n').encode()
        if len(raw)>5_000_000: raise ValueError('对话历史超过 5 MB，请拆分对话内容')
        target.parent.mkdir(parents=True,exist_ok=True)
        fd,name=tempfile.mkstemp(prefix='.session-',suffix='.tmp',dir=target.parent)
        try:
            with os.fdopen(fd,'wb') as stream:
                stream.write(raw);stream.flush();os.fsync(stream.fileno())
            os.replace(name,target)
        finally:
            if os.path.exists(name): os.unlink(name)
        return hashlib.sha256(raw).hexdigest()

    def write(self, workspace, body):
        workspace_scope=body.get('scope')=='workspace'
        if workspace_scope and body.get('cell') is not None:raise ValueError('工作区会话不能绑定 cell')
        notebook=None if workspace_scope else document_path(workspace,body.get('path'),body.get('cell'))
        cell=body.get('cell');data=self.clean(body.get('data'),notebook,cell)
        with workspace.lock:
            target=workspace.editable_path('sessions/workspace.json') if workspace_scope else self.target(workspace,notebook,cell)
            _,current=self.read_file(target)
            if current!=body.get('revision'): raise FileExistsError('对话历史已在其他窗口或文件区修改，请刷新后重试；本窗口副本仍保留')
            revision=self.atomic_write(target,data)
            return {'revision':revision,'file':target.relative_to(workspace.root).as_posix()}

    def move(self, workspace, path, destination):
        if not isinstance(path,str) or not isinstance(destination,str) or not path or not destination: raise ValueError('缺少笔记路径')
        workspace.resolve(path);workspace.resolve(destination)
        with workspace.lock:
            root=workspace.editable_path('sessions')
            if not root.exists(): return {'moved':[]}
            plans=[]
            for directory in root.iterdir():
                if directory.is_symlink() or not directory.is_dir() or not re.search(r'-[0-9a-f]{16}$',directory.name): continue
                records=[]
                for file in directory.glob('*.json'):
                    if file.name!='global.json' and not re.fullmatch(r'cell-[a-zA-Z0-9_-]+\.json',file.name): continue
                    file=workspace.editable_path(file.relative_to(workspace.root).as_posix())
                    data,_=self.read_file(file)
                    if data: records.append((file,data))
                if not records: continue
                previous=records[0][1].get('notebook')
                if not isinstance(previous,str) or not (previous==path or previous.startswith(path+'/')): continue
                next_path=destination+previous[len(path):];target=self.directory(workspace,next_path)
                if target.exists() and target!=directory: raise FileExistsError('目标笔记已有对话文件，未覆盖历史')
                plans.append((directory,target,previous,next_path,records))
            moved=[]
            workspace_file=workspace.editable_path('sessions/workspace.json')
            data,_=self.read_file(workspace_file)
            if data:
                def remap(value):
                    return destination+value[len(path):] if isinstance(value,str) and (value==path or value.startswith(path+'/')) else value
                for chat in data['conversations']:
                    if 'contextPath' in chat:chat['contextPath']=remap(chat['contextPath'])
                    if 'fileContexts' in chat:
                        for context in chat['fileContexts'].values():
                            if context.get('selectionReference'):context['selectionReference']['path']=remap(context['selectionReference']['path'])
                        chat['fileContexts']={remap(key):value for key,value in chat['fileContexts'].items()}
                    for record in [chat,*chat.get('messages',[]),*(chat.get('branch') or {}).get('archive',[])]:
                        if 'path' in record:record['path']=remap(record['path'])
                        if record.get('selectionReference'):record['selectionReference']['path']=remap(record['selectionReference']['path'])
                        if record.get('pdfContext'):record['pdfContext']['path']=remap(record['pdfContext']['path'])
                        for trace in record.get('toolTrace',[]):
                            if trace.get('path'):trace['path']=remap(trace['path'])
                        for selection in [*record.get('cellSelections',[]),*record.get('sources',[])]:selection['path']=remap(selection['path'])
                revision=self.atomic_write(workspace_file,data)
                moved.append({'scope':'workspace','revision':revision,'file':'sessions/workspace.json'})
            for directory,target,previous,next_path,records in plans:
                if directory!=target: directory.rename(target)
                for file,data in records:
                    data['notebook']=next_path
                    for chat in data['conversations']:
                        for message in [chat,*chat.get('messages',[]),*(chat.get('branch') or {}).get('archive',[])]:
                            if message.get('selectionReference') and message['selectionReference']['path']==previous:message['selectionReference']['path']=next_path
                            for selection in message.get('sources',[]):
                                if selection['path']==previous:selection['path']=next_path
                            if message.get('path')==previous: message['path']=next_path
                            for selection in message.get('cellSelections',[]):
                                if selection['path']==previous: selection['path']=next_path
                    revision=self.atomic_write(target/file.name,data)
                    moved.append({'path':next_path,'previous':previous,'cell':data.get('cell'),'revision':revision,'file':(target/file.name).relative_to(workspace.root).as_posix()})
            return {'moved':moved}
