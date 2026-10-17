"""Read-only workspace images. SVG is served with an inert document policy."""
import xml.etree.ElementTree as ET

IMAGE_TYPES={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.ico':'image/x-icon','.avif':'image/avif','.svg':'image/svg+xml'}

def workspace_image(workspace,path):
    target=workspace.editable_path(path)
    mime=IMAGE_TYPES.get(target.suffix.lower())
    if not mime or not target.is_file():raise ValueError('请选择支持的图片文件')
    if not 0<target.stat().st_size<=50_000_000:raise ValueError('图片为空或超过 50 MB')
    with target.open('rb') as stream:header=stream.read(32)
    valid={
        'image/png':header.startswith(b'\x89PNG\r\n\x1a\n'),
        'image/jpeg':header.startswith(b'\xff\xd8\xff'),
        'image/gif':header.startswith((b'GIF87a',b'GIF89a')),
        'image/webp':header.startswith(b'RIFF') and header[8:12]==b'WEBP',
        'image/bmp':header.startswith(b'BM'),
        'image/x-icon':header.startswith(b'\x00\x00\x01\x00'),
        'image/avif':header[4:8]==b'ftyp' and any(brand in header[8:] for brand in (b'avif',b'avis')),
    }.get(mime,False)
    if mime=='image/svg+xml':
        if target.stat().st_size>5_000_000:raise ValueError('SVG 超过 5 MB')
        raw=target.read_bytes()
        if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():raise ValueError('不支持包含实体声明的 SVG')
        try:valid=ET.fromstring(raw).tag in ('svg','{http://www.w3.org/2000/svg}svg')
        except ET.ParseError:valid=False
    if not valid:raise ValueError('文件内容不是有效的图片格式')
    return target,mime
