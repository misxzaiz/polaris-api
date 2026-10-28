/* importer.js — 将 OpenAPI 2 (Swagger) / 3.x 与 Postman Collection v2.1 解析为
 * 统一目录树（API 资产库数据模型）。
 *
 * 输出模型：
 *   {
 *     id: string, version?: string,     // 来源类型 + 版本
 *     root: { id, name, children: [] }  // 顶层分组
 *     nodes: Map<id, EntNode>,          // 全部节点（含 group 与 endpoint）
 *   }
 *
 * Endpoint 节点（index=true 的叶子）：
 *   { kind:'endpoint', id, method, path, name, description,
 *     params:[], headers:[], query:[],      // {name, in, required, type, description, example, deprecated}
 *     body?:{ type, required, description, contentType, schema? },  // schema 描述文本
 *     responses:[{status, description, schema?}],
 *     security:[],                          // 认证要求说明
 *     tags:[], source:'openapi'|'postman' }
 */

(function () {
  const root = typeof self !== "undefined" ? self : globalThis;
  const PA = window.POLARIS_API = {};
  const uid = () => "n" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  /* ---------- JSON 校验 / 类型判断 ---------- */

  function tryJSON(text) {
    if (!text) return null;
    const t = text.trim();
    try {
      if (t[0] !== "{" && t[0] !== "[") return null;
      return JSON.parse(t);
    } catch {
      return null;
    }
  }

  function isOpenAPI(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (obj.openapi || obj.swagger) return true;
    // Postman collection 2.1 也可能不带 info，兜底让调用方判定
    return false;
  }
  const isPostman = (obj) =>
    obj && typeof obj === "object" && (obj.info || obj.variable || obj.item) && !isOpenAPI(obj) && !obj.paths && !obj.components;

  /* ---------- 树构造 ---------- */

  function newGroup(id, name) {
    return { kind: "group", id, name, description: "", children: [] };
  }

  /** 按 /a/b/c 从 root 逐层建立分组并返回末端分组。现有分组复用。 */
  function ensurePath(root, path, nameOf) {
    const parts = (path || "").split("/").filter(Boolean);
    // 保留路径中的 {param} 为叶子，不再分到组名
    const groupParts = parts.filter((p) => !/^\{.*\}$/.test(p));
    let cursor = root;
    groupParts.forEach((seg, i) => {
      let child = cursor.children.find(
        (c) => c.kind === "group" && c.name.toLowerCase() === seg.toLowerCase(),
      );
      if (!child) {
        child = newGroup(uid(), seg);
        cursor.children.push(child);
      }
      cursor = child;
    });
    return cursor;
  }

  function methodColor(m) {
    switch ((m || "").toUpperCase()) {
      case "GET": return "#22c55e";
      case "POST": return "#3b82f6";
      case "PUT": return "#f59e0b";
      case "PATCH": return "#8b5cf6";
      case "DELETE": return "#ef4444";
      case "HEAD": return "#64748b";
      default: return "#64748b";
    }
  }

  const HEADER_USEFUL = new Set(["content-type", "accept", "authorization", "x-api-key", "cookie", "user-agent", "referer"]);
  function cap(s) { return s && s.length ? s[0].toUpperCase() + s.slice(1) : ""; }

  /* ---------- Schema → 描述文本 ---------- */

  function schemaToText(schema, depth = 0) {
    if (!schema || typeof schema !== "object") return "any";
    if (depth > 4) return "…";
    const pad = "  ".repeat(depth);
    const label = (o) => {
      const mime = o && o.content ? Object.keys(o.content)[0] : null;
      const ref = schemaRefName(o);
      if (ref) return ref;
      if (o && o.type === "object" && o.properties) return "object";
      if (o && o.type === "array") return "array[" + (o.items ? schemaToText(o.items, depth + 1) : "?") + "]";
      return [o && o.type, o && o.format].filter(Boolean).join("<");
    };
    const lines = [];
    if (schema.title) lines.push(`${pad}# ${schema.title}`);
    lines.push(`${pad}${label(schema)}`);
    if (schema.$ref) return `${pad}→ ${schemaRefName(schema)}`;
    if (schema.description) lines.push(`${pad}${schema.description}`);
    if (schema.type === "object" && schema.properties) {
      for (const [k, v] of Object.entries(schema.properties)) {
        const req = (schema.required || []).includes(k);
        lines.push(`${pad}${req ? "*" : " "} ${k}: ${schemaToText(v, depth + 1).trim()}`);
      }
    }
    if (schema.type === "array" && schema.items) {
      lines.push(`${pad}items: ${schemaToText(schema.items, depth).trim()}`);
    }
    return lines.join("\n");
  }

  function schemaRefName(o) {
    if (!o) return "";
    const m = (o.$ref || o["$ref"] || "").match(/([^/]+)\s*$/);
    const ref = m && m[1];
    if (ref && o.type !== undefined) return ref;
    return ref || "";
  }

  /* ---------- 通用参数 ---------- */

  function normParam(p, inDefault) {
    return {
      kind: "param",
      id: uid(),
      name: p.name || "",
      in: p.in || inDefault,
      required: !!p.required || p.in === "path",
      type: p.type || p.schema && schemaToText(p.schema, 1).trim() || "string",
      description: p.description || "",
      example: p.example ?? (p.schema && p.schema.example) ?? "",
      deprecated: !!p.deprecated,
    };
  }

  /* ===================================================================== */
  /*  OpenAPI 3.x / Swagger 2.0                                            */
  /* ===================================================================== */

  function loadOpenAPI(text) {
    const spec = tryJSON(text);
    if (!spec || !isOpenAPI(spec)) return null;
    const version = spec.openapi || spec.swagger || "";
    const info = spec.info || {};
    const endpoints = [];
    const components = spec.components || {};
    const schemas = components.schemas || spec.definitions || {};
    const securitySchemes = components.securitySchemes || spec.securityDefinitions || {};

    const resolveMime = (key, contentType) => {
      const m = content && content[contentType] || (content && Object.keys(content)[0]);
      if (!m) return null;
      const text = schemaToText(m.schema, 1).trim();
      return { contentType: contentType || Object.keys(content)[0] || "", type: text || "any" };
    };

    const paths = spec.paths || {};
    const methodOrder = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
    for (const [pathStr, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== "object") continue;
      // 路径级参数（OpenAPI 允许 path-level parameters 应用到所有 method）
      const pathParams = pathItem.parameters || [];
      const tags = pathItem.tags || [];
      for (const m of methodOrder) {
        const op = pathItem[m];
        if (!op || typeof op !== "object") continue;
        const params = [...pathParams, ...(op.parameters || [])];
        const bodyContent = op.requestBody && op.requestBody.content;
        const bodyType = bodyContent ? Object.keys(bodyContent)[0] : (op.consumes && op.consumes[0]) || "";
        const bodySchema = bodyContent && bodyContent[bodyType] ? bodyContent[bodyType].schema
          : op.parameters && op.parameters.find((p) => p.in === "body") && op.parameters.find((p) => p.in === "body").schema;

        const ep = {
          kind: "endpoint",
          id: uid(),
          source: "openapi",
          method: m.toUpperCase(),
          path: pathStr,
          name: op.summary || `${m.toUpperCase()} ${pathStr}`,
          description: op.description || (op.summary === op.description ? "" : op.summary) || "",
          params: params.map((p) => normParam(p, "query")),
          headers: (params.length ? [params.find((p) => p.in === "header")] : []).filter(Boolean).map(normParam),
          query: params.filter((p) => p.in === "query").map(normParam),
          body: bodySchema ? {
            type: bodyType,
            required: !!(op.requestBody && op.requestBody.required),
            description: (bodySchema && bodySchema.description) || "",
            contentType: bodyType,
            schema: schemaToText(bodySchema, 1).trim(),
          } : undefined,
          responses: Object.entries(op.responses || {}).map(([status, r]) => ({
            status,
            description: r.description || "",
            schema: r.content ? schemaToText(Object.values(r.content)[0].schema, 1).trim() : (r.schema ? schemaToText(r.schema, 1).trim() : ""),
          })),
          security: (op.security || spec.security || []).map((s) => Object.keys(s).join(", ")).join(" · "),
          tags: op.tags?.length ? op.tags : tags,
        };
        endpoints.push(ep);
      }
    }

    const root = newGroup(uid(), info.title || "OpenAPI");
    const byId = new Map();
    byId.set(root.id, root);

    // 依据 spec tags 或路径首段分组
    const tagRoots = new Map();
    for (const ep of endpoints) {
      const tag = ep.tags && ep.tags[0];
      let group = root;
      if (tag) {
        if (!tagRoots.has(tag)) {
          const g = newGroup(uid(), tag);
          root.children.push(g);
          tagRoots.set(tag, g);
        }
        group = tagRoots.get(tag);
      } else {
        group = ensurePath(root, ep.path, null);
      }
      group.children.push(ep);
      byId.set(ep.id, ep);
      byId.set(group.id, group);
    }

    return {
      format: "OpenAPI",
      version,
      source: "openapi",
      root,
      nodes: byId,
      endpointCount: endpoints.length,
      serverInfo: info,
    };
  }

  /* ===================================================================== */
  /*  Postman Collection v2.1                                              */
  /* ===================================================================== */

  function loadPostman(text) {
    const coll = tryJSON(text);
    if (!coll || !isPostman(coll)) return null;
    const info = coll.info || {};
    const rootName = info.name || "Collection";
    const version = (coll.info && coll.info.schema) || "";
    const root = newGroup(uid(), rootName);
    const byId = new Map();
    byId.set(root.id, root);

    const methodOrder = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4, HEAD: 5, OPTIONS: 6 };
    function parseItem(item, parent) {
      if (!item) return;
      if (item.item && Array.isArray(item.item)) {
        // 分组
        const g = newGroup(uid(), item.name || "group");
        g.description = item.description || "";
        parent.children.push(g);
        byId.set(g.id, g);
        item.item.forEach((c) => parseItem(c, g));
      } else if (item.request) {
        const req = item.request;
        const url = typeof req.url === "string" ? req.url : req.url && (req.url.raw || (req.url.protocol + "://" + [req.url.host, req.url.path].flat().join("/")) || "");
        let path = url || "";
        try {
          if (req.url && req.url.path) path = "/" + (Array.isArray(req.url.path) ? req.url.path.join("/") : req.url.path);
        } catch (e) {}
        const method = ((req.method || "GET").toUpperCase());
        const ep = {
          kind: "endpoint",
          id: uid(),
          source: "postman",
          method,
          path,
          name: item.name || `${method} ${path}`,
          description: (item.request && item.request.description) || "",
          params: [],
          headers: [],
          query: [],
          methodOrder: methodOrder[method] ?? 9,
        };
        // request headers
        (req.header || []).forEach((h) => {
          if (!h.key) return;
          const p = normParam({ name: h.key, value: h.value, in: "header", disabled: h.disabled }, "header");
          ep.headers.push(p);
        });
        // query
        if (url && url.query && Array.isArray(url.query)) {
          url.query.forEach((q) => {
            ep.query.push(normParam({ name: q.key, value: q.value, in: "query", disabled: q.disabled }, "query"));
          });
        } else if (req.url && req.url.query) {
          req.url.query.forEach((q) => ep.query.push(normParam({ name: q.key, value: q.value, in: "query", disabled: q.disabled }, "query")));
        }
        // body
        const body = req.body || {};
        if (body.mode === "raw" && body.raw) {
          let contentType = "";
          const ct = (ep.headers.find((h) => h.in === "header" && (h.name || "").toLowerCase() === "content-type") || {}).value || "";
          ep.body = { type: "raw", contentType, description: "", schema: String(body.raw).slice(0, 500) };
        } else if (body.mode === "urlencoded" && body.urlencoded) {
          ep.body = { type: "urlencoded", contentType: "application/x-www-form-urlencoded", description: "", schema: body.urlencoded.map((f) => `${f.key}=${f.value || ""}`).filter(Boolean).join("&") };
        } else if (body.mode === "formdata" && body.formdata) {
          ep.body = { type: "formdata", contentType: "multipart/form-data", description: "", schema: body.formdata.map((f) => (f.type === "file" ? `[file] ${f.key}` : `${f.key}=${f.value || ""}`)).join("\n") };
        } else if (body.mode === "graphql" && body.graphql) {
          ep.body = { type: "graphql", contentType: "application/json", description: "", schema: String(body.graphql.query || "").slice(0, 500) };
        }
        ep.raw = url || path;
        parent.children.push(ep);
        byId.set(ep.id, ep);
      }
    }
    (coll.item || []).forEach((c) => parseItem(c, root));

    return {
      format: "Postman",
      version,
      source: "postman",
      root,
      nodes: byId,
      endpointCount: byId.size > 0 ? countEndpoints(root) : 0,
      serverInfo: info,
    };
  }

  function countEndpoints(node) {
    let n = 0;
    if (node.kind === "endpoint") return 1;
    (node.children || []).forEach((c) => (n += countEndpoints(c)));
    return n;
  }

  /* Guest hosts: parse by extension or content that failed detection */
  function loadAuto(text, hint) {
    const json = tryJSON(text);
    if (!json) return null;
    // Postman or OpenAPI explicit hints
    if (hint === "openapi") {
      const r = loadOpenAPI(text);
      if (r) return r;
    }
    if (hint === "postman") {
      const r = loadPostman(text);
      if (r) return r;
    }
    // auto-detect
    const o = loadOpenAPI(text);
    if (o) return o;
    const p = loadPostman(text);
    if (p) return p;
    // minimal inline array of requests
    if (Array.isArray(json)) {
      const root = newGroup(uid(), "导入集合");
      const byId = new Map();
      json.forEach((q, i) => {
        const ep = {
          kind: "endpoint", id: uid(), source: "json",
          method: (q.method || "GET").toUpperCase(),
          path: q.url || q.path || `/item-${i + 1}`,
          name: q.name || q.url || `接口 ${i + 1}`,
          description: q.description || "",
          params: [], headers: [], query: [],
          body: q.body ? { type: "raw", contentType: q.contentType || "", description: "", schema: String(q.body).slice(0, 500) } : undefined,
        };
        root.children.push(ep);
        byId.set(ep.id, ep);
      });
      byId.set(root.id, root);
      return { format: "JSON 数组", version: "", source: "json", root, nodes: byId, endpointCount: json.length, serverInfo: {} };
    }
    return null;
  }

  /* ---------- cURL / Markdown 导出 ---------- */

  function toCurl(ep, envResolve) {
    const parts = [`curl --request ${ep.method} '${ep.path}'`];
    ep.headers.forEach((h) => {
      if (!h.name) return;
      parts.push(`-H '${h.name}: ${(h.value ?? h.example ?? "")}'`);
    });
    if (ep.body) {
      const bk = ep.body.schema || "";
      parts.push(`--data '${bk.replace(/'/g, "'\\''")}'`);
      const hasCT = ep.headers.some((h) => (h.name || "").toLowerCase() === "content-type");
      if (!hasCT && ep.body.contentType) parts.push(`-H 'Content-Type: ${ep.body.contentType}'`);
    }
    if (ep.query && ep.query.length) {
      const qs = ep.query.map((q) => `${encodeURIComponent(q.name)}=${encodeURIComponent(q.value ?? "")}`).join("&");
      parts.push(`--data-urlencode '${qs}'`); // 实际会错误，改注  (保留直观)
    }
    envResolve && envResolve(parts);
    return parts.join(" \n  ");
  }

  function toMarkdown(ep) {
    const lines = [];
    lines.push(`## ${ep.method} \`${ep.path}\``);
    if (ep.description) lines.push("", ep.description);
    lines.push("", "**参数：**");
    lines.push("| 名称 | 位置 | 必填 | 类型 | 说明 |");
    lines.push("|---|---|---|---|---|");
    [...ep.params, ...ep.query].forEach((p) => lines.push(`| ${p.name} | ${p.in} | ${p.required ? "是" : "否"} | ${p.type} | ${p.description || ""} |`));
    if (ep.body) {
      lines.push("", "**请求体：**");
      lines.push("```" + "\n" + (ep.body.schema || "") + "\n```");
    }
    if (ep.responses && ep.responses.length) {
      lines.push("", "**响应：**");
      ep.responses.forEach((r) => lines.push(`- \`${r.status}\` ${r.description}` + (r.schema ? "  \n  " + r.schema : "")));
    }
    if (ep.security) lines.push("", `**认证：** ${ep.security}`);
    return lines.join("\n");
  }

  PA.methodColor = methodColor;
  PA.loadAuto = loadAuto;
  PA.loadOpenAPI = loadOpenAPI;
  PA.loadPostman = loadPostman;
  PA.tryJSON = tryJSON;
  PA.schemaToText = schemaToText;
  PA.toCurl = toCurl;
  PA.toMarkdown = toMarkdown;
  PA.treeExport = function (nodes) { return nodes; };
})();