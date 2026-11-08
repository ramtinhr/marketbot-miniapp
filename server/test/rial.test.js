import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Rial } from '../src/rial.js';

const rial = new Rial({});
const base = { side: 'want', method: 'wallet', amount: '100000' };

test('a rial offer needs have|want, a known method, and a whole Toman amount', () => {
  assert.deepEqual(rial.normalize(base), {
    side: 'want', method: 'wallet', amount: '100000', description: '', destination: null,
  });
  assert.equal(rial.normalize({ ...base, amount: '۱٬۰۰۰٬۰۰۰' }).amount, '1000000');
  assert.throws(() => rial.normalize({ ...base, side: 'buy' }), { code: 'invalid_order' });
  assert.throws(() => rial.normalize({ ...base, method: 'cash' }), { code: 'invalid_method' });
  assert.throws(() => rial.normalize({ ...base, amount: '10.5' }), { code: 'invalid_amount' });
  assert.throws(() => rial.normalize({ ...base, amount: '0' }), { code: 'invalid_amount' });
});

test('bank "want" offers require a valid Sheba; wallet and p2p do not', () => {
  assert.throws(() => rial.normalize({ ...base, method: 'paya' }), { code: 'invalid_sheba' });
  assert.throws(() => rial.normalize({ ...base, method: 'satna', destination: 'IR00' }), { code: 'invalid_sheba' });
  const sheba = 'IR820540102680020817909002';
  assert.equal(rial.normalize({ ...base, method: 'paya', destination: sheba }).destination, sheba);
  assert.equal(rial.normalize({ ...base, method: 'satna', destination: sheba.toLowerCase() }).destination, sheba);
  assert.equal(rial.normalize({ side: 'have', method: 'paya', amount: '50000' }).destination, null);
  assert.equal(rial.normalize({ ...base, method: 'p2p', description: 'حساب مقصد' }).destination, null);
});

test('an offer\'s description is optional, kept on one line, and at most 120 characters', () => {
  assert.equal(rial.normalize({ ...base, description: '  فقط\nفوری \t ' }).description, 'فقط فوری');
  assert.equal(rial.normalize({ ...base, description: 'ا'.repeat(120) }).description.length, 120);
  assert.throws(() => rial.normalize({ ...base, description: 'ا'.repeat(121) }), { code: 'invalid_description' });
  assert.throws(() => rial.normalize({ ...base, description: 5 }), { code: 'invalid_description' });
});

test('P2P only allows funded receive requests with payment instructions', () => {
  assert.throws(() => rial.normalize({ ...base, method: 'p2p' }), { code: 'invalid_description' });
  assert.throws(() => rial.normalize({ ...base, method: 'p2p', description: '  ' }), { code: 'invalid_description' });
  assert.throws(() => rial.normalize({ ...base, method: 'p2p', side: 'have', description: 'test' }), { code: 'invalid_description' });
});
