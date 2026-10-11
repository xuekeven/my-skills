import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const skillNodeModules = path.join(SKILL_ROOT, 'node_modules')
const requireFromSkill = createRequire(path.join(SKILL_ROOT, 'package.json'))

export async function loadSkillDependency(name) {
  let entry
  try {
    entry = requireFromSkill.resolve(name)
  } catch (error) {
    throw new Error(
      `Skill 依赖 ${name} 未安装。请在 ${SKILL_ROOT} 运行 npm ci；不要安装到目标仓库。`,
      { cause: error },
    )
  }

  const relativeEntry = path.relative(skillNodeModules, path.resolve(entry))
  if (relativeEntry.startsWith('..') || path.isAbsolute(relativeEntry)) {
    throw new Error(`Skill 依赖 ${name} 解析到了 Skill 外部；请在 ${SKILL_ROOT} 重新运行 npm ci。`)
  }

  try {
    return await import(pathToFileURL(entry).href)
  } catch (error) {
    throw new Error(`Skill 依赖 ${name} 无法加载；请在 ${SKILL_ROOT} 重新运行 npm ci。`, {
      cause: error,
    })
  }
}
