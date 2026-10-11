import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const script = path.resolve(import.meta.dirname, '../scripts/extract-requirements.py')
test('DOCX extracts table, adjacent paragraph URL and hyperlink target; flags media/revisions', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-requirements-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const input = path.join(tmp, '需求.docx'), output = path.join(tmp, 'out.json')
  const py = process.env.PYTHON || 'python3'
  const build = spawnSync(py, ['-c', `import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('word/document.xml', '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>设计稿参考：</w:t></w:r></w:p><w:p><w:r><w:t>https://www.figma.com/design/key/name?node-id=1-2）</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>按钮</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>无反应</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:hyperlink r:id="r1"><w:r><w:t>图二</w:t></w:r></w:hyperlink></w:p><w:p><w:ins><w:r><w:t>待确认</w:t></w:r></w:ins></w:p></w:body></w:document>''')
 z.writestr('word/_rels/document.xml.rels','<Relationships><Relationship Id="r1" Target="https://www.figma.com/design/key/name?node-id=3-4" /></Relationships>')
 z.writestr('word/media/image1.png', b'fixture')
`, input], { encoding: 'utf8' })
  assert.equal(build.status, 0, build.stderr)
  const run = spawnSync(py, [script, '--input', input, '--output', output], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const result = JSON.parse(fs.readFileSync(output))
  assert.deepEqual(result.tables[0].rows, [['按钮', '无反应']])
  assert.deepEqual(result.urls, ['https://www.figma.com/design/key/name?node-id=1-2', 'https://www.figma.com/design/key/name?node-id=3-4'])
  assert.equal(result.blocks[1].location, 'word/document.xml#p2')
  assert.match(result.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(result.warnings, ['embedded_media_requires_visual_review', 'ins_requires_source_review'])
  const reject = spawnSync(py, [script, '--input', input, '--output', input], { encoding: 'utf8' })
  assert.notEqual(reject.status, 0)
})
