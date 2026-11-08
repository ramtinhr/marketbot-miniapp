import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAmount, groupTyped } from '../../web/src/format.ts';
import { asciiAmount } from '../src/trading.js';
test('miniapp number validation preserves grouped decimals and rejects malformed amounts',()=>{
  for(const raw of ['۱٬۲۳۴٫۵۶','1,234.56']){assert.equal(parseAmount(raw),'1234.56');assert.equal(asciiAmount(raw),'1234.56');}
  for(const raw of ['1/2','-5','1e5','1,2','1 2','1.2.3','12abc']){assert.equal(parseAmount(raw),null,raw);assert.equal(asciiAmount(raw),null,raw);}
  assert.equal(parseAmount('1.5',0),null);
});
test('formatting never silently changes invalid amounts or truncates precision',()=>{
  assert.equal(groupTyped('۱۲۳۴۵۶۷٫۰۰۱۰',8),'1,234,567.0010');
  assert.equal(groupTyped('1.5',0),'1.5');
  assert.equal(groupTyped('1.123456789',8),'1.123456789');
  for(const raw of ['-5','1e5','1/2','1.2.3','12abc'])assert.equal(groupTyped(raw,8),raw);
});
