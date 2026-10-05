// Sends one real code through Kavenegar, outside the mini app, with the same
// code the server runs (KavenegarSms). Reads KAVENEGAR_* from server/.env.
// Touches no database.
//
//   npm run sms:try -- 09121234567 [code]
//       sends `code` (default: a random 5 digits) with KAVENEGAR_OTP_TEMPLATE
//
// Each send is charged to the Kavenegar account.

import { randomInt } from 'node:crypto';

import { config } from './config.js';
import { KavenegarSms } from './sms.js';

const [phoneArg, codeArg] = process.argv.slice(2);
if (!phoneArg) {
  console.error('usage: npm run sms:try -- <mobile, e.g. 09121234567> [code]');
  process.exit(1);
}

const phone = phoneArg.startsWith('0') ? `+98${phoneArg.slice(1)}` : phoneArg;
const code = codeArg ?? String(randomInt(10_000, 100_000));
const { kavenegarApiKey: apiKey, kavenegarTemplate: template } = config.sms;

async function loggingFetch(url, init) {
  console.log(`→ ${init.method} ${String(url).replace(encodeURIComponent(apiKey), '<api key>')}`);
  const res = await fetch(url, init);
  const text = await res.clone().text();
  console.log(`← ${res.status} ${text}`);
  return res;
}

const sms = new KavenegarSms({ apiKey, template, fetchImpl: loggingFetch });
try {
  await sms.sendCode(phone, code);
  console.log(`\nsent code ${code} to ${phone} with template "${template}"`);
} catch (err) {
  console.error(`\nfailed: ${err.message}`);
  process.exit(1);
}
