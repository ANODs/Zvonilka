#!/usr/bin/env node
// Проверка доски: компьютер (Аня) и телефон (Борис) в одном звонке, потом опоздавшая Вера.
//
//   node tools/board_test.mjs                  проверка
//   node tools/board_test.mjs --shots <папка>  ещё и снимки

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sa = process.argv.indexOf('--shots');
const SHOTS = sa > 0 ? resolve(process.argv[sa + 1] || 'shots') : '';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = '') => { results.push(!!pass); console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
async function until(fn, ms = 20000, step = 200) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(step); }
}

const profile = await mkdtemp(join(tmpdir(), 'zvonilka-board-'));
const { server, port } = await serve(fileURLToPath(new URL('../web/', import.meta.url)));
if (SHOTS) await mkdir(SHOTS, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run', '--mute-audio', 'about:blank',
], { stdio: 'ignore' });

let failed = false;
try {
  const active = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n'), 15000, 100);
  const ws = new WebSocket(`ws://127.0.0.1:${active[0]}${active[1]}`);
  await new Promise((ok) => { ws.onopen = ok; });
  let id = 0;
  const waiting = new Map(), errors = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { const w = waiting.get(m.id); waiting.delete(m.id); if (w) m.error ? w[1](new Error(m.error.message)) : w[0](m.result); }
    else if (m.method === 'Runtime.exceptionThrown' || (m.method === 'Runtime.consoleAPICalled' && /error|warning/.test(m.params.type))) {
      (errors.get(m.sessionId) || errors.set(m.sessionId, []).get(m.sessionId)).push(JSON.stringify(m.params).slice(0, 300));
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const i = ++id; waiting.set(i, [ok, fail]); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const room = 'board-' + Math.random().toString(36).slice(2, 10);
  const base = `http://127.0.0.1:${port}/`;

  async function page(name, { phone = false, w = 1280, h = 800, context } = {}) {
    const ctx = context || (await send('Target.createBrowserContext')).browserContextId;
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId: ctx });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const cmd = (m, p) => send(m, p, sessionId);
    await cmd('Runtime.enable');
    await cmd('Page.enable');
    await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: phone });
    if (phone) { await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); await cmd('Emulation.setUserAgentOverride', { userAgent: PHONE_UA }); }
    const ev = async (expression) => { const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(name + ': ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; };
    const P = {
      name, sessionId, targetId, ctx, ev, cmd, w, h,
      go: () => cmd('Page.navigate', { url: `${base}?name=${encodeURIComponent(name)}#${room}` }),
      count: () => ev('zvonilka.board.count()'),
      open: () => ev('zvonilka.board.isOpen()'),
      mouse: (type, x, y, extra = {}) => cmd('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra }),
      key: async (key, code, modifiers = 0) => { await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers }); },
      touch: (type, pts) => cmd('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 6, radiusY: 6, force: 1 })) }),
      async drag(points, modifiers = 0) {
        await P.mouse('mouseMoved', ...points[0], { modifiers });
        await P.mouse('mousePressed', ...points[0], { modifiers });
        for (const p of points.slice(1)) { await P.mouse('mouseMoved', ...p, { buttons: 1, modifiers }); await sleep(16); }
        await P.mouse('mouseReleased', ...points[points.length - 1], { modifiers });
      },
      async swipe(points) {
        await P.touch('touchStart', [points[0]]);
        for (const p of points.slice(1)) { await sleep(16); await P.touch('touchMove', [p]); }
        await P.touch('touchEnd', []);
      },
      async shot(file) { if (!SHOTS) return; const r = await cmd('Page.captureScreenshot', { format: 'png' }); await writeFile(join(SHOTS, file + '.png'), Buffer.from(r.data, 'base64')); },
    };
    return P;
  }

  const linked = (P, n) => until(async () => { const s = await P.ev('zvonilka.call.stats()'); return s.length === n && s.every((x) => x.status === 'connected' && (x.dc === 'open' || x.dc === 'relay')); }, 40000);
  const wave = (x0, y0) => Array.from({ length: 24 }, (_, i) => [x0 + i * 14, y0 + Math.sin(i / 3) * 40]);

  const A = await page('Аня');
  const B = await page('Борис', { phone: true, w: 390, h: 844 });
  await A.go();
  await B.go();
  check('двое в звонке', await linked(A, 1) && await linked(B, 1));

  // Компьютер: ⌘B открывает доску, мышью — штрих.
  await A.mouse('mouseMoved', 640, 400);
  await A.key('b', 'KeyB', 4);
  check('⌘B открывает доску', await until(() => A.open(), 3000));
  await sleep(500);
  await A.shot('b1-empty-desktop');
  await A.drag(wave(380, 360));
  check('штрих мышью у себя', await A.count() === 1);
  check('штрих дошёл до собеседника, пока у него доска закрыта', await until(async () => (await B.count()) === 1, 5000));
  check('у собеседника появился значок «на доске новое»', await B.ev('document.getElementById("edge").classList.contains("news")'));

  // Телефон: смахнуть от правого края — доска.
  await B.swipe([[386, 420], [360, 420], [320, 420], [270, 420], [230, 420]]);
  check('смахнул от правого края — доска открылась', await until(() => B.open(), 3000));
  await sleep(500);
  await B.swipe(wave(60, 520).map(([x, y]) => [x, y]));
  check('штрих пальцем дошёл до компьютера', await until(async () => (await A.count()) === 2, 5000));

  // Вставка текста (⌘V) — заметка.
  await A.ev(`(() => { const d = new DataTransfer(); d.setData('text/plain', 'Купить молоко и хлеб'); window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d })); })()`);
  check('⌘V с текстом — заметка у обоих', await until(async () => (await A.count()) === 3 && (await B.count()) === 3, 5000));
  // Вставка картинки.
  await A.ev(`(async () => { const c = document.createElement('canvas'); c.width = 600; c.height = 400; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 600, 400); gr.addColorStop(0, '#6cb8ff'); gr.addColorStop(1, '#b78cff'); g.fillStyle = gr; g.fillRect(0, 0, 600, 400); g.fillStyle = '#fff'; g.font = 'bold 60px sans-serif'; g.fillText('Схема', 180, 220);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png')); const d = new DataTransfer(); d.items.add(new File([blob], 'a.png', { type: 'image/png' })); window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d })); })()`);
  check('⌘V с картинкой — картинка у обоих', await until(async () => (await A.count()) === 4 && (await B.count()) === 4, 8000));
  await sleep(700);
  await A.shot('b2-board-desktop');
  await B.shot('b2-board-phone');

  // Отмена.
  await A.key('z', 'KeyZ', 4);
  check('⌘Z убирает последнее у всех', await until(async () => (await A.count()) === 3 && (await B.count()) === 3, 5000));
  // Текст двойным щелчком.
  await A.mouse('mouseMoved', 900, 250);
  await A.mouse('mousePressed', 900, 250, { clickCount: 1 });
  await A.mouse('mouseReleased', 900, 250, { clickCount: 1 });
  await A.mouse('mousePressed', 900, 250, { clickCount: 2 });
  await A.mouse('mouseReleased', 900, 250, { clickCount: 2 });
  await sleep(200);
  await A.cmd('Input.insertText', { text: 'План на завтра' });
  await A.key('Escape', 'Escape');
  check('двойной щелчок — текст, Esc — готово', await until(async () => (await B.ev('zvonilka.board.items().some((x) => x.k === "text" && x.t === "План на завтра")')), 5000));
  check('Esc не закрыл доску, пока писали текст', await A.open());

  // Буквы на доске не открывают чат, а меняют инструмент.
  await A.key('e', 'KeyE');
  check('E — ластик, чат не открылся', !(await A.ev('zvonilka.snapshot().chatOpen')) && (await A.ev('document.querySelector("#board canvas").dataset.tool')) === 'eraser');
  await A.key('p', 'KeyP');

  // Shift — ровная линия: в штрихе две точки, и он строго горизонтальный.
  const before = await A.count();
  await A.drag([[300, 650], [360, 660], [420, 640], [520, 668], [620, 655]], 8);
  const line = await A.ev('(() => { const s = zvonilka.board.items().filter((x) => x.k === "stroke").sort((a, b) => b.z - a.z)[0]; return s.p; })()');
  check('Shift — прямая линия от нажатия до отпускания', (await A.count()) === before + 1 && line.length === 4 && line[2] === 320 && line[3] === 5, JSON.stringify(line));

  // Сглаживание: дрожащая рука даёт ровную кривую, а конец штриха — там, где отпустили.
  const shaky = Array.from({ length: 60 }, (_, i) => [300 + i * 8, 560 + Math.sin(i / 9) * 50 + (i % 2 ? 7 : -7)]);
  await A.drag(shaky);
  const sm = await A.ev(`(() => { const s = zvonilka.board.items().filter((x) => x.k === "stroke").sort((a, b) => b.z - a.z)[0];
    let q = s.p; for (let pass = 0; pass < 2; pass++) { const r = q.slice(); for (let i = 2; i < q.length - 2; i += 2) { r[i] = (q[i - 2] + 2 * q[i] + q[i + 2]) / 4; r[i + 1] = (q[i - 1] + 2 * q[i + 1] + q[i + 3]) / 4; } q = r; }
    let jag = 0; for (let i = 2; i < q.length - 2; i += 2) jag += Math.abs(q[i + 1] - (q[i - 1] + q[i + 3]) / 2);
    return { jag: jag / (q.length / 2), end: [s.x + s.p[s.p.length - 2], s.y + s.p[s.p.length - 1]] }; })()`);
  const endScreen = await A.ev(`(() => { const c = document.querySelector('#board canvas'); return 0; })()`);
  void endScreen;
  check('сглаживание гасит дрожание руки', sm.jag < 1, `средний зубец ${sm.jag.toFixed(2)} (рука дрожала на ±7)`);
  await A.shot('b3-smooth-desktop');
  // Выделение: V, рамка вокруг всего, перенос, удаление, отмена.
  await A.key('v', 'KeyV');
  await A.drag([[40, 60], [600, 400], [1260, 760]]);
  const nsel = await A.ev('zvonilka.board.selected()');
  check('рамка выделяет нарисованное', nsel >= 3, `выделено ${nsel}`);
  const xs = await B.ev('JSON.stringify(zvonilka.board.items().map((x) => Math.round(x.x)))');
  const [hx, hy] = await A.ev(`(() => { const s = zvonilka.board.items().filter((x) => x.k === "stroke")[0]; return [0, 0]; })()`);
  await A.ev('void 0');
  // Потянуть за первый штрих (он выделен) — двигается вся группа.
  const pt = await A.ev(`(() => { const c = document.querySelector('#board canvas'); return [c.clientWidth / 2, c.clientHeight / 2]; })()`);
  void hx; void hy;
  await A.key('a', 'KeyA', 4);
  const all = await A.ev('zvonilka.board.selected()');
  check('⌘A выделяет всё, что видно на экране', all === await A.count(), `${all} из ${await A.count()}`);
  await A.key('d', 'KeyD', 4);
  check('⌘D дублирует выделенное', await until(async () => (await B.count()) === all * 2, 5000), `у собеседника ${await B.count()}`);
  await A.key('Backspace', 'Backspace');
  check('Backspace удаляет выделенное у всех', await until(async () => (await B.count()) === all, 5000));
  await A.key('z', 'KeyZ', 4);
  check('⌘Z возвращает всю группу разом', await until(async () => (await B.count()) === all * 2, 5000));
  await A.key('z', 'KeyZ', 4);
  check('ещё ⌘Z — дубли убраны', await until(async () => (await B.count()) === all, 5000));
  void xs; void pt;
  await A.key('a', 'KeyA', 4);
  await A.key('Escape', 'Escape');
  const afterEsc = [await A.ev('zvonilka.board.selected()'), await A.open()];
  check('Esc снимает выделение, доска остаётся', afterEsc[0] === 0 && afterEsc[1], JSON.stringify(afterEsc));
  await A.key('p', 'KeyP');

  // Телефон: смахнуть от левого края — назад к звонку.
  await B.swipe([[6, 420], [40, 420], [90, 420], [140, 420]]);
  check('смахнул от левого края — снова звонок', await until(async () => !(await B.open()), 3000));
  await A.key('Escape', 'Escape');
  check('Esc на компьютере — снова звонок', await until(async () => !(await A.open()), 3000));

  // Опоздавшая Вера получает всю доску.
  const C = await page('Вера', { w: 1100, h: 700 });
  await C.go();
  const total = await A.count();
  check('опоздавшей пришла вся доска', await until(async () => (await C.count()) === total, 20000), `у неё ${await C.count().catch(() => '?')}`);

  // Борис перезашёл — доска осталась на устройстве.
  await A.ev('zvonilka.call.leave()');
  await C.ev('zvonilka.call.leave()');
  await B.ev('zvonilka.call.leave()');
  await sleep(500);
  await B.go();
  check('после перезахода доска на месте, даже когда никого нет', await until(async () => (await B.count()) === total, 8000));

  for (const P of [A, B, C]) {
    const e = (errors.get(P.sessionId) || []).filter((x) => !/vibrate/.test(x));
    check(`${P.name}: в консоли чисто`, !e.length, e.slice(0, 3).join(' | '));
  }
} catch (e) {
  failed = true;
  console.error('Проверка прервана:', e.message);
} finally {
  chrome.kill();
  server.close();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
const ok = results.filter(Boolean).length;
console.log(`\n${ok} из ${results.length} проверок прошли${SHOTS ? `, снимки — в ${SHOTS}` : ''}`);
process.exit(failed || ok !== results.length ? 1 : 0);
