/* core.js — DOM 查询、HTML 转义、通用格式化、状态栏/吐司/复制、日期格式化、BINARY/tryJSON。
 * 自原版 relay-devkit core/dom.js + core/http.js 合并移植，改 IIFE 挂 window.POLARIS_CORE。
 * 无依赖。被 json-view.js / app.js 复用。
 * DBX 沙箱内根元素为 #root.pa-root；所有 DOM 查询作用域限定其内，避免污染宿主。
 */
(function () {
  const root = document.getElementById('root') || document;
  const $ = (s, r = root) => r.querySelector(s);
  const $$ = (s, r = root) => [...r.querySelectorAll(s)];
  const uid = () => 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const bytes = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
  const ms = (n) => n < 1000 ? Math.round(n) + ' ms' : (n / 1000).toFixed(2) + ' s';
  /* methodColor 返回 CSS 类名（m-GET 等），与原版一致；配色由 app.css 的 .m-* 规则提供 */
  const methodColor = (m) => 'm-' + (m || 'GET').toUpperCase();

  let statusTimer = null;
  let idleMsg = '就绪 · DBX 沙箱：仅可访问 manifest 声明的 host.network 目标源';
  function setStatus(msg, kind) {
    const m = $('#statusMsg'); if (!m) return;
    m.textContent = msg; m.className = 'msg' + (kind ? ' ' + kind : '');
    clearTimeout(statusTimer);
    if (kind) statusTimer = setTimeout(() => { m.className = 'msg'; m.textContent = idleMsg; }, 4500);
  }
  function setIdleMsg(s) { idleMsg = s; }

  function toast(html) {
    const t = $('#toast'); if (!t) return;
    t.innerHTML = html; t.classList.add('show'); clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), 1500);
  }
  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const ta = el('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      ta.remove();
    }
    toast((label || '已复制') + ' <b>✓</b>');
  }

  function fmtDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* http.js 合并 */
  const BINARY = /^(image|audio|video|font)\/|application\/(octet-stream|pdf|zip|x-)/i;
  function tryJSON(text) { try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false }; } }

  window.POLARIS_CORE = { $, $$, uid, esc, el, METHODS, bytes, ms, methodColor, setStatus, setIdleMsg, toast, copy, fmtDate, BINARY, tryJSON };
})();
