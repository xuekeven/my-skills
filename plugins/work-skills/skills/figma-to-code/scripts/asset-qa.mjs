#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { createFail } from './lib/cli.mjs'
import { createJsonTools } from './lib/json.mjs'

const HELP = `
合并逐资产机器 QA，并从 manifest 生成单一视觉联系表。

用法：
  node asset-qa.mjs bundle \\
    --input <asset_id>=<qa-report.json> [--input ...] \\
    --output <run-dir>/qa/stage-2-asset-qa.json

  node asset-qa.mjs contact-sheet \\
    --manifest <run-dir>/asset-manifest.json \\
    --output <run-dir>/qa/stage-2-asset-contact-sheet.svg \\
    [--reference <run-dir>/figma-reference.png] [--columns 2]
`

const fail = createFail('asset-qa')
const { readJson, writeJson } = createJsonTools(fail)

function parseBundleArgs(argv) {
  const options = { inputs: [], output: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[++index]
    if (value === undefined) fail(`${arg} 缺少值。`)
    if (arg === '--input') options.inputs.push(value)
    else if (arg === '--output') options.output = value
    else fail(`未知参数：${arg}。使用 --help 查看用法。`)
  }
  if (options.inputs.length === 0) fail('bundle 至少需要一个 --input。')
  if (!options.output) fail('bundle 缺少 --output。')
  return options
}

function parseInput(value) {
  const separator = value?.indexOf('=') ?? -1
  if (separator <= 0 || separator === value.length - 1) {
    fail(`无效 --input：${value ?? ''}；应为 <asset_id>=<qa-report.json>。`)
  }
  const assetId = value.slice(0, separator).trim()
  const file = value.slice(separator + 1)
  if (!assetId || assetId.includes('/') || assetId.includes('\\')) {
    fail(`无效 asset_id：${assetId || '(empty)'}`)
  }
  const resolved = path.resolve(file)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    fail(`找不到 QA 报告：${file}`)
  }
  return { assetId, file: resolved }
}

function extractQa(payload, assetId, file) {
  let qa
  if (Array.isArray(payload.asset_qa)) {
    qa = payload.asset_qa.find((entry) => entry?.asset_id === assetId)
  } else if (Array.isArray(payload.asset_qa?.assets)) {
    qa = payload.asset_qa.assets.find((entry) => entry?.asset_id === assetId)
  } else {
    qa = payload.asset_qa
  }
  if (!qa || typeof qa !== 'object' || Array.isArray(qa)) {
    fail(`${file} 缺少资产 ${assetId} 的 asset_qa 对象。`)
  }
  if (typeof qa.sha256 !== 'string' || !qa.sha256) {
    fail(`${file} 的资产 ${assetId} 缺少 sha256。`)
  }
  const machineStatus = qa.machine_qa_status ?? qa.qa_status
  if (!['pass', 'fail'].includes(machineStatus) || !['pass', 'fail'].includes(qa.qa_status)) {
    fail(`${file} 的资产 ${assetId} 缺少有效 machine_qa_status/qa_status。`)
  }
  if (!qa.checks || typeof qa.checks !== 'object' || Array.isArray(qa.checks)) {
    fail(`${file} 的资产 ${assetId} 缺少 checks 对象。`)
  }
  return { ...qa, asset_id: assetId }
}

function bundle(options) {
  const parsedInputs = options.inputs.map(parseInput)
  const seen = new Set()
  const assetQa = parsedInputs.map(({ assetId, file }) => {
    if (seen.has(assetId)) fail(`重复 asset_id：${assetId}`)
    seen.add(assetId)
    return extractQa(readJson(file, ` QA 报告 ${assetId}`), assetId, file)
  })

  writeJson(options.output, {
    schema_version: 1,
    artifact_type: 'figma_to_code_asset_qa_bundle',
    generated_at: new Date().toISOString(),
    asset_qa: assetQa,
  })
  console.log(`[asset-qa] bundled ${assetQa.length} assets: ${path.resolve(options.output)}`)
}

function parseContactSheetArgs(argv) {
  const options = { manifest: '', output: '', reference: '', columns: 2 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[++index]
    if (value === undefined) fail(`${arg} 缺少值。`)
    if (arg === '--manifest') options.manifest = value
    else if (arg === '--output') options.output = value
    else if (arg === '--reference') options.reference = value
    else if (arg === '--columns') options.columns = Number(value)
    else fail(`未知参数：${arg}。使用 --help 查看用法。`)
  }
  if (!options.manifest) fail('contact-sheet 缺少 --manifest。')
  if (!options.output) fail('contact-sheet 缺少 --output。')
  if (!Number.isInteger(options.columns) || options.columns < 1 || options.columns > 4) {
    fail('--columns 必须是 1 到 4 的整数。')
  }
  return options
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function mediaType(file) {
  const types = {
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  }
  return types[path.extname(file).toLowerCase()] ?? null
}

function dataUri(file) {
  const type = mediaType(file)
  if (!type) fail(`不支持的资产格式：${file}`)
  return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`
}

function assetDimensions(asset) {
  const bounds = asset.export_canvas_bounds ?? asset.visual_bounds ?? asset.logical_bounds
  const width = Number(bounds?.width ?? asset.pixel_size?.width ?? 1)
  const height = Number(bounds?.height ?? asset.pixel_size?.height ?? 1)
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1,
    height: Number.isFinite(height) && height > 0 ? height : 1,
  }
}

function contactSheet(options) {
  const manifestFile = path.resolve(options.manifest)
  const manifestDir = path.dirname(manifestFile)
  const payload = readJson(manifestFile, ' asset manifest')
  const manifest = payload.asset_manifest
  if (!manifest || !Array.isArray(manifest.assets)) fail('manifest 缺少 asset_manifest.assets。')

  const assets = manifest.assets.map((asset) => {
    const file = path.resolve(manifestDir, asset.file)
    if (!fs.existsSync(file)) fail(`找不到资产：${asset.file}`)
    return { asset, uri: dataUri(file), dimensions: assetDimensions(asset) }
  })

  const outer = 24
  const gap = 16
  const cardWidth = 448
  const cardHeight = 250
  const titleHeight = 54
  const previewY = titleHeight + 16
  const previewHeight = 148
  const previewGap = 8
  const previewWidth = (cardWidth - 32 - previewGap * 2) / 3
  const rowCount = Math.ceil(assets.length / options.columns)
  const sheetWidth = outer * 2 + options.columns * cardWidth + (options.columns - 1) * gap
  let referenceHeight = 0
  let reference = null

  if (options.reference) {
    const referenceFile = path.resolve(options.reference)
    if (!fs.existsSync(referenceFile)) fail(`找不到参考图：${options.reference}`)
    reference = dataUri(referenceFile)
    referenceHeight = 330
  }

  const sheetHeight = outer * 2 + referenceHeight + rowCount * cardHeight + Math.max(0, rowCount - 1) * gap
  const fragments = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetWidth}" height="${sheetHeight}" viewBox="0 0 ${sheetWidth} ${sheetHeight}">`,
    '<defs>',
    '<pattern id="checker" width="16" height="16" patternUnits="userSpaceOnUse">',
    '<rect width="16" height="16" fill="#f3f4f6"/>',
    '<rect width="8" height="8" fill="#d7dae0"/><rect x="8" y="8" width="8" height="8" fill="#d7dae0"/>',
    '</pattern>',
    '</defs>',
    `<rect width="${sheetWidth}" height="${sheetHeight}" fill="#eceef2"/>`,
  ]

  if (reference) {
    fragments.push(
      `<rect x="${outer}" y="${outer}" width="${sheetWidth - outer * 2}" height="${referenceHeight - gap}" rx="6" fill="#fff" stroke="#c8ccd4"/>`,
      `<text x="${outer + 16}" y="${outer + 30}" font-family="Arial, sans-serif" font-size="16" fill="#17191d">Figma reference</text>`,
      `<image href="${reference}" x="${outer + 16}" y="${outer + 44}" width="${sheetWidth - outer * 2 - 32}" height="${referenceHeight - 68}" preserveAspectRatio="xMidYMid meet"/>`,
    )
  }

  assets.forEach(({ asset, uri, dimensions }, index) => {
    const column = index % options.columns
    const row = Math.floor(index / options.columns)
    const x = outer + column * (cardWidth + gap)
    const y = outer + referenceHeight + row * (cardHeight + gap)
    const label = `${asset.asset_id} · ${String(asset.format).toUpperCase()} · ${dimensions.width}×${dimensions.height}`
    const backgrounds = [
      { fill: 'url(#checker)', label: 'alpha' },
      { fill: '#ffffff', label: 'light' },
      { fill: '#252830', label: 'dark' },
    ]

    fragments.push(
      `<rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="6" fill="#fff" stroke="#c8ccd4"/>`,
      `<text x="${x + 16}" y="${y + 24}" font-family="Arial, sans-serif" font-size="14" fill="#17191d">${escapeXml(label)}</text>`,
      `<text x="${x + 16}" y="${y + 44}" font-family="Arial, sans-serif" font-size="12" fill="#5f6672">${escapeXml(asset.file)}</text>`,
    )

    backgrounds.forEach((background, previewIndex) => {
      const previewX = x + 16 + previewIndex * (previewWidth + previewGap)
      const innerX = previewX + 10
      const innerY = y + previewY + 10
      fragments.push(
        `<rect x="${previewX}" y="${y + previewY}" width="${previewWidth}" height="${previewHeight}" rx="4" fill="${background.fill}" stroke="#b9bec8"/>`,
        `<image href="${uri}" x="${innerX}" y="${innerY}" width="${previewWidth - 20}" height="${previewHeight - 20}" preserveAspectRatio="xMidYMid meet"/>`,
        `<text x="${previewX + previewWidth / 2}" y="${y + previewY + previewHeight + 20}" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#5f6672">${background.label}</text>`,
      )
    })
  })
  fragments.push('</svg>')

  const output = path.resolve(options.output)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const temporary = `${output}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${fragments.join('\n')}\n`)
  fs.renameSync(temporary, output)
  console.log(`[asset-qa] contact sheet ${assets.length} assets: ${output}`)
}

const argv = process.argv.slice(2)
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP.trim())
  process.exit(0)
}
const command = argv.shift()
if (command === 'bundle') bundle(parseBundleArgs(argv))
else if (command === 'contact-sheet') contactSheet(parseContactSheetArgs(argv))
else fail(`未知命令：${command}。使用 --help 查看用法。`)
