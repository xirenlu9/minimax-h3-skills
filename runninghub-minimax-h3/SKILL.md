---
name: runninghub-minimax-h3
description: 使用 RunningHub 国际站消费级 H3 应用预览参数、生成视频和恢复任务。独立本机服务管理加密 Key 池与账户级并发队列；导入密钥不会生成视频。
---

# RunningHub MiniMax H3

固定 AI App `2084320751339032577`。不切换应用或执行工作流，不改写用户已有 H3 提示词。未知费用保持 `null`；最低积分是调度阈值，不是一次视频的费用预测。

## 按需读取

- 配置 Key、启动执行器、余额或并发管理：只读 [本机服务](references/local-installation.md)。凭据在 Skill/Git 目录外加密保存，不读取原文 Key、密码或 vault 到模型上下文。
- 单条视频预览/生成/查询：使用下面命令；只在需要参数细节时读 [应用参数](references/app-parameters.md)。
- 旧 Manju 项目或旧服务 journal：只读 [兼容入口](references/manju-compat.md)，使用 `scripts/h3-manju.mjs`。不把旧 journal 交给新版服务。
- 旧本地直接 Key 池的历史任务：只读 [旧池兼容](references/key-pool.md)。已迁移池禁止新任务，防止两套执行器同时消费同一账户。

## 视频操作

manifest 使用 `prompt` 或 `promptFile` 二选一；参考素材为本地 `path`、`kind` 与可选 `role`。相对路径以 manifest 目录为基准。最多六图、三音频、一视频，原文使用对应 `<Picture 1>`、`<Audio 1>`、`<Video 1>` 标签。非通用角色应在原文说明对应标签；通用图片槽不保证严格首尾帧锁定。

```text
node service/cli.mjs start
node scripts/h3.mjs prepare --manifest INPUT.json --journal PRIVATE.json
node scripts/h3.mjs generate --journal SAME.json --confirm submit
node scripts/h3.mjs status --journal SAME.json
node scripts/h3.mjs resume --journal SAME.json
node scripts/h3.mjs cancel --journal SAME.json
```

journal 必须位于服务私有数据目录内。`prepare` 只校验素材、读取公开 schema、保存预览，不上传或生成。`cancel` 仅取消尚未提交的本地工作。

用户明确要求生成才授权一次提交；批次必须明确授权任务数，每段独立 journal。导入 Key、查余额、修复或启动服务均不构成视频生成授权。确认后排队，执行器默认全局并发3、每账户组1；不等于平台实际并发权限。

已受理任务始终绑定原 Key/taskId。`status`/`resume` 不重提任务，远端排队不回到本地提交队列。仅在尚未提交、实时余额低于阈值且用户未指定 Key 时选择其他可用账户；平台限流、鉴权异常、schema 改变、查询失败或提交不明时暂停新提交，不换账户绕过错误。`submission_unknown` 必须查原账户并人工接回 taskId 或确认未受理；未查明不能释放槽或新建替代任务。

成功仅表示收到结果。报告画面、时长、音轨质量前应实际查看/试听；带签名凭据的链接不回显。保留用户已经选定的成片，不自动重跑。
