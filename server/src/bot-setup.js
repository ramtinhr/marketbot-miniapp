// One-off: points the bot at this server - the menu button that opens the Mini
// App, the commands, and the webhook at $PUBLIC_URL. Telegram keeps them, so
// run it again only when PUBLIC_URL or BOT_TOKEN changes. Reads server/.env and
// goes through TELEGRAM_PROXY_URL like every other Bot API call.
//
//   npm run bot:setup

import { Bot } from './bot.js';
import { config } from './config.js';

const bot = new Bot({ botToken: config.auth.botToken, publicUrl: config.publicUrl, ...config.telegram });

try {
  const info = await bot.setup();
  console.log(`webhook: ${info.url}`);
  console.log(`pending updates: ${info.pending_update_count}`);
  if (info.last_error_message) console.log(`last error: ${info.last_error_message}`);
  console.log('menu button and commands set');
} catch (err) {
  console.error(`bot setup failed: ${err.message.replaceAll(config.auth.botToken, '<token>')}`);
  if (!config.telegram.proxyUrl) console.error('TELEGRAM_PROXY_URL is empty - Telegram was called directly');
  process.exit(1);
}
