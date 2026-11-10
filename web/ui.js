// Звонилка — интерфейс звонка (docs/UX.md). Сам звонок — в call.js.
//
// На экране люди, а не кнопки: плитки занимают всё место и плавно перестраиваются, панель из
// пяти значков прячется сама. Остальное делается жестами, знакомыми по галерее, плееру и
// мессенджеру: коснулся человека — он крупно, щипок — приблизить, зажал и повёл — его
// громкость, смахнул — следующий, начал печатать — сообщение, удержал микрофон — сказал.

import * as call from './call.js';

const { me, peers, prefs, savePrefs } = call;
const TG_BOT = 'StartNewCallBot'; // бот, у которого эта страница — Mini App

const $ = (id) => document.getElementById(id);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const quiet = (fn) => { try { return fn(); } catch (_) { return undefined; } };
const query = new URLSearchParams(location.search);
const ua = navigator.userAgent;
const phone = /Android|iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const coarse = matchMedia('(pointer: coarse)').matches;
const canShare = !phone && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
// На iPhone громкость элемента менять нельзя — там человека можно только заглушить.
const canVolume = (() => { const v = document.createElement('video'); quiet(() => { v.volume = 0.5; }); return v.volume === 0.5; })();
const EASE = 'cubic-bezier(.22, .9, .24, 1)';

const stage = $('stage'), callEl = $('call'), bar = $('bar'), hud = $('hud'), sheet = $('sheet');

// ---------------------------------------------------------------- Telegram

const inTg = /tgWebApp/.test(location.hash + location.search) || !!window.TelegramWebviewProxy;
let tg = null;      // Telegram.WebApp, когда страница открыта как Mini App
let tgBot = TG_BOT;
let tgName = '';

// Внутри Telegram комната приходит стартовым параметром, имя — из профиля.
async function initTelegram() {
  if (!inTg) return;
  await new Promise((done) => {
    const s = document.createElement('script');
    s.src = 'https://telegram.org/js/telegram-web-app.js';
    s.onload = s.onerror = done;
    document.head.append(s);
  });
  const app = window.Telegram && window.Telegram.WebApp;
  if (!app || !app.platform || app.platform === 'unknown') return;
  tg = app;
  quiet(() => tg.ready());
  quiet(() => tg.expand());
  quiet(() => tg.setHeaderColor('#000000'));
  quiet(() => tg.setBackgroundColor('#000000'));
  if (tg.isVersionAtLeast('7.10')) quiet(() => tg.setBottomBarColor('#000000'));
  if (tg.isVersionAtLeast('7.7')) quiet(() => tg.disableVerticalSwipes());
  if (tg.isVersionAtLeast('6.1')) quiet(() => tg.BackButton.onClick(back));
  const user = tg.initDataUnsafe && tg.initDataUnsafe.user;
  if (user) tgName = call.cleanName(user.first_name);
}

// «Назад» в шапке Telegram закрывает то, что открыто, — как системная кнопка на телефоне.
function syncBack() {
  if (!tg || !tg.isVersionAtLeast('6.1')) return;
  const open = me.joined && (!sheet.hidden || chatOpen || immersive || inPresent());
  quiet(() => (open ? tg.BackButton.show() : tg.BackButton.hide()));
}

function startRoom() {
  const param = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || query.get('tgWebAppStartParam') || '';
  return param ? call.paramRoom(param) : '';
}

// ---------------------------------------------------------------- приглашение

const browserLink = () => location.origin + location.pathname + '#' + encodeURIComponent(me.room);
const telegramLink = () => `https://t.me/${tgBot}?startapp=${call.roomParam(me.room)}`;
// Внутри Telegram зовём ссылкой, которая открывает Mini App; в браузере — ссылкой на страницу.
const inviteLink = () => (tg ? telegramLink() : browserLink());

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
  const area = document.createElement('textarea');
  area.value = text;
  area.style.cssText = 'position:fixed;opacity:0';
  document.body.append(area);
  area.select();
  const ok = !!quiet(() => document.execCommand('copy'));
  area.remove();
  return ok;
}

async function copyInvite() {
  buzz();
  toast((await copyText(inviteLink())) ? 'Ссылка скопирована' : inviteLink());
}

function shareInvite() {
  const link = inviteLink(), text = 'Заходите в звонок';
  if (tg) {
    const sent = quiet(() => { tg.openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text)); return true; });
    if (sent) return;
  }
  if (navigator.share) { navigator.share({ title: 'Звонилка', text, url: link }).catch(() => {}); return; }
  copyInvite();
}

// ---------------------------------------------------------------- звук и отдача

let actx = null;   // один звуковой контекст: измеритель своего микрофона и два сигнала
let meter = null;

function audio() {
  if (!actx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    actx = quiet(() => new Ctx()) || null;
    if (!actx) return null;
  }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}

// Слушает свой микрофон: по нему светится своя плитка и видно, что человек говорит,
// забыв включить микрофон.
function attachMeter() {
  if (meter) { quiet(() => meter.src.disconnect()); meter = null; }
  const ctx = me.audio && audio();
  if (!ctx) return;
  quiet(() => {
    const src = ctx.createMediaStreamSource(new MediaStream([me.audio]));
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    meter = { src, an, buf: new Float32Array(an.fftSize) };
  });
}

function micLevel() {
  if (!meter || actx.state !== 'running') return 0;
  meter.an.getFloatTimeDomainData(meter.buf);
  let sum = 0;
  for (const x of meter.buf) sum += x * x;
  return Math.min(1, Math.sqrt(sum / meter.buf.length) * 5);
}

// Две тихие ноты: вверх — кто-то вошёл, вниз — вышел. Слышно, даже если не смотришь на экран.
function chime(up) {
  const ctx = audio();
  if (!ctx || ctx.state !== 'running') return;
  const notes = up ? [659.25, 987.77] : [987.77, 659.25];
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    const at = ctx.currentTime + i * 0.11;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.05, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.34);
  });
}

// Лёгкий толчок под пальцем там, где телефон это умеет. Браузер разрешает его только после
// первого касания страницы.
function buzz(strong) {
  quiet(() => {
    if (tg && tg.HapticFeedback && tg.isVersionAtLeast('6.1')) tg.HapticFeedback.impactOccurred(strong ? 'medium' : 'light');
    else if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(strong ? 14 : 7);
  });
}

// ---------------------------------------------------------------- значки

const ICONS = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.500 11a6.500 6.500 0 0 0 13 0M12 17.500V21"/>',
  micOff: '<path d="M9 9V6a3 3 0 0 1 5.700-1.300M15 10v1a3 3 0 0 1-4.800 2.400M5.500 11a6.500 6.500 0 0 0 10.400 5.200M18.500 11a6.500 6.500 0 0 1-.600 2.700M12 17.500V21M4 4l16 16"/>',
  cam: '<rect x="3" y="6.500" width="12.500" height="11" rx="3"/><path d="M15.500 10.500l5.500-3v9l-5.500-3"/>',
  camOff: '<path d="M10 6.500h2.500a3 3 0 0 1 3 3v1l5.500-3v9l-3.300-1.800M15.300 15.500a3 3 0 0 1-2.800 2H6a3 3 0 0 1-3-3v-5a3 3 0 0 1 2-2.800M4 4l16 16"/>',
  screen: '<rect x="3" y="4.500" width="18" height="12.500" rx="2.500"/><path d="M8.500 20.500h7M12 13.500v-5M9.500 10.800L12 8.300l2.500 2.500"/>',
  chat: '<path d="M12 4.500c4.700 0 8.500 3.100 8.500 7s-3.800 7-8.500 7c-1 0-2-.100-2.900-.400L5 20l.900-3.400c-1.500-1.300-2.400-3.100-2.400-5.100 0-3.900 3.800-7 8.500-7z"/>',
  leave: '<path d="M12 9c-1.600 0-3.150.250-4.600.720v3.100c0 .390-.230.740-.560.900-.980.490-1.870 1.120-2.660 1.850-.180.180-.430.280-.700.280-.280 0-.530-.110-.710-.290L.290 13.080a.990.990 0 0 1 0-1.410C3.340 8.780 7.460 7 12 7s8.660 1.780 11.710 4.670a.990.990 0 0 1 0 1.410l-2.480 2.480c-.180.180-.430.290-.710.290-.270 0-.520-.110-.700-.280a11.300 11.300 0 0 0-2.670-1.850.990.990 0 0 1-.560-.900v-3.100C15.150 9.250 13.600 9 12 9z" fill="currentColor" stroke="none" transform="translate(0 .500)"/>',
  close: '<path d="M6.500 6.500l11 11M17.500 6.500l-11 11"/>',
  send: '<path d="M12 19V5.500M6 11.500l6-6 6 6"/>',
  go: '<path d="M5 12h13.500M13 6.500l5.500 5.500-5.500 5.500"/>',
  grid: '<rect x="4.500" y="4.500" width="6" height="6" rx="1.500"/><rect x="13.500" y="4.500" width="6" height="6" rx="1.500"/><rect x="4.500" y="13.500" width="6" height="6" rx="1.500"/><rect x="13.500" y="13.500" width="6" height="6" rx="1.500"/>',
  chevron: '<path d="M7.500 10l4.500 4.500 4.500-4.500"/>',
  volume: '<path d="M4 9.500v5h3.500l4.500 4v-13l-4.500 4zM15.500 9a4.500 4.500 0 0 1 0 6M18 6.500a8 8 0 0 1 0 11"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// ---------------------------------------------------------------- уведомления и подсказки

function toast(text, action, run, ms) {
  const el = document.createElement('div');
  el.className = 'toast glass';
  el.textContent = text;
  const drop = () => { el.classList.add('out'); setTimeout(() => el.remove(), 320); };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action;
    b.onclick = () => { drop(); run(); };
    el.append(b);
  }
  const box = $('toasts');
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(drop, ms || (action ? 12000 : 4200));
}

// Подсказка о жесте: один раз в жизни, в тот момент, когда жест пригодится, и по одной.
const hints = [];
let hintBusy = false;

function hint(key, text) {
  if (prefs.hints[key] || hints.some((h) => h.key === key)) return;
  hints.push({ key, text });
  pumpHints();
}

function pumpHints() {
  if (hintBusy || !hints.length || !me.joined) return;
  const h = hints.shift();
  hintBusy = true;
  prefs.hints[h.key] = 1;
  savePrefs();
  toast(h.text, null, null, 6500);
  setTimeout(() => { hintBusy = false; pumpHints(); }, 9000);
}

// ---------------------------------------------------------------- плитки

const tiles = new Map(); // ключ → плитка: участник или его экран
const NOTE = { new: 'Соединение…', connecting: 'Соединение…', reconnecting: 'Переподключение…', blocked: 'Нет прямого пути' };
// Почему соединение не установилось — словами, а не вечным «Соединение…».
const WHY = {
  silent: 'Собеседник не отвечает',
  nat: 'Сети не пропускают прямой путь',
  hidden: 'Сети скрывают адреса устройств',
  'relay-failed': 'Не вышло даже через ретранслятор',
};
// Два устройства одного человека называются одинаково — различаем их по виду устройства.
const shownName = (p) => (p.dev && (p.name === me.name || [...peers.values()].some((q) => q !== p && q.name === p.name)) ? `${p.name} · ${p.dev}` : p.name);
const initial = (name) => ([...String(name).trim()][0] || '?').toUpperCase();

// Что сейчас должно быть на экране: по плитке на человека и на каждый чужой показ экрана.
// Свой экран себе не показываем: вышел бы коридор зеркал.
function describe() {
  const list = [];
  for (const p of peers.values()) {
    const on = p.status === 'connected';
    const sharing = on && p.state.screen && !!p.scr;
    list.push({ key: p.id, kind: 'cam', peer: p, name: shownName(p), hue: p.hue, stream: p.cam, video: on && p.state.cam, muted: !p.state.mic, sharing, note: (p.status === 'blocked' && WHY[p.why]) || NOTE[p.status] || '' });
    if (sharing) list.push({ key: 's:' + p.id, kind: 'screen', peer: p, name: `${p.name} — экран`, hue: p.hue, stream: p.scr, video: true, muted: false, note: '' });
  }
  list.push({ key: 'me', kind: 'cam', self: true, name: 'Вы', hue: me.hue, stream: me.camStream, video: me.cam, muted: !me.mic, sharing: me.screen, note: '' });
  return list;
}

function makeTile(d) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.key = d.key;
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = !!d.self;
  video.setAttribute('playsinline', '');
  video.setAttribute('disablepictureinpicture', '');
  video.addEventListener('resize', renderSoon); // стал известен размер кадра — от него зависит раскладка
  const orb = document.createElement('div');
  orb.className = 'orb';
  const ball = document.createElement('i');
  const letter = document.createElement('span');
  ball.append(letter);
  orb.append(ball);
  const label = document.createElement('div');
  label.className = 'label';
  label.innerHTML = icon('micOff') + icon('screen'); // «микрофон выключен» и «показывает экран»
  label.firstChild.setAttribute('class', 'mute');
  label.lastChild.setAttribute('class', 'share');
  const name = document.createElement('span');
  const badge = document.createElement('em'); // «тише обычного»: чтобы было понятно, почему человека плохо слышно
  badge.hidden = true;
  badge.innerHTML = icon('volume') + '<span></span>';
  label.append(name, badge);
  const note = document.createElement('div');
  note.className = 'note';
  el.append(video, orb, label, note);
  const t = { key: d.key, d, el, video, letter, name, badge, note, rect: null, role: '', fit: null, zoom: null, busy: false, timer: 0, dragging: false, fresh: true, lvl: 0, shown: 0 };
  tiles.set(d.key, t);
  stage.append(el);
  return t;
}

function removeTile(t) {
  tiles.delete(t.key);
  t.el.classList.add('gone');
  setTimeout(() => { t.video.srcObject = null; t.el.remove(); }, 340);
}

function syncTiles(list) {
  const keep = new Set();
  for (const d of list) {
    keep.add(d.key);
    const t = tiles.get(d.key) || makeTile(d);
    t.d = d;
    if (t.video.srcObject !== (d.stream || null)) t.video.srcObject = d.stream || null;
    if (d.self) t.video.muted = true; else applyVol(t);
    const cl = t.el.classList;
    cl.toggle('screen', d.kind === 'screen');
    cl.toggle('no-video', !d.video);
    cl.toggle('muted', d.kind === 'cam' && d.muted);
    cl.toggle('sharing', !!d.sharing);
    cl.toggle('mirror', !!d.self && me.facing === 'user');
    cl.toggle('has-note', !!d.note);
    t.el.style.setProperty('--hue', d.hue);
    t.note.textContent = d.note;
    t.name.textContent = d.name;
    t.letter.textContent = initial(d.self ? me.name : d.name);
  }
  for (const t of [...tiles.values()]) if (!keep.has(t.key)) removeTile(t);
}

function play(video) {
  if (!video.srcObject || !video.paused) return;
  const p = video.play();
  if (p) p.catch((e) => { if (e && e.name === 'NotAllowedError' && !video.muted) $('hear').hidden = false; });
}

// ---------------------------------------------------------------- раскладка

// Все плитки лежат на одной сцене и получают место числами, поэтому любая перестановка —
// плавный переезд, а не скачок. Четыре вида: один; двое (собеседник во весь экран, вы в углу);
// сетка; кто-то крупно, остальные лентой.
const view = { mode: 'solo', big: null, keys: [], list: [] };
let pinned = null;      // кого человек сам вывел крупно; 'grid' — сам вернул сетку
let immersive = false;  // крупная плитка заняла весь экран, остальное спрятано
let screensKey = '';

function insets() {
  const cs = getComputedStyle($('safe'));
  return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
}

const aspect = (t) => (t && t.video.videoWidth && t.video.videoHeight ? t.video.videoWidth / t.video.videoHeight : 0);

// Какой формы может быть плитка. Экран не режем вовсе. Кадр с камеры можно подрезать по бокам
// (человек обычно в центре), а сверху и снизу — совсем немного, иначе пострадает лицо: поэтому
// человек с телефона получает высокую плитку, а не широкую с обрезанной головой. Пока кадра
// нет — годится почти любая форма.
function shapeOf(t, cropH, cropW) {
  const a = t.d.video ? aspect(t) : 0;
  if (!a) return { a: 0, lo: 3 / 4, hi: 16 / 9 };
  if (t.d.kind === 'screen') return { a, lo: a, hi: a };
  return { a, lo: a / cropW, hi: a * cropH };
}

// Наибольший прямоугольник допустимой формы в ячейке w × h и то, во сколько раз обрезан кадр.
function shapeIn(s, w, h) {
  const ar = clamp(w / h, s.lo, s.hi);
  const size = ar < w / h ? { w: h * ar, h } : { w, h: w / ar };
  return { ...size, crop: s.a ? Math.max(ar / s.a, s.a / ar) : 1 };
}

// Раскладывает плитки в области рядами одной высоты, как фотографии в галерее: ширина каждой —
// по её кадру, поэтому человек с телефона стоит рядом с человеком за компьютером и никто не
// обрезан. Из вариантов «сколько в ряд» выбирает тот, где людей видно крупнее всего.
function fitGrid(shapes, R, gap, top) {
  const n = shapes.length;
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = [];
    for (let i = 0; i < n; i += cols) rows.push(shapes.slice(i, i + cols).map((s) => ({ s, ar: s.a || 1 })));
    const across = (row) => R.w - gap * (row.length - 1);            // ширина ряда без промежутков
    const down = R.h - gap * (rows.length - 1);                       // высота всех рядов без промежутков
    const sum = (row) => row.reduce((total, c) => total + c.ar, 0);
    // Высота ряда: чтобы самый широкий ряд влез по ширине, а все вместе — по высоте.
    let h = down / rows.length;
    for (const row of rows) h = Math.min(h, across(row) / sum(row));
    if (h <= 0) continue;
    // Остаток места плитки добирают сами: с камерой — чуть подрезая кадр, без камеры — сколько
    // нужно (там резать нечего). Сначала вширь, потом ввысь.
    for (const row of rows) {
      const f = across(row) / (h * sum(row));
      for (const c of row) c.ar = Math.max(c.ar, Math.min(c.s.hi, c.ar * (c.s.a ? Math.min(1.12, f) : f)));
    }
    let v = Math.min(1.25, down / (h * rows.length));
    for (const row of rows) for (const c of row) v = Math.min(v, c.ar / c.s.lo);
    v = Math.max(1, v);
    // Счёт — видимая площадь кадров; плитка без камеры стоит меньше: смотреть в ней не на что.
    let score = 0;
    for (const row of rows) {
      for (const c of row) {
        c.w = h * c.ar;
        c.h = h * v;
        const crop = c.s.a ? Math.max(c.w / c.h / c.s.a, c.s.a * c.h / c.w) : 1;
        score += (c.s.a ? 1 : 0.35) * c.w * c.h / crop;
      }
    }
    if (!best || score > best.score * 1.02) best = { rows, score };
  }
  if (!best) return shapes.map(() => ({ x: R.x, y: R.y, w: 1, h: 1 }));
  const rowH = best.rows[0][0].h;
  let y = R.y + (top ? 0 : (R.h - rowH * best.rows.length - gap * (best.rows.length - 1)) / 2);
  const out = [];
  for (const row of best.rows) {
    let x = R.x + (R.w - row.reduce((total, c) => total + c.w, 0) - gap * (row.length - 1)) / 2;
    for (const c of row) {
      out.push({ x, y, w: c.w, h: c.h });
      x += c.w + gap;
    }
    y += rowH + gap;
  }
  return out;
}

// Маленькая плитка в углу: размер — по настоящим пропорциям кадра, угол — куда её перетащили.
function pipRect(t, W, H, safe, padT, padB, m) {
  const ar = clamp(aspect(t) || (W < H ? 3 / 4 : 16 / 9), 9 / 16, 16 / 9);
  const side = clamp(Math.min(W, H) * 0.3, 104, 232);
  const w = ar >= 1 ? side : side * ar, h = ar >= 1 ? side / ar : side;
  return {
    x: prefs.pip[1] === 'l' ? m + safe.l : W - w - m - safe.r,
    y: prefs.pip[0] === 't' ? padT : H - padB - h,
    w, h,
  };
}

function layout() {
  const list = view.list, n = list.length;
  const W = stage.clientWidth, H = stage.clientHeight;
  if (!n || !W || !H) return;
  const keys = list.map((d) => d.key);
  const screens = list.filter((d) => d.kind === 'screen').map((d) => d.key);
  if (screens.join() !== screensKey) {
    // Начался новый показ экрана — он выходит вперёд, что бы ни было выбрано до этого.
    const before = screensKey.split(',');
    if (pinned === 'grid' || screens.some((k) => !before.includes(k))) pinned = null;
    screensKey = screens.join();
  }
  if (pinned && pinned !== 'grid' && !keys.includes(pinned)) pinned = null;

  let big = null;
  if (n > 1) {
    if (pinned && pinned !== 'grid') big = pinned;
    else if (pinned !== 'grid' && screens.length) big = screens[screens.length - 1];
    else if (n === 2) big = keys[0];
  }
  const rest = big ? keys.filter((k) => k !== big) : [];
  const mode = n === 1 ? 'solo' : !big ? 'grid' : rest.length === 1 ? 'duo' : 'present';
  if (mode !== 'present') immersive = false;

  const gap = W < 640 ? 6 : 10, m = W < 640 ? 10 : 14;
  const safe = insets();
  const padT = $('top').offsetTop + $('top').offsetHeight + gap; // под строкой сверху
  const padB = H - bar.offsetTop + gap;                           // над панелью кнопок
  const rects = new Map();
  let lift = 0; // на сколько поднять всплывающие сообщения, чтобы они не закрывали ленту
  const full = { x: 0, y: 0, w: W, h: H, r: 0, z: 1, role: 'full' };
  const shapes = (ks) => ks.map((k) => shapeOf(tiles.get(k), 1.6, 2.2));
  const small = (cells, hidden) => rest.forEach((k, i) => rects.set(k, { ...cells[i], r: 14, z: 2, role: hidden ? 'hidden' : 'small' }));
  // Крупная плитка занимает отведённое место целиком, если кадр это позволяет; иначе — по кадру.
  const lead = (R) => {
    const s = shapeOf(tiles.get(big), 1.3, 8);
    if (immersive) return full;
    if (!s.a) return { ...R, r: 22, z: 1, role: 'big' };
    const z = shapeIn(s, R.w, R.h);
    return { x: R.x + (R.w - z.w) / 2, y: R.y + (R.h - z.h) / 2, w: z.w, h: z.h, r: 22, z: 1, role: 'big' };
  };

  if (mode === 'solo') {
    rects.set(keys[0], full);
  } else if (mode === 'duo') {
    rects.set(big, full);
    rects.set(rest[0], { ...pipRect(tiles.get(rest[0]), W, H, safe, padT, padB, m), r: 20, z: 3, role: 'pip' });
  } else if (mode === 'present' && W > H * 1.15) {
    // Широкий экран: лента справа, крупная плитка — всё остальное.
    const sw = clamp(W * 0.19, 150, 260);
    rects.set(big, lead({ x: m + safe.l, y: padT, w: W - sw - 2 * m - gap - safe.l - safe.r, h: H - padT - padB }));
    small(fitGrid(shapes(rest), { x: W - sw - m - safe.r, y: padT, w: sw, h: H - padT - m - safe.b }, gap, true), immersive);
  } else if (mode === 'present') {
    // Высокий экран: лента внизу, над кнопками. Чужому экрану нужно места ровно по его
    // пропорциям — всё, что осталось, достаётся людям.
    const sh = clamp(H * 0.13, 72, 116), most = H - padB - padT - sh - gap;
    const a = tiles.get(big).d.kind === 'screen' ? aspect(tiles.get(big)) : 0;
    const bh = a ? clamp((W - 2 * gap) / a, Math.min(160, most), most) : most;
    const sy = padT + bh + gap, roomy = bh < most - 40;
    rects.set(big, lead({ x: gap, y: padT, w: W - 2 * gap, h: bh }));
    small(fitGrid(shapes(rest), { x: gap, y: sy, w: W - 2 * gap, h: H - padB - sy }, gap), immersive);
    if (!roomy && !immersive) lift = sh + gap;
  } else {
    const cells = fitGrid(shapes(keys), { x: m + safe.l, y: padT, w: W - 2 * m - safe.l - safe.r, h: H - padT - padB }, gap);
    keys.forEach((k, i) => rects.set(k, { ...cells[i], r: clamp(Math.min(cells[i].w, cells[i].h) * 0.08, 14, 26), z: 1, role: 'cell' }));
  }

  view.mode = mode;
  view.big = big;
  view.keys = keys;
  stage.dataset.mode = mode;
  callEl.classList.toggle('immersive', immersive);
  callEl.style.setProperty('--lift', lift + 'px');
  for (const d of list) place(tiles.get(d.key), rects.get(d.key));
}

function place(t, r) {
  const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
  const resized = !t.rect || t.rect.w !== w || t.rect.h !== h;
  // Приближение переживает перестановку: запоминаем, какое место кадра было в центре плитки.
  const held = t.zoom && resized && t.rect ? zoomPoint(t) : null;
  t.rect = { x, y, w, h };
  t.role = r.role;
  t.el.dataset.role = r.role;
  if (t.dragging) return;
  const s = t.el.style;
  s.transform = `translate3d(${x}px, ${y}px, 0)`;
  s.width = w + 'px';
  s.height = h + 'px';
  s.borderRadius = r.r + 'px';
  s.zIndex = r.z;
  if (t.zoom && !zoomable(t)) t.zoom = null; // маленькие плитки не приближаются
  else if (held) { t.zoom = zoomAt(t, held); showZoom(t, t.zoom); }
  if (!t.zoom && !t.busy) plainFit(t);
  if (t.fresh) {
    t.fresh = false;
    quiet(() => t.el.animate([{ opacity: 0, scale: 0.86 }, { opacity: 1, scale: 1 }], { duration: 520, easing: EASE }));
  }
}

// Во время изменения размеров окна плитки не «плывут», а сразу встают на место.
let stillTimer = 0;
function onResize() {
  stage.classList.add('still');
  clearTimeout(stillTimer);
  stillTimer = setTimeout(() => stage.classList.remove('still'), 180);
  renderSoon();
}

let renderTimer = 0;
function renderSoon() {
  if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = 0; render(); }, 16);
}

let wasMic = false, hadScreen = false;

function render() {
  if (!me.joined) return;
  const list = describe();
  view.list = list;
  syncTiles(list);
  layout();
  for (const t of tiles.values()) play(t.video);
  renderBar();
  renderTop();
  syncBack();
  if (!canIdle()) callEl.classList.remove('idle');

  // Подсказки — в тот момент, когда жест пригодится.
  const lead = tiles.get(leadKey());
  if (view.mode === 'duo' && lead && !lead.d.self && lead.d.video && aspect(lead) && fitOf(lead) === 'cover' && geometry(lead).k > 1.8) {
    hint('fit', coarse ? 'Двойное касание покажет кадр целиком' : 'Двойной щелчок покажет кадр целиком');
  }
  if (wasMic && !me.mic && me.audio) {
    nudged = false;
    hint('talk', coarse ? 'Удерживайте кнопку микрофона, чтобы сказать пару слов' : 'Удерживайте пробел, чтобы сказать пару слов, не включая микрофон');
  }
  wasMic = me.mic;
  const screen = list.some((d) => d.kind === 'screen');
  if (screen && !hadScreen) hint('zoom', coarse ? 'Экран можно приблизить щипком или двойным касанием' : 'Экран можно приблизить двойным щелчком');
  hadScreen = screen;
  if (view.mode === 'present' && coarse) hint('swipe', 'Смахните в сторону — следующий участник, вниз — все сразу');
}

// ---------------------------------------------------------------- приближение

// Крупную плитку можно приблизить, как фотографию: «вписать», «заполнить» и ближе, до пяти раз.
// Основа — кадр, вписанный целиком; z = { s, x, y } — масштаб и сдвиг относительно неё.
function geometry(t) {
  const W = t.rect.w, H = t.rect.h;
  const a = aspect(t) || W / H;
  const cw = Math.min(W, H * a), ch = cw / a;
  return { W, H, cw, ch, k: Math.max(W / cw, H / ch) }; // k — во сколько раз надо увеличить, чтобы заполнить
}

const centered = (g, s) => ({ s, x: (g.W - g.W * s) / 2, y: (g.H - g.H * s) / 2 });
const baseZoom = (t) => (t.zoom ? { ...t.zoom } : centered(geometry(t), fitOf(t) === 'cover' ? geometry(t).k : 1));

// Как показать кадр, если человек сам не выбирал. Экран — всегда целиком. Камера заполняет
// плитку, но узкий портретный кадр в широкой плитке не режем: от лица остались бы одни глаза.
function autoFit(t) {
  if (t.d.kind === 'screen') return 'contain';
  const a = aspect(t);
  return a && t.rect && a < t.rect.w / t.rect.h / 1.65 ? 'contain' : 'cover';
}

// Приближать и выбирать «вписать» или «заполнить» можно на крупной чужой плитке.
const zoomable = (t) => (t.role === 'full' || t.role === 'big') && !t.d.self;
const fitOf = (t) => (zoomable(t) && t.fit) || autoFit(t);

// Не даёт утащить картинку так, чтобы рядом с ней появилась пустота.
function clampZoom(t, z) {
  const g = geometry(t);
  const axis = (pos, size, content) => {
    if (content * z.s <= size) return (size - size * z.s) / 2;
    return clamp(pos, size - z.s * (size + content) / 2, -z.s * (size - content) / 2);
  };
  return { s: z.s, x: axis(z.x, g.W, g.cw), y: axis(z.y, g.H, g.ch) };
}

function showZoom(t, z, smooth) {
  t.video.classList.toggle('snap', !!smooth);
  t.video.style.objectFit = 'contain';
  t.video.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
  t.el.classList.toggle('zoomed', !!t.zoom || t.busy); // подпись не закрывает то, что рассматривают
}

// Без приближения браузер сам вписывает или заполняет — так плитка меняет размер без рывков.
function plainFit(t) {
  t.video.classList.remove('snap');
  t.el.classList.remove('zoomed');
  t.video.style.transform = '';
  t.video.style.objectFit = fitOf(t);
}

// Жест закончился: прилипнуть к «вписать» или «заполнить», если рядом, иначе оставить как есть.
function settleZoom(t, z) {
  const g = geometry(t);
  const choose = (fit) => { t.fit = fit === autoFit(t) ? null : fit; t.zoom = null; };
  let to;
  if (z.s < 1.04) { choose('contain'); to = centered(g, 1); }
  else if (g.k > 1.06 && Math.abs(z.s - g.k) / g.k < 0.07) { choose('cover'); to = centered(g, g.k); }
  else { t.zoom = clampZoom(t, z); to = t.zoom; }
  showZoom(t, to, true);
  clearTimeout(t.timer);
  t.timer = setTimeout(() => { t.busy = false; if (!t.zoom && tiles.get(t.key) === t) plainFit(t); }, 320);
  // Рассматривать мелкое в маленькой плитке незачем: приблизил — она раскрылась на весь экран.
  if (t.zoom && t.role === 'big' && !immersive && inPresent() && t.rect.w * t.rect.h < 0.5 * stage.clientWidth * stage.clientHeight) setImmersive(true);
}

// Какое место кадра (в его долях) сейчас в центре плитки и во сколько раз кадр крупнее вписанного.
function zoomPoint(t) {
  const g = geometry(t), z = t.zoom;
  return { s: z.s, cx: (g.W / 2 - z.x - z.s * (g.W - g.cw) / 2) / (z.s * g.cw), cy: (g.H / 2 - z.y - z.s * (g.H - g.ch) / 2) / (z.s * g.ch) };
}

// То же приближение для плитки нового размера.
function zoomAt(t, p) {
  const g = geometry(t);
  return clampZoom(t, { s: p.s, x: g.W / 2 - p.s * (g.W - g.cw) / 2 - p.cx * p.s * g.cw, y: g.H / 2 - p.s * (g.H - g.ch) / 2 - p.cy * p.s * g.ch });
}

function glideZoom(t, from, to) {
  t.busy = true;
  showZoom(t, from);
  void t.video.offsetWidth; // зафиксировать начало, чтобы переход было от чего считать
  settleZoom(t, to);
}

// Двойное касание: камера — «заполнить» ↔ «вписать» (или вдвое ближе, если кадр и так впору),
// экран — ближе к месту касания; второй раз — обратно.
function zoomToggle(t, px, py) {
  const g = geometry(t), from = baseZoom(t), def = autoFit(t);
  buzz();
  if (t.zoom || fitOf(t) !== def) {
    t.zoom = null;
    t.fit = null;
    return glideZoom(t, from, centered(g, def === 'cover' ? g.k : 1));
  }
  if (t.d.kind !== 'screen' && g.k > 1.15) return glideZoom(t, from, centered(g, def === 'cover' ? 1 : g.k));
  const s = from.s * 2.5;
  glideZoom(t, from, { s, x: px - (px - from.x) * (s / from.s), y: py - (py - from.y) * (s / from.s) });
}

// ---------------------------------------------------------------- громкость человека

const sessionVol = new Map(); // безымянных гостей помним только до конца звонка

function volSlot(p, create) {
  if (p.name !== call.DEFAULT_NAME) return prefs.vol[p.name] || (create ? (prefs.vol[p.name] = {}) : null);
  if (!sessionVol.has(p.id) && create) sessionVol.set(p.id, {});
  return sessionVol.get(p.id) || null;
}

function getVol(d) {
  const slot = volSlot(d.peer, false);
  const v = slot && slot[d.kind === 'screen' ? 'scr' : 'mic'];
  return typeof v === 'number' ? clamp(v, 0, 1) : 1;
}

function applyVol(t) {
  const v = getVol(t.d);
  if (canVolume) t.video.volume = v;
  t.video.muted = v === 0;
  t.badge.hidden = v === 1;
  t.badge.lastChild.textContent = v === 0 ? 'без звука' : Math.round(v * 100) + '%';
}

function setVol(t, v) {
  volSlot(t.d.peer, true)[t.d.kind === 'screen' ? 'scr' : 'mic'] = Math.round(v * 100) / 100;
  applyVol(t);
  hudShow(t, v);
}

let hudTimer = 0;

function hudShow(t, v) {
  clearTimeout(hudTimer);
  const W = stage.clientWidth, H = stage.clientHeight;
  hud.style.left = clamp(t.rect.x + t.rect.w / 2, 48, W - 48) + 'px';
  hud.style.top = clamp(t.rect.y + t.rect.h / 2, 132, H - 132) + 'px';
  hud.style.setProperty('--v', Math.round(v * 100) + '%');
  $('hud-value').textContent = canVolume ? Math.round(v * 100) + '%' : v ? 'Слышно' : 'Без звука';
  $('hud-name').textContent = t.d.kind === 'screen' ? 'Звук экрана' : t.d.name;
  hud.classList.add('on');
}

function hudHide(ms) {
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => hud.classList.remove('on'), ms || 0);
}

// ---------------------------------------------------------------- жесты

const ges = { pts: new Map(), mode: null, id: -1, key: null, mouse: false, x0: 0, y0: 0, x: 0, y: 0, t0: 0, hold: 0, pending: 0, last: null, pinch: null };

const canFlip = () => phone && me.cam;
const inPresent = () => view.mode === 'present'; // есть лента: можно листать людей и вернуть сетку
const leadKey = () => view.big || (view.mode === 'solo' ? view.keys[0] : null);
const isLead = (t) => !!t && (t.role === 'full' || t.role === 'big');

function stagePoint(e) {
  const r = stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.isPrimary) ges.pts.clear();
  ges.pts.set(e.pointerId, stagePoint(e));
  quiet(() => stage.setPointerCapture(e.pointerId));
  if (ges.pts.size === 2) return pinchStart();
  if (ges.pts.size > 2) return;
  const el = e.target.closest('.tile');
  const t = el && tiles.get(el.dataset.key);
  const p = stagePoint(e);
  Object.assign(ges, { mode: 'press', id: e.pointerId, key: t ? t.key : null, mouse: e.pointerType === 'mouse', x0: p.x, y0: p.y, x: p.x, y: p.y, t0: performance.now() });
  clearTimeout(ges.hold);
  ges.hold = setTimeout(holdStart, 380);
}

function onMove(e) {
  const pt = ges.pts.get(e.pointerId);
  if (!pt) return;
  Object.assign(pt, stagePoint(e));
  if (ges.mode === 'pinch') return pinchMove();
  if (e.pointerId !== ges.id) return;
  ges.x = pt.x;
  ges.y = pt.y;
  const dx = ges.x - ges.x0, dy = ges.y - ges.y0;
  if (ges.mode === 'press') {
    if (Math.hypot(dx, dy) < (ges.mouse ? 5 : 9)) return;
    clearTimeout(ges.hold);
    const t = ges.key && tiles.get(ges.key);
    if (t && t.role === 'pip') {
      Object.assign(ges, { mode: 'pip', rx: t.rect.x, ry: t.rect.y, px: null, py: null });
      t.dragging = true;
      t.el.classList.add('drag');
    } else if (t && t.zoom) {
      Object.assign(ges, { mode: 'pan', z0: { ...t.zoom }, z: null });
      t.busy = true;
    } else if (!ges.mouse) {
      ges.mode = 'swipe';
      ges.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    } else ges.mode = 'none';
  }
  if (ges.mode === 'pip') pipMove(dx, dy);
  else if (ges.mode === 'pan') panMove(dx, dy);
  else if (ges.mode === 'swipe') swipeMove(dx, dy);
  else if (ges.mode === 'hold') holdMove();
}

function onUp(e) {
  if (!ges.pts.delete(e.pointerId)) return;
  quiet(() => stage.releasePointerCapture(e.pointerId));
  if (ges.mode === 'pinch') { if (ges.pts.size < 2) pinchEnd(); return; }
  if (e.pointerId !== ges.id) return;
  clearTimeout(ges.hold);
  const mode = ges.mode, dx = ges.x - ges.x0, dy = ges.y - ges.y0;
  ges.mode = null;
  ges.id = -1;
  const cancelled = e.type === 'pointercancel';
  if (mode === 'press') { if (!cancelled) tap(); }
  else if (mode === 'pip') pipEnd();
  else if (mode === 'pan') panEnd();
  else if (mode === 'swipe') swipeEnd(cancelled ? 0 : dx, cancelled ? 0 : dy, performance.now() - ges.t0);
  else if (mode === 'hold') holdEnd();
}

// Касание. Маленькая плитка становится крупной; крупная занимает весь экран и возвращается;
// когда двое — касание прячет и возвращает кнопки, как в плеере.
function tap() {
  const key = ges.key, t = key && tiles.get(key);
  const now = performance.now();
  const twice = !!ges.last && ges.last.key === key && now - ges.last.t < 320 && Math.hypot(ges.x - ges.last.x, ges.y - ges.last.y) < 40;
  ges.last = twice ? null : { key, t: now, x: ges.x, y: ges.y };
  clearTimeout(ges.pending);
  if (chatOpen) return closeChat(); // касание мимо сообщений закрывает их
  if (twice) return doubleTap(t);
  if (!t) { if (!ges.mouse) toggleChrome(); return; }
  if (!isLead(t)) {
    // Свою плитку в углу касаются дважды, чтобы сменить камеру: ждём, не второе ли это касание.
    if (t.d.self && canFlip()) ges.pending = setTimeout(() => focus(key), 260);
    else focus(key);
  } else if (inPresent()) {
    ges.pending = setTimeout(() => setImmersive(!immersive), 260); // ждём, как в галерее: вдруг это двойное касание — приблизить
  } else if (!ges.mouse) toggleChrome();
}

function doubleTap(t) {
  if (!t) return;
  if (t.d.self) { if (canFlip()) { buzz(); call.flipCam(); } return; }
  if (isLead(t)) zoomToggle(t, ges.x - t.rect.x, ges.y - t.rect.y);
}

function focus(key) {
  if (key !== pinned) immersive = false;
  pinned = key;
  buzz();
  render();
}

function setImmersive(on) {
  immersive = on && inPresent();
  render();
  if (immersive && canIdle()) callEl.classList.add('idle'); else showChrome();
}

// Следующий или предыдущий участник — на место крупной плитки.
function step(dir) {
  const i = view.keys.indexOf(view.big), n = view.keys.length;
  if (i < 0 || n < 2) return;
  pinned = view.keys[(i + dir + n) % n];
  buzz();
  render();
}

// Зажали человека: дальше палец вверх-вниз — его громкость, прямо на нём, без меню.
function holdStart() {
  if (ges.mode !== 'press') return;
  const t = ges.key && tiles.get(ges.key);
  ges.mode = 'none';
  if (!t) return;
  buzz(true);
  if (t.d.self) return openSheet();
  Object.assign(ges, { mode: 'hold', vt: t, v0: getVol(t.d), v: -1, hy: ges.y });
  hudShow(t, ges.v0);
}

function holdMove() {
  const t = ges.vt;
  if (tiles.get(t.key) !== t) return;
  let v = clamp(ges.v0 + (ges.hy - ges.y) / 170, 0, 1);
  if (!canVolume) v = v >= 0.5 ? 1 : 0;
  else if (v > 0.96) v = 1;
  else if (v < 0.04) v = 0;
  if (v === ges.v) return;
  if (v === 0 || v === 1) buzz();
  ges.v = v;
  setVol(t, v);
}

function holdEnd() {
  savePrefs();
  hudHide(450);
}

// Свою плитку в углу можно перетащить в любой другой угол.
function pipMove(dx, dy) {
  const t = tiles.get(ges.key);
  if (!t) return;
  ges.px = clamp(ges.rx + dx, 4, stage.clientWidth - t.rect.w - 4);
  ges.py = clamp(ges.ry + dy, 4, stage.clientHeight - t.rect.h - 4);
  t.el.style.transform = `translate3d(${ges.px}px, ${ges.py}px, 0)`;
}

function pipEnd() {
  const t = tiles.get(ges.key);
  if (!t) return;
  t.dragging = false;
  t.el.classList.remove('drag');
  if (ges.px != null) {
    const cx = ges.px + t.rect.w / 2, cy = ges.py + t.rect.h / 2;
    prefs.pip = (cy < stage.clientHeight / 2 ? 't' : 'b') + (cx < stage.clientWidth / 2 ? 'l' : 'r');
    savePrefs();
  }
  render();
}

function panMove(dx, dy) {
  const t = tiles.get(ges.key);
  if (!t) return;
  ges.z = clampZoom(t, { s: ges.z0.s, x: ges.z0.x + dx, y: ges.z0.y + dy });
  showZoom(t, ges.z);
}

function panEnd() {
  const t = tiles.get(ges.key);
  if (!t) return;
  t.busy = false;
  if (ges.z) t.zoom = ges.z;
}

// Смахивание по крупной плитке: в сторону — следующий человек, вниз — обратно к сетке;
// вверх где угодно — написать сообщение. Плитка едет за пальцем.
function swipeMove(dx, dy) {
  const t = tiles.get(leadKey());
  if (!t || ges.key !== t.key) return;
  let x = 0, y = 0, s = 1;
  if (ges.axis === 'x') x = inPresent() ? dx : dx * 0.15;
  else if (dy > 0 && inPresent()) { y = dy * 0.8; s = 1 - Math.min(0.25, dy / stage.clientHeight * 0.5); }
  else y = dy * 0.1;
  t.el.classList.add('drag');
  t.el.style.transform = `translate3d(${t.rect.x + x}px, ${t.rect.y + y}px, 0) scale(${s})`;
}

function swipeEnd(dx, dy, ms) {
  const t = tiles.get(leadKey());
  if (t) t.el.classList.remove('drag');
  const onLead = !!t && ges.key === t.key, flick = ms < 260;
  if (ges.axis === 'x' && onLead && inPresent() && (Math.abs(dx) > 70 || (flick && Math.abs(dx) > 28))) return step(dx < 0 ? 1 : -1);
  if (ges.axis === 'y' && dy > 0 && onLead && inPresent() && (dy > 100 || (flick && dy > 36))) return focus('grid');
  if (ges.axis === 'y' && dy < -56) openChat();
  render(); // плитка возвращается на место
}

// Два пальца: на крупной плитке — приблизить; свести до конца — вернуть сетку;
// развести на маленькой — вывести её крупно. Как в галерее.
function pinchStart() {
  clearTimeout(ges.hold);
  if (ges.mode === 'hold') holdEnd();
  if (ges.mode === 'pan') panEnd();
  if (ges.mode === 'pip') pipEnd();
  const lead = tiles.get(leadKey());
  if (ges.mode === 'swipe' && lead) lead.el.classList.remove('drag');
  const [a, b] = [...ges.pts.values()];
  const t = (ges.key && tiles.get(ges.key)) || lead;
  ges.mode = 'pinch';
  ges.pinch = null;
  if (!t || t.d.self) return;
  const d0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  if (isLead(t)) {
    const z0 = baseZoom(t);
    ges.pinch = { t, zoom: true, d0, z0, z: z0, m0: { x: (a.x + b.x) / 2 - t.rect.x, y: (a.y + b.y) / 2 - t.rect.y } };
    t.busy = true;
    showZoom(t, z0);
  } else ges.pinch = { t, zoom: false, d0, k: 1 };
}

function pinchMove() {
  const p = ges.pinch;
  if (!p || ges.pts.size < 2) return;
  const [a, b] = [...ges.pts.values()];
  const k = Math.hypot(a.x - b.x, a.y - b.y) / p.d0;
  if (!p.zoom) { p.k = k; return; }
  const s = clamp(p.z0.s * k, 0.5, 5 * Math.max(1, geometry(p.t).k));
  const mx = (a.x + b.x) / 2 - p.t.rect.x, my = (a.y + b.y) / 2 - p.t.rect.y;
  const z = { s, x: mx - (p.m0.x - p.z0.x) * (s / p.z0.s), y: my - (p.m0.y - p.z0.y) * (s / p.z0.s) };
  p.z = s >= 1 ? clampZoom(p.t, z) : z; // меньше «вписать» — картинка сжимается под пальцами: сейчас вернётся сетка
  showZoom(p.t, p.z);
}

function pinchEnd() {
  const p = ges.pinch;
  ges.pinch = null;
  ges.mode = 'none';
  if (!p || tiles.get(p.t.key) !== p.t) return;
  if (!p.zoom) { if (p.k > 1.25) focus(p.t.key); return; }
  if (p.z.s < 0.8 && inPresent()) {
    settleZoom(p.t, centered(geometry(p.t), fitOf(p.t) === 'cover' ? geometry(p.t).k : 1));
    return focus('grid');
  }
  settleZoom(p.t, p.z);
}

// Мышь и тачпад: колёсико над человеком — его громкость; с Ctrl или ⌘ (и щипок на тачпаде) —
// приблизить крупную плитку туда, где курсор.
let wheel = null, wheelTimer = 0;

function onWheel(e) {
  const el = e.target.closest('.tile');
  const t = el && tiles.get(el.dataset.key);
  e.preventDefault();
  if (!t || t.d.self) return;
  const dy = clamp(e.webkitDirectionInvertedFromDevice ? -e.deltaY : e.deltaY, -40, 40);
  if (e.ctrlKey || e.metaKey) {
    if (!isLead(t)) return;
    const p = stagePoint(e), px = p.x - t.rect.x, py = p.y - t.rect.y;
    const from = wheel && wheel.t === t ? wheel.z : baseZoom(t);
    const s = clamp(from.s * Math.exp(-clamp(e.deltaY, -30, 30) * 0.01), 1, 5 * Math.max(1, geometry(t).k));
    const z = clampZoom(t, { s, x: px - (px - from.x) * (s / from.s), y: py - (py - from.y) * (s / from.s) });
    t.busy = true;
    wheel = { t, z };
    showZoom(t, z);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { wheel = null; if (tiles.get(t.key) === t) settleZoom(t, z); }, 240);
    return;
  }
  const v = canVolume ? clamp(getVol(t.d) - dy * 0.0025, 0, 1) : dy < 0 ? 1 : 0;
  setVol(t, v);
  savePrefs();
  hudHide(900);
}

// ---------------------------------------------------------------- панель кнопок

const BAR = [['mic', 'Микрофон'], ['cam', 'Камера'], ['screen', 'Показать экран'], ['chat', 'Сообщение'], ['leave', 'Выйти из звонка']];
const barBtn = {};
let skipClick = 0;
let talking = false; // микрофон включён удержанием — кнопки не прячем

function buildBar() {
  for (const [id, title] of BAR) {
    if (id === 'screen' && !canShare) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.dataset.act = id;
    b.innerHTML = icon(id);
    barBtn[id] = b;
    bar.append(b);
  }
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || performance.now() < skipClick) return;
    b.blur(); // иначе пробел нажимал бы эту кнопку, а не микрофон
    buzz();
    const id = b.dataset.act;
    if (id === 'mic') call.toggleMic();
    else if (id === 'cam') call.toggleCam();
    else if (id === 'screen') call.toggleScreen();
    else if (id === 'chat') { if (chatOpen) closeChat(); else openChat(); }
    else if (id === 'leave') call.leave();
  });

  // Удержание микрофона — «сказать пару слов»: слышно, пока держишь.
  let timer = 0, held = false;
  const mic = barBtn.mic;
  mic.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    held = false;
    clearTimeout(timer);
    timer = setTimeout(() => { held = call.talk(true); if (held) { buzz(true); setTalking(true); } }, 260);
  });
  const end = () => {
    clearTimeout(timer);
    if (!held) return;
    held = false;
    call.talk(false);
    setTalking(false);
    skipClick = performance.now() + 400;
  };
  mic.addEventListener('pointerup', end);
  mic.addEventListener('pointercancel', end);
  mic.addEventListener('pointerleave', end);
  mic.addEventListener('contextmenu', (e) => e.preventDefault());
}

function setTalking(on) {
  talking = on;
  if (on) callEl.classList.remove('idle'); else showChrome();
  renderBar();
}

function renderBar() {
  const set = (b, name, off) => {
    if (b.dataset.icon !== name) { b.dataset.icon = name; b.innerHTML = icon(name); }
    b.classList.toggle('off', off);
  };
  set(barBtn.mic, me.mic ? 'mic' : 'micOff', !me.mic);
  set(barBtn.cam, me.cam ? 'cam' : 'camOff', !me.cam);
  barBtn.mic.classList.toggle('talk', me.talking);
  if (barBtn.screen) barBtn.screen.classList.toggle('on', me.screen);
  barBtn.chat.classList.toggle('on', chatOpen);
  barBtn.chat.classList.toggle('unread', unread && !chatOpen);
  bar.style.setProperty('--hue', me.hue);
}

// Пробел: короткое нажатие включает и выключает микрофон, удержание — «сказать пару слов».
let spaceDown = false, spaceTimer = 0, spaceHeld = false;

function onKeyDown(e) {
  if (!me.joined) return;
  audio();
  if (e.key === 'Escape') return back();
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const el = e.target instanceof Element ? e.target : null;
  if (el && el.closest('input, textarea, select')) return;
  if (el && el.closest('button, a, summary') && (e.code === 'Space' || e.key === 'Enter')) return; // клавиша нажимает то, что в фокусе
  showChrome();
  if (e.code === 'Space') {
    e.preventDefault();
    if (e.repeat || spaceDown) return;
    spaceDown = true;
    spaceHeld = false;
    spaceTimer = setTimeout(() => { spaceHeld = call.talk(true); if (spaceHeld) setTalking(true); }, 240);
    return;
  }
  if (!sheet.hidden) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (inPresent()) step(e.key === 'ArrowRight' ? 1 : -1);
    else if (view.mode === 'grid') focus(view.keys[e.key === 'ArrowRight' ? 0 : view.keys.length - 1]);
    return;
  }
  if (e.key === 'Enter') { e.preventDefault(); return openChat(); }
  if (e.key.length === 1) openChat(true); // просто начали печатать: буква попадёт уже в сообщение
}

function onKeyUp(e) {
  if (e.code !== 'Space' || !spaceDown) return;
  spaceDown = false;
  clearTimeout(spaceTimer);
  if (spaceHeld) { spaceHeld = false; call.talk(false); setTalking(false); }
  else call.toggleMic();
}

// Шаг назад: закрыть то, что открыто последним.
function back() {
  if (!sheet.hidden) closeSheet();
  else if (chatOpen) closeChat();
  else if (immersive) setImmersive(false);
  else if (inPresent()) focus('grid');
}

// ---------------------------------------------------------------- кто говорит

// Голос виден светом: плитка говорящего светится его цветом, шар без камеры «дышит».
let levelTimer = 0, loud = 0, nudged = false;

function levels() {
  const mine = micLevel();
  for (const t of tiles.values()) {
    if (t.d.kind !== 'cam') continue;
    const raw = t.d.self ? (me.mic ? mine : 0) : clamp(call.level(t.d.peer) * 3.2, 0, 1);
    const target = raw < 0.08 ? 0 : raw;
    t.lvl = target > t.lvl ? target : t.lvl * 0.72; // вспыхивает сразу, гаснет плавно
    const shown = t.lvl < 0.03 ? 0 : Math.round(t.lvl * 40) / 40;
    if (shown !== t.shown) { t.shown = shown; t.el.style.setProperty('--lvl', shown); }
  }
  // Человек говорит, а микрофон выключен: один раз за выключение мягко напоминаем.
  if (me.mic || !me.audio || nudged) { loud = 0; return; }
  loud = mine > 0.3 ? loud + 1 : Math.max(0, loud - 1);
  if (loud < 9) return;
  nudged = true;
  loud = 0;
  showChrome();
  barBtn.mic.classList.add('nudge');
  setTimeout(() => barBtn.mic.classList.remove('nudge'), 2600);
  toast(coarse ? 'Вас не слышно: микрофон выключен' : 'Вас не слышно: микрофон выключен. Пробел включит его');
}

// ---------------------------------------------------------------- сообщения

// Чата-панели нет: сообщения всплывают поверх видео и сами гаснут. Написать — кнопкой,
// смахиванием вверх или просто начав печатать.
let chatOpen = false, quickChat = false, unread = false;

function openChat(quick) {
  if (!me.joined) return;
  quickChat = !!quick && !chatOpen;
  chatOpen = true;
  unread = false;
  $('chat').classList.add('open');
  callEl.classList.add('chat-open');
  callEl.classList.remove('idle');
  const log = $('chat-log');
  log.scrollTop = log.scrollHeight;
  $('chat-text').focus({ preventScroll: true });
  renderBar();
  syncBack();
}

function closeChat() {
  chatOpen = false;
  quickChat = false;
  $('chat').classList.remove('open');
  callEl.classList.remove('chat-open');
  $('chat-text').blur();
  renderBar();
  syncBack();
  showChrome();
}

function addChat(name, hue, text, mine) {
  const log = $('chat-log');
  const el = document.createElement('div');
  el.className = 'msg fresh';
  el.style.setProperty('--hue', hue);
  const b = document.createElement('b');
  b.textContent = name;
  el.append(b, document.createTextNode(text));
  log.append(el);
  while (log.children.length > 200) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
  setTimeout(() => el.classList.remove('fresh'), 8000);
  if (!mine && !chatOpen) { unread = true; renderBar(); buzz(); }
}

// ---------------------------------------------------------------- строка сверху и лист

function renderTop() {
  const n = peers.size + 1;
  const alone = n === 1;
  $('pill-text').textContent = alone ? 'Только вы' : n === 2 ? [...peers.values()][0].name : `${n} в звонке`;
  $('grid').hidden = !inPresent();
  $('sharing').hidden = !me.screen;
  const invite = $('invite');
  if (invite.hidden === alone) {
    invite.hidden = !alone;
    if (alone) $('invite-link').textContent = inviteLink().replace(/^https?:\/\//, '');
  }
}

// Один лист на всё редкое: позвать, имя, устройства, шпаргалка по жестам.
async function openSheet() {
  $('sheet-link').textContent = inviteLink().replace(/^https?:\/\//, '');
  $('set-name').value = prefs.name || (me.name === call.DEFAULT_NAME ? '' : me.name);
  $('set-flip').hidden = !canFlip();
  $('set-full').hidden = !(document.fullscreenEnabled || (tg && tg.requestFullscreen && tg.isVersionAtLeast('8.0')));
  $('sheet-card').style.transform = '';
  sheet.hidden = false;
  callEl.classList.remove('idle');
  syncBack();
  const d = await call.devices();
  const fill = (select, info) => {
    select.replaceChildren();
    if (!info.list.length) { select.append(new Option('По умолчанию', '')); select.disabled = true; return; }
    select.disabled = false;
    for (const x of info.list) select.append(new Option(x.label, x.id));
    select.value = info.current || info.list[0].id;
  };
  fill($('set-mic'), d.mic);
  fill($('set-cam'), d.cam);
}

function closeSheet() {
  if (sheet.hidden) return;
  sheet.hidden = true;
  syncBack();
  showChrome();
}

function setName(value) {
  prefs.name = call.cleanName(value);
  savePrefs();
  call.setName(prefs.name || tgName);
}

function toggleFullscreen() {
  if (tg && tg.requestFullscreen && tg.isVersionAtLeast('8.0')) {
    quiet(() => { if (tg.isFullscreen) tg.exitFullscreen(); else tg.requestFullscreen(); });
    return;
  }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}

// Лист на телефоне смахивается вниз за «ручку», как любой нижний лист.
function wireSheetDrag() {
  const card = $('sheet-card'), grab = $('sheet-grab');
  let y0 = null;
  grab.addEventListener('pointerdown', (e) => { y0 = e.clientY; quiet(() => grab.setPointerCapture(e.pointerId)); card.classList.add('drag'); });
  grab.addEventListener('pointermove', (e) => { if (y0 != null) card.style.transform = `translateY(${Math.max(0, e.clientY - y0)}px)`; });
  const end = (e) => {
    if (y0 == null) return;
    const dy = e.clientY - y0;
    y0 = null;
    card.classList.remove('drag');
    card.style.transform = '';
    if (dy > 80) closeSheet();
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------- кнопки появляются и исчезают

// Когда собеседник во весь экран, кнопки лежат поверх картинки и гаснут сами. В сетке и с
// лентой они картинку не закрывают, поэтому остаются на месте.
let idleTimer = 0, barHover = false;

const canIdle = () => me.joined && peers.size > 0 && (view.mode === 'duo' || immersive) && sheet.hidden && !chatOpen && !talking && !barHover;

function showChrome() {
  callEl.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (canIdle()) callEl.classList.add('idle'); }, coarse ? 4500 : 3000);
}

function toggleChrome() {
  if (callEl.classList.contains('idle')) return showChrome();
  clearTimeout(idleTimer);
  if (canIdle()) callEl.classList.add('idle');
}

// ---------------------------------------------------------------- вход и выход

let wakeLock = null;

async function keepAwake() {
  if (!navigator.wakeLock || !me.joined || document.visibilityState !== 'visible') return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
}

function show(id) {
  for (const x of ['home', 'call', 'left']) $(x).hidden = x !== id;
}

function showHome(error) {
  $('home-name').value = prefs.name || tgName;
  $('home-name').hidden = !!tgName && !prefs.name; // в Telegram имя уже есть
  $('home-err').textContent = error || '';
  show('home');
}

// created — звонок только что создан: ссылку сразу кладём в буфер, её всё равно сейчас отправлять.
function enter(room, created) {
  const why = call.supported();
  if (why) return showHome(why === 'insecure' ? 'Звонок работает только на странице с https' : 'Этот браузер не умеет видеозвонки');
  if (!inTg) quiet(() => history.replaceState(null, '', '#' + encodeURIComponent(room)));
  document.title = 'Звонилка — звонок';
  pinned = null;
  immersive = false;
  screensKey = '';
  wasMic = hadScreen = nudged = false;
  show('call');
  me.dev = phone ? 'телефон' : 'компьютер';
  call.join(room, prefs.name || tgName);
  if (created && !tg) copyText(browserLink()).then((ok) => { if (ok && me.joined) toast('Ссылка на звонок скопирована — отправьте её, кому хотите'); });
  audio();
  render();
  showChrome();
  if (tg) quiet(() => tg.enableClosingConfirmation());
  keepAwake();
  clearInterval(levelTimer);
  levelTimer = setInterval(levels, 80);
}

function afterLeave() {
  clearInterval(levelTimer);
  clearTimeout(idleTimer);
  clearTimeout(ges.hold);
  clearTimeout(ges.pending);
  ges.pts.clear();
  ges.mode = null;
  for (const t of tiles.values()) { t.video.srcObject = null; t.el.remove(); }
  tiles.clear();
  sessionVol.clear();
  hints.length = 0;
  if (wakeLock) { quiet(() => wakeLock.release()); wakeLock = null; }
  if (tg) quiet(() => tg.disableClosingConfirmation());
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  sheet.hidden = true;
  chatOpen = quickChat = unread = talking = immersive = false;
  syncBack();
  $('chat').classList.remove('open');
  $('chat-log').replaceChildren();
  $('chat-text').value = '';
  hud.classList.remove('on');
  $('hear').hidden = true;
  $('invite').hidden = true;
  callEl.classList.remove('idle', 'chat-open', 'immersive');
  document.title = 'Звонилка';
  show('left');
}

function startFromHome(room, created) {
  const name = call.cleanName($('home-name').value);
  if (name !== prefs.name && !$('home-name').hidden) { prefs.name = name; savePrefs(); }
  enter(room, created);
}

// ---------------------------------------------------------------- события звонка

const WHAT = { mic: 'микрофон', cam: 'камера', both: 'камера и микрофон' };

function wireCall() {
  call.on('change', renderSoon);
  call.on('left', afterLeave);
  call.on('track', (kind) => {
    if (kind === 'audio') attachMeter();
    if (kind === 'video') { const t = tiles.get('me'); if (t) t.video.srcObject = null; } // Safari не замечает смену дорожки в потоке
    renderSoon();
  });
  call.on('chat', ({ peer, text }) => {
    addChat(peer.name, peer.hue, text, false);
    if (!coarse) hint('type', 'Чтобы ответить, просто начните печатать');
  });
  call.on('notice', ({ type, peer }) => {
    if (type === 'joined') {
      chime(true);
      buzz();
      showChrome();
      setTimeout(() => hint('volume', coarse ? 'Зажмите человека и ведите вверх или вниз — это его громкость' : 'Колёсико над человеком меняет его громкость'), 2500);
    } else if (type === 'left') chime(false);
    else if (type === 'lost') { chime(false); toast(`${peer.name}: связь потеряна`); }
    else if (type === 'blocked') toast(`${peer.name}: ${(WHY[peer.why] || 'нет прямого пути').toLowerCase()}`);
    else if (type === 'full') toast('В звонке уже восемь человек — больше нельзя');
    else if (type === 'failed') toast('Не удалось начать звонок');
  });
  call.on('media-error', ({ what, name, insecure }) => {
    if (what === 'screen') return toast('Не удалось показать экран');
    let text;
    if (insecure) text = 'Камера и микрофон работают только на странице с https';
    else if (name === 'NotAllowedError' || name === 'SecurityError') text = `Нет доступа: ${WHAT[what]}. Вы видите и слышите остальных, а они вас — нет`;
    else if (name === 'NotFoundError' || name === 'OverconstrainedError') text = `Не найдено: ${WHAT[what]}`;
    else if (name === 'NotReadableError' || name === 'AbortError') text = `Занято другой программой: ${WHAT[what]}`;
    else text = `Не удалось включить: ${WHAT[what]}`;
    // Встроенный браузер Telegram не везде даёт камеру и микрофон — тот же звонок откроется в обычном.
    if (tg && tg.openLink) toast(text, 'Открыть в браузере', () => tg.openLink(browserLink()));
    else toast(text);
  });
}

// ---------------------------------------------------------------- запуск

// Экранная клавиатура на телефоне не должна закрывать звонок: он сжимается до видимой части.
function fitViewport() {
  const vv = window.visualViewport;
  if (!vv || Math.abs(vv.scale - 1) > 0.01) return;
  const root = document.documentElement.style;
  root.setProperty('--vvh', vv.height + 'px');
  root.setProperty('--vvt', vv.offsetTop + 'px');
}

function wireUi() {
  document.body.classList.toggle('touch', coarse);
  buildBar();
  wireSheetDrag();
  $('chat-send').innerHTML = icon('send');
  $('home-go').innerHTML = icon('go');
  $('grid').innerHTML = icon('grid');
  $('pill').insertAdjacentHTML('beforeend', icon('chevron'));
  $('sharing').insertAdjacentHTML('beforeend', icon('close'));
  $('hud-icon').innerHTML = icon('volume');
  $('sheet-close').innerHTML = icon('close');

  $('new-call').onclick = () => startFromHome(call.newRoom(), true);
  $('home-form').onsubmit = (e) => {
    e.preventDefault();
    const room = call.parseRoom($('home-code').value);
    if (!room) { $('home-err').textContent = 'Введите код комнаты или вставьте ссылку на звонок'; return; }
    startFromHome(room, false);
  };
  // Вставили ссылку — значит, хотят войти: кнопку нажимать незачем.
  $('home-code').addEventListener('paste', () => setTimeout(() => {
    const text = $('home-code').value;
    const room = /:\/\/|t\.me\//.test(text) ? call.parseRoom(text) : '';
    if (room) startFromHome(room, false);
  }, 0));
  $('rejoin').onclick = () => enter(me.room, false);
  $('left-new').onclick = () => enter(call.newRoom(), true);

  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('dragstart', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault()); // Safari: не масштабировать страницу

  $('pill').onclick = openSheet;
  $('grid').onclick = () => focus('grid');
  $('sharing').onclick = () => call.toggleScreen();
  $('invite-copy').onclick = copyInvite;
  $('invite-share').onclick = shareInvite;
  $('invite-share').hidden = !tg && !navigator.share;
  $('sheet-copy').onclick = copyInvite;
  $('sheet-share').onclick = shareInvite;
  $('sheet-share').hidden = !tg && !navigator.share;
  $('hear').onclick = () => { $('hear').hidden = true; audio(); for (const t of tiles.values()) play(t.video); };

  $('chat-form').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chat-text').value.trim().slice(0, 2000);
    if (!text) return closeChat();
    $('chat-text').value = '';
    call.sendChat(text);
    addChat('Вы', me.hue, text, true);
    if (quickChat) closeChat();
  };

  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
  $('sheet-close').onclick = closeSheet;
  $('set-name').onchange = () => setName($('set-name').value);
  $('set-mic').onchange = () => call.chooseDevice('mic', $('set-mic').value);
  $('set-cam').onchange = () => call.chooseDevice('cam', $('set-cam').value);
  $('set-flip').onclick = () => { call.flipCam(); closeSheet(); };
  $('set-full').onclick = () => { toggleFullscreen(); closeSheet(); };

  bar.addEventListener('pointerenter', () => { barHover = true; showChrome(); });
  bar.addEventListener('pointerleave', () => { barHover = false; showChrome(); });
  window.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && me.joined) showChrome(); });
  // Любое касание: будим звук (браузер разрешает его только после жеста) и остановленное видео.
  window.addEventListener('pointerdown', () => { audio(); for (const t of tiles.values()) play(t.video); }, true);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => { if (spaceHeld) { spaceHeld = spaceDown = false; call.talk(false); setTalking(false); } });

  new ResizeObserver(onResize).observe(stage);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitViewport);
    window.visualViewport.addEventListener('scroll', fitViewport);
    fitViewport();
  }
  document.addEventListener('visibilitychange', keepAwake);
  window.addEventListener('pagehide', () => call.leave());
  window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
  window.addEventListener('hashchange', () => {
    if (inTg) return;
    const room = call.parseRoom(location.hash);
    if (room && room !== me.room) location.reload();
  });
}

(async function boot() {
  wireUi();
  wireCall();
  await initTelegram();
  if (/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(query.get('bot') || '')) tgBot = query.get('bot');
  const asked = call.cleanName(query.get('name'));
  if (asked) prefs.name = asked; // ссылка с готовым именем: ?name=Аня
  const room = inTg ? startRoom() : location.hash.length > 1 ? call.parseRoom(location.hash) : '';
  if (room) enter(room, false); else showHome();
})();

// ---------------------------------------------------------------- для проверки

// Состояние интерфейса для живого теста (tools/call_test.mjs) и отладки из консоли.
window.zvonilka = {
  call, tiles, view,
  focus, step, openChat, closeChat, openSheet, closeSheet, setImmersive, inviteLink, browserLink, telegramLink,
  snapshot: () => ({
    joined: me.joined, mode: view.mode, big: view.big, pinned, immersive,
    idle: callEl.classList.contains('idle'), chatOpen, sheet: !sheet.hidden, mic: me.mic, talking: me.talking,
    tiles: [...tiles.values()].map((t) => ({
      key: t.key, role: t.role, rect: t.rect, fit: fitOf(t), zoom: t.zoom, vol: t.d.self ? null : getVol(t.d),
      video: t.video.videoWidth + 'x' + t.video.videoHeight, paused: t.video.paused, level: t.shown,
    })),
  }),
};
