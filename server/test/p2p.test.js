import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { P2P, receiptBody } from '../src/p2p.js';
import { Rial } from '../src/rial.js';
import { Wallets, withTransaction } from '../src/wallets.js';
import { RIAL_SCHEMA, P2P_SCHEMA } from '../src/schema.js';

const image = 'data:image/png;base64,iVBORw0KGgo=';
test('receipt requires a bounded image and bank reference', () => {
  assert.deepEqual(receiptBody({receipt:image,reference:' 123 '}),{receipt:image,reference:'123'});
  for (const body of [{},{receipt:image},{receipt:'data:text/html;base64,AAAA',reference:'1'}, {receipt:image,reference:'a'.repeat(121)}]) {
    assert.throws(()=>receiptBody(body),{code:'invalid_receipt'});
  }
});

test('P2P escrow and reservations against PostgreSQL (PGlite)', async t => {
  const db = new PGlite();
  // One PGlite connection: give each complete transaction exclusive use.
  let tail = Promise.resolve();
  const pool = { query: (sql,args) => db.query(sql,args), async connect() {
    const prior = tail; let release;
    tail = new Promise(resolve => { release=resolve; }); await prior;
    return {query: (sql,args) => db.query(sql,args), release};
  } };
  await db.exec(await readFile(new URL('./p2p-fixture.sql',import.meta.url),'utf8'));
  await db.exec(RIAL_SCHEMA + P2P_SCHEMA);
  await db.exec(await readFile(new URL('./p2p-engine.sql',import.meta.url),'utf8'));
  const query=pool.query;
  pool.query=async(sql,args)=>{
    const result=await query(sql,args);
    if(sql.includes('INSERT INTO public.marketbot_p2p_commands')) await db.query('SELECT public.marketbot_p2p_process_next()');
    return result;
  };
  const wallets=new Wallets(pool), rial=new Rial({pg:pool,wallets}), p2p=new P2P(pool);
  const users=(await db.query("INSERT INTO exchange.users(username,display_name) VALUES ('receiver','r'),('payer','p'),('payer2','p2'),('broke','b') RETURNING id")).rows.map(r=>r.id);
  const [receiver,payer,payer2,broke]=users;
  const actor={actor:'test'};
  await withTransaction(pool,c=>wallets.move(c,'credit',receiver,'IRT','10000000',{referenceType:'test',actor:'test'}));
  const offer = amount => rial.place(receiver,{side:'want',method:'p2p',amount,description:'حساب مقصد برای واریز'},actor);
  const balances = async id => (await db.query('SELECT available::float8,frozen::float8 FROM exchange.wallets WHERE user_id=$1',[id])).rows[0] || {available:0,frozen:0};
  try {
    await t.test('insufficient balance rolls back; funded receive request freezes full amount',async()=>{
      await assert.rejects(rial.place(broke,{side:'want',method:'p2p',amount:'100',description:'مقصد'},actor),{code:'insufficient_balance'});
      const {order}=await offer('5000000');
      assert.equal(order.held,'5000000');
      assert.deepEqual(await balances(receiver),{available:5000000,frozen:5000000});
      assert.equal((await rial.offers({method:'p2p'})).length,0);
      await assert.rejects(rial.take(payer,order.id,{amount:'100'},actor),{code:'reservation_required'});
    });
    let first;
    await t.test('exclusive partial reservation; repeat does not extend deadline; unrelated users cannot see it',async()=>{
      first=(await p2p.reserve(payer,{amount:'1000000'})).payments[0];
      const replay=(await p2p.reserve(payer,{amount:'2000000'})).payments[0];
      assert.equal(replay.id,first.id);
      assert.equal(+new Date(replay.expires_at),+new Date(first.expires_at));
      await assert.rejects(p2p.reserve(payer2,{amount:'1000000'}),{code:'market_short'});
      assert.equal((await p2p.list(payer2)).payments.length,0);
      await assert.rejects(rial.cancel(receiver,first.offer_id,actor),{code:'payment_pending'});
    });
    await t.test('expiry reopens allocation without releasing escrow; late receipt is refused',async()=>{
      await db.query("UPDATE miniapp_p2p_payments SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[first.id]);
      await p2p.maintain();
      await assert.rejects(p2p.receipt(payer,first.id,{receipt:image,reference:'1'}),{code:'reservation_expired'});
      assert.equal((await db.query('SELECT filled_amount::float8 AS filled FROM miniapp_rial_offers WHERE id=$1',[first.offer_id])).rows[0].filled,0);
      assert.deepEqual(await balances(receiver),{available:5000000,frozen:5000000});
    });
    await t.test('receipt does not credit; only receiver can confirm; repeated confirmation credits once',async()=>{
      const p=(await p2p.reserve(payer,{amount:'1000000'})).payments[0];
      await assert.rejects(p2p.receipt(payer2,p.id,{receipt:image,reference:'1'}),{code:'not_found'});
      await p2p.receipt(payer,p.id,{receipt:image,reference:'1'});
      assert.equal((await balances(payer)).available,0);
      await assert.rejects(p2p.confirm(payer,p.id),{code:'not_found'});
      await p2p.confirm(receiver,p.id); await p2p.confirm(receiver,p.id);
      assert.equal((await balances(payer)).available,1000000);
      assert.equal((await balances(receiver)).frozen,4000000);
    });
    await t.test('one amount reserves multiple offers atomically and competing reservations cannot overlap',async()=>{
      await offer('2000000');
      const results=await Promise.allSettled([p2p.reserve(payer,{amount:'6000000'}),p2p.reserve(payer2,{amount:'6000000'})]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      const winner=results.findIndex(r=>r.status==='fulfilled');
      const result=results[winner].value;
      const winningPayer=[payer,payer2][winner];
      assert.equal(result.payments.length,2);
      for (const p of result.payments) await p2p.receipt(winningPayer,p.id,{receipt:image,reference:p.id});
      await db.query("UPDATE miniapp_p2p_payments SET confirmation_due_at=clock_timestamp()-interval '1 second' WHERE status='awaiting_confirmation'");
      await p2p.maintain();
      assert.equal((await db.query("SELECT count(*)::int AS n FROM miniapp_p2p_payments WHERE status='admin_review'")).rows[0].n,2);
      await assert.rejects(p2p.confirm(receiver,result.payments[0].id),{code:'payment_pending'});
      await withTransaction(pool,c=>c.query("SELECT miniapp_p2p_resolve($1,'settled','admin:test','verified bank payment')",[result.payments[0].id]));
      await withTransaction(pool,c=>c.query("SELECT miniapp_p2p_resolve($1,'rejected','admin:test','not received')",[result.payments[1].id]));
      await assert.rejects(withTransaction(pool,c=>c.query("SELECT miniapp_p2p_resolve($1,'settled','admin:test','duplicate')",[result.payments[0].id])));
      assert.equal((await balances(receiver)).frozen,0);
    });
    await t.test('insufficient batch selection rolls back every allocation; cancellation releases only remaining escrow',async()=>{
      const {order}=await offer('300000');
      await assert.rejects(p2p.reserve(payer2,{amount:'400000'}),{code:'market_short'});
      assert.equal((await db.query("SELECT count(*)::int AS n FROM miniapp_p2p_payments WHERE status='reserved'")).rows[0].n,0);
      const p=(await p2p.reserve(payer2,{amount:'100000'})).payments[0];
      await p2p.receipt(payer2,p.id,{receipt:image,reference:'partial'});
      await p2p.confirm(receiver,p.id);
      const before=await balances(receiver);
      await rial.cancel(receiver,order.id,actor);
      assert.deepEqual(await balances(receiver),{available:before.available+200000,frozen:before.frozen-200000});
    });
    await t.test('dispute enters admin queue immediately; a failed settlement rolls back; rejection refunds once',async()=>{
      await offer('100000');
      const p=(await p2p.reserve(payer2,{amount:'100000'})).payments[0];
      await p2p.receipt(payer2,p.id,{receipt:image,reference:'disputed'});
      await p2p.confirm(receiver,p.id,true);
      assert.equal((await db.query('SELECT status FROM miniapp_p2p_payments WHERE id=$1',[p.id])).rows[0].status,'admin_review');
      const before=await balances(receiver);
      await db.query("UPDATE exchange.wallets SET status='closed' WHERE user_id=$1",[payer2]);
      await assert.rejects(withTransaction(pool,c=>c.query("SELECT miniapp_p2p_resolve($1,'settled','admin:test','closed recipient')",[p.id])));
      assert.deepEqual(await balances(receiver),before);
      assert.equal((await db.query('SELECT status FROM miniapp_p2p_payments WHERE id=$1',[p.id])).rows[0].status,'admin_review');
      await db.query("UPDATE exchange.wallets SET status='active' WHERE user_id=$1",[payer2]);
      await withTransaction(pool,c=>c.query("SELECT miniapp_p2p_resolve($1,'rejected','admin:test','not received')",[p.id]));
      assert.deepEqual(await balances(receiver),{available:before.available+100000,frozen:before.frozen-100000});
    });
    await t.test('all wallets match their ledger and total money is conserved',async()=>{
      const rows=(await db.query(`SELECT w.user_id,w.available::text,w.frozen::text,sum(e.available_delta)::text AS ledger_available,sum(e.frozen_delta)::text AS ledger_frozen
        FROM exchange.wallets w JOIN exchange.wallet_entries e ON e.wallet_id=w.id GROUP BY w.user_id,w.available,w.frozen`)).rows;
      for (const r of rows) { assert.equal(Number(r.available),Number(r.ledger_available)); assert.equal(Number(r.frozen),Number(r.ledger_frozen)); }
      assert.equal((await db.query('SELECT sum(available+frozen)::float8 AS total FROM exchange.wallets')).rows[0].total,10000000);
    });
  } finally { await db.close(); }
});
