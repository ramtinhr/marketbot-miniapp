// Shared data contract with marketbot-api/src/lib/bankAccounts.js.
// Both apps deploy independently and use the same PostgreSQL table.
import { randomUUID } from 'node:crypto';

const error = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id, label, holder_name, iban, created_at';
export function normalizeIban(raw) {
  const value = String(raw ?? '').replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660)).replace(/[\s-]/g, '').toUpperCase();
  const iban = /^\d{24}$/.test(value) ? `IR${value}` : value;
  if (!/^IR\d{24}$/.test(iban) || BigInt(`${iban.slice(4)}1827${iban.slice(2, 4)}`) % 97n !== 1n) return null;
  return iban;
}
export function normalizeBankAccount(body) {
  const iban = normalizeIban(body?.iban);
  if (!iban) throw error(400, 'invalid_sheba', 'invalid Iranian IBAN');
  const label = typeof body?.label === 'string' ? body.label.trim() : '';
  const holder_name = typeof body?.holder_name === 'string' ? body.holder_name.trim() : '';
  if (!label || label.length > 80 || !holder_name || holder_name.length > 120) {
    throw error(400, 'invalid_bank_account', 'label and holder_name are required (80 and 120 characters maximum)');
  }
  return { iban, label, holder_name };
}
export class BankAccounts {
  constructor(pg) { this.pg = pg; }
  async ready() {
    if (!this.preparing) this.preparing = this.pg.query(`
      CREATE TABLE IF NOT EXISTS public.marketbot_bank_accounts (
        id UUID PRIMARY KEY, exchange_user_id UUID NOT NULL,
        label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
        holder_name TEXT NOT NULL CHECK (length(holder_name) BETWEEN 1 AND 120),
        iban TEXT NOT NULL CHECK (iban ~ '^IR[0-9]{24}$'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), archived_at TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX IF NOT EXISTS marketbot_bank_accounts_active_iban
        ON public.marketbot_bank_accounts(exchange_user_id, iban) WHERE archived_at IS NULL;
    `).catch(err => { this.preparing = null; throw err; });
    await this.preparing;
  }
  validateUser(userId) {
    if (!UUID.test(String(userId))) throw error(400, 'bad_request', 'invalid exchange user id');
  }
  async list(userId) {
    this.validateUser(userId); await this.ready();
    const { rows } = await this.pg.query(`SELECT ${COLUMNS} FROM public.marketbot_bank_accounts WHERE exchange_user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC, id`, [userId]);
    return rows;
  }
  async get(userId, id) {
    this.validateUser(userId);
    if (!UUID.test(String(id))) throw error(404, 'bank_account_not_found', 'bank account not found');
    await this.ready();
    const { rows } = await this.pg.query(`SELECT ${COLUMNS} FROM public.marketbot_bank_accounts WHERE id = $1 AND exchange_user_id = $2 AND archived_at IS NULL`, [id, userId]);
    if (!rows.length) throw error(404, 'bank_account_not_found', 'bank account not found');
    return rows[0];
  }
  async add(userId, body) {
    this.validateUser(userId); const account = normalizeBankAccount(body); await this.ready();
    try {
      const { rows } = await this.pg.query(`INSERT INTO public.marketbot_bank_accounts (id, exchange_user_id, label, holder_name, iban) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
        [randomUUID(), userId, account.label, account.holder_name, account.iban]);
      return rows[0];
    } catch (err) {
      if (err.code === '23505') throw error(409, 'bank_account_exists', 'this IBAN is already saved');
      throw err;
    }
  }
  async remove(userId, id) {
    this.validateUser(userId);
    if (!UUID.test(String(id))) throw error(404, 'bank_account_not_found', 'bank account not found');
    await this.ready();
    const result = await this.pg.query('UPDATE public.marketbot_bank_accounts SET archived_at = now() WHERE id = $1 AND exchange_user_id = $2 AND archived_at IS NULL', [id, userId]);
    if (!result.rowCount) throw error(404, 'bank_account_not_found', 'bank account not found');
  }
}
