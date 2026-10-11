#!/usr/bin/env node
/**
 * create-branch.mjs
 * 在当前 git 仓库中，基于指定基准 ref 新建修复分支；分支名符合 analyze.md 约定：
 * fix-YYMMDD-HHmm（年月日、时分取「执行本脚本时」的本地时间）。
 *
 * ── 命令行参数（与 parseArgs 一致） ──
 *   -h, --help             打印帮助并退出（0）
 *
 *   必选：
 *   --base <ref>           bug_appear_baseline：分支名、tag、SHA、origin/xxx
 *                          若为 x.y.z 形式，会额外尝试同名 tag / v 前缀 / refs/tags/*
 *
 *   可选：
 *   --prefix <s>           分支名前缀，默认 fix（得到 fix-YYMMDD-HHmm）
 *   --cwd <path>           git 仓库根目录，默认当前目录；也可用环境变量 GCL_REPO_ROOT
 *   --fetch                先执行 git fetch --prune（需网络与远程配置）
 *   --dry-run              只打印将要执行的命令，不真正建分支
 *   --allow-dirty          工作区有未提交修改时仍继续（默认会拒绝，防止基线误判）
 *
 * ── 参数约束 ──
 *   --base / --prefix / --cwd 只能传一次；缺值、重复、未知参数都会直接报错退出。
 *   --fetch --dry-run 只预览命令，不会真实更新远端引用；若目标 ref 需 fetch 后才能解析，
 *   会打印“真实执行时将先 fetch 再解析”的提示，而不是误报创建失败。
 *
 * ── 起点 ref 解析规则 ──
 *   bug_appear_baseline 若仅为「版本号」字符串（如 1.2.5），本脚本会依次尝试与同仓库内
 *   git tag/分支的常见命名对齐（例如 1.2.5、v1.2.5、refs/tags/…）。
 *   若仓库中不存在可解析对象，则需改用 commit SHA、分支名，或先为该版本打 tag。
 *
 * ── 前置条件 ──
 *   当前工作目录须在某 git 工作区内（或设置环境变量 GCL_REPO_ROOT）。
 *   默认若存在未提交的本地修改会直接退出；可加 --allow-dirty 跳过该检查。
 *
 * 示例：
 *   node tools/create-branch.mjs --base <bug_appear_baseline>
 *   node tools/create-branch.mjs --base main
 *   node tools/create-branch.mjs --base 1.2.5 --dry-run
 *
 * 分支名示例：
 *   若在 2026-04-23 22:23 本地时间执行，且前缀为 fix，则分支名为 fix-260423-2223。
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const KNOWN_FLAGS = new Set([
  "-h",
  "--help",
  "--base",
  "--prefix",
  "--dry-run",
  "--allow-dirty",
  "--fetch",
  "--cwd",
]);

/** 两位数补零 */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * 生成分支名：`${prefix}-${YYMMDD}-${HHmm}`（本地时区）。
 * YY 为公历年份后两位；与原 Skill 示例 fix-260423-2223 一致。
 */
function makeBranchName(prefix, date = new Date()) {
  const yy = pad2(date.getFullYear() % 100);
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const HH = pad2(date.getHours());
  const Mi = pad2(date.getMinutes());
  return `${prefix}-${yy}${mm}${dd}-${HH}${Mi}`;
}

/** 在非零退出码时打印 stderr 并以相同码退出（避免静默失败） */
function runGit(args, cwd, inheritIo = false) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    ...(inheritIo ? { stdio: "inherit" } : { stdio: ["ignore", "pipe", "pipe"] }),
  });
  if (r.status !== 0) {
    const err = !inheritIo ? r.stderr || r.stdout || "" : "";
    process.stderr.write(
      err ||
        `git ${args.join(" ")} 失败，退出码 ${r.status ?? "unknown"}\n`
    );
    process.exit(r.status ?? 1);
  }
  return !inheritIo ? r.stdout?.trimEnd() : "";
}

/** 尝试解析 ref；成功返回 { sha, ref }，失败返回 null（不退出进程）。 */
function tryRevParse(cwd, ref) {
  const r = spawnSync("git", ["rev-parse", "--verify", ref], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return null;
  const sha = r.stdout.trim();
  if (!sha) return null;
  return { sha, ref };
}

/**
 * 当 bug_appear_baseline 像语义化版本（如 1.2.5、1.0.0-rc.1）时，按常见 tag 命名扩展候选 ref。
 * 仍要求仓库里确实存在对应对象；不会根据 package.json 推断提交。
 */
const SEMVER_LIKE = /^\d+\.\d+\.\d+([+.-]?[0-9A-Za-z.-]*)?$/;

function candidateRefsForBase(base) {
  const list = [base];
  const trimmed = base.trim();
  if (SEMVER_LIKE.test(trimmed)) {
    list.push(`v${trimmed}`, `refs/tags/${trimmed}`, `refs/tags/v${trimmed}`);
  }
  return [...new Set(list)];
}

/** 从左到右试候选，返回第一个可被 git verify 的项。 */
function resolveBaseRef(cwd, base) {
  for (const ref of candidateRefsForBase(base)) {
    const hit = tryRevParse(cwd, ref);
    if (hit) return hit;
  }
  return null;
}

function parseError(message) {
  const err = new Error(message);
  err.isUsageError = true;
  return err;
}

function readOptionValue(argv, index, flag) {
  const next = argv[index + 1];
  if (!next || KNOWN_FLAGS.has(next)) {
    throw parseError(`error: ${flag} 缺少参数值`);
  }
  return next;
}

function parseArgs(argv) {
  const out = {
    base: null,
    prefix: "fix",
    dryRun: false,
    allowDirty: false,
    fetchFirst: false,
    cwd: process.env.GCL_REPO_ROOT
      ? resolve(process.env.GCL_REPO_ROOT)
      : process.cwd(),
    help: false,
  };
  const seenValueFlags = new Set();
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--base") {
      if (seenValueFlags.has(a)) {
        throw parseError("error: --base 只能传一次");
      }
      out.base = readOptionValue(argv, i, a);
      seenValueFlags.add(a);
      i += 1;
    }
    else if (a === "--prefix") {
      if (seenValueFlags.has(a)) {
        throw parseError("error: --prefix 只能传一次");
      }
      out.prefix = readOptionValue(argv, i, a);
      seenValueFlags.add(a);
      i += 1;
    }
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--allow-dirty") out.allowDirty = true;
    else if (a === "--fetch") out.fetchFirst = true;
    else if (a === "--cwd") {
      if (seenValueFlags.has(a)) {
        throw parseError("error: --cwd 只能传一次");
      }
      out.cwd = resolve(readOptionValue(argv, i, a));
      seenValueFlags.add(a);
      i += 1;
    }
    else {
      throw parseError(`error: 不支持的参数 ${a}`);
    }
  }
  return out;
}

function printHelp() {
  process.stderr.write(`用法:
  node create-branch.mjs --base <ref> [选项]

必选:
  --base <ref>     bug_appear_baseline：分支名、tag、SHA、origin/xxx；若为 x.y.z 形式会尝试同名 tag / v 前缀等

可选:
  --prefix <s>     分支名前缀，默认 fix（得到 fix-YYMMDD-HHmm）
  --cwd <path>     git 仓库根目录，默认当前目录；也可用环境变量 GCL_REPO_ROOT
  --fetch          先执行 git fetch --prune（需网络与远程配置）
  --dry-run        只打印将要执行的命令，不真正建分支
  --allow-dirty    工作区有未提交修改时仍继续（默认会拒绝，防止基线误判）

说明:
  分支名中「年月日时分」为执行本脚本的本地时间，与 analyze.md 示例一致。
  纯版本号（如 1.2.5）只有在仓库里存在可解析的 tag/分支时才能作为起点；否则请打 tag 或改用 commit。
`);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (error) {
    if (error?.isUsageError) {
      process.stderr.write(`${error.message}\n`);
      printHelp();
      process.exit(1);
    }
    throw error;
  }
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  if (!opts.base) {
    process.stderr.write("error: 必须提供 --base <ref>（即 bug 出现版本/分支）\n");
    printHelp();
    process.exit(1);
  }

  // 确认在 git 仓库内（rev-parse 在子目录也可找到根）
  runGit(["rev-parse", "--git-dir"], opts.cwd);

  if (opts.fetchFirst) {
    if (opts.dryRun) {
      process.stdout.write(`[dry-run] git -C ${opts.cwd} fetch --prune\n`);
    } else {
      runGit(["fetch", "--prune"], opts.cwd, true);
    }
  }

  const branchName = makeBranchName(opts.prefix);

  // 解析 base：分支、远程分支、SHA、标签名；若为 x.y.z 形式会额外尝试 v 前缀与 refs/tags/
  const resolved = resolveBaseRef(opts.cwd, opts.base);
  if (!resolved) {
    if (opts.dryRun && opts.fetchFirst) {
      process.stdout.write(
        `[dry-run] git -C ${opts.cwd} switch -c ${branchName} <resolved-after-fetch:${opts.base}>\n` +
          `          # 当前本地尚无法解析 ${opts.base}；真实执行时会先 fetch，再重新解析起点\n`
      );
      process.exit(0);
    }

    const tried = candidateRefsForBase(opts.base).join(", ");
    process.stderr.write(
      `error: 无法解析 --base ${opts.base}\n` +
        `  已尝试: ${tried}\n` +
        `  若这是仅写在 package.json 的版本号，请用对应 **git tag/分支/commit**，或先为该版本打 tag。\n`
    );
    process.exit(1);
  }

  // 未提交修改时默认拒绝（与「从干净基线开修复分支」的常见习惯一致）
  // dry-run 不改动仓库，允许在脏工作区预览命令。
  if (!opts.allowDirty && !opts.dryRun) {
    const status = runGit(["status", "--porcelain"], opts.cwd);
    if (status.length > 0) {
      process.stderr.write(
        "error: 工作区有未提交修改。请先提交/暂存/清理，或显式传入 --allow-dirty\n" +
          status +
          "\n"
      );
      process.exit(2);
    }
  }

  // 使用解析得到的 commit SHA 作为起点，避免「仅标签有别名」时的歧义
  const args = ["switch", "-c", branchName, resolved.sha];
  if (opts.dryRun) {
    process.stdout.write(
      `[dry-run] git -C ${opts.cwd} ${args.join(" ")}\n` +
        `          # 将基于 ${resolved.ref} (${resolved.sha.slice(0, 7)}…) 创建 ${branchName}\n`
    );
    process.exit(0);
  }

  runGit(args, opts.cwd, true);

  // 当前分支名回显，便于日志与复制
  const current = runGit(["branch", "--show-current"], opts.cwd);
  process.stdout.write(
    `已创建并切换到分支: ${current}\n` +
      `  基于: ${resolved.ref} → ${resolved.sha.slice(0, 7)}\n`
  );
}

main();
