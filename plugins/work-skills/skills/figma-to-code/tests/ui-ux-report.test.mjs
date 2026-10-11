import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { generateReport } from '../scripts/generate-ui-ux-report.mjs'
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
test('generates a complete human-readable report without hiding failed evidence', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-ux-report-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  for (const name of ['prd.docx', 'functional.log']) fs.writeFileSync(path.join(base, name), name)
  const ref = name => ({ path: name, sha256: hash(path.join(base, name)) })
  const contract = { schema_version: 1, product_id: 'demo', data_mode: 'mock', sources: [{ id: 'prd', ...ref('prd.docx') }],
    screens: [{ id: 'home', route: '#home', run_dir: 'runs/home', default_state: 'default', design: { kind: 'figma', file_key: 'file', node_id: '1:2' } }],
    requirements: [
      { id: 'r-implement', screen_ids: ['home'], disposition: 'implement', behavior: 'go to page', evidence: [{ source_id: 'prd', location: 'p1', text: 'go' }] },
      { id: 'r-noop', screen_ids: ['home'], disposition: 'noop', behavior: 'no navigation', evidence: [{ source_id: 'prd', location: 'p2', text: 'noop' }] },
      { id: 'r-out', screen_ids: ['home'], disposition: 'out_of_scope', behavior: 'not this release', evidence: [{ source_id: 'prd', location: 'p3', text: 'out' }] },
      { id: 'r-clarify', screen_ids: ['home'], disposition: 'clarify', behavior: 'ask', evidence: [{ source_id: 'prd', location: 'p4', text: 'ask' }] },
    ],
    cases: [
      { id: 'c1', requirement_ids: ['r-implement'], level: 'browser', given: 'home', when: 'click', then: 'page' },
      { id: 'c2', requirement_ids: ['r-noop'], level: 'browser', given: 'home', when: 'click', then: 'same' },
    ], questions: [], transitions: [{ from: '#home', to: '#lesson', trigger: 'start', parameter: 'lessonId' }] }
  const results = { schema_version: 1, product_id: 'demo', contract_sha256: 'contract', environment: 'Chrome + Playwright', executed_at: '2026-09-23T00:00:00Z', cases: [
    { id: 'c1', status: 'pass', actual: 'navigated', evidence: [ref('functional.log')] },
    { id: 'c2', status: 'fail', actual: 'unexpected navigation', evidence: [ref('functional.log')] },
  ] }
  const acceptance = { can_deliver: false, blocking_reasons: ['home:visual_failed'] }
  const contractFile = path.join(base, 'product-contract.json'), resultsFile = path.join(base, 'functional-results.json'), acceptanceFile = path.join(base, 'product-acceptance.json'), outputFile = path.join(base, 'ui-ux-report.md')
  fs.writeFileSync(contractFile, JSON.stringify(contract)); results.contract_sha256 = hash(contractFile); fs.writeFileSync(resultsFile, JSON.stringify(results)); fs.writeFileSync(acceptanceFile, JSON.stringify(acceptance))
  generateReport({ contractFile, resultsFile, acceptanceFile, outputFile })
  const report = fs.readFileSync(outputFile, 'utf8')
  for (const heading of ['# UI UX 交付报告', '## 1. 交付目录与证据', '## 2. 页面与路由', '## 3. 本期范围与实现状态', '## 4. 核心流程与数据联动', '## 5. 功能验收', '## 6. 截图与视觉验收', '## 7. 交付阻塞与剩余风险', 'product-contract.json', 'home:visual_failed', 'r-noop', 'r-clarify', 'c2']) assert.match(report, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(report, /当前不可宣称完整交付/)
  assert.match(report, /❌ fail/)
})
