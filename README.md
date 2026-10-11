# my-skills

个人可复用的 ChatGPT / Codex skills 集合，按效率类和工作类插件组织。

## 目录结构

```text
.
├── .agents/plugins/marketplace.json
├── plugins/efficiency-skills/
│   ├── .codex-plugin/plugin.json
│   └── skills/
│       ├── example/SKILL.md
│       └── get-red-book-evaluate/
└── plugins/work-skills/
    ├── .codex-plugin/plugin.json
    └── skills/
        ├── help-fix-bug/
        └── figma-to-code/
```

新增 skill 时，在对应插件的 `skills/` 下创建独立目录，并放入该目录自己的 `SKILL.md`。`get-red-book-evaluate`、`help-fix-bug` 和 `figma-to-code` 都保留了各自的辅助规则与资源。

## 本地使用

在支持本地插件市场的客户端中添加这个仓库，选择 `My Skills` 市场，按需安装 `Efficiency Skills` 和 `Work Skills`。市场名称仍为 `My Skills`，两个插件分别对应 `plugins/efficiency-skills/` 和 `plugins/work-skills/`。

如果使用 Codex CLI，可从仓库根目录注册本地市场：

```bash
codex plugin marketplace add .
```

修改插件后，刷新对应市场并重启客户端，在新对话中验证。客户端使用安装后的插件副本，不直接读取源目录。安装方式参考 [OpenAI 官方插件打包文档](https://developers.openai.com/plugins/build/plugins)。

## 工作类技能依赖

复制的技能保留源码、规则、提示、测试和依赖锁文件，不包含 `node_modules/`、Figma 的 `runs/` 或临时候选图片。首次使用需要脚本的功能时，在**实际安装的技能目录**安装依赖：

- `help-fix-bug`：使用 `pnpm install --frozen-lockfile`，可运行 `pnpm run doctor` 检查环境。
- `figma-to-code`：需要 Node.js 22.4 或更新版本，使用 `npm ci`，可运行 `npm test` 检查脚本。

运行产物和本地依赖由 `.gitignore` 排除；不要把它们提交到插件仓库。
