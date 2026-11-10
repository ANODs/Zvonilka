#!/usr/bin/env node
// Бот Звонилки: зовёт в звонок из любого чата Telegram.
//
//   @бот           — в любом чате: «Позвать в звонок», новый звонок со случайным кодом
//   @бот планёрка  — звонок с понятным кодом: кто наберёт то же слово, попадёт туда же
//   /start         — кнопка «Новый звонок» в личном чате с ботом
//
// Кнопка под сообщением ведёт на https://t.me/<бот>?startapp=<код> — эта ссылка открывает
// Mini App (страницу web/) сразу в нужной комнате. Сам звонок бот не видит и ничего о нём
// не хранит: он только составляет ссылку.
//
// Запуск: TELEGRAM_BOT_TOKEN=… node bot/bot.mjs   (Node 18+, зависимостей нет)
// Токен берётся из окружения и никуда не выводится. Одновременно с прежним ботом
// (telegram-bot.js) не запускать: обновления получает только один из них.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Нужна переменная окружения TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}/`;

async function api(method, params = {}) {
  const res = await fetch(API + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(40000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data.result;
}

// Те же правила, что на странице (web/call.js): регистр не важен, пробелы и знаки — дефис.
function normalizeRoom(s) {
  return String(s == null ? '' : s).normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function newRoom() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  let out = '';
  for (const b of bytes) if (b < 252 && out.length < 16) out += chars[b % 36];
  return out;
}

// Стартовый параметр Telegram — только латиница, цифры и «_»; всё остальное идёт как X + hex.
function roomParam(room) {
  if (/^[a-z0-9_]{1,64}$/.test(room)) return room;
  return 'X' + [...new TextEncoder().encode(room)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const me = await api('getMe');
const link = (room) => `https://t.me/${me.username}?startapp=${roomParam(room)}`;
const button = (room) => ({ inline_keyboard: [[{ text: 'Войти в звонок', url: link(room) }]] });
console.log(`Бот @${me.username} работает`);

async function onInline(q) {
  let room = normalizeRoom(q.query);
  if (roomParam(room).length > 64) room = ''; // слишком длинное слово не влезет в ссылку
  const named = !!room;
  if (!room) room = newRoom();
  await api('answerInlineQuery', {
    inline_query_id: q.id,
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

async function onMessage(m) {
  if (!m.text || m.chat.type !== 'private') return;
  const room = newRoom();
  await api('sendMessage', {
    chat_id: m.chat.id,
    text: `Новый звонок готов. Перешлите это сообщение тому, кого зовёте, или наберите @${me.username} в любом чате.`,
    reply_markup: button(room),
  });
}

for (let offset = 0; ;) {
  let updates = [];
  try {
    updates = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'inline_query'] });
  } catch (e) {
    console.error('Нет связи с Telegram:', e.message);
    await new Promise((r) => setTimeout(r, 3000));
    continue;
  }
  for (const u of updates) {
    offset = u.update_id + 1;
    try {
      if (u.inline_query) await onInline(u.inline_query);
      else if (u.message) await onMessage(u.message);
    } catch (e) {
      console.error('Не удалось ответить:', e.message);
    }
  }
}
