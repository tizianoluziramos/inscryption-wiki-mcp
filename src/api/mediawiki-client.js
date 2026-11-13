const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class MediaWikiError extends Error {
  constructor(message, { status = null, code = null, cause = undefined } = {}) {
    super(message, { cause });
    this.name = 'MediaWikiError';
    this.status = status;
    this.code = code;
  }
}

function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

export class MediaWikiClient {
  #queue = Promise.resolve();
  #lastRequestAt = 0;

  constructor({
    apiUrl,
    userAgent,
    minDelayMs = 1000,
    timeoutMs = 20000,
    maxRetries = 3,
    fetchImpl = globalThis.fetch,
    wait = sleep,
    clock = () => Date.now(),
  }) {
    const url = new URL(apiUrl);
    if (url.protocol !== 'https:') throw new Error('MediaWiki API requires HTTPS');
    this.apiUrl = url.href;
    this.userAgent = userAgent;
    this.minDelayMs = minDelayMs;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.fetchImpl = fetchImpl;
    this.wait = wait;
    this.clock = clock;
  }

  async request(parameters) {
    const action = parameters.action ?? 'query';
    const url = new URL(this.apiUrl);
    const query = { ...parameters, action, format: 'json', formatversion: '2' };
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    // Only one caller at a time: avoids server overload and makes Retry-After effective.
    const job = this.#queue.then(() => this.#perform(url));
    this.#queue = job.catch(() => {});
    return job;
  }

  async #perform(url) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const remaining = this.minDelayMs - (this.clock() - this.#lastRequestAt);
      if (remaining > 0) await this.wait(remaining);
      this.#lastRequestAt = this.clock();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'User-Agent': this.userAgent,
          },
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (cause) {
        if (attempt < this.maxRetries) {
          await this.wait(Math.min(30000, 1000 * 2 ** attempt));
          continue;
        }
        throw new MediaWikiError('Could not reach MediaWiki API', { cause });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        if (RETRYABLE_STATUSES.has(response.status) && attempt < this.maxRetries) {
          const requested = retryAfterMs(response.headers.get('retry-after'));
          await this.wait(Math.min(120000, requested ?? 1000 * 2 ** attempt));
          continue;
        }
        const message = response.status === 403 || response.status === 401
          ? 'Access denied by Fandom; the server will not bypass access restrictions'
          : `MediaWiki API returned HTTP ${response.status}`;
        throw new MediaWikiError(message, { status: response.status });
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('json')) {
        throw new MediaWikiError('The wiki returned non-JSON data (possibly a bot challenge)');
      }
      let data;
      try {
        data = await response.json();
      } catch (cause) {
        throw new MediaWikiError('Invalid JSON returned by MediaWiki API', { cause });
      }
      if (!data || typeof data !== 'object') {
        throw new MediaWikiError('Unexpected MediaWiki API response');
      }
      if (data.error) {
        const code = String(data.error.code ?? 'unknown');
        if ((code === 'maxlag' || code === 'ratelimited') && attempt < this.maxRetries) {
          const delay = Number(data.error.lag);
          await this.wait(Math.min(120000, Number.isFinite(delay) && delay > 0 ? delay * 1000 : 1000 * 2 ** attempt));
          continue;
        }
        throw new MediaWikiError(`MediaWiki API ${code}: ${data.error.info ?? 'Unknown API error'}`, { code });
      }
      return data;
    }
    throw new MediaWikiError('MediaWiki retry limit reached');
  }
}
