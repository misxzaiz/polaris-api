/* dbx-bridge.js — window.dbxPlugin 的唯一封装。所有宿主交互经此通道，
 * 使 UI 在无宿主（浏览器调试）时也能降级运行。
 * 暴露：DBXBridge = { ready, locale, theme, appearance, context, storage, plugin }
 */
(function () {
  const bridge = window.DBXBridge = {};
  const plugin = typeof window.dbxPlugin !== "undefined" ? window.dbxPlugin : null;
  bridge.plugin = plugin;

  let state = { locale: "en", appearance: "light", context: {}, readyResolved: false, readyOk: false, backendInfo: null };

  bridge.ready = (async () => {
    if (!plugin) {
      state.readyOk = false;
      state.readyResolved = true;
      return false;
    }
    try {
      await plugin.ready;
      state.locale = plugin.locale || "en";
      const theme = plugin.theme;
      state.appearance = typeof theme === "string" ? theme : (theme && theme.appearance) || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      state.context = plugin.context || {};
      if (plugin.onContext) plugin.onContext((next) => { state.context = next || {}; });
      state.readyOk = true;
      state.readyResolved = true;
      document.documentElement.dataset.dbxTheme = state.appearance;
      return true;
    } catch (error) {
      state.readyOk = false;
      state.readyResolved = true;
      state.error = error && error.message;
      return false;
    }
  })();

  // 存储：优先 dbxPlugin.storage，否则 localStorage 降级
  bridge.storage = {
    async get(key) {
      if (plugin && plugin.storage && plugin.storage.get) {
        try { const v = await plugin.storage.get(key); return v; } catch { return null; }
      }
      try { const raw = localStorage.getItem("polaris-api:" + key); return raw ? JSON.parse(raw) : null; } catch { return null; }
    },
    async set(key, value) {
      if (plugin && plugin.storage && plugin.storage.set) {
        try { await plugin.storage.set(key, value); return; } catch { /* fallthrough */ }
      }
      try { localStorage.setItem("polaris-api:" + key, JSON.stringify(value)); } catch { /* ignore */ }
    },
    async delete(key) {
      if (plugin && plugin.storage && plugin.storage.delete) {
        try { await plugin.storage.delete(key); return; } catch { /* fallthrough */ }
      }
      try { localStorage.removeItem("polaris-api:" + key); } catch { /* ignore */ }
    },
  };

  bridge.invoke = async (method, params, options) => {
    if (plugin && plugin.invoke) return plugin.invoke(method, params, options);
    throw new Error("dbxPlugin.invoke 不可用");
  };

  bridge.setTitle = async (title) => {
    if (plugin && plugin.setTitle) { try { await plugin.setTitle(title); } catch { /* ignore */ } }
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