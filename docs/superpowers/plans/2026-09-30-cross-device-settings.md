# 跨设备配置同步实施记录

目标：同一账号跨设备恢复个人设置及私密渠道；管理员维护团队类目、品牌及配置附件。历史任务、画布和商品素材不纳入本次同步。

架构：扩展已有config-vault及其会话。个人配置与团队草稿/发布分别版本化；附件存放服务器且验证作用域；前端先恢复后允许自动保存。保留旧/config接口且不能抹除新增设置域。

- [x] 服务端：settings个人/团队读写、权限、附件、兼容、并发测试。
- [x] 客户端：所有持久化配置快照与恢复、账号请求隔离、首次保存、轮询和冲突。
- [x] 网页：统一同步状态、旧电脑迁移预览、团队草稿与发布、附件上传。
- [x] 集成：团队数据注入时保留历史任务版本，生成就绪检查。
- [x] 验证：独立浏览器/真实服务联调，权限及密钥隔离，类型检查与构建。
- [x] 发布：备份config-vault数据和前端目录、升级服务、主账号管理员授权、只读上线检查。
- [ ] 迁移：从旧浏览器已存在的配置迁移，无法访问的浏览器本地数据不得假装已恢复。

接口约定：GET /api/config-vault/settings 返回SettingsEnvelope；GET /settings/versions 返回SettingsVersions；PUT /settings/personal {revision,value}、PUT /settings/team/draft {revision,value}、POST /settings/team/publish {revision} 分别返回对应SettingsSection。POST /assets {scope,name,mimeType,data} 中data为base64，返回SettingsAsset。新写入均携带X-Config-User，与认证账号匹配。旧/config读写保持兼容。

前端类型定义：web/src/types/settings-sync.ts。个人范围含config、modelRoles、webdav、promptSources、appearance；团队范围含policyPack、brands。应用程序代理和所有运行状态保留本机。配置附件经上传后替换本机引用。
