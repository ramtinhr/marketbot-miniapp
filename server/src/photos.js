// Users' Telegram profile photos, fetched by the bot through the Bot API and
// served from this app's own origin. The photo_url in the launch parameters is
// often missing, and where present it points at t.me, which the Mini App's
// webview cannot always reach (Telegram's in-app proxy does not cover it).
//
// Telegram may be unreachable from the server too, so, like the bot's alerts,
// calls can go through the HTTP relay in TELEGRAM_PROXY_URL: POST /request with
// {method, url}, answered with the upstream response as is.

const API = 'https://api.telegram.org';

/** The smallest size at least this wide: the avatar is shown at 64px, at up to 3x. */
const WANT_PX = 160;

export class TelegramPhotos {
  /**
   * @param {{ botToken: string, proxyUrl?: string, proxyKey?: string, ttlMs?: number, maxEntries?: number, timeoutMs?: number, log?: object }} opts
   */
  constructor({ botToken, proxyUrl = '', proxyKey = '', ttlMs = 6 * 3600_000, maxEntries = 500, timeoutMs = 10_000, log }) {
    this.botToken = botToken;
    this.proxyUrl = proxyUrl.replace(/\/+$/, '');
    this.proxyKey = proxyKey;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.timeoutMs = timeoutMs;
    this.log = log;
    /** telegram id -> { at, photo: {type, data} | null, pending? } */
    this.cache = new Map();
  }

  get configured() {
    return Boolean(this.botToken);
  }

  async #get(url) {
    const signal = AbortSignal.timeout(this.timeoutMs);
    if (!this.proxyUrl) return fetch(url, { signal });
    const headers = { 'content-type': 'application/json' };
    if (this.proxyKey) headers['x-api-key'] = this.proxyKey;
    return fetch(`${this.proxyUrl}/request`, { method: 'POST', headers, body: JSON.stringify({ method: 'GET', url }), signal });
  }

  async #call(method, params) {
    const res = await this.#get(`${API}/bot${this.botToken}/${method}?${new URLSearchParams(params)}`);
    const body = await res.json().catch(() => null);
    if (!body?.ok) throw new Error(`telegram ${method}: ${body?.description || `HTTP ${res.status}`}`);
    return body.result;
  }

  async #fetch(telegramId) {
    const { photos } = await this.#call('getUserProfilePhotos', { user_id: String(telegramId), limit: '1' });
    const sizes = photos?.[0];
    if (!sizes?.length) return null;
    const size = sizes.find((s) => s.width >= WANT_PX) ?? sizes[sizes.length - 1];
    const file = await this.#call('getFile', { file_id: size.file_id });
    if (!file.file_path) return null;
    const res = await this.#get(`${API}/file/bot${this.botToken}/${file.file_path}`);
    if (!res.ok) throw new Error(`telegram file: HTTP ${res.status}`);
    const type = res.headers.get('content-type');
    return { type: type?.startsWith('image/') ? type : 'image/jpeg', data: Buffer.from(await res.arrayBuffer()) };
  }

  /**
   * The user's current profile photo, or null if they have none or hide it.
   * Cached, including "none"; concurrent requests share one fetch. Throws when
   * Telegram cannot be reached, and that is not cached.
   */
  async photo(telegramId) {
    const hit = this.cache.get(telegramId);
    if (hit?.pending) return hit.pending;
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.photo;

    const pending = this.#fetch(telegramId);
    this.cache.set(telegramId, { pending });
    try {
      const photo = await pending;
      this.cache.delete(telegramId);
      this.cache.set(telegramId, { at: Date.now(), photo });
      while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
      return photo;
    } catch (err) {
      this.cache.delete(telegramId);
      this.log?.warn({ err: { message: err.message.replace(this.botToken, '<token>') } }, 'could not fetch a profile photo');
      throw err;
    }
  }
}
