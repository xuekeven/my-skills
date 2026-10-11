#!/usr/bin/env node
/**
 * doctor.mjs
 * 轻量自检 help-fix-bug Skill 的本机运行条件：
 * - Node.js 版本
 * - git 命令是否可用，以及当前目录是否位于 git 仓库内
 * - playwright 依赖是否已安装
 * - 浏览器可执行文件是否可直接命中（环境变量或常见本机路径）
 *
 * 用法：
 *   node tools/doctor.mjs
 *   pnpm run doctor
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const MIN_NODE_MAJOR = 18;
const PASS = "PASS";
const WARN = "WARN";
const FAIL = "FAIL";

const CHROME_FOR_TESTING = {
  darwin: "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  win32:  ["C:\\Program Files\\Google\\Chrome for Testing\\Application\\chrome.exe",
           "C:\\Program Files (x86)\\Google\\Chrome for Testing\\Application\\chrome.exe"],
  linux:  ["/opt/google/chrome-for-testing/chrome", "/usr/bin/google-chrome-for-testing"],
};

const CHROME_STABLE = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  win32:  ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
           "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"],
  linux:  ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"],
};

function findFirst(paths) {
  const arr = Array.isArray(paths) ? paths : [paths];
  return arr.find(path => existsSync(path)) ?? null;
}

function run(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function print(status, label, detail) {
  process.stdout.write(`[${status}] ${label}: ${detail}\n`);
}

async function checkPlaywright() {
  try {
    const mod = await import("playwright");
    const version = mod?.default?.version || mod?.chromium?.version?.() || "已安装";
    return { status: PASS, detail: String(version) };
  } catch (error) {
    return {
      status: FAIL,
      detail:
        "未安装 playwright；请先在 help-fix-bug/ 目录执行 `pnpm install`" +
        `（${error?.message ?? String(error)}）`,
    };
  }
}

function checkNode() {
  const version = process.versions.node;
  const major = Number(version.split(".")[0] || 0);
  if (major >= MIN_NODE_MAJOR) {
    return { status: PASS, detail: `v${version}` };
  }
  return {
    status: FAIL,
    detail: `当前为 v${version}，需要 >= ${MIN_NODE_MAJOR}`,
  };
}

function checkGitBinary() {
  const result = run("git", ["--version"]);
  if (result.error) {
    return { status: FAIL, detail: `不可用（${result.error.message}）` };
  }
  if (result.status !== 0) {
    return { status: FAIL, detail: result.stderr.trim() || "git --version 执行失败" };
  }
  return { status: PASS, detail: result.stdout.trim() };
}

function checkGitRepo() {
  const result = run("git", ["rev-parse", "--show-toplevel"]);
  if (result.error) {
    return { status: FAIL, detail: `检查失败（${result.error.message}）` };
  }
  if (result.status !== 0) {
    return {
      status: FAIL,
      detail: "当前目录不在 git 仓库内",
    };
  }
  return { status: PASS, detail: result.stdout.trim() };
}

function checkBrowser() {
  const envPath = process.env.GCL_EXECUTABLE_PATH;
  if (envPath) {
    return existsSync(envPath)
      ? { status: PASS, detail: `GCL_EXECUTABLE_PATH -> ${envPath}` }
      : { status: FAIL, detail: `GCL_EXECUTABLE_PATH 不存在：${envPath}` };
  }

  const cft = findFirst(CHROME_FOR_TESTING[process.platform] ?? []);
  if (cft) return { status: PASS, detail: `Chrome for Testing -> ${cft}` };

  const stable = findFirst(CHROME_STABLE[process.platform] ?? []);
  if (stable) return { status: PASS, detail: `Chrome Stable -> ${stable}` };

  return {
    status: WARN,
    detail:
      "未命中常见 Chrome 路径；运行 get-link-content.mjs 时仍会继续尝试 chrome/msedge channel 或 Playwright bundled Chromium",
  };
}

async function main() {
  const checks = [
    ["Node.js", checkNode()],
    ["git", checkGitBinary()],
    ["git repo", checkGitRepo()],
    ["browser", checkBrowser()],
    ["playwright", await checkPlaywright()],
  ];

  let hasFail = false;
  for (const [label, result] of checks) {
    print(result.status, label, result.detail);
    if (result.status === FAIL) hasFail = true;
  }

  process.exit(hasFail ? 1 : 0);
}

main().catch(error => {
  process.stderr.write(`doctor 执行失败：${error?.message ?? String(error)}\n`);
  process.exit(1);
});
