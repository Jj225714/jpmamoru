# GPT Image 异步任务部署说明

GPT Image 异步接口由 Provider Relay 的配套 job service 提供，使用本机 Sub2API 作为固定上游。部署时必须同时交付完整 `provider-relay/` 目录、systemd 模板、Nginx `/api/providers/` 路由和 JSON 任务文件路径；只复制 `server.mjs` 会漏掉 job service 模块及其测试。

环境变量：

```text
GPT_IMAGE_UPSTREAM_BASE_URL=http://127.0.0.1:8080/v1
AOWEISI_JOB_STORE=/var/lib/aoweisi-provider-relay/provider-relay/jobs.json
JOB_AUTH_SESSION_URL=http://127.0.0.1:3183/api/config-vault/session
JOB_AUTH_COOKIE_NAME=__Secure-provider_tasks
```

这是独立站点 systemd 单元的路径；客户安装包使用 `/var/lib/enterprise-ai-platform/provider-relay/jobs.json`。独立站点由 `StateDirectory` 创建并授权服务账户的数据目录，启动前创建 provider-relay 子目录（0750），任务服务创建 JSON 文件（0600），UMask=0077；不 touch 空文件，不预设 JSON 格式。Nginx 保留原始 Host、Origin、Sec-Fetch-Site、Authorization 和 Idempotency-Key；不伪造来源。连接超时 10 秒，发送/读取超时 75 秒，关闭缓存和上游自动重试。后台生成耗时不应占用提交或轮询连接。

接口为 `POST /api/providers/gpt/jobs`（请求体 `{operation,body}`，带 Bearer、幂等键和可信账号会话）及 `GET /api/providers/gpt/jobs/:id`。服务端负责模型/operation 白名单、用户隔离、重试边界和结果脱敏。网络错误或提交响应不明确时不得自动再次提交；只有明确的限流拒绝才允许按策略重试。

## 可信会话与代理边界

Vault 主 Cookie `__Secure-config_vault` 保持 `Path=/api/config-vault`；任务专用 Cookie `__Secure-provider_tasks` 使用 `Path=/api/providers`。两者均为 Secure、HttpOnly、SameSite=Strict，由 vault 登录/会话续期维护，退出或切换账号时撤销旧会话。不要把主 Cookie 扩到 `/api`。浏览器任务请求使用同源 credentials；已有登录浏览器升级后需要先刷新 vault 会话或重新登录，以获取任务 Cookie。

`deploy/nginx-managed-locations.inc` 只在 `/api/providers/` 提取专用任务 Cookie 交给本机 relay，拒绝重复任务 Cookie；主 Cookie、其他 Cookie 不转发。其他模型代理保持剥离 Cookie。Relay 再只把专用 Cookie 发往固定 `JOB_AUTH_SESSION_URL`，绝不发送给模型上游；渠道 Bearer 也不发送给 vault。客户端伪造的用户 ID header 不能作为所有权依据。

Vault 源码默认监听 `127.0.0.1:3183`（可由 `--port` 改写），systemd 模板因此固定上述 loopback URL；安装前应核对实际服务参数。若端口改变，在受控 systemd override 中同步 URL，路径必须为 `/api/config-vault/session`，不可使用浏览器提供的地址。Relay 与 vault 的公共 origin 必须一致；服务器间调用保留该站点 Host/Origin，通过 vault 每次验证活跃账号，响应的 `user.id` 才用于任务所有权。无需额外服务密钥；不要在文档或日志中记录真实 Cookie/Bearer。

无有效会话拒绝任务访问，验证服务异常不能回退为仅凭共享 key 访问。任务所有权绑定可信账号及渠道 key：A/B 即便共用团队 key，也不能互相列表、猜 ID 读取、取消或恢复任务；同账号新会话可继续访问。该边界是本站任务服务，不改变共享 key 在供应商直接 API 上的权限。

## 升级与旧任务存档

以下是获准上线时的操作步骤，本次配置更新不执行部署：

1. 暂停新任务入口，停止旧 relay 写入后备份任务 JSON、队列加密材料和配置，保留文件权限；不要覆盖或清空旧任务文件。
2. 先交付支持任务专用 Cookie 的 vault，再交付完整 relay、前端同源 credentials 与 Nginx 配置；检查 systemd 的内部认证 URL、公共 origin 和可写目录，运行实际环境的 `nginx -t` 后才重载。
3. 新 Fal 任务文件为 `${AOWEISI_JOB_STORE}.account-v1`，新 GPT 文件为 `${AOWEISI_JOB_STORE}.gpt.account-v1`。原 `${AOWEISI_JOB_STORE}` 及其 `.gpt` 文件作为只读隔离存档，不按共享 key 自动认领，也不恢复旧等待任务。不要把旧文件直接改名为新文件。
4. 旧幂等键命中返回 `409 legacy_task_requires_review`，应人工核对供应商原任务/费用，不自动换新幂等键再次提交。Fal 恢复仅查询已有 providerJobId；GPT uncertain 不得重新触发付费生成。
5. 使用两个真实登录的测试账号共用合成渠道 key 验证列表、猜 ID、取消/恢复、注销/切号、旧任务及重启；检查 vault 与模型上游各自收到的 header，确认 Cookie 不流入模型代理。验证任务通知和刷新不跨账号，再开放入口。
6. 回退时关闭任务入口并保留新旧文件，不能退回 bearer-only 版本后继续对外开放旧任务服务。先调查并恢复可信认证，避免重新暴露共享 key 下的任务。

前端运行时开关 `gptImageJobsEnabled` 默认必须为 `false`。只有在后端模块、完整安装包、Nginx、JSON 持久化和真实 Sub2API 兼容性验收通过后，才可在对应发布包中改为 `true`。GPT Image 的模型、尺寸、编辑输入及响应格式限制必须按实际上游验收，不能把通用 OpenAI 兼容性当作已验证。

GPT running 任务重启后标记为 `uncertain`，不自动重新生成，不能承诺 exactly-once 扣费。GPT 接口仅支持配套后端白名单内的 GPT Image 模型，DALL·E、Gemini 和模型脚本不自动适用；Fal 使用其独立任务接口及模型白名单。单 JSON 存储仅允许单实例写入。完整验收与同步清单见 [客户安装说明](../../customer-install/docs/job-service.md)。尚未生产启用；源码副本待总控通知后同步。
