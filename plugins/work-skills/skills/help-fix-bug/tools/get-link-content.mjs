#!/usr/bin/env node
/**
 * get-link-content.mjs
 * 使用 Playwright 抓取目标 URL（等待页面进入目标加载阶段并可选额外等待后），将结果保存到
 * ~/.get-link-content-res/<文件名>（或 --out / --res-dir 指定），供 AI 通过 Read 工具分析 Bug。
 *
 * ── 命令行参数（与 parseArgs 一致） ──
 *   <URL>                  目标地址，须以 http:// 或 https:// 开头；与「第一个非选项参数」二选一
 *   --url <URL>            同上，显式写法
 *   -h, --help             打印帮助并退出（0），无 URL 时也会打印帮助并以 1 退出
 *
 *   输出与路径：
 *   --out <stem>           输出文件路径前缀（不含扩展名）；将按所选格式追加 .html / .mhtml / .png
 *   --res-dir <path>       未指定 --out 时，文件保存到此目录；默认见环境变量 GCL_RES_DIR
 *
 *   格式（可任意组合；若三者都未出现，则默认仅保存 --html）：
 *   --html                 HTML 快照（.html）
 *   --mhtml                MHTML 快照（.mhtml），内嵌 CSS/图片，本地打开接近原页
 *   --screenshot           全页 PNG 截图（.png）
 *
 *   浏览器（可选；未指定时按下方顺序自动探测）：
 *   --browser <path|name>  绝对路径，或：chrome-for-testing | chrome | edge | msedge | chromium
 *
 *   登录态持久化（Playwright userDataDir，与日常 Chrome 勿共用同一目录）：
 *   --user-data-dir <path> 独立 profile；未指定时默认见环境变量 GCL_USER_DATA_DIR
 *
 *   页面加载（传给 Playwright page.goto）：
 *   --wait-until <event>   load | domcontentloaded | networkidle | commit，默认 domcontentloaded
 *   --timeout-ms <n>       导航超时（毫秒），默认 60000
 *   --extra-wait-ms <n>    goto 成功后再额外等待（毫秒），默认 3000，适合懒加载/慢 SPA
 *
 *   模式：
 *   --headed               全程有头：打开窗口 → 用户操作后按 Enter → 再保存（不走「先无头判登录」）
 *   --headless             始终无头，不检测登录页，直接抓取（需已有 Cookie 或页面无需登录）
 *   --debug                输出更详细的调试日志（浏览器候选、跳转阶段、登录检测结果、失败栈）
 *
 *   环境变量（可被 CLI 覆盖或作为默认）：
 *   GCL_EXECUTABLE_PATH    强制浏览器可执行文件路径（最高优先，覆盖 --browser 探测）
 *   GCL_USER_DATA_DIR        默认登录态目录，等价于未传 --user-data-dir 时的默认值
 *   GCL_RES_DIR              默认结果目录，等价于未传 --res-dir 时的默认值
 *
 * ── 浏览器选用顺序（未指定 GCL_EXECUTABLE_PATH 且未传 --browser 时） ──
 *   1. Google Chrome for Testing（本机路径探测）
 *   2. Google Chrome 稳定版（本机路径探测）
 *   3. Chrome channel（Playwright 自主寻找）
 *   4. Microsoft Edge channel（Windows 上常见）
 *   5. Playwright 内置 Chromium（兜底）
 *   注：Playwright 只能自动化 Chromium 系浏览器。
 *
 * ── 自动登录检测（未使用 --headed / --headless 覆盖时） ──
 *   1. 先以无头模式访问 URL（复用 userDataDir 中持久化的登录态）
 *   2. 若检测到登录页 → 弹出有头浏览器 → 用户登录后按 Enter
 *   3. 无头重新抓取
 *
 * ── 输出文件命名（未指定 --out 时由 URL 推导基名） ──
 *   禅道  .../bug-view-59554.html  → bug-view-59554.{html|mhtml|png}
 *   Jira  .../browse/JDRW-129337   → JDRW-129337.{…}
 *   监控  .../issues/24150        → issues-24150.{…}
 *
 * 示例：
 *   node tools/get-link-content.mjs <URL>
 *   node tools/get-link-content.mjs --url <URL> --html --mhtml
 *   node tools/get-link-content.mjs <URL> --screenshot --out /tmp/my-bug
 *   node tools/get-link-content.mjs <URL> --browser chrome --user-data-dir ~/.my-zentao-profile
 */
import process from "node:process";
import { homedir } from "node:os";
import { join, extname, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";

// ─── 常量 ────────────────────────────────────────────────────────────────────

const DEFAULT_USER_DATA_DIR = join(homedir(), ".get-link-content-profile");
const DEFAULT_RES_DIR       = join(homedir(), ".get-link-content-res");
const DEFAULT_WAIT_UNTIL    = "domcontentloaded";
const DEFAULT_EXTRA_WAIT_MS = 3_000;
const VALID_WAIT_UNTIL      = ["load", "domcontentloaded", "networkidle", "commit"];
const KNOWN_OUTPUT_EXTS     = new Set([".html", ".mhtml", ".png"]);
const PLAYWRIGHT_INSTALL_HINT =
  "未安装 playwright。请先在 help-fix-bug/ 目录执行：\n" +
  "  pnpm install\n" +
  "若已安装，请确认当前脚本所在目录的 node_modules 未被清理。";

/** Chrome for Testing 可执行文件 —— 各平台 */
const CHROME_FOR_TESTING = {
  darwin: "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  win32:  ["C:\\Program Files\\Google\\Chrome for Testing\\Application\\chrome.exe",
           "C:\\Program Files (x86)\\Google\\Chrome for Testing\\Application\\chrome.exe"],
  linux:  ["/opt/google/chrome-for-testing/chrome", "/usr/bin/google-chrome-for-testing"],
};

/** Chrome 稳定版可执行文件 —— 各平台 */
const CHROME_STABLE = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  win32:  ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
           "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"],
  linux:  ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"],
};

/** 登录页检测：URL 含登录关键字 */
const LOGIN_URL_RE   = /[/?=&](login|signin|sign[-_]in|auth|sso|passport|oauth|cas|account)/i;
/** 登录页检测：页面标题含登录关键字 */
const LOGIN_TITLE_RE = /登[录陆]|login|sign[\s-]*in/i;

// ─── 浏览器探测 ───────────────────────────────────────────────────────────────

let chromiumPromise = null;

async function getChromium() {
  if (!chromiumPromise) {
    chromiumPromise = import("playwright")
      .then(mod => mod.chromium)
      .catch(error => {
        throw new Error(
          `${PLAYWRIGHT_INSTALL_HINT}\n原始错误：${error?.message ?? String(error)}`
        );
      });
  }
  return chromiumPromise;
}

function findFirst(paths) {
  const arr = Array.isArray(paths) ? paths : [paths];
  return arr.find(p => existsSync(p)) ?? null;
}

/**
 * 解析 --browser 参数或自动探测，返回传给 launchPersistentContext 的候选配置列表。
 * 每项为 { executablePath?, channel?, _label }，由 launchContext 依次尝试。
 *
 * --browser 支持：
 *   /绝对/路径          直接作为 executablePath
 *   chrome-for-testing  强制使用 Chrome for Testing
 *   chrome              强制使用 Chrome 稳定版（失败则 channel=chrome）
 *   edge | msedge       channel=msedge
 *   chromium            Playwright 内置 Chromium
 */
function resolveBrowserCandidates(browserArg) {
  const env = process.env.GCL_EXECUTABLE_PATH;
  if (env) return [{ executablePath: env, _label: `env: ${env}` }];

  if (browserArg) {
    const b = browserArg.trim();
    if (b.startsWith("/") || /^[A-Za-z]:\\/.test(b)) {
      return [{ executablePath: b, _label: b }];
    }
    switch (b.toLowerCase()) {
      case "chrome-for-testing": {
        const p = findFirst(CHROME_FOR_TESTING[process.platform] ?? []);
        if (!p) throw new Error(`未找到 Google Chrome for Testing（平台：${process.platform}）`);
        return [{ executablePath: p, _label: "Chrome for Testing" }];
      }
      case "chrome": {
        const p = findFirst(CHROME_STABLE[process.platform] ?? []);
        return p
          ? [{ executablePath: p, _label: "Chrome Stable" }]
          : [{ channel: "chrome", _label: "Chrome (channel)" }];
      }
      case "edge":
      case "msedge":
        return [{ channel: "msedge", _label: "Edge" }];
      case "chromium":
        return [{ _label: "Playwright bundled Chromium" }];
      default:
        throw new Error(
          `未知 --browser 值：${b}\n支持：chrome-for-testing | chrome | edge | chromium | 绝对路径`
        );
    }
  }

  // 自动探测候选（依次尝试，失败则下一个）
  const candidates = [];
  const p = process.platform;

  const cft = findFirst(CHROME_FOR_TESTING[p] ?? []);
  if (cft) candidates.push({ executablePath: cft, _label: "Chrome for Testing" });

  const cs = findFirst(CHROME_STABLE[p] ?? []);
  if (cs) candidates.push({ executablePath: cs, _label: "Chrome Stable" });

  candidates.push({ channel: "chrome",  _label: "Chrome (channel)" });
  candidates.push({ channel: "msedge",  _label: "Edge (channel)" });
  candidates.push({ _label: "Playwright bundled Chromium" });

  return candidates;
}

/**
 * 按候选列表依次尝试启动 Playwright 持久化上下文，返回第一个成功的。
 */
async function launchContext(userDataDir, headless, candidates) {
  const chromium = await getChromium();
  const baseArgs = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
  ];
  let lastErr;
  for (const { _label, ...config } of candidates) {
    try {
      const ctx = await chromium.launchPersistentContext(userDataDir, {
        headless,
        ...config,
        args: baseArgs,
        ignoreHTTPSErrors: true,
      });
      if (_label) process.stderr.write(`使用浏览器：${_label}\n`);
      return ctx;
    } catch (e) {
      if (_label) process.stderr.write(`${_label} 不可用，尝试下一个…\n`);
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("所有浏览器候选均启动失败");
}

// ─── 文件命名 ──────────────────────────────────────────────────────────────────

/**
 * 从 URL 推导输出文件的基名（stem，不含扩展名）。
 *
 * 示例：
 *   .../zentao/bug-view-59554.html  → bug-view-59554
 *   .../jira/browse/JDRW-129337    → JDRW-129337
 *   .../issues/24150?project=10    → issues-24150
 * 规则：取路径末尾有意义的段；末段若为纯数字则拼上倒数第二段。
 */
function urlToStem(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return `page-${Date.now()}`; }

  const segs = u.pathname
    .split("/")
    .filter(Boolean)
    .map(s => s.replace(/\.html$/i, ""));

  if (segs.length === 0) return sanitize(u.hostname);

  const last = segs[segs.length - 1];
  const base =
    /^\d+$/.test(last) && segs.length >= 2
      ? segs[segs.length - 2] + "-" + last
      : last;

  return sanitize(base);
}

function sanitize(s) {
  return s
    .replace(/[^a-zA-Z0-9\-_]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── 登录检测 ─────────────────────────────────────────────────────────────────

async function detectLoginPage(page) {
  const url = page.url();
  if (LOGIN_URL_RE.test(url)) return true;

  const title = await page.title().catch(() => "");
  if (LOGIN_TITLE_RE.test(title)) return true;

  const pwdCount = await page
    .locator('input[type="password"]')
    .count()
    .catch(() => 0);
  return pwdCount > 0;
}

// ─── 核心：打开页面，把 page 传给 callback ────────────────────────────────────

function waitForEnter(prompt) {
  if (!process.stdin.isTTY) {
    throw new Error(
      "当前执行环境不是交互式终端，无法等待你在浏览器中登录后按 Enter 继续。" +
      "请改为在本机终端执行 `--headed` 调试，或回退到 Codex 的 Chrome 登录态共享方案。"
    );
  }
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function debugLog(enabled, message) {
  if (!enabled) return;
  process.stderr.write(`[debug] ${message}\n`);
}

async function debugPageState(page, enabled, label) {
  if (!enabled) return;
  const url = page.url();
  const title = await page.title().catch(() => "");
  process.stderr.write(`[debug] ${label}: url=${url} title=${title}\n`);
}

function stripKnownOutputExt(stem) {
  const ext = extname(stem).toLowerCase();
  return KNOWN_OUTPUT_EXTS.has(ext) ? stem.slice(0, -ext.length) : stem;
}

function isZentaoBugUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /bug-view-\d+\.html/i.test(url.pathname);
  } catch {
    return false;
  }
}

function frameLooksLikeTarget(frame, rawUrl) {
  const url = frame.url();
  if (!url || url === "about:blank") return false;
  if (url === rawUrl) return true;

  try {
    const target = new URL(rawUrl);
    const current = new URL(url);
    return current.origin === target.origin && current.pathname === target.pathname;
  } catch {
    return false;
  }
}

async function findMatchingChildFrame(page, rawUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const frames = page.frames().filter(frame => frame !== page.mainFrame());
    const exact = frames.find(frame => frameLooksLikeTarget(frame, rawUrl));
    if (exact) return exact;

    const named = frames.find(frame => {
      const name = frame.name();
      return name && /^app-/.test(name) && frame.url() !== "about:blank";
    });
    if (named) return named;

    await sleep(250);
  }

  return null;
}

function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function staticizeHtmlSnapshot(html, baseUrl) {
  const withoutScripts = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const baseTag = `<base href="${escapeHtmlAttr(baseUrl)}">`;

  if (/<head\b[^>]*>/i.test(withoutScripts)) {
    return withoutScripts.replace(
      /<head\b([^>]*)>/i,
      `<head$1>\n  ${baseTag}\n  <meta name="generator" content="get-link-content zentao static snapshot">`
    );
  }

  return `<!DOCTYPE html><html><head>${baseTag}</head><body>${withoutScripts}</body></html>`;
}

async function buildZentaoFrameHtmlSnapshot(frame, frameUrl, assetDirName) {
  return await frame.evaluate(async ({ assetDirName }) => {
    function toDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
        reader.readAsDataURL(blob);
      });
    }

    function guessExt(url, mimeType) {
      try {
        const pathname = new URL(url, location.href).pathname;
        const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
        if (match) return `.${match[1]}`;
      } catch {}

      const mime = mimeType.split(";")[0].trim().toLowerCase();
      if (mime === "image/jpeg") return ".jpg";
      if (mime === "image/png") return ".png";
      if (mime === "image/gif") return ".gif";
      if (mime === "image/webp") return ".webp";
      if (mime === "image/svg+xml") return ".svg";
      if (mime === "image/bmp") return ".bmp";
      return ".bin";
    }

    const docEl = document.documentElement.cloneNode(true);
    const assets = [];
    let assetIndex = 0;

    const allElements = docEl.querySelectorAll("*");
    for (const el of allElements) {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      }
    }

    docEl.querySelectorAll("script").forEach(node => node.remove());

    const baseUrl = location.href;
    const images = [...docEl.querySelectorAll("img[src]")];
    for (const img of images) {
      const originalSrc = img.getAttribute("src");
      if (!originalSrc || originalSrc.startsWith("data:")) continue;

      const absoluteUrl = new URL(originalSrc, baseUrl).href;
      try {
        const response = await fetch(absoluteUrl, { credentials: "include" });
        if (!response.ok) continue;

        const blob = await response.blob();
        const dataUrl = await toDataUrl(blob);
        assetIndex += 1;
        const fileName = `img-${assetIndex}${guessExt(absoluteUrl, blob.type || response.headers.get("content-type") || "")}`;
        const relativePath = `${assetDirName}/${fileName}`;

        assets.push({ fileName, dataUrl });
        img.setAttribute("src", relativePath);

        const parent = img.closest("a[href]");
        if (parent) {
          const href = parent.getAttribute("href");
          if (href && new URL(href, baseUrl).href === absoluteUrl) {
            parent.setAttribute("href", relativePath);
          }
        }
      } catch {}
    }

    let head = docEl.querySelector("head");
    if (!head) {
      head = document.createElement("head");
      docEl.insertBefore(head, docEl.firstChild);
    }

    const base = document.createElement("base");
    base.setAttribute("href", baseUrl);
    head.prepend(base);

    const meta = document.createElement("meta");
    meta.setAttribute("name", "generator");
    meta.setAttribute("content", "get-link-content zentao local snapshot");
    head.appendChild(meta);

    return {
      html: "<!DOCTYPE html>\n" + docEl.outerHTML,
      assets,
    };
  }, { assetDirName });
}

async function resolveCaptureTarget(page, rawUrl, opts) {
  const { timeoutMs = 60_000 } = opts;
  const pageTitle = await page.title().catch(() => "");

  if (!isZentaoBugUrl(rawUrl)) {
    return {
      kind: "page",
      captureUrl: page.url(),
      captureTitle: pageTitle,
      getHtml: async () => await page.content(),
      getMhtml: async () => {
        const cdp = await page.context().newCDPSession(page);
        const { data } = await cdp.send("Page.captureSnapshot", { format: "mhtml" });
        return data;
      },
      screenshotTo: async path => {
        await page.screenshot({ path, fullPage: true, type: "png" });
      },
    };
  }

  const childFrame = await findMatchingChildFrame(page, rawUrl, timeoutMs);
  if (!childFrame) {
    return {
      kind: "page",
      captureUrl: page.url(),
      captureTitle: pageTitle,
      getHtml: async () => await page.content(),
      getMhtml: async () => {
        const cdp = await page.context().newCDPSession(page);
        const { data } = await cdp.send("Page.captureSnapshot", { format: "mhtml" });
        return data;
      },
      screenshotTo: async path => {
        await page.screenshot({ path, fullPage: true, type: "png" });
      },
    };
  }

  const frameElement = await childFrame.frameElement().catch(() => null);
  const frameUrl = childFrame.url() || page.url();
  const frameTitle = await childFrame.evaluate(() => document.title).catch(() => pageTitle);

  process.stderr.write(`检测到禅道内容 iframe，改为抓取运行中的内页 DOM：${frameUrl}\n`);
  return {
    kind: "zentao-frame",
    captureUrl: frameUrl,
    captureTitle: frameTitle,
    getHtml: async stem => {
      const assetDirName = `${basename(stem)}.assets`;
      return await buildZentaoFrameHtmlSnapshot(childFrame, frameUrl, assetDirName);
    },
    screenshotTo: async path => {
      if (frameElement) {
        await frameElement.screenshot({ path, type: "png" });
      } else {
        await page.screenshot({ path, fullPage: true, type: "png" });
      }
    },
  };
}

/**
 * 处理自动登录检测，最终把稳定的 page 传给 callback，返回 callback 的结果。
 * 无论成功或失败，context 都会在 callback 完成后关闭。
 */
async function withPage(url, userDataDir, candidates, opts, callback) {
  const {
    waitUntil    = DEFAULT_WAIT_UNTIL,
    timeoutMs    = 60_000,
    extraWaitMs  = DEFAULT_EXTRA_WAIT_MS,
    forceHeaded  = false,
    forceHeadless = false,
    debug = false,
  } = opts;
  const gotoOpts = { waitUntil, timeout: timeoutMs };
  debugLog(debug, `capture start url=${url}`);
  debugLog(
    debug,
    `mode headed=${forceHeaded} headless=${forceHeadless} waitUntil=${waitUntil} timeoutMs=${timeoutMs} extraWaitMs=${extraWaitMs} userDataDir=${userDataDir}`
  );
  debugLog(debug, `browser candidates=${candidates.map(c => c._label || c.channel || c.executablePath || "chromium").join(" -> ")}`);

  // ── 强制有头 ──
  if (forceHeaded) {
    process.stderr.write("以有头模式打开浏览器，操作完成后按 Enter 继续…\n");
    const ctx = await launchContext(userDataDir, false, candidates);
    try {
      const page = await ctx.newPage();
      debugLog(debug, "headed mode: page created");
      await page.goto(url, gotoOpts);
      if (extraWaitMs > 0) await sleep(extraWaitMs);
      await debugPageState(page, debug, "headed after goto");
      await waitForEnter("操作完成后按 Enter 开始保存…\n");
      return await callback(page);
    } finally { await ctx.close().catch(() => {}); }
  }

  // ── 第一步：无头尝试 ──
  {
    const ctx = await launchContext(userDataDir, true, candidates);
    let needLogin = false;
    try {
      const page = await ctx.newPage();
      debugLog(debug, "headless first pass: page created");
      await page.goto(url, gotoOpts);
      if (extraWaitMs > 0) await sleep(extraWaitMs);
      await debugPageState(page, debug, "headless first pass after goto");

      if (forceHeadless) return await callback(page);

      needLogin = await detectLoginPage(page);
      debugLog(debug, `headless first pass detectLoginPage=${needLogin}`);
      if (!needLogin) return await callback(page);
    } finally { await ctx.close().catch(() => {}); }

    // ── 第二步：检测到登录页 → 弹出有头浏览器 ──
    process.stderr.write(
      "\n检测到当前页面需要登录，正在打开有头浏览器…\n" +
      "请在弹出的窗口中完成登录操作。\n"
    );
    const headedCtx = await launchContext(userDataDir, false, candidates);
    try {
      const page = await headedCtx.newPage();
      debugLog(debug, "headed login pass: page created");
      await page.goto(url, { ...gotoOpts, timeout: timeoutMs * 2 }).catch(() => {});
      await debugPageState(page, debug, "headed login pass after goto");
      await waitForEnter("\n登录完成后按 Enter，脚本将无头重新抓取…\n");
    } finally { await headedCtx.close().catch(() => {}); }

    // ── 第三步：无头重试 ──
    process.stderr.write("正在以无头模式重新抓取目标页面…\n");
    const ctx2 = await launchContext(userDataDir, true, candidates);
    try {
      const page = await ctx2.newPage();
      debugLog(debug, "headless second pass: page created");
      await page.goto(url, gotoOpts);
      if (extraWaitMs > 0) await sleep(extraWaitMs);
      await debugPageState(page, debug, "headless second pass after goto");
      const stillLogin = await detectLoginPage(page);
      debugLog(debug, `headless second pass detectLoginPage=${stillLogin}`);
      if (stillLogin) {
        throw new Error("登录后仍检测到登录页，请确认登录成功后重试。");
      }
      return await callback(page);
    } finally { await ctx2.close().catch(() => {}); }
  }
}

// ─── 保存各格式 ───────────────────────────────────────────────────────────────

/**
 * 将抓取目标按指定格式列表保存，返回已保存文件路径数组。
 *
 * @param {object} target
 * @param {string}   stem    输出路径（不含扩展名），如 /home/user/.get-link-content-res/JDRW-129337
 * @param {string[]} formats 格式列表，取值：'html' | 'mhtml' | 'screenshot'
 */
async function saveFormats(target, stem, formats) {
  const saved = [];

  for (const fmt of formats) {
    switch (fmt) {
      case "html": {
        const htmlResult = await target.getHtml(stem);
        let html = typeof htmlResult === "string" ? htmlResult : htmlResult.html;
        const path = stem + ".html";
        writeFileSync(path, html, "utf8");
        if (htmlResult && typeof htmlResult === "object" && Array.isArray(htmlResult.assets) && htmlResult.assets.length > 0) {
          const assetDirName = `${basename(stem)}.assets`;
          const assetDirPath = join(dirname(stem), assetDirName);
          mkdirSync(assetDirPath, { recursive: true });
          for (const asset of htmlResult.assets) {
            const match = String(asset.dataUrl).match(/^data:.*?;base64,(.*)$/);
            if (!match) continue;
            const absoluteAssetPath = join(assetDirPath, asset.fileName);
            writeFileSync(absoluteAssetPath, Buffer.from(match[1], "base64"));
            const relativePath = `${assetDirName}/${asset.fileName}`;
            const fileUrl = pathToFileURL(absoluteAssetPath).href;
            html = html.split(relativePath).join(fileUrl);
          }
          writeFileSync(path, html, "utf8");
        }
        saved.push({ fmt, path, size: html.length });
        break;
      }
      case "mhtml": {
        if (target.kind === "zentao-frame") {
          process.stderr.write("禅道暂不支持mhtml格式，已跳过。\n");
          break;
        }
        const data = await target.getMhtml();
        const path = stem + ".mhtml";
        writeFileSync(path, data, "utf8");
        saved.push({ fmt, path, size: data.length });
        break;
      }
      case "screenshot": {
        const path = stem + ".png";
        await target.screenshotTo(path);
        saved.push({ fmt, path, size: -1 });   // size 由 fs.stat 获取，此处略
        break;
      }
    }
  }

  return saved;
}

async function capturePageOutputs(page, rawUrl, opts, stem, formats) {
  const target = await resolveCaptureTarget(page, rawUrl, opts);
  const results = await saveFormats(target, stem, formats);
  return { finalUrl: target.captureUrl, title: target.captureTitle, results };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    url:           null,
    browser:       null,
    userDataDir:   process.env.GCL_USER_DATA_DIR || DEFAULT_USER_DATA_DIR,
    resDir:        process.env.GCL_RES_DIR       || DEFAULT_RES_DIR,
    outStem:       null,       // --out 指定输出路径/前缀（不含扩展名）
    // 格式标志（三者可任意组合；均未指定时默认 html=true）
    fmtHtml:       false,
    fmtMhtml:      false,
    fmtScreenshot: false,
    // 页面加载选项
    waitUntil:     DEFAULT_WAIT_UNTIL,
    timeoutMs:     60_000,
    extraWaitMs:   DEFAULT_EXTRA_WAIT_MS,
    forceHeaded:   false,
    forceHeadless: false,
    debug:         false,
    help:          false,
  };
  const errors = [];
  let i = 2;

  function takeValue(flag) {
    const value = argv[i + 1];
    if (!value || value.startsWith("-")) {
      errors.push(`${flag} 缺少参数值`);
      return null;
    }
    i += 1;
    return value;
  }

  function setUrl(value, sourceLabel) {
    if (opts.url) {
      errors.push(`URL 只能提供一次，重复来源：${sourceLabel}`);
      return;
    }
    opts.url = value;
  }

  for (; i < argv.length; i++) {
    const a = argv[i];
    if      (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--url") {
      const value = takeValue(a);
      if (value) setUrl(value, "--url");
    }
    else if (a === "--browser") {
      const value = takeValue(a);
      if (value) opts.browser = value;
    }
    else if (a === "--user-data-dir") {
      const value = takeValue(a);
      if (value) opts.userDataDir = value;
    }
    else if (a === "--res-dir") {
      const value = takeValue(a);
      if (value) opts.resDir = value;
    }
    else if (a === "--out") {
      const value = takeValue(a);
      if (value) opts.outStem = value;
    }
    else if (a === "--html")       opts.fmtHtml       = true;
    else if (a === "--mhtml")      opts.fmtMhtml      = true;
    else if (a === "--screenshot") opts.fmtScreenshot = true;
    else if (a === "--wait-until") {
      const value = takeValue(a);
      if (value) opts.waitUntil = value;
    }
    else if (a === "--timeout-ms") {
      const value = takeValue(a);
      if (value) opts.timeoutMs = Number(value);
    }
    else if (a === "--extra-wait-ms") {
      const value = takeValue(a);
      if (value) opts.extraWaitMs = Number(value);
    }
    else if (a === "--headed")   opts.forceHeaded   = true;
    else if (a === "--headless") opts.forceHeadless = true;
    else if (a === "--debug")    opts.debug         = true;
    else if (!a.startsWith("-")) setUrl(a, "位置参数");
    else errors.push(`未知参数：${a}`);
  }

  return { opts, errors };
}

function printHelp() {
  process.stderr.write(`
用法:
  node tools/get-link-content.mjs <URL>                         # 默认保存 HTML
  node tools/get-link-content.mjs --url <URL>                   # 显式 URL
  node tools/get-link-content.mjs <URL> --mhtml --screenshot    # 只保存 MHTML + 截图（无 --html 则不写 HTML）
  node tools/get-link-content.mjs <URL> --html --mhtml --screenshot --out /tmp/issue

位置参数与 URL:
  <URL>                     目标地址（须 http:// 或 https://）；须提供一次
  --url <URL>               与位置参数二选一，等价

信息:
  -h, --help                打印本帮助并退出（退出码 0）

输出与目录:
  --out <stem>              输出文件路径前缀（不含扩展名）；按所选格式追加 .html / .mhtml / .png
                            若路径以 .html/.mhtml/.png 结尾会自动剥掉再追加后缀
  --res-dir <path>          未指定 --out 时，文件保存到此目录（覆盖环境变量 GCL_RES_DIR）
  成功时：每个生成文件路径打印一行到 stdout，stderr 写摘要（最终 URL、标题、各文件大小）

格式（可任意组合；若三者都未写，则仅启用 --html）:
  --html                    HTML 快照（.html）
  --mhtml                   MHTML 快照（.mhtml），内嵌资源，本地打开接近线上样式
  --screenshot              全页 PNG 截图（.png）

浏览器:
  --browser <path|name>     绝对路径，或：chrome-for-testing | chrome | edge | msedge | chromium
  未指定 --browser 且未设置 GCL_EXECUTABLE_PATH 时选用顺序：
  1. Chrome for Testing   2. Chrome 稳定版   3. channel=chrome   4. channel=msedge   5. 内置 Chromium

登录态（Playwright 持久化 profile，勿与正在用的主 Chrome 共用同一目录）:
  --user-data-dir <path>    独立 user data；未指定时来自环境变量 GCL_USER_DATA_DIR

页面加载（page.goto）:
  --wait-until <event>      load | domcontentloaded | networkidle | commit（默认 domcontentloaded）
  --timeout-ms <n>         导航超时毫秒，默认 60000
  --extra-wait-ms <n>       导航成功后再等待毫秒（懒加载/慢页），默认 3000

模式:
  --headed                   全程有头：窗口打开 → 操作完成后按 Enter → 保存（不先无头判登录）
  --headless                 始终无头，不检测登录页，直接抓取
  --debug                    输出详细调试日志；失败时附带更多上下文与错误栈

环境变量:
  GCL_EXECUTABLE_PATH       强制浏览器可执行文件路径（优先于 --browser 与自动探测）
  GCL_USER_DATA_DIR         默认 --user-data-dir，默认 ~/.get-link-content-profile
  GCL_RES_DIR               默认 --res-dir，默认 ~/.get-link-content-res

安全:
  不在仓库中保存密码或 Cookie；登录态仅落在本机 userData-dir 目录。
  结果文件含内网/隐私内容时，勿提交到公开仓库。
`);
}

async function main() {
  const { opts, errors } = parseArgs(process.argv);

  if (opts.help) { printHelp(); process.exit(0); }
  if (errors.length > 0) {
    for (const err of errors) {
      process.stderr.write(`error: ${err}\n`);
    }
    process.stderr.write("\n");
    printHelp();
    process.exit(1);
  }
  if (!opts.url)  { printHelp(); process.exit(1); }

  if (!/^https?:\/\//i.test(opts.url)) {
    process.stderr.write("error: URL 必须以 http:// 或 https:// 开头\n");
    process.exit(1);
  }

  if (opts.forceHeaded && opts.forceHeadless) {
    process.stderr.write("error: --headed 与 --headless 不能同时使用\n");
    process.exit(1);
  }

  if (!VALID_WAIT_UNTIL.includes(opts.waitUntil)) {
    process.stderr.write(`error: --wait-until 只支持 ${VALID_WAIT_UNTIL.join(" | ")}\n`);
    process.exit(1);
  }

  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
    process.stderr.write("error: --timeout-ms 必须是大于 0 的整数\n");
    process.exit(1);
  }

  if (!Number.isInteger(opts.extraWaitMs) || opts.extraWaitMs < 0) {
    process.stderr.write("error: --extra-wait-ms 必须是大于等于 0 的整数\n");
    process.exit(1);
  }

  // 确定要保存的格式列表
  const formats = [];
  if (opts.fmtHtml)       formats.push("html");
  if (opts.fmtMhtml)      formats.push("mhtml");
  if (opts.fmtScreenshot) formats.push("screenshot");
  if (formats.length === 0) formats.push("html");   // 默认保存 HTML

  // 解析浏览器候选
  let candidates;
  try {
    candidates = resolveBrowserCandidates(opts.browser);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }

  // 确定输出 stem
  let stem = opts.outStem;
  if (!stem) {
    mkdirSync(opts.resDir, { recursive: true });
    stem = join(opts.resDir, urlToStem(opts.url));
  } else {
    // --out 指定了路径，确保父目录存在；自动剥离用户可能带的扩展名
    stem = stripKnownOutputExt(stem);
    mkdirSync(dirname(stem), { recursive: true });
  }

  // 抓取并保存
  let saved;
  try {
    saved = await withPage(opts.url, opts.userDataDir, candidates, {
      waitUntil:     opts.waitUntil,
      timeoutMs:     opts.timeoutMs,
      extraWaitMs:   opts.extraWaitMs,
      forceHeaded:   opts.forceHeaded,
      forceHeadless: opts.forceHeadless,
      debug:         opts.debug,
    }, async (page) => {
      return await capturePageOutputs(page, opts.url, {
        waitUntil: opts.waitUntil,
        timeoutMs: opts.timeoutMs,
        extraWaitMs: opts.extraWaitMs,
      }, stem, formats);
    });
  } catch (e) {
    process.stderr.write(`抓取失败: ${e?.message || e}\n`);
    if (opts.debug && e?.stack) {
      process.stderr.write(e.stack + "\n");
    }
    process.exit(2);
  }

  // stdout：每个文件一行路径（方便 Agent 直接 Read）
  for (const { path } of saved.results) {
    process.stdout.write(path + "\n");
  }

  // stderr：摘要
  process.stderr.write(`\n最终 URL：${saved.finalUrl}\n标题：${saved.title}\n`);
  for (const { fmt, path, size } of saved.results) {
    const sizeStr = size >= 0 ? `（${(size / 1024).toFixed(0)} KB）` : "";
    process.stderr.write(`  [${fmt}] 已保存${sizeStr}: ${path}\n`);
  }
}

main().catch(e => {
  process.stderr.write(String(e?.stack || e) + "\n");
  process.exit(3);
});
