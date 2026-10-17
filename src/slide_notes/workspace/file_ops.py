"""Filesystem operations shared by the real-file and notebook projections."""
import hashlib
import json
from pathlib import Path, PureWindowsPath
import shutil
import stat
import tempfile
import time
import uuid
import zipfile
from contextlib import contextmanager
from slide_notes.workspace.visibility import WorkspaceVisibility

EXCLUDED={'.git','.venv','venv','node_modules','__pycache__','.codex','.agents','.aws','.pytest_cache','.slide-notes'}

class FileOperations(WorkspaceVisibility):
    def unique_file_path(self, path, directory=False):
        target=self.editable_path(path)
        stem,suffix=(target.name,'') if directory else (target.stem,target.suffix)
        candidate=target;index=1
        while candidate.exists() or candidate.is_symlink():
            candidate=target.with_name(f'{stem} ({index}){suffix}');index+=1
        return candidate

    def transferable_items(self, path):
        target=self.editable_path(path)
        if not target.exists(): raise FileNotFoundError('文件已不存在')
        items=[target]
        for item in items:
            self.editable_path(item.relative_to(self.root).as_posix())
            mode=item.lstat().st_mode
            if stat.S_ISDIR(mode): items.extend(sorted(item.iterdir()))
            elif not stat.S_ISREG(mode): raise ValueError('只能传输普通文件和文件夹，不能包含符号链接或特殊文件')
        return target,items

    def import_directory(self, path):
        with self.lock:
            target=self.unique_file_path(path,directory=True)
            target.mkdir()
            self.remember_user_file(target.relative_to(self.root).as_posix())
            return {'path':target.relative_to(self.root).as_posix()}

    def import_file(self, path, stream, size):
        if not isinstance(size,int) or isinstance(size,bool) or not 0 <= size <= 100*1024*1024:
            raise ValueError('单个导入文件不能超过 100 MB')
        with self.lock:
            target=self.editable_path(path)
            target.parent.mkdir(parents=True,exist_ok=True)
            # Publish only a complete upload; never replace an existing file or
            # the live JSON belonging to an open notebook.
            with tempfile.TemporaryFile(dir=target.parent) as staged:
                remaining=size
                while remaining:
                    chunk=stream.read(min(65536,remaining))
                    if not chunk: raise ValueError('文件传输未完成，请重试')
                    staged.write(chunk);remaining-=len(chunk)
                target=self.unique_file_path(path)
                with target.open('xb') as output:
                    staged.seek(0)
                    try: shutil.copyfileobj(staged,output)
                    except BaseException:
                        target.unlink(missing_ok=True)
                        raise
            self.remember_user_file(target.relative_to(self.root).as_posix())
            return {'path':target.relative_to(self.root).as_posix(),'size':size}

    @contextmanager
    def export_file(self, path):
        with self.lock:
            target,items=self.transferable_items(path)
            if target.is_file():
                with target.open('rb') as stream:
                    yield stream,target.name,'application/octet-stream'
            else:
                with tempfile.TemporaryFile() as stream:
                    with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED) as archive:
                        for item in items: archive.write(item,item.relative_to(target.parent).as_posix())
                    stream.seek(0)
                    yield stream,target.name+'.zip','application/zip'

    def editable_path(self, path):
        # API paths use forward slashes on every OS; drive-relative paths and
        # backslashes must not acquire different meanings after a transfer.
        if '\\' in str(path) or PureWindowsPath(path).drive:
            raise ValueError('请使用工作区内以 / 分隔的相对路径')
        relative=Path(path)
        if relative.is_absolute() or not relative.parts or any(part in ('.','..') or part in EXCLUDED for part in relative.parts):
            raise ValueError('不能修改工作区根目录、环境或配置目录')
        current=self.root
        for part in relative.parts:
            current=current/part
            if current.is_symlink(): raise ValueError('请直接操作原始文件，不能通过符号链接修改')
        return self.resolve(path)

    def impact(self, path):
        target=self.editable_path(path)
        path=target.relative_to(self.root).as_posix()
        if not target.exists(): raise FileNotFoundError('文件已不存在')
        items=[target, *sorted(target.rglob('*'))] if target.is_dir() else [target]
        digest=hashlib.sha256();files=notes=0
        for item in items:
            stat=item.lstat()
            digest.update(f'{item.relative_to(self.root)}:{stat.st_mtime_ns}:{stat.st_size}:{stat.st_mode}'.encode())
            if item.is_file() and not item.is_symlink():
                files+=1
                if self.describe(item)['kind'] in ('notebook','marimo'): notes+=1
        return {'path':path,'files':files,'notes':notes,'otherFiles':files-notes,'revision':digest.hexdigest()}

    def affected(self, path):
        return [key for key in self.runners if key==path or key.startswith(path+'/')]

    def mutate(self, operation, path='', destination=None, revision=None):
        with self.lock:
            if operation=='mkdir':
                target=self.editable_path(path)
                target.mkdir()
                self.remember_user_file(target.relative_to(self.root).as_posix())
                return {'path':target.relative_to(self.root).as_posix()}
            if operation=='restore': return self.restore(path)
            source=self.editable_path(path)
            if operation!='copy' and self.notes_directory and self.notes_root.is_relative_to(source):
                raise ValueError('不能移动或删除专用笔记根目录；可以操作其中的文件和子目录')
            path=source.relative_to(self.root).as_posix()
            impact=self.impact(path)
            if revision != impact['revision']: raise FileExistsError('文件已更改，请刷新后重试')
            affected=self.affected(path)
            if any(self.runners[key].lock.locked() for key in affected): raise ValueError('笔记正在运行，请停止后再移动或删除')
            if operation in ('move','copy'):
                target=self.editable_path(destination)
                destination=target.relative_to(self.root).as_posix()
                if (operation=='move' and target==source) or (target!=source and target.is_relative_to(source)):
                    raise ValueError('不能移到自身或子目录')
                if not target.parent.is_dir(): raise ValueError('目标目录不存在')
                if operation=='copy':
                    self.transferable_items(path)
                    target=self.unique_file_path(destination,directory=source.is_dir())
                    if source.is_dir():
                        target.mkdir()
                        try: shutil.copytree(source,target,symlinks=True,dirs_exist_ok=True)
                        except BaseException:
                            if target.exists(): shutil.rmtree(target)
                            raise
                    else:
                        with source.open('rb') as stream,target.open('xb') as output:
                            try: shutil.copyfileobj(stream,output)
                            except BaseException:
                                target.unlink(missing_ok=True)
                                raise
                    self.remember_user_file(target.relative_to(self.root).as_posix())
                    return {'path':target.relative_to(self.root).as_posix(),'copiedFrom':path}
                if target.exists(): raise FileExistsError('目标已存在，未覆盖任何文件')
                source.rename(target)
                for key in affected:
                    replacement=destination+key[len(path):]
                    self.stores[replacement]=self.stores.pop(key)
                    self.stores[replacement].path=self.resolve(replacement)
                    self.runners[replacement]=self.runners.pop(key)
                if self.initial and (self.initial==path or self.initial.startswith(path+'/')): self.initial=destination+self.initial[len(path):]
                self.remember_user_file(destination,previous=path)
                return {'path':destination,'previous':path}
            if operation=='trash':
                token=uuid.uuid4().hex
                directory=self.root/'.slide-notes/trash'/token
                directory.mkdir(parents=True)
                metadata={'path':path,'deleted':time.time()}
                (directory/'metadata.json').write_text(json.dumps(metadata,ensure_ascii=False),encoding='utf-8')
                source.rename(directory/'item')
                for key in affected:
                    self.runners.pop(key).stop();self.stores.pop(key,None)
                if self.initial and (self.initial==path or self.initial.startswith(path+'/')): self.initial=None
                self.remember_user_file(path,remove=True)
                return {'id':token,**metadata,**impact}
            raise ValueError('未知文件操作')

    def trash_list(self):
        entries=[]
        for meta in (self.root/'.slide-notes/trash').glob('*/metadata.json'):
            try:
                if (meta.parent/'item').exists(): entries.append({'id':meta.parent.name,**json.loads(meta.read_text(encoding='utf-8'))})
            except (OSError,ValueError): pass
        return {'entries':sorted(entries,key=lambda e:e['deleted'],reverse=True)}

    def restore(self, token):
        if not isinstance(token,str) or len(token)!=32 or not token.isalnum(): raise ValueError('无效回收项')
        directory=self.root/'.slide-notes/trash'/token
        metadata=json.loads((directory/'metadata.json').read_text(encoding='utf-8'))
        target=self.editable_path(metadata['path'])
        if target.exists(): raise FileExistsError('原位置已存在同名文件，未覆盖')
        target.parent.mkdir(parents=True,exist_ok=True)
        (directory/'item').rename(target)
        (directory/'metadata.json').unlink();directory.rmdir()
        self.remember_user_file(metadata['path'])
        return {'path':metadata['path']}
