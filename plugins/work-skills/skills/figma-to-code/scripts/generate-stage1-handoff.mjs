#!/usr/bin/env node

import path from 'node:path'
import process from 'node:process'

import { createArtifactTools } from './lib/artifacts.mjs'
import { createFail, parseBoolean, parseNonNegativeInteger, parseOptionArgs } from './lib/cli.mjs'
import { createJsonTools } from './lib/json.mjs'
import { summarizeStageTiming } from './lib/timing.mjs'

const HELP = `
从紧凑设计事实、Figma 参考图和计时文件确定性生成第一阶段交接。

用法：
  node generate-stage1-handoff.mjs --analysis <stage-1-input.json> --timing <timing.json>
    --reference <figma-reference.png> --output <stage-1-handoff.json>
    [--details <stage-1-analysis-details.json>]
    [--legacy-classification-mirrors true|false] [--max-compact-bytes <bytes>]

analysis 可以是仅包含第一阶段 handoff 字段的紧凑 JSON，也可以是已有完整交接。
compact 输入只需在 design_analysis.layer_hierarchy.coverage.classified_layer_ids_by_strategy
维护一次分类；生成器会派生计数、参考图哈希、公共外壳、workflow_state 和门禁。
新交接默认不复制顶层分类数组；只有旧消费者明确需要时才启用 legacy mirrors。
事实输入保留在 /tmp；只有 --details 指定的正式分析附件会进入 output_artifacts。
--max-compact-bytes 只控制非阻塞体积提示；超限不改变输出、退出码或阶段门禁，
也不要求压缩、拆附件或重新生成。
`

const fail = createFail('generate-stage1-handoff')
const { readJson, writeJson } = createJsonTools(fail)
const { artifact, hashFile, relativePath, requireFile } = createArtifactTools(fail)

function readArgs(argv) {
  return parseOptionArgs(
    argv,
    {
      help: HELP,
      fields: {
        '--analysis': 'analysis',
        '--timing': 'timing',
        '--reference': 'reference',
        '--output': 'output',
        '--details': 'details',
        '--legacy-classification-mirrors': 'legacyClassificationMirrors',
        '--max-compact-bytes': 'maxCompactBytes',
      },
      required: ['analysis', 'timing', 'reference', 'output'],
      defaults: {
        analysis: '',
        timing: '',
        reference: '',
        output: '',
        details: '',
        legacyClassificationMirrors: 'false',
        maxCompactBytes: '12288',
      },
    },
    fail,
  )
}

function unique(values) {
  return [...new Set(values)]
}

const CLASSIFICATION_FIELDS = [
  'real_text_layers',
  'code_css_layers',
  'svg_layers',
  'png_layers',
  'ignored_layers',
]

function sorted(values) {
  return [...values].sort()
}

function normalizeCompactClassifications(sourceHandoff, designAnalysis, legacyMirrors) {
  if (designAnalysis.task_meta?.report_profile !== 'compact') return
  const coverage = designAnalysis.layer_hierarchy?.coverage
  const classification = coverage?.classified_layer_ids_by_strategy
  if (!classification || typeof classification !== 'object' || Array.isArray(classification)) {
    fail('compact 设计事实缺少 coverage.classified_layer_ids_by_strategy。')
  }

  const allIds = []
  for (const field of CLASSIFICATION_FIELDS) {
    const ids = classification[field] ?? []
    if (!Array.isArray(ids)) fail(`classification.${field} 必须是数组。`)
    classification[field] = unique(ids)
    allIds.push(...classification[field])

    if (field in sourceHandoff) {
      const mirror = sourceHandoff[field]
      if (!Array.isArray(mirror)) fail(`handoff.${field} 必须是数组。`)
      if (JSON.stringify(sorted(mirror)) !== JSON.stringify(sorted(classification[field]))) {
        fail(`handoff.${field} 与规范分类索引不一致。`)
      }
      delete sourceHandoff[field]
    }
    if (legacyMirrors) sourceHandoff[field] = [...classification[field]]
  }

  const uniqueIds = unique(allIds)
  if (uniqueIds.length !== allIds.length) fail('classified_layer_ids_by_strategy 存在跨分类重复 ID。')
  const unknownRoleCount = Number(coverage.unknown_role_count ?? 0)
  if (!Number.isInteger(unknownRoleCount) || unknownRoleCount < 0) {
    fail('coverage.unknown_role_count 必须是非负整数。')
  }
  if (coverage.classified_visible !== undefined && coverage.classified_visible !== uniqueIds.length) {
    fail('coverage.classified_visible 与分类 ID 并集数量不一致。')
  }
  coverage.classified_visible = uniqueIds.length
  const totalVisible = uniqueIds.length + unknownRoleCount
  if (coverage.total_visible !== undefined && coverage.total_visible !== totalVisible) {
    fail('coverage.total_visible 与分类及未知角色数量不一致。')
  }
  coverage.total_visible = totalVisible
  coverage.unknown_role_count = unknownRoleCount
}

function summarizeTiming(payload, runDirectory, timingFile) {
  return summarizeStageTiming(payload, {
    stage: 1,
    stageName: 'read_and_plan',
    phases: ['rule_loading', 'design_read', 'handoff_generation'],
    runDirectory,
    timingFile,
    relativePath,
    fail,
  })
}

const options = readArgs(process.argv.slice(2))
const legacyClassificationMirrors = parseBoolean(
  options.legacyClassificationMirrors,
  '--legacy-classification-mirrors',
  fail,
)
const maxCompactBytes = parseNonNegativeInteger(
  options.maxCompactBytes,
  '--max-compact-bytes',
  fail,
)
const analysisFile = requireFile(options.analysis, '第一阶段设计事实')
const timingFile = requireFile(options.timing, '计时文件')
const referenceFile = requireFile(options.reference, 'Figma 参考图')
const detailsFile = options.details ? requireFile(options.details, '第一阶段分析附件') : null
const outputFile = path.resolve(options.output)
if (path.basename(outputFile) !== 'stage-1-handoff.json') {
  fail('--output 文件名必须是 stage-1-handoff.json。')
}

const runDirectory = path.dirname(outputFile)
const analysisPayload = readJson(analysisFile, '第一阶段设计事实')
const timingPayload = readJson(timingFile, '计时文件')
const sourceHandoff = structuredClone(
  analysisPayload.handoff ?? analysisPayload.stage_1_handoff ?? analysisPayload,
)
const sourceState = analysisPayload.workflow_state ?? {}
const designAnalysis = sourceHandoff.design_analysis
if (!designAnalysis || typeof designAnalysis !== 'object' || Array.isArray(designAnalysis)) {
  fail('设计事实缺少 handoff.design_analysis。')
}
for (const field of ['page_classification', 'readiness_score', 'targeted_reread_queue']) {
  if (!(field in sourceHandoff)) fail(`设计事实缺少 handoff.${field}。`)
}
normalizeCompactClassifications(sourceHandoff, designAnalysis, legacyClassificationMirrors)

const frameInfo = designAnalysis.frame_info ?? {}
const taskMeta = designAnalysis.task_meta ?? {}
const runId = sourceState.run_id ?? analysisPayload.run_id ?? taskMeta.run_id
if (typeof runId !== 'string' || !runId) fail('设计事实缺少 run_id。')
const frameWidth = Number(frameInfo.css_size?.width ?? frameInfo.width)
const frameHeight = Number(frameInfo.css_size?.height ?? frameInfo.height)
if (!Number.isFinite(frameWidth) || !Number.isFinite(frameHeight)) {
  fail('design_analysis.frame_info 缺少有效 Frame 宽高。')
}

const referenceHash = hashFile(referenceFile)
const blockingReasons = [...(sourceHandoff.blocking_reasons ?? [])]
if (!frameInfo.final_screenshot || typeof frameInfo.final_screenshot !== 'object') {
  blockingReasons.push('figma_reference_metadata_missing')
} else if (frameInfo.final_screenshot.sha256 && frameInfo.final_screenshot.sha256 !== referenceHash) {
  blockingReasons.push('figma_reference_hash_mismatch')
} else {
  frameInfo.final_screenshot.sha256 = referenceHash
  frameInfo.final_screenshot.path ??= relativePath(runDirectory, referenceFile)
}
const readiness = Number(sourceHandoff.readiness_score?.overall ?? 0)
if (!Number.isFinite(readiness) || readiness < 90) blockingReasons.push('readiness_below_90')
const normalizedBlockingReasons = unique(blockingReasons)
const requestedStage2Gate = sourceHandoff.can_enter_stage_2 ?? true
const canEnterStage2 =
  requestedStage2Gate === true && normalizedBlockingReasons.length === 0
const timing = summarizeTiming(timingPayload, runDirectory, timingFile)
const generatedAt = new Date().toISOString()

const inputArtifacts = [artifact(runDirectory, referenceFile, 'figma_reference')]
const outputArtifacts = [artifact(runDirectory, timingFile, 'workflow_timing')]
if (detailsFile) outputArtifacts.unshift(artifact(runDirectory, detailsFile, 'stage_1_analysis_details'))
const activeArtifacts = [...inputArtifacts, ...outputArtifacts].map((entry) => entry.path)
activeArtifacts.push(relativePath(runDirectory, outputFile))

const inputType =
  sourceState.input_type ??
  taskMeta.input_type ??
  (frameInfo.figma_file_key ? 'figma_node' : 'screenshot')
const nextStatus = canEnterStage2 ? 'stage_1_planned' : 'blocked'
const nextMode = canEnterStage2
  ? readiness >= 95
    ? 'normal'
    : 'generate_with_risk'
  : 'blocked'
const previousStatus = sourceState.status ?? 'initialized'
const transition = {
  from: previousStatus,
  to: nextStatus,
  reason: canEnterStage2
    ? 'frame_identity_and_read_plan_verified'
    : 'stage_1_gate_incomplete',
  root_cause: 'stage_1_completion',
  trigger_report: relativePath(runDirectory, outputFile),
  affected_scope: [frameInfo.frame_id ?? sourceState.frame_id].filter(Boolean),
  invalidated_artifacts: [],
  recovery_checks: ['frame_identity', 'final_visual', 'section_coverage', 'layer_classification'],
  timestamp: generatedAt,
}
const workflowState = {
  run_id: runId,
  status: nextStatus,
  current_stage: 1,
  input_type: inputType,
  figma_file_key: frameInfo.figma_file_key ?? sourceState.figma_file_key ?? '',
  frame_id: frameInfo.frame_id ?? sourceState.frame_id ?? '',
  frame_name: frameInfo.frame_name ?? sourceState.frame_name ?? '',
  frame_width: frameWidth,
  frame_height: frameHeight,
  source_image_sha256:
    inputType === 'screenshot'
      ? sourceState.source_image_sha256 ?? referenceHash
      : sourceState.source_image_sha256 ?? null,
  identity_verified_at:
    frameInfo.identity_verified_at ?? sourceState.identity_verified_at ?? generatedAt,
  generation_mode: nextMode,
  blocking_reasons: normalizedBlockingReasons,
  timing,
  timing_history: sourceState.timing_history ?? [],
  active_artifacts: unique(activeArtifacts),
  invalidated_artifacts: unique(sourceState.invalidated_artifacts ?? []),
  transitions: [...(sourceState.transitions ?? []), transition],
}

const handoff = {
  schema_version: 1,
  artifact_type: 'figma_to_code_stage_handoff',
  stage: 1,
  stage_name: 'read_and_plan',
  generated_at: generatedAt,
  workflow_state: workflowState,
  timing,
  input_artifacts: inputArtifacts,
  output_artifacts: outputArtifacts,
  handoff: {
    ...sourceHandoff,
    blocking_reasons: normalizedBlockingReasons,
    can_enter_stage_2: canEnterStage2,
  },
}
writeJson(outputFile, handoff)

const compactBytes = Buffer.byteLength(JSON.stringify(handoff))

console.log(`[generate-stage1-handoff] generated ${relativePath(runDirectory, outputFile)}`)
console.log(`  readiness: ${readiness}`)
console.log(`  can_enter_stage_2: ${canEnterStage2}`)
console.log(`  compact_bytes: ${compactBytes}`)
if (taskMeta.report_profile === 'compact' && maxCompactBytes > 0 && compactBytes > maxCompactBytes) {
  console.warn(
    `  warning: compact handoff is ${compactBytes} bytes (recommended maximum ${maxCompactBytes}); advisory only, no compaction or regeneration required.`,
  )
}
if (!canEnterStage2) process.exitCode = 3
