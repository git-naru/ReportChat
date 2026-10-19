// ReportChat 클라이언트: 문서 페이지 위에 여러 명이 실시간으로 펜·텍스트 필기를 한다.
// 필기 좌표는 페이지 가로를 1000으로 둔 좌표계에 저장해 화면 크기·확대와 무관하게 맞춘다.

const NS = 'http://www.w3.org/2000/svg';
const PW = 1000;
const PALETTE = ['#e11d48', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#2563eb', '#7c3aed', '#db2777', '#111827'];
const SIZES = { pen: [2, 4, 8], highlighter: [12, 22, 36], text: [16, 26, 42] };
const FONT = "'Pretendard', 'Noto Sans KR', 'Malgun Gothic', 'Apple SD Gothic Neo', system-ui, sans-serif";
const LINE = 1.25;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const local = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } },
};

function rid(n = 12) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, n);
}

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let args = null;
  const call = () => {
    last = Date.now();
    timer = null;
    const a = args;
    args = null;
    fn(...a);
  };
  const f = (...a) => {
    args = a;
    if (!timer) timer = setTimeout(call, Math.max(0, last + ms - Date.now()));
  };
  f.flush = () => {
    if (timer) {
      clearTimeout(timer);
      call();
    }
  };
  return f;
}

const round1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ------------------------------------------------------------------ 상태

const S = {
  roomId: null,
  me: {
    id: local.get('rc.clientId') || rid(),
    name: local.get('rc.name') || '',
    color: local.get('rc.color') || PALETTE[Math.floor(Math.random() * 6)],
    sid: null,
  },
  docs: [],
  objects: new Map(),
  users: [],
  pageId: null,
  roomView: null,
  sync: local.get('rc.sync') !== '0',
  tool: 'pen',
  penColor: null, // null이면 내 색
  sizeIdx: { pen: 1, highlighter: 1, text: 1 },
  zoom: 1,
  scale: 1, // 화면 px / 페이지 단위
  undo: [],
  redo: [],
};
local.set('rc.clientId', S.me.id);

const els = {
  page: $('#page'), img: $('#pageImg'), ink: $('#ink'), objs: $('#objs'), drafts: $('#drafts'),
  selection: $('#selection'), overlay: $('#overlay'), stage: $('#stage'), empty: $('#empty'),
};
/** 현재 페이지에 그려진 객체 id → SVG 요소 */
const drawn = new Map();

// ------------------------------------------------------------------ 연결

const conn = {
  ws: null,
  ready: false,
  queue: [],
  retry: 0,
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    setConn('connecting');
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', room: S.roomId, clientId: S.me.id, name: S.me.name, color: S.me.color }));
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      this.ready = false;
      setConn('offline');
      setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** this.retry++));
    };
  },
  send(msg) {
    if (this.ready) this.ws.send(JSON.stringify(msg));
    // 끊긴 동안의 편집은 모아 두었다가 다시 연결되면 보낸다
    else if (msg.t === 'ops') this.queue.push(msg);
  },
  onInit() {
    this.ready = true;
    this.retry = 0;
    setConn('online');
    for (const msg of this.queue.splice(0)) this.ws.send(JSON.stringify(msg));
  },
};

function setConn(state) {
  const el = $('#conn');
  el.dataset.state = state;
  el.textContent = { connecting: '연결 중…', online: '실시간 연결됨', offline: '연결 끊김 — 다시 연결하는 중' }[state];
}

function onMessage(msg) {
  switch (msg.t) {
    case 'init': {
      S.me.sid = msg.you.sid;
      S.docs = msg.room.docs;
      S.objects = new Map(msg.room.objects.map((o) => [o.id, o]));
      S.roomView = msg.room.view;
      S.users = msg.users;
      // 끊긴 동안 한 편집은 서버로 보내고 받은 상태 위에 다시 반영한다
      const queued = conn.queue.slice();
      conn.onInit();
      for (const m of queued) for (const op of m.ops) applyOp(op, false);
      pickDistinctColor();
      renderUsers();
      renderDocs();
      const target = (S.sync && pageExists(S.roomView) && S.roomView) || (pageExists(S.pageId) && S.pageId) || S.roomView || firstPageId();
      showPage(target, { broadcast: false, force: true });
      break;
    }
    case 'users':
      S.users = msg.users;
      renderUsers();
      for (const [sid] of cursors) if (!S.users.some((u) => u.sid === sid)) removeCursor(sid);
      for (const [id, d] of remoteDrafts) if (!S.users.some((u) => u.sid === d.by)) removeDraft(id);
      break;
    case 'ops':
      for (const op of msg.ops) applyOp(op, true);
      break;
    case 'draft':
      onRemoteDraft(msg);
      break;
    case 'cursor':
      onRemoteCursor(msg);
      break;
    case 'view':
      S.roomView = msg.pageId;
      if (S.sync && msg.pageId !== S.pageId) showPage(msg.pageId, { broadcast: false });
      renderDocs();
      break;
    case 'doc': {
      const i = S.docs.findIndex((d) => d.id === msg.doc.id);
      const prev = S.docs[i];
      if (i >= 0) S.docs[i] = msg.doc;
      else S.docs.push(msg.doc);
      if (i < 0 && msg.doc.status === 'converting') toast(`${msg.doc.by}님이 "${msg.doc.name}"을(를) 올리는 중입니다…`);
      if (prev?.status === 'converting' && msg.doc.status === 'error') toast(`"${msg.doc.name}": ${msg.doc.error}`, { type: 'error', timeout: 8000 });
      renderDocs();
      if (!S.pageId && msg.doc.status === 'ready') showPage(msg.doc.pages[0].id, { broadcast: false });
      break;
    }
    case 'docRemoved': {
      const doc = S.docs.find((d) => d.id === msg.docId);
      if (!doc) break;
      S.docs = S.docs.filter((d) => d !== doc);
      const pages = new Set(doc.pages.map((p) => p.id));
      for (const [id, o] of S.objects) if (pages.has(o.pageId)) S.objects.delete(id);
      // 지워진 문서의 객체는 되돌리기로 살릴 수 없으므로 기록에서도 뺀다
      const alive = (entry) => [...entry.undo, ...entry.redo].every((op) => !pages.has(op.obj?.pageId ?? S.objects.get(op.id)?.pageId));
      S.undo = S.undo.filter(alive);
      S.redo = S.redo.filter(alive);
      S.roomView = msg.view;
      renderDocs();
      if (pages.has(S.pageId)) showPage(msg.view || firstPageId(), { broadcast: false });
      toast(`${msg.by}님이 "${doc.name}"을(를) 삭제했습니다.`);
      break;
    }
  }
}

// ------------------------------------------------------------------ 문서·페이지

function allPages() {
  return S.docs.filter((d) => d.status === 'ready').flatMap((doc) => doc.pages.map((page, index) => ({ doc, page, index })));
}
const findPage = (pageId) => allPages().find((p) => p.page.id === pageId);
const pageExists = (pageId) => !!pageId && !!findPage(pageId);
const firstPageId = () => allPages()[0]?.page.id || null;

function showPage(pageId, { broadcast = true, force = false } = {}) {
  const found = pageId && findPage(pageId);
  if (!found) {
    S.pageId = null;
    els.page.hidden = true;
    els.empty.hidden = false;
    clearPageLayers();
    renderPager();
    renderDocs();
    return;
  }
  if (S.pageId === pageId && !force) return;
  finishEdit();
  deselect();
  S.pageId = pageId;
  const { page } = found;
  S.pageH = (PW * page.h) / page.w;
  els.empty.hidden = true;
  els.page.hidden = false;
  if (els.img.getAttribute('src') !== page.url) els.img.src = page.url;
  els.ink.setAttribute('viewBox', `0 0 ${PW} ${S.pageH}`);
  clearPageLayers();
  for (const o of S.objects.values()) if (o.pageId === pageId) drawObj(o);
  for (const d of remoteDrafts.values()) if (d.pageId === pageId) renderDraft(d);
  for (const c of cursors.values()) placeCursor(c);
  S.zoom = 1;
  layout();
  els.stage.scrollTo(0, 0);
  renderPager();
  renderDocs();
  if (broadcast && S.sync) {
    S.roomView = pageId;
    conn.send({ t: 'view', pageId });
  }
}

function clearPageLayers() {
  els.objs.replaceChildren();
  els.drafts.replaceChildren();
  els.selection.replaceChildren();
  drawn.clear();
}

function currentPage() {
  return S.pageId ? findPage(S.pageId) : null;
}

function stepPage(delta) {
  const pages = allPages();
  const i = pages.findIndex((p) => p.page.id === S.pageId);
  const next = pages[clamp(i + delta, 0, pages.length - 1)];
  if (next) showPage(next.page.id);
}

function layout() {
  const cur = currentPage();
  if (!cur) return;
  const { page } = cur;
  const sw = els.stage.clientWidth - 40;
  const sh = els.stage.clientHeight - 40;
  const fitW = Math.max(120, Math.min(sw, (sh * page.w) / page.h));
  const w = fitW * S.zoom;
  els.page.style.width = `${w}px`;
  els.page.style.height = `${(w * page.h) / page.w}px`;
  S.scale = w / PW;
  $('#zoomFit').textContent = `${Math.round(S.zoom * 100)}%`;
  if (editor) styleEditor();
  if (S.selected) drawSelection();
}

function setZoom(z, cx, cy) {
  if (!currentPage()) return;
  const r = els.page.getBoundingClientRect();
  if (cx === undefined) {
    const s = els.stage.getBoundingClientRect();
    cx = s.left + s.width / 2;
    cy = s.top + s.height / 2;
  }
  const fx = (cx - r.left) / r.width;
  const fy = (cy - r.top) / r.height;
  S.zoom = clamp(z, 0.25, 8);
  layout();
  const r2 = els.page.getBoundingClientRect();
  els.stage.scrollLeft += r2.left + fx * r2.width - cx;
  els.stage.scrollTop += r2.top + fy * r2.height - cy;
}

function renderPager() {
  const pages = allPages();
  const i = pages.findIndex((p) => p.page.id === S.pageId);
  const cur = pages[i];
  $('#pageLabel').textContent = cur ? `${cur.doc.name} · ${cur.index + 1} / ${cur.doc.pages.length}` : '';
  $('#prevPage').disabled = i <= 0;
  $('#nextPage').disabled = i < 0 || i >= pages.length - 1;
}

const KIND_LABEL = { image: '이미지', pdf: 'PDF', office: '문서', sheet: '시트' };

function renderDocs() {
  const box = $('#docs');
  box.replaceChildren();
  for (const doc of [...S.docs].reverse()) {
    const item = document.createElement('div');
    item.className = 'doc';
    const head = document.createElement('div');
    head.className = 'doc-head';
    head.innerHTML = `<span class="kind" data-kind="${doc.kind}">${KIND_LABEL[doc.kind] || ''}</span><span class="doc-name"></span><button class="icon del" title="문서 삭제"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    head.querySelector('.doc-name').textContent = doc.name;
    head.querySelector('.doc-name').title = `${doc.name} — ${doc.by}`;
    head.querySelector('.del').onclick = () => {
      if (confirm(`"${doc.name}"과(와) 그 위의 필기를 모두 삭제할까요? 모든 참여자에게서 사라집니다.`)) conn.send({ t: 'delDoc', docId: doc.id });
    };
    item.append(head);

    if (doc.status === 'converting') {
      item.insertAdjacentHTML('beforeend', '<div class="doc-status"><span class="spinner"></span>변환 중…</div>');
    } else if (doc.status === 'error') {
      const st = document.createElement('div');
      st.className = 'doc-status error';
      st.textContent = doc.error || '변환 실패';
      item.append(st);
    } else {
      const grid = document.createElement('div');
      grid.className = 'thumbs';
      doc.pages.forEach((p, idx) => {
        const t = document.createElement('button');
        t.className = 'thumb';
        if (p.id === S.pageId) t.classList.add('active');
        if (p.id === S.roomView && p.id !== S.pageId) t.classList.add('shared');
        t.style.aspectRatio = `${p.w} / ${p.h}`;
        t.title = `${idx + 1}쪽`;
        t.innerHTML = `<img loading="lazy" alt=""><span>${idx + 1}</span>`;
        t.querySelector('img').src = p.url;
        t.onclick = () => {
          showPage(p.id);
          if (matchMedia('(max-width: 760px)').matches) document.body.classList.remove('sidebar-open');
        };
        grid.append(t);
      });
      item.append(grid);
    }
    box.append(item);
  }
  box.querySelector('.thumb.active')?.scrollIntoView({ block: 'nearest' });
}

// ------------------------------------------------------------------ 필기 객체

function pathD(pts) {
  const [x0, y0] = pts[0];
  if (pts.length === 1) return `M${x0} ${y0}l0.01 0`;
  let d = `M${x0} ${y0}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    d += `Q${x} ${y} ${round1((x + nx) / 2)} ${round1((y + ny) / 2)}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return `${d}L${lx} ${ly}`;
}

function strokeAttrs(el, o) {
  el.setAttribute('d', pathD(o.points));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', o.color);
  el.setAttribute('stroke-width', o.width);
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  if (o.tool === 'highlighter') el.setAttribute('stroke-opacity', '0.38');
  else el.removeAttribute('stroke-opacity');
}

function drawObj(o) {
  if (o.pageId !== S.pageId) return;
  const tag = o.type === 'stroke' ? 'path' : 'text';
  let el = drawn.get(o.id);
  if (!el) {
    el = document.createElementNS(NS, tag);
    el.dataset.id = o.id;
    els.objs.append(el);
    drawn.set(o.id, el);
  }
  if (o.type === 'stroke') {
    strokeAttrs(el, o);
    el.setAttribute('transform', `translate(${o.tx || 0} ${o.ty || 0})`);
  } else {
    el.setAttribute('font-size', o.size);
    el.setAttribute('font-family', FONT);
    el.setAttribute('fill', o.color);
    el.setAttribute('stroke', '#ffffff');
    el.setAttribute('stroke-opacity', '0.85');
    el.setAttribute('stroke-width', round1(o.size * 0.14));
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('paint-order', 'stroke');
    el.replaceChildren(...o.text.split('\n').map((line, i) => {
      const ts = document.createElementNS(NS, 'tspan');
      ts.setAttribute('x', o.x);
      ts.setAttribute('y', round1(o.y + o.size * (0.95 + LINE * i)));
      ts.textContent = line || '​';
      return ts;
    }));
    el.style.visibility = editor?.obj.id === o.id ? 'hidden' : '';
  }
  const title = document.createElementNS(NS, 'title');
  title.textContent = o.authorName || '';
  el.append(title);
  if (S.selected === o.id) drawSelection();
}

function undrawObj(id) {
  drawn.get(id)?.remove();
  drawn.delete(id);
}

/** 연산을 로컬 상태에 반영한다. 원격 연산이면 remote=true. */
function applyOp(op, remote) {
  if (op.k === 'add') {
    if (S.objects.has(op.obj.id)) return false;
    const obj = structuredClone(op.obj);
    S.objects.set(obj.id, obj);
    removeDraft(obj.id);
    drawObj(obj);
  } else if (op.k === 'upd') {
    const obj = S.objects.get(op.id);
    if (!obj) return false;
    // 내가 입력 중인 텍스트를 다른 사람이 고친 경우에는 입력 중인 내용을 우선한다
    if (remote && editor?.obj.id === op.id) {
      const { text, ...rest } = op.patch;
      Object.assign(obj, rest);
    } else {
      Object.assign(obj, op.patch);
    }
    drawObj(obj);
  } else if (op.k === 'del') {
    if (!S.objects.delete(op.id)) return false;
    undrawObj(op.id);
    if (S.selected === op.id) deselect();
    if (editor?.obj.id === op.id) closeEditor();
  }
  return true;
}

/** 내 편집을 반영하고 전송한다. undoOps를 주면 되돌리기 기록에 남긴다. */
function commit(ops, undoOps) {
  const applied = ops.filter((op) => applyOp(op, false));
  if (applied.length) conn.send({ t: 'ops', ops: applied });
  if (undoOps) {
    S.undo.push({ undo: undoOps, redo: ops });
    if (S.undo.length > 300) S.undo.shift();
    S.redo = [];
  }
  return applied;
}

function undoRedo(from, to) {
  finishEdit();
  const entry = from.pop();
  if (!entry) return;
  const isUndo = from === S.undo;
  commit(isUndo ? entry.undo : entry.redo);
  to.push(entry);
}

function objectsOnPage(pageId = S.pageId) {
  return [...S.objects.values()].filter((o) => o.pageId === pageId);
}

const bboxCache = new WeakMap();
function pointsBox(points) {
  let b = bboxCache.get(points);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of points) {
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y);
      b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
    }
    bboxCache.set(points, b);
  }
  return b;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l ? clamp(((px - ax) * dx + (py - ay) * dy) / l, 0, 1) : 0;
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

/** 객체의 페이지 좌표 경계 [x1, y1, x2, y2] */
function objBox(o) {
  if (o.type === 'stroke') {
    const [a, b, c, d] = pointsBox(o.points);
    const r = o.width / 2;
    return [a - r + o.tx, b - r + o.ty, c + r + o.tx, d + r + o.ty];
  }
  const el = drawn.get(o.id);
  if (el) {
    const bb = el.getBBox();
    return [bb.x, bb.y, bb.x + bb.width, bb.y + bb.height];
  }
  return [o.x, o.y, o.x + o.size, o.y + o.size * LINE];
}

function hits(o, x, y, tol) {
  const [x1, y1, x2, y2] = objBox(o);
  if (x < x1 - tol || x > x2 + tol || y < y1 - tol || y > y2 + tol) return false;
  if (o.type !== 'stroke') return true;
  const px = x - o.tx;
  const py = y - o.ty;
  const r = o.width / 2 + tol;
  const p = o.points;
  if (p.length === 1) return Math.hypot(p[0][0] - px, p[0][1] - py) <= r;
  for (let i = 1; i < p.length; i++) if (segDist(px, py, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= r) return true;
  return false;
}

function hitTest(x, y, tol) {
  const list = objectsOnPage();
  for (let i = list.length - 1; i >= 0; i--) if (hits(list[i], x, y, tol)) return list[i];
  return null;
}

// ------------------------------------------------------------------ 선택

function select(id) {
  S.selected = id;
  drawSelection();
}

function deselect() {
  S.selected = null;
  els.selection.replaceChildren();
}

function drawSelection() {
  const o = S.objects.get(S.selected);
  if (!o || o.pageId !== S.pageId) return deselect();
  const [x1, y1, x2, y2] = objBox(o);
  const pad = 5 / S.scale;
  const r = document.createElementNS(NS, 'rect');
  r.setAttribute('x', x1 - pad);
  r.setAttribute('y', y1 - pad);
  r.setAttribute('width', x2 - x1 + pad * 2);
  r.setAttribute('height', y2 - y1 + pad * 2);
  r.setAttribute('class', 'sel-box');
  const label = document.createElementNS(NS, 'text');
  label.setAttribute('x', x1 - pad);
  label.setAttribute('y', y1 - pad - 4 / S.scale);
  label.setAttribute('font-size', 12 / S.scale);
  label.setAttribute('class', 'sel-label');
  label.textContent = o.authorName || '';
  els.selection.replaceChildren(r, label);
}

function deleteSelected() {
  const o = S.objects.get(S.selected);
  if (!o) return;
  commit([{ k: 'del', id: o.id }], [{ k: 'add', obj: structuredClone(o) }]);
}

// ------------------------------------------------------------------ 텍스트 편집

let editor = null; // {obj, ta, mirror, isNew, added, original}

const sendTextUpdate = throttle((id, text) => {
  if (S.objects.has(id)) conn.send({ t: 'ops', ops: [{ k: 'upd', id, patch: { text } }] });
}, 120);

function openEditor(obj, isNew) {
  finishEdit();
  deselect();
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.spellcheck = false;
  ta.value = obj.text;
  const mirror = document.createElement('div');
  mirror.className = 'text-mirror';
  els.overlay.append(mirror, ta);
  editor = { obj, ta, mirror, isNew, added: !isNew, original: obj.text };
  drawn.get(obj.id)?.style.setProperty('visibility', 'hidden');
  styleEditor();
  ta.addEventListener('input', onEditorInput);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      finishEdit();
    }
    e.stopPropagation();
  });
  ta.addEventListener('blur', () => finishEdit());
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());
  requestAnimationFrame(() => ta.focus());
}

function styleEditor() {
  const { obj, ta, mirror } = editor;
  const live = S.objects.get(obj.id) || obj;
  for (const el of [ta, mirror]) {
    el.style.left = `${(live.x / PW) * 100}%`;
    el.style.top = `${(live.y / S.pageH) * 100}%`;
    el.style.fontSize = `${live.size * S.scale}px`;
    el.style.lineHeight = String(LINE);
    el.style.fontFamily = FONT;
  }
  ta.style.color = live.color;
  ta.style.caretColor = live.color;
  ta.style.setProperty('--c', live.color);
  mirror.textContent = `${ta.value}​`;
  ta.style.width = `${mirror.offsetWidth + live.size * S.scale}px`;
  ta.style.height = `${mirror.offsetHeight}px`;
}

function onEditorInput() {
  const { obj, ta } = editor;
  obj.text = ta.value;
  styleEditor();
  if (!editor.added) {
    if (!ta.value) return;
    editor.added = true;
    commit([{ k: 'add', obj: structuredClone(obj) }]);
    drawn.get(obj.id)?.style.setProperty('visibility', 'hidden');
    return;
  }
  const live = S.objects.get(obj.id);
  if (live) live.text = ta.value;
  sendTextUpdate(obj.id, ta.value);
}

function closeEditor() {
  if (!editor) return;
  const { obj, ta, mirror } = editor;
  editor = null;
  ta.remove();
  mirror.remove();
  drawn.get(obj.id)?.style.removeProperty('visibility');
}

function finishEdit() {
  if (!editor) return;
  sendTextUpdate.flush();
  const { obj, isNew, added, original } = editor;
  const text = editor.ta.value;
  closeEditor();
  const live = S.objects.get(obj.id);
  if (!live) return;
  if (!text.trim()) {
    // 빈 텍스트는 지운다. 원래 있던 글을 비운 경우에는 되돌릴 수 있게 남긴다.
    const restore = { ...structuredClone(live), text: original };
    commit([{ k: 'del', id: obj.id }], isNew ? undefined : [{ k: 'add', obj: restore }]);
    return;
  }
  live.text = text;
  drawObj(live);
  if (isNew && added) {
    S.undo.push({ undo: [{ k: 'del', id: obj.id }], redo: [{ k: 'add', obj: structuredClone(live) }] });
    S.redo = [];
  } else if (text !== original) {
    S.undo.push({ undo: [{ k: 'upd', id: obj.id, patch: { text: original } }], redo: [{ k: 'upd', id: obj.id, patch: { text } }] });
    S.redo = [];
  }
}

// ------------------------------------------------------------------ 포인터 입력

function toPage(e) {
  const r = els.ink.getBoundingClientRect();
  return [round1(((e.clientX - r.left) / r.width) * PW), round1(((e.clientY - r.top) / r.height) * S.pageH)];
}

function insidePage(e) {
  const r = els.page.getBoundingClientRect();
  return !els.page.hidden && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

const myColor = () => S.penColor || S.me.color;
const sizeOf = (tool) => SIZES[tool][S.sizeIdx[tool]];

let gesture = null;
let spaceHeld = false;

const sendDraft = throttle(() => {
  if (!gesture?.obj || !gesture.pending.length) return;
  const o = gesture.obj;
  conn.send({ t: 'draft', id: o.id, pageId: o.pageId, tool: o.tool, color: o.color, width: o.width, points: gesture.pending.splice(0), reset: gesture.reset });
  gesture.reset = false;
}, 40);

els.stage.addEventListener('pointerdown', (e) => {
  if (e.button === 2) return;
  if (editor && e.target !== editor.ta) finishEdit();
  closeMenus();
  const onPage = insidePage(e);
  const pan = e.button === 1 || spaceHeld || (S.tool === 'select' && !(onPage && hitTest(...toPage(e), 6 / S.scale)));
  if (pan) {
    gesture = { kind: 'pan', x: e.clientX, y: e.clientY, sl: els.stage.scrollLeft, st: els.stage.scrollTop };
    els.stage.classList.add('panning');
  } else if (!onPage || !S.pageId) {
    return;
  } else if (S.tool === 'pen' || S.tool === 'highlighter') {
    const obj = {
      id: rid(), type: 'stroke', pageId: S.pageId, tool: S.tool, color: myColor(), width: sizeOf(S.tool),
      points: [toPage(e)], tx: 0, ty: 0, author: S.me.id, authorName: S.me.name,
    };
    const el = document.createElementNS(NS, 'path');
    els.drafts.append(el);
    strokeAttrs(el, obj);
    gesture = { kind: 'draw', obj, el, pending: [obj.points[0]], reset: true };
    sendDraft();
  } else if (S.tool === 'eraser') {
    gesture = { kind: 'erase', erased: [] };
    eraseAt(e);
  } else if (S.tool === 'text') {
    const [x, y] = toPage(e);
    const hit = hitTest(x, y, 4 / S.scale);
    if (hit?.type === 'text') {
      openEditor(hit, false);
    } else {
      const size = sizeOf('text');
      openEditor({
        id: rid(), type: 'text', pageId: S.pageId, x, y: round1(y - size * 0.6), size, color: myColor(), text: '',
        author: S.me.id, authorName: S.me.name,
      }, true);
    }
    e.preventDefault();
    return;
  } else if (S.tool === 'select') {
    const [x, y] = toPage(e);
    const hit = hitTest(x, y, 6 / S.scale);
    select(hit.id);
    const start = hit.type === 'stroke' ? { tx: hit.tx, ty: hit.ty } : { x: hit.x, y: hit.y };
    gesture = { kind: 'move', obj: hit, from: [x, y], start, moved: false };
  }
  els.stage.setPointerCapture(e.pointerId);
  e.preventDefault();
});

const sendMove = throttle((id, patch) => conn.send({ t: 'ops', ops: [{ k: 'upd', id, patch }] }), 60);

els.stage.addEventListener('pointermove', (e) => {
  if (S.pageId && insidePage(e)) sendCursor(...toPage(e));
  if (!gesture) return;
  if (gesture.kind === 'pan') {
    els.stage.scrollLeft = gesture.sl - (e.clientX - gesture.x);
    els.stage.scrollTop = gesture.st - (e.clientY - gesture.y);
  } else if (gesture.kind === 'draw') {
    const pts = gesture.obj.points;
    const events = e.getCoalescedEvents?.() || [e];
    for (const ev of events.length ? events : [e]) {
      const p = toPage(ev);
      const last = pts[pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.8 / S.scale) continue;
      pts.push(p);
      gesture.pending.push(p);
    }
    gesture.el.setAttribute('d', pathD(pts));
    sendDraft();
  } else if (gesture.kind === 'erase') {
    for (const ev of e.getCoalescedEvents?.() || [e]) eraseAt(ev);
  } else if (gesture.kind === 'move') {
    const [x, y] = toPage(e);
    const dx = round1(x - gesture.from[0]);
    const dy = round1(y - gesture.from[1]);
    if (!gesture.moved && Math.hypot(dx, dy) * S.scale < 3) return;
    gesture.moved = true;
    const o = S.objects.get(gesture.obj.id);
    if (!o) return;
    const patch = o.type === 'stroke'
      ? { tx: round1(gesture.start.tx + dx), ty: round1(gesture.start.ty + dy) }
      : { x: round1(gesture.start.x + dx), y: round1(gesture.start.y + dy) };
    gesture.patch = patch;
    Object.assign(o, patch);
    drawObj(o);
    sendMove(o.id, patch);
  }
});

function endGesture() {
  if (!gesture) return;
  const g = gesture;
  gesture = null;
  els.stage.classList.remove('panning');
  if (g.kind === 'draw') {
    sendDraft.flush();
    g.el.remove();
    commit([{ k: 'add', obj: g.obj }], [{ k: 'del', id: g.obj.id }]);
  } else if (g.kind === 'erase' && g.erased.length) {
    S.undo.push({ undo: g.erased.map((obj) => ({ k: 'add', obj })), redo: g.erased.map((obj) => ({ k: 'del', id: obj.id })) });
    S.redo = [];
  } else if (g.kind === 'move' && g.moved && g.patch) {
    sendMove.flush();
    commit([{ k: 'upd', id: g.obj.id, patch: g.patch }], [{ k: 'upd', id: g.obj.id, patch: g.start }]);
  }
}
els.stage.addEventListener('pointerup', endGesture);
els.stage.addEventListener('pointercancel', endGesture);
els.stage.addEventListener('pointerleave', () => sendCursor.hide());

els.stage.addEventListener('dblclick', (e) => {
  if (S.tool !== 'select' || !insidePage(e)) return;
  const hit = hitTest(...toPage(e), 6 / S.scale);
  if (hit?.type === 'text') openEditor(hit, false);
});

function eraseAt(e) {
  if (!insidePage(e)) return;
  const [x, y] = toPage(e);
  const tol = 9 / S.scale;
  for (const o of objectsOnPage()) {
    if (hits(o, x, y, tol)) {
      gesture.erased.push(structuredClone(o));
      commit([{ k: 'del', id: o.id }]);
    }
  }
}

els.stage.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoom(S.zoom * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
}, { passive: false });

window.addEventListener('resize', () => layout());

// ------------------------------------------------------------------ 다른 사람의 커서·그리는 중인 선

const cursors = new Map(); // sid → {sid, pageId, x, y, el, timer}
const remoteDrafts = new Map(); // id → {id, by, pageId, tool, color, width, points, el, timer}

const sendCursor = throttle((x, y) => conn.ready && conn.send({ t: 'cursor', pageId: S.pageId, x, y }), 50);
sendCursor.hide = () => conn.ready && conn.send({ t: 'cursor', pageId: null, x: 0, y: 0 });

function onRemoteCursor(msg) {
  let c = cursors.get(msg.sid);
  if (!c) {
    const el = document.createElement('div');
    el.className = 'cursor';
    el.innerHTML = '<svg viewBox="0 0 16 16"><path d="M1 1l5 14 2-6 6-2z"/></svg><span></span>';
    c = { sid: msg.sid, el };
    cursors.set(msg.sid, c);
  }
  Object.assign(c, { pageId: msg.pageId, x: msg.x, y: msg.y });
  const user = S.users.find((u) => u.sid === msg.sid);
  c.el.style.setProperty('--c', user?.color || '#64748b');
  c.el.querySelector('span').textContent = user?.name || '';
  placeCursor(c);
  clearTimeout(c.timer);
  c.timer = setTimeout(() => c.el.classList.add('idle'), 8000);
  c.el.classList.remove('idle');
}

function placeCursor(c) {
  if (c.pageId !== S.pageId || !S.pageId) return c.el.remove();
  c.el.style.left = `${(c.x / PW) * 100}%`;
  c.el.style.top = `${(c.y / S.pageH) * 100}%`;
  if (!c.el.isConnected) els.overlay.append(c.el);
}

function removeCursor(sid) {
  cursors.get(sid)?.el.remove();
  cursors.delete(sid);
}

function onRemoteDraft(msg) {
  let d = remoteDrafts.get(msg.id);
  if (!d || msg.reset) {
    if (d) removeDraft(d.id);
    d = { id: msg.id, by: msg.by, pageId: msg.pageId, tool: msg.tool, color: msg.color || '#64748b', width: msg.width, points: [], el: null };
    remoteDrafts.set(msg.id, d);
  }
  d.points.push(...msg.points.filter((p) => Array.isArray(p) && p.length === 2));
  renderDraft(d);
  clearTimeout(d.timer);
  d.timer = setTimeout(() => removeDraft(d.id), 6000);
}

function renderDraft(d) {
  if (d.pageId !== S.pageId || !d.points.length) return;
  if (!d.el || !d.el.isConnected) {
    d.el = document.createElementNS(NS, 'path');
    els.drafts.append(d.el);
  }
  strokeAttrs(d.el, d);
}

function removeDraft(id) {
  const d = remoteDrafts.get(id);
  if (!d) return;
  clearTimeout(d.timer);
  d.el?.remove();
  remoteDrafts.delete(id);
}

// ------------------------------------------------------------------ 도구 모음

function setTool(tool) {
  if (tool !== S.tool) finishEdit();
  S.tool = tool;
  if (tool !== 'select') deselect();
  for (const b of $$('#tools button')) b.classList.toggle('active', b.dataset.tool === tool);
  els.stage.dataset.tool = tool;
  renderSizes();
}

function renderColors() {
  const box = $('#colors');
  box.replaceChildren();
  const colors = [S.me.color, ...PALETTE.filter((c) => c !== S.me.color)];
  colors.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.setProperty('--c', c);
    b.title = i === 0 ? '내 색' : c;
    if (i === 0) b.classList.add('mine');
    if (myColor() === c) b.classList.add('active');
    b.onclick = () => {
      S.penColor = i === 0 ? null : c;
      renderColors();
      renderSizes();
      // 선택하거나 입력 중인 텍스트의 색도 바꾼다
      const target = editor?.obj.id || S.selected;
      const o = target && S.objects.get(target);
      if (o && o.color !== c) {
        commit([{ k: 'upd', id: o.id, patch: { color: c } }], [{ k: 'upd', id: o.id, patch: { color: o.color } }]);
        if (editor) styleEditor();
      } else if (editor) {
        editor.obj.color = c;
        styleEditor();
      }
      editor?.ta.focus();
    };
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    box.append(b);
  });
}

function renderSizes() {
  const box = $('#sizes');
  box.replaceChildren();
  const tool = SIZES[S.tool] ? S.tool : 'pen';
  SIZES[tool].forEach((size, i) => {
    const b = document.createElement('button');
    b.className = 'size';
    if (S.sizeIdx[tool] === i) b.classList.add('active');
    b.title = tool === 'text' ? ['작은 글씨', '보통 글씨', '큰 글씨'][i] : ['가늘게', '보통', '굵게'][i];
    if (tool === 'text') b.innerHTML = `<span style="font-size:${11 + i * 4}px;font-weight:700">가</span>`;
    else b.innerHTML = `<i style="width:${6 + i * 5}px;height:${6 + i * 5}px;background:${myColor()};opacity:${tool === 'highlighter' ? 0.45 : 1}"></i>`;
    b.onclick = () => {
      S.sizeIdx[tool] = i;
      renderSizes();
      const o = editor ? S.objects.get(editor.obj.id) || editor.obj : null;
      if (tool === 'text' && o && o.size !== size) {
        if (S.objects.has(o.id)) commit([{ k: 'upd', id: o.id, patch: { size } }], [{ k: 'upd', id: o.id, patch: { size: o.size } }]);
        else o.size = size;
        styleEditor();
        editor.ta.focus();
      }
    };
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    box.append(b);
  });
}

for (const b of $$('#tools button')) b.onclick = () => setTool(b.dataset.tool);
$('#undo').onclick = () => undoRedo(S.undo, S.redo);
$('#redo').onclick = () => undoRedo(S.redo, S.undo);
$('#prevPage').onclick = () => stepPage(-1);
$('#nextPage').onclick = () => stepPage(1);
$('#zoomIn').onclick = () => setZoom(S.zoom * 1.25);
$('#zoomOut').onclick = () => setZoom(S.zoom / 1.25);
$('#zoomFit').onclick = () => {
  S.zoom = 1;
  layout();
};
$('#toggleSidebar').onclick = () => {
  // 좁은 화면에서는 문서 목록이 위에 겹쳐 열리고, 넓은 화면에서는 접혔다 펼쳐진다
  document.body.classList.toggle(matchMedia('(max-width: 760px)').matches ? 'sidebar-open' : 'sidebar-closed');
  setTimeout(layout, 220);
};
$('#syncToggle').checked = S.sync;
$('#syncToggle').onchange = (e) => {
  S.sync = e.target.checked;
  local.set('rc.sync', S.sync ? '1' : '0');
  if (S.sync && S.roomView && S.roomView !== S.pageId) showPage(S.roomView, { broadcast: false });
};

function closeMenus() {
  $('#clearMenu').hidden = true;
}
$('#clearBtn').onclick = (e) => {
  e.stopPropagation();
  $('#clearMenu').hidden = !$('#clearMenu').hidden;
};
document.addEventListener('click', closeMenus);
for (const b of $$('#clearMenu button')) {
  b.onclick = () => {
    closeMenus();
    const list = objectsOnPage().filter((o) => b.dataset.clear === 'all' || o.author === S.me.id);
    if (!list.length) return toast('지울 필기가 없습니다.');
    if (b.dataset.clear === 'all' && !confirm(`이 페이지의 필기 ${list.length}개를 모두 지울까요? (되돌리기로 복구할 수 있습니다)`)) return;
    commit(list.map((o) => ({ k: 'del', id: o.id })), list.map((o) => ({ k: 'add', obj: structuredClone(o) })));
  };
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, dialog')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) undoRedo(S.redo, S.undo);
    else undoRedo(S.undo, S.redo);
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    undoRedo(S.redo, S.undo);
  } else if (mod) {
    return;
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected) {
    e.preventDefault();
    deleteSelected();
  } else if (e.key === 'PageDown' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    if (e.key.startsWith('Arrow') && els.stage.scrollHeight > els.stage.clientHeight + 2) return;
    e.preventDefault();
    stepPage(1);
  } else if (e.key === 'PageUp' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    if (e.key.startsWith('Arrow') && els.stage.scrollHeight > els.stage.clientHeight + 2) return;
    e.preventDefault();
    stepPage(-1);
  } else if (e.key === ' ') {
    spaceHeld = true;
    els.stage.classList.add('space');
    e.preventDefault();
  } else if (e.key === 'Escape') {
    deselect();
  } else {
    const tool = { v: 'select', p: 'pen', h: 'highlighter', t: 'text', e: 'eraser' }[e.key.toLowerCase()];
    if (tool) setTool(tool);
    else if (e.key === '+' || e.key === '=') setZoom(S.zoom * 1.25);
    else if (e.key === '-') setZoom(S.zoom / 1.25);
    else if (e.key === '0') $('#zoomFit').click();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceHeld = false;
    els.stage.classList.remove('space');
  }
});

// ------------------------------------------------------------------ 내보내기

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function exportPng() {
  const cur = currentPage();
  if (!cur) return toast('저장할 페이지가 없습니다.');
  finishEdit();
  const { page, doc, index } = cur;
  const canvas = document.createElement('canvas');
  canvas.width = page.w;
  canvas.height = page.h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, page.w, page.h);
  ctx.drawImage(await loadImage(page.url), 0, 0, page.w, page.h);

  const svg = els.ink.cloneNode(true);
  svg.querySelector('#drafts').remove();
  svg.querySelector('#selection').remove();
  svg.setAttribute('xmlns', NS);
  svg.setAttribute('width', page.w);
  svg.setAttribute('height', page.h);
  for (const el of svg.querySelectorAll('[style]')) el.removeAttribute('style');
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
  try {
    ctx.drawImage(await loadImage(url), 0, 0, page.w, page.h);
  } finally {
    URL.revokeObjectURL(url);
  }
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${doc.name.replace(/\.[^.]+$/, '')}-${index + 1}쪽.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('#exportBtn').onclick = () => exportPng().catch(() => toast('이미지를 저장하지 못했습니다.', { type: 'error' }));

// ------------------------------------------------------------------ 업로드

function uploadFiles(files) {
  files = [...files].filter((f) => f.size > 0);
  if (!files.length) return;
  if (!conn.ready) return toast('서버와 연결된 뒤 다시 시도해 주세요.', { type: 'error' });
  const form = new FormData();
  for (const f of files) form.append('files', f, f.name);
  form.append('name', S.me.name);
  const t = toast(`업로드 중… 0%`, { timeout: 0 });
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/rooms/${S.roomId}/upload`);
  xhr.upload.onprogress = (e) => e.lengthComputable && t.update(`업로드 중… ${Math.round((e.loaded / e.total) * 100)}%`);
  xhr.onload = () => {
    let body = {};
    try {
      body = JSON.parse(xhr.responseText);
    } catch { /* 빈 응답 */ }
    if (xhr.status !== 200) return t.update(body.error || '업로드에 실패했습니다.', 'error', 6000);
    const bad = (body.docs || []).filter((d) => d.error);
    if (bad.length) t.update(bad.map((d) => `${d.name}: ${d.error}`).join('\n'), 'error', 8000);
    else t.update('업로드 완료 — 변환이 끝나면 모두의 화면에 표시됩니다.', 'ok', 2500);
  };
  xhr.onerror = () => t.update('업로드에 실패했습니다. 네트워크를 확인해 주세요.', 'error', 6000);
  xhr.send(form);
}

for (const input of [$('#fileInput'), ...$$('.file-pick')]) {
  input.onchange = () => {
    uploadFiles(input.files);
    input.value = '';
  };
}

document.addEventListener('paste', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  uploadFiles(files.map((f, i) => (f.type.startsWith('image/') && /^image\.\w+$|^$/.test(f.name)
    ? new File([f], `스크린샷-${stamp}${i ? `-${i}` : ''}.${f.type.split('/')[1] || 'png'}`, { type: f.type })
    : f)));
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files') || $('#app').hidden) return;
  dragDepth++;
  $('#dropOverlay').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#dropOverlay').hidden = true;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
  if (!$('#app').hidden && e.dataTransfer?.files.length) uploadFiles(e.dataTransfer.files);
});

// ------------------------------------------------------------------ 참여자

function renderUsers() {
  const box = $('#users');
  box.replaceChildren();
  const others = S.users.filter((u) => u.sid !== S.me.sid);
  for (const u of others.slice(0, 8)) {
    const el = document.createElement('span');
    el.className = 'avatar';
    el.style.setProperty('--c', u.color);
    el.textContent = [...u.name][0] || '?';
    el.title = u.name;
    box.append(el);
  }
  if (others.length > 8) box.insertAdjacentHTML('beforeend', `<span class="avatar more">+${others.length - 8}</span>`);
  box.title = `${S.users.length}명 접속 중`;
  const me = $('#meBtn');
  me.style.setProperty('--c', S.me.color);
  me.innerHTML = `<span class="avatar"></span><span class="me-name"></span>`;
  me.querySelector('.avatar').textContent = [...S.me.name][0] || '?';
  me.querySelector('.me-name').textContent = `${S.me.name} (나)`;
  renderColors();
  renderSizes();
}

/** 이미 다른 사람이 쓰는 색이면, 직접 고른 색이 아닌 경우에 한해 겹치지 않는 색으로 바꾼다 */
function pickDistinctColor() {
  if (local.get('rc.colorChosen')) return;
  const used = new Set(S.users.filter((u) => u.id !== S.me.id).map((u) => u.color));
  if (!used.has(S.me.color)) return;
  const free = PALETTE.slice(0, 8).find((c) => !used.has(c));
  if (!free) return;
  S.me.color = free;
  local.set('rc.color', free);
  conn.send({ t: 'me', name: S.me.name, color: free });
}

function openMeDialog(onDone) {
  const dlg = $('#meDialog');
  $('#meName').value = S.me.name;
  let chosen = S.me.color;
  const box = $('#meColors');
  const paint = () => {
    box.replaceChildren(...PALETTE.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `swatch${c === chosen ? ' active' : ''}`;
      b.style.setProperty('--c', c);
      const taken = S.users.find((u) => u.color === c && u.id !== S.me.id);
      b.title = taken ? `${taken.name}님이 사용 중` : c;
      if (taken) b.classList.add('taken');
      b.onclick = () => {
        chosen = c;
        paint();
      };
      return b;
    }));
  };
  paint();
  dlg.onclose = () => {
    const name = $('#meName').value.trim().slice(0, 40);
    if (!name) return openMeDialog(onDone);
    if (chosen !== S.me.color) local.set('rc.colorChosen', '1');
    Object.assign(S.me, { name, color: chosen });
    local.set('rc.name', name);
    local.set('rc.color', chosen);
    renderUsers();
    if (conn.ready) conn.send({ t: 'me', name, color: chosen });
    onDone?.();
  };
  dlg.addEventListener('cancel', (e) => !S.me.name && e.preventDefault(), { once: true });
  dlg.showModal();
}
$('#meBtn').onclick = () => openMeDialog();

// ------------------------------------------------------------------ 알림

function toast(text, { type = 'info', timeout = 3500 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = text;
  $('#toasts').append(el);
  let timer;
  const close = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  };
  const arm = (ms) => {
    clearTimeout(timer);
    if (ms) timer = setTimeout(close, ms);
  };
  arm(timeout);
  return {
    update(t, ty = type, ms = 0) {
      el.textContent = t;
      el.className = `toast ${ty}`;
      arm(ms);
    },
    close,
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
$('#copyLink').onclick = async () => {
  const url = `${location.origin}/r/${S.roomId}`;
  if (await copyText(url)) toast('초대 링크를 복사했습니다. 함께할 사람에게 보내 주세요.', { type: 'ok' });
  else prompt('이 링크를 복사해 보내 주세요', url);
};

// ------------------------------------------------------------------ 시작

function roomFromUrl() {
  const m = /^\/r\/([A-Za-z0-9_-]{6,40})\/?$/.exec(location.pathname);
  return m ? m[1] : null;
}

function enterRoom(roomId) {
  S.roomId = roomId;
  $('#landing').hidden = true;
  $('#app').hidden = false;
  document.title = 'ReportChat — 공유 보드';
  setTool('pen');
  renderUsers();
  showPage(null);
  const start = () => conn.connect();
  if (S.me.name) start();
  else openMeDialog(start);
}

function startLanding() {
  $('#landing').hidden = false;
  $('#createRoom').onclick = async () => {
    const res = await fetch('/api/rooms', { method: 'POST' });
    const { id } = await res.json();
    location.href = `/r/${id}`;
  };
  $('#joinForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#joinCode').value.trim();
    const m = /(?:\/r\/)?([A-Za-z0-9_-]{6,40})\/?$/.exec(v);
    if (m) location.href = `/r/${m[1]}`;
    else toast('보드 링크나 코드를 확인해 주세요.', { type: 'error' });
  };
}

const roomId = roomFromUrl();
if (roomId) enterRoom(roomId);
else startLanding();
