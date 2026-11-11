# Jadmin

入口：客户配置的管理域名。服务默认监听 `127.0.0.1:8090`，由 Nginx 提供 HTTPS。

## 已部署能力

- 管理后台登录、审计、CPU/内存/磁盘/Docker 状态；
- Jchat 用户创建、启用/停用、重置密码；Jchat API 地址、Key、默认模型和模型列表；
- 四个业务模块及配置保险库、模型转发服务的健康状态；
- 通过 JAPI 现有 `/api/v1` 管理接口读取管理员账户、用户、API Key 掩码和用量摘要；
- 读取配置保险库团队管理员，并授权或撤销管理员，操作写入审计记录；
- Jimage页面可达性检查。Jimage 工作区和浏览器 IndexedDB 数据仍需在Jimage内导入。

## 运行依赖

Python 3、`bcrypt`、Docker CLI，以及环境变量 `ADMIN_SECRET`、`ADMIN_EMAIL`、`ADMIN_PASSWORD`。生产环境还需能读取 JAPI `.env` 和配置保险库管理员 CLI；可用以下变量覆盖默认路径：`SUB2API_BASE_URL`、`SUB2API_ENV`、`CONFIG_VAULT_ADMIN_FILE`、`CONFIG_VAULT_ADMIN_CLI`。

Jchat 路径、Mongo 容器名和配置文件也支持 `LIBRECHAT_ENV`、`LIBRECHAT_CONFIG`、`LIBRECHAT_MONGO_CONTAINER`。不要把凭据、`admin.db`、主密钥或真实 API Key 放进公开安装包。

## 新服务器安装

本目录是客户独立安装副本，不包含现网域名、数据库、用户、密钥或保险库主密钥。默认安装目录为 `/opt/enterprise-ai-platform/admin-panel`，所有路径和域名均可通过环境变量覆盖。

1. 安装 Python 3、bcrypt、Docker、Node.js（配置保险库要求 Node.js 22+）。
2. 按 `docs/architecture.md` 部署 Jchat、JAPI、配置保险库、provider-relay 和Jimage 静态站。
3. 复制 `admin-panel.service.example` 为 systemd 服务，写入私有环境文件，并把 Nginx 站点指向 `127.0.0.1:8090`。
4. 首次登录后检查“模块状态与能力”，再用“JAPI与配置保险库”卡片验证接口。
5. 用 `healthcheck.py` 做匿名页面、登录和模块接口验收。

JAPI 的上游账号、分组、额度和 PostgreSQL 数据属于其自身管理范围；当前后台只读取安全摘要，避免绕过它的业务校验直接改库。
