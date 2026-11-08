// Browser sign-in proves phone ownership before issuing any customer session.
import crypto from 'node:crypto';
import { httpError } from './errors.js';
import { asciiDigits, generateCode } from './otp.js';
import { normalizeIranMobile } from './phone.js';

export class WebAuth {
  constructor(users, otp) {
    this.users = users;
    this.otp = otp;
    this.pg = users.pg;
  }

  async send(rawPhone, ip) {
    const phone = normalizeIranMobile(asciiDigits(rawPhone));
    if (!phone) throw httpError(400, 'phone_not_iranian', 'enter an Iranian mobile number');
    await this.users.ready();
    const client = await this.pg.connect();
    const id = crypto.randomUUID();
    const code = generateCode();
    try {
      await client.query('BEGIN');
      // Serialize both limits across processes, including simultaneous sends.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`web-ip:${ip}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [phone]);
      const { rows } = await client.query(
        `SELECT count(*) FILTER (WHERE phone = $1)::int AS phone_count,
                count(*) FILTER (WHERE ip = $2)::int AS ip_count,
                extract(epoch FROM (now() - max(created_at) FILTER (WHERE phone = $1))) AS elapsed
           FROM miniapp_web_logins WHERE created_at > now() - interval '1 hour' AND (phone = $1 OR ip = $2)`, [phone, ip],
      );
      const usage = rows[0];
      if (usage.elapsed !== null && Number(usage.elapsed) < this.otp.resendSeconds) {
        throw httpError(429, 'otp_too_soon', 'wait before requesting another code', { retry_after: Math.ceil(this.otp.resendSeconds - Number(usage.elapsed)) });
      }
      if (usage.phone_count >= this.otp.maxPerHour || usage.ip_count >= 20) {
        throw httpError(429, 'otp_too_many', 'too many codes', { retry_after: 3600 });
      }
      await client.query('UPDATE miniapp_web_logins SET consumed_at = now() WHERE phone = $1 AND consumed_at IS NULL', [phone]);
      await client.query(
        `INSERT INTO miniapp_web_logins (id, phone, ip, code_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 second'))`,
        [id, phone, ip, this.otp.hash(`web:${id}`, code), this.otp.ttlSeconds],
      );
      await this.otp.sms.sendCode(phone, code);
      await client.query("DELETE FROM miniapp_web_logins WHERE created_at < now() - interval '1 day'");
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
    return { challenge_id: id, expires_in: this.otp.ttlSeconds, resend_in: this.otp.resendSeconds };
  }

  async verify(id, rawCode, meta) {
    const code = asciiDigits(rawCode).replace(/\s/g, '');
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !/^\d{6}$/.test(code)) {
      throw httpError(400, 'otp_invalid', 'invalid challenge or code');
    }
    await this.users.ready();
    const client = await this.pg.connect();
    let phone;
    let failure;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT *, expires_at <= now() AS expired FROM miniapp_web_logins WHERE id = $1 FOR UPDATE', [id]);
      const challenge = rows[0];
      if (!challenge || challenge.consumed_at) failure = 'otp_missing';
      else if (challenge.expired) failure = 'otp_expired';
      else if (challenge.attempts >= this.otp.maxAttempts) failure = 'otp_locked';
      else {
        const expected = Buffer.from(challenge.code_hash, 'hex');
        const given = Buffer.from(this.otp.hash(`web:${id}`, code), 'hex');
        if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
          await client.query('UPDATE miniapp_web_logins SET attempts = attempts + 1 WHERE id = $1', [id]);
          failure = challenge.attempts + 1 >= this.otp.maxAttempts ? 'otp_locked' : 'otp_wrong';
        } else {
          await client.query('UPDATE miniapp_web_logins SET consumed_at = now() WHERE id = $1', [id]);
          phone = challenge.phone;
        }
      }
      // Wrong guesses must commit too, so retries cannot reset the attempt cap.
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
    if (failure) throw httpError(400, failure, 'code could not be verified');
    return this.users.loginWithVerifiedPhone(phone, meta);
  }
}
