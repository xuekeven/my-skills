# 总结 bug

## 用户交互

- 在分析与修复 bug 已完成后，询问用户是否输出一份结构化总结，便于工单回填、评审与留档。
  - 如果不需要，整个 SKILL 流程结束
  - 如果需要，按照下面的“文档模板”生成文档
  - 如果需要，用户告诉文档名以及保存在何处，按照用户要求新建并生成文档
  - 如果需要，用户未告诉文档名，默认按照分支名创建 markdown 文件 `bug-report-${YYMMDD}-${HHmm}.md` 作为文档名。
  - 如果需要，用户未告诉文档保存在何处，默认保存在用户当前工作区下。

模板：

```
当前 bug 已修复！是否需要总结沉淀此 bug 为文档，便于工单回填、评审与留档？如果需要，请告诉我。

默认会以 `bug-report-${YYMMDD}-${HHmm}.md` 作为文档名保存在当前工作区下。如果需要其他的命名方式保存在其他目录，请告诉我。
```

## 文档模板

按下面结构生成 Markdown 文档；无内容的节可写「无」或省略该节。两列表格左侧标题列使用 `<span style="white-space: nowrap;">...</span>`，避免 VS Code 等 Markdown 预览器把中文标题逐字换行。

---

# Bug 修复报告：${bug_appear_baseline} · ${YYMMDD}-${HHmm}

## 概述


| <span style="white-space: nowrap;">项目</span> | 内容 |
| --- | --- |
| <span style="white-space: nowrap;">现象</span> | ${现象简述} |
| <span style="white-space: nowrap;">严重度</span> | ${严重度，如"阻断主流程 / 部分用户受影响 / 偶现视觉问题"} |
| <span style="white-space: nowrap;">代码基线</span> | ${bug_appear_baseline} |
| <span style="white-space: nowrap;">出现时间</span> | ${bug_appear_time} |
| <span style="white-space: nowrap;">原始描述</span> | ${bug_user_desc} |
| <span style="white-space: nowrap;">修复分支</span> | fix-${YYMMDD}-${HHmm} |
| <span style="white-space: nowrap;">修复用时</span> | ${从开始分析到用户确认修复完成的耗时；若无法精确计算，写约 X 小时/分钟或"未记录"} |


## 环境

| <span style="white-space: nowrap;">项目</span> | 内容 |
| --- | --- |
| <span style="white-space: nowrap;">客户端</span> | ${浏览器/App WebView 及版本，若已知} |
| <span style="white-space: nowrap;">服务端</span> | ${与问题相关的环境，若已知} |
| <span style="white-space: nowrap;">信息来源</span> | ${用户口述 / Jira 链接 / 禅道链接 / 前端监控链接 / 代码推断} |

## 复现

| <span style="white-space: nowrap;">项目</span> | 内容 |
| --- | --- |
| <span style="white-space: nowrap;">步骤</span> | 1. ${前置条件（登录态、数据、开关等）} <br /> 2. ${操作步骤} <br /> 3. …… |
| <span style="white-space: nowrap;">期望</span> | ${期望行为} |
| <span style="white-space: nowrap;">实际</span> | ${实际现象} |
| <span style="white-space: nowrap;">频率</span> | ${必现 / 偶现（触发条件：……）} |

## 根因分析

| <span style="white-space: nowrap;">项目</span> | 内容 |
| --- | --- |
| <span style="white-space: nowrap;">主因</span> | ${一句话结论} |
| <span style="white-space: nowrap;">证据链</span> | ${关键日志 / 堆栈 / 接口返回（使用 `startLine:endLine:path` 引用代码）}<br />${事实标注：来自工单 / 监控可核对}<br />${推断标注：根据代码路径推出} |
| <span style="white-space: nowrap;">同类排查</span> | ${仓库内是否存在相同反模式；若已扫描，写结论；若未扫，写建议后续项} |

## 修复方案

| <span style="white-space: nowrap;">项目</span> | 内容 |
| --- | --- |
| <span style="white-space: nowrap;">采用方案</span> | ${方案描述} |
| <span style="white-space: nowrap;">变更摘要</span> | `${path/to/file}`：${改动一两句话}<br />`${path/to/another-file}`：${改动一两句话} |
| <span style="white-space: nowrap;">未本次修复的同类问题</span> | ${列出或写"无"} |

## 测试回归

| <span style="white-space: nowrap;">项目</span> | 内容 |
| --- | --- |
| <span style="white-space: nowrap;">验证步骤</span> | 1. ${操作步骤}<br />2. ……<br />3. 预期结果：${……} |
| <span style="white-space: nowrap;">回归注意点</span> | ${相邻功能、边界数据、发布 / 配置依赖} |

## 后续与风险

| <span style="white-space: nowrap;">项目</span> | 内容 |
| --- | --- |
| <span style="white-space: nowrap;">待办</span> | ${需产品 / 后端 / 运维配合的事项，若无写"无"} |
| <span style="white-space: nowrap;">上线风险</span> | ${说明} |
| <span style="white-space: nowrap;">回滚方式</span> | ${回滚 commit / feature flag / 脚本逆操作等，若无写"无"} |
| <span style="white-space: nowrap;">工单回复</span> | ${1～3 句，含根因 + 修复点 + 验证结论，脱敏处理敏感路径或参数} |
