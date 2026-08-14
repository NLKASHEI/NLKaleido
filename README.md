# NLKaleido · 万花筒（SillyTavern 扩展）

契约约束下的 **Agent 变量托管系统**——正文生成结束后，变量 Agent 在契约护栏内自主维护角色卡状态（好感/关系/背包/世界阶段…），本地引擎负责调度、裁决、回滚与保护。前缀分片缓存（L0-L3）保证变量请求的 KV-Cache 命中，最大程度省钱。

在此基础上提供四个**作者可选、默认关闭**的平台能力：**长期记忆（M13）**、**剧情编排引擎（M15）**、**检定系统（M16）**、**MVU 存量卡迁移脚手架（M9）**，以及**玩家一键配置（M14，极简档零配置直用）**。

零依赖：无需任何第三方脚本框架、不修改 ST 主仓库、运行时无任何外部命令体系、禁 eval/new Function。

## 安装（酒馆内）

1. 打开酒馆 **扩展** 面板 → **Install extension**
2. 粘贴本仓库 Git URL（例如 `https://github.com/<你的账号>/NLKaleido`）
3. 安装后刷新页面即生效

## 使用

- **首次进入**：先选择“我是玩家”或“我是作者”，之后可随时切换。
- **玩家模式**：直接显示当前角色与世界状态，不暴露作者设置。
- **作者模式**：使用带用途说明的向导定义变量、AI 更新方式、玩家显示和前端写入权限；列表、键值表、对象均可视化构造，复杂 JSON、变量预览与审计工具收在高级区。
  - **导出**：一键下载 `{contract, stat_data, changelog}` 打包 JSON。
- **记忆（M13）**：契约声明 `memory: { enabled: true }` → 反思写入（同一变量请求）+ BM25 检索 + L3 记忆段注入 + 遗忘状态机 + 记忆表（面板「记忆」页签浏览/手动归档/检索）。
- **剧情（M15）**：契约声明 `plot: { enabled: true }` → 事件链状态机（本地骰子 + API 双驱）+ 风声系统 + 区域事件（面板「剧情」页签手动推进/停滞/终局）。
- **检定（M16）**：契约声明 `dice: { enabled: true }` → roll/check/contest 检定引擎 + outcomes 结果分级 + AI 预设导入（tests 校验）+ 检定建议行（点击才执行，防奶人）。
- **迁移（M9）**：面板「迁移」页签粘贴 MVU 老卡世界书条目与 ZOD 脚本 → 检测 → 解析 → 提取规则 → 生成契约初稿（难翻译构造显式标注，不静默丢弃）→ 导入。
- **配置（M14）**：面板「配置」页签一键档位（极简/标准/进阶）+ 自动探测降级 + 连通性自检 + 快照回滚/恢复出厂；可切换深色、亮色、纸张或跟随酒馆主题。

变量 Agent 复用酒馆当前“API 连接”中的模型与密钥，无需在 NLKaleido 重复配置。到期变量默认要求模型
逐项给出“更新 / 不变”和依据，遗漏或结论与 patch 冲突会被拒绝并自动重试，避免 Agent 偷懒跳过。

### 契约最小示例

```json
{
  "version": 1,
  "id": "my-card",
  "schema": { "type": "object", "loose": true },
  "updateRules": {
    "角色.好感度": {
      "path": "角色.好感度", "type": "number", "default": 50,
      "updateMode": "every_turn", "dynamic": true, "display": true,
      "changeRule": "好感度：每次 ±0~3，特殊事件可大改"
    },
    "角色.关系阶段": {
      "path": "角色.关系阶段", "type": "string", "default": "陌生",
      "updateMode": "every_n_turns", "everyN": 3, "display": true,
      "changeRule": "关系阶段依据 ${角色.好感度} 推进"
    }
  },
  "displayRules": [{ "path": "角色.好感度", "render": "value" }],
  "guardrails": {},
  "invariants": [],
  "memory": { "enabled": true, "tables": [{ "id": "profile", "name": "角色档案", "columns": ["名字", "*初登场"] }] },
  "plot": { "enabled": true, "everyN": 5 },
  "dice": { "enabled": true }
}
```

## 角色卡前端变量 API

每个变量须由作者单独开启“允许前端脚本写入”。正式 API 会检查声明、类型、权限和跨变量约束，
并且 `await` 返回时已经完成派生计算、审计和保存：

```js
const value = NLKaleido.variables.get('角色.好感度');
const result = await NLKaleido.variables.set('角色.好感度', 80);
await NLKaleido.variables.setMany({ '角色.好感度': 80, '世界.阶段': '第一章' });
const declared = NLKaleido.variables.list();
const unsubscribe = NLKaleido.variables.subscribe((variables) => render(variables));
```

并发写入按调用顺序串行保存；保存失败会拒绝 Promise 并恢复内存状态。底层
`getState()` / `getContract()` / `dispatch()` 仅为内置管理界面和兼容用途保留。

事件（经 ST eventSource）：`nlkaleido:status_changed` / `nlkaleido:pending_updated` / `nlkaleido:contract_changed` / `nlkaleido:metrics` / `nlkaleido:run_changed` / `nlkaleido:achievement_unlocked` / `nlkaleido:memory_changed` / `nlkaleido:plot_changed` / `nlkaleido:dice_rolled` / `nlkaleido:config_changed`。

## 技术说明

- 变量请求走 ST 原生 `generateRawData`（非流式，经后端原样透传，读 `usage.prompt_cache_hit_tokens` 做缓存命中埋点）；
- 结构化输出经 `CHAT_COMPLETION_SETTINGS_READY`（stringify 前最后一站）注入 `json_schema`，不传参以保留完整响应（含 usage）；
- 触发锚点 = `GENERATION_ENDED`（覆盖成功/报错/中止/工具循环收尾），带消息完整性与中止标记双守卫；
- 状态存 `chatMetadata.variables['nlkaleido']`（聊天级）；run/global 层存 `extensionSettings.variables.global['nlkaleido:*']`；
- 记忆/剧情/检定存 chat 层独立键（默认关闭零开销）；配置中心存 `nlkaleido:config`（F12 持久化，configVersion 自动迁移）；
- **代码分包**：M9 迁移代码独立 chunk 按需加载，主 bundle 零迁移代码（默认关闭零开销为可测事实）；
- 全部设计文档见《万花筒交接稿.md》（§0-§24）与《验收核对.md》。

## 构建（开发者）

```bash
npm install
npm test        # 429 测试
npm run build   # tsc → rollup → release/dist/（index.js + chunks/）
```

## License

MIT
