# 服务器统一模型服务与独立访问码

## 用户使用

服务器开启 `managedModelGatewayEnabled` 后，访问网站先输入管理员分发的独立访问码。用户不填写模型地址或 API Key；生图、商品识图、文案、翻译和画布图片请求走同源服务。当前启用图片模型 `gpt-image-2` 和文本/识图模型 `gpt-5.5`，不开放视频、音频或用户自定义调用脚本。

浏览器只持有 Secure、HttpOnly、SameSite=Strict 的12小时会话 Cookie；访问码只在提交时使用，不保存进浏览器配置。服务器不下发模型密钥。已有个人渠道设置保留，但托管模式不使用它们；本地开发默认继续个人配置模式。

访问码仅用于模型调用授权和额度，不是完整账号系统。任务、素材和个人品牌仍保存在各浏览器本地；同一浏览器切换访问码不会清空或隔离已有工作区。后续登录可沿用服务器 principal ID。

## 额度与错误处理

- 每个访问码默认每天20张图片请求、200次文本/识图请求，北京时间零点重置；全站默认200张图片、2000次文本请求。
- 每码同时1个图片请求，全站最多4个模型请求；前端图片排队。大请求在读取及解析前也有资源准入限制。
- 批量图片按 `n` 扣次数；背景补全、重试均属于请求。已发往上游的超时/失败保留额度，因为上游可能已计费。次数限制不是人民币费用上限。
- 模型、路由、请求参数与数量由服务端验证，客户端不能自行提高限额或改转发目标。服务端不自动重复付费请求。
- 每次付费请求绑定发起人的 `X-Managed-Principal`，与实际 Cookie 身份不符时在扣额度之前拒绝，避免跨标签页切换访问码误计费。

## 服务器布局与安全

- 服务：`aoweisi-model-gateway.service`，独立非登录用户运行 Python 标准库服务，只监听 `127.0.0.1:3180`。
- 程序：`/opt/aoweisi-model-gateway/current`，独立版本目录；Nginx代理 `/api/managed/`，不给外部直接访问后端端口。
- 密钥：`/etc/aoweisi-model-gateway/config.json`，root持有、专用组只读（0640），不位于静态目录，不进入源码、构建、公共配置或日志。
- 状态：`/var/lib/aoweisi-model-gateway/`（0700），SQLite保存访问码摘要、会话摘要、额度。访问码仅创建时交付原文。
- 登录有频率限制；变更请求严格检查同源 Origin。上游凭据错误映射为服务器配置故障，不要求普通用户输入密钥。
- Nginx在读取大请求前按IP限制6请求/秒、突发12及12个并发连接；此限制独立于按访问码的每日额度。
- 图片外链转为本人会话可读的24小时临时路径。转发仅接受上游图片响应登记的HTTPS公网地址，校验解析IP、每次跳转、文件类型与大小，不把模型Authorization发送给图片主机。
- 原BM自带密钥网关保留兼容旧客户端，不注入服务器密钥。曾在其他地方分享过的旧API Key建议另行轮换；本功能不会让已知旧密钥自动失效。

## 管理访问码

以下命令在服务器SSH中运行；不要把访问码或API Key放进命令行参数、网站目录或公共聊天。创建到文件的方式不会在终端输出访问码。

```sh
runuser -u aoweisi-model-gateway -- python3 /opt/aoweisi-model-gateway/current/cli.py --config /etc/aoweisi-model-gateway/config.json create-code --name User04 --image-limit 20 --text-limit 200 --output-file /var/lib/aoweisi-model-gateway/issued/user04.json
runuser -u aoweisi-model-gateway -- python3 /opt/aoweisi-model-gateway/current/cli.py --config /etc/aoweisi-model-gateway/config.json list-codes
runuser -u aoweisi-model-gateway -- python3 /opt/aoweisi-model-gateway/current/cli.py --config /etc/aoweisi-model-gateway/config.json set-quota --id PRINCIPAL_ID --image-limit 40 --text-limit 300
runuser -u aoweisi-model-gateway -- python3 /opt/aoweisi-model-gateway/current/cli.py --config /etc/aoweisi-model-gateway/config.json disable-code --id PRINCIPAL_ID
```

`PRINCIPAL_ID`为管理编号，不是访问码。停用会同时撤销该码的所有会话；发起中的上游请求可能已经产生费用。初始交付清单位于私密备份目录，不要整份转发给普通用户。

## 检查与回滚

后端：`python -m unittest discover -s model-gateway -p 'test_*.py'`。前端使用类型检查、完整Vitest测试及生产构建。`deploy/check-managed-service.py`检查认证、模型列表、Cookie、同源限制及停用，可选读取上游模型列表，不生成内容。

发布时先启动后端并验证，再装Nginx转发及前端，最后启用公开布尔开关。回滚须同时恢复旧前端与运行时设置，不能保留开关却撤掉后端。不要删除密钥、访问码数据库、私密备份或旧规则版本。真实模型生成效果需要另行验收，模拟测试与只读列表不能代替实图检查。
