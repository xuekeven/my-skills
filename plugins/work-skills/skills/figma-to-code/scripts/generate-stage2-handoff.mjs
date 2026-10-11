#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { createArtifactTools } from './lib/artifacts.mjs'
import { createFail, parseOptionArgs } from './lib/cli.mjs'
import { createJsonTools } from './lib/json.mjs'
import { summarizeStageTiming } from './lib/timing.mjs'

const HELP = `
从第一阶段交接、补读报告、资产 manifest、QA 报告和计时文件确定性生成第二阶段交接。

用法：
  node generate-stage2-handoff.mjs \\
    --stage1 <stage-1-handoff.json> \\
    --manifest <run-dir>/asset-manifest.json \\
    --reread-report <run-dir>/reread-report.json \\
    --timing <run-dir>/timing.json \\
    --reference <run-dir>/figma-reference.png \\
    --output <delivery-root>/.figma-to-code/runs/<run-id>/stage-2-handoff.json \\
    [--state-output <run-dir>/state.json] \\
    [--contact-sheet <run-dir>/qa/stage-2-asset-contact-sheet.svg] \\
    [--attempt-log <run-dir>/diagnostics/stage-2-asset-attempts.json]

生成器会重新计算资产、QA 和 manifest 哈希，核对 run/frame 身份和 QA 门禁，并从
manifest 推导资产统计与 output_artifacts。workflow_state 已嵌入交接；只有兼容旧流程时
才传 --state-output 额外生成独立 state.json。
`

const fail = createFail('generate-stage2-handoff')
const { readJson, writeJson } = createJsonTools(fail)
const { artifact, hashFile, relativePath, requireFile, uniqueArtifacts } = createArtifactTools(fail)

function readArgs(argv) {
  return parseOptionArgs(
    argv,
    {
      help: HELP,
      fields: {
        '--stage1': 'stage1',
        '--manifest': 'manifest',
        '--reread-report': 'rereadReport',
        '--timing': 'timing',
        '--reference': 'reference',
        '--output': 'output',
        '--state-output': 'stateOutput',
        '--contact-sheet': 'contactSheet',
        '--attempt-log': 'attemptLog',
      },
      required: ['stage1', 'manifest', 'rereadReport', 'timing', 'reference', 'output'],
      defaults: {
        stage1: '',
        manifest: '',
        rereadReport: '',
        timing: '',
        reference: '',
        output: '',
        stateOutput: '',
        contactSheet: '',
        attemptLog: '',
      },
    },
    fail,
  )
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label} 不一致：${actual} !== ${expected}`)
}

function summarizeTiming(payload, runDirectory, timingFile) {
  return summarizeStageTiming(payload, {
    stage: 2,
    stageName: 'replenish_and_export',
    phases: ['rule_loading', 'targeted_reread', 'asset_export_qa', 'handoff_generation'],
    runDirectory,
    timingFile,
    relativePath,
    fail,
    allowRunning: false,
    requireRuleLoading: true,
  })
}

function qaEntryForAsset(report, assetId) {
  if (Array.isArray(report.asset_qa)) return report.asset_qa.find((entry) => entry.asset_id === assetId)
  if (Array.isArray(report.asset_qa?.assets)) {
    return report.asset_qa.assets.find((entry) => entry.asset_id === assetId)
  }
  return report.asset_qa
}

function allChecksPass(checks) {
  return checks && Object.values(checks).every((value) => value === true)
}

function visualQaStatus(asset, qa) {
  if (asset.visual_qa?.status) return asset.visual_qa.status
  if (qa.visual_qa?.status) return qa.visual_qa.status
  if (qa.visual_evidence?.result && qa.qa_status === 'pass') return 'pass'
  return 'missing'
}

function evidenceFiles(value, baseDirectory, output = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => evidenceFiles(item, baseDirectory, output))
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => evidenceFiles(item, baseDirectory, output))
  } else if (typeof value === 'string' && !path.isAbsolute(value)) {
    const candidate = path.resolve(baseDirectory, value)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) output.add(candidate)
  }
  return output
}

const options = readArgs(process.argv.slice(2))
const stage1File = requireFile(options.stage1, '第一阶段交接')
const manifestFile = requireFile(options.manifest, '资产 manifest')
const rereadFile = requireFile(options.rereadReport, '补读报告')
const timingFile = requireFile(options.timing, '计时文件')
const referenceFile = requireFile(options.reference, 'Figma 参考图')
const outputFile = path.resolve(options.output)
const stateFile = options.stateOutput ? path.resolve(options.stateOutput) : null
const runDirectory = path.dirname(outputFile)
const manifestDirectory = path.dirname(manifestFile)

const stage1 = readJson(stage1File, '第一阶段交接')
const manifestPayload = readJson(manifestFile, '资产 manifest')
const reread = readJson(rereadFile, '补读报告')
const timingPayload = readJson(timingFile, '计时文件')
const manifest = manifestPayload.asset_manifest
const sourceState = stage1.workflow_state
if (!manifest || !Array.isArray(manifest.assets)) fail('asset-manifest.json 缺少 asset_manifest.assets。')
if (!sourceState || sourceState.current_stage !== 1) fail('第一阶段交接缺少有效 workflow_state。')

assertEqual(manifest.run_id, sourceState.run_id, 'manifest.run_id')
assertEqual(manifest.frame_id, sourceState.frame_id, 'manifest.frame_id')
if (reread.run_id) assertEqual(reread.run_id, sourceState.run_id, 'reread.run_id')
if (reread.frame_identity?.frame_id) {
  assertEqual(reread.frame_identity.frame_id, sourceState.frame_id, 'reread.frame_identity.frame_id')
}
if (reread.frame_identity?.identity_changed) fail('补读报告显示 Frame 身份已经变化，必须回第一阶段。')

const qaSummaries = []
const outputArtifacts = [
  artifact(runDirectory, rereadFile, 'targeted_reread_report'),
  artifact(runDirectory, manifestFile, 'asset_manifest'),
]
const gateFailures = [...(manifest.blocking_reasons ?? []), ...(reread.blocking_reasons ?? [])]

for (const asset of manifest.assets) {
  if (!asset.asset_id || !asset.file || !asset.qa_report) fail('manifest 资产缺少 asset_id、file 或 qa_report。')
  const assetFile = requireFile(path.resolve(manifestDirectory, asset.file), `资产 ${asset.asset_id}`)
  const qaFile = requireFile(path.resolve(manifestDirectory, asset.qa_report), `QA 报告 ${asset.asset_id}`)
  const actualHash = hashFile(assetFile)
  if (actualHash !== asset.sha256) gateFailures.push(`${asset.asset_id}: manifest_hash_mismatch`)

  const qaReport = readJson(qaFile, `QA 报告 ${asset.asset_id}`)
  const qa = qaEntryForAsset(qaReport, asset.asset_id)
  if (!qa) fail(`QA 报告中找不到资产 ${asset.asset_id}。`)
  const expectedFormat = String(asset.format).toLowerCase()
  const actualFormat = path.extname(assetFile).slice(1).toLowerCase()
  if (actualFormat !== expectedFormat) gateFailures.push(`${asset.asset_id}: file_format_mismatch`)
  if (qa.format && qa.format !== expectedFormat) gateFailures.push(`${asset.asset_id}: qa_format_mismatch`)
  if (qa.sha256 !== actualHash) gateFailures.push(`${asset.asset_id}: qa_hash_mismatch`)
  const machineStatus = qa.machine_qa_status ?? qa.qa_status
  const visualStatus = visualQaStatus(asset, qa)
  const manifestChecksPass = allChecksPass(asset.qa)
  const passed =
    machineStatus === 'pass' && visualStatus === 'pass' && manifestChecksPass && asset.qa_status === 'pass'
  if (!passed) gateFailures.push(`${asset.asset_id}: asset_qa_not_passed`)

  qaSummaries.push({
    asset_id: asset.asset_id,
    machine_qa: machineStatus,
    visual_qa: visualStatus,
    qa_status: passed ? 'pass' : 'fail',
    qa_report: relativePath(runDirectory, qaFile),
  })
  outputArtifacts.push(artifact(runDirectory, assetFile, `${asset.format}_asset`))
  outputArtifacts.push(artifact(runDirectory, qaFile, 'asset_qa'))
}

if (options.contactSheet) {
  outputArtifacts.push(artifact(runDirectory, options.contactSheet, 'asset_contact_sheet'))
}
if (options.attemptLog) outputArtifacts.push(artifact(runDirectory, options.attemptLog, 'asset_attempt_log'))

const rounds = reread.rounds ?? reread.reread_rounds ?? []
const readiness =
  reread.readiness_after_reread ?? rounds.at(-1)?.readiness_after_round ?? stage1.handoff?.readiness_score?.total ?? 0
if (!Number.isFinite(readiness) || readiness < 90) gateFailures.push('readiness_below_90')
const blockingReasons = [...new Set(gateFailures)]
const canEnterStage3 = blockingReasons.length === 0
const timing = summarizeTiming(timingPayload, runDirectory, timingFile)
const generatedAt = new Date().toISOString()
const previousTransitions = sourceState.transitions ?? []
const nextStatus = canEnterStage3 ? 'stage_2_assets_ready' : sourceState.status
const invalidatedArtifacts = [...(sourceState.invalidated_artifacts ?? [])]

if (options.attemptLog) {
  const attempts = readJson(options.attemptLog, '资产尝试记录')
  invalidatedArtifacts.push(...(attempts.invalidated_artifacts ?? []))
}

const inputArtifacts = [
  artifact(runDirectory, stage1File, 'stage_1_handoff'),
  artifact(runDirectory, referenceFile, 'figma_reference'),
]
for (const evidenceFile of evidenceFiles(reread, path.dirname(rereadFile))) {
  const relativeToManifest = relativePath(manifestDirectory, evidenceFile)
  if (
    evidenceFile !== rereadFile &&
    !relativeToManifest.startsWith('assets/') &&
    !relativeToManifest.startsWith('asset-qa/') &&
    !relativeToManifest.startsWith('qa/')
  ) {
    inputArtifacts.push(artifact(runDirectory, evidenceFile, 'targeted_reread_source'))
  }
}

const activePaths = uniqueArtifacts([...inputArtifacts, ...outputArtifacts]).map((item) => item.path)
if (stateFile) activePaths.push(relativePath(runDirectory, stateFile))
activePaths.push(relativePath(runDirectory, outputFile))
const workflowState = {
  ...sourceState,
  status: nextStatus,
  current_stage: 2,
  identity_verified_at: reread.generated_at ?? generatedAt,
  generation_mode: canEnterStage3 ? (readiness >= 95 ? 'normal' : 'generate_with_risk') : sourceState.generation_mode,
  blocking_reasons: blockingReasons,
  timing,
  timing_history: [
    ...(sourceState.timing_history ?? []),
    { stage: 2, status: canEnterStage3 ? 'completed' : 'incomplete', duration_ms: timing.duration_ms, timing_status: timing.timing_status },
  ],
  active_artifacts: [...new Set(activePaths)],
  invalidated_artifacts: [...new Set(invalidatedArtifacts)],
  transitions: [
    ...previousTransitions,
    {
      from: sourceState.status,
      to: nextStatus,
      reason: canEnterStage3 ? 'stage_2_machine_and_visual_gates_passed' : 'stage_2_gate_incomplete',
      root_cause: 'stage_2_completion',
      trigger_report: relativePath(runDirectory, rereadFile),
      affected_scope: manifest.assets.map((asset) => asset.asset_id),
      invalidated_artifacts: [...new Set(invalidatedArtifacts)],
      recovery_checks: ['identity', 'targeted_reread', 'asset_machine_qa', 'asset_visual_qa', 'manifest_hashes'],
      timestamp: generatedAt,
    },
  ],
}

if (stateFile) {
  writeJson(stateFile, {
    schema_version: 1,
    artifact_type: 'figma_to_code_workflow_state',
    updated_at: generatedAt,
    workflow_state: workflowState,
  })
  outputArtifacts.splice(2, 0, artifact(runDirectory, stateFile, 'workflow_state'))
}

const resolvedFields = rounds.flatMap((round) => round.resolved_fields ?? [])
const fieldSourceConfidence =
  reread.field_source_confidence ?? resolvedFields.filter((field) => field && typeof field === 'object')
const designAnalysisUpdates =
  reread.design_analysis_updates ??
  fieldSourceConfidence.map((field) => ({
    field: field.field,
    previous: null,
    updated: field.value,
    source: field.source,
    confidence: field.confidence,
  }))
const normalizedRounds = rounds.map((round) => ({
  ...round,
  resolved_fields: (round.resolved_fields ?? []).map((field) =>
    field && typeof field === 'object' ? field.field : field,
  ),
}))
const manifestHash = hashFile(manifestFile)
const passCount = qaSummaries.filter((summary) => summary.qa_status === 'pass').length

const handoff = {
  schema_version: 1,
  artifact_type: 'figma_to_code_stage_handoff',
  stage: 2,
  stage_name: 'replenish_and_export',
  generated_at: generatedAt,
  workflow_state: workflowState,
  timing,
  input_artifacts: uniqueArtifacts(inputArtifacts),
  output_artifacts: uniqueArtifacts(outputArtifacts),
  handoff: {
    reread_rounds: normalizedRounds,
    field_source_confidence: fieldSourceConfidence,
    design_analysis_updates: designAnalysisUpdates,
    readiness_after_reread: readiness,
    classification_changes: reread.classification_changes ?? [],
    layout_mode: stage1.handoff?.layout_mode ?? stage1.layout_mode ?? 'fixed_only',
    responsive_plan: stage1.handoff?.responsive_plan ?? stage1.responsive_plan ?? null,
    responsive_plan_ready:
      (stage1.handoff?.layout_mode ?? stage1.layout_mode ?? 'fixed_only') === 'fixed_only'
        ? true
        : reread.responsive_plan_ready === true,
    responsive_reread_fields: reread.responsive_reread_fields ?? [],
    asset_manifest: {
      path: relativePath(runDirectory, manifestFile),
      sha256: manifestHash,
      asset_count: manifest.assets.length,
      qa_pass_count: passCount,
      qa_fail_count: manifest.assets.length - passCount,
    },
    asset_qa_summary: qaSummaries,
    remaining_risks: reread.remaining_risks ?? [],
    blocking_reasons: blockingReasons,
    can_enter_stage_3: canEnterStage3,
  },
}
writeJson(outputFile, handoff)

console.log(`[generate-stage2-handoff] generated ${relativePath(runDirectory, outputFile)}`)
console.log(`  assets: ${manifest.assets.length}, QA pass: ${passCount}, fail: ${manifest.assets.length - passCount}`)
console.log(`  can_enter_stage_3: ${canEnterStage3}`)
if (stateFile) console.log(`  legacy state: ${relativePath(runDirectory, stateFile)}`)
