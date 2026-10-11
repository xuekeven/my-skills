import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const workflow = path.join(root, 'scripts', 'workflow.mjs')

function run(args) {
  const result = spawnSync(process.execPath, [workflow, ...args], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}

function runAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workflow, ...args], { cwd: root })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr || stdout || `workflow exited ${code}`))
    })
  })
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-workflow-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('begin, transition, and finish create canonical complete timing', (t) => {
  const directory = temporaryDirectory(t)
  const file = path.join(directory, 'timing.json')

  run(['begin', '--file', file, '--run-id', 'canonical', '--stage', '1', '--phase', 'rule_loading'])
  run(['transition', '--file', file, '--stage', '1', '--from-phase', 'rule_loading', '--to-phase', 'design_read'])
  run(['transition', '--file', file, '--stage', '1', '--from-phase', 'design_read', '--to-phase', 'handoff_generation'])
  run(['finish', '--file', file, '--stage', '1', '--phase', 'handoff_generation'])

  const summary = JSON.parse(run(['summary', '--file', file]))
  assert.equal(summary.timing_status, 'complete')
  assert.deepEqual(summary.stages['1'].missing_phases, [])
  assert.deepEqual(
    Object.keys(summary.scopes),
    [
      'stage:1',
      'stage:1/phase:rule_loading',
      'stage:1/phase:design_read',
      'stage:1/phase:handoff_generation',
    ],
  )
})

test('concurrent legacy starts do not overwrite timing events', async (t) => {
  const directory = temporaryDirectory(t)
  const file = path.join(directory, 'timing.json')
  const scopes = Array.from({ length: 8 }, (_, index) => `parallel:${index}`)

  await Promise.all(scopes.map((scope) => runAsync([
    'start', '--file', file, '--run-id', 'parallel', '--scope', scope,
  ])))

  const timing = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(timing.events.length, scopes.length)
  assert.deepEqual(new Set(timing.events.map((event) => event.scope)), new Set(scopes))
})

test('summary remains partial when required phases were never measured', (t) => {
  const directory = temporaryDirectory(t)
  const file = path.join(directory, 'timing.json')

  run(['begin', '--file', file, '--run-id', 'partial', '--stage', '1', '--phase', 'rule_loading'])
  run(['finish', '--file', file, '--stage', '1', '--phase', 'rule_loading'])

  const summary = JSON.parse(run(['summary', '--file', file]))
  assert.equal(summary.timing_status, 'partial')
  assert.deepEqual(summary.stages['1'].missing_phases, ['design_read', 'handoff_generation'])
})
