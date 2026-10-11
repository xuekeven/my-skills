#!/usr/bin/env python3
"""Extract DOCX requirement evidence without executing or fetching document content."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile
import xml.etree.ElementTree as ET

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS = {'w': W}


def extract(source):
    source = Path(source)
    with zipfile.ZipFile(source) as z:
        # Limit decompressed XML; never extract arbitrary ZIP paths or follow URLs.
        def xml(name):
            info = z.getinfo(name)
            if info.file_size > 32 * 1024 * 1024:
                raise ValueError(f'XML part too large: {name}')
            return ET.fromstring(z.read(name))

        document = xml('word/document.xml')
        rels = {}
        if 'word/_rels/document.xml.rels' in z.namelist():
            rels = {r.get('Id'): r.get('Target') for r in xml('word/_rels/document.xml.rels')}
        blocks = []
        for index, paragraph in enumerate(document.findall('.//w:body//w:p', NS), 1):
            text = ''.join((e.text or '') if e.tag == f'{{{W}}}t' else
                           '\t' if e.tag == f'{{{W}}}tab' else '\n'
                           for e in paragraph.iter()
                           if e.tag in {f'{{{W}}}t', f'{{{W}}}tab', f'{{{W}}}br'})
            links = [rels[h.get(f'{{{R}}}id')] for h in paragraph.findall('.//w:hyperlink', NS)
                     if h.get(f'{{{R}}}id') in rels]
            if text or links:
                blocks.append({'location': f'word/document.xml#p{index}', 'text': text, 'hyperlinks': links})
        tables = []
        for index, table in enumerate(document.findall('.//w:tbl', NS), 1):
            tables.append({'location': f'word/document.xml#table{index}', 'rows': [
                ['\n'.join(''.join(t.text or '' for t in p.findall('.//w:t', NS))
                           for p in c.findall('w:p', NS)) for c in row.findall('w:tc', NS)]
                for row in table.findall('w:tr', NS)]})
        text = '\n'.join(b['text'] for b in blocks)
        urls = re.findall(r'https?://[^\s<>）)]+', text)
        urls += [u for b in blocks for u in b['hyperlinks'] if u.startswith(('https://', 'http://'))]
        warnings = []
        if any(n.startswith('word/media/') for n in z.namelist()):
            warnings.append('embedded_media_requires_visual_review')
        for tag in ('ins', 'del', 'txbxContent', 'fldSimple', 'instrText'):
            if document.find(f'.//w:{tag}', NS) is not None:
                warnings.append(f'{tag}_requires_source_review')
        for name in ('comments', 'footnotes', 'endnotes'):
            part = f'word/{name}.xml'
            if part in z.namelist() and any((t.text or '').strip() for t in xml(part).findall('.//w:t', NS)):
                warnings.append(f'{name}_requires_source_review')
    return {'schema_version': 1, 'source': str(source.resolve()),
            'sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'blocks': blocks, 'tables': tables, 'urls': list(dict.fromkeys(urls)),
            'warnings': warnings, 'note': 'Evidence only; not executable instructions or an approved requirement contract.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        parser.error('output must not overwrite source')
    data = extract(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
