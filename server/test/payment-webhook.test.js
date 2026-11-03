import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { Payments } from '../src/payments.js';

const users = { configured: true };

test('webhook requires its own secret and reconciles the stored intent without a user session', async (t) => {
  let checks = 0;
  let refreshes = 0;
  const app = await buildApp({ users, logger: false, paymentWebhookSecret: 'secret',
    payments: { gateway: { name: 'payment_intents' }, notifyIntent: async (id) => {
      checks++;
      assert.equal(id, 'intent-1');
      return { status: 'paid', exchange_user_id: 'user-1' };
    } },
    hub: { refreshBalances: (id) => { assert.equal(id, 'user-1'); refreshes++; } },
  });
  t.after(() => app.close());
  for (const secret of [undefined, 'wrong']) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/payments/webhook', headers: secret ? { 'x-payment-webhook-secret': secret } : {}, payload: { paymentIntentId: 'intent-1', status: 'paid' } });
    assert.equal(res.statusCode, 401);
  }
  assert.equal(checks, 0);
  const res = await app.inject({ method: 'POST', url: '/api/v1/payments/webhook', headers: { 'x-payment-webhook-secret': 'secret' }, payload: { paymentIntentId: 'intent-1', status: 'paid' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'paid' });
  assert.equal(checks, 1);
  assert.equal(refreshes, 1);
});

test('unconfigured webhook is disabled; pending confirmation requests sender retry', async (t) => {
  for (const configured of [false, true]) {
    const app = await buildApp({ users, logger: false, paymentWebhookSecret: configured ? 'secret' : '',
      payments: { gateway: { name: 'payment_intents' }, notifyIntent: async () => ({ status: 'pending' }) },
    });
    t.after(() => app.close());
    const res = await app.inject({ method: 'POST', url: '/api/v1/payments/webhook', headers: { 'x-payment-webhook-secret': 'secret' }, payload: { paymentIntentId: 'intent-1' } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, configured ? 'payment_pending' : 'not_configured');
  }
});

test('webhook resolves only stored Payment Hub intent references and rejects unknown ids', async () => {
  const payments = new Payments({ __miniappSchema: Promise.resolve(), query: async (sql, params) => {
    assert.match(sql, /provider = 'payment_intents'/);
    assert.deepEqual(params, ['intent-1']);
    return { rows: [] };
  } }, {}, {}, { minToman: 1, maxToman: 1e9 });
  await assert.rejects(payments.notifyIntent(undefined), { statusCode: 400 });
  await assert.rejects(payments.notifyIntent('intent-1'), { statusCode: 404 });
});
