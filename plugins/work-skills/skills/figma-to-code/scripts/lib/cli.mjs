import process from 'node:process'

export function createFail(prefix) {
  return (message, code = 1) => {
    console.error(`\n[${prefix}] ${message}\n`)
    process.exit(code)
  }
}

export function flagForField(field) {
  return `--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
}

export function parseBoolean(value, flag, fail) {
  if (!['true', 'false'].includes(value)) fail(`${flag} 必须是 true 或 false。`)
  return value === 'true'
}

export function parseNonNegativeInteger(value, flag, fail) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) fail(`${flag} 必须是非负整数。`)
  return parsed
}

export function parseOptionArgs(
  argv,
  { help, fields, required = [], defaults = {}, repeatable = [] },
  fail,
) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(help.trim())
    process.exit(0)
  }

  const options = { ...defaults }
  for (const field of repeatable) options[field] = [...(defaults[field] ?? [])]

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const field = fields[arg]
    if (!field) fail(`未知参数：${arg}。使用 --help 查看用法。`)
    const value = argv[++index]
    if (value === undefined) fail(`${arg} 缺少值。`)
    if (repeatable.includes(field)) options[field].push(value)
    else options[field] = value
  }

  for (const field of required) {
    if (options[field] === undefined || options[field] === null || options[field] === '') {
      fail(`缺少 ${flagForField(field)}。`)
    }
  }
  return options
}
