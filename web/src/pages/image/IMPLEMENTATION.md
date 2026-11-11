# 通用生图任务安全交付（2026-10-25）

## 完成内容

- `onJobIntent` 在创建前等待 IndexedDB 持久化；写入失败不发 POST。
- 任务绑定 vault 账号与渠道ID/地址/key摘要，不持久化真实凭据。旧无归属记录保留但不自动认领。生成日志按账号过滤；旧本地日志仅在本地身份下显示。
- 无 jobId 展示“提交结果待核实”，不自动重提，不提供失败卡新建重试。有 jobId 的恢复仅 GET/poll，不重新准备引用，不受创建功能开关影响，不回退同步生成。
- 404/409、不确定状态等显示原任务待核实，不自动付费重建。
- 实时 sessionGuard 在异步引用准备前捕获原账号/渠道修订，由模块04 helper 在请求、重试与轮询期间核验。账号、渠道和 A→B→A 变更使旧 guard 失效。
- 页面在任务会话变化时重新挂载，以 sessionRevision 保护异步结果、日志、资产保存和任务状态回写。

## 修改文件

- `pages/image/index.tsx`：持久意图、恢复入口、禁重新提交、账号视图及异步写回保护。
- `pages/image/gpt-job-recovery.ts`：记录隔离与仅查询恢复。
- `pages/image/image-job-session.ts`：实时账号/渠道修订 guard。
- `services/api/image.ts`：GPT client 接 guard；已知 jobId 优先恢复，早于引用准备及功能开关分支。
- `pages/image/gpt-job-recovery.test.ts`、`image-job-boundary.test.ts`、`image-job-safety.browser.mjs`：回归验证。
- 模块04负责的 gpt-jobs/fal-jobs helper、relay及harness未由本模块修改。

## 验证

- 11个定向测试文件、131项通过，含资产库最终契约、SPA复用、账号引用屏障、任务恢复、image调用边界及引用尺寸。
- 全站 `npm run typecheck` 通过。
- `node src/pages/image/image-job-safety.browser.mjs`：真实本地HTTPS、实际ImagePage、实际vault/relay和模块04 helper；JAPI与模型为本地模拟，测试入口负责前端配置/身份store初始化。
- 浏览器通过生成、参考图编辑、刷新GET恢复、A/B共key隔离、A→B→A丢弃旧结果、响应丢失刷新不POST；独立B浏览器只能读取B任务。28次jobs请求；5次明确生成操作对应5次模型上游提交，恢复未增加提交；上游Cookie计数0。
- 截图：`web/test-results/image-job-safety/recovered.png`、`lost-acknowledgement.png`。

后续独立 MIME 派单已修复：完整1×1 PNG/JPEG字节复现确认 `resolveImageSource` 固定PNG标签是实现缺陷，不是测试期望错误，也不是任务安全改动新增。现复用 `detectRasterMimeTypeFromBase64` 按字节签名选择MIME，保持原字节和URL响应不变，未知格式保持原PNG回退。`image.managed.test.ts` 改用完整图片夹具、实际编辑引用，并验证JSON Content-Type及错误声明MIME不覆盖真实图片类型、data URL读取的Content-Type与字节一致。相关5文件28项全部通过，全站typecheck通过；原2项失败已关闭。未部署。

## 边界

未部署、未调用真实付费模型。无编号记录须到任务中心或由管理员核实，不自动匹配/认领旧bearer任务。旧无归属任务保留且不展示为当前账号任务。服务端授权仍由vault与relay执行，客户端摘要和guard只是前端隔离措施。
