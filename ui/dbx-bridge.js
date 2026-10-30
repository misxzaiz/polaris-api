/* dbx-bridge.js — window.dbxPlugin 的唯一封装。所有宿主交互经此通道，
 * 使 UI 在无宿主（浏览器调试）时也能降级运行。
 *
 * 关键修复（v0.1.x 的坑）：localStorage 在 sandbox="allow-scripts" 无 same-origin
 * 的 DBX iframe 里访问会抛错，原版用 try/catch 静默吞掉导致持久化无声失效。
 * 本版降级改用内存 Map：宿主可用时走 dbxPlugin.storage（需声明 host.storage），
 * 否则退内存（重启丢失，但功能正常不报错）。
 *
 * 暴露：window.DBXBridge = { ready, locale, appearance, theme, context, storage, invoke, setTitle }
 */
(function () {
  const bridge = window.DBXBridge = {};
  const plugin = typeof window.dbxPlugin !== "undefined" ? window.dbxPlugin : null;
  bridge.plugin = plugin;

  let state = { locale: "zh-CN", appearance: "dark", context: {}, readyResolved: false, readyOk: false, backendInfo: null };

  /* 内存降级存储（沙箱 localStorage 不可靠时使用） */
  const memStore = new Map();

  bridge.ready = (async () => {
    if (!plugin) {
      state.readyOk = false;
      state.readyResolved = true;
      /* 无宿主：尝试 localStorage（独立调试模式可用则用，不可用则忽略） */
      return false;
    }
    try {
      await plugin.ready;
      state.locale = plugin.locale || "zh-CN";
      const theme = plugin.theme;
      state.appearance = typeof theme === "string" ? theme : (theme && theme.appearance) || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      state.context = plugin.context || {};
      if (plugin.onContext) plugin.onContext((next) => { state.context = next || {}; });
      state.readyOk = true;
      state.readyResolved = true;
      applyTheme(state.appearance);
      return true;
    } catch (error) {
      state.readyOk = false;
      state.readyResolved = true;
      state.error = error && error.message;
      return false;
    }
  })();

  function applyTheme(appearance) {
    const root = document.getElementById("root") || document.documentElement;
    root.setAttribute("data-dbx-theme", appearance);
    document.documentElement.setAttribute("data-dbx-theme", appearance);
  }
  bridge.applyTheme = applyTheme;

  /* 存储：优先 dbxPlugin.storage（声明 host.storage 后可用），否则内存降级。
   * 不再用 localStorage：sandbox="allow-scripts" 无 same-origin 时访问抛错，
   * 静默吞掉会导致持久化无声失效（v0.1.x 的坑）。 */
  bridge.storage = {
    async get(key) {
      if (plugin && plugin.storage && plugin.storage.get) {
        try { return await plugin.storage.get(key); } catch (e) { /* fallthrough 到内存 */ }
      }
      return memStore.has(key) ? memStore.get(key) : null;
    },
    async set(key, value) {
      if (plugin && plugin.storage && plugin.storage.set) {
        try { await plugin.storage.set(key, value); return; } catch (e) { /* fallthrough */ }
      }
      memStore.set(key, value);
    },
    async delete(key) {
      if (plugin && plugin.storage && plugin.storage.delete) {
        try { await plugin.storage.delete(key); return; } catch (e) { /* fallthrough */ }
      }
      memStore.delete(key);
    },
  };

  bridge.invoke = async (method, params, options) => {
    if (plugin && plugin.invoke) return plugin.invoke(method, params, options);
    throw new Error("dbxPlugin.invoke 不可用");
  };

  bridge.setTitle = async (title) => {
    if (plugin && plugin.setTitle) { try { await plugin.setTitle(title); } catch (e) { /* ignore */ } }
  };

  const getters = {
    get locale() { return state.locale; },
    get appearance() { return state.appearance; },
    get context() { return state.context; },
    get readyOk() { return state.readyOk; },
    get backendInfo() { return state.backendInfo; },
    set backendInfo(v) { state.backendInfo = v; },
  };
  Object.assign(bridge, getters);
})();
