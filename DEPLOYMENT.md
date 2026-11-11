# 奥维斯AI生图：服务器部署与维护

## 2026-10-04 白底图调整面板 OOM 修复（当前版本）

- 当前前端：`/opt/infinite-canvas/releases/aoweisi-white-oom-fix-20261004`，入口 `main-CeDsiie8.js`。自动准备调整面板不再对已有白底结果调用本地 ORT 抠图模型，改用浏览器白底像素透明化，避免 `std::bad_alloc`；原图保留，处理失败仍可重试。
- 类型检查、21 项编辑回归测试、生产构建及线上独立浏览器保存流程通过。发布包 SHA-256：`884d8b3c669139ad6ded97fb03c69951f2cf20b3efe69a2aac2845b6bc17eb92`。旧版 `aoweisi-white-auto-edit-20261001` 保留供回滚。

## 2026-10-01 白底图生成后直接调整

- 当前前端：`/opt/infinite-canvas/releases/aoweisi-white-auto-edit-20261001`，入口 `main-BwEkObIt.js`。AI 白底图和不透明 API 结果生成后自动准备商品图层并打开调整面板；透明 API 结果直接复用图层。右侧面板顶部新增“保存调整”。准备失败时保留生成结果，支持只重试图层准备，不重复调用生图。
- 类型检查、格式检查、生产构建、21 项相关回归测试和 7 个浏览器流程场景通过。外部生图和抠图在本地流程测试中使用受控响应。真实线上独立浏览器验证了面板内调整和保存，未调用模型或写入服务器业务数据；线上入口资源与本地构建逐字节一致。
- 发布包 SHA-256：`f35f771fbea79f4d8bd4274f22d166b20b13b8abf542c0cd4583348c52154f15`；发布与核验记录：`F:/AIVIBI/sanheai/backups/white-auto-edit-20261001/`。旧版 `aoweisi-white-options-20260930` 保留供回滚。配置、公开规则及三个现有服务状态核验正常。

## 2026-09-30 商品白底图处理选项调整

- 当前前端：`/opt/infinite-canvas/releases/aoweisi-white-options-20260930`，入口 `main-DxsP_RJf.js`。去除商品白底图中的“精准抠图（本地）”选项及对应首次下载提示，默认使用“AI 白底优化”，保留已配置的抠图 API；已有图层编辑流程保持兼容。
- 类型检查、生产构建、本地及真实线上浏览器下拉菜单检查通过。发布时保留旧静态资源；Nginx、个人模型转发、配置同步服务正常，运行配置和公开规则摘要与发布前一致。
- 本地发布和核验记录：`F:/AIVIBI/sanheai/backups/white-options-20260930/`。发布包 SHA-256：`878c46c7bdd47d1562e768eba187498f2d3f7fef54825d4b04547ba2b395e205`。前端可原子回滚到 `aoweisi-settings-sync-20260930-113557`；本次未更新配置服务或用户数据。

## 2026-09-30 跨设备配置同步修复

- 当前前端：`/opt/infinite-canvas/releases/aoweisi-settings-sync-20260930-113557`；配置服务：`/opt/aoweisi-config-vault/releases/aoweisi-settings-sync-20260930-113557`。更新现有config-vault，不恢复旧managed访问码服务。
- 复用Always API账号会话，新增个人完整设置、团队草稿／发布／附件及版本检查。个人资料仍按账号AES-GCM加密；旧`/config`客户端不会清除新设置域。配置迁移操作见 [跨设备同步说明](docs/cross-device-settings.md)。
- 现有主账号ID `1` 已由私有管理员列表授权；文件为 `/var/lib/aoweisi-config-vault/team-admin-users.json`，不在网页静态目录。模型密钥不代表团队管理权限。
- Nginx配置服务路由显式转发`X-Config-User`，请求体上限30MB、相关超时60秒；服务MemoryMax调为512M。单附件最多20MB，前端附件上传超时120秒。
- 一致备份保存在 `/root/aoweisi-releases/aoweisi-settings-sync-20260930-113557/`，包括旧systemd单元、旧Nginx片段、加密配置数据与主密钥。目录仅root可读。升级前后原个人配置记录摘要完全一致；公共运行配置、旧公开规则目录均未修改。
- 本地真实服务双浏览器验收通过。线上配置入口、静态资源、新API未登录401及Nginx／配置服务／模型转发active已核验。未调用真实生图模型。
- **旧电脑真实浏览器数据尚未迁移**：本任务未能连接旧浏览器会话，不能从服务器找回从未上传的类目、品牌或附件。用户需在旧电脑服务器网站执行一次迁移；新电脑随后登录同一账号即可恢复。
- 回滚前端可切回 `/opt/infinite-canvas/releases/aoweisi-category-hierarchy-20260924-203752`。服务和Nginx配置从上述备份恢复后重载／重启；不要用备份覆盖新增用户配置数据，除非明确执行数据恢复。

## 2026-09-24 本次完整程序同步

- 当前前端已切换为 `/opt/infinite-canvas/releases/aoweisi-category-hierarchy-20260924-203752`，包含配置页的“大类 → 子类”分组、原文件要求及10张示例图，以及本次打包的其他前端更新。
- 完整源码与构建包私密留档在 `/root/aoweisi-releases/aoweisi-category-hierarchy-20260924-203752.zip`，SHA-256：`b6a8672e10680c042ed83888445b0ca8bf0582eab5d2d697d962bffd675d8195`。公开网站仅使用其中 `web/dist`，不暴露源码包或部署材料。
- 旧版本 `/opt/infinite-canvas/releases/aoweisi-always-api-copy-20260922` 保留。新目录保留旧静态资源，以兼容已经打开的页面；`current` 使用原子符号链接切换。
- Nginx配置、`/etc/infinite-canvas/runtime-config.js`、现有公共规则目录摘要与部署前一致；Nginx、个人模型转发和个人配置同步服务正常。没有恢复已停用的访问码服务，没有修改用户数据库或浏览器工作区。
- HTTP已核对入口、配置页、5个入口资源及10张示例图的摘要。部署记录：工作区 `backups/aoweisi-category-hierarchy-20260924-203752/verified.json`；只读浏览器验收材料：`web/test-results/category-server-sync-20260924/`。
- 回滚时将 `/opt/infinite-canvas/current` 原子切回上述旧版本；不要覆盖当前目录或删除用户数据。此部署更新程序，未将文件标准预览自动发布为新的共享规则版本。

## 2026-09-24 本地修复：遗留管理员访问码入口

- 原因：9 月 22 日停用访问码及 `/api/managed` 后，全局配置与跨境设置中的类目面板仍挂载旧 `CategoryAdmin`，要求不可用的管理员访问码。本地 Vite 对未接入的接口返回 HTML，也不能完成管理登录。
- 修复：两个入口统一显示当前已发布规则及类目预览，移除旧管理组件挂载，不再请求旧登录或类目管理接口。可通过现有 `PolicyEditor` 编辑本地规则副本；未设置负责人时引导到 `/commerce/settings` 设置 PIN。读取本地存储期间不开放编辑，共享规则加载失败显示明确提示。
- 范围：本地保存和发布沿用现有负责人 PIN 验证、版本保存与历史任务隔离机制。入口和编辑弹窗均明确只影响当前浏览器。全平台发布及类目层级管理仍暂不可用，不能使用浏览器 PIN 或个人渠道密钥替代服务端管理员授权；本次没有恢复旧网关，也没有修改生产服务器。
- 验证：页面渲染回归与本地规则编辑/保存测试共 61 项通过；另执行 TypeScript 检查与生产构建。源码目录不含 Git 元数据，未创建提交。
- 后续若恢复全平台类目管理，必须独立接入受支持的服务端身份及管理权限校验，并验证草稿、发布、回滚及审计后再开放入口。

## 个人配置服务器同步

当前发布版本为 `/opt/infinite-canvas/releases/aoweisi-server-config-20260922`。已增加“账号与同步”，使用 Sub2API 账号登录，将个人渠道密钥、模型和生成参数加密保存至服务器并在其他设备登录后读取。独立 `aoweisi-config-vault` 服务监听本机 3183，经同源 `/api/config-vault/` 提供认证配置接口；公开运行配置仅包含 `serverConfigEnabled: true`，不包含密钥。

数据位于 `/var/lib/aoweisi-config-vault`，使用 AES-256-GCM；主密钥在 `/opt/aoweisi-config-vault/master.key`，通过 systemd credential 提供。配置和会话按用户隔离，写入带版本冲突检查。设备代理、WebDAV、画布和素材不参与此次配置同步。部署及恢复说明见工作区 `outputs/sub2api-restore-20260922/SERVER-CONFIG.md`。

## 2026-09-22 Sub2API 接入

当前生图发布目录已切换至 `/opt/infinite-canvas/releases/aoweisi-channel-setup-20260922`。新增渠道 `https://llm.zhitouzhuan.com/v1`，通过同源 `/api/model-gateway/sub2api/v1/` 转发到本机独立 Sub2API，需调用者个人 Bearer 密钥；原 BM 转发保留。运行配置 `sub2apiModelGatewayEnabled: true` 仅在此部署启用。个人配置已通过私密一次性页面写入浏览器，并取得持久化成功回执；临时配置服务已停止，入口返回 410。

“导入配置”新增支持 `app: "infinite-canvas-channel", version: 1` 的单渠道文件，保留其他渠道及工作区数据，并绑定文件中的图片和文本模型。密钥不得加入公开静态资源。完整恢复、初始化、验证和回滚记录位于工作区 `outputs/sub2api-restore-20260922/README.md`。

## 当前部署

- 网站：**https://103.79.187.126**
- 跨境设置：https://103.79.187.126/commerce/settings
- 系统：Debian 13，Nginx 静态前端＋Node.js 20 个人凭据转发服务，开机自启。
- SSH：`ssh -p 54055 root@103.79.187.126`。密码不保存在仓库中。
- 版本：奥维斯AI生图（基于 v0.19.0），包含跨境规则编辑、白底工作台、已注释的导航入口及完整工作区迁移。
- 发布目录：`/opt/infinite-canvas/releases/aoweisi-server-config-20260922`。
- 生效目录：`/opt/infinite-canvas/current`，符号链接指向发布目录。
- Nginx 站点配置：`/etc/nginx/sites-available/infinite-canvas`，通过 `sites-enabled/infinite-canvas` 启用。
- 公网使用 80/443，HTTP 自动转 HTTPS；不对外开放 Vite 开发服务。

前端发布已检查的 `web/dist`，不是官方容器镜像。2026-09-22 起移除访问码，所有模型服务使用程序内的个人渠道配置。`aoweisi-provider-relay` 使用 Node.js 20，在 127.0.0.1:3181 提供 fal/Azure 受限转发，不注入共享密钥。旧 `aoweisi-model-gateway` 已停用并取消开机启动，历史数据库保留；旧 `/api/managed` 返回 410。原有 BM 自带密钥转发仍保留。

## HTTPS 与续期

使用 Let's Encrypt 的 IP 短期证书，证书名称为 `infinite-canvas-ip`。证书位于 `/etc/letsencrypt/live/infinite-canvas-ip/`；私钥只留在服务器，不能复制进仓库或静态发布目录。

Certbot 位于 `/opt/certbot/bin/certbot`，通过 Python 虚拟环境安装。`infinite-canvas-cert-renew.timer` 每日检查两次，续期成功后重新加载 Nginx。续期使用 80 端口下的 `/.well-known/acme-challenge/`，请保持公网可达。

```sh
systemctl status nginx --no-pager
systemctl list-timers infinite-canvas-cert-renew.timer --no-pager
systemctl status infinite-canvas-cert-renew.service --no-pager
journalctl -u infinite-canvas-cert-renew.service --no-pager -n 30
/opt/certbot/bin/certbot certificates
/opt/certbot/bin/certbot renew --dry-run --no-random-sleep-on-renew
```

首次签发、公网 HTTPS 校验和模拟续期均已通过。证书没有配置联系人邮箱，续期异常请通过上述日志检查。

## 备份与回滚

- 首次部署前的 Nginx 配置：`/opt/infinite-canvas/backups/nginx-before-first-deploy`。
- HTTP 初始配置：`/opt/infinite-canvas/backups/nginx-http.conf`。
- 本次发布包：服务器 `/root/infinite-canvas-v0.19.0-custom.tar.gz`；本地 `F:/AIVIBI/sanheai/backups/deployment-20260916/infinite-canvas-v0.19.0-custom.tar.gz`。
- 发布包 SHA-256：`a8974467676f5fd3eac194050776793a5734067c1a1a71696b4f90a474d4f7d7`。

旧目录 `/opt/infinite-canvas/releases/v0.19.0-custom-20260916` 与 `/opt/infinite-canvas/releases/aoweisi-v0.19.0-migration-20260916` 均已保留。当前完整安装包为 `/root/aoweisi-data-sync-final.tar.gz`，SHA-256 为 `8d9ce34bdf9bf6d61102b96790b6e4e5c7092964ec571667269f3bd63680cec5`，已通过 71 项测试、类型检查与生产构建。今后更新时继续保留当前目录和配置备份，将新包解压到新版本目录后原子切换 `current`，不要直接覆盖当前目录。回滚到旧版不会删除独立存放的数据快照。

仓库 `deploy/` 保存 HTTP 初始配置、HTTPS 配置及续期 systemd 单元，可供重建环境时使用。不要在证书签发前启用引用证书的 HTTPS 配置。

## 用户数据和模型配置

**规则、接口配置与工作区分开处理：**已发布规则和方案由服务器公开提供；模型地址、密钥和模型通过“配置 → 渠道”设置，高级工具在“高级图片工具”中绑定。个人任务、画布、配置和生成记录属于浏览器工作区，不随公共规则下发。

本项目使用浏览器 IndexedDB/localStorage。**服务器网址与 localhost 的浏览器数据独立**。新增的完整工作区迁移会先上传受保护快照，再在服务器网址下恢复浏览器工作区；不是多用户共享数据库，也不是持续双向同步。

- 不再使用访问码。个人配置导出包含本人密钥，必须私密保存，不得放入网站目录。
- 跨境规则可重新导入原 Excel；画布使用已有导出/导入能力。普通模型配置导出不能视为完整跨境任务数据备份。
- 本地抠图首次使用仍需在浏览器下载模型；跨域模型接口及 WebDAV 仍受浏览器 CORS/HTTPS 规则限制。
- 高级接口使用调用者提供的密钥，不提供公共共享模型额度。工作区快照仍需原迁移凭据，旧授权数据库不删除。

## 完整工作区迁移

- 入口：配置 → 本地存储 → 工作区迁移与备份；独立页面 `/workspace-transfer.html` 支持完整 ZIP 导出/导入。
- 范围：需求规则、品牌、任务、审核、画布、素材、白底记录、模型配置和图片/媒体原文件；可重建的预览与提示词缓存不打包。源数据不会删除。
- 服务器快照目录：`/var/lib/aoweisi-sync/private-data`，与公开静态根目录分离。
- HTTPS 接口：`/private-data/snapshot-*.zip`；HTTP Basic 用户 `owner`，使用随机迁移凭据（不是 SSH 密码）。无凭据返回 401；已有快照的 PUT 返回 409，防止重试覆盖。
- 认证哈希：`/etc/nginx/aoweisi-workspace.htpasswd`；配置片段：`/etc/nginx/snippets/aoweisi-private-data.conf`。二者不进入公开网站目录。
- 本次迁移的凭据与授权文件只在本机 `F:/AIVIBI/sanheai/backups/workspace-transfer-private/`，其中 `credential.json` 属于私密文件，不要提交或公开。开发授权 `bootstrap.json` 有有效期，只允许同源本机请求读取；上传完应关闭授权。
- 开发授权结果 `result.json` 和远端 `*-restored.zip` 回执仅记录数量、时间、字节数及摘要，不含模型密钥或原始数据。
- 恢复前会验证附件摘要并拒绝覆盖有业务数据的目标工作区；只替换空工作区或严格匹配的初始默认设置。批量数据库写入使用事务。

本次已在服务器核验的快照为 `snapshot-20260916154258578-0a1e774394a64f1b.zip`，大小 **428,859,915 字节**，SHA-256 为 `a9b9e9fc15992e281db5dcd610970bd326eeadf981ef7bb5dc37cd50bc8bdf21`。内容包括 **3 个任务、3 个画布、1 个品牌、3 份规则包、228 个图片文件、17 个已生成图片资产记录**；当前 v3 规则包有 **40 个需求方案和 87 张参考图关联**。服务器文件上传核验与浏览器恢复完成是两个独立步骤，后者以恢复回执和页面结果为准。

**本次恢复已完成**：服务器回执 `snapshot-20260916154258578-0a1e774394a64f1b-restored.zip` 记录 `restoredAt=2026-09-16T16:30:07.512Z`（北京时间 2026-09-17 00:30），恢复摘要与源归档一致；恢复后读取得到 3 个任务、3 个画布、3 份规则包、228 个图片文件、1 条白底记录和 3 个本地配置键。浏览器已返回服务器跨境设置页，并显示原 v3 奥维斯规则、40 个方案和原负责人。源端数据保留，一次性开发授权已关闭。其他浏览器/设备需要单独通过受保护归档恢复，不能把本次迁移理解为全设备实时共享。

维护时可运行 `python3 /root/inspect-workspace.py /var/lib/aoweisi-sync/private-data/<实际快照文件名>`，只输出数量及校验信息，不输出密钥。不要把快照移入 `current` 或其他公开目录。

## 发布检查

### 高级通用生图、主题与个人渠道（2026-09-22）

- 前端：`/opt/infinite-canvas/releases/aoweisi-advanced-personal-20260922`。
- 转发服务：`/opt/aoweisi-provider-relay/releases/20260922`，`current` 指向该版本；`aoweisi-provider-relay.service` 已启用。
- 回滚备份：`/opt/infinite-canvas/backups/advanced-personal-20260922`，包含旧运行时配置、旧 managed 路由、站点配置及前一版本目录记录。
- 前一版本：`/opt/infinite-canvas/releases/aoweisi-product-white-editor-20260921`。旧静态资源保留兼容已打开的页面。
- 前端包 SHA-256：`924323e2552cb17de034cce0c6d3788235383b09a14f743e8e00d638627bcbc6`。
- 安装 Debian 官方 Node.js 20.19.2，服务器运行 5 项转发测试通过；修正软链接版本目录的服务启动判断，并确认新服务 active/enabled。
- 保留证书、站点主体配置、公共规则、私有工作区迁移和 BM 路由；相关配置哈希检查一致。
- 公网 HTTPS 浏览器检查通过：高级入口无访问码、主题刷新保持、编辑稿创建保存、原生渠道设置及工具绑定。旧访问码接口返回 410，新转发缺少密钥返回 401、跨站请求返回 403、未知模型返回 404；未执行付费模型调用。
- 当前配置方式见 [高级图片工具说明](docs/advanced-image-editor.md)。以下历次访问码网关的记录仅用于历史追溯和回滚，不代表当前仍启用。

如需回滚，先恢复备份中的 `managed-locations.conf` 和 `runtime-config.js`，原子切回前一前端目录，运行 `nginx -t`，重新启用旧模型网关后重载 Nginx；新转发服务可停止。不要删除旧数据库或浏览器工作区。

### 商品白底图旋转、缩放与调色（2026-09-21）

当前前端 `/opt/infinite-canvas/current` 指向 `/opt/infinite-canvas/releases/aoweisi-product-white-editor-20260921`。服务器发布包 `/root/aoweisi-product-white-editor-20260921.tar.gz`，SHA-256 为 `adab741d15165ca9bcbadc3e641919967efae4f6d49eb8870861239926d09991`，入口为 `main-BpzHTuge.js`。本地包、发布前后状态及线上核验记录位于 `F:/AIVIBI/sanheai/backups/product-white-editor-20260921/`。

新增独立透明商品图层、自由旋转、等比缩放、拖动、色温／色调／饱和度／亮度／对比度调整、调色前对比和还原；草稿可恢复，保存调整保留旧版本，下载及各个使用入口统一采用当前调整结果。历史记录首次编辑从已有生成结果提取商品，并保留构图。

发布前 30 项专项测试、类型检查、生产构建及两组共 27 个浏览器场景通过；工作簿导入的 8 项测试单独复跑通过。全量套件未完成，不计为全量通过。PNG 预览与导出逐像素一致，背景纯白、96 DPI、四种 JPG 尺寸及 PNG 超限报错均已验证。外部抠图模型与 API 在本地交互验收中使用受控响应，未调用付费生图。

线上白底页面、跨境页面、设置页、入口脚本、CSS、运行时配置、公开规则及匿名会话接口均返回 200；HTML 和入口资源与本地已测试构建逐字节一致。真实线上浏览器已确认新版入口启动、访问码授权页可见且无页面运行异常；编辑操作验收在本地独立浏览器工作区完成。Nginx 与模型服务 active，Nginx 配置、运行时设置和公开规则摘要与发布前一致，访问码、模型数据库及工作区数据未修改。

回滚可原子切回 `/opt/infinite-canvas/releases/aoweisi-commerce-zip-workbook-20260921`，原目录已保留；无需修改 Nginx 或模型服务配置。部署核验记录保存了发布前后的目录及配置摘要。

### 商品 ZIP 内含 Excel 导入修复（2026-09-21）

当前前端 `/opt/infinite-canvas/current` 指向 `/opt/infinite-canvas/releases/aoweisi-commerce-zip-workbook-20260921`。服务器包 `/root/aoweisi-commerce-zip-workbook-20260921.tar.gz`，SHA-256 为 `02776facb8708a2cbb0749d0fd726fac6ae3d641111bcaa3aca6393e8026eabd`，入口为 `main-CJDPXooq.js`；本地包在 `F:/AIVIBI/sanheai/backups/commerce-zip-workbook-20260921/frontend.tar.gz`。

旧版仅检查左侧单独选中的 Excel，即使 ZIP 包内已有商品工作簿也提示未上传。新版在未单独上传 Excel 时读取 ZIP 中唯一的 .xlsx，忽略 Office 临时锁文件；多个 Excel 要求明确选择，纯图片 ZIP 提示补传 Excel；ZIP 可有一层外包装目录，继续按 SKU 关联图片。浏览器使用无私人数据的 Excel+图片 ZIP 创建任务成功，SKU 源图片为 1 张；纯图片 ZIP 提示准确。新增 5 项回归测试，完整 627 项测试、类型检查及生产构建通过；线上跨境页、设置页、入口脚本、运行时配置和公开规则均返回 200，Nginx 与模型服务 active。未调用付费生图；原工作区及服务器规则、访问码和数据库不变。前一发布目录 `aoweisi-commerce-upload-layout-fix-20260920` 保留供回滚。

### 跨境任务上传列表布局二次修复（2026-09-20）

当前前端 `/opt/infinite-canvas/current` 指向 `/opt/infinite-canvas/releases/aoweisi-commerce-upload-layout-fix-20260920`。服务器包 `/root/aoweisi-commerce-upload-layout-fix-20260920.tar.gz`，SHA-256 `d5224edb393f6df14878a730460c1e6bb0db364d92ca7f00baa3c7cee049de1f`，入口 `main-Ct56FuYi.js`。本地发布包和浏览器前后截图位于 `F:/AIVIBI/sanheai/backups/commerce-upload-layout-fix-20260920` 与上一版的 `commerce-upload-layout-20260920` 目录。

上一版虽隐藏 AntD 上传列表并单独绘制文件行，但 `Upload.Dragger` 外层保持行内布局，新增文件行没有被父级网格计入高度，仍被下方“生成配置”卡片盖住。本次给 Excel 和 ZIP 上传控件外层设置块级布局。浏览器已复现旧版遮挡，并在新版分别选择两种文件、点击两次“移除”，验证按钮可点击；750px 和 375px 窄屏下文件行与配置卡片不重叠。前端 622 项测试、类型检查、构建通过，线上新入口、脚本、运行时配置、公开规则均返回 200，Nginx 与模型服务正常。未提交真实任务或调用付费生图；服务器用户工作区和配置未改动，上一版目录保留供回滚。

### 跨境任务上传列表遮挡修复（2026-09-20）

上一版前端曾指向 `/opt/infinite-canvas/releases/aoweisi-commerce-upload-layout-20260920`。服务器包 `/root/aoweisi-commerce-upload-layout-20260920.tar.gz`，SHA-256 为 `d31658fc07e310a8c024afcdbfba00f5bf3a34ffbf24da0d3d6b93f833c4117f`，入口为 `main-C9-oXEjY.js`；本地包位于 `F:/AIVIBI/sanheai/backups/commerce-upload-layout-20260920/frontend.tar.gz`。用户截图和后续浏览器复现确认该版仍有遮挡，已被上方版本取代。

Excel 与 ZIP 选定后在上传框下方的正常文档流显示名称和“移除”，不显示会被遮挡的 AntD 上传列表；弹窗长内容可滚动。前端 622 项测试、类型检查、生产构建通过；线上跨境页面、设置、入口脚本、运行时配置与公开规则返回 200，Nginx 配置及两项服务正常。未进行浏览器实际文件选择和点击验收，也未调用付费模型。旧目录 `aoweisi-safe-image-filenames-20260920` 原样保留；规则、访问码、数据库、Nginx 和运行时设置未改动。

### 跨境与画布参考图上传参数修复（2026-09-20）

当前前端 `/opt/infinite-canvas/current` 指向 `/opt/infinite-canvas/releases/aoweisi-safe-image-filenames-20260920`。服务器发布包 `/root/aoweisi-safe-image-filenames-20260920.tar.gz`，SHA-256 为 `436de91dffd12c1441be4b89e41b2dfa23808e984a6b5af4f4629abe3f59b086`，入口为 `main-CO7mNDbi.js`。本地发布材料位于 `F:/AIVIBI/sanheai/backups/safe-image-filenames-20260920`。

统一模型服务的 multipart 解析器拒绝中文文件名所形成的非 ASCII 上传头；已在本地用相同图片字节、仅替换文件名复现 ASCII 请求通过而中文请求返回 400 `invalid_request`。现在编辑生图请求对所有参考图仅在上传时生成 ASCII 文件名，实际图像字节、MIME 类型、原始参考图及提示词不变。前端 622 项测试、类型检查、生产构建通过；服务器跨境设置页、画布页、新入口脚本和公开规则目录均返回 200，Nginx 与统一模型服务 active。未运行付费模型，实际生图成功与画面质量仍需用用户任务验收。旧前端目录 `aoweisi-reference-aspect-final-20260920` 保留供回滚；规则、访问码、额度数据库和运行时配置未修改。

### 通用生图参考图画幅修复（2026-09-20）

当前前端 `/opt/infinite-canvas/current` 指向 `/opt/infinite-canvas/releases/aoweisi-reference-aspect-final-20260920`。服务器发布包 `/root/aoweisi-reference-aspect-final-20260920.tar.gz`，SHA-256 为 `0b4863296f07df91c356b506e67583148f5b88566259654055cb2887cfa49d24`，入口为 `main-DtVlFO4F.js`；本地发布材料位于 `F:/AIVIBI/sanheai/backups/reference-aspect-release-20260920`。

通用生图带参考图且指定输出比例时，仅请求中的临时参考图被居中置于目标比例画布，原图和历史记录不变；返回比例不符时显示警告并保留原结果。画布局部编辑和跨境任务既有流程不受此入口开关影响。前端 621 项测试、类型检查和生产构建通过。匿名 HTTP 检查：生图页、跨境设置页、公开规则目录、新入口脚本及运行时配置返回 200；Nginx 与统一模型服务均为 active。未调用付费模型，真实生成结果的画幅仍需用户用实际参考图确认。旧目录 `aoweisi-review-navigation-20260918` 与中间目录 `aoweisi-reference-aspect-20260920` 保留供回滚；未修改公共规则、访问码、额度数据库或服务器运行时配置。

### 审核错误点击定位（2026-09-18）

当前前端 `/opt/infinite-canvas/current` 指向 `/opt/infinite-canvas/releases/aoweisi-review-navigation-20260918`。发布包 `/root/aoweisi-review-error-navigation-20260918.tar.gz`，SHA-256 为 `eebbfc016ba85f15bb5258b3aa90575f7b736e010932e36e33c7e88544e47fed`，入口为 `main-B3d_UWCC.js`；本地发布材料位于 `F:/AIVIBI/sanheai/backups/review-error-navigation-release-20260918`。

跨境任务审核错误现在可点击定位到对应的需求方案、产品参数、事实确认、营销文案、当前版本图片或审核按钮。营销文案错误会自动展开折叠面板，目标控件获得焦点并短暂高亮；内容审核阶段同时显示未人工校对、中文文案缺失和预览来源错误。

验证：101 项相关前端测试、类型检查和生产构建通过；服务器安装包摘要、Nginx 配置、首页入口资源、跨境设置路由和深层任务路由均通过，Nginx 与统一模型服务保持 active。旧发布目录 `/opt/infinite-canvas/releases/aoweisi-uncertainty-confirmation-20260918` 保留，可原子切回；未修改运行时配置、公共规则、访问码、额度数据库或浏览器工作区数据，未调用付费模型。

### 商品待确认信息逐条处理（2026-09-18）

当前前端 `/opt/infinite-canvas/current` 指向 `/opt/infinite-canvas/releases/aoweisi-uncertainty-confirmation-20260918`。发布包 `/root/aoweisi-uncertainty-confirmation-20260918.tar.gz`，SHA-256 为 `bcd1afd6c57d47086c60e94cf88c801cfe90a69e20eae4e73bd06d5551c16d58`，入口 `main--maHnEDe.js`；本地备份为 `F:/AIVIBI/sanheai/backups/uncertainty-confirmation-20260918-151204`，发布材料位于 `F:/AIVIBI/sanheai/backups/uncertainty-confirmation-release-20260918`。

AI 识别结果中的每条待确认信息现在可填写“事实名称”和“核实后的准确内容”，然后确认写入产品事实，也可忽略或恢复待确认。确认单项会撤销受影响的内容审核和合规结果，但不会自动将整组产品参数标记为已核实；忽略只记录处理状态，不进入卖点也不清理成图。旧任务的字符串列表无需迁移即可继续使用。

验证：43 项相关测试、609 项完整前端测试、类型检查和生产构建通过。Nginx 配置检查、首页、任务深层路由和新入口资源均返回 200，Nginx 与统一模型服务保持 active。未调用付费模型。

### 统一模型服务图片格式二次校正（2026-09-18）

后端 `/opt/aoweisi-model-gateway/current` 指向 `/opt/aoweisi-model-gateway/releases/20260918-3`。发布包 `/root/managed-mime-normalization-20260918.tar.gz`，SHA-256 为 `3e02ee1c4d1006906a49491d6454c4fd362f82cac10212ca64af90377c65d5c9`；本地发布材料位于 `F:/AIVIBI/sanheai/backups/managed-mime-normalization-20260918`。

服务器不再仅信任浏览器上传的 `Content-Type`，而是根据图片真实签名识别 PNG、JPEG、WebP 和 GIF，并使用实际 MIME 重建转发请求。这兼容未刷新旧页面和历史任务中“JPEG 内容声明为 PNG”的文件，同时继续拒绝 SVG、空文件及无法识别的非图片内容。

Debian 生产环境 75 项后端测试全部通过。线上零额度临时码使用“JPEG 字节、image/png 声明”提交图片编辑：登录返回 200，编辑返回 429 `quota_exceeded`，证明错误声明已被服务器修复并通过参数校验；临时代码随后停用，临时文件已删除。本次未执行付费生图，模型密钥、正式访问码、额度数据库、规则与前端数据均未改动。

### 图片格式复用修复（2026-09-18）

当前前端 `/opt/infinite-canvas/current` 指向 `/opt/infinite-canvas/releases/aoweisi-image-mime-fix-20260918`。发布包 `/root/aoweisi-image-mime-fix-20260918.tar.gz`，SHA-256 为 `edde1cae26408e744a3bcfb4284618459370a8c2c2785f1e7d704a38e2fc38cc`，入口为 `main-wlQm2dK-.js`；本地发布材料保存在 `F:/AIVIBI/sanheai/backups/image-mime-release-20260918`，源码备份为 `F:/AIVIBI/sanheai/backups/image-mime-fix-20260918-144745`。

本次修复会按文件真实字节识别 PNG、JPEG、WebP 和 GIF，并在模型结果入库及图片重新上传两处校正 MIME。历史上被保存为 `data:image/png`、实际内容为 JPEG 的白底图无需迁移，进入跨境场景生图时会自动修复为 `image/jpeg`。模型密钥、独立访问码、数据库、规则目录、Nginx 配置及运行时配置未改动。

验证：前端完整测试 607 项、类型检查和生产构建通过；Nginx 配置检查、首页、商品白底页和新入口资源均返回 200。生产环境创建零额度临时访问码，以 JPEG 文件和 `image/jpeg` 上传图片编辑接口，登录返回 200、编辑返回 429 `quota_exceeded`，证明请求已通过原先失败的图片参数校验；临时代码随后停用并删除临时文件。本次未执行付费生图。

### 统一模型服务与独立访问码（2026-09-18）

前端包 `/root/aoweisi-managed-access.tar.gz`，SHA-256 `e3afbbfa5d1c23f3cdc6135931107ebc4f95248a7572bfb50dbfc8663d73ca7d`，入口 `main-C8giwO_A.js`。后端 `/opt/aoweisi-model-gateway/current` 指向 `releases/20260918-2`；后端包SHA-256 `9a47e18a0453620bd6f37c33e2d6f50fb43c4406033834beb2c53fa621abc5f8`。源码备份 `F:/AIVIBI/sanheai/backups/managed-gateway-20260918-095145`。

服务 `aoweisi-model-gateway.service` 以独立用户运行，只监听127.0.0.1:3180；配置 `/etc/aoweisi-model-gateway/config.json` 为0640、root持有/专用组只读，状态目录 `/var/lib/aoweisi-model-gateway/` 为0700。密钥经隐藏输入写入服务器，未复制到源码、前端、公共配置或本地交付文件。公开运行时仅新增 `managedModelGatewayEnabled: true`。

已创建User01、User02、User03三个独立码，每码20张图片请求/200次文本请求每天，12小时会话。私密交付清单在本机 `F:/AIVIBI/sanheai/backups/managed-access-private-20260918/access-codes.txt`，ACL仅允许当前管理员和SYSTEM；文件包含访问码，不能公开或整份发给普通用户。服务端原件也在私有状态目录中。管理命令见 [统一模型服务说明](docs/managed-model-gateway.md)。

验证：599项前端测试、类型检查、生产构建通过；Debian实际运行74项后端测试全部通过，包括Windows跳过的权限检查。真实HTTPS认证、Secure/HttpOnly Cookie、同源限制、退出及停用均通过；上游只读模型列表返回200，两项配置模型可用，付费生成请求为0。客户端UI经模拟接口检查桌面/手机布局和失效流程；生产浏览器自动化连接超时，线上版本及匿名授权响应由HTTP确认。跨标签页请求必须匹配发起人，否则扣额度前拒绝。

Nginx新增 `aoweisi-managed` 独立限流区，在读取大请求前按IP限制6请求/秒、突发12、最多12连接；Python另有身份、字节预算和模型并发校验。原配置备份为 `/opt/infinite-canvas/backups/nginx-before-managed.conf`、`runtime-before-managed.js`，旧前端 `aoweisi-scene-framing-20260918` 保留。回滚须恢复前端及运行时开关，保留私有配置/数据库；不应删除访问码或工作区数据。

### 场景白条修复（2026-09-18）

发布包 `/root/aoweisi-scene-framing.tar.gz`，SHA-256 为 `980678e483950ccaa70e55d7bd4d22fb2fe4225da324a0e21bf9f9b464fe35ed`；前端入口 `main-LI9WZZI-.js`。本地发布材料保存在 `F:/AIVIBI/sanheai/backups/scene-framing-release-20260918`。

本次仅切换静态程序目录，Nginx配置、运行时配置及推荐规则目录的SHA-256与发布前一致；规则仍为 `aoweisi-creative-v5-a16342322f67`，32项方案。页面、脚本和规则入口可访问，模型网关未认证请求返回401。沿用上一步通过类型检查、完整测试及生产构建的产物；未调用真实付费模型。

旧目录 `/opt/infinite-canvas/releases/aoweisi-creative-v3-20260918` 原样保留，可原子切回 `current` 回滚，无需修改规则和运行时设置。用户刷新页面后新生成生效，旧白条图片需明确重新生成，不自动扣费重跑。

### 商品信息建议与推荐流程 v3（2026-09-18）

当前发布包 `/root/aoweisi-creative-v3-final.tar.gz`，SHA-256 为 `69ed477f86c9f92918ad5cf2c356740a009c13e5739c27f98710bcef93f9f314`；页面引用 `main-BQTe-vM3.js`。发布前源码备份为 `F:/AIVIBI/sanheai/backups/commerce-creative-v3-20260917-211547`，本地发布材料位于 `commerce-creative-release-20260917`。

规则入口 `/public-rules/catalog-creative-v1.json`，版本 `aoweisi-creative-v5-a16342322f67`；32项推荐，四类各8项、各默认开启4项，默认开启方案均采用自然窗光。参考资料仍保留87个关联、84个去重图片。规则文件 SHA-256 为 `891fa8906561a2c908907c386c340253f661c1e1e83b791fdfeaa44500d91d7a`。新增运行时键 `commerceCreativePolicyCatalogUrl`，旧v3/v4入口、品牌和私人模型数据均不改写。

验证：526项前端测试、5项公共发布测试、类型检查和生产构建通过；浏览器在独立 `127.0.0.1` 存储中检查四类默认选择及数量。模拟识图验证首次点击、上传缓存、默认采用保护及关闭后迟到响应，未调用真实模型。生产静态页面、构建文件、运行时设置及新规则版本通过HTTP核验，最终版本84/84参考图片可访问，旧目录版本不变；生产浏览器自动化连接失败，不能记为线上交互验收。未认证模型网关及私人备份均返回401。

行为、接口和实图验收边界见 [v3说明](docs/commerce-creative-v3.md)。旧任务通过“使用新版方案创建副本”使用新推荐，不强制替换原任务。

回滚基线为 `/opt/infinite-canvas/releases/aoweisi-visual-v2-20260917`；运行时与Nginx备份分别为 `/opt/infinite-canvas/backups/runtime-before-creative-v3.js`、`nginx-before-creative-v3.conf`。代码回滚时恢复对应运行时入口，不删除新规则目录或浏览器数据；新v3任务需恢复兼容代码后继续处理。

### 需求画面流程 v2（2026-09-17）

已发布 `/root/aoweisi-visual-v2.tar.gz`，SHA-256：`34f92fffbaf52dc8a51ebf113d38042ecaa3d96f74b60be0438d36eaa0af8268`。本地源码修改前备份：`F:/AIVIBI/sanheai/backups/commerce-visual-fix-20260917-172109`；构建、规则及审计清单位于相邻的 `commerce-visual-release-20260917`。

新客户端经运行时键 `commerceVisualPolicyCatalogUrl` 读取 `/public-rules/catalog-visual-v2.json`，版本为 `aoweisi-v4-3e62e18c1632`，包含四类 40 项需求（11/11/9/9）、87 个参考关联及 84 个去重图片。原 `/public-rules/catalog.json` 保持 v3，旧标签页不会被投喂新默认规则。Nginx 为新目录增加了只读、禁止缓存的精确路径，私有快照和 BM 网关设置保持不变。

验证：357 项前端测试、类型检查、生产构建、2 项公共导出隔离测试通过；新版 HTML 引用 `main-CRejUBTO.js` 且资源返回 200；公开 v3/v4 目录同时可读，84/84 参考图 HEAD 检查通过，服务器文件摘要已验证。本地浏览器确认历史收纳筐任务仍为 6/6、可导出并显示升级入口；生产浏览器自动检查超时，不能当作完成交互验收。40 项模型请求使用模拟接口，未为发布调用付费生图；真实商品及面板效果仍需人工验图。

详细行为及已知画布边界见 [需求画面流程说明](docs/commerce-visual-pipeline.md)。旧任务须显式升级新修订，不自动重跑。新版规则会要求确认实测参数、配盖及竞品对比依据，缺失要求可补全或关闭。

回滚前端可将 `current` 原子切回 `/opt/infinite-canvas/releases/aoweisi-bm-gateway-20260917`，同时恢复 `/opt/infinite-canvas/backups/runtime-before-visual-v2.js`；Nginx 备份为 `nginx-before-visual-v2.conf`。无需删除 v4 参考目录或用户数据。已建立的 v2 任务不能交由旧执行器继续生成，应保留数据并恢复新版后再处理。

### BM 模型跨域修复

当前发布包 `/root/aoweisi-bm-gateway.tar.gz`，SHA-256 为 `8359b5a6a2258a019b3cd127af48148851466d36c17e38cd3aedadcc1b6b4e7a`。生产开关为 `/etc/infinite-canvas/runtime-config.js` 中的 `bmModelGatewayEnabled: true`，转发范围、Nginx 配置和限制详见 `docs/bm-model-gateway.md`。

已用用户提供的密钥分别验证直连 BM、生产同源接口、本地 Vite 同源接口：均返回 HTTP 200 和 11 个模型。测试密钥仅通过隐藏输入临时使用，未写入源码、部署包或服务配置。240 项自动化测试、类型检查及生产构建通过；未调用付费图片生成来验证。

上一版本 `aoweisi-home-cleanup-20260917` 保留；Nginx 与运行时配置备份为 `/opt/infinite-canvas/backups/nginx-before-bm-gateway.conf` 和 `runtime-before-bm-gateway.js`。本地开发使用 `npm run dev -- --port 3001`，Vite Preview 不提供该代理。

### 首页精简

当前发布包为 `/root/aoweisi-home-cleanup.tar.gz`，SHA-256 为 `8d6d6a38dcc231964d3d92303b0afca926d9760482a5631580cf527ebc99f163`。首屏文案按用户原文更新；“沉淀每一次好结果”及后续展示/预览已注释隐藏，恢复标记为 `TEMP_HIDDEN_HOME_SHOWCASE`。类型检查与生产构建通过。上一版本目录 `aoweisi-product-prompt-20260917` 保留，公共规则与私有数据不受此次界面修改影响。

### 商品基础提示词

当前发布包 `/root/aoweisi-product-prompt.tar.gz`，SHA-256 为 `77fe84e64388107bd01458d02f917efbea905132d075cd673ea31fc9d2f43d3e`。通用生图新增空提示词自动识别商品图并填写六项信息，规则与四类案例见 `docs/product-base-prompt.md`。识别使用用户已配置、支持图片的文本模型，只自动填写文字；生成图片仍需用户点击。已有文字不覆盖，换图后的未编辑自动内容需核对后继续。

154 项自动化测试、类型检查和生产构建通过。识图接口测试使用模拟模型，未为部署验证调用付费模型。上一发布目录 `/opt/infinite-canvas/releases/aoweisi-public-rules-20260917` 保留，可用于代码回滚；共享规则目录、私有快照及浏览器数据不变。

### 公共规则读取

- 公开目录：`https://103.79.187.126/public-rules/catalog.json`，无需登录，禁止缓存旧目录。
- 兼容入口版本：`aoweisi-v3-e39a32a62f12`；新版视觉入口为 `aoweisi-v4-3e62e18c1632`。各含 40 个需求方案、87 个参考图关联，去重后 84 个图片文件。
- 公开文件根目录：`/var/lib/aoweisi-public-rules`，与网站代码版本及私有快照目录独立。
- `/config.js` 由 Nginx 指向 `/etc/infinite-canvas/runtime-config.js`，通过 `commercePolicyCatalogUrl` 告知前端共享规则地址。发布新前端时必须保留此配置。
- 新访客完成本地初始化后自动读取服务器目录；页面显示“共享服务器规则已加载：40 个方案”。原任务仍引用其固定版本，个人品牌、模型配置和历史记录不会被公共数据覆盖。
- 公共规则只读。页面中的“编辑本地副本”以及本地发布不会修改所有人看到的公共版本。共享版本只能由服务器维护者发布，不能把前端 PIN 当成服务器管理员认证。
- 发布脚本 `deploy/publish-public-rules.py` 仅从受保护快照中提取最新已发布规则和绑定图片，按字段白名单生成公开目录；不导出草稿、品牌私有数据、任务、负责人或模型密钥。

更新公共规则时，将新的、已确认要公开的工作区快照保存到私有目录，然后在服务器运行：

```sh
python3 /root/publish-public-rules.py /var/lib/aoweisi-sync/private-data/<实际快照文件名>.zip
```

脚本在完整校验参考图片后原子替换 `catalog.json`，旧公开目录备份保存在 `/opt/infinite-canvas/backups/public-rules/`。使用新快照前应确认公开范围；不要直接把工作区 ZIP 放进公开目录。前端在重新打开或刷新时检查共享版本，旧版本缓存保留用于历史任务。

当前前端发布包 `/root/aoweisi-public-rules.tar.gz`，SHA-256 为 `3fcf43e5ffea868bdef01cb0b8960b560304132eeb598f763b9e38d5bea02e76`。前端 99 项测试、类型检查、构建，以及 2 项公开导出隔离测试通过。独立空白站点存储已实测显示共享规则 40 项、参考图 87 项，负责人保持未配置，未导入私有备份。

本次已验证 HTTP 跳转 HTTPS、可信 IP 证书、续期模拟、首页/跨境设置/白底工作台/画布深层路由返回 200、JS/CSS 资源可访问。服务器文件对应本地已检查的构建产物。

检查远端页面时，应确认隐藏入口、规则编辑窗口、配置入口及白底模式可用。真实生图需要在服务器网址下配置模型；未为部署测试消耗模型额度。
<!-- 2026-09-24 补充验证：本地浏览器 /config → 跨境类目规则已显示新面板，无访问码输入；未配置负责人时编辑禁用并显示设置链接。共享类目优先于本地副本，不承诺本地副本覆盖共享目录。 -->

