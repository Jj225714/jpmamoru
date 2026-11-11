# 奥维斯AI生图 项目协作说明

## 项目定位与当前版本

奥维斯AI生图基于 Infinite Canvas v0.19.0 定制，包含无限画布、生图工作台、商品白底图和跨境电商图片流程。界面与浏览器标题使用“奥维斯AI生图”；技术存储键仍保留 `infinite-canvas`，不要因品牌更名改动数据库名称。版本以根目录 `VERSION` 为准，`web/package.json` 中的包版本不是应用发布版本。先阅读 `AGENTS.md`，再查看具体模块代码；用户当前要求优先。

本地目录：`F:/AIVIBI/sanheai/infinite-canvas`。当前工作副本没有 `.git` 历史，不能假定可以通过 Git 撤销改动。修改前检查现有代码，不覆盖用户定制功能。

## 启动与检查

当前公网部署为 `https://103.79.187.126`；服务器环境、目录、证书自动续期和回滚说明见根目录 `DEPLOYMENT.md`。公网地址和 localhost 的浏览器数据独立。

本次本地工作区已上传私有服务器快照，并在当前浏览器的服务器站点恢复成功（3 个任务、3 个画布、3 份规则包、228 个图片文件）。本地数据保留；不要再次执行一次性自动迁移，也不要把私密快照改为公开文件。需要其他设备恢复时参考部署文档。

已发布规则有独立服务器目录：新版通过 `commerceCreativePolicyCatalogUrl` 读取 `/public-rules/catalog-creative-v1.json` 的32项推荐方案；旧 `/public-rules/catalog.json` 和 `catalog-visual-v2.json` 保留40项历史规则供旧客户端使用。运行时设置位于服务器 `/etc/infinite-canvas/runtime-config.js`，加载逻辑在 `services/commerce-policy-catalog.ts` 与跨境 store 中。本地初始化失败时禁止用默认状态覆盖数据；公共规则仅可创建本地副本，普通网页操作不能更新服务器公共版本。私人模型配置与任务不公开。

所有前端命令在 `web/` 下运行：

```sh
cd web
npm ci
npm run dev -- --port 3001
npm run typecheck
npm test -- --testTimeout=20000
npm run build
```

开发地址为 `http://localhost:3001`；默认 `npm run dev` 使用 3000。保持原域名和端口，否则浏览器会显示另一份本地存储。依赖已安装时无需每次运行 `npm ci`。Vitest 负责前端测试，测试与源码同目录或位于 `web/tests/`；Excel 导入测试使用本机工作簿，耗时较长。生产构建可能出现体积和混合导入警告，需区分警告与真正失败。

## 目录与技术栈

- `web/`：Vite、React、TypeScript、React Router、Ant Design、Tailwind、Zustand、localforage。
- `provider-relay/`：当前 Node.js 个人凭据转发服务，官方 fal/Azure 限定接口，无共享密钥或访问码。`model-gateway/` 是已停用的历史实现，仅留作回滚参考。
- `web/src/router.tsx`：路由；`layouts/user-layout.tsx`：公共布局。
- `web/src/pages/`：`canvas` 画布、`image` 生图、`commerce` 跨境任务、`config` 配置等页面。
- `web/src/components/`：公共组件；`components/layout/` 管理顶部导航及配置弹窗。
- `web/src/stores/`：共享状态；`stores/canvas/`：画布状态。
- `web/src/services/api/`：模型和外部服务请求；`services/image-storage.ts`：图片、生成记录和缩略图存储。
- `web/src/lib/commerce/`：需求表导入、生成配置、流水线、规则检查、排版、分层导出和规则编辑。
- `web/src/types/commerce.ts`：任务、规则包、品牌、生成方案及图层类型。
- `canvas-agent/`、`canvas-proxy/`：可选本地助手与转发服务；不是跨境业务后端。
- `plugins/`：插件；`docs/`：文档站；`assets/`：项目资源。

## 已有定制功能与数据约束

- 2026-09-22 已移除访问码。旧 `managedModelGatewayEnabled` 标记不能重新开启授权界面；保留个人配置、任务、画布与素材。
- 所有模型通过原“配置 → 渠道”设置，fal/Azure 工具在“高级图片工具”绑定；删除绑定时提示配置，不猜测渠道。转发 `/api/providers/` 只使用调用者的密钥，限制 Origin、地址、路径、方法及体积；旧 `/api/managed/` 返回 410。配置导出包含个人密钥，不得公开。

- 场景图不再把非方形模型结果直接补白成方图：最多一次背景扩展，仍失败则报错，不裁切或拉伸商品；白底类保留正常留白。见 [白条修复说明](docs/commerce-scene-framing.md)。此修复已于2026-09-18同步服务器，历史图片不自动改写或重跑。

- 新版推荐流程v3见 [说明](docs/commerce-creative-v3.md)：四类各8项、默认4项；拍摄设置单独配置。跨境六字段信息建议必须点击后调用、人工选择采用，不自动覆盖或认证事实。前后对比的两张独立来源须顺序生成并验证依赖，不能仅靠来源ID通过被隐藏或移出画板的对比图。
- 持久化版本4保持旧任务内容不变；使用“使用新版方案创建副本”建立v3任务，不就地改写旧方案。`comparison-source` 不属于最终导出图片；更换前图使后图失效。规则编辑器可追加默认关闭的高级方案，但不能删除或重排已有ID。

- 历史画面流程 v2 见 [说明](docs/commerce-visual-pipeline.md)：营销方案先生成自己的 `marketing-base`，精确绑定需求/序号/变体/站点后才叠字，禁止隐式白底回退。当前新任务使用v3，历史任务推荐创建新版副本，不能批量重跑或覆盖旧结果。
- v4 规则使用独立公共入口 `catalog-visual-v2.json` 和运行时键 `commerceVisualPolicyCatalogUrl`；旧入口保留 v3 供旧客户端使用。画布营销背景是含商品的整幅场景，不是自动抠出的商品/背景双层；v2 直接换场景位图需回到需求生成流程，文字和样式仍可编辑。

- BM 渠道 `https://bm.clawvp.com/v1` 使用固定上游同源转发，规则见 `docs/bm-model-gateway.md`。生产由 Nginx 和运行时布尔开关启用，本地由 Vite 接管；任何渠道密钥都不可写入源码、服务器公共配置或日志。

- 通用生图的提示词为空时，上传商品图会通过已配置的支持图片的文本模型自动填写六项基础信息。四类案例规范见 `docs/product-base-prompt.md`。只自动填写，不自动生图；已有输入与全局系统提示词不改写。禁止套用案例中的未确认性能参数。

- `/image?mode=product-white`：单张商品白底处理，支持本地抠图、配置的抠图服务、AI 优化、记录、下载、画布与跨境任务联动。
- `/commerce`：按品牌、任务、SKU 方案生成图片，支持多语言、数量、Logo、水印、站点、变体、人工审核与 ZIP 导出。
- `/commerce/settings`：品牌、模型、国家规则和模板；编辑器位于 `pages/commerce/components/policy-editor.tsx`。
- 规则编辑保留原条目 ID；已发布版本另存新版本，旧任务固定关联原 `policyPackId` 和 `policyVersion`。保存通过负责人 PIN 验证，等待存储成功才提示完成，失败保留编辑内容。
- 文案变更或翻译不完整须重新校对，品牌默认值不能跳过新方案的待校对标记。
- 分层画布和素材层 ZIP 已支持；PSD 编码尚未实现，不要把 PSD 标为当前可用。
- IndexedDB 使用 `infinite-canvas` 数据库。业务状态使用 localforage，跨境键为 `infinite-canvas:commerce_store`，白底记录键为 `infinite-canvas:product-white`。
- 缩略图仅用于显示，生成参考、下载、导出和同步使用原图。图片清理须保留跨境及白底记录引用的素材。
- 不清空浏览器存储、不随意更换存储键、不重置品牌/API 配置、不破坏旧任务和已生成图片。密钥不得写入文档或日志。
- `services/workspace-transfer.ts` 和 `workspace-transfer.html` 提供完整归档迁移；独立恢复页面避免应用状态仓库在恢复过程中并发持久化。服务器快照经认证保护，细节见 `DEPLOYMENT.md`。一次性迁移不能宣传为实时同步或多用户共享数据库。

## 临时隐藏的界面与恢复方法

首页文案已改为“通过奥维斯达成人生目标，让每次创作变成一种进步”。`pages/home/index.tsx` 中从“沉淀每一次好结果”开始的展示区及后续预览层、对应列表请求均以 `TEMP_HIDDEN_HOME_SHOWCASE` 注释保留。恢复展示时取消这三块代码的注释；首屏标题和两个进入按钮保留。

用户要求通过**代码注释**隐藏以下入口。功能源码与路由保留，此项仅为界面隐藏，不是权限限制；手动访问 `/video` 仍可打开视频页面。

统一标记：`TEMP_HIDDEN_HEADER`。执行以下命令定位所有恢复点：

```sh
rg -n TEMP_HIDDEN_HEADER web/src
```

| 文件（相对 `web/src/`） | 注释内容 |
| --- | --- |
| `constant/navigation-tools.ts` | 视频创作台导航条目，桌面及手机菜单共用 |
| `components/layout/app-top-nav.tsx` | Agent 顶部按钮及自动连接 effect |
| `components/layout/user-status-actions.tsx` | 文档、语言、版本、GitHub 入口 |
| `layouts/user-layout.tsx` | Agent 面板挂载，避免旧展开状态留下侧栏 |
| `components/canvas/canvas-top-bar.tsx` | 画布文档菜单项、Agent 状态、按钮及分隔线 |

恢复时，仅去掉标记旁对应的 `/* ... */`、`{/* ... */}` 或单行 `//` 注释；不要把说明性注释当作代码。Agent 的按钮、面板与自动连接应一起恢复。相关导入、状态和原始组件仍保留，因此无需重写功能。配置入口、画布插件与快捷键入口未隐藏。黑白主题按钮已恢复，在普通页面、画布和高级编辑器可用；主题沿用原有用户设置，不改变设计画布或导出像素。语言等其余隐藏项仍按原标记保留。

修改后检查桌面与手机导航、跨境设置、商品白底图及画布顶部；确认隐藏入口消失且配置仍可打开，再运行类型检查和构建。

## 文档、备份与工作方式

界面文案使用中文，沿用现有组件与四空格缩进；只改本次需求涉及的范围。用户可感知改动记录在 `CHANGELOG.md` 的 `Unreleased`，待人工确认项目写入 `docs/content/docs/progress/pending-test.mdx`。后续计划在 `todo.mdx`。

升级前 v0.18.0 定制源码备份：`F:/AIVIBI/sanheai/backups/infinite-canvas-pre-v0.19.0-20260916-223632`，恢复步骤见其中 `RESTORE.md`。此备份不包含浏览器业务数据，也不包含本次升级后的规则编辑及入口隐藏；不要当作当前版本完整备份。
