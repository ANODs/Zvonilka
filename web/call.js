// Звонилка — звонок без интерфейса (docs/PLAN.md): комната, сигналинг, прямые соединения,
// микрофон, камера и экран. Как звонок выглядит, решает ui.js: он читает состояние отсюда
// и слушает события.
//
// Участники находят друг друга через публичные MQTT-брокеры: тема и ключ AES-GCM выводятся из
// кода комнаты, так что брокер видит только шум. Дальше каждая пара соединяется напрямую по
// WebRTC. У соединения пять постоянных каналов — микрофон, камера, экран, звук экрана и канал
// данных; включить камеру или показ экрана значит подменить дорожку, без пересогласования.

const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const HELLO_BEATS = 4;            // напоминаем о себе раз в 20 секунд (удар — 5 секунд)
const STORE = 'zvonilka.v1';
export const MAX_PEERS = 7;       // восемь человек в комнате: в сетке каждый шлёт поток каждому
export const DEFAULT_NAME = 'Гость';

const te = new TextEncoder();
const td = new TextDecoder();
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

// ---------------------------------------------------------------- события

const handlers = new Map();

// change — состояние изменилось, пора перерисовать; track(вид) — своя дорожка заменена;
// notice({type, peer}) — кто-то вошёл, вышел или не соединился; chat({peer, text});
// media-error({what, name, insecure}); left — мы вышли.
export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, []);
  handlers.get(type).push(fn);
}

function emit(type, data) {
  for (const fn of handlers.get(type) || []) {
    try { fn(data); } catch (e) { console.error('Звонилка:', e); }
  }
}

let changeTimer = 0;
function changed() {
  if (!changeTimer) changeTimer = setTimeout(() => { changeTimer = 0; emit('change'); }, 0);
}

// ---------------------------------------------------------------- настройки

// Живут в браузере: имя, свой цвет, выбранные устройства, угол своей плитки, громкости людей
// и какие подсказки уже показаны.
export const prefs = { name: '', hue: -1, cam: true, micId: '', camId: '', pip: 'br', vol: Object.create(null), hints: Object.create(null) };

(function loadPrefs() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (_) {}
  if (!saved || typeof saved !== 'object') saved = {};
  if (typeof saved.name === 'string') prefs.name = cleanName(saved.name);
  if (Number.isInteger(saved.hue) && saved.hue >= 0 && saved.hue < 360) prefs.hue = saved.hue;
  if (saved.cam === false) prefs.cam = false;
  if (typeof saved.micId === 'string') prefs.micId = saved.micId;
  if (typeof saved.camId === 'string') prefs.camId = saved.camId;
  if (/^[tb][lr]$/.test(saved.pip)) prefs.pip = saved.pip;
  for (const key of ['vol', 'hints']) {
    const src = saved[key];
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src).slice(0, 300)) if (v && (key === 'hints' || typeof v === 'object')) prefs[key][k] = v;
  }
  if (prefs.hue < 0) prefs.hue = Math.floor(Math.random() * 360);
})();

export function savePrefs() {
  try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch (_) {}
}

export function cleanName(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
}

const cleanHue = (h, id) => (Number.isInteger(h) && h >= 0 && h < 360 ? h : parseInt(id.slice(0, 6), 16) % 360);

// ---------------------------------------------------------------- комната

// Комната — строка: регистр не важен, пробелы и знаки превращаются в дефис.
export function normalizeRoom(s) {
  return String(s == null ? '' : s).normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

export function newRoom() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const out = [];
  const buf = new Uint8Array(32);
  while (out.length < 16) {
    crypto.getRandomValues(buf);
    for (const b of buf) if (b < 252 && out.length < 16) out.push(chars[b % 36]); // 252 = 36 × 7: без перекоса
  }
  return out.join('');
}

// Стартовый параметр Telegram — только латиница, цифры и «_»; всё остальное идёт как X + hex.
export function roomParam(room) {
  return /^[a-z0-9_]{1,64}$/.test(room) ? room : 'X' + hex(te.encode(room));
}

export function paramRoom(param) {
  const m = /^X((?:[0-9a-f]{2})+)$/.exec(String(param || ''));
  if (!m) return normalizeRoom(param);
  try { return normalizeRoom(td.decode(Uint8Array.from(m[1].match(/../g), (h) => parseInt(h, 16)))); } catch (_) { return ''; }
}

function unescapeUri(s) {
  try { return decodeURIComponent(s); } catch (_) { return s; }
}

// Код, ссылка на страницу, ссылка Telegram или ссылка прежней Звонилки (…/room/код).
export function parseRoom(text) {
  const s = String(text == null ? '' : text).trim();
  let m;
  if ((m = /[?&](?:startapp|tgWebAppStartParam)=([^&#\s]+)/.exec(s))) return paramRoom(unescapeUri(m[1]));
  if ((m = /#([^#\s]+)$/.exec(s))) return normalizeRoom(unescapeUri(m[1]));
  if ((m = /\/room\/([^/?#\s]+)/.exec(s))) return normalizeRoom(unescapeUri(m[1]));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return '';
  return normalizeRoom(s);
}

// ---------------------------------------------------------------- сигналинг: шифрование

async function deriveRoom(room) {
  const ikm = await crypto.subtle.importKey('raw', te.encode(room), 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode('zvonilka'), info: te.encode('zvonilka signal v1') }, ikm, 48 * 8));
  const topic = 'zvonilka/' + hex(bits.subarray(0, 16));
  const aes = await crypto.subtle.importKey('raw', bits.slice(16, 48), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { topic, aes, ad: te.encode(topic) };
}

async function seal(k, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: k.ad }, k.aes, te.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

async function unseal(k, bytes) {
  if (bytes.length < 28) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: k.ad }, k.aes, bytes.subarray(12));
    return JSON.parse(td.decode(pt));
  } catch (_) { return null; } // чужое или испорченное
}

// ---------------------------------------------------------------- сигналинг: MQTT
// MQTT 3.1.1 поверх WebSocket: CONNECT, SUBSCRIBE и PUBLISH с QoS 0 — больше ничего не нужно.

function mqttPacket(first, parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const len = [];
  let x = n;
  do { let b = x % 128; x = Math.floor(x / 128); if (x > 0) b |= 128; len.push(b); } while (x > 0);
  const out = new Uint8Array(1 + len.length + n);
  out[0] = first;
  out.set(len, 1);
  let o = 1 + len.length;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function mqttStr(s) {
  const b = te.encode(s);
  return Uint8Array.of(b.length >> 8, b.length & 255, ...b);
}

// Соединение с одним брокером; само переподключается, пока его не закроют.
function broker(url, topic, onPayload, onReady) {
  const b = { ready: false, closed: false };
  let sock = null, ping = 0, retry = 0, timer = 0;

  function again() {
    if (!b.closed) timer = setTimeout(open, Math.min(15000, 800 * 2 ** retry++));
  }

  function open() {
    if (b.closed) return;
    let s;
    try { s = new WebSocket(url, ['mqtt']); } catch (_) { return again(); }
    sock = s;
    s.binaryType = 'arraybuffer';
    let buf = new Uint8Array(0);
    let drop = 0; // сколько байт слишком большого пакета ещё пропустить
    s.onopen = () => {
      s.send(mqttPacket(0x10, [mqttStr('MQTT'), Uint8Array.of(4, 2, 0, 60), mqttStr('zv-' + randomHex(6))]));
      ping = setInterval(() => s.readyState === WebSocket.OPEN && s.send(Uint8Array.of(0xc0, 0)), 30000);
    };
    s.onmessage = (ev) => {
      let add = new Uint8Array(ev.data);
      if (drop > 0) {
        const d = Math.min(drop, add.length);
        drop -= d;
        add = add.subarray(d);
        if (!add.length) return;
      }
      const joined = new Uint8Array(buf.length + add.length);
      joined.set(buf);
      joined.set(add, buf.length);
      buf = joined;
      for (;;) {
        let i = 1, n = 0, mult = 1;
        for (; i < buf.length && i <= 4; i++) { n += (buf[i] & 127) * mult; mult *= 128; if (!(buf[i] & 128)) break; }
        if (i >= buf.length) return;
        const total = i + 1 + n;
        if (n > 1 << 18) {
          // В публичную тему может написать кто угодно: лишнее пропускаем, соединение держим.
          if (buf.length >= total) { buf = buf.slice(total); continue; }
          drop = total - buf.length;
          buf = new Uint8Array(0);
          return;
        }
        if (buf.length < total) return;
        const type = buf[0] >> 4, qos = (buf[0] >> 1) & 3, body = buf.subarray(i + 1, total);
        buf = buf.slice(total);
        if (type === 2 && body[1] === 0) s.send(mqttPacket(0x82, [Uint8Array.of(0, 1), mqttStr(topic), Uint8Array.of(0)]));
        else if (type === 9) { b.ready = true; retry = 0; onReady(b); }
        else if (type === 3 && body.length >= 2) {
          const tl = (body[0] << 8) | body[1];
          if (td.decode(body.subarray(2, 2 + tl)) === topic) onPayload(body.slice(2 + tl + (qos ? 2 : 0)));
        }
      }
    };
    s.onclose = () => {
      if (sock !== s) return;
      b.ready = false;
      clearInterval(ping);
      again();
    };
  }

  b.publish = (bytes) => {
    if (b.ready && sock && sock.readyState === WebSocket.OPEN) sock.send(mqttPacket(0x30, [mqttStr(topic), bytes]));
  };
  b.close = () => {
    b.closed = true;
    b.ready = false;
    clearTimeout(timer);
    clearInterval(ping);
    if (sock) { sock.onclose = null; try { sock.close(); } catch (_) {} }
  };
  open();
  return b;
}

// Сообщения комнаты: запечатать и разослать через все брокеры, принять, расшифровать и отсеять
// повторы. У каждого отправителя свой счётчик: вторая копия через другой брокер и сообщение,
// записанное и присланное снова, приходят с уже виденным номером.
const sig = (() => {
  let k = null, brokers = [], n = 0, pending = [], gen = 0, bye = null;
  let order = Promise.resolve(), rx = Promise.resolve();
  let handler = null;
  const seen = new Map(); // отправитель → { top, set }

  function fresh(from, num) {
    if (!Number.isSafeInteger(num) || num < 1) return false;
    let s = seen.get(from);
    if (!s) { s = { top: 0, set: new Set() }; seen.set(from, s); }
    if (num <= s.top - 512 || s.set.has(num)) return false;
    s.set.add(num);
    if (num > s.top) s.top = num;
    if (s.set.size > 1024) for (const x of s.set) if (x <= s.top - 512) s.set.delete(x);
    return true;
  }

  function onPayload(bytes) {
    const key = k;
    rx = rx.then(async () => {
      if (key !== k) return;
      const m = await unseal(key, bytes);
      if (!m || m.v !== 1 || typeof m.f !== 'string' || m.f === me.id || !/^[0-9a-f]{16}$/.test(m.f)) return;
      if (!fresh(m.f, m.n)) return;
      if (m.to && m.to !== me.id) return;
      handler(m);
    }).catch((e) => console.warn('Звонилка: сигналинг', e));
  }

  function flush() {
    const queue = pending;
    pending = [];
    for (const bytes of queue) for (const b of brokers) b.publish(bytes);
  }

  function close() {
    for (const b of brokers) b.close();
    brokers = [];
    k = null;
    bye = null;
  }

  return {
    async start(room, onMessage, onReady) {
      const mine = ++gen;
      close();
      const key = await deriveRoom(room);
      if (mine !== gen) return; // пока считали ключ, человек уже вышел
      k = key;
      n = 0;
      seen.clear();
      pending = [];
      handler = onMessage;
      brokers = BROKERS.map((url) => broker(url, key.topic, onPayload, () => { flush(); onReady(); }));
      // Прощание запечатано заранее: когда страницу закрывают, шифровать уже некогда.
      seal(key, { v: 1, f: me.id, n: 2 ** 40, t: 'bye' }).then((bytes) => { if (mine === gen) bye = bytes; });
    },
    send(obj) {
      const key = k;
      if (!key) return Promise.resolve();
      const msg = { v: 1, f: me.id, n: ++n, ...obj };
      order = order.then(async () => {
        if (key !== k) return;
        const bytes = await seal(key, msg);
        if (!brokers.some((b) => b.ready)) { pending.push(bytes); if (pending.length > 64) pending.shift(); return; }
        for (const b of brokers) b.publish(bytes);
      }).catch(() => {});
      return order;
    },
    farewell() {
      if (!bye) return false;
      for (const b of brokers) b.publish(bye);
      bye = null;
      return true;
    },
    stop() { gen++; close(); },
  };
})();

// ---------------------------------------------------------------- состояние

export const me = {
  id: randomHex(8),
  name: DEFAULT_NAME,
  hue: prefs.hue,
  room: '',
  joined: false,
  mic: false, cam: false, screen: false,   // что видят и слышат остальные
  talking: false,                          // микрофон включён только на время удержания
  audio: null, video: null, display: null, displayAudio: null,
  facing: 'user',
  camStream: new MediaStream(),            // микрофон и камера: одна группа для синхронности губ
  screenStream: new MediaStream(),         // экран и его звук
};
export const peers = new Map(); // id → участник
let session = 0;                // растёт с каждым входом: по нему опоздавшие ответы узнают, что уже не нужны
let tick = 0;

// Нужен https (или localhost) и браузер с WebRTC.
export function supported() {
  if (!window.isSecureContext || !crypto.subtle) return 'insecure';
  if (!window.RTCPeerConnection) return 'unsupported';
  return '';
}

// ---------------------------------------------------------------- участники и соединения

function peerFor(id, m) {
  let p = peers.get(id);
  if (p) {
    const name = cleanName(m.name);
    if (name && name !== p.name) { p.name = name; changed(); }
    return p;
  }
  if (peers.size >= MAX_PEERS) return null;
  p = {
    id, name: cleanName(m.name) || DEFAULT_NAME, hue: cleanHue(m.hue, id),
    polite: me.id > id,               // звонит тот, у кого идентификатор меньше; вежливый уступает
    pc: null, dc: null, tx: null, cam: null, scr: null,
    state: { mic: false, cam: false, screen: false },
    status: 'new', ever: false, makingOffer: false, ignoreOffer: false,
    cands: [], out: [], outTimer: 0, timer: 0, restarts: 0, started: 0, retryAt: 0,
    heard: Date.now(),
  };
  peers.set(id, p);
  changed();
  return p;
}

function onSignal(m) {
  if (!me.joined) return;
  if (m.t === 'bye') { const p = peers.get(m.f); if (p) dropPeer(p, 'left'); return; }
  if (m.t === 'full') { if (!peers.size) emit('notice', { type: 'full' }); return; }
  const p = peerFor(m.f, m);
  if (!p) { if (m.t === 'hello') sig.send({ t: 'full', to: m.f }); return; }
  p.heard = Date.now();
  if (m.t === 'hello') onHello(p, m);
  else if (m.t === 'desc') onDesc(p, m.d);
  else if (m.t === 'cand') onCands(p, m.c);
  else if (m.t === 'restart') { if (p.pc && !p.polite) { try { p.pc.restartIce(); } catch (_) {} } }
}

const helloMsg = (to) => ({ t: 'hello', name: me.name, hue: me.hue, ...(to ? { to } : {}) });

function onHello(p, m) {
  if (p.pc) return;
  if (p.status === 'blocked' && Date.now() < p.retryAt) return;
  if (!p.polite) connect(p);
  else if (!m.to) sig.send(helloMsg(p.id)); // чтобы звонящий точно о нас знал
}

function makePc(p) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });
  p.pc = pc;
  p.status = 'connecting';
  p.started = Date.now();
  p.makingOffer = false;
  p.ignoreOffer = false;
  pc.onicecandidate = (e) => { if (e.candidate && p.pc === pc) queueCand(p, e.candidate); };
  pc.onnegotiationneeded = () => { if (p.pc === pc) negotiate(p); };
  pc.onconnectionstatechange = () => { if (p.pc === pc) onConn(p); };
  // Канал данных одинаково объявлен с обеих сторон: открывается без своего рукопожатия.
  const dc = pc.createDataChannel('zvonilka', { negotiated: true, id: 0 });
  p.dc = dc;
  dc.onopen = () => { if (p.pc === pc) sendState(p); };
  dc.onmessage = (e) => { if (p.pc === pc) onChannel(p, e.data); };
  // Канал закрылся при живом соединении — значит, собеседник закрыл страницу.
  dc.onclose = () => { setTimeout(() => { if (p.pc === pc && peers.get(p.id) === p) dropPeer(p, 'left'); }, 1500); };
  clearTimeout(p.timer);
  p.timer = setTimeout(() => watchdog(p, pc), 7000);
  changed();
  return pc;
}

// Пока соединение не установилось: повторяем offer, если ответа нет, и сдаёмся через 25 секунд.
function watchdog(p, pc) {
  if (p.pc !== pc || p.status === 'connected' || p.ever) return;
  if (Date.now() - p.started > 25000) return blocked(p);
  if (!p.polite && pc.signalingState === 'have-local-offer' && pc.localDescription) sendDesc(p, pc.localDescription);
  p.timer = setTimeout(() => watchdog(p, pc), 7000);
}

function connect(p) {
  const pc = makePc(p);
  p.tx = [
    pc.addTransceiver('audio', { direction: 'sendrecv', streams: [me.camStream] }),
    pc.addTransceiver('video', { direction: 'sendrecv', streams: [me.camStream] }),
    pc.addTransceiver('video', { direction: 'sendrecv', streams: [me.screenStream] }),
    pc.addTransceiver('audio', { direction: 'sendrecv', streams: [me.screenStream] }),
  ];
  wire(p);
}

const KINDS = ['audio', 'video', 'display', 'displayAudio'];

// Что сейчас уходит в канал. Выключенный микрофон остаётся у нас (по нему видно, что человек
// говорит в пустоту), но собеседникам не идёт ничего.
const outgoing = (kind) => (kind === 'audio' && !me.mic ? null : me[kind]);

// Свои дорожки — в каналы, чужие — в потоки для плиток.
function wire(p) {
  p.tx.forEach((t, i) => t.sender.replaceTrack(outgoing(KINDS[i])).catch(() => {}));
  p.cam = new MediaStream([p.tx[0].receiver.track, p.tx[1].receiver.track]);
  p.scr = new MediaStream([p.tx[2].receiver.track, p.tx[3].receiver.track]);
  applyQuality();
  changed();
}

function pushTrack(kind) {
  const i = KINDS.indexOf(kind), track = outgoing(kind);
  for (const p of peers.values()) if (p.tx) p.tx[i].sender.replaceTrack(track).catch(() => {});
}

function sendDesc(p, d) {
  sendTo(p, { t: 'desc', d: { type: d.type, sdp: d.sdp } });
}

async function negotiate(p) {
  const pc = p.pc;
  try {
    p.makingOffer = true;
    await pc.setLocalDescription();
    if (p.pc === pc) sendDesc(p, pc.localDescription);
  } catch (e) {
    console.warn('Звонилка: offer', e);
  } finally {
    p.makingOffer = false;
  }
}

// «Идеальное согласование»: при встречных offer вежливая сторона откатывает свой.
async function onDesc(p, d) {
  if (!d || (d.type !== 'offer' && d.type !== 'answer') || typeof d.sdp !== 'string') return;
  if (!p.pc) {
    if (d.type !== 'offer') return;
    makePc(p);
  }
  const pc = p.pc;
  try {
    const collision = d.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
    p.ignoreOffer = !p.polite && collision;
    if (p.ignoreOffer) return;
    await pc.setRemoteDescription(d);
    if (p.pc !== pc) return;
    if (d.type === 'offer') {
      if (!p.tx) {
        const t = pc.getTransceivers();
        if (t.length < 4) throw new Error('в offer не хватает каналов');
        p.tx = t.slice(0, 4);
        for (const x of p.tx) x.direction = 'sendrecv';
        if (p.tx[0].sender.setStreams) {
          p.tx[0].sender.setStreams(me.camStream);
          p.tx[1].sender.setStreams(me.camStream);
          p.tx[2].sender.setStreams(me.screenStream);
          p.tx[3].sender.setStreams(me.screenStream);
        }
        wire(p);
      }
      await pc.setLocalDescription();
      if (p.pc !== pc) return;
      sendDesc(p, pc.localDescription);
    }
    const queued = p.cands;
    p.cands = [];
    for (const c of queued) addCand(p, c);
  } catch (e) {
    console.warn('Звонилка: описание сеанса', e);
  }
}

// Кандидаты ICE уходят пачками: меньше сообщений через брокер.
function queueCand(p, c) {
  p.out.push({ candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex });
  if (p.outTimer) return;
  p.outTimer = setTimeout(() => {
    p.outTimer = 0;
    const list = p.out;
    p.out = [];
    if (p.pc && list.length) sendTo(p, { t: 'cand', c: list });
  }, 40);
}

function onCands(p, list) {
  if (!Array.isArray(list)) return;
  for (const c of list.slice(0, 40)) {
    if (!c || typeof c.candidate !== 'string') continue;
    if (p.pc && p.pc.remoteDescription) addCand(p, c);
    else if (p.cands.length < 80) p.cands.push(c);
  }
}

async function addCand(p, c) {
  try { await p.pc.addIceCandidate(c); } catch (e) { if (!p.ignoreOffer) console.warn('Звонилка: кандидат', e); }
}

const live = (p) => !!p.pc && p.pc.connectionState === 'connected';

// Пока соединение живо — по каналу данных, иначе — через брокеры.
function sendTo(p, msg) {
  if (live(p) && p.dc && p.dc.readyState === 'open') {
    try { p.dc.send(JSON.stringify(msg)); return; } catch (_) {}
  }
  sig.send({ ...msg, to: p.id });
}

function onConn(p) {
  const s = p.pc.connectionState;
  if (s === 'connected') {
    const first = !p.ever;
    p.status = 'connected';
    p.ever = true;
    p.restarts = 0;
    clearTimeout(p.timer);
    sendState(p);
    applyQuality();
    if (first) emit('notice', { type: 'joined', peer: p });
    changed();
  } else if (s === 'disconnected') {
    p.status = 'reconnecting';
    changed();
    clearTimeout(p.timer);
    p.timer = setTimeout(() => { if (p.pc && !live(p)) restart(p); }, 4000);
  } else if (s === 'failed') {
    if (!p.ever) blocked(p);
    else if (p.restarts < 3) restart(p);
    else dropPeer(p, 'lost');
  }
}

// Путь пропал (сменилась сеть): новый offer с перезапуском ICE делает звонившая сторона.
function restart(p) {
  p.restarts++;
  p.status = 'reconnecting';
  changed();
  if (!p.polite) { try { p.pc.restartIce(); } catch (_) {} }
  else sig.send({ t: 'restart', to: p.id });
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    if (!p.pc || live(p)) return;
    if (p.restarts < 3) restart(p); else dropPeer(p, 'lost');
  }, 8000);
}

// Прямого пути нет: у обоих строгий NAT. Попробуем ещё раз позже, если участник не уйдёт.
function blocked(p) {
  closePc(p);
  p.status = 'blocked';
  p.retryAt = Date.now() + 45000;
  emit('notice', { type: 'blocked', peer: p });
  changed();
}

// later — дать уже отправленному прощанию уйти, прежде чем рвать соединение.
function closePc(p, later) {
  clearTimeout(p.timer);
  clearTimeout(p.outTimer);
  p.outTimer = 0;
  p.out = [];
  p.cands = [];
  const pc = p.pc, dc = p.dc;
  p.pc = null;
  p.dc = null;
  p.tx = null;
  p.cam = null;
  p.scr = null;
  if (!pc) return;
  pc.onicecandidate = pc.onnegotiationneeded = pc.onconnectionstatechange = null;
  if (dc) dc.onopen = dc.onmessage = dc.onclose = null;
  const close = () => { try { pc.close(); } catch (_) {} };
  if (later) setTimeout(close, 250); else close();
}

function dropPeer(p, why) {
  if (peers.get(p.id) !== p) return;
  const was = p.ever;
  closePc(p);
  peers.delete(p.id);
  if (why === 'lost' || (why === 'left' && was)) emit('notice', { type: why, peer: p });
  applyQuality();
  changed();
}

// ---------------------------------------------------------------- канал данных

function onChannel(p, data) {
  if (typeof data !== 'string' || data.length > 200000) return;
  let m;
  try { m = JSON.parse(data); } catch (_) { return; }
  if (!m || typeof m !== 'object') return;
  if (m.t === 'state') {
    p.state = { mic: !!m.mic, cam: !!m.cam, screen: !!m.screen };
    const name = cleanName(m.name);
    if (name) p.name = name;
    p.hue = cleanHue(m.hue, p.id);
    changed();
  } else if (m.t === 'desc') onDesc(p, m.d);
  else if (m.t === 'cand') onCands(p, m.c);
  else if (m.t === 'chat') { const text = String(m.text == null ? '' : m.text).slice(0, 2000); if (text) emit('chat', { peer: p, text }); }
  else if (m.t === 'bye') dropPeer(p, 'left');
}

function sendState(p) {
  if (!p.dc || p.dc.readyState !== 'open') return;
  try { p.dc.send(JSON.stringify({ t: 'state', name: me.name, hue: me.hue, mic: me.mic, cam: me.cam, screen: me.screen })); } catch (_) {}
}

function broadcastState() {
  for (const p of peers.values()) sendState(p);
  changed();
}

// Сообщение всем, кто сейчас в звонке; истории нет — она у каждого своя.
export function sendChat(text) {
  const msg = JSON.stringify({ t: 'chat', text: String(text).slice(0, 2000) });
  for (const p of peers.values()) {
    if (p.dc && p.dc.readyState === 'open') { try { p.dc.send(msg); } catch (_) {} }
  }
}

export function setName(value) {
  me.name = cleanName(value) || DEFAULT_NAME;
  broadcastState();
}

// Громкость речи участника от 0 до 1: браузер считает её сам, своей обработки звука не нужно.
export function level(p) {
  if (!p.tx || p.status !== 'connected' || !p.state.mic) return 0;
  try {
    const s = p.tx[0].receiver.getSynchronizationSources()[0];
    return s && s.audioLevel ? s.audioLevel : 0;
  } catch (_) { return 0; }
}

// ---------------------------------------------------------------- микрофон, камера, экран

function audioWish() {
  return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(prefs.micId ? { deviceId: { exact: prefs.micId } } : {}) };
}

function videoWish() {
  return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, ...(prefs.camId ? { deviceId: { exact: prefs.camId } } : { facingMode: me.facing }) };
}

// Ставит дорожку в свой канал у всех участников и в свой предпросмотр; прежнюю останавливает.
function setTrack(kind, track) {
  const old = me[kind];
  if (old === (track || null)) return;
  if (old) { old.onended = null; try { old.stop(); } catch (_) {} }
  me[kind] = track || null;
  const stream = kind === 'audio' || kind === 'video' ? me.camStream : me.screenStream;
  if (old) { try { stream.removeTrack(old); } catch (_) {} }
  if (track) {
    stream.addTrack(track);
    track.onended = () => { if (me[kind] === track) trackGone(kind); };
  }
  pushTrack(kind);
  applyQuality();
  emit('track', kind);
}

// Устройство отключили или показ остановили кнопкой браузера.
function trackGone(kind) {
  if (kind === 'audio') { me.mic = false; me.talking = false; }
  if (kind === 'video') me.cam = false;
  setTrack(kind, null);
  if (kind === 'display') { setTrack('displayAudio', null); me.screen = false; }
  broadcastState();
}

function mediaError(what, e) {
  emit('media-error', { what, name: e && e.name, insecure: !navigator.mediaDevices || !window.isSecureContext });
}

async function userMedia(wish) {
  try {
    return await navigator.mediaDevices.getUserMedia(wish);
  } catch (e) {
    // Запомненного устройства больше нет — берём то, что есть.
    if (e && e.name === 'OverconstrainedError' && (prefs.micId || prefs.camId)) {
      prefs.micId = '';
      prefs.camId = '';
      savePrefs();
      return navigator.mediaDevices.getUserMedia({ audio: wish.audio ? audioWish() : false, video: wish.video ? videoWish() : false });
    }
    throw e;
  }
}

// При входе: микрофон и, если так было в прошлый раз, камера — одним запросом разрешения.
async function startMedia() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return mediaError('both', null);
  const mine = session;
  const wantCam = prefs.cam !== false;
  let stream = null;
  try {
    stream = await userMedia({ audio: audioWish(), video: wantCam ? videoWish() : false });
  } catch (e) {
    if (!wantCam) return mediaError('mic', e);
    try {
      stream = await userMedia({ audio: audioWish(), video: false });
      if (e.name !== 'NotFoundError') mediaError('cam', e);
    } catch (e2) {
      return mediaError('both', e2);
    }
  }
  if (!me.joined || mine !== session) { for (const t of stream.getTracks()) t.stop(); return; }
  const a = stream.getAudioTracks()[0], v = stream.getVideoTracks()[0];
  if (a) { me.mic = true; setTrack('audio', a); }
  if (v) { me.cam = true; setTrack('video', v); }
  broadcastState();
}

let busy = false; // пока браузер спрашивает разрешение, второе нажатие ничего не делает

export async function toggleMic() {
  if (busy || !me.joined) return;
  if (me.audio) {
    me.mic = !me.mic;
    me.talking = false;
    pushTrack('audio');
  } else {
    busy = true;
    try {
      const s = await userMedia({ audio: audioWish(), video: false });
      me.mic = true;
      setTrack('audio', s.getAudioTracks()[0]);
    } catch (e) { mediaError('mic', e); }
    busy = false;
  }
  broadcastState();
}

// «Удерживайте, чтобы сказать»: микрофон включён, пока держат кнопку или пробел.
// Возвращает, началась ли речь: если микрофон и так включён или его ещё нет — нет.
export function talk(on) {
  if (on) {
    if (me.mic || !me.audio || !me.joined) return false;
    me.mic = true;
    me.talking = true;
  } else {
    if (!me.talking) return false;
    me.mic = false;
    me.talking = false;
  }
  pushTrack('audio');
  broadcastState();
  return true;
}

export async function toggleCam() {
  if (busy || !me.joined) return;
  if (me.video) {
    me.cam = false;
    setTrack('video', null); // камера гаснет совсем, а не шлёт чёрный кадр
  } else {
    busy = true;
    try {
      const s = await userMedia({ audio: false, video: videoWish() });
      me.cam = true;
      setTrack('video', s.getVideoTracks()[0]);
    } catch (e) { mediaError('cam', e); }
    busy = false;
  }
  prefs.cam = me.cam;
  savePrefs();
  broadcastState();
}

// Передняя ↔ задняя. Телефон не даёт открыть две камеры сразу, поэтому сначала гасим прежнюю.
export async function flipCam() {
  if (busy || !me.video) return;
  busy = true;
  me.facing = me.facing === 'user' ? 'environment' : 'user';
  prefs.camId = '';
  setTrack('video', null);
  try {
    const s = await userMedia({ audio: false, video: videoWish() });
    setTrack('video', s.getVideoTracks()[0]);
  } catch (e) {
    me.cam = false;
    mediaError('cam', e);
  }
  busy = false;
  broadcastState();
}

export async function toggleScreen() {
  if (busy || !me.joined) return;
  if (me.display) {
    me.screen = false;
    setTrack('display', null);
    setTrack('displayAudio', null);
    return broadcastState();
  }
  busy = true;
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
    const v = s.getVideoTracks()[0], a = s.getAudioTracks()[0];
    try { v.contentHint = 'detail'; } catch (_) {}
    me.screen = true;
    setTrack('display', v);
    setTrack('displayAudio', a || null);
  } catch (e) {
    if (!e || e.name !== 'NotAllowedError') mediaError('screen', e);
  }
  busy = false;
  broadcastState();
}

// Чем больше людей, тем скромнее поток каждому: в сетке их приходится слать всем.
function applyQuality() {
  let n = 0;
  for (const p of peers.values()) if (p.status === 'connected') n++;
  const cam = n <= 1 ? [2000, 1, 30] : n === 2 ? [1000, 1, 30] : n === 3 ? [650, 1.5, 30] : n <= 5 ? [380, 2, 24] : [220, 3, 15];
  const scr = n <= 2 ? 2500 : n <= 4 ? 1500 : 900;
  for (const p of peers.values()) {
    if (!p.tx) continue;
    setEncoding(p.tx[1].sender, { maxBitrate: cam[0] * 1000, scaleResolutionDownBy: cam[1], maxFramerate: cam[2] });
    setEncoding(p.tx[2].sender, { maxBitrate: scr * 1000 });
    setEncoding(p.tx[3].sender, { maxBitrate: 128000 });
  }
}

async function setEncoding(sender, enc) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) return; // ещё не согласовано
    Object.assign(params.encodings[0], enc);
    await sender.setParameters(params);
  } catch (_) {}
}

// Микрофоны и камеры для выбора. Названия появляются только после разрешения на доступ.
export async function devices() {
  let list = [];
  try { list = await navigator.mediaDevices.enumerateDevices(); } catch (_) {}
  const pick = (kind, saved, track) => {
    const all = list.filter((d) => d.kind === kind && d.label);
    const active = track && track.getSettings ? track.getSettings().deviceId : '';
    const has = (id) => !!id && all.some((d) => d.deviceId === id);
    return { list: all.map((d) => ({ id: d.deviceId, label: d.label })), current: has(saved) ? saved : has(active) ? active : '' };
  };
  return { mic: pick('audioinput', prefs.micId, me.audio), cam: pick('videoinput', prefs.camId, me.video) };
}

export async function chooseDevice(kind, id) {
  if (busy || !me.joined) return;
  busy = true;
  try {
    if (kind === 'mic') {
      prefs.micId = id;
      const s = await userMedia({ audio: audioWish(), video: false });
      setTrack('audio', s.getAudioTracks()[0]); // включён микрофон или нет — остаётся как было
    } else {
      prefs.camId = id;
      if (me.video) setTrack('video', null);
      const s = await userMedia({ audio: false, video: videoWish() });
      me.cam = true;
      prefs.cam = true;
      setTrack('video', s.getVideoTracks()[0]);
    }
    savePrefs();
  } catch (e) { mediaError(kind, e); }
  busy = false;
  broadcastState();
}

// ---------------------------------------------------------------- вход и выход

// Входит сразу, без «комнаты ожидания»: микрофон и камеру браузер спросит по ходу.
export async function join(room, name) {
  if (me.joined || supported()) return;
  const mine = ++session;
  me.id = randomHex(8); // каждый вход — новый участник: старые соединения с ним не спутаются
  me.room = room;
  me.name = cleanName(name) || DEFAULT_NAME;
  me.joined = true;
  changed();
  startMedia();
  try {
    await sig.start(room, onSignal, () => { if (me.joined) sig.send(helloMsg()); });
  } catch (e) {
    console.warn('Звонилка: вход', e);
    if (mine === session) emit('notice', { type: 'failed' });
    return;
  }
  if (mine !== session || !me.joined) return;
  clearInterval(tick);
  let beats = 0;
  tick = setInterval(() => {
    // Раз в пять секунд убираем тех, кто так и не появился; раз в двадцать напоминаем о себе.
    if (++beats % HELLO_BEATS === 0) sig.send(helloMsg());
    const now = Date.now();
    for (const p of [...peers.values()]) if (!p.pc && now - p.heard > 45000) dropPeer(p, 'silent');
  }, 5000);
}

export function leave() {
  if (!me.joined) return;
  me.joined = false;
  clearInterval(tick);
  for (const p of peers.values()) {
    if (p.dc && p.dc.readyState === 'open') { try { p.dc.send('{"t":"bye"}'); } catch (_) {} }
  }
  if (!sig.farewell()) sig.send({ t: 'bye' });
  const mine = session;
  setTimeout(() => { if (mine === session) sig.stop(); }, 600); // даём прощанию уйти
  for (const p of [...peers.values()]) closePc(p, true);
  peers.clear();
  me.mic = me.cam = me.screen = me.talking = false;
  for (const kind of KINDS) setTrack(kind, null);
  emit('left');
}

// ---------------------------------------------------------------- для проверки

// Что на самом деле идёт по каждому соединению: живой тест (tools/call_test.mjs) и консоль.
export async function stats() {
  const out = [];
  for (const p of peers.values()) {
    const o = { id: p.id, name: p.name, status: p.status, state: p.state, dc: p.dc ? p.dc.readyState : 'none', path: '', rtt: 0, audio: 0, video: 0, screen: 0, sent: 0 };
    if (p.pc && p.tx) {
      const mids = p.tx.map((t) => t.mid);
      const report = await p.pc.getStats();
      report.forEach((r) => {
        if (r.type === 'inbound-rtp') {
          if (r.mid === mids[0]) o.audio = r.packetsReceived || 0;
          else if (r.mid === mids[1]) o.video = r.framesDecoded || 0;
          else if (r.mid === mids[2]) o.screen = r.framesDecoded || 0;
        } else if (r.type === 'outbound-rtp' && r.mid === mids[1]) {
          o.sent = r.framesEncoded || 0;
        } else if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
          const a = report.get(r.localCandidateId), b = report.get(r.remoteCandidateId);
          if (a && b) o.path = a.candidateType + '/' + b.candidateType;
          o.rtt = r.currentRoundTripTime || 0;
        }
      });
    }
    out.push(o);
  }
  return out;
}
