export function summarizeStageTiming(
  payload,
  {
    stage,
    stageName,
    phases,
    runDirectory,
    timingFile,
    relativePath,
    fail,
    allowRunning = true,
    requireRuleLoading = false,
  },
) {
  if (!Array.isArray(payload.events)) {
    if (payload.stage === stage && payload.stage_name === stageName) return payload
    fail(`timing.json 既不是原始 events，也不是第 ${stage} 阶段 timing 对象。`)
  }

  const now = Date.now()
  const durationOf = (event) =>
    Number.isFinite(event.duration_ms)
      ? event.duration_ms
      : Math.max(0, now - Number(event.started_at_epoch_ms ?? now))
  const isComplete = (event) => event.finished_at && Number.isFinite(event.duration_ms)
  const sourceEvents = allowRunning ? payload.events : payload.events.filter(isComplete)
  const stageScope = `stage:${stage}`
  const phasePrefix = `${stageScope}/phase:`
  const stageEvents = sourceEvents.filter((event) => event.scope === stageScope)
  const phaseEvents = sourceEvents.filter((event) => event.scope.startsWith(phasePrefix))
  if (stageEvents.length === 0) {
    fail(`timing.json 缺少${allowRunning ? '' : '已完成的'} ${stageScope} 计时。`)
  }

  const phaseDurations = {}
  const observedPhases = new Set()
  for (const event of phaseEvents) {
    const phase = event.scope.slice(phasePrefix.length)
    observedPhases.add(phase)
    phaseDurations[phase] = (phaseDurations[phase] ?? 0) + durationOf(event)
  }
  for (const phase of phases) phaseDurations[phase] ??= 0

  const completed = stageEvents.every(isComplete)
  const durationMs = stageEvents.reduce((total, event) => total + durationOf(event), 0)
  const measuredMs = Object.values(phaseDurations).reduce((total, value) => total + value, 0)
  const unclassifiedMs = Math.max(0, durationMs - measuredMs)
  const notes = []
  let timingStatus = completed ? 'complete' : 'partial'
  if (!completed) notes.push(`${stageScope} 仍在计时；阶段停止后重跑生成器以固化最终耗时。`)
  const missingPhases = phases.filter((phase) => !observedPhases.has(phase))
  if (missingPhases.length > 0) {
    timingStatus = 'partial'
    notes.push(`缺少实测 phase：${missingPhases.join(', ')}。`)
  }
  if (requireRuleLoading && phaseDurations.rule_loading === 0) {
    timingStatus = 'partial'
    notes.push('rule_loading 缺少实测记录。')
  }
  if (unclassifiedMs > 0) notes.push(`阶段有 ${unclassifiedMs}ms 未分类开销。`)

  const startedAt = [...stageEvents]
    .sort((left, right) => Number(left.started_at_epoch_ms) - Number(right.started_at_epoch_ms))[0]
    ?.started_at
  const finishedAt = completed
    ? [...stageEvents]
        .sort((left, right) => Number(right.finished_at_epoch_ms) - Number(left.finished_at_epoch_ms))[0]
        ?.finished_at
    : null

  return {
    measurement_method: 'workflow_timer',
    timing_status: timingStatus,
    timer_file: relativePath(runDirectory, timingFile),
    stage,
    stage_name: stageName,
    started_at: startedAt ?? null,
    finished_at: finishedAt ?? null,
    duration_ms: durationMs,
    phase_durations_ms: phaseDurations,
    excluded_wait_ms: 0,
    notes,
  }
}
