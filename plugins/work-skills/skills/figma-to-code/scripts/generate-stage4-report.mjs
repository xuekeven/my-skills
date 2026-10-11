#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { createArtifactTools } from './lib/artifacts.mjs'
import { createFail, parseOptionArgs } from './lib/cli.mjs'
import { createJsonTools } from './lib/json.mjs'
import { summarizeStageTiming } from './lib/timing.mjs'

const AUDIT_KEYS = [
  'layer_coverage_audit',
  'rich_text_run_plan',
  'text_outline_audit',
  'button_icon_audit',
  'background_illustration_inventory',
  'gradient_direction_audit',
  'mask_blur_clip_audit',
  'z_index_layer_order_audit',
  'asset_size_audit',
  'visual_diff_report',
]

const BASE_SCORE_KEYS = [
  'frame_size_accuracy',
  'section_position_accuracy',
  'layer_order_accuracy',
  'background_illustration_completeness',
  'text_content_accuracy',
  'text_wrap_accuracy',
  'typography_weight_accuracy',
  'card_surface_accuracy',
  'gradient_mask_effect_accuracy',
  'border_gradient_accuracy',
  'micro_anchor_accuracy',
  'asset_ratio_accuracy',
  'texture_fidelity_accuracy',
  'interaction_button_accuracy',
  'overall_visual_match',
]

const ENHANCED_SCORE_KEYS = [
  'gradient_direction_accuracy',
  'gradient_border_sampling_accuracy',
  'title_underline_baseline_accuracy',
  'nested_blur_shape_completeness',
  'nested_effect_clip_accuracy',
  'text_segment_strategy_accuracy',
  'special_font_asset_accuracy',
  'mixed_text_alignment_accuracy',
]

const HELP = `
从 Stage 1/3、manifest、当前捕获和 visual diff 确定性生成第四阶段 audit、
迭代记录与紧凑交接。

用法：
  node generate-stage4-report.mjs \\
    --stage1 <stage-1-handoff.json> \\
    --stage3 <run-dir>/stage-3-handoff.json \\
    --manifest <run-dir>/asset-manifest.json \\
    --capture-report <run-dir>/stage-4-capture-report.json \\
    --reference <run-dir>/figma-reference.png \\
    --preview <run-dir>/stage-4-preview.png \\
    --visual-diff <run-dir>/stage-4-visual-diff-report.json \\
    --diff-image <run-dir>/stage-4-diff.png \\
    --timing <run-dir>/timing.json \\
    --output <run-dir>/stage-4-handoff.json \\
    [--sections <sections.json|stage-1-handoff.json>] \\
    [--mode auto|compact|detailed] \\
    [--assessment <stage-4-assessment.json>] \\
    [--accept-known-risk <risk-type> ...]

auto 仅在 Stage 1 fast_path、可见图层不超过 40、section 不超过 4 且捕获/diff
通过时选择 compact。其他情况选择 detailed，并要求 assessment 提供 10 类 audit
覆盖、评分与 finding。compact 也可传 assessment 做局部覆盖。
默认直接读取 --stage1 的 handoff.design_analysis.layout_structure.sections（兼容旧版顶层
design_analysis）；--sections 仅用于
兼容独立 section JSON 或显式指定另一份 Stage 1 交接。

生成文件：
  stage-4-audits.json
  stage-4-iteration-history.json
  stage-4-handoff.json

退出码：0 表示可交付，3 表示已生成报告但门禁未通过，1 表示输入或用法错误。
`

const fail = createFail('generate-stage4-report')
const { readJson, writeJson } = createJsonTools(fail)
const { artifact, hashFile, relativePath, requireFile } = createArtifactTools(fail)

function readArgs(argv) {
  const options = parseOptionArgs(
    argv,
    {
      help: HELP,
      fields: {
        '--stage1': 'stage1',
        '--stage3': 'stage3',
        '--manifest': 'manifest',
        '--capture-report': 'captureReport',
        '--reference': 'reference',
        '--preview': 'preview',
        '--visual-diff': 'visualDiff',
        '--diff-image': 'diffImage',
        '--sections': 'sections',
        '--timing': 'timing',
        '--output': 'output',
        '--assessment': 'assessment',
        '--mode': 'mode',
        '--accept-known-risk': 'acceptedKnownRisks',
      },
      required: [
        'stage1',
        'stage3',
        'manifest',
        'captureReport',
        'reference',
        'preview',
        'visualDiff',
        'diffImage',
        'timing',
        'output',
      ],
      defaults: {
        stage1: '',
        stage3: '',
        manifest: '',
        captureReport: '',
        reference: '',
        preview: '',
        visualDiff: '',
        diffImage: '',
        sections: '',
        timing: '',
        output: '',
        assessment: '',
        mode: 'auto',
        acceptedKnownRisks: [],
      },
      repeatable: ['acceptedKnownRisks'],
    },
    fail,
  )
  if (!['auto', 'compact', 'detailed'].includes(options.mode)) {
    fail('--mode 必须是 auto、compact 或 detailed。')
  }
  return options
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function duplicateValues(values) {
  return unique(values.filter((value, index) => values.indexOf(value) !== index))
}

function item(layerId, layerName, expected, actual, status, evidence, fixStrategy) {
  return {
    layer_id: layerId || 'not_applicable',
    layer_name: layerName,
    expected,
    actual,
    status,
    evidence,
    fix_strategy: fixStrategy,
  }
}

function audit(status, items, extra = {}) {
  return { status, items, ...extra }
}

function statusScore(status, pass = 100, warn = 97) {
  if (status === 'pass') return pass
  if (status === 'warn') return warn
  return 0
}

function stage1HandoffPayload(stage1) {
  return stage1.handoff ?? stage1.stage_1_handoff ?? stage1
}

function stage1DesignAnalysis(stage1) {
  return (
    stage1.design_analysis ??
    stage1HandoffPayload(stage1)?.design_analysis ??
    {}
  )
}

function expectedVisibleLayerIds(stage1) {
  const classified =
    stage1DesignAnalysis(stage1)?.layer_hierarchy?.coverage?.classified_layer_ids_by_strategy
  if (classified) {
    return unique([
      ...(classified.real_text_layers ?? []),
      ...(classified.code_css_layers ?? []),
      ...(classified.svg_layers ?? []),
      ...(classified.png_layers ?? []),
    ])
  }
  const handoff = stage1HandoffPayload(stage1)
  if (!handoff) fail('Stage 1 缺少可见图层分类。')
  return unique([
    ...(handoff.real_text_layers ?? []),
    ...(handoff.code_css_layers ?? []),
    ...(handoff.svg_layers ?? []),
    ...(handoff.png_layers ?? []),
  ].map((entry) => (typeof entry === 'string' ? entry : entry?.layer_id ?? entry?.id)))
}

function layerIdsFromEntries(entries) {
  return (entries ?? []).flatMap((entry) => {
    if (typeof entry === 'string') return [entry]
    if (entry?.layer_id) return [entry.layer_id]
    if (Array.isArray(entry?.layer_ids)) return entry.layer_ids
    return []
  })
}

function mappedLayerIds(mapping) {
  return unique(
    ['real_text_layers', 'code_css_layers', 'svg_layers', 'png_layers'].flatMap((key) =>
      layerIdsFromEntries(mapping?.[key]),
    ),
  )
}

function mappedAssetIds(mapping) {
  return unique(
    ['svg_layers', 'png_layers'].flatMap((key) =>
      (mapping?.[key] ?? []).map((entry) => entry?.asset_id).filter(Boolean),
    ),
  )
}

function validateSections(sections, frameHeight) {
  const problems = []
  let cursor = 0
  for (const [index, section] of sections.entries()) {
    if (!section?.section_name) problems.push(`section_${index}:missing_name`)
    if (!Number.isFinite(section?.y_start) || !Number.isFinite(section?.y_end)) {
      problems.push(`section_${index}:invalid_bounds`)
      continue
    }
    if (section.y_start !== cursor) problems.push(`${section.section_name}:gap_or_overlap_at_${cursor}`)
    if (section.y_end <= section.y_start) problems.push(`${section.section_name}:non_positive_height`)
    cursor = section.y_end
  }
  if (cursor !== frameHeight) problems.push(`section_end:${cursor}_expected_${frameHeight}`)
  return problems
}

function sectionsFromPayload(payload, label) {
  const sections = Array.isArray(payload)
    ? payload
    : stage1DesignAnalysis(payload)?.layout_structure?.sections
  if (!Array.isArray(sections) || sections.length === 0) {
    fail(
      `${label} 必须是非空数组，或包含 design_analysis.layout_structure.sections / ` +
        'handoff.design_analysis.layout_structure.sections。',
    )
  }
  return sections
}

function summarizeTiming(payload, runDirectory, timingFile) {
  return summarizeStageTiming(payload, {
    stage: 4,
    stageName: 'acceptance',
    phases: ['rule_loading', 'capture_diff_audit', 'local_fix', 'regression', 'handoff_generation'],
    runDirectory,
    timingFile,
    relativePath,
    fail,
  })
}

function validateScoreObject(scores, keys, label) {
  for (const key of keys) {
    if (!Number.isFinite(scores?.[key]) || scores[key] < 0 || scores[key] > 100) {
      fail(`${label}.${key} 必须是 0–100 的数字。`)
    }
  }
}

function mergeScoreOverrides(base, overrides, keys, label) {
  const result = { ...base, ...(overrides ?? {}) }
  validateScoreObject(result, keys, label)
  return result
}

function riskRemovalCondition(type) {
  if (type === 'font_fallback' || type === 'target_repository_font_availability') {
    return '提供可授权嵌入的设计字体文件，接入 @font-face 后重跑完整第四阶段。'
  }
  if (type === 'browser_console_warning') {
    return '消除对应控制台警告并重跑捕获、diff 与受影响 audit。'
  }
  return '补齐该风险所缺输入或来源证据后重跑完整第四阶段。'
}

function commandFor(options) {
  const parts = [
    'node scripts/generate-stage4-report.mjs',
    '--stage1',
    options.stage1,
    '--stage3',
    options.stage3,
    '--manifest',
    options.manifest,
    '--capture-report',
    options.captureReport,
    '--reference',
    options.reference,
    '--preview',
    options.preview,
    '--visual-diff',
    options.visualDiff,
    '--diff-image',
    options.diffImage,
    '--timing',
    options.timing,
    '--output',
    options.output,
    '--mode',
    options.mode,
  ]
  if (options.sections) parts.push('--sections', options.sections)
  if (options.assessment) parts.push('--assessment', options.assessment)
  for (const risk of options.acceptedKnownRisks) parts.push('--accept-known-risk', risk)
  return parts.join(' ')
}

const options = readArgs(process.argv.slice(2))
const stage1File = requireFile(options.stage1, ' Stage 1 交接')
const stage3File = requireFile(options.stage3, ' Stage 3 交接')
const manifestFile = requireFile(options.manifest, '资产 manifest')
const captureReportFile = requireFile(options.captureReport, '第四阶段捕获报告')
const referenceFile = requireFile(options.reference, 'Figma 参考图')
const previewFile = requireFile(options.preview, '第四阶段预览截图')
const visualDiffFile = requireFile(options.visualDiff, '第四阶段 visual diff 报告')
const diffImageFile = requireFile(options.diffImage, '第四阶段 diff 图')
const timingFile = requireFile(options.timing, '计时文件')
const outputFile = path.resolve(options.output)
if (path.basename(outputFile) !== 'stage-4-handoff.json') {
  fail('--output 文件名必须是 stage-4-handoff.json。')
}
const runDirectory = path.dirname(outputFile)
const auditsFile = path.join(runDirectory, 'stage-4-audits.json')
const iterationsFile = path.join(runDirectory, 'stage-4-iteration-history.json')

const stage1 = readJson(stage1File, 'Stage 1 交接')
const designAnalysis = stage1DesignAnalysis(stage1)
const stage1Handoff = stage1HandoffPayload(stage1)
const stage3 = readJson(stage3File, 'Stage 3 交接')
const manifestPayload = readJson(manifestFile, '资产 manifest')
const capturePayload = readJson(captureReportFile, '第四阶段捕获报告')
const visualDiffPayload = readJson(visualDiffFile, '第四阶段 visual diff 报告')
const sectionsFile = options.sections ? requireFile(options.sections, 'section 表') : stage1File
const sectionsPayload =
  sectionsFile === stage1File ? stage1 : readJson(sectionsFile, 'section 表')
const sections = sectionsFromPayload(
  sectionsPayload,
  options.sections ? 'section 来源' : 'Stage 1 交接的 section',
)
const standaloneSectionsFile = Array.isArray(sectionsPayload) ? sectionsFile : null
const sectionsPointer = stage1.design_analysis
  ? 'design_analysis.layout_structure.sections'
  : 'handoff.design_analysis.layout_structure.sections'
const sectionsEvidence = standaloneSectionsFile
  ? relativePath(runDirectory, standaloneSectionsFile)
  : `${relativePath(runDirectory, sectionsFile)}#${sectionsPointer}`
const timingPayload = readJson(timingFile, '计时文件')
const assessment = options.assessment
  ? readJson(requireFile(options.assessment, '第四阶段 assessment'), '第四阶段 assessment')
  : {}

const sourceState = stage3.workflow_state
const stage3Handoff = stage3.handoff
const layoutMode =
  stage3Handoff?.layout_mode ??
  stage1Handoff?.layout_mode ??
  'fixed_only'
const responsiveValidation = stage3Handoff?.responsive_validation ?? {
  layout_mode: layoutMode,
  can_deliver: layoutMode === 'fixed_only',
  status: layoutMode === 'fixed_only' ? 'not_applicable' : 'missing',
  blocking_reasons: layoutMode === 'fixed_only' ? [] : ['responsive_validation_missing'],
}
const manifest = manifestPayload.asset_manifest
const capture = capturePayload.capture_precheck
const diffPrecheck = visualDiffPayload.diff_precheck
const visualDiff = visualDiffPayload.visual_diff_report
if (
  stage3.stage !== 3 ||
  sourceState?.current_stage !== 3 ||
  stage3Handoff?.can_enter_stage_4 !== true
) {
  fail('Stage 3 交接门禁未通过。')
}
if (!manifest || !Array.isArray(manifest.assets)) fail('asset-manifest.json 缺少 asset_manifest.assets。')
if (!capture || typeof capture !== 'object') fail('捕获报告缺少 capture_precheck。')
if (!diffPrecheck || !visualDiff) fail('visual diff 报告缺少 diff_precheck 或 visual_diff_report。')
const expectedIds = expectedVisibleLayerIds(stage1)
const mapping = stage3Handoff.implementation_mapping
const mappedIdsWithDuplicates = ['real_text_layers', 'code_css_layers', 'svg_layers', 'png_layers']
  .flatMap((key) => layerIdsFromEntries(mapping?.[key]))
  .filter(Boolean)
const mappedIds = mappedLayerIds(mapping)
const missingLayerIds = expectedIds.filter((id) => !mappedIds.includes(id))
const extraLayerIds = mappedIds.filter((id) => !expectedIds.includes(id))
const duplicateLayerIds = duplicateValues(mappedIdsWithDuplicates)
const frameHeight = Number(sourceState.frame_height)
const sectionProblems = validateSections(sections, frameHeight)

const fastPath = Boolean(
  stage1Handoff?.page_classification?.fast_path ??
    stage1Handoff?.page_classification?.fast_path_eligible ??
    designAnalysis.page_classification?.fast_path ??
    designAnalysis.page_classification?.fast_path_eligible ??
    designAnalysis.task_meta?.read_path === 'small_frame_fast_path',
)
const compactEligible =
  fastPath &&
  expectedIds.length <= 40 &&
  sections.length <= 4 &&
  capture.machine_checks_passed === true &&
  diffPrecheck.can_run_diff === true &&
  visualDiff.can_accept === true
const reportMode = options.mode === 'auto' ? (compactEligible ? 'compact' : 'detailed') : options.mode
if (reportMode === 'compact' && !compactEligible) {
  fail('当前页面不满足 compact 条件；使用 detailed 并提供 --assessment。')
}
if (reportMode === 'detailed' && !options.assessment) {
  fail('detailed 模式必须提供 --assessment。')
}
if (reportMode === 'detailed') {
  const missingOverrides = AUDIT_KEYS.filter((key) => !assessment.audit_overrides?.[key])
  if (missingOverrides.length > 0) {
    fail(`detailed assessment 缺少 audit_overrides：${missingOverrides.join(', ')}`)
  }
}

const blockers = []
const addBlocker = (reason) => {
  if (!blockers.includes(reason)) blockers.push(reason)
}

if (layoutMode !== 'fixed_only' && responsiveValidation.can_deliver !== true) {
  addBlocker('responsive_gate_error')
}

const previewHash = hashFile(previewFile)
const captureHash = hashFile(captureReportFile)
const visualDiffHash = hashFile(visualDiffFile)
if (capture.screenshot_sha256 !== previewHash) addBlocker('capture_screenshot_hash_mismatch')
if (diffPrecheck.actual_image_sha256 !== previewHash) addBlocker('diff_preview_hash_mismatch')
if (diffPrecheck.capture_report_sha256 !== captureHash) addBlocker('diff_capture_report_hash_mismatch')
if (capture.machine_checks_passed !== true) addBlocker('capture_precheck_failed')
if (diffPrecheck.can_run_diff !== true) addBlocker('diff_precheck_failed')
if (
  diffPrecheck.external_assertions?.default_interaction_state_matches_reference?.status !== 'pass'
) {
  addBlocker('default_interaction_state_not_confirmed')
}
if (visualDiff.can_accept !== true) addBlocker('visual_diff_failed')
if (missingLayerIds.length > 0 || extraLayerIds.length > 0 || duplicateLayerIds.length > 0) {
  addBlocker('layer_coverage_error')
}
if (sectionProblems.length > 0) addBlocker('section_coverage_error')
if (
  sourceState.run_id !== manifest.run_id ||
  sourceState.frame_id !== manifest.frame_id ||
  stage1.workflow_state?.run_id !== sourceState.run_id ||
  stage1.workflow_state?.frame_id !== sourceState.frame_id
) {
  addBlocker('frame_identity_error')
}

const manifestDirectory = path.dirname(manifestFile)
const assetProblems = []
for (const assetEntry of manifest.assets) {
  const assetFile = path.resolve(manifestDirectory, assetEntry.file)
  if (!fs.existsSync(assetFile)) assetProblems.push(`${assetEntry.asset_id}:missing`)
  else if (hashFile(assetFile) !== assetEntry.sha256) assetProblems.push(`${assetEntry.asset_id}:hash`)
  if (assetEntry.qa_status !== 'pass') assetProblems.push(`${assetEntry.asset_id}:qa`)
}
const usedAssetIds = unique(stage3Handoff.used_asset_ids ?? [])
const mappedAssets = mappedAssetIds(mapping)
for (const assetEntry of manifest.assets) {
  if (!usedAssetIds.includes(assetEntry.asset_id)) assetProblems.push(`${assetEntry.asset_id}:unused`)
  if (!mappedAssets.includes(assetEntry.asset_id)) assetProblems.push(`${assetEntry.asset_id}:unmapped`)
}
if (assetProblems.length > 0) addBlocker('asset_manifest_error')

const classifiedRealTextIds = unique(layerIdsFromEntries(stage1Handoff.real_text_layers))
const textLayerIds =
  classifiedRealTextIds.length > 0
    ? classifiedRealTextIds
    : (designAnalysis.typography?.text_layers ?? [])
        .filter((entry) => entry.strategy === 'real_text')
        .map((entry) => entry.id)
const mappedTextIds = unique(layerIdsFromEntries(mapping?.real_text_layers))
const missingTextIds = textLayerIds.filter((id) => !mappedTextIds.includes(id))
const sectionsFromStage1 = designAnalysis.layout_structure?.sections ?? []
const backgroundIds = unique(
  sectionsFromStage1.flatMap((section) => [
    ...(section.background_layers ?? []),
    ...(section.image_layers ?? []),
    ...(section.decoration_layers ?? []),
  ]),
)
const missingBackgroundIds = backgroundIds.filter((id) => !mappedIds.includes(id))
const buttonIds = unique(sectionsFromStage1.flatMap((section) => section.button_layers ?? []))
const missingButtonIds = buttonIds.filter((id) => !mappedIds.includes(id))
const expectedGradients = designAnalysis.color_system?.gradients ?? []
const cssDescriptions = (mapping?.code_css_layers ?? [])
  .map((entry) => (typeof entry === 'string' ? '' : entry?.implementation ?? ''))
  .join(' ')
const gradientEvidencePresent =
  expectedGradients.length === 0 || /gradient|渐变/i.test(cssDescriptions)

const layerStatus =
  missingLayerIds.length === 0 && extraLayerIds.length === 0 && duplicateLayerIds.length === 0
    ? 'pass'
    : 'error'
const textStatus = missingTextIds.length === 0 ? 'pass' : 'error'
const buttonStatus = missingButtonIds.length === 0 ? 'pass' : 'error'
const backgroundStatus = missingBackgroundIds.length === 0 ? 'pass' : 'error'
const gradientStatus = gradientEvidencePresent ? 'pass' : 'error'
const assetStatus = assetProblems.length === 0 ? 'pass' : 'error'
const diffStatus = visualDiff.can_accept === true ? 'pass' : 'error'

let audits = {
  layer_coverage_audit: audit(
    layerStatus,
    [
      item(
        sourceState.frame_id,
        sourceState.frame_name,
        `${expectedIds.length} 个可见图层唯一落位，${sections.length} 个 section 连续覆盖 0..${frameHeight}`,
        `${mappedIds.length}/${expectedIds.length} 个唯一映射；missing=${missingLayerIds.length}, extra=${extraLayerIds.length}, duplicate=${duplicateLayerIds.length}, section_problems=${sectionProblems.length}`,
        layerStatus,
        ['stage-1-handoff.json', 'stage-3-handoff.json', sectionsEvidence],
        layerStatus === 'pass' ? '无。' : '回到 Stage 3 只修缺失、额外或重复映射及 section 边界。',
      ),
    ],
    { missing_layers: missingLayerIds, extra_layers: extraLayerIds, duplicate_layers: duplicateLayerIds },
  ),
  rich_text_run_plan: audit(textStatus, [
    item(
      textLayerIds.join(',') || 'not_applicable',
      'all real text runs',
      `${textLayerIds.length} 个 Figma 文本层保持真实文本并按 run 隔离`,
      `${mappedTextIds.length}/${textLayerIds.length} 个文本层映射；missing=${missingTextIds.length}`,
      textStatus,
      ['stage-1-handoff.json#handoff.design_analysis.typography', 'stage-3-handoff.json#handoff.implementation_mapping'],
      textStatus === 'pass' ? '无。' : '回到 Stage 3 补齐真实文本或拆分缺失 run。',
    ),
  ]),
  text_outline_audit: audit(textStatus, [
    item(
      textLayerIds.join(',') || 'not_applicable',
      'text fill/stroke/effect stack',
      '保留 Stage 1 记录的文本 fill、stroke、effect、内容和换行',
      `全部文本策略已映射；visual diff=${visualDiff.overall_diff_percent}%`,
      textStatus,
      ['stage-1-handoff.json#handoff.design_analysis.typography', relativePath(runDirectory, visualDiffFile)],
      textStatus === 'pass' ? '无。' : '回到 Stage 3 修正文本 fill/stroke/effect stack。',
    ),
  ]),
  button_icon_audit: audit(buttonStatus, [
    item(
      buttonIds.join(',') || 'not_applicable',
      'buttons and icons',
      `${buttonIds.length} 个按钮层及相关图标保持尺寸、间距、居中和真实文字`,
      `${buttonIds.length - missingButtonIds.length}/${buttonIds.length} 个按钮层已映射；正式资产 ${mappedAssets.length} 个`,
      buttonStatus,
      ['stage-1-handoff.json#handoff.design_analysis.layout_structure.sections', 'stage-3-handoff.json'],
      buttonStatus === 'pass' ? '无。' : '回到 Stage 3 补齐按钮或图标映射。',
    ),
  ]),
  background_illustration_inventory: audit(backgroundStatus, [
    item(
      backgroundIds.join(',') || 'not_applicable',
      'backgrounds, illustrations and edge decorations',
      `${backgroundIds.length} 个背景、插图和装饰层均有实现`,
      `${backgroundIds.length - missingBackgroundIds.length}/${backgroundIds.length} 个已映射`,
      backgroundStatus,
      ['stage-1-handoff.json#handoff.design_analysis.layout_structure.sections', 'stage-3-handoff.json'],
      backgroundStatus === 'pass' ? '无。' : '回到 Stage 3 补齐缺失背景或装饰。',
    ),
  ]),
  gradient_direction_audit: audit(
    gradientStatus,
    [
      item(
        sourceState.frame_id,
        'declared gradients',
        `${expectedGradients.length} 条设计渐变保留类型、方向、stop 和边缘关系`,
        gradientEvidencePresent
          ? `Stage 3 CSS 映射包含渐变证据；visual diff=${visualDiff.overall_diff_percent}%`
          : 'Stage 3 CSS 映射未找到渐变证据',
        gradientStatus,
        ['stage-1-handoff.json#handoff.design_analysis.color_system', 'stage-3-handoff.json'],
        gradientStatus === 'pass' ? '无。' : '回到 Stage 3 补齐渐变向量、stop 和边缘采样。',
      ),
    ],
    {
      edge_samples:
        assessment.edge_samples ??
        (expectedGradients.length === 0
          ? []
          : [
              {
                sample: 'aggregate_visual_diff',
                expected: '与 Figma 渐变方向和边缘色一致',
                actual: `${visualDiff.overall_diff_percent}% overall diff`,
                status: gradientStatus,
              },
            ]),
    },
  ),
  mask_blur_clip_audit: {
    status: assetStatus,
    mask_boolean_transform_audit: audit(assetStatus, [
      item(
        mappedAssets.join(',') || sourceState.frame_id,
        'asset alpha, mask and clip',
        '正式资产 alpha、mask、transform、比例与父级裁切通过 manifest QA',
        `${manifest.assets.length - assetProblems.length}/${manifest.assets.length} 个正式资产无哈希、QA、使用或映射问题`,
        assetStatus,
        [relativePath(runDirectory, manifestFile), 'stage-3-handoff.json'],
        assetStatus === 'pass' ? '无。' : '按根因回到 Stage 2 重新导出，或回到 Stage 3 修正落位/裁切。',
      ),
    ]),
    nested_blur_shape_inventory: audit('pass', [
      item(
        sourceState.frame_id,
        'nested effects',
        'Stage 1 已识别的 blur、柔光和嵌套效果均由映射与 diff 覆盖',
        `visual diff=${visualDiff.overall_diff_percent}%；未发现未映射可见层`,
        'pass',
        ['stage-1-handoff.json#handoff.design_analysis.effects', relativePath(runDirectory, visualDiffFile)],
        '无；复杂页面应在 detailed assessment 中覆盖此自动判断。',
      ),
    ]),
  },
  z_index_layer_order_audit: audit(layerStatus, [
    item(
      sourceState.frame_id,
      'frame stacking order',
      '全部可见层保持 Figma 前后顺序、裁切和 stacking context',
      `${mappedIds.length}/${expectedIds.length} 个图层已映射；visual diff=${visualDiff.overall_diff_percent}%`,
      layerStatus,
      ['stage-3-handoff.json#handoff.implementation_mapping', relativePath(runDirectory, diffImageFile)],
      layerStatus === 'pass' ? '无。' : '回到 Stage 3 修正受影响层级和 stacking context。',
    ),
  ]),
  asset_size_audit: audit(assetStatus, [
    item(
      manifest.assets.map((entry) => entry.asset_id).join(',') || 'not_applicable',
      'formal assets',
      `${manifest.assets.length} 个正式资产文件、QA、哈希、使用和图层映射一致`,
      assetProblems.length === 0 ? `${manifest.assets.length}/${manifest.assets.length} 通过` : assetProblems.join(', '),
      assetStatus,
      [relativePath(runDirectory, manifestFile), 'stage-3-handoff.json'],
      assetStatus === 'pass' ? '无。' : '按问题类型回到 Stage 2 或 Stage 3 修正资产。',
    ),
  ]),
  visual_diff_report: {
    status: diffStatus,
    report_path: relativePath(runDirectory, visualDiffFile),
    reference_image: relativePath(runDirectory, referenceFile),
    actual_image: relativePath(runDirectory, previewFile),
    diff_image: relativePath(runDirectory, diffImageFile),
    threshold: visualDiff.threshold,
    accept_percent: visualDiff.accept_percent,
    section_accept_percent: visualDiff.section_accept_percent,
    overall_diff_percent: visualDiff.overall_diff_percent,
    pixel_match_percent: visualDiff.pixel_match_percent,
    section_diffs: visualDiff.section_diffs,
    can_accept: visualDiff.can_accept,
  },
}

for (const key of AUDIT_KEYS) {
  const override = assessment.audit_overrides?.[key]
  if (!override) continue
  audits[key] = { ...audits[key], ...override }
}
for (const key of AUDIT_KEYS) {
  if (!['pass', 'warn', 'error'].includes(audits[key]?.status)) {
    fail(`audit ${key}.status 必须是 pass、warn 或 error。`)
  }
  if (audits[key].status === 'error') addBlocker(`audit_error:${key}`)
}

const acceptedKnownRisks = new Set(options.acceptedKnownRisks)
const acceptedIrreducibleRisks = [...(assessment.accepted_irreducible_risks ?? [])]
const auditFindings = [...(assessment.audit_findings ?? [])]
for (const [index, risk] of (stage3Handoff.known_risks ?? []).entries()) {
  if (!acceptedKnownRisks.has(risk.type)) {
    addBlocker(`known_risk_unresolved:${risk.type ?? index}`)
    auditFindings.push({
      finding_id: `known-risk-${index + 1}`,
      category: 'remaining_minor_issues',
      region: 'page',
      severity: risk.severity ?? 'medium',
      expected: 'Stage 3 已知风险在交付前被消除或显式接受',
      actual: risk.detail ?? risk.note ?? risk.type,
      evidence: ['stage-3-handoff.json#handoff.known_risks'],
      root_cause: 'source_field',
      responsible_stage: 3,
      status: 'open',
      fix_strategy: riskRemovalCondition(risk.type),
      revalidation_result: '未提供 --accept-known-risk 决策。',
    })
    continue
  }
  const acceptedRisk = {
    risk_id: `known-risk-${index + 1}`,
    type: risk.type,
    severity: risk.severity ?? 'low',
    detail: risk.detail ?? risk.note ?? risk.type,
    evidence: ['stage-3-handoff.json#handoff.known_risks', relativePath(runDirectory, diffImageFile)],
    removal_condition: riskRemovalCondition(risk.type),
  }
  acceptedIrreducibleRisks.push(acceptedRisk)
  auditFindings.push({
    finding_id: acceptedRisk.risk_id,
    category: 'remaining_minor_issues',
    region: 'page',
    severity: acceptedRisk.severity,
    expected: '使用设计指定的精确来源或渲染条件',
    actual: acceptedRisk.detail,
    evidence: acceptedRisk.evidence,
    root_cause: 'irreducible_rendering',
    responsible_stage: 3,
    status: 'accepted_irreducible',
    fix_strategy: acceptedRisk.removal_condition,
    revalidation_result: `visual diff ${visualDiff.overall_diff_percent}%，当前阈值门禁通过。`,
  })
}

const overallVisualMatch = Math.max(0, Math.min(100, Math.round(100 - visualDiff.overall_diff_percent)))
const hasFontRisk = acceptedIrreducibleRisks.some((risk) =>
  ['font_fallback', 'font_fallback_variance', 'target_repository_font_availability'].includes(
    risk.type,
  ),
)
const baseScores = mergeScoreOverrides(
  {
    frame_size_accuracy: capture.target_size_matched ? 100 : 0,
    section_position_accuracy: sectionProblems.length === 0 ? 100 : 0,
    layer_order_accuracy: statusScore(audits.z_index_layer_order_audit.status),
    background_illustration_completeness: statusScore(
      audits.background_illustration_inventory.status,
    ),
    text_content_accuracy: statusScore(audits.rich_text_run_plan.status),
    text_wrap_accuracy: statusScore(audits.rich_text_run_plan.status),
    typography_weight_accuracy: hasFontRisk ? 98 : statusScore(audits.text_outline_audit.status),
    card_surface_accuracy: statusScore(audits.mask_blur_clip_audit.status),
    gradient_mask_effect_accuracy: statusScore(audits.gradient_direction_audit.status),
    border_gradient_accuracy: statusScore(audits.gradient_direction_audit.status),
    micro_anchor_accuracy: visualDiff.overall_diff_percent <= 0.5 ? 100 : 99,
    asset_ratio_accuracy: statusScore(audits.asset_size_audit.status),
    texture_fidelity_accuracy: visualDiff.overall_diff_percent <= 0.5 ? 100 : 99,
    interaction_button_accuracy: statusScore(audits.button_icon_audit.status),
    overall_visual_match: overallVisualMatch,
  },
  assessment.restore_quality_score,
  BASE_SCORE_KEYS,
  'restore_quality_score',
)
const enhancedScores = mergeScoreOverrides(
  {
    gradient_direction_accuracy: statusScore(audits.gradient_direction_audit.status),
    gradient_border_sampling_accuracy: statusScore(audits.gradient_direction_audit.status),
    title_underline_baseline_accuracy: 100,
    nested_blur_shape_completeness: statusScore(audits.mask_blur_clip_audit.status),
    nested_effect_clip_accuracy: statusScore(audits.mask_blur_clip_audit.status),
    text_segment_strategy_accuracy: statusScore(audits.rich_text_run_plan.status),
    special_font_asset_accuracy: hasFontRisk ? 95 : 100,
    mixed_text_alignment_accuracy: statusScore(audits.rich_text_run_plan.status),
  },
  assessment.enhanced_restore_quality_score,
  ENHANCED_SCORE_KEYS,
  'enhanced_restore_quality_score',
)

const pixelScore = 100 - visualDiff.overall_diff_percent
const fidelityPercent = Math.round(0.6 * pixelScore + 0.4 * baseScores.overall_visual_match)
const fixableGaps = assessment.fixable_gaps ?? []
const regressionErrors = assessment.regression_errors ?? []
const keyBaseScores = [
  baseScores.layer_order_accuracy,
  baseScores.background_illustration_completeness,
  baseScores.text_wrap_accuracy,
  baseScores.card_surface_accuracy,
  baseScores.micro_anchor_accuracy,
  baseScores.overall_visual_match,
]
const enhancedThresholdsPassed =
  enhancedScores.gradient_direction_accuracy >= 98 &&
  enhancedScores.title_underline_baseline_accuracy >= 98 &&
  enhancedScores.nested_blur_shape_completeness >= 95 &&
  enhancedScores.text_segment_strategy_accuracy >= 95 &&
  enhancedScores.special_font_asset_accuracy >= 95
const fidelityGatePassed = fidelityPercent >= 98
if (keyBaseScores.some((score) => score < 95)) addBlocker('critical_score_below_95')
if (!enhancedThresholdsPassed) addBlocker('enhanced_score_gate_failed')
if (baseScores.overall_visual_match < 98 && acceptedIrreducibleRisks.length === 0) {
  addBlocker('overall_visual_match_below_98')
}
if (!fidelityGatePassed) addBlocker('restore_fidelity_gate_failed')
if (regressionErrors.length > 0) addBlocker('regression_errors_present')

const canDeliver = blockers.length === 0
const restoreFidelity = {
  stage: 'measured',
  overall_percent: fidelityPercent,
  prev_round_percent: assessment.prev_round_percent ?? null,
  delta_vs_prev:
    Number.isFinite(assessment.prev_round_percent)
      ? fidelityPercent - assessment.prev_round_percent
      : null,
  formula: 'round(0.6*(100-overall_diff_percent@0.3)+0.4*overall_visual_match)',
  formula_substitution: `round(0.6*(100-${visualDiff.overall_diff_percent})+0.4*${baseScores.overall_visual_match})=${fidelityPercent}`,
  pixel_match_percent: visualDiff.pixel_match_percent,
  diff_threshold_used: visualDiff.threshold,
  overall_visual_match: baseScores.overall_visual_match,
  dimension_scores: {
    frame_and_sections: Math.round(
      (baseScores.frame_size_accuracy + baseScores.section_position_accuracy) / 2,
    ),
    layers_and_assets: Math.round(
      (baseScores.layer_order_accuracy + baseScores.asset_ratio_accuracy) / 2,
    ),
    text_and_typography: Math.round(
      (baseScores.text_content_accuracy +
        baseScores.text_wrap_accuracy +
        baseScores.typography_weight_accuracy) /
        3,
    ),
    surface_and_effects: Math.round(
      (baseScores.card_surface_accuracy +
        baseScores.gradient_mask_effect_accuracy +
        baseScores.texture_fidelity_accuracy) /
        3,
    ),
    interaction_controls: baseScores.interaction_button_accuracy,
  },
  fixable_gaps: fixableGaps,
  irreducible_deductions: acceptedIrreducibleRisks.map((risk) => ({
    category: risk.type ?? risk.risk_id,
    estimated_impact_percent: risk.estimated_impact_percent ?? 1,
    evidence: risk.evidence,
    removal_condition: risk.removal_condition,
  })),
  grade:
    fidelityPercent >= 98
      ? 'excellent'
      : fidelityPercent >= 95
        ? 'good'
        : fidelityPercent >= 90
          ? 'acceptable'
          : 'fail',
  can_deliver: canDeliver,
}

const generatedAt = new Date().toISOString()
const auditReport = {
  schema_version: 1,
  artifact_type: 'figma_to_code_stage_4_audits',
  generated_at: generatedAt,
  run_id: sourceState.run_id,
  frame_id: sourceState.frame_id,
  report_mode: reportMode,
  machine_executable_audits: audits,
  audit_findings: auditFindings,
  restore_quality_score: baseScores,
  enhanced_restore_quality_score: enhancedScores,
  restore_fidelity: restoreFidelity,
  fixable_gaps: fixableGaps,
  accepted_irreducible_risks: acceptedIrreducibleRisks,
  blocking_reasons: blockers,
  can_deliver: canDeliver,
}
writeJson(auditsFile, auditReport)
const auditsHash = hashFile(auditsFile)

const regressionChecks = [
  {
    name: 'stage_3_gate',
    result: 'pass',
    evidence: relativePath(runDirectory, stage3File),
  },
  {
    name: 'capture_precheck',
    result: capture.machine_checks_passed === true ? 'pass' : 'fail',
    evidence: relativePath(runDirectory, captureReportFile),
  },
  {
    name: 'visual_diff',
    result: visualDiff.can_accept === true ? 'pass' : 'fail',
    evidence: relativePath(runDirectory, visualDiffFile),
  },
  {
    name: 'asset_manifest',
    result: assetProblems.length === 0 ? 'pass' : 'fail',
    evidence: relativePath(runDirectory, manifestFile),
  },
  ...(assessment.regression_checks ?? []),
]
const iterationReport = {
  schema_version: 1,
  artifact_type: 'figma_to_code_stage_4_iteration_history',
  generated_at: generatedAt,
  run_id: sourceState.run_id,
  iterations:
    assessment.iterations ??
    [
      {
        round: 1,
        kind: 'acceptance_baseline',
        changes: [],
        decision: canDeliver
          ? (fixableGaps.length > 0
            ? '综合还原度已达到 98 分及以上；保留剩余可修差异，暂停继续循环并允许交付。'
            : '基线满足全部机器门禁和 compact audit；不进行无收益局部修正。')
          : '基线未满足门禁；按 blocking_reasons 和 audit finding 回到负责阶段局部修正。',
        overall_diff_percent: visualDiff.overall_diff_percent,
        restore_fidelity_percent: fidelityPercent,
        regressions: regressionErrors,
        status: canDeliver ? (fixableGaps.length > 0 ? 'accepted_paused_at_98' : 'accepted') : 'needs_fix',
      },
    ],
  regression_checks: regressionChecks,
  regression_errors: regressionErrors,
}
writeJson(iterationsFile, iterationReport)
const iterationsHash = hashFile(iterationsFile)

const timing = summarizeTiming(timingPayload, runDirectory, timingFile)
const captureSummary = {
  path: relativePath(runDirectory, captureReportFile),
  sha256: captureHash,
  screenshot_path: relativePath(runDirectory, previewFile),
  screenshot_sha256: previewHash,
  capture_target: capture.capture_target,
  expected_css_size: capture.expected_css_size,
  expected_pixel_size: capture.expected_pixel_size,
  root_bbox: capture.root_bbox,
  document_ready: capture.document_ready,
  target_found: capture.target_found,
  target_size_matched: capture.target_size_matched,
  capture_clip_matches_target: capture.capture_clip_matches_target,
  fonts_loaded: capture.fonts_loaded,
  images_loaded: capture.images_loaded,
  loading_state_clear: capture.loading_state_clear,
  screenshot_not_blank: capture.screenshot_not_blank,
  console_error_count: capture.console_error_count,
  network_failure_count: (capture.network_failures ?? []).length,
  browser_shutdown: capture.browser_shutdown,
  machine_checks_passed: capture.machine_checks_passed,
  blocking_reasons: capture.blocking_reasons ?? [],
}
const diffSummary = {
  path: relativePath(runDirectory, visualDiffFile),
  sha256: visualDiffHash,
  reference_size: diffPrecheck.reference_size,
  preview_size: diffPrecheck.preview_size,
  scale: diffPrecheck.scale,
  capture_report_sha256: diffPrecheck.capture_report_sha256,
  actual_image_sha256: diffPrecheck.actual_image_sha256,
  capture_report_matches_actual: diffPrecheck.capture_report_matches_actual,
  machine_checks_passed: diffPrecheck.machine_checks_passed,
  default_interaction_state:
    diffPrecheck.external_assertions?.default_interaction_state_matches_reference,
  can_run_diff: diffPrecheck.can_run_diff,
  blocking_reasons: diffPrecheck.blocking_reasons ?? [],
}
const visualSummary = {
  path: relativePath(runDirectory, visualDiffFile),
  sha256: visualDiffHash,
  diff_image: relativePath(runDirectory, diffImageFile),
  threshold: visualDiff.threshold,
  accept_percent: visualDiff.accept_percent,
  section_accept_percent: visualDiff.section_accept_percent,
  overall_diff_percent: visualDiff.overall_diff_percent,
  pixel_match_percent: visualDiff.pixel_match_percent,
  section_diffs: visualDiff.section_diffs,
  can_accept: visualDiff.can_accept,
}

const inputArtifacts = [
  artifact(runDirectory, stage1File, 'stage_1_handoff'),
  ...(sectionsFile !== stage1File && !standaloneSectionsFile
    ? [artifact(runDirectory, sectionsFile, 'stage_1_sections_source')]
    : []),
  artifact(runDirectory, stage3File, 'stage_3_handoff'),
  artifact(runDirectory, manifestFile, 'asset_manifest'),
  artifact(runDirectory, referenceFile, 'figma_reference'),
  artifact(runDirectory, previewFile, 'stage_4_preview_screenshot'),
  artifact(runDirectory, captureReportFile, 'stage_4_capture_report'),
]
const outputArtifacts = [
  ...(standaloneSectionsFile
    ? [artifact(runDirectory, standaloneSectionsFile, 'sections')]
    : []),
  artifact(runDirectory, visualDiffFile, 'stage_4_visual_diff_report'),
  artifact(runDirectory, diffImageFile, 'stage_4_visual_diff_image'),
  artifact(runDirectory, auditsFile, 'stage_4_audits'),
  artifact(runDirectory, iterationsFile, 'stage_4_iteration_history'),
]
const activeArtifacts = unique([
  ...inputArtifacts.map((entry) => entry.path),
  ...outputArtifacts.map((entry) => entry.path),
  relativePath(runDirectory, outputFile),
])
const nextStatus = canDeliver ? 'complete' : 'stage_4_validating'
const workflowState = {
  ...sourceState,
  status: nextStatus,
  current_stage: 4,
  blocking_reasons: blockers,
  timing,
  timing_history: [
    ...(sourceState.timing_history ?? []),
    {
      stage: 4,
      status: canDeliver ? 'completed' : 'incomplete',
      duration_ms: timing.duration_ms,
      timing_status: timing.timing_status,
    },
  ],
  active_artifacts: activeArtifacts,
  invalidated_artifacts: unique(sourceState.invalidated_artifacts ?? []),
  transitions: [
    ...(sourceState.transitions ?? []),
    {
      from: sourceState.status,
      to: nextStatus,
      reason: canDeliver
        ? 'stage_4_machine_reports_and_acceptance_gates_passed'
        : 'stage_4_gate_incomplete',
      root_cause: 'stage_4_completion',
      trigger_report: relativePath(runDirectory, visualDiffFile),
      affected_scope: [],
      invalidated_artifacts: [],
      recovery_checks: ['capture_precheck', 'visual_diff', 'ten_audits', 'scores', 'regression'],
      timestamp: generatedAt,
    },
  ],
}

const handoff = {
  schema_version: 1,
  artifact_type: 'figma_to_code_stage_handoff',
  stage: 4,
  stage_name: 'acceptance',
  generated_at: generatedAt,
  workflow_state: workflowState,
  timing,
  input_artifacts: inputArtifacts,
  output_artifacts: outputArtifacts,
  handoff: {
    report_mode: reportMode,
    preview: {
      route_url: capture.url,
      route_path:
        stage3Handoff.preview?.route_path ??
        (capture.url?.startsWith('file://') ? new URL(capture.url).pathname : ''),
      capture_target: capture.capture_target,
      expected_css_size: capture.expected_css_size,
      default_interaction_state:
        assessment.default_interaction_state ?? {
          status:
            diffPrecheck.external_assertions?.default_interaction_state_matches_reference?.status,
          evidence:
            diffPrecheck.external_assertions?.default_interaction_state_matches_reference?.evidence ??
            [],
        },
    },
    capture_precheck: captureSummary,
    diff_precheck: diffSummary,
    visual_diff_report: visualSummary,
    machine_executable_audits: {
      path: relativePath(runDirectory, auditsFile),
      sha256: auditsHash,
      audit_count: AUDIT_KEYS.length,
      pass_count: AUDIT_KEYS.filter((key) => audits[key].status === 'pass').length,
      warn_count: AUDIT_KEYS.filter((key) => audits[key].status === 'warn').length,
      error_count: AUDIT_KEYS.filter((key) => audits[key].status === 'error').length,
    },
    audit_findings: {
      path: relativePath(runDirectory, auditsFile),
      sha256: auditsHash,
      count: auditFindings.length,
      open_error_count: auditFindings.filter(
        (finding) => finding.status === 'error' || finding.status === 'open',
      ).length,
    },
    restore_quality_score: {
      path: relativePath(runDirectory, auditsFile),
      sha256: auditsHash,
      overall_visual_match: baseScores.overall_visual_match,
      critical_scores_passed: keyBaseScores.every((score) => score >= 95),
    },
    enhanced_restore_quality_score: {
      path: relativePath(runDirectory, auditsFile),
      sha256: auditsHash,
      threshold_gates_passed: enhancedThresholdsPassed,
    },
    restore_fidelity: restoreFidelity,
    layout_mode: layoutMode,
    responsive_validation: responsiveValidation,
    iteration_history: {
      path: relativePath(runDirectory, iterationsFile),
      sha256: iterationsHash,
      iteration_count: iterationReport.iterations.length,
    },
    regression_errors: regressionErrors,
    fixable_gaps: fixableGaps,
    accepted_irreducible_risks: acceptedIrreducibleRisks,
    checks: [
      ...regressionChecks,
      {
        name: 'stage_4_report_generation',
        command: commandFor(options),
        exit_code: canDeliver ? 0 : 3,
        result: canDeliver ? 'pass' : 'fail',
      },
    ],
    blocking_reasons: blockers,
    can_deliver: canDeliver,
  },
}

writeJson(outputFile, handoff)
console.log(`[generate-stage4-report] mode: ${reportMode}`)
console.log(`[generate-stage4-report] audits: ${relativePath(runDirectory, auditsFile)}`)
console.log(`[generate-stage4-report] iterations: ${relativePath(runDirectory, iterationsFile)}`)
console.log(`[generate-stage4-report] handoff: ${relativePath(runDirectory, outputFile)}`)
console.log(`[generate-stage4-report] diff: ${visualDiff.overall_diff_percent}%`)
console.log(`[generate-stage4-report] restore_fidelity: ${fidelityPercent}%`)
console.log(`[generate-stage4-report] can_deliver: ${canDeliver}`)
if (!canDeliver) process.exitCode = 3
