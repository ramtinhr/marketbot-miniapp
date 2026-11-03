import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeBankAccount, normalizeIban } from '../src/bank-accounts.js';
import { buildApp } from '../src/app.js';
import { Withdrawals } from '../src/withdrawals.js';

const iban = 'IR820540102680020817909002';
const userId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000099';
const account = { id: accountId, label: 'اصلی', holder_name: 'کاربر آزمایشی', iban };

test('bank accounts normalize Persian Sheba numbers and validate holder/label and checksum', () => {
  assert.equal(normalizeIban('۸۲۰۵۴۰۱۰۲۶۸۰۰۲۰۸۱۷۹۰۹۰۰۲'), iban);
  assert.equal(normalizeIban('IR820540102680020817909003'), null);
  assert.deepEqual(normalizeBankAccount({ ...account, label: ' اصلی ' }), { iban, label: 'اصلی', holder_name: account.holder_name });
  assert.throws(() => normalizeBankAccount({ ...account, holder_name: '' }), { code: 'invalid_bank_account' });
});

test('bank APIs use verified session identity; saved withdrawals override client destination and holder before OTP', async t => {
  let requests = 0;
  const users = { configured: true, authenticate: async token => token ? { user: { id: 1 }, session: { verified: token === 'verified', exchangeUserId: userId } } : null };
  const banks = {
    list: async id => { assert.equal(id, userId); return [account]; },
    add: async (id, body) => { assert.equal(id, userId); assert.equal(body.label, 'اصلی'); return account; },
    remove: async (id, aid) => { assert.equal(id, userId); assert.equal(aid, accountId); },
    get: async (id, aid) => { assert.equal(id, userId); assert.equal(aid, accountId); return account; },
  };
  const withdrawals = new Withdrawals(null, null);
  withdrawals.request = async (_user, id, body) => {
    assert.equal(id, userId); requests++;
    assert.equal(body.destination, iban); assert.equal(body.beneficiary_name, account.holder_name);
    assert.equal(body.bank_account_id, accountId); return { id: 'w1', ...body };
  };
  const app = await buildApp({ users, bankAccounts: banks, withdrawals,
    otp: { check: async () => 1, consume: async () => {} }, logger: false });
  t.after(() => app.close());
  assert.equal((await app.inject('/api/v1/bank-accounts')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/v1/bank-accounts', headers: { authorization: 'Bearer unverified' } })).statusCode, 403);
  const headers = { authorization: 'Bearer verified' };
  assert.equal((await app.inject({ url: '/api/v1/bank-accounts', headers })).json().accounts[0].id, accountId);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bank-accounts', headers, payload: account })).statusCode, 201);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/bank-accounts/${accountId}`, headers })).statusCode, 204);
  const result = await app.inject({ method: 'POST', url: '/api/v1/wallet/withdrawals', headers, payload: {
    asset: 'IRT', amount: '10000', recipient_type: 'saved', bank_account_id: accountId, destination: 'forged', beneficiary_name: 'forged', code: '123456',
  } });
  assert.equal(result.statusCode, 200, result.body); assert.equal(requests, 1);
});

test('third-party withdrawals accept a valid Sheba with a beneficiary and reject missing names', () => {
  const withdrawals = new Withdrawals(null, null);
  const input = { asset: 'IRT', amount: '10000', destination: iban, recipient_type: 'other', beneficiary_name: 'شخص دیگر' };
  assert.equal(withdrawals.normalize(input).beneficiary_name, 'شخص دیگر');
  assert.equal(withdrawals.normalize(input).bank_account_id, null);
  assert.throws(() => withdrawals.normalize({ ...input, beneficiary_name: '' }), { code: 'invalid_beneficiary' });
});
