#!/usr/bin/env node
// Проверка ретранслятора: два участника в безголовом Chrome, прямой путь запрещён (?relayforce),
// звук, видео, состояние и чат должны дойти через воркер.
//
//   node tools/relay_test.mjs                         воркер, запущенный локально: cd bot && npx wrangler dev
//   node tools/relay_test.mjs --relay <адрес воркера>  другой воркер, например настоящий

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const at = process.argv.indexOf('--relay');
const RELAY = at > 0 ? process.argv[at + 1] : 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = '') => { results.push(!!pass); console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

async function until(fn, ms = 20000, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

const profile = await mkdtemp(join(tmpdir(), 'zvonilka-relay-'));
const { server, port } = await serve(fileURLToPath(new URL('../web/', import.meta.url)));
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
  const waiting = new Map();
  const errors = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { const w = waiting.get(m.id); waiting.delete(m.id); if (w) m.error ? w[1](new Error(m.error.message)) : w[0](m.result); }
    else if (m.method === 'Runtime.exceptionThrown' || (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')) {
      (errors.get(m.sessionId) || errors.set(m.sessionId, []).get(m.sessionId)).push(JSON.stringify(m.params).slice(0, 300));
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const i = ++id; waiting.set(i, [ok, fail]); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  async function page(name) {
    const { browserContextId } = await send('Target.createBrowserContext');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    const room = 'relay-' + Math.random().toString(36).slice(2, 10);
    const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
    return { name, sessionId, ev, room, go: (r) => send('Page.navigate', { url: `http://127.0.0.1:${port}/?name=${encodeURIComponent(name)}&relay=${encodeURIComponent(RELAY)}&relayforce#${r}` }, sessionId) };
  }
  const A = await page('Аня'), B = await page('Борис');
  const room = A.room;
  await A.go(room);
  await sleep(1500);
  await B.go(room);
  const flows = (P) => until(async () => { const s = await P.ev('zvonilka.call.stats()'); return s.length === 1 && s[0].path === 'relay' && s[0].audio > 25 && s[0].video > 5 && s; }, 45000);
  const [sa, sb] = [await flows(A), await flows(B)];
  check('через ретранслятор идут звук и видео в обе стороны', sa && sb, sa && sb ? `Аня получила ${sa[0].audio} кусков звука и ${sa[0].video} кадров, Борис — ${sb[0].audio} и ${sb[0].video}` : JSON.stringify(await A.ev('zvonilka.call.stats()')));
  check('имена дошли через ретранслятор', sa && sa[0].name === 'Борис' && sb && sb[0].name === 'Аня');
  const tile = await B.ev(`(() => { const t = [...zvonilka.tiles.values()].find((x) => !x.d.self); return t ? t.video.videoWidth + 'x' + t.video.videoHeight : ''; })()`);
  check('картинка собеседника видна на плитке', /^[1-9]\d*x[1-9]\d*$/.test(tile), tile);
  await A.ev('zvonilka.call.toggleMic()');
  check('выключенный микрофон виден собеседнику', await until(async () => (await B.ev('zvonilka.call.stats()'))[0].state.mic === false, 6000));
  const p1 = (await B.ev('zvonilka.call.stats()'))[0].audio;
  await sleep(1500);
  const p2 = (await B.ev('zvonilka.call.stats()'))[0].audio;
  check('выключенный микрофон не передаётся', p2 - p1 < 3, `за 1,5 с пришло ${p2 - p1} кусков`);
  await A.ev('zvonilka.call.sendChat("привет через сервер")');
  await A.ev('zvonilka.call.toggleMic()');
  check('сообщение дошло', await until(() => B.ev('document.getElementById("chat-log").textContent.includes("привет через сервер")'), 6000));
  await A.ev('zvonilka.call.leave()');
  check('вышел — собеседник это видит', await until(async () => (await B.ev('zvonilka.call.stats()')).length === 0, 10000));
  for (const P of [A, B]) {
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
console.log(`\n${ok} из ${results.length} проверок прошли`);
process.exit(failed || ok !== results.length ? 1 : 0);
