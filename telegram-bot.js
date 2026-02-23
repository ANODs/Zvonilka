const { Telegraf, Markup } = require('telegraf');
require('dotenv').config({ path: '.env.local' });

// Ensure token is loaded
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
    console.error("TELEGRAM_BOT_TOKEN is not defined in .env.local!");
    process.exit(1);
}

const bot = new Telegraf(botToken);
const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://hostfi.app'; // Fallback base URL for the join button

bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query.trim();

    // Return nothing if user hasn't typed a room code yet
    if (!query) {
        return await ctx.answerInlineQuery([]);
    }

    const roomLink = `${appUrl}/room/${query}`;

    // Escape HTML special characters to prevent Telegram parse errors
    const escapeHTML = (text) => text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const escapedQuery = escapeHTML(query);

    const results = [
        {
            type: 'article',
            id: '1',
            title: 'Поделиться ссылкой на комнату',
            description: `Комната: ${query}`,
            input_message_content: {
                message_text: `📞 Приглашаю вас присоединиться к комнате <b>${escapedQuery}</b>!`,
                parse_mode: 'HTML'
            },
            reply_markup: {
                inline_keyboard: [[
                    { text: 'Присоединиться 🎥', url: roomLink, style: 'success' }
                ]]
            }
        }
    ];

    return await ctx.answerInlineQuery(results);
});

// Start and Help commands for private messages
const startMessage = `
Привет! 👋 Я бот для быстрого создания приглашений в звонки.

Я работаю в <b>инлайн-режиме</b>. Это значит, что вы можете использовать меня прямо в любом чате или группе!

<b>Как пользоваться:</b>
1. Откройте любой чат, куда хотите скинуть ссылку.
2. Напишите: <code>@StartNewCallBot 1234</code> (где 1234 — это любой код или название вашей комнаты).
3. Над полем ввода появится окно с кнопкой, нажмите на него — и в чат улетит красивая кнопка-приглашение! 🎥
`;

bot.start((ctx) => ctx.replyWithHTML(startMessage));
bot.help((ctx) => ctx.replyWithHTML(startMessage));

// Launch bot
bot.launch().then(() => {
    console.log("Telegram Inline Bot is running 🤖");
}).catch((err) => {
    console.error("Failed to launch bot:", err);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
