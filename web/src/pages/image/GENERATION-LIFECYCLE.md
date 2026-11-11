# 生成过程中界面消失：本地修复记录（2026-10-28）

## 复现与根因

延迟本地模拟 images/edits 响应，上传参考图并生成。仅移动鼠标十次，界面保持；随后修改同账号渠道名称，旧版 GeneralImageWorkbench 因 key=taskSessionRevision 重挂载，提示词、参考图和结果一起清空。放行模拟响应后，请求正常返回，提交次数仍为1，但没有结果或历史记录。

taskSessionRevision 包含渠道名称、地址、key及 checking/signed-out 阶段。旧页面把这个任务客户端修订当作整个工作台的生命周期；卸载递增 sessionRevision，旧生成 Promise 完成后提前返回，而 saveLog 仅在完成后调用。未发现鼠标移动直接清空工作台的处理器，不能声称已复现所有线上偶发触发因素。

## 修改范围

- `index.tsx`：工作台改用真实账号边界；发请求前等待本地运行记录落盘；成功/失败更新同一记录；明确重试创建独立记录；历史预览不能打断正在运行的任务；活动记录不能被删除；运行中显示本地跟踪说明。
- `generation-account-session.ts`：同账号 checking/saving/ready 或渠道刷新不重挂载；用户ID变化、登出和A→B→A仍使旧界面失效。
- `generation-journal.ts`：本地记录写入串行化，保存原账号归属。start在等待存储前登记活动状态；interrupt同步撤销并排队写中断状态，迟到start/finish不能恢复运行或提交请求。
- 新增对应两个单测文件及 `generation-lifecycle.browser.mjs`；`reference-focus.browser.mjs` 等待历史记录完成状态后再预览。
- 未修改共享任务客户端、任务中心session、服务器配置、模型API或其他模块。

## 语义与验证

- 记录是本地历史，不是后台持久任务。刷新、离开、新建会话、切号会结束本地跟踪；可能仍有上游工作进行，不能据此判断取消、退款或成功。孤立running记录展示为“跟踪已中断·待核实”，不自动重提。
- 开始记录无法保存时不发模型请求。完成记录保存异常会显示核实提示。
- 19个相关测试文件、93项通过；全站typecheck通过。
- 延迟setItem分别覆盖账号切换、卸载、新建会话：最终中断、active=false、提交0次、迟到finish不覆盖。
- 真实ImagePage配合本地Playwright拦截响应，覆盖鼠标、渠道刷新、同账号阶段刷新、成功、失败、明确重试、刷新以及账号A/B/ABA；六次明确生成/重试对应六次模拟提交，刷新不新增请求。账号变化使用store合成状态，不是生产身份认证验收。
- 证据目录：`web/test-results/generation-lifecycle/`。before为旧版复现，completed/failure/after为修复验证。

未部署、未访问生产、未调用真实模型。同步请求中断后不保证取回结果；当前记录粒度为一次生成批次，尚未结束批次中的部分结果不承诺完整恢复。多设备历史同步、手机浏览器和真实供应商取消/计费不在本次验证范围内。
