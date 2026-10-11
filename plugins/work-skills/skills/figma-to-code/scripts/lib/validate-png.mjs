import { createHash } from 'node:crypto'
import fs from 'node:fs'

import { loadSkillDependency } from './dependencies.mjs'

function countBoundaryPixels(image, alphaLimit) {
  let nonclear = 0
  const visit = (x, y) => {
    const alpha = image.data[((image.width * y + x) << 2) + 3]
    if (alpha > alphaLimit) nonclear += 1
  }

  for (let x = 0; x < image.width; x += 1) {
    visit(x, 0)
    if (image.height > 1) visit(x, image.height - 1)
  }
  for (let y = 1; y < image.height - 1; y += 1) {
    visit(0, y)
    if (image.width > 1) visit(image.width - 1, y)
  }
  return nonclear
}

export async function validatePngAsset(options, { fail, writeJson }) {
  if (!fs.existsSync(options.file)) fail(`找不到文件：${options.file}`)

  let PNG
  try {
    const module = await loadSkillDependency('pngjs')
    PNG = module.PNG || module.default?.PNG
  } catch (error) {
    fail(error.message)
  }
  if (!PNG) fail('pngjs 已加载，但没有提供 PNG 导出。')

  const bytes = fs.readFileSync(options.file)
  let image
  try {
    image = PNG.sync.read(bytes)
  } catch (error) {
    fail(`无法解码 PNG：${error.message}`)
  }

  const expectedWidth = Math.round(options.cssWidth * options.scale)
  const expectedHeight = Math.round(options.cssHeight * options.scale)
  let minimumAlpha = 255
  let maximumAlpha = 0
  let transparentPixels = 0
  let contentPixels = 0
  let opaqueNearWhitePixels = 0

  for (let index = 0; index < image.data.length; index += 4) {
    const alpha = image.data[index + 3]
    minimumAlpha = Math.min(minimumAlpha, alpha)
    maximumAlpha = Math.max(maximumAlpha, alpha)
    if (alpha < 255) transparentPixels += 1
    if (alpha > 0) contentPixels += 1
    if (
      alpha === 255 &&
      image.data[index] >= options.nearWhiteMin &&
      image.data[index + 1] >= options.nearWhiteMin &&
      image.data[index + 2] >= options.nearWhiteMin
    ) {
      opaqueNearWhitePixels += 1
    }
  }

  const boundaryNonclearPixels = countBoundaryPixels(image, options.edgeAlphaMax)
  const sourceRatio = options.cssWidth / options.cssHeight
  const exportedRatio = image.width / image.height
  const opaqueNearWhitePercent = (opaqueNearWhitePixels / (image.width * image.height)) * 100
  const checks = {
    decode: true,
    dimensions: image.width === expectedWidth && image.height === expectedHeight,
    has_content: contentPixels > 0,
    alpha: options.transparent
      ? transparentPixels > 0 && contentPixels > 0
      : minimumAlpha === 255,
    bounds: options.clearEdge ? boundaryNonclearPixels === 0 : true,
    ratio: Math.abs(exportedRatio - sourceRatio) / sourceRatio <= 0.005,
    opaque_near_white: options.maxOpaqueNearWhitePercent === null
      ? true
      : opaqueNearWhitePercent <= options.maxOpaqueNearWhitePercent,
  }
  const qaStatus = Object.values(checks).every(Boolean) ? 'pass' : 'fail'

  writeJson(options.report, {
    asset_qa: {
      file: options.file,
      format: 'png',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      expected_css_size: { width: options.cssWidth, height: options.cssHeight },
      scale: options.scale,
      expected_pixel_size: { width: expectedWidth, height: expectedHeight },
      actual_pixel_size: { width: image.width, height: image.height },
      transparent_required: options.transparent,
      clear_edge_required: options.clearEdge,
      edge_alpha_max: options.edgeAlphaMax,
      near_white_min: options.nearWhiteMin,
      max_opaque_near_white_percent: options.maxOpaqueNearWhitePercent,
      alpha_summary: {
        minimum: minimumAlpha,
        maximum: maximumAlpha,
        transparent_pixels: transparentPixels,
        content_pixels: contentPixels,
        boundary_nonclear_pixels: boundaryNonclearPixels,
        opaque_near_white_pixels: opaqueNearWhitePixels,
        opaque_near_white_percent: Number(opaqueNearWhitePercent.toFixed(3)),
      },
      checks,
      machine_qa_status: qaStatus,
      qa_status: qaStatus,
    },
  })

  console.log(`\n[validate-asset:png] ${qaStatus === 'pass' ? '通过' : '失败'}`)
  console.log(`  文件：${options.file}`)
  console.log(`  尺寸：${image.width}x${image.height}（期望 ${expectedWidth}x${expectedHeight}）`)
  console.log(`  透明像素：${transparentPixels}`)
  console.log(`  非透明边界像素：${boundaryNonclearPixels}`)
  console.log(`  不透明近白色像素：${opaqueNearWhitePixels}（${opaqueNearWhitePercent.toFixed(3)}%）`)
  console.log(`  报告：${options.report}\n`)

  return qaStatus === 'pass' ? 0 : 2
}
