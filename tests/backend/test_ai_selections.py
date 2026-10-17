"""Selection references use temporary workspaces and a fake provider only."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from http.server import ThreadingHTTPServer
from slide_notes.web.server import Workspace
from slide_notes.ai.service import AIService
from slide_notes.ai.selections import register,read_selection,canonical,pdf_revision,load_blob
from slide_notes.ai.sources import sources,message_content
from slide_notes.ai.tools import NoteAgent
from slide_notes.ai.tool_trace import summary
from test_pdf_ai_context import sample_pdf
from test_ai import Provider


class SelectionReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.workspace=Workspace(self.root);self.note=self.workspace.create('References')
        doc=self.note['document'];doc['slides'][0]['cells']=[{'id':identity,'kind':'markdown','source':text,'display':'normal','showCode':False} for identity,text in [('before','BEFORE definition'),('chosen','SELECTED '+('long content '*100)+'SECRET_TAIL'),('after','AFTER conclusion')]]
        self.workspace.notebook(self.note['path'])[1].save(doc,self.note['revision']);self.current=self.workspace.document(self.note['path']);self.path=self.note['path']
        (self.root/'paper.pdf').write_bytes(sample_pdf())
    def tearDown(self):self.temp.cleanup()
    def note_ref(self,**extra):return register(self.workspace,{'selections':[{'kind':'note-cells','path':self.path,'cells':['chosen'],**extra}]})['sources'][0]
    def pdf_ref(self,**extra):return register(self.workspace,{'selections':[{'kind':'pdf-elements','path':'paper.pdf','page':2,'text':'SECOND PAGE equation 42','fingerprint':'original','rects':[[40,720,300,760]],'elements':[{'index':0,'from':0,'to':23}],**extra}]})['sources'][0]
    def update(self,fn):
        current=self.workspace.document(self.path);fn(current['document']);self.workspace.notebook(self.path)[1].save(current['document'],current['revision'])
    def test_deduplicated_previews_and_paginated_snapshot(self):
        ref=self.note_ref();self.assertEqual(ref,self.note_ref());self.assertEqual(len(ref['text']),600);self.assertTrue(ref['truncated']);self.assertNotIn('SECRET_TAIL',json.dumps(ref));self.assertEqual(sources([ref]),[ref])
        register(self.workspace,{'selections':[{'kind':'note-cells','path':self.path,'cells':['before']}]});self.assertEqual(len(list((self.root/'sessions/selection-documents').glob('*.json'))),1)
        text='';offset=0
        while True:
            result=read_selection(self.workspace,{'id':ref['id'],'offset':offset,'limit':80});text+=result['text']
            if result['nextOffset'] is None:break
            offset=result['nextOffset']
        self.assertIn('SECRET_TAIL',text);self.assertNotIn('BEFORE definition',text)
        around=read_selection(self.workspace,{'id':ref['id'],'before':1,'after':1});self.assertIn('BEFORE definition',around['text']);self.assertIn('AFTER conclusion',around['text']);self.assertEqual([p['selected'] for p in around['parts']],[False,True,False])
        receipt=summary('read_selection',result);self.assertEqual(receipt['selectionId'],ref['id']);self.assertEqual(receipt['selectionVersion'],'snapshot')
    def test_versions_deletion_and_old_neighbor_snapshots(self):
        ref=self.note_ref();self.update(lambda doc:doc['slides'][0]['cells'][1].update(source='LATEST CHANGED'))
        old=read_selection(self.workspace,{'id':ref['id']});new=read_selection(self.workspace,{'id':ref['id'],'version':'latest'})
        self.assertTrue(old['stale']);self.assertIn('SECRET_TAIL',old['text']);self.assertIn('LATEST CHANGED',new['text']);self.assertEqual(new['revision'],self.workspace.document(self.path)['revision']);self.assertTrue(canonical(self.workspace,ref)['stale'])
        self.update(lambda doc:doc['slides'][0]['cells'].pop(1));latest=read_selection(self.workspace,{'id':ref['id'],'version':'latest'});self.assertFalse(latest['selectionAvailable']);self.assertEqual(latest['missingCells'],['chosen'])
        (self.root/self.path).unlink();self.assertTrue(read_selection(self.workspace,{'id':ref['id']})['missing']);self.assertIn('SECRET_TAIL',read_selection(self.workspace,{'id':ref['id']})['text'])
    def test_unicode_partial_selection_and_stale_ranges(self):
        text='😀 prefix FORMULA suffix';self.update(lambda doc:doc['slides'][0]['cells'][1].update(source=text))
        start=len('😀 prefix '.encode('utf-16-le'))//2
        raw={'kind':'cell-text','path':self.path,'cell':'chosen','from':start,'to':start+7,'text':'FORMULA','textKind':'source'}
        ref=register(self.workspace,{'selections':[raw]})['sources'][0];self.assertEqual(read_selection(self.workspace,{'id':ref['id']})['text'],'FORMULA');self.assertFalse(ref['stale'])
        self.update(lambda doc:doc['slides'][0]['cells'][1].update(source='new prefix '+text))
        latest=read_selection(self.workspace,{'id':ref['id'],'version':'latest'});self.assertFalse(latest['selectionAvailable']);self.assertIn('new prefix',latest['text']);self.assertIn('原文字范围已变化',latest['note'])
        original=read_selection(self.workspace,{'id':ref['id']});self.assertEqual(original['text'],'FORMULA');self.assertTrue(original['stale'])
    def test_rendered_text_is_never_treated_as_source_offsets(self):
        raw={'kind':'cell-text','path':self.path,'cell':'chosen','from':0,'to':4,'text':'word','textKind':'rendered'}
        ref=register(self.workspace,{'selections':[raw]})['sources'][0];self.assertEqual(ref['textKind'],'rendered')
        snapshot=read_selection(self.workspace,{'id':ref['id']});self.assertFalse(snapshot['snapshotAligned']);self.assertEqual(snapshot['text'],'word')
        latest=read_selection(self.workspace,{'id':ref['id'],'version':'latest'});self.assertFalse(latest['selectionAvailable']);self.assertIn('SECRET_TAIL',latest['text'])
    def test_pdf_text_context_versions_and_no_images(self):
        ref=self.pdf_ref();self.assertFalse(ref['truncated']);self.assertEqual(ref['text'],'SECOND PAGE equation 42')
        context=read_selection(self.workspace,{'id':ref['id'],'before':1,'after':1});self.assertEqual(context['pages'],[1,2,3]);self.assertIn('FIRST PAGE ONLY',context['text']);self.assertFalse((self.root/'sessions/assets').exists());self.assertNotIn('images',context)
        (self.root/'paper.pdf').write_bytes(sample_pdf()+b'\n%changed')
        self.assertTrue(read_selection(self.workspace,{'id':ref['id']})['stale'])
        with self.assertRaisesRegex(ValueError,'PDF 已变化'):read_selection(self.workspace,{'id':ref['id'],'version':'latest'})
        self.assertTrue(read_selection(self.workspace,{'id':ref['id'],'before':1})['contextUnavailable'])
        with self.assertRaises(FileExistsError):self.pdf_ref(sourceRevision=ref['sourceRevision'])
    def test_boundaries_corruption_and_workspace_isolation(self):
        ref=self.note_ref()
        with tempfile.TemporaryDirectory() as other:
            with self.assertRaises(ValueError):read_selection(Workspace(Path(other)),{'id':ref['id']})
        for change in [{'path':'../outside.json'},{'path':'/tmp/outside.json'},{'id':'../secret'},{'path':'sessions/private.json'}]:
            with self.assertRaises(ValueError):read_selection(self.workspace,{'id':ref['id'],**change})
        with self.assertRaises(ValueError):canonical(self.workspace,{**ref,'path':'paper.pdf'})
        file=self.root/'sessions/selections'/f"{ref['id']}.json";file.write_text('{}')
        with self.assertRaises(ValueError):read_selection(self.workspace,{'id':ref['id']})
    def test_move_keeps_snapshot_and_current_link(self):
        ref=self.note_ref();destination='Moved.json';(self.root/self.path).rename(self.root/destination)
        moved=canonical(self.workspace,{**ref,'path':destination});self.assertEqual(moved['path'],destination)
        result=read_selection(self.workspace,{'id':ref['id'],'path':destination,'version':'latest'});self.assertIn('SECRET_TAIL',result['text']);self.assertFalse(result['stale'])
    def test_legacy_missing_sources_keep_their_original_text(self):
        (self.root/'paper.pdf').unlink();ref=self.pdf_ref();self.assertTrue(ref['stale']);self.assertEqual(read_selection(self.workspace,{'id':ref['id']})['text'],'SECOND PAGE equation 42')
        raw={'kind':'cell-text','path':'missing.json','cell':'gone','from':0,'to':8,'text':'old text','textKind':'source'}
        ref=register(self.workspace,{'selections':[raw]})['sources'][0];self.assertTrue(ref['stale']);self.assertEqual(read_selection(self.workspace,{'id':ref['id']})['text'],'old text')
    def test_repeated_previews_are_sent_once_and_proposal_has_full_text(self):
        ref=self.note_ref();seen=set();cache={}
        first=message_content(self.workspace,'first',[],[ref],seen_selection_refs=seen,selection_cache=cache)
        second=message_content(self.workspace,'second',[],[ref],seen_selection_refs=seen,selection_cache=cache)
        self.assertIn(ref['text'],json.loads(first.split('：\n')[-1])[0]['text']);self.assertNotIn(ref['text'],second);self.assertIn('previewAlreadyIncluded',second)
        expanded=message_content(self.workspace,'proposal',[],[ref],expand_references=True);self.assertIn('SECRET_TAIL',expanded)
    def test_preview_only_initial_payload_and_fake_provider_tool_expansion(self):
        provider=ThreadingHTTPServer(('127.0.0.1',0),Provider);provider.calls=[];provider.mode='agent';threading.Thread(target=provider.serve_forever,daemon=True).start()
        try:
            service=AIService(self.root/'config');service.configure({'baseUrl':f'http://127.0.0.1:{provider.server_port}/v1','model':'fake'})
            ref=self.note_ref();body={'path':self.path,'scope':'cells','cells':['chosen'],'revision':self.current['revision'],'prompt':'explain the selection','mode':'chat','selectionContext':'references','sources':[ref],'requestId':str(uuid.uuid4())}
            request=service.prepare(self.workspace,body);initial=json.dumps(request['payload']['messages']);self.assertNotIn('SECRET_TAIL',initial);self.assertNotIn('BEFORE definition',initial);self.assertIn('read_selection',json.dumps(request['payload']['tools']))
            provider.responses=[{'choices':[{'message':{'content':None,'tool_calls':[{'id':'expand','type':'function','function':{'name':'read_selection','arguments':json.dumps({'id':ref['id'],'before':1,'after':1})}}]},'finish_reason':'tool_calls'}]},{'choices':[{'message':{'content':'selection read'},'finish_reason':'stop'}]}]
            events=list(service.stream(request));self.assertEqual(events[-1]['type'],'done');self.assertEqual(len(provider.calls),2)
            tool=next(message for message in provider.calls[1][1]['messages'] if message['role']=='tool');self.assertIn('SECRET_TAIL',tool['content']);self.assertIn('BEFORE definition',tool['content']);self.assertTrue(any(e.get('summary',{}).get('selectionId')==ref['id'] for e in events))
            # Default and explicit note reads preserve the normal Workspace permissions.
            agent=request['agent'];latest,_=agent.execute('read_selection',{'id':ref['id'],'version':'latest'});self.assertEqual(latest['revision'],self.current['revision'])
        finally:provider.shutdown();provider.server_close()
