// Sending one-time codes by SMS.
//
// Kavenegar's verify/lookup sends a pre-approved template, which Iranian
// operators deliver on the fast lane reserved for codes; plain sends to a
// number on the operators' block list never arrive. The console provider only
// writes the code to the log, for development.

import { httpError } from './errors.js';

/** +989121234567 -> 09121234567, as Kavenegar takes a receptor. */
export function localMobile(e164) {
  return e164.startsWith('+98') ? `0${e164.slice(3)}` : e164;
}

export class KavenegarSms {
  constructor({ apiKey, template, fetchImpl = fetch }) {
    this.apiKey = apiKey;
    this.template = template;
    this.fetch = fetchImpl;
  }

  get configured() {
    return Boolean(this.apiKey && this.template);
  }

  async sendCode(phone, code) {
    if (!this.configured) throw httpError(503, 'sms_unavailable', 'KAVENEGAR_API_KEY and KAVENEGAR_OTP_TEMPLATE are not set');
    const url = new URL(`https://api.kavenegar.com/v1/${encodeURIComponent(this.apiKey)}/verify/lookup.json`);
    url.search = new URLSearchParams({ receptor: localMobile(phone), token: code, template: this.template }).toString();
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw httpError(502, 'sms_failed', `kavenegar unreachable: ${err.message}`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.return?.status !== 200) {
      throw httpError(502, 'sms_failed', `kavenegar refused the message: ${body?.return?.message ?? res.status}`);
    }
  }
}

export class ConsoleSms {
  constructor({ log }) {
    this.log = log;
  }

  get configured() {
    return true;
  }

  async sendCode(phone, code) {
    this.log.warn({ phone, code }, 'SMS_PROVIDER=console: one-time code (not sent)');
  }
}

export function createSms({ provider, kavenegarApiKey, kavenegarTemplate }, { production, log }) {
  if (provider === 'console') {
    if (production) throw new Error('SMS_PROVIDER=console is not allowed with NODE_ENV=production');
    return new ConsoleSms({ log });
  }
  if (provider === 'kavenegar') return new KavenegarSms({ apiKey: kavenegarApiKey, template: kavenegarTemplate });
  throw new Error(`unknown SMS_PROVIDER "${provider}" - use kavenegar or console`);
}
