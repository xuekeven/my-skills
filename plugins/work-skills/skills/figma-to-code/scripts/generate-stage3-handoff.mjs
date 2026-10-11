#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { createArtifactTools } from './lib/artifacts.mjs'
import { createFail, parseOptionArgs } from './lib/cli.mjs'
import { createJsonTools } from './lib/json.mjs'
import { summarizeStageTiming } from './lib/timing.mjs'

const HELP = `
从 Stage 1/2、资产 manifest、实现摘要、浏览器捕获报告和计时文件确定性生成第三阶段交接。

用法：
  node generate-stage3-handoff.mjs \\
    --stage1 <stage-1-handoff.json> \\
    --stage2 <run-dir>/stage-2-handoff.json \\
    --manifest <run-dir>/asset-manifest.json \\
    --implementation <stage-3-implementation.json> \\
    --capture-report <run-dir>/stage-3-capture-report.json \\
    --timing <run-dir>/timing.json \\
    --output <run-dir>/stage-3-handoff.json \\
    [--delivery-root <交付根目录>]

implementation 可以是仅包含第三阶段 handoff 字段的紧凑 JSON，也可以是已有
stage-3-handoff.json。生成器自动计算文件哈希、校验资产与图层覆盖、合并浏览器证据、
推导 workflow_state 和 can_enter_stage_4，不手工维护公共外壳。
实现文件默认相对 run 目录解析；证据目录隐藏在交付根目录时传 --delivery-root，生成器
会从交付根定位 changed_files，并把交接路径统一规范为相对 run 目录。

退出码：0 表示门禁通过，3 表示已生成交接但第三阶段门禁未通过，1 表示输入或用法错误。
`

const fail = createFail('generate-stage3-handoff')
const { readJson, writeJson } = createJsonTools(fail)
const { artifact, hashFile, relativePath, requireFile, uniqueArtifacts } = createArtifactTools(fail)

function readArgs(argv) {
  return parseOptionArgs(
    argv,
    {
      help: HELP,
      fields: {
        '--stage1': 'stage1',
        '--stage2': 'stage2',
        '--manifest': 'manifest',
        '--implementation': 'implementation',
        '--capture-report': 'captureReport',
        '--timing': 'timing',
        '--output': 'output',
        '--delivery-root': 'deliveryRoot',
      },
      required: ['stage1', 'stage2', 'manifest', 'implementation', 'captureReport', 'timing', 'output'],
      defaults: {
        stage1: '',
        stage2: '',
        manifest: '',
        implementation: '',
        captureReport: '',
        timing: '',
        output: '',
        deliveryRoot: '',
      },
    },
    fail,
  )
}

function findReferencedFile(value, anchors) {
  if (!value || typeof value !== 'string') return null
  const candidates = path.isAbsolute(value)
    ? [value]
    : anchors.map((anchor) => path.resolve(anchor, value))
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null
}

function resolveReferencedFile(value, anchors, label) {
  if (!value || typeof value !== 'string') fail(`${label} 必须是非空路径。`)
  const found = findReferencedFile(value, anchors)
  if (!found) fail(`找不到${label}：${value}`)
  return found
}

function normalizeUrl(value) {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.href
  } catch {
    return value
  }
}

function expectedVisibleLayerIds(stage1) {
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
  if (!handoff) fail('Stage 1 缺少可用于覆盖复核的图层分类。')
  return [
    ...(handoff.real_text_layers ?? []),
    ...(handoff.code_css_layers ?? []),
    ...(handoff.svg_layers ?? []),
    ...(handoff.png_layers ?? []),
  ].map((item) => (typeof item === 'string' ? item : item.layer_id ?? item.id))
}

function mappedLayerIds(mapping) {
  const categories = ['real_text_layers', 'code_css_layers', 'svg_layers', 'png_layers']
  const result = []
  for (const category of categories) {
    if (!Array.isArray(mapping?.[category])) fail(`implementation_mapping.${category} 必须是数组。`)
    for (const item of mapping[category]) {
      if (typeof item === 'string') result.push(item)
      else if (item?.layer_id) result.push(item.layer_id)
      else if (Array.isArray(item?.layer_ids)) result.push(...item.layer_ids)
      else fail(`implementation_mapping.${category} 存在没有 layer_id/layer_ids 的条目。`)
    }
  }
  return result
}

function mappedAssetIds(mapping) {
  return ['svg_layers', 'png_layers'].flatMap((category) =>
    (mapping[category] ?? []).map((item) => item?.asset_id).filter(Boolean),
  )
}

function duplicateValues(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

function summarizeTiming(payload, runDirectory, timingFile) {
  return summarizeStageTiming(payload, {
    stage: 3,
    stageName: 'implement_design',
    phases: ['rule_loading', 'repo_analysis', 'implementation', 'verification', 'handoff_generation'],
    runDirectory,
    timingFile,
    relativePath,
    fail,
  })
}

function artifactTypeForFile(file) {
  const extension = path.extname(file).slice(1).toLowerCase()
  return extension ? `implementation_${extension}` : 'implementation_file'
}

function generatorCommand(options) {
  const parts = [
    'node',
    'scripts/generate-stage3-handoff.mjs',
    '--stage1',
    options.stage1,
    '--stage2',
    options.stage2,
    '--manifest',
    options.manifest,
    '--implementation',
    options.implementation,
    '--capture-report',
    options.captureReport,
    '--timing',
    options.timing,
    '--output',
    options.output,
  ]
  if (options.deliveryRoot) parts.push('--delivery-root', options.deliveryRoot)
  return parts.join(' ')
}

const options = readArgs(process.argv.slice(2))
const stage1File = requireFile(options.stage1, ' Stage 1 交接')
const stage2File = requireFile(options.stage2, ' Stage 2 交接')
const manifestFile = requireFile(options.manifest, '资产 manifest')
const implementationFile = requireFile(options.implementation, '第三阶段实现摘要')
const captureReportFile = requireFile(options.captureReport, '浏览器捕获报告')
const timingFile = requireFile(options.timing, '计时文件')
const outputFile = path.resolve(options.output)
if (path.basename(outputFile) !== 'stage-3-handoff.json') {
  fail('--output 文件名必须是 stage-3-handoff.json。')
}
const runDirectory = path.dirname(outputFile)
const deliveryRoot = options.deliveryRoot ? path.resolve(options.deliveryRoot) : runDirectory
if (
  options.deliveryRoot &&
  (!fs.existsSync(deliveryRoot) || !fs.statSync(deliveryRoot).isDirectory())
) {
  fail(`找不到交付根目录：${options.deliveryRoot}`)
}
const implementationDirectory = path.dirname(implementationFile)

const stage1 = readJson(stage1File, 'Stage 1 交接')
const stage2 = readJson(stage2File, 'Stage 2 交接')
const manifestPayload = readJson(manifestFile, '资产 manifest')
const implementationPayload = readJson(implementationFile, '第三阶段实现摘要')
const capturePayload = readJson(captureReportFile, '浏览器捕获报告')
const timingPayload = readJson(timingFile, '计时文件')
const implementation = implementationPayload.handoff ?? implementationPayload
const manifest = manifestPayload.asset_manifest
const capture = capturePayload.capture_precheck
const sourceState = stage2.workflow_state

if (!sourceState || stage2.stage !== 2 || sourceState.current_stage !== 2) {
  fail('Stage 2 交接缺少有效 workflow_state。')
}
if (!manifest || !Array.isArray(manifest.assets)) fail('asset-manifest.json 缺少 asset_manifest.assets。')
if (!capture || typeof capture !== 'object') fail('捕获报告缺少 capture_precheck。')
if (!implementation.preview || !implementation.implementation_mapping) {
  fail('实现摘要缺少 preview 或 implementation_mapping。')
}

const layoutMode =
  implementation.layout_mode ??
  stage2.handoff?.layout_mode ??
  stage1.handoff?.layout_mode ??
  'fixed_only'
const responsiveValidation = implementation.responsive_validation ?? {
  layout_mode: layoutMode,
  can_deliver: layoutMode === 'fixed_only',
  status: layoutMode === 'fixed_only' ? 'not_applicable' : 'missing',
  blocking_reasons: layoutMode === 'fixed_only' ? [] : ['responsive_validation_missing'],
}

const blockers = [...(implementation.blocking_reasons ?? [])]
const addBlocker = (reason) => {
  if (!blockers.includes(reason)) blockers.push(reason)
}
const internalCheckResults = new Map()
const recordInternalCheck = (name, passed, reason) => {
  internalCheckResults.set(name, { passed, reason })
  if (!passed) addBlocker(`${name}_error`)
}

const stage2GatePassed =
  sourceState.status === 'stage_2_assets_ready' &&
  stage2.handoff?.can_enter_stage_3 === true &&
  (sourceState.blocking_reasons ?? []).length === 0
recordInternalCheck('stage_2_gate', stage2GatePassed, stage2GatePassed ? 'Stage 2 门禁有效。' : 'Stage 2 门禁未通过。')

const identityPassed =
  manifest.run_id === sourceState.run_id &&
  manifest.frame_id === sourceState.frame_id &&
  stage1.workflow_state?.run_id === sourceState.run_id &&
  stage1.workflow_state?.frame_id === sourceState.frame_id
recordInternalCheck('frame_identity', identityPassed, identityPassed ? 'Stage 1/2 与 manifest 身份一致。' : '上游身份不一致。')
const responsiveGatePassed =
  layoutMode === 'fixed_only' ||
  (responsiveValidation &&
    typeof responsiveValidation === 'object' &&
    ['pending', 'in_progress', 'pass'].includes(responsiveValidation.status ?? 'pending'))
recordInternalCheck(
  'responsive_gate',
  responsiveGatePassed,
  responsiveGatePassed ? '响应式实现证据已就绪，最终适配门禁留给 Stage 4。' : '响应式实现证据未就绪。',
)

const manifestDirectory = path.dirname(manifestFile)
const manifestAssetsById = new Map()
const assetProblems = []
for (const asset of manifest.assets) {
  if (!asset.asset_id || manifestAssetsById.has(asset.asset_id)) {
    assetProblems.push(`invalid_or_duplicate_asset_id:${asset.asset_id ?? 'missing'}`)
    continue
  }
  manifestAssetsById.set(asset.asset_id, asset)
  const assetFile = resolveReferencedFile(asset.file, [manifestDirectory], `资产 ${asset.asset_id}`)
  const actualHash = hashFile(assetFile)
  if (actualHash !== asset.sha256) assetProblems.push(`${asset.asset_id}:hash_mismatch`)
  if (asset.qa_status !== 'pass') assetProblems.push(`${asset.asset_id}:qa_not_passed`)
}

const usedAssetIds = implementation.used_asset_ids ?? []
const duplicateAssetIds = duplicateValues(usedAssetIds)
const unknownAssetIds = usedAssetIds.filter((assetId) => !manifestAssetsById.has(assetId))
const omittedAssetIds = [...manifestAssetsById.keys()].filter((assetId) => !usedAssetIds.includes(assetId))
assetProblems.push(
  ...duplicateAssetIds.map((id) => `${id}:duplicate_use`),
  ...unknownAssetIds.map((id) => `${id}:not_in_manifest`),
  ...omittedAssetIds.map((id) => `${id}:not_used`),
)
recordInternalCheck(
  'asset_manifest',
  assetProblems.length === 0,
  assetProblems.length === 0 ? `${usedAssetIds.length} 个正式资产哈希、QA 与使用关系通过。` : assetProblems.join(', '),
)

const changedFiles = implementation.changed_files ?? []
const changedFilePaths = []
const missingChangedFiles = []
for (const file of changedFiles) {
  const resolved = findReferencedFile(file, [deliveryRoot, runDirectory, implementationDirectory])
  if (resolved) changedFilePaths.push(resolved)
  else missingChangedFiles.push(file)
}
const normalizedChangedFiles = changedFilePaths.map((file) => relativePath(runDirectory, file))
recordInternalCheck(
  'changed_files',
  changedFiles.length > 0 && missingChangedFiles.length === 0,
  missingChangedFiles.length === 0
    ? `${changedFiles.length} 个实现文件存在。`
    : `缺少实现文件：${missingChangedFiles.join(', ')}`,
)

const expectedLayerIds = expectedVisibleLayerIds(stage1).filter(Boolean)
const mappedIds = mappedLayerIds(implementation.implementation_mapping).filter(Boolean)
const mappingDuplicates = duplicateValues(mappedIds)
const missingLayerIds = expectedLayerIds.filter((id) => !mappedIds.includes(id))
const extraLayerIds = mappedIds.filter((id) => !expectedLayerIds.includes(id))
const assetMappingIds = mappedAssetIds(implementation.implementation_mapping)
const missingAssetMappings = usedAssetIds.filter((id) => !assetMappingIds.includes(id))
const duplicateAssetMappings = duplicateValues(assetMappingIds)
const mappingPassed =
  mappingDuplicates.length === 0 &&
  missingLayerIds.length === 0 &&
  extraLayerIds.length === 0 &&
  missingAssetMappings.length === 0 &&
  duplicateAssetMappings.length === 0
recordInternalCheck(
  'implementation_mapping',
  mappingPassed,
  mappingPassed
    ? `${mappedIds.length}/${expectedLayerIds.length} 个可见图层唯一映射，${usedAssetIds.length} 个资产均有落位。`
    : JSON.stringify({
        duplicate_layers: mappingDuplicates,
        missing_layers: missingLayerIds,
        extra_layers: extraLayerIds,
        missing_asset_mappings: missingAssetMappings,
        duplicate_asset_mappings: duplicateAssetMappings,
      }),
)

const expectedSize = implementation.preview.expected_css_size
const capturePassed =
  capture.machine_checks_passed === true &&
  normalizeUrl(capture.url) === normalizeUrl(implementation.preview.route_url) &&
  capture.capture_target === implementation.preview.capture_target &&
  capture.expected_css_size?.width === expectedSize?.width &&
  capture.expected_css_size?.height === expectedSize?.height &&
  (capture.runtime_exceptions ?? []).length === 0 &&
  (capture.console_error_count ?? 0) === 0 &&
  (capture.network_failures ?? []).length === 0
recordInternalCheck(
  'capture_precheck',
  capturePassed,
  capturePassed
    ? `捕获根唯一且为 ${expectedSize.width}x${expectedSize.height}，截图、网络和控制台通过。`
    : `捕获前置失败：${(capture.blocking_reasons ?? []).join(', ') || 'identity_or_runtime_mismatch'}`,
)

const screenshotFile = resolveReferencedFile(
  capture.screenshot_path,
  [path.dirname(captureReportFile), process.cwd()],
  '捕获截图',
)
if (capture.screenshot_sha256 && hashFile(screenshotFile) !== capture.screenshot_sha256) {
  recordInternalCheck('capture_screenshot_hash', false, '捕获截图 SHA-256 与报告不一致。')
} else {
  recordInternalCheck('capture_screenshot_hash', true, '捕获截图 SHA-256 与报告一致。')
}

const projectChecks = implementation.checks ?? []
if (!Array.isArray(projectChecks) || projectChecks.length === 0) {
  addBlocker('project_checks_missing_error')
}
for (const check of projectChecks) {
  if (!check?.name || !['pass', 'fail', 'not_applicable'].includes(check.result)) {
    addBlocker('project_check_schema_error')
  } else if (check.result === 'fail') {
    addBlocker(`project_check_failed:${check.name}`)
  } else if (check.result === 'not_applicable' && !check.reason) {
    addBlocker(`project_check_reason_missing:${check.name}`)
  }
}

const runtimeErrors = [
  ...(implementation.runtime_errors ?? []),
  ...(capture.runtime_exceptions ?? []).map((detail) => ({ type: 'runtime_exception', detail })),
  ...(capture.console_messages ?? [])
    .filter((message) => message.level === 'error')
    .map((message) => ({ type: 'console_error', detail: message.text })),
  ...(capture.network_failures ?? []).map((failure) => ({ type: 'network_error', detail: failure })),
]
if (runtimeErrors.length > 0) addBlocker('runtime_errors_present')

const knownRisks = [...(implementation.known_risks ?? [])]
const consoleWarnings = (capture.console_messages ?? []).filter((message) => message.level === 'warning')
if (consoleWarnings.length > 0) {
  knownRisks.push({
    type: 'browser_console_warning',
    severity: 'non_blocking',
    detail: consoleWarnings.map((message) => message.text),
  })
}

const timing = summarizeTiming(timingPayload, runDirectory, timingFile)
const generatedAt = new Date().toISOString()
const canEnterStage4 = blockers.length === 0
const command = generatorCommand(options)
const internalChecks = [...internalCheckResults.entries()].map(([name, result]) => ({
  name,
  command:
    name === 'capture_precheck' || name === 'capture_screenshot_hash'
      ? (capture.command_argv ?? []).join(' ') || command
      : command,
  exit_code: result.passed ? 0 : 3,
  result: result.passed ? 'pass' : 'fail',
  reason: result.reason,
}))
// Internal checks are the authoritative evidence for generated gates. Replace
// same-named entries from an older/full handoff so replaying that handoff does
// not preserve stale browser commands or duplicate results.
const checks = [
  ...projectChecks.filter((check) => !internalCheckResults.has(check?.name)),
  ...internalChecks,
]

const inputArtifacts = [
  artifact(runDirectory, stage1File, 'stage_1_handoff'),
  artifact(runDirectory, stage2File, 'stage_2_handoff'),
  artifact(runDirectory, manifestFile, 'asset_manifest'),
]
const outputArtifacts = [
  ...changedFilePaths.map((file) => artifact(runDirectory, file, artifactTypeForFile(file))),
  artifact(runDirectory, captureReportFile, 'capture_report'),
  artifact(runDirectory, screenshotFile, 'preview_screenshot'),
]
const activeArtifacts = uniqueArtifacts([...inputArtifacts, ...outputArtifacts]).map((item) => item.path)
activeArtifacts.push(relativePath(runDirectory, outputFile))

const nextStatus = canEnterStage4 ? 'stage_3_implemented' : sourceState.status
const workflowState = {
  ...sourceState,
  status: nextStatus,
  current_stage: 3,
  identity_verified_at: capture.captured_at ?? generatedAt,
  generation_mode: canEnterStage4 && knownRisks.length > 0 ? 'generate_with_risk' : sourceState.generation_mode,
  blocking_reasons: blockers,
  timing,
  timing_history: [
    ...(sourceState.timing_history ?? []),
    {
      stage: 3,
      status: canEnterStage4 ? 'completed' : 'incomplete',
      duration_ms: timing.duration_ms,
      timing_status: timing.timing_status,
    },
  ],
  active_artifacts: [...new Set(activeArtifacts)],
  invalidated_artifacts: [...new Set(sourceState.invalidated_artifacts ?? [])],
  transitions: [
    ...(sourceState.transitions ?? []),
    {
      from: sourceState.status,
      to: nextStatus,
      reason: canEnterStage4
        ? 'independent_preview_and_stage_3_checks_passed'
        : 'stage_3_gate_incomplete',
      root_cause: 'stage_3_completion',
      trigger_report: relativePath(runDirectory, captureReportFile),
      affected_scope: normalizedChangedFiles,
      invalidated_artifacts: [],
      recovery_checks: [
        'project_checks',
        'asset_manifest',
        'implementation_mapping',
        'capture_precheck',
      ],
      timestamp: generatedAt,
    },
  ],
}

const handoff = {
  schema_version: 1,
  artifact_type: 'figma_to_code_stage_handoff',
  stage: 3,
  stage_name: 'implement_design',
  generated_at: generatedAt,
  workflow_state: workflowState,
  timing,
  input_artifacts: uniqueArtifacts(inputArtifacts),
  output_artifacts: uniqueArtifacts(outputArtifacts),
  handoff: {
    preview: implementation.preview,
    changed_files: normalizedChangedFiles,
    used_asset_ids: usedAssetIds,
    implementation_mapping: implementation.implementation_mapping,
    capture_measurements: implementation.capture_measurements ?? {
      root: capture.root_bbox,
    },
    interactions: implementation.interactions ?? [],
    layout_mode: layoutMode,
    responsive_validation: responsiveValidation,
    checks,
    runtime_errors: runtimeErrors,
    known_risks: knownRisks,
    blocking_reasons: blockers,
    can_enter_stage_4: canEnterStage4,
  },
}

writeJson(outputFile, handoff)
console.log(`[generate-stage3-handoff] generated ${relativePath(runDirectory, outputFile)}`)
console.log(`  layers: ${mappedIds.length}/${expectedLayerIds.length}`)
console.log(`  assets: ${usedAssetIds.length}/${manifest.assets.length}`)
console.log(`  can_enter_stage_4: ${canEnterStage4}`)
if (!canEnterStage4) process.exitCode = 3
