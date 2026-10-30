/* json-view.js — 共享 JSON 渲染核心：路径下钻、原始高亮、对象树、数据表格（多表格/列宽拖拽/智能单元格）。
 * 自原版 relay-devkit core/json-view.js 移植：去 ES module，改 IIFE 挂 window.POLARIS_JV。
 * 工具函数（$ el esc copy bytes fmtDate）从 window.POLARIS_CORE 注入。
 */
(function(){
const { $, el, esc, copy, bytes, fmtDate } = window.POLARIS_CORE;
// core/json-view.js — 共享 JSON 渲染核心：路径下钻、原始高亮、对象树、数据表格（多表格/列宽拖拽/智能单元格）。
// 被 API 工具与 JSON 工具共用。core 不依赖任何应用代码：表格的「持久化」与「重渲染」通过 configureViewHost 反转注入。


/* ===== view-host 钩子（控制反转，避免 core→app 反向依赖） ===== */
let _persist=()=>{}, _rerender=()=>{};
function configureViewHost(opts){ if(opts&&opts.persist)_persist=opts.persist; if(opts&&opts.rerender)_rerender=opts.rerender; }

/* ===== 单元格右键菜单 ===== */
let _cellCtx=null;
function closeCellCtx(){ if(_cellCtx){_cellCtx.remove();_cellCtx=null;} document.removeEventListener('click',closeCellCtx); document.removeEventListener('keydown',cellCtxEsc); }
function cellCtxEsc(e){ if(e.key==='Escape') closeCellCtx(); }

/* ===================== 路径下钻 ===================== */
function getByPath(data,path){
  if(!path||!path.trim()) return {ok:true,value:data};
  const parts=path.replace(/\[(\w+)\]/g,'.$1').split('.').map(s=>s.trim()).filter(s=>s!=='');
  let cur=data;
  for(const p of parts){
    if(cur==null) return {ok:false};
    if(Array.isArray(cur)){ const i=Number(p); if(!Number.isInteger(i)||i<0||i>=cur.length) return {ok:false}; cur=cur[i]; }
    else if(typeof cur==='object'){ if(!(p in cur)) return {ok:false}; cur=cur[p]; }
    else return {ok:false};
  }
  return {ok:true,value:cur};
}
/* 自动识别可下钻路径（对象键 / 数组，限深限量） */
function collectPaths(root){
  const out=[], seen=new Set();
  const push=(p,v)=>{ if(seen.has(p))return; seen.add(p); let kind='value',count; if(Array.isArray(v)){kind='array';count=v.length;} else if(v&&typeof v==='object'){kind='object';count=Object.keys(v).length;} out.push({path:p,kind,count}); };
  const walk=(v,path,depth)=>{ if(out.length>250)return;
    if(Array.isArray(v)){ if(v.length){ const ep=path?path+'[0]':'[0]'; push(ep,v[0]); if(v[0]&&typeof v[0]==='object'&&depth<4) walk(v[0],ep,depth+1); } }
    else if(v&&typeof v==='object'){ for(const k of Object.keys(v)){ const p=path?path+'.'+k:k; push(p,v[k]); if(v[k]&&typeof v[k]==='object'&&depth<4) walk(v[k],p,depth+1); } }
  };
  push('',root); walk(root,'',0); return out;
}

/* ===================== 原始 ===================== */
let wrapOn=false;
function toggleRawWrap(){ wrapOn=!wrapOn; return wrapOn; }
function viewRaw(r,data){
  let html;
  if(data!==undefined){ html=hlJSON(JSON.stringify(data,null,2)); }
  else if(r.isBinary){ html=esc(`[二进制内容 · ${r.contentType} · ${bytes(r.size)}]`); }
  else html=esc(r.text);
  return el('pre','raw'+(wrapOn?' wrap':''),html);
}
function hlJSON(s){
  return esc(s).replace(/(&quot;(?:\\.|[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|(-?\d+\.?\d*(?:[eE][+\-]?\d+)?)/g,
    (m,str,colon,bool,num)=>{ if(str!=null) return `<span class="${colon?'tok-key':'tok-str'}">${str}</span>${colon||''}`; if(bool!=null) return `<span class="tok-bool">${bool}</span>`; if(num!=null) return `<span class="tok-num">${num}</span>`; return `<span class="tok-null">null</span>`; });
}

/* ===================== 增强过滤语法 ===================== */
/**
 * parseFilter — 将过滤字符串解析为 AST 节点数组
 * 语法：纯文本（向后兼容）、field:value、field=value、field>num、field:/regex/、*:value、-排除
 * 返回 { ast: FilterNode[], plainText: string|null }
 * 当输入为纯文本（无字段操作符）时 plainText 非空，退化为原有 includes 行为
 */
function parseFilter(raw){
  if(!raw||!raw.trim()) return {ast:[],plainText:''};
  const ast=[];
  let plainText=null;
  // 按空格分割，但保留引号内的空格
  const tokens=[];
  let buf='',inQ=false,qCh='';
  for(let i=0;i<raw.length;i++){
    const ch=raw[i];
    if(inQ){ if(ch===qCh){ inQ=false; } else buf+=ch; }
    else if(ch==='"'||ch==="'"){ inQ=true; qCh=ch; }
    else if(ch===' '){ if(buf){tokens.push(buf);buf='';} }
    else buf+=ch;
  }
  if(buf) tokens.push(buf);
  const OPS_RE=/^(-?)([*\w.一-鿿-]+)(:|=|==|~|>=|>|<=|<)([\s\S]*)$/;
  for(const tok of tokens){
    const m=tok.match(OPS_RE);
    if(!m){
      // 纯文本
      if(tok.startsWith('-')&&tok.length>1){ ast.push({type:'text',value:tok.slice(1),negated:true}); }
      else { ast.push({type:'text',value:tok,negated:false}); plainText=plainText===null?tok:plainText+' '+tok; }
      continue;
    }
    const [_,neg,field,op,value]=m;
    const negated=neg==='-';
    // 正则 field:/pattern/ 或 ~pattern
    if(op===':'&&value.startsWith('/')&&value.endsWith('/')&&value.length>1){
      try{ const rx=new RegExp(value.slice(1,-1),'i'); ast.push({type:'field',field,op:'~',regex:rx,negated}); }catch(e){ ast.push({type:'text',value:tok,negated:false}); }
      continue;
    }
    if(op==='~'){
      try{ const src=value.startsWith('/')&&value.endsWith('/')?value.slice(1,-1):value; const rx=new RegExp(src,'i'); ast.push({type:'field',field,op:'~',regex:rx,negated}); }catch(e){ ast.push({type:'text',value:tok,negated:false}); }
      continue;
    }
    // 数值比较 > >= < <=
    if(op==='>'||op==='>='||op==='<'||op==='<='){
      const n=Number(value); if(!isNaN(n)){ ast.push({type:'field',field,op,numValue:n,negated}); continue; }
      // 非数字退化为文本
      ast.push({type:'text',value:tok,negated:false}); plainText=plainText===null?tok:plainText+' '+tok; continue;
    }
    // = 或 == 精确匹配
    if(op==='='||op==='=='){
      if(value==='true'){ ast.push({type:'field',field,op:'=',boolValue:true,negated}); }
      else if(value==='false'){ ast.push({type:'field',field,op:'=',boolValue:false,negated}); }
      else if(value==='null'){ ast.push({type:'field',field,op:'=',nullValue:true,negated}); }
      else { const n=Number(value); if(!isNaN(n)&&String(n)===value) ast.push({type:'field',field,op:'=',numValue:n,negated}); else ast.push({type:'field',field,op:'=',value,negated}); }
      continue;
    }
    // : 包含匹配（field:-value 为否定包含）
    if(op===':'){
      if(value.startsWith('-')&&value.length>1){ ast.push({type:'field',field,op:':',value:value.slice(1),negated:true}); }
      else if(field==='*'){ ast.push({type:'wildcard',op:':',value,negated}); }
      else { ast.push({type:'field',field,op:':',value,negated}); }
      continue;
    }
  }
  // 全部是纯文本节点 → plainText 保持
  const hasFieldOps=ast.some(n=>n.type==='field'||n.type==='wildcard');
  if(hasFieldOps) plainText=null;
  return {ast,plainText:plainText||null};
}

/** matchValue — 单个 AST 条件对一个值做匹配 */
function matchCond(val,node){
  if(node.type==='text'){
    const hit=String(val==null?'':typeof val==='object'?JSON.stringify(val):val).toLowerCase().includes(node.value.toLowerCase());
    return node.negated?!hit:hit;
  }
  if(node.type==='wildcard'){
    // 任意字段包含 value
    if(val&&typeof val==='object'){
      const en=Array.isArray(val)?Object.values(val):Object.values(val);
      const hit=en.some(v=>String(v==null?'':typeof v==='object'?JSON.stringify(v):v).toLowerCase().includes(node.value.toLowerCase()));
      return node.negated?!hit:hit;
    }
    const hit=String(val==null?'':val).toLowerCase().includes(node.value.toLowerCase());
    return node.negated?!hit:hit;
  }
  // node.type==='field'
  const {field,op,negated}=node;
  // 提取实际值：对对象取字段值，对原始值仅在 field 匹配 key 时使用
  // matchRow 调用前已提取字段值；matchTreeNode 调用时需处理
  let v=val;
  if(op===':'){
    const hit=String(v==null?'':typeof v==='object'?JSON.stringify(v):v).toLowerCase().includes(node.value.toLowerCase());
    return negated?!hit:hit;
  }
  if(op==='='){
    if(node.boolValue!==undefined){ const hit=(v===true||v===false)?v===node.boolValue:String(v).toLowerCase()===''+node.boolValue; return negated?!hit:hit; }
    if(node.nullValue){ const hit=v===null; return negated?!hit:hit; }
    if(node.numValue!==undefined){ const hit=(typeof v==='number')?v===node.numValue:Number(v)===node.numValue; return negated?!hit:hit; }
    const hit=String(v==null?'':v)===node.value; return negated?!hit:hit;
  }
  if(op==='~'){
    try{ const hit=node.regex.test(String(v==null?'':v)); return negated?!hit:hit; }catch(e){ return false; }
  }
  if(op==='>'||op==='>='||op==='<'||op==='<='){
    const nv=typeof v==='number'?v:Number(v);
    if(isNaN(nv)) return false;
    let hit;
    if(op==='>') hit=nv>node.numValue; else if(op==='>=') hit=nv>=node.numValue; else if(op==='<') hit=nv<node.numValue; else hit=nv<=node.numValue;
    return negated?!hit:hit;
  }
  return true;
}

/** matchRow — 表格行级别匹配（所有 AST 条件必须 AND 通过） */
function matchRow(obj,ast,fieldKey){
  if(!ast.length) return true;
  for(const node of ast){
    if(node.type==='text'||node.type==='wildcard'){
      if(!matchCond(obj,node)) return false;
      continue;
    }
    // field 节点：在对象中找到对应字段
    if(node.type==='field'){
      const fv=obj&&typeof obj==='object'&&!Array.isArray(obj)?obj[node.field]:undefined;
      if(fv===undefined){
        // 字段不存在 → 对整个对象做文本搜索 fallback
        if(!matchCond(obj,node)) return false;
      } else {
        if(!matchCond(fv,node)) return false;
      }
    }
  }
  return true;
}

/** matchTreeNode — 对象树节点匹配（key+val 整体） */
function matchTreeNode(key,val,ast){
  if(!ast.length) return true;
  for(const node of ast){
    if(node.type==='text'){
      // 纯文本：key 或 val（含子节点递归）
      if(matchTextRecursive(key,val,node.value,node.negated)) continue;
      return false;
    }
    if(node.type==='wildcard'){
      if(matchWildcardRecursive(key,val,node.value,node.negated)) continue;
      return false;
    }
    if(node.type==='field'){
      // 字段匹配：当前 key 匹配字段名时检查 val，否则递归子节点
      if(matchFieldRecursive(key,val,node)) continue;
      return false;
    }
  }
  return true;
}
function matchTextRecursive(key,val,q,negated){
  const ql=q.toLowerCase();
  let hit=false;
  if(key!=null&&String(key).toLowerCase().includes(ql)) hit=true;
  if(!hit){
    if(val&&typeof val==='object'){
      const en=Array.isArray(val)?val.map((v,i)=>[i,v]):Object.entries(val);
      hit=en.some(([k,v])=>matchTextRecursive(k,v,q,false));
    } else {
      hit=String(val==null?'':val).toLowerCase().includes(ql);
    }
  }
  return negated?!hit:hit;
}
function matchWildcardRecursive(key,val,q,negated){
  const ql=q.toLowerCase();
  let hit=false;
  if(val&&typeof val==='object'){
    const en=Array.isArray(val)?val.map((v,i)=>[i,v]):Object.entries(val);
    hit=en.some(([k,v])=>{
      // 检查 val 本身
      if(String(v==null?'':typeof v==='object'?JSON.stringify(v):v).toLowerCase().includes(ql)) return true;
      // 递归子节点
      if(v&&typeof v==='object') return matchWildcardRecursive(k,v,q,false);
      return false;
    });
  } else {
    hit=String(val==null?'':val).toLowerCase().includes(ql);
  }
  return negated?!hit:hit;
}
function matchFieldRecursive(key,val,node){
  const {field,op,negated}=node;
  // 如果当前 key 匹配字段名，检查值
  if(key!=null&&String(key).toLowerCase()===field.toLowerCase()){
    if(matchCond(val,node)) return true;
    // 即使匹配字段名，值不匹配也可能子节点匹配
  }
  // 递归子节点
  if(val&&typeof val==='object'){
    const en=Array.isArray(val)?val.map((v,i)=>[i,v]):Object.entries(val);
    return en.some(([k,v])=>matchFieldRecursive(k,v,node));
  }
  return false;
}

/** 收集 AST 中所有文本/值用于高亮 */
function astHighlightTerms(ast){
  const terms=[];
  for(const n of ast){
    if(n.type==='text') terms.push(n.value);
    else if(n.type==='wildcard') terms.push(n.value);
    else if(n.type==='field'&&n.op===':') terms.push(n.value);
    else if(n.type==='field'&&n.op==='='&&n.value) terms.push(n.value);
  }
  return terms;
}
/** 增强版 hlText — 支持多个高亮词 */
function hlTextMulti(s,terms){
  if(!terms.length) return esc(s);
  let html=esc(s);
  const lower=html.toLowerCase();
  // 按长度降序排列，避免短匹配覆盖长匹配
  const sorted=[...terms].sort((a,b)=>b.length-a.length);
  const marks=[];
  for(const t of sorted){
    const tl=t.toLowerCase();
    let pos=0;
    while(true){
      const idx=lower.indexOf(tl,pos);
      if(idx<0) break;
      marks.push({s:idx,e:idx+tl.length});
      pos=idx+tl.length;
    }
  }
  if(!marks.length) return html;
  // 合并重叠区间
  marks.sort((a,b)=>a.s-b.s);
  const merged=[marks[0]];
  for(let i=1;i<marks.length;i++){
    const last=merged[merged.length-1];
    if(marks[i].s<=last.e) last.e=Math.max(last.e,marks[i].e);
    else merged.push(marks[i]);
  }
  // 从后往前插入 <span class="hl">
  for(let i=merged.length-1;i>=0;i--){
    const {s,e}=merged[i];
    html=html.slice(0,s)+'<span class="hl">'+html.slice(s,e)+'</span>'+html.slice(e);
  }
  return html;
}

/* ===================== 列选择器（折叠 + 拖拽排序） ===================== */
function columnPicker(cols,hiddenSet,isOpen,onChange){
  const hidden=new Set(Object.keys(hiddenSet||{}));
  const vis=cols.filter(c=>!hidden.has(c)).length;
  const open=!!isOpen;
  const bar=el('div','col-picker'+(open?'':' collapsed'));
  const arrow=()=>open?'▾':'▸';
  // 折叠 toggle：列 · 5/8 ▸
  const toggle=el('button','col-toggle');
  toggle.type='button';
  toggle.textContent=`列 · ${vis}/${cols.length} ${arrow()}`;
  toggle.onclick=()=>{
    const now=!bar.classList.contains('collapsed');
    bar.classList.toggle('collapsed',now);
    toggle.textContent=`列 · ${vis}/${cols.length} ${now?'▸':'▾'}`;
    if(onChange._saveOpen) onChange._saveOpen(!now);
  };
  bar.appendChild(toggle);
  // chip 区域（折叠时隐藏）
  const body=el('div','col-body');
  const allBtn=el('button','col-q','全选'); allBtn.type='button';
  const noneBtn=el('button','col-q','全不选'); noneBtn.type='button';
  allBtn.onclick=()=>onChange({});
  noneBtn.onclick=()=>{ const h={}; cols.forEach(c=>h[c]=true); onChange(h); };
  body.append(allBtn,noneBtn);
  cols.forEach(c=>{
    const on=!hidden.has(c);
    const chip=el('button','col-chip'+(on?' on':'')); chip.type='button';
    chip.textContent=c; chip.draggable=true;
    // 显隐切换
    chip.onclick=()=>{
      const h={...(hiddenSet||{})};
      if(h[c]) delete h[c]; else h[c]=true;
      onChange(h);
    };
    // 拖拽排序
    chip.addEventListener('dragstart',e=>{
      e.dataTransfer.setData('text/plain',c);
      e.dataTransfer.effectAllowed='move';
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend',()=>chip.classList.remove('dragging'));
    chip.addEventListener('dragover',e=>{ e.preventDefault(); e.dataTransfer.dropEffect='move'; chip.classList.add('drag-over'); });
    chip.addEventListener('dragleave',()=>chip.classList.remove('drag-over'));
    chip.addEventListener('drop',e=>{
      e.preventDefault(); chip.classList.remove('drag-over');
      const from=e.dataTransfer.getData('text/plain');
      if(!from||from===c) return;
      const order=[...cols];
      order.splice(order.indexOf(from),1);
      order.splice(order.indexOf(c),0,from);
      onChange({...(hiddenSet||{})},order);
    });
    body.appendChild(chip);
  });
  bar.appendChild(body);
  return bar;
}

/* ===================== 对象树 ===================== */
function viewObject(data,t){
  const host=el('div','jtree');
  if(data===undefined){ host.innerHTML='<span class="dimnote">响应不是合法 JSON，无法以对象树展示。请切到「原始」。</span>'; return host; }
  const raw=(t.respFilter||'').trim();
  const {ast,plainText}=parseFilter(raw);
  const q=plainText!==null?plainText.toLowerCase():(raw?raw.toLowerCase():'');
  const hlTerms=astHighlightTerms(ast);
  const opt={ q, ast, hlTerms, pretty:t.prettyCells!==false, openAll:t.treeOpen||'auto' };
  const node=jsonNode(null,data,0,opt);
  if(node) host.appendChild(node); else host.innerHTML='<div class="dimnote">无匹配「'+esc(q)+'」的字段。</div>';
  return host;
}
function treeKeep(key,val,q){
  if(!q) return true;
  if(key!=null && String(key).toLowerCase().includes(q)) return true;
  if(val&&typeof val==='object'){ const en=Array.isArray(val)?val.map((v,i)=>[i,v]):Object.entries(val); return en.some(([k,v])=>treeKeep(k,v,q)); }
  return String(val).toLowerCase().includes(q);
}
function hlText(s,q){ s=esc(s); if(!q) return s; const i=s.toLowerCase().indexOf(q); if(i<0) return s; return s.slice(0,i)+'<span class="hl">'+s.slice(i,i+q.length)+'</span>'+s.slice(i+q.length); }
function valSpan(v,q,key,pretty,hlTerms){
  if(v===null) return `<span class="jt-null">null</span>`;
  const ty=typeof v;
  if(pretty&&ty==='string'&&isImgUrl(v)){ return `<img class="cell-img" src="${esc(v)}" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('🖼'))"><span class="cell-imn">${esc(fileName(v))}</span>`; }
  if(pretty){ const ts=tsInfo(key,v); if(ts) return `<span class="cell-ts">🕓 ${esc(fmtDate(ts.date))}</span> <span class="jt-prev">(${esc(plainVal(v))})</span>`; }
  if(ty==='string') return `<span class="jt-str">"${hlTerms&&hlTerms.length?hlTextMulti(v,hlTerms):hlText(v,q)}"</span>`;
  if(ty==='number') return `<span class="jt-num">${hlTerms&&hlTerms.length?hlTextMulti(String(v),hlTerms):hlText(String(v),q)}</span>`;
  if(ty==='boolean') return `<span class="jt-bool">${v}</span>`;
  return esc(String(v));
}
function jsonNode(key,val,depth,opt){
  const q=opt.q;
  const ast=opt.ast;
  if(ast&&ast.length){ if(!matchTreeNode(key,val,ast)) return null; }
  else if(q && !treeKeep(key,val,q)) return null;
  const node=el('div','jt-node'); const isObj=val&&typeof val==='object';
  const hlT=opt.hlTerms;
  const keyHTML = key!=null ? `<span class="jt-key">${hlT&&hlT.length?hlTextMulti(String(key),hlT):hlText(String(key),q)}</span><span class="jt-colon">: </span>` : '';
  if(!isObj){ const row=el('div','jt-row'); row.innerHTML=keyHTML+valSpan(val,q,key,opt.pretty,hlT)+`<span class="jt-act"><b data-act="copy">copy</b></span>`; row.querySelector('[data-act=copy]').onclick=()=>copy(typeof val==='string'?val:JSON.stringify(val),'已复制'); node.appendChild(row); return node; }
  const arr=Array.isArray(val); const entries=arr?val.map((v,i)=>[i,v]):Object.entries(val);
  const open = opt.openAll==='all'?true : opt.openAll==='none'?false : (q?true:depth<1);
  const prev = arr?`[…] ${entries.length} 项`:`{…} ${entries.length} 键`;
  const row=el('div','jt-row expandable');
  row.innerHTML=`<span class="jt-tog">${open?'▾':'▸'}</span>${keyHTML}<span class="jt-prev">${arr?'[':'{'}</span><span class="jt-prev" data-prev>${open?'':' '+prev+' '}</span><span class="jt-act"><b data-act="copy">copy</b></span>`;
  const children=el('div','jt-children'+(open?'':' hide'));
  entries.forEach(([k,v])=>{ const c=jsonNode(k,v,depth+1,opt); if(c) children.appendChild(c); });
  const tail=el('div','jt-row'); tail.innerHTML=`<span class="jt-prev" style="padding-left:0">${arr?']':'}'}</span>`; children.appendChild(tail);
  const tog=row.querySelector('.jt-tog'), prevEl=row.querySelector('[data-prev]');
  row.addEventListener('click',e=>{ if(e.target.dataset.act)return; const hid=children.classList.toggle('hide'); tog.textContent=hid?'▸':'▾'; prevEl.textContent=hid?' '+prev+' ':''; });
  row.querySelector('[data-act=copy]').onclick=e=>{ e.stopPropagation(); copy(JSON.stringify(val,null,2),'节点已复制'); };
  node.append(row,children); return node;
}

/* ===================== 值智能渲染：图片缩略图 / 时间戳转时间 ===================== */
const IMG_URL_RE=/^(?:https?:)?\/\/[^\s'"]+\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)(?:[?#][^\s'"]*)?$/i;
function isImgUrl(s){ if(typeof s!=='string')return false; s=s.trim(); return /^data:image\//i.test(s)||IMG_URL_RE.test(s); }
function keyIsTime(key){ if(key==null)return false; return /(_at\b|\bat$|date|time|timestamp|\bts\b|created|updated|modified|expire|publish|issued|deleted|lastseen|lastlogin|epoch)/i.test(String(key)); }
function tsInfo(key,v){
  if(typeof v==='string'){
    const s=v.trim();
    if(/^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+\-]\d{2}:?\d{2})?)?$/.test(s)){ const d=new Date(s); if(!isNaN(+d)) return {date:d}; }
    if(keyIsTime(key)&&/^\d{10}$|^\d{13}$/.test(s)){ const n=Number(s); const d=new Date(s.length===13?n:n*1000); if(!isNaN(+d)) return {date:d}; }
    return null;
  }
  if(typeof v==='number'&&keyIsTime(key)&&isFinite(v)){
    if(v>=1e12&&v<4e12) return {date:new Date(v)};
    if(v>=1e9&&v<4e9) return {date:new Date(v*1000)};
  }
  return null;
}
function fileName(u){ if(/^data:/i.test(u))return '内嵌图片'; try{ const x=new URL(u,location.href); return decodeURIComponent(x.pathname.split('/').pop()||u).slice(0,42);}catch(e){ return String(u).split(/[?#]/)[0].split('/').pop().slice(0,42);} }
function plainVal(v){ return v===null?'null':v===undefined?'':typeof v==='object'?JSON.stringify(v):String(v); }
/* 返回 {html, full}：full 为完整原始文本（用于 tooltip / 复制） */
function richValue(v,q,key,pretty,hlTerms){
  const full=plainVal(v);
  if(v===null) return {html:'<span class="cell-null">null</span>',full};
  if(v===undefined) return {html:'<span class="cell-null">—</span>',full:''};
  if(typeof v==='object'){ const s=JSON.stringify(v); return {html:`<span class="cobj">${esc(s)}</span>`,full:s}; }
  if(pretty&&typeof v==='string'&&isImgUrl(v)){ return {html:`<img class="cell-img" src="${esc(v)}" alt="" loading="lazy" onerror="this.style.display='none'"><span class="cell-imn">${esc(fileName(v))}</span>`,full:v}; }
  if(pretty){ const ts=tsInfo(key,v); if(ts) return {html:`<span class="cell-ts">🕓 ${esc(fmtDate(ts.date))}</span>`,full:full+'  ·  '+fmtDate(ts.date)}; }
  const hl=hlTerms&&hlTerms.length?hlTextMulti(String(v),hlTerms):hlText(String(v),q);
  if(typeof v==='number') return {html:`<span class="cell-num">${hl}</span>`,full};
  if(typeof v==='boolean') return {html:`<span class="cell-bool">${v}</span>`,full};
  return {html:`<span class="cell-str">${hl}</span>`,full};
}

/* ===================== 表格（含多表格选择 + 列宽拖拽 + 智能渲染） ===================== */
function tableCandidates(data){
  const out=[];
  if(Array.isArray(data)){ out.push({label:'根数组',path:'',data,count:data.length}); return out; }
  if(data&&typeof data==='object'){
    const scan=(obj,prefix,depth)=>{ for(const [k,v] of Object.entries(obj)){ const path=prefix?prefix+'.'+k:k; if(Array.isArray(v)) out.push({label:path,path,data:v,count:v.length}); else if(v&&typeof v==='object'&&depth<1) scan(v,path,depth+1); } };
    scan(data,'',0);
    out.push({label:'对象本身(键值)',path:'__self',data,count:Object.keys(data).length});
  }
  return out;
}
function rowMatches(obj,q){ if(!q)return true; return Object.values(obj).some(v=>String(typeof v==='object'?JSON.stringify(v):v).toLowerCase().includes(q)); }
/** 兼容增强过滤的行匹配 */
function rowMatchesAST(obj,ast,q){
  if(!ast.length&&!q) return true;
  if(ast.length) return matchRow(obj,ast);
  return rowMatches(obj,q);
}
function viewTable(data,t){
  const host=el('div','tbl-host');
  const cands=tableCandidates(data);
  let sel=cands.find(c=>c.path===t.tableSel)||cands[0];
  if(cands.length>1){
    const bar=el('div','tbl-cands'); bar.appendChild(el('span','lab','表格'));
    cands.forEach(c=>{ const chip=el('button','tcand'+(c===sel?' on':''),`${esc(c.label)} <em>${c.count}</em>`); chip.onclick=()=>{ t.tableSel=c.path; _persist(); (t.rerender||_rerender)(); }; bar.appendChild(chip); });
    host.appendChild(bar);
  }
  if(!sel){ host.appendChild(el('div','prev-none','无可表格化的数据。')); return host; }
  const raw=(t.respFilter||'').trim();
  const {ast,plainText}=parseFilter(raw);
  const q=plainText!==null?plainText.toLowerCase():raw.toLowerCase();
  const hlTerms=astHighlightTerms(ast);
  const pretty=t.prettyCells!==false;
  const pathKey=sel.path||'__root';
  const wrap=el('div','tbl-wrap'); const d=sel.data;
  const tbl=el('table','dt'); const thead=el('thead'), tbody=el('tbody');
  const cell=(v,key)=>{ const rv=richValue(v,q,key,pretty,hlTerms); return `<td data-full="${esc(rv.full)}">${rv.html}</td>`; };
  // 排序配置
  const sortCfg=(t.sort&&t.sort[pathKey])||null;
  let note='';
  if(Array.isArray(d) && sel.path!=='__self'){
    const objs=d.length&&d.every(x=>x&&typeof x==='object'&&!Array.isArray(x));
    if(objs){
      let cols=[]; d.forEach(o=>Object.keys(o).forEach(k=>{if(!cols.includes(k))cols.push(k);}));
      // 应用自定义列序
      const savedOrder=(t.colOrder&&t.colOrder[pathKey])||[];
      if(savedOrder.length){
        const ordered=savedOrder.filter(c=>cols.includes(c));
        const rest=cols.filter(c=>!savedOrder.includes(c));
        cols=ordered.concat(rest);
      }
      // 列选择器（列 ≥ 4 时显示）
      const hiddenSet=(t.hiddenCols&&t.hiddenCols[pathKey])||{};
      const visibleCols=cols.filter(c=>!hiddenSet[c]);
      if(cols.length>=4){
        const pickerOpen=!!(t._pickerOpen&&t._pickerOpen[pathKey]);
        const cb=(h,order)=>{
          if(!t.hiddenCols) t.hiddenCols={};
          t.hiddenCols[pathKey]=h;
          if(order){ if(!t.colOrder) t.colOrder={}; t.colOrder[pathKey]=order; }
          _persist();
          (t.rerender||_rerender)();
        };
        cb._saveOpen=v=>{ if(!t._pickerOpen) t._pickerOpen={}; t._pickerOpen[pathKey]=v; };
        host.appendChild(columnPicker(cols,hiddenSet,pickerOpen,cb));
      }
      // 排序：先过滤再排序
      const filtered=[];
      d.forEach((o,i)=>{ if(rowMatchesAST(o,ast,q)) filtered.push({o,i}); });
      let sorted=filtered;
      if(sortCfg&&sortCfg.col){
        const {col,dir}=sortCfg;
        sorted=[...filtered].sort((a,b)=>{
          const va=a.o[col],vb=b.o[col];
          if(va==null&&vb==null) return 0;
          if(va==null) return 1;
          if(vb==null) return -1;
          if(typeof va==='number'&&typeof vb==='number') return dir==='asc'?va-vb:vb-va;
          const cmp=String(va).localeCompare(String(vb));
          return dir==='asc'?cmp:-cmp;
        });
      }
      // 表头（支持排序点击）
      thead.innerHTML='<tr><th class="idx">#</th>'+visibleCols.map(c=>{
        let cls=''; let arrow='';
        if(sortCfg&&sortCfg.col===c){ cls=sortCfg.dir==='asc'?' sort-asc':' sort-desc'; arrow=sortCfg.dir==='asc'?' ▲':' ▼'; }
        return `<th class="sortable${cls}" data-col="${esc(c)}">${esc(c)}${arrow}</th>`;
      }).join('')+'</tr>';
      // 表头排序点击
      thead.addEventListener('click',e=>{
        const th=e.target.closest('th[data-col]');
        if(!th) return;
        const col=th.dataset.col;
        if(!t.sort) t.sort={};
        const cur=t.sort[pathKey];
        let newDir='asc';
        if(cur&&cur.col===col){ newDir=cur.dir==='asc'?'desc':cur.dir==='desc'?null:'asc'; }
        if(newDir) t.sort[pathKey]={col,dir:newDir};
        else delete t.sort[pathKey];
        _persist();
        (t.rerender||_rerender)();
      });
      // 渲染行
      sorted.forEach(({o,i})=>{
        const tr=el('tr');
        tr.innerHTML=`<td class="idx">${i}</td>`+visibleCols.map(c=>cell(o[c],c)).join('');
        tbody.appendChild(tr);
      });
      const totalCols=visibleCols.length;
      note=`数组 · ${sorted.length}/${d.length} 行 × ${totalCols} 列`;
      if(q||raw) note+=` · 过滤「${esc(raw)}」`;
      if(sortCfg&&sortCfg.col) note+=` · 按 ${sortCfg.col} ${sortCfg.dir==='asc'?'升序':'降序'}`;
      if(visibleCols.length<cols.length) note+=` · 隐藏 ${cols.length-visibleCols.length} 列`;
    }else{
      thead.innerHTML='<tr><th class="idx">#</th><th>value</th></tr>';
      let shown=0; d.forEach((v,i)=>{
        const sv=String(typeof v==='object'?JSON.stringify(v):v).toLowerCase();
        let keep=true;
        if(ast.length){ keep=matchCond(v,ast[0])&&ast.slice(1).every(n=>matchCond(v,n)); }
        else if(q&&!sv.includes(q)) keep=false;
        if(!keep) return;
        shown++; const tr=el('tr'); tr.innerHTML=`<td class="idx">${i}</td>`+cell(v,null); tbody.appendChild(tr);
      });
      note=`数组 · ${shown}/${d.length} 项（基础/混合类型）`;
    }
  }else{
    thead.innerHTML='<tr><th>key</th><th>value</th></tr>';
    let shown=0,tot=0; Object.entries(d).forEach(([k,v])=>{
      tot++;
      let keep=true;
      if(ast.length){
        // 对键值对做 AST 匹配
        for(const node of ast){
          if(node.type==='field'){
            // 字段名匹配 key
            if(String(k).toLowerCase()===(node.field||'').toLowerCase()){
              if(!matchCond(v,node)){keep=false;break;}
            } else {
              // 值或 key 文本匹配
              if(!matchCond(v,node)&&!matchTextRecursive(k,v,node.type==='text'?node.value:node.value||'',node.negated)){keep=false;break;}
            }
          } else {
            if(!matchTextRecursive(k,v,node.type==='text'?node.value:(node.value||''),node.negated)){keep=false;break;}
          }
        }
      } else if(q && !(k.toLowerCase().includes(q)||String(typeof v==='object'?JSON.stringify(v):v).toLowerCase().includes(q))) keep=false;
      if(!keep) return;
      shown++; const tr=el('tr');
      tr.innerHTML=`<td style="color:var(--j-key)">${hlTerms&&hlTerms.length?hlTextMulti(k,hlTerms):hlText(k,q)}</td>`+cell(v,k);
      tbody.appendChild(tr);
    });
    note=`对象 · ${shown}/${tot} 个字段`;
  }
  tbl.append(thead,tbody);
  addColResize(tbl,t,pathKey);
  // 单元格右键复制
  tbl.addEventListener('contextmenu',e=>{
    const td=e.target.closest('td');
    if(!td||td.classList.contains('idx'))return;
    e.preventDefault(); closeCellCtx();
    // 隐藏悬停浮窗（z-index:200 会遮挡右键菜单 z-index:90）
    const tip=$('#cellTip'); if(tip)tip.classList.remove('show');
    const menu=el('div','db-ctx'); _cellCtx=menu;
    function item(label,action){ const b=el('button','db-ctx-item',label); b.onclick=ev=>{ev.stopPropagation();closeCellCtx();action();}; menu.appendChild(b); }
    function sep(){ menu.appendChild(el('div','db-ctx-sep')); }
    const val=td.dataset.full!=null?td.dataset.full:td.textContent;
    item('复制值',()=>copy(val,'已复制'));
    const ci=td.cellIndex,hr=thead.rows[0],thCell=hr&&hr.cells[ci];
    if(thCell&&thCell.dataset.col){ sep(); item('复制列名',()=>copy(thCell.dataset.col,'已复制列名')); }
    document.body.appendChild(menu);
    requestAnimationFrame(()=>{document.addEventListener('click',closeCellCtx);document.addEventListener('keydown',cellCtxEsc);});
    const mw=menu.offsetWidth,mh=menu.offsetHeight,vw=innerWidth,vh=innerHeight,pad=6;
    menu.style.left=(e.clientX+mw+pad>vw?Math.max(pad,e.clientX-mw-pad):e.clientX+pad)+'px';
    menu.style.top=(e.clientY+mh+pad>vh?Math.max(pad,e.clientY-mh-pad):e.clientY+pad)+'px';
  });
  if(note) host.appendChild(el('div','tbl-note',note));
  wrap.appendChild(tbl); host.appendChild(wrap); return host;
}
function addColResize(tbl,t,pathKey){
  if(!t.colW) t.colW={};
  const head=tbl.tHead; if(!head||!head.rows.length)return;
  const ths=[...head.rows[0].cells];
  const colg=el('colgroup'); ths.forEach(()=>colg.appendChild(el('col'))); tbl.insertBefore(colg,head);
  const cols=[...colg.children];
  const stored=t.colW[pathKey];
  if(stored){ tbl.style.tableLayout='fixed'; ths.forEach((th,i)=>{ if(stored[i]!=null) cols[i].style.width=stored[i]+'px'; }); }
  ths.forEach((th,i)=>{
    const grip=el('span','col-grip'); grip.title='拖动调整列宽'; th.appendChild(grip);
    grip.addEventListener('mousedown',ev=>{
      ev.preventDefault(); ev.stopPropagation();
      if(tbl.style.tableLayout!=='fixed'){ ths.forEach((h,j)=>cols[j].style.width=h.getBoundingClientRect().width+'px'); tbl.style.tableLayout='fixed'; }
      const startX=ev.clientX, startW=th.getBoundingClientRect().width;
      const move=mv=>{ cols[i].style.width=Math.max(46,Math.min(1600,startW+(mv.clientX-startX)))+'px'; };
      const up=()=>{ document.removeEventListener('mousemove',move); document.removeEventListener('mouseup',up); document.body.style.cursor=''; document.body.style.userSelect=''; const map=t.colW[pathKey]||(t.colW[pathKey]={}); ths.forEach((h,j)=>map[j]=Math.round(h.getBoundingClientRect().width)); _persist(); };
      document.body.style.cursor='col-resize'; document.body.style.userSelect='none';
      document.addEventListener('mousemove',move); document.addEventListener('mouseup',up);
    });
  });
}

/* ===================== 增强过滤栏（token 显示） ===================== */
/**
 * filterBar — 增强过滤输入组件
 * 保留原有 input 的所有行为，在其上方叠加 token chip 显示
 * @param {object} stateObj - 状态对象（含 respFilter 字段）
 * @param {function} onChange - 过滤变化回调（由调用方持久化+重渲染）
 * @param {string[]} [availableFields] - 可选，当前数据的字段名列表（用于提示）
 */
function filterBar(stateObj,onChange,availableFields){
  const wrap=el('div','ti filter');
  wrap.innerHTML='<span class="lbl">过滤</span>';
  const bar=el('div','fb-bar');
  // 实际编辑用的 input
  const inp=el('input','fb-edit');
  inp.type='text';
  inp.placeholder='筛选行/字段… 支持 name:值 id>1 role:true';
  inp.value=stateObj.respFilter||'';
  inp.spellcheck=false;
  // token 容器
  const tokens=el('div','fb-tokens');
  // 字段提示下拉
  const acWrap=el('div','fb-ac');
  let acOpen=false;
  function hideAC(){ acOpen=false; acWrap.classList.remove('open'); acWrap.innerHTML=''; }
  function showAC(list){
    if(!list.length){ hideAC(); return; }
    acWrap.innerHTML='';
    list.slice(0,12).forEach(f=>{
      const item=el('button','fb-ac-item'); item.type='button'; item.textContent=f;
      item.onclick=()=>{ inp.value+=f; inp.focus(); hideAC(); onChange(); };
      acWrap.appendChild(item);
    });
    acWrap.classList.add('open'); acOpen=true;
  }
  // 解析并渲染 tokens
  function renderTokens(){
    tokens.innerHTML='';
    const raw=(inp.value||'').trim();
    if(!raw){ tokens.style.display='none'; return; }
    tokens.style.display='flex';
    const {ast}=parseFilter(raw);
    for(const node of ast){
      const chip=el('span','ftk');
      if(node.type==='text'){
        if(node.negated) chip.innerHTML='<span class="ftk-neg">-</span><span class="ftk-val">'+esc(node.value)+'</span>';
        else chip.innerHTML='<span class="ftk-val">'+esc(node.value)+'</span>';
      } else if(node.type==='wildcard'){
        chip.innerHTML='<span class="ftk-field">*</span><span class="ftk-op">:</span><span class="ftk-val">'+esc(node.value)+'</span>';
      } else if(node.type==='field'){
        let valClass='ftk-val';
        let valText=esc(node.value||'');
        if(node.numValue!==undefined){ valClass='ftk-num'; valText=esc(String(node.numValue)); }
        else if(node.boolValue!==undefined){ valClass='ftk-bool'; valText=esc(String(node.boolValue)); }
        else if(node.nullValue){ valClass='ftk-null'; valText='null'; }
        else if(node.regex){ valClass='ftk-val'; valText='/'+esc(node.regex.source)+'/'; }
        const neg=node.negated?'<span class="ftk-neg">-</span>':'';
        chip.innerHTML=neg+'<span class="ftk-field">'+esc(node.field)+'</span><span class="ftk-op">'+esc(node.op)+'</span><span class="'+valClass+'">'+valText+'</span>';
      }
      tokens.appendChild(chip);
    }
  }
  // 输入事件
  inp.addEventListener('input',()=>{
    stateObj.respFilter=inp.value;
    renderTokens();
    // 字段提示：当输入以字母结尾且刚输入了 : 或 = 等
    const val=inp.value;
    const cursorPos=inp.selectionStart;
    if(availableFields&&availableFields.length){
      // 取光标前的当前 token
      const before=val.slice(0,cursorPos);
      const lastSpace=before.lastIndexOf(' ');
      const curToken=before.slice(lastSpace+1);
      const m=curToken.match(/^(-?)([\w.一-鿿-]*)$/);
      if(m&&m[2].length>0){
        const prefix=m[2].toLowerCase();
        const matches=availableFields.filter(f=>f.toLowerCase().startsWith(prefix)&&f.toLowerCase()!==prefix);
        if(matches.length) showAC(matches); else hideAC();
      } else hideAC();
    }
    onChange();
  });
  inp.addEventListener('keydown',e=>{
    if(e.key==='Escape') hideAC();
    if(e.key==='Enter'){ e.preventDefault(); hideAC(); onChange(); }
  });
  // 点击 bar 聚焦 input
  bar.addEventListener('click',e=>{ if(e.target===bar||e.target===tokens) inp.focus(); });
  // 点击其他区域关闭提示
  document.addEventListener('click',e=>{ if(!bar.contains(e.target)) hideAC(); });
  renderTokens();
  bar.append(tokens,inp,acWrap);
  wrap.appendChild(bar);
  return wrap;
}

window.POLARIS_JV = { configureViewHost, getByPath, collectPaths, toggleRawWrap, viewRaw, parseFilter, viewObject, viewTable, filterBar };
})();