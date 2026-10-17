"""Content tools with one workspace boundary; no arbitrary code execution."""
import base64
import fnmatch
import hashlib
import json
import os
from pathlib import Path,PurePosixPath
import tempfile
from slide_notes.ai.command import run_command, read_artifact, available as command_available, EXPORTS
from slide_notes.workspace.file_ops import EXCLUDED
from slide_notes.ai.images import upload_image
from slide_notes.ai.pdf_reader import read_pdf, search_pdf, available as pdf_available, integer
from slide_notes.paths import is_source_workspace, protected_software_roots, SOURCE_FILES

TEXT_CONTENT={'.md','.txt','.csv','.tsv','.bib','.tex','.rst'}
IMAGE_CONTENT={'.png','.jpg','.jpeg','.webp','.gif'}
WORKSPACE_TOOLS={'list_workspace','search_workspace','read_file','read_pdf','search_pdf','read_image','create_note','write_text_file','manage_files','run_command','save_generated_file'}
WRITE_TOOLS={'apply_note_operations','create_note','write_text_file','manage_files','save_generated_file'}


def tool(name,description,properties,required=()):
    return {'type':'function','function':{'name':name,'description':description,'parameters':{'type':'object','properties':properties,'required':list(required),'additionalProperties':False}}}


def path_value(value,allow_root=False):
    if not isinstance(value,str) or len(value)>1000 or '\\' in value or any(ord(c)<32 for c in value):raise ValueError('需要 Workspace 相对路径')
    p=PurePosixPath(value)
    if p.is_absolute() or '..' in p.parts or any(part in EXCLUDED or part=='sessions' or part=='.env' or part.startswith('.env.') for part in p.parts):raise ValueError('路径越过 Workspace 或指向内部配置目录')
    if not value and not allow_root:raise ValueError('需要具体文件路径')
    return value


class WorkspaceTools:
    def content_path(self,path,write=False,allow_root=False):
        path_value(path,allow_root)
        if not path:return self.workspace.root
        target=self.workspace.editable_path(path)
        if write:
            protected=protected_software_roots(self.workspace.root)
            if is_source_workspace(self.workspace.root):
                if target.parent==self.workspace.root and target.name in SOURCE_FILES:raise ValueError('软件入口、项目说明与 idea.md 保持只读')
            if any(target.is_relative_to(root) for root in protected):raise ValueError('软件目录保持只读')
            if target.name=='AGENTS.md':raise ValueError('Agent 配置保持只读')
        return target

    def writable_note(self,path):
        target=self.content_path(path,write=True)
        if not target.is_relative_to(self.workspace.notes_root) or target.suffix!='.json':raise ValueError('笔记修改须使用专用笔记目录内的 JSON 笔记')
        self.workspace.notebook(path)
        return target

    def workspace_tools(self):
        path={'type':'string','description':'当前 Workspace 内的相对路径；不接受绝对路径或 ..。'}
        return [
            tool('list_workspace','浏览当前 Workspace 的文件夹；支持分页。读取不限于当前文件。',{'path':path,'offset':{'type':'integer','minimum':0},'limit':{'type':'integer','minimum':1,'maximum':200}}),
            tool('search_workspace','在 Workspace 中检索文件名或文本内容，字面量匹配；PDF 正文用 search_pdf。',{'query':{'type':'string'},'path':path,'mode':{'type':'string','enum':['name','text']},'glob':{'type':'string'},'limit':{'type':'integer','minimum':1,'maximum':100}},('query',)),
            tool('read_file','只读 Workspace UTF-8 文本，返回行号和 revision。JSON 笔记编辑应使用 inspect_note/apply_note_operations，PDF 用 read_pdf。',{'path':path,'startLine':{'type':'integer','minimum':1},'limit':{'type':'integer','minimum':1,'maximum':300},'textOffset':{'type':'integer','minimum':0}},('path',)),
            tool('read_pdf','自行读取 Workspace 中 PDF 的任意页，不需要用户翻页。返回文字、总页数、nextPage；扫描页自动附图，图表/公式可设 includeImages=true。',{'path':path,'startPage':{'type':'integer','minimum':1},'count':{'type':'integer','minimum':1,'maximum':5},'textOffset':{'type':'integer','minimum':0},'includeImages':{'type':'boolean'}}),
            tool('search_pdf','全文检索 Workspace 内指定 PDF，返回命中页码。先检索再 read_pdf 读取相关页，可自主继续阅读。',{'path':path,'query':{'type':'string'},'startPage':{'type':'integer','minimum':1},'limit':{'type':'integer','minimum':1,'maximum':100}},('query',)),
            tool('read_image','读取 Workspace 中 PNG/JPEG/WebP/GIF 图片并将像素提供给模型；最大 3 MB。',{'path':path},('path',)),
            tool('create_note','在当前 Workspace 专用笔记目录创建新笔记，可带首个 Markdown cell。返回新路径和 revision。',{'title':{'type':'string'},'directory':path,'markdown':{'type':'string'}},('title',)),
            tool('write_text_file','创建或按 revision 原子更新 Markdown/文本/CSV/BibTeX/TeX 内容文件；不写软件、配置或 JSON 笔记。新文件 revision="new"。',{'path':path,'revision':{'type':'string'},'text':{'type':'string'}},('path','revision','text')),
            tool('run_command','在隔离环境运行 shell/Python/数据分析命令（正常 Bash 语法）。Workspace 挂载为只读，不能访问用户主目录、配置或网络；在 /scratch 或 $NOTE_OUTPUT_DIR 生成文件，再 save_generated_file 导入 Workspace。不要通过命令修改软件或原笔记。Python 使用 python，已安装包可用。',{'command':{'type':'string'},'cwd':path,'timeout':{'type':'integer','minimum':1,'maximum':60}},('command',)),
            tool('save_generated_file','把 run_command 返回的生成文件导入 Workspace。使用 runId、artifactId 和目标 destination；不覆盖已有文件，不写软件。JSON 数据仅能放入专用笔记目录的 assets 子目录。',{'runId':{'type':'string'},'artifactId':{'type':'string'},'destination':path},('runId','artifactId','destination')),
            tool('manage_files','整理 Workspace 内容文件：impact 获取版本，mkdir 新建目录，move 移动/重命名，trash 可恢复删除，trash_list 列出回收站，restore 恢复。禁止删除软件或覆盖已有目标。move/trash 需要 impact 返回的 revision。',{'operation':{'type':'string','enum':['impact','mkdir','move','trash','trash_list','restore']},'path':path,'destination':path,'revision':{'type':'string'},'trashId':{'type':'string'}},('operation',)),
        ]

    def workspace_capabilities(self):
        return {'workspace':self.workspace.root.name,'access':'workspace-content','read':'当前 Workspace 文件、任意 PDF 页、图片、笔记','write':'专用笔记目录内的笔记和 Workspace 内容文件','pdfEngineAvailable':pdf_available(),'sandboxExecutionAvailable':command_available(),'tools':sorted(WORKSPACE_TOOLS),'forbidden':['outside workspace','software changes','credentials/configuration','unsandboxed execution'],'note':'当前文件与 cell 是默认上下文，不限制 Workspace 工具的读取范围。只有用户明确要求修改时才写入。'}

    def write_guard(self,name,args):
        if name not in WRITE_TOOLS:return None
        if not isinstance(args,dict):raise ValueError('工具参数必须是对象')
        if name=='apply_note_operations':
            path=args.get('path',self.path);self.writable_note(path)
            return {'path':path,'revision':args.get('revision'),'kind':'notebook'}
        if name=='save_generated_file':
            target=self.content_path(args.get('destination'),write=True)
            if target.suffix.lower() not in EXPORTS:raise ValueError('生成文件类型不在内容范围内')
            if target.suffix.lower()=='.json' and not target.is_relative_to(self.workspace.notes_root/'assets'):raise ValueError('JSON 数据只能导入笔记 assets 目录，不能覆盖笔记或软件配置')
            return {'path':args['destination'],'revision':None,'kind':'create'}
        if name=='write_text_file':
            path=args.get('path');target=self.content_path(path,write=True)
            if target.suffix.lower() not in TEXT_CONTENT:raise ValueError('只允许写入 Markdown、文本或数据内容文件')
            return {'path':path,'revision':args.get('revision'),'kind':'file'}
        if name=='create_note':
            path=args.get('directory') or self.workspace.notes_directory or ''
            target=self.content_path(path,write=True,allow_root=True)
            if not target.is_relative_to(self.workspace.notes_root):raise ValueError('新笔记必须在专用笔记目录')
            return {'path':path,'revision':None,'kind':'create'}
        operation=args.get('operation')
        if operation in ('impact','trash_list'):return None
        if operation=='restore':
            item=self.trash_item(args.get('trashId'));path=item['path']
        else:path=args.get('path')
        target=self.content_path(path,write=True)
        if operation in ('move','trash'):self.content_tree(target)
        if operation=='move':
            destination=args.get('destination');self.content_path(destination,write=True)
            # A rename must not turn a content file into executable/config code.
            if target.is_file() and Path(destination).suffix.lower()!=target.suffix.lower():raise ValueError('移动时须保留内容文件扩展名')
        return {'path':path,'revision':args.get('revision'),'kind':'files','destination':args.get('destination')}

    def content_tree(self,target):
        items=[target]
        if target.is_dir():
            for index,item in enumerate(target.rglob('*')):
                if index>=5000:raise ValueError('目录内容过多，请分批整理')
                items.append(item)
        for item in items:
            self.content_path(item.relative_to(self.workspace.root).as_posix(),write=True)
            if item.is_symlink():raise ValueError('不通过符号链接操作文件')
            if item.is_dir():continue
            if not item.is_file():raise ValueError('只操作普通内容文件')
            if item.suffix.lower() in TEXT_CONTENT|IMAGE_CONTENT|{'.pdf'}:continue
            if item.suffix=='.json':self.writable_note(item.relative_to(self.workspace.root).as_posix());continue
            raise ValueError('目录包含软件或非内容文件，请选择具体内容文件')

    def check_trash_storage(self):
        for relative in ('.slide-notes','.slide-notes/trash'):
            if (self.workspace.root/relative).is_symlink():raise ValueError('回收站目录不能是符号链接')

    def trash_item(self,token):
        self.check_trash_storage()
        if not isinstance(token,str) or len(token)!=32 or not token.isalnum():raise ValueError('无效回收项')
        directory=self.workspace.root/'.slide-notes/trash'/token
        if directory.is_symlink() or (directory/'item').is_symlink() or (directory/'metadata.json').is_symlink():raise ValueError('无效回收项')
        if (directory/'metadata.json').stat().st_size>10000:raise ValueError('回收项元数据过大')
        data=json.loads((directory/'metadata.json').read_text(encoding='utf-8'))
        path_value(data['path']);self.content_path(data['path'],write=True)
        # Only content files originally under the allowed workspace may return.
        item=directory/'item'
        candidates=[item]
        for index,candidate in enumerate(item.rglob('*')):
            if index>=5000:raise ValueError('回收目录过大，请分批恢复')
            candidates.append(candidate)
        for candidate in candidates:
            original=Path(data['path']) if candidate==item else Path(data['path'])/candidate.relative_to(item)
            self.content_path(str(original),write=True)
            if candidate.is_symlink():raise ValueError('不恢复符号链接')
            if candidate.is_dir():continue
            suffix=Path(data['path']).suffix.lower() if candidate==item else candidate.suffix.lower()
            if suffix=='.json':
                original=Path(data['path']) if candidate==item else Path(data['path'])/candidate.relative_to(item)
                if not self.workspace.resolve(str(original)).is_relative_to(self.workspace.notes_root):raise ValueError('仅恢复专用笔记目录内的笔记 JSON')
                from slide_notes.web.server import validate
                validate(json.loads(candidate.read_text(encoding='utf-8')))
            if suffix not in TEXT_CONTENT|IMAGE_CONTENT|{'.pdf','.json'}:raise ValueError('软件文件不能通过 Agent 恢复')
        return data

    def execute_workspace(self,name,args):
        allowed={tool['function']['name']:set(tool['function']['parameters']['properties']) for tool in self.workspace_tools()}
        if set(args)-allowed[name]:raise ValueError('工具参数不在允许范围内')
        if name=='list_workspace':
            path=args.get('path','');directory=self.content_path(path,allow_root=True)
            if not directory.is_dir():raise ValueError('目录不存在')
            offset=integer(args.get('offset',0),0,100000,'分页偏移');limit=integer(args.get('limit',100),1,200,'分页数量');entries=[]
            for item in sorted(directory.iterdir(),key=lambda item:(not item.is_dir(),item.name.casefold())):
                try:self.content_path(item.relative_to(self.workspace.root).as_posix())
                except ValueError:continue
                entries.append({'path':item.relative_to(self.workspace.root).as_posix(),'name':item.name,'kind':'directory' if item.is_dir() else item.suffix.lower().lstrip('.') or 'file','size':item.stat().st_size if item.is_file() else None})
            return {'path':path,'entries':entries[offset:offset+limit],'nextOffset':offset+limit if offset+limit<len(entries) else None},None
        if name=='search_workspace':return self.search_workspace(args),None
        if name=='read_file':
            path=args.get('path');target=self.content_path(path)
            if not target.is_file() or target.stat().st_size>2_000_000:raise ValueError('文本文件不存在或超过 2 MB，请缩小范围')
            raw=target.read_bytes()
            try:text=raw.decode('utf-8')
            except UnicodeError:raise ValueError('不是 UTF-8 文本；PDF 用 read_pdf，图片用 read_image') from None
            if '\0' in text:raise ValueError('二进制文件请使用专用读取工具')
            start=integer(args.get('startLine',1),1,1000000,'起始行');limit=integer(args.get('limit',200),1,300,'行数');lines=text.splitlines();selected=lines[start-1:start-1+limit];result='\n'.join(f'{start+i}: {line}' for i,line in enumerate(selected))
            offset=integer(args.get('textOffset',0),0,2_000_000,'文字偏移');more=len(result)>offset+32000
            return {'path':path,'revision':hashlib.sha256(raw).hexdigest(),'text':result[offset:offset+32000],'startLine':start,'totalLines':len(lines),'nextLine':start if more else start+len(selected) if start+len(selected)<=len(lines) else None,'nextTextOffset':offset+32000 if more else None,'truncated':more},None
        if name in ('read_pdf','search_pdf'):
            path=args.get('path') or (self.path if self.scope=='pdf' else None);self.content_path(path)
            return (read_pdf if name=='read_pdf' else search_pdf)(self.workspace,path,args,getattr(self,'job',None)),None
        if name=='read_image':
            path=args.get('path');target=self.content_path(path)
            if target.suffix.lower() not in IMAGE_CONTENT or not target.is_file() or target.stat().st_size>3_000_000:raise ValueError('请选择不超过 3 MB 的 Workspace 图片')
            from slide_notes.ai.images import image_type, MIMES
            raw=target.read_bytes();mime=MIMES[image_type(raw)]
            asset=upload_image(self.workspace,{'data':'data:'+mime+';base64,'+base64.b64encode(raw).decode(),'name':target.name[:200]})
            return {'path':path,'images':[asset],'readOnly':True},None
        if name=='run_command':
            cwd=args.get('cwd','');self.content_path(cwd,allow_root=True)
            return run_command(self.workspace,args.get('command'),cwd,args.get('timeout',30),getattr(self,'job',None)),None
        if name=='save_generated_file':
            self.write_guard(name,args);item,raw=read_artifact(self.workspace,args['runId'],args['artifactId']);path=args['destination'];target=self.content_path(path,write=True)
            if target.suffix.lower()!=Path(item['name']).suffix.lower():raise ValueError('导入时须保留生成文件类型')
            if target.suffix.lower()=='.json':
                data=json.loads(raw)
                if isinstance(data,dict) and data.get('version')==1 and 'slides' in data:raise ValueError('JSON 笔记请使用 create_note 和 apply_note_operations，不能从命令直接导入')
            with self.workspace.lock:
                target=self.content_path(path,write=True);target.parent.mkdir(parents=True,exist_ok=True)
                with target.open('xb') as stream:stream.write(raw)
                self.workspace.remember_user_file(path)
            return {'path':path,'revision':hashlib.sha256(raw).hexdigest(),'saved':True}, {'type':'workspace-mutation','operation':'write','path':path}
        if name=='create_note':
            self.write_guard(name,args);title=args.get('title');markdown=args.get('markdown','')
            if not isinstance(title,str) or not title.strip() or len(title)>150 or not isinstance(markdown,str) or len(markdown)>160000:raise ValueError('笔记标题或正文无效')
            with self.workspace.lock:
                created=self.workspace.create(title,args.get('directory'))
                if markdown:
                    from slide_notes.cli import apply_operations
                    doc,_=apply_operations(created['document'],[{'op':'cell.add','slide':created['document']['slides'][0]['id'],'kind':'markdown','source':markdown}])
                    _,store,_=self.workspace.notebook(created['path']);saved=store.save(doc,created['revision']);created.update(saved)
            return {'path':created['path'],'revision':created['revision'],'saved':True,'executed':False}, {'type':'workspace-mutation','operation':'create','path':created['path']}
        if name=='write_text_file':
            self.write_guard(name,args);path=args['path'];target=self.content_path(path,write=True);text=args.get('text');revision=args.get('revision')
            if not isinstance(text,str) or len(text)>160000:raise ValueError('内容文件最多 160,000 字符')
            with self.workspace.lock:
                target=self.content_path(path,write=True)
                if target.exists() and (not target.is_file() or target.stat().st_size>2_000_000):raise ValueError('目标不是可编辑的小型内容文件')
                actual=hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else 'new'
                if revision!=actual:raise ValueError('内容文件已变化，请重新 read_file；新文件使用 revision="new"')
                if not target.parent.is_dir():raise ValueError('目标目录不存在，请先 mkdir')
                fd,temp=tempfile.mkstemp(prefix='.note-',dir=target.parent)
                try:
                    with os.fdopen(fd,'w',encoding='utf-8') as stream:stream.write(text);stream.flush();os.fsync(stream.fileno())
                    os.replace(temp,target)
                finally:
                    if os.path.exists(temp):os.unlink(temp)
                self.workspace.remember_user_file(path)
            return {'path':path,'revision':hashlib.sha256(text.encode()).hexdigest(),'saved':True}, {'type':'workspace-mutation','operation':'write','path':path}
        if name=='manage_files':
            operation=args.get('operation');path=args.get('path','')
            if operation in ('trash','restore','trash_list'):self.check_trash_storage()
            if operation=='trash_list':
                entries=[]
                for entry in self.workspace.trash_list()['entries']:
                    try:self.trash_item(entry['id'])
                    except (ValueError,OSError):continue
                    entries.append(entry)
                return {'entries':entries[:100]},None
            if operation=='impact':
                self.content_path(path);return self.workspace.impact(path),None
            self.write_guard(name,args)
            if operation=='restore':path=args.get('trashId')
            result=self.workspace.mutate(operation,path,args.get('destination'),args.get('revision'))
            if operation=='move':
                from slide_notes.ai.sessions import SessionStorage
                SessionStorage().move(self.workspace,path,result['path'])
            return {**result,'saved':True}, {'type':'workspace-mutation','operation':operation,'path':result.get('path',path),'previous':result.get('previous'),'trashId':result.get('id')}
        raise ValueError('未知 Workspace 工具')

    def search_workspace(self,args):
        query=args.get('query');mode=args.get('mode','text');pattern=args.get('glob','*');root=self.content_path(args.get('path',''),allow_root=True);limit=integer(args.get('limit',40),1,100,'结果数量')
        if not isinstance(query,str) or not query.strip() or len(query)>200 or mode not in ('text','name') or not isinstance(pattern,str) or len(pattern)>200:raise ValueError('检索参数无效')
        if not root.is_dir():raise ValueError('检索目录不存在')
        matches=[];scanned=total=0
        for directory,dirs,files in os.walk(root,followlinks=False):
            dirs[:]=sorted(name for name in dirs if name not in EXCLUDED|{'sessions'} and not (Path(directory)/name).is_symlink())
            for name in sorted(files):
                target=Path(directory)/name;path=target.relative_to(self.workspace.root).as_posix()
                try:self.content_path(path)
                except ValueError:continue
                if not target.is_file():continue
                scanned+=1
                if scanned>5000 or total>32_000_000:return {'matches':matches,'truncated':True,'scanned':scanned}
                if not fnmatch.fnmatch(path,pattern) and not fnmatch.fnmatch(name,pattern):continue
                if mode=='name':
                    if query.casefold() in path.casefold():matches.append({'path':path})
                elif target.stat().st_size<=1_000_000:
                    raw=target.read_bytes();total+=len(raw)
                    try:text=raw.decode('utf-8')
                    except UnicodeError:continue
                    if '\0' in text:continue
                    for index,line in enumerate(text.splitlines(),1):
                        if query.casefold() in line.casefold():matches.append({'path':path,'line':index,'text':line.strip()[:500]})
                        if len(matches)>=limit:return {'matches':matches,'truncated':True,'scanned':scanned}
                if len(matches)>=limit:return {'matches':matches,'truncated':True,'scanned':scanned}
        return {'matches':matches,'truncated':False,'scanned':scanned}
