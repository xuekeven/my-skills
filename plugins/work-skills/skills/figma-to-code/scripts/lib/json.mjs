import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export function createJsonTools(fail) {
  function readJson(file, label = 'JSON 文件') {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      fail(`无法读取${label}：${error.message}`)
    }
  }

  function writeJson(file, value) {
    const resolved = path.resolve(file)
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    const temporary = `${resolved}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
    fs.renameSync(temporary, resolved)
  }

  return { readJson, writeJson }
}
