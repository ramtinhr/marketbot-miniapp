import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OtpService } from '../src/otp.js';
import { WebAuth } from '../src/web-auth.js';

const id = 'f296ff0b-60b0-492f-9da3-f1d2748b481d';
function fixture(overrides = {}) {
  const otp = new OtpService(null, { async sendCode() {} }, { secret: 'test-only-secret', maxAttempts: 2 });
  const challenge = { phone: '+989121234567', attempts: 0, expired: false, consumed_at: null, code_hash: otp.hash(`web:${id}`, '123456'), ...overrides };
  const calls = [];
  let logins = 0;
  const pg = {
    async connect() { return { query: this.query.bind(this), release() {} }; },
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT *, expires_at')) return { rows: [{ ...challenge }] };
      if (sql.includes('SET attempts = attempts + 1')) challenge.attempts++;
      if (sql.startsWith('UPDATE miniapp_web_logins SET consumed_at')) challenge.consumed_at = new Date();
      return { rows: [], rowCount: 1 };
    },
  };
  const users = { pg, async ready() {}, async loginWithVerifiedPhone(phone) { logins++; return { token: 'session', user: { phone }, verified: true }; } };
  return { auth: new WebAuth(users, otp), challenge, calls, logins: () => logins };
}

test('browser SMS verification issues a verified session once, including Persian digits', async () => {
  const f = fixture();
  assert.equal((await f.auth.verify(id, '۱۲۳۴۵۶', {})).verified, true);
  assert.equal(f.logins(), 1);
  await assert.rejects(f.auth.verify(id, '123456', {}), { code: 'otp_missing' });
  assert.equal(f.logins(), 1);
});

test('wrong guesses commit the attempt count and lock out the correct code at the limit', async () => {
  const f = fixture();
  await assert.rejects(f.auth.verify(id, '000000', {}), { code: 'otp_wrong' });
  assert.equal(f.challenge.attempts, 1);
  assert.equal(f.calls.at(-1), 'COMMIT');
  await assert.rejects(f.auth.verify(id, '000000', {}), { code: 'otp_locked' });
  await assert.rejects(f.auth.verify(id, '123456', {}), { code: 'otp_locked' });
  assert.equal(f.logins(), 0);
});

test('expired and malformed browser challenges never issue sessions', async () => {
  const f = fixture({ expired: true });
  await assert.rejects(f.auth.verify(id, '123456', {}), { code: 'otp_expired' });
  await assert.rejects(f.auth.verify('bad-id', '123456', {}), { code: 'otp_invalid' });
  assert.equal(f.logins(), 0);
});

test('browser sending rejects invalid phones before touching the database', async () => {
  const f = fixture();
  await assert.rejects(f.auth.send('+447700900123', '127.0.0.1'), { code: 'phone_not_iranian' });
  assert.equal(f.calls.length, 0);
});

test('browser SMS sending enforces phone cooldown, phone quota, and IP quota', async () => {
  for (const [usage, expected] of [
    [{ phone_count: 1, ip_count: 1, elapsed: 0 }, 'otp_too_soon'],
    [{ phone_count: 6, ip_count: 6, elapsed: 61 }, 'otp_too_many'],
    [{ phone_count: 0, ip_count: 20, elapsed: null }, 'otp_too_many'],
  ]) {
    const f = fixture();
    const original = f.auth.pg.query;
    f.auth.pg.query = async (sql, args) => sql.includes('phone_count') ? { rows: [usage] } : original(sql, args);
    await assert.rejects(f.auth.send('09121234567', '127.0.0.1'), { code: expected });
    assert.equal(f.calls.at(-1), 'ROLLBACK');
    assert.equal(f.logins(), 0);
  }
});
