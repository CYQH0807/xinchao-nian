# Ombre 与心潮念本地方法清单

本文档对应本地集成基线：Ombre Brain v3.6.3 + 心潮念 3.2.0。

## 暴露关系

外部 Agent 只连接心潮念的 `/mcp`。心潮念会从本地 Ombre 的 `tools/list` 读取实时 schema，
再按下面的白名单转发；因此参数以运行中的 Ombre 为准，本文档记录的是稳定的公共方法面。

| 范围 | 方法 | 说明 |
| --- | --- | --- |
| 心潮念 | `xinchao_context` | 读取当前窗口的动态短态、近期连续性和可选长期记忆 |
| 心潮念 | `xinchao_event` | 记录一次真实互动并结算窗口状态 |
| 心潮念 | `xinchao_handoff_note` | 保存有界、短期的交接便签 |
| 心潮念 | `xinchao_pending_create` | 创建待交付内容，不决定留下或放下 |
| 心潮念 | `xinchao_pending_consumed` | 回执内容已经真实说出口 |
| 心潮念 | `xinchao_hold_status` | 查询默认异步 `hold` 的任务状态和最终 bucket ID |
| 心潮念 | `xinchao_hold_retry` | 手动重新排队失败的 `hold` 任务 |
| 心潮念 | `xinchao_personality_reflect` | 写入月度 14 维性格内核自评 |
| 心潮念 | `xinchao_personality_stats` | 读取性格内核统计，可选读取原因 |
| 心潮念 | `xinchao_anchor_update` | 更新性格内核的私有底线锚点 |
| 心潮念 | `xinchao_cabin_inbox` | 读取已解锁的小屋来信 |
| 心潮念 | `xinchao_cabin_note` | 给用户保存一封小屋来信 |
| 心潮念（可选） | `board_post` | 在配置 `XINCHAO_BOARD_TOKEN` 后向公共留言板发帖 |
| 心潮念（可选） | `board_read` | 在配置 `XINCHAO_BOARD_TOKEN` 后读取公共留言板 |

## Ombre v3.6.3 基础方法

这 16 个方法在 Ombre 的同一个 MCP `/mcp` 上注册，也会由心潮念代理：

| 方法 | 作用 | 写入/风险边界 |
| --- | --- | --- |
| `breath` | 默认自然浮现记忆 | 只读召回 |
| `breath_search` | 关键词/语义检索记忆 | 只读检索 |
| `breath_advanced` | 带完整过滤条件的检索/目录 | 只读检索 |
| `hold` | 默认异步沉淀一条重要记忆，先返回 `job_id` | 后台新增/合并记忆；用 `xinchao_hold_status` 查询结果 |
| `grow` | 整理长文本并拆分导入多条记忆 | 新增/合并记忆；支持新版幂等重试 |
| `trace` | 修改元数据、正文局部内容、关系和生命周期 | 普通写入；同时承载归档/恢复/测试数据硬删除 |
| `dream` | 读取近期变动记忆供消化 | 读取 |
| `anchor` | 设置记忆坐标系锚点 | 更新锚点状态 |
| `release` | 解除记忆坐标系锚点 | 更新锚点状态 |
| `pulse` | 读取记忆库总体状态 | 只读摘要 |
| `plan` | 登记待办/承诺/未闭环事项 | 新增计划 |
| `letter_write` | 写一封长期保存的信 | 新增信件，可设锁 |
| `letter_lock_update` | 调整已有信件的锁 | 更新锁状态，不改正文 |
| `letter_read` | 检索历史信件 | 只读信件 |
| `feel` | 按当前主题找回过去的感受 | 只读检索 |
| `I` | 读取或沉淀自我认知 | 读取或新增候选认知 |

## 可选 Ombre 方法

`You` 和 `Them` 不是固定注册的工具。它们分别受 Ombre Dashboard 中的持久开关控制：

- `You`：读取或沉淀模型对人类一方的长期认识。
- `Them`：读取或沉淀模型对其他人的长期认识。

开关关闭时，方法从 Ombre 和心潮念的 `tools/list` 中完全消失；打开时心潮念会按实时 schema
代理它们。两者的 `delete_id` 是撤回认识条目，不是记忆桶物理删除。

## 破坏性操作边界

新版不再暴露独立的 `purge`、`forget`、`restore` MCP 方法。心潮念也不会把旧方法伪装成新版：

1. `trace(delete=True)` 只把记忆移入归档并标记 `deleted_at`，不物理删除 Markdown。
2. `trace(restore=True)` 单独恢复归档记忆；有保护冲突时必须按 Ombre schema 一并解除冲突。
3. `trace(hard_delete=True, delete_reason="...")` 只允许清理创建时明确标记为 `test_data=True`
   的测试桶；普通记忆、计划和归档内容不会因为误传参数而被顺带删除。
4. `delete`、`hard_delete`、正文局部替换和 `restore` 的参数冲突由新版 Ombre 在写入前拒绝。

因此，本地验证可以创建带 `test_data=True` 的测试桶并硬删除；真实记忆仍遵循归档边界。

## 心潮星图兼容 HTTP 接口

这两个接口不是给外部 Agent 的 MCP 方法，只供同一 Docker 网络里的心潮 sidecar 使用，均要求
`OMBRE_MCP_SERVICE_TOKEN` 的 Bearer token：

- `GET /api/bucket-map`：最多返回 800 条元数据星表，不返回正文、`content_preview` 或 `why_remembered`。
- `GET /api/bucket-preview/{bucket_id}`：只返回指定桶最多 7 行非空正文，且拒绝归档桶和非法 ID。

## 本地数据范围

- Ombre 代码快照：`ombre-brain/`，来源为相邻本地仓库 Ombre-Brain 的 v3.6.3 兼容分支。
- Ombre 数据：Docker 命名卷 `ombre-buckets`。
- 心潮状态：Docker 命名卷 `xinchao-state`。
- 本集成不要求、不执行远端 push；远端 Fork 仍可由后续人工决定何时提交。
