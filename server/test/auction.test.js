import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decimal, fillOrder, matchAuction, units } from '../src/auction.js';

const order = (id, userId, side, price, quantity, filled = '0') => {
  const o = { id, userId, side, price: units(price), quantity: units(quantity), filled: units(filled), filledQuote: 0n, status: 'open' };
  o.held = side === 'buy' ? (o.price * (o.quantity - o.filled)) / 10n ** 18n : o.quantity - o.filled;
  return o;
};

test('amounts convert to integers of 10^-18 and back exactly', () => {
  assert.equal(units('102350'), 102350n * 10n ** 18n);
  assert.equal(decimal(units('0.00000001')), '0.00000001');
  assert.equal(decimal(units('102350.500000000000000000')), '102350.5');
  assert.equal(decimal(units('12')), '12');
  assert.equal(decimal(-units('1.25')), '-1.25');
});

test('a buy fills against the cheapest sells first, at their prices, up to its limit', () => {
  const taker = order('t', 'me', 'buy', '102000', '15');
  const makers = [
    order('a', 'u1', 'sell', '101500', '5'),
    order('b', 'u2', 'sell', '101800', '4', '1'),
    order('c', 'u3', 'sell', '102500', '100'),
  ];
  const { fills, remaining } = matchAuction(taker, makers);
  assert.deepEqual(fills.map((f) => [f.maker.id, decimal(f.quantity), decimal(f.price)]), [
    ['a', '5', '101500'],
    ['b', '3', '101800'],
  ]);
  assert.equal(decimal(remaining), '7', 'the ask above the limit is not touched');
});

test('a sell fills against the highest buys first and never against its own orders', () => {
  const taker = order('t', 'me', 'sell', '100', '10');
  const makers = [order('mine', 'me', 'buy', '120', '10'), order('a', 'u1', 'buy', '110', '4'), order('b', 'u2', 'buy', '99', '10')];
  const { fills, remaining } = matchAuction(taker, makers);
  assert.deepEqual(fills.map((f) => f.maker.id), ['a']);
  assert.equal(decimal(remaining), '6');
});

test('a buy filled below its limit releases exactly what its limit held for that part', () => {
  let buy = order('t', 'me', 'buy', '102000', '2');
  assert.equal(decimal(buy.held), '204000');
  buy = fillOrder(buy, units('0.5'), units('101000'));
  assert.equal(buy.status, 'partial');
  assert.equal(decimal(buy.filledQuote), '50500');
  assert.equal(decimal(buy.held), '153000', 'the hold drops by 0.5 x 102000; the 500 difference is released to the buyer');
  buy = fillOrder(buy, units('1.5'), units('102000'));
  assert.equal(buy.status, 'filled');
  assert.equal(buy.held, 0n, 'a filled buy holds nothing, to the last unit');
});

test('a sell holds the coin and releases it as it fills', () => {
  let sell = order('t', 'me', 'sell', '0.00001234', '1000.12345678');
  sell = fillOrder(sell, units('0.12345678'), units('0.00001234'));
  assert.equal(decimal(sell.held), '1000');
  assert.equal(decimal(sell.filledQuote), '0.0000015234566652');
});
