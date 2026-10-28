# polaris-api

DBX 插件 —— **API 资产库**：从 OpenAPI/Swagger 与 Postman Collection 导入接口，
整理为可搜索的目录树；浏览每个接口的方法、路径、参数、请求体与响应 Schema，
一键复制 cURL、导出 Markdown。

- 插件 ID：`com.polaris.api`
- 贡献点：`workbench`（`com.polaris.api.workbench`）
- 入口：`ui/index.html`（纯前端 universal，无原生 sidecar）
- 权限：无（默认离线；从 URL 拉取需 `host.network` 目标域名授权）

## 为什么是「资产库」而不是又一个 HTTP 客户端

DBX 官方商店已有 **HTTP Client**（`com.jettech.httpclient`，Go sidecar 发送任意请求）。
polaris-api 不与它正面竞争，而是补一个它没有的角色：

| 能力 | HTTP Client | polaris-api |
|---|---|---|
| 构造 + 发送任意 HTTP（sidecar） | ✅ | — |
| **导入 OpenAPI / Swagger** | ❌ | ✅ |
| **导入 Postman Collection** | 环境变量导入（JSON） | ✅ 完整集合树 |
| 目录树浏览 / 搜索 / 分组 | 集合（手写） | 从规格自动建树 |
| 参数 / 请求体 / 响应 Schema 阅读 | 点选 | **自动解析展示** |
| 一键复制 cURL / Markdown | 导出一对一 | ✅ 从规格生成 |

定位一句话：**把散落的接口文档变成 DBX 里可搜、可读、可复制的 API 资产库。**

## 使用

1. DBX 插件中心安装本插件（.dbxp 见 Release 或 dist/）。
2. 打开工作台（插件列表 → polaris-api，或连接清单 → polaris-api）。
3. 点击「导入 OpenAPI / Postman」→ 粘贴 JSON / 上传文件 / 填 URL。
4. 目录树自动生成；点接口看详情；搜索、复制、导出。

## 目录结构

```
polaris-api/
├── manifest.json        # Manifest v1：身份、贡献点 workbench、校验
├── dbx-plugin.toml      # 打包：仅 assets/ 与 ui/
├── assets/plugin.svg    # 图标
├── ui/
│   ├── index.html       # 工作台骨架
│   ├── app.css          # 主题令牌 + 样式
│   ├── importer.js      # OpenAPI 2/3 + Postman v2.1 → 统一目录树
│   ├── dbx-bridge.js    # window.dbxPlugin 封装（降级兼容无宿主）
│   └── app.js           # 渲染 / 搜索 / 导入 / 复制 / 持久化
├── scripts/package.mjs  # 生成 .dbxp（zip + checksums）
└── tools/               # 本地验证脚本
```

## 构建

```bash
node scripts/package.mjs
# → dist/polaris-api-<version>-universal.dbxp
```

无需编译、无需原生依赖。产物可按 DBX 本地安装，或提交到 `t8y2/dbx-store` 过审上架。

## 开发 / 验证

- 浏览器直接打开 `ui/index.html`：DBXBridge 无宿主时落回 localStorage，可离线调试导入与渲染。
- 组件接口：`window.POLARIS_API.{loadOpenAPI, loadPostman, loadAuto, toCurl, toMarkdown}`。

## 与 HTTP Client 的关系

不重复、不冲突。HTTP Client 负责「发送」，polaris-api 负责「整理与阅读文档」。
未来可将 polaris-api 选中的接口，以 `executeCommand` 方式交棒给宿主/HTTP Client。

## License

Apache-2.0