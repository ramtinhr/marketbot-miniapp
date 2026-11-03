import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaymentIntentsGateway } from '../src/gateways/payment-intents.js';
import { createGateway } from '../src/payments.js';

const config = { baseUrl: 'http://payments.test', apiKey: 'test-secret' };
const charge = { authority: 'MB-00112233445566AA', amountToman: 10000, callbackUrl: 'https://app.test/callback' };
const intent = { id: 'intent-1', paymentUrl: 'https://bank.test/pay', amount: '100000', currency: 'IRR', method: 'kaino_deposit', status: 'requires_action' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('factory selects Payment Hub without requiring direct Kaino credentials', () => {
  assert.equal(createGateway({ provider: 'payment_intents', paymentIntents: config }, { production: true }).name, 'payment_intents');
  assert.throws(() => createGateway({ provider: '__proto__' }), /unknown PAYMENT_PROVIDER/);
  assert.throws(() => new PaymentIntentsGateway({ ...config, baseUrl: 'file:///tmp/key' }), /HTTP/);
});

test('checkout sends Rial, stable idempotency key, return URLs and server API key; omits unrelated fields', async () => {
  const gateway = new PaymentIntentsGateway({ ...config, fetchImpl: async (url, options) => {
    assert.equal(url, 'http://payments.test/api/v1/payment-intents');
    assert.equal(options.headers['x-api-key'], config.apiKey);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), {
      method: 'kaino_deposit', amount: '100000', idempotencyKey: charge.authority,
      successUrl: charge.callbackUrl, cancelUrl: charge.callbackUrl,
    });
    return json(intent, 201);
  } });
  assert.deepEqual(await gateway.request(charge), { ref: 'intent-1', url: 'https://bank.test/pay' });
});

test('missing credentials, upstream errors and malformed checkout responses fail without disclosing secrets', async () => {
  const missing = new PaymentIntentsGateway({ ...config, apiKey: '' });
  await assert.rejects(missing.request(charge), { code: 'gateway_unavailable' });
  for (const result of [() => json({ message: config.apiKey }, 401), () => json({}), () => json({ ...intent, paymentUrl: 'javascript:alert(1)' }), () => { throw new Error(config.apiKey); }]) {
    const gateway = new PaymentIntentsGateway({ ...config, fetchImpl: async () => result() });
    await assert.rejects(gateway.request(charge), (err) => err.code === 'gateway_unavailable' && !err.message.includes(config.apiKey));
  }
});

test('HTTP 200 and browser success parameters never prove an unpaid intent was paid', async () => {
  const gateway = new PaymentIntentsGateway({ ...config, fetchImpl: async () => json(intent) });
  const result = await gateway.verify({ ref: intent.id, amountToman: 10000, params: { Status: 'OK', status: '200' } });
  assert.equal(result.unclear, true);
  assert.notEqual(result.paid, true);
});

test('mismatched identity, method, currency or amount stays pending; no unrelated upstream data retained', async () => {
  for (const changed of [{ id: 'other' }, { method: 'kaino_payout' }, { currency: 'IRT' }, { amount: '10000' }, { amount: '100000.1' }, { amount: null }]) {
    const gateway = new PaymentIntentsGateway({ ...config, fetchImpl: async () => json({ ...intent, ...changed, secret: 'private' }) });
    const outcome = await gateway.verify({ ref: intent.id, amountToman: 10000 });
    assert.equal(outcome.unclear, true);
    assert.equal(outcome.raw.secret, undefined);
  }
});

test('service-declared failures and cancellations are terminal without a wallet credit', async () => {
  for (const status of ['failed', 'cancelled']) {
    const gateway = new PaymentIntentsGateway({ ...config, fetchImpl: async () => json({ ...intent, status }) });
    const outcome = await gateway.verify({ ref: intent.id, amountToman: 10000 });
    assert.equal(outcome.paid, false);
    assert.equal(outcome.cancelled, status === 'cancelled');
  }
});

test('verification confirms remotely then accepts a matching paid intent', async () => {
  const calls = [];
  const gateway = new PaymentIntentsGateway({ ...config, fetchImpl: async (url, options) => {
    calls.push([url, options.method]);
    return json(options.method === 'POST' ? {} : { ...intent, status: 'succeeded' });
  } });
  const outcome = await gateway.verify({ ref: intent.id, amountToman: 10000 });
  assert.equal(outcome.paid, true);
  assert.equal(outcome.refId, intent.id);
  assert.deepEqual(calls, [
    ['http://payments.test/api/v1/payment-intents/intent-1/confirm', 'POST'],
    ['http://payments.test/api/v1/payment-intents/intent-1', 'GET'],
  ]);
});

test('HTTP success from confirm does not credit an unknown or pending payment status', async () => {
  for (const status of ['requires_action', 'pending', 'processing', 200, 'unknown']) {
    const gateway = new PaymentIntentsGateway({ ...config, fetchImpl: async () => json({ ...intent, status }) });
    assert.equal((await gateway.verify({ ref: intent.id, amountToman: 10000 })).unclear, true);
  }
});
