// Kaino (inopay.done.ir) wallet API: the three calls a wallet charge needs.
//
//   login               -> a token, sent as the Authorization header from then on
//   POST /chargeWallet  -> an IPG reference; the payer opens the IPG pay page with it
//   POST /chargeWallet/verify -> settles the payment after the payer comes back
//
// Every request body is signed: HMAC-SHA256(KAINO_SECRET, "#v1#v2#...#") over
// the documented fields in the documented order, empty ones dropped. Amounts
// are Rial, written the way Java's Double.toString writes them, because Kaino
// rebuilds the signed text from the number it parsed.

import crypto from 'node:crypto';

import { httpError } from './errors.js';

/** "#v1#v2#...#" over `keys` in order; null, undefined and "" are left out. */
export function signText(params, keys) {
  const parts = keys.map((k) => params[k]).filter((v) => v !== null && v !== undefined && v !== '');
  return `#${parts.join('#')}#`;
}

export function sign(params, keys, secret) {
  return crypto.createHmac('sha256', secret).update(signText(params, keys)).digest('hex');
}

/** Java's Double.toString of a whole number: "300000.0", and "1.0E7" from ten million up. */
export function javaDouble(n) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`not a positive whole amount: ${n}`);
  if (n < 1e7) return `${n}.0`;
  const s = String(n);
  const digits = s.replace(/0+$/, '');
  return `${digits[0]}.${digits.slice(1) || '0'}E${s.length - 1}`;
}

/** Kaino's localDate, yyyy-MM-dd HH:mm:ss, on the wall clock of `timeZone`. */
export function kainoDate(date = new Date(), timeZone = 'Asia/Tehran') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const SECRET_KEYS = new Set(['password', 'token', 'accesstoken', 'authorization', 'sign', 'secret']);

/** A copy for logs and the database, without credentials. */
export function redact(value, depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.has(k.toLowerCase()) ? '***' : redact(v, depth + 1)]),
    );
  }
  return value;
}

/** The objects a Kaino answer may keep its fields in: itself, or wrapped in result/data/value. */
function layers(body) {
  if (!body || typeof body !== 'object') return [];
  return [body, body.result, body.data, body.value].filter((x) => x && typeof x === 'object' && !Array.isArray(x));
}

/** The first field among `keys` holding a non-empty string or number, in any layer. */
export function pick(body, keys) {
  for (const layer of layers(body)) {
    for (const k of keys) {
      const v = layer[k];
      if ((typeof v === 'string' && v.trim()) || (typeof v === 'number' && Number.isFinite(v))) return String(v).trim();
    }
  }
  return null;
}

/** A card number only ever masked: one Kaino sends in full keeps its first six and last four digits. */
export function maskPan(pan) {
  if (!pan) return null;
  const s = String(pan).replace(/[\s-]/g, '');
  if (/^\d{16,19}$/.test(s)) return `${s.slice(0, 6)}${'*'.repeat(s.length - 10)}${s.slice(-4)}`;
  return /\*/.test(s) && s.length <= 32 ? s : null;
}

function httpsUrl(raw, name, { allowHttp }) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL: "${raw}"`);
  }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new Error(`${name} must be https: "${raw}"`);
  if (u.search || u.hash || u.username || u.password) throw new Error(`${name} must be a bare origin, without a query or credentials: "${raw}"`);
  return u.origin;
}

function path(raw, name) {
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(raw ?? '')) throw new Error(`${name} must be a path starting with "/": "${raw}"`);
  return raw.replace(/\/+$/, '');
}

export class Kaino {
  /**
   * @param {{ baseUrl: string, loginBaseUrl?: string, loginPath: string, walletPathPrefix: string, ipgPayPath: string,
   *           username: string, password: string, tenant: string, secret: string, timeZone?: string,
   *           allowHttp?: boolean, timeoutMs?: number, fetchImpl?: typeof fetch, log?: object }} opts
   */
  constructor({
    baseUrl, loginBaseUrl, loginPath, walletPathPrefix, ipgPayPath, username, password, tenant, secret,
    timeZone = 'Asia/Tehran', allowHttp = false, timeoutMs = 20_000, fetchImpl = fetch, log,
  }) {
    const missing = Object.entries({ KAINO_USERNAME: username, KAINO_PASSWORD: password, KAINO_TENANT: tenant, KAINO_SECRET: secret })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) throw new Error(`set ${missing.join(', ')} for PAYMENT_PROVIDER=kaino`);
    this.baseUrl = httpsUrl(baseUrl, 'KAINO_BASE_URL', { allowHttp });
    this.loginBaseUrl = httpsUrl(loginBaseUrl || baseUrl, 'KAINO_LOGIN_BASE_URL', { allowHttp });
    this.loginPath = path(loginPath, 'KAINO_LOGIN_PATH');
    this.walletPathPrefix = path(walletPathPrefix, 'KAINO_WALLET_PATH_PREFIX');
    this.ipgPayPath = path(ipgPayPath, 'KAINO_IPG_PAY_PATH');
    kainoDate(new Date(), timeZone); // throws on an unknown zone, at boot rather than at the first payment
    this.timeZone = timeZone;
    this.username = username;
    this.tenant = tenant;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.log = log;
    // Kept off `this`, so they never end up in a log line that prints the client.
    this.#password = password;
    this.#secret = secret;
  }

  #password;
  #secret;
  #token = null;
  #loggingIn = null;

  /** The IPG page the payer is sent to for a charge's reference. */
  payUrl(ipgReference) {
    return `${this.baseUrl}${this.ipgPayPath}?reference=${encodeURIComponent(ipgReference)}`;
  }

  #sign(params, keys) {
    return sign(params, keys, this.#secret);
  }

  /** One HTTP call. Network failures and timeouts throw; any HTTP answer resolves. */
  async #call(url, body, token) {
    const label = new URL(url).pathname;
    const started = Date.now();
    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(token && { authorization: token }) },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.log?.warn({ kaino: label, ms: Date.now() - started, err: err.message }, 'kaino unreachable');
      throw httpError(502, 'gateway_unavailable', `kaino ${label} unreachable: ${err.message}`);
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON - a proxy's error page, say; kept as text for the error.
    }
    this.log?.info({ kaino: label, status: res.status, ms: Date.now() - started }, 'kaino call');
    return { status: res.status, json, text };
  }

  async login(staleToken = null) {
    // Concurrent requests that all saw the old token share one login.
    if (this.#loggingIn) return this.#loggingIn;
    if (staleToken && this.#token && this.#token !== staleToken) return this.#token;
    this.#loggingIn = (async () => {
      const params = { username: this.username, password: this.#password };
      const { status, json } = await this.#call(`${this.loginBaseUrl}${this.loginPath}`, {
        ...params,
        sign: this.#sign(params, ['username', 'password']),
      });
      const token = json?.token ?? json?.accessToken ?? json?.data?.token ?? json?.value?.token;
      if (status < 200 || status >= 300 || typeof token !== 'string' || !token) {
        this.log?.error({ kaino: 'login', status, body: redact(json) }, 'kaino login failed');
        throw httpError(502, 'gateway_unavailable', `kaino login failed (HTTP ${status})`);
      }
      this.#token = token;
      return token;
    })();
    try {
      return await this.#loggingIn;
    } finally {
      this.#loggingIn = null;
    }
  }

  /**
   * A signed, authenticated call to a wallet endpoint. Logs in first if need
   * be, and once more if the token was refused. A non-2xx answer throws an
   * error carrying `kaino: { status, body }`.
   */
  async #wallet(endpoint, body) {
    const url = `${this.baseUrl}${this.walletPathPrefix}${endpoint}`;
    let token = this.#token ?? (await this.login());
    let res = await this.#call(url, body, token);
    if (res.status === 401) {
      token = await this.login(token);
      res = await this.#call(url, body, token);
    }
    if (res.status >= 200 && res.status < 300) return res.json;
    const reason = res.json?.customMessage || res.json?.message || res.text.slice(0, 200) || 'no body';
    this.log?.warn({ kaino: endpoint, status: res.status, body: redact(res.json) ?? res.text.slice(0, 500) }, 'kaino refused');
    const err = httpError(502, 'gateway_failed', `kaino ${endpoint} answered ${res.status}: ${reason}`);
    err.kaino = { status: res.status, body: res.json };
    throw err;
  }

  /** Opens an IPG charge of `amountRial` into the merchant wallet. */
  chargeWallet({ identifier, amountRial, callBackUrl }) {
    const params = {
      identifier,
      tenant: this.tenant,
      amount: javaDouble(amountRial),
      username: this.username,
      localDate: kainoDate(new Date(), this.timeZone),
      callBackUrl,
    };
    const signature = this.#sign(params, ['identifier', 'tenant', 'amount', 'username', 'localDate', 'callBackUrl']);
    return this.#wallet('/chargeWallet', { ...params, currency: 'IRR', sign: signature });
  }

  /** Settles a charge the payer paid. Unverified IPG payments are refunded by the bank. */
  verifyCharge({ identifier, amountRial, reference, stan }) {
    const params = {
      identifier,
      tenant: this.tenant,
      amount: javaDouble(amountRial),
      reference,
      isVerify: true,
      stan: stan || undefined,
    };
    const signature = this.#sign(params, ['identifier', 'tenant', 'amount', 'reference', 'isVerify', 'stan']);
    return this.#wallet('/chargeWallet/verify', { ...params, sign: signature });
  }
}

const FAILED_STATES = new Set(['FAILED', 'FAILURE', 'FAIL', 'ERROR', 'REJECTED', 'CANCELED', 'CANCELLED', 'REVERSED', 'EXPIRED', 'NOK', 'UNSUCCESSFUL']);
const PAID_STATES = new Set(['SUCCESS', 'SUCCEEDED', 'SUCCESSFUL', 'VERIFIED', 'DONE', 'PAID', 'OK', 'COMPLETED', 'APPROVED']);

/**
 * Reads a 2xx verify answer: `paid`, `failed`, or `unclear` - an answer that
 * does not plainly say either, or that names another amount or charge, which
 * is left for an operator instead of being credited or written off.
 */
export function verifyVerdict(body, { identifier, amountRial }) {
  const all = layers(body);
  if (!all.length) return { verdict: 'unclear', reason: 'kaino answered verify without a JSON object' };
  for (const l of all) {
    if (l.success === false || l.isSuccess === false || l.result === false || l.result === 'false' || l.error || l.exception) {
      return { verdict: 'failed', reason: `kaino declined the payment: ${l.customMessage || l.message || l.error || l.exception || 'success=false'}` };
    }
  }
  const state = pick(body, ['status', 'statusType', 'state']);
  if (state && /^-?\d+$/.test(state)) {
    if (!['0', '200', '201'].includes(state)) return { verdict: 'unclear', reason: `kaino reports status ${state}` };
  } else if (state) {
    const s = state.toUpperCase();
    if (FAILED_STATES.has(s)) return { verdict: 'failed', reason: `kaino reports the payment ${state}` };
    if (!PAID_STATES.has(s)) return { verdict: 'unclear', reason: `kaino reports an unknown state "${state}"` };
  }
  const amount = pick(body, ['amount']);
  if (amount !== null && Number(amount) !== amountRial) {
    return { verdict: 'unclear', reason: `kaino verified ${amount} Rial, not the ${amountRial} charged` };
  }
  const id = pick(body, ['identifier']);
  if (id !== null && id !== identifier) return { verdict: 'unclear', reason: `kaino verified charge ${id}, not ${identifier}` };
  return { verdict: 'paid' };
}

/**
 * Whether a verify call that failed was Kaino turning the payment down, rather
 * than a failure on the way (network, a proxy, our own credentials), after
 * which the payment stays pending and a repeat of the callback asks again.
 */
export function isDeclined(err) {
  const status = err?.kaino?.status;
  if (!status) return false;
  if (status >= 400 && status < 500) return ![401, 403, 404, 408, 429].includes(status);
  // Kaino answers its own errors with HTTP 500 and a JSON body; a 500 without one, or a 502-504, came from in between.
  return status === 500 && Boolean(err.kaino.body) && typeof err.kaino.body === 'object';
}

const SAFE_STAN = /^[A-Za-z0-9_-]{1,64}$/;

/** Kaino as a gateway for Payments. Amounts arrive in Toman and go to Kaino in Rial. */
export class KainoGateway {
  /** @param {Kaino} kaino */
  constructor(kaino) {
    this.name = 'kaino';
    this.kaino = kaino;
  }

  get configured() {
    return true;
  }

  async request({ authority, amountToman, callbackUrl }) {
    const res = await this.kaino.chargeWallet({ identifier: authority, amountRial: amountToman * 10, callBackUrl: callbackUrl });
    if (verifyVerdict(res, { identifier: authority, amountRial: amountToman * 10 }).verdict === 'failed') {
      throw httpError(502, 'gateway_failed', `kaino refused the charge: ${JSON.stringify(redact(res))}`);
    }
    const ref = pick(res, ['ipgReference', 'reference']);
    if (!ref || ref.length > 128) {
      throw httpError(502, 'gateway_failed', `kaino returned no usable ipgReference: ${JSON.stringify(redact(res))}`);
    }
    const link = pick(res, ['link', 'payUrl', 'paymentUrl']);
    let url = this.kaino.payUrl(ref);
    if (link) {
      let u;
      try {
        u = new URL(link);
      } catch {
        throw httpError(502, 'gateway_failed', `kaino returned a pay link that is not a URL: ${link}`);
      }
      if (u.protocol !== 'https:') throw httpError(502, 'gateway_failed', `kaino returned a pay link that is not https: ${link}`);
      url = u.href;
    }
    return { ref, url };
  }

  /**
   * Resolves with { paid: true, refId, cardPan }, { paid: false, cancelled, reason },
   * or { unclear: true, reason }; throws when Kaino could not be asked, so the
   * payment stays pending. `params` is the callback's query and body:
   * attacker-controlled, so it is only read for the optional stan and for
   * telling a cancel from a failure - what is verified is the stored charge.
   */
  async verify({ authority, ref, amountToman, params }) {
    const amountRial = amountToman * 10;
    const stan = typeof params.stan === 'string' && SAFE_STAN.test(params.stan) ? params.stan : undefined;
    const cancelled = params.result === 'false' || params.result === false;
    let res;
    try {
      res = await this.kaino.verifyCharge({ identifier: authority, amountRial, reference: ref, stan });
    } catch (err) {
      if (!isDeclined(err)) throw err;
      return { paid: false, cancelled, reason: err.message, raw: redact(err.kaino.body) };
    }
    const raw = redact(res);
    const { verdict, reason } = verifyVerdict(res, { identifier: authority, amountRial });
    if (verdict === 'failed') return { paid: false, cancelled, reason, raw };
    if (verdict === 'unclear') return { unclear: true, reason, raw };
    return {
      paid: true,
      refId: pick(res, ['rrn', 'RRN', 'referenceNumber', 'retrievalReferenceNumber', 'traceNumber', 'trackingCode']) ?? ref,
      cardPan: maskPan(pick(res, ['maskedPan', 'cardPan', 'cardNumber', 'pan'])),
      raw,
    };
  }
}
