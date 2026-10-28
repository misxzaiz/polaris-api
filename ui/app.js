/* app.js — polaris-api 主逻辑：初始化、导入、目录树渲染、搜索、详情导航、导出。
 * 数据模型来自 importer.js（PA.{loadAuto,toCurl,toMarkdown,methodColor}）。
 */
(function () {
  const PA = window.POLARIS_API;
  if (!PA) throw new Error("importer.js 未加载");

  const $ = (id) => document.getElementById(id);

  /* ---------- 单一状态 ---------- */
  let catalog = null;          // { root, nodes, endpointCount, format, version, name }
  let expanded = new Set();    // 展开的分组 id
  let activeId = null;         // 当前选中节点 id
  let searchQuery = "";

  const treeEl = $("tree");
  const detailEl = $("detail");
  const welcomeEl = $("welcome");
  const searchEl = $("search");
  const countEl = $("count");
  const collectionEl = $("collectionName");
  const brandIcon = $("brandIcon");
  const welcomeIcon = $("welcomeIcon");
  const importPanel = $("importPanel");

  /* ---------- 图标 ---------- */
  async function initIcons() {
    let base = "";
    try {
      if (window.dbxPlugin && window.dbxPlugin.readAssetUrl) {
        base = await window.dbxPlugin.readAssetUrl("assets/plugin.svg");
      }
    } catch { /* fallthrough */ }
    if (!base) base = "./assets/plugin.svg";
    brandIcon.src = base;
    welcomeIcon.src = base;
  }

  /* ---------- 目录树渲染 ---------- */
  function renderTree() {
    const shown = visibleTree();
    treeEl.innerHTML = "";
    if (shown) treeEl.appendChild(renderNodeChildren(shown, ""));
    countEl.textContent = catalog ? `${catalog.endpointCount} 个接口` : "";
    const empty = $("emptyState");
    const list = treeEl;
    const noItems = !catalog || catalog.endpointCount === 0;
    if (empty) empty.style.display = noItems ? "block" : "none";
    if (list) list.style.display = noItems ? "none" : "block";
  }

  function renderNodeChildren(node, indent) {
    const ul = document.createElement("ul");
    ul.className = "pa-tree__list";
    (node.children || []).forEach((child) => {
      if (child.kind === "group") ul.appendChild(renderGroup(child, indent));
      else ul.appendChild(renderEndpoint(child, indent));
    });
    return ul;
  }

  function renderGroup(group, indent) {
    const li = document.createElement("li");
    li.className = "pa-tree__group" + (expanded.has(group.id) ? " open" : "");
    li.dataset.id = group.id;
    const label = document.createElement("div");
    label.className = "pa-node-label";
    label.innerHTML = `<span class="pa-chevron">▶</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(group.name || "分组")}</span>`;
    const childCount = countEndpoints(group);
    if (childCount > 0) {
      const badge = document.createElement("span");
      badge.className = "pa-count";
      badge.textContent = childCount;
      label.appendChild(badge);
    }
    label.addEventListener("click", () => {
      expanded.has(group.id) ? expanded.delete(group.id) : expanded.add(group.id);
      renderTree();
    });
    li.appendChild(label);
    if (expanded.has(group.id)) {
      const children = renderNodeChildren(group, indent + "  ");
      children.className = "pa-children";
      li.appendChild(children);
    }
    return li;
  }

  function renderEndpoint(ep, indent) {
    const li = document.createElement("li");
    li.className = "pa-tree__ep";
    li.dataset.id = ep.id;
    const button = document.createElement("button");
    button.className = "pa-node-row" + (activeId === ep.id ? " active" : "");
    const color = PA.methodColor(ep.method);
    const safeName = escapeHtml(ep.name);
    const safePath = escapeHtml(ep.path || "");
    button.innerHTML = `<span class="pa-method" style="background:${color}">${escapeHtml(ep.method)}</span><span class="pa-ep-name">${safeName}</span><span class="pa-ep-path">${safePath}</span>`;
    button.addEventListener("click", () => { activeId = ep.id; selectEndpoint(ep); renderTree(); });
    li.appendChild(button);
    return li;
  }

  /* ---------- 搜索过滤 ---------- */
  function buildFiltered(node) {
    // 返回带 children 过滤的浅拷贝（保留结构），命中 endpoint 或命中组内后代
    if (node.kind === "endpoint") {
      const hay = `${node.method} ${node.path} ${node.name}`.toLowerCase();
      return hay.includes(searchQuery) ? Object.assign({}, node, { children: [] }) : null;
    }
    const kept = (node.children || []).map(buildFiltered).filter(Boolean);
    if (!kept.length && searchQuery && !node.name.toLowerCase().includes(searchQuery)) return null;
    return Object.assign({}, node, { children: kept });
  }

  function visibleTree() {
    if (!catalog) return null;
    if (!searchQuery) return catalog.root;
    return buildFiltered(catalog.root) || { kind: "group", id: catalog.root.id, name: catalog.root.name, children: [] };
  }

  /* ---------- 详情渲染 ---------- */
  function selectEndpoint(ep) {
    welcomeEl.hidden = true;
    detailEl.hidden = false;
    const color = PA.methodColor(ep.method);
    let html = `<h2><span class="pa-method" style="background:${color}">${escapeHtml(ep.method)}</span> <span>${escapeHtml(ep.name)}</span></h2>`;
    html += `<div class="pa-path">${escapeHtml(ep.path)}</div>`;
    if (ep.description) html += `<p class="pa-desc">${escapeHtml(ep.description)}</p>`;

    html += `<div class="pa-toolbar">
      <button class="pa-btn" data-copy="curl">复制 cURL</button>
      <button class="pa-btn" data-copy="md">复制 Markdown</button>
      <button class="pa-btn" data-copy="json">复制 JSON</button>
      <span class="pa-hint" id="copyHint"></span>
    </div>`;

    // 参数 / query
    const rows = [];
    [...ep.params, ...ep.query].forEach((p) => {
      rows.push(`<tr><td class="${p.required ? "pa-req" : ""}">${escapeHtml(p.name)}</td><td>${escapeHtml(p.in || "")}</td><td>${p.required ? "是" : "否"}</td><td>${escapeHtml(p.type || "")}</td><td>${escapeHtml(p.description || p.example || "")}</td></tr>`);
    });
    if (rows.length) html += `<div class="pa-section"><h3>参数与 Query</h3><table class="pa-table"><thead><tr><th>名称</th><th>位置</th><th>必填</th><th>类型</th><th>说明</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;

    // headers
    if (ep.headers.length) {
      const hRows = ep.headers.map((h) => `<tr><td>${escapeHtml(h.name)}</td><td>${escapeHtml((h.value ?? h.example ?? "") || "")}</td><td>${escapeHtml(h.description || "")}</td></tr>`).join("");
      html += `<div class="pa-section"><h3>请求头</h3><table class="pa-table"><thead><tr><th>名称</th><th>值</th><th>说明</th></tr></thead><tbody>${hRows}</tbody></table></div>`;
    }

    // body
    if (ep.body) {
      html += `<div class="pa-section"><h3>请求体</h3><div class="pa-hint">${escapeHtml((ep.body.contentType || ep.body.type || "") + (ep.body.required ? " · 必填" : "") + (ep.body.description ? " · " + ep.body.description : ""))}</div><pre class="pa-code">${escapeHtml(ep.body.schema || "")}</pre></div>`;
    }

    // responses
    if (ep.responses && ep.responses.length) {
      const rRows = ep.responses.map((r) => `<tr><td><span class="pa-status" style="color:${statusColor(r.status)}">${escapeHtml(r.status)}</span></td><td>${escapeHtml(r.description || "")}</td><td>${r.schema ? `<pre class="pa-code">${escapeHtml(r.schema)}</pre>` : ""}</td></tr>`).join("");
      html += `<div class="pa-section"><h3>响应</h3><table class="pa-table"><thead><tr><th>状态</th><th>说明</th><th>Schema</th></tr></thead><tbody>${rRows}</tbody></table></div>`;
    }

    html += `<div class="pa-section"><h3>来源</h3><div class="pa-hint">${escapeHtml(catalog.format)} ${escapeHtml(catalog.version || "")} · ${escapeHtml(ep.source)}</div></div>`;
    detailEl.innerHTML = html;
    currentEp = ep;
    detailEl.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", () => handleCopy(btn.dataset.copy));
    });
  }

  function statusColor(status) {
    const s = parseInt(status, 10);
    if (s >= 200 && s < 300) return "#22c55e";
    if (s >= 300 && s < 400) return "#f59e0b";
    if (s >= 400 && s < 500) return "#f97316";
    if (s >= 500) return "#ef4444";
    return "var(--pa-muted)";
  }

  let currentEp = null;
  async function copyText(text) {
    const hint = $("copyHint");
    try {
      await navigator.clipboard.writeText(text);
      if (hint) { hint.textContent = "已复制"; setTimeout(() => (hint.textContent = ""), 1500); }
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
  }
  function handleCopy(kind) {
    if (!currentEp) return;
    let out = "";
    if (kind === "curl") out = PA.toCurl(currentEp);
    else if (kind === "md") out = PA.toMarkdown(currentEp);
    else if (kind === "json") out = JSON.stringify(currentEp, null, 2);
    copyText(out);
  }

  /* ---------- 导入流程 ---------- */
  function showImport() { importPanel.hidden = false; switchImportTab("paste"); }
  function hideImport() { importPanel.hidden = true; }

  function switchImportTab(name) {
    ["paste", "file", "url"].forEach((k) => {
      $("pane" + k[0].toUpperCase() + k.slice(1)).hidden = k !== name;
      $("tab" + k[0].toUpperCase() + k.slice(1)).setAttribute("aria-selected", String(k === name));
    });
  }

  async function doImport() {
    const active = ["paste", "file", "url"].find((k) => !$("pane" + k[0].toUpperCase() + k.slice(1)).hidden);
    let text = "";
    let hint = "";
    const button = $("btnDoImport");
    button.disabled = true;
    try {
      if (active === "paste") {
        text = $("pasteInput").value;
      } else if (active === "file") {
        const f = $("fileInput").files && $("fileInput").files[0];
        if (!f) { alert("请选择文件"); button.disabled = false; return; }
        const name = f.name || "";
        hint = name.endsWith(".yaml") || name.endsWith(".yml") ? "openapi" : name.includes("postman") ? "postman" : "auto";
        text = await f.text();
      } else if (active === "url") {
        const url = $("urlInput").value.trim();
        if (!url) { alert("请输入 URL"); button.disabled = false; return; }
        // 需 host.network 目标域名，否则会失败
        try {
          const res = await fetch(url, { mode: "cors" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          text = await res.text();
        } catch (e) {
          alert("拉取失败：" + (e.message || e) + "\n\ndbx 沙箱默认禁止网络；请在 manifest 开启 host.network 并在插件设置给目标域名联网。");
          button.disabled = false;
          return;
        }
      }
      const result = PA.loadAuto(text, hint);
      if (!result) { alert("无法解析：不是有效的 OpenAPI / Swagger / Postman Collection JSON"); button.disabled = false; return; }
      catalog = {
        root: result.root,
        nodes: result.nodes,
        endpointCount: result.endpointCount,
        format: result.format,
        version: result.version,
        name: result.root.name,
      };
      expanded.clear();
      if (catalog.root && catalog.root.children && catalog.root.children.length) {
        // 默认展开一级结构
        catalog.root.children.forEach((c) => expanded.add(c.id));
      }
      collectionEl.textContent = catalog.name;
      searchQuery = "";
      searchEl.value = "";
      activeId = null;
      detailEl.hidden = true;
      welcomeEl.hidden = false;
      renderTree();
      // 持久化
      await DBXBridge.storage.set("catalog-v1", catalog);
      hideImport();
    } finally {
      button.disabled = false;
    }
  }

  /* ---------- 加载持久化 ---------- */
  async function loadPersisted() {
    const saved = await DBXBridge.storage.get("catalog-v1");
    if (saved && saved.root && !catalog) {
      catalog = saved;
      collectionEl.textContent = catalog.name;
      // expanded 从持久化恢复（默认全部）
      catalog.root.children.forEach((c) => expanded.add(c.id));
      renderTree();
    }
  }

  /* ---------- 事件绑定 ---------- */
  $("btnImport").addEventListener("click", showImport);
  $("btnCancelImport").addEventListener("click", hideImport);
  $("btnDoImport").addEventListener("click", doImport);
  $("tabPaste").addEventListener("click", () => switchImportTab("paste"));
  $("tabFile").addEventListener("click", () => switchImportTab("file"));
  $("tabUrl").addEventListener("click", () => switchImportTab("url"));

  searchEl.addEventListener("input", () => {
    searchQuery = searchEl.value.trim().toLowerCase();
    // 搜索时展开全部命中节点
    if (searchQuery) {
      let count = 0;
      (function walk(node) {
        (node.children || []).forEach((c) => {
          if (c.kind === "group") {
            const hay = (c.children || []).map((e) => (e.kind === "endpoint" ? e.method + " " + e.path + " " + e.name : e.name)).join(" ").toLowerCase();
            if (hay.includes(searchQuery)) expanded.add(c.id);
            walk(c);
          }
        });
      })(catalog.root);
    }
    renderTree();
  });

  $("btnExportMd").addEventListener("click", async () => {
    if (!currentEp) { alert("先选中一个接口"); return; }
    const md = PA.toMarkdown(currentEp);
    await copyText(md);
  });

  /* ---------- 启动 ---------- */
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function boot() {
    await initIcons();
    await DBXBridge.ready;
    if (DBXBridge.readyOk && DBXBridge.locale && DBXBridge.locale.toLowerCase().startsWith("zh")) {
      document.documentElement.lang = "zh-CN";
    }
    await loadPersisted();
    renderTree();
  }
  boot();
})();