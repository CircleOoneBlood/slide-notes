"""Regression coverage for reactive execution, graph failures and local persistence."""
from _paths import PACKAGE_ROOT
import copy
import json
import os
import sys
from unittest.mock import patch
from pathlib import Path
import tempfile
import unittest

from slide_notes.notebook.runtime import Kernel
from slide_notes.web.server import Runner, Store, validate


def document(*sources):
    return {'version':1,'title':'test','slides':[{'id':'page','name':'test','cells':[
        {'id':f'c{i}','kind':'code','source':source,'display':'normal'}
        for i,source in enumerate(sources)
    ]}]}


class RuntimeTests(unittest.TestCase):
    def test_sample_and_control_only_rerun_descendants(self):
        kernel = Kernel()
        sample = json.loads((PACKAGE_ROOT/'example.json').read_text())
        first = kernel.run(sample)
        self.assertFalse(first['errors'])
        grid = kernel.namespace['grid_x1']
        result = kernel.run(sample, control={'key':'parameters:x1','value':1.5})
        self.assertAlmostEqual(kernel.namespace['height'], 2.61)
        self.assertIs(grid,kernel.namespace['grid_x1'])
        self.assertIn({'from':'parameters','to':'point','variable':'x1'},result['edges'])

    def test_workspace_worker_bootstrap_without_inherited_source_path(self):
        class Environment:
            python = Path(sys.executable)
            def snapshot(self):
                return {'status': 'ready'}
        with tempfile.TemporaryDirectory(prefix='notes-worker-layout-') as directory:
            root = Path(directory)
            (root/'helper.py').write_text('value = 42\n')
            runner = Runner(root, Environment())
            try:
                with patch.dict(os.environ):
                    os.environ.pop('PYTHONPATH', None)
                    result = runner.run({'document': document('from helper import value\nanswer = value + 1\nanswer')}, 'worker-r1')
                self.assertTrue(result['ok'], result)
                self.assertFalse(result['state']['errors'], result)
                self.assertTrue(any(value['name']=='answer' and value['value']=='43'
                                    for value in result['state']['variables']), result)
            finally:
                runner.stop()

    def test_cross_page_skip_and_function_globals(self):
        d = document('offset = 3','def f(x):\n    return x + offset','result = f(2)\nresult')
        d['slides'][0]['cells'][0]['display'] = 'skip'
        d['slides'].append({'id':'p2','name':'second','cells':[d['slides'][0]['cells'].pop()]})
        k = Kernel(); state = k.run(d)
        self.assertEqual(k.namespace['result'],5)
        self.assertIn({'from':'c0','to':'c1','variable':'offset'},state['edges'])
        d['slides'][0]['cells'][0]['source'] = 'offset = 7'
        k.run(d)
        self.assertEqual(k.namespace['result'],9)

    def test_failure_invalidates_descendants_and_recovers(self):
        d=document('x=2','y=x+1','z=y+1'); k=Kernel(); k.run(d)
        d['slides'][0]['cells'][0]['source']='x=1/0'
        state=k.run(d)
        self.assertEqual(set(state['errors']),{'c0','c1','c2'})
        self.assertNotIn('z',k.namespace)
        self.assertFalse(state['variables'])
        d['slides'][0]['cells'][0]['source']='x=5'
        self.assertFalse(k.run(d)['errors'])
        self.assertEqual(k.namespace['z'],7)

    def test_cycle_and_duplicate_definitions(self):
        k=Kernel(); d=document('x=y+1','y=x+1')
        self.assertEqual(len(k.run(d)['errors']),2)
        d['slides'][0]['cells'][0]['source']='x=1'
        self.assertFalse(k.run(d)['errors'])
        d['slides'][0]['cells'][1]['source']='x=2'
        self.assertEqual(len(k.run(d)['errors']),2)
        d['slides'][0]['cells'].pop()
        self.assertFalse(k.run(d)['errors'])
        self.assertEqual(k.namespace['x'],1)

    def test_removed_definition_does_not_leak(self):
        d=document('x=2','y=x+1'); k=Kernel(); k.run(d)
        d['slides'][0]['cells'][0]['source']='new_x=3'
        state=k.run(d)
        self.assertIn('c1',state['errors'])
        self.assertNotIn('x',k.namespace)
        self.assertNotIn('y',k.namespace)

    def test_local_temporary_scope(self):
        k=Kernel(); state=k.run(document('_tmp = 2\nx = _tmp + 1','_tmp = 8\ny = _tmp + 1'))
        self.assertFalse(state['errors'])
        self.assertEqual((k.namespace['x'],k.namespace['y']),(3,9))

    def test_atomic_save_and_conflict(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'note.json'; original=document('x=1')
            path.write_text(json.dumps(original))
            store=Store(path); loaded=store.get(); changed=copy.deepcopy(original); changed['title']='new'
            store.save(changed,loaded['revision'])
            with self.assertRaises(FileExistsError): store.save(original,loaded['revision'])
            self.assertEqual(store.get()['document']['title'],'new')
            self.assertFalse(path.with_suffix('.json.tmp').exists())

    def test_invalid_display_is_rejected(self):
        d=document('x=1'); d['slides'][0]['cells'][0]['display']='sub-slide'
        with self.assertRaises(ValueError): validate(d)


if __name__ == '__main__':
    unittest.main()
