// One-time codes sent by SMS to the user's verified phone number: one to open
// a session's access to money (`login`), and a fresh one for each withdrawal
// (`withdraw`).
//
// Only an HMAC of a code is stored, keyed with a per-process secret mixed with
// the bot token, so the table alone cannot be brute-forced offline. Each code
// expires, allows a few attempts, and works once. Sending is throttled per
// user: a cooldown between codes and a cap per hour.

import crypto from 'node:crypto';

import { httpError } from './errors.js';
import { schemaReady } from './schema.js';

export const OTP_PURPOSES = ['login', 'withdraw'];
const CODE_LENGTH = 6;

/** Persian and Arabic-Indic digits as ASCII, as a Persian keyboard types them. */
export function asciiDigits(s) {
  return String(s ?? '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

export function generateCode() {
  return String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

export class OtpService {
  /**
   * @param {import('pg').Pool} pg
   * @param {{ sendCode(phone: string, code: string): Promise<void> }} sms
   * @param {{ secret: string, ttlSeconds?: number, resendSeconds?: number, maxAttempts?: number, maxPerHour?: number }} opts
   */
  constructor(pg, sms, { secret, ttlSeconds = 120, resendSeconds = 60, maxAttempts = 5, maxPerHour = 6 }) {
    this.pg = pg;
    this.sms = sms;
    this.key = crypto.createHash('sha256').update(`miniapp-otp:${secret}`).digest();
    this.ttlSeconds = ttlSeconds;
    this.resendSeconds = resendSeconds;
    this.maxAttempts = maxAttempts;
    this.maxPerHour = maxPerHour;
  }

  hash(otpId, code) {
    return crypto.createHmac('sha256', this.key).update(`${otpId}:${code}`).digest('hex');
  }

  /** Sends a new code; resolves with when it expires and when another may be asked for. */
  async send(user, purpose) {
    if (!OTP_PURPOSES.includes(purpose)) throw httpError(400, 'bad_request', 'unknown code purpose');
    await schemaReady(this.pg);
    const { rows } = await this.pg.query(
      `SELECT count(*)::int AS n, max(created_at) AS last
         FROM miniapp_otps WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
      [user.id],
    );
    const last = rows[0].last ? new Date(rows[0].last).getTime() : 0;
    const wait = Math.ceil((last + this.resendSeconds * 1000 - Date.now()) / 1000);
    if (wait > 0) throw httpError(429, 'otp_too_soon', `wait ${wait}s before asking for another code`, { retry_after: wait });
    if (rows[0].n >= this.maxPerHour) {
      throw httpError(429, 'otp_too_many', 'too many codes this hour', { retry_after: 3600 });
    }

    const code = generateCode();
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      // Asking again replaces the previous code of the same purpose.
      await client.query(
        'UPDATE miniapp_otps SET consumed_at = now() WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL',
        [user.id, purpose],
      );
      const inserted = await client.query(
        `INSERT INTO miniapp_otps (user_id, purpose, phone, code_hash, expires_at)
         VALUES ($1, $2, $3, '', now() + ($4::int * interval '1 second')) RETURNING id`,
        [user.id, purpose, user.phone, this.ttlSeconds],
      );
      const id = inserted.rows[0].id;
      await client.query('UPDATE miniapp_otps SET code_hash = $2 WHERE id = $1', [id, this.hash(id, code)]);
      await this.sms.sendCode(user.phone, code);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return { expires_in: this.ttlSeconds, resend_in: this.resendSeconds };
  }

  /** Consumes the user's current code for `purpose` if `rawCode` matches; throws otherwise. */
  async verify(user, purpose, rawCode) {
    await this.consume(this.pg, await this.check(user, purpose, rawCode));
  }

  /**
   * Marks a checked code used, on `db` (a pool or a client inside a
   * transaction), so a code is only spent if what it confirms goes through.
   */
  async consume(db, otpId) {
    // Conditional, so two requests racing with the same code use it once.
    const used = await db.query('UPDATE miniapp_otps SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL', [otpId]);
    if (!used.rowCount) throw httpError(400, 'otp_missing', 'ask for a code first');
  }

  /**
   * Resolves with the id of the user's current code for `purpose` if `rawCode`
   * matches, without using it up. A wrong code counts against the attempts
   * straight away, outside any caller's transaction.
   */
  async check(user, purpose, rawCode) {
    const code = asciiDigits(rawCode).replace(/\s/g, '');
    if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) throw httpError(400, 'otp_invalid', 'the code is 6 digits');
    await schemaReady(this.pg);
    const { rows } = await this.pg.query(
      `SELECT id, code_hash, attempts, expires_at < now() AS expired, phone
         FROM miniapp_otps WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [user.id, purpose],
    );
    const otp = rows[0];
    if (!otp || otp.phone !== user.phone) throw httpError(400, 'otp_missing', 'ask for a code first');
    if (otp.expired) throw httpError(400, 'otp_expired', 'the code has expired - ask for a new one');
    if (otp.attempts >= this.maxAttempts) throw httpError(429, 'otp_locked', 'too many wrong codes - ask for a new one');

    const expected = Buffer.from(otp.code_hash, 'hex');
    const given = Buffer.from(this.hash(otp.id, code), 'hex');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      const { rows: after } = await this.pg.query(
        'UPDATE miniapp_otps SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
        [otp.id],
      );
      const left = Math.max(0, this.maxAttempts - after[0].attempts);
      throw httpError(400, left ? 'otp_wrong' : 'otp_locked', 'wrong code', { attempts_left: left });
    }
    return otp.id;
  }
}
