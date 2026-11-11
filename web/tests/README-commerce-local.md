# 跨境类目与细节素材本地验收

在 `web/` 运行。所有测试使用独立浏览器上下文，不读写线上规则或用户浏览器数据。

## 真实服务联调

先运行 `npm run build`。Python 环境须有 Pillow 和 cryptography；设置 `COMMERCE_TEST_PYTHON` 为对应 Python 可执行文件后运行：

```text
node tests/commerce-policies.local.e2e.mjs
```

测试启动仅监听回环地址的 HTTPS 8443 服务，加载真实生产构建和 Python 管理接口。测试用临时账号完成登录、图片上传、保存、发布、跨浏览器更新、并发冲突、回滚及只读权限检查。服务不具备外部模型调用能力。结束后关闭服务、删除临时账户与证书。

结果和截图位于 `test-results/commerce-local-real/`。若8443已占用，先停止占用该端口的测试服务；不要关闭不相关的服务。

## 上传与绑定交互

本地开发服务在3000端口运行时执行：

```text
node tests/commerce-categories.e2e.mjs
```

该测试使用真实 React 界面、图片上传及 IndexedDB，模拟管理接口以便控制草稿，验证类目复制、改父类、商品类目选择、细节素材用途、变体共享、主参考绑定及原图排版。接口真实写入由上一项覆盖。

## 回归

```text
npm test -- --run --testTimeout=20000
```

在 `model-gateway/` 使用同一 Python 环境执行 `python -m unittest discover -p "test_*.py"`。前端 `commerce-policy-published.test.ts` 需要另设 `COMMERCE_POLICY_CATALOG_FIXTURE` 指向 Python 发布的10细类目录，未指定时跳过；真实HTTP发布与解析仍由上面的联调测试覆盖。
