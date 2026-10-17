"""Real marimo 0.25.1 objects connected to Slide Notes' UI and scheduler.

Internal marimo API usage is isolated here; the pinned version is intentional.
No replacement module, monkey-patching, or marimo server context is installed.
"""
from __future__ import annotations

import copy
import json
import math
import re

from marimo import Html
from marimo._plugins.ui._core.ui_element import UIElement
from plotly.utils import PlotlyJSONEncoder

SUPPORTED = {"marimo-slider", "marimo-number", "marimo-checkbox", "marimo-dropdown",
             "marimo-text", "marimo-plotly"}


class MarimoBridge:
    def __init__(self):
        self.elements = {}

    def drop(self, cells):
        self.elements = {key: entry for key, entry in self.elements.items() if entry['cell'] not in cells}

    def register(self, cell, bindings, result):
        seen = set()

        def walk(value, name=None, depth=0):
            if id(value) in seen or depth > 12:
                return
            seen.add(id(value))
            if isinstance(value, UIElement):
                tag = value._args.component_name
                if tag not in SUPPORTED:
                    raise ValueError(f"Slide Notes 尚未接入 {tag}；请查看 docs/guides/mo.md 的支持列表")
                if value._on_change is not None:
                    raise ValueError("当前 mo 桥接不支持 on_change；请在下游 cell 读取控件 .value")
                key = 'mo:' + str(value._id)
                if key not in self.elements:
                    self.elements[key] = {'cell': cell, 'element': value, 'name': name}
                return
            if isinstance(value, Html):
                for child in getattr(value, '_live_children', getattr(value, '_children', [])):
                    walk(child, name, depth + 1)
            elif isinstance(value, (list, tuple, dict)):
                children = value.values() if isinstance(value, dict) else value
                for child in list(children)[:1000]:
                    walk(child, name, depth + 1)

        for name, value in bindings.items():
            walk(value, name)
        walk(result)

    def spec(self, key):
        entry = self.elements[key]
        element = entry['element']
        args = element._component_args
        kind = element._args.component_name.removeprefix('marimo-')
        spec = {'key': key, 'id': str(element._id), 'cell': entry['cell'], 'name': entry['name'],
                'type': kind, 'label': element._args.label or entry['name'] or '',
                'value': copy.deepcopy(element._value_frontend), 'disabled': args.get('disabled', False),
                'debounce': args.get('debounce', False)}
        if kind in ('slider', 'number'):
            steps = args.get('steps') or []
            spec.update(minimum=0 if steps else args.get('start'),
                        maximum=len(steps)-1 if steps else args.get('stop'),
                        step=1 if steps else args.get('step') or 1, steps=steps,
                        orientation=args.get('orientation', 'horizontal'))
        elif kind == 'dropdown':
            spec.update(options=args['options'], allowNone=args.get('allow-select-none', False))
        elif kind == 'text':
            spec.update(placeholder=args.get('placeholder', ''), maxLength=args.get('max-length'),
                        inputType=args.get('kind', 'text'))
        elif kind == 'plotly':
            spec['figure'] = json.loads(json.dumps(element._figure.to_plotly_json(), cls=PlotlyJSONEncoder))
        return spec

    def update(self, key, value, dirty):
        if key not in self.elements or self.elements[key]['cell'] in dirty:
            raise ValueError('mo 控件已变更，请先运行笔记后再交互')
        entry = self.elements[key]
        spec = self.spec(key)
        if spec['disabled']:
            raise ValueError('该 mo 控件已禁用')
        kind = spec['type']
        if kind in ('slider', 'number'):
            if type(value) not in (float, int) or not math.isfinite(value):
                raise ValueError('控件值必须为有限数字')
            if spec['minimum'] is not None:
                value = max(spec['minimum'], value)
            if spec['maximum'] is not None:
                value = min(spec['maximum'], value)
            if spec['steps']:
                value = int(round(value))
        elif kind == 'checkbox' and type(value) is not bool:
            raise ValueError('checkbox 值必须是布尔值')
        elif kind == 'dropdown':
            if (not isinstance(value, list) or len(value) > 1
                    or any(v not in spec['options'] for v in value)
                    or (not value and not spec['allowNone'])):
                raise ValueError('无效的 dropdown 选项')
        elif kind == 'text':
            if not isinstance(value, str) or len(value) > (spec['maxLength'] or 200_000):
                raise ValueError('无效的 text 内容')
        elif kind == 'plotly':
            if (not isinstance(value, dict) or value.keys() - {'points', 'range', 'lasso', 'indices'}
                    or not isinstance(value.get('points', []), list)
                    or not all(isinstance(p, dict) for p in value.get('points', []))
                    or not isinstance(value.get('indices', []), list)
                    or not isinstance(value.get('range', {}), dict)
                    or not isinstance(value.get('lasso', {}), dict)):
                raise ValueError('无效的 Plotly 选择事件')
        # Real marimo conversion preserves Python .value semantics (e.g. dropdown mappings).
        element = entry['element']
        previous = copy.deepcopy(element._value_frontend)
        try:
            element._update(copy.deepcopy(value))
        except Exception as exc:
            element._update(previous)
            raise ValueError(f'mo 事件处理失败：{exc}') from None
        return entry['cell']

    def render(self, value):
        if not isinstance(value, Html):
            return None
        html = value.text
        ids = list(dict.fromkeys(re.findall(r"<marimo-ui-element\s[^>]*object-id=['\"]([^'\"]+)['\"]", html)))
        widgets = []
        for identity in ids:
            key = 'mo:' + identity
            if key not in self.elements:
                raise ValueError('无法连接 mo 控件；请先把控件赋给变量，再输出控件或 mo.vstack/hstack')
            widgets.append(self.spec(key))
        # Native plugin payloads can contain a whole Plotly figure; transmit it only once.
        html = re.sub(r'(<marimo-ui-element\b[^>]*>).*?</marimo-ui-element>',
                      r'\1</marimo-ui-element>', html, flags=re.S)
        return {'kind': 'marimo', 'html': html, 'widgets': widgets}
