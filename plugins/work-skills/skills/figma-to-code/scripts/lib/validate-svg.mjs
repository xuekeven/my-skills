import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { Resvg } from '@resvg/resvg-js'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { PNG } from 'pngjs'

const GRAPHIC_TAGS = new Set([
  'circle',
  'ellipse',
  'image',
  'line',
  'path',
  'polygon',
  'polyline',
  'rect',
  'text',
  'use',
])
const NON_RENDERED_ANCESTORS = new Set(['clipPath', 'defs', 'mask', 'pattern', 'symbol'])

export function parseViewBoxValue(value) {
  const parts = String(value)
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  return parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0
    ? parts
    : null
}

function collectNodes(items, ancestors = [], output = []) {
  for (const item of items ?? []) {
    if (!item || typeof item !== 'object') continue
    for (const [tag, children] of Object.entries(item)) {
      if (tag === ':@' || tag === '#text' || tag === '?xml') continue
      const node = { tag, attrs: item[':@'] ?? {}, ancestors }
      output.push(node)
      if (Array.isArray(children)) collectNodes(children, [...ancestors, node], output)
    }
  }
  return output
}

function almostEqual(left, right) {
  return Math.abs(left - right) <= Math.max(0.001, Math.abs(right) * 0.00001)
}

function normalizedOpacity(value) {
  if (value === undefined) return 1
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 1
}

function isInsideNonRenderedContainer(node) {
  return node.ancestors.some((ancestor) => NON_RENDERED_ANCESTORS.has(ancestor.tag))
}

function referencedGradientIsOpaque(fill, nodesById) {
  const match = String(fill).match(/^url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)$/)
  if (!match) return null
  const gradient = nodesById.get(match[1])
  if (!gradient || !['linearGradient', 'radialGradient'].includes(gradient.tag)) return null
  const stops = gradient.descendants.filter((node) => node.tag === 'stop')
  return stops.length > 0 && stops.every((stop) => {
    const opacity = normalizedOpacity(stop.attrs['stop-opacity'])
    const color = String(stop.attrs['stop-color'] ?? 'black').toLowerCase()
    return opacity >= 0.999 && color !== 'none' && color !== 'transparent'
  })
}

function isOpaqueFullCanvasRect(node, viewBox, nodesById) {
  if (node.tag !== 'rect' || isInsideNonRenderedContainer(node)) return false
  if (node.attrs.rx !== undefined || node.attrs.ry !== undefined || node.attrs['clip-path']) return false

  const [viewX, viewY, viewWidth, viewHeight] = viewBox
  const x = Number(node.attrs.x ?? 0)
  const y = Number(node.attrs.y ?? 0)
  const width = node.attrs.width === '100%' ? viewWidth : Number(node.attrs.width)
  const height = node.attrs.height === '100%' ? viewHeight : Number(node.attrs.height)
  if (![x, y, width, height].every(Number.isFinite)) return false
  if (!(x <= viewX && y <= viewY && x + width >= viewX + viewWidth && y + height >= viewY + viewHeight)) {
    return false
  }

  const effectiveOpacity = [node, ...node.ancestors].reduce(
    (opacity, current) => opacity * normalizedOpacity(current.attrs.opacity),
    normalizedOpacity(node.attrs['fill-opacity']),
  )
  if (effectiveOpacity < 0.999) return false

  const fill = String(node.attrs.fill ?? 'black').trim().toLowerCase()
  if (fill === 'none' || fill === 'transparent') return false
  const gradientOpaque = referencedGradientIsOpaque(fill, nodesById)
  return gradientOpaque ?? true
}

function findReferences(nodes, sourceFile) {
  const fragmentReferences = []
  const externalReferences = []
  const missingLocalReferences = []
  const urlPattern = /url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/g

  for (const node of nodes) {
    for (const [name, rawValue] of Object.entries(node.attrs)) {
      const value = String(rawValue)
      for (const match of value.matchAll(urlPattern)) fragmentReferences.push(match[1])
      if (!['href', 'xlink:href'].includes(name)) continue
      if (value.startsWith('#')) fragmentReferences.push(value.slice(1))
      else if (/^(?:https?:)?\/\//i.test(value) || /^file:/i.test(value)) externalReferences.push(value)
      else if (!value.startsWith('data:')) {
        const localPath = path.resolve(path.dirname(sourceFile), value.split(/[?#]/, 1)[0])
        if (!fs.existsSync(localPath)) missingLocalReferences.push(value)
      }
    }
  }
  return { fragmentReferences, externalReferences, missingLocalReferences }
}

function rasterizeInProcess(source, scale) {
  try {
    const bytes = new Resvg(source, { fitTo: { mode: 'zoom', value: scale } }).render().asPng()
    const image = PNG.sync.read(bytes)
    let minimumAlpha = 255
    let maximumAlpha = 0
    let transparentPixels = 0
    let contentPixels = 0
    let boundaryNonclearPixels = 0

    const alphaAt = (x, y) => image.data[((image.width * y + x) << 2) + 3]
    for (let index = 3; index < image.data.length; index += 4) {
      const alpha = image.data[index]
      minimumAlpha = Math.min(minimumAlpha, alpha)
      maximumAlpha = Math.max(maximumAlpha, alpha)
      if (alpha < 255) transparentPixels += 1
      if (alpha > 0) contentPixels += 1
    }
    for (let x = 0; x < image.width; x += 1) {
      if (alphaAt(x, 0) > 0) boundaryNonclearPixels += 1
      if (image.height > 1 && alphaAt(x, image.height - 1) > 0) boundaryNonclearPixels += 1
    }
    for (let y = 1; y < image.height - 1; y += 1) {
      if (alphaAt(0, y) > 0) boundaryNonclearPixels += 1
      if (image.width > 1 && alphaAt(image.width - 1, y) > 0) boundaryNonclearPixels += 1
    }

    return {
      error: null,
      width: image.width,
      height: image.height,
      minimum_alpha: minimumAlpha,
      maximum_alpha: maximumAlpha,
      transparent_pixels: transparentPixels,
      content_pixels: contentPixels,
      boundary_nonclear_pixels: boundaryNonclearPixels,
    }
  } catch (error) {
    return { error: error.message }
  }
}

export function runInternalSvgRaster(file, scale) {
  return rasterizeInProcess(fs.readFileSync(file, 'utf8'), scale)
}

function rasterizeInChild(file, scale, entryFile) {
  const result = spawnSync(process.execPath, [entryFile, '--internal-svg-raster', file, String(scale)], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim().split('\n').at(-1)
    return { error: `隔离栅格化失败：${detail}` }
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    return { error: `无法解析隔离栅格化结果：${error.message}` }
  }
}

export async function validateSvgAsset(options, { fail, writeJson, entryFile }) {
  const sourceFile = path.resolve(options.file)
  if (!fs.existsSync(sourceFile)) fail(`找不到文件：${options.file}`)

  const bytes = fs.readFileSync(sourceFile)
  const source = bytes.toString('utf8').replace(/^\uFEFF/, '')
  const xmlValidation = XMLValidator.validate(source)
  let parsed = []
  if (xmlValidation === true) {
    try {
      parsed = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '',
        preserveOrder: true,
      }).parse(source)
    } catch {
      parsed = []
    }
  }

  const nodes = collectNodes(parsed)
  for (const node of nodes) {
    node.descendants = nodes.filter((candidate) => candidate.ancestors.includes(node))
  }
  const root = nodes.find((node) => node.tag === 'svg' && node.ancestors.length === 0)
  const actualViewBox = root?.attrs.viewBox ? parseViewBoxValue(root.attrs.viewBox) : null
  const ids = nodes.map((node) => node.attrs.id).filter(Boolean)
  const uniqueIds = new Set(ids)
  const nodesById = new Map(nodes.filter((node) => node.attrs.id).map((node) => [node.attrs.id, node]))
  const references = findReferences(nodes, sourceFile)
  const unresolvedReferences = references.fragmentReferences.filter((id) => !nodesById.has(id))
  const visibleGraphics = nodes.filter((node) => GRAPHIC_TAGS.has(node.tag) && !isInsideNonRenderedContainer(node))
  const fullCanvasOpaqueRects = actualViewBox
    ? nodes.filter((node) => isOpaqueFullCanvasRect(node, actualViewBox, nodesById))
    : []
  const rasterPrecheckPassed =
    xmlValidation === true &&
    Boolean(root) &&
    (!options.transparent || fullCanvasOpaqueRects.length === 0) &&
    references.externalReferences.length === 0 &&
    references.missingLocalReferences.length === 0 &&
    unresolvedReferences.length === 0 &&
    ids.length === uniqueIds.size &&
    !nodes.some((node) => ['foreignObject', 'script'].includes(node.tag))
  const raster = rasterPrecheckPassed
    ? rasterizeInChild(sourceFile, options.rasterScale, entryFile)
    : { error: '结构预检未通过，已跳过隔离栅格化。' }

  const structure = {
    path_count: nodes.filter((node) => node.tag === 'path').length,
    gradient_count: nodes.filter((node) => ['linearGradient', 'radialGradient'].includes(node.tag)).length,
    filter_count: nodes.filter((node) => node.tag === 'filter').length,
    mask_count: nodes.filter((node) => node.tag === 'mask').length,
    clip_path_count: nodes.filter((node) => node.tag === 'clipPath').length,
    visible_graphic_count: visibleGraphics.length,
  }
  const expected = options.expectedViewBox
  const dimensionsMatch =
    actualViewBox !== null && actualViewBox.every((value, index) => almostEqual(value, expected[index]))
  const checks = {
    xml_parse: xmlValidation === true && Boolean(root),
    raster_decode: raster.error === null,
    dimensions: dimensionsMatch,
    has_content: visibleGraphics.length > 0 && (raster.content_pixels ?? 0) > 0,
    alpha: options.transparent ? (raster.transparent_pixels ?? 0) > 0 : raster.minimum_alpha === 255,
    bounds: options.clearEdge ? raster.boundary_nonclear_pixels === 0 : true,
    native_transparency: options.transparent ? (raster.transparent_pixels ?? 0) > 0 : true,
    no_injected_background: options.transparent ? fullCanvasOpaqueRects.length === 0 : true,
    no_external_references: references.externalReferences.length === 0,
    all_references_resolved:
      unresolvedReferences.length === 0 && references.missingLocalReferences.length === 0,
    ids_unique: ids.length === uniqueIds.size,
    no_script_or_foreign_object: !nodes.some((node) => ['foreignObject', 'script'].includes(node.tag)),
    minimum_paths: structure.path_count >= options.minimums.path,
    minimum_gradients: structure.gradient_count >= options.minimums.gradient,
    minimum_filters: structure.filter_count >= options.minimums.filter,
    minimum_masks: structure.mask_count >= options.minimums.mask,
    minimum_clips: structure.clip_path_count >= options.minimums.clipPath,
    hash_recorded: true,
  }
  const qaStatus = Object.values(checks).every(Boolean) ? 'pass' : 'fail'
  writeJson(options.report, {
    asset_qa: {
      file: options.file,
      format: 'svg',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      expected_view_box: expected,
      actual_view_box: actualViewBox,
      transparent_required: options.transparent,
      clear_edge_required: options.clearEdge,
      raster_scale: options.rasterScale,
      minimum_structure: options.minimums,
      structure,
      raster_summary: raster,
      diagnostics: {
        xml_error: xmlValidation === true ? null : xmlValidation.err,
        opaque_full_canvas_rect_ids: fullCanvasOpaqueRects.map((node) => node.attrs.id ?? null),
        external_references: references.externalReferences,
        missing_local_references: references.missingLocalReferences,
        unresolved_fragment_references: [...new Set(unresolvedReferences)],
        duplicate_ids: [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))],
      },
      checks,
      machine_qa_status: qaStatus,
      qa_status: qaStatus,
    },
  })

  console.log(`\n[validate-asset:svg] ${qaStatus === 'pass' ? '通过' : '失败'}`)
  console.log(`  文件：${options.file}`)
  console.log(`  viewBox：${actualViewBox?.join(' ') ?? 'missing'}（期望 ${expected.join(' ')}）`)
  console.log(`  可见图形：${visibleGraphics.length}`)
  console.log(`  疑似整幅注入背景：${fullCanvasOpaqueRects.length}`)
  console.log(`  报告：${options.report}\n`)

  return qaStatus === 'pass' ? 0 : 2
}
