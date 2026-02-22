const { Telegraf, Markup } = require('telegraf');
require('dotenv').config({ path: '.env.local' });

// Ensure token is loaded
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
    console.error("TELEGRAM_BOT_TOKEN is not defined in .env.local!");
    process.exit(1);
}

const bot = new Telegraf(botToken);
const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://zvonilka.pton.app'; // Fallback base URL for the join button

bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query.trim();

    // Return nothing if user hasn't typed a room code yet
    if (!query) {
        return await ctx.answerInlineQuery([]);
    }

    const roomLink = `${appUrl}/room/${query}`;

    const results = [
        {
            type: 'article',
            id: '1',
            title: 'Поделиться ссылкой на комнату',
            description: `Комната: ${query}`,
            input_message_content: {
                message_text: `📞 Приглашаю вас присоединиться к комнате **${query}**!`,
                parse_mode: 'Markdown'
            },
            ...Markup.inlineKeyboard([
                Markup.button.url('Присоединиться 🎥', roomLink)
            ])
        }
    ];

    return await ctx.answerInlineQuery(results);
});

// Launch bot
bot.launch().then(() => {
    console.log("Telegram Inline Bot is running 🤖");
}).catch((err) => {
    console.error("Failed to launch bot:", err);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
