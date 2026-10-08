# 心潮的 MiniMax M3 接入

2026-10-08 本地配置使用心潮自己的 `ModelClient` 直接访问 MiniMax，不调用 DSH 的主对话模型。

| 配置 | 本地值 |
| --- | --- |
| `MODEL_ENABLED` | `true` |
| `MODEL_BASE_URL` | `https://api.minimaxi.com/v1` |
| `MODEL_NAME` | `MiniMax-M3` |
| `AGENT_NAME` | `汐`，与分类提示词的关系主体一致 |
| `MODEL_API_KEY` | 已写入被忽略的根目录 `.env`，不记录在文档中 |
| `INTERACTION_CLASSIFY_MIN_MINUTES` | 沿用 8 分钟 |
| `DREAM_ENABLED` | `true`，仍遵守现有睡眠、至少 24 小时间隔和每日上限 |
| `SHADOW_MODE` | `false` |
| `DAYTIME_EMERGENCE_ENABLED` | `true`，沿用 08–23 时、2–3 小时间隔、每天最多 7 次 |
| `DAYTIME_BARK_ENABLED` | `false` |
| `BARK_ENABLED` | `false` |
| `BRIDGE_SELF_SIGNALS` | 沿用现有 `true` |
| `ATTENTION_ENABLED` | 关闭 |

MiniMax 官方 [OpenAI 兼容接口](https://platform.minimax.io/docs/api-reference/text-openai-api)列出 `MiniMax-M3`，支持客户端当前使用的 `thinking: {type: disabled}`，因此可以直接生成简短 JSON。

## 三条路径

- 分类：xi-mind 回传真实 exchange，M3 判断互动类型，经私人词表核验后由心潮结算。8 分钟内的额外 exchange 会被节流，不补判。
- 梦境：达到现有梦境条件时，M3 根据 Ombre 材料及状态生成梦；原有梦境保存、余韵和念头池路径保留。
- 白昼内在念头：达到现有浮现条件后，把浮出的记忆交给 M3 整理成一句供主意识读取的内在念头，保留记忆桶来源后进已有池。失败、空输出或模型关闭时继续用记忆摘句。xi-mind 的状态上下文包含念头正文，明确它是内在材料而非事实记录；成长为持续念头后沿用现有 self-signal → Bridge → Life 路径。

生成念头不会自行发送通知、调用 `sharing`、认定人类到访或直接抵消驱力。主意识是否表达仍由汐及 Life 决定。Bark、手机注意力监测和主动频率未额外放开。

## 验证与回退

实际 M3 接口的分类、梦境和通知型念头调用通过；新增内在念头提示词也已单独实测通过。隔离 HTTP 联调验证了模拟 Ombre → 模型 → 念头池 → xi-mind 上下文，不访问真实状态或记忆卷；单元回归另验证了来源保留、失败回退和持续念头的自身信号。

更新后的运行容器内，分类与梦境实际请求均通过，内在念头连续两次通过，健康检查 200。首次容器念头请求曾在 30 秒超时，DNS、出站连接和凭据随后核验正常；未调整网络，后续三类请求成功。保留原有 30 秒模型超时与失败回退，不将一次成功当作长期稳定性结论。所有接口探针使用虚构测试材料，未将结果写入真实状态卷。

本地启用前的 `.env`、主状态快照和镜像 ID 保存在被忽略的 `xinchao/state/m3-enable-backup-20261008-201459/`，目录权限为 0700，敏感文件为 0600。旧镜像另保留为 `xinchao-nian/dynamic-mind:before-m3-pool-20261008`。回退配置或镜像时保留之后产生的用户状态，不自动用旧快照覆盖真实状态卷。
