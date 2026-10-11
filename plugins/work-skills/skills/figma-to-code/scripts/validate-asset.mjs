#!/usr/bin/env node

import path from 'node:path'
import process from 'node:process'

import { createFail, parseBoolean, parseNonNegativeInteger } from './lib/cli.mjs'
import { createJsonTools } from './lib/json.mjs'
import { validatePngAsset } from './lib/validate-png.mjs'
import { parseViewBoxValue, runInternalSvgRaster, validateSvgAsset } from './lib/validate-svg.mjs'

const HELP = `
统一校验第二阶段导出的 PNG 或 SVG，并生成机器 QA 报告。

PNG 用法：
  node validate-asset.mjs \\
    --file hero@3x.png --report qa.json \\
    --css-width 116 --css-height 66 --scale 3 \\
    --transparent true --clear-edge true

SVG 用法：
  node validate-asset.mjs \\
    --file badge.svg --report qa.json \\
    --expected-view-box "0 0 80 80" \\
    --transparent true --clear-edge true

通用参数：
  --format auto|png|svg         默认按文件扩展名自动识别
  --file <path>                 待校验资产
  --report <path>               QA JSON 输出路径
  --transparent <bool>          是否要求透明像素/画布
  --clear-edge <bool>           是否要求画布边界透明

PNG 参数：
  --css-width <px>              CSS 画布宽度
  --css-height <px>             CSS 画布高度
  --scale <number>              导出倍率
  --edge-alpha-max <0-255>      允许的最大边界 alpha（默认：0）
  --near-white-min <0-255>      近白色 RGB 下限（默认：250）
  --max-opaque-near-white-percent <0-100>
                                允许的不透明近白色像素占比；用于拦截白色 matte

SVG 参数：
  --expected-view-box <x y w h> 期望 viewBox
  --min-paths <n>               最少 path 数（默认：0）
  --min-gradients <n>           最少 gradient 数（默认：0）
  --min-filters <n>             最少 filter 数（默认：0）
  --min-masks <n>               最少 mask 数（默认：0）
  --min-clips <n>               最少 clipPath 数（默认：0）
  --raster-scale <n>            内存栅格化倍率（默认：2）

依赖由 Skill 自身管理。退出码：0 通过，2 QA 失败，1 用法或依赖错误。
`

const fail = createFail('validate-asset')
const { writeJson } = createJsonTools(fail)

function parseExpectedViewBox(value) {
  const parsed = parseViewBoxValue(value)
  if (!parsed) fail('--expected-view-box 必须包含四个有限数值，且宽高为正数。')
  return parsed
}

function readArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP.trim())
    process.exit(0)
  }

  const options = {
    format: 'auto',
    file: '',
    report: '',
    transparent: null,
    clearEdge: null,
    cssWidth: NaN,
    cssHeight: NaN,
    scale: NaN,
    edgeAlphaMax: 0,
    nearWhiteMin: 250,
    maxOpaqueNearWhitePercent: null,
    expectedViewBox: null,
    rasterScale: 2,
    minimums: { path: 0, gradient: 0, filter: 0, mask: 0, clipPath: 0 },
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[++index]
    if (value === undefined) fail(`${arg} 缺少值。`)
    if (arg === '--format') options.format = value
    else if (arg === '--file') options.file = value
    else if (arg === '--report') options.report = value
    else if (arg === '--transparent') options.transparent = parseBoolean(value, '--transparent', fail)
    else if (arg === '--clear-edge') options.clearEdge = parseBoolean(value, '--clear-edge', fail)
    else if (arg === '--css-width') options.cssWidth = Number(value)
    else if (arg === '--css-height') options.cssHeight = Number(value)
    else if (arg === '--scale') options.scale = Number(value)
    else if (arg === '--edge-alpha-max') options.edgeAlphaMax = Number(value)
    else if (arg === '--near-white-min') options.nearWhiteMin = Number(value)
    else if (arg === '--max-opaque-near-white-percent') {
      options.maxOpaqueNearWhitePercent = Number(value)
    }
    else if (arg === '--expected-view-box') options.expectedViewBox = parseExpectedViewBox(value)
    else if (arg === '--min-paths') options.minimums.path = parseNonNegativeInteger(value, '--min-paths', fail)
    else if (arg === '--min-gradients') {
      options.minimums.gradient = parseNonNegativeInteger(value, '--min-gradients', fail)
    } else if (arg === '--min-filters') {
      options.minimums.filter = parseNonNegativeInteger(value, '--min-filters', fail)
    } else if (arg === '--min-masks') {
      options.minimums.mask = parseNonNegativeInteger(value, '--min-masks', fail)
    } else if (arg === '--min-clips') {
      options.minimums.clipPath = parseNonNegativeInteger(value, '--min-clips', fail)
    } else if (arg === '--raster-scale') options.rasterScale = Number(value)
    else fail(`未知参数：${arg}。使用 --help 查看用法。`)
  }

  if (!options.file) fail('缺少 --file。')
  if (!options.report) fail('缺少 --report。')
  if (options.transparent === null) fail('缺少 --transparent。')
  if (options.clearEdge === null) fail('缺少 --clear-edge。')

  const inferred = path.extname(options.file).slice(1).toLowerCase()
  if (options.format === 'auto') options.format = inferred
  if (!['png', 'svg'].includes(options.format)) fail('--format 必须是 auto、png 或 svg。')

  if (options.format === 'png') {
    for (const [key, flag] of [
      ['cssWidth', '--css-width'],
      ['cssHeight', '--css-height'],
      ['scale', '--scale'],
    ]) {
      if (!Number.isFinite(options[key]) || options[key] <= 0) fail(`${flag} 必须是正数。`)
    }
    if (!Number.isInteger(options.edgeAlphaMax) || options.edgeAlphaMax < 0 || options.edgeAlphaMax > 255) {
      fail('--edge-alpha-max 必须是 0 到 255 的整数。')
    }
    if (!Number.isInteger(options.nearWhiteMin) || options.nearWhiteMin < 0 || options.nearWhiteMin > 255) {
      fail('--near-white-min 必须是 0 到 255 的整数。')
    }
    if (
      options.maxOpaqueNearWhitePercent !== null &&
      (!Number.isFinite(options.maxOpaqueNearWhitePercent) ||
        options.maxOpaqueNearWhitePercent < 0 ||
        options.maxOpaqueNearWhitePercent > 100)
    ) {
      fail('--max-opaque-near-white-percent 必须是 0 到 100 的数值。')
    }
  } else {
    if (!options.expectedViewBox) fail('SVG 缺少 --expected-view-box。')
    if (!Number.isFinite(options.rasterScale) || options.rasterScale <= 0 || options.rasterScale > 8) {
      fail('--raster-scale 必须是大于 0 且不超过 8 的数值。')
    }
  }
  return options
}

if (process.argv[2] === '--internal-svg-raster') {
  const result = runInternalSvgRaster(process.argv[3], Number(process.argv[4]))
  process.stdout.write(JSON.stringify(result))
  process.exit(result.error ? 1 : 0)
}

const options = readArgs(process.argv.slice(2))
const exitCode = options.format === 'png'
  ? await validatePngAsset(options, { fail, writeJson })
  : await validateSvgAsset(options, { fail, writeJson, entryFile: process.argv[1] })
process.exit(exitCode)
