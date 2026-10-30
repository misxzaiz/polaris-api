// backend/src/main.rs — polaris-api sidecar：原生 HTTP 请求代理。
//
// DBX 沙箱 UI 受 CSP/CORS 限制无法发任意 URL 请求。本 sidecar 以本机 OS 用户权限
// 用 reqwest 发请求，无 CORS/混合内容/禁发头限制，等效 cURL/Postman。
//
// 协议：UI 经 dbxPlugin.invoke('http/request', {method,url,headers,body,bodyType,timeoutMs})
//       → 宿主 stdio-jsonl 转发至此 → reqwest 发送 → 返回 {status,statusText,ok,contentType,headers,body,isBase64,timeMs}
//
// 二进制响应（图片/PDF 等）以 base64 返回，UI 侧转 Blob 预览/下载。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use dbx_plugin_sdk::{PluginEmitter, PluginError, PluginHandler, PluginMetadata, PluginServer, RequestContext};
use serde_json::{json, Value};

#[derive(Default)]
struct PolarisApi;

impl PluginHandler for PolarisApi {
    fn handle(
        &self,
        _context: RequestContext,
        method: &str,
        params: Value,
        _emitter: &PluginEmitter,
    ) -> Result<Value, PluginError> {
        match method {
            "http/request" => handle_request(params),
            "polaris-api/ping" => Ok(json!({
                "ok": true,
                "plugin": "com.polaris.api",
                "version": env!("CARGO_PKG_VERSION"),
            })),
            _ => Err(PluginError::method_not_found(method)),
        }
    }
}

/// 处理 http/request：用 reqwest 发送任意 URL 请求。
fn handle_request(params: Value) -> Result<Value, PluginError> {
    let method = params.get("method").and_then(Value::as_str).unwrap_or("GET").to_uppercase();
    let url = params
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| PluginError::new(-32602, "缺少 url"))?;
    let body = params.get("body").and_then(Value::as_str).unwrap_or("");
    let body_type = params.get("bodyType").and_then(Value::as_str).unwrap_or("text");
    let timeout_ms = params.get("timeoutMs").and_then(Value::as_u64).unwrap_or(120_000);

    // headers: { "Name": "value", ... }
    let mut headers: HashMap<String, String> = HashMap::new();
    if let Some(h) = params.get("headers").and_then(Value::as_object) {
        for (k, v) in h {
            if let Some(s) = v.as_str() {
                headers.insert(k.clone(), s.to_string());
            }
        }
    }

    // 构建 reqwest 请求
    let client = reqwest::blocking::Client::builder()
        .timeout(if timeout_ms > 0 { Duration::from_millis(timeout_ms) } else { Duration::from_secs(900) })
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| PluginError::new(-32000, format!("client build: {e}")))?;

    let m = parse_method(&method)?;
    let mut req = client.request(m, url);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    // body
    if !["GET", "HEAD"].contains(&method.as_str()) && !body.is_empty() {
        req = req.body(body.to_string());
        // 若未声明 Content-Type 且为 json/form，自动补
        let has_ct = headers.keys().any(|k| k.eq_ignore_ascii_case("content-type"));
        if !has_ct {
            match body_type {
                "json" => req = req.header("Content-Type", "application/json"),
                "form" => req = req.header("Content-Type", "application/x-www-form-urlencoded"),
                _ => {}
            }
        }
    }

    let start = Instant::now();
    let resp = req.send().map_err(|e| PluginError::new(-32000, format!("send: {e}")))?;
    let status = resp.status().as_u16();
    let status_text = resp.status().canonical_reason().unwrap_or("").to_string();
    let ok = resp.status().is_success();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // 收集响应头
    let mut res_headers = serde_json::Map::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() {
            res_headers.insert(k.as_str().to_string(), Value::String(s.to_string()));
        }
    }
    // 判断二进制：image/audio/video/font/octet-stream/pdf/zip 等
    let is_binary = is_binary_content_type(&content_type);
    let bytes = resp.bytes().map_err(|e| PluginError::new(-32000, format!("read body: {e}")))?;
    let time_ms = start.elapsed().as_millis() as u64;

    let (body_out, is_base64) = if is_binary {
        (BASE64_STANDARD.encode(&bytes), true)
    } else {
        let text = String::from_utf8_lossy(&bytes).to_string();
        (text, false)
    };

    Ok(json!({
        "status": status,
        "statusText": status_text,
        "ok": ok,
        "contentType": content_type,
        "headers": Value::Object(res_headers),
        "body": body_out,
        "isBase64": is_base64,
        "size": bytes.len(),
        "timeMs": time_ms,
    }))
}

fn parse_method(s: &str) -> Result<reqwest::Method, PluginError> {
    match s {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        "PUT" => Ok(reqwest::Method::PUT),
        "PATCH" => Ok(reqwest::Method::PATCH),
        "DELETE" => Ok(reqwest::Method::DELETE),
        "HEAD" => Ok(reqwest::Method::HEAD),
        "OPTIONS" => Ok(reqwest::Method::OPTIONS),
        _ => Err(PluginError::new(-32602, format!("不支持的方法: {s}"))),
    }
}

fn is_binary_content_type(ct: &str) -> bool {
    let ct = ct.split(';').next().unwrap_or("").trim().to_lowercase();
    ct.starts_with("image/")
        || ct.starts_with("audio/")
        || ct.starts_with("video/")
        || ct.starts_with("font/")
        || ct == "application/octet-stream"
        || ct == "application/pdf"
        || ct == "application/zip"
        || ct.starts_with("application/x-")
}

// base64 编码（避免引入额外 crate）—— base64 0.22 用 BASE64_STANDARD 引擎
use base64::prelude::{BASE64_STANDARD};
use base64::Engine;

fn main() -> std::io::Result<()> {
    let metadata = PluginMetadata::new("com.polaris.api", env!("CARGO_PKG_VERSION"));
    PluginServer::new(metadata, PolarisApi).serve()
}
