"""Workspace launcher and isolated Python environments; no user data in the app install."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid
from slide_notes.paths import EXAMPLES_ROOT, configuration_directory, environment_python

BASE_REQUIREMENTS = ['marimo==0.25.1', 'numpy==2.5.3', 'plotly==7.1.0']

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)

class Environment:
    def __init__(self, root):
        self.root = root
        self.directory = root / '.slide-notes'
        self.python = environment_python(self.directory / 'venv')
        self.lock = threading.Lock()
        self.process = None
        self.thread = None
        self.closed = False
        self.state = {'status': 'ready' if self.python.exists() and (self.directory / 'environment.json').exists() else 'missing', 'message': '', 'log': []}

    def snapshot(self):
        with self.lock:
            return {**self.state, 'log': list(self.state['log']), 'python': str(self.python)}

    def start(self):
        with self.lock:
            if self.closed or self.state['status'] in ('installing', 'ready'): return self.snapshot_unlocked()
            self.state = {'status': 'installing', 'message': '正在创建独立 Python 环境', 'log': []}
            self.thread = threading.Thread(target=self.install, daemon=True)
            self.thread.start()
            return self.snapshot_unlocked()

    def snapshot_unlocked(self):
        return {**self.state, 'log': list(self.state['log']), 'python': str(self.python)}

    def command(self, args):
        with self.lock:
            if self.closed: raise RuntimeError('初始化已停止')
            self.process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', start_new_session=os.name == 'posix')
            process = self.process
        with process.stdout as stream:
            for line in stream:
                with self.lock:
                    self.state['log'] = (self.state['log'] + [line.rstrip()])[-30:]
        if process.wait() != 0: raise RuntimeError('环境初始化失败，可查看日志并重试')

    def install(self):
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            self.command([sys.executable, '-m', 'venv', str(self.directory / 'venv')])
            with self.lock: self.state['message'] = '正在安装 Python 笔记运行依赖'
            self.command([str(self.python), '-m', 'pip', 'install', '--disable-pip-version-check', *BASE_REQUIREMENTS])
            self.command([str(self.python), '-c', 'import marimo, numpy, plotly'])
            write_json(self.directory / 'environment.json', {'requirements': BASE_REQUIREMENTS, 'created': time.time()})
            with self.lock: self.state.update(status='ready', message='Python 环境已就绪')
        except Exception as exc:
            with self.lock: self.state.update(status='error', message=str(exc))
        finally:
            with self.lock: self.process = None

    def stop(self):
        import signal
        with self.lock:
            self.closed = True
            process = self.process
        if process and process.poll() is None:
            if os.name == 'posix':
                try: os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError: pass
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    try: os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
            else:
                # pip may own build subprocesses; stopping the window must also
                # stop its environment installer on Windows.
                import psutil
                try:
                    parent = psutil.Process(process.pid)
                    children = parent.children(recursive=True)
                    for child in reversed(children):
                        try: child.terminate()
                        except psutil.NoSuchProcess: pass
                    process.terminate()
                    _, alive = psutil.wait_procs(children, timeout=3)
                    for child in alive:
                        try: child.kill()
                        except psutil.NoSuchProcess: pass
                    try: process.wait(timeout=3)
                    except subprocess.TimeoutExpired: process.kill()
                except psutil.NoSuchProcess:
                    pass
        if self.thread: self.thread.join(timeout=4)

class Application:
    def __init__(self, config_home=None):
        self.config = Path(config_home) if config_home is not None else configuration_directory()
        self.workspaces = {}
        self.lock = threading.RLock()

    def recent(self):
        try: return json.loads((self.config/'recent.json').read_text(encoding='utf-8'))
        except (OSError, ValueError): return []

    def home(self):
        with self.lock:
            return {'application': 'slide-notes', 'session': self.session(), 'recent': [{**entry, 'exists': Path(entry['path']).is_dir()} for entry in self.recent()], 'home': str(Path.home()),
                    'workspaces': [self.describe(key, workspace) for key, workspace in self.workspaces.items()]}

    def session(self):
        try: return json.loads((self.config/'session.json').read_text(encoding='utf-8'))
        except (OSError, ValueError): return None

    def remember(self, key, notebook=None, editors=None):
        with self.lock:
            session=self.session() or {'notebooks': {}}
            if key is not None:
                workspace=self.get(key)
                if notebook is not None:
                    notebook=workspace.notebook(notebook)[0]
                session.setdefault('notebooks', {})[key]=notebook
                if editors is not None:
                    if not isinstance(editors, dict) or not isinstance(editors.get('tabs'), list) or len(editors['tabs']) > 200:
                        raise ValueError('标签页格式不正确')
                    tabs = []
                    for tab in editors['tabs']:
                        if not isinstance(tab, dict) or tab.get('kind') not in ('notebook', 'pdf', 'image') or not isinstance(tab.get('path'), str):
                            raise ValueError('标签页格式不正确')
                        path = tab['path']
                        if tab['kind'] == 'notebook': path = workspace.notebook(path)[0]
                        elif tab['kind']=='image':path=workspace.image(path)[0].relative_to(workspace.root).as_posix()
                        else: path = workspace.pdf(path).relative_to(workspace.root).as_posix()
                        if not any(item['path'] == path for item in tabs): tabs.append({'kind':tab['kind'], 'path':path})
                    active = editors.get('active')
                    if active is not None and active not in [tab['path'] for tab in tabs]:
                        raise ValueError('活动标签页不存在')
                    session.setdefault('editors', {})[key] = {'tabs':tabs, 'active':active}
            session['workspace']=key
            write_json(self.config/'session.json',session)
            return session

    def describe(self, key, workspace):
        return {'id': key, 'path': str(workspace.root), 'name': workspace.root.name, 'environment': workspace.environment.snapshot(),
                'notesDirectory':workspace.notes_directory, 'notebookAliases':workspace.notebook_aliases}

    def open(self, path, create=False, initialize=True):
        from slide_notes.web.server import Workspace
        root = Path(path).expanduser()
        if not root.is_absolute(): raise ValueError('请选择绝对路径')
        if create: root.mkdir(parents=True, exist_ok=False)
        root = root.resolve()
        if not root.is_dir(): raise ValueError('工作区目录不存在')
        if (root/'.slide-notes').is_symlink(): raise ValueError('工作区配置目录不能是符号链接')
        key = hashlib.sha256(str(root).encode()).hexdigest()[:20]
        with self.lock:
            if key not in self.workspaces:
                from slide_notes.workspace.storage import migrate_notebooks
                configuration=root/'.slide-notes/workspace.json'
                settings=json.loads(configuration.read_text(encoding='utf-8')) if configuration.exists() else {}
                env = Environment(root)
                workspace = Workspace(root, None, environment=env, notes_directory=settings.get('notesDirectory','notebooks'))
                notes=workspace.editable_path(workspace.notes_directory)
                if notes.exists() and not notes.is_dir(): raise ValueError('笔记目录路径已被文件占用：'+str(notes))
                notes.mkdir(parents=True,exist_ok=True)
                workspace.notes_directory=notes.relative_to(root).as_posix()
                aliases=migrate_notebooks(workspace,settings)
                write_json(configuration,{**settings,'version':2,'notesDirectory':workspace.notes_directory,'notesMigrated':True})
                session=self.session()
                if session and session.get('notebooks',{}).get(key) in aliases:
                    session['notebooks'][key]=aliases[session['notebooks'][key]]
                    write_json(self.config/'session.json',session)
                self.workspaces[key] = workspace
            workspace = self.workspaces[key]
            recent = [entry for entry in self.recent() if entry['path'] != str(root)]
            write_json(self.config/'recent.json', [{'path': str(root), 'name': root.name, 'opened': time.time()}, *recent][:30])
        if initialize: workspace.environment.start()
        return self.describe(key, workspace)

    def get(self, key=None):
        with self.lock:
            if key in self.workspaces: return self.workspaces[key]
            if key is None and len(self.workspaces)==1: return next(iter(self.workspaces.values()))
            # Bookmarked editor URLs remain valid after restarting the application.
            for entry in self.recent() if key else []:
                if hashlib.sha256(entry['path'].encode()).hexdigest()[:20] == key:
                    self.open(entry['path'])
                    return self.workspaces[key]
        raise ValueError('请从首页打开工作区；多个工作区时需指定 workspace ID')

    def directories(self, path=None):
        root = Path(path or Path.home()).expanduser().resolve()
        if not root.is_dir(): raise ValueError('目录不存在')
        entries=[]
        for item in root.iterdir():
            try:
                if item.is_dir() and not item.name.startswith('.'): entries.append({'name':item.name, 'path':str(item.resolve())})
            except OSError: pass
        return {'path':str(root), 'parent':str(root.parent), 'entries':sorted(entries,key=lambda e:e['name'].lower())}

    def examples(self, key):
        workspace=self.get(key)
        relative=workspace.notes_directory+'/示例笔记'
        target=workspace.editable_path(relative)
        target.mkdir(exist_ok=True)
        source=EXAMPLES_ROOT
        copied=[]
        for name in ('mo-linked.json','mo-selection.json'):
            dest=workspace.editable_path(relative+'/'+name)
            if not dest.exists(): shutil.copyfile(source/name,dest)
            copied.append(dest.relative_to(workspace.root).as_posix())
        return {'paths':copied}

    def stop(self):
        with self.lock: workspaces=list(self.workspaces.values())
        for workspace in workspaces:
            workspace.stop()
            workspace.environment.stop()
