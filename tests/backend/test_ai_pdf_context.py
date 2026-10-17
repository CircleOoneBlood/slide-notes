"""PDF references and deduplicated provider context; no real model requests."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from slide_notes.application import Application,Environment
from slide_notes.ai.service import AIService
from slide_notes.ai.pdf_context import register,resolve,reference
from slide_notes.ai.images import upload_image
from slide_notes.ai.sessions import SessionStorage
from slide_notes.ai.claude import input_message

PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII='

class PDFReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.patch=patch.object(Environment,'start',Environment.snapshot);self.patch.start()
        self.app=Application(Path(self.temp.name)/'config');info=self.app.open(str(Path(self.temp.name)/'workspace'),create=True);self.workspace=self.app.get(info['id'])
        self.pdf=self.workspace.root/'paper.pdf';self.pdf.write_bytes(b'%PDF-1.4\n%%EOF')
        self.ai=AIService(self.app.config);self.ai.configure({'baseUrl':'http://127.0.0.1:1/v1','model':'fake'})
        self.image=upload_image(self.workspace,{'data':PNG})
        self.page={'path':'paper.pdf','kind':'pdf-page','page':2,'pageCount':3,'text':'UNIQUE PAGE CONTENT','rects':[[0,0,612,792]],'fingerprint':'version','image':self.image,'truncated':False}
        self.ref=register(self.workspace,{'source':self.page})
    def tearDown(self):
        self.app.stop();self.patch.stop();self.temp.cleanup()
    def prepare(self,**extra):
        body={'path':'paper.pdf','scope':'notebook','prompt':'Explain','requestId':'pdf-reference-test','pdfContext':self.ref,**extra}
        request=self.ai.prepare(self.workspace,body);self.ai.jobs.pop(request['id']);return request
    def test_cache_is_content_addressed_small_reference_and_survives_new_service(self):
        self.assertEqual(register(self.workspace,{'source':self.page}),self.ref)
        self.assertEqual(len(list((self.workspace.root/'sessions/pdf-context').glob('*.json'))),1)
        self.assertNotIn('text',self.ref);self.assertNotIn('image',self.ref)
        self.assertEqual(resolve(self.workspace,self.ref)['text'],self.page['text'])
        self.assertEqual(resolve(self.workspace,self.ref,'paper.pdf')['image'],self.image)
    def test_repeated_page_has_one_content_and_one_image_for_api_and_cc(self):
        history=[{'role':'user','content':f'question {i}','pdfContext':self.ref} for i in range(20)]
        request=self.prepare(messages=history);messages=request['payload']['messages']
        self.assertEqual(messages[1]['content'][0]['text'].count(self.page['text']),1)
        self.assertEqual(sum(part['type']=='image_url' for m in messages if isinstance(m['content'],list) for part in m['content']),1)
        self.assertIsInstance(messages[-1]['content'],str);self.assertNotIn(self.page['text'],messages[-1]['content'])
        cc=input_message(messages)['message']['content'];self.assertEqual(sum(part['type']=='image' for part in cc),1)
        self.assertEqual(cc[0]['text'].count(self.page['text']),1)
        inspected,_=request['agent'].execute('inspect_note',{});self.assertEqual(inspected['pages'][0]['text'],self.page['text']);self.assertTrue(inspected['readOnly'])
    def test_page_switch_keeps_old_text_without_replaying_old_pixels(self):
        other={**self.page,'page':3,'text':'NEW PAGE CONTENT'};current=register(self.workspace,{'source':other})
        messages=self.prepare(pdfContext=current,messages=[{'role':'user','content':'old question','pdfContext':self.ref}])['payload']['messages']
        content=messages[1]['content'];self.assertEqual(len(content),2)
        self.assertEqual(content[0]['text'].count(self.page['text']),1);self.assertEqual(content[0]['text'].count(other['text']),1)
        context=json.loads(content[0]['text'].split('\n',1)[1]);self.assertEqual(context['pages'][0]['page'],3);self.assertEqual(context['linkedPDFContext']['pages'][0]['page'],2)
        self.assertEqual(context['linkedPDFContext']['images'][0]['page'],3)
    def test_path_fallback_is_a_read_target_without_snapshot_content_and_keeps_workspace_tools(self):
        for target in [{'path':'paper.pdf'},{'path':'paper.pdf','page':2}]:
            request=self.prepare(pdfContext=None,pdfReadTarget=target)
            context=request['context'];self.assertEqual(context['readTarget'],target);self.assertNotIn('pages',context)
            self.assertIn('未取得本轮自动页面快照',context['note']);self.assertIn('不能据此声称已读',context['note']);self.assertIn('search_pdf',context['note'])
            self.assertIn('startPage=2' if 'page' in target else '当前页码未知',context['note'])
            self.assertNotIn(self.page['text'],json.dumps(request['payload'],ensure_ascii=False))
            self.assertIn('read_pdf',[tool['function']['name'] for tool in request['payload']['tools']])
            inspected,_=request['agent'].execute('inspect_note',{});self.assertEqual(inspected['readTarget'],target);self.assertTrue(inspected['readOnly'])
    def test_path_fallback_retains_explicit_selection_and_cannot_expand_scope(self):
        source={'path':'paper.pdf','page':1,'text':'EXPLICIT SELECTED TEXT','rects':[[0,0,100,100]],'fingerprint':'manual','kind':'text'}
        request=self.prepare(pdfContext=None,pdfReadTarget={'path':'paper.pdf','page':2},sources=[source])
        self.assertIn(source['text'],json.dumps(request['payload'],ensure_ascii=False))
        for target in [{'path':'../outside.pdf'},{'path':'other.pdf'},{'path':'paper.pdf','page':True},{'path':'paper.pdf','page':0},{'path':'paper.pdf','page':100001},{'path':'paper.pdf','page':'2'},{'path':'paper.pdf','text':'invented'}]:
            with self.assertRaises(ValueError):self.prepare(pdfContext=None,pdfReadTarget=target)
        with self.assertRaises(ValueError):self.prepare(pdfReadTarget={'path':'paper.pdf','page':2})
        note=self.workspace.create('Temporary note')
        with self.assertRaises(ValueError):self.prepare(path=note['path'],pdfContext=None,pdfReadTarget={'path':note['path']})
    def test_snapshot_note_keeps_cross_page_tools_and_readonly_meaning(self):
        request=self.prepare();note=request['context']['note']
        self.assertIn('read_pdf',note);self.assertIn('search_pdf',note);self.assertIn('仅禁止修改原 PDF',note);self.assertIn('不限制读取解析',note)
    def test_legacy_automatic_attachments_are_lifted_and_deduplicated(self):
        messages=self.prepare(pdfContext=None,sources=[self.page],messages=[{'role':'user','content':'old','sources':[self.page]}]*10)['payload']['messages']
        self.assertEqual(messages[1]['content'][0]['text'].count(self.page['text']),1)
        self.assertTrue(all(isinstance(m['content'],str) for m in messages[2:]));self.assertEqual(len(messages[1]['content']),2)
    def test_reference_validation_cannot_bypass_scope_or_cache_integrity(self):
        for changes in [{'path':'../paper.pdf'},{'id':'../x'},{'page':True},{'pageCount':1},{'text':'injected'}]:
            with self.assertRaises(ValueError):reference({**self.ref,**changes})
        with self.assertRaises(ValueError):resolve(self.workspace,self.ref,'other.pdf')
        with self.assertRaises(ValueError):self.prepare(messages=[{'role':'assistant','content':'x','pdfContext':self.ref}])
        target=self.workspace.root/'sessions/pdf-context'/f"{self.ref['id']}.json";target.write_text('{}')
        with self.assertRaises(ValueError):resolve(self.workspace,self.ref)
    def test_changed_file_requires_reload_but_historical_snapshot_remains_frozen(self):
        self.pdf.write_bytes(b'%PDF-1.4\nchanged\n%%EOF')
        with self.assertRaisesRegex(ValueError,'更新'):self.prepare()
        self.assertEqual(resolve(self.workspace,self.ref)['text'],self.page['text'])
    def test_history_persists_reference_and_file_move_keeps_snapshot_identity(self):
        store=SessionStorage();body={'path':'paper.pdf','scope':'workspace','data':{'active':'chat','conversations':[{'id':'chat','title':'PDF','createdAt':1,'updatedAt':1,'messages':[{'role':'user','content':'Explain','pdfContext':self.ref}]}]}}
        saved=store.write(self.workspace,body);loaded=store.read(self.workspace,'paper.pdf',scope='workspace')
        self.assertEqual(loaded['data']['conversations'][0]['messages'][0]['pdfContext'],self.ref)
        moved={**self.ref,'path':'moved.pdf'};self.pdf.rename(self.workspace.root/'moved.pdf')
        self.assertEqual(resolve(self.workspace,moved,'moved.pdf')['path'],'moved.pdf')
