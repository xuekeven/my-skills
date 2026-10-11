import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const validator = path.join(root, 'scripts', 'validate-responsive.mjs')

function run(input) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-responsive-test-'))
  try {
    const inputFile = path.join(directory, 'input.json')
    fs.writeFileSync(inputFile, JSON.stringify(input, null, 2))
    const result = spawnSync(process.execPath, [validator, '--input', inputFile], { encoding: 'utf8' })
    const output = JSON.parse(fs.readFileSync(path.join(directory, 'responsive-validation.json'), 'utf8'))
    return { result, output }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function plan(captures) {
  return {
    layout_mode: 'fixed_and_responsive',
    frame_width: 375,
    responsive: {
      base: { width: 375, height: 812 },
      viewport_range: { min_width: 320, max_width: 440, min_height: 568, max_height: 932 },
      viewports: captures.map(({ width, height, kind }) => ({ width, height, kind })),
      breakpoints: [400],
      captures,
    },
  }
}

test('responsive validation rejects missing evidence instead of treating omitted checks as pass', () => {
  const { result, output } = run(plan([
    { width: 320, height: 700, kind: 'min', status: 'pass', checks: { default_state_passed: true } },
  ]))
  assert.notEqual(result.status, 0)
  assert.equal(output.can_deliver, false)
  assert.ok(output.findings.some((finding) => finding.code === 'missing_screenshot'))
  assert.ok(output.findings.some((finding) => finding.code === 'missing_check'))
})

test('responsive validation requires planned breakpoint and out-of-range evidence', () => {
  const captures = [320, 375, 380, 399, 401, 440].map((width) => ({
    width,
    height: 812,
    kind: width === 375 ? 'base' : 'middle',
    status: 'pass',
    screenshot: `screens/${width}.png`,
    capture_report: `reports/${width}.json`,
    checks: {
      root_scale_used: false,
      horizontal_overflow: false,
      core_content_clipped: false,
      console_error_count: 0,
      network_failure_count: 0,
      default_state_passed: true,
    },
  }))
  const { output } = run(plan(captures))
  assert.equal(output.can_deliver, false)
  assert.ok(output.findings.some((finding) => finding.code === 'out_of_range_viewport_missing'))
  assert.ok(output.findings.some((finding) => finding.code === 'missing_screenshot'))
})
