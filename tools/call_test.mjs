#!/usr/bin/env node
// Живая проверка звонка: три участника в безголовом Chrome — компьютер, телефон и ещё один
// компьютер. Брокеры и WebRTC настоящие, камера и микрофон — тестовые, жесты — как от пальцев
// и мыши.
//
//   node tools/call_test.mjs                 проверка
//   node tools/call_test.mjs --shots <папка>  ещё и снимки экранов
//   node tools/call_test.mjs --base <адрес>   проверить опубликованную страницу, а не файлы из web/
//
// Путь к Chrome можно задать переменной CHROME.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? resolve(process.argv[shotsAt + 1] || 'shots') : '';
const baseAt = process.argv.indexOf('--base');
const BASE = baseAt > 0 ? String(process.argv[baseAt + 1] || '').replace(/\/?$/, '/') : '';
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

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

// Показ экрана в безголовом браузере взять неоткуда — подменяем его рисунком с текстом.
const FAKE_SCREEN = `navigator.mediaDevices.getDisplayMedia = async () => {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  const x = c.getContext('2d'); let n = 0;
  const draw = () => {
    x.fillStyle = '#10141c'; x.fillRect(0, 0, 1280, 720);
    x.fillStyle = '#e8e8ea'; x.font = '600 44px sans-serif'; x.fillText('Общий экран · кадр ' + (n++), 60, 90);
    x.font = '22px monospace'; x.fillStyle = '#8fb4ff';
    for (let i = 0; i < 18; i++) x.fillText('строка ' + (i + 1) + ': мелкий текст, который хочется приблизить', 60, 150 + i * 30);
  };
  draw(); setInterval(draw, 100);
  return c.captureStream(15);
};`;

// Для снимков тестовая зелёная заставка Chrome не годится: по ней не понять, как выглядит звонок.
// Вместо камеры рисуем силуэт человека на фоне его цвета, вместо микрофона — тон, которым
// проверка «говорит» по команде (window.__speak). Обычная проверка идёт с устройствами Chrome.
const prettyMedia = (hue, portrait) => `(() => {
  if (!localStorage.getItem('zvonilka.v1')) localStorage.setItem('zvonilka.v1', JSON.stringify({ hue: ${hue}, hints: { talk: 1, zoom: 1, swipe: 1, volume: 1, type: 1, fit: 1 } }));
  const W = ${portrait ? 720 : 1280}, H = ${portrait ? 1280 : 720};
  let voice = null;
  window.__speak = (on) => { if (voice) { voice.gain.gain.value = on ? 0.22 : 0; voice.depth.gain.value = on ? 0.16 : 0; } };
  navigator.mediaDevices.getUserMedia = async (wish) => {
    const tracks = [];
    if (wish && wish.video) {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d'); let t = 0;
      const draw = () => {
        t += 0.04;
        const bg = x.createLinearGradient(0, 0, W, H);
        bg.addColorStop(0, 'hsl(${hue} 42% 30%)'); bg.addColorStop(1, 'hsl(${(hue + 40) % 360} 50% 11%)');
        x.fillStyle = bg; x.fillRect(0, 0, W, H);
        const lamp = x.createRadialGradient(W * 0.8, H * 0.18, 0, W * 0.8, H * 0.18, Math.max(W, H) * 0.5);
        lamp.addColorStop(0, 'hsla(${(hue + 20) % 360}, 80%, 78%, .5)'); lamp.addColorStop(1, 'hsla(${hue}, 80%, 60%, 0)');
        x.fillStyle = lamp; x.fillRect(0, 0, W, H);
        const r = Math.min(W, H) * 0.19, cx = W / 2 + Math.sin(t) * r * 0.06, cy = H * 0.43 + Math.cos(t * 0.7) * r * 0.04;
        const skin = x.createLinearGradient(0, cy - r, 0, cy + r * 4);
        skin.addColorStop(0, 'hsl(${hue} 34% 80%)'); skin.addColorStop(1, 'hsl(${hue} 30% 52%)');
        x.fillStyle = skin;
        x.beginPath(); x.ellipse(cx, cy + r * 3.1, r * 2.2, r * 2, 0, 0, 7); x.fill();
        x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fill();
      };
      draw(); setInterval(draw, 66);
      tracks.push(c.captureStream(15).getVideoTracks()[0]);
    }
    if (wish && wish.audio) {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator(), gain = ctx.createGain(), lfo = ctx.createOscillator(), depth = ctx.createGain(), out = ctx.createMediaStreamDestination();
      osc.type = 'triangle'; osc.frequency.value = 170; lfo.frequency.value = 4; gain.gain.value = 0; depth.gain.value = 0;
      lfo.connect(depth).connect(gain.gain); osc.connect(gain).connect(out); osc.start(); lfo.start();
      voice = { gain, depth };
      tracks.push(out.stream.getAudioTracks()[0]);
    }
    return new MediaStream(tracks);
  };
})();`;

class Page {
  constructor(cdp, name) {
    this.cdp = cdp;
    this.name = name;
    this.errors = [];
  }

  cmd(method, params) { return this.cdp.send(method, params, this.session); }

  async open({ width, height, phone, hue = 220, deny = false }) {
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
    await this.cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: !!phone });
    if (phone) {
      await this.cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await this.cmd('Emulation.setUserAgentOverride', { userAgent: PHONE_UA });
    }
    await this.cmd('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_SCREEN });
    if (SHOTS) await this.cmd('Page.addScriptToEvaluateOnNewDocument', { source: prettyMedia(hue, !!phone) });
    // Человек не дал доступа к камере и микрофону: должен остаться в звонке слушателем.
    if (deny) await this.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('нет доступа', 'NotAllowedError'); };` });
  }

  speak(on) { return SHOTS ? this.eval(`window.__speak(${!!on})`) : null; }

  go(url) { return this.cmd('Page.navigate', { url }); }

  async eval(expression) {
    const r = await this.cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${this.name}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }

  snap() { return this.eval('zvonilka.snapshot()'); }
  stats() { return this.eval('zvonilka.call.stats()'); }
  id() { return this.eval('zvonilka.call.me.id'); }
  async tile(key) { return (await this.snap()).tiles.find((t) => t.key === key); }
  async center(key, fx = 0.5, fy = 0.5) { const t = await this.tile(key); return [t.rect.x + t.rect.w * fx, t.rect.y + t.rect.h * fy]; }
  at(selector) { return this.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`); }

  async shot(file) {
    if (!SHOTS) return;
    const r = await this.cmd('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(SHOTS, file + '.png'), Buffer.from(r.data, 'base64'));
  }

  // --- пальцы
  touch(type, points) { return this.cmd('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 8, radiusY: 8, force: 1 })) }); }
  async tap(x, y) { await this.touch('touchStart', [[x, y]]); await sleep(40); await this.touch('touchEnd', []); }
  async doubleTap(x, y) { await this.tap(x, y); await sleep(90); await this.tap(x, y); }
  async swipe(x1, y1, x2, y2, ms = 140) {
    const steps = 8;
    await this.touch('touchStart', [[x1, y1]]);
    for (let i = 1; i <= steps; i++) { await sleep(ms / steps); await this.touch('touchMove', [[x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps]]); }
    await this.touch('touchEnd', []);
  }
  async pinch(cx, cy, from, to) {
    const pts = (d) => [[cx - d / 2, cy], [cx + d / 2, cy]];
    await this.touch('touchStart', [pts(from)[0]]);
    await sleep(30);
    await this.touch('touchStart', pts(from));
    for (let i = 1; i <= 10; i++) { await sleep(20); await this.touch('touchMove', pts(from + (to - from) * i / 10)); }
    await sleep(30);
    await this.touch('touchEnd', []);
  }

  // --- мышь и клавиши
  mouse(type, x, y, extra = {}) { return this.cmd('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' || type === 'mouseWheel' ? 'none' : 'left', clickCount: 1, ...extra }); }
  async click(x, y, count = 1) {
    await this.mouse('mouseMoved', x, y);
    for (let i = 1; i <= count; i++) {
      await this.mouse('mousePressed', x, y, { clickCount: i });
      await this.mouse('mouseReleased', x, y, { clickCount: i });
      if (i < count) await sleep(80);
    }
  }
  wheel(x, y, deltaY, modifiers = 0) { return this.mouse('mouseWheel', x, y, { deltaX: 0, deltaY, modifiers }); }
  key(type, key, code, extra = {}) { return this.cmd('Input.dispatchKeyEvent', { type, key, code, ...extra }); }
}

// ---------------------------------------------------------------- запуск

const profile = await mkdtemp(join(tmpdir(), 'zvonilka-test-'));
const { server, port } = BASE ? { server: null, port: 0 } : await serve(fileURLToPath(new URL('../web/', import.meta.url)));
if (SHOTS) await mkdir(SHOTS, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });

let failed = false;
try {
  const active = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n'), 15000, 100);
  if (!active) throw new Error('Chrome не запустился: ' + CHROME);
  const cdp = new Cdp(`ws://127.0.0.1:${active[0]}${active[1]}`);
  await cdp.ready;

  const base = BASE || `http://127.0.0.1:${port}/`;
  const room = 'test-' + Math.random().toString(36).slice(2, 12);
  const link = (name) => `${base}?name=${encodeURIComponent(name)}#${room}`;
  const A = new Page(cdp, 'Аня'), B = new Page(cdp, 'Борис'), C = new Page(cdp, 'Вера');
  await A.open({ width: 1280, height: 800, hue: 262 });
  await B.open({ width: 390, height: 844, phone: true, hue: 188 });
  await C.open({ width: 1100, height: 700, hue: 18 });

  const connected = (page, n) => until(async () => {
    const s = await page.stats();
    return s.length === n && s.every((p) => p.status === 'connected' && p.dc === 'open' && p.audio > 5 && p.video > 3) && s;
  }, 40000);

  // --- главная: новый звонок, вход по коду, выход и ещё один звонок
  {
    const H = new Page(cdp, 'Главная'), P = new Page(cdp, 'Главная на телефоне');
    await H.open({ width: 1280, height: 800 });
    await P.open({ width: 390, height: 844, phone: true });
    await H.go(base);
    await P.go(base);
    const home = await until(() => H.eval('!document.getElementById("home").hidden')) && await until(() => P.eval('!document.getElementById("home").hidden'));
    await sleep(400);
    await H.shot('01-home-desktop');
    await P.shot('01-home-phone');
    let [x, y] = await H.at('#new-call');
    await H.click(x, y);
    const made = await until(async () => (await H.snap()).joined && H.eval('zvonilka.call.me.room'), 8000);
    check('«Новый звонок» — одна кнопка, и ты в звонке', home && /^[a-z0-9]{16}$/.test(made || '') && await H.eval('location.hash') === '#' + made, `комната ${made}`);
    [x, y] = await P.at('#home-code');
    await P.tap(x, y);
    await P.cmd('Input.insertText', { text: 'Планёрка 12' });
    [x, y] = await P.at('#home-go');
    await P.tap(x, y);
    const byCode = await until(async () => (await P.snap()).joined && P.eval('zvonilka.call.me.room'), 8000);
    check('вход по коду: «Планёрка 12» — комната «планёрка-12»', byCode === 'планёрка-12', `комната «${byCode}»`);
    [x, y] = await H.at('#bar [data-act=leave]');
    await H.click(x, y);
    await until(() => H.eval('!document.getElementById("left").hidden'), 4000);
    [x, y] = await H.at('#left-new');
    await H.click(x, y);
    const again = await until(async () => (await H.snap()).joined && H.eval('zvonilka.call.me.room'), 8000);
    check('вышел и начал новый звонок — комната другая', again && again !== made);
    await cdp.send('Target.closeTarget', { targetId: H.targetId });
    await cdp.send('Target.closeTarget', { targetId: P.targetId });
  }

  // --- один в звонке
  await A.go(link('Аня'));
  const solo = await until(async () => { const s = await A.snap(); return s.joined && s.tiles.length === 1 && s.tiles[0].video !== '0x0' && s; });
  check('вход по ссылке сразу в звонок', solo && solo.mode === 'solo', solo ? `вид «${solo.mode}», камера ${solo.tiles[0].video}` : 'не вошёл');
  check('одному предлагают позвать', await A.eval('!document.getElementById("invite").hidden && document.getElementById("invite-link").textContent.includes(' + JSON.stringify(room) + ')'));
  await sleep(600);
  await A.shot('02-solo-desktop');

  // --- двое
  await B.go(link('Борис'));
  const duoA = await connected(A, 1), duoB = await connected(B, 1);
  check('двое соединились напрямую', duoA && duoB, duoA ? `путь ${duoA[0].path}, задержка ${Math.round(duoA[0].rtt * 1000)} мс` : 'нет соединения');
  if (!duoA || !duoB) throw new Error('дальше проверять нечего');
  const idA = await A.id(), idB = await B.id();
  let sA = await A.snap(), sB = await B.snap();
  check('двое: собеседник во весь экран, вы в углу', sA.mode === 'duo' && sB.mode === 'duo' && sB.tiles.find((t) => t.key === idA).role === 'full' && sB.tiles.find((t) => t.key === 'me').role === 'pip');
  check('имена дошли', duoA[0].name === 'Борис' && duoB[0].name === 'Аня', `${duoA[0].name}, ${duoB[0].name}`);
  await B.speak(true);
  await sleep(900);
  await A.shot('03-duo-desktop');
  await B.speak(false);
  await A.speak(true);
  await sleep(700);
  await B.shot('03-duo-phone');
  await A.speak(false);

  // Кнопки на телефоне гаснут сами и возвращаются касанием.
  const idle = await until(async () => (await B.snap()).idle, 8000);
  check('кнопки сами гаснут', idle);
  await B.shot('04-duo-phone-clean');
  await B.tap(195, 300);
  await sleep(150);
  check('касание возвращает кнопки', !(await B.snap()).idle);

  // Двойное касание: «заполнить» ↔ «вписать».
  await B.doubleTap(195, 300);
  await sleep(450);
  check('двойное касание показывает кадр целиком', (await B.tile(idA)).fit === 'contain');
  await B.shot('05-duo-phone-fit');
  await B.doubleTap(195, 300);
  await sleep(450);
  check('второе двойное касание возвращает', (await B.tile(idA)).fit === 'cover');

  // Зажать человека и вести вниз — его громкость.
  await B.touch('touchStart', [[195, 380]]);
  await sleep(480);
  for (let i = 1; i <= 6; i++) { await B.touch('touchMove', [[195, 380 + i * 14]]); await sleep(25); }
  await sleep(120);
  await B.shot('06-volume-phone');
  await B.touch('touchEnd', []);
  const vol = (await B.tile(idA)).vol;
  check('зажал и повёл — громкость человека', vol > 0.3 && vol < 0.7, `стало ${Math.round(vol * 100)}%`);
  check('громкость дошла до звука', await B.eval(`Math.abs(zvonilka.tiles.get(${JSON.stringify(idA)}).video.volume - ${vol}) < 0.02`));

  // Свою плитку можно утащить в другой угол.
  const [px, py] = await B.center('me');
  await B.swipe(px, py, 70, 150, 220);
  await sleep(700);
  const pip = (await B.tile('me')).rect;
  check('свою плитку можно перетащить в угол', pip.x < 60 && pip.y < 200, `теперь в ${pip.x},${pip.y}`);

  // Двойное касание по себе — другая камера; плитка при этом остаётся в углу.
  const framesBefore = (await A.stats())[0].video;
  const [fx, fy] = await B.center('me');
  await B.doubleTap(fx, fy);
  const flipped = await until(() => B.eval('zvonilka.call.me.facing === "environment" && !!zvonilka.call.me.video && zvonilka.call.me.video.readyState === "live"'), 5000, 100);
  const stillFlows = await until(async () => (await A.stats())[0].video > framesBefore + 5, 6000);
  check('двойное касание по себе меняет камеру', flipped && stillFlows && (await B.tile('me')).role === 'pip');

  // --- трое
  await C.go(link('Вера'));
  const [tA, tB, tC] = [await connected(A, 2), await connected(B, 2), await connected(C, 2)];
  check('трое: каждый соединён с каждым', tA && tB && tC);
  if (!tA || !tB || !tC) throw new Error('дальше проверять нечего');
  const idC = await C.id();
  sA = await A.snap();
  sB = await B.snap();
  check('трое: сетка', sA.mode === 'grid' && sB.mode === 'grid' && (await C.snap()).mode === 'grid');

  // Камера выключена — вместо лица шар цвета человека; кто говорит — светится.
  await C.eval('zvonilka.call.toggleCam()');
  const orb = await until(() => A.eval(`zvonilka.tiles.get(${JSON.stringify(idC)}).el.classList.contains('no-video')`), 5000, 100);
  check('выключенная камера видна остальным', orb && (await A.stats()).find((p) => p.id === idC).state.cam === false);
  await B.speak(true);
  await sleep(900);
  if (SHOTS) check('кто говорит — светится', (await A.tile(idB)).level > 0.2 && (await A.tile(idC)).level === 0, `уровень ${(await A.tile(idB)).level}`);
  await A.shot('07-grid-desktop');
  await B.speak(false);
  await C.speak(true);
  await sleep(700);
  await B.shot('07-grid-phone');
  await C.speak(false);
  await C.eval('zvonilka.call.toggleCam()');
  await until(async () => (await A.stats()).find((p) => p.id === idC).state.cam === true, 5000);

  // Микрофон: выключили — остальным не идёт ничего.
  await A.eval('zvonilka.call.toggleMic()');
  const sawMute = await until(async () => (await B.stats()).find((p) => p.id === idA).state.mic === false, 5000);
  await sleep(700);
  const a1 = (await B.stats()).find((p) => p.id === idA).audio;
  await sleep(1200);
  const a2 = (await B.stats()).find((p) => p.id === idA).audio;
  check('выключенный микрофон не передаётся', sawMute && a2 - a1 < 3, `за секунду пришло пакетов: ${a2 - a1}`);
  if (SHOTS) {
    // Говорит с выключенным микрофоном — мягкое напоминание.
    await A.speak(true);
    const nudge = await until(() => A.eval('document.getElementById("toasts").textContent.includes("Вас не слышно")'), 5000, 150);
    check('говорит в выключенный микрофон — напоминание', nudge);
    await A.shot('08-unheard-desktop');
    await A.speak(false);
  }

  // Удержание пробела — «сказать пару слов».
  await A.eval('window.focus()');
  await A.key('keyDown', ' ', 'Space');
  const talking = await until(async () => (await A.snap()).talking, 3000, 60);
  const heard = await until(async () => (await B.stats()).find((p) => p.id === idA).state.mic === true, 3000, 100);
  await A.shot('08-talk-desktop');
  await A.key('keyUp', ' ', 'Space');
  const quietAgain = await until(async () => !(await A.snap()).mic, 3000, 60);
  check('удержание пробела: слышно, пока держишь', talking && heard && quietAgain);
  await A.key('keyDown', ' ', 'Space');
  await sleep(60);
  await A.key('keyUp', ' ', 'Space');
  check('короткий пробел включает микрофон', await until(async () => (await A.snap()).mic, 3000, 60));

  // Сообщение: просто начать печатать.
  await A.key('keyDown', 'п', 'KeyG', { text: 'п' });
  await A.key('keyUp', 'п', 'KeyG');
  await A.cmd('Input.insertText', { text: 'ривет всем' });
  const typed = await A.eval('document.getElementById("chat-text").value');
  await sleep(200);
  await A.shot('09-typing-desktop');
  await A.key('keyDown', 'Enter', 'Enter', { text: '\r' });
  await A.key('keyUp', 'Enter', 'Enter');
  const got = await until(() => B.eval('[...document.querySelectorAll("#chat-log .msg")].some((m) => m.textContent.includes("привет всем") && m.textContent.includes("Аня"))'), 5000);
  check('начал печатать — написал сообщение', typed === 'привет всем' && got && !(await A.snap()).chatOpen, `в поле было «${typed}»`);
  await sleep(300);
  await B.shot('09-message-phone');

  // Телефон: коснулся — крупно, смахнул — следующий, вниз — все.
  let [x, y] = await B.center(idC);
  await B.tap(x, y);
  await sleep(700);
  sB = await B.snap();
  check('касание выводит человека крупно', sB.mode === 'present' && sB.big === idC);
  await B.shot('10-present-phone');
  [x, y] = await B.center(idC);
  await B.swipe(x + 80, y, x - 120, y, 120);
  await sleep(700);
  const next = (await B.snap()).big;
  check('смахнул в сторону — следующий участник', next && next !== idC, `был ${idC.slice(0, 4)}, стал ${String(next).slice(0, 4)}`);
  [x, y] = await B.center(next);
  await B.tap(x, y);
  await sleep(500);
  check('касание крупной плитки — во весь экран', (await B.snap()).immersive);
  await B.shot('11-immersive-phone');
  await B.swipe(x, y - 100, x, y + 160, 140);
  await sleep(700);
  check('смахнул вниз — снова все', (await B.snap()).mode === 'grid');
  await B.swipe(195, 500, 195, 380, 120);
  await sleep(400);
  check('смахнул вверх — пишу сообщение', (await B.snap()).chatOpen);
  await B.shot('12-chat-phone');
  await B.tap(195, 200);
  await sleep(300);

  // Компьютер: щелчок, весь экран, Esc, колёсико.
  [x, y] = await A.center(idB);
  await A.click(x, y);
  await sleep(700);
  check('щелчок выводит человека крупно', (await A.snap()).big === idB);
  await A.shot('10-present-desktop');
  [x, y] = await A.center(idB);
  await A.click(x, y);
  await sleep(600);
  check('щелчок по крупной плитке — во весь экран', (await A.snap()).immersive);
  await A.key('keyDown', 'Escape', 'Escape');
  await A.key('keyUp', 'Escape', 'Escape');
  await sleep(500);
  await A.key('keyDown', 'Escape', 'Escape');
  await A.key('keyUp', 'Escape', 'Escape');
  await sleep(600);
  check('Esc возвращает сетку', (await A.snap()).mode === 'grid');
  [x, y] = await A.center(idC);
  await A.mouse('mouseMoved', x, y);
  for (let i = 0; i < 3; i++) { await A.wheel(x, y, 100); await sleep(40); }
  await sleep(100);
  await A.shot('13-wheel-volume-desktop');
  const wv = (await A.tile(idC)).vol;
  check('колёсико над человеком — его громкость', wv > 0.5 && wv < 0.9, `стало ${Math.round(wv * 100)}%`);

  // --- показ экрана
  await A.eval('zvonilka.call.toggleScreen()');
  const scr = 's:' + idA;
  const shown = await until(async () => { const s = await B.snap(); return s.mode === 'present' && s.big === scr && s.tiles.find((t) => t.key === scr).video !== '0x0'; }, 10000);
  const frames = await until(async () => (await C.stats()).find((p) => p.id === idA).screen > 3, 8000);
  check('показ экрана сам выходит вперёд', shown && frames);
  await sleep(900);
  await B.shot('14-screen-phone');
  await C.shot('14-screen-desktop');
  await A.shot('14-sharing-desktop');

  [x, y] = await B.center(scr);
  await B.pinch(x, y, 60, 220);
  await sleep(900);
  const z = (await B.tile(scr)).zoom;
  check('щипок приближает экран', z && z.s > 2, z ? `в ${z.s.toFixed(1)} раза` : 'нет');
  check('приближенный маленький экран раскрывается на весь', (await B.snap()).immersive && (await B.tile(scr)).role === 'full');
  await B.shot('15-zoom-phone');
  await B.swipe(x, y, x + 60, y + 30, 120);
  await sleep(200);
  const z2 = (await B.tile(scr)).zoom;
  check('приближенное двигается пальцем', z && z2 && (z2.x !== z.x || z2.y !== z.y));
  await B.doubleTap(x, y);
  await sleep(500);
  check('двойное касание возвращает экран целиком', (await B.tile(scr)).zoom === null);
  await B.pinch(x, y, 220, 60);
  await sleep(800);
  check('свёл пальцы — снова все', (await B.snap()).mode === 'grid');

  [x, y] = await C.center(scr);
  await C.mouse('mouseMoved', x, y);
  for (let i = 0; i < 4; i++) { await C.wheel(x, y, -100, 2); await sleep(40); }
  await sleep(500);
  const zc = (await C.tile(scr)).zoom;
  check('Ctrl + колёсико приближает', zc && zc.s > 1.5, zc ? `в ${zc.s.toFixed(1)} раза` : 'нет');
  await C.shot('15-zoom-desktop');
  await C.click(x, y, 2);
  await sleep(600);
  check('двойной щелчок возвращает', (await C.tile(scr)).zoom === null);

  [x, y] = await A.at('#sharing');
  await A.click(x, y);
  check('показ экрана остановлен', await until(async () => !(await B.snap()).tiles.some((t) => t.key === scr), 6000));

  // --- лист
  await B.eval('zvonilka.openSheet()');
  await sleep(700);
  await B.shot('16-sheet-phone');
  await B.eval('zvonilka.closeSheet()');
  [x, y] = await A.at('#pill');
  await A.click(x, y);
  await sleep(600);
  check('лист открывается с названия звонка', (await A.snap()).sheet && await A.eval('document.getElementById("set-mic").options.length > 0'));
  await A.shot('16-sheet-desktop');
  // Имя меняется на ходу и сразу видно остальным.
  await A.eval('(() => { const i = document.getElementById("set-name"); i.value = "Анна"; i.dispatchEvent(new Event("change")); })()');
  check('новое имя сразу видят остальные', await until(async () => (await B.stats()).find((p) => p.id === idA).name === 'Анна', 4000));
  if (!SHOTS) {
    // Другой микрофон: дорожка меняется, звук продолжает идти. (Для снимков устройства нарисованы.)
    const switched = await A.eval(`(async () => {
      const d = await zvonilka.call.devices();
      const other = d.mic.list.find((x) => x.id !== d.mic.current);
      if (!other) return 'нет второго микрофона';
      const before = zvonilka.call.me.audio;
      await zvonilka.call.chooseDevice('mic', other.id);
      const now = zvonilka.call.me.audio;
      return now && now !== before && now.readyState === 'live' && zvonilka.call.me.mic ? 'ok' : 'дорожка не сменилась';
    })()`);
    const p1 = (await B.stats()).find((p) => p.id === idA).audio;
    await sleep(1200);
    const p2 = (await B.stats()).find((p) => p.id === idA).audio;
    check('смена микрофона на ходу', switched === 'ok' && p2 - p1 > 20, `${switched}, пакетов за секунду: ${p2 - p1}`);
  }
  await A.key('keyDown', 'Escape', 'Escape');
  await A.key('keyUp', 'Escape', 'Escape');

  // --- выход и возвращение
  [x, y] = await C.at('#bar [data-act=leave]');
  await C.click(x, y);
  const gone = await until(async () => (await A.stats()).length === 1 && (await B.stats()).length === 1, 8000);
  check('вышел — остальные это видят', gone && await C.eval('!document.getElementById("left").hidden'));
  await sleep(500);
  await C.shot('17-left-desktop');
  [x, y] = await C.at('#rejoin');
  await C.click(x, y);
  check('«Вернуться» — снова в звонке', await connected(C, 2) && await connected(A, 2));

  await cdp.send('Target.closeTarget', { targetId: C.targetId });
  check('закрыл вкладку — остальные это видят', await until(async () => (await A.stats()).length === 1 && (await B.stats()).length === 1, 15000));

  // --- без камеры и микрофона: слушатель
  const L = new Page(cdp, 'Слушатель');
  await L.open({ width: 1100, height: 700, hue: 120, deny: true });
  await L.go(link('Лев'));
  const hears = await until(async () => { const s = await L.stats(); return s.length === 2 && s.every((p) => p.status === 'connected' && p.audio > 5 && p.video > 3); }, 40000);
  const idL = hears ? await L.id() : '';
  const seen = hears && await until(async () => (await A.snap()).tiles.some((t) => t.key === idL && t.video === '0x0'), 6000);
  check('без доступа к камере и микрофону — слушатель: всех видит и слышит', hears && seen && await L.eval('document.getElementById("toasts").textContent.includes("Нет доступа")'));
  await sleep(600);
  await L.shot('18-listener-desktop');
  await A.shot('18-with-listener-desktop');
  await cdp.send('Target.closeTarget', { targetId: L.targetId });

  // --- Telegram: страница запущена как Mini App (настоящий скрипт Telegram, параметры запуска —
  // как их передаёт приложение), второй участник входит в ту же секунду из обычного браузера
  const tgRoom = 'tg' + Math.random().toString(36).slice(2, 12);
  const initData = new URLSearchParams({ user: JSON.stringify({ id: 1, first_name: 'Тим' }), start_param: tgRoom, auth_date: '1', hash: 'x' }).toString();
  const T = new Page(cdp, 'Telegram'), F = new Page(cdp, 'Гость');
  await T.open({ width: 390, height: 844, phone: true, hue: 300 });
  await F.open({ width: 1100, height: 700, hue: 40 });
  await Promise.all([
    T.go(`${base}?tgWebAppStartParam=${tgRoom}#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=8.0&tgWebAppPlatform=android&tgWebAppThemeParams=${encodeURIComponent('{}')}`),
    F.go(`${base}#${tgRoom}`),
  ]);
  const both = await connected(T, 1) && await connected(F, 1);
  check('одновременный вход двоих — соединились', both);
  const tgState = await T.eval('({ room: zvonilka.call.me.room, name: zvonilka.call.me.name, link: zvonilka.inviteLink(), hash: location.hash.includes("tgWebAppData"), sdk: !!(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.platform === "android") })');
  check('Telegram: комната из параметра запуска, имя из профиля, ссылка-приглашение через бота',
    tgState.sdk && tgState.room === tgRoom && tgState.name === 'Тим' && tgState.link === `https://t.me/StartNewCallBot?startapp=${tgRoom}` && tgState.hash,
    JSON.stringify(tgState));
  check('Telegram: гость видит имя из профиля', both && (await F.stats())[0].name === 'Тим');
  await sleep(600);
  await T.shot('19-telegram-phone');

  for (const p of [A, B, C, L, T, F]) {
    const errors = p.errors.filter((e) => !/icon\.png|favicon/.test(e));
    check(`${p.name}: в консоли чисто`, !errors.length, errors.slice(0, 5).join(' | '));
  }
} catch (e) {
  failed = true;
  console.error('Проверка прервана:', e.message);
} finally {
  chrome.kill();
  if (server) server.close();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

const bad = results.filter((r) => !r.pass);
console.log(`\n${results.length - bad.length} из ${results.length} проверок прошли${SHOTS ? `, снимки — в ${SHOTS}` : ''}`);
process.exit(failed || bad.length ? 1 : 0);
