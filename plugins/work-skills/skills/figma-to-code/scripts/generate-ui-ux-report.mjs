#!/usr/bin/env node
/** Generate the final human-readable UI/UX delivery report from machine evidence. */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const fail = message => { throw new Error(message) }
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const rel = (from, file) => path.relative(path.dirname(from), file) || path.basename(file)
const exists = file => Boolean(file && fs.existsSync(file))
const ref = (base, value) => {
  if (!value) return null
  const file = path.isAbsolute(value) ? value : path.resolve(base, value)
  return { file, display: file, exists: exists(file), hash: exists(file) && fs.statSync(file).isFile() ? sha256(file) : null }
}
const mdPath = (report, item) => item ? `\`${rel(report, item.file)}\`` : '`未提供`'
const esc = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
const bullet = (items, empty = '无') => items.length ? items.map(item => `- ${item}`).join('\n') : `- ${empty}`
const statusIcon = status => status === 'pass' ? '✅' : status === 'fail' ? '❌' : status === 'blocked' ? '⛔' : '⚠️'

function args(argv) {
  if (argv.includes('--help') || !argv.length) {
    console.log(`用法：\n  node generate-ui-ux-report.mjs \\\n    --contract <product-contract.json> \\\n    --results <functional-results.json> \\\n    --acceptance <product-acceptance.json> \\\n    --output <ui-ux-report.md>\n\n输出最终 UI/UX 交付报告；报告会明确视觉、功能、mock 数据、风险和证据路径。`)
    process.exit(0)
  }
  const result = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1]
    if (!['--contract', '--results', '--acceptance', '--output'].includes(key) || !value || result[key]) fail(`参数错误：${key}`)
    result[key] = path.resolve(value)
  }
  for (const key of ['--contract', '--results', '--acceptance', '--output']) if (!result[key]) fail(`缺少 ${key}`)
  return result
}

function stage4For(contractFile, screen) {
  const stage4 = path.resolve(path.dirname(contractFile), screen.run_dir, 'stage-4-handoff.json')
  if (!exists(stage4)) return { file: ref(path.dirname(contractFile), stage4), json: null }
  return { file: ref(path.dirname(contractFile), stage4), json: readJson(stage4) }
}
function stage3For(contractFile, screen) {
  const stage3 = path.resolve(path.dirname(contractFile), screen.run_dir, 'stage-3-handoff.json')
  if (!exists(stage3)) return { file: ref(path.dirname(contractFile), stage3), json: null }
  return { file: ref(path.dirname(contractFile), stage3), json: readJson(stage3) }
}
function previewRef(contractFile, screen, stage4, stage3) {
  const preview = stage4?.handoff?.preview || stage3?.handoff?.preview
  if (!preview) return null
  const candidates = [preview.path, preview.screenshot, preview.preview_path, preview.capture_path]
  for (const candidate of candidates) {
    const item = ref(path.dirname(contractFile), candidate)
    if (item?.exists) return item
  }
  return candidates[0] ? ref(path.dirname(contractFile), candidates[0]) : null
}

export function generateReport({ contractFile, resultsFile, acceptanceFile, outputFile }) {
  const contract = readJson(contractFile)
  const results = readJson(resultsFile)
  const acceptance = readJson(acceptanceFile)
  const base = path.dirname(contractFile)
  const contractHash = sha256(contractFile)
  if (results.contract_sha256 && results.contract_sha256 !== contractHash) fail('functional-results.json 不属于当前 product-contract.json')
  if (acceptance.contract_sha256 && acceptance.contract_sha256 !== contractHash) fail('product-acceptance.json 不属于当前 product-contract.json')
  const generatedAt = new Date().toISOString()
  const resultById = new Map((results.cases || []).map(item => [item.id, item]))
  const contractByCase = new Map((contract.cases || []).map(item => [item.id, item]))
  const passed = (results.cases || []).filter(item => item.status === 'pass')
  const failed = (results.cases || []).filter(item => item.status !== 'pass')
  const screens = (contract.screens || []).map(screen => {
    const stage4 = stage4For(contractFile, screen)
    const stage3 = stage3For(contractFile, screen)
    const visual = stage4.json?.handoff || {}
    const preview = previewRef(contractFile, screen, stage4.json, stage3.json)
    const changed = stage3.json?.handoff?.changed_files || []
    return { screen, stage4, stage3, visual, preview, changed }
  })
  const requirements = contract.requirements || []
  const implemented = requirements.filter(item => item.disposition === 'implement')
  const noops = requirements.filter(item => item.disposition === 'noop')
  const outOfScope = requirements.filter(item => item.disposition === 'out_of_scope')
  const clarify = requirements.filter(item => item.disposition === 'clarify')
  const blockers = acceptance.blocking_reasons || []
  const sources = (contract.sources || []).map(item => ref(base, item.path))
  const report = outputFile
  const lines = []
  lines.push('# UI UX 交付报告', '', `- 生成时间：${generatedAt}`, `- 产品标识：\`${esc(contract.product_id)}\``, `- 数据模式：\`${esc(contract.data_mode)}\``, `- 最终结论：${acceptance.can_deliver === true ? '✅ 功能与视觉验收通过，可交付' : '⚠️ 当前不可宣称完整交付'}`, '')
  lines.push('## 1. 交付目录与证据', '', `- 报告：\`${report}\``, `- 产品契约：${mdPath(report, ref(base, contractFile))}`, `- 功能结果：${mdPath(report, ref(base, resultsFile))}`, `- 产品聚合验收：${mdPath(report, ref(base, acceptanceFile))}`, `- 需求来源：${sources.map(item => mdPath(report, item)).join('、') || '`未提供`'}`, '')
  lines.push('## 2. 页面与路由', '', '| 页面 | 路由 | 设计稿 | 默认状态 | 视觉门禁 | 截图 |', '|---|---|---|---|---|---|')
  for (const item of screens) {
    const design = item.screen.design?.kind === 'figma' ? `Figma \`${item.screen.design.file_key}\`, node \`${item.screen.design.node_id}\`` : '截图输入'
    const visualPass = item.visual.can_deliver === true ? '✅ 通过' : '⚠️ 未通过/缺失'
    lines.push(`| ${esc(item.screen.id)} | \`${esc(item.screen.route)}\` | ${design} | ${esc(item.screen.default_state)} | ${visualPass} | ${item.preview ? mdPath(report, item.preview) : '`未生成`'} |`)
  }
  lines.push('', '## 3. 本期范围与实现状态', '', '### 已实现', bullet(implemented.map(item => `\`${item.id}\`：${item.behavior}`)), '', '### 明确无操作', bullet(noops.map(item => `\`${item.id}\`：${item.behavior}`)), '', '### 本期不做', bullet(outOfScope.map(item => `\`${item.id}\`：${item.behavior}`)), '', '### 待确认', bullet(clarify.map(item => `\`${item.id}\`：${item.behavior}`), '无；需求契约中没有未解决的 clarify 项'), '')
  lines.push('## 4. 核心流程与数据联动', '', bullet((contract.transitions || []).map(item => `\`${item.from || ''}\` → \`${item.to || ''}\`：${item.trigger || item.behavior || ''}${item.parameter ? `；参数：\`${item.parameter}\`` : ''}`), '契约未单独列出 transitions；请以 requirements 和功能用例为准'), '')
  lines.push('## 5. 功能验收', '', `- 测试环境：${esc(results.environment || '未记录')}`, `- 执行时间：${esc(results.executed_at || '未记录')}`, `- 用例总数：${(results.cases || []).length}`, `- 通过：${passed.length}`, `- 未通过/阻塞/未执行：${failed.length}`, '', '| 用例 | 类型 | 结果 | 实际结果 | 证据 |', '|---|---|---|---|---|')
  for (const planned of contract.cases || []) {
    const actual = resultById.get(planned.id)
    const evidence = (actual?.evidence || []).map(item => mdPath(report, ref(base, item.path))).join('、') || '`无`'
    lines.push(`| ${esc(planned.id)} | ${esc(planned.level)} | ${actual ? `${statusIcon(actual.status)} ${actual.status}` : '⚠️ 未覆盖'} | ${esc(actual?.actual || planned.then)} | ${evidence} |`)
  }
  lines.push('', '## 6. 截图与视觉验收', '')
  for (const item of screens) {
    lines.push(`### ${esc(item.screen.id)}`, '', `- Stage 3 截图：${item.preview ? mdPath(report, item.preview) : '`未生成`'}`, `- Stage 3 交接：${mdPath(report, item.stage3.file)}`, `- Stage 4 交接：${mdPath(report, item.stage4.file)}`, `- 视觉结论：${item.visual.can_deliver === true ? '通过' : '未通过或证据不完整'}`)
    const score = item.visual.restore_quality_score || item.visual.enhanced_restore_quality_score
    if (score) lines.push(`- 还原度：${esc(score.overall_visual_match ?? score.overall_percent ?? '未记录')}`)
    const risks = item.visual.accepted_irreducible_risks || item.visual.remaining_risks || []
    lines.push('- 当前视觉风险：', bullet(risks.map(risk => typeof risk === 'string' ? risk : `${risk.risk_type || risk.type || 'risk'}：${risk.reason || risk.description || JSON.stringify(risk)}`)))
    if (item.changed.length) lines.push('- 主要修改文件：', bullet(item.changed.map(file => typeof file === 'string' ? `\`${file}\`` : `\`${file.path || JSON.stringify(file)}\``)))
    lines.push('')
  }
  lines.push('## 7. 交付阻塞与剩余风险', '', bullet(blockers.map(item => `\`${item}\``)), '', '### 说明', '- 视觉验收失败不能被功能通过抵消。', '- mock 数据通过只代表本地可交互原型，不代表真实接口联调完成。', '- 报告中的路径和哈希以机器交接文件为事实来源；若代码、设计稿、需求契约或测试结果发生变化，应重新生成报告。', '')
  lines.push('## 8. 生成与复核命令', '', '```sh', `node <skill>/scripts/generate-ui-ux-report.mjs \\\n  --contract ${contractFile} \\\n  --results ${resultsFile} \\\n  --acceptance ${acceptanceFile} \\\n  --output ${outputFile}`, '```', '', `报告输入哈希：`, `- product-contract.json：\`${contractHash}\``, `- functional-results.json：\`${sha256(resultsFile)}\``, `- product-acceptance.json：\`${sha256(acceptanceFile)}\``, '')
  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  fs.writeFileSync(outputFile, lines.join('\n') + '\n', 'utf8')
  return { outputFile, canDeliver: acceptance.can_deliver === true, screens: screens.length, functionalTests: (results.cases || []).length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const a = args(process.argv.slice(2)); console.log(JSON.stringify(generateReport({ contractFile: a['--contract'], resultsFile: a['--results'], acceptanceFile: a['--acceptance'], outputFile: a['--output'] }))) }
  catch (error) { console.error(`[generate-ui-ux-report] ${error.message}`); process.exitCode = 1 }
}
