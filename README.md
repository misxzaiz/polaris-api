# polaris-api

DBX 插件 `com.polaris.api` —— API 请求客户端（Rust sidecar 版）。

从 relay-devkit api 模块移植：多 tab、环境变量、cURL 导入导出、Params/Headers/Body 编辑；响应支持表格 / 对象树 / 路径下钻 / 字段筛选 / 图片与时间戳智能渲染。

请求经原生 sidecar（reqwest）发送，无 CORS / 混合内容 / 禁发头限制，等效 cURL。

## 架构

```
polaris-api/
├── manifest.json          # DBX manifest v1，含 backend + ui entrypoint
├── dbx-plugin.toml        # 打包配置（Rust backend）
├── backend/               # Rust sidecar：reqwest 发请求，stdio-jsonl 协议
│   ├── Cargo.toml         # dbx-plugin-sdk + reqwest(rustls-tls-native-roots) + base64
│   └── src/main.rs        # http/request 方法处理
├── ui/                    # 沙箱 UI（无网络，经 dbxPlugin.invoke 调 sidecar）
│   ├── index.html         # #viewApi SPA 骨架（自 relay-devkit panel.jsx）
│   ├── app.css            # 自 relay-devkit main.css 移植，.pa-root 作用域 + DBX 双主题
│   ├── app.js             # 请求客户端主体（多 tab/环境/cURL/响应视图）
│   ├── core.js            # DOM/格式化工具（自 core/dom.js + http.js）
│   ├── json-view.js       # JSON 渲染核心（路径下钻/对象树/表格/过滤）
│   ├── curl.js            # cURL 解析/生成（parseCurl/toCurl）
│   └── dbx-bridge.js      # dbxPlugin 封装（storage 走 host.storage）
├── assets/plugin.svg
└── .github/workflows/plugin-release.yml   # 多平台编译矩阵（引用 dbx 官方 reusable workflow）
```

## 开发

```bash
# 浏览器开发模式（不需 DBX 宿主）
dbx-plugin dev --path . --port 5190

# 构建本机平台的 .dbxp 候选
dbx-plugin package .
```

## 发布

GitHub Release published → `.github/workflows/plugin-release.yml` 自动为所有目标平台编译 unsigned candidate，产出 `release-candidates.json`。DBX Store 审查签名后上架。

## 版本历史

- v0.2.0 — 重构为 Rust sidecar 架构，解决 v0.1.x 跨域不可用问题
- v0.1.x — universal 前端插件（API 资产库方向，已被取代）
