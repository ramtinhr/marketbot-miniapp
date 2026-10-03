// Sign-in against a real Postgres. Skipped unless TEST_DB_PORT is set, e.g.:
//   docker run -d --rm --name miniapp-pg -e POSTGRES_USER=marketbot -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine
//   TEST_DB_PORT=55432 TEST_DB_PASSWORD=test npm test
// It drops and recreates the miniapp_* tables: never point it at a real database.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { UserStore } from '../src/store.js';
import { signForTest } from '../src/telegram.js';

const port = Number(process.env.TEST_DB_PORT || 0);
const TOKEN = '999:integration';

const now = () => Math.floor(Date.now() / 1000);
const init = (id, name) => signForTest({ auth_date: now(), query_id: 'q', user: { id, first_name: name } }, TOKEN);
const contact = (userId, phone) => signForTest({ auth_date: now(), contact: { user_id: userId, phone_number: phone } }, TOKEN);

let pg;
let app;
const post = (url, payload) => app.inject({ method: 'POST', url: `/api/v1${url}`, payload });
const me = (token) => app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });

before(async () => {
  if (!port) return;
  pg = createPool({
    host: process.env.TEST_DB_HOST || '127.0.0.1',
    port,
    user: process.env.TEST_DB_USER || 'marketbot',
    password: process.env.TEST_DB_PASSWORD || 'test',
    database: process.env.TEST_DB_NAME || 'marketbot',
    ssl: false,
  });
  await pg.query('DROP TABLE IF EXISTS miniapp_sessions, miniapp_users');
  app = await buildApp({ users: new UserStore(pg, { botToken: TOKEN }), logger: false });
});

after(async () => {
  await app?.close();
  await pg?.end();
});

test('sign-in with a shared phone number, end to end', { skip: !port && 'TEST_DB_PORT not set' }, async () => {
  assert.deepEqual((await post('/auth/telegram', { init_data: init(1001, 'علی') })).json(), { status: 'phone_required' });

  let r = await post('/auth/phone', { init_data: init(1001, 'علی'), contact: contact(1001, '+447700900123') });
  assert.equal(r.json().code, 'phone_not_iranian');

  r = await post('/auth/phone', { init_data: init(1001, 'علی'), contact: contact(2002, '989121234567') });
  assert.equal(r.json().code, 'contact_mismatch');

  r = await post('/auth/phone', { init_data: init(1001, 'علی'), contact: contact(1001, '989121234567') });
  assert.equal(r.statusCode, 200, r.body);
  const first = r.json().token;
  assert.equal(r.json().user.phone, '+989121234567');
  assert.equal((await me(first)).json().user.telegram_id, 1001);

  // Reopening signs in without the phone, and picks up a changed name.
  r = await post('/auth/telegram', { init_data: init(1001, 'علی رضایی') });
  assert.equal(r.json().status, 'ok');
  assert.equal(r.json().user.first_name, 'علی رضایی');
});

test('a number that moves to another Telegram account leaves the old one', { skip: !port && 'TEST_DB_PORT not set' }, async () => {
  const old = (await post('/auth/telegram', { init_data: init(1001, 'علی') })).json().token;
  assert.ok(old);

  const r = await post('/auth/phone', { init_data: init(3003, 'مریم'), contact: contact(3003, '+98 912 123 4567') });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().user.phone, '+989121234567');

  assert.equal((await me(old)).statusCode, 401);
  assert.deepEqual((await post('/auth/telegram', { init_data: init(1001, 'علی') })).json(), { status: 'phone_required' });
});
