# 测试题目

这些文件用于逐个验证 `get-red-book-evaluate` Skill 的触发、模式识别、参数提取、数量边界和报告模板路由。每个题目文件中的“测试题目”保持原始请求；“预期解析”只用于测试时核对，不是发给 Skill 的额外指令。

| 编号 | 模式 | 主题 | 特殊参数 | 文件 |
| --- | --- | --- | --- | --- |
| 实体1 | 实体 | 华为 | 默认时间、IP 和数量 | [01-entity-huawei.md](01-entity-huawei.md) |
| 商品1 | 商品 | iPhone 17 Pro Max | 默认时间、IP 和数量 | [02-product-iphone-17-pro-max.md](02-product-iphone-17-pro-max.md) |
| 事件1 | 事件 | 衡阳老人进店休息离世事件 | 默认时间、IP 和数量 | [03-event-hengyang-store-death.md](03-event-hengyang-store-death.md) |
| 品类1 | 品类 | 新能源汽车 | 默认时间、IP 和数量 | [04-category-nev.md](04-category-nev.md) |
| 实体2 | 实体 | 雷军 | 近一年、深圳 IP、10 个目标有效帖 | [05-entity-lei-jun-shenzhen.md](05-entity-lei-jun-shenzhen.md) |
| 实体3 | 实体 | 雷军 | 近一年、上海 IP、10 个目标有效帖 | [06-entity-lei-jun-shanghai.md](06-entity-lei-jun-shanghai.md) |
| 商品2 | 商品 | 小牛 MT Sport 2026 | 近 3 个月、20 个目标有效帖 | [07-product-niumotors-mt-sport-2026.md](07-product-niumotors-mt-sport-2026.md) |
| 商品3 | 商品 | 九号 FZ110 | 近 3 个月、20 个目标有效帖 | [08-product-ninebot-fz110.md](08-product-ninebot-fz110.md) |
| 事件2 | 事件 | 刘翔买断还是安置事件 | 默认时间、IP 和数量 | [09-event-liu-xiang-buyout-placement.md](09-event-liu-xiang-buyout-placement.md) |
| 事件3 | 事件 | 西藏吉隆口岸附近泥石流重大伤亡事件 | 默认时间、IP 和数量 | [10-event-jilong-landslide.md](10-event-jilong-landslide.md) |
| 品类2 | 品类 | 洗碗机 | 15 个目标有效帖 | [11-category-dishwasher.md](11-category-dishwasher.md) |
| 品类3 | 品类 | AI Agent 工程师 | 15 个目标有效帖 | [12-category-ai-agent-engineer.md](12-category-ai-agent-engineer.md) |

未指定数量的题目按 Skill 默认值执行：目标有效帖 8 篇、实时打开贴最多 10 篇、最多查看贴累计最多 30 篇。
