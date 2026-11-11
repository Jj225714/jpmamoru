# 配置保险库（Node.js 22+，无第三方运行依赖）

复用已有账号登录及 AES-256-GCM 密钥。个人设置、会话、配置附件、团队草稿和发布记录均加密存储。不要重新生成已有 `--key-file`，否则旧存档将无法解密。

## 启动与管理员授权

```sh
node server.mjs --origin https://example.com --auth-base http://127.0.0.1:8080/api/v1 --store /private/config-vault --key-file /private/config-vault.key --admin-users-file /private/config-vault-admins.json --public-rules-dir /srv/application/public-rules --port 3183
node admin-users.mjs --file /private/config-vault-admins.json --action grant --user-id 123
node admin-users.mjs --file /private/config-vault-admins.json --action list
node admin-users.mjs --file /private/config-vault-admins.json --action revoke --user-id 123
```

账号 ID 必须来自现有账号服务，不能使用邮箱猜测。默认无人拥有团队管理权限。管理员文件置于私有目录；授权即时生效，无需重启。`--public-rules-dir` 指向实际 `/public-rules/` 静态目录，发布时会校验文件存在。旧 URL 继续由静态服务器分发；新附件使用鉴权保险库接口。

反向代理整个 `/api/config-vault/`，请求体上限建议 30MB、读取超时 60 秒；保留 `Host`、`Origin`、`X-Config-User` 和 Cookie。若配置了 `proxy_pass_request_headers off`，必须逐项显式转发这些头以及 `Content-Type`、`Sec-Fetch-Site`。不能沿用旧 256KB 请求限制，否则附件会被拦截。API 仍仅监听本机。不要把保险库存储目录放进网页静态目录。部署时须同步本目录的 `server.mjs`、`settings.mjs`、`validation.mjs` 和 `commerce-policy-schema.json`。

## 接口

- `GET /settings`：schemaVersion=2、当前账号、manageTeam 权限、personal/team；管理员另获 draft。
- `GET /settings/versions`：各范围修订号，供轮询；无任何密钥。
- `PUT /settings/personal {revision,value}`：原子保存个人设置，返回 SettingsSection。与旧 `/config` 共用个人修订号；旧接口只更新 config，不删除 extras。
- `PUT /settings/team/draft {revision,value}`：保存草稿，返回草稿 section。允许不完整，不允许未知敏感字段、本机附件或商品图绑定。
- `POST /settings/team/validate {value}`：返回 `{valid,errors}`。
- `POST /settings/team/publish {revision}`：修订号为 draft.revision；返回发布 section，草稿同时递增并更新为发布内容。
- `GET /settings/team/history`：管理员获取 `{history:[{version,revision,savedAt,actor,rollbackOf?}]}`。
- `POST /settings/team/rollback {revision,version}`：以指定历史内容发布更高版本；revision 为当前草稿版本。
- `POST /assets {scope,name,mimeType,data}`：data 为标准 base64，scope 为 personal/team，返回 SettingsAsset；支持 PNG/JPEG/WebP/GIF/TTF/OTF/WOFF/WOFF2，单文件最多 20MB，编码后的 JSON 请求体最多 30MB。禁止 SVG/HTML。个人附件隔离到当前账号；团队上传须管理员。
- `GET /assets/team/<sha256>` 或 `/assets/personal/<sha256>`：需登录，返回原始字节。

团队配置的 `TeamSettings.modelConfig` 统一保存渠道（含 API Key）、模型列表、五个默认模型和流程角色。默认模型必须绑定团队渠道；`sceneModel`、`repairModel`、`copyModel`、`translationModel`、`complianceModel` 允许为空，客户端分别回退到团队图片或文本默认模型。管理员才可写草稿、发布和回滚，普通成员只能读取已发布版本。模型配置与类目规则共用团队修订号、冲突检测和不可变发布历史，个人主题、语言、提示词来源、WebDAV 等仍在个人修订号中同步。

所有新写入携带 `X-Config-User: 当前账号ID`，不匹配返回409。会话注销与写入串行，注销后不得保存。权限不足403，未登录401，修订冲突409，校验失败422（可展示原因）。GET须同源 Origin，或浏览器同源 Fetch Metadata。

## 发布、备份与回滚

每次发布先写不可变 release，再原子更新单个 `settings-team.enc`。此文件同时包含生效指针、草稿、历史及审计，避免跨文件提交不一致；中途故障至多产生未引用 release，不会出现部分生效状态。单个服务进程独占存储，不能多进程共写。

发布生成 `server-aoweisi-team-v<version>-<hash>`，品牌也使用版本化 ID。历史任务保留旧版本。已发布类目不能删除；回滚时保留后来新增类目的停用记录。新版本号高于输入和历史版本。

升级前一致备份整个私有存储目录、密钥、管理员文件及前端目录。不要只备份个人记录而遗漏附件。服务可兼容旧 user-N.enc 并保留 `/config`，首次读取旧数据转换为个人 section 而不覆盖原档。程序回滚不要求还原用户数据；团队内容回滚用管理接口生成新版本。

```sh
node --test config-vault/*.test.mjs
```

测试使用临时独立服务和存储，覆盖双账号隔离、双浏览器同账号恢复、首次保存、并发冲突、旧接口兼容、重启、权限、附件、团队发布、回滚和语义校验。不调用真实生图模型。
