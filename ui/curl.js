/* curl.js — cURL 命令解析与生成、URL 工具。
 * 自原版 relay-devkit tools/api.js 的 parseCurl/tokenizeCurl/toCurl/shortUrl/splitUrl 抽离为独立模块。
 * 纯函数，无 DOM 依赖；IIFE 挂 window.POLARIS_CURL。
 * 被 app.js（导入/导出 cURL）与 tools/smoke.mjs（测试）共用。
 */
(function () {
  /* 单 token 分词：处理引号、转义、行连接 */
  function tokenizeCurl(s) {
    s = s.replace(/\\\r?\n/g, ' ');
    const out = []; let cur = '', q = null, started = false;
    for (let i = 0; i < s.length; i++) { const c = s[i];
      if (q) { if (c === '\\' && q === '"') { cur += (s[++i] || ''); } else if (c === q) q = null; else cur += c; }
      else if (c === '"' || c === "'") { q = c; started = true; }
      else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { if (started) { out.push(cur); cur = ''; started = false; } }
      else { cur += c; started = true; }
    }
    if (started) out.push(cur); return out;
  }

  /* 解析 curl 命令为请求结构。
   * 支持 -X -H -d --data-raw --data-ascii --data-binary --data-urlencode -u -b -A -e -G --json、
   * --flag=value 等号写法、-Xvalue 紧贴写法、curl.exe 前缀。
   * 返回 {method,url,headers:[{on,k,v}],body,bodyType} */
  function parseCurl(text) {
    let toks = tokenizeCurl(text.trim());
    if (toks.length && /^curl(\.exe)?$/i.test(toks[0])) toks = toks.slice(1);
    // 拆分 --flag=value / -X=value 等号写法为独立 token
    const flat = [];
    for (const t of toks) {
      if (t.startsWith('--') || (/^-[A-Za-z]/.test(t) && t.length > 2)) {
        const idx = t.indexOf('=');
        if (idx > 0) { flat.push(t.slice(0, idx)); flat.push(t.slice(idx + 1)); continue; }
      }
      flat.push(t);
    }
    toks = flat;
    const headers = [], datas = []; let method = null, url = '', getFlag = false;
    const addH = h => { const i = h.indexOf(':'); if (i < 0) { headers.push({ on: true, k: h.trim(), v: '' }); return; } headers.push({ on: true, k: h.slice(0, i).trim(), v: h.slice(i + 1).trim() }); };
    for (let i = 0; i < toks.length; i++) { let t = toks[i]; const nx = () => toks[++i];
      if (t === '-X' || t === '--request') method = nx();
      else if (t.startsWith('-X') && t.length > 2) method = t.slice(2);
      else if (t === '-H' || t === '--header') addH(nx());
      else if (t.startsWith('-H') && t.length > 2) addH(t.slice(2));
      else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-ascii' || t === '--data-binary' || t === '--data-urlencode') datas.push(nx());
      else if (t.startsWith('-d') && t.length > 2) datas.push(t.slice(2));
      else if (t === '--json') {
        datas.push(nx());
        if (!headers.some(h => h.k.toLowerCase() === 'content-type')) headers.push({ on: true, k: 'Content-Type', v: 'application/json' });
      }
      else if (t === '-u' || t === '--user') { try { headers.push({ on: true, k: 'Authorization', v: 'Basic ' + btoa(nx()) }); } catch (e) {} }
      else if (t === '-b' || t === '--cookie') headers.push({ on: true, k: 'Cookie', v: nx() });
      else if (t === '-A' || t === '--user-agent') headers.push({ on: true, k: 'User-Agent', v: nx() });
      else if (t === '-e' || t === '--referer') headers.push({ on: true, k: 'Referer', v: nx() });
      else if (t === '-G' || t === '--get') getFlag = true;
      else if (t === '--url') url = nx();
      else if (['--compressed', '-L', '--location', '-k', '--insecure', '-s', '--silent', '-S', '--show-error', '-i', '--include', '-v', '--verbose', '-f', '--fail', '-#', '--progress-bar'].includes(t)) {}
      else if (t.startsWith('-')) {}
      else if (!url) url = t;
    }
    if (!method) method = (datas.length && !getFlag) ? 'POST' : 'GET';
    method = method.toUpperCase();
    let body = datas.join('&');
    if (getFlag && body) { url += (url.includes('?') ? '&' : '?') + body; body = ''; }
    const ct = headers.find(h => h.k.toLowerCase() === 'content-type');
    let bodyType = 'none';
    if (body) { if (ct && /json/i.test(ct.v)) bodyType = 'json'; else if (/^\s*[\[{]/.test(body)) bodyType = 'json'; else bodyType = 'text'; }
    if (bodyType === 'json') { try { body = JSON.stringify(JSON.parse(body), null, 2); } catch (e) {} }
    return { method, url, headers, body, bodyType };
  }

  /* 请求结构 → cURL 命令。resolveVars 为变量解析回调（可空，默认原样）。 */
  function toCurl(t, resolveVars) {
    const rv = resolveVars || (s => s);
    let url = rv(t.url.trim()); if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(url)) url = 'https://' + url;
    const Q = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
    const parts = ['curl -X ' + t.method + ' ' + Q(url)];
    const headers = {};
    t.headers.filter(r => r.on && r.k).forEach(r => headers[rv(r.k)] = rv(r.v));
    let body = null;
    if (!['GET', 'HEAD'].includes(t.method)) {
      if (t.bodyType === 'json') { body = rv(t.body); if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'; }
      else if (t.bodyType === 'text') body = rv(t.body);
      else if (t.bodyType === 'form') { body = t.formBody.filter(r => r.on && r.k).map(r => encodeURIComponent(rv(r.k)) + '=' + encodeURIComponent(rv(r.v))).join('&'); if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    }
    Object.entries(headers).forEach(([k, v]) => parts.push('-H ' + Q(k + ': ' + v)));
    if (body) parts.push('--data-raw ' + Q(body));
    return parts.join(' \\\n  ');
  }

  /* URL 拆分为 [base, query] */
  function splitUrl(url) { const i = url.indexOf('?'); return i < 0 ? [url, ''] : [url.slice(0, i), url.slice(i + 1)]; }

  /* 从 URL 提取短显示名（pathname 或 hostname） */
  function shortUrl(u) {
    try { const x = new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u.replace(/^\{\{[^}]+\}\}/, 'http://x')); return (x.pathname && x.pathname.length > 1) ? x.pathname : x.hostname; }
    catch (e) { return String(u).slice(0, 28); }
  }

  window.POLARIS_CURL = { tokenizeCurl, parseCurl, toCurl, splitUrl, shortUrl };
})();
