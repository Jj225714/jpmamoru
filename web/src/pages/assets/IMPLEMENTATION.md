# 资产库交付记录（2026-10-25）

模块01完成个人、团队、项目资产库页面，保留默认本地历史资产入口。服务端库支持列表、上传、预览下载、配额、去重、来源详情、回收站恢复和审计；权限以服务端结果为准。账号切换或成员权限重查时隐藏旧数据及弹窗，异步结果受账号和作用域检查保护。

本地迁移采用显式选择、引用优先复制、来源映射与收据校验。成功提示必须等待模块07客户端完成验证；支持刷新后继续原映射。所有本地原件保留，不删除或覆盖。已接入最终模型渠道与小数比例兼容契约。

第9项修复移除 StrictMode 下过早完成标记，恢复任务由 effect 成对创建和清理；每次“带入生图”使用独立请求标识。历史资产详情补充提示词、模型、参数、时间、工作流及有序引用，缺失字段明确标注，来源为客户端记录。

## 修改范围

- `pages/assets/`：library-page、library-model、library-session、library-migration、library-migration-panel、asset-reuse、local-provenance、index 及相关测试和浏览器脚本。
- `stores/use-asset-store.ts`：持久化本地资产库 ID。
- `pages/image/index.tsx`：SPA 复用恢复生命周期。
- 模块07服务客户端及模块06 config-vault 未由本任务修改。

## 验证结果

- 8 个 Vitest 文件、115 项测试通过（含模块07最终迁移客户端测试）。
- `npm run typecheck` 通过。
- `asset-reuse.browser.mjs`：实际 `/assets` 到 `/image` SPA 首次与重复复用均恢复提示词和 B/C/A 引用顺序。
- `library-ui.browser.mjs`：真实本地 vault、HTTPS Vite、双浏览器上下文，110 次请求通过。覆盖账号隔离、伪造写请求403、精确1024字节配额、去重、回收恢复、审计、引用优先迁移、刷新续传不新增POST、权限撤销及本地原件保留。
- 最终兼容用例：`_channel::image-v1` / `1.90:1`、`-channel::image-v1` / `2.5:1`、auto质量和空背景。
- 截图：`web/test-results/asset-library-ui/generated-provenance.png`、`web/test-results/asset-reuse-fix/local-provenance.png`、`web/test-results/asset-reuse-fix/first-spa.png`。

## 边界与依赖

无剩余模块07接口阻塞。验证使用本地模拟 JAPI 身份；未部署生产、未调用真实付费模型。迁移逐项执行，后续失败可能留下已复制的引用，原件始终保留；列表与审计范围继承服务端契约。

后续通用 `/image` 任务安全回归已完成，结果和边界见 `../image/IMPLEMENTATION.md`。
