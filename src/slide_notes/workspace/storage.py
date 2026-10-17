"""Initialize the notebook directory and move legacy notebooks with a resumable journal."""
import hashlib
import json
import os
from pathlib import Path
from slide_notes.application import write_json
from slide_notes.workspace.file_ops import EXCLUDED
from slide_notes.paths import is_source_workspace, SOURCE_DIRECTORIES


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def notebook_filename(title):
    return (''.join(c for c in str(title)[:150] if c not in '/\\\x00').strip(' .') or '未命名笔记')+'.json'


def migrate_notebooks(workspace, settings):
    journal_path=workspace.root/'.slide-notes/notes-migration.json'
    if journal_path.exists():
        journal=json.loads(journal_path.read_text(encoding='utf-8'))
    else:
        journal={'version':1,'entries':[]}
        if not settings.get('notesMigrated'):
            app_source=is_source_workspace(workspace.root)
            reserved=set()
            for directory, dirs, names in os.walk(workspace.root, followlinks=False):
                base=Path(directory)
                dirs[:]=sorted(name for name in dirs if name not in EXCLUDED|{'build','dist','.github'}
                    and not name.endswith('.egg-info') and not (base/name).is_symlink()
                    and not (base/name).resolve().is_relative_to(workspace.notes_root)
                    and not (app_source and base==workspace.root and name in SOURCE_DIRECTORIES-{'slide_notes'})
                    and not (app_source and (base/name).relative_to(workspace.root).as_posix()
                             in ('slide_notes/examples','slide_notes/static','slide_notes/test_fixtures')))
                for name in sorted(names):
                    source=base/name
                    key=source.relative_to(workspace.root).as_posix()
                    if source.suffix!='.json' or source.is_symlink(): continue
                    if app_source and key=='slide_notes/example.json': continue
                    entry=workspace.describe(source)
                    if entry['kind']!='notebook': continue
                    relative=notebook_filename(entry['title']) if key.startswith('slide_notes/data/') else key
                    destination=workspace.notes_directory+'/'+relative
                    target=workspace.editable_path(destination)
                    stem=target.stem
                    suffix=2
                    while target.exists() or destination in reserved:
                        target=target.with_name(stem+'-migrated-'+str(suffix)+source.suffix)
                        destination=target.relative_to(workspace.root).as_posix();suffix+=1
                    reserved.add(destination)
                    journal['entries'].append({'source':key,'destination':destination,'sha256':digest(source),'status':'pending'})
            write_json(journal_path,journal)
    apply_journal(workspace,journal_path,journal)
    workspace.notebook_aliases={entry['source']:entry['destination'] for entry in journal['entries'] if entry['status']=='done'}
    normalize_legacy_layout(workspace,journal)
    return workspace.notebook_aliases


def apply_journal(workspace,journal_path,journal):
    for entry in journal['entries']:
        if entry['status']=='done': continue
        source=workspace.editable_path(entry['source']);target=workspace.editable_path(entry['destination'])
        if source.exists():
            if digest(source)!=entry['sha256']: raise ValueError('迁移期间笔记已更改，请检查：'+entry['source'])
            if target.exists(): raise FileExistsError('迁移目标已存在，未覆盖：'+entry['destination'])
            target.parent.mkdir(parents=True,exist_ok=True)
            workspace.mutate('move',entry['source'],entry['destination'],workspace.impact(entry['source'])['revision'])
        elif not target.is_file() or digest(target)!=entry['sha256']:
            raise ValueError('无法恢复迁移，请检查：'+entry['source'])
        entry['status']='done';write_json(journal_path,journal)


def normalize_legacy_layout(workspace,original):
    """Remove the old application's storage scaffolding, preserving user-created folders."""
    path=workspace.root/'.slide-notes/notes-layout.json'
    if path.exists(): journal=json.loads(path.read_text(encoding='utf-8'))
    else:
        journal={'version':1,'entries':[]};reserved=set()
        prefix=workspace.notes_directory+'/slide_notes/data/'
        for old in original['entries']:
            source=workspace.editable_path(old['destination'])
            if not old['source'].startswith('slide_notes/data/') or not old['destination'].startswith(prefix) or not source.is_file(): continue
            info=workspace.describe(source)
            if info['kind']!='notebook': continue
            filename=notebook_filename(info['title']);target=workspace.notes_root/filename;suffix=2
            while target.exists() or target.as_posix() in reserved:
                target=workspace.notes_root/(Path(filename).stem+'-'+str(suffix)+'.json');suffix+=1
            reserved.add(target.as_posix())
            journal['entries'].append({'source':old['destination'],'destination':target.relative_to(workspace.root).as_posix(),'sha256':digest(source),'status':'pending'})
        write_json(path,journal)
    apply_journal(workspace,path,journal)
    workspace.notebook_aliases.update({entry['source']:entry['destination'] for entry in journal['entries']})
    for key,value in list(workspace.notebook_aliases.items()):
        seen={key}
        while value in workspace.notebook_aliases and value not in seen:
            seen.add(value);value=workspace.notebook_aliases[value]
        workspace.notebook_aliases[key]=value
    if journal['entries']:
        for folder in ('slide_notes/data','slide_notes'):
            try: (workspace.notes_root/folder).rmdir()
            except OSError: pass  # Never remove a folder containing other user files.
