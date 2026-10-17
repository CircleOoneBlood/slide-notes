"""Real marimo objects, dependency execution and stale-event regression tests."""
from _paths import EXAMPLES_ROOT
import json
from pathlib import Path
import unittest

import marimo as mo
from slide_notes.notebook.runtime import Kernel
from test_runtime import document


class MarimoTests(unittest.TestCase):
    def test_slider_updates_reader_without_recreating_creator_or_unrelated_cells(self):
        doc = document('import marimo as mo\nx = mo.ui.slider(-2, 2, step=.1, value=.8, label="x")\nmo.vstack([mo.md("**函数** $x^2$"), x])',
                       'y = x.value ** 2\nmo.md(f"高度：{y:.2f}")', 'unrelated = object()')
        k = Kernel(); state = k.run(doc)
        self.assertFalse(state['errors'])
        result = state['outputs']['c0']['result']
        self.assertEqual(result['kind'], 'marimo')
        self.assertIn('marimo-tex', result['html'])
        self.assertIsInstance(k.namespace['x'], mo.ui.slider)
        key = result['widgets'][0]['key']
        old_slider, unrelated = k.namespace['x'], k.namespace['unrelated']
        duration = state['outputs']['c0']['durationMs']
        state = k.run(doc, control={'key': key, 'value': 1.5})
        self.assertFalse(state['errors'])
        self.assertIs(k.namespace['x'], old_slider)
        self.assertIs(k.namespace['unrelated'], unrelated)
        self.assertEqual(state['outputs']['c0']['durationMs'], duration)
        self.assertEqual(k.namespace['y'], 2.25)
        self.assertEqual(state['outputs']['c0']['result']['widgets'][0]['value'], 1.5)
        self.assertIn('2.25', state['outputs']['c1']['result']['html'])
        self.assertIn({'from':'c0','to':'c1','variable':'x'}, state['edges'])

    def test_event_stale_after_source_change_force_or_deletion(self):
        doc = document('import marimo as mo\nx = mo.ui.slider(0, 10, value=2)\nx', 'y = x.value')
        k = Kernel(); state = k.run(doc)
        key = state['outputs']['c0']['result']['widgets'][0]['key']
        doc['slides'][0]['cells'][0]['source'] += '\n# changed'
        with self.assertRaisesRegex(ValueError, '控件已变更'):
            k.run(doc, control={'key':key, 'value':5})
        k.run(doc, force=True)
        with self.assertRaises(ValueError):
            k.run(doc, control={'key':key, 'value':6})
        doc['slides'][0]['cells'].pop(0)
        state = k.run(doc)
        self.assertIn('c1', state['errors'])
        self.assertFalse(k.marimo.elements)

    def test_checkbox_dropdown_number_text_and_invalid_event(self):
        doc = document('import marimo as mo\nflag = mo.ui.checkbox()\nchoice = mo.ui.dropdown({"平方": 2, "立方":3},value="平方")\nn = mo.ui.number(0,10,value=2)\ntext = mo.ui.text(value="hi")\nmo.vstack([flag,choice,n,text])',
                       'answer = (flag.value, choice.value, n.value, text.value)\nanswer')
        k=Kernel(); state=k.run(doc);self.assertFalse(state['errors'])
        specs = {s['name']:s for s in state['outputs']['c0']['result']['widgets']}
        for name, value in [('flag',True),('choice',['立方']),('n',5),('text','你好')]:
            self.assertFalse(k.run(doc,control={'key':specs[name]['key'],'value':value})['errors'])
        self.assertEqual(k.namespace['answer'],(True,3,5,'你好'))
        for name, value in [('flag',1),('choice',['missing']),('n',float('nan')),('text',42)]:
            with self.assertRaises(ValueError):
                k.run(doc,control={'key':specs[name]['key'],'value':value})
        self.assertEqual(k.namespace['choice'].value,3)

    def test_plotly_selection_runs_downstream_and_preserves_plot(self):
        doc = document('import marimo as mo\nimport plotly.graph_objects as go\nchart = mo.ui.plotly(go.Figure(go.Scatter(x=[1,2], y=[3,5], mode="markers")))\nchart',
                       'selected = chart.value\nmo.md(f"选中 {len(selected)} 个点")')
        k=Kernel();state=k.run(doc);self.assertFalse(state['errors'])
        spec=state['outputs']['c0']['result']['widgets'][0]
        self.assertEqual(spec['type'],'plotly');self.assertIn('figure',spec)
        chart=k.namespace['chart']
        selection={'points':[{'x':2,'y':5,'curveNumber':0,'pointNumber':1,'pointIndex':1}], 'indices':[1]}
        state=k.run(doc,control={'key':spec['key'],'value':selection})
        self.assertFalse(state['errors']);self.assertIs(k.namespace['chart'],chart)
        self.assertEqual(k.namespace['selected'][0]['x'],2)
        self.assertIn('选中 1',state['outputs']['c1']['result']['html'])
        k.run(doc,control={'key':spec['key'],'value':{}})
        self.assertEqual(k.namespace['selected'],[])

    def test_widgets_embedded_in_markdown_and_shown_twice(self):
        doc=document('import marimo as mo\nx = mo.ui.slider(0,10,value=2)\nmo.md(f"选择：{x}")','mo.hstack([x, x])')
        k=Kernel();state=k.run(doc);self.assertFalse(state['errors'])
        key=state['outputs']['c0']['result']['widgets'][0]['key']
        state=k.run(doc,control={'key':key,'value':5})
        self.assertFalse(state['errors'])
        self.assertEqual(state['outputs']['c1']['result']['widgets'][0]['value'],5)

    def test_unsupported_widgets_and_callbacks_report_errors(self):
        for source in ['import marimo as mo\nmo.ui.table([{"a":1}])',
                       'import marimo as mo\nmo.ui.slider(0,10,on_change=lambda v: print(v))']:
            state=Kernel().run(document(source))
            self.assertIn('c0',state['errors'])
            self.assertIsNone(state['outputs']['c0']['result'])

    def test_marimo_demos(self):
        for filename in ('mo-linked.json','mo-selection.json'):
            doc=json.loads((EXAMPLES_ROOT/filename).read_text())
            state=Kernel().run(doc)
            self.assertFalse(state['errors'])


if __name__=='__main__':
    unittest.main()
