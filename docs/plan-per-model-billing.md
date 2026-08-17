# plan-per-model-billing（已批准，2026-08-15）

## 需求（用户原话要点）

- "能根据 api 拉计费吗，手动更新不现实" → 余额必须官方接口自动拉
- "切了 flash 或者 pro 两者的用量都能显示" → 分模型用量，本会话内
- "计费最准的肯定是官方 api 后台" → 经调研：官方仅有余额接口，无分模型明细/价格 API
- 最终范围（用户确认）：**官方余额自动拉取 + 分模型用量（本会话）**，不做费用估算

## 关键决策记录

1. **余额**：`credentials.resolve("DEEPSEEK_API_KEY")` → `GET https://api.deepseek.com/user/balance`
   （Bearer、5s 超时、60s 缓存、失败返回 null 显示 `--`）；key 不出机器
2. **分模型用量**：注册 `perModelUsage` 投影单元（与官方 token-meter 同机制），
   `request/header` 顺序标记当前模型；同一 (轮,步) 重复样本**替换**语义（防双计）
3. **不做**：费用估算（无官方价格 API，社区方案是爬 HTML，脆弱）、跨会话统计、余额之外
   的官方消费明细（无 API）
4. **验证**：`scripts/replay-permodel.mjs` 重放真实日志，与独立参照折叠对账 +
   分模型之和 == 官方 tokenUsage 总量（已实测一致：441415 / 40422912 / 200474）
5. **生效方式**：host 侧改动需重启 dsh web（最后一步脚本化执行，会话自动恢复）

## 验收清单（重启后）

- [x] 面板状态行出现 💰 余额（官方数据：实测 ¥161.37）
- [x] 「分模型」小节出现（flash：7 次请求 · ↑65.8M ↓260.8k · 缓存 99%）
- [x] 分模型之和与用量总量对账一致（重放脚本 + 官方 tokenUsage 双对账）
- [x] 现有 Git/MCP/Skills/用量 无回归
- [x] 重启后踩坑记录：`balance !== null` 在 balance 为 undefined（数据未到）时也成立，
  会读 `undefined.currency` 崩溃整个面板 → 必须用 `!= null` 宽松判断（已修，commit 已推送）
