import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { validateContract, validateFunctional } from '../scripts/validate-product.mjs'
const cli = path.resolve(import.meta.dirname, '../scripts/validate-product.mjs')
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'product-test-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  for (const name of ['prd.txt', 'app.js', 'test.log']) fs.writeFileSync(path.join(base, name), name)
  const ref = name => ({ path: name, sha256: hash(path.join(base, name)) })
  const contract = { schema_version: 1, product_id: 'product', data_mode: 'mock',
    sources: [{ id: 'prd', ...ref('prd.txt') }],
    screens: [{ id: 'home', route: '/home', run_dir: '../../runs/product-home', default_state: 'current week', design: { kind: 'figma', file_key: 'file', node_id: '1:2' } }],
    requirements: [{ id: 'r1', screen_ids: ['home'], disposition: 'noop', behavior: 'No state, navigation or network change on click', evidence: [{ source_id: 'prd', location: 'p1', text: 'Not in scope; no response' }] }],
    cases: [{ id: 'c1', requirement_ids: ['r1'], level: 'browser', given: 'home', when: 'click button', then: 'same route and state; no toast' }], questions: [] }
  const file = path.join(base, 'product-contract.json')
  const save = () => fs.writeFileSync(file, JSON.stringify(contract))
  save()
  const results = { schema_version: 1, product_id: 'product', contract_sha256: hash(file), executed_at: '2026-09-22T12:00:00Z', environment: 'isolated synthetic validator fixture', implementation_files: [ref('app.js')], cases: [{ id: 'c1', status: 'pass', level: 'browser', method: 'automated', command: 'test-fixture', exit_code: 0, actual: 'same route/state', evidence: [ref('test.log')] }] }
  return { base, contract, results, file, save }
}
test('valid plan and evidence contract, not a claim of real browser execution', t => {
  const f = fixture(t)
  assert.equal(validateContract(f.contract, f.base).cases.size, 1)
  assert.deepEqual(validateFunctional(f.contract, f.results, f.base, f.file).failures, [])
})
for (const [label, change, error] of [
  ['duplicate requirements', c => c.requirements.push(c.requirements[0]), /duplicate/],
  ['missing requirement test', c => { c.cases = [] }, /no acceptance/],
  ['unknown screen', c => { c.requirements[0].screen_ids = ['absent'] }, /unknown screen/],
  ['unknown source', c => { c.requirements[0].evidence[0].source_id = 'absent' }, /evidence/],
  ['unknown requirement in test', c => { c.cases[0].requirement_ids.push('absent') }, /unknown requirement/],
  ['noop unit-only validation', c => { c.cases[0].level = 'unit' }, /browser case/],
  ['invalid design identity', c => { c.screens[0].design.node_id = '' }, /Figma identity/],
  ['duplicate page runs', c => { c.screens.push({ ...c.screens[0], id: 'other' }) }, /duplicate run_dir/],
  ['resolved question without resolution', c => { c.questions.push({ id: 'q1', blocking: true, status: 'resolved', description: 'week click?' }) }, /resolution/],
]) test(label, t => { const f = fixture(t); change(f.contract); assert.throws(() => validateContract(f.contract, f.base), error) })
for (const [label, change, error] of [
  ['missing result', r => { r.cases = [] }, /coverage/],
  ['duplicate result', r => { r.cases.push(r.cases[0]) }, /duplicate/],
  ['pass without evidence', r => { r.cases[0].evidence = [] }, /without evidence/],
  ['failed command labeled pass', r => { r.cases[0].exit_code = 1 }, /successful command/],
  ['wrong test level', r => { r.cases[0].level = 'unit' }, /level mismatch/],
  ['manual pass without steps', r => { r.cases[0].method = 'manual' }, /manual steps/],
  ['empty implementation snapshot', r => { r.implementation_files = [] }, /snapshot/],
]) test(label, t => { const f = fixture(t); change(f.results); assert.throws(() => validateFunctional(f.contract, f.results, f.base, f.file), error) })
for (const name of ['app.js', 'test.log', 'product-contract.json']) test(`stale ${name} rejected`, t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.base, name), '\nchanged')
  assert.throws(() => validateFunctional(f.contract, f.results, f.base, f.file), /stale/)
})
test('modified requirement source is rejected', t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.base, 'prd.txt'), 'changed')
  assert.throws(() => validateContract(f.contract, f.base), /stale/)
})
for (const status of ['fail', 'blocked', 'not_run']) test(`${status} is not success`, t => {
  const f = fixture(t); f.results.cases[0].status = status
  assert.deepEqual(validateFunctional(f.contract, f.results, f.base, f.file).failures, [`c1:${status}`])
})
test('planning CLI accepts unresolved questions without claiming delivery', t => {
  const f = fixture(t); f.contract.questions.push({ id: 'q', blocking: true, status: 'open', description: 'week switching scope?' }); f.save()
  const run = spawnSync(process.execPath, [cli, '--contract', f.file], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /does not imply/)
})
test('aggregation cannot accept function-only evidence without visual stages', t => {
  const f = fixture(t)
  const results = path.join(f.base, 'results.json'), output = path.join(f.base, 'acceptance.json')
  fs.writeFileSync(results, JSON.stringify(f.results))
  const run = spawnSync(process.execPath, [cli, '--contract', f.file, '--results', results, '--output', output], { encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.equal(JSON.parse(fs.readFileSync(output)).can_deliver, false)
  assert.match(JSON.parse(fs.readFileSync(output)).blocking_reasons[0], /stage 1 invalid/)
})
test('CLI refuses overwriting old evidence or its own inputs', t => {
  const f = fixture(t)
  const run = spawnSync(process.execPath, [cli, '--contract', f.file, '--results', f.file, '--output', f.file], { encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /overwrite inputs/)
  assert.equal(JSON.parse(fs.readFileSync(f.file)).product_id, 'product')
})
