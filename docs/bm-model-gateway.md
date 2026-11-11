# BM 模型接口转发

## 使用方式

渠道地址继续填写 `https://bm.clawvp.com/v1`，协议选择 OpenAI，填入自己的 API Key 后保存。生产站和本地开发工作台会把允许的 BM 请求改为同源 `/api/model-gateway/bm/...`，用户不需要手动启用本地代理。

密钥仍由用户的浏览器保存，并随每次请求通过 HTTPS 传递；服务器没有配置默认密钥，不向其他访问者提供任何人的模型额度。其他浏览器需要单独配置自己的渠道。

## 转发范围

只支持固定上游 `https://bm.clawvp.com` 和以下路径/方法：

| 方法 | 上游路径 |
| --- | --- |
| GET、HEAD | `/v1/models` |
| POST | `/v1/images/generations`、`/v1/images/edits` |
| POST | `/v1/responses`、`/v1/chat/completions` |
| POST | `/v1/audio/speech`、`/v1/videos` |
| GET、HEAD | `/v1/videos/<任务ID>`、`/v1/videos/<任务ID>/content` |

必须提供 Bearer 认证。未知目标、管理路径、非允许方法和查询参数不会被转发；上游重定向被阻止，不将认证传给其他域名。普通图片 CDN 地址及其他模型服务商不在此转发范围。

## 服务器配置

- `deploy/nginx-bm-gateway-http.conf` 安装到 `/etc/nginx/conf.d/aoweisi-bm.conf`，定义固定上游及限流。
- `deploy/nginx-bm-gateway-common.inc` 安装到 `/etc/nginx/snippets/aoweisi-bm-common.conf`。
- `deploy/nginx-bm-gateway-locations.inc` 安装到 `/etc/nginx/snippets/aoweisi-bm-locations.conf`，由 HTTPS 站点 include。
- `/etc/infinite-canvas/runtime-config.js` 设置 `bmModelGatewayEnabled: true`，同时保留共享规则配置。
- 验证上游 TLS，透传 Authorization、Content-Type 和 Accept，去掉 Cookie、Origin、Referer；不记录请求访问日志、认证头或请求体。
- 图片请求体最大 128MB，每个 IP 最多 12 个并发请求；上游读取超时 610 秒，关闭缓冲以支持流式文本，不自动重试可能计费的请求。

修改 Nginx 配置后执行 `nginx -t`，通过后再 reload；无效配置不得替换正在运行的版本。

## 本地开发

Vite 使用同一路径，固定转发到 BM。开发请求需要符合来源、路径、方法与认证检查；不允许客户端指定其他上游，不跟随重定向，也不代理 WebSocket。Vite Preview 不继承开发转发。生产部署必须使用 Nginx 配置，不能把开发服务器直接暴露到公网。

## 检查与边界

密钥验证使用只读模型列表接口；200 和模型列表表示该密钥可读取模型，不代表余额、图片额度或所有模型能力均已实测。401/403 应核对渠道密钥，429 应稍后重试或检查服务商额度。无需为了排查问题把密钥写进日志、源码、文档或 URL。
