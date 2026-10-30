/* app.js — polaris-api 请求客户端：多 tab、集合/分组、环境变量、cURL 导入导出、响应渲染编排。
 * 自原版 relay-devkit tools/api.js 移植，适配 DBX 沙箱：
 *   - 去 cap.http / /__proxy 代理（DBX 无宿主直发通道、无本地中继后端）；
 *   - 网络纯 fetch 直连，受 manifest 声明的 host.network 白名单 + 浏览器 CORS 约束；
 *   - 持久化走 DBXBridge.storage（声明 host.storage），降级内存；
 *   - 去 router/currentView 依赖（DBX 单视图）。
 * IIFE 启动；依赖：window.POLARIS_CORE（$ $$ uid esc el METHODS bytes ms methodColor setStatus toast copy fmtDate BINARY tryJSON）
 *           window.POLARIS_JV（getByPath collectPaths viewRaw viewObject viewTable toggleRawWrap filterBar configureViewHost）
 *           window.DBXBridge（storage ready）
 */
(function () {
const { $, $$, uid, esc, el, METHODS, bytes, ms, methodColor, setStatus, toast, copy, fmtDate, BINARY, tryJSON } = window.POLARIS_CORE;
const JV = window.POLARIS_JV;
const { getByPath, collectPaths, viewRaw, viewObject, viewTable, toggleRawWrap, filterBar } = JV;
const { parseCurl, toCurl, shortUrl, splitUrl } = window.POLARIS_CURL;
const DBX = window.DBXBridge;

/* ===================== 状态 + 持久化 ===================== */
const ST_KEY='polaris-api.state.v2';   // 单键存全部状态（storage 256KiB/值上限足够）
let state={ tabs:[], activeTab:null, collections:[], envs:[], activeEnv:null };
let ui={ sideCollapsed:false, layout:'v', reqH:240, reqW:520, timeoutMs:120000 };

/* 响应字节数估算（sidecar 已返回 size，此为降级估算） */
function respSize(ct, body, isBase64){
  if(!body) return 0;
  if(isBase64){ const pad=(body.match(/=+$/)||[''])[0].length; return Math.floor(body.length*3/4)-pad; }
  return new TextEncoder().encode(body).length;
}
/* sidecar 返回 base64 二进制 → Blob（供 blobUrl 预览/下载） */
function b64ToBlob(b64, ct){
  try{
    const bin=atob(b64); const u8=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
    return new Blob([u8],{type:ct||'application/octet-stream'});
  }catch(e){ return null; }
}

/* 浏览器 fetch 禁发头（forbidden header names + Sec- 前缀）。
 * DBX 沙箱纯 fetch 直连：这些头会被浏览器静默剥离（UI 无感知丢失）。
 * DBX 无 cap.http 宿主直发通道，无法绕过——只能提示用户这些头会丢失。 */
const BROWSER_STRIP=/^(cookie|cookie2|user-agent|referer|origin|host|date|dnt|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*|accept-encoding|content-length)$/i;
const blankRow = ()=>({id:uid(),on:true,k:'',v:''});
function newTab(seed){
  return Object.assign({
    id:uid(), name:'未命名请求', savedId:null, dirty:false,
    method:'GET', url:'', params:[blankRow()], headers:[blankRow()],
    bodyType:'none', body:'', formBody:[blankRow()],
    reqTab:'params', respView:'object', respPath:'', respFilter:'', tableSel:null,
    prettyCells:true, colW:{}, treeOpen:'auto', hiddenCols:{}, sort:{}, colOrder:{},
    response:null
  }, seed||{});
}
const activeTab = ()=> state.tabs.find(t=>t.id===state.activeTab);

/* persist 改为异步单键存储（DBXBridge.storage，声明 host.storage 后走 dbxPlugin.storage，
 * 否则内存降级）。剔除 response 等运行态。失败不阻塞 UI。 */
let _persistTimer=null;
function persist(){
  clearTimeout(_persistTimer);
  _persistTimer=setTimeout(()=>{
    const tabs=state.tabs.map(t=>{const c={...t};delete c.response;delete c.abortCtl;delete c.sendSeq;delete c.stopped;return c;});
    const snap={tabs,activeTab:state.activeTab,collections:state.collections,envs:state.envs,activeEnv:state.activeEnv,ui};
    DBX.storage.set(ST_KEY, snap).catch(()=>{});
  },180);
}
async function load(){
  const snap = await DBX.storage.get(ST_KEY).catch(()=>null);
  if(snap && typeof snap==='object'){
    if(snap.tabs&&snap.tabs.length){ state.tabs=snap.tabs.map(x=>newTab(x)); state.activeTab=snap.activeTab; }
    if(Array.isArray(snap.collections)) state.collections=snap.collections;
    if(snap.envs){ state.envs=snap.envs||[]; state.activeEnv=snap.activeEnv||null; }
    if(snap.ui) ui=Object.assign(ui,snap.ui);
  }
  // 超时容错：历史存储可能无 timeoutMs 或类型异常，统一回落默认 120s
  if(typeof ui.timeoutMs!=='number' || !Number.isFinite(ui.timeoutMs) || ui.timeoutMs<0) ui.timeoutMs=120000;
  if(!state.collections.length || !state.envs.length) seed();
  if(!state.tabs.length){ const t=newTab(); state.tabs=[t]; state.activeTab=t.id; }
  if(!activeTab()) state.activeTab=state.tabs[0].id;
}
function sreq(name,method,url,extra){ return Object.assign({id:uid(),name,method,url,params:[blankRow()],headers:[blankRow()],bodyType:'none',body:'',formBody:[blankRow()]},extra||{}); }
function seed(){
  if(!state.envs.length){
    const demo={id:uid(),name:'Demo · jsonplaceholder',baseUrl:'https://jsonplaceholder.typicode.com',vars:[{id:uid(),on:true,k:'token',v:'demo-token-123'}]};
    state.envs=[demo]; state.activeEnv=demo.id;
  }
  if(!state.collections.length){
    const g={ id:uid(), name:'示例 · DEMO', collapsed:false, requests:[
      sreq('用户列表 {{baseUrl}}','GET','{{baseUrl}}/users'),
      sreq('单个 Todo(对象)','GET','{{baseUrl}}/todos/1'),
      sreq('用户 {{baseUrl}}/users/1','GET','{{baseUrl}}/users/1'),
      sreq('相册(嵌套数据→表格)','GET','{{baseUrl}}/albums'),
      sreq('新建 Post','POST','{{baseUrl}}/posts',{bodyType:'json',body:JSON.stringify({title:'polaris',body:'hello',userId:1},null,2),
        headers:[{id:uid(),on:true,k:'Authorization',v:'Bearer {{token}}'},blankRow()]}),
    ]};
    state.collections=[g];
  }
}

/* ===================== 变量解析 ===================== */
function curEnv(){ return state.envs.find(e=>e.id===state.activeEnv); }
function resolveVars(str){
  if(str==null || String(str).indexOf('{{')<0) return str;
  const env=curEnv();
  return String(str).replace(/\{\{\s*([\w.\-]+)\s*\}\}/g,(m,key)=>{
    if(!env) return m;
    if(key==='baseUrl') return env.baseUrl||'';
    const v=(env.vars||[]).find(r=>r.on&&r.k===key);
    return v? v.v : m;
  });
}

/* ===================== 方法下拉（延迟到 initApi 绑定） ===================== */
function bindMethodMenu(){
  const menu=$('#methodMenu'); if(!menu)return;
  METHODS.forEach(m=>{ const b=el('button',methodColor(m),m); b.onclick=()=>{ const t=activeTab(); t.method=m; markDirty(t); $('#methodMenu').classList.remove('open'); renderRequestBar(); renderReqEditor(); persist(); }; menu.appendChild(b); });
}
function bindTopEvents(){
  const ms=$('#methodSel'); if(ms) ms.onclick=e=>{ e.stopPropagation(); $('#methodMenu').classList.toggle('open'); };
  const es=$('#envSel'); if(es) es.onclick=e=>{ e.stopPropagation(); $('#envMenu').classList.toggle('open'); };
  document.addEventListener('click',()=>{ const mm=$('#methodMenu'); if(mm)mm.classList.remove('open'); const em=$('#envMenu'); if(em)em.classList.remove('open'); $$('.path-menu').forEach(m=>m.classList.remove('open')); });
}

/* ===================== 侧栏 ===================== */
function renderSidebar(){
  const tree=$('#tree');
  const prevScroll=tree.scrollTop;   // 重建会重置 scrollTop，先记录
  tree.innerHTML='';
  const q=($('#search').value||'').toLowerCase().trim();
  let total=0, shown=0;
  if(!state.collections.length) tree.appendChild(el('div','tree-empty','还没有任何分组。<br>点击右上角 ＋ 新建一个。'));
  state.collections.forEach(g=>{
    const matched=g.requests.filter(r=>!q||r.name.toLowerCase().includes(q)||r.url.toLowerCase().includes(q));
    total+=g.requests.length;
    if(q && !matched.length && !g.name.toLowerCase().includes(q)) return;
    const list=q?matched:g.requests; shown+=list.length;
    const gEl=el('div','group'+(g.collapsed&&!q?' collapsed':''));
    const head=el('div','group-head');
    head.innerHTML=`<span class="caret">▼</span><span class="gname">${esc(g.name)}</span><span class="gcount">${g.requests.length}</span>`;
    const act=el('span','gact');
    const ren=el('button','x','✎'); ren.title='重命名'; ren.onclick=e=>{e.stopPropagation();renameGroup(g);};
    const del=el('button','x','🗑'); del.title='删除分组'; del.onclick=e=>{e.stopPropagation();deleteGroup(g);};
    act.append(ren,del); head.appendChild(act);
    head.onclick=()=>{ g.collapsed=!g.collapsed; persist(); renderSidebar(); };
    gEl.appendChild(head);
    const reqs=el('div','reqs');
    list.forEach(r=>{
      const item=el('div','req-item'+(activeTab()&&activeTab().savedId===r.id?' active':''));
      item.innerHTML=`<span class="mb ${methodColor(r.method)}">${r.method}</span><span class="rn">${esc(r.name)}</span>`;
      const x=el('button','rx','✕'); x.title='删除'; x.onclick=e=>{e.stopPropagation();deleteSaved(g,r);};
      item.appendChild(x); item.onclick=()=>openSaved(r); reqs.appendChild(item);
    });
    gEl.appendChild(reqs); tree.appendChild(gEl);
  });
  if(q && shown===0) tree.appendChild(el('div','tree-empty','没有匹配「'+esc(q)+'」的请求。'));
  if(prevScroll) tree.scrollTop=prevScroll;   // 恢复滚动位置（搜索/点击重建不打断浏览）
  $('#stSaved').textContent=total;
}

/* ===================== 环境切换 ===================== */
function renderEnv(){
  const env=curEnv();
  $('#envName').textContent=env?env.name:'无环境';
  $('#envSel').title=env&&env.baseUrl?('baseUrl: '+env.baseUrl):'未选择环境';
  const menu=$('#envMenu'); menu.innerHTML='';
  state.envs.forEach(e=>{
    const b=el('button','env-item'+(e.id===state.activeEnv?' on':''),`<span>${esc(e.name)}</span><small>${esc(e.baseUrl||'(无 baseUrl)')}</small>`);
    b.onclick=()=>{ state.activeEnv=e.id; persist(); renderEnv(); renderRequestBar(); $('#envMenu').classList.remove('open'); setStatus('已切换环境：'+e.name,'ok'); };
    menu.appendChild(b);
  });
  const none=el('button','env-item'+(!state.activeEnv?' on':''),'<span>无环境</span><small>不解析变量</small>');
  none.onclick=()=>{ state.activeEnv=null; persist(); renderEnv(); renderRequestBar(); $('#envMenu').classList.remove('open'); };
  menu.appendChild(none);
  const mng=el('button','env-item manage','<span>⚙ 管理环境与变量…</span>'); mng.onclick=()=>{ $('#envMenu').classList.remove('open'); openEnvManager(); };
  menu.appendChild(mng);
  const to=el('button','env-item manage','<span>⏱ 请求超时：'+esc(fmtTimeout(ui.timeoutMs))+'</span>'); to.onclick=()=>{ $('#envMenu').classList.remove('open'); openTimeoutSettings(); };
  menu.appendChild(to);
}
function openEnvManager(){
  const bg=$('#modalBg'); const m=el('div','modal wide');
  let selId=state.activeEnv || (state.envs[0]&&state.envs[0].id);
  function render(){
    const env=state.envs.find(e=>e.id===selId);
    m.innerHTML=`<h3>环境与变量</h3><div class="sub">每个环境含一个请求服务 <b>baseUrl</b>(ip+端口) 与一组变量；在 URL / Header / Body 中用 <b>{{baseUrl}}</b>、<b>{{变量名}}</b> 引用，发送时解析。</div>`;
    const tabs=el('div','env-tabs');
    state.envs.forEach(e=>{ const b=el('button','env-tab'+(e.id===selId?' on':''),esc(e.name)+(e.id===state.activeEnv?' ●':'')); b.onclick=()=>{selId=e.id;render();}; tabs.appendChild(b); });
    const add=el('button','env-tab add','＋ 新建环境'); add.onclick=()=>{ const ne={id:uid(),name:'环境 '+(state.envs.length+1),baseUrl:'',vars:[blankRow()]}; state.envs.push(ne); selId=ne.id; render(); };
    tabs.appendChild(add); m.appendChild(tabs);
    if(env){
      const f1=el('div','field'); f1.innerHTML='<label>环境名称</label>'; const i1=el('input'); i1.value=env.name; i1.oninput=()=>env.name=i1.value; f1.appendChild(i1); m.appendChild(f1);
      const f2=el('div','field'); f2.innerHTML='<label>请求服务 baseUrl（ip + 端口）</label>'; const i2=el('input'); i2.placeholder='http://127.0.0.1:8080'; i2.value=env.baseUrl||''; i2.oninput=()=>env.baseUrl=i2.value; f2.appendChild(i2); m.appendChild(f2);
      const f3=el('div','field'); f3.innerHTML='<label>变量</label>'; const host=el('div','env-vars'); if(!env.vars)env.vars=[blankRow()]; host.appendChild(kvEditor(env.vars,{kPlace:'变量名',vPlace:'值',onChange:()=>{}})); f3.appendChild(host); m.appendChild(f3);
    }else m.appendChild(el('div','field','还没有环境，点「＋ 新建环境」。'));
    const acts=el('div','acts');
    if(env){ const del=el('button','btn ghost danger','删除'); del.onclick=()=>{ if(confirm('删除环境「'+env.name+'」？')){ state.envs=state.envs.filter(e=>e.id!==env.id); if(state.activeEnv===env.id)state.activeEnv=state.envs[0]?state.envs[0].id:null; selId=state.envs[0]&&state.envs[0].id; render(); } }; acts.appendChild(del); }
    const sp=el('div'); sp.style.flex='1'; acts.appendChild(sp);
    if(env){ const use=el('button','btn',env.id===state.activeEnv?'✓ 当前环境':'设为当前'); use.onclick=()=>{ state.activeEnv=selId; persist(); renderEnv(); renderRequestBar(); render(); }; acts.appendChild(use); }
    const done=el('button','btn primary','完成'); done.onclick=close; acts.appendChild(done);
    m.appendChild(acts);
  }
  function close(){ state.envs.forEach(e=>{ if(e.vars)e.vars=e.vars.filter(r=>r.k||r.v); }); persist(); renderEnv(); renderRequestBar(); bg.classList.remove('open'); bg.innerHTML=''; }
  bg.innerHTML=''; bg.appendChild(m); bg.classList.add('open'); bg.onclick=e=>{if(e.target===bg)close();};
  render();
}

/* 超时配置：全局默认（持久化 ui.timeoutMs），独立窗口 fetch 路径由 AbortController 执行等价超时 */
function fmtTimeout(ms){
  if(ms==null) return '';
  if(ms<=0) return '无限制';
  return (ms/1000)+' 秒';
}
function timeoutOptions(){
  return [
    {label:'无限制（宿主护栏约 900s）', ms:0},
    {label:'15 秒', ms:15000},
    {label:'30 秒', ms:30000},
    {label:'60 秒', ms:60000},
    {label:'120 秒（默认）', ms:120000},
    {label:'300 秒', ms:300000},
  ];
}
function openTimeoutSettings(){
  const bg=$('#modalBg'); const m=el('div','modal');
  m.innerHTML='<h3>请求超时设置</h3><div class="sub">发送请求最长等待时间。面板模式经宿主 cap.http 直发，受宿主 900s（约 15 分钟）总护栏约束；「无限制」实际等待上限仍为 900s。</div>';
  const opts=timeoutOptions();
  const f=el('div','field'); f.innerHTML='<label>超时</label>';
  const sel=el('select');
  // 预置选项；若当前值不在预置中，追加一个「自定义」占位显示（不改动用户值，保存时若未改动维持原值）
  if(!opts.some(o=>o.ms===ui.timeoutMs)){
    const op=el('option'); op.value=String(ui.timeoutMs); op.textContent='自定义 '+(ui.timeoutMs>0?(ui.timeoutMs/1000)+' 秒':'无限制'); sel.appendChild(op);
  }
  opts.forEach(o=>{ const op=el('option'); op.value=o.ms; op.textContent=o.label; sel.appendChild(op); });
  sel.value=String(ui.timeoutMs);
  f.appendChild(sel); m.appendChild(f);
  // 说明当前生效值
  const cur=el('div','sub'); cur.style.cssText='padding-top:0'; cur.innerHTML='当前值：<b>'+fmtTimeout(ui.timeoutMs)+'</b>';
  m.appendChild(cur);
  const acts=el('div','acts'); const sp=el('div'); sp.style.flex='1';
  const reset=el('button','btn ghost','恢复默认 120s'); reset.title='120 秒';
  reset.onclick=()=>{ ui.timeoutMs=120000; persist(); renderEnv(); close(); setStatus('请求超时已恢复默认 120 秒','ok'); };
  const ok=el('button','btn primary','保存'); ok.onclick=()=>{ const v=Number(sel.value); if(v!==ui.timeoutMs){ ui.timeoutMs=v; persist(); setStatus('请求超时已设为 '+fmtTimeout(v),'ok'); } close(); };
  acts.append(reset,sp,ok); m.appendChild(acts);
  bg.innerHTML=''; bg.appendChild(m); bg.classList.add('open');
  bg.onclick=e=>{ if(e.target===bg)close(); };
  function close(){ bg.classList.remove('open'); bg.innerHTML=''; }
}
/* ===================== tab 条 ===================== */
// 新建 tab 时置 true：新 tab unshift 到头部，需滚动到最左让用户看到；
// 其余场景（点击/关闭/保存等）应恢复重建前的滚动位置，避免整条 tab 栏跳回开头。
let _resetTabScroll=false;
function renderTabs(){
  const bar=$('#tabbar');
  const prevScroll=bar.scrollLeft;   // 重建会重置 scrollLeft，先记录点击前位置
  bar.innerHTML='';
  // 加号钉在左缘（position:sticky），先插入使其位于滚动起点
  const add=el('button','tab-add','+'); add.title='新建请求 tab'; add.onclick=()=>{ const nt=newTab(); state.tabs.unshift(nt); state.activeTab=nt.id; _resetTabScroll=true; renderAll(); persist(); };
  bar.appendChild(add);
  state.tabs.forEach(t=>{
    const tab=el('div','rtab'+(t.id===state.activeTab?' active':''));
    tab.innerHTML=`<span class="tm ${methodColor(t.method)}">${t.method}</span><span class="tn">${esc(t.name)}</span>`;
    if(t.dirty) tab.appendChild(el('span','dirty'));
    const x=el('button','tx','×'); x.title='关闭'; x.onclick=e=>{e.stopPropagation();closeTab(t);}; tab.appendChild(x);
    tab.onclick=()=>{ state.activeTab=t.id; renderAll(); persist(); };
    tab.oncontextmenu=e=>{ e.preventDefault(); e.stopPropagation(); showTabCtxMenu(e,t); };
    tab.querySelector('.tn').ondblclick=e=>{ e.stopPropagation(); const n=prompt('重命名 tab：',t.name); if(n!=null){ t.name=n.trim()||t.name; renderTabs(); persist(); } };
    bar.appendChild(tab);
  });
  // 新 tab 回到左缘，确保可见（加号 stick 后滚动起点即在窗口最左）；
  // 其他操作（点击/关闭/保存等）恢复重建前位置，避免点靠后 tab 时整条跳回开头。
  if(_resetTabScroll){ bar.scrollLeft=0; _resetTabScroll=false; }
  else if(prevScroll) bar.scrollLeft=prevScroll;
  updateTabFade();
  $('#stTabs').textContent=state.tabs.length;
}
/* 右缘溢出遮罩：有未滚出的 tab 时亮起（隐藏滚动条下的唯一"还有更多"提示） */
function updateTabFade(){
  const bar=$('#tabbar'); if(!bar) return;
  bar.classList.toggle('has-more', bar.scrollLeft+bar.clientWidth < bar.scrollWidth-1);
}

/* ===================== 请求栏 ===================== */
function renderRequestBar(){
  const t=activeTab();
  const lbl=$('#methodLabel'); lbl.textContent=t.method; lbl.className=methodColor(t.method);
  const urlIn=$('#url'); if(document.activeElement!==urlIn) urlIn.value=t.url;
  updateResolvedPreview();
}
function updateResolvedPreview(){
  const t=activeTab(); const box=$('#urlResolved');
  if(t.url && t.url.indexOf('{{')>=0){ const r=resolveVars(t.url); box.innerHTML='→ <b>'+esc(r)+'</b>'; }
  else box.innerHTML='';
}

/* ===================== 请求编辑区 ===================== */
const countRows = rows => rows.filter(r=>r.on&&(r.k||r.v)).length;
function renderReqEditor(){
  const t=activeTab();
  $$('#reqSubtabs .subtab').forEach(b=>b.classList.toggle('active',b.dataset.rt===t.reqTab));
  $('#bParams').textContent=countRows(t.params)||'';
  $('#bHeaders').textContent=countRows(t.headers)||'';
  $('#bBody').textContent=t.bodyType!=='none'?'•':'';
  const pane=$('#reqPane'); pane.innerHTML='';
  if(t.reqTab==='params'){
    pane.appendChild(kvEditor(t.params,{kPlace:'参数名',vPlace:'参数值',onChange:()=>{ markDirty(t); syncParamsToUrl(t); $('#bParams').textContent=countRows(t.params)||''; persist(); }}));
  }else if(t.reqTab==='headers'){
    pane.appendChild(kvEditor(t.headers,{kPlace:'Header 名',vPlace:'Header 值',onChange:()=>{ markDirty(t); $('#bHeaders').textContent=countRows(t.headers)||''; persist(); }}));
  }else renderBodyEditor(pane,t);
}
function kvEditor(rows,opts){
  const wrap=el('div','kv');
  function ensureBlank(){ if(!rows.length || rows[rows.length-1].k || rows[rows.length-1].v) rows.push(blankRow()); }
  function rowEl(r){
    const isLast=()=>rows[rows.length-1]===r;
    const row=el('div','kv-row'+((!r.k&&!r.v)?' blank':''));
    const ck=el('label','ck'); const cb=el('input'); cb.type='checkbox'; cb.checked=r.on; cb.onchange=()=>{r.on=cb.checked;opts.onChange();}; ck.appendChild(cb);
    const ki=el('input','k'); ki.type='text'; ki.placeholder=opts.kPlace; ki.value=r.k; ki.spellcheck=false;
    const vi=el('input','v'); vi.type='text'; vi.placeholder=opts.vPlace; vi.value=r.v; vi.spellcheck=false;
    const onInput=()=>{ r.k=ki.value; r.v=vi.value; row.classList.toggle('blank',!r.k&&!r.v); if((r.k||r.v)&&isLast()){ const nr=blankRow(); rows.push(nr); wrap.appendChild(rowEl(nr)); } opts.onChange(); };
    ki.addEventListener('input',onInput); vi.addEventListener('input',onInput);
    const rm=el('button','rm','✕'); rm.title='删除该行'; rm.onclick=()=>{ const i=rows.indexOf(r); if(i>-1)rows.splice(i,1); rebuild(); opts.onChange(); };
    row.append(ck,ki,vi,rm); return row;
  }
  function rebuild(){ wrap.innerHTML=''; ensureBlank(); rows.forEach(r=>wrap.appendChild(rowEl(r))); }
  rebuild(); return wrap;
}
function renderBodyEditor(pane,t){
  const bar=el('div','body-bar'); const seg=el('div','seg');
  [['none','无'],['json','JSON'],['text','文本'],['form','Form']].forEach(([v,l])=>{ const b=el('button',t.bodyType===v?'on':'',l); b.onclick=()=>{ t.bodyType=v; markDirty(t); persist(); renderReqEditor(); }; seg.appendChild(b); });
  bar.appendChild(seg); bar.appendChild(el('div','sp'));
  if(t.bodyType==='json'){ const fmt=el('button','tool','格式化'); fmt.onclick=()=>{ try{ t.body=JSON.stringify(JSON.parse(t.body),null,2); renderReqEditor(); persist(); setStatus('JSON 已格式化','ok'); }catch(e){ setStatus('JSON 无效：'+e.message,'err'); } }; bar.appendChild(fmt); }
  pane.appendChild(bar);
  if(t.bodyType==='none'){ pane.appendChild(el('div','body-none','该请求没有 Body。<br>选择 JSON / 文本 / Form 以编辑请求体。')); }
  else if(t.bodyType==='form'){ const host=el('div'); host.style.cssText='height:calc(100% - 49px);overflow:auto'; host.appendChild(kvEditor(t.formBody,{kPlace:'字段名',vPlace:'字段值',onChange:()=>{markDirty(t);persist();}})); pane.appendChild(host); }
  else{
    const ta=el('textarea','code'); ta.spellcheck=false; ta.placeholder=t.bodyType==='json'?'{\n  "key": "value"\n}':'原始请求体…'; ta.value=t.body; ta.style.height='calc(100% - 49px)';
    ta.addEventListener('input',()=>{ t.body=ta.value; markDirty(t); persist(); });
    ta.addEventListener('keydown',e=>{ if(e.key==='Tab'){ e.preventDefault(); const s=ta.selectionStart,en=ta.selectionEnd; ta.value=ta.value.slice(0,s)+'  '+ta.value.slice(en); ta.selectionStart=ta.selectionEnd=s+2; t.body=ta.value; } });
    pane.appendChild(ta);
  }
}
function syncParamsToUrl(t){
  const [base]=splitUrl(t.url);
  const qs=t.params.filter(r=>r.on&&r.k).map(r=>encodeURIComponent(r.k)+'='+encodeURIComponent(r.v)).join('&');
  t.url = qs? base+'?'+qs : base;
  const urlIn=$('#url'); if(document.activeElement!==urlIn) urlIn.value=t.url;
  updateResolvedPreview();
}
function syncUrlToParams(t){
  const [,query]=splitUrl(t.url); const rows=[];
  if(query) query.split('&').forEach(p=>{ if(!p)return; const [k,...rest]=p.split('='); rows.push({id:uid(),on:true,k:decodeURIComponent(k||''),v:decodeURIComponent((rest.join('=')||'').replace(/\+/g,' '))}); });
  rows.push(blankRow()); t.params=rows;
}

/* ===================== 发送 ===================== */
async function send(){
  const t=activeTab();
  const seq=(t.sendSeq||0)+1;              // 竞态守卫序号：迟到响应不得覆盖新请求/已中断状态
  t.sendSeq=seq;
  t.stopped=false;                       // 新发送重置中断标记
  if(t.abortCtl) t.abortCtl.abort();     // 清理上个 in-flight（若还在）
  let url=resolveVars(t.url.trim());
  if(!url){ setStatus('请先输入 URL','warn'); $('#url').focus(); return; }
  if(!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(url)) url='https://'+url;
  const headers={}; t.headers.filter(r=>r.on&&r.k).forEach(r=>headers[resolveVars(r.k)]=resolveVars(r.v));
  // DBX 沙箱纯 fetch 直连：无 cap.http 宿主直发、无本地中继代理。
  // 禁发头（Cookie/UA/Referer 等 forbidden headers）会被浏览器静默剥离，UI 无感知丢失。
  // 不再硬拦截——改为发送后若失败提示可能原因；用户可去掉这些头或接受丢失。
  const strippedHeaders=Object.keys(headers).filter(k=>BROWSER_STRIP.test(k));
  t.strippedHeaders=strippedHeaders;
  let body; const method=t.method;
  if(!['GET','HEAD'].includes(method)){
    if(t.bodyType==='json'){ body=resolveVars(t.body); if(!Object.keys(headers).some(h=>h.toLowerCase()==='content-type')) headers['Content-Type']='application/json'; }
    else if(t.bodyType==='text'){ body=resolveVars(t.body); }
    else if(t.bodyType==='form'){ body=t.formBody.filter(r=>r.on&&r.k).map(r=>encodeURIComponent(resolveVars(r.k))+'='+encodeURIComponent(resolveVars(r.v))).join('&'); if(!Object.keys(headers).some(h=>h.toLowerCase()==='content-type')) headers['Content-Type']='application/x-www-form-urlencoded'; }
  }
  // 超时：全局 ui.timeoutMs（默认 120s）；`0` = 无限制（fetch 不设 timer）
  const tmo = (typeof ui.timeoutMs==='number' && Number.isFinite(ui.timeoutMs)) ? ui.timeoutMs : 120000;
  const btn=$('#sendBtn');
  // 发送态：按钮变为可点击的「■ 停止」
  btn.classList.add('stop-mode'); btn.disabled=false;
  btn.innerHTML='<span class="stop-ico"></span> 停止';
  btn.title='停止请求';
  $('#resSubtabs').style.display='none'; $('#resStatus').style.display='none'; $('#resTools').style.display='none';
  $('#resPane').innerHTML='<div class="res-loading"><span class="spin"></span> 请求发送中…<span class="wait-tick" id="waitTick"></span></div>';
  setStatus(method+' '+url+' …');
  const t0=performance.now();
  // 等待计时
  const tick=setInterval(()=>{ const el=$('#waitTick'); if(el) el.textContent=' · 已等待 '+ms(performance.now()-t0); },1000);

  // 停止处理：只有 seq 匹配（未发生新发送）才生效
  const doStop=()=>{
    if(t.sendSeq!==seq) return;               // 已被新请求覆盖，忽略
    t.sendSeq++;                               // 推进序号，废止在途回调
    t.stopped=true;
    clearInterval(tick);
    if(t.abortCtl){ t.abortCtl.abort(); t.abortCtl=null; }
    btn.classList.remove('stop-mode'); btn.disabled=false; btn.innerHTML='发送 <span class="k">⌘↵</span>'; btn.title='';
    btn.onclick=send;
    $('#resPane').innerHTML=`<div class="res-err"><div class="ti">⏹ 已手动中断</div><div>请求已停止。<span style="color:var(--dimmer)">sidecar 原生请求仍在后台继续，UI 已丢弃响应（逻辑中断）。</span></div><div style="margin-top:10px;color:var(--dimmer);font-size:11px">耗时 ${ms(performance.now()-t0)} · ${esc(url)}</div></div>`;
    setStatus('请求已中断 · '+ms(performance.now()-t0),'err');
  };
  btn.onclick = (e)=>{ e.preventDefault(); e.stopPropagation(); doStop(); };

  const abortCtl = (typeof AbortController!=='undefined') ? new AbortController() : null;
  t.abortCtl=abortCtl;
  try{
    let resp;
    {
      // sidecar 模式：经 dbxPlugin.invoke('http/request') 调本插件原生 backend 发送。
      // 原生进程用 reqwest 发请求，无 CORS/混合内容/禁发头限制，等效 cURL。
      // 停止按钮为逻辑中断：invoke 是同步 RPC 无法取消，请求继续在 sidecar 跑，
      // UI 用 sendSeq 守卫丢弃迟到响应（与原版 cap.http 面板模式同范式）。
      const r = await DBX.invoke('http/request', {
        method, url, headers,
        body: body || '',
        bodyType: t.bodyType || 'text',
        timeoutMs: tmo > 0 ? tmo : 86400000,
      });
      if (t.stopped || t.sendSeq !== seq) return;
      const ct = r.contentType || '';
      const isBin = BINARY.test(ct) || !!r.isBase64;
      const text = r.body || '';
      let blobUrl = null;
      if (isBin && r.isBase64 && text) { const blob = b64ToBlob(text, ct); if (blob) blobUrl = URL.createObjectURL(blob); }
      const parsed = isBin ? { ok: false } : tryJSON(text);
      const t1 = performance.now();
      resp = {
        status: r.status, statusText: r.statusText || '', ok: !!r.ok,
        timeMs: r.timeMs || (t1 - t0), size: r.size || respSize(ct, text, r.isBase64) || 0,
        contentType: ct, headers: r.headers || {}, text, isBinary: isBin, blobUrl, url,
        parsed: parsed.ok ? parsed.value : undefined,
      };
    }
    if(t.stopped||t.sendSeq!==seq){ if(resp&&resp.blobUrl) URL.revokeObjectURL(resp.blobUrl); return; }  // 在途响应丢弃
    t.response=resp;
    t.respPath=''; t.respFilter=''; t.tableSel=null; t.colW={}; t.treeOpen='auto'; t.hiddenCols={}; t.sort={};
    t.respView = resp.parsed!==undefined ? (Array.isArray(resp.parsed)?'table':'object') : /text\/html/i.test(resp.contentType)?'preview' : (resp.isBinary&&/^image\//i.test(resp.contentType))?'preview':'raw';
    renderResponse();
    setStatus(method+' '+resp.status+' '+resp.statusText+' · '+ms(resp.timeMs)+' · '+bytes(resp.size), resp.ok?'ok':'warn');
  }catch(err){
    if(t.stopped||t.sendSeq!==seq) return;   // 停止/被覆盖：吞吐异常
    const t1=performance.now(); t.response={error:err.message||String(err),timeMs:t1-t0,url}; renderResponse();
    setStatus('请求失败：'+(err.message||err),'err');
  }finally{
    clearInterval(tick);
    if(btn.classList.contains('stop-mode')){
      btn.classList.remove('stop-mode'); btn.disabled=false; btn.innerHTML='发送 <span class="k">⌘↵</span>'; btn.title='';
    }
    // 还原 onClick：绑定事件的 sendBtn 由 bindEvents 原生挂载，重启避免残留 stop 接管
    const sb=$('#sendBtn'); if(sb){ sb.onclick=send; }
    if(t.abortCtl===abortCtl) t.abortCtl=null;
  }
}

/* ===================== 路径下钻（响应态） ===================== */
function getDrilled(t){
  const r=t.response; const root=r&&!r.error?r.parsed:undefined;
  let data=root, drillErr=false;
  if(t.respPath && root!==undefined){ const g=getByPath(root,t.respPath); if(g.ok) data=g.value; else {drillErr=true; data=undefined;} }
  const hasJSON=data!==undefined;
  const canTable=hasJSON && (Array.isArray(data) || (data&&typeof data==='object'));
  const canPrev = !!r && !t.respPath && (/text\/html/i.test(r.contentType)||/^image\//i.test(r.contentType));
  return {data,drillErr,hasJSON,canTable,canPrev};
}
/** 收集当前钻取数据的顶层字段名（用于过滤栏提示） */
function apiResponseFields(data){
  if(!data) return [];
  if(Array.isArray(data)&&data.length&&data[0]&&typeof data[0]==='object'&&!Array.isArray(data[0])) return Object.keys(data[0]);
  if(data&&typeof data==='object'&&!Array.isArray(data)) return Object.keys(data);
  return [];
}

/* ===================== 响应渲染 ===================== */
function renderResponse(){
  const t=activeTab(); const r=t.response;
  const pane=$('#resPane'),sub=$('#resSubtabs'),sb=$('#resStatus'),tools=$('#resTools');
  if(!r){ sub.style.display='none'; sb.style.display='none'; tools.style.display='none';
    pane.innerHTML='<div class="res-idle"><div class="big">准备就绪</div>输入 URL 点「发送」，或从左侧集合载入一个请求。</div>'; return; }
  if(r.error){ sub.style.display='none'; sb.style.display='none'; tools.style.display='none';
    const netHint=/Failed to fetch|NetworkError|load failed|send:|connect|dns|timeout|timed out/i.test(r.error);
    pane.innerHTML=`<div class="res-err"><div class="ti">⚠ 请求失败</div><div>${esc(r.error)}</div>`+
      (netHint?`<div class="hintbox"><b>可能原因：</b>目标无响应、DNS 解析失败、连接被拒、TLS 握手失败或超时。<br>请求经 sidecar 原生 reqwest 发送（无 CORS/混合内容限制），若失败多为目标侧或网络问题。${t.strippedHeaders&&t.strippedHeaders.length?`<br><b>禁发头：</b>本次含 <code>${esc(t.strippedHeaders.join(', '))}</code>，sidecar 原生发送会完整携带（不会被剥离）。`:''}</div>`:'')+
      `<div style="margin-top:10px;color:var(--dimmer);font-size:11px">耗时 ${ms(r.timeMs)} · ${esc(r.url)}</div></div>`; return; }
  sb.style.display='flex';
  const cls=r.status>=500?'s5':r.status>=400?'s4':r.status>=300?'s3':'s2'; const color=`var(--${cls})`;
  sb.innerHTML=`<span class="status-chip" style="color:${color}"><span class="dotc" style="background:${color}"></span>${r.status} ${esc(r.statusText)}</span>`+
    `<span class="res-meta"><span>耗时 <b>${ms(r.timeMs)}</b></span><span>大小 <b>${bytes(r.size)}</b></span>`+(r.contentType?`<span>类型 <b>${esc(r.contentType.split(';')[0])}</b></span>`:'')+`</span>`;
  sub.style.display='flex';
  // 工具栏（路径下拉 + 手动 + 过滤）
  const baseHasJSON = r.parsed!==undefined;
  if(baseHasJSON){
    tools.style.display='flex';
    tools.innerHTML='';
    let pi=null;
    // 路径下拉（自动识别）
    const pths=collectPaths(r.parsed);
    const ddWrap=el('div','ti path'); ddWrap.innerHTML='<span class="lbl">路径</span>';
    const dd=el('div','pathdd');
    const ddBtn=el('button','pathdd-btn'); ddBtn.type='button';
    const setLbl=()=>{ ddBtn.innerHTML=`<span>${t.respPath?esc(t.respPath):'选择路径'}</span><span class="pcar">▼</span>`; };
    setLbl();
    const menu=el('div','path-menu');
    const fbox=el('input','path-filter'); fbox.placeholder='过滤路径 / 输入后回车应用'; fbox.spellcheck=false;
    const list=el('div','path-list');
    const apply=p=>{ t.respPath=p; if(pi)pi.value=p; persist(); setLbl(); menu.classList.remove('open'); renderRespBody(); };
    const fill=()=>{ list.innerHTML=''; const kw=fbox.value.toLowerCase().trim(); let n=0;
      pths.forEach(p=>{ if(n>=200)return; const lab=p.path===''?'(根)':p.path; if(kw&&!lab.toLowerCase().includes(kw))return; n++;
        const o=el('button','path-opt'+(p.path===t.respPath?' on':'')); o.type='button';
        o.innerHTML=`<span class="pp">${esc(lab)}</span><span class="pk ${p.kind}">${p.kind==='array'?'[ ] '+p.count:p.kind==='object'?'{ } '+p.count:'·'}</span>`;
        o.onclick=()=>apply(p.path); list.appendChild(o); });
      if(!n) list.innerHTML='<div class="path-empty">无匹配路径。<br>回车可直接应用输入的路径。</div>'; };
    fbox.addEventListener('input',fill);
    fbox.addEventListener('keydown',e=>{ if(e.key==='Enter') apply(fbox.value.trim()); if(e.key==='Escape') menu.classList.remove('open'); });
    ddBtn.onclick=e=>{ e.stopPropagation(); const willOpen=!menu.classList.contains('open'); $$('.path-menu').forEach(x=>x.classList.remove('open')); $('#methodMenu').classList.remove('open'); $('#envMenu').classList.remove('open'); if(willOpen){ menu.classList.add('open'); fbox.value=''; fill(); setTimeout(()=>fbox.focus(),0); } };
    menu.addEventListener('click',e=>e.stopPropagation());
    menu.append(fbox,list); dd.append(ddBtn,menu); ddWrap.appendChild(dd);
    // 手动输入（保留，供精确路径与快捷测试）
    const man=el('div','ti manual'); man.innerHTML='<span class="lbl">手动</span>'; pi=el('input'); pi.id='respPathIn'; pi.placeholder='如 data.items[0].name'; pi.value=t.respPath||''; pi.spellcheck=false;
    pi.addEventListener('input',()=>{ t.respPath=pi.value; persist(); setLbl(); renderRespBody(); }); man.appendChild(pi);
    // 过滤（增强版，支持字段匹配语法）
    const drilled=getDrilled(t);
    const apiFields=apiResponseFields(drilled.data);
    const flt=filterBar(t,()=>{ persist(); renderRespBody(); },apiFields);
    tools.append(ddWrap,man,flt);
  }else tools.style.display='none';
  $('#bResH').textContent=Object.keys(r.headers||{}).length||'';
  renderRespBody();
}
function renderRespBody(){
  const t=activeTab(); const r=t.response; if(!r||r.error) return;
  const d=getDrilled(t);
  const caps={table:d.canTable,object:d.hasJSON,raw:true,preview:d.canPrev,headers:true};
  if(!caps[t.respView]) t.respView=d.hasJSON?'object':(d.canPrev?'preview':'raw');
  $$('#resSubtabs .subtab').forEach(b=>{ const v=b.dataset.rv; b.classList.toggle('active',v===t.respView); b.classList.toggle('disabled',!caps[v]); if(v==='preview') b.style.display=d.canPrev?'':'none'; });
  const isT=t.respView==='table', isO=t.respView==='object', isR=t.respView==='raw';
  const pretty=t.prettyCells!==false;
  $('#prettyBtn').style.display=(isT||isO)?'':'none'; $('#prettyBtn').style.color=pretty?'var(--brand)':''; $('#prettyBtn').innerHTML=pretty?'✦ 美化':'✦ 原始';
  $('#treeExpand').style.display=isO?'':'none'; $('#treeCollapse').style.display=isO?'':'none';
  $('#wrapBtn').style.display=isR?'':'none';
  const pane=$('#resPane'); pane.innerHTML='';
  if(d.drillErr){ pane.innerHTML='<div class="prev-none">路径 <b>'+esc(t.respPath)+'</b> 在响应中不存在。</div>'; return; }
  const v=t.respView;
  if(v==='raw') pane.appendChild(viewRaw(r,d.data));
  else if(v==='object') pane.appendChild(viewObject(d.data,t));
  else if(v==='table') pane.appendChild(viewTable(d.data,t));
  else if(v==='preview') pane.appendChild(viewPreview(r));
  else pane.appendChild(viewHeaders(r));
}

/* ---- 预览 / Headers ---- */
function viewPreview(r){
  if(/^image\//i.test(r.contentType)&&r.blobUrl){ const w=el('div','prev-img-wrap'); const img=el('img'); img.src=r.blobUrl; w.appendChild(img); return w; }
  if(/text\/html/i.test(r.contentType)){ const f=el('iframe','prev-frame'); f.sandbox=''; f.srcdoc=r.text; return f; }
  return el('div','prev-none','无可预览内容（仅支持 HTML 与图片预览）。');
}
function viewHeaders(r){
  const wrap=el('div','tbl-wrap'); const tbl=el('table','dt'); const keys=Object.keys(r.headers||{});
  tbl.innerHTML='<thead><tr><th>Header</th><th>Value</th></tr></thead>'; const tb=el('tbody');
  if(!keys.length) tb.innerHTML='<tr><td colspan="2" style="color:var(--dimmer)">（无可见响应头 — 浏览器可能限制了部分头）</td></tr>';
  keys.forEach(k=>{ const tr=el('tr'); tr.innerHTML=`<td style="color:var(--j-key);white-space:nowrap">${esc(k)}</td><td>${esc(r.headers[k])}</td>`; tb.appendChild(tr); });
  tbl.appendChild(tb); wrap.appendChild(tbl); return wrap;
}

/* ===================== cURL：导入 + 导出 ===================== */
/* parseCurl/tokenizeCurl/toCurl/shortUrl/splitUrl 抽离至 curl.js（window.POLARIS_CURL），此处仅保留 UI 编排 */
function openCurlImport(){
  const bg=$('#modalBg'); const m=el('div','modal');
  m.innerHTML='<h3>导入 cURL</h3><div class="sub">粘贴一条 curl 命令，解析为新的请求 tab（支持 -X -H -d --data-raw -u -b -G --json、--flag=value 等号写法、curl.exe 前缀）。</div>';
  const f=el('div','field'); f.innerHTML='<label>cURL 命令</label>'; const ta=el('textarea','curl-ta'); ta.placeholder="curl 'https://api.example.com/users' -H 'Authorization: Bearer xxx' -H 'Content-Type: application/json' --data-raw '{\"a\":1}'"; f.appendChild(ta); m.appendChild(f);
  const acts=el('div','acts'); const sp=el('div'); sp.style.flex='1';
  const c=el('button','btn ghost','取消'); c.onclick=close;
  const ok=el('button','btn primary','解析并新建');
  ok.onclick=()=>{ const txt=ta.value.trim(); if(!txt){ setStatus('请粘贴 curl 命令','warn'); return; }
    try{ const p=parseCurl(txt); if(!p.url){ setStatus('未能从命令中解析出 URL','err'); return; }
      const nt=newTab({ name:'cURL: '+shortUrl(p.url), method:p.method, url:p.url, bodyType:p.bodyType, body:p.body,
        headers:(p.headers.length?p.headers.map(h=>({id:uid(),on:true,k:h.k,v:h.v})):[]).concat([blankRow()]) });
      syncUrlToParams(nt); nt.dirty=true; state.tabs.unshift(nt); state.activeTab=nt.id; renderAll(); persist(); close(); setStatus('已从 cURL 导入：'+p.method+' '+p.url,'ok');
      // 检测禁发头：DBX 沙箱纯直连，这些头会被浏览器静默剥离，主动提醒
      const fb=p.headers.filter(h=>BROWSER_STRIP.test(h.k));
      if(fb.length){
        setStatus('⚠ 导入含浏览器禁发头（'+fb.map(h=>h.k).join(', ')+'）——DBX 直连无法发送这些头，浏览器会静默剥离，目标可能返回 403/登录失效','warn');
      }
    }catch(e){ setStatus('cURL 解析失败：'+e.message,'err'); }
  };
  acts.append(c,sp,ok); m.appendChild(acts);
  bg.innerHTML=''; bg.appendChild(m); bg.classList.add('open'); ta.focus(); bg.onclick=e=>{if(e.target===bg)close();};
  function close(){ bg.classList.remove('open'); bg.innerHTML=''; }
}

/* ===================== 保存 / 载入 / 分组 ===================== */
function markDirty(t){ if(!t.dirty){ t.dirty=true; renderTabs(); } }
function findSaved(id){ for(const g of state.collections){ const r=g.requests.find(x=>x.id===id); if(r) return {g,r}; } return null; }
function snapshot(t){ return { method:t.method,url:t.url,params:JSON.parse(JSON.stringify(t.params)),headers:JSON.parse(JSON.stringify(t.headers)),bodyType:t.bodyType,body:t.body,formBody:JSON.parse(JSON.stringify(t.formBody)) }; }
function saveCurrent(){
  const t=activeTab();
  if(t.savedId){ const f=findSaved(t.savedId); if(f){ Object.assign(f.r,snapshot(t)); f.r.name=t.name; t.dirty=false; persist(); renderTabs(); renderSidebar(); setStatus('已更新「'+t.name+'」','ok'); return; } }
  const groupOpts=state.collections.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('');
  openModal('保存请求','把当前请求存入一个分组',[
    {label:'名称',id:'mName',type:'text',value:(t.url? t.method+' '+shortUrl(t.url):'未命名请求')},
    {label:'分组',id:'mGroup',type:'select',html:groupOpts+'<option value="__new">＋ 新建分组…</option>'},
  ],vals=>{
    let gid=vals.mGroup;
    if(gid==='__new'||!state.collections.length){ const gn=prompt('新分组名称：','新分组'); if(!gn) return false; const g={id:uid(),name:gn,collapsed:false,requests:[]}; state.collections.push(g); gid=g.id; }
    const g=state.collections.find(x=>x.id===gid); const r=Object.assign({id:uid(),name:vals.mName||'未命名请求'},snapshot(t)); g.requests.push(r);
    t.savedId=r.id; t.name=r.name; t.dirty=false; persist(); renderTabs(); renderSidebar(); setStatus('已保存到「'+g.name+'」','ok');
  });
}
function openSaved(r){
  const exist=state.tabs.find(t=>t.savedId===r.id); if(exist){ state.activeTab=exist.id; renderAll(); return; }
  const t=newTab({ name:r.name,savedId:r.id,method:r.method,url:r.url, params:JSON.parse(JSON.stringify(r.params||[blankRow()])), headers:JSON.parse(JSON.stringify(r.headers||[blankRow()])), bodyType:r.bodyType||'none',body:r.body||'',formBody:JSON.parse(JSON.stringify(r.formBody||[blankRow()])) });
  if(!t.params.length)t.params=[blankRow()]; if(!t.headers.length)t.headers=[blankRow()]; if(!t.formBody.length)t.formBody=[blankRow()];
  state.tabs.unshift(t); state.activeTab=t.id; renderAll(); persist(); setStatus('已载入「'+r.name+'」');
}
function deleteSaved(g,r){ if(!confirm('删除已保存的请求「'+r.name+'」？'))return; g.requests=g.requests.filter(x=>x.id!==r.id); state.tabs.forEach(t=>{ if(t.savedId===r.id){t.savedId=null;t.dirty=true;} }); persist(); renderSidebar(); renderTabs(); }
function renameGroup(g){ const n=prompt('分组名称：',g.name); if(n==null)return; g.name=n.trim()||g.name; persist(); renderSidebar(); }
function deleteGroup(g){ if(!confirm('删除分组「'+g.name+'」及其中 '+g.requests.length+' 个请求？'))return; const ids=g.requests.map(r=>r.id); state.collections=state.collections.filter(x=>x.id!==g.id); state.tabs.forEach(t=>{ if(ids.includes(t.savedId)){t.savedId=null;t.dirty=true;} }); persist(); renderSidebar(); renderTabs(); }

/* ===================== tab 操作 ===================== */
function closeTab(t){
  if(t.dirty&&(t.url||t.savedId)){ if(!confirm('该 tab 有未保存修改，仍要关闭？'))return; }
  const i=state.tabs.indexOf(t); state.tabs.splice(i,1);
  if(!state.tabs.length){ const nt=newTab(); state.tabs.unshift(nt); state.activeTab=nt.id; }
  else if(state.activeTab===t.id) state.activeTab=state.tabs[Math.max(0,i-1)].id;
  renderAll(); persist();
}
/* ---- 右键菜单（tab 上右键调出） ---- */
function closeOthers(t){ state.tabs=state.tabs.filter(x=>x===t); state.activeTab=t.id; renderAll(); persist(); }
function closeRight(t){ const i=state.tabs.indexOf(t); state.tabs=state.tabs.slice(0,i+1); state.activeTab=t.id; renderAll(); persist(); }
function closeLeft(t){ const i=state.tabs.indexOf(t); state.tabs=state.tabs.slice(i); state.activeTab=t.id; renderAll(); persist(); }
let _ctxTab=null; // 右键菜单当前关联的 tab
let _ctxMenuClose=null; // 关闭函数
function showTabCtxMenu(e,t){
  e.preventDefault(); e.stopPropagation();
  _ctxTab=t;
  // 关闭旧菜单
  if(_ctxMenuClose) _ctxMenuClose();
  const menu=el('div','ctx-menu');
  menu.style.cssText='position:fixed;z-index:10001;background:var(--bg-2, #1e1f26);border:1px solid var(--line, #2a2b32);border-radius:8px;padding:4px 0;min-width:160px;box-shadow:0 8px 24px rgba(0,0,0,.4)';
  menu.style.left=Math.min(e.clientX,innerWidth-180)+'px';
  menu.style.top=Math.min(e.clientY,innerHeight-8)+'px';
  document.body.appendChild(menu);
  // 先挂载再读高度，确保 offsetHeight 正确
  menu.style.top=Math.min(e.clientY,innerHeight-menu.offsetHeight-8)+'px';
  const items=[
    {label:'✕ 关闭',action:()=>{closeTab(t);closeMenu();}},
    {label:'关闭其他',action:()=>{closeOthers(t);closeMenu();}},
    {label:'关闭右侧',action:()=>{closeRight(t);closeMenu();}},
    {label:'关闭左侧',action:()=>{closeLeft(t);closeMenu();}},
    {sep:true},
    {label:'✎ 重命名',action:()=>{const n=prompt('重命名 tab：',t.name);if(n!=null){t.name=n.trim()||t.name;renderTabs();persist();}closeMenu();}},
    {label:'📋 复制 URL',action:()=>{copy(t.url||'','URL 已复制');closeMenu();}},
    {label:'cURL 复制',action:()=>{copy(toCurl(t, resolveVars),'cURL 已复制');closeMenu();}},
  ];
  items.forEach(item=>{
    if(item.sep){ const hr=el('div'); hr.style.cssText='height:1px;background:var(--line,#2a2b32);margin:4px 0'; menu.appendChild(hr); return; }
    const b=el('button');
    b.textContent=item.label;
    b.style.cssText='display:block;width:100%;padding:6px 14px;text-align:left;font-size:12px;color:var(--ink,#d8dae2);background:none;border:none;cursor:pointer;white-space:nowrap';
    b.onmouseenter=()=>b.style.background='var(--surface,#262830)';
    b.onmouseleave=()=>b.style.background='none';
    b.onclick=item.action;
    menu.appendChild(b);
  });
  function closeMenu(){
    menu.remove(); _ctxMenuClose=null;
    document.removeEventListener('keydown',_onKey);
    document.removeEventListener('mousedown',_onDoc);
  }
  _ctxMenuClose=closeMenu;
  function _onKey(e2){ if(e2.key==='Escape') closeMenu(); }
  function _onDoc(e2){ if(!menu.contains(e2.target)) closeMenu(); }
  // 延迟绑定，避免当前右键事件立即触发关闭
  setTimeout(()=>{ document.addEventListener('keydown',_onKey); document.addEventListener('mousedown',_onDoc); }, 0);
}

/* ===================== 通用模态 ===================== */
function openModal(title,sub,fields,onOk){
  const bg=$('#modalBg'); const m=el('div','modal');
  m.innerHTML=`<h3>${esc(title)}</h3>${sub?`<div class="sub">${esc(sub)}</div>`:''}`;
  fields.forEach(f=>{ const fd=el('div','field'); fd.innerHTML=`<label>${esc(f.label)}</label>`+(f.type==='select'?`<select id="${f.id}">${f.html}</select>`:`<input id="${f.id}" type="text" value="${esc(f.value||'')}" />`); m.appendChild(fd); });
  const acts=el('div','acts'); const sp=el('div'); sp.style.flex='1';
  const cancel=el('button','btn ghost','取消'); cancel.onclick=close;
  const ok=el('button','btn primary','确定'); ok.onclick=()=>{ const vals={}; fields.forEach(f=>vals[f.id]=$('#'+f.id,m).value); if(onOk(vals)!==false) close(); };
  acts.append(sp,cancel,ok); m.appendChild(acts);
  bg.innerHTML=''; bg.appendChild(m); bg.classList.add('open');
  const first=m.querySelector('input,select'); if(first){first.focus(); if(first.select)first.select();}
  m.addEventListener('keydown',e=>{ if(e.key==='Enter'&&e.target.tagName!=='SELECT')ok.click(); if(e.key==='Escape')close(); });
  bg.onclick=e=>{ if(e.target===bg)close(); };
  function close(){ bg.classList.remove('open'); bg.innerHTML=''; }
}

/* ===================== 导入 / 导出集合（延迟到 initApi 绑定） ===================== */
function bindImportExport(){
  const eb=$('#exportBtn'); if(eb) eb.onclick=()=>{ const data=JSON.stringify({relay:2,exportedAt:new Date().toISOString(),collections:state.collections,envs:state.envs},null,2); const a=el('a'); a.href=URL.createObjectURL(new Blob([data],{type:'application/json'})); a.download='relay-export.json'; a.click(); setStatus('已导出集合与环境','ok'); };
  const ib=$('#importBtn'); if(ib) ib.onclick=()=>$('#fileInput').click();
  const fi=$('#fileInput'); if(fi) fi.onchange=e=>{ const f=e.target.files[0]; if(!f)return; const rd=new FileReader();
    rd.onload=()=>{ try{ const d=JSON.parse(rd.result); const cols=Array.isArray(d)?d:d.collections; if(!Array.isArray(cols)) throw new Error('格式不符'); cols.forEach(g=>{ g.id=uid(); (g.requests||[]).forEach(r=>r.id=uid()); }); state.collections=state.collections.concat(cols); if(d.envs&&Array.isArray(d.envs)){ d.envs.forEach(en=>{en.id=uid();}); state.envs=state.envs.concat(d.envs); renderEnv(); } persist(); renderSidebar(); setStatus('已导入 '+cols.length+' 个分组','ok'); }catch(err){ setStatus('导入失败：'+err.message,'err'); } $('#fileInput').value=''; };
    rd.readAsText(f);
  };
}

/* ===================== 响应工具按钮 ===================== */
function downloadResp(){ const t=activeTab(); const r=t.response; if(!r||r.error)return; const d=getDrilled(t); let name='response'; try{ const u=new URL(r.url); name=(u.pathname.split('/').pop()||'response'); }catch(e){} let blobUrl,revoke=false; if(r.isBinary&&r.blobUrl&&!t.respPath){ blobUrl=r.blobUrl; } else { const text=d.hasJSON?JSON.stringify(d.data,null,2):r.text; if(!/\./.test(name)) name+= d.hasJSON?'.json':/html/.test(r.contentType)?'.html':'.txt'; blobUrl=URL.createObjectURL(new Blob([text],{type:r.contentType||'text/plain'})); revoke=true; } const a=el('a'); a.href=blobUrl; a.download=name; a.click(); if(revoke)setTimeout(()=>URL.revokeObjectURL(blobUrl),1000); setStatus('已下载 '+name,'ok'); }

/* ===================== 事件绑定（延迟到 initApi 调用） ===================== */
function bindEvents(){
  const sb=$('#sendBtn'); if(sb) sb.onclick=send;
  const sv=$('#saveBtn'); if(sv) sv.onclick=saveCurrent;
  const cb=$('#curlBtn'); if(cb) cb.onclick=()=>copy(toCurl(activeTab(), resolveVars),'cURL 已复制');
  const ci=$('#curlImportBtn'); if(ci) ci.onclick=openCurlImport;
  const cr=$('#copyResBtn'); if(cr) cr.onclick=()=>{ const t=activeTab(); const d=getDrilled(t); if(!t.response||t.response.error)return; copy(d.hasJSON?JSON.stringify(d.data,null,2):(t.response.text||''),'已复制'); };
  const dl=$('#dlBtn'); if(dl) dl.onclick=downloadResp;
  const wr=$('#wrapBtn'); if(wr) wr.onclick=()=>{ const on=toggleRawWrap(); $('#wrapBtn').style.color=on?'var(--brand)':''; renderRespBody(); };
  const pt=$('#prettyBtn'); if(pt) pt.onclick=()=>{ const t=activeTab(); t.prettyCells=(t.prettyCells===false); persist(); renderRespBody(); };
  const te=$('#treeExpand'); if(te) te.onclick=()=>{ activeTab().treeOpen='all'; renderRespBody(); };
  const tc=$('#treeCollapse'); if(tc) tc.onclick=()=>{ activeTab().treeOpen='none'; renderRespBody(); };
  const url=$('#url');
  if(url){
    url.addEventListener('input',e=>{ const t=activeTab(); t.url=e.target.value; markDirty(t); updateResolvedPreview(); });
    url.addEventListener('change',e=>{ const t=activeTab(); t.url=e.target.value; syncUrlToParams(t); if(t.reqTab==='params')renderReqEditor(); persist(); });
    url.addEventListener('keydown',e=>{ if((e.metaKey||e.ctrlKey)&&e.key==='Enter') send(); });
  }
  $$('#reqSubtabs .subtab').forEach(b=>b.onclick=()=>{ activeTab().reqTab=b.dataset.rt; renderReqEditor(); persist(); });
  $$('#resSubtabs .subtab').forEach(b=>b.onclick=()=>{ if(b.classList.contains('disabled'))return; activeTab().respView=b.dataset.rv; renderRespBody(); persist(); });
  const srch=$('#search'); if(srch) srch.addEventListener('input',renderSidebar);
  const ng=$('#newGroup'); if(ng) ng.onclick=()=>{ const n=prompt('新分组名称：','新分组'); if(!n)return; state.collections.push({id:uid(),name:n.trim(),collapsed:false,requests:[]}); persist(); renderSidebar(); };
  const ts=$('#toggleSide'); if(ts) ts.onclick=()=>{ ui.sideCollapsed=!ui.sideCollapsed; $('#main').classList.toggle('collapsed',ui.sideCollapsed); persist(); };
  const tb=$('#tabbar'); if(tb) tb.addEventListener('scroll',updateTabFade);
  const lb=$('#layoutBtn'); if(lb) lb.onclick=()=>{ ui.layout = ui.layout==='h'?'v':'h'; applyLayout(); persist(); };
  // DBX 单视图，无 currentView 路由判断；快捷键直接生效
  document.addEventListener('keydown',e=>{ if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){ e.preventDefault(); send(); } if((e.metaKey||e.ctrlKey)&&(e.key==='s'||e.key==='S')){ e.preventDefault(); saveCurrent(); } });
}
/* DBX 无代理按钮（顶栏未渲染 proxyBtn）；applyProxyBtn 保留为空操作以兼容 initApi 调用 */
function applyProxyBtn(){ /* no-op: DBX 沙箱无本地中继代理 */ }

/* 分隔条拖拽（适配上下/左右，窄面板友好） */
function bindDividerDrag(){
  const div=$('#divider'), split=$('#split'); if(!div||!split)return;
  let dragging=false;
  div.addEventListener('mousedown',e=>{ dragging=true; document.body.style.cursor=ui.layout==='h'?'col-resize':'row-resize'; document.body.style.userSelect='none'; e.preventDefault(); });
  document.addEventListener('mousemove',e=>{ if(!dragging)return; const r=split.getBoundingClientRect();
    if(ui.layout==='h'){ const w=Math.max(160,Math.min(Math.max(60,r.width-180),e.clientX-r.left)); ui.reqW=w; split.style.setProperty('--reqW',w+'px'); }
    else{ const h=Math.max(80,Math.min(Math.max(80,r.height-120),e.clientY-r.top)); ui.reqH=h; split.style.setProperty('--reqH',h+'px'); } });
  document.addEventListener('mouseup',()=>{ if(dragging){ dragging=false; document.body.style.cursor=''; document.body.style.userSelect=''; persist(); } });
}
/* 表格单元格悬停浮层：显示完整内容（截断或较长时） */
function bindCellTooltip(){
  const tip=$('#cellTip'); if(!tip)return;
  let on=false;
  const wantShow=td=>{ const full=td.getAttribute('data-full'); if(full==null||full==='') return null; const truncated=td.scrollWidth>td.clientWidth+1; return (truncated||full.length>56)?full:null; };
  document.addEventListener('mouseover',e=>{ const x=e.target; if(!(x instanceof Element))return; const td=x.closest('td[data-full]'); if(!td){ if(on){tip.classList.remove('show');on=false;} return; } const full=wantShow(td); if(full==null){ if(on){tip.classList.remove('show');on=false;} return; } tip.textContent=full.length>2000?full.slice(0,2000)+'…':full; tip.classList.add('show'); on=true; });
  document.addEventListener('mousemove',e=>{ if(!on)return; const pad=14,w=tip.offsetWidth,h=tip.offsetHeight; let x=e.clientX+pad,y=e.clientY+pad; if(x+w>innerWidth-8)x=e.clientX-w-pad; if(y+h>innerHeight-8)y=e.clientY-h-pad; tip.style.left=Math.max(8,x)+'px'; tip.style.top=Math.max(8,y)+'px'; });
  document.addEventListener('mouseout',e=>{ const x=e.target; if(!(x instanceof Element))return; if(x.closest('td[data-full]')){ tip.classList.remove('show'); on=false; } });
}
function applyLayout(){ const split=$('#split'); if(!split)return; split.classList.toggle('h',ui.layout==='h'); const defH=240, defW=520; split.style.setProperty('--reqH',(ui.reqH||defH)+'px'); split.style.setProperty('--reqW',(ui.reqW||defW)+'px'); const lb=$('#layoutBtn'); if(lb) lb.innerHTML = ui.layout==='h'?'⇅ 上下':'⇄ 左右'; }

/* ===================== 总渲染 + 初始化 ===================== */
function renderAll(){ renderTabs(); renderRequestBar(); renderReqEditor(); renderResponse(); renderSidebar(); renderEnv(); }
async function initApi(){
  // 先绑定所有 DOM 事件（DOM 必须已就绪）
  bindMethodMenu();
  bindTopEvents();
  bindImportExport();
  bindEvents();
  bindDividerDrag();
  bindCellTooltip();
  // 配置 JSON 视图宿主钩子（持久化 + 重渲染反转注入）
  JV.configureViewHost({ persist, rerender: renderRespBody });
  // 等 DBX 桥就绪后加载状态并首渲染
  await DBX.ready;
  await load();
  const main=$('#main'); if(main) main.classList.toggle('collapsed',ui.sideCollapsed);
  applyLayout();
  applyProxyBtn();
  renderAll();
}

/* ===================== 启动 ===================== */
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded', initApi);
}else{
  initApi();
}
})();
