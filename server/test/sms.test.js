import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConsoleSms, KavenegarSms, createSms, localMobile } from '../src/sms.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeKavenegar(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return answer();
  };
  return { calls, fetchImpl };
}

test('localMobile turns +98 numbers into the 09 form Kavenegar takes', () => {
  assert.equal(localMobile('+989121234567'), '09121234567');
  assert.equal(localMobile('09121234567'), '09121234567');
});

test('KavenegarSms sends the code with the verify/lookup template', async () => {
  const { calls, fetchImpl } = fakeKavenegar(() => json(200, { return: { status: 200, message: 'تایید شد' }, entries: [] }));
  const sms = new KavenegarSms({ apiKey: 'KEY/1', template: 'otp', fetchImpl });
  await sms.sendCode('+989121234567', '12345');

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(url.origin, 'https://api.kavenegar.com');
  assert.equal(url.pathname, '/v1/KEY%2F1/verify/lookup.json');
  assert.deepEqual(Object.fromEntries(url.searchParams), { receptor: '09121234567', token: '12345', template: 'otp' });
});

test('KavenegarSms reports a refused message as sms_failed', async () => {
  const { fetchImpl } = fakeKavenegar(() => json(400, { return: { status: 424, message: 'template not found' }, entries: null }));
  const sms = new KavenegarSms({ apiKey: 'KEY', template: 'otp', fetchImpl });
  await assert.rejects(sms.sendCode('+989121234567', '12345'), (err) => {
    assert.equal(err.statusCode, 502);
    assert.equal(err.code, 'sms_failed');
    assert.match(err.message, /template not found/);
    return true;
  });
});

test('KavenegarSms reports an unreachable Kavenegar as sms_failed', async () => {
  const sms = new KavenegarSms({ apiKey: 'KEY', template: 'otp', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(sms.sendCode('+989121234567', '12345'), { code: 'sms_failed' });
});

test('KavenegarSms without a key or template refuses with sms_unavailable', async () => {
  const { calls, fetchImpl } = fakeKavenegar(() => json(200, {}));
  const sms = new KavenegarSms({ apiKey: 'KEY', template: '', fetchImpl });
  assert.equal(sms.configured, false);
  await assert.rejects(sms.sendCode('+989121234567', '12345'), { code: 'sms_unavailable' });
  assert.equal(calls.length, 0);
});

test('createSms picks the provider and keeps console out of production', () => {
  const log = { warn() {} };
  assert.ok(createSms({ provider: 'kavenegar', kavenegarApiKey: 'k', kavenegarTemplate: 't' }, { production: true, log }) instanceof KavenegarSms);
  assert.ok(createSms({ provider: 'console' }, { production: false, log }) instanceof ConsoleSms);
  assert.throws(() => createSms({ provider: 'console' }, { production: true, log }));
  assert.throws(() => createSms({ provider: 'other' }, { production: false, log }));
});
