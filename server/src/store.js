// The app's users and their sessions, in the bot's Postgres under miniapp_*.
//
// Telegram vouches for both halves of a sign-in: the launch parameters say
// which account opened the app, and the contact shared through
// `WebApp.requestContact()` says which phone number that account has. Only
// Iranian mobile numbers are let in. A session is a random 256-bit bearer
// token; only its SHA-256 is stored, so a leaked table signs nobody in.

import crypto from 'node:crypto';

import { httpError } from './errors.js';
import { normalizeIranMobile } from './phone.js';
import { verifySigned } from './telegram.js';

// Written only after this long without one, so a polling page costs a read
// per request rather than a write.
const TOUCH_EVERY_MS = 60_000;

const sha256 = (token) => crypto.createHash('sha256').update(token).digest('hex');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS miniapp_users (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL UNIQUE,
  phone         TEXT UNIQUE,
  first_name    TEXT,
  last_name     TEXT,
  username      TEXT,
  language_code TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_at    TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS miniapp_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES miniapp_users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS miniapp_sessions_user_idx ON miniapp_sessions (user_id);
`;

const USER_COLUMNS = 'id, telegram_id, phone, first_name, last_name, username, created_at, blocked_at';

/** What the app is shown about its user. */
export function publicUser(row) {
  return {
    id: row.id,
    telegram_id: row.telegram_id,
    phone: row.phone,
    first_name: row.first_name,
    last_name: row.last_name,
    username: row.username,
    created_at: row.created_at,
  };
}

export class UserStore {
  /**
   * @param {import('pg').Pool} pg
   * @param {{ botToken?: string, initDataMaxAgeSeconds?: number, contactMaxAgeSeconds?: number, ttlHours?: number, idleMinutes?: number }} [opts]
   */
  constructor(pg, { botToken = '', initDataMaxAgeSeconds = 86_400, contactMaxAgeSeconds = 600, ttlHours = 720, idleMinutes = 10_080 } = {}) {
    this.pg = pg;
    this.botToken = botToken;
    this.initDataMaxAgeSeconds = initDataMaxAgeSeconds;
    this.contactMaxAgeSeconds = contactMaxAgeSeconds;
    this.ttlMs = ttlHours * 3600_000;
    this.idleMs = idleMinutes * 60_000;
    this.readyPromise = null;
  }

  get configured() {
    return Boolean(this.botToken);
  }

  /** Creates the tables once; a failure is retried on the next call. */
  ready() {
    if (!this.readyPromise) {
      this.readyPromise = this.pg.query(SCHEMA).catch((err) => {
        this.readyPromise = null;
        throw err;
      });
    }
    return this.readyPromise;
  }

  /** The Telegram account that opened the app, from its launch parameters. */
  telegramUser(initData) {
    const { user } = verifySigned(initData, this.botToken, { maxAgeSeconds: this.initDataMaxAgeSeconds });
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
      throw httpError(400, 'bad_request', 'the launch parameters carry no user');
    }
    return user;
  }

  /**
   * Opening the app: a session for an account that has shared its number
   * before, or null while it still has to.
   */
  async loginExisting(initData, meta) {
    const tg = this.telegramUser(initData);
    await this.ready();
    const { rows } = await this.pg.query(`SELECT ${USER_COLUMNS} FROM miniapp_users WHERE telegram_id = $1`, [tg.id]);
    if (!rows.length || !rows[0].phone) return null;
    return this.startSession(rows[0], tg, meta);
  }

  /** Sharing the phone number: creates the user, or updates its number, and signs it in. */
  async loginWithContact(initData, contactData, meta) {
    const tg = this.telegramUser(initData);
    const { contact } = verifySigned(contactData, this.botToken, { maxAgeSeconds: this.contactMaxAgeSeconds });
    if (!contact || Number(contact.user_id) !== tg.id) {
      throw httpError(400, 'contact_mismatch', 'the shared contact is not the account that opened the app');
    }
    const phone = normalizeIranMobile(contact.phone_number);
    if (!phone) throw httpError(400, 'phone_not_iranian', 'only Iranian mobile numbers (+98 9xx) can sign in');

    await this.ready();
    const client = await this.pg.connect();
    let row;
    try {
      await client.query('BEGIN');
      // A number belongs to whoever Telegram says holds it now. An account that
      // had it before keeps its row, loses the number and its sessions, and is
      // asked to share a number on its next visit.
      const taken = await client.query('SELECT id FROM miniapp_users WHERE phone = $1 AND telegram_id <> $2 FOR UPDATE', [phone, tg.id]);
      if (taken.rows.length) {
        await client.query('UPDATE miniapp_users SET phone = NULL WHERE id = $1', [taken.rows[0].id]);
        await client.query('DELETE FROM miniapp_sessions WHERE user_id = $1', [taken.rows[0].id]);
      }
      const res = await client.query(
        `INSERT INTO miniapp_users (telegram_id, phone) VALUES ($1, $2)
         ON CONFLICT (telegram_id) DO UPDATE SET phone = EXCLUDED.phone
         RETURNING ${USER_COLUMNS}`,
        [tg.id, phone],
      );
      row = res.rows[0];
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return this.startSession(row, tg, meta);
  }

  async startSession(row, tg, { ip = null, userAgent = null } = {}) {
    if (row.blocked_at) throw httpError(403, 'blocked', 'this account is blocked');
    const token = crypto.randomBytes(32).toString('base64url');
    await this.pg.query(
      `INSERT INTO miniapp_sessions (token_hash, user_id, expires_at, ip, user_agent)
       VALUES ($1, $2, now() + ($3::float8 * interval '1 millisecond'), $4, $5)`,
      [sha256(token), row.id, this.ttlMs, ip, userAgent ? String(userAgent).slice(0, 300) : null],
    );
    // Names and usernames change on Telegram; keep the latest.
    const { rows } = await this.pg.query(
      `UPDATE miniapp_users SET first_name = $2, last_name = $3, username = $4, language_code = $5, last_login_at = now()
        WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [row.id, tg.first_name ?? null, tg.last_name ?? null, tg.username ?? null, tg.language_code ?? null],
    );
    // Expired rows are only ever read past; clear them while here.
    await this.pg.query(
      `DELETE FROM miniapp_sessions WHERE expires_at < now() OR last_seen_at < now() - ($1::float8 * interval '1 millisecond')`,
      [this.idleMs],
    );
    return { token, user: publicUser(rows[0]) };
  }

  /** The signed-in user for a bearer token, or null. */
  async authenticate(token) {
    if (!token) return null;
    await this.ready();
    const hash = sha256(token);
    const { rows } = await this.pg.query(
      `SELECT u.id, u.telegram_id, u.phone, u.first_name, u.last_name, u.username, u.created_at, s.last_seen_at
         FROM miniapp_sessions s JOIN miniapp_users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND u.blocked_at IS NULL AND u.phone IS NOT NULL AND s.expires_at > now()
          AND s.last_seen_at > now() - ($2::float8 * interval '1 millisecond')`,
      [hash, this.idleMs],
    );
    if (!rows.length) return null;
    const row = rows[0];
    if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_EVERY_MS) {
      await this.pg.query('UPDATE miniapp_sessions SET last_seen_at = now() WHERE token_hash = $1', [hash]);
    }
    return publicUser(row);
  }

  async logout(token) {
    if (!token) return;
    await this.ready();
    await this.pg.query('DELETE FROM miniapp_sessions WHERE token_hash = $1', [sha256(token)]);
  }
}
