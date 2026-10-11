# 独立本机服务：Key 池与执行器

基于上游 `ff8d400`，补充远端排队隔离、实时余额预检、异常暂停和 Windows 安全迁移。Node.js 20+，无 npm 依赖，不需要租云服务器或修改导演台。

## 数据与启动

默认数据目录 `~/.runninghub-h3-service/`；可用 `RH_H3_HOME` 指定绝对路径，但不能位于 Skill/Git 仓库内。默认端口 `127.0.0.1:4317`，可用 `RH_H3_PORT` 修改，服务与 CLI 设置必须一致。

```text
node service/cli.mjs start
```

Windows 首次启动自动创建随机 vault passphrase，并用当前用户 DPAPI 加密保存至 `vault.passphrase.dpapi`；不写命令参数、环境变量或明文临时文件。API Key 使用 AES-256-GCM 存入 `state.json`，`service.token` 用于本机鉴权。DPAPI 自动解锁不能跨用户/机器复制使用。

其他平台沿用隐藏输入 passphrase 的上游方式；已有手工 passphrase vault 必须用原密码，不能覆盖创建新密码。仅在用户明确需要无人值守外部密码管理时使用原上游 `RH_H3_VAULT_PASSPHRASE` 环境方式，注意同一用户进程可能读取环境。

保持执行器进程运行；关闭进程不会取消远端视频，重启后按账本查询原任务。

## 导入现有个人池

服务停止时运行以下迁移，原五字段文件只在脚本进程内解析，邮箱、登录密码、邮箱密码不进入新 vault；同账户使用邮箱哈希形成匿名账户组。

```text
node service/cli.mjs migrate --file ACCOUNT_FILE.txt --legacy-pool OLD_PRIVATE_DIRECTORY
node service/cli.mjs start
node service/cli.mjs key probe-all
node service/cli.mjs executor resume
```

旧池有活动/未知任务或来源文件不存在则拒绝迁移。先持久化冻结旧池，再写入新库；源与目标完成确认前新服务禁止恢复，防止中途写盘失败造成双执行器。失败后不自动解冻，修正故障并重复同一迁移命令恢复。保留旧历史账本；重复迁移不覆盖新池启用状态、余额或任务，但会暂停执行器等待确认。导入初始禁用；只读核验成功才恢复原启用意图，人工确认后恢复执行器。核验错误会暂停整个执行器，不循环换账户绕过。

手工添加一把新 Key：`node service/cli.mjs key add --account-group ALIAS`，Key 隐藏输入；同一账户必须同组。然后 `key probe KEY_ID`、`key enable KEY_ID`。`key probe` 按 ID 直接查余额，零余额充值后也能刷新，不需要制造生成预约。

## 管理命令

```text
node service/cli.mjs key list
node service/cli.mjs key probe KEY_ID
node service/cli.mjs key disable KEY_ID
node service/cli.mjs executor status
node service/cli.mjs executor pause
node service/cli.mjs executor resume
node service/cli.mjs settings --max-concurrent 3 --min-credits 1
node service/cli.mjs job list
```

全局并发可设1–4，默认3；每账户组最多一个活动任务，远端排队和受理不明均占槽。本地设置不增加平台配额。最低积分必须大于零，但不代表足够支付一条视频；实际消费以平台账单为准。

仅在新任务提交前、实时余额不足时允许重新选账户；已指定 Key 不静默换绑。遇到限流、鉴权失败、查询错误或受理不明暂停所有新提交。已发出的请求不能撤回；暂停门只阻止尚未发出的请求，已有任务仍用原 Key 查询。

## 未知提交恢复

先在原 RunningHub 账户确认任务：

```text
node service/cli.mjs job attach-task JOB_ID ORIGINAL_TASK_ID
node service/cli.mjs job resolve-not-accepted JOB_ID
```

`attach-task` 会用原 Key 查询并确认该 taskId，拒绝覆盖其他账本绑定。确认没有任务后，`resolve-not-accepted` 要求输入完整确认语句，只关闭原账本项，不重发。尚有未知提交时禁止 `executor resume`。

输入素材上传与实际视频生成仅在用户明确授权 `generate --confirm submit` 后执行。准备、迁移、核验不会提交视频。带凭据的结果链接不回显，必要时使用 taskId 到平台查看。
