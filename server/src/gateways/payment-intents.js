import { httpError } from '../errors.js';

/** Payment Hub adapter. Amounts in the Mini App are Toman; the Hub uses Rial. */
export class PaymentIntentsGateway {
  constructor({ baseUrl, apiKey, method = 'kaino_deposit', fetchImpl = fetch }) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('PAYMENT_API_URL must be an HTTP(S) URL without credentials, query or fragment');
    }
    if (method !== 'kaino_deposit') throw new Error('unsupported payment intent deposit method');
    this.baseUrl = url.href.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.method = method;
    this.fetch = fetchImpl;
    this.name = 'payment_intents';
  }

  get configured() { return Boolean(this.apiKey); }

  async call(path, body) {
    if (!this.configured) throw httpError(503, 'gateway_unavailable', 'PAYMENT_API_KEY is not configured');
    try {
      const response = await this.fetch(`${this.baseUrl}/api/v1/payment-intents${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-api-key': this.apiKey, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid response');
      return data;
    } catch {
      // Never expose the API key, customer data, or upstream response body.
      throw httpError(502, 'gateway_unavailable', 'payment service request failed');
    }
  }

  async request({ authority, amountToman, callbackUrl }) {
    const intent = await this.call('', {
      method: this.method,
      amount: (BigInt(amountToman) * 10n).toString(),
      idempotencyKey: authority,
      successUrl: callbackUrl,
      cancelUrl: callbackUrl,
    });
    let url;
    try { url = new URL(intent.paymentUrl); } catch { /* rejected below */ }
    if (typeof intent.id !== 'string' || !intent.id || !url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw httpError(502, 'gateway_unavailable', 'payment service returned no valid checkout URL or intent id');
    }
    return { ref: intent.id, url: url.href };
  }

  async verify({ ref, amountToman }) {
    await this.call(`/${encodeURIComponent(ref)}/confirm`, {});
    const intent = await this.call(`/${encodeURIComponent(ref)}`);
    // Only retain reconciliation fields, never arbitrary upstream/customer data.
    const raw = { id: intent.id, status: intent.status, amount: intent.amount, currency: intent.currency, method: intent.method };
    if (intent.id !== ref || intent.currency !== 'IRR' || intent.method !== this.method ||
        typeof intent.amount !== 'string' || !/^\d+(?:\.0+)?$/.test(intent.amount) ||
        BigInt(intent.amount.split('.')[0]) !== BigInt(amountToman) * 10n) {
      return { unclear: true, reason: 'payment intent does not match the stored charge', raw };
    }
    // No callback query parameter can establish payment success.
    // Confirm first, then read the authoritative intent. HTTP success alone is insufficient.
    if (['succeeded', 'paid'].includes(intent.status)) {
      return { paid: true, refId: ref, cardPan: null, raw };
    }
    if (intent.status === 'failed' || intent.status === 'cancelled') {
      return { paid: false, cancelled: intent.status === 'cancelled', reason: `payment intent ${intent.status}`, raw };
    }
    return { unclear: true, reason: `payment intent status: ${String(intent.status)}`, raw };
  }
}
