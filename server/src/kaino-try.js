// Tries Kaino for real, outside the mini app, with the same code the server
// runs (Kaino, KainoGateway). Reads the KAINO_* values from server/.env.
// Prints every request and answer; touches no database and no wallet.
//
//   npm run kaino:try -- login
//       logs in only: checks the URL, username, password and KAINO_SECRET
//
//   npm run kaino:try -- charge [toman] [--callback URL] [--port 8787]
//       opens a charge (default 10000 Toman) and prints the pay link. Without
//       --callback, Kaino sends the browser back to a page this script serves
//       on localhost, and the payment is verified the moment it arrives. With
//       --callback (e.g. when Kaino will not take a localhost address), run
//       `verify` yourself after paying.
//
//   npm run kaino:try -- verify [key=value ...]
//       verifies the last charge (kept in server/.kaino-try.json); key=value
//       pairs are what the callback carried, e.g. stan=123 result=true
//
// Paying a charge moves real money into the merchant wallet: use small amounts.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { Kaino, KainoGateway, redact, signText } from './kaino.js';

const STATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.kaino-try.json');

const SIGNED = {
  '/chargeWallet': ['identifier', 'tenant', 'amount', 'username', 'localDate', 'callBackUrl'],
  '/chargeWallet/verify': ['identifier', 'tenant', 'amount', 'reference', 'isVerify', 'stan'],
};

const show = (value) => JSON.stringify(value, null, 2).replace(/\n/g, '\n    ');

/** fetch, printing each request (with the text that was signed) and each answer. */
async function loggingFetch(url, init) {
  const { pathname } = new URL(url);
  const body = JSON.parse(init.body);
  console.log(`\n→ POST ${url}`);
  console.log(`    authorization: ${init.headers.authorization ? 'yes (token)' : 'none'}`);
  const { sign: _sign, ...fields } = body;
  console.log(`    body: ${show(redact(fields))}`);
  const endpoint = Object.keys(SIGNED).find((e) => pathname.endsWith(e));
  if (endpoint) console.log(`    signed text: ${signText(body, SIGNED[endpoint])}`);
  if (body.sign) console.log(`    sign: ${body.sign}`);
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    console.log(`← network error: ${err.message}${err.cause ? ` (${err.cause.message ?? err.cause})` : ''}`);
    throw err;
  }
  const text = await res.clone().text();
  let shown = text;
  try {
    shown = show(redact(JSON.parse(text)));
  } catch {
    // Not JSON; shown as it came.
  }
  console.log(`← HTTP ${res.status}\n    ${shown || '(empty body)'}`);
  return res;
}

const log = { info() {}, warn() {}, error() {} };

function gateway() {
  const k = config.payments.kaino;
  if (/[\s>]$/.test(k.secret) || /\s/.test(k.secret)) {
    console.warn('warning: KAINO_SECRET contains spaces or ends with ">" - it looks cut off; every signature will be wrong');
  }
  return new KainoGateway(new Kaino({ ...k, allowHttp: true, fetchImpl: loggingFetch, log }));
}

const newAuthority = () => `MB-${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

function option(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

/** Serves the callback on localhost until Kaino sends the browser to it. */
function awaitCallback(port, authority) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== `/kaino-callback/${authority}`) {
        res.writeHead(404).end();
        return;
      }
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        let body = {};
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            body = Object.fromEntries(new URLSearchParams(raw));
          }
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<p style="font:20px sans-serif">Kaino came back - see the terminal.</p>');
        server.close();
        resolve({ method: req.method, query: Object.fromEntries(url.searchParams), body, contentType: req.headers['content-type'] ?? null });
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
  });
}

async function verify(g, state, params) {
  console.log(`\n=== verify ${state.authority} (${state.amountToman} Toman, reference ${state.ref})`);
  try {
    const outcome = await g.verify({ authority: state.authority, ref: state.ref, amountToman: state.amountToman, params });
    console.log('\n=== outcome, as the server would act on it');
    if (outcome.paid) console.log(`PAID - the wallet would be credited. refId=${outcome.refId} cardPan=${outcome.cardPan ?? '-'}`);
    else if (outcome.unclear) console.log(`UNCLEAR - left pending for an operator: ${outcome.reason}`);
    else console.log(`${outcome.cancelled ? 'CANCELLED' : 'FAILED'} - nothing credited: ${outcome.reason}`);
  } catch (err) {
    console.log(`\n=== outcome: ERROR - the payment would stay pending: ${err.message}`);
    process.exitCode = 1;
  }
}

const [command = 'help', ...args] = process.argv.slice(2);

try {
  if (command === 'login') {
    await gateway().kaino.login();
    console.log('\nlogin OK - the URL, username, password and KAINO_SECRET work');
  } else if (command === 'charge') {
    const callback = option(args, '--callback', null);
    const port = Number(option(args, '--port', '8787'));
    const amountToman = Number(args[0] ?? 10_000);
    if (!Number.isSafeInteger(amountToman) || amountToman <= 0) throw new Error(`not a whole Toman amount: ${args[0]}`);
    const authority = newAuthority();
    const callbackUrl = callback ?? `http://localhost:${port}/kaino-callback/${authority}`;
    const g = gateway();
    console.log(`=== charge ${authority}: ${amountToman} Toman (${amountToman * 10} Rial), back to ${callbackUrl}`);
    const { ref, url } = await g.request({ authority, amountToman, callbackUrl });
    const state = { authority, ref, amountToman, callbackUrl, at: new Date().toISOString() };
    fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
    console.log(`\n=== open this and pay:\n\n    ${url}\n`);
    if (callback) {
      console.log('then run: npm run kaino:try -- verify [key=value ...from the callback]');
    } else {
      console.log(`waiting for Kaino to send the browser to localhost:${port} (Ctrl+C to stop)...`);
      const back = await awaitCallback(port, authority);
      console.log(`\n=== callback: ${back.method}, content-type ${back.contentType ?? '-'}`);
      console.log(`    query: ${show(back.query)}`);
      console.log(`    body: ${show(back.body)}`);
      state.callback = back;
      fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
      await verify(g, state, { ...back.query, ...back.body });
    }
  } else if (command === 'verify') {
    if (!fs.existsSync(STATE)) throw new Error('no charge yet - run `npm run kaino:try -- charge` first');
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const given = Object.fromEntries(args.filter((a) => a.includes('=')).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
    const params = Object.keys(given).length ? given : { ...state.callback?.query, ...state.callback?.body };
    await verify(gateway(), state, params);
  } else {
    console.log('usage: npm run kaino:try -- login | charge [toman] [--callback URL] [--port 8787] | verify [key=value ...]');
  }
} catch (err) {
  console.error(`\nfailed: ${err.message}`);
  process.exit(1);
}
