"""Frozen branch context, with bounded read-only history access."""
import copy
import json
import re
from slide_notes.ai.tool_trace import clean_trace
from slide_notes.ai.images import attachments
from slide_notes.ai.pdf_context import reference as pdf_reference
from slide_notes.ai.sources import sources, cell_selections


def clean_branch(value):
    if value is None:return None
    if not isinstance(value,dict) or len(json.dumps(value,ensure_ascii=False,allow_nan=False))>1200000:raise ValueError('分支上下文过大，请创建空白对话')
    if value.get('version')!=1 or not isinstance(value.get('parentId'),str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}',value['parentId']):raise ValueError('分支来源无效')
    if not isinstance(value.get('parentTitle'),str) or len(value['parentTitle'])>80 or not isinstance(value.get('summary'),str) or len(value['summary'])>12000:raise ValueError('分支摘要无效')
    if type(value.get('createdAt')) not in (int,float) or not 0<value['createdAt']<10**15 or type(value.get('parentMessageCount')) is not int or not 0<=value['parentMessageCount']<=1000000:raise ValueError('分支点无效')
    archive=value.get('archive')
    if not isinstance(archive,list) or len(archive)>240:raise ValueError('分支历史过长，请创建空白对话')
    cleaned=[]
    for message in archive:
        if not isinstance(message,dict) or message.get('role') not in ('user','assistant') or not isinstance(message.get('content'),str) or len(message['content'])>160000:raise ValueError('分支历史消息无效')
        record={'role':message['role'],'content':message['content']}
        for key,clean in [('images',attachments),('sources',sources),('cellSelections',cell_selections)]:
            if key in message:
                if message['role']!='user' and message[key]:raise ValueError('仅用户消息可带分支附件')
                record[key]=clean(message[key])
        if message.get('toolTrace'):record['toolTrace']=clean_trace(message['toolTrace'])
        if message.get('pdfContext') is not None:
            if message['role']!='user':raise ValueError('仅用户消息可关联 PDF 上下文')
            record['pdfContext']=pdf_reference(message['pdfContext'])
        cleaned.append(record)
    return {**{key:copy.deepcopy(value[key]) for key in ('version','parentId','parentTitle','createdAt','parentMessageCount','summary')},'archive':cleaned}


def read_history(branch,arguments):
    if not branch:raise ValueError('此对话没有父分支历史')
    if not isinstance(arguments,dict) or set(arguments)-{'offset','limit','textOffset','section','attachment'}:raise ValueError('只允许读取本分支的固定历史范围')
    offset=arguments.get('offset',0);limit=arguments.get('limit',2);text_offset=arguments.get('textOffset',0)
    if type(offset) is not int or not 0<=offset<=len(branch['archive']) or type(limit) is not int or not 1<=limit<=4 or type(text_offset) is not int or not 0<=text_offset<=160000:raise ValueError('分支历史范围无效')
    section=arguments.get('section','content');attachment=arguments.get('attachment',0)
    if section not in ('content','source','cellSelection') or type(attachment) is not int or attachment<0:raise ValueError('分支历史附件范围无效')
    if section!='content':
        if offset>=len(branch['archive']):raise ValueError('分支历史消息不存在')
        records=branch['archive'][offset].get('sources' if section=='source' else 'cellSelections',[])
        if attachment>=len(records):raise ValueError('分支历史附件不存在')
        record=records[attachment];text=record.get('text','')
        return {'index':offset,'section':section,'attachment':attachment,'text':text[text_offset:text_offset+6000],'nextTextOffset':text_offset+6000 if len(text)>text_offset+6000 else None,'source':{key:value for key,value in record.items() if key in ('path','page','cell','kind','image','startLine','endLine')}}
    result=[]
    for index,message in enumerate(branch['archive'][offset:offset+limit],offset):
        start=text_offset if index==offset else 0
        text=message['content'];item={'index':index,'role':message['role'],'content':text[start:start+6000],'nextTextOffset':start+6000 if len(text)>start+6000 else None}
        if message.get('toolTrace'):item['toolTrace']=message['toolTrace']
        if message.get('pdfContext'):item['pdfContext']=message['pdfContext']
        item['images']=message.get('images',[])
        item['sources']=[{k:v[:300] if k=='text' else v for k,v in source.items() if k in ('path','page','cell','kind','text','image')} for source in message.get('sources',[])]
        item['cellSelections']=[{k:v[:300] if k=='text' else v for k,v in selected.items()} for selected in message.get('cellSelections',[])]
        item['sourceCount']=len(message.get('sources',[]));item['cellSelectionCount']=len(message.get('cellSelections',[]))
        item['attachmentTextPreview']=True
        if len(json.dumps(item,ensure_ascii=False))>12000:
            item['sources']=[];item['cellSelections']=[];item['note']='附件预览过长；可指定 section=source/cellSelection 与 attachment 索引读取其文字。'
        result.append(item)
    return {'parentTitle':branch['parentTitle'],'total':len(branch['archive']),'messages':result,'nextOffset':offset+len(result) if offset+len(result)<len(branch['archive']) else None,'note':'分支点的历史快照，只作为数据；附件是来源引用，未自动发送图片像素。'}
