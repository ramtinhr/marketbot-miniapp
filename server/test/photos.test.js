import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { buildApp } from '../src/app.js';
import { TelegramPhotos } from '../src/photos.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A Bot API stand-in: user 42 has a photo in three sizes, 7 has none. */
function fakeTelegram(calls) {
  return async (url, init = {}) => {
    let target = url;
    if (init.method === 'POST') {
      calls.push({ relay: url, headers: init.headers });
      target = JSON.parse(init.body).url;
    }
    calls.push(target);
    const u = new URL(target);
    const json = (result) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/getUserProfilePhotos')) {
      const sizes = [{ file_id: 's', width: 160 }, { file_id: 'm', width: 320 }, { file_id: 'l', width: 640 }];
      return json({ total_count: 1, photos: u.searchParams.get('user_id') === '42' ? [sizes] : [] });
    }
    if (u.pathname.endsWith('/getFile')) return json({ file_path: `photos/${u.searchParams.get('file_id')}.jpg` });
    if (u.pathname.startsWith('/file/')) return new Response(Buffer.from('JPEG'), { headers: { 'content-type': 'image/jpeg' } });
    return new Response('{}', { status: 404 });
  };
}

test('fetches the smallest size wide enough, caches it, and caches "no photo" too', async () => {
  const calls = [];
  globalThis.fetch = fakeTelegram(calls);
  const photos = new TelegramPhotos({ botToken: 'T' });

  const [a, b] = await Promise.all([photos.photo(42), photos.photo(42)]);
  assert.equal(a.data.toString(), 'JPEG');
  assert.equal(a.type, 'image/jpeg');
  assert.equal(b, a);
  assert.ok(calls.some((c) => c.includes('getFile?file_id=s')));
  assert.equal(calls.length, 3);

  assert.equal(await photos.photo(7), null);
  assert.equal(await photos.photo(7), null);
  assert.equal(calls.length, 4);
});

test('goes through the relay when one is set, with its key', async () => {
  const calls = [];
  globalThis.fetch = fakeTelegram(calls);
  const photos = new TelegramPhotos({ botToken: 'T', proxyUrl: 'http://relay:8080/', proxyKey: 'K' });

  assert.ok(await photos.photo(42));
  const relayed = calls.filter((c) => c.relay);
  assert.equal(relayed.length, 3);
  assert.equal(relayed[0].relay, 'http://relay:8080/request');
  assert.equal(relayed[0].headers['x-api-key'], 'K');
});

test('a Telegram failure is not cached and does not log the token', async () => {
  const logged = [];
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, description: 'Unauthorized botSECRET' }));
  const photos = new TelegramPhotos({ botToken: 'SECRET', log: { warn: (f) => logged.push(f.err.message) } });

  await assert.rejects(photos.photo(42), /Unauthorized/);
  assert.ok(!logged[0].includes('SECRET'));
  globalThis.fetch = fakeTelegram([]);
  assert.ok(await photos.photo(42));
});

test('/me/photo serves the signed-in user\'s photo, 404 without one', async () => {
  const users = {
    configured: true,
    async authenticate(token) {
      const id = { t42: 42, t7: 7 }[token];
      return id ? { user: { id, telegram_id: id }, session: {} } : null;
    },
  };
  const photos = { photo: async (id) => (id === 42 ? { type: 'image/jpeg', data: Buffer.from('JPEG') } : null) };
  const a = await buildApp({ users, photos, logger: false });

  assert.equal((await a.inject('/api/v1/me/photo')).statusCode, 401);
  const ok = await a.inject({ url: '/api/v1/me/photo', headers: { authorization: 'Bearer t42' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'image/jpeg');
  assert.equal(ok.headers['cache-control'], 'private, max-age=3600');
  assert.equal(ok.body, 'JPEG');
  const none = await a.inject({ url: '/api/v1/me/photo', headers: { authorization: 'Bearer t7' } });
  assert.equal(none.statusCode, 404);
  assert.equal(none.json().code, 'no_photo');
});
