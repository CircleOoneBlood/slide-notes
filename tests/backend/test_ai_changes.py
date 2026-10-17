"""Change tracking uses temporary notebooks and never calls a model."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from slide_notes.ai.changes import clean_baseline, clean_report, cell_hash, snapshot_cells, source_diff, change_report
from slide_notes.ai.service import AIService
from slide_notes.ai.sessions import SessionStorage
from slide_notes.ai.tools import NoteAgent
from slide_notes.application import Application, Environment

class ChangeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.patch=patch.object(Environment,'start',Environment.snapshot);self.patch.start()
        self.app=Application(Path(self.temp.name)/'config');info=self.app.open(str(Path(self.temp.name)/'workspace'),create=True);self.workspace=self.app.get(info['id'])
        note=self.workspace.create('Changes');self.path=note['path'];self.store=self.workspace.notebook(self.path)[1]
        doc=note['document'];doc['slides'][0]['cells']=[{'id':'one','kind':'code','source':'x = 1\ny = 2','display':'normal'},{'id':'two','kind':'markdown','source':'SECRET OTHER CELL','display':'normal'}]
        self.store.save(doc,note['revision']);self.current=self.store.get()
        self.baseline=self.snapshot(self.current)
        self.ai=AIService(self.app.config);self.ai.configure({'baseUrl':'http://127.0.0.1:1/v1','model':'fake','apiKey':''})
    def tearDown(self):
        self.app.stop();self.patch.stop();self.temp.cleanup()
    def snapshot(self,current):
        return clean_baseline({'version':1,'title':current['document']['title'],'revision':current['revision'],'coverage':'all','scopeIds':[],'cells':snapshot_cells(current['document'])})
    def save(self,mutate):
        doc=copy.deepcopy(self.current['document']);mutate(doc);self.store.save(doc,self.current['revision']);self.current=self.store.get();return self.current
    def prepare(self,**kwargs):
        self.ai.jobs.clear()
        return self.ai.prepare(self.workspace,{'requestId':'changes-test-123','path':self.path,'revision':self.current['revision'],'prompt':'检查我改的地方','scope':'notebook','changeBaseline':self.baseline,**kwargs})
    def test_server_diff_uses_saved_current_content_and_scoped_config(self):
        self.save(lambda d:d['slides'][0]['cells'][0].update(source='x = 3\ny = 2',showCode=True))
        request=self.prepare(scope='cell',cell='one');report=request['changeReport'];change=report['changes'][0]
        self.assertEqual(change['fields'],['source','showCode']);self.assertIn('-x = 1',change['diff']);self.assertIn('+x = 3',change['diff'])
        self.assertEqual(report['runtime']['status'],'never-run');self.assertNotIn('SECRET OTHER CELL',json.dumps(request['payload']))
        self.assertEqual(request['context']['slides'][0]['cells'][0]['showCode'],True)
    def test_deleted_cell_is_reported_only_with_known_baseline(self):
        self.baseline.update(coverage='partial',scopeIds=['one']);self.baseline['cells']=self.baseline['cells'][:1]
        self.save(lambda d:d['slides'][0]['cells'].pop(0))
        request=self.prepare(scope='cells',cells=['one']);self.assertEqual(request['changeReport']['changes'][0]['kind'],'deleted');self.assertFalse(request['agent'].allowed)
        with self.assertRaisesRegex(ValueError,'不存在'):self.prepare(scope='cell',cell='one',changeBaseline=None)
    def test_new_deleted_moved_and_scope_additions(self):
        def mutate(d):
            cells=d['slides'][0]['cells'];cells.reverse();cells.append({'id':'three','kind':'code','source':'z=3','display':'normal'})
        self.save(mutate);changes={c['id']:c for c in self.prepare()['changeReport']['changes']}
        self.assertEqual(changes['one']['kind'],'moved');self.assertEqual(changes['three']['kind'],'added')
        self.baseline.update(coverage='partial',scopeIds=['one']);self.baseline['cells']=self.baseline['cells'][:1]
        changes={c['id']:c for c in self.prepare(scope='cells',cells=['one','two'])['changeReport']['changes']};self.assertEqual(changes['two']['kind'],'context-added')
    def test_origins_exclusions_and_stale_execution(self):
        old=self.baseline['cells'][0]
        self.save(lambda d:d['slides'][0]['cells'][0].update(source='x = 4'))
        current=snapshot_cells(self.current['document'])[0];origins={'one':{'beforeHash':cell_hash(old),'afterHash':cell_hash(current)}}
        runner=self.workspace.notebook(self.path)[2];runner.last_state={'errors':{}};runner.last_revision=self.baseline['revision']
        request=self.prepare(changeOrigins=origins);self.assertEqual(request['changeReport']['changes'][0]['origin'],'agent');self.assertEqual(request['changeReport']['runtime']['status'],'stale')
        request=self.prepare(changeOrigins=origins,excludedChanges=['one']);self.assertEqual(request['changeReport']['changes'],[]);self.assertEqual(request['changeReport']['excludedCount'],1)
        self.assertIn('x = 4',json.dumps(request['context']))
        self.save(lambda d:d['slides'][0]['cells'][0].update(source='x = 5'));self.assertEqual(self.prepare(changeOrigins=origins)['changeReport']['changes'][0]['origin'],'mixed')
    def test_history_and_session_file_preserve_baseline_and_diff(self):
        self.save(lambda d:d['slides'][0]['cells'][0].update(source='x = 6'))
        report=self.prepare()['changeReport'];request=self.prepare(messages=[{'role':'user','content':'上次问题','changeReport':report},{'role':'assistant','content':'上次回答'}])
        self.assertIn('历史数据',json.dumps(request['payload'],ensure_ascii=False))
        data={'active':'chat','conversations':[{'id':'chat','title':'对话','createdAt':1,'updatedAt':1,'messages':[{'role':'user','content':'问题','changeReport':report}],'changeBaseline':self.baseline,'changeOrigins':{},'excludedChanges':['one']}]}
        storage=SessionStorage();saved=storage.write(self.workspace,{'path':self.path,'revision':None,'data':data});loaded=storage.read(self.workspace,self.path)['data']['conversations'][0]
        self.assertEqual(loaded['changeBaseline'],self.baseline);self.assertEqual(loaded['messages'][0]['changeReport'],report);self.assertTrue((self.workspace.root/saved['file']).exists())
    def test_mutation_events_identify_only_affected_cells(self):
        context=self.ai.context(self.workspace,self.path);agent=NoteAgent(self.workspace,context)
        _,event=agent.execute('apply_note_operations',{'revision':self.current['revision'],'operations':[{'op':'cell.update','id':'one','source':'x=9'}]})
        self.assertEqual(event['changedIds'],['one']);self.assertEqual(event['beforeCells'][0]['source'],'x = 1\ny = 2')
    def test_bounds_and_nonfinite_data_are_rejected(self):
        baseline=copy.deepcopy(self.baseline);baseline['cells'][0]['layout']={'width':float('nan')}
        with self.assertRaises(ValueError):clean_baseline(baseline)
        diff,truncated=source_diff('a\n'*5000,'b\n'*5000);self.assertTrue(truncated);self.assertLessEqual(len(diff),16000)
        with self.assertRaises(ValueError):clean_report({'changes':[],'runtime':{'status':'pretend-executed'}})
        self.assertNotEqual(source_diff('a','a\n')[0],'')

if __name__=='__main__':unittest.main()
