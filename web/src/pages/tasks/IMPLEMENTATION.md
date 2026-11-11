# 模块01 本地交付记录（2026-10-25）

## 完成范围

- `/tasks`：按当前账号渠道显示 GPT / Fal（esrgan、flux-fill、qwen-layered）列表、独立游标分页、详情、结果链接、服务端阶段与耗时、队列模式和保留期。错误只呈现客户端脱敏摘要。
- 取消/恢复由后端 actions 决定；uncertain 不可重试。恢复仅调用 resumeQuery，查询失败不创建任务，不显示虚构百分比。
- 桌面/移动导航与通用生图增加任务入口及最近任务。移除通用生图启动时扫描无账号归属旧本地 GPT 记录并自动恢复的路径，改由认证服务端列表查询。旧记录没有删除。
- 通知权限包含允许、拒绝、不支持分支。本站打开且权限允许时轮询各来源，已观察任务转为成功/失败/取消只通知一次；历史终态作为基线。账号/来源/凭据散列隔离通知记录，持久化失败则不通知以避免刷新重复。支持 Web Locks 的浏览器串行跨标签去重。
- 跨账号参考图门禁：同步订阅账号 ID/退出状态变化并 reset 队列，A→B→A 不依赖 React 是否重渲染。通用生图同步 reset 自动识别控制器、参考图及提示词；画布复用 Hook，项目变化继续 reset。
- 画布原生生成/重试入口统一消费 CanvasGenerationGate：提示词、配置节点、悬浮工具栏生成/重试、错误节点、批次重试、蒙版生成、角度生成。上传中或失败未处理时禁用；停止当前任务按钮仍可用。保留提交前门禁，蒙版异步读取后另校验 checkpoint。

## 修改文件

- `src/pages/tasks/`：index.tsx、board.ts、session.ts、presentation.ts、notifications.tsx、notifications-core.ts、current-image-tasks.tsx、tasks.test.ts、session.test.ts、task-center.browser.mjs、本记录。
- `src/router.tsx`
- `src/components/layout/app-top-nav.tsx`、`mobile-nav-drawer.tsx`
- `src/pages/image/index.tsx`、`reference-readiness-panel.tsx`、`reference-account.test.ts`、`reference-account.browser.mjs`、`canvas-reference-harness.tsx`、`canvas-reference-gate.browser.mjs`
- `src/pages/canvas/project.tsx`
- `src/components/canvas/canvas-generation-gate.tsx`、`canvas-node-prompt-panel.tsx`、`canvas-config-node-panel.tsx`、`canvas-node-hover-toolbar.tsx`、`canvas-node.tsx`、`canvas-node-mask-edit-dialog.tsx`、`canvas-node-angle-dialog.tsx`

## 验证

- 定向 Vitest：tasks.test.ts、session.test.ts、模块04 task-center.test.ts、reference-account.test.ts、reference-readiness.test.ts、product-base-prompt-controller.test.ts，共 **77 项通过**。
- 最终 `npm run typecheck`：通过（包括修正 reference-account.test.ts StoreApi 类型和 canvas-reference-harness.tsx inputSummary 类型）。
- `task-center.browser.mjs`：真实 `/tasks` 页面配合模拟 GPT/Fal 接口，通过状态、分页、结果详情/刷新、查询失败、恢复 action、通知授权与去重、退出清空。只发生预期的 retry 查询恢复 POST，无创建请求。
- `reference-account.browser.mjs`：真实 `/image` 文件上传入口，延迟图片加载并合成 A→B、A→B→A、退出；旧图片均未进入 UI。
- `canvas-reference-gate.browser.mjs`：真实提示词/配置节点/错误节点组件及队列 Hook，验证并发上传、失败、重试/移除、项目/账号切换；禁用按钮强制 click 的生成回调次数为零。
- 截图：`web/test-results/task-center/detail.png`、`signed-out.png`；`web/test-results/reference-account/after-switch.png`；`web/test-results/canvas-reference-gate/pending.png`、`ready.png`。

## 边界与集成

- 未部署，未调用真实付费模型，未走真实登录/退出认证链路；画布为组件级浏览器回归，完整 `/canvas/:id` 验收仍建议模块08复跑。
- 任务中心只呈现服务端已受理任务；没有新增本地待提交队列，不保证关闭浏览器后发送通知。未接管旧生图创建流程，也没有调用 prepareIntent/restoreIntents；模块04异步 prepareIntent 不影响本次只读/动作集成。
- GPT 来源只列出符合现有 GPT 任务服务 eligibility 的渠道。共用 bearer key 仍是共用服务端任务空间，前端账号隔离不能替代后端账号授权。
- 未修改模块04 API 客户端、模块02/03文件或共享 product-base-prompt.ts。通知需要浏览器权限和可用持久存储；真实系统通知显示未作操作系统级验收。
