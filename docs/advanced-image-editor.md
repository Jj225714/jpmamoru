# 高级通用生图：个人渠道配置

入口：生图工作台 → 高级通用生图（`/image?mode=advanced`）。生成结果、历史结果及上传图片均可进入分层编辑器。

程序已移除访问码登录、授权栏和共享模型覆盖。旧运行时开关 `managedModelGatewayEnabled: true` 不再启用访问码。历史生成记录、素材、画布和编辑稿不清空。

## 在程序中配置

所有服务使用原有 **配置 → 渠道** 界面，不再要求服务器设置 fal/Azure 密钥。

1. 通用模型渠道沿用 OpenAI/Gemini 协议、地址、API Key 和模型脚本。
2. 新增渠道，将服务类型选为 **fal 图片工具**，地址填 `https://queue.fal.run`，填写自己的 API Key。默认提供 FLUX Fill、Real-ESRGAN 和 Qwen-Image-Layered。
3. 新增 **Azure Vision 文字识别** 渠道，地址填 `https://资源名.cognitiveservices.azure.com`，填写自己的 Azure Key，模型为 `read`。
4. 在 **配置 → 高级图片工具** 分别选择：消除/扩图 → FLUX Fill；高清 → Real-ESRGAN；复杂拆层 → Qwen-Image-Layered；文字识别 → Azure Read。

识别原图文字只需要 OCR 渠道；清除旧字并建立可编辑文字层还需要消除渠道。未配置的功能显示“前往配置”。删除渠道会使相关工具待配置，不会改用其他模型。

渠道及绑定沿用程序原来的浏览器本地配置保存方式。导出的配置 JSON 包含个人密钥；编辑稿不保存密钥。修改渠道设置不会改变正在运行的任务使用的配置快照。程序不会自动重试付费生成。

## 主题及编辑稿

顶部、画布及高级编辑器均显示黑白模式按钮，主题会被记住。主题只改变界面，不改变图片内容、画布背景或导出颜色。

编辑稿继续独立保存在 IndexedDB，并保留原图副本。已有本地图片仍可读取；仅剩旧服务器临时地址而无本地副本的图片，需要重新导入。PNG/JPG 导出和保存到素材不扁平化编辑稿。

## 转发服务部署

fal/Azure 转发沿用个人凭据。启用任务存储后，配套 Provider Relay 会持久化任务数据；GPT 异步部署、恢复和启用条件见 [部署说明](gpt-image-jobs-deployment.md)。客户安装要求 Node.js 22 或更新版本。

开发和 Vite 预览已内置同一处理器。生产环境：

- 将验收完成的完整 `provider-relay/` 运行模块放入新发布目录，再切换 `/opt/aoweisi-provider-relay/current`；不能只复制 `server.mjs`，不能混用不同版本的任务模块。
- 安装 `deploy/aoweisi-provider-relay.service`。默认沿用已有受限服务账户，监听 `127.0.0.1:3181`。如站点域名变化，修改 `--origin`；不得使用通配来源。
- 更新 `deploy/nginx-managed-locations.inc` 对应的服务器 include。旧 `/api/managed` 路径返回 410；新 `/api/providers` 转发到 3181。不得把旧共享密钥接口改成匿名访问。
- 校验 Nginx 配置，重载新服务和代理，再发布前端构建及新版 runtime-config。旧网关可停止，但无需删除旧数据库或凭据文件。

### 新接口

- `POST /api/providers/fal/submit/{flux-fill|esrgan|qwen-layered}`：仅接受对应模型所需参数。
- `GET /api/providers/fal/requests/{模型别名}/{请求编号}/{status|result}`：读取服务商任务状态和结果。
- `POST /api/providers/fal/requests/{模型别名}/{请求编号}/cancel`：尝试取消指定任务。
- `POST /api/providers/azure/read`：调用配置的官方 Azure 资源。
- `GET /api/providers/media?url=...`：只读取官方 fal.media 的 HTTPS 图片。

模型请求携带本次所选渠道的 Authorization，Azure 额外携带资源名称。转发器限制方法、地址、模型、参数、图片尺寸和请求体积；丢弃 Cookie，不跟随重定向，检查并固定公共 DNS 地址，不记录密钥或上游失败正文。没有用户 API Key 就不能调用付费模型。

## 验证

- `cd web` 后运行 `npm run typecheck`、`npm test`、`npm run build`。
- 根目录运行 `node --test provider-relay/server.test.mjs`，验证接口限制和凭据转发。
- 启动 Vite 后运行 `npm run test:editor:e2e`，再运行 `node tests/personal-channels.e2e.mjs`。
- 浏览器测试使用独立上下文、测试凭据和固定模型结果；截图保存在 `web/test-results/`，不调用付费模型。
- 真实 fal/Azure 效果需用户在配置页面填写有效凭据后单独验收。模拟接口通过不代表真实模型效果已验收。

### 本次验证结果

- 类型检查和生产构建通过。
- 前端 53 个测试文件、654 项测试通过（`npm test -- --maxWorkers=2`）。降低并发避免既有大型工作簿读取测试受资源竞争影响超时。
- 转发服务 5 项测试通过，覆盖调用方密钥隔离、来源检查、地址/路径限制、真实 PNG 尺寸和错误脱敏。
- 分层编辑回归与个人渠道回归均通过；验证了旧访问码开关不生效、原配置保留、服务新增与绑定、刷新恢复、删除渠道提示、主题记忆、图片像素不变以及高级编辑器内的配置弹窗。
- 浏览器回归没有调用访问码接口。专用模型结果仍为测试响应，未宣称已完成真实付费接口效果验收。
