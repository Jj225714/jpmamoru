# Jadmin 源码交付记录

此目录保存 Jadmin 统一管理后台的 Python/JavaScript 源码与公开部署模板。2026-11-11 对照服务器 `/opt/enterprise-ai-platform/admin-panel/`，`server.py`、`setup_wizard.py`、`healthcheck.py`、`models-ui.js`、`modules-ui.js`、`setup-ui.js` 和 `README.md` 的 SHA-256 与服务器文件一致。源文件取自本地 `customer-install/admin-panel/`；该目录与服务器部署一致。较早的 `enterprise-ai-platform/admin-panel/` 版本没有混入。

`server.py` 是后台服务入口，`setup_wizard.py` 用于初始化，JavaScript 文件负责管理界面，`healthcheck.py` 是健康检查。启动模板见 `deploy/admin-panel.service.template`；运行及依赖说明见 [README.md](README.md)。

生产服务器的环境文件、管理员账号、密码、API Key、审计数据库、配置保险库主密钥、缓存及运行数据没有进入 Git。部署新机器时须单独提供受保护的配置文件、数据库或初始化流程；复制本目录不会自动迁移现有用户数据。

本次只归档和上传源码，没有改变线上 Jadmin 服务，也没有对生产端执行重启或发布。
