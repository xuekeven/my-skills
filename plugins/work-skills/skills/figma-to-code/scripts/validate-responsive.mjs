#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

function die(message, code = 1) {
  console.error(`[validate-responsive] ${message}`)
  process.exit(code)
}

function usage() {
  console.log(`用法：
  node validate-responsive.mjs --input <responsive-plan-and-results.json> [--output <responsive-validation.json>]

输入包含 layout_mode、responsive.base、responsive.viewport_range、responsive.viewports，
以及完成后的 responsive.captures。fixed_only 模式会生成通过的 no-op 结果。`)
}

function args(argv) {
  const out = { input: '', output: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--help' || key === '-h') { usage(); process.exit(0) }
    if (key === '--input') out.input = argv[++i]
    else if (key === '--output') out.output = argv[++i]
    else die(`未知参数：${key}`)
  }
  if (!out.input) die('缺少 --input。')
  return out
}

function isInt(value) { return Number.isInteger(value) }
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (error) { die(`无法读取 JSON ${file}：${error.message}`) }
}
function add(findings, code, message, severity = 'error') { findings.push({ code, message, severity }) }
function requireBoolean(value, label, findings) {
  if (typeof value !== 'boolean') add(findings, 'missing_check', `${label} 必须明确为 true 或 false。`)
}
function requireInteger(value, label, findings) {
  if (!Number.isInteger(value) || value < 0) add(findings, 'missing_check', `${label} 必须是非负整数。`)
}
function existsIfPath(base, value) {
  if (!value || typeof value !== 'string') return false
  return fs.existsSync(path.resolve(base, value))
}

const options = args(process.argv.slice(2))
const inputFile = path.resolve(options.input)
const input = readJson(inputFile)
const baseDir = path.dirname(inputFile)
const findings = []
const layoutMode = input.layout_mode ?? input.mode ?? 'fixed_only'

if (!['fixed_only', 'fixed_and_responsive'].includes(layoutMode)) {
  add(findings, 'invalid_layout_mode', 'layout_mode 必须是 fixed_only 或 fixed_and_responsive。')
}

const result = {
  schema_version: 1,
  layout_mode: layoutMode,
  status: 'fail',
  can_deliver: false,
  findings,
  checked_viewports: [],
  missing_viewports: [],
  summary: '',
}

if (layoutMode === 'fixed_only') {
  result.status = 'pass'
  result.can_deliver = true
  result.summary = '未启用响应式；响应式子门禁按 no-op 通过。'
} else {
  const responsive = input.responsive
  if (!responsive || typeof responsive !== 'object') {
    add(findings, 'missing_responsive_plan', '启用响应式时必须提供 responsive 计划。')
  }
  const base = responsive?.base
  const range = responsive?.viewport_range
  const planned = responsive?.viewports
  const captures = responsive?.captures
  if (!base || !isInt(base.width) || !isInt(base.height) || base.width <= 0 || base.height <= 0) {
    add(findings, 'invalid_base', 'responsive.base 必须包含正整数 width 和 height。')
  }
  if (!range || !isInt(range.min_width) || !isInt(range.max_width) || range.min_width > range.max_width) {
    add(findings, 'invalid_viewport_range', 'viewport_range 必须包含有效的 min_width/max_width。')
  }
  if (base?.width !== input.frame_width && isInt(input.frame_width)) {
    add(findings, 'base_frame_mismatch', 'responsive.base.width 必须等于固定稿 frame_width。')
  }
  if (!Array.isArray(planned) || planned.length === 0) {
    add(findings, 'missing_viewports', '必须声明至少一个计划 viewport。')
  }
  if (!Array.isArray(captures)) {
    add(findings, 'missing_captures', '必须提供 responsive.captures。')
  }

  const plannedKeys = new Set((planned ?? []).filter(Boolean).map(v => `${v.width}x${v.height}`))
  const plannedWidths = new Set((planned ?? []).filter(Boolean).map(v => v.width))
  const requiredWidths = new Set([range?.min_width, range?.max_width, base?.width])
  if (range && range.min_width < range.max_width) requiredWidths.add(Math.floor((range.min_width + range.max_width) / 2))
  for (const breakpoint of responsive?.breakpoints ?? []) {
    if (Number.isInteger(breakpoint)) {
      requiredWidths.add(breakpoint - 1)
      requiredWidths.add(breakpoint + 1)
    } else if (Number.isInteger(breakpoint?.width)) {
      requiredWidths.add(breakpoint.width - 1)
      requiredWidths.add(breakpoint.width + 1)
    }
  }
  if (!(planned ?? []).some(v => v?.kind === 'out_of_range')) add(findings, 'out_of_range_viewport_missing', '计划中必须包含至少一个 kind=out_of_range 的安全预览。')
  for (const width of requiredWidths) {
    if (Number.isInteger(width) && width > 0 && !plannedWidths.has(width)) add(findings, 'required_viewport_missing', `计划中缺少必测宽度：${width}。`)
  }
  const captureMap = new Map()
  for (const capture of captures ?? []) {
    const key = `${capture?.width}x${capture?.height}`
    if (captureMap.has(key)) add(findings, 'duplicate_capture', `重复 viewport 捕获：${key}.`)
    captureMap.set(key, capture)
    result.checked_viewports.push(key)
    if (!isInt(capture?.width) || !isInt(capture?.height)) {
      add(findings, 'invalid_capture_size', `捕获 ${key} 的宽高必须是整数。`)
      continue
    }
    const inRange = range && capture.width >= range.min_width && capture.width <= range.max_width
    const checks = capture.checks ?? {}
    if (!capture.screenshot || !existsIfPath(baseDir, capture.screenshot)) add(findings, 'missing_screenshot', `${key} 必须提供存在的 screenshot。`)
    if (!capture.capture_report || !existsIfPath(baseDir, capture.capture_report)) add(findings, 'missing_capture_report', `${key} 必须提供存在的 capture_report。`)
    requireBoolean(checks.root_scale_used, `${key}.checks.root_scale_used`, findings)
    requireBoolean(checks.horizontal_overflow, `${key}.checks.horizontal_overflow`, findings)
    requireBoolean(checks.core_content_clipped, `${key}.checks.core_content_clipped`, findings)
    requireInteger(checks.console_error_count, `${key}.checks.console_error_count`, findings)
    requireInteger(checks.network_failure_count, `${key}.checks.network_failure_count`, findings)
    requireBoolean(checks.default_state_passed, `${key}.checks.default_state_passed`, findings)
    if (capture.status !== 'pass') add(findings, 'capture_not_passed', `${key} 捕获状态不是 pass。`)
    if (inRange && checks.root_scale_used === true) add(findings, 'root_scale_used', `${key} 使用了根容器整体缩放。`)
    if (inRange && checks.horizontal_overflow === true) add(findings, 'horizontal_overflow', `${key} 存在意外横向溢出。`)
    if (inRange && checks.core_content_clipped === true) add(findings, 'core_content_clipped', `${key} 核心内容被裁切。`)
    if ((checks.console_error_count ?? 0) > 0) add(findings, 'console_errors', `${key} 存在控制台错误。`)
    if ((checks.network_failure_count ?? 0) > 0) add(findings, 'network_failures', `${key} 存在网络失败。`)
    if (inRange && checks.default_state_passed !== true) add(findings, 'default_state_failed', `${key} 默认交互状态未通过。`)
    if (capture.screenshot && !existsIfPath(baseDir, capture.screenshot)) add(findings, 'missing_screenshot', `${key} 截图文件不存在：${capture.screenshot}`)
    if (capture.capture_report && !existsIfPath(baseDir, capture.capture_report)) add(findings, 'missing_capture_report', `${key} 捕获报告不存在：${capture.capture_report}`)
  }

  for (const key of plannedKeys) if (!captureMap.has(key)) result.missing_viewports.push(key)
  if (result.missing_viewports.length) add(findings, 'planned_viewport_missing', `缺少计划 viewport 捕获：${result.missing_viewports.join(', ')}`)
  if (range && !(planned ?? []).some(v => v?.width === range.min_width)) add(findings, 'range_min_missing', '计划中缺少范围最小宽度。')
  if (range && !(planned ?? []).some(v => v?.width === range.max_width)) add(findings, 'range_max_missing', '计划中缺少范围最大宽度。')
  if (base && !(planned ?? []).some(v => v?.width === base.width && v?.height === base.height)) add(findings, 'base_viewport_missing', '计划中缺少真实基准 viewport。')

  const blocking = findings.filter(f => f.severity === 'error')
  result.status = blocking.length ? 'fail' : 'pass'
  result.can_deliver = blocking.length === 0
  result.summary = result.can_deliver
    ? `响应式门禁通过，已检查 ${result.checked_viewports.length} 个 viewport。`
    : `响应式门禁未通过，${blocking.length} 个阻断问题。`
}

const outputFile = path.resolve(options.output || path.join(baseDir, 'responsive-validation.json'))
fs.mkdirSync(path.dirname(outputFile), { recursive: true })
fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`)
console.log(`[validate-responsive] ${result.summary}`)
console.log(`[validate-responsive] output: ${outputFile}`)
if (!result.can_deliver) process.exitCode = 3
