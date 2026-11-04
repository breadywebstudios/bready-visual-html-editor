// Bready Visual HTML Editor — webview side.
// The page is parsed with a position-tracking parser so every element knows
// exactly where it lives in the source. Edits are sent to VS Code as small
// range replacements; everything outside the range stays byte-for-byte as is.
(function(){
'use strict';
const vscode = acquireVsCodeApi();
const NONCE = document.getElementById('app').dataset.nonce;
const $ = s => document.querySelector(s);

document.getElementById('app').innerHTML = `
<div class="app">
  <header class="top">
    <span class="path" id="path"></span>
    <div class="grp" id="devices">
      <button class="tbtn on" data-dev="desktop">Desktop</button>
      <button class="tbtn" data-dev="tablet">Tablet</button>
      <button class="tbtn" data-dev="mobile">Mobile</button>
    </div>
    <div class="grp">
      <button class="tbtn" id="undo" title="Undo (Ctrl+Z)">↶</button>
      <button class="tbtn" id="redo" title="Redo (Ctrl+Shift+Z)">↷</button>
    </div>
    <button class="tbtn" id="srcBtn" title="Open the source code beside this editor">&lt;/&gt; Source</button>
    <label class="tog" title="Run the page's own scripts in the preview"><input type="checkbox" id="scriptsTog">Scripts</label>
    <label class="tog" title="Save the file after every visual edit"><input type="checkbox" id="autoTog">Auto-save</label>
    <button class="btn primary" id="saveBtn" title="Save (Ctrl+S)">Save</button>
  </header>
  <div class="main">
    <div class="stageWrap">
      <div class="stage" id="stage">
        <iframe id="f0" title="Page preview"></iframe>
        <iframe id="f1" title="Page preview"></iframe>
        <div class="overlay">
          <div class="box hover" id="hoverBox"></div>
          <div class="box sel" id="selBox"></div>
          <div class="tag" id="selTag"></div>
          <div class="textbar" id="textbar">
            <button data-cmd="bold" title="Bold"><b>B</b></button>
            <button data-cmd="italic" title="Italic"><i>I</i></button>
            <button data-cmd="underline" title="Underline"><u>U</u></button>
            <button data-cmd="link" title="Make link">Link</button>
            <input id="linkInp" placeholder="https://… then Enter" hidden>
            <button data-cmd="unlink" title="Remove link">Unlink</button>
            <button data-cmd="removeFormat" title="Clear formatting">Clear</button>
            <button data-cmd="done" class="done" title="Finish (Ctrl+Enter)">Done</button>
          </div>
        </div>
      </div>
    </div>
    <aside class="insp" id="inspector"></aside>
  </div>
</div>
<div class="toast" id="toast"></div>`;

const VOID = new Set('area base br col embed hr img input link meta source track wbr param keygen command'.split(' '));
const RAW = new Set(['script','style','textarea','title','noscript','xmp','iframe','noembed','noframes']);
const P_CLOSERS = new Set('address article aside blockquote details dialog div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul'.split(' '));
const SKIP_DIRS = new Set(['node_modules','.git','.next','.vercel','.svelte-kit','.cache','vendor']);
const MIME = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',svg:'image/svg+xml',ico:'image/x-icon',bmp:'image/bmp',css:'text/css',js:'text/javascript',mjs:'text/javascript',json:'application/json',mp4:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf'};


/* ---------------- state ---------------- */
let hasRoot = false;
let file = null;            // {segs, name}
let src = '';
let nodes = [], byStart = new Map();
let selStart = null, selEl = null, doc = null;
let autosave = true, runScripts = false;
let editingEl = null, editingNode = null, editBefore = '';
let renderTok = 0, active = 0, pending = 0, queuedUpdate = null;
const frames = [$('#f0'), $('#f1')];
const blobCache = new Map();

/* ---------------- talking to VS Code ---------------- */
let reqId = 0; const waiting = new Map();
function request(kind, data){
  return new Promise((res, rej) => { const id = ++reqId; waiting.set(id, {res, rej}); vscode.postMessage({type: 'request', id, kind, ...data}); });
}
window.addEventListener('message', e => {
  if (frames.some(f => f.contentWindow === e.source)) return; // ignore the previewed page
  const m = e.data || {};
  switch (m.type){
    case 'init':
      hasRoot = m.hasRoot; autosave = m.autoSave; runScripts = m.runScripts;
      $('#autoTog').checked = autosave; $('#scriptsTog').checked = runScripts;
      file = {segs: m.segs, name: m.segs[m.segs.length - 1]};
      $('#path').innerHTML = escHtml(m.segs.slice(0, -1).join(' / ') + (m.segs.length > 1 ? ' / ' : '')) + '<b>' + escHtml(file.name) + '</b>';
      src = m.text; reparse(); render({fresh: true}); renderInspector();
      break;
    case 'update':
      if (pending > 0){ queuedUpdate = m.text; break; }
      externalText(m.text);
      break;
    case 'editDone':
      pending = Math.max(0, pending - 1);
      if (!m.ok){ externalText(m.text); toast('The file changed elsewhere — reloaded it.'); }
      else if (!pending && queuedUpdate != null){ const t = queuedUpdate; queuedUpdate = null; externalText(t); }
      break;
    case 'config':
      if (runScripts !== m.runScripts){ runScripts = m.runScripts; render(); }
      autosave = m.autoSave; $('#autoTog').checked = autosave; $('#scriptsTog').checked = runScripts;
      break;
    case 'assetsChanged': blobCache.clear(); render(); break;
    case 'reply': { const w = waiting.get(m.id); if (w){ waiting.delete(m.id); m.ok ? w.res(m.value) : w.rej(new Error(m.error)); } break; }
  }
});
function externalText(text){
  if (text == null || text === src) return;
  editingEl = null; hideTextbar();
  src = text; reparse();
  if (selStart != null && !byStart.has(selStart)) selStart = null;
  render();
}

/* ================= SOURCE PATCHING ================= */
function replaceRange(s, e, text, opts = {}){
  if (src.slice(s, e) === text && opts.select === undefined) return false;
  const old = src.slice(s, e), baseLen = src.length;
  const delta = text.length - (e - s);
  if (selStart != null && selStart >= e && e > s) selStart += delta;
  else if (selStart != null && s === e && selStart >= s) selStart += delta;
  src = src.slice(0, s) + text + src.slice(e);
  if (opts.select !== undefined) selStart = opts.select;
  if (text !== old){ pending++; vscode.postMessage({type: 'edit', start: s, end: e, text, old, baseLen}); }
  reparse(); render();
  return true;
}

/* ================= PARSER ================= */
function closesOnOpen(open, t){
  switch(open){
    case 'p': return P_CLOSERS.has(t);
    case 'li': return t === 'li';
    case 'dt': case 'dd': return t === 'dt' || t === 'dd';
    case 'option': return t === 'option' || t === 'optgroup';
    case 'tr': return t === 'tr' || t === 'tbody' || t === 'tfoot' || t === 'thead';
    case 'td': case 'th': return ['td','th','tr','tbody','tfoot','thead'].includes(t);
    case 'thead': case 'tbody': return t === 'tbody' || t === 'tfoot';
  }
  return false;
}
const WS = c => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

function parse(text){
  const n = text.length, list = [];
  const top = {tag:'#root', children:[], start:0, openEnd:0, closeStart:n, end:n, parent:null, attrs:[]};
  const stack = [top];
  const reClose = /<\/([a-zA-Z][^\s\/>]*)[^>]*>/y, reOpen = /<([a-zA-Z][^\s\/>]*)/y;
  const inForeign = () => stack.some(s => s.tag === 'svg' || s.tag === 'math');
  let i = 0;
  while (i < n){
    const lt = text.indexOf('<', i); if (lt < 0) break;
    if (text.startsWith('<!--', lt)){ const e = text.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    const c = text[lt + 1];
    if (c === '!' || c === '?'){ const e = text.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    if (c === '/'){
      reClose.lastIndex = lt; const m = reClose.exec(text);
      if (!m){ i = lt + 1; continue; }
      const tag = m[1].toLowerCase(), endPos = lt + m[0].length;
      let k = stack.length - 1; while (k > 0 && stack[k].tag !== tag) k--;
      if (k > 0){
        while (stack.length - 1 > k){ const t = stack.pop(); t.closeStart = t.end = lt; }
        const t = stack.pop(); t.closeStart = lt; t.end = endPos;
      }
      i = endPos; continue;
    }
    reOpen.lastIndex = lt; const m = reOpen.exec(text);
    if (!m){ i = lt + 1; continue; }
    const tag = m[1].toLowerCase();
    let p = lt + m[0].length, selfClose = false; const attrs = [];
    while (p < n){
      while (p < n && WS(text[p])) p++;
      if (p >= n) break;
      const ch = text[p];
      if (ch === '>'){ p++; break; }
      if (ch === '/'){ if (text[p+1] === '>'){ selfClose = true; p += 2; break; } p++; continue; }
      const ns = p; while (p < n && !WS(text[p]) && text[p] !== '/' && text[p] !== '>' && text[p] !== '=') p++;
      if (p === ns){ p++; continue; }
      const name = text.slice(ns, p); let vs = null, ve = null, quote = '';
      let q = p; while (q < n && WS(text[q])) q++;
      if (text[q] === '='){
        q++; while (q < n && WS(text[q])) q++;
        const qc = text[q];
        if (qc === '"' || qc === "'"){ quote = qc; vs = q + 1; const e = text.indexOf(qc, vs); ve = e < 0 ? n : e; p = e < 0 ? n : e + 1; }
        else { vs = q; while (q < n && !WS(text[q]) && text[q] !== '>') q++; ve = q; p = q; }
      }
      attrs.push({name, lname:name.toLowerCase(), fullStart:ns, fullEnd:p, valueStart:vs, valueEnd:ve, quote, value: vs == null ? '' : text.slice(vs, ve)});
    }
    const foreign = inForeign() || tag === 'svg' || tag === 'math';
    while (stack.length > 1 && closesOnOpen(stack[stack.length-1].tag, tag)){ const t = stack.pop(); t.closeStart = t.end = lt; }
    const parent = stack[stack.length-1];
    const node = {tag, start:lt, openEnd:p, attrs, children:[], parent, id:list.length,
      isVoid: VOID.has(tag) && !foreign, raw: RAW.has(tag) && !foreign, foreign};
    parent.children.push(node); list.push(node);
    if (node.isVoid || (selfClose && foreign)){ node.closeStart = node.end = p; i = p; continue; }
    if (node.raw){
      const re = new RegExp('</' + tag + '(?=[\\s/>])', 'ig'); re.lastIndex = p;
      const mm = re.exec(text);
      if (mm){ const gt = text.indexOf('>', mm.index); node.closeStart = mm.index; node.end = gt < 0 ? n : gt + 1; }
      else { node.closeStart = node.end = n; }
      i = node.end; continue;
    }
    stack.push(node); i = p;
  }
  while (stack.length > 1){ const t = stack.pop(); t.closeStart = t.end = n; }
  return list;
}
function reparse(){ nodes = parse(src); byStart = new Map(nodes.map(nd => [nd.start, nd])); }
const getAttr = (nd, name) => nd.attrs.find(a => a.lname === name);
const attrVal = (nd, name) => { const a = getAttr(nd, name); return a ? a.value : null; };
function attrInsertPos(nd){
  let p = nd.openEnd - 1;
  if (src[p] !== '>') p = nd.openEnd;
  if (src[p-1] === '/') p--;
  while (p > nd.start && WS(src[p-1])) p--;
  return p;
}
const isTextEditable = nd => nd && !nd.isVoid && !nd.raw && !nd.foreign && !['html','head','body','select','table','tbody','thead','tr','ul','ol','dl'].includes(nd.tag);


function escText(t){ return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/ /g,'&nbsp;'); }
function escAttr(t){ return t.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g,'&amp;').replace(/"/g,'&quot;'); }
function decodeEnt(t){ return t.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#0*39;|&#x0*27;|&apos;/gi,"'"); }
const escHtml = t => String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function setAttr(nd, name, value){
  const a = getAttr(nd, name.toLowerCase());
  if (value == null){
    if (!a) return;
    let s = a.fullStart; while (s > nd.start && WS(src[s-1])) s--;
    replaceRange(s, a.fullEnd, ''); return;
  }
  value = String(value);
  if (a){
    if (a.valueStart != null && a.quote === '"') replaceRange(a.valueStart, a.valueEnd, escAttr(value));
    else if (a.valueStart != null && a.quote === "'") replaceRange(a.valueStart, a.valueEnd, value.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g,'&amp;').replace(/'/g,'&#39;'));
    else replaceRange(a.fullStart, a.fullEnd, `${a.name}="${escAttr(value)}"`);
  } else {
    const p = attrInsertPos(nd);
    replaceRange(p, p, ` ${name}="${escAttr(value)}"`);
  }
}
function parseStyle(s){
  const out = [];
  // split on ; that are not inside parentheses (url(data:...;base64) etc.)
  let depth = 0, cur = '';
  for (const ch of s){ if (ch === '(') depth++; if (ch === ')') depth = Math.max(0, depth-1); if (ch === ';' && !depth){ out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur);
  return out.map(p => { const i = p.indexOf(':'); return i < 0 ? null : [p.slice(0,i).trim().toLowerCase(), p.slice(i+1).trim()]; }).filter(x => x && x[0]);
}
function setStyleProp(nd, prop, val){
  const decl = parseStyle(decodeEnt(attrVal(nd, 'style') || ''));
  const i = decl.findIndex(d => d[0] === prop);
  val = (val || '').trim().replace(/;+$/,'').replace(/"/g, "'");
  if (!val){ if (i < 0) return; decl.splice(i, 1); }
  else if (i >= 0) decl[i][1] = val; else decl.push([prop, val]);
  const str = decl.map(d => `${d[0]}: ${d[1]}`).join('; ');
  setAttr(nd, 'style', str ? str + ';' : null);
}
function lineInfo(pos){
  const ls = src.lastIndexOf('\n', pos - 1) + 1;
  const before = src.slice(ls, pos);
  const indent = before.match(/^[ \t]*/)[0];
  return {lineStart: ls, indent, startsLine: /^[ \t]*$/.test(before)};
}
function indentBlock(text, indent){ return text.replace(/\n/g, '\n' + indent); }

/* ---- serialising a text-edited element back to source ---- */
function serializeChildren(el){ let out = ''; for (const c of el.childNodes) out += serializeNode(c); return out; }
function serializeNode(n){
  if (n.nodeType === 3) return escText(n.data);
  if (n.nodeType === 8) return `<!--${n.data}-->`;
  if (n.nodeType !== 1) return '';
  const id = n.getAttribute('data-vedit-id');
  const sn = id != null ? nodes[+id] : null;
  if (sn){
    if (sn.isVoid || sn.raw) return src.slice(sn.start, sn.end);
    return src.slice(sn.start, sn.openEnd) + serializeChildren(n) + src.slice(sn.closeStart, sn.end);
  }
  const tag = n.tagName.toLowerCase();
  let attrs = '';
  for (const a of n.attributes){ if (a.name.startsWith('data-vedit') || a.name === 'contenteditable') continue; attrs += ` ${a.name}="${a.value.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}"`; }
  if (VOID.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${serializeChildren(n)}</${tag}>`;
}


/* ================= ASSETS (read through VS Code) ================= */
function resolvePath(url, baseSegs){
  url = (url || '').trim(); if (!url) return null;
  if (/^(?:[a-z][a-z0-9+.\-]*:|\/\/|#)/i.test(url)) return null;
  const clean = url.split(/[?#]/)[0]; if (!clean) return null;
  const segs = clean.startsWith('/') ? [] : baseSegs.slice();
  for (const part of clean.split('/')){
    if (!part || part === '.') continue;
    if (part === '..') segs.pop();
    else { try { segs.push(decodeURIComponent(part)); } catch { segs.push(part); } }
  }
  return segs;
}
async function resolveUrl(url, baseSegs, asCss = false, depth = 0){
  const segs = resolvePath(url, baseSegs); if (!segs || !segs.length) return null;
  const key = (asCss ? 'css:' : '') + segs.join('/');
  if (!blobCache.has(key)) blobCache.set(key, (async () => {
    const f = await getFileAt(segs); if (!f) return null;
    if (asCss){
      const css = await rewriteCss(await f.text(), segs.slice(0, -1), depth + 1);
      return URL.createObjectURL(new Blob([css], {type:'text/css'}));
    }
    const ext = segs[segs.length-1].split('.').pop().toLowerCase();
    const type = MIME[ext] || f.type;
    return URL.createObjectURL(type ? new Blob([f], {type}) : f);
  })().catch(() => null));
  const u = await blobCache.get(key);
  if (!u) return null;
  const h = url.indexOf('#');
  return h >= 0 ? u + url.slice(h) : u;
}
async function rewriteCss(text, baseSegs, depth){
  if (depth > 4 || !hasRoot) return text;
  const re = /url\(\s*(['"]?)(.*?)\1\s*\)|@import\s+(['"])(.*?)\3/gi;
  const hits = []; let m;
  while ((m = re.exec(text))){
    const isStringImport = m[3] != null;
    const isImport = isStringImport || /@import\s*$/i.test(text.slice(Math.max(0, m.index - 24), m.index));
    hits.push({i: m.index, len: m[0].length, raw: isStringImport ? m[4] : m[2], isImport, urlForm: !isStringImport});
  }
  if (!hits.length) return text;
  const res = await Promise.all(hits.map(h => resolveUrl(h.raw, baseSegs, h.isImport, depth)));
  let out = '', pos = 0;
  hits.forEach((h, k) => { if (!res[k]) return; out += text.slice(pos, h.i) + (h.urlForm ? `url("${res[k]}")` : `"${res[k]}"`); pos = h.i + h.len; });
  return out + text.slice(pos);
}
async function rewriteSrcset(v, baseSegs){
  const parts = decodeEnt(v).split(',');
  const out = await Promise.all(parts.map(async p => {
    const m = p.trim().match(/^(\S+)(.*)$/); if (!m) return p;
    const u = await resolveUrl(m[1], baseSegs); return u ? u + m[2] : p.trim();
  }));
  return out.join(', ');
}


function toBytes(v){
  if (!v) return null;
  if (typeof v.base64 === 'string'){ const bin = atob(v.base64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof v === 'object'){ const n = Object.keys(v).length; const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = v[i]; return u; } // JSON-mangled typed array
  return null;
}
async function getFileAt(segs){
  if (!hasRoot || !segs || !segs.length) return null;
  try { const data = await request('readFile', {segs}); const bytes = toBytes(data); return bytes ? new Blob([bytes]) : null; } catch { return null; }
}

/* builds the instrumented copy of the page shown in the preview */
async function buildPreview(){
  const edits = [], jobs = [];
  const baseSegs = file ? file.segs.slice(0, -1) : [];
  for (const nd of nodes){
    let extra = ` data-vedit-id="${nd.id}"`;
    if (nd.tag === 'script'){
      if (runScripts) extra += ` nonce="${NONCE}"`;
      else { const t = getAttr(nd, 'type'); if (t) edits.push([t.fullStart, t.fullEnd, 'type="text/x-vedit-off"']); else extra += ' type="text/x-vedit-off"'; }
    }
    if (nd.tag === 'meta' && /refresh|content-security-policy/i.test(attrVal(nd, 'http-equiv') || '')){
      const a = getAttr(nd, 'http-equiv'); edits.push([a.fullStart, a.fullStart, 'data-vedit-x-']);
    }
    const p = attrInsertPos(nd); edits.push([p, p, extra]);
    if (!hasRoot) continue;
    for (const a of nd.attrs){
      if (a.valueStart == null || !a.value.trim()) continue;
      const ln = a.lname, t = nd.tag;
      if (ln === 'src' || ln === 'poster' || (ln === 'href' && (t === 'link' || t === 'image' || t === 'use')) || (ln === 'xlink:href' && (t === 'image' || t === 'use')) || (ln === 'data' && t === 'object')){
        if (ln === 'src' && t === 'script' && !runScripts) continue;
        const asCss = t === 'link' && /stylesheet/i.test(attrVal(nd, 'rel') || '');
        jobs.push(resolveUrl(decodeEnt(a.value), baseSegs, asCss).then(u => { if (u) edits.push([a.valueStart, a.valueEnd, u]); }));
      } else if (ln === 'srcset'){
        jobs.push(rewriteSrcset(a.value, baseSegs).then(v => { edits.push([a.valueStart, a.valueEnd, v]); }));
      } else if (ln === 'style' && /url\(/i.test(a.value)){
        jobs.push(rewriteCss(decodeEnt(a.value), baseSegs, 0).then(v => { edits.push([a.valueStart, a.valueEnd, a.quote === "'" ? v.replace(/'/g, '"') : v.replace(/"/g, "'")]); }));
      }
    }
    if (nd.tag === 'style' && nd.raw){
      const css = src.slice(nd.openEnd, nd.closeStart);
      if (/url\(|@import/i.test(css)) jobs.push(rewriteCss(css, baseSegs, 0).then(v => { if (v !== css) edits.push([nd.openEnd, nd.closeStart, v]); }));
    }
  }
  await Promise.all(jobs);
  edits.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let out = '', pos = 0;
  for (const [s, e, t] of edits){ if (s < pos) continue; out += src.slice(pos, s) + t; pos = e; }
  return out + src.slice(pos);
}

/* ================= RENDER / PREVIEW ================= */
async function render(opts = {}){
  const tok = ++renderTok;
  let html;
  try { html = await buildPreview(); } catch (err){ console.error(err); html = src; }
  if (tok !== renderTok) return;
  const cur = frames[active], next = frames[1 - active];
  let sx = 0, sy = 0;
  if (!opts.fresh){ try { sx = cur.contentWindow.scrollX; sy = cur.contentWindow.scrollY; } catch {} }
  await new Promise(res => { next.onload = () => res(); next.srcdoc = html; });
  next.onload = null;
  if (tok !== renderTok) return;
  const w = next.contentWindow, d = next.contentDocument;
  try { d.documentElement.style.scrollBehavior = 'auto'; w.scrollTo(sx, sy); } catch {}
  next.classList.add('on'); cur.classList.remove('on'); active = 1 - active;
  doc = d; wire(d, w);
  editingEl = null; hideTextbar();
  restoreSelection();
}
function wire(d, w){
  const st = d.createElement('style');
  st.textContent = '[data-vedit-editing]{outline:2px solid #c2410c!important;outline-offset:3px;cursor:text!important;min-width:8px}html{scroll-behavior:auto!important}';
  (d.head || d.documentElement).appendChild(st);
  const target = e => e.target && e.target.closest ? e.target.closest('[data-vedit-id]') : null;
  d.addEventListener('mousemove', e => { if (editingEl){ setBox($('#hoverBox'), null); return; } const t = target(e); setBox($('#hoverBox'), t && t !== selEl ? t : null); }, true);
  d.addEventListener('mouseleave', () => setBox($('#hoverBox'), null));
  d.addEventListener('click', e => {
    if (editingEl && editingEl.contains(e.target)){ if (e.target.closest('a')) e.preventDefault(); return; }
    e.preventDefault(); e.stopPropagation();
    const t = target(e); if (!t) return;
    const nd = nodes[+t.getAttribute('data-vedit-id')];
    if (editingEl){ selStart = nd.start; if (!commitEdit()) selectNode(nd, t); return; }
    selectNode(nd, t);
  }, true);
  d.addEventListener('dblclick', e => {
    const t = target(e); if (!t || editingEl) return;
    const nd = nodes[+t.getAttribute('data-vedit-id')];
    e.preventDefault();
    selectNode(nd, t);
    if (isTextEditable(nd)) startEdit();
  }, true);
  for (const ev of ['submit', 'auxclick']) d.addEventListener(ev, e => e.preventDefault(), true);
  d.addEventListener('keydown', e => onKey(e, true), true);
  d.addEventListener('input', () => updateBoxes());
  w.addEventListener('scroll', () => { updateBoxes(); setBox($('#hoverBox'), null); });
  w.addEventListener('resize', updateBoxes);
  // leaving the page (inspector, another VS Code pane) finishes the text edit
  w.addEventListener('blur', () => setTimeout(() => { if (editingEl && document.activeElement !== $('#linkInp')) commitEdit(); }, 0));
}
function restoreSelection(){
  const nd = selStart != null ? byStart.get(selStart) : null;
  if (!nd){ selStart = null; selEl = null; }
  else selEl = doc ? doc.querySelector(`[data-vedit-id="${nd.id}"]`) : null;
  updateBoxes(); renderInspector();
}
let syncTimer = null;
function selectNode(nd, el){
  if (editingEl) commitEdit();
  selStart = nd ? nd.start : null;
  selEl = el || (nd && doc ? doc.querySelector(`[data-vedit-id="${nd.id}"]`) : null);
  setBox($('#hoverBox'), null);
  updateBoxes(); renderInspector();
  clearTimeout(syncTimer);
  if (nd) syncTimer = setTimeout(() => vscode.postMessage({type: 'select', start: nd.start, end: nd.end}), 120);
}
function setBox(box, el){
  if (!el || !el.isConnected){ box.style.display = 'none'; return null; }
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height){ box.style.display = 'none'; return null; }
  Object.assign(box.style, {display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px'});
  return r;
}
function updateBoxes(){
  const r = setBox($('#selBox'), editingEl ? null : selEl);
  const tag = $('#selTag');
  if (!r || editingEl){ tag.style.display = 'none'; }
  else {
    const nd = byStart.get(selStart);
    const cls = attrVal(nd, 'class');
    tag.textContent = nd.tag + (cls ? '.' + cls.trim().split(/\s+/)[0] : '');
    tag.style.display = 'block';
    tag.style.left = Math.max(0, r.left) + 'px';
    tag.style.top = (r.top > 20 ? r.top - 19 : r.top + 2) + 'px';
  }
  if (editingEl) positionTextbar();
}

/* ================= TEXT EDITING ================= */
let savedRange = null;
function startEdit(){
  const nd = byStart.get(selStart);
  if (!selEl || !isTextEditable(nd)) return;
  editingEl = selEl; editingNode = nd;
  editBefore = serializeChildren(selEl);
  selEl.setAttribute('contenteditable', 'true');
  selEl.setAttribute('data-vedit-editing', '');
  selEl.focus();
  selEl.addEventListener('focusout', onEditBlur);
  selEl.addEventListener('paste', onPaste);
  selEl.addEventListener('keydown', onEditKey);
  $('#selTag').style.display = 'none';
  $('#textbar').style.display = 'flex'; $('#linkInp').hidden = true;
  positionTextbar(); renderInspector();
}
function onEditBlur(){ setTimeout(() => { if (editingEl && doc && !editingEl.contains(doc.activeElement)) commitEdit(); }, 0); }
function onPaste(e){ e.preventDefault(); doc.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain')); }
function onEditKey(e){
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); commitEdit(); return; }
  if (e.key === 'Enter'){ e.preventDefault(); doc.execCommand('insertLineBreak'); }
  if (e.key === 'Escape'){ e.preventDefault(); cancelEdit(); }
}
function commitEdit(){
  if (!editingEl) return false;
  const el = editingEl, nd = editingNode;
  editingEl = null; editingNode = null;
  el.removeEventListener('focusout', onEditBlur);
  el.removeAttribute('contenteditable'); el.removeAttribute('data-vedit-editing');
  hideTextbar();
  const after = serializeChildren(el);
  if (after !== editBefore){ replaceRange(nd.openEnd, nd.closeStart, after); return true; }
  updateBoxes(); renderInspector();
  return false;
}
function cancelEdit(){ if (!editingEl) return; editingEl = null; hideTextbar(); render(); }
function hideTextbar(){ $('#textbar').style.display = 'none'; }
function positionTextbar(){
  if (!editingEl) return;
  const r = editingEl.getBoundingClientRect(), bar = $('#textbar'), stage = $('#stage');
  let top = r.top - 40; if (top < 4) top = Math.min(r.bottom + 8, stage.clientHeight - 38);
  bar.style.top = top + 'px';
  bar.style.left = Math.max(4, Math.min(r.left, stage.clientWidth - bar.offsetWidth - 4)) + 'px';
}
$('#textbar').addEventListener('mousedown', e => { if (e.target.id !== 'linkInp') e.preventDefault(); });
$('#textbar').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || !doc) return;
  const cmd = b.dataset.cmd;
  if (cmd === 'done') return commitEdit();
  if (cmd === 'link'){
    const sel = doc.getSelection();
    savedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const inp = $('#linkInp'); inp.hidden = false; inp.value = 'https://'; inp.focus(); inp.select();
    positionTextbar(); return;
  }
  doc.execCommand(cmd, false, null);
  updateBoxes();
});
$('#linkInp').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== 'Escape') return;
  e.preventDefault();
  const inp = $('#linkInp'), url = inp.value.trim();
  inp.hidden = true;
  if (!editingEl) return;
  editingEl.focus();
  if (savedRange){ const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); }
  if (e.key === 'Enter' && url && url !== 'https://') doc.execCommand('createLink', false, url);
  positionTextbar();
});

async function opReplaceImage(){
  const nd = curNode(); if (!nd) return;
  if (!hasRoot){ toast('Open the website folder in VS Code to add images.'); return; }
  const old = decodeEnt(attrVal(nd, 'src') || '');
  const external = !old || /^(?:[a-z][a-z0-9+.\-]*:|\/\/)/i.test(old);
  const oldPath = old.split(/[?#]/)[0];
  const prefix = external ? 'images/' : oldPath.slice(0, oldPath.lastIndexOf('/') + 1);
  const dirSegs = resolvePath(prefix || './', file.segs.slice(0, -1)) || [];
  const startAt = nd.start;
  try {
    const res = await request('pickImage', {dirSegs});
    if (!res) return;
    blobCache.delete([...dirSegs, res.name].join('/'));
    const n2 = byStart.get(startAt); if (!n2) return;
    setAttr(n2, 'src', prefix + res.name);
    toast('Image added: ' + [...dirSegs, res.name].join('/'));
  } catch (err){ toast('Could not add the image: ' + err.message); }
}

/* ================= TOP BAR & KEYS ================= */
$('#undo').onclick = () => { if (editingEl) commitEdit(); vscode.postMessage({type: 'undo'}); };
$('#redo').onclick = () => vscode.postMessage({type: 'redo'});
$('#saveBtn').onclick = () => { if (editingEl) commitEdit(); vscode.postMessage({type: 'save'}); };
$('#srcBtn').onclick = () => { const nd = curNode(); vscode.postMessage({type: 'showSource', start: nd ? nd.start : null, end: nd ? nd.end : null}); };
$('#devices').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  $('#devices').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  $('#stage').className = 'stage ' + (b.dataset.dev === 'desktop' ? '' : b.dataset.dev);
  setTimeout(updateBoxes, 250);
});
$('#scriptsTog').onchange = e => { runScripts = e.target.checked; vscode.postMessage({type: 'setConfig', key: 'runScripts', value: runScripts}); render(); };
$('#autoTog').onchange = e => { autosave = e.target.checked; vscode.postMessage({type: 'setConfig', key: 'autoSave', value: autosave}); };
function onKey(e, fromFrame){
  const mod = e.ctrlKey || e.metaKey, k = (e.key || '').toLowerCase();
  const inField = e.target && (e.target.closest?.('input,textarea,select,[contenteditable]') || e.target.isContentEditable);
  // Inside the page preview VS Code can't see the keys, so pass the main shortcuts on.
  if (fromFrame && mod && k === 's'){ e.preventDefault(); if (editingEl) commitEdit(); vscode.postMessage({type: 'save'}); return; }
  if (inField || editingEl) return;
  if (fromFrame && mod && k === 'z'){ e.preventDefault(); vscode.postMessage({type: e.shiftKey ? 'redo' : 'undo'}); return; }
  if (fromFrame && mod && k === 'y'){ e.preventDefault(); vscode.postMessage({type: 'redo'}); return; }
  if (!file) return;
  if ((k === 'delete' || k === 'backspace') && curNode()){ e.preventDefault(); opDelete(); return; }
  if (k === 'escape'){ selectNode(null); return; }
  if (k === 'enter' && curNode()){ e.preventDefault(); startEdit(); return; }
  if (mod && k === 'd' && curNode()){ e.preventDefault(); opDuplicate(); return; }
}
document.addEventListener('keydown', e => onKey(e, false));
window.addEventListener('resize', updateBoxes);
let toastTimer;
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }

/* ================= ELEMENT OPERATIONS ================= */
const curNode = () => selStart != null ? byStart.get(selStart) : null;
const elemSiblings = nd => nd.parent.children;
function opDelete(){
  const nd = curNode(); if (!nd || ['html','head','body'].includes(nd.tag)) return;
  let s = nd.start, e = nd.end;
  const li = lineInfo(s);
  if (li.startsLine){
    const rest = src.slice(e).match(/^[ \t]*(\r?\n|$)/);
    if (rest){ s = li.lineStart; e += rest[0].length; }
  }
  const parentStart = nd.parent && nd.parent.tag !== '#root' ? nd.parent.start : null;
  replaceRange(s, e, '', {select: parentStart});
  toast(`Deleted <${nd.tag}>`);
}
function opDuplicate(){
  const nd = curNode(); if (!nd || ['html','head','body'].includes(nd.tag)) return;
  const li = lineInfo(nd.start), copy = src.slice(nd.start, nd.end);
  const text = li.startsLine ? '\n' + li.indent + copy : copy;
  replaceRange(nd.end, nd.end, text, {select: nd.end + text.length - copy.length});
}
function opMove(dir){
  const nd = curNode(); if (!nd) return;
  const sib = elemSiblings(nd), i = sib.indexOf(nd), other = sib[i + dir];
  if (!other) return toast(dir < 0 ? 'Already first' : 'Already last');
  const [a, b] = dir < 0 ? [other, nd] : [nd, other];
  const between = src.slice(a.end, b.start);
  const text = src.slice(b.start, b.end) + between + src.slice(a.start, a.end);
  const newStart = dir < 0 ? a.start : a.start + (b.end - b.start) + between.length;
  replaceRange(a.start, b.end, text, {select: newStart});
}
function opParent(){ const nd = curNode(); if (nd && nd.parent && nd.parent.tag !== '#root') selectNode(nd.parent); }
const SNIPPETS = {
  'Heading': '<h2>New heading</h2>',
  'Paragraph': '<p>New paragraph. Double-click to edit this text.</p>',
  'Button / link': '<a href="#" class="btn">Button</a>',
  'Image': '<img src="https://placehold.co/800x500" alt="Describe the image">',
  'Section': '<section>\n  <h2>Section title</h2>\n  <p>Section text.</p>\n</section>',
  'List': '<ul>\n  <li>First item</li>\n  <li>Second item</li>\n</ul>',
  'Container (div)': '<div>\n  <p>New block</p>\n</div>',
  'Line break': '<br>'
};
function opInsert(kind, where){
  const nd = curNode(); if (!nd) return;
  const snip = SNIPPETS[kind];
  if (where === 'inside'){
    if (nd.isVoid || nd.raw) return toast("Can't put elements inside this one");
    const childIndent = lineInfo(nd.start).indent + '  ';
    let p = nd.closeStart; while (p > nd.openEnd && (src[p-1] === ' ' || src[p-1] === '\t')) p--;
    if (src[p-1] === '\n'){ const t = childIndent + indentBlock(snip, childIndent) + '\n'; return replaceRange(p, p, t, {select: p + childIndent.length}); }
    return replaceRange(nd.closeStart, nd.closeStart, snip, {select: nd.closeStart});
  }
  const li = lineInfo(nd.start), block = indentBlock(snip, li.indent);
  if (where === 'before'){
    const t = li.startsLine ? block + '\n' + li.indent : block;
    return replaceRange(nd.start, nd.start, t, {select: nd.start});
  }
  const t = li.startsLine ? '\n' + li.indent + block : block;
  replaceRange(nd.end, nd.end, t, {select: nd.end + t.length - block.length});
}

/* ================= INSPECTOR ================= */
function E(tag, props, ...kids){
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})){
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'value' || k === 'checked' || k === 'title' || k === 'disabled' || k === 'type') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}
function field(label, key, value, onCommit, opts = {}){
  const inp = E(opts.multiline ? 'textarea' : 'input', {class: 'inp' + (opts.mono ? ' mono' : ''), value: value ?? '', placeholder: opts.placeholder || '', 'data-key': key, spellcheck: 'false'});
  const commit = () => { if (inp.value !== (value ?? '')) onCommit(inp.value); };
  inp.addEventListener('change', commit);
  if (!opts.multiline) inp.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); inp.blur(); } });
  else if (opts.ctrlEnter !== false) inp.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); inp.blur(); } });
  return E('label', {class: 'fld'}, label ? E('span', {class: 'lbl', text: label}) : null, inp);
}
function rgbToHex(c){
  const m = (c || '').match(/\d+(\.\d+)?/g); if (!m || m.length < 3) return '#000000';
  return '#' + m.slice(0, 3).map(x => (+x | 0).toString(16).padStart(2, '0')).join('');
}
function section(title, ...kids){ return E('div', {class: 'sec'}, title ? E('h3', {text: title}) : null, ...kids); }
function renderInspector(){
  const box = $('#inspector');
  const ae = document.activeElement, keepKey = ae && box.contains(ae) ? ae.getAttribute('data-key') : null;
  const keepSel = keepKey && 'selectionStart' in ae ? [ae.selectionStart, ae.selectionEnd] : null;
  box.replaceChildren();
  if (!file){ box.append(section('Inspector', E('p', {class: 'note', text: 'Loading…'}))); return; }
  const nd = curNode();
  if (!nd) renderPagePanel(box); else renderNodePanel(box, nd);
  if (keepKey){ const el = box.querySelector(`[data-key="${CSS.escape(keepKey)}"]`); if (el){ el.focus(); try { if (keepSel) el.setSelectionRange(...keepSel); } catch {} } }
}
function renderPagePanel(box){
  const title = nodes.find(n => n.tag === 'title' && n.raw);
  const desc = nodes.find(n => n.tag === 'meta' && (attrVal(n, 'name') || '').toLowerCase() === 'description');
  const head = nodes.find(n => n.tag === 'head');
  box.append(section('Page',
    title ? field('Page title (browser tab & Google)', 'ptitle', decodeEnt(src.slice(title.openEnd, title.closeStart).trim()), v => replaceRange(title.openEnd, title.closeStart, escText(v))) : null,
    field('Meta description (Google snippet)', 'pdesc', desc ? decodeEnt(attrVal(desc, 'content') || '') : '', v => {
      if (desc) return setAttr(desc, 'content', v);
      const after = title || head; if (!after) return toast('No <head> found');
      const at = title ? title.end : head.openEnd;
      const ind = lineInfo(title ? title.start : head.start).indent + (title ? '' : '  ');
      replaceRange(at, at, `\n${ind}<meta name="description" content="${escAttr(v)}">`);
    }, {multiline: true})
  ));
  box.append(section('How it works', E('ul', {class: 'tips'},
    E('li', {}, 'Click anything on the page to select it.'),
    E('li', {}, 'Double-click text to type straight into the page. Click outside or press ', E('span', {class: 'kbd', text: 'Ctrl+Enter'}), ' to finish.'),
    E('li', {}, 'Use the panel to change links, images, colours, spacing and attributes.'),
    E('li', {}, E('span', {class: 'kbd', text: 'Ctrl+Z'}), ' undo · ', E('span', {class: 'kbd', text: 'Ctrl+S'}), ' save · ', E('span', {class: 'kbd', text: 'Del'}), ' delete element · ', E('span', {class: 'kbd', text: 'Esc'}), ' deselect'),
    E('li', {}, 'Only what you change is rewritten — the rest of the file stays byte-for-byte identical.'),
    E('li', {}, 'Click </> Source to open the code beside this view; selections follow along.')
  )));
}
function renderNodePanel(box, nd){
  // breadcrumbs
  const chain = []; for (let p = nd; p && p.tag !== '#root'; p = p.parent) chain.unshift(p);
  const shown = chain.slice(-5);
  const crumbs = E('div', {class: 'crumbs'}, chain.length > shown.length ? '… ' : null,
    shown.map((p, i) => [i ? '›' : null, E('button', {class: p === nd ? 'last' : '', text: p.tag + (attrVal(p, 'id') ? '#' + attrVal(p, 'id') : ''), onclick: () => selectNode(p)})]));
  const id = attrVal(nd, 'id'), cls = attrVal(nd, 'class');
  const editable = isTextEditable(nd) && selEl;
  box.append(section(null, crumbs,
    E('div', {class: 'eltitle'}, '<' + nd.tag + '>', ' ', E('small', {text: (id ? '#' + id + ' ' : '') + (cls ? '.' + cls.trim().split(/\s+/).join('.') : '')})),
    E('div', {class: 'actions'},
      editable ? E('button', {class: 'btn primary wide', text: editingEl ? 'Editing… click Done when finished' : '✎ Edit text on page', disabled: !!editingEl, onclick: startEdit}) : null,
      E('button', {class: 'btn', text: '↑ Move up', onclick: () => opMove(-1)}),
      E('button', {class: 'btn', text: '↓ Move down', onclick: () => opMove(1)}),
      E('button', {class: 'btn', text: '⤴ Parent', onclick: opParent}),
      E('button', {class: 'btn', text: '⧉ Duplicate', onclick: opDuplicate}),
      E('button', {class: 'btn danger', text: '🗑 Delete', onclick: opDelete}),
      E('button', {class: 'btn', text: '</> Code', title: 'Show this element in the source code', onclick: () => vscode.postMessage({type: 'showSource', start: nd.start, end: nd.end})})
    )));

  // quick text field for simple text-only elements
  if (isTextEditable(nd) && nd.children.length === 0){
    const inner = src.slice(nd.openEnd, nd.closeStart);
    const lead = inner.match(/^\s*/)[0], trail = inner.slice(lead.length).match(/\s*$/)[0];
    const textNow = selEl ? selEl.textContent.trim() : decodeEnt(inner.trim());
    box.append(section('Text', field('', 'text', textNow, v => replaceRange(nd.openEnd, nd.closeStart, lead + escText(v) + trail), {multiline: true})));
  }
  if (nd.tag === 'a'){
    box.append(section('Link',
      field('Link address (href)', 'href', decodeEnt(attrVal(nd, 'href') || ''), v => setAttr(nd, 'href', v)),
      E('label', {class: 'tog'}, E('input', {type: 'checkbox', checked: attrVal(nd, 'target') === '_blank', onchange: e => {
        if (e.target.checked){ setAttr(nd, 'target', '_blank'); const n2 = curNode(); if (!getAttr(n2, 'rel')) setAttr(n2, 'rel', 'noopener'); }
        else setAttr(nd, 'target', null);
      }}), 'Open in a new tab')));
  }
  if (nd.tag === 'img'){
    const prev = selEl && selEl.currentSrc ? E('img', {class: 'imgprev', src: selEl.currentSrc, alt: ''}) : null;
    box.append(section('Image', prev,
      E('button', {class: 'btn', text: '🖼 Replace image…', onclick: opReplaceImage}),
      field('Image file (src)', 'src', decodeEnt(attrVal(nd, 'src') || ''), v => setAttr(nd, 'src', v)),
      field('Alt text (for accessibility & SEO)', 'alt', decodeEnt(attrVal(nd, 'alt') || ''), v => setAttr(nd, 'alt', v))));
  }

  // style
  if (!['html','head','meta','link','script','style','title','br'].includes(nd.tag)){
    const decl = Object.fromEntries(parseStyle(decodeEnt(attrVal(nd, 'style') || '')));
    const cs = selEl && doc ? doc.defaultView.getComputedStyle(selEl) : null;
    const colorField = (label, prop) => {
      const txt = E('input', {class: 'inp', value: decl[prop] || '', placeholder: cs ? cs[prop === 'color' ? 'color' : 'backgroundColor'] : '', 'data-key': 's-' + prop});
      const pick = E('input', {type: 'color', value: rgbToHex(decl[prop] && decl[prop].startsWith('#') ? hexToRgb(decl[prop]) : cs ? cs[prop === 'color' ? 'color' : 'backgroundColor'] : '#000')});
      txt.addEventListener('change', () => setStyleProp(nd, prop, txt.value));
      txt.addEventListener('keydown', e => { if (e.key === 'Enter') txt.blur(); });
      pick.addEventListener('change', () => setStyleProp(nd, prop, pick.value));
      return E('label', {class: 'fld'}, E('span', {class: 'lbl', text: label}), E('div', {class: 'colorrow'}, pick, txt));
    };
    const sf = (label, prop, cssKey) => field(label, 's-' + prop, decl[prop] || '', v => setStyleProp(nd, prop, v), {placeholder: cs ? cs[cssKey] : ''});
    const align = decl['text-align'] || '';
    box.append(section('Style',
      E('div', {class: 'row2'}, colorField('Text colour', 'color'), colorField('Background', 'background-color')),
      E('div', {class: 'row2'}, sf('Font size', 'font-size', 'fontSize'),
        E('label', {class: 'fld'}, E('span', {class: 'lbl', text: 'Weight'}),
          E('select', {class: 'inp', onchange: e => setStyleProp(nd, 'font-weight', e.target.value)},
            ['', '300', '400', '500', '600', '700', '800'].map(w => E('option', {value: w, selected: (decl['font-weight'] || '') === w ? true : null, text: w ? w : '— default —'}))))),
      E('label', {class: 'fld'}, E('span', {class: 'lbl', text: 'Text align'}),
        E('div', {class: 'seg'}, ['', 'left', 'center', 'right'].map(a => E('button', {class: align === a ? 'on' : '', text: a || 'default', onclick: () => setStyleProp(nd, 'text-align', a)})))),
      E('div', {class: 'row2'}, sf('Padding', 'padding', 'padding'), sf('Margin', 'margin', 'margin')),
      E('div', {class: 'row2'}, sf('Width', 'width', 'width'), sf('Corner radius', 'border-radius', 'borderRadius')),
      E('p', {class: 'note', text: 'These are written as an inline style="" on this element. Leave a box empty to remove it.'})));
  }

  box.append(section('ID & classes',
    field('id', 'id', id || '', v => setAttr(nd, 'id', v.trim() || null)),
    field('class', 'class', cls || '', v => setAttr(nd, 'class', v.trim() ? v : null))));

  // all attributes
  const attrRows = nd.attrs.map(a => E('div', {class: 'attr'},
    E('code', {text: a.name, title: a.name}),
    (() => { const i = E('input', {class: 'inp', value: a.value, 'data-key': 'a-' + a.lname}); i.addEventListener('change', () => setAttr(nd, a.name, i.value)); i.addEventListener('keydown', e => { if (e.key === 'Enter') i.blur(); }); return i; })(),
    E('button', {text: '✕', title: 'Remove attribute', onclick: () => setAttr(nd, a.name, null)})));
  const newName = E('input', {class: 'inp', placeholder: 'name', 'data-key': 'newattr'}), newVal = E('input', {class: 'inp', placeholder: 'value', 'data-key': 'newval'});
  const add = () => { const n = newName.value.trim(); if (!/^[^\s"'>\/=]+$/.test(n)) return toast('Enter a valid attribute name'); setAttr(nd, n, newVal.value); };
  newVal.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  box.append(E('details', {class: 'sec'}, E('summary', {}, E('h3', {text: `Attributes (${nd.attrs.length})`})),
    ...attrRows, E('div', {class: 'attr'}, newName, newVal, E('button', {text: '+', title: 'Add attribute', onclick: add}))));

  // raw html
  const html = src.slice(nd.start, nd.end);
  const ta = field('', 'html', html, () => {}, {multiline: true, mono: true, ctrlEnter: false});
  const taEl = ta.querySelector('textarea');
  taEl.replaceWith(taEl.cloneNode()); // drop the auto-commit; we use the Apply button
  const taReal = ta.querySelector('textarea'); taReal.value = html; taReal.rows = Math.min(16, html.split('\n').length + 1);
  box.append(E('details', {class: 'sec'}, E('summary', {}, E('h3', {text: 'HTML of this element'})), ta,
    E('button', {class: 'btn', text: 'Apply HTML', onclick: () => replaceRange(nd.start, nd.end, taReal.value, {select: nd.start})})));

  // insert
  const kindSel = E('select', {class: 'inp'}, Object.keys(SNIPPETS).map(k => E('option', {value: k, text: k})));
  const whereSel = E('select', {class: 'inp'}, E('option', {value: 'after', text: 'after this'}), E('option', {value: 'before', text: 'before this'}), E('option', {value: 'inside', text: 'inside, at the end'}));
  box.append(section('Add element', E('div', {class: 'row2'}, kindSel, whereSel),
    E('button', {class: 'btn', text: '+ Insert', onclick: () => opInsert(kindSel.value, whereSel.value)})));
}
function hexToRgb(h){ h = h.replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); const n = parseInt(h.slice(0, 6), 16); return isNaN(n) ? '' : `rgb(${n >> 16},${(n >> 8) & 255},${n & 255})`; }


vscode.postMessage({type: 'ready'});
renderInspector();
})();
