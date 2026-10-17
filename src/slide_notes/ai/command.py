"""Agent commands run in a namespace sandbox, never in the app process."""
import base64
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from slide_notes.workspace.file_ops import EXCLUDED

EXPORTS={'.md','.txt','.csv','.tsv','.bib','.tex','.rst','.png','.jpg','.jpeg','.webp','.gif','.pdf','.svg','.html','.json'}
HELPER=r'''
import base64,json,os,subprocess,sys
from pathlib import Path
os.makedirs('/scratch/home',exist_ok=True)
with open('/scratch/command.log','wb') as log:
    try:
        process=subprocess.run(['/bin/bash','--noprofile','--norc','-c',sys.argv[1]],stdout=log,stderr=subprocess.STDOUT,timeout=int(sys.argv[2]))
        code=process.returncode
    except subprocess.TimeoutExpired:code=124
text=Path('/scratch/command.log').read_bytes()[:48001]
result={'exitCode':code,'output':text[:48000].decode('utf-8',errors='replace'),'truncated':len(text)>48000,'files':[]}
total=0;scanned=0
for directory,dirs,files in os.walk('/scratch',followlinks=False):
    dirs[:]=sorted(name for name in dirs if name!='home' and not (Path(directory)/name).is_symlink())
    for name in sorted(files):
        scanned+=1
        if scanned>200:break
        path=Path(directory)/name
        if name=='command.log' or path.is_symlink() or not path.is_file() or path.suffix.lower() not in json.loads(sys.argv[3]):continue
        size=path.stat().st_size
        if size>3000000 or total+size>8000000 or len(result['files'])>=16:continue
        raw=path.read_bytes();total+=len(raw)
        result['files'].append({'path':path.relative_to('/scratch').as_posix(),'data':base64.b64encode(raw).decode()})
    if scanned>200:break
print(json.dumps(result))
'''


@lru_cache(maxsize=8)
def _sandbox_features(executable, modified, size):
    # The binary's metadata invalidates this cache after an engine upgrade.
    try:
        result=subprocess.run([executable,'--help'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=3)
    except (OSError,subprocess.SubprocessError):return False
    return result.returncode==0 and b'--disable-userns' in result.stdout and b'--unshare-user' in result.stdout


def available():
    if not sys.platform.startswith('linux') or not shutil.which('prlimit'):return False
    executable=shutil.which('bwrap')
    if not executable:return False
    try:metadata=Path(executable).stat()
    except OSError:return False
    return _sandbox_features(executable,metadata.st_mtime_ns,metadata.st_size)


def run_command(workspace,command,cwd='',timeout=30,job=None):
    if not available():raise ValueError('本机没有可用的隔离执行器（需要支持 --disable-userns 的 Bubblewrap 0.8+ 和 prlimit）；不会退回无隔离 shell')
    if not isinstance(command,str) or not command.strip() or len(command)>16000 or '\0' in command:raise ValueError('命令无效或过长')
    if type(timeout) is not int or not 1<=timeout<=60:raise ValueError('执行超时须为 1–60 秒')
    directory=workspace.root if not cwd else workspace.editable_path(cwd)
    if not directory.is_dir():raise ValueError('执行目录不存在')
    with tempfile.TemporaryDirectory(prefix='note-command-') as temporary:
        empty=Path(temporary)/'empty';empty.mkdir()
        args=[shutil.which('bwrap'),'--unshare-all','--unshare-user','--die-with-parent','--new-session','--disable-userns','--cap-drop','ALL','--clearenv']
        for name in ('usr','lib','lib64'):
            if Path('/'+name).exists():args.extend(['--ro-bind','/'+name,'/'+name])
        args.extend(['--symlink','usr/bin','/bin','--proc','/proc','--dev','/dev','--size','67108864','--tmpfs','/scratch','--size','16777216','--tmpfs','/tmp','--ro-bind',str(workspace.root),'/workspace'])
        # Neither the account's home nor inherited environment are mounted.
        # Mask internal/credential directories even when nested in the workspace.
        masked=0
        for parent,dirs,files in os.walk(workspace.root,followlinks=False):
            for name in list(dirs):
                path=Path(parent)/name
                if name in EXCLUDED|{'sessions'} or path.is_symlink():
                    dirs.remove(name);masked+=1;dest='/workspace/'+path.relative_to(workspace.root).as_posix()
                    args.extend(['--ro-bind',str(empty),dest])
            for name in files:
                path=Path(parent)/name
                if name=='.env' or name.startswith('.env.') or path.is_symlink() or not path.is_file():
                    masked+=1;args.extend(['--ro-bind','/dev/null','/workspace/'+path.relative_to(workspace.root).as_posix()])
            if masked>1000:raise ValueError('Workspace 内部目录过多，请缩小工作区')
        runtime=Path(sys.prefix)
        base_runtime=Path(sys.base_prefix).resolve()
        # Venv interpreters can point into a separately installed CPython (for
        # example setup-python's /opt/hostedtoolcache/... prefix). Mount only
        # that interpreter installation, never its parent or inherited paths.
        system_roots=[Path('/'+name) for name in ('usr','lib','lib64') if Path('/'+name).exists()]
        if not any(base_runtime.is_relative_to(root) for root in system_roots) and base_runtime!=runtime.resolve():
            if base_runtime==Path('/') or base_runtime==Path.home().resolve() or workspace.root.is_relative_to(base_runtime):
                raise ValueError('Python 基础环境范围过大，不能用作隔离运行时')
            args.extend(['--ro-bind',str(base_runtime),str(base_runtime)])
        # A separate Python mount supplies installed packages, without user home.
        if runtime!=Path('/usr'):args.extend(['--ro-bind',str(runtime),'/runtime'])
        else:args.extend(['--symlink','usr','/runtime'])
        for key,value in {'PATH':'/runtime/bin:/usr/bin:/bin','HOME':'/scratch/home','NOTE_OUTPUT_DIR':'/scratch','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1','OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','LANG':'C.UTF-8','MPLCONFIGDIR':'/scratch/home','LD_LIBRARY_PATH':'/runtime/lib:'+str(base_runtime/'lib')}.items():args.extend(['--setenv',key,value])
        args.extend(['--chdir','/workspace'+('/'+cwd if cwd else ''),'--','/runtime/bin/python','-c',HELPER,command,str(timeout),json.dumps(sorted(EXPORTS))])
        import psutil
        threads=sum(process.info['num_threads'] or 1 for process in psutil.process_iter(['uids','num_threads']) if process.info['uids'] and process.info['uids'].real==os.getuid())
        args=[shutil.which('prlimit'),'--nproc='+str(threads+64),'--as=2147483648','--cpu='+str(timeout+3),'--fsize=16777216','--nofile=128','--',*args]
        output=Path(temporary)/'output.json'
        with output.open('wb') as log,(Path(temporary)/'error.txt').open('wb') as errors:
            process=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=log,stderr=errors,start_new_session=True)
            def stop():
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
            if job is not None:job['stop']=stop
            try:
                deadline=time.monotonic()+timeout+5
                while process.poll() is None:
                    if job is not None and job['cancel'].is_set():raise ValueError('命令已取消')
                    if time.monotonic()>deadline:raise ValueError('命令执行超时，已终止隔离进程')
                    time.sleep(.03)
                if process.returncode:
                    detail=(Path(temporary)/'error.txt').read_bytes()[:500].decode('utf-8',errors='replace')
                    raise ValueError('隔离执行失败；未退回无隔离命令：'+detail)
            finally:
                stop();process.wait(timeout=3)
                if job is not None:job['stop']=None
        if output.stat().st_size>12_000_000:raise ValueError('命令导出数据过多')
        try:result=json.loads(output.read_text())
        except (ValueError,UnicodeError):raise ValueError('隔离命令未返回有效结果') from None
        if not isinstance(result,dict) or type(result.get('exitCode')) is not int or not isinstance(result.get('output'),str) or len(result['output'])>48000 or not isinstance(result.get('files'),list) or len(result['files'])>16:raise ValueError('隔离命令结果无效')
        run_id=uuid.uuid4().hex;exports=[];total=0
        target=workspace.editable_path('sessions/executions/'+run_id);target.mkdir(parents=True)
        for item in result['files']:
            if not isinstance(item,dict) or not isinstance(item.get('path'),str) or len(item['path'])>500 or not isinstance(item.get('data'),str) or len(item['data'])>4000000:raise ValueError('导出文件无效')
            name=Path(item['path']).name
            if Path(name).suffix.lower() not in EXPORTS:raise ValueError('导出文件类型无效')
            try:raw=base64.b64decode(item['data'],validate=True)
            except ValueError:raise ValueError('导出文件编码无效') from None
            total+=len(raw)
            if len(raw)>3_000_000 or total>8_000_000:raise ValueError('导出文件过大')
            identity=hashlib.sha256(raw).hexdigest();(target/identity).write_bytes(raw)
            exports.append({'id':identity,'name':name,'size':len(raw)})
        (target/'manifest.json').write_text(json.dumps(exports,ensure_ascii=False))
        return {'runId':run_id,'exitCode':result['exitCode'],'output':result['output'],'truncated':result.get('truncated') is True,'artifacts':exports,'sandbox':{'workspace':'read-only','network':False,'outputDirectory':'/scratch'},'note':'在隔离环境中执行。工作区文件保持不变；生成文件可通过 save_generated_file 导入。'}


def read_artifact(workspace,run_id,identity):
    if not isinstance(run_id,str) or not re.fullmatch(r'[0-9a-f]{32}',run_id) or not isinstance(identity,str) or not re.fullmatch(r'[0-9a-f]{64}',identity):raise ValueError('生成文件引用无效')
    directory=workspace.editable_path('sessions/executions/'+run_id)
    manifest=workspace.editable_path('sessions/executions/'+run_id+'/manifest.json')
    records=json.loads(manifest.read_text());item=next((item for item in records if item['id']==identity),None)
    if not item:raise ValueError('生成文件不存在')
    raw=workspace.editable_path('sessions/executions/'+run_id+'/'+identity).read_bytes()
    if len(raw)>3_000_000 or hashlib.sha256(raw).hexdigest()!=identity:raise ValueError('生成文件已损坏')
    return item,raw
