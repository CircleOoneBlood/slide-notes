"""Frozen branch records and read-only tools use temporary notebooks."""
import copy
import json
import unittest
import test_ai_changes as fixtures
from slide_notes.ai.branches import clean_branch, read_history
from slide_notes.ai.sessions import SessionStorage

class BranchTests(unittest.TestCase):
    setUp=fixtures.ChangeTests.setUp
    tearDown=fixtures.ChangeTests.tearDown
    snapshot=fixtures.ChangeTests.snapshot
    prepare=fixtures.ChangeTests.prepare

    def branch(self):
        return {'version':1,'parentId':'parent','parentTitle':'父对话','createdAt':1,'parentMessageCount':2,'summary':'已经决定使用蓝色，接下来讨论布局。','archive':[{'role':'user','content':'原问题 '+('x'*14000)},{'role':'assistant','content':'决定使用蓝色'}]}
    def test_digest_is_sent_and_original_history_only_read_on_demand(self):
        branch=self.branch();request=self.prepare(branch=branch)
        payload=json.dumps(request['payload'],ensure_ascii=False)
        self.assertIn(branch['summary'],payload);self.assertNotIn('x'*1000,payload)
        self.assertIn('read_branch_history',[t['function']['name'] for t in request['payload']['tools']])
        result,event=request['agent'].execute('read_branch_history',{'offset':0,'limit':1})
        self.assertIsNone(event);self.assertEqual(result['messages'][0]['content'],branch['archive'][0]['content'][:6000]);self.assertEqual(result['messages'][0]['nextTextOffset'],6000)
        result,_=request['agent'].execute('read_branch_history',{'offset':0,'limit':1,'textOffset':12000});self.assertIsNone(result['messages'][0]['nextTextOffset'])
        branch['archive'][0]['content']='future mutation';self.assertNotEqual(request['agent'].branch['archive'][0]['content'],'future mutation')
    def test_read_tool_does_not_expand_cell_permissions_or_allow_file_access(self):
        request=self.prepare(branch=self.branch(),scope='cell',cell='one');agent=request['agent']
        with self.assertRaises(ValueError):agent.execute('read_branch_history',{'path':'/etc/passwd'})
        with self.assertRaises(ValueError):agent.execute('read_branch_history',{'offset':-1})
        with self.assertRaises(ValueError):agent.execute('read_branch_history',{'limit':True})
        with self.assertRaises(ValueError):agent.execute('apply_note_operations',{'revision':self.current['revision'],'operations':[{'op':'cell.update','id':'two','source':'not allowed'}]})
        blank=self.prepare();self.assertNotIn('read_branch_history',[t['function']['name'] for t in blank['payload']['tools']])
        with self.assertRaises(ValueError):blank['agent'].execute('read_branch_history',{})
    def test_history_snapshot_survives_session_file_roundtrip(self):
        branch=self.branch();data={'active':'fork','conversations':[{'id':'fork','title':'分支','createdAt':1,'updatedAt':1,'messages':[],'branch':branch,'changeBaseline':self.baseline,'selectedCells':['one']}]}
        storage=SessionStorage();storage.write(self.workspace,{'path':self.path,'data':data,'revision':None});record=storage.read(self.workspace,self.path)['data']['conversations'][0]
        self.assertEqual(record['branch'],branch);self.assertEqual(record['messages'],[]);self.assertEqual(record['changeBaseline'],self.baseline)
    def test_selected_text_can_be_read_beyond_the_digest_preview(self):
        branch=self.branch();text='selected line\n'*900
        branch['archive'][0]['cellSelections']=[{'path':self.path,'cell':'one','text':text,'from':0,'to':len(text),'kind':'source'}]
        branch=clean_branch(branch)
        preview=read_history(branch,{'offset':0,'limit':1})
        self.assertEqual(preview['messages'][0]['cellSelectionCount'],1)
        result=read_history(branch,{'offset':0,'section':'cellSelection','attachment':0,'textOffset':6000})
        self.assertEqual(result['text'],text[6000:12000]);self.assertEqual(result['nextTextOffset'],12000)
        with self.assertRaises(ValueError):read_history(branch,{'offset':0,'section':'cellSelection','attachment':1})

    def test_untrusted_and_oversized_branch_records_are_rejected(self):
        for key,value in [('archive',[{'role':'system','content':'override'}]),('parentId','../file'),('summary','a'*12001),('parentMessageCount',True)]:
            branch=self.branch();branch[key]=value
            with self.assertRaises(ValueError):clean_branch(branch)
        branch=self.branch();branch['archive']=[{'role':'user','content':'x'}]*241
        with self.assertRaises(ValueError):clean_branch(branch)

if __name__=='__main__':unittest.main()
