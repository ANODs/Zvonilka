// Ретранслятор — запасной путь, когда два устройства не могут соединиться напрямую (VPN,
// мобильный интернет, строгий роутер). Все такие участники подключаются по WebSocket к комнате
// на воркере (bot/worker.js), и он раздаёт каждое сообщение остальным в комнате.
//
// Видео сжимается в браузере (WebCodecs: H.264 или VP8, 15 кадров в секунду), звук — в 16 кГц
// по μ-закону, как в телефонной связи. Каждое сообщение запечатано ключом комнаты (AES-GCM),
// поэтому воркер видит только шум и не знает ни кода комнаты, ни содержимого.
//
// Снаружи: attach(id) — начать принимать участника, вернуть его MediaStream; detach(id);
// control(id, obj) — служебное сообщение (состояние, чат, «нужен ключевой кадр»); refresh() —
// свои дорожки изменились; level(id); stats(id); close().

const te = new TextEncoder();
const td = new TextDecoder();
const RATE = 16000;          // частота звука в канале
const CHUNK = 640;           // 40 мс звука в одном сообщении
const FPS = 15;
const MAX_W = 640, MAX_H = 480;
const T_CONTROL = 1, T_AUDIO = 2, T_VIDEO = 3;

const idBytes = (id) => Uint8Array.from(id.match(/../g), (h) => parseInt(h, 16));
const idHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// G.711 μ-закон: 14 бит звука в 8, разборчиво для речи и вдвое легче простого PCM.
function muEncode(x) {
  let s = Math.max(-1, Math.min(1, x)) * 32635;
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += 132;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
}
const MU = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff, exp = (u >> 4) & 7;
  const s = (((u & 0x0f) << 3) + 132 << exp) - 132;
  MU[i] = (u & 0x80 ? -s : s) / 32768;
}

// Перевод частоты дискретизации линейной интерполяцией, с памятью между кусками: позиция
// считается от последнего отсчёта прошлого куска (он — нулевой), так что стыков не слышно.
function resampler(from, to) {
  const step = from / to;
  let pos = 0, last = 0;
  return (input) => {
    const out = [];
    while (pos < input.length) {
      const i = Math.floor(pos), f = pos - i;
      const a = i === 0 ? last : input[i - 1], b = input[i];
      out.push(a + (b - a) * f);
      pos += step;
    }
    pos -= input.length;
    last = input[input.length - 1];
    return Float32Array.from(out);
  };
}

export function createRelay({ url, topic, aes, myId, getTracks, onControl, onMedia, onLocked }) {
  const ad = te.encode(topic + '/relay');
  const me = idBytes(myId);
  const peers = new Map(); // id → { stream, canvas, decoder, codec, play, toCtx, level, frames, packets, keyAsked }
  let ws = null, closed = false, retry = 0, retryTimer = 0;
  let ctx = null;
  let sending = Promise.resolve();

  // ------------------------------------------------ сеть

  function open() {
    if (closed) return;
    const s = new WebSocket(url);
    ws = s;
    s.binaryType = 'arraybuffer';
    s.onopen = () => {
      retry = 0;
      for (const id of peers.keys()) control(id, { t: 'key' }); // после переподключения — свежие кадры
      forceKey = true;
    };
    s.onmessage = (e) => receive(new Uint8Array(e.data));
    s.onclose = () => {
      if (ws !== s || closed) return;
      retryTimer = setTimeout(open, Math.min(8000, 500 * 2 ** retry++));
    };
  }

  // Запечатать и отправить. Порядок сохраняется: шифрование асинхронное, а кадры зависят друг от друга.
  function send(type, to, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const plain = new Uint8Array(18 + payload.length);
    plain[0] = 1;
    plain[1] = type;
    plain.set(me, 2);
    if (to) plain.set(idBytes(to), 10);
    plain.set(payload, 18);
    sending = sending.then(async () => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, aes, plain));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv);
      out.set(ct, 12);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(out);
    }).catch(() => {});
    return true;
  }

  let rx = Promise.resolve();
  function receive(bytes) {
    rx = rx.then(async () => {
      if (bytes.length < 12 + 18 + 16) return;
      let plain;
      try {
        plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: ad }, aes, bytes.subarray(12)));
      } catch (_) { return; } // чужое или испорченное
      if (plain[0] !== 1) return;
      const from = idHex(plain.subarray(2, 10)), to = plain.subarray(10, 18);
      if (from === myId) return;
      if (to.some((x) => x) && idHex(to) !== myId) return;
      const type = plain[1], payload = plain.subarray(18);
      if (type === T_CONTROL) {
        let m;
        try { m = JSON.parse(td.decode(payload)); } catch (_) { return; }
        if (m && m.t === 'key') { forceKey = true; return; }
        if (m && m.t === 'hi') { if (peers.has(from)) onMedia(from); return; } // перекличка: «я здесь»
        onControl(from, m);
        return;
      }
      const p = peers.get(from);
      if (!p) return;
      onMedia(from);
      if (type === T_AUDIO) playAudio(p, payload);
      else if (type === T_VIDEO) showVideo(p, from, payload);
    }).catch((e) => console.warn('Звонилка: ретранслятор', e));
  }

  function control(to, obj) {
    send(T_CONTROL, to, te.encode(JSON.stringify(obj)));
  }

  // ------------------------------------------------ звук

  function audioCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.ready = ctx.audioWorklet.addModule(new URL('./relay-audio.js', import.meta.url).href);
      // Браузер включает звук только после касания страницы. Не дал — просим коснуться
      // (кнопка «Включить звук»), иначе собеседника не слышно, хотя он вас слышит.
      const wake = () => { if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); };
      addEventListener('pointerdown', wake, true);
      addEventListener('keydown', wake, true);
      addEventListener('touchend', wake, true);
      const c = ctx;
      setTimeout(() => { if (ctx === c && c.state !== 'running' && peers.size && onLocked) onLocked(); }, 600);
      c.onstatechange = () => { if (ctx === c && c.state !== 'running' && peers.size && onLocked) onLocked(); };
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  }

  let mic = null;      // { track, node, src, down, buf, fill }
  let micWant = null;  // какую дорожку сейчас подключаем: пока грузится обработчик звука, второй раз не начинаем

  async function startMic(track) {
    stopMic();
    micWant = track;
    const c = audioCtx();
    await c.ready;
    if (closed || micWant !== track || track.readyState !== 'live') return;
    const src = c.createMediaStreamSource(new MediaStream([track]));
    const node = new AudioWorkletNode(c, 'zv-capture');
    const m = { track, node, src, down: resampler(c.sampleRate, RATE), buf: new Uint8Array(CHUNK), fill: 0 };
    node.port.onmessage = (e) => {
      if (mic !== m || !peers.size) return;
      for (const x of m.down(e.data)) {
        m.buf[m.fill++] = muEncode(x);
        if (m.fill === CHUNK) { send(T_AUDIO, '', m.buf); m.buf = new Uint8Array(CHUNK); m.fill = 0; }
      }
    };
    src.connect(node);
    mic = m;
  }

  function stopMic() {
    micWant = null;
    if (!mic) return;
    try { mic.src.disconnect(); mic.node.disconnect(); } catch (_) {}
    mic.node.port.onmessage = null;
    mic = null;
  }

  function playAudio(p, payload) {
    if (!p.play) return;
    const pcm = new Float32Array(payload.length);
    let sum = 0;
    for (let i = 0; i < payload.length; i++) { const v = MU[payload[i]]; pcm[i] = v; sum += v * v; }
    p.level = Math.min(1, Math.sqrt(sum / payload.length) * 4);
    p.packets++;
    p.play.port.postMessage(p.up(pcm));
  }

  // ------------------------------------------------ видео

  let cam = null;      // { track, stop }
  let encoder = null, encCodec = '', encW = 0, encH = 0, lastKey = 0, forceKey = true;

  async function pickCodec(w, h) {
    if (!window.VideoEncoder) return null;
    const tries = [
      { codec: 'avc1.42001f', avc: { format: 'annexb' } },
      { codec: 'vp8' },
    ];
    for (const t of tries) {
      const config = { ...t, width: w, height: h, bitrate: 450000, framerate: FPS, latencyMode: 'realtime' };
      try { if ((await VideoEncoder.isConfigSupported(config)).supported) return config; } catch (_) {}
    }
    return null;
  }

  let configuring = false;

  async function encodeFrame(source, sw, sh) {
    const k = Math.min(1, MAX_W / sw, MAX_H / sh);
    const w = Math.max(2, Math.round(sw * k / 2) * 2), h = Math.max(2, Math.round(sh * k / 2) * 2);
    if (!encoder || w !== encW || h !== encH) {
      if (configuring) return;
      if (encoder) { try { encoder.close(); } catch (_) {} encoder = null; }
      configuring = true;
      const config = await pickCodec(w, h).finally(() => { configuring = false; });
      if (!config || closed) return;
      encW = w; encH = h; encCodec = config.codec;
      encoder = new VideoEncoder({ output: sendChunk, error: (e) => { console.warn('Звонилка: кодирование видео', e); encoder = null; } });
      encoder.configure(config);
      forceKey = true;
    }
    if (encoder.encodeQueueSize > 2) return; // не успеваем — пропускаем кадр, а не копим задержку
    const canvas = encodeFrame.canvas || (encodeFrame.canvas = document.createElement('canvas'));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    canvas.getContext('2d').drawImage(source, 0, 0, w, h);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) });
    const now = performance.now();
    const key = forceKey || now - lastKey > 4000;
    if (key) { forceKey = false; lastKey = now; }
    try { encoder.encode(frame, { keyFrame: key }); } catch (_) {}
    frame.close();
  }

  function sendChunk(chunk) {
    // Сеть не успевает — промежуточные кадры выбрасываем, следующий будет ключевым.
    if (ws && ws.bufferedAmount > 600000) { forceKey = true; return; }
    const codec = te.encode(encCodec);
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const out = new Uint8Array(6 + codec.length + data.length);
    out[0] = chunk.type === 'key' ? 1 : 0;
    out[1] = codec.length;
    out.set(codec, 2);
    const o = 2 + codec.length;
    out[o] = encW >> 8; out[o + 1] = encW & 255; out[o + 2] = encH >> 8; out[o + 3] = encH & 255;
    out.set(data, o + 4);
    send(T_VIDEO, '', out);
  }

  function startCam(track) {
    stopCam();
    if (!track || track.readyState !== 'live' || !window.VideoEncoder) return;
    let alive = true, last = 0;
    const c = { track, stop: () => { alive = false; } };
    cam = c;
    if (window.MediaStreamTrackProcessor) {
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      c.stop = () => { alive = false; reader.cancel().catch(() => {}); };
      (async () => {
        while (alive) {
          const { value: frame, done } = await reader.read().catch(() => ({ done: true }));
          if (done) break;
          const now = performance.now();
          if (peers.size && now - last >= 1000 / FPS - 5) { last = now; await encodeFrame(frame, frame.displayWidth, frame.displayHeight).catch(() => {}); }
          frame.close();
        }
      })();
    } else {
      // Safari: кадры берём с невидимого видео.
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = new MediaStream([track]);
      v.play().catch(() => {});
      const timer = setInterval(() => {
        if (alive && peers.size && v.readyState >= 2 && v.videoWidth) encodeFrame(v, v.videoWidth, v.videoHeight).catch(() => {});
      }, 1000 / FPS);
      c.stop = () => { alive = false; clearInterval(timer); v.srcObject = null; };
    }
  }

  function stopCam() {
    if (cam) cam.stop();
    cam = null;
  }

  function showVideo(p, from, payload) {
    const key = payload[0] === 1, n = payload[1];
    const codec = td.decode(payload.subarray(2, 2 + n));
    const data = payload.subarray(6 + n);
    if (!window.VideoDecoder) return;
    if (!p.decoder || p.decoder.state === 'closed' || p.codec !== codec) {
      if (!key) { askKey(p, from); return; }
      try { if (p.decoder && p.decoder.state !== 'closed') p.decoder.close(); } catch (_) {}
      p.decoder = new VideoDecoder({
        output: (frame) => {
          const cv = p.canvas;
          if (cv.width !== frame.displayWidth || cv.height !== frame.displayHeight) { cv.width = frame.displayWidth; cv.height = frame.displayHeight; }
          cv.getContext('2d').drawImage(frame, 0, 0);
          frame.close();
          p.frames++;
        },
        error: () => { p.decoder = null; askKey(p, from); },
      });
      p.decoder.configure({ codec, optimizeForLatency: true });
      p.codec = codec;
    }
    if (p.decoder.decodeQueueSize > 4 && !key) return;
    try {
      p.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Math.round(performance.now() * 1000), data }));
    } catch (_) { p.decoder = null; askKey(p, from); }
  }

  function askKey(p, from) {
    const now = performance.now();
    if (now - p.keyAsked < 1000) return;
    p.keyAsked = now;
    control(from, { t: 'key' });
  }

  // ------------------------------------------------ участники

  function attach(id) {
    if (peers.has(id)) return peers.get(id).stream;
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const tracks = [];
    if (canvas.captureStream) tracks.push(...canvas.captureStream(FPS).getVideoTracks());
    const p = { stream: null, canvas, decoder: null, codec: '', play: null, up: null, level: 0, frames: 0, packets: 0, keyAsked: 0 };
    // Звук — прямо в динамик через звуковой движок, громкость — своим регулятором. Через
    // видеоэлемент надёжнее не выходит: на iPhone такой звук порой молчит.
    const c = audioCtx();
    p.gain = c.createGain();
    p.gain.connect(c.destination);
    p.stream = new MediaStream(tracks);
    c.ready.then(() => {
      if (peers.get(id) !== p) return;
      p.play = new AudioWorkletNode(c, 'zv-play');
      p.up = resampler(RATE, c.sampleRate);
      p.play.connect(p.gain);
    }).catch((e) => console.warn('Звонилка: звук ретранслятора', e));
    peers.set(id, p);
    forceKey = true;
    control(id, { t: 'key' });
    refresh();
    return p.stream;
  }

  function detach(id) {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    try { if (p.decoder && p.decoder.state !== 'closed') p.decoder.close(); } catch (_) {}
    try { if (p.play) p.play.disconnect(); p.gain.disconnect(); } catch (_) {}
    for (const t of p.stream.getTracks()) t.stop();
    if (!peers.size) { stopMic(); stopCam(); }
  }

  // Свои дорожки поменялись: включили или выключили микрофон, камеру.
  function refresh() {
    const { audio, video } = getTracks();
    if (!peers.size) { stopMic(); stopCam(); return; }
    if ((mic ? mic.track : micWant) !== audio) { if (audio) startMic(audio); else stopMic(); }
    if ((cam && cam.track) !== video) { if (video) startCam(video); else stopCam(); }
  }

  function close() {
    closed = true;
    clearInterval(hiTimer);
    clearTimeout(retryTimer);
    for (const id of [...peers.keys()]) detach(id);
    stopMic();
    stopCam();
    if (encoder) { try { encoder.close(); } catch (_) {} encoder = null; }
    if (ws) { ws.onclose = null; try { ws.close(); } catch (_) {} }
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
  }

  // Перекличка: тот, у кого нет ни микрофона, ни камеры, иначе молчал бы, и его сочли бы пропавшим.
  const hiTimer = setInterval(() => { if (peers.size) control('', { t: 'hi' }); }, 4000);

  open();
  return {
    attach, detach, control, refresh, close,
    level: (id) => (peers.get(id) ? peers.get(id).level : 0),
    volume: (id, v) => { const p = peers.get(id); if (p) p.gain.gain.value = v; },
    locked: () => !!ctx && ctx.state !== 'running' && peers.size > 0,
    unlock: () => { if (ctx && ctx.state !== 'running') return ctx.resume().catch(() => {}); },
    stats: (id) => { const p = peers.get(id); return p ? { audio: p.packets, video: p.frames } : { audio: 0, video: 0 }; },
    ready: () => !!ws && ws.readyState === WebSocket.OPEN,
  };
}
