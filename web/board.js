// Звонилка — общая доска звонка (docs/UX.md, «Доска»). Бесконечный холст: рисовать пером,
// писать текст, вставлять картинки и заметки (⌘V, перетаскиванием), двигать и стирать.
//
// У каждой комнаты своя доска. Пока идёт звонок, изменения уходят остальным тем же путём, что
// и сообщения чата (напрямую или через ретранслятор), а на устройстве доска хранится в IndexedDB
// — вернулся в комнату, и она на месте. Сервера у доски нет.
//
// Модель: предметы { id, k: stroke | text | note | image, x, y, ts, by, del? }. Кто изменил
// позже (часы Лэмпорта), тот и прав — так правки сходятся у всех без сервера.
//
// Снаружи: createBoard({ root, send, myId, myHue }) → { open, close, isOpen, load(room),
// receive(msg), snapshot(), onLink(peerId) }.

const COLORS = ['#ffffff', '#ffd23f', '#ff6b6b', '#5fd38d', '#6cb8ff', '#b78cff'];
const WIDTHS = { pen: 3, marker: 14 };
const MAX_IMAGE = 1100;     // сторона вставленной картинки, пикселей
const MAX_IMAGE_BYTES = 150000;
const SEND_CHUNK = 150000;  // байт в одном сообщении синхронизации

const uid = (me) => me.slice(0, 6) + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ------------------------------------------------ хранение на устройстве

function idb() {
  if (!idb.p) {
    idb.p = new Promise((done, fail) => {
      const r = indexedDB.open('zvonilka', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('boards');
      r.onsuccess = () => done(r.result);
      r.onerror = () => fail(r.error);
    });
  }
  return idb.p;
}

async function loadItems(room) {
  try {
    const db = await idb();
    return await new Promise((done) => {
      const r = db.transaction('boards').objectStore('boards').get(room);
      r.onsuccess = () => done(Array.isArray(r.result) ? r.result : []);
      r.onerror = () => done([]);
    });
  } catch (_) { return []; }
}

async function saveItems(room, items) {
  try {
    const db = await idb();
    db.transaction('boards', 'readwrite').objectStore('boards').put(items, room);
  } catch (_) {}
}

// ------------------------------------------------ картинки

function fileToImage(file) {
  return new Promise((done, fail) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); done(img); };
    img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('не картинка')); };
    img.src = url;
  });
}

// Уменьшить и сжать, чтобы картинка помещалась в одно сообщение канала.
function compress(img) {
  let k = Math.min(1, MAX_IMAGE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  for (let q = 0.82; ; q -= 0.12) {
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    const src = c.toDataURL('image/jpeg', Math.max(0.4, q));
    if (src.length < MAX_IMAGE_BYTES || (q < 0.45 && k < 0.3)) return { src, w: c.width, h: c.height };
    if (q < 0.45) { k *= 0.7; q = 0.94; }
  }
}

// ------------------------------------------------ доска

export function createBoard({ root, send, myId, onToggle }) {
  const canvas = root.querySelector('canvas');
  const g = canvas.getContext('2d');
  const panel = root.querySelector('.bpanel');
  const editor = root.querySelector('textarea');
  const items = new Map();      // id → предмет
  const images = new Map();     // id → Image
  const view = { x: 0, y: 0, s: 1 }; // экран = (мир − x) · s
  let room = '', clock = 0, open = false, dirty = true, saveTimer = 0;
  let tool = 'pen', color = COLORS[0], selected = null;
  const undo = [], redo = [];
  const pts = new Map();        // активные касания
  let act = null;               // текущее действие
  let me = myId;

  // ------------------------------------------ предметы и синхронизация

  const alive = () => [...items.values()].filter((it) => !it.del && it.id !== editingId).sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1));

  // Штрих «по ходу» (live) уступает окончательному с тем же временем.
  function newer(a, b) { return !b || a.ts > b.ts || (a.ts === b.ts && (a.by > b.by || (b.live && !a.live))); }

  // Принять предмет (свой или чужой): кто позже, тот прав.
  function apply(it) {
    if (!it || typeof it.id !== 'string' || typeof it.ts !== 'number') return false;
    const have = items.get(it.id);
    if (!newer(it, have)) return false;
    clock = Math.max(clock, it.ts);
    items.set(it.id, it);
    if (it.k === 'image' && !it.del && !images.has(it.id)) {
      const img = new Image();
      img.onload = () => { dirty = true; };
      img.src = it.src;
      images.set(it.id, img);
    }
    dirty = true;
    persist();
    return true;
  }

  // Своё изменение: проставить время, применить, разослать, запомнить для отмены.
  function commit(it, before, history = true) {
    const next = { ...it, ts: ++clock, by: me };
    apply(next);
    send({ items: [next] });
    if (history) { undo.push({ before: before || null, after: next }); redo.length = 0; }
    return next;
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (room) saveItems(room, [...items.values()]); }, 800);
  }

  function receive(m) {
    if (!m || !Array.isArray(m.items)) return;
    let changed = false;
    for (const it of m.items.slice(0, 400)) changed = apply(it) || changed;
    if (changed && !open) onToggle && onToggle('news');
  }

  // Новому собеседнику — всё, что есть на доске, частями.
  function snapshot() {
    const out = [];
    let batch = [], size = 0;
    for (const it of items.values()) {
      const n = JSON.stringify(it).length;
      if (size + n > SEND_CHUNK && batch.length) { out.push({ items: batch }); batch = []; size = 0; }
      batch.push(it);
      size += n;
    }
    if (batch.length) out.push({ items: batch });
    return out;
  }

  async function load(name, id) {
    me = id || me;
    room = name;
    items.clear();
    images.clear();
    undo.length = redo.length = 0;
    for (const it of await loadItems(room)) apply(it);
    fit();
  }

  // ------------------------------------------ вид

  const toWorld = (x, y) => ({ x: x / view.s + view.x, y: y / view.s + view.y });

  // Показать всё, что есть на доске; пустая — в начало координат.
  function fit() {
    const list = alive();
    const W = canvas.clientWidth || innerWidth, H = canvas.clientHeight || innerHeight;
    if (!list.length) { view.s = 1; view.x = -W / 2; view.y = -H / 2; dirty = true; return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of list) { const b = bounds(it); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
    const s = clamp(Math.min(W / (x1 - x0 + 160), H / (y1 - y0 + 220)), 0.2, 1.5);
    view.s = s;
    view.x = (x0 + x1) / 2 - W / 2 / s;
    view.y = (y0 + y1) / 2 - H / 2 / s;
    dirty = true;
  }

  function zoomAt(sx, sy, k) {
    const w = toWorld(sx, sy);
    view.s = clamp(view.s * k, 0.1, 8);
    view.x = w.x - sx / view.s;
    view.y = w.y - sy / view.s;
    dirty = true;
  }

  // ------------------------------------------ рисование

  function bounds(it) {
    if (it.k === 'stroke') {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < it.p.length; i += 2) { x0 = Math.min(x0, it.p[i]); x1 = Math.max(x1, it.p[i]); y0 = Math.min(y0, it.p[i + 1]); y1 = Math.max(y1, it.p[i + 1]); }
      const r = it.w / 2 + 4;
      return { x0: it.x + x0 - r, y0: it.y + y0 - r, x1: it.x + x1 + r, y1: it.y + y1 + r };
    }
    if (it.k === 'text') {
      const lines = String(it.t).split('\n');
      g.font = `500 ${it.size}px -apple-system, system-ui, sans-serif`;
      const w = Math.max(...lines.map((l) => g.measureText(l).width), 20);
      return { x0: it.x, y0: it.y, x1: it.x + w, y1: it.y + lines.length * it.size * 1.25 };
    }
    return { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h };
  }

  function wrap(text, width, font) {
    g.font = font;
    const out = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const t = line ? line + ' ' + word : word;
        if (g.measureText(t).width > width && line) { out.push(line); line = word; } else line = t;
      }
      out.push(line);
    }
    return out;
  }

  function drawItem(it) {
    if (it.k === 'stroke') {
      const p = it.p;
      g.strokeStyle = it.c;
      g.lineWidth = it.w;
      g.globalAlpha = it.m ? 0.45 : 1;
      g.lineCap = g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(it.x + p[0], it.y + p[1]);
      if (p.length === 2) g.lineTo(it.x + p[0] + 0.1, it.y + p[1]);
      for (let i = 2; i < p.length - 2; i += 2) {
        const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
        g.quadraticCurveTo(it.x + p[i], it.y + p[i + 1], it.x + mx, it.y + my);
      }
      if (p.length > 2) g.lineTo(it.x + p[p.length - 2], it.y + p[p.length - 1]);
      g.stroke();
      g.globalAlpha = 1;
    } else if (it.k === 'text') {
      g.fillStyle = it.c;
      g.font = `500 ${it.size}px -apple-system, system-ui, sans-serif`;
      g.textBaseline = 'top';
      String(it.t).split('\n').forEach((l, i) => g.fillText(l, it.x, it.y + i * it.size * 1.25));
    } else if (it.k === 'note') {
      g.fillStyle = it.c;
      roundRect(it.x, it.y, it.w, it.h, 14);
      g.fill();
      g.fillStyle = '#1a1a1a';
      const font = '500 17px -apple-system, system-ui, sans-serif';
      wrap(it.t, it.w - 32, font).slice(0, Math.floor((it.h - 28) / 22)).forEach((l, i) => { g.textBaseline = 'top'; g.fillText(l, it.x + 16, it.y + 16 + i * 22); });
      if (it.from) { g.fillStyle = 'rgba(0,0,0,.45)'; g.font = '500 12px -apple-system, system-ui, sans-serif'; g.fillText(it.from, it.x + 16, it.y + it.h - 22); }
    } else if (it.k === 'image') {
      const img = images.get(it.id);
      g.save();
      roundRect(it.x, it.y, it.w, it.h, 10);
      g.clip();
      if (img && img.complete && img.naturalWidth) g.drawImage(img, it.x, it.y, it.w, it.h);
      else { g.fillStyle = '#222'; g.fillRect(it.x, it.y, it.w, it.h); }
      g.restore();
    }
  }

  function roundRect(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function render() {
    requestAnimationFrame(render);
    if (!open || !dirty) return;
    dirty = false;
    const dpr = devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    // Точки сетки: видно, что холст бесконечный и куда он сдвинулся.
    const step = 32 * view.s;
    if (step > 9) {
      g.fillStyle = 'rgba(255,255,255,.09)';
      const ox = -view.x * view.s % step, oy = -view.y * view.s % step;
      for (let x = ox; x < W; x += step) for (let y = oy; y < H; y += step) g.fillRect(x - 1, y - 1, 2, 2);
    }
    g.setTransform(dpr * view.s, 0, 0, dpr * view.s, -view.x * view.s * dpr, -view.y * view.s * dpr);
    for (const it of alive()) drawItem(it);
    if (act && act.kind === 'draw') drawItem(act.item);
    const sel = selected && items.get(selected);
    if (sel && !sel.del) {
      const b = bounds(sel);
      g.strokeStyle = '#6cb8ff';
      g.lineWidth = 2 / view.s;
      g.setLineDash([6 / view.s, 5 / view.s]);
      g.strokeRect(b.x0 - 6 / view.s, b.y0 - 6 / view.s, b.x1 - b.x0 + 12 / view.s, b.y1 - b.y0 + 12 / view.s);
      g.setLineDash([]);
    }
    root.classList.toggle('empty', !alive().length);
  }
  requestAnimationFrame(render);

  // ------------------------------------------ попадание и ластик

  function distSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    const t = l ? clamp(((px - ax) * dx + (py - ay) * dy) / l, 0, 1) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }

  function hit(wx, wy, slop) {
    const list = alive();
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (it.k === 'stroke') {
        const p = it.p, r = it.w / 2 + slop;
        if (p.length === 2 && Math.hypot(wx - it.x - p[0], wy - it.y - p[1]) < r) return it;
        for (let j = 0; j < p.length - 2; j += 2) if (distSeg(wx, wy, it.x + p[j], it.y + p[j + 1], it.x + p[j + 2], it.y + p[j + 3]) < r) return it;
      } else {
        const b = bounds(it);
        if (wx >= b.x0 - slop && wx <= b.x1 + slop && wy >= b.y0 - slop && wy <= b.y1 + slop) return it;
      }
    }
    return null;
  }

  function erase(it) {
    if (!it || it.del) return;
    commit({ ...it, del: true }, it);
    if (selected === it.id) selected = null;
  }

  // ------------------------------------------ касания и мышь

  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  let spaceHeld = false;

  canvas.addEventListener('pointerdown', (e) => {
    if (editing) commitEdit();
    canvas.setPointerCapture(e.pointerId);
    const p = local(e);
    pts.set(e.pointerId, p);
    hidePanel(e.pointerType !== 'mouse');
    if (pts.size === 2) {
      // Два пальца: двигать и приближать холст; начатый штрих отменяется.
      const [a, b] = [...pts.values()];
      act = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: view.s, w0: toWorld((a.x + b.x) / 2, (a.y + b.y) / 2) };
      dirty = true;
      return;
    }
    if (pts.size > 2) return;
    const w = toWorld(p.x, p.y);
    const pan = e.button === 1 || spaceHeld || tool === 'hand';
    if (pan) {
      const it = tool === 'hand' && !spaceHeld && e.button === 0 ? hit(w.x, w.y, 6 / view.s) : null;
      if (it) { selected = it.id; act = { kind: 'move', it, before: it, w0: w, x0: it.x, y0: it.y }; }
      else { selected = null; act = { kind: 'pan', p0: p, vx: view.x, vy: view.y }; }
      dirty = true;
      return;
    }
    if (tool === 'eraser') { act = { kind: 'erase' }; erase(hit(w.x, w.y, 8 / view.s)); return; }
    if (tool === 'text') {
      const it = hit(w.x, w.y, 4 / view.s);
      if (it && (it.k === 'text' || it.k === 'note')) startEdit(it);
      else startEdit({ id: uid(me), k: 'text', x: w.x, y: w.y - 14, t: '', c: color, size: 28, z: Date.now() });
      act = null;
      return;
    }
    // Перо и маркер.
    const marker = tool === 'marker';
    act = { kind: 'draw', item: { id: uid(me), k: 'stroke', x: w.x, y: w.y, p: [0, 0], c: color, w: (marker ? WIDTHS.marker : WIDTHS.pen) / Math.sqrt(view.s), m: marker, z: Date.now() }, sent: 0 };
    dirty = true;
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') nearBottom(e.clientY);
    const p = pts.get(e.pointerId);
    if (!p) return;
    Object.assign(p, local(e));
    if (!act) return;
    if (act.kind === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      view.s = clamp(act.s0 * Math.hypot(a.x - b.x, a.y - b.y) / act.d0, 0.1, 8);
      view.x = act.w0.x - mx / view.s;
      view.y = act.w0.y - my / view.s;
      dirty = true;
    } else if (act.kind === 'pan') {
      view.x = act.vx - (p.x - act.p0.x) / view.s;
      view.y = act.vy - (p.y - act.p0.y) / view.s;
      dirty = true;
    } else if (act.kind === 'move') {
      const w = toWorld(p.x, p.y);
      act.it = { ...act.it, x: act.x0 + w.x - act.w0.x, y: act.y0 + w.y - act.w0.y };
      items.set(act.it.id, act.it);
      dirty = true;
    } else if (act.kind === 'erase') {
      const w = toWorld(p.x, p.y);
      erase(hit(w.x, w.y, 8 / view.s));
    } else if (act.kind === 'draw') {
      const w = toWorld(p.x, p.y), it = act.item, n = it.p.length;
      const dx = w.x - it.x, dy = w.y - it.y;
      if (Math.hypot(dx - it.p[n - 2], dy - it.p[n - 1]) * view.s < 1.5) return;
      it.p.push(Math.round(dx * 10) / 10, Math.round(dy * 10) / 10);
      dirty = true;
      // Остальные видят штрих по ходу, а не только когда палец отпущен.
      const now = performance.now();
      if (now - act.sent > 70) { act.sent = now; send({ items: [{ ...it, p: it.p.slice(), ts: clock + 1, by: me, live: true }] }); }
    }
  });

  const end = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (act && act.kind === 'pinch') { if (!pts.size) act = null; return; }
    if (!act) return;
    if (act.kind === 'draw') {
      const it = commit(act.item);
      if (it.p.length === 2) dots.push({ id: it.id, t: performance.now() }); // точка от щелчка: вдруг это начало двойного
    }
    else if (act.kind === 'move' && (act.it.x !== act.before.x || act.it.y !== act.before.y)) { items.set(act.before.id, act.before); commit(act.it, act.before); }
    act = null;
    dirty = true;
    showPanelSoon();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    if (e.ctrlKey || e.metaKey) zoomAt(p.x, p.y, Math.exp(-clamp(e.deltaY, -40, 40) * 0.01)); // щипок на тачпаде
    else { view.x += e.deltaX / view.s; view.y += e.deltaY / view.s; dirty = true; }
  }, { passive: false });

  // Двойной щелчок пером успевает поставить две точки — они не нужны, убираем без следа в отмене.
  const dots = [];
  function dropDots() {
    const now = performance.now();
    for (const d of dots.splice(0)) {
      const it = items.get(d.id);
      if (it && !it.del && now - d.t < 700) { commit({ ...it, del: true }, null, false); const i = undo.findIndex((u) => u.after.id === d.id); if (i >= 0) undo.splice(i, 1); }
    }
  }

  canvas.addEventListener('dblclick', (e) => {
    dropDots();
    const p = local(e), w = toWorld(p.x, p.y), it = hit(w.x, w.y, 4 / view.s);
    if (it && (it.k === 'text' || it.k === 'note')) startEdit(it);
    else if (!it) startEdit({ id: uid(me), k: 'text', x: w.x, y: w.y - 14, t: '', c: color, size: 28, z: Date.now() });
  });

  // ------------------------------------------ текст

  let editing = null, editingId = null; // что сейчас пишем; на холсте этот предмет не рисуется

  function startEdit(it) {
    if (!it) return;
    editing = { it, prev: items.get(it.id) };
    editingId = it.id;
    const s = view.s;
    editor.value = it.t || '';
    editor.style.left = (it.x - view.x) * s + 'px';
    editor.style.top = (it.y - view.y) * s + 'px';
    editor.style.fontSize = (it.k === 'note' ? 17 : it.size) * s + 'px';
    editor.style.color = it.k === 'note' ? '#1a1a1a' : it.c;
    editor.style.background = it.k === 'note' ? it.c : 'transparent';
    editor.style.width = (it.k === 'note' ? it.w * s : Math.max(240, innerWidth - (it.x - view.x) * s - 24)) + 'px';
    editor.hidden = false;
    dirty = true;
    setTimeout(() => editor.focus(), 0);
  }

  function commitEdit() {
    if (!editing) return;
    const { it, prev } = editing;
    editing = null;
    editingId = null;
    editor.hidden = true;
    dirty = true;
    const t = editor.value.replace(/\s+$/, '');
    const old = prev && !prev.del ? prev : null;
    if (!t) { if (old) commit({ ...old, del: true }, old); return; }
    if (!old || old.t !== t) commit({ ...(old || it), t, del: false }, old);
  }

  editor.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); commitEdit(); }
  });
  editor.addEventListener('blur', () => commitEdit());

  // ------------------------------------------ вставка и перетаскивание

  // Куда положить вставленное: середина экрана, а если там уже что-то лежит — рядом, наискосок.
  function center(w = 0, h = 0) {
    const c = toWorld(canvas.clientWidth / 2, canvas.clientHeight / 2);
    for (let i = 0; i < 12; i++) {
      const box = { x0: c.x - w / 2, y0: c.y - h / 2, x1: c.x + w / 2, y1: c.y + h / 2 };
      if (!alive().some((it) => { const b = bounds(it); return b.x0 < box.x1 && b.x1 > box.x0 && b.y0 < box.y1 && b.y1 > box.y0; })) break;
      c.x += 36 / view.s;
      c.y += 36 / view.s;
    }
    return c;
  }

  // Вставленное должно быть видно целиком: вид подъезжает к нему (и отдаляется, если не влезает).
  function reveal(it) {
    const b = bounds(it), m = 24;
    const W = canvas.clientWidth, H = canvas.clientHeight - (innerWidth < 640 ? 170 : 90); // над панелью
    const s = Math.min(view.s, (W - 2 * m) / (b.x1 - b.x0), (H - 2 * m) / (b.y1 - b.y0));
    if (s < view.s) view.s = Math.max(0.1, s);
    const x0 = view.x + m / view.s, y0 = view.y + m / view.s, x1 = view.x + (W - m) / view.s, y1 = view.y + (H - m) / view.s;
    if (b.x0 < x0) view.x -= x0 - b.x0; else if (b.x1 > x1) view.x += b.x1 - x1;
    if (b.y0 < y0) view.y -= y0 - b.y0; else if (b.y1 > y1) view.y += b.y1 - y1;
    dirty = true;
  }

  async function addImage(file, at) {
    try {
      const { src, w, h } = compress(await fileToImage(file));
      const k = Math.min(1, Math.min(420, canvas.clientWidth * 0.7) / Math.max(w, h)) / view.s;
      const c = at || center(w * k, h * k);
      const it = commit({ id: uid(me), k: 'image', x: c.x - w * k / 2, y: c.y - h * k / 2, w: w * k, h: h * k, src, z: Date.now() });
      if (!at) reveal(it);
    } catch (_) {}
  }

  function addNote(text, at, from) {
    const lines0 = wrap(String(text), 240, '500 17px -apple-system, system-ui, sans-serif').length;
    const c = at || center(272, clamp(lines0 * 22 + 32, 80, 420));
    const lines = wrap(text, 240, '500 17px -apple-system, system-ui, sans-serif').length;
    const h = clamp(lines * 22 + 32 + (from ? 20 : 0), 80, 420);
    const it = commit({ id: uid(me), k: 'note', x: c.x - 136, y: c.y - h / 2, w: 272, h, t: String(text).slice(0, 2000), c: COLORS[1], z: Date.now(), ...(from ? { from } : {}) });
    selected = it.id;
    if (!at) reveal(it);
  }

  function onPaste(e) {
    if (!open || editing) return;
    const data = e.clipboardData;
    if (!data) return;
    const file = [...data.files].find((f) => f.type.startsWith('image/'));
    if (file) { e.preventDefault(); addImage(file); return; }
    const text = data.getData('text/plain');
    if (text && text.trim()) { e.preventDefault(); addNote(text.trim()); }
  }
  addEventListener('paste', onPaste);

  root.addEventListener('dragover', (e) => { e.preventDefault(); });
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    const p = local(e), at = toWorld(p.x, p.y);
    const file = [...(e.dataTransfer && e.dataTransfer.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) addImage(file, at);
    else { const t = e.dataTransfer && e.dataTransfer.getData('text/plain'); if (t) addNote(t, at); }
  });

  // ------------------------------------------ отмена

  function step(from, to) {
    const op = from.pop();
    if (!op) return;
    to.push(op);
    const target = from === undo ? op.before : op.after;
    const cur = items.get(op.after.id);
    commit(target ? { ...target, del: !!target.del } : { ...cur, del: true }, null, false);
  }

  // ------------------------------------------ клавиши

  const TOOLS = { p: 'pen', m: 'marker', e: 'eraser', t: 'text', h: 'hand' };

  function onKey(e) {
    if (!open || editing) return;
    const el = e.target instanceof Element ? e.target : null;
    if (el && el.closest('input, textarea, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.code === 'KeyZ') { e.preventDefault(); e.stopImmediatePropagation(); step(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo); return; }
    if (mod && e.code === 'KeyY') { e.preventDefault(); e.stopImmediatePropagation(); step(redo, undo); return; }
    if (mod) return;
    if (e.code === 'Space') { spaceHeld = true; canvas.classList.add('grab'); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if ((e.key === 'Backspace' || e.key === 'Delete') && selected) { erase(items.get(selected)); e.preventDefault(); e.stopImmediatePropagation(); return; }
    const t = TOOLS[e.key.toLowerCase()] || TOOLS[{ KeyP: 'p', KeyM: 'm', KeyE: 'e', KeyT: 't', KeyH: 'h' }[e.code]];
    if (t) { setTool(t); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.key === '0') { fit(); e.stopImmediatePropagation(); }
    if (e.key.length === 1 || e.key === 'Enter') e.stopImmediatePropagation(); // буквы на доске не открывают чат
  }
  addEventListener('keydown', onKey, true);
  addEventListener('keyup', (e) => { if (e.code === 'Space' && spaceHeld) { spaceHeld = false; canvas.classList.remove('grab'); if (open) e.stopImmediatePropagation(); } }, true);

  // ------------------------------------------ панель инструментов

  function setTool(t) {
    tool = t;
    selected = null;
    for (const b of panel.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
    canvas.dataset.tool = t;
    dirty = true;
  }

  function setColor(c) {
    color = c;
    for (const b of panel.querySelectorAll('[data-color]')) b.classList.toggle('on', b.dataset.color === c);
    if (tool === 'eraser' || tool === 'hand') setTool('pen');
    const sel = selected && items.get(selected);
    if (sel && !sel.del && sel.k !== 'image') commit({ ...sel, c }, sel); // перекрасить выделенное
  }

  for (const c of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.color = c;
    b.style.setProperty('--c', c);
    b.setAttribute('aria-label', 'Цвет');
    panel.querySelector('.colors').append(b);
  }
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) setTool(b.dataset.tool);
    else if (b.dataset.color) setColor(b.dataset.color);
    else if (b.dataset.act === 'undo') step(undo, redo);
    else if (b.dataset.act === 'note') { addNote('Заметка'); startEdit(items.get(selected)); }
    else if (b.dataset.act === 'image') root.querySelector('input[type=file]').click();
  });
  root.querySelector('input[type=file]').addEventListener('change', (e) => {
    for (const f of e.target.files) addImage(f);
    e.target.value = '';
  });

  // Панель прячется, пока рисуешь, и выходит, когда мышь у нижнего края или палец отпущен.
  let panelTimer = 0;
  function hidePanel(touch) {
    clearTimeout(panelTimer);
    if (touch) root.classList.add('quiet');
  }
  function showPanelSoon() {
    clearTimeout(panelTimer);
    panelTimer = setTimeout(() => root.classList.remove('quiet'), 500);
  }
  function nearBottom(y) {
    root.classList.toggle('quiet', y < innerHeight - 140 && !panel.matches(':hover'));
  }

  // ------------------------------------------ открыть и закрыть

  function setOpen(on) {
    if (on === open) return;
    open = on;
    root.hidden = !on;
    root.classList.toggle('quiet', false);
    if (on) { dirty = true; fit(); } // открыли — видно всё, что на доске
    else { if (editing) commitEdit(); act = null; pts.clear(); }
    onToggle && onToggle(on ? 'open' : 'close');
  }

  addEventListener('resize', () => { dirty = true; });
  setTool('pen');
  setColor(COLORS[0]);

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
    load,
    receive,
    snapshot,
    addNote,
    fit,
    count: () => alive().length,
    items: () => alive(),
  };
}
