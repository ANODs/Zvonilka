// Бот Звонилки для Cloudflare Workers: тот же bot.mjs, только без своего компьютера.
// Telegram сам присылает сюда запросы (вебхук), воркер отвечает кнопкой «Войти в звонок».
//
//   @бот           — в любом чате: новый звонок со случайным кодом
//   @бот планёрка  — звонок с понятным кодом
//   /start         — кнопка «Новый звонок» в личном чате
//
// Настройка: секрет TELEGRAM_BOT_TOKEN в настройках воркера, затем один раз открыть
// https://<адрес воркера>/setup — воркер сам скажет Telegram слать запросы сюда.
// Имя бота — переменная BOT_USERNAME (по умолчанию StartNewCallBot).
// GET /ice — временные ключи ретранслятора для страницы (секреты TURN_KEY_ID, TURN_KEY_TOKEN).
// Токен нигде не выводится; чужие запросы отсекаются по секретному заголовку,
// который выводится из токена.

import { DurableObject } from 'cloudflare:workers';

const te = new TextEncoder();
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// Те же правила, что на странице (web/call.js): регистр не важен, пробелы и знаки — дефис.
function normalizeRoom(s) {
  return String(s == null ? '' : s).normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function newRoom() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (const b of crypto.getRandomValues(new Uint8Array(64))) if (b < 252 && out.length < 16) out += chars[b % 36];
  return out;
}

// Стартовый параметр Telegram — только латиница, цифры и «_»; всё остальное идёт как X + hex.
const roomParam = (room) => (/^[a-z0-9_]{1,64}$/.test(room) ? room : 'X' + hex(te.encode(room)));

// Секрет вебхука: по нему воркер узнаёт, что запрос прислал именно Telegram.
async function hookSecret(token) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode('zvonilka webhook ' + token)))).slice(0, 48);
}

const json = (obj) => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });

// Проверка канала: доходит ли до воркера долгий поток с телефона. Операторы в России местами
// режут соединения с Cloudflare после первых килобайт — тогда ретранслятор здесь бесполезен.
const TEST_PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Проверка канала</title>
<style>body{margin:0;padding:24px;background:#000;color:#fff;font:17px/1.45 -apple-system,system-ui,sans-serif}
h1{font-size:26px;margin:0 0 8px}p{color:#aaa;margin:0 0 20px}button{width:100%;height:56px;border:0;border-radius:28px;background:#fff;color:#000;font:600 17px system-ui}
#log{margin-top:24px;white-space:pre-wrap}.ok{color:#5fd38d}.bad{color:#ff6b6b}b{font-size:22px}</style></head>
<body><h1>Проверка канала</h1><p>Выключите VPN и Wi-Fi, оставьте только мобильную связь, нажмите кнопку и подождите до 40 секунд.</p>
<button id="go">Проверить</button><div id="log"></div>
<script>
const log = (t, c) => { const d = document.createElement('div'); d.textContent = t; if (c) d.className = c; document.getElementById('log').append(d); };
function run(kind, bytes) {
  return new Promise((done) => {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/test/ws');
    ws.binaryType = 'arraybuffer';
    let got = 0, t0 = 0, sent = 0;
    const end = (ok) => { clearTimeout(timer); try { ws.close(); } catch (_) {} done({ ok, got, sent, ms: performance.now() - t0 }); };
    const timer = setTimeout(() => end(false), 15000);
    ws.onopen = () => {
      t0 = performance.now();
      if (kind === 'down') ws.send(JSON.stringify({ down: bytes }));
      else { const chunk = new Uint8Array(16384); const pump = () => { while (sent < bytes && ws.bufferedAmount < 262144) { ws.send(chunk); sent += chunk.length; } if (sent < bytes) setTimeout(pump, 10); else ws.send(JSON.stringify({ up: sent })); }; pump(); }
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') { const m = JSON.parse(e.data); if (m.upGot >= bytes) { got = m.upGot; end(true); } return; }
      got += e.data.byteLength; if (got >= bytes) end(true);
    };
    ws.onerror = () => end(false);
  });
}
const rate = (r) => (r.got * 8 / Math.max(r.ms, 1) / 1000).toFixed(1) + ' Мбит/с';
document.getElementById('go').onclick = async () => {
  document.getElementById('log').textContent = '';
  log('Сеть: ' + ((navigator.connection && navigator.connection.type) || 'неизвестно'));
  const d = await run('down', 2 * 1024 * 1024);
  log(d.ok ? 'Приём: ' + rate(d) : 'Приём оборвался на ' + Math.round(d.got / 1024) + ' КБ из 2048', d.ok ? 'ok' : 'bad');
  const u = await run('up', 1024 * 1024);
  log(u.ok ? 'Отправка: ' + rate(u) : 'Отправка оборвалась: сервер получил ' + Math.round(u.got / 1024) + ' КБ из 1024', u.ok ? 'ok' : 'bad');
  const b = document.createElement('b'); b.textContent = d.ok && u.ok ? 'Канал работает — ретранслятор через Cloudflare подойдёт' : 'Канал режется — через Cloudflare без VPN не выйдет'; b.className = d.ok && u.ok ? 'ok' : 'bad';
  document.getElementById('log').append(document.createElement('br'), b);
};
</script></body></html>`;

function testSocket() {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  let upGot = 0;
  server.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') { upGot += e.data.byteLength; return; }
    const m = JSON.parse(e.data);
    if (m.down) {
      const chunk = new Uint8Array(16384);
      for (let sent = 0; sent < Math.min(m.down, 8 << 20); sent += chunk.length) server.send(chunk);
    } else if (m.up) server.send(JSON.stringify({ upGot }));
  });
  return new Response(null, { status: 101, webSocket: client });
}

// Ретранслятор звонка (web/relay.js): по комнате на каждую тему звонка. Кто подключился, тот
// получает все сообщения остальных. Сообщения запечатаны ключом комнаты, здесь их не открыть.
const ORIGINS = /^https:\/\/(zvonilka\.timoshkin\.dev|anods\.github\.io)$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export class Room extends DurableObject {
  async fetch(request) {
    if (this.ctx.getWebSockets().length >= 12) return new Response('Комната полна', { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server); // пока все молчат, комната спит и не тратит лимиты
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message === 'string' || message.byteLength > 262144) return;
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) { try { other.send(message); } catch (_) {} }
    }
  }

  webSocketClose(ws) { try { ws.close(); } catch (_) {} }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const room = /^\/relay\/([0-9a-f]{32})$/.exec(path);
    if (room) {
      if (request.headers.get('upgrade') !== 'websocket') return new Response('Нужен WebSocket', { status: 426 });
      if (!ORIGINS.test(request.headers.get('origin') || '')) return new Response('Нет', { status: 403 });
      return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(request);
    }
    if (path === '/test') return new Response(TEST_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    if (path === '/test/ws' && request.headers.get('upgrade') === 'websocket') return testSocket();

    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return new Response('Не задан секрет TELEGRAM_BOT_TOKEN', { status: 500 });
    const bot = env.BOT_USERNAME || 'StartNewCallBot';
    const url = new URL(request.url);
    const secret = await hookSecret(token);

    // Один раз после выкладки: сказать Telegram, куда слать запросы.
    if (request.method === 'GET' && url.pathname === '/setup') {
      const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url.origin + '/hook', secret_token: secret, allowed_updates: ['message', 'inline_query'], drop_pending_updates: true }),
      });
      const data = await res.json();
      return new Response(data.ok ? `Готово: Telegram шлёт запросы бота @${bot} сюда` : `Не получилось: ${data.description}`, { status: data.ok ? 200 : 502 });
    }

    // Временные ключи к ретранслятору Cloudflare (TURN) для страницы звонка: запасной путь,
    // когда два устройства не могут соединиться напрямую. Нужны секреты TURN_KEY_ID и
    // TURN_KEY_TOKEN; без них страница работает как раньше, только напрямую.
    if (request.method === 'GET' && url.pathname === '/ice') {
      const origin = request.headers.get('origin') || '';
      const allowed = /^https:\/\/(zvonilka\.timoshkin\.dev|anods\.github\.io)$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      const headers = { 'content-type': 'application/json', 'access-control-allow-origin': allowed ? origin : 'https://zvonilka.timoshkin.dev', vary: 'origin', 'cache-control': 'no-store' };
      let iceServers = [];
      if (allowed && env.TURN_KEY_ID && env.TURN_KEY_TOKEN) {
        const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.TURN_KEY_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ttl: 21600 }), // шесть часов — с запасом на длинный звонок
        }).catch(() => null);
        const data = res && res.ok ? await res.json().catch(() => null) : null;
        if (data && Array.isArray(data.iceServers)) iceServers = data.iceServers;
      }
      return new Response(JSON.stringify({ iceServers }), { headers });
    }

    if (request.method !== 'POST' || url.pathname !== '/hook') return new Response('Бот Звонилки');
    if (request.headers.get('x-telegram-bot-api-secret-token') !== secret) return new Response('Нет', { status: 403 });

    const u = await request.json().catch(() => ({}));
    const link = (room) => `https://t.me/${bot}?startapp=${roomParam(room)}`;
    const button = (room) => ({ inline_keyboard: [[{ text: 'Войти в звонок', url: link(room) }]] });

    // Ответ уходит прямо в теле ответа на вебхук — лишний запрос к Telegram не нужен.
    if (u.inline_query) {
      let room = normalizeRoom(u.inline_query.query);
      if (roomParam(room).length > 64) room = ''; // слишком длинное слово не влезет в ссылку
      const named = !!room;
      if (!room) room = newRoom();
      return json({
        method: 'answerInlineQuery',
        inline_query_id: u.inline_query.id,
        cache_time: 0, // у каждого запроса свой код звонка
        is_personal: true,
        results: [{
          type: 'article',
          id: roomParam(room),
          title: named ? `Позвать в звонок «${room}»` : 'Позвать в звонок',
          description: 'Отправит сюда кнопку: нажал — и сразу в звонке',
          input_message_content: { message_text: named ? `Звонок «${room}» — заходите` : 'Звонок — заходите' },
          reply_markup: button(room),
        }],
      });
    }
    if (u.message && u.message.text && u.message.chat.type === 'private') {
      return json({
        method: 'sendMessage',
        chat_id: u.message.chat.id,
        text: `Новый звонок готов. Перешлите это сообщение тому, кого зовёте, или наберите @${bot} в любом чате.`,
        reply_markup: button(newRoom()),
      });
    }
    return new Response('ok');
  },
};
