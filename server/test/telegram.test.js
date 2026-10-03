import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeIranMobile } from '../src/phone.js';
import { signForTest, verifySigned } from '../src/telegram.js';

const TOKEN = '123456:TEST-token';
const now = Date.now();
const authDate = Math.floor(now / 1000) - 60;

test('signed data verifies and decodes its JSON fields', () => {
  const raw = signForTest({ auth_date: authDate, query_id: 'q1', user: { id: 42, first_name: 'رامتین' } }, TOKEN);
  const data = verifySigned(raw, TOKEN, { maxAgeSeconds: 3600, now });
  assert.equal(data.user.id, 42);
  assert.equal(data.user.first_name, 'رامتین');
  assert.equal(data.auth_date, authDate);
});

test('a wrong token, a changed field or a missing hash is refused', () => {
  const raw = signForTest({ auth_date: authDate, user: { id: 42 } }, TOKEN);
  assert.throws(() => verifySigned(raw, 'other:token', { now }), { statusCode: 401, code: 'bad_signature' });

  const tampered = new URLSearchParams(raw);
  tampered.set('user', JSON.stringify({ id: 43 }));
  assert.throws(() => verifySigned(tampered.toString(), TOKEN, { now }), { code: 'bad_signature' });

  tampered.delete('hash');
  assert.throws(() => verifySigned(tampered.toString(), TOKEN, { now }), { code: 'bad_signature' });
  assert.throws(() => verifySigned('', TOKEN, { now }), { statusCode: 400 });
});

test('old data is refused once past its age', () => {
  const raw = signForTest({ auth_date: authDate - 7200, user: { id: 42 } }, TOKEN);
  assert.throws(() => verifySigned(raw, TOKEN, { maxAgeSeconds: 3600, now }), { code: 'expired' });
  assert.equal(verifySigned(raw, TOKEN, { now }).user.id, 42);
});

test('Iranian mobile numbers normalise to +989XXXXXXXXX; anything else is null', () => {
  for (const raw of ['989121234567', '+989121234567', '09121234567', '9121234567', '00989121234567', '+98 912 123-4567', '۰۹۱۲۱۲۳۴۵۶۷', '٠٩١٢١٢٣٤٥٦٧']) {
    assert.equal(normalizeIranMobile(raw), '+989121234567', raw);
  }
  for (const raw of ['+12025550123', '442071234567', '982188776655', '0912123456', '091212345678', 'abc', '', null, undefined]) {
    assert.equal(normalizeIranMobile(raw), null, String(raw));
  }
});
