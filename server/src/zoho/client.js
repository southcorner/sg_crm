'use strict';

/**
 * Zoho Books HTTP client (India DC).
 *
 *   base            https://www.zohoapis.in/books/v3
 *   auth            Authorization: Zoho-oauthtoken <access token>
 *   org             organization_id appended to every request as a query param
 *   rate limit      token bucket, 80 requests / minute
 *   retries         429 + 5xx, exponential backoff, max 3 retries
 *   daily budget    persisted counter `zoho_api_calls_YYYY-MM-DD` in settings,
 *                   budget from setting `zoho_daily_call_budget` (default 2000).
 *                   Hitting it throws BudgetExceededError so sync halts cleanly.
 *
 * Everything the client touches from the outside world (fetch, clock, sleep,
 * token provider, call counter) is injectable so the sync logic can be tested
 * without network or database.
 */

const BASE_URL = 'https://www.zohoapis.in/books/v3';

class ZohoApiError extends Error {
  constructor(message, { status, code, path, body } = {}) {
    super(message);
    this.name = 'ZohoApiError';
    this.status = status;
    this.code = code;
    this.path = path;
    this.body = body;
  }
}

class BudgetExceededError extends Error {
  constructor(used, budget) {
    super(`Zoho daily API budget exhausted (${used}/${budget} calls today). Sync halted.`);
    this.name = 'BudgetExceededError';
    this.used = used;
    this.budget = budget;
  }
}

class ZohoAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZohoAuthError';
  }
}

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Classic token bucket. `capacity` tokens, refilled at capacity/windowMs.
 * take() resolves as soon as a token is available.
 */
class TokenBucket {
  constructor({ capacity = 80, windowMs = 60_000, now = () => Date.now(), sleep = sleepReal } = {}) {
    this.capacity = capacity;
    this.windowMs = windowMs;
    this.now = now;
    this.sleep = sleep;
    this.tokens = capacity;
    this.lastRefill = now();
  }

  _refill() {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed <= 0) return;
    const gained = (elapsed / this.windowMs) * this.capacity;
    if (gained >= 1) {
      this.tokens = Math.min(this.capacity, this.tokens + gained);
      this.lastRefill = t;
    }
  }

  async take() {
    // bounded loop: each pass either consumes a token or waits for one to refill
    for (;;) {
      this._refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const perToken = this.windowMs / this.capacity;
      await this.sleep(Math.max(25, Math.ceil(perToken)));
    }
  }
}

/** Default call counter — persists in the settings table, one key per day. */
function settingsCallCounter() {
  const config = require('../config');
  return {
    key(date = new Date()) {
      return `zoho_api_calls_${date.toISOString().slice(0, 10)}`;
    },
    used(date) {
      return Number(config.getSetting(this.key(date), 0)) || 0;
    },
    increment(date) {
      const key = this.key(date);
      const next = (Number(config.getSetting(key, 0)) || 0) + 1;
      config.setSetting(key, next);
      return next;
    },
    budget() {
      return Number(config.getSetting('zoho_daily_call_budget', 2000)) || 2000;
    },
  };
}

/** In-memory counter — used by tests and by callers that opt out of persistence. */
function memoryCallCounter(budget = 2000) {
  const counts = new Map();
  return {
    key(date = new Date()) {
      return `zoho_api_calls_${date.toISOString().slice(0, 10)}`;
    },
    used(date) {
      return counts.get(this.key(date)) || 0;
    },
    increment(date) {
      const key = this.key(date);
      const next = (counts.get(key) || 0) + 1;
      counts.set(key, next);
      return next;
    },
    budget() {
      return budget;
    },
  };
}

class ZohoClient {
  /**
   * @param {object} opts
   * @param {function} opts.getToken      async ({force}) => access token string
   * @param {function} opts.getOrgId      () => organization id (string) or null
   * @param {function} [opts.fetchImpl]   fetch-compatible function
   * @param {object}   [opts.counter]     daily call counter (see above)
   * @param {number}   [opts.maxRetries]  retries after the first attempt (default 3)
   */
  constructor({
    getToken,
    getOrgId,
    fetchImpl,
    counter,
    baseUrl = BASE_URL,
    maxRetries = 3,
    rateLimit = { capacity: 80, windowMs: 60_000 },
    sleep = sleepReal,
    now = () => Date.now(),
    logger,
  } = {}) {
    this.getToken = getToken;
    this.getOrgId = getOrgId;
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.counter = counter || settingsCallCounter();
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.maxRetries = maxRetries;
    this.sleep = sleep;
    this.now = now;
    this.logger = logger || require('../logger');
    this.bucket = new TokenBucket({ ...rateLimit, sleep, now });
  }

  budgetStatus() {
    const used = this.counter.used();
    const budget = this.counter.budget();
    return { used, budget, remaining: Math.max(0, budget - used) };
  }

  /** Throws BudgetExceededError if today's budget is already spent. */
  assertBudget() {
    const { used, budget } = this.budgetStatus();
    if (used >= budget) throw new BudgetExceededError(used, budget);
  }

  buildUrl(path, query = {}) {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    const orgId = this.getOrgId ? this.getOrgId() : null;
    if (orgId) url.searchParams.set('organization_id', String(orgId));
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  backoffMs(attempt, retryAfterHeader) {
    if (retryAfterHeader) {
      const secs = Number(retryAfterHeader);
      if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 60_000);
    }
    return Math.min(500 * 2 ** attempt, 30_000);
  }

  /**
   * One API call, with budget check, rate limiting, 401-refresh and retries.
   * Returns the parsed JSON body — or, with `responseType: 'binary'`, a
   * `{buffer, contentType}` pair (item images are the only such endpoint).
   *
   * Binary responses take a separate read path because the JSON one consumes
   * the body as text, which would corrupt a JPEG. Everything else — budget,
   * rate limit, 401 refresh, retry/backoff — is shared, so an image fetch is
   * counted and throttled exactly like any other call. An error status still
   * decodes as text so Zoho's JSON error message survives.
   */
  async request(path, { method = 'GET', query = {}, body, headers = {}, responseType = 'json' } = {}) {
    let refreshed = false;
    let attempt = 0;

    for (;;) {
      this.assertBudget();
      await this.bucket.take();

      const token = await this.getToken({ force: false });
      const url = this.buildUrl(path, query);

      this.counter.increment();

      let res;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        // network-level failure — same retry policy as a 5xx
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoffMs(attempt));
          attempt += 1;
          continue;
        }
        throw new ZohoApiError(`network error calling ${path}: ${err.message}`, { path });
      }

      const status = res.status;
      const wantsBinary = responseType === 'binary';
      const ok = status >= 200 && status < 300;

      let buffer = null;
      let text = '';
      if (wantsBinary && ok) {
        buffer = Buffer.from(await res.arrayBuffer());
      } else {
        // errors always come back as JSON, whatever we asked for
        text = typeof res.text === 'function' ? await res.text() : '';
      }

      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { message: text };
        }
      }

      if (status === 401 && !refreshed) {
        refreshed = true;
        await this.getToken({ force: true });
        continue; // does not count as a retry attempt
      }

      if ((status === 429 || status >= 500) && attempt < this.maxRetries) {
        const retryAfter = res.headers && typeof res.headers.get === 'function'
          ? res.headers.get('Retry-After')
          : null;
        const wait = this.backoffMs(attempt, retryAfter);
        this.logger.warn({ path, status, attempt, wait }, 'zoho request retrying');
        await this.sleep(wait);
        attempt += 1;
        continue;
      }

      if (status < 200 || status >= 300) {
        const message = (payload && (payload.message || payload.error)) || `HTTP ${status}`;
        throw new ZohoApiError(`Zoho API ${status} on ${path}: ${message}`, {
          status,
          code: payload && payload.code,
          path,
          body: payload,
        });
      }

      if (wantsBinary) {
        const contentType =
          res.headers && typeof res.headers.get === 'function' ? res.headers.get('Content-Type') : null;
        return { buffer: buffer || Buffer.alloc(0), contentType: contentType || null };
      }

      return payload || {};
    }
  }

  get(path, query) {
    return this.request(path, { method: 'GET', query });
  }

  /** GET returning raw bytes: `{buffer, contentType}`. */
  getBinary(path, query) {
    return this.request(path, { method: 'GET', query, responseType: 'binary' });
  }

  /**
   * Walk a paginated list endpoint. Yields each page's rows to `onPage` (if
   * given) and returns every row collected.
   *
   * Zoho paginates with page/per_page and reports page_context.has_more_page.
   */
  async paginate(path, { query = {}, listKey, perPage = 200, maxPages = 500, onPage } = {}) {
    const rows = [];
    let page = 1;
    let pages = 0;

    for (;;) {
      const payload = await this.get(path, { ...query, page, per_page: perPage });
      const key = listKey || guessListKey(payload);
      let batch = key && Array.isArray(payload[key]) ? payload[key] : null;
      // some endpoints (e.g. GET /salespersons) return their list under `data`
      // instead of the entity name
      if (!batch && Array.isArray(payload.data)) batch = payload.data;
      batch = batch || [];
      pages += 1;

      if (onPage) await onPage(batch, { page, payload });
      rows.push(...batch);

      const ctx = payload.page_context || {};
      const hasMore = ctx.has_more_page === true;
      if (!hasMore || batch.length === 0 || pages >= maxPages) break;
      page = (Number(ctx.page) || page) + 1;
    }

    return rows;
  }
}

function guessListKey(payload) {
  for (const [k, v] of Object.entries(payload || {})) {
    if (Array.isArray(v) && k !== 'page_context') return k;
  }
  return null;
}

module.exports = {
  BASE_URL,
  ZohoClient,
  TokenBucket,
  ZohoApiError,
  BudgetExceededError,
  ZohoAuthError,
  settingsCallCounter,
  memoryCallCounter,
};
