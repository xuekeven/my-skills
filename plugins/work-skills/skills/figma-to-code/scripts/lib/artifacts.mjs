import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function createArtifactTools(fail) {
  function requireFile(file, label) {
    const resolved = path.resolve(file)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      fail(`找不到${label}：${file}`)
    }
    return resolved
  }

  function hashFile(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  }

  function relativePath(fromDirectory, file) {
    return path.relative(fromDirectory, path.resolve(file)).split(path.sep).join('/') || path.basename(file)
  }

  function artifact(runDirectory, file, artifactType) {
    const resolved = requireFile(file, artifactType)
    return {
      artifact_type: artifactType,
      path: relativePath(runDirectory, resolved),
      sha256: hashFile(resolved),
      status: 'active',
    }
  }

  function uniqueArtifacts(artifacts) {
    const seen = new Set()
    return artifacts.filter((item) => {
      const key = `${item.artifact_type}:${item.path}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  return { artifact, hashFile, relativePath, requireFile, uniqueArtifacts }
}
