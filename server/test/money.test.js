import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import { asciiDigits, generateCode } from '../src/otp.js';
import { localMobile } from '../src/sms.js';
import { asciiAmount, marketOrderPrice, priceString } from '../src/trading.js';
import { Withdrawals, normalizeSheba } from '../src/withdrawals.js';

test('Sheba numbers: IR and 24 digits whose mod-97 check holds; Persian digits and spaces are fine', () => {
  assert.equal(normalizeSheba('IR820540102680020817909002'), 'IR820540102680020817909002');
  assert.equal(normalizeSheba('ir82 0540 1026 8002 0817 9090 02'), 'IR820540102680020817909002');
  assert.equal(normalizeSheba('۸۲۰۵۴۰۱۰۲۶۸۰۰۲۰۸۱۷۹۰۹۰۰۲'), 'IR820540102680020817909002');
  assert.equal(normalizeSheba('IR820540102680020817909003'), null, 'a changed digit fails the check');
  assert.equal(normalizeSheba('IR8205401026800208179090'), null, 'too short');
  assert.equal(normalizeSheba('DE89370400440532013000'), null, 'not Iranian');
});

test('a withdrawal request is checked before any code is used', () => {
  const w = new Withdrawals(null, null);
  assert.deepEqual(w.normalize({ asset: 'irt', amount: '500000', destination: 'IR820540102680020817909002' }), {
    asset: 'IRT', amount: '500000', network: null, destination: 'IR820540102680020817909002',
  });
  assert.throws(() => w.normalize({ asset: 'IRT', amount: '10.5', destination: 'IR820540102680020817909002' }), { code: 'invalid_amount' });
  assert.throws(() => w.normalize({ asset: 'IRT', amount: '1000', destination: 'IR00' }), { code: 'invalid_sheba' });
  assert.throws(() => w.normalize({ asset: 'USDT', amount: '10', network: 'SOL', destination: 'T'.repeat(34) }), { code: 'invalid_network' });
  assert.throws(() => w.normalize({ asset: 'USDT', amount: '10', network: 'TRC20', destination: 'short' }), { code: 'invalid_address' });
  assert.throws(() => w.normalize({ asset: 'FOO', amount: '1', network: 'X', destination: 'T'.repeat(34) }), { code: 'unsupported_asset' });
  assert.equal(w.normalize({ asset: 'USDT', amount: '12.5', network: 'trc20', destination: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE' }).network, 'TRC20');
});

test('amounts: Persian digits, the Persian decimal mark and grouping are read; anything else is refused', () => {
  assert.equal(asciiAmount('۱۲٫۵'), '12.5');
  assert.equal(asciiAmount('1,250,000'), '1250000');
  assert.equal(asciiAmount('0'), null);
  assert.equal(asciiAmount('1.123456789'), null, 'more than 8 decimals');
  assert.equal(asciiAmount('-5'), null);
  assert.equal(asciiAmount('1e5'), null);
});

const depth = {
  asks: [
    { price: '100000', quantity: '1' },
    { price: '100500', quantity: '2' },
    { price: '101000', quantity: '5' },
  ],
  bids: [
    { price: '99500', quantity: '1.5' },
    { price: '99000', quantity: '3' },
  ],
};

test('a market order is priced at the deepest level it needs, moved by the slippage margin against the taker', () => {
  // 2.5 reaches the second ask (100500); 0.5% more, rounded up.
  assert.equal(marketOrderPrice(depth, 'buy', '2.5', 50), '101003');
  // Within the best ask alone.
  assert.equal(marketOrderPrice(depth, 'buy', '1', 0), '100000');
  // 2 reaches the second bid (99000); 0.5% less, rounded down.
  assert.equal(marketOrderPrice(depth, 'sell', '2', 50), '98505');
  // More than the book holds.
  assert.equal(marketOrderPrice(depth, 'buy', '9', 50), null);
  assert.equal(marketOrderPrice(depth, 'sell', '5', 50), null);
  assert.equal(marketOrderPrice(null, 'buy', '1', 50), null);
});

test('prices round the safe way for the side, whole Toman above 1000', () => {
  assert.equal(priceString(100502.1, 'up'), '100503');
  assert.equal(priceString(100502.9, 'down'), '100502');
  assert.equal(priceString(12.345678912, 'up'), '12.34567892');
  assert.equal(priceString(0.5, 'down'), '0.5');
  assert.equal(priceString(100000, 'up'), '100000', 'whole prices keep their zeros');
});

test('codes are six digits; Persian digits typed into the field count', () => {
  for (let i = 0; i < 50; i += 1) assert.match(generateCode(), /^\d{6}$/);
  assert.equal(asciiDigits('۱۲۳۴۵۶'), '123456');
  assert.equal(localMobile('+989121234567'), '09121234567');
});

test('money routes need a session that has confirmed its SMS code', async () => {
  const session = { tokenHash: 'h', verified: false, exchangeUserId: null, phone: '+989121234567' };
  const users = {
    configured: true,
    async authenticate(token) {
      return token === 't' ? { user: { id: 1, phone: '+989121234567' }, session } : null;
    },
    async verifySession() {
      session.verified = true;
      session.exchangeUserId = '00000000-0000-4000-8000-000000000001';
    },
  };
  const otp = {
    async send() { return { expires_in: 120, resend_in: 60 }; },
    async verify(_user, _purpose, code) {
      if (code !== '123456') throw Object.assign(new Error('wrong code'), { statusCode: 400, code: 'otp_wrong', extra: { attempts_left: 4 } });
    },
  };
  const wallets = { async balances() { return [{ asset: 'IRT', available: '1000' }]; } };
  const a = await buildApp({ users, otp, wallets, logger: false });
  const auth = { authorization: 'Bearer t' };

  const locked = await a.inject({ url: '/api/v1/wallet', headers: auth });
  assert.equal(locked.statusCode, 403);
  assert.equal(locked.json().code, 'otp_required');

  assert.equal((await a.inject({ method: 'POST', url: '/api/v1/auth/otp/send', headers: auth })).json().expires_in, 120);
  const wrong = await a.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', headers: auth, payload: { code: '000000' } });
  assert.equal(wrong.statusCode, 400);
  assert.deepEqual(wrong.json(), { error: 'wrong code', code: 'otp_wrong', attempts_left: 4 });

  const right = await a.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', headers: auth, payload: { code: '123456' } });
  assert.deepEqual(right.json(), { verified: true });
  const open = await a.inject({ url: '/api/v1/wallet', headers: auth });
  assert.equal(open.statusCode, 200);
  assert.equal(open.json().balances[0].asset, 'IRT');
});
