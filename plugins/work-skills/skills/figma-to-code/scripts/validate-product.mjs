#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const assert = (condition, message) => { if (!condition) throw new Error(message) }
const text = value => typeof value === 'string' && value.trim().length > 0
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
function unique(items, label) {
  assert(Array.isArray(items), `${label} must be an array`)
  const ids = items.map(x => x.id)
  assert(ids.every(text) && new Set(ids).size === ids.length, `${label}: empty or duplicate id`)
  return new Set(ids)
}
function artifact(ref, base) {
  assert(ref && text(ref.path) && /^[a-f0-9]{64}$/.test(ref.sha256), 'artifact requires path and SHA-256')
  const file = path.resolve(base, ref.path)
  assert(fs.statSync(file).isFile() && digest(file) === ref.sha256, `stale artifact: ${ref.path}`)
  return file
}

export function validateContract(contract, base) {
  assert(contract.schema_version === 1 && text(contract.product_id), 'invalid product identity')
  assert(['mock', 'api', 'local'].includes(contract.data_mode), 'invalid data_mode')
  const sources = unique(contract.sources, 'sources')
  assert(sources.size > 0, 'sources must not be empty')
  contract.sources.forEach(s => artifact(s, base))
  const screens = unique(contract.screens, 'screens')
  assert(screens.size > 0, 'screens must not be empty')
  const runs = new Set()
  for (const s of contract.screens) {
    assert(text(s.route) && text(s.run_dir) && text(s.default_state), `${s.id}: missing screen mapping`)
    const run = path.resolve(base, s.run_dir)
    assert(!runs.has(run), `${s.id}: duplicate run_dir`)
    runs.add(run)
    assert(s.design && ['figma', 'screenshot'].includes(s.design.kind), `${s.id}: design missing`)
    if (s.design.kind === 'figma') {
      assert(text(s.design.file_key) && /^\d+:\d+$/.test(s.design.node_id), `${s.id}: exact Figma identity required`)
    } else artifact(s.design.reference, base)
  }
  const requirements = unique(contract.requirements, 'requirements')
  assert(requirements.size > 0, 'requirements must not be empty')
  const cases = unique(contract.cases, 'cases')
  for (const r of contract.requirements) {
    assert(['implement', 'noop', 'out_of_scope', 'clarify'].includes(r.disposition), `${r.id}: disposition invalid`)
    assert(Array.isArray(r.screen_ids) && r.screen_ids.length && r.screen_ids.every(id => screens.has(id)), `${r.id}: unknown screen`)
    assert(Array.isArray(r.evidence) && r.evidence.length && r.evidence.every(e => sources.has(e.source_id) && text(e.location) && text(e.text)), `${r.id}: source evidence missing`)
    assert(text(r.behavior), `${r.id}: behavior missing`)
    if (['implement', 'noop'].includes(r.disposition)) {
      assert(contract.cases.some(c => c.requirement_ids?.includes(r.id)), `${r.id}: no acceptance case`)
      if (r.disposition === 'noop') assert(contract.cases.some(c => c.requirement_ids?.includes(r.id) && c.level === 'browser'), `${r.id}: noop requires a browser case`)
    }
  }
  for (const c of contract.cases) {
    assert(Array.isArray(c.requirement_ids) && c.requirement_ids.length && c.requirement_ids.every(id => requirements.has(id)), `${c.id}: unknown requirement`)
    assert(['unit', 'component', 'browser'].includes(c.level), `${c.id}: invalid test level`)
    assert(text(c.given) && text(c.when) && text(c.then), `${c.id}: Given/When/Then missing`)
  }
  unique(contract.questions, 'questions')
  for (const q of contract.questions) {
    assert(typeof q.blocking === 'boolean' && ['open', 'resolved'].includes(q.status) && text(q.description), `${q.id}: invalid question`)
    if (q.status === 'resolved') assert(text(q.resolution), `${q.id}: resolution missing`)
  }
  return { screens, requirements, cases }
}

export function validateFunctional(contract, results, base, contractFile) {
  assert(results.schema_version === 1 && results.product_id === contract.product_id, 'results identity mismatch')
  assert(results.contract_sha256 === digest(contractFile), 'stale requirement contract')
  assert(text(results.environment) && text(results.executed_at) && !Number.isNaN(Date.parse(results.executed_at)), 'test environment/time missing')
  assert(Array.isArray(results.implementation_files) && results.implementation_files.length, 'implementation snapshot missing')
  const implementation = new Set(results.implementation_files.map(f => artifact(f, base)))
  assert(implementation.size === results.implementation_files.length, 'duplicate implementation file')
  const ids = unique(results.cases, 'result cases')
  assert(ids.size === contract.cases.length && contract.cases.every(c => ids.has(c.id)), 'test coverage mismatch')
  const failures = []
  for (const r of results.cases) {
    assert(['pass', 'fail', 'blocked', 'not_run'].includes(r.status), `${r.id}: invalid result status`)
    if (r.status !== 'pass') { failures.push(`${r.id}:${r.status}`); continue }
    assert(text(r.actual) && Array.isArray(r.evidence) && r.evidence.length, `${r.id}: pass without evidence`)
    r.evidence.forEach(ref => artifact(ref, base))
    const planned = contract.cases.find(c => c.id === r.id)
    assert(r.level === planned.level, `${r.id}: test level mismatch`)
    assert(['automated', 'manual'].includes(r.method), `${r.id}: invalid execution method`)
    if (r.method === 'automated') assert(text(r.command) && r.exit_code === 0, `${r.id}: successful command missing`)
    else assert(Array.isArray(r.steps) && r.steps.length && r.steps.every(text), `${r.id}: manual steps missing`)
  }
  return { failures, implementation }
}

export function evaluateProduct(contractFile, resultsFile) {
  const base = path.dirname(contractFile)
  const contract = read(contractFile)
  validateContract(contract, base)
  const results = read(resultsFile)
  const { failures, implementation } = validateFunctional(contract, results, base, contractFile)
  const blockers = [...failures]
  blockers.push(...contract.requirements.filter(r => r.disposition === 'clarify').map(r => `${r.id}:clarify`))
  blockers.push(...contract.questions.filter(q => q.blocking && q.status === 'open').map(q => `${q.id}:open`))
  const visual = []
  const runIds = new Set()
  for (const screen of contract.screens) {
    const refs = []
    let previousRun
    for (let stage = 1; stage <= 4; stage++) {
      const file = path.resolve(base, screen.run_dir, `stage-${stage}-handoff.json`)
      const check = spawnSync(process.execPath, [fileURLToPath(new URL('./validate-handoff.mjs', import.meta.url)), '--file', file], { encoding: 'utf8' })
      assert(check.status === 0, `${screen.id}: stage ${stage} invalid: ${check.stderr || check.stdout}`)
      const report = read(file)
      const state = report.workflow_state
      if (previousRun) assert(state.run_id === previousRun, `${screen.id}: inconsistent run identity`)
      previousRun = state.run_id
      if (stage === 1) {
        assert(!runIds.has(state.run_id), `${screen.id}: reused run_id`)
        runIds.add(state.run_id)
      }
      const gate = ['can_enter_stage_2', 'can_enter_stage_3', 'can_enter_stage_4', 'can_deliver'][stage - 1]
      if (report.handoff[gate] !== true) blockers.push(`${screen.id}:stage_${stage}_failed`)
      if (screen.design.kind === 'figma') {
        assert(state.figma_file_key === screen.design.file_key && state.frame_id === screen.design.node_id, `${screen.id}: design identity mismatch`)
      } else assert(state.source_image_sha256 === screen.design.reference.sha256, `${screen.id}: screenshot identity mismatch`)
      if (stage === 3) {
        const preview = new URL(report.handoff.preview.route_url)
        const actualRoute = /^[a-z]+:\/\//i.test(screen.route) ? preview.href : preview.pathname + preview.search + preview.hash
        assert(actualRoute === screen.route, `${screen.id}: route mismatch`)
        assert(Array.isArray(report.handoff.changed_files) && report.handoff.changed_files.length, `${screen.id}: changed files missing`)
        for (const f of report.handoff.changed_files) {
          const filePath = path.resolve(path.dirname(file), typeof f === 'string' ? f : f.path)
          assert(implementation.has(filePath), `${screen.id}: functional snapshot omits ${filePath}`)
        }
      }
      if (stage === 4 && report.handoff.can_deliver !== true) blockers.push(`${screen.id}:visual_failed`)
      refs.push({ path: path.relative(base, file), sha256: digest(file) })
    }
    visual.push({ screen_id: screen.id, handoffs: refs })
  }
  return { schema_version: 1, product_id: contract.product_id, generated_at: new Date().toISOString(),
    data_mode: contract.data_mode, contract_sha256: digest(contractFile),
    functional_results: { path: path.relative(base, resultsFile), sha256: digest(resultsFile) },
    visual, blocking_reasons: blockers, can_deliver: blockers.length === 0 }
}

function main(argv) {
  if (argv.includes('--help')) {
    console.log('Usage: node validate-product.mjs --contract <product-contract.json> [--results <functional-results.json> --output <product-acceptance.json>]\nWithout results: validate planning contract only. All evidence paths resolve relative to the contract directory. Nonzero exit means not deliverable.')
    return
  }
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    assert(['--contract', '--results', '--output'].includes(argv[i]) && text(argv[i + 1]) && !args[argv[i]], 'invalid arguments')
    args[argv[i]] = path.resolve(argv[i + 1])
  }
  assert(args['--contract'], '--contract required')
  assert(Boolean(args['--results']) === Boolean(args['--output']), '--results and --output must be supplied together')
  const contractFile = args['--contract']
  // Remove no files on failure; never leave an old success report looking current.
  if (args['--output']) {
    assert(![contractFile, args['--results']].includes(args['--output']), 'output must not overwrite inputs')
    assert(!fs.existsSync(args['--output']), 'output exists; use a new acceptance filename for each attempt')
    let report
    try { report = evaluateProduct(contractFile, args['--results']) }
    catch (error) { report = { schema_version: 1, generated_at: new Date().toISOString(), can_deliver: false, blocking_reasons: [error.message] } }
    fs.mkdirSync(path.dirname(args['--output']), { recursive: true })
    fs.writeFileSync(args['--output'], JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
    if (!report.can_deliver) process.exitCode = 1
  } else {
    validateContract(read(contractFile), path.dirname(contractFile))
    console.log('[product] contract structurally valid; this does not imply requirements resolved or tests passed')
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(`[product] ${error.message}`); process.exitCode = 1 }
}
