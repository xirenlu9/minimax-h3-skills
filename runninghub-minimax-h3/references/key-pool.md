# 个人本地 Key 池与并发队列

仅本模式需要本文；参数问题用 app-parameters.md，旧 Manju journal 用原 h3.mjs。

## 边界

- 仅用于用户有权使用的账户与消费级 Key。不是无限/免费算力，不绕过平台限流、权益或账户配额。
- Node 22+，本版本凭据保护仅支持 Windows 当前用户 DPAPI。默认私有目录为运行进程的 `%LOCALAPPDATA%/RunningHubH3`；`keyPool.mjs summary` 返回实际 encryptedPath。也可所有命令统一传 `--poolDirectory 私有目录绝对路径`。
- 密文、journal 与批次输入放私有目录，不能放在 Skill/Git 仓库内。Key 通过脚本内部发往固定 `https://www.runninghub.ai`，不进提示词、CLI 参数、日志或 Git。
- 原 h3.mjs 与导演台调用链不改。新 h3-pool.mjs 独立工作；直接模式返回结果 URL，不自动回写导演台素材库。
- 导入积分是快照。每次准备与生成前检查实时余额、账户在跑任务数；默认每 Key 1 任务，全局 3，可调。最低积分是人工设定阈值，不是视频准确报价。
- 额度不足可在提交前选下一可用 Key，最多核验 5 个候选；如果参考素材已上传，则为新 Key 重新上传原素材。提交后固定 Key 与 taskId，超时不会换 Key 重提。鉴权/限流/网络错误不触发账户轮换。
- 没有可用额度时暂停批次；提交 unknown 会占用原槽位，需人工核对。余额刷新失败时暂禁该 Key，不推算“剩余额度”。结果收集失败只恢复原任务。
- 用同一账户的多个 Key 并发仍受账户配额限制；建议每账户仅启用一个 Key。跨机器复制 DPAPI 密文不可用。

## 运维（不生成视频）

脚本路径均相对 Skill 根目录；用终端执行，不把账户文件读取到模型上下文。

```text
node scripts/keyPool.mjs import --file 账户文件绝对路径
node scripts/keyPool.mjs summary
node scripts/keyPool.mjs list
node scripts/keyPool.mjs configure --maxConcurrent 3 --minCredits 1
node scripts/keyPool.mjs update --id 脱敏KeyID --enabled false
node scripts/h3-pool.mjs probe
```

导入格式 `邮箱----RunningHub密码----积分----消费级Key----邮箱密码`。只保留 Key 与积分，丢弃邮箱和两个密码；重复导入不恢复禁用 Key、不重置实时余额或任务。list 只有脱敏 ID 和调度状态。

单 Key 也不需要服务器。可禁用其他 Key，或 prepare 指定 `--keyId 脱敏KeyID`，此任务固定选择该 Key，余额不足不自动改选。

## 单任务

manifest 与原模式同样使用 prompt 或 promptFile、references 和 parameters；直接模式 references 需本地 path、kind、role，不支持 Manju assetId/projectId。参数策略见 app-parameters.md。

```json
{"prompt":"[0s-10s] 镜头缓慢推进，人物回头。","references":[],"parameters":{"durationSeconds":10,"aspectRatio":"16:9","megapixels":0.4,"steps":8},"minCredits":1}
```

```text
node scripts/h3-pool.mjs prepare --manifest INPUT.json --journal 私有目录/新任务.json
node scripts/h3-pool.mjs generate --journal 私有目录/同一任务.json --confirm submit
node scripts/h3-pool.mjs status --journal 私有目录/同一任务.json
node scripts/h3-pool.mjs resume --journal 私有目录/同一任务.json
node scripts/h3-pool.mjs cancel --journal 私有目录/同一任务.json
```

prepare 查询账户/应用并上传参考素材，不调用生成接口，但会预约 Key。cancel 仅释放**未提交**的本地预约。先审阅参数；仅用户授权本条生成才传 confirm submit。

unknown：人工在原账户确认 taskId 后，执行 `recover-task --journal 同一任务.json --taskId 确认的ID`，脚本用原 Key 查询确认；不要猜 taskId，不重新 prepare 或解除未知槽位。

schema 在准备与提交实时核验。新脚本的 fingerprint 算法独立于上游 2026-10-08 的历史摘要，不把两个算法的哈希相同作为已验证条件。实际质量、尺寸、音轨需检查生成的视频才能评价；任务 SUCCESS 不代表质量验收。

## 批次多并发

批次 manifest：`{"jobs":[{"manifest":"第一个INPUT的绝对路径"},{"manifest":"第二个INPUT的绝对路径"}]}`，最多 100 个。plan 只在私有目录保存固定输入和子 journal，不访问远端。

```text
node scripts/batch.mjs plan --manifest BATCH.json --journal 私有目录/新批次.json
node scripts/batch.mjs run --journal 私有目录/同一批次.json --confirm submit --waitSeconds 60
node scripts/batch.mjs status --journal 私有目录/同一批次.json
node scripts/batch.mjs resume --journal 私有目录/同一批次.json
```

- run 才启动已授权批次的待处理任务；以配置上限填补空槽，先查询旧任务，不重复生成。同一 journal 每次只允许一个本地调度器。
- 默认轮询预算 60 秒，可设 0–3600；每个网络请求单独超时。到预算返回进度，未完任务保留；要继续启动排队任务用同一批次 run。status/resume 只查询，绝不启动队列。
- 任一未知提交、鉴权/限流/网络错误暂停新调度，已经提交的任务保留原 Key 与 taskId。失败任务不自动付费重做。
- 锁仅在本地文件更新时短暂串行，不串行视频生成。异常退出留下 lock 时，确认对应执行器已停止后才人工删除，禁止自动清锁接管。

## 验证范围与官方接口

`node --test scripts/keyPool.test.mjs` 使用合成账户与隔离临时目录，验证本地调度，不调用收费 API。
消费级 AI App 请求和余额字段依据 [生成接口](https://www.runninghub.ai/runninghub-api-doc-en/api-425761096)、[账户接口](https://www.runninghub.ai/runninghub-api-doc-en/api-425761030)、[任务查询](https://www.runninghub.ai/runninghub-api-doc-en/api-425761033)。pool 数量或本地测试通过不等于全部 Key 权限/真实生成已经验证。
# 升级后的兼容说明

新任务使用新版独立服务与 `scripts/h3.mjs`，只读 `references/local-installation.md` 即可。本文剩余内容仅用于未迁移的旧池或历史 journal 恢复。迁移成功的池禁止新预约；旧 `h3-pool.mjs`、`batch.mjs` 只可查询已有记录，不能继续消费同一批 Key。
