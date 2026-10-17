"""Explorer-only filtering; hiding a path never changes filesystem access."""
import json
from pathlib import Path
import tempfile
from slide_notes.paths import is_source_workspace, SOURCE_DIRECTORIES

CONFIG_NAMES={
    'agents.md','claude.md','readme','readme.md','readme.rst','license','license.md',
    'license.txt','copying','pyproject.toml','setup.py','setup.cfg','manifest.in',
    'requirements.txt','requirements-dev.txt','pipfile','pipfile.lock','poetry.lock',
    'uv.lock','package.json','package-lock.json','pnpm-lock.yaml','yarn.lock',
    'tsconfig.json','jsconfig.json','dockerfile','docker-compose.yml','compose.yaml',
    'makefile','cmakelists.txt','tox.ini','pytest.ini','ruff.toml','environment.yml',
    'settings.json','config.json','config.yaml','config.yml','workspace.json','environment.json',
}
GENERATED_DIRS={'build','dist','__pycache__','sessions'}
APP_FILES=set(SOURCE_DIRECTORIES)|{'notebook.py','notebook.css','notes',
           'start.sh','start-notes.sh','install.sh','install.ps1'}
PRIVATE_DIRS={'.git','.venv','venv','node_modules','__pycache__','.codex','.agents','.aws','.pytest_cache','.slide-notes'}


class WorkspaceVisibility:
    def user_file_registry(self):
        directory=self.root/'.slide-notes'
        path=directory/'user-files.json'
        if directory.is_symlink() or path.is_symlink():
            raise ValueError('文件来源记录不能通过符号链接访问')
        return path

    def user_file_paths(self):
        path=self.user_file_registry()
        try:
            stamp=(path.stat().st_mtime_ns,path.stat().st_size)
        except FileNotFoundError:
            stamp=None
        cached=getattr(self,'_user_file_cache',None)
        if cached is not None and cached[0]==stamp:return cached[1]
        paths=set()
        if stamp is not None:
            data=json.loads(path.read_text(encoding='utf-8'))
            for value in data.get('paths',[]):
                try:paths.add(self.editable_path(value).relative_to(self.root).as_posix())
                except (ValueError,TypeError):continue
        self._user_file_cache=(stamp,paths)
        return paths

    def remember_user_file(self, path, previous=None, remove=False):
        with self.lock:
            paths=set(self.user_file_paths())
            key=self.editable_path(path).relative_to(self.root).as_posix()
            if previous:
                old=self.editable_path(previous).relative_to(self.root).as_posix()
                paths={key+item[len(old):] if item==old or item.startswith(old+'/') else item for item in paths}
            if remove:paths={item for item in paths if item!=key and not item.startswith(key+'/')}
            else:paths.add(key)
            if paths==self.user_file_paths():return
            target=self.user_file_registry();target.parent.mkdir(parents=True,exist_ok=True)
            with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',prefix='.user-files-',dir=target.parent,delete=False) as stream:
                temporary=Path(stream.name)
                json.dump({'version':1,'paths':sorted(paths)},stream,ensure_ascii=False,indent=2)
            try:temporary.replace(target)
            finally:temporary.unlink(missing_ok=True)
            self._user_file_cache=None

    def content_visibility(self):
        # Cache ownership lookups once per listing/search, rather than doing
        # registry I/O for every descendant of a large directory.
        owned=self.user_file_paths()
        parents={parent.as_posix() for path in owned for parent in Path(path).parents if parent.as_posix()!='.'}
        app_source=is_source_workspace(self.root)
        notes=self.notes_directory
        def visible(path):
            key=Path(path).as_posix();parts=Path(key).parts
            if not parts or key=='.':return True
            if any(part in PRIVATE_DIRS for part in parts):return False
            if notes and (key==notes or key.startswith(notes+'/') or notes.startswith(key+'/')):return True
            if key in parents or key in owned or any(parent.as_posix() in owned for parent in Path(key).parents):return True
            if app_source and parts[0] in APP_FILES:return False
            if any(part.startswith('.') or part in GENERATED_DIRS or part.endswith('.egg-info') for part in parts):return False
            for part in parts:
                lower=part.lower()
                if lower in CONFIG_NAMES or lower.endswith(('.ini','.toml','.lock','.code-workspace',
                        '.config.js','.config.ts','.config.mjs','.config.cjs','.config.json')):
                    return False
                if lower.startswith('tsconfig') and lower.endswith('.json'):return False
                if lower.startswith('requirements') and lower.endswith('.txt'):return False
            return True
        return visible
