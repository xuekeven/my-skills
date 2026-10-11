import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const generator = path.join(root, 'scripts', 'generate-stage1-handoff.mjs')
const validator = path.join(root, 'scripts', 'validate-handoff.mjs')

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}

function runRaw(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
  })
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-stage1-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const reference = path.join(directory, 'figma-reference.png')
  const timing = path.join(directory, 'timing.json')
  const analysis = path.join(directory, 'stage-1-input.json')
  const output = path.join(directory, 'stage-1-handoff.json')
  fs.writeFileSync(reference, 'reference bytes')
  writeJson(timing, {
    version: 1,
    run_id: 'stage1-derived',
    events: [
      { scope: 'stage:1', started_at: '2026-01-01T00:00:00.000Z', started_at_epoch_ms: 1, finished_at: '2026-01-01T00:00:00.030Z', finished_at_epoch_ms: 31, duration_ms: 30, status: 'completed' },
      { scope: 'stage:1/phase:rule_loading', started_at: '2026-01-01T00:00:00.000Z', started_at_epoch_ms: 1, finished_at: '2026-01-01T00:00:00.010Z', finished_at_epoch_ms: 11, duration_ms: 10, status: 'completed' },
      { scope: 'stage:1/phase:design_read', started_at: '2026-01-01T00:00:00.010Z', started_at_epoch_ms: 11, finished_at: '2026-01-01T00:00:00.020Z', finished_at_epoch_ms: 21, duration_ms: 10, status: 'completed' },
      { scope: 'stage:1/phase:handoff_generation', started_at: '2026-01-01T00:00:00.020Z', started_at_epoch_ms: 21, finished_at: '2026-01-01T00:00:00.030Z', finished_at_epoch_ms: 31, duration_ms: 10, status: 'completed' }
    ]
  })
  writeJson(analysis, {
    run_id: 'stage1-derived',
    design_analysis: {
      task_meta: { report_profile: 'compact', input_type: 'figma_node' },
      frame_info: {
        figma_file_key: 'file-key',
        frame_id: '1:1',
        frame_name: 'Frame',
        css_size: { width: 10, height: 10 },
        final_screenshot: { width: 10, height: 10 }
      },
      layout_structure: {
        sections: [{
          section_name: 'content', x: 0, y_start: 0, y_end: 10, width: 10, height: 10,
          included_layer_ids: ['1:2'], background_layers: [], text_layers: ['1:2'],
          image_layers: [], decoration_layers: [], button_layers: [], card_layers: [],
          export_groups: [], restore_strategy: 'real text', overlaps: [], risks: []
        }]
      },
      layer_hierarchy: {
        root_id: '1:1',
        nodes: [],
        coverage: {
          classified_layer_ids_by_strategy: {
            real_text_layers: ['1:2'],
            code_css_layers: ['1:1'],
            svg_layers: [],
            png_layers: [],
            ignored_layers: []
          }
        }
      },
      typography: { text_layers: [{ id: '1:2', strategy: 'real_text' }] },
      color_system: { gradients: [] }
    },
    page_classification: { type: 'simple_frame' },
    readiness_score: { overall: 100 },
    targeted_reread_queue: [],
    blocking_reasons: []
  })
  return { directory, reference, timing, analysis, output }
}

test('generator derives screenshot hash, coverage counts, gate, and omits mirrors', (t) => {
  const files = fixture(t)
  const stdout = run(generator, [
    '--analysis', files.analysis,
    '--timing', files.timing,
    '--reference', files.reference,
    '--output', files.output,
  ])
  run(validator, ['--file', files.output])

  const handoff = JSON.parse(fs.readFileSync(files.output, 'utf8'))
  const coverage = handoff.handoff.design_analysis.layer_hierarchy.coverage
  assert.equal(coverage.classified_visible, 2)
  assert.equal(coverage.total_visible, 2)
  assert.equal(coverage.unknown_role_count, 0)
  assert.equal(handoff.handoff.can_enter_stage_2, true)
  assert.equal('real_text_layers' in handoff.handoff, false)
  assert.equal(
    handoff.handoff.design_analysis.frame_info.final_screenshot.sha256,
    crypto.createHash('sha256').update('reference bytes').digest('hex'),
  )
  assert.match(stdout, /compact_bytes: \d+/)
})

test('legacy classification mirrors remain available on explicit request', (t) => {
  const files = fixture(t)
  run(generator, [
    '--analysis', files.analysis,
    '--timing', files.timing,
    '--reference', files.reference,
    '--output', files.output,
    '--legacy-classification-mirrors', 'true',
  ])
  run(validator, ['--file', files.output])

  const handoff = JSON.parse(fs.readFileSync(files.output, 'utf8'))
  assert.deepEqual(handoff.handoff.real_text_layers, ['1:2'])
  assert.deepEqual(handoff.handoff.code_css_layers, ['1:1'])
})

test('compact size limit is warning-only and does not require details or regeneration', (t) => {
  const files = fixture(t)
  const result = runRaw(generator, [
    '--analysis', files.analysis,
    '--timing', files.timing,
    '--reference', files.reference,
    '--output', files.output,
    '--max-compact-bytes', '1',
  ])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(
    result.stderr,
    /warning: compact handoff is \d+ bytes \(recommended maximum 1\); advisory only, no compaction or regeneration required\./,
  )
  assert.doesNotMatch(result.stderr, /--details/)
  run(validator, ['--file', files.output])

  const handoff = JSON.parse(fs.readFileSync(files.output, 'utf8'))
  assert.equal(handoff.handoff.can_enter_stage_2, true)
  assert.equal(
    handoff.output_artifacts.some((entry) => entry.type === 'stage_1_analysis_details'),
    false,
  )
})

test('malformed legacy classification mirror reports a contract error', (t) => {
  const files = fixture(t)
  const analysis = JSON.parse(fs.readFileSync(files.analysis, 'utf8'))
  analysis.real_text_layers = '1:2'
  writeJson(files.analysis, analysis)

  const result = runRaw(generator, [
    '--analysis', files.analysis,
    '--timing', files.timing,
    '--reference', files.reference,
    '--output', files.output,
  ])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /handoff\.real_text_layers 必须是数组/)
})
