"""JSON-first local client. See docs/guides/agent.md; edits use the server's revision lock."""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
import uuid
from slide_notes.paths import configure_text_streams


class CLIError(Exception):
    def __init__(self, message, code=1):
        super().__init__(message)
        self.code = code


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise CLIError(message, 2)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise CLIError("本地 API 不应重定向，请检查 --url")


class Client:
    def __init__(self, url):
        parsed = urlparse(url)
        if (parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1")
                or parsed.username or parsed.password or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment):
            raise CLIError("--url 必须是本机 HTTP 地址，例如 http://127.0.0.1:2720", 2)
        self.url = url.rstrip("/")
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, endpoint, body=None, **query):
        suffix = "?" + urlencode({k: v for k, v in query.items() if v is not None}) if query else ""
        workspace = getattr(self, 'workspace', None)
        if workspace: suffix += ("&" if suffix else "?") + urlencode({"workspace": workspace})
        data = None if body is None else json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        request = Request(self.url + endpoint + suffix, data=data,
                          headers={"Content-Type": "application/json"} if data else {})
        try:
            with self.opener.open(request, timeout=30) as response:
                result = json.load(response)
        except HTTPError as exc:
            try:
                message = json.loads(exc.read()).get("error", str(exc))
            except (ValueError, AttributeError):
                message = str(exc)
            if exc.code == 404 and endpoint == "/api/runtime":
                message = "服务版本较旧，请 Ctrl+C 后重新执行 ./start-notes.sh"
            raise CLIError(message, 3 if exc.code == 409 else 1) from None
        except (URLError, TimeoutError) as exc:
            raise CLIError(f"无法连接或请求超时：{exc}。先运行 ./start-notes.sh；运行超时可用 interrupt 停止内核。") from None
        if isinstance(result, dict) and result.get("ok") is False:
            raise CLIError(result.get("error", "服务请求失败"))
        return result


def read_text(filename):
    return sys.stdin.read() if filename == "-" else Path(filename).read_text(encoding="utf-8")


def read_json(filename):
    return json.loads(read_text(filename))


def check_document(document):
    # Reuse the same validator as browser saves; do not execute notebook sources.
    from slide_notes.web.server import validate
    validate(document)


def find_slide(document, identity):
    for slide in document["slides"]:
        if slide["id"] == identity:
            return slide
    raise ValueError(f"页面不存在：{identity}")


def find_cell(document, identity):
    for slide in document["slides"]:
        for cell in slide["cells"]:
            if cell["id"] == identity:
                return slide, cell
    raise ValueError(f"cell 不存在：{identity}")


def insert_before(items, item, before):
    if before is None:
        items.append(item)
        return
    for index, candidate in enumerate(items):
        if candidate["id"] == before:
            items.insert(index, item)
            return
    raise ValueError(f"目标位置不存在：{before}")


def display(value):
    value = "normal" if value == "slide" else value
    if value not in ("normal", "fragment", "skip"):
        raise ValueError("display 必须是 slide、fragment 或 skip")
    return value


def apply_operations(document, operations):
    if not isinstance(operations, list) or not operations or len(operations) > 1000:
        raise ValueError("operations 必须是包含 1–1000 项的数组")
    updated = copy.deepcopy(document)
    results = []
    fields = {
        "notebook.rename": {"title"}, "slide.add": {"id", "name", "before"},
        "slide.update": {"id", "name"}, "slide.delete": {"id"}, "slide.move": {"id", "before"},
        "cell.add": {"id", "slide", "kind", "source", "sourceFile", "display", "showCode", "layout", "before"},
        "cell.update": {"id", "source", "sourceFile", "display", "showCode", "layout"},
        "cell.delete": {"id"}, "cell.move": {"id", "slide", "before"},
    }
    for number, op in enumerate(operations, 1):
        try:
            if not isinstance(op, dict) or op.get("op") not in fields:
                raise ValueError("未知操作")
            action = op["op"]
            unknown = op.keys() - fields[action] - {"op"}
            if unknown:
                raise ValueError("未知字段：" + ", ".join(sorted(unknown)))
            identity = op.get("id")
            if action == "notebook.rename":
                updated["title"] = op["title"]
            elif action == "slide.add":
                identity = identity or "s" + uuid.uuid4().hex
                insert_before(updated["slides"], {"id": identity, "name": op["name"], "cells": []}, op.get("before"))
            elif action.startswith("slide."):
                slide = find_slide(updated, op["id"])
                if action == "slide.update":
                    slide["name"] = op["name"]
                elif action == "slide.delete":
                    if len(updated["slides"]) == 1:
                        raise ValueError("不能删除最后一页")
                    updated["slides"].remove(slide)
                elif op.get("before") != identity:
                    updated["slides"].remove(slide)
                    insert_before(updated["slides"], slide, op.get("before"))
            elif action in ("cell.add", "cell.update"):
                if "source" in op and "sourceFile" in op:
                    raise ValueError("source 和 sourceFile 不能同时提供")
                if action == "cell.add":
                    identity = identity or "c" + uuid.uuid4().hex
                    kind = "code" if op["kind"] == "python" else op["kind"]
                    cell = {"id": identity, "kind": kind, "source": "", "display": "normal", "showCode": False}
                    insert_before(find_slide(updated, op["slide"])["cells"], cell, op.get("before"))
                else:
                    _, cell = find_cell(updated, op["id"])
                for key in ("source", "showCode", "layout"):
                    if key in op:
                        if key == "layout" and op[key] is None:
                            cell.pop(key, None)
                        else:
                            cell[key] = copy.deepcopy(op[key])
                if "sourceFile" in op:
                    if op["sourceFile"] == "-":
                        raise ValueError("批量 sourceFile 请使用文件路径；stdin 用于整个 operations JSON")
                    cell["source"] = read_text(op["sourceFile"])
                if "display" in op:
                    cell["display"] = display(op["display"])
                if not isinstance(cell.get("showCode", False), bool):
                    raise ValueError("showCode 必须为布尔值")
            else:
                source_slide, cell = find_cell(updated, op["id"])
                if action == "cell.delete":
                    source_slide["cells"].remove(cell)
                elif op.get("before") != identity or op["slide"] != source_slide["id"]:
                    destination = find_slide(updated, op["slide"])
                    source_slide["cells"].remove(cell)
                    cell.pop("layout", None)
                    insert_before(destination["cells"], cell, op.get("before"))
            results.append({"op": action, "id": identity})
        except (KeyError, TypeError, ValueError, OSError) as exc:
            raise ValueError(f"第 {number} 个操作失败：{exc}") from None
    check_document(updated)
    return updated, results


def summarize(document):
    return {"title": document["title"], "slides": [
        {"id": slide["id"], "name": slide["name"], "cells": [
            {k: cell[k] for k in ("id", "kind", "display", "showCode", "layout") if k in cell}
            for cell in slide["cells"]]} for slide in document["slides"]]}


def summarize_result(result):
    if not result:
        return result
    if result.get('kind') == 'plotly':
        return {'kind': 'plotly'}
    if result.get('kind') == 'marimo':
        return {**result, 'widgets': [{k: v for k, v in spec.items() if k != 'figure'}
                                     for spec in result['widgets']]}
    return result


def runtime_view(state, view):
    if state is None or view == "all":
        return state
    if view == "graph":
        return {"nodes": state["graph"], "edges": state["edges"]}
    if view != "summary":
        return state[view]
    return {"errors": state["errors"], "variables": state["variables"], "outputs": {
        identity: {**{k: output.get(k) for k in ("stdout", "controls", "durationMs")},
                   "result": summarize_result(output.get("result"))}
        for identity, output in state["outputs"].items()}}


def add_edit_options(parser):
    parser.add_argument("--revision", help="预期版本；不匹配时拒绝修改，不自动重试")
    parser.add_argument("--dry-run", action="store_true", help="校验并返回修改后的文档，不保存")


def add_source_options(parser, required=False):
    group = parser.add_mutually_exclusive_group(required=required)
    group.add_argument("--source", help="单行内容；多行建议 --source-file")
    group.add_argument("--source-file", help="UTF-8 文件，- 表示 stdin")
    parser.add_argument("--display", choices=("slide", "fragment", "skip"))
    parser.add_argument("--show-code", choices=("true", "false"))


def parser():
    root = Parser(prog="notes", description="Slide Notes agent CLI · 默认 JSON 输出；需先启动 ./start-notes.sh")
    root.add_argument("--url", default=os.environ.get("SLIDE_NOTES_URL", "http://127.0.0.1:2720"))
    root.add_argument('--workspace', default=os.environ.get('SLIDE_NOTES_WORKSPACE'), help='工作区 ID，见 workspace list / open')
    root.add_argument("--notebook", default=os.environ.get("SLIDE_NOTES_NOTEBOOK"), help="相对服务工作区的笔记路径；省略使用服务启动笔记")
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="查看服务和当前笔记摘要")
    listing = commands.add_parser("list", help="列出工作区笔记")
    listing.add_argument("--query", default="")
    new = commands.add_parser("create", help="创建空白笔记，返回路径和第一页 ID")
    new.add_argument("--title", required=True)
    new.add_argument('--directory', help='工作区内的相对目录；默认当前笔记所在目录')
    workspace = commands.add_parser('workspace', help='工作区列表、打开/创建和环境状态')
    ws = workspace.add_subparsers(dest='action', required=True)
    ws.add_parser('list')
    for action in ('open', 'create'):
        ws.add_parser(action).add_argument('path', help='绝对路径')
    ws.add_parser('environment')
    ws.add_parser('initialize')
    files = commands.add_parser('files', help='真实目录操作；move/copy/trash 要求 impact 返回的 revision')
    fs = files.add_subparsers(dest='action', required=True)
    listing_files = fs.add_parser('list')
    listing_files.add_argument('path', nargs='?', default='')
    listing_files.add_argument('--notes-only', action='store_true')
    fs.add_parser('trash-list')
    for action in ('mkdir', 'impact', 'move', 'copy', 'trash', 'restore'):
        command = fs.add_parser(action)
        command.add_argument('path')
        if action in ('move','copy'): command.add_argument('destination')
        if action in ('move','copy','trash'): command.add_argument('--revision', required=True)
    show = commands.add_parser("show", help="读取笔记、页面或 cell")
    selector = show.add_mutually_exclusive_group()
    selector.add_argument("--slide")
    selector.add_argument("--cell")
    show.add_argument("--summary", action="store_true", help="仅列结构，不含源码")
    validate = commands.add_parser("validate", help="校验文档结构，不执行 Python")
    validate.add_argument("--file", help="本地 JSON 文件或 -；省略时校验服务中的笔记")
    batch = commands.add_parser("apply", help="按顺序执行操作数组，一次原子保存")
    batch.add_argument("--file", required=True, help="operations JSON 文件或 -")
    add_edit_options(batch)
    replace = commands.add_parser("replace", help="用完整文档替换笔记；必须提供先前读取的 revision")
    replace.add_argument("--file", required=True)
    replace.add_argument("--revision", required=True)
    replace.add_argument("--dry-run", action="store_true")
    rename = commands.add_parser("rename", help="修改笔记标题")
    rename.add_argument("title")
    add_edit_options(rename)
    for entity in ("slide", "cell"):
        group = commands.add_parser(entity, help="增删改移页面" if entity == "slide" else "增删改移 cell")
        subs = group.add_subparsers(dest="action", required=True)
        for action in ("add", "update", "delete", "move"):
            sub = subs.add_parser(action)
            add_edit_options(sub)
            sub.add_argument("--id", required=action != "add", help="稳定 ID（字母数字），添加时可省略自动生成")
            if action in ("add", "move"):
                sub.add_argument("--before", help="插入指定 ID 之前；省略追加到末尾")
            if entity == "slide" and action in ("add", "update"):
                sub.add_argument("--name", required=True)
            if entity == "cell":
                if action in ("add", "move"):
                    sub.add_argument("--slide", required=True, help="目标页面 ID")
                if action == "add":
                    sub.add_argument("--kind", required=True, choices=("python", "markdown", "html"))
                if action in ("add", "update"):
                    add_source_options(sub, required=action == "add")
    views = ("summary", "all", "outputs", "variables", "graph", "errors")
    run = commands.add_parser("run", help="执行保存的笔记，返回运行结果")
    run.add_argument("--cell", help="重算指定 Python cell 及下游（仍会计算其他脏依赖）")
    run.add_argument("--force", action="store_true", help="重算全部 Python cell")
    events = run.add_mutually_exclusive_group()
    events.add_argument("--event", nargs=2, metavar=("KEY", "JSON"), help="发送 mo 控件事件，值为 JSON（数字、布尔、选项数组或选择对象）")
    events.add_argument("--control", nargs=2, metavar=("KEY", "VALUE"), help="修改已创建滑杆的值并重算")
    run.add_argument("--revision", help="要求执行指定版本")
    run.add_argument("--view", choices=views, default="summary")
    runtime = commands.add_parser("runtime", help="只读上次运行状态，不执行代码")
    runtime.add_argument("--view", choices=views, default="summary")
    commands.add_parser("interrupt", help="停止并重置该笔记的 Python 会话")
    return root


def dispatch(args):
    if args.command == "validate" and args.file:
        document = read_json(args.file)
        check_document(document)
        return {"valid": True, **summarize(document)}, 0
    client = Client(args.url)
    client.workspace = args.workspace
    if args.command == 'workspace':
        if args.action == 'list': return client.request('/api/app/home'), 0
        if args.action in ('open', 'create'):
            return client.request('/api/app/open', {'path': args.path, 'create': args.action=='create'}), 0
        if args.action == 'environment': return client.request('/api/app/environment'), 0
        if not args.workspace: raise ValueError('initialize 需要 --workspace ID')
        return client.request('/api/app/initialize', {'workspace': args.workspace}), 0
    if args.command == 'files':
        if args.action == 'list': return client.request('/api/files', path=args.path, notes='1' if args.notes_only else '0'), 0
        if args.action == 'impact': return client.request('/api/files/impact', path=args.path), 0
        if args.action == 'trash-list': return client.request('/api/files/trash'), 0
        return client.request('/api/files/mutate', {'operation': args.action, 'path': args.path,
            'destination': getattr(args,'destination',None), 'revision': getattr(args,'revision',None)}), 0
    if args.command == "list":
        return client.request("/api/search", q=args.query, notes="1"), 0
    if args.command == "create":
        return client.request("/api/notebooks", {"title": args.title, 'directory': args.directory}), 0
    if args.command == "runtime":
        result = client.request("/api/runtime", path=args.notebook)
        result["state"] = runtime_view(result["state"], args.view)
        return result, 0
    if args.command == "interrupt":
        return client.request("/api/interrupt", {"path": args.notebook}), 0
    current = client.request("/api/document", path=args.notebook)
    document, revision, path = current["document"], current["revision"], current["path"]
    expected = getattr(args, "revision", None)
    if expected is not None and expected != revision:
        raise CLIError("版本冲突：请重新 show，并基于新版本调整操作", 3)
    if args.command == "status":
        return {"url": client.url, "path": path, "workspace": current["workspace"], "revision": revision,
                **summarize(document)}, 0
    if args.command == "show":
        selected = summarize(document) if args.summary else document
        if args.slide:
            selected = find_slide(selected, args.slide)
        if args.cell:
            _, selected = find_cell(selected, args.cell)
        return {"path": path, "revision": revision, "document": selected}, 0
    if args.command == "validate":
        check_document(document)
        return {"path": path, "revision": revision, "valid": True, **summarize(document)}, 0
    if args.command == "run":
        if args.cell and find_cell(document, args.cell)[1]["kind"] != "code":
            raise ValueError("--cell 只能指定 Python cell")
        body = {"path": path, "revision": revision, "force": args.force, "target": args.cell}
        if args.control:
            value = float(args.control[1])
            if not math.isfinite(value):
                raise ValueError("控件值必须是有限数字")
            body["control"] = {"key": args.control[0], "value": value}
        if args.event:
            body["control"] = {"key": args.event[0], "value": json.loads(args.event[1])}
        result = client.request("/api/run", body)
        state = result["state"]
        return {"path": path, "revision": revision, "state": runtime_view(state, args.view)}, 4 if state["errors"] else 0
    if args.command == "replace":
        updated = read_json(args.file)
        check_document(updated)
        operations = [{"op": "notebook.replace"}]
    else:
        if args.command == "apply":
            operations = read_json(args.file)
        elif args.command == "rename":
            operations = [{"op": "notebook.rename", "title": args.title}]
        else:
            operation = {"op": args.command + "." + args.action}
            for key in ("id", "name", "before", "slide", "kind", "source", "display"):
                if getattr(args, key, None) is not None:
                    operation[key] = getattr(args, key)
            if getattr(args, "source_file", None) is not None:
                operation["source"] = read_text(args.source_file)
            if getattr(args, "show_code", None) is not None:
                operation["showCode"] = args.show_code == "true"
            operations = [operation]
        updated, operations = apply_operations(document, operations)
    result = {"path": path, "previousRevision": revision, "operations": operations}
    if args.dry_run:
        return {**result, "dryRun": True, "revision": revision, "document": updated}, 0
    if updated == document:
        return {**result, "changed": False, "revision": revision}, 0
    saved = client.request("/api/save", {"path": path, "revision": revision, "document": updated})
    return {**result, "changed": True, **saved}, 0


def main(argv=None):
    configure_text_streams(include_stdin=True)
    try:
        args = parser().parse_args(argv)
        result, code = dispatch(args)
        print(json.dumps({"ok": code == 0, **result}, ensure_ascii=False, indent=2, allow_nan=False))
        return code
    except KeyboardInterrupt:
        message = "命令已中断；若 run 已提交，执行 ./notes interrupt 停止该笔记的计算（指定同一 --url / --notebook）。"
        print(json.dumps({"ok": False, "error": message, "exitCode": 130}, ensure_ascii=False), file=sys.stderr)
        return 130
    except (CLIError, ValueError, OSError, KeyError, TypeError) as exc:
        code = exc.code if isinstance(exc, CLIError) else 2
        print(json.dumps({"ok": False, "error": str(exc), "exitCode": code}, ensure_ascii=False), file=sys.stderr)
        return code


if __name__ == "__main__":
    sys.exit(main())
