# Help Fix Bug

一个 Agent Skill，帮助开发者**系统性地排查、分析、修复 Bug**，并自动生成结构化的修复报告。

## 工作流

```
了解 Bug → 分析 Bug → 修复 Bug → 总结 Bug
```

| 步骤 | 文档 | 说明 |
|------|------|------|
| 1. 了解 Bug | `prompts/comprehend.md` | 向用户收集代码基线、出现时间、Bug 描述 |
| 2. 分析 Bug | `prompts/analyze.md` | 新建修复分支，通过 Codex 插件共享浏览器登录态读取报告链接内容，系统分析根因 |
| 3. 修复 Bug | `prompts/fix.md` | 提供多方案对比，修改代码，等待用户验证 |
| 4. 总结 Bug | `prompts/summarize.md` | 生成结构化修复报告（可写入文件留档） |

## 触发方式

在支持 Agent Skill 的对话中，以以下任一方式触发：

```
/help-fix <描述或链接>
/help-fix https://jira.example.com/browse/XX-1234
帮我看看这个 bug，批量导出会卡住
帮忙排查一下 https://zentao.example.com/zentao/bug-view-100.html
看下这个报错 https://fe-monitor.example.com/issues/500
```

若只要解释概念、不排查代码，Skill 不会自动启动。

## 支持的报告链接类型

| 类型 | URL 格式 |
|------|---------|
| 禅道 | `https://zentao.jiandan100.cn/zentao/bug-view-*.html` |
| Jira | `https://jira.jiandan100.cn/jira/browse/JDRW-*` |
| 前端监控 | `https://fe-monitor.jd100.com/easytech/issues/*?project=*` |

## 报告链接读取方式

分析阶段使用 **Codex 插件的浏览器控制能力** 读取报告链接内容：复用用户当前浏览器里的既有登录态，只做只读查看，不提交、编辑、删除或流转任何页面内容。

执行边界：

- 打开报告链接后，只读取标题、描述、复现步骤、评论、堆栈、环境和附件说明等与 bug 相关的可见信息。
- 如果页面显示登录、权限错误、网络错误或空白页，立即停止链接分析并向用户报告阻塞点。
- 不主动要求用户粘贴页面内容。
- 不主动使用 API token、`curl` 或未文档化接口请求报告链接。
- 不主动调用 `tools/get-link-content.mjs` 作为分析流程的一部分；该脚本仍保留在仓库中，用于手动调试和历史兼容。

## 工具（`tools/`）

tools 目录下只有 `.mjs` 脚本，不含其他配置文件（依赖统一在本目录的 `package.json` 中）。

### `tools/create-branch.mjs`

从指定 Git 基线（分支 / tag / commit）创建修复分支，分支名自动按 `fix-YYMMDD-HHmm` 格式生成。

- 未知参数、重复的 `--base` / `--prefix` / `--cwd`，以及这些参数缺值时，脚本会直接报错退出。
- `--fetch --dry-run` 只预览命令，不会真实更新远端引用；如果目标 ref 需要先 `fetch` 才能在本地解析，脚本会打印提示而不是误报创建失败。

```bash
# 在目标仓库根目录运行
node path/to/help-fix-bug/tools/create-branch.mjs --base main
node path/to/help-fix-bug/tools/create-branch.mjs --base v1.2.5 --dry-run
node path/to/help-fix-bug/tools/create-branch.mjs --help
```

参数说明：

| 参数 | 说明 |
|------|------|
| `--base <ref>` | 必选。修复分支的起点；可传分支名、tag、commit SHA、`origin/xxx`。若传 `1.2.5` 这类版本号，会额外尝试同名 tag、`v1.2.5`、`refs/tags/*` |
| `--prefix <s>` | 分支名前缀，默认 `fix`；最终分支名格式为 `prefix-YYMMDD-HHmm` |
| `--cwd <path>` | 指定目标 git 仓库目录；默认当前目录，也可用环境变量 `GCL_REPO_ROOT` 提供默认值 |
| `--fetch` | 建分支前先执行 `git fetch --prune`，适合基线在远端且本地 refs 可能过旧时使用 |
| `--dry-run` | 只打印将要执行的 git 命令，不真正创建和切换分支 |
| `--allow-dirty` | 默认工作区有未提交修改会拒绝执行；加上这个参数后允许在 dirty worktree 上继续 |
| `-h`, `--help` | 打印帮助并退出 |

补充说明：

| 行为 | 说明 |
|------|------|
| 参数校验 | 未知参数、重复的 `--base` / `--prefix` / `--cwd`，以及这些参数缺值时，脚本会直接报错退出 |
| `--fetch --dry-run` | 只预览命令，不会真实更新远端引用；如果目标 ref 需要先 `fetch` 才能在本地解析，脚本会打印提示而不是误报创建失败 |
| 时间来源 | 分支名中的 `YYMMDD-HHmm` 取执行脚本时的本地时间 |

### `tools/get-link-content.mjs`

用 **Playwright** 抓取报告链接页面内容，并保存 HTML / MHTML / PNG 文件供 AI 分析或人工核对。当前 Skill 的分析流程默认不再调用该脚本；它保留为手动调试/历史兼容工具。

对于禅道的壳页式页面，脚本会优先抓运行中的 iframe 内页：`--html` 保存 iframe DOM 并把页面内图片下载到同名 `.assets/` 目录，`--screenshot` 保存 iframe 画面，`--mhtml` 暂不支持并会打印提示跳过。

**自动登录检测**：

1. 先以**无头**模式访问 URL（复用持久化登录态）
2. 若检测到登录页（URL/标题/密码框）→ 弹出**有头**浏览器，用户完成登录后按 Enter
3. 关闭有头浏览器（登录 Cookie 已写入 `userDataDir`），**无头**重新抓取

```bash
# 在 help-fix-bug/ 目录下运行（已 pnpm install）
node tools/get-link-content.mjs --url "https://jira.example.com/browse/XX-1"
node tools/get-link-content.mjs "https://zentao.example.com/zentao/bug-view-1.html" --mhtml --screenshot
node tools/get-link-content.mjs "https://zentao.example.com/zentao/bug-view-1.html" --out /tmp/issue
node tools/get-link-content.mjs --help
node tools/get-link-content.mjs --html --mhtml --screenshot --url "https://zentao.jiandan100.cn/zentao/bug-view-59434.html"
node tools/get-link-content.mjs --html --mhtml --screenshot --url "https://fe-monitor.jd100.com/easytech/issues/28287?project=8"
node tools/get-link-content.mjs --html --mhtml --screenshot --url "https://jira.jiandan100.cn/jira/browse/JDRW-130833"
```

参数说明：

| 参数 | 说明 |
|------|------|
| `<URL>` | 位置参数。目标地址，必须是 `http://` 或 `https://`；与 `--url <URL>` 二选一 |
| `--url <URL>` | 显式传 URL，和位置参数等价 |
| `-h`, `--help` | 打印帮助并退出 |

输出与目录：

| 参数 | 说明 |
|------|------|
| `--out <stem>` | 指定输出前缀；脚本会自动追加 `.html` / `.mhtml` / `.png` |
| `--res-dir <path>` | 未指定 `--out` 时，结果文件保存到该目录；默认取环境变量 `GCL_RES_DIR`，否则为 `~/.get-link-content-res` |

输出格式：

| 参数 | 说明 |
|------|------|
| `--html` | 保存 HTML 快照；默认启用。禅道页面会额外下载图片到同名 `.assets/` 目录 |
| `--mhtml` | 保存 MHTML 快照；禅道页面暂不支持，会打印提示并跳过 |
| `--screenshot` | 保存整页 PNG 截图 |

浏览器与登录态：

| 参数 / 环境变量 | 说明 |
|------|------|
| `--browser <path|name>` | 指定浏览器。可传绝对路径，或 `chrome-for-testing`、`chrome`、`edge`、`msedge`、`chromium` |
| `--user-data-dir <path>` | 指定独立的 Playwright 持久化 profile 目录，用于复用登录态；默认取环境变量 `GCL_USER_DATA_DIR`，否则为 `~/.get-link-content-profile` |
| `GCL_EXECUTABLE_PATH` | 环境变量。强制浏览器可执行文件路径，优先级高于 `--browser` 和自动探测 |
| `GCL_USER_DATA_DIR` | 环境变量。未传 `--user-data-dir` 时，作为默认登录态目录 |
| `GCL_RES_DIR` | 环境变量。未传 `--res-dir` 时，作为默认结果目录 |

页面加载与模式：

| 参数 | 说明 |
|------|------|
| `--wait-until <event>` | `page.goto` 等待事件，默认 `domcontentloaded` |
| `--timeout-ms <n>` | 导航超时，默认 `60000` 毫秒 |
| `--headed` | 始终有头模式（手动操作后按 Enter 再抓取） |
| `--headless` | 始终无头，跳过登录检测 |
| `--extra-wait-ms <n>` | 导航后额外等待，默认 `3000`（适合懒加载 SPA） |

补充说明：

| 行为 | 说明 |
|------|------|
| 默认格式 | 若 `--html` / `--mhtml` / `--screenshot` 三者都未显式传入，则默认只保存 `--html` |
| 浏览器选用顺序 | 未传 `--browser` 且未设置 `GCL_EXECUTABLE_PATH` 时，会依次尝试 Chrome for Testing → Chrome Stable → Chrome channel → Edge channel → Playwright bundled Chromium |
| 自动登录检测 | 默认先无头访问 URL；若识别为登录页，会自动弹出有头浏览器让用户登录，再切回无头重新抓取 |
| 成功输出 | 成功时每个生成文件路径会打印到 `stdout`；`stderr` 会输出最终 URL、页面标题和各文件大小摘要 |

### `tools/doctor.mjs`

快速自检本机是否满足 Skill 运行条件：Node.js、git、当前目录 git 仓库状态、`playwright` 依赖、浏览器可执行文件命中情况。

```bash
cd help-fix-bug
node tools/doctor.mjs
pnpm run doctor
```

## 安装（首次使用）

工具脚本依赖 `playwright`，需先在本目录安装依赖：

```bash
cd help-fix-bug
pnpm install
pnpm run doctor
```

## 目录结构

```
help-fix-bug/
├── SKILL.md                 # Agent Skill 入口（触发条件、工作流索引）
├── README.md                # 本文件
├── package.json             # Node 依赖与 doctor 脚本
├── prompts/
│   ├── comprehend.md        # 步骤 1：了解 Bug
│   ├── analyze.md           # 步骤 2：分析 Bug
│   ├── fix.md               # 步骤 3：修复 Bug
│   └── summarize.md         # 步骤 4：总结 Bug
└── tools/
    ├── create-branch.mjs    # 创建修复分支
    ├── doctor.mjs           # 自检运行环境
    └── get-link-content.mjs # 抓取报告链接内容
```

## 安全注意事项

- 不在仓库中存储账号密码、Cookie、API Token
- `get-link-content.mjs` 的登录态仅落在本机 `userDataDir`（默认 `~/.get-link-content-profile`）
- 含内网地址或业务细节的抓取结果（如 `/tmp/issue.html`、`/tmp/issue.mhtml`）**不要提交到公开仓库**
