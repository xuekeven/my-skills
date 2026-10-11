#!/usr/bin/env node

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { loadSkillDependency } from './lib/dependencies.mjs'

const HELP = `
通过 Chrome DevTools Protocol 查询并截取唯一 DOM 根，同时输出机器捕获、网络和控制台报告。

用法：
  node shoot-preview.mjs \\
    --url file:///absolute/path/restored-page/index.html \\
    --out visual-check/preview.png \\
    --report visual-check/capture-report.json \\
    --width 375 --height 812 --scale 1 \\
    --capture-target '[data-figma-frame]'

必填参数：
  --url <url>              本地预览 URL（http/https/file）
  --out <path>             PNG 输出路径
  --report <path>          机器捕获报告 JSON
  --width <px>             Figma Frame 的 CSS 宽度
  --height <px>            Figma Frame 的 CSS 高度
  --scale <number>         设备倍率；输出像素尺寸等于 CSS 尺寸乘以倍率
  --capture-target <css>   唯一还原根的 CSS selector

可选参数：
  --ready-selector <css>   页面就绪时必须可见的唯一/非唯一 selector（默认同 capture-target）
  --wait-ms <ms>           load 后额外稳定等待（默认：1000）
  --timeout-ms <ms>        浏览器、加载及资源总超时（默认：30000）

环境变量：
  CHROME_PATH              显式指定 Chrome、Edge 或 Chromium 可执行文件

pngjs 由 Skill 自身管理；目标仓库不需要安装图像诊断依赖。
退出码：0 表示捕获和全部机器前置通过，3 表示捕获前置失败，1 表示用法、依赖或浏览器错误。
`

function die(message, code = 1) {
  console.error(`\n[shoot-preview] ${message}\n`)
  process.exit(code)
}

async function loadPng() {
  try {
    const module = await loadSkillDependency('pngjs')
    return module.PNG || module.default?.PNG
  } catch (error) {
    die(error.message)
  }
}

function readArgs(argv) {
  const opt = {
    url: '',
    out: '',
    report: '',
    width: NaN,
    height: NaN,
    scale: NaN,
    captureTarget: '',
    readySelector: '',
    waitMs: 1000,
    timeoutMs: 30000,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(HELP.trim())
      process.exit(0)
    }
    if (arg === '--url') opt.url = argv[++i]
    else if (arg === '--out') opt.out = argv[++i]
    else if (arg === '--report') opt.report = argv[++i]
    else if (arg === '--width') opt.width = Number(argv[++i])
    else if (arg === '--height') opt.height = Number(argv[++i])
    else if (arg === '--scale') opt.scale = Number(argv[++i])
    else if (arg === '--capture-target') opt.captureTarget = argv[++i]
    else if (arg === '--ready-selector') opt.readySelector = argv[++i]
    else if (arg === '--wait-ms') opt.waitMs = Number(argv[++i])
    else if (arg === '--timeout-ms') opt.timeoutMs = Number(argv[++i])
    else die(`未知参数：${arg}。使用 --help 查看用法。`)
  }

  for (const key of ['url', 'out', 'report', 'captureTarget']) {
    if (!opt[key]) die(`缺少必填参数 --${key.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)}。`)
  }
  for (const key of ['width', 'height', 'scale']) {
    if (!Number.isFinite(opt[key]) || opt[key] <= 0) die(`--${key} 必须是正数。`)
  }
  if (!Number.isInteger(opt.width) || !Number.isInteger(opt.height)) {
    die('--width 和 --height 必须是整数 CSS 像素。')
  }
  if (!Number.isFinite(opt.waitMs) || opt.waitMs < 0) die('--wait-ms 必须是 0 或正数。')
  if (!Number.isFinite(opt.timeoutMs) || opt.timeoutMs <= 0) die('--timeout-ms 必须是正数。')

  try {
    const parsedUrl = new URL(opt.url)
    if (!['http:', 'https:', 'file:'].includes(parsedUrl.protocol)) throw new Error('protocol')
    if (parsedUrl.protocol === 'file:') {
      const file = fileURLToPath(parsedUrl)
      if (!path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new Error('file')
      }
    }
  } catch {
    die('--url 必须是有效的 http/https URL，或指向现有文件的绝对 file:// URL。')
  }
  opt.readySelector ||= opt.captureTarget
  return opt
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true)

  return new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
    if (childHasExited(child)) finish(true)
  })
}

function isIgnorableBrowserRequest(url, resourceType) {
  if (resourceType !== 'Other') return false
  try {
    return new URL(url).pathname === '/favicon.ico'
  } catch {
    return false
  }
}

async function waitFor(predicate, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate()
    if (value) return value
    await delay(100)
  }
  throw new Error(message)
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
        return
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params)
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP 连接已关闭。'))
      this.pending.clear()
    })
  }

  static async connect(url) {
    if (typeof WebSocket !== 'function') {
      throw new Error('当前 Node.js 不提供 WebSocket；请使用支持全局 WebSocket 的 Node.js 版本。')
    }
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('无法连接 Chrome DevTools Protocol。')), { once: true })
    })
    return new CdpClient(socket)
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || []
    listeners.push(listener)
    this.listeners.set(method, listeners)
  }

  waitForEvent(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const listeners = this.listeners.get(method) || []
      let timer
      const listener = (params) => {
        clearTimeout(timer)
        this.listeners.set(method, (this.listeners.get(method) || []).filter((item) => item !== listener))
        resolve(params)
      }
      listeners.push(listener)
      this.listeners.set(method, listeners)
      timer = setTimeout(() => {
        this.listeners.set(method, (this.listeners.get(method) || []).filter((item) => item !== listener))
        reject(new Error(`等待 ${method} 超时。`))
      }, timeoutMs)
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.socket.close()
  }
}

function analyzeScreenshot(PNG, buffer) {
  const image = PNG.sync.read(buffer)
  const colors = new Set()
  let nonTransparentPixels = 0
  const stride = Math.max(1, Math.floor((image.width * image.height) / 50000))
  for (let pixel = 0; pixel < image.width * image.height; pixel += stride) {
    const index = pixel << 2
    if (image.data[index + 3] > 0) nonTransparentPixels += 1
    colors.add(
      `${image.data[index]},${image.data[index + 1]},${image.data[index + 2]},${image.data[index + 3]}`,
    )
    if (colors.size > 2 && nonTransparentPixels > 1) break
  }
  return {
    width: image.width,
    height: image.height,
    sampled_unique_colors: colors.size,
    screenshot_not_blank: colors.size > 1 && nonTransparentPixels > 0,
  }
}

function candidatesFromPath(executableNames, env) {
  const pathValue = env.PATH || env.Path || env.path || ''
  if (!pathValue) return []
  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => executableNames.map((name) => path.join(directory, name)))
}

function platformBrowserCandidates(platform, env) {
  const common = [env.CHROME_PATH || '']
  let executableNames = []
  let installedPaths = []

  if (platform === 'darwin') {
    executableNames = [
      'google-chrome',
      'chromium',
      'chromium-browser',
      'microsoft-edge',
    ]
    installedPaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ]
  } else if (platform === 'win32') {
    executableNames = ['chrome.exe', 'msedge.exe', 'chromium.exe']
    const programFiles = [env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean)
    installedPaths = [
      ...programFiles.flatMap((directory) => [
        path.join(directory, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(directory, 'Chromium', 'Application', 'chrome.exe'),
      ]),
      env.LOCALAPPDATA
        ? path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
        : '',
      env.LOCALAPPDATA
        ? path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        : '',
      env.LOCALAPPDATA
        ? path.join(env.LOCALAPPDATA, 'Google', 'Chrome SxS', 'Application', 'chrome.exe')
        : '',
      env.LOCALAPPDATA
        ? path.join(env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe')
        : '',
    ]
  } else if (platform === 'linux') {
    executableNames = [
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      'microsoft-edge',
      'microsoft-edge-stable',
    ]
    installedPaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/snap/bin/chromium',
      '/opt/google/chrome/chrome',
      '/opt/microsoft/msedge/msedge',
    ]
  }

  return [
    ...new Set([
      ...common,
      ...candidatesFromPath(executableNames, env),
      ...installedPaths,
    ].filter(Boolean)),
  ]
}

const opt = readArgs(process.argv.slice(2))
const PNG = await loadPng()
if (!PNG) die('pngjs 已加载，但没有提供 PNG 导出。')

const chromeCandidates = platformBrowserCandidates(process.platform, process.env)
const chrome = chromeCandidates.find((candidate) => fs.existsSync(candidate))
if (!chrome) {
  die(
    `未在 ${process.platform} 找到 Chrome、Edge 或 Chromium。` +
      `已检查 PATH 和 ${chromeCandidates.length} 个候选路径；请安装浏览器或显式设置 CHROME_PATH。`,
  )
}

const outputPath = path.resolve(opt.out)
const reportPath = path.resolve(opt.report)
const expectedPixelSize = {
  width: Math.round(opt.width * opt.scale),
  height: Math.round(opt.height * opt.scale),
}
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-to-code-shot-'))
const debugPortFile = path.join(userDataDir, 'DevToolsActivePort')
const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-background-networking',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--noerrdialogs',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let client
const runtimeExceptions = []
const consoleMessages = []
const requestUrls = new Map()
const networkFailures = []
let networkResponseCount = 0
let documentStatus = null
let childSpawnError = null
child.on('error', (error) => {
  childSpawnError = error
})

let cleanupPromise
function cleanup() {
  cleanupPromise ??= (async () => {
    const warnings = []
    let method = childHasExited(child) ? 'already_exited' : 'none'
    let exited = childHasExited(child)

    if (!exited && client) {
      method = 'cdp_browser_close'
      const closeRequest = client.send('Browser.close').catch((error) => {
        warnings.push(`cdp_close_response:${error.message}`)
      })
      await Promise.race([closeRequest, delay(500)])
      exited = await waitForChildExit(child, 4000)
    }

    if (!exited) {
      method = 'sigterm'
      try {
        if (!child.kill('SIGTERM')) warnings.push('sigterm_not_delivered')
      } catch (error) {
        warnings.push(`sigterm_error:${error.message}`)
      }
      exited = await waitForChildExit(child, 3000)
    }

    if (!exited) {
      method = 'sigkill'
      try {
        if (!child.kill('SIGKILL')) warnings.push('sigkill_not_delivered')
      } catch (error) {
        warnings.push(`sigkill_error:${error.message}`)
      }
      exited = await waitForChildExit(child, 1000)
    }

    try {
      client?.close()
    } catch (error) {
      warnings.push(`cdp_socket_close:${error.message}`)
    }

    if (exited) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true })
      } catch (error) {
        warnings.push(`profile_cleanup:${error.message}`)
      }
    } else {
      warnings.push(`browser_still_running:${child.pid}`)
    }

    return {
      method,
      graceful: method === 'cdp_browser_close',
      forced: method === 'sigkill',
      exited,
      exit_code: child.exitCode,
      signal: child.signalCode,
      warnings,
    }
  })()
  return cleanupPromise
}

try {
  const portInfo = await waitFor(
    () => {
      if (childSpawnError) throw childSpawnError
      try {
        const [port] = fs.readFileSync(debugPortFile, 'utf8').trim().split(/\r?\n/)
        return Number(port) || null
      } catch {
        return null
      }
    },
    opt.timeoutMs,
    '浏览器调试端口启动超时。',
  )
  const target = await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${portInfo}/json/list`)
        const targets = await response.json()
        return targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
      } catch {
        return null
      }
    },
    opt.timeoutMs,
    '无法取得浏览器页面调试目标。',
  )

  client = await CdpClient.connect(target.webSocketDebuggerUrl)
  client.on('Runtime.exceptionThrown', (params) => {
    runtimeExceptions.push(params.exceptionDetails?.text || 'runtime_exception')
  })
  client.on('Runtime.consoleAPICalled', (params) => {
    if (!['error', 'warning'].includes(params.type)) return
    const text = (params.args ?? [])
      .map((argument) => {
        if ('value' in argument) return String(argument.value)
        return argument.description || argument.type || 'unknown'
      })
      .join(' ')
    consoleMessages.push({
      level: params.type,
      text,
      timestamp: params.timestamp ?? null,
    })
  })
  client.on('Network.requestWillBeSent', (params) => {
    requestUrls.set(params.requestId, params.request?.url || '')
  })
  client.on('Network.responseReceived', (params) => {
    networkResponseCount += 1
    if (params.type === 'Document') documentStatus = params.response.status
    if (
      params.response.status >= 400 &&
      !isIgnorableBrowserRequest(params.response.url, params.type)
    ) {
      networkFailures.push({
        kind: 'http_error',
        url: params.response.url,
        status: params.response.status,
        resource_type: params.type,
      })
    }
  })
  client.on('Network.loadingFailed', (params) => {
    if (params.canceled) return
    const url = requestUrls.get(params.requestId) || ''
    if (isIgnorableBrowserRequest(url, params.type)) return
    networkFailures.push({
      kind: 'loading_failed',
      url,
      error: params.errorText || 'unknown',
      resource_type: params.type,
    })
  })
  await Promise.all([
    client.send('Page.enable'),
    client.send('Runtime.enable'),
    client.send('Network.enable'),
  ])
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: opt.width,
    height: opt.height,
    deviceScaleFactor: opt.scale,
    mobile: false,
  })

  const loaded = client.waitForEvent('Page.loadEventFired', opt.timeoutMs)
  await client.send('Page.navigate', { url: opt.url })
  await loaded
  if (opt.waitMs > 0) await delay(opt.waitMs)

  const selector = JSON.stringify(opt.captureTarget)
  const readySelector = JSON.stringify(opt.readySelector)
  const resourceWait = Math.min(5000, Math.max(1000, opt.timeoutMs - opt.waitMs))
  const probeExpression = `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      if (document.fonts?.ready) await Promise.race([document.fonts.ready, wait(${resourceWait})]);
      const images = [...document.images];
      await Promise.all(images.map((image) => image.complete ? null : Promise.race([
        new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        }),
        wait(${resourceWait})
      ])));

      const targets = [...document.querySelectorAll(${selector})];
      const readyNodes = [...document.querySelectorAll(${readySelector})];
      const isVisible = (node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const loadingSelectors = '[aria-busy="true"], [data-loading="true"], .loading, [class~="loading"], [class*="skeleton"]';
      const loadingNodes = [...document.querySelectorAll(loadingSelectors)].filter(isVisible);

      let root = null;
      if (targets.length === 1) {
        const rect = targets[0].getBoundingClientRect();
        root = {
          x: rect.x,
          y: rect.y,
          page_x: rect.x + scrollX,
          page_y: rect.y + scrollY,
          width: rect.width,
          height: rect.height,
          child_count: targets[0].childElementCount
        };
      }

      const style = document.createElement('style');
      style.dataset.figmaToCodeCapture = 'true';
      style.textContent = '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}';
      document.head.appendChild(style);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      return {
        document_ready_state: document.readyState,
        fonts_status: document.fonts?.status || 'unsupported',
        image_count: images.length,
        failed_images: images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.currentSrc || image.src),
        target_count: targets.length,
        ready_selector_count: readyNodes.filter(isVisible).length,
        visible_loading_markers: loadingNodes.length,
        root,
        scroll: { x: scrollX, y: scrollY },
        document_size: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        animations_stabilized: true
      };
    })()
  `
  const probeResult = await client.send('Runtime.evaluate', {
    expression: probeExpression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (probeResult.exceptionDetails) throw new Error(probeResult.exceptionDetails.text)
  const probe = probeResult.result.value
  const blockingReasons = []
  if (probe.document_ready_state !== 'complete') blockingReasons.push('preview_document_not_ready_error')
  if (documentStatus !== null && documentStatus >= 400) blockingReasons.push('preview_document_http_error')
  if (probe.target_count === 0) blockingReasons.push('capture_target_missing_error')
  if (probe.target_count > 1) blockingReasons.push('capture_target_not_unique_error')
  if (probe.ready_selector_count === 0) blockingReasons.push('preview_ready_selector_missing_error')
  if (probe.fonts_status !== 'loaded' && probe.fonts_status !== 'unsupported') {
    blockingReasons.push('font_loading_error')
  }
  if (probe.failed_images.length > 0) blockingReasons.push('image_loading_error')
  if (probe.visible_loading_markers > 0) blockingReasons.push('preview_loading_state_error')
  if (runtimeExceptions.length > 0) blockingReasons.push('preview_runtime_error')
  if (consoleMessages.some((message) => message.level === 'error')) {
    blockingReasons.push('preview_console_error')
  }
  if (networkFailures.length > 0) blockingReasons.push('preview_network_error')

  const root = probe.root
  const targetSizeMatched = Boolean(
    root && Math.abs(root.width - opt.width) <= 0.5 && Math.abs(root.height - opt.height) <= 0.5,
  )
  if (root && !targetSizeMatched) blockingReasons.push('capture_target_size_mismatch_error')

  let screenshotBuffer = null
  let screenshotAnalysis = {
    width: 0,
    height: 0,
    sampled_unique_colors: 0,
    screenshot_not_blank: false,
  }
  if (root && targetSizeMatched) {
    const screenshot = await client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: root.page_x,
        y: root.page_y,
        width: opt.width,
        height: opt.height,
        scale: 1,
      },
    })
    screenshotBuffer = Buffer.from(screenshot.data, 'base64')
    screenshotAnalysis = analyzeScreenshot(PNG, screenshotBuffer)
    if (
      screenshotAnalysis.width !== expectedPixelSize.width ||
      screenshotAnalysis.height !== expectedPixelSize.height
    ) {
      blockingReasons.push('diff_frame_size_mismatch_error')
    }
    if (!screenshotAnalysis.screenshot_not_blank) blockingReasons.push('preview_blank_error')
  }

  const uniqueBlockingReasons = [...new Set(blockingReasons)]
  const screenshotSha256 = screenshotBuffer
    ? crypto.createHash('sha256').update(screenshotBuffer).digest('hex')
    : ''
  if (screenshotBuffer) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, screenshotBuffer)
  }

  const capturePrecheck = {
    captured_at: new Date().toISOString(),
    command_argv: [process.execPath, path.resolve(process.argv[1]), ...process.argv.slice(2)],
    url: opt.url,
    capture_report_path: opt.report,
    screenshot_path: opt.out,
    screenshot_sha256: screenshotSha256,
    scale: opt.scale,
    capture_target: opt.captureTarget,
    ready_selector: opt.readySelector,
    expected_css_size: { width: opt.width, height: opt.height },
    expected_pixel_size: expectedPixelSize,
    actual_pixel_size: { width: screenshotAnalysis.width, height: screenshotAnalysis.height },
    root_bbox: root,
    document_status: documentStatus,
    document_ready: probe.document_ready_state === 'complete',
    target_found: probe.target_count === 1,
    target_count: probe.target_count,
    target_size_matched: targetSizeMatched,
    capture_clip_matches_target: Boolean(root && targetSizeMatched),
    fonts_loaded: ['loaded', 'unsupported'].includes(probe.fonts_status),
    images_loaded: probe.failed_images.length === 0,
    failed_images: probe.failed_images,
    loading_state_clear: probe.visible_loading_markers === 0,
    screenshot_not_blank: screenshotAnalysis.screenshot_not_blank,
    sampled_unique_colors: screenshotAnalysis.sampled_unique_colors,
    animations_stabilized: probe.animations_stabilized,
    runtime_exceptions: runtimeExceptions,
    console_messages: consoleMessages,
    console_error_count: consoleMessages.filter((message) => message.level === 'error').length,
    console_warning_count: consoleMessages.filter((message) => message.level === 'warning').length,
    network_response_count: networkResponseCount,
    network_failures: networkFailures,
    machine_checks_passed: uniqueBlockingReasons.length === 0,
    blocking_reasons: uniqueBlockingReasons,
  }
  capturePrecheck.browser_shutdown = await cleanup()
  writeJson(reportPath, { capture_precheck: capturePrecheck })

  if (!capturePrecheck.machine_checks_passed) {
    die(`捕获前置失败，报告：${opt.report}`, 3)
  }
  console.log(`\n[shoot-preview] 已写入 ${opt.out}（${expectedPixelSize.width}x${expectedPixelSize.height}）。`)
  console.log(`[shoot-preview] 机器捕获报告：${opt.report}\n`)
} catch (error) {
  const browserShutdown = await cleanup()
  die(`截图失败：${error.message}（浏览器退出方式：${browserShutdown.method}）`)
}
