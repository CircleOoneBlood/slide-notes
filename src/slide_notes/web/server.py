"""Loopback-only server with atomic document saves and an interruptible kernel."""
from __future__ import annotations

import argparse
import ast
import copy
import hashlib
import hmac
import importlib.metadata
import json
import mimetypes
import multiprocessing
import os
import re
from pathlib import Path
import threading
import time
import uuid
import sys
import socket
import subprocess
from multiprocessing.connection import Connection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote

import psutil

from slide_notes.ai.service import AIService
from slide_notes.ai.sessions import SessionStorage
from slide_notes.ai.images import upload_image, read_image
from slide_notes.ai.pdf_context import register as register_pdf_context
from slide_notes.ai.selections import register as register_selections, pdf_revision as selection_pdf_revision
from slide_notes.workspace.image_files import IMAGE_TYPES, workspace_image
from slide_notes.notebook.runtime import worker
from slide_notes.workspace.file_ops import FileOperations, EXCLUDED
from slide_notes.paths import PACKAGE_ROOT, STATIC_ROOT, KERNEL_WORKER, configuration_directory, frontend_dependencies

ROOT = PACKAGE_ROOT
TEMPLATE_PATH = ROOT / "example.json"


def is_marimo_notebook(source):
    """Recognize an actual top-level App declaration without executing Python."""
    try:
        statements = ast.parse(source).body
    except SyntaxError:
        return False
    modules, constructors = set(), set()
    for statement in statements:
        if isinstance(statement, ast.Import):
            modules.update(alias.asname or alias.name for alias in statement.names
                           if alias.name == "marimo")
        elif isinstance(statement, ast.ImportFrom) and statement.module == "marimo":
            constructors.update(alias.asname or alias.name for alias in statement.names
                                if alias.name == "App")
        elif isinstance(statement, (ast.Assign, ast.AnnAssign)):
            value = statement.value
            if not isinstance(value, ast.Call):
                continue
            function = value.func
            if isinstance(function, ast.Name) and function.id in constructors:
                return True
            if (isinstance(function, ast.Attribute) and function.attr == "App"
                    and isinstance(function.value, ast.Name) and function.value.id in modules):
                return True
    return False


def validate(document):
    if not isinstance(document, dict) or document.get("version") != 1:
        raise ValueError("不支持的笔记格式")
    if not isinstance(document.get("title"), str) or not document["title"].strip():
        raise ValueError("笔记标题不能为空")
    slides = document.get("slides")
    if not isinstance(slides, list) or not 1 <= len(slides) <= 500:
        raise ValueError("笔记需要 1–500 个页面")
    ids = set()
    for slide in slides:
        if not isinstance(slide, dict) or not isinstance(slide.get("name"), str):
            raise ValueError("页面需要名称")
        if not isinstance(slide.get("cells"), list) or len(slide["cells"]) > 500:
            raise ValueError("每页最多 500 个 cell")
        for item in [slide, *slide["cells"]]:
            if not isinstance(item, dict):
                raise ValueError("无效的 cell")
            identity = item.get("id")
            if not isinstance(identity, str) or not identity.isalnum() or identity in ids:
                raise ValueError("页面和 cell 需要唯一的字母数字 ID")
            ids.add(identity)
        for cell in slide["cells"]:
            if cell.get("kind") not in ("markdown", "code", "html"):
                raise ValueError("未知的 cell 类型")
            if cell.get("display") not in ("normal", "fragment", "skip"):
                raise ValueError("未知的展示方式")
            if not isinstance(cell.get("source"), str) or len(cell["source"]) > 200_000:
                raise ValueError("cell 内容过长")
            if "layout" in cell:
                layout = cell["layout"]
                if not isinstance(layout, dict):
                    raise ValueError("无效的 cell 布局")
                width = layout.get("width", 100)
                if type(width) not in (int, float) or not 20 <= width <= 100:
                    raise ValueError("cell 宽度需要在 20–100 之间")
                x = layout.get("x", 0)
                if type(x) not in (int, float) or not 0 <= x <= 80 or x + width > 100.0001:
                    raise ValueError("cell 边界需要在笔记范围内")
                for key, minimum, maximum in (("y", 0, 10000), ("height", 62, 10000), ("gapBefore", 0, 1_000_000)):
                    if key in layout and (type(layout[key]) not in (int, float) or not minimum <= layout[key] <= maximum):
                        raise ValueError("cell 纵向位置或高度超出范围")
                for edge in ("snapLeft", "snapRight", "snapTop", "snapBottom"):
                    if edge in layout and not isinstance(layout[edge], bool):
                        raise ValueError("cell 吸附设置需要是布尔值")
                for key in ("row", "column"):
                    identity = layout.get(key)
                    if identity is not None and (not isinstance(identity, str) or not identity.isalnum() or len(identity) > 80):
                        raise ValueError("无效的 cell 行或列标识")



class Store:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.read()

    def read(self):
        raw = self.path.read_bytes()
        document = json.loads(raw)
        validate(document)
        return document, hashlib.sha256(raw).hexdigest()

    def get(self):
        with self.lock:
            document, revision = self.read()
            return {"document": document, "revision": revision}

    def save(self, document, revision):
        validate(document)
        with self.lock:
            _, current = self.read()
            if current != revision:
                raise FileExistsError("笔记已在其他窗口中更改。请先导出本窗口副本，再刷新页面。")
            raw = (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode()
            temporary = self.path.with_suffix(".json.tmp")
            with temporary.open("wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(self.path)
            return {"revision": hashlib.sha256(raw).hexdigest()}


class ChildProcess:
    def __init__(self, process): self.process = process
    @property
    def pid(self): return self.process.pid
    def is_alive(self): return self.process.poll() is None
    def terminate(self): self.process.terminate()
    def kill(self): self.process.kill()
    def join(self, timeout=None):
        try: self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired: pass

def connected_worker(python, cwd, worker_path=KERNEL_WORKER, timeout=20):
    """Authenticate a workspace interpreter without inherited POSIX descriptors.

    A fresh key is exchanged as bounded raw bytes before accepting pickle data.
    The child removes that key from its environment before executing a notebook.
    """
    secret = os.urandom(32)
    environment = os.environ.copy()
    environment['SLIDE_NOTES_WORKER_AUTHKEY'] = secret.hex()
    process = None
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen(4)
        deadline = time.monotonic() + timeout
        try:
            process = subprocess.Popen(
                [str(python), str(worker_path), '--connect', str(listener.getsockname()[1]), str(cwd)],
                env=environment,
            )
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError('工作区计算进程启动失败')
                listener.settimeout(min(.2, max(.001, deadline - time.monotonic())))
                try: client, _ = listener.accept()
                except socket.timeout: continue
                with client:
                    client.settimeout(min(3, max(.001, deadline - time.monotonic())))
                    received = bytearray()
                    try:
                        while len(received) < len(secret):
                            block = client.recv(len(secret) - len(received))
                            if not block: break
                            received.extend(block)
                        if not hmac.compare_digest(received, secret): continue
                        client.sendall(b'OK')
                    except OSError:
                        continue
                    client.settimeout(None)
                    return Connection(client.detach()), ChildProcess(process)
            raise TimeoutError('工作区计算进程连接超时')
        except BaseException:
            if process is not None and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=3)
            raise


class Runner:
    def __init__(self, cwd=None, environment=None):
        self.lock = threading.Lock()
        self.process = None
        self.connection = None
        self.guard = threading.Lock()
        self.cwd = cwd
        self.environment = environment
        self.last_state = None
        self.last_revision = None

    def snapshot(self):
        with self.guard:
            return {"running": self.lock.locked(), "state": copy.deepcopy(self.last_state),
                    "executedRevision": self.last_revision}

    def stop(self):
        with self.guard:
            self.last_state = None
            self.last_revision = None
            if self.process:
                self.process.terminate()
                self.process.join(timeout=1)
                if self.process.is_alive():
                    self.process.kill()
                    self.process.join(timeout=1)
                self.process = None
            if self.connection:
                self.connection.close()
                self.connection = None

    def run(self, request, revision=None):
        with self.lock:
            with self.guard:
                if self.process is None or not self.process.is_alive():
                    if self.environment:
                        if self.environment.snapshot()['status'] != 'ready':
                            raise ValueError('工作区 Python 环境尚未就绪，请在首页查看进度或重试')
                        if os.name == 'nt':
                            self.connection, self.process = connected_worker(self.environment.python, self.cwd)
                        else:
                            parent, child = socket.socketpair()
                            try:
                                process = subprocess.Popen([str(self.environment.python), str(KERNEL_WORKER), str(child.fileno()), str(self.cwd)], pass_fds=(child.fileno(),))
                                self.connection = Connection(parent.detach())
                                self.process = ChildProcess(process)
                            finally:
                                parent.close(); child.close()
                    else:
                        context = multiprocessing.get_context("spawn")
                        self.connection, child = context.Pipe()
                        self.process = context.Process(target=worker, args=(child, self.cwd), daemon=True)
                        self.process.start()
                        child.close()
                connection = self.connection
            try:
                connection.send(request)
                if not connection.poll(20):
                    self.stop()
                    raise TimeoutError("运行超过 20 秒，已停止计算。请修改代码后重新运行。")
                result = connection.recv()
                with self.guard:
                    if self.connection is connection and result.get("ok"):
                        self.last_state = copy.deepcopy(result["state"])
                        self.last_revision = revision
                return result
            except (EOFError, OSError, TypeError):
                raise RuntimeError("计算已停止。下次运行会建立新的 Python 会话。") from None


class Workspace(FileOperations):
    """Resolve every request to an explicit document, with one kernel per notebook."""
    def __init__(self, root, initial=None, runner=None, environment=None, notes_directory=None):
        self.root = root.resolve()
        self.environment = environment
        self.initial = initial.path.resolve().relative_to(self.root).as_posix() if initial else None
        self.stores = {self.initial: initial} if initial else {}
        self.runners = {self.initial: runner or Runner(self.root, environment)} if initial else {}
        self.lock = threading.RLock()
        self.package_cache = None
        self.notes_directory = notes_directory
        self.notebook_aliases = {}

    @property
    def notes_root(self):
        return self.resolve(self.notes_directory or '')

    def resolve(self, path=""):
        candidate = (self.root / path).resolve()
        if not candidate.is_relative_to(self.root):
            raise ValueError("路径必须在当前工作区内")
        return candidate

    def notebook(self, path=None):
        if path in self.notebook_aliases and not self.resolve(path).exists():
            path = self.notebook_aliases[path]
        if not path and not self.initial:
            entries = [e for e in self.search(notes_only=True)["entries"] if e["kind"] == "notebook"]
            if not entries: raise ValueError("工作区还没有笔记，请新建笔记")
            self.initial = entries[0]["path"]
        resolved = self.resolve(path or self.initial)
        if resolved.suffix != ".json" or not resolved.is_file():
            raise ValueError("请选择 Slide Notes 的 JSON 笔记；原版 marimo 笔记仍使用原版入口")
        key = resolved.relative_to(self.root).as_posix()
        with self.lock:
            if key not in self.stores:
                self.stores[key] = Store(resolved)
                self.runners[key] = Runner(self.root, self.environment)
            return key, self.stores[key], self.runners[key]

    def document(self, path=None):
        key, store, _ = self.notebook(path)
        return {**store.get(), "path": key, "workspace": self.root.name, "managed": self.environment is not None,
                "notesDirectory": self.notes_directory or ''}

    def describe(self, path):
        key = path.relative_to(self.root).as_posix()
        resolved = path.resolve()
        entry = {"name": path.name, "path": key, "kind": "directory" if path.is_dir() else "file"}
        if not resolved.is_relative_to(self.root):
            return {**entry, "kind": "link", "unavailable": True}
        if path.is_dir():
            return entry
        try:
            entry["size"] = path.stat().st_size
            if path.suffix == ".json" and entry["size"] <= 5_000_000:
                document = json.loads(path.read_text(encoding='utf-8'))
                if isinstance(document, dict) and document.get("version") == 1 and "slides" in document:
                    validate(document)
                    kind = "template" if resolved == TEMPLATE_PATH.resolve() else "notebook"
                    entry.update(kind=kind, title=document["title"], slides=len(document["slides"]))
            elif path.suffix.lower() in IMAGE_TYPES:
                entry["kind"] = "image"
            elif path.suffix.lower() == ".pdf":
                entry["kind"] = "pdf"
            elif path.suffix == ".py" and entry["size"] < 1_000_000:
                source = path.read_text(encoding='utf-8')
                if is_marimo_notebook(source):
                    entry.update(kind="marimo", title=path.stem)
        except (ValueError, OSError, TypeError, KeyError):
            pass
        return entry

    def files(self, path="", notes_only=False, content_only=False, include_pdf=False):
        directory = self.notes_root if notes_only and not path else self.resolve(path)
        if notes_only and not directory.is_relative_to(self.notes_root):
            raise ValueError('仅笔记视图只能浏览专用笔记目录')
        if not directory.is_dir():
            raise ValueError("目录不存在")
        visible=self.content_visibility() if content_only else lambda path:True
        entries = [self.describe(p) for p in directory.iterdir() if (not notes_only or p.name not in EXCLUDED) and visible(p.relative_to(self.root).as_posix())]
        if notes_only:
            kinds = {"directory", "notebook", "marimo"} | ({"pdf"} if include_pdf else set())
            entries = [e for e in entries if e["kind"] in kinds and self.resolve(e['path']).is_relative_to(self.notes_root)]
        entries.sort(key=lambda e: (e["kind"] != "directory", e["name"].lower()))
        return {"entries": entries, "path": directory.relative_to(self.root).as_posix(), "workspace": self.root.name,
                "notesDirectory": self.notes_directory or ''}

    def search(self, query="", notes_only=False, content_only=False, include_pdf=False):
        entries, scanned = [], 0
        # Dependency caches remain browsable in the tree, but are not search roots.
        excluded = EXCLUDED
        visible=self.content_visibility() if content_only else lambda path:True
        for directory, dirs, names in os.walk(self.notes_root if notes_only else self.root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in excluded and not (Path(directory) / d).is_symlink() and visible((Path(directory)/d).relative_to(self.root).as_posix()))
            for name in sorted(names):
                scanned += 1
                if scanned > 20_000:
                    return {"entries": entries, "truncated": True}
                path = Path(directory) / name
                key = path.relative_to(self.root).as_posix()
                if not visible(key):continue
                if notes_only and path.suffix not in (".json", ".py") and not (include_pdf and path.suffix.lower() == ".pdf"):
                    continue
                if notes_only and not path.resolve().is_relative_to(self.notes_root): continue
                if not notes_only and query.lower() not in key.lower():
                    continue
                entry = self.describe(path)
                if notes_only and entry["kind"] not in ({"notebook", "marimo"} | ({"pdf"} if include_pdf else set())):
                    continue
                if query.lower() not in (key + " " + entry.get("title", "")).lower():
                    continue
                entries.append(entry)
        return {"entries": entries, "truncated": False}

    def image(self, path):
        return workspace_image(self,path)

    def pdf(self, path):
        target = self.resolve(path)
        if target.suffix.lower() != '.pdf' or not target.is_file():
            raise ValueError('请选择 PDF 文件')
        with target.open('rb') as stream:
            if not stream.read(1024).lstrip().startswith(b'%PDF-'):
                raise ValueError('文件不是有效的 PDF')
        return target

    def preview(self, path):
        resolved = self.resolve(path)
        if not resolved.is_file():
            raise ValueError("文件不存在")
        with resolved.open("rb") as stream:
            raw = stream.read(100_001)
        binary = b"\x00" in raw
        try:
            content = raw[:100_000].decode("utf-8")
        except UnicodeDecodeError:
            content, binary = "", True
        return {"entry": self.describe(resolved), "content": "" if binary else content,
                "binary": binary, "truncated": len(raw) > 100_000}

    def create(self, title, directory=None):
        title = str(title).strip()[:150] or "未命名笔记"
        directory = self.resolve(directory) if directory else self.notes_root if self.notes_directory else (self.resolve(self.initial).parent if directory is None and self.initial else self.root)
        if self.notes_directory and not directory.is_relative_to(self.notes_root):
            raise ValueError('新笔记须创建在专用笔记目录 '+self.notes_directory+' 内')
        if not directory.is_dir(): raise ValueError("目录不存在")
        filename = "".join(ch for ch in title if ch not in "/\\\x00").strip(" .") or "未命名笔记"
        path = directory / (filename + ".json")
        if path.exists(): path = directory / (filename + "-" + uuid.uuid4().hex[:6] + ".json")
        self.editable_path(path.relative_to(self.root).as_posix())
        document = {"version": 1, "title": title, "slides": [
            {"id": "s" + uuid.uuid4().hex, "name": "第一页", "cells": []}]}
        with path.open("x", encoding="utf-8") as stream:
            json.dump(document, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        self.remember_user_file(path.relative_to(self.root).as_posix())
        return self.document(path.relative_to(self.root).as_posix())

    def rename_notebook(self, path, title, revision):
        title=str(title).strip()
        if not title or len(title)>150 or any(c in title for c in '/\\\x00') or title in ('.','..'):
            raise ValueError('请输入有效笔记名称（不能包含路径分隔符，最多 150 字）')
        with self.lock:
            key,store,runner=self.notebook(path)
            current=store.get()
            if current['revision']!=revision: raise FileExistsError('笔记已更改，请刷新后重试')
            if runner.lock.locked(): raise ValueError('笔记正在运行，请停止后再重命名')
            target=store.path.with_name(title+'.json')
            if target!=store.path and target.exists(): raise FileExistsError('同名笔记已存在，未覆盖')
            document=copy.deepcopy(current['document']);document['title']=title
            saved=store.save(document,revision)
            destination=target.relative_to(self.root).as_posix()
            if destination!=key:
                try: self.mutate('move',key,destination,self.impact(key)['revision'])
                except Exception:
                    store.save(current['document'],saved['revision'])
                    raise
            return self.document(destination)

    def packages(self):
        if self.environment:
            status = self.environment.snapshot()
            if status['status'] != 'ready': return {'packages': [], 'python': '初始化中', 'executable': str(self.environment.python), 'environment': status}
            if not self.package_cache or time.monotonic()-self.package_cache[0]>30:
                code = "import importlib.metadata as m,json,sys;print(json.dumps({'packages':[{'name':d.metadata['Name'],'version':d.version,'summary':d.metadata.get('Summary','')} for d in m.distributions()],'python':sys.version.split()[0],'executable':sys.executable}))"
                result = subprocess.run([str(self.environment.python), '-c', code], capture_output=True, text=True, check=True, timeout=15)
                self.package_cache=(time.monotonic(),json.loads(result.stdout))
            return self.package_cache[1]
        if not self.package_cache or time.monotonic() - self.package_cache[0] > 30:
            packages = sorted(({"name": d.metadata["Name"], "version": d.version,
                                "summary": d.metadata.get("Summary", "")}
                               for d in importlib.metadata.distributions() if d.metadata["Name"]),
                              key=lambda d: d["name"].lower())
            self.package_cache = time.monotonic(), packages
        return {"packages": self.package_cache[1], "python": sys.version.split()[0], "executable": sys.executable}

    def metrics(self):
        memory = psutil.virtual_memory()
        total_rss = 0
        with self.lock:
            runners = list(self.runners.values())
        for runner in runners:
            try:
                if runner.process:
                    total_rss += psutil.Process(runner.process.pid).memory_info().rss
            except (psutil.Error, TypeError):
                pass
        return {"cpu": psutil.cpu_percent(), "memory": memory.percent,
                "memoryUsed": memory.used, "memoryTotal": memory.total,
                "kernelMemory": total_rss, "kernelPercent": total_rss / memory.total * 100}

    def stop(self):
        with self.lock:
            for runner in self.runners.values():
                runner.stop()


def handler_factory(workspace=None, application=None):
    initial_workspace = workspace
    ai = AIService(application.config if application else configuration_directory())
    chat_sessions = SessionStorage()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            if args and str(args[1] if len(args) > 1 else "") not in ("200", "304"):
                super().log_message(format, *args)

        def respond(self, data, status=200):
            raw = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(raw)
            except BrokenPipeError:
                pass

        def allowed(self):
            host = self.headers.get("Host", "")
            allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            origin = self.headers.get("Origin")
            return host in allowed and (origin is None or origin == f"http://{host}")

        def send_ai(self, workspace, body, connection_test=False):
            request = ai.prepare(workspace, body, connection_test)
            stream = ai.stream(request)
            try:
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Connection', 'close')
                self.end_headers()
                self.close_connection = True
                for event in stream:
                    self.wfile.write(('data: '+json.dumps(event,ensure_ascii=False)+'\n\n').encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                ai.cancel(workspace, request['id'])
            finally:
                stream.close()
                with ai.lock: ai.jobs.pop(request['id'], None)

        def send_pdf(self, workspace, query):
            target = workspace.pdf(query['path'])
            with target.open('rb') as stream:
                size = os.fstat(stream.fileno()).st_size
                start, end, status = 0, size - 1, 200
                requested = self.headers.get('Range')
                if requested:
                    match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
                    try:
                        if not match or not any(match.groups()): raise ValueError()
                        first, last = match.groups()
                        if first:
                            start = int(first)
                            end = min(int(last), size - 1) if last else size - 1
                        else:
                            length = int(last)
                            if length <= 0: raise ValueError()
                            start = max(0, size - length)
                        if start > end or start >= size: raise ValueError()
                    except ValueError:
                        self.send_response(416)
                        self.send_header('Content-Range', f'bytes */{size}')
                        self.send_header('Content-Length', '0')
                        self.end_headers()
                        return
                    status = 206
                self.send_response(status)
                self.send_header('Content-Type', 'application/pdf')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Content-Length', str(end - start + 1))
                self.send_header('Cache-Control', 'no-store')
                disposition = 'attachment' if query.get('download') == '1' else 'inline'
                self.send_header('Content-Disposition', disposition + "; filename*=UTF-8''" + quote(target.name))
                if status == 206: self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                self.end_headers()
                if self.command == 'HEAD': return
                stream.seek(start)
                remaining = end - start + 1
                try:
                    while remaining:
                        chunk = stream.read(min(65536, remaining))
                        if not chunk: break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        def send_image(self, workspace, query):
            target,mime=workspace.image(query.get('path'))
            with target.open('rb') as stream:
                digest=hashlib.sha256()
                while chunk:=stream.read(65536):digest.update(chunk)
                stream.seek(0)
                self.send_response(200)
                self.send_header('X-Image-Fingerprint',digest.hexdigest())
                self.send_header('Content-Type',mime)
                self.send_header('Content-Length',str(os.fstat(stream.fileno()).st_size))
                self.send_header('X-Content-Type-Options','nosniff')
                self.send_header('Cache-Control','no-store')
                self.send_header('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
                self.send_header('Content-Disposition',('attachment' if query.get('download')=='1' else 'inline')+"; filename*=UTF-8''"+quote(target.name))
                self.end_headers()
                if self.command=='HEAD':return
                try:
                    while chunk:=stream.read(65536):self.wfile.write(chunk)
                except (BrokenPipeError,ConnectionResetError):pass

        def do_HEAD(self):
            if urlparse(self.path).path not in ('/api/pdf','/api/image','/api/files/export'):
                self.send_response(405)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            self.do_GET()

        def do_GET(self):
            if not self.allowed():
                return self.respond({"error": "仅接受本机同源请求"}, 403)
            parsed = urlparse(self.path)
            path = parsed.path
            query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            if path.startswith("/api/"):
                try:
                    if application and path.startswith('/api/app/'):
                        if path == '/api/app/home': return self.respond(application.home())
                        if path == '/api/app/directories': return self.respond(application.directories(query.get('path')))
                        if path == '/api/app/environment': return self.respond(application.get(query.get('workspace')).environment.snapshot())
                        if path == '/api/app/workspace':
                            key = query['workspace']
                            return self.respond(application.describe(key, application.get(key)))
                        return self.respond({'error':'Not found'},404)
                    if path == '/api/ai/config': return self.respond(ai.config())
                    workspace = application.get(query.get('workspace') or self.headers.get('X-Slide-Workspace')) if application else initial_workspace
                    if path == '/api/ai/images':
                        raw,mime=read_image(workspace,query.get('id'))
                        self.send_response(200);self.send_header('Content-Type',mime);self.send_header('X-Content-Type-Options','nosniff');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw);return
                    if path == '/api/ai/sessions': return self.respond(chat_sessions.read(workspace,query.get('path'),query.get('cell'),query.get('scope')))
                    if path == '/api/ai/selection-version': return self.respond({'revision':selection_pdf_revision(workspace,query.get('path'))})
                    if path == '/api/ai/context': return self.respond(ai.context(workspace,query.get('path'),query.get('scope','notebook'),query.get('cell'),cells=json.loads(query.get('cells','null'))))
                    if path == '/api/image': return self.send_image(workspace, query)
                    if path == '/api/pdf': return self.send_pdf(workspace, query)
                    if path == '/api/files/export':
                        with workspace.export_file(query['path']) as (stream,name,mime):
                            self.send_response(200)
                            self.send_header('Content-Type',mime)
                            self.send_header('Content-Length',str(os.fstat(stream.fileno()).st_size))
                            self.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+quote(name))
                            self.send_header('X-Content-Type-Options','nosniff')
                            self.send_header('Cache-Control','no-store')
                            self.send_header('Content-Security-Policy',"sandbox; default-src 'none'")
                            self.end_headers()
                            if self.command!='HEAD':
                                try:
                                    while chunk:=stream.read(65536): self.wfile.write(chunk)
                                except (BrokenPipeError,ConnectionResetError): pass
                        return
                    if path == '/api/files/impact': return self.respond(workspace.impact(query['path']))
                    if path == '/api/files/trash': return self.respond(workspace.trash_list())
                    if path == "/api/document":
                        return self.respond(workspace.document(query.get("path")))
                    if path == "/api/runtime":
                        key, store, runner = workspace.notebook(query.get("path"))
                        snapshot = runner.snapshot()
                        revision = store.get()["revision"]
                        return self.respond({"path": key, "revision": revision, **snapshot,
                                             "stale": snapshot["executedRevision"] != revision})
                    if path == "/api/files":
                        return self.respond(workspace.files(query.get("path", ""), query.get("notes")=="1", query.get('content')=='1', include_pdf=query.get('pdf')=='1'))
                    if path == "/api/search":
                        return self.respond(workspace.search(query.get("q", ""), query.get("notes") == "1", query.get('content')=='1', include_pdf=query.get('pdf')=='1'))
                    if path == "/api/preview":
                        return self.respond(workspace.preview(query["path"]))
                    if path == "/api/packages":
                        return self.respond(workspace.packages())
                    if path == "/api/metrics":
                        return self.respond(workspace.metrics())
                    return self.respond({"error": "Not found"}, 404)
                except (ValueError, OSError, KeyError) as exc:
                    return self.respond({"error": str(exc)}, 400)
            if path == "/vendor/plotly.js":
                from plotly.offline import get_plotlyjs
                raw, mime = get_plotlyjs().encode(), "application/javascript"
            else:
                vendors = {"/vendor/dagre.js": frontend_dependencies() / "@dagrejs/dagre/dist/dagre.min.js",
                           "/vendor/purify.js": frontend_dependencies() / "dompurify/dist/purify.min.js"}
                if path in vendors:
                    target = STATIC_ROOT / "vendor" / path.removeprefix("/vendor/")
                    if not target.is_file(): target = vendors[path]
                elif path.startswith("/vendor/katex/"):
                    base = STATIC_ROOT / "vendor/katex"
                    if not base.exists(): base = frontend_dependencies() / "katex/dist"
                    target = (base / path.removeprefix("/vendor/katex/")).resolve()
                    if not target.is_relative_to(base):
                        return self.respond({"error": "Not found"}, 404)
                else:
                    page = "index.html" if path in ("/", "/editor") else path.lstrip("/")
                    target = (STATIC_ROOT / page).resolve()
                    if not target.is_relative_to(STATIC_ROOT):
                        return self.respond({"error": "Not found"}, 404)
                if not target.is_file():
                    return self.respond({"error": "Not found"}, 404)
                raw = target.read_bytes()
                if application and target == STATIC_ROOT / 'index.html':
                    raw = raw.replace(b'<body>', b'<body data-managed-workbench="true">')
                mime = mimetypes.guess_type(target)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            if not self.allowed():
                return self.respond({"error": "仅接受本机同源 JSON 请求"}, 403)
            if urlparse(self.path).path=='/api/files/import':
                self.close_connection=True
                try:
                    if self.headers.get('Content-Type')!='application/octet-stream': raise ValueError('文件上传格式无效')
                    query={k:v[0] for k,v in parse_qs(urlparse(self.path).query).items()}
                    workspace=application.get(query.get('workspace') or self.headers.get('X-Slide-Workspace')) if application else initial_workspace
                    size=int(self.headers.get('Content-Length','-1'))
                    self.connection.settimeout(60)
                    return self.respond(workspace.import_file(query['path'],self.rfile,size))
                except (ValueError,OSError,KeyError) as exc:
                    return self.respond({'error':str(exc)},400)
            if self.headers.get('Content-Type')!='application/json':
                return self.respond({'error':'仅接受本机同源 JSON 请求'},403)
            try:
                size = int(self.headers.get("Content-Length", 0))
                if not 0 < size <= 5_000_000:
                    raise ValueError("请求过大或为空")
                body = json.loads(self.rfile.read(size))
                parsed = urlparse(self.path)
                path = parsed.path
                query = {k:v[0] for k,v in parse_qs(parsed.query).items()}
                if application and path.startswith('/api/app/'):
                    if path == '/api/app/session': return self.respond(application.remember(body.get('workspace'),body.get('notebook'),body.get('editors')))
                    if path == '/api/app/quit':
                        self.respond({'ok': True})
                        threading.Thread(target=self.server.shutdown, daemon=True).start()
                        return
                    if path == '/api/app/open': return self.respond(application.open(body['path'], body.get('create',False)))
                    if path == '/api/app/initialize': return self.respond(application.get(body['workspace']).environment.start())
                    if path == '/api/app/examples': return self.respond(application.examples(body['workspace']))
                    return self.respond({'error':'Not found'},404)
                if path == '/api/ai/config': return self.respond(ai.configure(body))
                workspace = application.get(query.get('workspace') or self.headers.get('X-Slide-Workspace')) if application else initial_workspace
                if path == '/api/ai/images': return self.respond(upload_image(workspace,body))
                if path == '/api/ai/selections': return self.respond(register_selections(workspace,body))
                if path == '/api/ai/pdf-context': return self.respond(register_pdf_context(workspace,body))
                if path == '/api/ai/sessions': return self.respond(chat_sessions.write(workspace,body))
                if path == '/api/ai/sessions/move': return self.respond(chat_sessions.move(workspace,body.get('path'),body.get('destination')))
                if path == '/api/ai/chat': return self.send_ai(workspace,body)
                if path == '/api/ai/test': return self.send_ai(workspace,body,True)
                if path == '/api/ai/guard': return self.respond(ai.guard(workspace,body))
                if path == '/api/ai/cancel': return self.respond(ai.cancel(workspace,body.get('requestId')))
                if path == '/api/files/mutate': return self.respond(workspace.mutate(body['operation'],body.get('path',''),body.get('destination'),body.get('revision')))
                if path == '/api/files/import-directory': return self.respond(workspace.import_directory(body['path']))
                if path == "/api/notebooks":
                    return self.respond(workspace.create(body.get("title", "未命名笔记"),body.get('directory')))
                if path == '/api/notebooks/rename':
                    return self.respond(workspace.rename_notebook(body['path'],body['title'],body['revision']))
                _, store, runner = workspace.notebook(body.get("path"))
                if path == "/api/save":
                    with workspace.lock:
                        return self.respond(store.save(body["document"], body["revision"]))
                if path == "/api/interrupt":
                    runner.stop()
                    return self.respond({"ok": True})
                if path == "/api/run":
                    current = store.get()
                    if "revision" in body and body["revision"] != current["revision"]:
                        raise FileExistsError("笔记已更改，请重新读取版本后运行。")
                    document = current["document"]
                    return self.respond(runner.run({"document": copy.deepcopy(document),
                        "force": bool(body.get("force")), "target": body.get("target"),
                        "control": body.get("control")}, revision=current["revision"]))
                return self.respond({"error": "Not found"}, 404)
            except FileExistsError as exc:
                self.respond({"error": str(exc)}, 409)
            except (ValueError, KeyError, TypeError) as exc:
                self.respond({"error": str(exc)}, 400)
            except Exception as exc:
                self.respond({"error": str(exc)}, 500)
    return Handler


def main():
    parser = argparse.ArgumentParser(description="Slide Notes · 本地分页笔记，Ctrl+C 停止")
    parser.add_argument("--port", type=int, default=2720)
    parser.add_argument("--document", type=Path, default=Path.cwd() / "notebooks/notebook.json")
    parser.add_argument("--workspace", type=Path, help="Files 面板的工作区根目录，默认为项目目录")
    args = parser.parse_args()
    if not args.document.exists():
        args.document.parent.mkdir(parents=True, exist_ok=True)
        args.document.write_bytes((ROOT / "example.json").read_bytes())
    document_path = args.document.resolve()
    workspace_root = args.workspace or (Path.cwd() if document_path.is_relative_to(Path.cwd()) else document_path.parent)
    workspace = Workspace(workspace_root, Store(document_path))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_factory(workspace))
    server.daemon_threads = True
    print(f"\nSlide Notes → http://127.0.0.1:{server.server_port}\n笔记：{args.document}\n按 Ctrl+C 停止服务和计算。\n", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print("\n已停止。", flush=True)
    finally:
        workspace.stop()
        server.server_close()


if __name__ == "__main__":
    main()
