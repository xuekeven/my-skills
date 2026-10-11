#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { createFail } from './lib/cli.mjs'
import { createJsonTools } from './lib/json.mjs'

const HELP = `
初始化 figma-to-code 运行目录，并记录阶段/子阶段墙钟耗时。

用法：
  node workflow.mjs init --delivery-root <目录> --run-id <id>
  node workflow.mjs begin --file <timing.json> --run-id <id> --stage <1-4> --phase <phase>
  node workflow.mjs transition --file <timing.json> --stage <1-4>
    --from-phase <phase> --to-phase <phase>
  node workflow.mjs finish --file <timing.json> --stage <1-4> --phase <phase>
    [--status completed|paused|blocked]
  node workflow.mjs start --file <timing.json> --run-id <id> --scope <scope> [--label <text>]
  node workflow.mjs stop --file <timing.json> --scope <scope> [--status completed|paused|blocked]
  node workflow.mjs summary --file <timing.json>

init 输出 delivery_root、run_dir、qa_dir 和 diagnostics_dir 的绝对路径。
正常阶段优先使用 begin/transition/finish；它们自动生成规范 scope，并在单次原子更新中
同时切换阶段和 phase。start/stop 仅保留给暂停、恢复和旧调用方。
同一 scope 可以多次 start/stop；等待用户或审批前以 paused 停止，等待时间不计入活动耗时。
`

const fail = createFail('workflow')
const { readJson, writeJson } = createJsonTools(fail)

const STAGE_PHASES = {
  1: ['rule_loading', 'design_read', 'handoff_generation'],
  2: ['rule_loading', 'targeted_reread', 'asset_export_qa', 'handoff_generation'],
  3: ['rule_loading', 'repo_analysis', 'implementation', 'verification', 'handoff_generation'],
  4: ['rule_loading', 'capture_diff_audit', 'local_fix', 'regression', 'handoff_generation'],
}

const LOCK_TIMEOUT_MS = 10_000
const STALE_LOCK_MS = 30_000
const lockWaiter = new Int32Array(new SharedArrayBuffer(4))
let activeLock = null

function releaseActiveLock() {
  if (!activeLock) return
  try {
    fs.closeSync(activeLock.handle)
  } catch {}
  try {
    fs.unlinkSync(activeLock.file)
  } catch {}
  activeLock = null
}

process.on('exit', releaseActiveLock)

function validRunId(runId) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)
}

function readArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP.trim())
    process.exit(0)
  }

  const options = {
    command: argv[0],
    deliveryRoot: '',
    file: '',
    runId: '',
    scope: '',
    label: '',
    status: 'completed',
    stage: '',
    phase: '',
    fromPhase: '',
    toPhase: '',
  }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[++index]
    if (value === undefined) fail(`${arg} 缺少值。`)
    if (arg === '--delivery-root') options.deliveryRoot = value
    else if (arg === '--file') options.file = value
    else if (arg === '--run-id') options.runId = value
    else if (arg === '--scope') options.scope = value
    else if (arg === '--label') options.label = value
    else if (arg === '--status') options.status = value
    else if (arg === '--stage') options.stage = value
    else if (arg === '--phase') options.phase = value
    else if (arg === '--from-phase') options.fromPhase = value
    else if (arg === '--to-phase') options.toPhase = value
    else fail(`未知参数：${arg}。使用 --help 查看用法。`)
  }

  if (!['init', 'begin', 'transition', 'finish', 'start', 'stop', 'summary'].includes(options.command)) {
    fail(`未知命令：${options.command}。`)
  }
  if (options.command === 'init') {
    if (!options.deliveryRoot) fail('init 缺少 --delivery-root。')
    if (!options.runId) fail('init 缺少 --run-id。')
  } else if (options.command === 'start' || options.command === 'stop') {
    if (!options.file) fail(`${options.command} 缺少 --file。`)
    if (!options.scope) fail(`${options.command} 缺少 --scope。`)
  } else {
    if (!options.file) fail(`${options.command} 缺少 --file。`)
    if (options.command === 'begin') {
      if (!options.runId) fail('begin 缺少 --run-id。')
      requireStagePhase(options.stage, options.phase, 'begin')
    } else if (options.command === 'transition') {
      requireStagePhase(options.stage, options.fromPhase, 'transition --from-phase')
      requireStagePhase(options.stage, options.toPhase, 'transition --to-phase')
      if (options.fromPhase === options.toPhase) fail('transition 的 from-phase 和 to-phase 不能相同。')
    } else if (options.command === 'finish') {
      requireStagePhase(options.stage, options.phase, 'finish')
    }
  }
  if (options.runId && !validRunId(options.runId)) {
    fail('--run-id 只能包含 ASCII 字母、数字、点、下划线和连字符，且必须以字母或数字开头。')
  }
  if (!['completed', 'paused', 'blocked'].includes(options.status)) {
    fail('--status 必须是 completed、paused 或 blocked。')
  }
  return options
}

function stageNumber(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || !STAGE_PHASES[parsed]) fail(`无效 stage：${value}。`)
  return parsed
}

function requireStagePhase(stage, phase, label) {
  const parsedStage = stageNumber(stage)
  if (!phase) fail(`${label} 缺少 phase。`)
  if (!STAGE_PHASES[parsedStage].includes(phase)) {
    fail(`第 ${parsedStage} 阶段不支持 phase ${phase}；可用值：${STAGE_PHASES[parsedStage].join(', ')}`)
  }
}

function stageScope(stage) {
  return `stage:${stageNumber(stage)}`
}

function phaseScope(stage, phase) {
  requireStagePhase(stage, phase, 'phase')
  return `${stageScope(stage)}/phase:${phase}`
}

function initializeLayout(options) {
  const deliveryRoot = path.resolve(options.deliveryRoot)
  const runDirectory = path.join(deliveryRoot, '.figma-to-code', 'runs', options.runId)
  const qaDirectory = path.join(runDirectory, 'qa')
  const diagnosticsDirectory = path.join(runDirectory, 'diagnostics')

  for (const directory of [deliveryRoot, runDirectory, qaDirectory, diagnosticsDirectory]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  console.log(JSON.stringify({
    delivery_root: deliveryRoot,
    run_dir: runDirectory,
    qa_dir: qaDirectory,
    diagnostics_dir: diagnosticsDirectory,
  }, null, 2))
}

function loadState(file, runId, command) {
  if (!fs.existsSync(file)) {
    if (!['start', 'begin'].includes(command)) fail(`计时文件不存在：${file}`)
    if (!runId) fail('首次 start 必须提供 --run-id。')
    return { version: 1, run_id: runId, events: [] }
  }
  const state = readJson(file, '计时文件')
  if (runId && state.run_id !== runId) fail(`run_id 不一致：${state.run_id} !== ${runId}`)
  if (!Array.isArray(state.events)) fail('计时文件缺少 events 数组。')
  return state
}

function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lockFile = `${file}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS

  while (true) {
    try {
      const handle = fs.openSync(lockFile, 'wx', 0o600)
      fs.writeFileSync(handle, `${process.pid}\n`)
      activeLock = { file: lockFile, handle }
      return
    } catch (error) {
      if (error.code !== 'EEXIST') fail(`无法锁定计时文件：${error.message}`)
      try {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs
        if (age > STALE_LOCK_MS) {
          fs.unlinkSync(lockFile)
          continue
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue
        fail(`无法检查计时锁：${statError.message}`)
      }
      if (Date.now() >= deadline) fail(`等待计时文件锁超时：${lockFile}`)
      Atomics.wait(lockWaiter, 0, 0, 10)
    }
  }
}

function updateState(file, runId, command, updater) {
  acquireLock(file)
  try {
    const state = loadState(file, runId, command)
    updater(state)
    writeJson(file, state)
    return state
  } finally {
    releaseActiveLock()
  }
}

function now() {
  const epochMs = Date.now()
  return { epochMs, iso: new Date(epochMs).toISOString() }
}

function startScope(state, options) {
  const running = state.events.find((event) => event.scope === options.scope && !event.finished_at)
  if (running) fail(`scope 已在计时：${options.scope}`)
  const started = now()
  const occurrence = state.events.filter((event) => event.scope === options.scope).length + 1
  state.events.push({
    id: `${options.scope}#${occurrence}`,
    scope: options.scope,
    label: options.label || null,
    started_at: started.iso,
    started_at_epoch_ms: started.epochMs,
    finished_at: null,
    finished_at_epoch_ms: null,
    duration_ms: null,
    status: 'running',
  })
}

function stopScope(state, options) {
  const event = [...state.events]
    .reverse()
    .find((candidate) => candidate.scope === options.scope && !candidate.finished_at)
  if (!event) fail(`没有正在计时的 scope：${options.scope}`)
  const finished = now()
  event.finished_at = finished.iso
  event.finished_at_epoch_ms = finished.epochMs
  event.duration_ms = Math.max(0, finished.epochMs - event.started_at_epoch_ms)
  event.status = options.status
}

function summarize(state) {
  const scopes = {}
  for (const event of state.events) {
    const summary = scopes[event.scope] ?? {
      duration_ms: 0,
      occurrences: 0,
      completed_occurrences: 0,
      open_occurrences: 0,
      statuses: [],
    }
    summary.occurrences += 1
    if (event.duration_ms === null) summary.open_occurrences += 1
    else {
      summary.duration_ms += event.duration_ms
      summary.completed_occurrences += 1
    }
    summary.statuses.push(event.status)
    scopes[event.scope] = summary
  }

  const stages = {}
  for (const [scope, value] of Object.entries(scopes)) {
    const stageMatch = scope.match(/^stage:(\d+)$/)
    const phaseMatch = scope.match(/^stage:(\d+)\/phase:(.+)$/)
    if (stageMatch) {
      const stage = stages[stageMatch[1]] ?? { duration_ms: 0, phase_durations_ms: {} }
      stage.duration_ms = value.duration_ms
      stages[stageMatch[1]] = stage
    } else if (phaseMatch) {
      const stage = stages[phaseMatch[1]] ?? { duration_ms: 0, phase_durations_ms: {} }
      stage.phase_durations_ms[phaseMatch[2]] = value.duration_ms
      stages[phaseMatch[1]] = stage
    }
  }

  for (const stage of Object.values(stages)) {
    stage.measured_phase_ms = Object.values(stage.phase_durations_ms).reduce(
      (total, duration) => total + duration,
      0,
    )
    stage.unclassified_ms = Math.max(0, stage.duration_ms - stage.measured_phase_ms)
  }

  let timingStatus = state.events.some((event) => !event.finished_at) ? 'partial' : 'complete'
  for (const [stageId, stage] of Object.entries(stages)) {
    const expected = STAGE_PHASES[stageId] ?? []
    stage.missing_phases = expected.filter((phase) => !(phase in stage.phase_durations_ms))
    if (stage.missing_phases.length > 0) timingStatus = 'partial'
  }

  return {
    version: state.version,
    run_id: state.run_id,
    generated_at: new Date().toISOString(),
    timing_status: timingStatus,
    stages,
    scopes,
  }
}

const options = readArgs(process.argv.slice(2))
if (options.command === 'init') {
  initializeLayout(options)
} else {
  const file = path.resolve(options.file)
  if (options.command === 'begin') {
    const stage = stageNumber(options.stage)
    updateState(file, options.runId, options.command, (state) => {
      startScope(state, { scope: stageScope(stage), label: `Stage ${stage}` })
      startScope(state, { scope: phaseScope(stage, options.phase), label: options.phase })
    })
    console.log(`[workflow] began stage:${stage} with phase:${options.phase}`)
  } else if (options.command === 'transition') {
    const stage = stageNumber(options.stage)
    updateState(file, '', options.command, (state) => {
      stopScope(state, { scope: phaseScope(stage, options.fromPhase), status: 'completed' })
      startScope(state, { scope: phaseScope(stage, options.toPhase), label: options.toPhase })
    })
    console.log(`[workflow] transitioned stage:${stage} ${options.fromPhase} -> ${options.toPhase}`)
  } else if (options.command === 'finish') {
    const stage = stageNumber(options.stage)
    updateState(file, '', options.command, (state) => {
      stopScope(state, { scope: phaseScope(stage, options.phase), status: options.status })
      stopScope(state, { scope: stageScope(stage), status: options.status })
    })
    console.log(`[workflow] finished stage:${stage} at phase:${options.phase}`)
  } else if (options.command === 'start') {
    updateState(file, options.runId, options.command, (state) => startScope(state, options))
    console.log(`[workflow] started ${options.scope}`)
  } else if (options.command === 'stop') {
    updateState(file, options.runId, options.command, (state) => stopScope(state, options))
    console.log(`[workflow] stopped ${options.scope}`)
  } else {
    const state = loadState(file, options.runId, options.command)
    console.log(JSON.stringify(summarize(state), null, 2))
  }
}
