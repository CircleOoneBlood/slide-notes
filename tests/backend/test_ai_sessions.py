"""History persistence uses only temporary workspaces and fake messages."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from slide_notes.ai.sessions import SessionStorage
from slide_notes.web.server import Workspace

class SessionStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.workspace=Workspace(self.root);self.note=self.workspace.create('Chat test');self.storage=SessionStorage()
        self.data={'active':'chat1','conversations':[{'id':'chat1','title':'推导问题','customTitle':True,'createdAt':1000,'updatedAt':2000,'messages':[{'role':'user','content':'问题'}],'draft':'草稿','selectedCells':['one']} ]}
    def tearDown(self):
        self.temp.cleanup()
    def write(self,cell=None,revision=None,data=None):
        return self.storage.write(self.workspace,{'path':self.note['path'],'cell':cell,'revision':revision,'data':data or self.data})
    def test_round_trip_file_visible_and_notebook_unchanged(self):
        before=self.workspace.resolve(self.note['path']).read_bytes()
        self.assertIsNone(self.storage.read(self.workspace,self.note['path'])['data'])
        result=self.write();file=self.root/result['file']
        self.assertTrue(file.is_relative_to(self.root/'sessions'));self.assertEqual(file.name,'global.json')
        saved=json.loads(file.read_text());self.assertEqual(saved['conversations'][0]['draft'],'草稿');self.assertEqual(saved['notebook'],self.note['path'])
        self.assertEqual(self.storage.read(self.workspace,self.note['path'])['revision'],result['revision'])
        self.assertEqual(self.workspace.resolve(self.note['path']).read_bytes(),before)
        entries=self.workspace.files()['entries'];self.assertTrue(any(entry['path']=='sessions' and entry['kind']=='directory' for entry in entries))
        self.assertEqual(self.workspace.describe(file)['kind'],'file')
    def test_global_and_cells_have_separate_multi_chat_files(self):
        self.write();data=copy.deepcopy(self.data);data['conversations'].append({**data['conversations'][0],'id':'chat2','title':'另一个对话'});data['active']='chat2'
        one=self.write('one',data=data);two=self.write('two')
        self.assertNotEqual(one['file'],two['file']);self.assertEqual(len(self.storage.read(self.workspace,self.note['path'],'one')['data']['conversations']),2)
        self.assertEqual(len(self.storage.read(self.workspace,self.note['path'])['data']['conversations']),1)
    def test_conflicts_and_corrupt_files_are_not_overwritten(self):
        initial=self.write();updated=copy.deepcopy(self.data);updated['conversations'][0]['title']='外部修改'
        second=self.write(revision=initial['revision'],data=updated)
        with self.assertRaises(FileExistsError): self.write(revision=initial['revision'])
        file=self.root/second['file'];self.assertEqual(json.loads(file.read_text())['conversations'][0]['title'],'外部修改')
        file.write_text('broken JSON')
        with self.assertRaises(ValueError):self.write(revision=second['revision'])
        self.assertEqual(file.read_text(),'broken JSON')
    def test_invalid_paths_and_symlink_do_not_write_outside_workspace(self):
        for cell in ['../secret','a/b','',123]:
            with self.assertRaises(ValueError):self.write(cell)
        with tempfile.TemporaryDirectory() as outside:
            (self.root/'sessions').symlink_to(outside,target_is_directory=True)
            with self.assertRaises(ValueError):self.write()
            self.assertEqual(list(Path(outside).iterdir()),[])
    def test_cell_selection_draft_history_and_move(self):
        selection={'path':self.note['path'],'cell':'one','text':'chosen text','from':3,'to':14,'startLine':2,'endLine':2,'kind':'source'}
        self.data['conversations'][0]['cellSelections']=[selection]
        self.data['conversations'][0]['messages'][0]['cellSelections']=[selection]
        self.write('one');loaded=self.storage.read(self.workspace,self.note['path'],'one')['data']
        self.assertEqual(loaded['conversations'][0]['cellSelections'][0]['text'],'chosen text')
        old=self.note['path'];self.workspace.resolve(old).rename(self.root/'Renamed.json');self.storage.move(self.workspace,old,'Renamed.json')
        loaded=self.storage.read(self.workspace,'Renamed.json','one')['data']['conversations'][0]
        self.assertEqual(loaded['cellSelections'][0]['path'],'Renamed.json');self.assertEqual(loaded['messages'][0]['cellSelections'][0]['path'],'Renamed.json')

    def test_move_preserves_all_scopes_and_updates_proposal_paths(self):
        self.data['conversations'][0]['messages'].append({'role':'assistant','content':'修改','path':self.note['path']})
        old=self.write();self.write('one');original=self.note['path'];destination='Renamed.json'
        self.workspace.resolve(original).rename(self.root/destination)
        result=self.storage.move(self.workspace,original,destination)
        self.assertEqual(len(result['moved']),2);self.assertFalse((self.root/old['file']).exists())
        for cell in [None,'one']:
            saved=self.storage.read(self.workspace,destination,cell)
            self.assertEqual(saved['data']['notebook'],destination)
            self.assertEqual(saved['data']['conversations'][0]['messages'][1]['path'],destination)
    def test_rejects_invalid_chat_records(self):
        for edit in [lambda data:data.update(active='missing'),lambda data:data['conversations'].append(copy.deepcopy(data['conversations'][0])),lambda data:data['conversations'][0].update(title='x'*81),lambda data:data['conversations'][0].update(messages=[{'role':'system','content':'bad'}])]:
            data=copy.deepcopy(self.data);edit(data)
            with self.assertRaises(ValueError):self.write(data=data)
        self.assertFalse((self.root/'sessions').exists())


    def test_images_round_trip_as_references_without_base64(self):
        image={'id':'a'*64+'.png','name':'截图.png'}
        self.data['conversations'][0]['images']=[image]
        self.data['conversations'][0]['messages'][0]['images']=[image]
        result=self.write();saved=json.loads((self.root/result['file']).read_text())
        self.assertEqual(saved['conversations'][0]['images'],[image])
        self.assertEqual(saved['conversations'][0]['messages'][0]['images'],[image])
        self.assertNotIn('base64',json.dumps(saved))
        self.data['conversations'][0]['images']=[{'id':'../escape.png'}]
        with self.assertRaises(ValueError): self.write(revision=result['revision'])

    def test_pdf_owned_sessions_and_source_snapshots(self):
        (self.root/'sample.pdf').write_bytes(b'%PDF-1.4\n%%EOF')
        source={'path':'sample.pdf','page':1,'rects':[[1,2,30,40]],'text':'selected text','fingerprint':'abc'}
        self.data['conversations'][0]['sources']=[source]
        self.data['conversations'][0]['messages'][0]['sources']=[source]
        body={'path':'sample.pdf','cell':None,'data':self.data,'revision':None}
        result=self.storage.write(self.workspace,body)
        saved=self.storage.read(self.workspace,'sample.pdf')['data']
        self.assertEqual(saved['notebook'],'sample.pdf');self.assertEqual(saved['conversations'][0]['sources'][0]['text'],'selected text')
        self.assertEqual(saved['conversations'][0]['messages'][0]['sources'][0]['rects'],[[1,2,30,40]])
        self.assertTrue((self.root/result['file']).exists())
        with self.assertRaises(ValueError):self.storage.read(self.workspace,'sample.pdf','one')


    def test_interface_preferences_round_trip_and_validation(self):
        data=copy.deepcopy(self.data);data['conversations'][0].update(bookmarked=True,responseMode='ask',modelOverride='sonnet',claudeEffort='medium')
        result=self.write(data=data);stored=self.storage.read(self.workspace,self.note['path'])['data']['conversations'][0]
        for field in ('bookmarked','responseMode','modelOverride','claudeEffort'):self.assertEqual(stored[field],data['conversations'][0][field])
        for field,value in [('bookmarked','yes'),('responseMode','bypass'),('claudeEffort','unlimited'),('modelOverride','bad\nmodel')]:
            broken=copy.deepcopy(data);broken['conversations'][0][field]=value
            with self.assertRaises(ValueError):self.write(data=broken,revision=result['revision'])

    def test_workspace_history_survives_note_removal_and_isolated_workspaces(self):
        self.data['conversations'][0]['contextPath']=self.note['path']
        result=self.storage.write(self.workspace,{'scope':'workspace','data':self.data,'revision':None})
        self.assertEqual(result['file'],'sessions/workspace.json')
        self.workspace.resolve(self.note['path']).unlink()
        loaded=self.storage.read(self.workspace,None,scope='workspace')
        self.assertEqual(loaded['data']['scope'],'workspace')
        self.assertIsNone(loaded['data']['notebook'])
        self.assertEqual(loaded['data']['conversations'][0]['draft'],'草稿')
        with self.assertRaises(FileExistsError):self.storage.write(self.workspace,{'scope':'workspace','data':self.data,'revision':None})
        with tempfile.TemporaryDirectory() as other:
            self.assertIsNone(self.storage.read(Workspace(Path(other)),None,scope='workspace')['data'])

    def test_workspace_migration_collects_legacy_global_histories_once_and_preserves_backups(self):
        first=self.write();self.write('one')
        other=self.workspace.create('Other')
        data=copy.deepcopy(self.data);data['conversations'][0]['draft']='其他草稿'
        second=self.storage.write(self.workspace,{'path':other['path'],'data':data,'revision':None})
        originals={file:(self.root/file).read_bytes() for file in [first['file'],second['file']]}
        loaded=self.storage.read(self.workspace,None,scope='workspace')
        chats=loaded['data']['conversations'];self.assertEqual(len(chats),2)
        self.assertEqual(len({chat['id'] for chat in chats}),2)
        self.assertEqual({chat['contextPath'] for chat in chats},{self.note['path'],other['path']})
        for chat in chats:self.assertEqual(chat['messages'][0]['path'],chat['contextPath'])
        for file,raw in originals.items():self.assertEqual((self.root/file).read_bytes(),raw)
        self.assertEqual(self.storage.read(self.workspace,None,scope='workspace')['revision'],loaded['revision'])
        self.assertEqual(len(self.storage.read(self.workspace,None,scope='workspace')['data']['conversations']),2)

    def test_workspace_contexts_follow_rename_without_moving_history_file(self):
        original=self.note['path'];destination='Renamed.json'
        self.data['conversations'][0].update(contextPath=original,fileContexts={original:{'selectedCells':['one'],'changeBaseline':None,'changeOrigins':{},'excludedChanges':[]}})
        self.data['conversations'][0]['messages'][0]['path']=original
        saved=self.storage.write(self.workspace,{'scope':'workspace','data':self.data,'revision':None})
        self.workspace.resolve(original).rename(self.root/destination)
        result=self.storage.move(self.workspace,original,destination)
        self.assertEqual(result['moved'][0]['file'],'sessions/workspace.json')
        record=self.storage.read(self.workspace,None,scope='workspace')['data']['conversations'][0]
        self.assertEqual(record['contextPath'],destination);self.assertEqual(record['messages'][0]['path'],destination)
        self.assertEqual(record['fileContexts'][destination]['selectedCells'],['one'])
        self.assertNotEqual(saved['revision'],result['moved'][0]['revision'])

    def test_workspace_rejects_unsafe_context_references_and_does_not_overwrite_corruption(self):
        for path in ['../outside.json','/outside.json','a\\b.json']:
            data=copy.deepcopy(self.data);data['conversations'][0]['contextPath']=path
            with self.assertRaises(ValueError):self.storage.write(self.workspace,{'scope':'workspace','data':data,'revision':None})
        saved=self.storage.write(self.workspace,{'scope':'workspace','data':self.data,'revision':None})
        target=self.root/saved['file'];target.write_text('broken JSON')
        with self.assertRaises(ValueError):self.storage.read(self.workspace,None,scope='workspace')
        self.assertEqual(target.read_text(),'broken JSON')

if __name__=='__main__': unittest.main()
