"""A small persistent Python kernel; with real marimo UI objects bridged to the slide interface."""
from __future__ import annotations

import builtins
import contextlib
import io
import json
import traceback
from time import perf_counter

from marimo._ast.compiler import compile_cell
from plotly.utils import PlotlyJSONEncoder
from slide_notes.notebook.marimo_bridge import MarimoBridge, UIElement


class OutputBuffer(io.StringIO):
    def write(self, text):
        remaining = max(0, 30_000 - self.tell())
        super().write(text[:remaining])
        return len(text)


class Note:
    def __init__(self, values):
        self.values = values
        self.cell = ""
        self.controls = []

    def slider(self, label, minimum=-2, maximum=2, step=0.05, value=0, *, key=None):
        if not minimum < maximum or step <= 0:
            raise ValueError("slider 需要 minimum < maximum 且 step > 0")
        identity = self.cell + ":" + str(key or label)
        if any(c["key"] == identity for c in self.controls):
            raise ValueError("同一 cell 中 slider 的 key 不能重复")
        current = min(maximum, max(minimum, self.values.get(identity, value)))
        self.values[identity] = current
        self.controls.append(dict(key=identity, label=str(label), minimum=minimum,
                                  maximum=maximum, step=step, value=current))
        return current

    @staticmethod
    def markdown(text):
        return {"kind": "markdown", "text": str(text)}


def preview(value):
    try:
        if isinstance(value, UIElement):
            return f"{type(value).__name__}.value = {value.value!r}"[:1500]
        return repr(value)[:1500]
    except Exception:
        return "<无法显示>"


class Kernel:
    def __init__(self):
        self.values = {}
        self.note = Note(self.values)
        self.marimo = MarimoBridge()
        self.rich_results = {}
        self.namespace = {"__builtins__": builtins, "__name__": "__notebook__", "note": self.note}
        self.cells = {}
        self.outputs = {}
        self.errors = {}
        self.graph = []
        self.edges = []

    @staticmethod
    def descendants(ids, edges):
        ids = set(ids)
        while True:
            expanded = ids | {e["to"] for e in edges if e["from"] in ids}
            if expanded == ids:
                return ids
            ids = expanded

    def run(self, document, *, target=None, force=False, control=None):
        previous, old_edges = self.cells, self.edges
        cells, parse_errors = {}, {}
        self.graph, self.edges = [], []
        for slide in document["slides"]:
            for cell in slide["cells"]:
                if cell["kind"] != "code":
                    continue
                entry = {**cell, "slide": slide["name"], "compiled": None}
                try:
                    entry["compiled"] = compile_cell(cell["source"], cell_id=cell["id"])
                    if "note" in entry["compiled"].defs:
                        raise ValueError("note 是内置控件接口，请使用其他变量名")
                except Exception as exc:
                    parse_errors[cell["id"]] = f"{type(exc).__name__}: {exc}"
                cells[cell["id"]] = entry
        owners = {}
        for identity, cell in cells.items():
            compiled = cell["compiled"]
            if compiled:
                for name in compiled.defs:
                    owners.setdefault(name, []).append(identity)
        for name, ids in owners.items():
            if len(ids) > 1:
                for identity in ids:
                    parse_errors[identity] = f"变量 {name} 在多个 cell 中定义，请保留一个定义。"
        for identity, cell in cells.items():
            compiled = cell["compiled"]
            refs, defs = (compiled.refs, compiled.defs) if compiled else (set(), set())
            inputs = sorted(refs - set(dir(builtins)) - {"note"})
            self.graph.append(dict(id=identity, slide=cell["slide"], inputs=inputs,
                                   outputs=sorted(defs)))
            for name in inputs:
                for owner in owners.get(name, []):
                    if owner != identity:
                        self.edges.append({"from": owner, "to": identity, "variable": name})
        changed = {i for i in cells.keys() | previous.keys()
                   if i not in cells or i not in previous or cells[i]["source"] != previous[i]["source"]}
        # Remove old definitions AND downstream values before attempting a rerun.
        dirty = self.descendants(changed, old_edges + self.edges)
        if force:
            dirty |= set(cells)
        if target:
            dirty |= self.descendants({target}, self.edges)
        if control:
            key, value = control["key"], control["value"]
            if key.startswith('mo:'):
                owner = self.marimo.update(key, value, dirty | set(parse_errors))
                # Match marimo: update the object, rerun readers, never reconstruct its creator.
                dirty |= self.descendants({owner}, self.edges) - {owner}
            else:
                value = float(value)
                available = {c["key"]: (i, c) for i, out in self.outputs.items()
                             for c in out.get("controls", [])}
                if key not in available:
                    raise ValueError("控件已变更，请重新运行所属 cell")
                owner, spec = available[key]
                self.values[key] = min(spec["maximum"], max(spec["minimum"], value))
                dirty |= self.descendants({owner}, self.edges)
        dirty |= set(parse_errors)
        self.marimo.drop(dirty)
        for identity in dirty:
            self.rich_results.pop(identity, None)
            for cell in (previous.get(identity), cells.get(identity)):
                if cell and cell["compiled"]:
                    for name in cell["compiled"].defs:
                        self.namespace.pop(name, None)
            self.outputs.pop(identity, None)
            self.errors.pop(identity, None)
        self.cells = cells
        self.namespace["note"] = self.note
        self.errors.update(parse_errors)
        # Kahn ordering also identifies downstream cells blocked by a cycle.
        parents = {i: {e["from"] for e in self.edges if e["to"] == i} for i in cells}
        pending, ordered = set(cells), []
        while pending:
            ready = [i for i in cells if i in pending and not (parents[i] & pending)]
            if not ready:
                for identity in pending:
                    self.errors[identity] = "循环依赖：请检查输入和输出关系。"
                    self.outputs.pop(identity, None)
                    for name in cells[identity]["compiled"].defs:
                        self.namespace.pop(name, None)
                break
            ordered.extend(ready)
            pending.difference_update(ready)
        # A formerly invalid graph may become runnable without changing a cell's code.
        dirty |= {i for i in cells if i not in self.outputs}
        for identity in ordered:
            if identity not in dirty or identity in parse_errors:
                continue
            if any(p in self.errors for p in parents[identity]):
                self.errors[identity] = "上游 cell 运行失败，已暂停此 cell。"
                self.outputs.pop(identity, None)
                continue
            cell = cells[identity]["compiled"]
            self.note.cell, self.note.controls = identity, []
            output = OutputBuffer()
            self.errors.pop(identity, None)
            started = perf_counter()
            try:
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                    if cell.body:
                        exec(cell.body, self.namespace)
                    result = eval(cell.last_expr, self.namespace) if cell.last_expr else None
                duration_ms = (perf_counter() - started) * 1000
                self.marimo.register(identity, {name: self.namespace.get(name) for name in cell.defs}, result)
                rendered = self.marimo.render(result)
                if rendered is not None:
                    self.rich_results[identity] = result
                elif hasattr(result, "to_plotly_json"):
                    rendered = {"kind": "plotly", "figure": json.loads(json.dumps(
                        result.to_plotly_json(), cls=PlotlyJSONEncoder))}
                elif isinstance(result, dict) and result.get("kind") == "markdown":
                    rendered = result
                elif result is not None:
                    rendered = {"kind": "text", "text": preview(result)}
                self.outputs[identity] = {"controls": self.note.controls,
                                          "stdout": output.getvalue(), "result": rendered,
                                          "durationMs": duration_ms}
            except BaseException:
                self.marimo.drop({identity})
                self.rich_results.pop(identity, None)
                self.errors[identity] = traceback.format_exc(limit=5)
                for name in cell.defs:
                    self.namespace.pop(name, None)
                self.outputs[identity] = {"controls": self.note.controls,
                                          "stdout": output.getvalue(), "result": None,
                                          "durationMs": (perf_counter() - started) * 1000}
        # A widget can be shown in several outputs; synchronize them without executing their cells.
        for identity, result in list(self.rich_results.items()):
            if identity in self.outputs and identity not in self.errors:
                self.outputs[identity]['result'] = self.marimo.render(result)
        variables = []
        for node in self.graph:
            if node["id"] in self.errors:
                continue
            for name in node["outputs"]:
                if name in self.namespace:
                    value = self.namespace[name]
                    variables.append({"name": name, "cell": node["id"],
                                      "type": type(value).__name__, "value": preview(value)})
        return {"outputs": self.outputs, "errors": self.errors, "graph": self.graph,
                "edges": self.edges, "variables": variables}


def worker(connection, cwd=None):
    import signal
    import os
    import sys
    if cwd is not None:
        os.chdir(cwd)
        sys.path.insert(0, str(cwd))
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    kernel = Kernel()
    try:
        while True:
            request = connection.recv()
            try:
                connection.send({"ok": True, "state": kernel.run(**request)})
            except BaseException as exc:
                connection.send({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
    except (EOFError, BrokenPipeError):
        pass
