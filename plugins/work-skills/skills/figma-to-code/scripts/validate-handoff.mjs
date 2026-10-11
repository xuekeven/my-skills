#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { createArtifactTools } from './lib/artifacts.mjs'
import { createFail } from './lib/cli.mjs'
import { createJsonTools } from './lib/json.mjs'

const HELP = `
校验 figma-to-code 四阶段交接 JSON 的公共外壳和阶段必需字段。

用法：
  node validate-handoff.mjs --file <run-dir>/stage-N-handoff.json
`

const STAGES = {
  1: {
    file: 'stage-1-handoff.json',
    name: 'read_and_plan',
    gate: 'can_enter_stage_2',
    required: ['design_analysis', 'page_classification', 'readiness_score', 'targeted_reread_queue'],
  },
  2: {
    file: 'stage-2-handoff.json',
    name: 'replenish_and_export',
    gate: 'can_enter_stage_3',
    required: [
      'reread_rounds',
      'field_source_confidence',
      'design_analysis_updates',
      'asset_manifest',
      'asset_qa_summary',
    ],
  },
  3: {
    file: 'stage-3-handoff.json',
    name: 'implement_design',
    gate: 'can_enter_stage_4',
    required: [
      'preview',
      'changed_files',
      'used_asset_ids',
      'implementation_mapping',
      'checks',
      'runtime_errors',
    ],
  },
  4: {
    file: 'stage-4-handoff.json',
    name: 'acceptance',
    gate: 'can_deliver',
    required: [
      'preview',
      'capture_precheck',
      'diff_precheck',
      'visual_diff_report',
      'machine_executable_audits',
      'audit_findings',
      'restore_quality_score',
      'enhanced_restore_quality_score',
      'restore_fidelity',
      'iteration_history',
      'regression_errors',
      'fixable_gaps',
      'accepted_irreducible_risks',
    ],
  },
}

const STAGE_4_AUDIT_KEYS = [
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

const STAGE_4_BASE_SCORE_KEYS = [
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

const STAGE_4_ENHANCED_SCORE_KEYS = [
  'gradient_direction_accuracy',
  'gradient_border_sampling_accuracy',
  'title_underline_baseline_accuracy',
  'nested_blur_shape_completeness',
  'nested_effect_clip_accuracy',
  'text_segment_strategy_accuracy',
  'special_font_asset_accuracy',
  'mixed_text_alignment_accuracy',
]

const fail = createFail('handoff')
const { readJson } = createJsonTools(fail)
const { hashFile } = createArtifactTools(fail)

function readFileArgument(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP.trim())
    process.exit(0)
  }

  let file = ''
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--file') file = argv[++index]
    else fail(`未知参数：${arg}。使用 --help 查看用法。`)
  }
  if (!file) fail('缺少 --file。')
  return path.resolve(file)
}

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} 必须是对象。`)
  return value
}

function requireArray(value, field) {
  if (!Array.isArray(value)) fail(`${field} 必须是数组。`)
  return value
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value) fail(`${field} 必须是非空字符串。`)
  return value
}

function requireNumber(value, field) {
  if (!Number.isFinite(value)) fail(`${field} 必须是有限数值。`)
  return value
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) fail(`${message}：${actual} !== ${expected}`)
}

function validateArtifact(artifact, field) {
  requireObject(artifact, field)
  requireString(artifact.artifact_type, `${field}.artifact_type`)
  requireString(artifact.path, `${field}.path`)
  if (!['active', 'invalidated', 'missing'].includes(artifact.status)) {
    fail(`${field}.status 必须是 active、invalidated 或 missing。`)
  }
  if (artifact.status === 'active') requireString(artifact.sha256, `${field}.sha256`)
}

function resolveActiveArtifact(handoffFile, artifact, field) {
  if (artifact.status !== 'active') return null
  const resolved = path.resolve(path.dirname(handoffFile), artifact.path)
  if (!fs.existsSync(resolved)) fail(`${field} 引用的活动文件不存在：${artifact.path}`)
  assertEqual(hashFile(resolved), artifact.sha256, `${field} SHA-256 与文件不一致`)
  return resolved
}

function uniqueIdsByStrategy(classification) {
  const seen = new Map()
  for (const [strategy, ids] of Object.entries(classification)) {
    for (const id of requireArray(ids, `classification.${strategy}`)) {
      if (typeof id !== 'string' || !id) fail(`classification.${strategy} 含无效 ID。`)
      if (seen.has(id)) fail(`图层 ${id} 同时归入 ${seen.get(id)} 和 ${strategy}。`)
      seen.set(id, strategy)
    }
  }
  return seen
}

function validateStage1Sections(sections, frameHeight, classifiedIds, rootId) {
  if (sections.length === 0) fail('sections 不能为空。')
  const ordered = [...sections].sort((left, right) => left.y_start - right.y_start)
  assertEqual(ordered[0].y_start, 0, '第一个 section 必须从 y=0 开始')

  const sectionIds = new Set()
  for (let index = 0; index < ordered.length; index += 1) {
    const section = ordered[index]
    requireNumber(section.y_start, `sections[${index}].y_start`)
    requireNumber(section.y_end, `sections[${index}].y_end`)
    requireNumber(section.height, `sections[${index}].height`)
    assertEqual(section.y_end - section.y_start, section.height, `${section.section_name} 高度不一致`)
    if (index > 0) {
      assertEqual(section.y_start, ordered[index - 1].y_end, `${section.section_name} 与上一 section 不连续`)
    }
    for (const id of requireArray(section.included_layer_ids, `${section.section_name}.included_layer_ids`)) {
      if (sectionIds.has(id)) fail(`图层 ${id} 被多个 section 重复包含。`)
      sectionIds.add(id)
    }
  }
  assertEqual(ordered.at(-1).y_end, frameHeight, '最后一个 section 必须覆盖到 Frame 底部')

  const expectedSectionIds = [...classifiedIds].filter((id) => id !== rootId)
  const missing = expectedSectionIds.filter((id) => !sectionIds.has(id))
  const unknown = [...sectionIds].filter((id) => !classifiedIds.has(id))
  if (missing.length > 0) fail(`section 未覆盖分类图层：${missing.join(', ')}`)
  if (unknown.length > 0) fail(`section 包含未分类图层：${unknown.join(', ')}`)
}

function validateStage1Classifications(handoff, classification, mirrorsRequired) {
  const fields = [
    'real_text_layers',
    'code_css_layers',
    'svg_layers',
    'png_layers',
    'ignored_layers',
  ]
  const presentFields = fields.filter((field) => field in handoff)
  if (presentFields.length === 0 && !mirrorsRequired) return
  if (presentFields.length !== fields.length) {
    fail('Stage 1 顶层分类镜像必须全部存在或全部省略。')
  }
  for (const field of fields) {
    const expected = [...(classification[field] ?? [])].sort()
    const actual = [...requireArray(handoff[field], `handoff.${field}`)].sort()
    assertEqual(JSON.stringify(actual), JSON.stringify(expected), `${field} 与规范分类索引不一致`)
  }
}

function validateStage1Files(report, handoff) {
  const analysis = requireObject(handoff.design_analysis, 'handoff.design_analysis')
  const frame = requireObject(analysis.frame_info, 'handoff.design_analysis.frame_info')
  const hierarchy = requireObject(analysis.layer_hierarchy, 'handoff.design_analysis.layer_hierarchy')
  const coverage = requireObject(hierarchy.coverage, 'handoff.design_analysis.layer_hierarchy.coverage')
  const state = requireObject(report.workflow_state, 'workflow_state')
  const profile = analysis.task_meta?.report_profile
  const frameWidth = frame.css_size?.width ?? frame.width ?? frame.absolute_bbox?.width
  const frameHeight = frame.css_size?.height ?? frame.height ?? frame.absolute_bbox?.height

  assertEqual(state.frame_id, frame.frame_id, 'workflow_state.frame_id 与 frame_info 不一致')
  assertEqual(state.frame_width, frameWidth, 'workflow_state.frame_width 与 frame_info 不一致')
  assertEqual(state.frame_height, frameHeight, 'workflow_state.frame_height 与 frame_info 不一致')

  let classification
  if (profile === 'compact') {
    classification = requireObject(
      coverage.classified_layer_ids_by_strategy,
      'coverage.classified_layer_ids_by_strategy',
    )
  } else if (profile === 'full') {
    classification = requireObject(analysis.code_restore_plan, 'handoff.design_analysis.code_restore_plan')
  } else {
    fail(`未知 report_profile：${profile}`)
  }

  const classifiedIds = uniqueIdsByStrategy(classification)
  const totalVisible = requireNumber(coverage.total_visible, 'coverage.total_visible')
  const classifiedVisible = requireNumber(coverage.classified_visible, 'coverage.classified_visible')
  assertEqual(classifiedIds.size, classifiedVisible, '分类 ID 并集数量与 classified_visible 不一致')
  assertEqual(
    classifiedVisible + (coverage.unknown_role_count ?? 0),
    totalVisible,
    '分类和未知角色数量无法覆盖 total_visible',
  )

  if (profile === 'full') {
    const nodes = requireArray(hierarchy.nodes, 'handoff.design_analysis.layer_hierarchy.nodes')
    const nodeIds = new Set(nodes.map((node) => node.id))
    assertEqual(nodeIds.size, nodes.length, 'full nodes 存在重复 ID')
    assertEqual(nodeIds.size, totalVisible, 'full nodes 数量与 total_visible 不一致')
    const unclassifiedNodes = [...nodeIds].filter((id) => !classifiedIds.has(id))
    if (unclassifiedNodes.length > 0) fail(`full nodes 存在未分类图层：${unclassifiedNodes.join(', ')}`)
  }

  validateStage1Sections(
    requireArray(analysis.layout_structure?.sections, 'handoff.design_analysis.layout_structure.sections'),
    frameHeight,
    new Set(classifiedIds.keys()),
    hierarchy.root_id,
  )
  validateStage1Classifications(handoff, classification, profile === 'full')
}

function qaEntryForAsset(report, assetId) {
  if (Array.isArray(report.asset_qa)) return report.asset_qa.find((entry) => entry.asset_id === assetId)
  if (Array.isArray(report.asset_qa?.assets)) {
    return report.asset_qa.assets.find((entry) => entry.asset_id === assetId)
  }
  return report.asset_qa
}

function visualQaStatus(asset, qa) {
  if (asset.visual_qa?.status) return asset.visual_qa.status
  if (qa.visual_qa?.status) return qa.visual_qa.status
  if (qa.visual_evidence?.result && qa.qa_status === 'pass') return 'pass'
  return 'missing'
}

function validateStage2Files(file, report, handoff) {
  const manifestSummary = handoff.asset_manifest
  const manifestFile = path.resolve(path.dirname(file), manifestSummary.path)
  if (!fs.existsSync(manifestFile)) fail(`asset manifest 不存在：${manifestSummary.path}`)
  assertEqual(hashFile(manifestFile), manifestSummary.sha256, 'asset manifest SHA-256 与文件不一致')

  const manifestPayload = readJson(manifestFile)
  const manifest = requireObject(manifestPayload.asset_manifest, 'asset_manifest.asset_manifest')
  const assets = requireArray(manifest.assets, 'asset_manifest.assets')
  assertEqual(manifest.run_id, report.workflow_state.run_id, 'asset manifest run_id 与 workflow_state 不一致')
  assertEqual(manifest.frame_id, report.workflow_state.frame_id, 'asset manifest frame_id 与 workflow_state 不一致')
  assertEqual(assets.length, manifestSummary.asset_count, 'asset manifest 资产数量与摘要不一致')

  const summaryById = new Map()
  for (const [index, summary] of requireArray(handoff.asset_qa_summary, 'handoff.asset_qa_summary').entries()) {
    requireString(summary.asset_id, `handoff.asset_qa_summary[${index}].asset_id`)
    if (summaryById.has(summary.asset_id)) fail(`asset_qa_summary 重复资产：${summary.asset_id}`)
    summaryById.set(summary.asset_id, summary)
  }
  assertEqual(summaryById.size, assets.length, 'asset_qa_summary 数量与 manifest 不一致')

  const outputFiles = new Set(
    report.output_artifacts
      .filter((artifact) => artifact.status === 'active')
      .map((artifact) => path.resolve(path.dirname(file), artifact.path)),
  )
  let passCount = 0
  for (const [index, asset] of assets.entries()) {
    const field = `asset_manifest.assets[${index}]`
    requireString(asset.asset_id, `${field}.asset_id`)
    requireString(asset.file, `${field}.file`)
    requireString(asset.format, `${field}.format`)
    requireString(asset.sha256, `${field}.sha256`)
    requireString(asset.qa_report, `${field}.qa_report`)

    const assetFile = path.resolve(path.dirname(manifestFile), asset.file)
    const qaFile = path.resolve(path.dirname(manifestFile), asset.qa_report)
    if (!fs.existsSync(assetFile)) fail(`${field} 文件不存在：${asset.file}`)
    if (!fs.existsSync(qaFile)) fail(`${field} QA 报告不存在：${asset.qa_report}`)
    assertEqual(hashFile(assetFile), asset.sha256, `${field} SHA-256 与文件不一致`)
    if (!outputFiles.has(assetFile)) fail(`${field} 未列入 output_artifacts`)
    if (!outputFiles.has(qaFile)) fail(`${field} QA 报告未列入 output_artifacts`)

    const qaReport = readJson(qaFile)
    const qa = requireObject(qaEntryForAsset(qaReport, asset.asset_id), `${field}.qa`)
    assertEqual(qa.sha256, asset.sha256, `${field} QA SHA-256 与资产不一致`)
    if (qa.format) assertEqual(qa.format, asset.format, `${field} QA 格式与 manifest 不一致`)
    const machineStatus = qa.machine_qa_status ?? qa.qa_status
    const visualStatus = visualQaStatus(asset, qa)
    const manifestChecksPass =
      asset.qa && Object.values(asset.qa).length > 0 && Object.values(asset.qa).every((value) => value === true)
    const passed =
      machineStatus === 'pass' &&
      visualStatus === 'pass' &&
      manifestChecksPass &&
      asset.qa_status === 'pass'
    if (passed) passCount += 1

    const summary = summaryById.get(asset.asset_id)
    if (!summary) fail(`asset_qa_summary 缺少资产：${asset.asset_id}`)
    assertEqual(summary.machine_qa, machineStatus, `${field} machine_qa 摘要不一致`)
    assertEqual(summary.visual_qa, visualStatus, `${field} visual_qa 摘要不一致`)
    if (summary.qa_status) assertEqual(summary.qa_status, passed ? 'pass' : 'fail', `${field} qa_status 摘要不一致`)
  }

  assertEqual(passCount, manifestSummary.qa_pass_count, 'qa_pass_count 与逐资产门禁不一致')
  assertEqual(assets.length - passCount, manifestSummary.qa_fail_count, 'qa_fail_count 与逐资产门禁不一致')
  if (handoff.can_enter_stage_3 && (passCount !== assets.length || handoff.blocking_reasons.length > 0)) {
    fail('can_enter_stage_3=true，但仍有失败资产或 blocking_reasons。')
  }
}

function implementationLayerIds(mapping) {
  const result = []
  for (const category of ['real_text_layers', 'code_css_layers', 'svg_layers', 'png_layers']) {
    const entries = requireArray(mapping[category], `handoff.implementation_mapping.${category}`)
    for (const [index, entry] of entries.entries()) {
      if (typeof entry === 'string') result.push(entry)
      else if (entry?.layer_id) result.push(entry.layer_id)
      else if (Array.isArray(entry?.layer_ids)) result.push(...entry.layer_ids)
      else fail(`handoff.implementation_mapping.${category}[${index}] 缺少 layer_id/layer_ids。`)
    }
  }
  return result
}

function stage1VisibleLayerIds(stage1) {
  const designAnalysis =
    stage1.design_analysis ??
    stage1.handoff?.design_analysis ??
    stage1.stage_1_handoff?.design_analysis
  const classified =
    designAnalysis?.layer_hierarchy?.coverage?.classified_layer_ids_by_strategy
  if (classified) {
    return [
      ...(classified.real_text_layers ?? []),
      ...(classified.code_css_layers ?? []),
      ...(classified.svg_layers ?? []),
      ...(classified.png_layers ?? []),
    ]
  }
  const handoff = stage1.handoff ?? stage1.stage_1_handoff
  if (!handoff) fail('Stage 1 输入缺少可见图层分类。')
  return [
    ...(handoff.real_text_layers ?? []),
    ...(handoff.code_css_layers ?? []),
    ...(handoff.svg_layers ?? []),
    ...(handoff.png_layers ?? []),
  ].map((item) => (typeof item === 'string' ? item : item.layer_id ?? item.id))
}

function duplicateValues(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

function validateStage3Files(file, report, handoff) {
  const runDirectory = path.dirname(file)
  const stage1Artifact = report.input_artifacts.find((artifact) => artifact.artifact_type === 'stage_1_handoff')
  const manifestArtifact = report.input_artifacts.find((artifact) => artifact.artifact_type === 'asset_manifest')
  const captureArtifact = report.output_artifacts.find((artifact) => artifact.artifact_type === 'capture_report')
  const screenshotArtifact = report.output_artifacts.find(
    (artifact) => artifact.artifact_type === 'preview_screenshot',
  )
  if (!stage1Artifact) fail('Stage 3 input_artifacts 缺少 stage_1_handoff。')
  if (!manifestArtifact) fail('Stage 3 input_artifacts 缺少 asset_manifest。')
  if (!captureArtifact) fail('Stage 3 output_artifacts 缺少 capture_report。')
  if (!screenshotArtifact) fail('Stage 3 output_artifacts 缺少 preview_screenshot。')

  const stage1 = readJson(path.resolve(runDirectory, stage1Artifact.path))
  const manifestPayload = readJson(path.resolve(runDirectory, manifestArtifact.path))
  const capturePayload = readJson(path.resolve(runDirectory, captureArtifact.path))
  const manifest = requireObject(manifestPayload.asset_manifest, 'asset_manifest.asset_manifest')
  const assets = requireArray(manifest.assets, 'asset_manifest.assets')
  const capture = requireObject(capturePayload.capture_precheck, 'capture_report.capture_precheck')
  const preview = requireObject(handoff.preview, 'handoff.preview')
  const expectedSize = requireObject(preview.expected_css_size, 'handoff.preview.expected_css_size')

  assertEqual(manifest.run_id, report.workflow_state.run_id, 'asset manifest run_id 与 workflow_state 不一致')
  assertEqual(manifest.frame_id, report.workflow_state.frame_id, 'asset manifest frame_id 与 workflow_state 不一致')
  assertEqual(capture.url, preview.route_url, 'capture report URL 与 preview.route_url 不一致')
  assertEqual(
    capture.capture_target,
    preview.capture_target,
    'capture report selector 与 preview.capture_target 不一致',
  )
  assertEqual(
    capture.expected_css_size?.width,
    expectedSize.width,
    'capture report width 与 preview 不一致',
  )
  assertEqual(
    capture.expected_css_size?.height,
    expectedSize.height,
    'capture report height 与 preview 不一致',
  )
  assertEqual(
    capture.screenshot_sha256,
    screenshotArtifact.sha256,
    'capture report screenshot SHA-256 与 output_artifacts 不一致',
  )

  const changedFiles = requireArray(handoff.changed_files, 'handoff.changed_files')
  const outputPaths = new Set(
    report.output_artifacts
      .filter((artifact) => artifact.status === 'active')
      .map((artifact) => artifact.path),
  )
  for (const changedFile of changedFiles) {
    if (handoff.can_enter_stage_4 && !outputPaths.has(changedFile)) {
      fail(`changed_files 未列入 output_artifacts：${changedFile}`)
    }
  }

  const usedAssetIds = requireArray(handoff.used_asset_ids, 'handoff.used_asset_ids')
  const assetById = new Map(assets.map((asset) => [asset.asset_id, asset]))
  const duplicateAssetIds = duplicateValues(usedAssetIds)
  if (duplicateAssetIds.length > 0) fail(`used_asset_ids 重复：${duplicateAssetIds.join(', ')}`)
  for (const assetId of usedAssetIds) {
    const asset = assetById.get(assetId)
    if (!asset) fail(`used_asset_ids 不在 manifest：${assetId}`)
    if (asset.qa_status !== 'pass') fail(`used_asset_ids 对应资产 QA 未通过：${assetId}`)
    const assetFile = path.resolve(path.dirname(path.resolve(runDirectory, manifestArtifact.path)), asset.file)
    if (!fs.existsSync(assetFile)) fail(`used_asset_ids 对应资产不存在：${asset.file}`)
    assertEqual(hashFile(assetFile), asset.sha256, `used_asset_ids 对应资产哈希不一致：${assetId}`)
  }
  const omittedAssets = assets.map((asset) => asset.asset_id).filter((assetId) => !usedAssetIds.includes(assetId))
  if (handoff.can_enter_stage_4 && omittedAssets.length > 0) {
    fail(`manifest 正式资产未被使用：${omittedAssets.join(', ')}`)
  }

  const mapping = requireObject(handoff.implementation_mapping, 'handoff.implementation_mapping')
  const mappedIds = implementationLayerIds(mapping)
  const expectedIds = stage1VisibleLayerIds(stage1).filter(Boolean)
  const duplicateLayerIds = duplicateValues(mappedIds)
  const missingLayerIds = expectedIds.filter((id) => !mappedIds.includes(id))
  const extraLayerIds = mappedIds.filter((id) => !expectedIds.includes(id))
  if (handoff.can_enter_stage_4 && duplicateLayerIds.length > 0) {
    fail(`implementation_mapping 图层重复：${duplicateLayerIds.join(', ')}`)
  }
  if (handoff.can_enter_stage_4 && missingLayerIds.length > 0) {
    fail(`implementation_mapping 图层遗漏：${missingLayerIds.join(', ')}`)
  }
  if (handoff.can_enter_stage_4 && extraLayerIds.length > 0) {
    fail(`implementation_mapping 存在额外图层：${extraLayerIds.join(', ')}`)
  }

  const checks = requireArray(handoff.checks, 'handoff.checks')
  if (checks.length === 0) fail('handoff.checks 不能为空。')
  for (const [index, check] of checks.entries()) {
    requireObject(check, `handoff.checks[${index}]`)
    requireString(check.name, `handoff.checks[${index}].name`)
    if (!['pass', 'fail', 'not_applicable'].includes(check.result)) {
      fail(`handoff.checks[${index}].result 非法。`)
    }
    if (check.result === 'not_applicable' && !check.reason) {
      fail(`handoff.checks[${index}] 为 not_applicable 时必须提供 reason。`)
    }
  }

  const runtimeErrors = requireArray(handoff.runtime_errors, 'handoff.runtime_errors')
  if (
    handoff.can_enter_stage_4 &&
    (handoff.blocking_reasons.length > 0 ||
      runtimeErrors.length > 0 ||
      checks.some((check) => check.result === 'fail') ||
      capture.machine_checks_passed !== true ||
      (capture.console_error_count ?? 0) > 0 ||
      (capture.network_failures ?? []).length > 0)
  ) {
    fail('can_enter_stage_4=true，但仍有检查失败、运行错误、捕获错误或 blocking_reasons。')
  }
}

function findArtifact(report, artifactTypes, location = 'output_artifacts') {
  const accepted = new Set(artifactTypes)
  return report[location].find((artifact) => accepted.has(artifact.artifact_type))
}

function requireScoreKeys(scores, keys, field) {
  requireObject(scores, field)
  for (const key of keys) {
    if (!Number.isFinite(scores[key]) || scores[key] < 0 || scores[key] > 100) {
      fail(`${field}.${key} 必须是 0–100 的数字。`)
    }
  }
}

function validateStage4Files(file, report, handoff) {
  const runDirectory = path.dirname(file)
  const stage3Artifact = findArtifact(report, ['stage_3_handoff'], 'input_artifacts')
  const referenceArtifact = findArtifact(report, ['figma_reference'], 'input_artifacts')
  const previewArtifact = findArtifact(
    report,
    ['stage_4_preview_screenshot', 'preview_screenshot'],
    'input_artifacts',
  )
  const captureArtifact = findArtifact(
    report,
    ['stage_4_capture_report', 'capture_report'],
    'input_artifacts',
  )
  const visualDiffArtifact = findArtifact(report, [
    'stage_4_visual_diff_report',
    'visual_diff_report',
  ])
  const diffImageArtifact = findArtifact(report, [
    'stage_4_visual_diff_image',
    'visual_diff_image',
  ])
  const auditsArtifact = findArtifact(report, ['stage_4_audits'])
  const iterationsArtifact = findArtifact(report, [
    'stage_4_iteration_history',
    'iteration_history',
  ])
  for (const [artifact, label] of [
    [stage3Artifact, 'Stage 3 交接'],
    [referenceArtifact, 'Figma 参考图'],
    [previewArtifact, '第四阶段预览截图'],
    [captureArtifact, '第四阶段捕获报告'],
    [visualDiffArtifact, 'visual diff 报告'],
    [diffImageArtifact, 'diff 图'],
    [auditsArtifact, 'Stage 4 audits'],
    [iterationsArtifact, 'Stage 4 iteration history'],
  ]) {
    if (!artifact) fail(`Stage 4 缺少${label} artifact。`)
  }

  const stage3 = readJson(path.resolve(runDirectory, stage3Artifact.path))
  const capturePayload = readJson(path.resolve(runDirectory, captureArtifact.path))
  const visualDiffPayload = readJson(path.resolve(runDirectory, visualDiffArtifact.path))
  const auditReport = readJson(path.resolve(runDirectory, auditsArtifact.path))
  const iterationReport = readJson(path.resolve(runDirectory, iterationsArtifact.path))
  const capture = requireObject(capturePayload.capture_precheck, 'capture_report.capture_precheck')
  const diffPrecheck = requireObject(visualDiffPayload.diff_precheck, 'visual_diff.diff_precheck')
  const visualDiff = requireObject(
    visualDiffPayload.visual_diff_report,
    'visual_diff.visual_diff_report',
  )
  const audits = requireObject(
    auditReport.machine_executable_audits,
    'stage_4_audits.machine_executable_audits',
  )
  const findings = requireArray(auditReport.audit_findings, 'stage_4_audits.audit_findings')
  const baseScores = requireObject(
    auditReport.restore_quality_score,
    'stage_4_audits.restore_quality_score',
  )
  const enhancedScores = requireObject(
    auditReport.enhanced_restore_quality_score,
    'stage_4_audits.enhanced_restore_quality_score',
  )
  const fidelity = requireObject(
    auditReport.restore_fidelity,
    'stage_4_audits.restore_fidelity',
  )
  const regressionErrors = requireArray(
    iterationReport.regression_errors,
    'stage_4_iteration_history.regression_errors',
  )
  const iterations = requireArray(
    iterationReport.iterations,
    'stage_4_iteration_history.iterations',
  )

  if (stage3.handoff?.can_enter_stage_4 !== true) fail('Stage 3 输入门禁未通过。')
  assertEqual(
    stage3.workflow_state?.run_id,
    report.workflow_state.run_id,
    'Stage 3 run_id 与 Stage 4 不一致',
  )
  assertEqual(
    stage3.workflow_state?.frame_id,
    report.workflow_state.frame_id,
    'Stage 3 frame_id 与 Stage 4 不一致',
  )
  assertEqual(
    capture.screenshot_sha256,
    previewArtifact.sha256,
    '捕获报告截图 SHA-256 与 Stage 4 预览图不一致',
  )
  assertEqual(
    diffPrecheck.actual_image_sha256,
    previewArtifact.sha256,
    'diff actual SHA-256 与 Stage 4 预览图不一致',
  )
  assertEqual(
    diffPrecheck.capture_report_sha256,
    captureArtifact.sha256,
    'diff 捕获报告 SHA-256 与当前 Stage 4 报告不一致',
  )
  if (
    capture.machine_checks_passed !== true ||
    diffPrecheck.can_run_diff !== true ||
    diffPrecheck.external_assertions?.default_interaction_state_matches_reference?.status !==
      'pass'
  ) {
    if (handoff.can_deliver) fail('can_deliver=true，但捕获、diff 前置或默认态门禁未通过。')
  }

  const auditKeys = Object.keys(audits)
  const missingAuditKeys = STAGE_4_AUDIT_KEYS.filter((key) => !auditKeys.includes(key))
  if (missingAuditKeys.length > 0) fail(`Stage 4 audits 缺少：${missingAuditKeys.join(', ')}`)
  const auditErrors = STAGE_4_AUDIT_KEYS.filter((key) => audits[key]?.status === 'error')
  const invalidAuditStatuses = STAGE_4_AUDIT_KEYS.filter(
    (key) => !['pass', 'warn', 'error'].includes(audits[key]?.status),
  )
  if (invalidAuditStatuses.length > 0) {
    fail(`Stage 4 audit status 非法：${invalidAuditStatuses.join(', ')}`)
  }
  const auditPasses = STAGE_4_AUDIT_KEYS.filter((key) => audits[key].status === 'pass')
  const auditWarnings = STAGE_4_AUDIT_KEYS.filter((key) => audits[key].status === 'warn')

  requireScoreKeys(baseScores, STAGE_4_BASE_SCORE_KEYS, 'stage_4_audits.restore_quality_score')
  requireScoreKeys(
    enhancedScores,
    STAGE_4_ENHANCED_SCORE_KEYS,
    'stage_4_audits.enhanced_restore_quality_score',
  )
  assertEqual(visualDiff.threshold, 0.3, 'visual diff 必须使用固定颜色阈值 0.3')
  assertEqual(fidelity.diff_threshold_used, 0.3, 'restore_fidelity 必须记录固定颜色阈值 0.3')
  const expectedFidelity = Math.round(
    0.6 * (100 - visualDiff.overall_diff_percent) +
      0.4 * baseScores.overall_visual_match,
  )
  assertEqual(
    fidelity.overall_percent,
    expectedFidelity,
    'restore_fidelity 与固定公式不一致',
  )
  assertEqual(
    fidelity.pixel_match_percent,
    visualDiff.pixel_match_percent,
    'restore_fidelity pixel match 与 visual diff 不一致',
  )

  const openFindings = findings.filter(
    (finding) => finding.status === 'error' || finding.status === 'open',
  )
  const criticalScores = [
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
  const unresolved =
    visualDiff.can_accept !== true ||
    auditErrors.length > 0 ||
    openFindings.length > 0 ||
    criticalScores.some((score) => score < 95) ||
    !enhancedThresholdsPassed ||
    regressionErrors.length > 0 ||
    (auditReport.blocking_reasons ?? []).length > 0 ||
    fidelity.can_deliver !== true
  if (handoff.can_deliver && unresolved) {
    fail('can_deliver=true，但 audit、评分、finding、回归或 blocking 门禁未通过。')
  }

  const auditReference = handoff.machine_executable_audits
  if (auditReference?.path) {
    assertEqual(auditReference.path, auditsArtifact.path, 'handoff audit path 不一致')
    assertEqual(auditReference.sha256, auditsArtifact.sha256, 'handoff audit SHA-256 不一致')
    assertEqual(auditReference.audit_count, STAGE_4_AUDIT_KEYS.length, 'handoff audit 数量不一致')
    assertEqual(auditReference.pass_count, auditPasses.length, 'handoff audit pass 数量不一致')
    assertEqual(auditReference.warn_count, auditWarnings.length, 'handoff audit warn 数量不一致')
    assertEqual(auditReference.error_count, auditErrors.length, 'handoff audit error 数量不一致')
  }
  const iterationReference = handoff.iteration_history
  if (iterationReference?.path) {
    assertEqual(
      iterationReference.path,
      iterationsArtifact.path,
      'handoff iteration path 不一致',
    )
    assertEqual(
      iterationReference.sha256,
      iterationsArtifact.sha256,
      'handoff iteration SHA-256 不一致',
    )
    assertEqual(
      iterationReference.iteration_count,
      iterations.length,
      'handoff iteration 数量不一致',
    )
  }
  if (handoff.restore_quality_score?.path) {
    assertEqual(
      handoff.restore_quality_score.sha256,
      auditsArtifact.sha256,
      'handoff score SHA-256 不一致',
    )
    assertEqual(
      handoff.restore_quality_score.overall_visual_match,
      baseScores.overall_visual_match,
      'handoff overall_visual_match 不一致',
    )
  } else {
    assertEqual(
      handoff.restore_quality_score?.overall_visual_match,
      baseScores.overall_visual_match,
      'handoff detailed score 与 audit report 不一致',
    )
  }
  assertEqual(
    handoff.restore_fidelity?.overall_percent,
    fidelity.overall_percent,
    'handoff restore_fidelity 与 audit report 不一致',
  )
  assertEqual(
    handoff.visual_diff_report?.sha256,
    visualDiffArtifact.sha256,
    'handoff visual diff SHA-256 不一致',
  )
  assertEqual(
    handoff.visual_diff_report?.can_accept,
    visualDiff.can_accept,
    'handoff visual diff gate 不一致',
  )
  assertEqual(
    handoff.visual_diff_report?.threshold,
    0.3,
    'handoff visual diff 必须记录固定颜色阈值 0.3',
  )
  if (
    handoff.can_deliver &&
    ((handoff.regression_errors ?? []).length > 0 ||
      (handoff.blocking_reasons ?? []).length > 0)
  ) {
    fail('can_deliver=true，但 handoff 仍有 regression 或 blocking。')
  }
}

const file = readFileArgument(process.argv.slice(2))
const report = readJson(file)
const stage = report.stage
const contract = STAGES[stage]
if (!contract) fail(`stage 必须是 1–4，当前为 ${stage}。`)

assertEqual(path.basename(file), contract.file, '交接文件名错误')
assertEqual(report.schema_version, 1, 'schema_version 错误')
assertEqual(report.artifact_type, 'figma_to_code_stage_handoff', 'artifact_type 错误')
assertEqual(report.stage_name, contract.name, 'stage_name 错误')
requireString(report.generated_at, 'generated_at')
if (Number.isNaN(Date.parse(report.generated_at))) fail('generated_at 不是有效 ISO 时间。')

const state = requireObject(report.workflow_state, 'workflow_state')
assertEqual(state.current_stage, stage, 'workflow_state.current_stage 与 stage 不一致')
requireString(state.run_id, 'workflow_state.run_id')
requireArray(state.blocking_reasons, 'workflow_state.blocking_reasons')

const timing = requireObject(report.timing, 'timing')
assertEqual(timing.stage, stage, 'timing.stage 与 stage 不一致')
assertEqual(timing.stage_name, contract.name, 'timing.stage_name 与 stage_name 不一致')

for (const [field, artifacts] of [
  ['input_artifacts', requireArray(report.input_artifacts, 'input_artifacts')],
  ['output_artifacts', requireArray(report.output_artifacts, 'output_artifacts')],
]) {
  artifacts.forEach((artifact, index) => {
    validateArtifact(artifact, `${field}[${index}]`)
    resolveActiveArtifact(file, artifact, `${field}[${index}]`)
  })
}

const handoff = requireObject(report.handoff, 'handoff')
for (const field of contract.required) {
  if (!(field in handoff)) fail(`handoff 缺少 ${field}。`)
}
requireArray(handoff.blocking_reasons, 'handoff.blocking_reasons')
if (typeof handoff[contract.gate] !== 'boolean') fail(`handoff.${contract.gate} 必须是布尔值。`)

if (stage === 1) validateStage1Files(report, handoff)
if (stage === 2) {
  const manifest = requireObject(handoff.asset_manifest, 'handoff.asset_manifest')
  requireString(manifest.path, 'handoff.asset_manifest.path')
  requireString(manifest.sha256, 'handoff.asset_manifest.sha256')
  for (const field of ['asset_count', 'qa_pass_count', 'qa_fail_count']) {
    if (!Number.isInteger(manifest[field]) || manifest[field] < 0) {
      fail(`handoff.asset_manifest.${field} 必须是非负整数。`)
    }
  }
  assertEqual(
    manifest.qa_pass_count + manifest.qa_fail_count,
    manifest.asset_count,
    'asset manifest QA 统计不一致',
  )
  validateStage2Files(file, report, handoff)
}
if (stage === 3) validateStage3Files(file, report, handoff)
if (stage === 4) validateStage4Files(file, report, handoff)

console.log(`[handoff] valid stage ${stage}: ${contract.file}`)
