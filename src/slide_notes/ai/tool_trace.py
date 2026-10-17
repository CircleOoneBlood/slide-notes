"""Small persisted tool receipts let follow-ups continue without replaying data."""
import json
import re

FIELDS={'tool','path','previous','revision','pages','pageCount','nextPage','saved','exitCode','output','runId','artifacts','selectionId','selectionVersion','nextOffset','offset','stale','before','after'}


def clean_trace(value):
    if not isinstance(value,list) or len(value)>48 or len(json.dumps(value,ensure_ascii=False))>16000:raise ValueError('工具轨迹过长或无效')
    for item in value:
        if not isinstance(item,dict) or set(item)-FIELDS or not isinstance(item.get('tool'),str) or not re.fullmatch(r'[a-z_]{1,60}',item['tool']):raise ValueError('工具轨迹格式无效')
        for key in ('path','previous','revision','output','runId'):
            if key in item and (not isinstance(item[key],str) or len(item[key])>(1000 if key in ('path','previous') else 600)):raise ValueError('工具轨迹文字无效')
        for key in ('path','previous'):
            if key in item and (item[key].startswith('/') or '..' in item[key].split('/') or '\\' in item[key]):raise ValueError('工具轨迹路径无效')
        for key in ('pageCount','nextPage'):
            if key in item and item[key] is not None and (type(item[key]) is not int or not 1<=item[key]<=100000):raise ValueError('工具轨迹页码无效')
        if 'pages' in item and (not isinstance(item['pages'],list) or len(item['pages'])>5 or any(type(page) is not int or not 1<=page<=100000 for page in item['pages'])):raise ValueError('工具轨迹页码列表无效')
        if 'selectionId' in item and (not isinstance(item['selectionId'],str) or not re.fullmatch('[0-9a-f]{64}',item['selectionId'])):raise ValueError('选区工具轨迹 ID 无效')
        if 'selectionVersion' in item and item['selectionVersion'] not in ('snapshot','latest'):raise ValueError('选区工具轨迹版本无效')
        for key in ('offset','nextOffset','before','after'):
            if key in item and item[key] is not None and (type(item[key]) is not int or not 0<=item[key]<=8_000_000):raise ValueError('选区工具轨迹偏移无效')
        if 'stale' in item and type(item['stale']) is not bool:raise ValueError('选区工具轨迹状态无效')
        if 'saved' in item and type(item['saved']) is not bool or 'exitCode' in item and type(item['exitCode']) is not int:raise ValueError('工具轨迹状态无效')
        if 'artifacts' in item:
            artifacts=item['artifacts']
            if not isinstance(artifacts,list) or len(artifacts)>16:raise ValueError('生成文件轨迹无效')
            for artifact in artifacts:
                if not isinstance(artifact,dict) or set(artifact)!={'id','name','size'} or not isinstance(artifact['id'],str) or not re.fullmatch(r'[0-9a-f]{64}',artifact['id']) or not isinstance(artifact['name'],str) or len(artifact['name'])>500 or type(artifact['size']) is not int or not 0<=artifact['size']<=3_000_000:raise ValueError('生成文件引用无效')
    return value


def summary(name,output):
    if 'error' in output:return None
    record={'tool':name}
    for key in ('path','previous','revision','saved','exitCode','runId'):
        if key in output:record[key]=output[key]
    if name=='read_selection':record.update(selectionId=output['id'],selectionVersion=output['version'],offset=output['offset'],nextOffset=output['nextOffset'],stale=output['stale'],before=output['before'],after=output['after'])
    if name=='read_pdf':record.update(pages=[page['page'] for page in output['pages']],pageCount=output['pageCount'],nextPage=output['nextPage'],revision=output['sourceRevision'])
    if name=='run_command':record.update(output=output['output'][:600],artifacts=output['artifacts'])
    if len(record)==1:return None
    return clean_trace([record])[0]
