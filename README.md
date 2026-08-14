# NLKaleido · 万花筒（SillyTavern 扩展）

契约约束下的 **Agent 变量托管系统**——正文生成结束后，变量 Agent 在契约护栏内自主维护角色卡状态（好感/关系/背包/世界阶段…），本地引擎负责调度、裁决、回滚与保护。前缀分片缓存（L0-L3）保证变量请求的 KV-Cache 命中，最大程度省钱。

零依赖：不依赖 tavern-helper、不修改 ST 主仓库、运行时无任何 MVU 命令体系。

## 安装（酒馆内）

1. 打开酒馆 **扩展** 面板 → **Install extension**
2. 粘贴本仓库 Git URL（例如 `https://github.com/<你的账号>/NLKaleido`）
3. 安装后刷新页面即生效

## 使用

- **玩家模式（默认）**：聊天正文生成结束后自动触发变量更新；面板状态板显示当前变量与待复核数量，开箱即用（需先在作者模式配置契约）。
- **作者模式**：面板左上角切「作者模式」→
  - **契约编辑器**：粘贴/编辑契约 JSON（字段 + 更新规则 + 护栏），保存即校验生效；
  - **预览**：状态表（full/summary/incremental）与观察层预览（Agent 本轮可见字段）；
  - **调试**：changelog diff / 单条回滚 / pending 接受或丢弃；
  - **导出**：一键下载 `{contract, stat_data, changelog}` 打包 JSON。

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
  "invariants": []
}
```

## 运行时 API（作者扩展）

`window.NLKaleido` 暴露：`getState()` / `getContract()` / `dispatch({action, ...})`。
事件（经 ST eventSource）：`nlkaleido:status_changed` / `nlkaleido:pending_updated` / `nlkaleido:contract_changed` / `nlkaleido:metrics`。

## 技术说明

- 变量请求走 ST 原生 `generateRawData`（非流式，经后端原样透传，读 `usage.prompt_cache_hit_tokens` 做缓存命中埋点）；
- 结构化输出经 `CHAT_COMPLETION_SETTINGS_READY`（stringify 前最后一站）注入 `json_schema`，不传参以保留完整响应（含 usage）；
- 触发锚点 = `GENERATION_ENDED`（覆盖成功/报错/中止/工具循环收尾），带消息完整性与中止标记双守卫；
- 状态存 `chatMetadata.variables['nlkaleido']`（聊天级）；run/global 层存 `extensionSettings.variables.global['nlkaleido:*']`；
- 全部设计文档见《万花筒交接稿.md》（§0-§24）。

## 构建（开发者）

```bash
npm install
npm test        # 198 测试
npm run build   # tsc → rollup → release/dist/index.js
```

## License

MIT
