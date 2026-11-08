import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';

test('P2P routes require verified identity and accept a receipt larger than the default JSON limit',async()=>{
  const session={verified:false,exchangeUserId:'trusted-user'};
  let called;
  const users={configured:true,async authenticate(token){return token==='t'?{user:{id:1},session}:null;}};
  const p2p={async receipt(...args){called=args;return {ok:true};},async reserve(...args){called=args;return {payments:[]};},async list(){return {payments:[]};},async confirm(){return {ok:true};}};
  const app=await buildApp({users,p2p,logger:false});
  try {
    assert.equal((await app.inject('/api/v1/p2p/payments')).statusCode,401);
    const headers={authorization:'Bearer t'};
    assert.equal((await app.inject({url:'/api/v1/p2p/payments',headers})).statusCode,403);
    session.verified=true;
    const image='data:image/png;base64,'+'A'.repeat(100000);
    const res=await app.inject({method:'POST',url:'/api/v1/p2p/payments/id/receipt',headers,payload:{receipt:image,reference:'123',userId:'untrusted'}});
    assert.equal(res.statusCode,200);
    assert.equal(called[0],'trusted-user');
    assert.equal(called[2].receipt.length,image.length);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/p2p/payments/id/receipt',headers,payload:{receipt:'A'.repeat(800000)}})).statusCode,413);
  } finally {await app.close();}
});
