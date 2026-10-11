# 原 Manju 兼容入口

`scripts/h3-manju.mjs` 保留升级前 `h3.mjs` 的完整实现。仅当用户已有 Manju 项目、素材 assetId 或旧 journal 时使用。新版 `h3.mjs` 不支持 Manju assetId；两套服务的数据目录、健康检查和 journal 不能混用。

```text
node scripts/h3-manju.mjs prepare --manifest INPUT.json --journal NEW.json --base http://127.0.0.1:OLD_PORT
node scripts/h3-manju.mjs generate --journal SAME.json
node scripts/h3-manju.mjs status --journal SAME.json
node scripts/h3-manju.mjs resume --journal SAME.json
```

确认自己的服务健康状态和用户生成授权后执行。保留同一 journal 与 operationId，恢复不新建替代任务。此兼容入口不意味着当前机器已部署 Manju，不改变 Toonflow/导演台数据库与生成 API。
