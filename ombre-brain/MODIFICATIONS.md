# 心潮念对 Ombre Brain v3.6.3 的本地兼容修改

本目录是 P0luz/Ombre-Brain v3.6.3 的 vendored 快照。完整上游许可和说明保留在
`LICENSE`、`NOTICE.md`、`README.md` 与 `CHANGELOG.md`。

## 本地修改

1. `src/tools/breath/_verbatim.py`
   - 在每条浮现记忆的表头追加结构化 `[domain:...] [tags:...]`。
   - 不改写磁盘正文，继续保留 v3.6.3 的双链清理、第三方发言归属和关系提示逻辑。
   - 供心潮的记忆共振按结构化主题计算亲和度。
2. `src/web/buckets.py`
   - 增加 sidecar 专用 `GET /api/bucket-map` 与 `GET /api/bucket-preview/{bucket_id}`。
   - 使用独立的 `OMBRE_MCP_SERVICE_TOKEN` Bearer 校验、严格 ID 校验和泛化错误响应；星图不返回正文。
3. 心潮念根目录的 Compose
   - 将新版 Ombre 快照作为本地构建上下文，并默认跳过不必要的 cloudflared 下载。

## 破坏性操作边界

本地兼容层没有恢复旧版 `purge` 等独立硬删除入口。v3.6.3 的生命周期操作统一由 `trace` 控制：
普通 `delete` 归档，`restore` 恢复，`hard_delete` 只接受明确 `test_data=True` 且必须有
`delete_reason` 的测试桶。心潮念代理也只允许 v3.6.3 的公共方法名。

这份文件描述的是当前本地快照；修改完成后如需发布，应在两个仓库分别提交并由人工决定是否推送。
