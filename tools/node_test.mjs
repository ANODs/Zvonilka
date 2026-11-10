#!/usr/bin/env node
// Живая проверка медиа-узла (node/): участники в безголовом Chrome соединяются только через
// узел, настоящие брокеры и настоящий WebRTC, камера и микрофон — тестовые.
//
//   node tools/node_test.mjs                  проверка (оба профиля SRTP)
//   node tools/node_test.mjs --log            ещё и журнал узла на экран
//   node tools/node_test.mjs --soak cm|gcm    долгая проверка: двое говорят через узел, пока
//                                             номера пакетов звука и видео не пройдут полный
//                                             круг (минут двадцать пять)
//
// Узел должен быть собран: cd node && zig build. Пути можно задать переменными CHROME и
// ZVONILKA_NODE.

import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NODE_BIN = process.env.ZVONILKA_NODE || fileURLToPath(new URL('../node/zig-out/bin/zvonilka-node', import.meta.url));
const SHOW_LOG = process.argv.includes('--log');
const soakAt = process.argv.indexOf('--soak');
const SOAK = soakAt > 0 ? (process.argv[soakAt + 1] === 'gcm' ? 'gcm' : 'cm') : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function until(fn, ms = 20000, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

// ---------------------------------------------------------------- протокол DevTools

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.waiting = new Map();
    this.handlers = [];
    this.ready = new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = fail; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (w) m.error ? w.fail(new Error(m.error.message)) : w.ok(m.result);
      } else for (const h of this.handlers) h(m);
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((ok, fail) => {
      this.waiting.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

// Показ экрана в безголовом браузере взять неоткуда — подменяем его рисунком.
const FAKE_SCREEN = `navigator.mediaDevices.getDisplayMedia = async () => {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  const x = c.getContext('2d'); let n = 0;
  const draw = () => {
    x.fillStyle = '#10141c'; x.fillRect(0, 0, 1280, 720);
    x.fillStyle = '#e8e8ea'; x.font = '600 44px sans-serif'; x.fillText('Общий экран · кадр ' + (n++), 60, 90);
  };
  draw(); setInterval(draw, 100);
  return c.captureStream(15);
};`;

// Страница, которая не договаривается о PLI: строка «nack pli» вычёркивается из offer здесь,
// перед отправкой. Тогда узлу остаётся просить ключевой кадр через FIR. С задержкой offer
// уходит позже: собеседник к тому времени уже давно шлёт видео.
const noPliScript = (delay) => `(() => {
  const real = RTCPeerConnection.prototype.setLocalDescription;
  RTCPeerConnection.prototype.setLocalDescription = async function (d) {
    if (d || this.signalingState === 'have-remote-offer') return real.apply(this, arguments);
    if (${delay}) await new Promise((r) => setTimeout(r, ${delay}));
    if (this.signalingState === 'closed') return; // пока ждали, страница построила соединение заново
    const offer = await this.createOffer();
    return real.call(this, { type: 'offer', sdp: offer.sdp.replace(/a=rtcp-fb:\\d+ nack pli\\r\\n/g, '') });
  };
})();`;

class Page {
  constructor(cdp, name) {
    this.cdp = cdp;
    this.name = name;
    this.errors = [];
  }

  cmd(method, params) { return this.cdp.send(method, params, this.session); }

  async open({ noPli = false, offerDelay = 0, deny = false } = {}) {
    const { browserContextId } = await this.cdp.send('Target.createBrowserContext');
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    this.targetId = targetId;
    this.session = (await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    this.cdp.handlers.push((m) => {
      if (m.sessionId !== this.session) return;
      if (m.method === 'Runtime.exceptionThrown') this.errors.push('исключение: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) this.errors.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') this.errors.push('журнал: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    });
    await this.cmd('Page.enable');
    await this.cmd('Runtime.enable');
    await this.cmd('Log.enable');
    await this.cmd('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
    await this.cmd('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_SCREEN });
    if (noPli) await this.cmd('Page.addScriptToEvaluateOnNewDocument', { source: noPliScript(offerDelay) });
    // Человек не дал доступа к камере и микрофону: остаётся слушателем.
    if (deny) await this.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('нет доступа', 'NotAllowedError'); };` });
  }

  click(selector) { return this.eval(`document.querySelector(${JSON.stringify(selector)}).click()`); }

  go(url) { return this.cmd('Page.navigate', { url }); }
  close() { return this.cdp.send('Target.closeTarget', { targetId: this.targetId }); }

  async eval(expression) {
    const r = await this.cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${this.name}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }

  stats() { return this.eval('zvonilka.call.stats()'); }
  id() { return this.eval('zvonilka.call.me.id'); }
  async peer(id) { return (await this.stats()).find((p) => p.id === id); }

  // Что браузер знает о соединении с участником: куда на самом деле идут пакеты, сколько
  // запросов ключевого кадра получил отправитель и сколько ключевых кадров закодировал.
  wire(id) {
    return this.eval(`(async () => {
      const p = zvonilka.call.peers.get(${JSON.stringify(id)});
      if (!p || !p.pc) return null;
      const out = { port: 0, address: '', state: p.pc.iceConnectionState, pli: 0, fir: 0, nack: 0, resent: 0, keysOut: 0, keysIn: 0, pliSent: 0, firSent: 0, nackSent: 0, regot: 0, lost: 0, packets: 0, codec: '', srtp: '' };
      const mids = p.tx.map((t) => t.mid);
      const report = await p.pc.getStats();
      report.forEach((r) => {
        if (r.type === 'transport') {
          // Выбранная пара кандидатов: куда соединение шлёт пакеты на самом деле.
          out.srtp = r.srtpCipher || '';
          const pair = report.get(r.selectedCandidatePairId), b = pair && report.get(pair.remoteCandidateId);
          if (b) { out.port = b.port; out.address = b.address || b.ip || ''; }
        } else if (r.type === 'outbound-rtp' && r.mid === mids[1]) {
          out.pli = r.pliCount || 0; out.fir = r.firCount || 0; out.nack = r.nackCount || 0; out.keysOut = r.keyFramesEncoded || 0;
          out.resent = r.retransmittedPacketsSent || 0;
          const c = report.get(r.codecId); if (c) out.codec = c.mimeType;
        } else if (r.type === 'inbound-rtp' && r.mid === mids[1]) {
          out.keysIn = r.keyFramesDecoded || 0; out.pliSent = r.pliCount || 0; out.firSent = r.firCount || 0;
          out.packets = r.packetsReceived || 0;
          out.nackSent = r.nackCount || 0; out.regot = r.retransmittedPacketsReceived || 0; out.lost = r.packetsLost || 0;
        }
      });
      return out;
    })()`);
  }
}

// ---------------------------------------------------------------- узел

class NodeProc {
  constructor(room, args = []) {
    this.lines = [];
    this.proc = spawn(NODE_BIN, [room, '--verbose', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.exited = new Promise((ok) => this.proc.on('exit', ok));
    let tail = '';
    this.proc.stderr.on('data', (d) => {
      const parts = (tail + d.toString('utf8')).split('\n');
      tail = parts.pop();
      for (const line of parts) {
        this.lines.push(line);
        if (SHOW_LOG) console.log('    узел │ ' + line);
      }
    });
  }

  find(re) { for (const l of this.lines) { const m = re.exec(l); if (m) return m; } return null; }
  last(re) { for (let i = this.lines.length - 1; i >= 0; i--) { const m = re.exec(this.lines[i]); if (m) return m; } return null; }
  count(re) { return this.lines.filter((l) => re.test(l)).length; }

  // Идентификатор, порт и адреса узла — из первых строк его журнала.
  async ready() {
    const m = await until(async () => this.find(/узел ([0-9a-f]{16}): порт UDP (\d+)/), 15000, 100);
    if (!m) throw new Error('узел не запустился: ' + NODE_BIN);
    this.id = m[1];
    this.port = Number(m[2]);
    const up = await until(async () => this.find(/сигналинг: слушаю/), 20000, 100);
    this.addresses = new Set(this.lines.map((l) => /(?:свой|внешний) (\S+):(\d+)$/.exec(l)).filter(Boolean).map((a) => `${a[1]}:${a[2]}`));
    return up;
  }

  // Пакеты браузера идут на один из адресов узла — свой или внешний.
  owns(w) { return !!w && this.addresses.has(`${w.address}:${w.port}`); }

  // Счётчики из строки «переслано: …».
  totals() {
    const m = this.last(/переслано: RTP (\d+), RTCP (\d+), сообщений (\d+); запросов кадра: PLI (\d+), FIR (\d+); NACK (\d+)/);
    return m ? { rtp: +m[1], rtcp: +m[2], messages: +m[3], pli: +m[4], fir: +m[5], nack: +m[6] } : null;
  }

  async stop() {
    this.proc.kill('SIGINT');
    await Promise.race([this.exited, sleep(3000)]);
    this.proc.kill('SIGKILL');
  }
}

// ---------------------------------------------------------------- запуск

try { await access(NODE_BIN); } catch (_) {
  console.error(`Узел не собран: ${NODE_BIN}\nСоберите его: cd node && zig build`);
  process.exit(2);
}

const profile = await mkdtemp(join(tmpdir(), 'zvonilka-node-test-'));
const { server, port } = await serve(fileURLToPath(new URL('../web/', import.meta.url)));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });

const nodes = [];
let failed = false;
try {
  const active = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n'), 15000, 100);
  if (!active) throw new Error('Chrome не запустился: ' + CHROME);
  const cdp = new Cdp(`ws://127.0.0.1:${active[0]}${active[1]}`);
  await cdp.ready;
  const base = `http://127.0.0.1:${port}/`;

  // Соединение с участником id есть, идёт через узел via («» — напрямую), звук и видео приходят.
  const linked = (page, n, via) => until(async () => {
    const s = await page.stats();
    return s.length === n && s.every((p) => p.status === 'connected' && p.dc === 'open' && p.via === via && p.audio > 5 && p.video > 3) && s;
  }, 45000);

  // Счётчики растут: звук — пакеты, видео — раскодированные кадры.
  const flows = async (page, id) => {
    const a = await page.peer(id);
    await sleep(1500);
    const b = await page.peer(id);
    return a && b && b.audio > a.audio + 20 && b.video > a.video + 5 ? `за 1,5 с: звук +${b.audio - a.audio} пакетов, видео +${b.video - a.video} кадров` : '';
  };

  // ------------------------------------------------------------ долгая проверка
  // Номер пакета RTP — 16 бит: через 65 536 пакетов он идёт на новый круг, и счётчик кругов
  // (ROC) входит в шифрование SRTP. Ошибка в нём видна только после первого круга: медиа
  // замирает. Видео проходит круг минут за пять, звук — за двадцать с лишним.
  if (SOAK) {
    const room = 'soak-' + Math.random().toString(36).slice(2, 12);
    const link = (name) => `${base}?name=${encodeURIComponent(name)}#${room}`;
    const node = new NodeProc(room, ['--srtp', SOAK]);
    nodes.push(node);
    await node.ready();
    const A = new Page(cdp, 'Аня'), B = new Page(cdp, 'Борис');
    for (const p of [A, B]) await p.open();
    await A.go(link('Аня'));
    await B.go(link('Борис'));
    const ok = await linked(A, 1, node.id) && await linked(B, 1, node.id);
    check('двое соединились через узел', ok);
    if (!ok) throw new Error('дальше проверять нечего');
    const idA = await A.id(), idB = await B.id();
    const started = Date.now();
    const CIRCLE = 66000; // с запасом больше 65 536: круг точно пройден
    let stalls = 0, last = null, done = false;
    while (!done && Date.now() - started < 30 * 60000) {
      await sleep(10000);
      const a = await A.peer(idB), b = await B.peer(idA), wa = await A.wire(idB), wb = await B.wire(idA);
      const now = { aAudio: a.audio, bAudio: b.audio, aVideo: a.video, bVideo: b.video, aPackets: wa.packets, bPackets: wb.packets };
      if (last) {
        // За десять секунд должно прийти около 500 пакетов звука и 300 кадров в каждую сторону.
        const moved = now.aAudio - last.aAudio > 300 && now.bAudio - last.bAudio > 300 && now.aVideo - last.aVideo > 100 && now.bVideo - last.bVideo > 100;
        if (!moved) { stalls++; console.log(`  замирание на ${Math.round((Date.now() - started) / 1000)}-й секунде: ${JSON.stringify(now)}`); }
      }
      last = now;
      const minutes = (Date.now() - started) / 60000;
      if (Math.round(minutes * 6) % 12 === 0) console.log(`  ${minutes.toFixed(0)} мин: видео ${now.aPackets} и ${now.bPackets} пакетов, звук ${now.aAudio} и ${now.bAudio}`);
      done = Math.min(now.aPackets, now.bPackets, now.aAudio, now.bAudio) > CIRCLE;
    }
    check('номера пакетов видео и звука прошли полный круг в обе стороны', done, last ? `видео ${last.aPackets} и ${last.bPackets} пакетов, звук ${last.aAudio} и ${last.bAudio}` : '');
    check('медиа ни разу не замерло', stalls === 0, `замираний: ${stalls}, минут: ${((Date.now() - started) / 60000).toFixed(1)}`);
    const fA = await flows(A, idB), fB = await flows(B, idA);
    check('после круга звук и видео идут как раньше', fA && fB, fA);
    await sleep(5200);
    const rejected = node.last(/пакетов без пары \d+, отброшено (\d+)/);
    const t = node.totals();
    check('узел не отбросил ни одного пакета', rejected && +rejected[1] === 0, t ? `переслано RTP ${t.rtp}, RTCP ${t.rtcp}; отброшено ${rejected ? rejected[1] : '?'}` : '');
    const wA = await A.wire(idB);
    check(`профиль SRTP — ${SOAK === 'gcm' ? 'AES-GCM' : 'AES-CM'}`, wA.srtp === (SOAK === 'gcm' ? 'SRTP_AEAD_AES_128_GCM' : 'SRTP_AES128_CM_HMAC_SHA1_80'), wA.srtp);
    for (const p of [A, B]) {
      const errors = p.errors.filter((e) => !/icon\.png|favicon/.test(e));
      check(`${p.name}: в консоли чисто`, !errors.length, errors.slice(0, 5).join(' | '));
    }
  }

  // ------------------------------------------------------------ главный сценарий: AES-CM
  if (!SOAK) {
    const room = 'node-' + Math.random().toString(36).slice(2, 12);
    const link = (name) => `${base}?name=${encodeURIComponent(name)}#${room}`;
    const A = new Page(cdp, 'Аня'), B = new Page(cdp, 'Борис'), C = new Page(cdp, 'Вера');
    for (const p of [A, B, C]) await p.open();

    // Сначала двое соединяются как обычно — напрямую.
    await A.go(link('Аня'));
    await B.go(link('Борис'));
    const direct = await linked(A, 1, '') && await linked(B, 1, '');
    check('без узла двое соединяются напрямую', direct);
    if (!direct) throw new Error('дальше проверять нечего');
    const idA = await A.id(), idB = await B.id();

    // В комнату входит узел: оба перестраивают соединение через него.
    const node = new NodeProc(room, ['--srtp', 'cm']);
    nodes.push(node);
    await node.ready();
    const viaA = await linked(A, 1, node.id), viaB = await linked(B, 1, node.id);
    check('узел вошёл в комнату — сетка стала звездой', viaA && viaB, viaA && viaB ? `узел ${node.id.slice(0, 6)}, порт ${node.port}` : 'соединения через узел нет');
    if (!viaA || !viaB) throw new Error('дальше проверять нечего');

    const wA = await A.wire(idB), wB = await B.wire(idA);
    check('пакеты обоих идут на адрес узла, а не друг другу', node.owns(wA) && node.owns(wB), `${wA.address}:${wA.port}, ${wB.address}:${wB.port}`);
    check('SRTP: AES-CM-128 с HMAC-SHA1-80', wA.srtp === 'SRTP_AES128_CM_HMAC_SHA1_80' && wB.srtp === wA.srtp && node.count(/соединение есть.*SRTP_AES128_CM_HMAC_SHA1_80/) >= 2, `${wA.srtp}, ${wB.srtp}`);
    check('кодек видео — VP8', wA.codec === 'video/VP8' && wB.codec === 'video/VP8', `${wA.codec}, ${wB.codec}`);

    const fA = await flows(A, idB), fB = await flows(B, idA);
    check('Аня получает звук и видео Бориса через узел', fA, fA);
    check('Борис получает звук и видео Ани через узел', fB, fB);
    check('имена и состояние дошли по каналу данных через узел', viaA[0].name === 'Борис' && viaB[0].name === 'Аня' && viaA[0].state.mic && viaA[0].state.cam && viaB[0].state.mic && viaB[0].state.cam, `${viaA[0].name}, ${viaB[0].name}`);

    // Запрос ключевого кадра: у Бориса появляется новый зритель дорожки Ани (запись) — его
    // браузер просит у отправителя ключевой кадр (PLI), и просьба должна дойти до Ани.
    {
      const before = await A.wire(idB), beforeB = await B.wire(idA);
      await B.eval(`(() => {
        const p = zvonilka.call.peers.get(${JSON.stringify(idA)});
        const rec = new MediaRecorder(new MediaStream([p.tx[1].receiver.track]));
        rec.start(200);
        window.__rec = rec;
      })()`);
      const got = await until(async () => {
        const now = await A.wire(idB), nowB = await B.wire(idA);
        return now.pli > before.pli && now.keysOut > before.keysOut && nowB.keysIn > beforeB.keysIn && nowB.pliSent > beforeB.pliSent && { now, nowB };
      }, 8000, 200);
      await B.eval('window.__rec && window.__rec.stop()');
      check('запрос ключевого кадра (PLI) доходит через узел, и кадр приходит', got,
        got ? `Борис послал PLI ${got.nowB.pliSent - beforeB.pliSent}, Аня получила ${got.now.pli - before.pli} и закодировала ключевых кадров ${got.now.keysOut - before.keysOut}` : `PLI у Ани ${before.pli}, у Бориса послано ${beforeB.pliSent}`);
    }

    // Сообщение.
    await A.eval(`zvonilka.call.sendChat('привет через узел')`);
    check('сообщение доходит через узел', await until(() => B.eval('[...document.querySelectorAll("#chat-log .msg")].some((m) => m.textContent.includes("привет через узел") && m.textContent.includes("Аня"))'), 6000));

    // Перезапуск ICE (так страница поступает, когда сменилась сеть): узел отвечает новыми
    // логином и паролем, соединение остаётся, медиа идёт дальше.
    {
      const before = await B.peer(idA);
      await A.eval(`zvonilka.call.peers.get(${JSON.stringify(idB)}).pc.restartIce()`);
      const restarted = await until(async () => node.find(/перезапуск ICE/), 8000, 100);
      await sleep(1500);
      const after = await B.peer(idA), wire = await A.wire(idB);
      check('перезапуск ICE: соединение через узел живёт дальше', restarted && wire.state === 'connected' && node.owns(wire) && after.status === 'connected' && after.video > before.video + 20,
        restarted ? `видео у Бориса +${after.video - before.video} кадров, ICE ${wire.state}` : 'узел не увидел перезапуска');
    }

    // Выключенный микрофон не передаётся и через узел.
    await A.eval('zvonilka.call.toggleMic()');
    const sawMute = await until(async () => (await B.peer(idA)).state.mic === false, 5000);
    await sleep(700);
    const a1 = (await B.peer(idA)).audio;
    await sleep(1200);
    const a2 = (await B.peer(idA)).audio;
    check('выключенный микрофон не передаётся', sawMute && a2 - a1 < 3, `за секунду пришло пакетов: ${a2 - a1}`);
    await A.eval('zvonilka.call.toggleMic()');
    check('включённый — снова слышен', await until(async () => { const p = await B.peer(idA); return p.state.mic && p.audio > a2 + 20; }, 6000));

    // Показ экрана идёт по третьему каналу.
    await A.eval('zvonilka.call.toggleScreen()');
    const screen = await until(async () => { const p = await B.peer(idA); return p.state.screen && p.screen > 3; }, 12000);
    check('показ экрана доходит через узел', screen);
    await A.eval('zvonilka.call.toggleScreen()');

    // Третий участник: каждая пара — через узел.
    await C.go(link('Вера'));
    const three = await linked(A, 2, node.id) && await linked(B, 2, node.id) && await linked(C, 2, node.id);
    check('трое: каждая пара соединена через узел', three);
    if (three) {
      const idC = await C.id();
      const fC = await flows(C, idA), fAC = await flows(A, idC);
      check('третий получает и отдаёт звук и видео', fC && fAC, fC);
      const wC = await C.wire(idB);
      check('пакеты третьего тоже идут на адрес узла', node.owns(wC), `${wC.address}:${wC.port}`);
    }

    // Участник закрыл вкладку — остальные это видят.
    await C.close();
    check('закрыл вкладку — остальные это видят', await until(async () => (await A.stats()).length === 1 && (await B.stats()).length === 1, 20000));

    // Слушатель: без доступа к камере и микрофону браузер прячет свои адреса за именами mDNS,
    // и узел узнаёт путь к нему только по его же проверкам связи.
    {
      const L = new Page(cdp, 'Лев');
      await L.open({ deny: true });
      await L.go(link('Лев'));
      const hears = await until(async () => {
        const st = await L.stats();
        return st.length === 2 && st.every((x) => x.status === 'connected' && x.via === node.id && x.audio > 5 && x.video > 3);
      }, 40000);
      check('слушатель без камеры и микрофона видит и слышит всех через узел', hears);
      // Вкладку без камеры и микрофона браузер закрывает мгновенно, не дав странице попрощаться,
      // поэтому слушатель выходит кнопкой.
      await L.click('#bar [data-act=leave]');
      check('слушатель вышел — остальные это видят', await until(async () => (await A.stats()).length === 1 && (await B.stats()).length === 1, 10000));
      const errors = L.errors.filter((e) => !/icon\.png|favicon/.test(e));
      check('Лев: в консоли чисто', !errors.length, errors.slice(0, 5).join(' | '));
      await L.close();
    }

    // Вышел и вернулся.
    await B.click('#bar [data-act=leave]');
    check('вышел — собеседник это видит', await until(async () => (await A.stats()).length === 0, 8000) && await until(() => B.eval('!document.getElementById("left").hidden'), 4000));
    await B.click('#rejoin');
    const back = await linked(A, 1, node.id) && await linked(B, 1, node.id);
    check('вернулся — снова через узел', back);

    await sleep(5200); // узел пишет счётчики раз в пять секунд
    const t = node.totals();
    check('узел пересылал RTP и RTCP и передавал запросы ключевого кадра', t && t.rtp > 500 && t.rtcp > 20 && t.pli >= 1 && t.messages >= 3, t ? `RTP ${t.rtp}, RTCP ${t.rtcp}, PLI ${t.pli}, FIR ${t.fir}, NACK ${t.nack}, сообщений ${t.messages}` : 'счётчиков нет');

    // Узел уходит: звезда снова становится сеткой.
    await node.stop();
    const again = await linked(A, 1, '') && await linked(B, 1, '');
    check('узел ушёл — снова напрямую', again);

    for (const p of [A, B, C]) {
      const errors = p.errors.filter((e) => !/icon\.png|favicon/.test(e));
      check(`${p.name}: в консоли чисто`, !errors.length, errors.slice(0, 5).join(' | '));
    }
    await A.close();
    await B.close();
  }

  // ------------------------------------------------------------ AES-GCM, потери и FIR
  if (!SOAK) {
    const room = 'node-' + Math.random().toString(36).slice(2, 12);
    const link = (name) => `${base}?name=${encodeURIComponent(name)}#${room}`;
    // Узел уже в комнате: участники сразу соединяются через него. Каждый 25-й пакет видео узел
    // «теряет» — получатель должен допросить его у отправителя (NACK), и тот пришлёт повтор.
    const node = new NodeProc(room, ['--srtp', 'gcm', '--lose', '25']);
    nodes.push(node);
    await node.ready();
    const A = new Page(cdp, 'Глеб'), B = new Page(cdp, 'Дина');
    // Дина строит своё соединение с узлом на три секунды позже: Глеб к тому времени уже шлёт
    // видео, и первый его ключевой кадр ей не достался.
    await A.open({ noPli: true });
    await B.open({ noPli: true, offerDelay: 3000 });
    await A.go(link('Глеб'));
    await B.go(link('Дина'));
    const ok = await linked(A, 1, node.id) && await linked(B, 1, node.id);
    check('узел уже в комнате — двое сразу соединяются через него', ok);
    if (ok) {
      const idA = await A.id(), idB = await B.id();
      const wA = await A.wire(idB), wB = await B.wire(idA);
      check('SRTP: AES-GCM', wA.srtp === 'SRTP_AEAD_AES_128_GCM' && wB.srtp === wA.srtp && node.count(/соединение есть.*SRTP_AEAD_AES_128_GCM/) >= 2, `${wA.srtp}, ${wB.srtp}`);
      const fA = await flows(A, idB), fB = await flows(B, idA);
      check('звук и видео идут в обе стороны', fA && fB, fA);

      // Потерянное допрашивается и приходит повтором по отдельному потоку (rtx).
      const healed = await until(async () => {
        const tx = await A.wire(idB), rx = await B.wire(idA);
        return tx.nack > 0 && tx.resent > 3 && rx.nackSent > 0 && rx.regot > 3 && { tx, rx };
      }, 15000, 300);
      check('потерянные пакеты допрашиваются через узел (NACK) и приходят повторами', healed,
        healed ? `Дина просила ${healed.rx.nackSent} раз и получила повторов ${healed.rx.regot}; Глеб получил просьб ${healed.tx.nack}, выслал повторов ${healed.tx.resent}` : JSON.stringify(await B.wire(idA)));

      // Ключевой кадр через FIR. Эти страницы о PLI не договаривались, поэтому узел, сведя пару,
      // попросил кадр у Глеба через FIR. (Сам Chrome FIR не шлёт никогда — перевод чужого FIR
      // проверяют юнит-тесты rtcp.zig.)
      const fir = await until(async () => { const x = await A.wire(idB); return x.fir >= 1 && x.keysOut >= 2 && x; }, 8000, 200);
      const seen = await B.wire(idA);
      await sleep(5200); // узел пишет счётчики раз в пять секунд
      const own = node.last(/своих запросов кадра: PLI (\d+), FIR (\d+)/);
      check('запрос ключевого кадра через FIR браузер принимает и отвечает кадром', fir && seen.keysIn >= 1 && own && +own[2] >= 1 && +own[1] === 0,
        fir ? `Глеб получил FIR ${fir.fir} и закодировал ключевых кадров ${fir.keysOut}, Дина раскодировала ${seen.keysIn}; узел послал FIR ${own ? own[2] : '?'}` : JSON.stringify(await A.wire(idB)));
      const t = node.totals();
      check('узел передавал NACK', t && t.nack >= 1 && t.rtp > 500, t ? `RTP ${t.rtp}, RTCP ${t.rtcp}, PLI ${t.pli}, FIR ${t.fir}, NACK ${t.nack}` : 'счётчиков нет');
    }
    // Узел пропал без прощания (его убили): страницы замечают обрыв, спрашивают узел и, не
    // дождавшись ответа, соединяются напрямую.
    if (ok) {
      const at = Date.now();
      node.proc.kill('SIGKILL');
      const direct = await linked(A, 1, '') && await linked(B, 1, '');
      const took = (Date.now() - at) / 1000;
      check('узел пропал без прощания — участники сами соединяются напрямую', direct && took < 30, `за ${took.toFixed(1)} с`);
    }
    for (const p of [A, B]) {
      const errors = p.errors.filter((e) => !/icon\.png|favicon/.test(e));
      check(`${p.name}: в консоли чисто`, !errors.length, errors.slice(0, 5).join(' | '));
    }
  }
} catch (e) {
  failed = true;
  console.error('Проверка прервана:', e.message);
} finally {
  for (const n of nodes) await n.stop();
  chrome.kill();
  server.close();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

const bad = results.filter((r) => !r.pass);
if ((bad.length || failed) && !SHOW_LOG) {
  console.log('\nЖурнал узла (конец):');
  for (const n of nodes) for (const l of n.lines.slice(-40)) console.log('    узел │ ' + l);
}
console.log(`\n${results.length - bad.length} из ${results.length} проверок прошли`);
process.exit(failed || bad.length ? 1 : 0);
