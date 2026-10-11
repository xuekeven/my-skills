#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { loadSkillDependency } from './lib/dependencies.mjs'

const CANONICAL_THRESHOLD = 0.3

const HELP = `
验证机器捕获报告后，对比精确尺寸的 Figma 参考 PNG 和页面实现 PNG。

用法：
  node visual-diff.js \\
    --reference visual-check/figma.png \\
    --actual visual-check/preview.png \\
    --capture-report visual-check/capture-report.json \\
    --out visual-check/diff.png \\
    --report visual-check/report.json \\
    --width 375 --height 812 --scale 1 \\
    --default-state-checked true \\
    --default-state-evidence visual-check/default-state.png \\
    --sections visual-check/stage-1-handoff.json \\
    --threshold 0.3 --accept 2 --section-accept 3

必填参数：
  --reference <path>            Figma Frame 参考 PNG
  --actual <path>               页面实现截图 PNG
  --capture-report <path>       shoot-preview.mjs 生成的机器捕获报告
  --out <path>                  差异 PNG 输出路径
  --report <path>               JSON 报告输出路径
  --width <px>                  Figma Frame 的 CSS 宽度
  --height <px>                 Figma Frame 的 CSS 高度
  --scale <number>              两张图片共同使用的倍率
  --default-state-checked <bool> 已用视觉证据确认默认态与 Figma 一致；这是外部断言
  --default-state-evidence <text> 默认态断言的截图、audit 路径或简短证据说明
  --sections <path|auto>        Stage 1 交接或 CSS 像素分区 JSON；也兼容 auto
  --accept <percent>            整体差异上限
  --section-accept <percent>    单个分区差异上限

可选参数：
  --threshold <0.3>             固定验收颜色阈值；默认且仅允许 0.3
  --cols <n>                    差异区域网格列数（默认：6）
  --rows <n>                    差异区域网格行数（默认：12）

pixelmatch 和 pngjs 由 Skill 自身管理；目标仓库不需要安装图像诊断依赖。

脚本校验捕获报告、实际截图 SHA-256、尺寸、捕获根与机器前置结果。前置失败时
退出码为 3 且不输出差异结论；差异超限为 2，通过为 0。
`

function fail(message, code = 1) {
  console.error(`\n[visual-diff] ${message}\n`)
  process.exit(code)
}

async function loadDependency(name) {
  try {
    return await loadSkillDependency(name)
  } catch (error) {
    fail(error.message)
  }
}

function readBoolean(value, flag) {
  if (!['true', 'false'].includes(value)) fail(`--${flag} 必须是 true 或 false。`)
  return value === 'true'
}

function readArgs(argv) {
  const opt = {
    reference: '',
    actual: '',
    captureReport: '',
    out: '',
    report: '',
    width: NaN,
    height: NaN,
    scale: NaN,
    defaultStateChecked: null,
    defaultStateEvidence: '',
    sections: '',
    threshold: CANONICAL_THRESHOLD,
    accept: NaN,
    sectionAccept: NaN,
    cols: 6,
    rows: 12,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(HELP.trim())
      process.exit(0)
    }
    if (arg === '--reference') opt.reference = argv[++i]
    else if (arg === '--actual') opt.actual = argv[++i]
    else if (arg === '--capture-report') opt.captureReport = argv[++i]
    else if (arg === '--out') opt.out = argv[++i]
    else if (arg === '--report') opt.report = argv[++i]
    else if (arg === '--width') opt.width = Number(argv[++i])
    else if (arg === '--height') opt.height = Number(argv[++i])
    else if (arg === '--scale') opt.scale = Number(argv[++i])
    else if (arg === '--default-state-checked') {
      opt.defaultStateChecked = readBoolean(argv[++i], 'default-state-checked')
    }
    else if (arg === '--default-state-evidence') opt.defaultStateEvidence = argv[++i]
    else if (arg === '--sections') opt.sections = argv[++i]
    else if (arg === '--threshold') opt.threshold = Number(argv[++i])
    else if (arg === '--accept') opt.accept = Number(argv[++i])
    else if (arg === '--section-accept') opt.sectionAccept = Number(argv[++i])
    else if (arg === '--cols') opt.cols = Number(argv[++i])
    else if (arg === '--rows') opt.rows = Number(argv[++i])
    else fail(`未知参数：${arg}。使用 --help 查看用法。`)
  }

  const requiredStrings = {
    reference: 'reference',
    actual: 'actual',
    captureReport: 'capture-report',
    out: 'out',
    report: 'report',
    sections: 'sections',
    defaultStateEvidence: 'default-state-evidence',
  }
  for (const [key, flag] of Object.entries(requiredStrings)) {
    if (!opt[key]) fail(`缺少必填参数 --${flag}。`)
  }
  if (opt.defaultStateChecked === null) fail('缺少必填参数 --default-state-checked。')
  for (const key of ['width', 'height', 'scale']) {
    if (!Number.isFinite(opt[key]) || opt[key] <= 0) fail(`--${key} 必须是正数。`)
  }
  if (!Number.isInteger(opt.width) || !Number.isInteger(opt.height)) {
    fail('--width 和 --height 必须是整数 CSS 像素。')
  }
  if (opt.threshold !== CANONICAL_THRESHOLD) {
    fail(`--threshold 固定为 ${CANONICAL_THRESHOLD}，不得为通过临时调整。`)
  }
  for (const key of ['accept', 'sectionAccept']) {
    if (!Number.isFinite(opt[key]) || opt[key] < 0 || opt[key] > 100) {
      const flag = key === 'sectionAccept' ? 'section-accept' : key
      fail(`--${flag} 必须在 0 到 100 之间。`)
    }
  }
  for (const key of ['cols', 'rows']) {
    if (!Number.isInteger(opt[key]) || opt[key] <= 0) fail(`--${key} 必须是正整数。`)
  }
  return opt
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`${label} JSON 无效：${error.message}`)
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function normalizeSection(section) {
  return {
    section_name: section?.section_name ?? section?.name,
    y_start: section?.y_start ?? section?.yStart,
    y_end: section?.y_end ?? section?.yEnd,
  }
}

function loadSections(value, cssHeight) {
  if (value === 'auto') {
    const first = Math.floor(cssHeight / 3)
    const second = Math.floor((cssHeight * 2) / 3)
    return [
      { section_name: '顶部', y_start: 0, y_end: first },
      { section_name: '中部', y_start: first, y_end: second },
      { section_name: '底部', y_start: second, y_end: cssHeight },
    ]
  }

  if (!fs.existsSync(value)) fail(`找不到分区文件：${value}`)
  const payload = readJson(value, '分区')
  const rawSections = Array.isArray(payload)
    ? payload
    : payload?.design_analysis?.layout_structure?.sections ??
      payload?.handoff?.design_analysis?.layout_structure?.sections ??
      payload?.stage_1_handoff?.design_analysis?.layout_structure?.sections
  if (!Array.isArray(rawSections) || rawSections.length === 0) {
    fail(
      '分区来源必须是非空数组，或包含 design_analysis.layout_structure.sections / ' +
        'handoff.design_analysis.layout_structure.sections 的 Stage 1 交接。',
    )
  }
  const sections = rawSections.map(normalizeSection)
  let cursor = 0
  for (const section of sections) {
    if (typeof section.section_name !== 'string' || !section.section_name.trim()) {
      fail('每个分区都必须有非空 section_name。')
    }
    if (!Number.isFinite(section.y_start) || !Number.isFinite(section.y_end)) {
      fail(`分区 ${section.section_name} 的 y_start/y_end 必须是 CSS 像素数值。`)
    }
    if (section.y_start !== cursor || section.y_end <= section.y_start || section.y_end > cssHeight) {
      fail(
        `分区必须从 0 到 ${cssHeight} 连续覆盖。无效范围：` +
          `${section.section_name}: ${section.y_start}-${section.y_end}.`,
      )
    }
    cursor = section.y_end
  }
  if (cursor !== cssHeight) fail(`分区结束于 ${cursor}；应覆盖完整 Frame 高度 ${cssHeight}。`)
  return sections
}

function regionDiff(mask, imageWidth, x0, y0, width, height) {
  let count = 0
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      if (mask[y * imageWidth + x]) count += 1
    }
  }
  return count
}

function issueHint(percent) {
  if (percent >= 40) return '背景缺失 | 图层偏移'
  if (percent >= 18) return '元素缺失 | 图层偏移 | 文本样式不一致'
  if (percent >= 6) return '文本样式不一致 | 渐变或效果不一致'
  return '轻微几何偏差 | 抗锯齿差异'
}

const opt = readArgs(process.argv.slice(2))
for (const file of [opt.reference, opt.actual, opt.captureReport]) {
  if (!fs.existsSync(file)) fail(`找不到输入文件：${file}`)
}

const actualBuffer = fs.readFileSync(opt.actual)
const actualSha256 = sha256(actualBuffer)
const captureReportBuffer = fs.readFileSync(opt.captureReport)
const captureReportSha256 = sha256(captureReportBuffer)
const captureReport = readJson(opt.captureReport, '捕获报告')
const capture = captureReport.capture_precheck
if (!capture || typeof capture !== 'object') fail('捕获报告缺少 capture_precheck。')

const pngModule = await loadDependency('pngjs')
const pixelmatchModule = await loadDependency('pixelmatch')
const PNG = pngModule.PNG || pngModule.default?.PNG
const pixelmatch = pixelmatchModule.default || pixelmatchModule
if (!PNG || typeof pixelmatch !== 'function') fail('无法加载 pngjs/pixelmatch 导出。')

let reference
let actual
try {
  reference = PNG.sync.read(fs.readFileSync(opt.reference))
  actual = PNG.sync.read(actualBuffer)
} catch (error) {
  fail(`无法解码输入 PNG：${error.message}`)
}

const expectedWidth = Math.round(opt.width * opt.scale)
const expectedHeight = Math.round(opt.height * opt.scale)
const captureReportMatchesActual = capture.screenshot_sha256 === actualSha256
const captureSizeMatchesRequest =
  capture.expected_css_size?.width === opt.width &&
  capture.expected_css_size?.height === opt.height &&
  capture.expected_pixel_size?.width === expectedWidth &&
  capture.expected_pixel_size?.height === expectedHeight &&
  capture.scale === opt.scale
const diffPrecheck = {
  reference_size: { width: reference.width, height: reference.height },
  preview_size: { width: actual.width, height: actual.height },
  expected_css_size: { width: opt.width, height: opt.height },
  expected_pixel_size: { width: expectedWidth, height: expectedHeight },
  scale: opt.scale,
  capture_target: capture.capture_target || '',
  capture_report_path: opt.captureReport,
  capture_report_sha256: captureReportSha256,
  actual_image_sha256: actualSha256,
  capture_report_matches_actual: captureReportMatchesActual,
  capture_size_matches_request: captureSizeMatchesRequest,
  is_width_matched: reference.width === actual.width && reference.width === expectedWidth,
  is_height_matched: reference.height === actual.height && reference.height === expectedHeight,
  is_top_left_aligned: capture.capture_clip_matches_target === true,
  has_extra_space: capture.capture_clip_matches_target !== true,
  assets_and_fonts_loaded: capture.images_loaded === true && capture.fonts_loaded === true,
  machine_checks_passed: capture.machine_checks_passed === true,
  external_assertions: {
    default_interaction_state_matches_reference: {
      status: opt.defaultStateChecked ? 'pass' : 'fail',
      evidence: [opt.defaultStateEvidence],
    },
  },
  can_run_diff: false,
  blocking_reasons: [...(Array.isArray(capture.blocking_reasons) ? capture.blocking_reasons : [])],
}

if (!diffPrecheck.is_width_matched || !diffPrecheck.is_height_matched) {
  diffPrecheck.blocking_reasons.push('diff_frame_size_mismatch_error')
}
if (!captureSizeMatchesRequest) diffPrecheck.blocking_reasons.push('capture_report_request_mismatch_error')
if (!captureReportMatchesActual) diffPrecheck.blocking_reasons.push('capture_report_stale_error')
if (!diffPrecheck.is_top_left_aligned || diffPrecheck.has_extra_space) {
  diffPrecheck.blocking_reasons.push('diff_alignment_error')
}
if (!diffPrecheck.assets_and_fonts_loaded) diffPrecheck.blocking_reasons.push('asset_or_font_loading_error')
if (!diffPrecheck.machine_checks_passed) diffPrecheck.blocking_reasons.push('capture_machine_precheck_error')
if (!opt.defaultStateChecked) diffPrecheck.blocking_reasons.push('default_state_not_checked_error')
diffPrecheck.blocking_reasons = [...new Set(diffPrecheck.blocking_reasons)]
diffPrecheck.can_run_diff = diffPrecheck.blocking_reasons.length === 0

if (!diffPrecheck.can_run_diff) {
  writeJson(opt.report, { diff_precheck: diffPrecheck, visual_diff_report: null })
  fail(`前置校验失败，未生成差异结论。报告：${opt.report}`, 3)
}

const sections = loadSections(opt.sections, opt.height)
const diff = new PNG({ width: expectedWidth, height: expectedHeight })
const numDiffPixels = pixelmatch(
  reference.data,
  actual.data,
  diff.data,
  expectedWidth,
  expectedHeight,
  { threshold: opt.threshold, includeAA: false, diffMask: true },
)

const mask = new Uint8Array(expectedWidth * expectedHeight)
for (let index = 0; index < mask.length; index += 1) {
  if (diff.data[(index << 2) + 3] > 0) mask[index] = 1
}

const totalPixels = expectedWidth * expectedHeight
const overallDiffPercent = Number(((numDiffPixels / totalPixels) * 100).toFixed(3))
const sectionDiffs = sections.map((section) => {
  const yStart = Math.round(section.y_start * opt.scale)
  const yEnd = Math.round(section.y_end * opt.scale)
  const height = yEnd - yStart
  const count = regionDiff(mask, expectedWidth, 0, yStart, expectedWidth, height)
  const percent = Number(((count / (expectedWidth * height)) * 100).toFixed(3))
  return {
    section_name: section.section_name,
    y_start_css: section.y_start,
    y_end_css: section.y_end,
    y_start_pixel: yStart,
    y_end_pixel: yEnd,
    diff_percent: percent,
    within_threshold: percent <= opt.sectionAccept,
  }
})

const cellWidth = Math.max(1, Math.floor(expectedWidth / opt.cols))
const cellHeight = Math.max(1, Math.floor(expectedHeight / opt.rows))
const cells = []
for (let row = 0; row < opt.rows; row += 1) {
  for (let column = 0; column < opt.cols; column += 1) {
    const x = column * cellWidth
    const y = row * cellHeight
    const width = column === opt.cols - 1 ? expectedWidth - x : cellWidth
    const height = row === opt.rows - 1 ? expectedHeight - y : cellHeight
    const count = regionDiff(mask, expectedWidth, x, y, width, height)
    if (count === 0) continue
    const percent = Number(((count / (width * height)) * 100).toFixed(2))
    cells.push({ x, y, width, height, diff_percent: percent, possible_issue: issueHint(percent) })
  }
}
cells.sort((left, right) => right.diff_percent - left.diff_percent)

const canAccept =
  overallDiffPercent <= opt.accept && sectionDiffs.every((section) => section.within_threshold)
fs.mkdirSync(path.dirname(path.resolve(opt.out)), { recursive: true })
fs.writeFileSync(opt.out, PNG.sync.write(diff))

const report = {
  diff_precheck: diffPrecheck,
  visual_diff_report: {
    reference_image: opt.reference,
    actual_image: opt.actual,
    diff_image: opt.out,
    compared_size: { width: expectedWidth, height: expectedHeight },
    threshold: opt.threshold,
    accept_percent: opt.accept,
    section_accept_percent: opt.sectionAccept,
    overall_diff_percent: overallDiffPercent,
    pixel_match_percent: Number((100 - overallDiffPercent).toFixed(3)),
    max_diff_regions: cells.slice(0, 5),
    section_diffs: sectionDiffs,
    can_accept: canAccept,
  },
}
writeJson(opt.report, report)

console.log('\n[visual-diff] 对比完成')
console.log(`  尺寸：${expectedWidth}x${expectedHeight}（${opt.scale} 倍）`)
console.log(`  整体差异：${overallDiffPercent}%（上限 ${opt.accept}%）`)
for (const section of sectionDiffs) {
  console.log(
    `  ${section.section_name}: ${section.diff_percent}% ` +
      `（${section.within_threshold ? '通过' : '超过阈值'}）`,
  )
}
console.log(`  差异图：${opt.out}`)
console.log(`  报告：${opt.report}`)
console.log(`  是否通过：${canAccept ? '是' : '否'}\n`)
process.exit(canAccept ? 0 : 2)
