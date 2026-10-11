---

name: help-fix-bug
description: 系统性排查并修复缺陷：澄清现象与复现、收集证据（日志/报错/环境）、缩小范围、提出最小修复并验证。仅当用户消息以 /help-fix 或 $help-fix-bug 开头时触发；前缀后可接具体问题描述、禅道/Jira/前端监控警告链接，或 https://*.jd100.com/* 产品 H5 链接。
allowed-tools: Read, Write, Edit, Bash

---

# 排查解决问题（Help Fix Bug）

## 触发条件

仅当对话以以下任一前缀开头时，**主动按本 Skill 流程执行**：

- 以 `/help-fix` 开头（可带空格后接**具体问题描述**、**问题报告链接**、**项目产品链接**，可组合，也可为空）
- 以 `$help-fix-bug` 开头（可带空格后接**具体问题描述**、**问题报告链接**、**项目产品链接**，可组合，也可为空）

其他自然语言求助表达（如「帮我看看这个 bug」「帮忙排查一下」「看下这个报错」等）不触发本 Skill，除非消息同时满足上述前缀条件。

**报告链接**（`*` 表示可变片段）：

- 禅道：`https://zentao.jiandan100.cn/zentao/bug-view-*.html`  
示例：`https://zentao.jiandan100.cn/zentao/bug-view-59554.html`
- Jira：`https://jira.jiandan100.cn/jira/browse/JDRW-*`  
示例：`https://jira.jiandan100.cn/jira/browse/JDRW-129337`
- 前端监控警告：`https://fe-monitor.jd100.com/easytech/issues/*?project=*`  
示例：`https://fe-monitor.jd100.com/easytech/issues/24150?project=10`

**产品链接**（`*` 表示可变片段）：

- `https://*.jd100.com/*`（子域名为占位，路径与查询串可变）  
示例：`https://jdldoq.jd100.com/checkQuestion?subjectId=3&questionId=61599`

若用户明确只要解释概念、不要做排查，则不要强行套本流程。

## 目标

根据用户提供的信息，首先分析定位 bug 产生原因并报告给用户，然后等用户实际手动复现和确认原因，之后再给出多种（如果有）可验证的修复方案并报告给用户，然后等用户选择方案和确认解决 bug，之后排查整个项目是否存在相同的问题，最终总结生成 bug 报告。

## 工作流

### 1. 了解bug

先读取并遵循 `./prompts/comprehend.md`，再开始“了解 bug”阶段。

### 2. 分析bug

在完成“了解 bug”阶段后，读取并遵循 `./prompts/analyze.md`，再开始“分析 bug”阶段。

### 3. 修复bug

在完成“分析 bug”阶段且用户确认原因后，读取并遵循 `./prompts/fix.md`，再开始“修复 bug”阶段。

### 4. 总结bug

在完成“修复 bug”阶段且用户确认问题已解决后，读取并遵循 `./prompts/summarize.md`，再开始“总结 bug”阶段。

## 与用户沟通方式

- 所有的提问/交互/问答模板，默认视为**要直接发给用户的原始话术**；除非用户已经提供了其中一部分信息，否则不要擅自压缩、概述、改写成更短版本，也不要删掉关键限定条件、示例、默认值说明和提示语
- 只有在**已经向用户明确提问之后**，且用户明确表示“留空”“默认”“按当前分支”“按今天”“不清楚，先这么记”这类意思时，才允许采用对应的定义的默认值
- 解答时，先列出bug详情，然后说**结论或当前最可能原因**，再给**证据链**（日志行、代码引用）
- 阻塞时明确阻塞点（需用户本机权限/密钥/业务数据时如实说明），并写出 **缺少什么信息**、**谁能提供**、**下一步应该怎样**

## 示例触发话术（等价即启用）

- `/help-fix 登录后偶发 401`
- `/help-fix https://zentao.jiandan100.cn/zentao/bug-view-59554.html`
- `/help-fix https://jdldoq.jd100.com/checkQuestion?subjectId=3&questionId=61599`
- `$help-fix-bug 批量导出会卡住`
- `$help-fix-bug https://jira.jiandan100.cn/jira/browse/JDRW-129337`
- `$help-fix-bug https://fe-monitor.jd100.com/easytech/issues/24150?project=10`
