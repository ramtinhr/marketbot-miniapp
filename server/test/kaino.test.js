import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import { Kaino, KainoGateway, javaDouble, kainoDate, maskPan, redact, sign, signText, verifyVerdict } from '../src/kaino.js';
import { AUTHORITY_PATTERN, Payments, callbackParams, createGateway } from '../src/payments.js';

const BASE = {
  baseUrl: 'https://kaino.test',
  loginPath: '/rest/accountChannel/wallet/v1/login',
  walletPathPrefix: '/rest/accountChannel/wallet/v1',
  ipgPayPath: '/rest/accountChannel/wallet/v1/chargeWallet/pay',
  username: '2000004855092',
  password: 'pw',
  tenant: 'TENANT001',
  secret: 'secret-key',
};

const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that answers from `routes` (pathname -> handler) and records every call. */
function fakeKaino(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    const call = { path: pathname, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    const handler = routes[pathname.replace(BASE.walletPathPrefix, '')] ?? routes[pathname];
    if (!handler) return json(404, { message: 'no route' });
    return handler(call, calls);
  };
  return { calls, fetchImpl };
}

const loginOk = () => json(200, { token: 'TOKEN-1' });

test('signatures: "#v1#v2#...#" over the listed fields in order, empty ones dropped - the package\'s own vector', () => {
  const params = {
    identifier: 'PAY001', tenant: 'TENANT001', amount: '300000.0', username: '2000004855092',
    localDate: '2026-01-15 10:30:00', callBackUrl: 'https://example.com/callback', stan: '', extra: 'unsigned',
  };
  const keys = ['identifier', 'tenant', 'amount', 'username', 'localDate', 'stan', 'callBackUrl'];
  const text = '#PAY001#TENANT001#300000.0#2000004855092#2026-01-15 10:30:00#https://example.com/callback#';
  assert.equal(signText(params, keys), text);
  assert.equal(sign(params, keys, 'secret-key'), crypto.createHmac('sha256', 'secret-key').update(text).digest('hex'));
  assert.equal(signText({ a: true, b: null, c: undefined, d: 0 }, ['a', 'b', 'c', 'd']), '#true#0#');
});

test('amounts are written as Java\'s Double.toString writes them', () => {
  assert.equal(javaDouble(300000), '300000.0');
  assert.equal(javaDouble(9_999_990), '9999990.0');
  assert.equal(javaDouble(10_000_000), '1.0E7');
  assert.equal(javaDouble(12_345_000), '1.2345E7');
  assert.equal(javaDouble(500_000_000), '5.0E8');
  assert.throws(() => javaDouble(0));
  assert.throws(() => javaDouble(10.5));
});

test('localDate is Tehran\'s wall clock whatever the server\'s zone', () => {
  assert.equal(kainoDate(new Date('2026-01-15T07:00:00Z')), '2026-01-15 10:30:00');
  assert.equal(kainoDate(new Date('2026-06-30T21:00:05Z')), '2026-07-01 00:30:05');
});

test('the configuration is checked at boot: bare https origins, every credential', () => {
  assert.throws(() => new Kaino({ ...BASE, baseUrl: 'https://inopay.done.ir (https://inopay.done.ir/)' }), /KAINO_BASE_URL is not a URL/);
  assert.throws(() => new Kaino({ ...BASE, baseUrl: 'http://inopay.done.ir' }), /must be https/);
  assert.throws(() => new Kaino({ ...BASE, baseUrl: 'https://inopay.done.ir/?x=1' }), /bare origin/);
  assert.throws(() => new Kaino({ ...BASE, secret: '' }), /KAINO_SECRET/);
  assert.throws(() => new Kaino({ ...BASE, loginPath: 'login' }), /KAINO_LOGIN_PATH/);
  assert.throws(() => new Kaino({ ...BASE, timeZone: 'Mars/Olympus' }));
  assert.equal(new Kaino({ ...BASE, baseUrl: 'https://kaino.test/' }).baseUrl, 'https://kaino.test');
  assert.throws(() => createGateway({ provider: 'fake' }, { production: true }), /not allowed/);
  assert.throws(() => createGateway({ provider: 'zarinpal' }, { production: false }), /unknown PAYMENT_PROVIDER/);
});

test('a charge logs in, signs the documented fields and sends the payer to the IPG page', async () => {
  const { calls, fetchImpl } = fakeKaino({
    [BASE.loginPath]: loginOk,
    '/chargeWallet': () => json(200, { ipgReference: 'IPG 42/x' }),
  });
  const gateway = new KainoGateway(new Kaino({ ...BASE, fetchImpl }));
  const { ref, url } = await gateway.request({ authority: 'MB-00112233445566AA', amountToman: 30_000, callbackUrl: 'https://app.test/cb/MB-1' });

  assert.equal(ref, 'IPG 42/x');
  assert.equal(url, 'https://kaino.test/rest/accountChannel/wallet/v1/chargeWallet/pay?reference=IPG%2042%2Fx');
  const [login, charge] = calls;
  assert.deepEqual(login.body, { username: BASE.username, password: 'pw', sign: sign({ username: BASE.username, password: 'pw' }, ['username', 'password'], 'secret-key') });
  assert.equal(login.headers.authorization, undefined);
  assert.equal(charge.headers.authorization, 'TOKEN-1');
  const { sign: signature, ...fields } = charge.body;
  assert.deepEqual(Object.keys(fields).sort(), ['amount', 'callBackUrl', 'currency', 'identifier', 'localDate', 'tenant', 'username']);
  assert.equal(fields.amount, '300000.0', 'Toman to Rial');
  assert.equal(fields.currency, 'IRR');
  assert.match(fields.localDate, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(signature, sign(fields, ['identifier', 'tenant', 'amount', 'username', 'localDate', 'callBackUrl'], 'secret-key'));
});

test('a charge Kaino refuses, or answers without a reference, fails as a gateway error', async () => {
  for (const answer of [json(500, { exception: 'X', customMessage: 'امضا نامعتبر' }), json(200, { success: false }), json(200, {}), json(200, { ipgReference: 'R', link: 'javascript:alert(1)' })]) {
    const { fetchImpl } = fakeKaino({ [BASE.loginPath]: loginOk, '/chargeWallet': () => answer.clone() });
    const gateway = new KainoGateway(new Kaino({ ...BASE, fetchImpl }));
    await assert.rejects(gateway.request({ authority: 'MB-00112233445566AA', amountToman: 10_000, callbackUrl: 'https://a.test' }), { statusCode: 502, code: 'gateway_failed' });
  }
});

test('a refused token logs in again once; concurrent callers share that login', async () => {
  let logins = 0;
  const { calls, fetchImpl } = fakeKaino({
    [BASE.loginPath]: () => json(200, { token: `TOKEN-${++logins}` }),
    '/chargeWallet': (call) => (call.headers.authorization === 'TOKEN-1' ? json(401, {}) : json(200, { ipgReference: 'R' })),
  });
  const gateway = new KainoGateway(new Kaino({ ...BASE, fetchImpl }));
  const args = { authority: 'MB-00112233445566AA', amountToman: 10_000, callbackUrl: 'https://a.test' };
  await gateway.request(args);
  await Promise.all([gateway.request(args), gateway.request(args)]);
  assert.equal(logins, 2);
  assert.equal(calls.filter((c) => c.path === BASE.loginPath).length, 2);
});

test('a bad password is one failed login, not a loop', async () => {
  const { calls, fetchImpl } = fakeKaino({ [BASE.loginPath]: () => json(401, { message: 'bad' }) });
  const gateway = new KainoGateway(new Kaino({ ...BASE, fetchImpl }));
  await assert.rejects(gateway.request({ authority: 'MB-00112233445566AA', amountToman: 10_000, callbackUrl: 'https://a.test' }), { code: 'gateway_unavailable' });
  assert.equal(calls.length, 1);
});

const VERIFY = { authority: 'MB-00112233445566AA', ref: 'IPG-STORED', amountToman: 30_000 };

async function verifyWith(answer, params = {}) {
  const { calls, fetchImpl } = fakeKaino({ [BASE.loginPath]: loginOk, '/chargeWallet/verify': () => answer });
  const gateway = new KainoGateway(new Kaino({ ...BASE, fetchImpl }));
  const outcome = await gateway.verify({ ...VERIFY, params });
  return { outcome, call: calls.find((c) => c.path.endsWith('/verify')) };
}

test('verify asks about the stored charge, never the one the callback names', async () => {
  const { outcome, call } = await verifyWith(json(200, { status: 'SUCCESS', amount: 300000, rrn: '123456789012', maskedPan: '603799******1234' }), {
    reference: 'IPG-SOMEONE-ELSES', identifier: 'MB-FFFFFFFFFFFFFFFF', stan: 'S1',
  });
  assert.deepEqual(outcome, { paid: true, refId: '123456789012', cardPan: '603799******1234', raw: { status: 'SUCCESS', amount: 300000, rrn: '123456789012', maskedPan: '603799******1234' } });
  const { sign: signature, ...fields } = call.body;
  assert.deepEqual(fields, { identifier: VERIFY.authority, tenant: 'TENANT001', amount: '300000.0', reference: 'IPG-STORED', isVerify: true, stan: 'S1' });
  assert.equal(signature, sign(fields, ['identifier', 'tenant', 'amount', 'reference', 'isVerify', 'stan'], 'secret-key'));
});

test('a stan that is not a plain token is left out', async () => {
  const { call } = await verifyWith(json(200, { status: 'SUCCESS' }), { stan: 'a#b' });
  assert.equal(call.body.stan, undefined);
});

test('verify answers: declines fail, anything unclear is left for an operator', async () => {
  const cases = [
    [json(200, { success: false, message: 'not paid' }), (o) => o.paid === false && !o.cancelled],
    [json(200, { result: { status: 'FAILED' } }), (o) => o.paid === false],
    [json(500, { exception: 'PaymentNotFound', customMessage: 'تراکنش یافت نشد' }), (o) => o.paid === false && /تراکنش یافت نشد/.test(o.reason)],
    [json(400, { message: 'bad' }), (o) => o.paid === false],
    [json(200, { status: 'SUCCESS', amount: 3000 }), (o) => o.unclear && /3000 Rial/.test(o.reason)],
    [json(200, { status: 'SUCCESS', identifier: 'MB-OTHER' }), (o) => o.unclear],
    [json(200, { status: 'PENDING' }), (o) => o.unclear],
    [json(200, { status: 7 }), (o) => o.unclear],
    [json(200), (o) => o.unclear],
    [json(200, true), (o) => o.unclear],
    [json(200, { status: 'VERIFIED', cardNumber: '6037991234561234' }), (o) => o.paid && o.cardPan === '603799******1234' && o.refId === 'IPG-STORED'],
  ];
  for (const [answer, ok] of cases) {
    const { outcome } = await verifyWith(answer);
    assert.ok(ok(outcome), JSON.stringify(outcome));
  }
  const { outcome } = await verifyWith(json(500, { exception: 'X' }), { result: 'false' });
  assert.equal(outcome.cancelled, true, 'the payer cancelled on the IPG page');
});

test('verify throws - the payment stays pending - when Kaino could not really answer', async () => {
  for (const answer of [json(502), new Response('<html>bad gateway</html>', { status: 500 }), json(404, {}), json(503, { message: 'down' })]) {
    await assert.rejects(verifyWith(answer), { statusCode: 502 });
  }
  const gateway = new KainoGateway(new Kaino({ ...BASE, fetchImpl: async () => { throw new TypeError('fetch failed'); } }));
  await assert.rejects(gateway.verify({ ...VERIFY, params: {} }), { code: 'gateway_unavailable' });
});

test('helpers: verdicts, masking, redaction, callback params', () => {
  assert.equal(verifyVerdict({ data: { status: 'ok', amount: '300000.0' } }, { identifier: 'X', amountRial: 300000 }).verdict, 'paid');
  assert.equal(maskPan('6037-9912-3456-1234'), '603799******1234');
  assert.equal(maskPan('6037****1234'), '6037****1234');
  assert.equal(maskPan('hello'), null);
  assert.deepEqual(redact({ token: 't', nested: { Password: 'p', sign: 's', ok: 1 } }), { token: '***', nested: { Password: '***', sign: '***', ok: 1 } });
  assert.deepEqual(callbackParams({ a: '1', b: ['x'], c: { d: 1 } }, { e: true, f: 'y'.repeat(600) }), { a: '1', e: 'true' });
  assert.deepEqual(callbackParams(null, 'raw'), {});
});

// ---- Payments.complete against a scripted database ----------------------

/** A pool whose client answers from `state`, recording every statement. */
function fakePool(state) {
  const log = [];
  const client = {
    async query(sql, params = []) {
      log.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (/FOR UPDATE/.test(sql)) return { rows: state.row ? [{ ...state.row }] : [] };
      if (/^SELECT .* FROM miniapp_payments WHERE id/s.test(sql.trim())) return { rows: [{ ...state.row }] };
      if (/^UPDATE miniapp_payments/.test(sql.trim())) {
        if (/status = 'paid'/.test(sql)) state.row.status = 'paid';
        if (/status = 'failed'/.test(sql)) state.row.status = 'failed';
        if (/SET status = \$2/.test(sql)) state.row.status = params[1];
        if (/verified_at = now\(\)/.test(sql)) Object.assign(state.row, { verified_at: new Date(), ref_id: params[1], card_pan: params[2] });
        if (/error = \$2/.test(sql) && !/SET status = \$2/.test(sql)) state.row.error = params[1];
        if (/SET status = \$2/.test(sql)) state.row.error = params[2];
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { __miniappSchema: Promise.resolve(), connect: async () => client, query: client.query };
  return { pool, log };
}

const pendingRow = () => ({ id: 'p1', exchange_user_id: 'u1', amount_toman: '30000', status: 'pending', gateway_ref: 'IPG-1', verified_at: null, ref_id: null, card_pan: null });

test('a verified payment is credited once, under the payment\'s idempotency key', async () => {
  const state = { row: pendingRow() };
  const { pool } = fakePool(state);
  const moves = [];
  const wallets = { move: async (...args) => moves.push(args) };
  const gateway = { name: 'kaino', verify: async (v) => (assert.deepEqual(v, { authority: 'MB-00112233445566AA', ref: 'IPG-1', amountToman: 30000, params: { x: '1' } }), { paid: true, refId: 'R1', cardPan: null, raw: {} }) };
  const p = await new Payments(pool, wallets, gateway, { minToman: 1, maxToman: 1e9 }).complete('MB-00112233445566AA', { x: '1' });
  assert.equal(p.status, 'paid');
  assert.equal(moves.length, 1);
  const [, kind, user, asset, amount, opts] = moves[0];
  assert.deepEqual([kind, user, asset, amount, opts.idempotencyKey], ['credit', 'u1', 'IRT', '30000', 'miniapp-payment:p1']);
});

test('a credit that fails keeps the verification; the next callback credits without asking the gateway again', async () => {
  const state = { row: pendingRow() };
  const { pool, log } = fakePool(state);
  let verifies = 0;
  let fail = true;
  const wallets = { move: async () => { if (fail) throw new Error('exchange tables missing'); } };
  const gateway = { name: 'kaino', verify: async () => (verifies++, { paid: true, refId: 'R1', raw: {} }) };
  const payments = new Payments(pool, wallets, gateway, { minToman: 1, maxToman: 1e9 });

  const first = await payments.complete('MB-00112233445566AA');
  assert.equal(first.status, 'pending');
  assert.ok(state.row.verified_at);
  assert.match(state.row.error, /credit failed/);
  assert.ok(log.includes('ROLLBACK TO SAVEPOINT'));

  fail = false;
  const second = await payments.complete('MB-00112233445566AA');
  assert.equal(second.status, 'paid');
  assert.equal(verifies, 1);
});

test('declined, unclear and unknown payments credit nothing', async () => {
  const run = async (outcome, row = pendingRow()) => {
    const state = { row };
    const { pool } = fakePool(state);
    let moved = false;
    const payments = new Payments(pool, { move: async () => { moved = true; } }, { name: 'kaino', verify: async () => outcome }, { minToman: 1, maxToman: 1e9 });
    const p = await payments.complete('MB-00112233445566AA');
    return { p, moved, row: state.row };
  };
  let r = await run({ paid: false, cancelled: true, reason: 'cancelled' });
  assert.deepEqual([r.p.status, r.moved], ['cancelled', false]);
  r = await run({ paid: false, cancelled: false, reason: 'declined' });
  assert.deepEqual([r.p.status, r.moved], ['failed', false]);
  r = await run({ unclear: true, reason: 'amount differs' });
  assert.deepEqual([r.p.status, r.moved, r.row.error], ['pending', false, 'amount differs']);
  r = await run({ paid: true, refId: 'R' }, { ...pendingRow(), status: 'paid' });
  assert.deepEqual([r.p.status, r.moved], ['paid', false], 'already settled: neither verified nor credited again');
  r = await run({ paid: true, refId: 'R' }, { ...pendingRow(), gateway_ref: null });
  assert.deepEqual([r.p.status, r.moved], ['failed', false], 'never reached the gateway');

  const { pool } = fakePool({ row: null });
  const payments = new Payments(pool, {}, { name: 'kaino', verify: async () => assert.fail('no verify for a malformed id') }, { minToman: 1, maxToman: 1e9 });
  assert.equal(await payments.complete("MB-1' OR 1=1"), null);
  assert.equal(await payments.complete('MB-00112233445566AA'), null);
});

test('authorities are unguessable and match the callback\'s pattern', async () => {
  const inserted = [];
  const pool = {
    __miniappSchema: Promise.resolve(),
    query: async (sql, params) => {
      if (/^INSERT/.test(sql)) inserted.push(params[4]);
      return { rows: [{ id: 'p1' }] };
    },
  };
  const gateway = { name: 'kaino', configured: true, request: async ({ authority, callbackUrl }) => ({ ref: 'R', url: callbackUrl.endsWith(`/api/v1/payments/callback/${authority}`) ? 'https://pay' : 'bad' }) };
  const payments = new Payments(pool, {}, gateway, { publicUrl: 'https://app.test', minToman: 10_000, maxToman: 1_000_000 });
  const started = await payments.start({ id: 1, phone: '+989121234567' }, 'u1', 10_000);
  assert.equal(started.url, 'https://pay');
  assert.match(inserted[0], AUTHORITY_PATTERN);
  await assert.rejects(payments.start({ id: 1 }, 'u1', 9_999), { code: 'amount_out_of_range' });
  for (const odd of ['1e5', '0x2710', [10_000], ' 10000', 10_000.5]) {
    await assert.rejects(payments.start({ id: 1 }, 'u1', odd), { code: 'amount_out_of_range' }, String(odd));
  }
  assert.equal((await payments.start({ id: 1 }, 'u1', '10000')).url, 'https://pay');
});

// ---- The callback route --------------------------------------------------

const users = { configured: true, ready: async () => {}, authenticate: async () => null };

async function appWith(complete) {
  const seen = [];
  const payments = {
    gateway: { name: 'kaino' },
    limits: () => ({}),
    complete: async (authority, params) => (seen.push({ authority, params }), complete(authority, params)),
  };
  const app = await buildApp({ users, payments, logger: false });
  return { app, seen };
}

test('the callback takes GET and form POST, and names the payment by its path', async () => {
  const { app, seen } = await appWith(async () => ({ id: 'p1', status: 'paid', amount_toman: '30000', ref_id: '<b>R1</b>', exchange_user_id: 'u1' }));
  const get = await app.inject({ url: '/api/v1/payments/callback/MB-00112233445566AA?result=true&ipgReference=X' });
  assert.equal(get.statusCode, 200);
  assert.match(get.body, /کیف پول شما شارژ شد/);
  assert.match(get.body, /&#60;b&#62;R1/, 'escaped');
  assert.equal(get.headers['cache-control'], 'no-store');

  const post = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/callback/MB-00112233445566AA',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'result=false&stan=S1',
  });
  assert.equal(post.statusCode, 200);
  assert.deepEqual(seen.map((s) => s.params), [{ result: 'true', ipgReference: 'X' }, { result: 'false', stan: 'S1' }]);
  assert.ok(seen.every((s) => s.authority === 'MB-00112233445566AA'));
  await app.close();
});

test('the callback page says "being checked" when verification could not finish, and "failed" otherwise', async () => {
  let answer = async () => { throw new Error('kaino unreachable'); };
  const { app } = await appWith((...a) => answer(...a));
  const checking = await app.inject({ url: '/api/v1/payments/callback/MB-00112233445566AA' });
  assert.match(checking.body, /در حال بررسی/);
  assert.match(checking.body, /href="\/api\/v1\/payments\/callback\/MB-00112233445566AA"/);

  answer = async () => ({ id: 'p1', status: 'failed' });
  assert.match((await app.inject({ url: '/api/v1/payments/callback/MB-00112233445566AA' })).body, /پرداخت انجام نشد/);
  answer = async () => null;
  assert.match((await app.inject({ url: '/api/v1/payments/callback/nonsense' })).body, /پرداخت انجام نشد/);
  await app.close();
});

test('JSON routes still refuse form bodies', async () => {
  const { app } = await appWith(async () => null);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/telegram', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'init_data=x' });
  assert.equal(res.statusCode, 415);
  await app.close();
});
