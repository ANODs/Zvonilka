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

export default {
  async fetch(request, env) {
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
      const allowed = /^https:\/\/anods\.github\.io$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      const headers = { 'content-type': 'application/json', 'access-control-allow-origin': allowed ? origin : 'https://anods.github.io', vary: 'origin', 'cache-control': 'no-store' };
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
