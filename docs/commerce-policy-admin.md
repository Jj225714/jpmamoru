# 跨境生图规则管理员运维

此功能不随代码修改自动部署。管理接口与模型网关共用登录会话、同源检查和服务端账号；浏览器本地 PIN 无权发布公共规则。

## 服务端准备

1. 将 `model-gateway/` 的 Python 文件和 `commerce-policy-schema.json` 一并安装到网关程序目录。Python 3.11 或更新版本；安装 Pillow（Debian/Ubuntu 可安装 `python3-pil`，或在网关虚拟环境安装 `Pillow>=10.4`）。缺少解码器时上传明确返回 503，不降级为仅检查文件头。
2. 在现有私有 config.json 增加 `"commerce_public_dir": "/var/lib/aoweisi-public-rules"` 和 `"commerce_catalog_name": "catalog-creative-v1.json"`。该目录必须与 Nginx `/public-rules/` alias 一致。未设置公开目录时仅写入网关 state_dir 下的 `commerce-policies/public-rules`，不会自动暴露到网站。
3. 创建 `/var/lib/aoweisi-public-rules` 并将目录及既有发布内容所有者设为网关服务的 User/Group（以实际 service 文件为准），公共目录 0755，公共文件 0644。保留所有既有 release，旧任务仍需使用。私人 `state_dir/commerce-policies` 不得映射到 Nginx。
4. 更新 systemd unit，其 `ReadWritePaths` 已增加 `/var/lib/aoweisi-public-rules`。配置 `ProtectSystem=strict` 时只赋予这个额外目录写权限；目录必须先创建再启动。应用 unit/config 后重载 systemd 并重启网关。
5. 核对前端 runtime catalog URL 指向 `/public-rules/catalog-creative-v1.json`，Nginx 目录指针禁用缓存，release 内容使用不可变缓存。

## 授予与撤销权限

在网关程序目录执行（替换真实配置和账号 ID）：

```sh
python3 cli.py --config /etc/aoweisi-model-gateway/config.json list-codes
python3 cli.py --config /etc/aoweisi-model-gateway/config.json set-rules-admin --id PRINCIPAL_ID --enabled true
python3 cli.py --config /etc/aoweisi-model-gateway/config.json set-rules-admin --id PRINCIPAL_ID --enabled false
```

新增账号默认无规则权限。每次请求实时查询权限；撤销立即对已有会话生效，无须等 cookie 过期。

## 首次导入与日常发布

登录被授权的账号，打开跨境生图的全平台规则管理。如果已有公开目录，后端自动载入当前最高版本作为初始草稿；使用界面的初始类目导入功能合入 3 个大类、10 个子类及示例图，并保留原有规则和洞洞板、收纳筐。保存草稿、运行校验、查看最终继承要求，然后发布。

普通编辑可复制类目及方案，修改后保存草稿。发布前必须通过结构、枚举、图片摘要、继承、引用和素材用途校验。大类下已有启用子类时，大类本身不要求场景示例；每个启用叶类必须具备对应示例及方案。文字规则由管理员人工校对。

上传只接受可完整解码的 PNG/JPEG/WebP/GIF，最多20MB及4000万像素。私有草稿中的图片地址为认证管理路由；发布复制为 `/public-rules/releases/<revision>/images/<sha256>.<ext>`。商品实拍应上传至商品细节素材区，不能放入公共规则管理。

## API 与一致性

- `GET /api/managed/commerce-policies`：管理员得到 `{canManage,revision,draft,history,activeVersion}`；普通登录只得到权限和生效版本信息。
- `POST` JSON：`action=save` 携带 `revision,package`；`upload` 携带 `dataUrl`；`validate` 可携带 `package`；`publish` 携带 `revision`；`rollback` 携带 `revision,version`。
- 所有写操作必须带同源 Origin、会话 cookie 和 `X-Managed-Principal`。失败采用 `{error:{code,message}}`。版本冲突返回409，校验失败422，权限不足403。
- 保存、发布、回滚返回完整管理员快照；validate 返回 `{valid,errors:string[]}`；upload 返回 `{asset:{id,url,sha256,mimeType}}`。
- 仅支持单个网关进程写入；线程内串行发布及版本乐观锁防止覆盖。不要启动两个共享同一 state_dir 的发布进程。
- 公开目录先完整写入不可变 release，然后持久化发布意图，最后原子替换唯一 catalog 指针。历史、草稿与审计只在指针提交后更新。程序启动及后续请求自动补全未完成的审计记录；切换前失败的孤立 release 不生效。

## 回滚、恢复与检查

从管理界面的历史版本选择回滚，会以旧内容创建更高的新版本，不覆盖既有 release，不自动修改正在进行的任务。旧版本没有的新类目保留为停用条目。已发布类目不能删除，ID不得用于另一个不同概念。

故障时先恢复目录权限或磁盘空间并重启网关。保留 `state_dir/commerce-policies/intent.json`，不要手动编辑它；服务根据公开 catalog 指针判断是否补全提交。备份私人状态目录及整个 public-rules 目录，二者配套恢复。不要只恢复 catalog 却丢弃它引用的图片。

验证命令：`python3 -m unittest discover -s model-gateway -p 'test_*.py'`。更改前端公共包类型时运行 `node model-gateway/sync-commerce-schema.cjs` 更新 Python 使用的结构契约，并运行双向目录解析测试；语义枚举同步维护 `commerce_policy_validation.py`。
