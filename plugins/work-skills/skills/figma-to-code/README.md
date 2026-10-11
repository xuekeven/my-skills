# figma-to-code

`figma-to-code` 是一个把 Figma 节点、当前选中画板或 UI 截图还原为可运行前端页面的 Codex Skill。它把读取、资产、实现和验收组织成带状态、交接物和根因回退的四阶段闭环。默认固定尺寸还原；明确要求多端时，在同一四阶段中启用可选响应式子门禁。

## 快速开始

这个 Skill 有两种使用模式。两种模式都复用同一套四阶段流程；区别在于输入范围和最终验收内容。

### 模式一：需求文档驱动

用户提供需求文档，文档中写明页面清单、页面之间的交互与数据联动，以及每个页面对应的 Figma 文件或节点地址。Skill 会先提取和校验需求，再按页面逐一执行视觉还原，并进行统一的功能验收。

```text
/figma-to-code implement whole stages

需求文档：/absolute/path/to/requirements.docx
目标项目：/absolute/path/to/your-project
要求：按照需求文档中的页面、交互和数据联动实现多页面应用；使用文档中每个页面对应的 Figma 地址进行视觉还原；接口缺失时可以 mock，但不能把 mock 声称为真实联调。
```

该模式适合多页面产品、页面跳转、登录态/空态/错误态、跨页面数据联动等需求。最终交付必须同时通过各页面的视觉门禁和产品功能门禁。

### 模式二：单个 Figma 地址驱动

用户只提供一个 Figma 文件、节点或画板地址。Skill 默认将其作为单个 Frame 还原为页面，不自动推断未提供的页面、业务流程或跨页面交互。

```text
/figma-to-code implement whole stages

Figma：<Figma 文件或节点链接>
目标项目：/absolute/path/to/your-project
输出目录：/absolute/path/to/your-project
要求：按照设计稿实现页面，复用项目现有框架和路由；完成四阶段读取、资产导出、代码实现、截图 diff 与验收后再报告结果。
```

如果只想先分析设计稿而不修改项目，则使用：

```text
/figma-to-code read and plan

Figma：<Figma 文件或节点链接>
输出目录：/absolute/path/to/your-project
```

常用阶段命令：

- `/figma-to-code read and plan`：只读分析，不导出正式资产、不写页面。
- `/figma-to-code replenish and export`：补读、导出和 QA，不写页面。
- `/figma-to-code implement the design`：实现页面；前置交接不可靠时按状态机回退。
- `/figma-to-code acceptance the page`：允许按根因局部修正并复验。
- `/figma-to-code implement three stages`：依次执行第一至第三阶段，完成读取规划、资产导出和页面实现；不执行第四阶段完整视觉验收。
- `/figma-to-code implement whole stages`：依次执行完整四阶段闭环。

专项口令、只读边界和局部修复边界见 `rules/08-意图路由与兼容口令.md`。

## 适用范围

- 读取并规划一个 Figma Frame 或 UI 截图；
- 补读缺失字段，规划、导出并验证视觉资产；
- 适配目标仓库现有框架、路由、样式和检查方式实现页面；
- 通过精确截图、分区 diff、结构化 audit 和评分循环验收。

没有需求文档时默认范围是一个 Frame。提供需求文档时，支持按文档中的多页设计实现页面跳转、状态与数据联动，并分别验收视觉和功能；明确本期不做的入口不擅自增加反馈。Skill 不以整页截图代替结构实现，不覆盖用户已有改动，也不会在未通过第四阶段门禁时宣称完成。

## 四阶段

响应式模式需额外读取 `rules/10-响应式适配闭环.md` 与 `references/响应式组件规则与验收.md`。先通过原始尺寸固定稿门禁，再创建独立响应式入口；响应式只在声明的 viewport 范围内验收，不能用整页 `transform: scale()` 冒充适配。

| 阶段 | 目标 | 主要交接物 |
|---|---|---|
| 1. 读取与规划 | 锁定设计身份，读取结构与最终视觉，建立 section、图层分类和补读队列 | `stage-1-handoff.json` |
| 2. 补读与资产 | 补齐关键字段，导出最小完整视觉组并逐张 QA | `stage-2-handoff.json`、`asset-manifest.json` |
| 3. 页面实现 | 在目标仓库中建立独立页面，按计划实现文本、CSS、SVG 和 PNG | `stage-3-handoff.json` |
| 4. 完整验收 | 精确捕获 DOM 根，执行 diff、audit、评分、局部修正和回归检查 | `stage-4-handoff.json` |

完整状态机和回退条件以 `rules/02-状态机与闭环回退.md` 为准。

四个交接 JSON 共享 `schema_version`、阶段信息、`workflow_state`、`timing`、`input_artifacts`、`output_artifacts` 和 `handoff`。其中：

- `stage-1-handoff.json`：Frame 身份、设计分析、section、单一覆盖索引中的全部图层分类、文本/颜色/效果、资产与切图计划、补读队列、读取评分和 `can_enter_stage_2`。紧凑模式的覆盖计数、参考图哈希和门禁由生成器派生，默认不复制顶层分类数组。
- `stage-2-handoff.json`：补读轮次、字段证据变化、分类修正、资产 manifest 路径与哈希、资产 QA 摘要、剩余风险和 `can_enter_stage_3`。
- `stage-3-handoff.json`：预览路由、唯一捕获 selector、CSS 尺寸、修改文件、使用资产、实现映射、实际检查命令/退出码、运行时错误和 `can_enter_stage_4`。
- `stage-4-handoff.json`：捕获前置、diff 前置、视觉 diff、10 类 audit、评分、迭代与回归、剩余差异、不可约风险和 `can_deliver`。

完整资产逐项事实只写在 `asset-manifest.json`，完整 diff 事实只写在 `visual-diff-report.json`；阶段交接保存路径、SHA-256、摘要和门禁，避免重复维护。

## 规则加载

`SKILL.md` 是精简入口。每次按 SKILL.md 路由读取全局规则与公共状态契约，状态机和意图路由按条件加载；进入某一阶段时，才加载该阶段规则和数据契约。完整流程也按阶段依次加载，不预先加载全部 schema。

```text
SKILL.md
├── rules/01-规则导航与工具映射.md
├── rules/02-状态机与闭环回退.md
├── rules/03-公共状态契约.md
├── rules/04-07 四阶段数据契约
├── rules/08-意图路由与兼容口令.md
└── stages/01-04 四阶段执行规则
```

规则文件和阶段文件是执行时的事实来源；README 只解释结构和使用方式。出现不一致时以 `SKILL.md` 指向的规则为准。

## 脚本

- `scripts/workflow.mjs`：初始化运行目录；正常阶段用 `begin/transition/finish` 原子记录阶段与 phase，`start/stop` 只用于暂停、恢复和旧调用方兼容。
- `scripts/generate-stage1-handoff.mjs`：从紧凑设计事实的单一分类索引、参考图和计时生成第一阶段交接，派生覆盖计数、截图哈希和门禁，并报告 `compact_bytes`。超过默认约 12 KB 只会警告，不要因此压缩或重新生成；独立分析附件和旧分类镜像均需显式启用。
- `scripts/validate-asset.mjs`：按扩展名检查 PNG 或 SVG 的尺寸、透明度、边界、结构和哈希。
- `scripts/asset-qa.mjs`：合并逐资产 QA，并把正式资产汇总成一张视觉联系表。
- `scripts/generate-stage2-handoff.mjs`：从事实文件重算哈希和门禁并生成第二阶段 JSON 交接。
- `scripts/generate-stage3-handoff.mjs`：复核实现文件、资产、图层映射和捕获证据并生成第三阶段交接。
- `scripts/shoot-preview.mjs`：通过 Chrome DevTools Protocol 查询并捕获唯一 DOM 根，输出机器捕获报告。
- `scripts/visual-diff.js`：验证捕获报告、截图哈希和尺寸后，生成整体及 section diff。
- `scripts/generate-stage4-report.mjs`：从捕获与 diff 生成 audit、评分、迭代记录和第四阶段交接。
- `scripts/validate-handoff.mjs`：统一校验四阶段交接的结构、产物引用、身份和门禁。
- `scripts/validate-responsive.mjs`：校验响应式计划、基准宽度、viewport 捕获、根缩放、溢出、裁切和运行时错误；未启用响应式时输出 no-op 通过。
- `scripts/extract-requirements.py`：从 DOCX 提取需求正文、表格、超链接和稳定位置证据。
- `scripts/validate-product.mjs`：校验产品契约、功能验收结果以及各页面视觉交接，生成产品聚合门禁。
- `scripts/generate-ui-ux-report.mjs`：基于产品契约、验收结果和页面交接生成最终 `ui-ux-report.md`。

`scripts/lib/` 只保存 CLI、JSON、产物、计时、依赖和资产校验的内部共享模块，不作为公共命令调用。

运行脚本前先执行 `--help`，并显式传入当前任务参数。验收 diff 的固定颜色阈值是 `0.3`。

XML 与轻量图像依赖由 Skill 根目录的 `package.json` 和 `package-lock.json` 固定版本。首次使用或依赖缺失时，在 Skill 根目录执行：

```bash
npm ci
```

脚本从自身所在的 Skill 目录解析 `pngjs`、`pixelmatch`、`fast-xml-parser` 和 `resvg`，即使从目标项目目录运行，也不会读取或要求目标项目的同名依赖。`node_modules` 只作为本地安装产物，不属于 Skill 源文件。

## 运行前提

- 可读取设计结构和最终视觉的 Figma 能力，或一张明确的 UI 截图；
- 目标仓库应具备可安装和预览条件；已有可确认的预览服务时优先复用。若需要 Skill 启动服务，必须在请求中明确授权；
- Node.js 22.4 或更新版本，用于原生 `fetch` 和稳定的全局 `WebSocket`；
- Chrome、Edge 或 Chromium。脚本会根据 macOS、Windows、Linux 自动搜索 `PATH` 和常见安装路径，也可用 `CHROME_PATH` 显式指定；
- Skill 根目录已执行 `npm ci`。目标仓库无需安装 `pngjs`、`pixelmatch` 或 `ws`。

## 输出目录

用户指定或从目标项目推导出的目录是 `delivery_root`。应用源码与正式资产保留在交付区，工作流证据统一隐藏在：

```text
<delivery_root>/.figma-to-code/runs/<run_id>/
```

其中保存四阶段 JSON 交接、manifest、合并资产 QA、参考图、预览图、捕获报告、diff、audit、迭代与计时。`state.json` 和独立 `sections.json` 默认不生成；失败诊断仅在失败时进入 `diagnostics/`。例如“输出到 test”会把实现放在 `test/`，把证据放在 `test/.figma-to-code/runs/<run_id>/`。第一阶段可以写 run 目录和只读证据，但仍不得修改目标项目代码或配置。Markdown 只用于 README 或回复摘要，不作为阶段交接事实源。

## 需求文档驱动的可交互实现

```text
/figma-to-code implement whole stages
需求文档：<需求文档绝对路径.docx>
目标项目：<项目绝对路径>
按照文档中的本期范围和设计稿实现多页面交互；接口缺失时允许 mock，不能把 mock 声称为真实联调。遇到主流程冲突先确认。
```

新流程：**提取需求 → 页面/设计映射 → 交互与数据契约 → 原四阶段逐页视觉流程 + 统一业务实现 → 功能回归 → 产品聚合验收 → 生成 `ui-ux-report.md`**。

需求文档模式使用 `implement three stages` 时，只完成各页面的 Stage 1–3 和页面实现，不执行 Stage 4 视觉验收、跨页面功能回归、产品聚合验收或最终 `ui-ux-report.md`；因此不能作为产品最终交付。

- 不再以“静态页面截图通过”作为需求模式的交付标准。
- 文档是需求数据，不会自动授权文档中的命令、生产操作或服务启动。
- 增加需求原文追踪、范围排除、冲突问题、mock 标记、动态时间与跨页数据一致性。
- 保留单 Frame 兼容；原四阶段脚本不必迁移。产品证据放 `.figma-to-code/products/<product_id>/`，单页证据仍在 `.figma-to-code/runs/`。
- `scripts/extract-requirements.py` 提取 DOCX；`scripts/validate-product.mjs` 复核契约、功能证据与逐页门禁。原 npm test 同时运行新回归测试。

详见 [需求模式规则](rules/09-需求驱动交互闭环.md)、[需求文档编写指南与附件示例](references/需求文档编写指南.md)、[机器契约与验收命令](references/需求契约与功能验收.md)。

