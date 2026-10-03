import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import { httpError } from '../src/errors.js';

/** The UserStore surface the routes use: account 42 has signed in before, 7 has not. */
function fakeUsers({ configured = true } = {}) {
  const sessions = new Map();
  const user = (id) => ({ id, telegram_id: id, phone: '+989121234567' });
  const start = (id) => {
    const token = `t${sessions.size + 1}`;
    sessions.set(token, user(id));
    return { token, user: user(id) };
  };
  return {
    configured,
    sessions,
    async loginExisting(initData) {
      if (initData === 'bad') throw httpError(401, 'bad_signature', 'invalid telegram signature');
      return initData === 'tg42' ? start(42) : null;
    },
    async loginWithContact(initData, contact) {
      if (contact === 'foreign') throw httpError(400, 'phone_not_iranian', 'only Iranian mobile numbers');
      return start(7);
    },
    async authenticate(token) { return sessions.get(token) ?? null; },
    async logout(token) { sessions.delete(token); },
  };
}

const post = (a, url, payload, headers = {}) => a.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers });

test('a returning account gets a session; a new one is asked for its phone', async () => {
  const a = await buildApp({ users: fakeUsers(), logger: false });

  const back = await post(a, '/auth/telegram', { init_data: 'tg42' });
  assert.equal(back.statusCode, 200);
  assert.equal(back.json().status, 'ok');
  assert.ok(back.json().token);

  const fresh = await post(a, '/auth/telegram', { init_data: 'tg7' });
  assert.deepEqual(fresh.json(), { status: 'phone_required' });
});

test('sharing an Iranian number signs in; any other number is refused with a code', async () => {
  const a = await buildApp({ users: fakeUsers(), logger: false });

  const ok = await post(a, '/auth/phone', { init_data: 'tg7', contact: 'signed' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().user.phone, '+989121234567');

  const foreign = await post(a, '/auth/phone', { init_data: 'tg7', contact: 'foreign' });
  assert.equal(foreign.statusCode, 400);
  assert.equal(foreign.json().code, 'phone_not_iranian');

  const forged = await post(a, '/auth/telegram', { init_data: 'bad' });
  assert.equal(forged.statusCode, 401);
  assert.equal(forged.json().code, 'bad_signature');
});

test('/me needs a bearer session, and logout ends it', async () => {
  const a = await buildApp({ users: fakeUsers(), logger: false });
  assert.equal((await a.inject('/api/v1/me')).statusCode, 401);

  const { token } = (await post(a, '/auth/telegram', { init_data: 'tg42' })).json();
  const auth = { authorization: `Bearer ${token}` };
  const me = await a.inject({ url: '/api/v1/me', headers: auth });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.telegram_id, 42);
  assert.equal(me.headers['cache-control'], 'no-store');

  assert.equal((await post(a, '/auth/logout', undefined, auth)).statusCode, 204);
  assert.equal((await a.inject({ url: '/api/v1/me', headers: auth })).statusCode, 401);
});

test('without a bot token every route says so; health does not depend on it', async () => {
  const a = await buildApp({ users: fakeUsers({ configured: false }), logger: false });
  const res = await post(a, '/auth/telegram', { init_data: 'tg42' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, 'not_configured');
  assert.equal((await a.inject('/health')).statusCode, 200);
});
