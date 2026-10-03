import crypto from 'node:crypto';

import { httpError } from './errors.js';

/**
 * Checks a query string Telegram signed for a Mini App - the launch parameters
 * (`initData`), or the contact `WebApp.requestContact()` hands back - and
 * returns its fields, with `user`/`contact` JSON-decoded. Throws a 401 when
 * the signature is wrong or the data is older than `maxAgeSeconds`.
 *
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifySigned(raw, botToken, { maxAgeSeconds = 0, now = Date.now() } = {}) {
  if (typeof raw !== 'string' || !raw) throw httpError(400, 'bad_request', 'signed telegram data is required');
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw httpError(401, 'bad_signature', 'invalid telegram signature');
  params.delete('hash');

  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(check).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(hash, 'hex'))) {
    throw httpError(401, 'bad_signature', 'invalid telegram signature');
  }

  const authDate = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) throw httpError(401, 'bad_signature', 'invalid telegram signature');
  if (maxAgeSeconds && now / 1000 - authDate > maxAgeSeconds) {
    throw httpError(401, 'expired', 'telegram data has expired - reopen the app');
  }

  const out = Object.fromEntries(params.entries());
  for (const key of ['user', 'contact']) {
    if (out[key] === undefined) continue;
    try {
      out[key] = JSON.parse(out[key]);
    } catch {
      throw httpError(400, 'bad_request', `invalid ${key} in telegram data`);
    }
  }
  out.auth_date = authDate;
  return out;
}

/** Signs `fields` the way Telegram does. For tests and local development only. */
export function signForTest(fields, botToken) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}
