"""Installed application entry point and native desktop shortcuts."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import signal
import subprocess
import sys
import threading
from urllib.request import urlopen, Request
import webbrowser
from http.server import ThreadingHTTPServer
from slide_notes import __version__
from slide_notes.application import Application
from slide_notes.web.server import handler_factory
from slide_notes.paths import STATIC_ROOT, configure_text_streams


def reusable_server(port):
    """An API response alone does not prove an upgraded process can serve its UI."""
    base=f'http://127.0.0.1:{port}/'
    try:
        with urlopen(base+'api/app/home',timeout=2) as response:
            info=json.load(response)
        if info.get('application')!='slide-notes' or 'session' not in info:
            return False
        with urlopen(base,timeout=2) as response:
            if response.headers.get_content_type()!='text/html': return False
            page=response.read(200_000)
        return b'data-managed-workbench="true"' in page and b'/workspace-menu.js' in page
    except (OSError, ValueError, AttributeError):
        return False


_DESKTOP_OWNER = 'slide-notes-desktop-v1'


def _owned_text(target, marker):
    """Never replace a shortcut or marker belonging to another application."""
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise ValueError(f'未覆盖已有文件：{target}')
    if target.exists() and marker not in target.read_text(encoding='utf-8', errors='replace'):
        raise ValueError(f'未覆盖已有文件：{target}')


def _desktop_linux(data_home, executable):
    base=Path(data_home or os.environ.get('XDG_DATA_HOME',Path.home()/'.local/share')).expanduser().absolute()
    target=base/'applications/slide-notes.desktop'
    # The comment also recognizes shortcuts installed before ownership markers existed.
    _owned_text(target, 'Comment=Local interactive notebooks\n')
    icon=base/'icons/hicolor/scalable/apps/slide-notes.svg'
    if icon.is_symlink() or (icon.exists() and (not target.exists() or not icon.is_file())):
        raise ValueError(f'未覆盖已有文件：{icon}')
    icon.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(STATIC_ROOT/'app-icon.svg',icon)
    target.parent.mkdir(parents=True,exist_ok=True)
    # Desktop Entry uses double quotes and percent field codes, not shell escaping.
    quoted=str(executable).replace('\\','\\\\').replace('"','\\"').replace('`','\\`').replace('$','\\$').replace('%','%%')
    target.write_text(f'[Desktop Entry]\nType=Application\nName=Slide Notes\nComment=Local interactive notebooks\nX-Slide-Notes-Managed={_DESKTOP_OWNER}\nExec="{quoted}" -m slide_notes.launcher\nIcon={icon}\nTerminal=false\nCategories=Education;Development;\nStartupNotify=true\n',encoding='utf-8')
    if data_home is None and shutil.which('update-desktop-database'): subprocess.run(['update-desktop-database',str(target.parent)],check=False)
    if data_home is None and shutil.which('xdg-user-dir'):
        result=subprocess.run(['xdg-user-dir','DESKTOP'],capture_output=True,text=True,timeout=3)
        desktop=Path(result.stdout.strip())
        if result.returncode==0 and desktop.is_absolute() and desktop.is_dir() and desktop!=Path.home():
            shortcut=desktop/'Slide Notes.desktop'
            if not shortcut.is_symlink() and (not shortcut.exists() or (shortcut.is_file() and 'Comment=Local interactive notebooks\n' in shortcut.read_text(errors='replace'))):
                shutil.copyfile(target,shortcut)
                shortcut.chmod(0o755)
                if shutil.which('gio'):
                    subprocess.run(['gio','set',str(shortcut),'metadata::trusted','true'],capture_output=True,timeout=3)
    return target


def _desktop_macos(data_home, executable):
    base=Path(data_home).expanduser().absolute() if data_home is not None else Path.home()/'Applications'
    target=base/'Slide Notes.app'
    marker=target/'Contents/.slide-notes-managed'
    if target.is_symlink() or (target.exists() and (not target.is_dir() or not marker.is_file() or marker.is_symlink() or marker.read_text(encoding='utf-8').strip()!=_DESKTOP_OWNER)):
        raise ValueError(f'未覆盖已有应用：{target}')
    # Check every path before writing, including a previously managed bundle.
    for parent in (target/'Contents', target/'Contents/MacOS'):
        if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
            raise ValueError(f'未覆盖已有路径：{parent}')
    launcher=target/'Contents/MacOS/slide-notes'
    info=target/'Contents/Info.plist'
    for item in (launcher,info):
        if item.is_symlink() or (item.exists() and not item.is_file()):
            raise ValueError(f'未覆盖已有文件：{item}')
    launcher.parent.mkdir(parents=True,exist_ok=True)
    launcher.write_text('#!/bin/sh\nexec '+shlex.quote(str(executable))+' -m slide_notes.launcher "$@"\n',encoding='utf-8')
    launcher.chmod(0o755)
    with info.open('wb') as output:
        plistlib.dump({'CFBundleName':'Slide Notes','CFBundleDisplayName':'Slide Notes','CFBundleIdentifier':'org.slidenotes.local','CFBundleExecutable':'slide-notes','CFBundlePackageType':'APPL','CFBundleVersion':__version__,'CFBundleShortVersionString':__version__,'NSHighResolutionCapable':True},output)
    marker.write_text(_DESKTOP_OWNER+'\n',encoding='utf-8')
    return target


def _create_windows_shortcut(target, interpreter, working_directory):
    """Use the Unicode Shell Link interface with explicit wide-string setters.

    IShellLinkW setters and IPersistFile.Save take wide strings. Calling these
    native interfaces also keeps file paths out of PowerShell source code.
    """
    import ctypes
    import uuid

    class GUID(ctypes.Structure):
        _fields_ = [('Data1', ctypes.c_uint32), ('Data2', ctypes.c_uint16),
                    ('Data3', ctypes.c_uint16), ('Data4', ctypes.c_ubyte * 8)]

    def guid(value):
        return GUID.from_buffer_copy(uuid.UUID(value).bytes_le)

    def check(result, operation):
        if result & 0x80000000:
            raise OSError(f'{operation} failed (HRESULT 0x{result & 0xffffffff:08X})')

    def method(interface, index, *arguments, result=ctypes.c_long):
        table = ctypes.cast(interface, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        return ctypes.WINFUNCTYPE(result, ctypes.c_void_p, *arguments)(table[index])

    ole32 = ctypes.WinDLL('ole32')
    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    ole32.CoInitializeEx.restype = ctypes.c_long
    ole32.CoUninitialize.argtypes = []
    ole32.CoUninitialize.restype = None
    ole32.CoCreateInstance.argtypes = [ctypes.POINTER(GUID), ctypes.c_void_p,
                                     ctypes.c_uint32, ctypes.POINTER(GUID),
                                     ctypes.POINTER(ctypes.c_void_p)]
    ole32.CoCreateInstance.restype = ctypes.c_long
    initialized = ole32.CoInitializeEx(None, 2)  # COINIT_APARTMENTTHREADED
    # An already initialized COM apartment is also usable, but is not ours to close.
    if (initialized & 0xffffffff) != 0x80010106:  # RPC_E_CHANGED_MODE
        check(initialized, 'CoInitializeEx')
    link, persist = ctypes.c_void_p(), ctypes.c_void_p()
    try:
        clsid = guid('00021401-0000-0000-c000-000000000046')
        shell_link_w = guid('000214f9-0000-0000-c000-000000000046')
        check(ole32.CoCreateInstance(ctypes.byref(clsid), None, 1,
                                     ctypes.byref(shell_link_w), ctypes.byref(link)),
              'CoCreateInstance(IShellLinkW)')
        # Vtable slots include the three inherited IUnknown methods.
        for slot, value, operation in (
            (20, interpreter, 'IShellLinkW.SetPath'),
            (11, '-m slide_notes.launcher', 'IShellLinkW.SetArguments'),
            (9, working_directory, 'IShellLinkW.SetWorkingDirectory'),
            (7, 'Slide Notes local workspace', 'IShellLinkW.SetDescription'),
        ):
            check(method(link, slot, ctypes.c_wchar_p)(link, str(value)), operation)
        persist_file = guid('0000010b-0000-0000-c000-000000000046')
        check(method(link, 0, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))(
            link, ctypes.byref(persist_file), ctypes.byref(persist)), 'QueryInterface(IPersistFile)')
        check(method(persist, 6, ctypes.c_wchar_p, ctypes.c_int)(persist, str(target), 1),
              'IPersistFile.Save')
    finally:
        if persist.value: method(persist, 2, result=ctypes.c_ulong)(persist)
        if link.value: method(link, 2, result=ctypes.c_ulong)(link)
        if not (initialized & 0x80000000): ole32.CoUninitialize()


def _desktop_windows(data_home, executable):
    if data_home is not None:
        base=Path(data_home).expanduser().absolute()
    else:
        appdata=os.environ.get('APPDATA')
        if not appdata:
            raise ValueError('Windows APPDATA 环境变量未设置；请指定桌面集成目录')
        base=Path(appdata)/'Microsoft/Windows/Start Menu/Programs'
    target=base/'Slide Notes.lnk'
    marker=base/'Slide Notes.lnk.slide-notes-managed'
    if target.is_symlink() or (target.exists() and (not target.is_file() or not marker.is_file())):
        raise ValueError(f'未覆盖已有快捷方式：{target}')
    _owned_text(marker,_DESKTOP_OWNER)
    pythonw=executable.with_name('pythonw.exe')
    interpreter=pythonw if pythonw.is_file() else executable
    base.mkdir(parents=True,exist_ok=True)
    _create_windows_shortcut(target,interpreter,Path.home())
    if not target.is_file():
        raise ValueError(f'未能创建 Windows 快捷方式：{target}')
    marker.write_text(_DESKTOP_OWNER+'\n',encoding='utf-8')
    return target


def desktop_install(data_home=None):
    """Install a per-user shortcut; explicit data_home confines all written files."""
    if data_home is None:
        data_home=os.environ.get('SLIDE_NOTES_DESKTOP_HOME') or None
    executable=Path(sys.executable).absolute()
    if not executable.is_file():
        raise ValueError('请先安装软件包，再执行 slide-notes desktop install')
    if any(character in str(executable) for character in ('\n','\r','\0')):
        raise ValueError('Python 安装路径不能包含换行或空字符')
    if sys.platform=='darwin': return _desktop_macos(data_home,executable)
    if sys.platform=='win32': return _desktop_windows(data_home,executable)
    if sys.platform.startswith('linux'): return _desktop_linux(data_home,executable)
    raise ValueError(f'暂不支持此系统的桌面快捷方式：{sys.platform}')


def main():
    configure_text_streams()
    parser=argparse.ArgumentParser(description='Slide Notes · 本地工作区与交互笔记')
    parser.add_argument('workspace',nargs='?',help='工作区路径；不指定则打开首页')
    parser.add_argument('action',nargs='?',help=argparse.SUPPRESS)
    parser.add_argument('--port',type=int,help='默认 2720；被其他服务占用时自动尝试接下来的端口')
    parser.add_argument('--no-browser',action='store_true')
    args=parser.parse_args()
    if args.workspace=='desktop':
        if args.action!='install': parser.error('使用 slide-notes desktop install')
        print(desktop_install());return
    if args.action: parser.error('多余参数')
    if args.workspace=='stop':
        port=args.port or 2720
        try:
            with urlopen(f'http://127.0.0.1:{port}/api/app/home',timeout=2) as r: info=json.load(r)
            if info.get('application')!='slide-notes': raise ValueError('不是新版 Slide Notes 服务')
            with urlopen(Request(f'http://127.0.0.1:{port}/api/app/quit',data=b'{}',headers={'Content-Type':'application/json'}),timeout=3) as r: json.load(r)
            print(f'已停止端口 {port} 的 Slide Notes');return
        except Exception as exc: parser.error(str(exc))
    app=Application()
    candidates=[args.port] if args.port else range(2720,2730)
    # Prefer an existing healthy instance even if an earlier port became free.
    for port in candidates:
        if not reusable_server(port): continue
        url=f'http://127.0.0.1:{port}/'
        if args.workspace:
            data=json.dumps({'path':str(Path(args.workspace).expanduser().resolve())}).encode()
            try:
                with urlopen(Request(url+'api/app/open',data=data,headers={'Content-Type':'application/json'})) as r: result=json.load(r)
            except Exception as exc: parser.error(str(exc))
            url+='?workspace='+result['id']
        if not args.no_browser: webbrowser.open(url)
        print(url);return
    server=None
    for port in candidates:
        try:
            server=ThreadingHTTPServer(('127.0.0.1',port),handler_factory(application=app))
            break
        except OSError: continue
    if server is None: parser.error('端口已被占用，请用 --port 指定其他端口')
    if args.port is None and server.server_port!=2720:
        print(f'2720 端口已有服务，使用 {server.server_port}；CLI 请添加 --url http://127.0.0.1:{server.server_port}',flush=True)
    def terminate(signum, frame): raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,terminate)
    server.daemon_threads=True
    url=f'http://127.0.0.1:{server.server_port}/'
    if args.workspace:
        try: result=app.open(str(Path(args.workspace).expanduser().resolve()));url+='?workspace='+result['id']
        except Exception:
            server.server_close();app.stop();raise
    if not args.no_browser: threading.Timer(.4,lambda:webbrowser.open(url)).start()
    print(f'Slide Notes → {url}\nCtrl+C 停止服务和工作区计算。',flush=True)
    try: server.serve_forever(poll_interval=.2)
    except KeyboardInterrupt: pass
    finally: app.stop();server.server_close()

if __name__=='__main__':main()
