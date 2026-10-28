import { getConfig } from '../../config/env.js';
import { RateLimitCounter } from '../../models/index.js';

/**
 * EasyOrders Public API client.
 *
 * Verified against https://public-api-docs.easy-orders.net/ :
 *  - Authentication header:  Api-Key: <key>
 *  - GET   /api/v1/external-apps/orders/:order_id          (permission orders:read)
 *  - GET   /api/v1/external-apps/orders/short/:short_id    (permission orders:read)
 *  - PATCH /api/v1/external-apps/orders/:order_id/status   (permission orders:update)
 *          body: { "status": "<one of the documented statuses>" }
 *  - Rate limit: 40 requests/minute, HTTP 429 when exceeded.
 *
 * The docs do not document error bodies or the PATCH response body, so the
 * client only relies on HTTP status codes and treats any 2xx as success.
 * The API key is only ever used server-side and never logged.
 */

export class EasyOrdersError extends Error {
  /**
   * kind: not_configured | rate_limited | timeout | network | server | client | invalid_response
   * ambiguous: the request may have reached EasyOrders (outcome unknown)
   * permanent: retrying the same request will not help
   */
  constructor(kind, message, { status, retryAfterMs, ambiguous = false, permanent = false } = {}) {
    super(message);
    this.name = 'EasyOrdersError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.ambiguous = ambiguous;
    this.permanent = permanent;
  }
}

let fetchImpl = (...args) => globalThis.fetch(...args);

/** Test hook: replace the HTTP implementation. */
export function setFetchImplementation(fn) {
  fetchImpl = fn || ((...args) => globalThis.fetch(...args));
}

const CONNECT_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET_BEFORE_SEND']);

function msUntilNextMinute(now = Date.now()) {
  return 60_000 - (now % 60_000) + 250;
}

/**
 * Persistent request budget shared by all serverless instances, so the app
 * stays under the documented 40 requests/minute.
 */
async function acquireRequestBudget() {
  const { maxRequestsPerMinute } = getConfig().easyOrders;
  const now = Date.now();
  const windowStart = now - (now % 60_000);
  const key = `easyorders:budget:${windowStart}`;
  try {
    const doc = await RateLimitCounter.findOneAndUpdate(
      { key },
      { $inc: { count: 1 }, $setOnInsert: { resetAt: new Date(windowStart + 60_000) } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    if (doc.count > maxRequestsPerMinute) {
      throw new EasyOrdersError('rate_limited', 'Local EasyOrders request budget exhausted for this minute', {
        retryAfterMs: msUntilNextMinute(now),
      });
    }
  } catch (err) {
    if (err instanceof EasyOrdersError) throw err;
    if (err?.code === 11000) return acquireRequestBudget();
    throw err;
  }
}

function parseRetryAfter(header) {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(1000, date - Date.now());
}

async function request(method, path, body) {
  const { apiKey, baseUrl, timeoutMs } = getConfig().easyOrders;
  if (!apiKey) {
    throw new EasyOrdersError('not_configured', 'EASYORDERS_API_KEY is not configured');
  }
  await acquireRequestBudget();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        'Api-Key': apiKey,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new EasyOrdersError('timeout', `EasyOrders request timed out after ${timeoutMs}ms`, {
        ambiguous: method !== 'GET',
      });
    }
    const code = err?.cause?.code || err?.code;
    if (CONNECT_ERROR_CODES.has(code)) {
      throw new EasyOrdersError('network', `Could not connect to EasyOrders (${code})`);
    }
    throw new EasyOrdersError('network', 'Network error while calling EasyOrders', { ambiguous: method !== 'GET' });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => '');
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (response.status === 429) {
    throw new EasyOrdersError('rate_limited', 'EasyOrders rate limit reached (HTTP 429)', {
      status: 429,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) ?? msUntilNextMinute(),
    });
  }
  if (response.status >= 500) {
    throw new EasyOrdersError('server', `EasyOrders server error (HTTP ${response.status})`, {
      status: response.status,
      ambiguous: method !== 'GET',
    });
  }
  if (response.status === 408) {
    throw new EasyOrdersError('timeout', 'EasyOrders request timeout (HTTP 408)', { status: 408, ambiguous: method !== 'GET' });
  }
  if (response.status >= 400) {
    const detail = typeof data?.message === 'string' ? `: ${data.message.slice(0, 200)}` : '';
    throw new EasyOrdersError('client', `EasyOrders rejected the request (HTTP ${response.status})${detail}`, {
      status: response.status,
      permanent: true,
    });
  }
  return { status: response.status, data };
}

function orderPath(orderId) {
  return `/api/v1/external-apps/orders/${encodeURIComponent(String(orderId))}`;
}

function orderFromResponse(data) {
  const order = data && typeof data === 'object' && data.id === undefined && data.data ? data.data : data;
  if (!order || typeof order !== 'object' || order.id === undefined || order.id === null) {
    throw new EasyOrdersError('invalid_response', 'EasyOrders returned an order response without an id');
  }
  return order;
}

/** Fetch the full order. Returns the raw order object. */
export async function getOrder(orderId) {
  const { data } = await request('GET', orderPath(orderId));
  return orderFromResponse(data);
}

/** Fetch the full order by its numeric order number (`short_id`). */
export async function getOrderByShortId(shortId) {
  const { data } = await request('GET', `/api/v1/external-apps/orders/short/${encodeURIComponent(String(shortId))}`);
  return orderFromResponse(data);
}

/** Update the order status. Resolves only when EasyOrders answered with 2xx. */
export async function updateOrderStatus(orderId, status) {
  const result = await request('PATCH', `${orderPath(orderId)}/status`, { status });
  // The PATCH response body is not documented. If it does echo a status that
  // differs from the requested one, treat the outcome as unconfirmed.
  const echoed = result.data && typeof result.data === 'object' ? (result.data.status ?? result.data.data?.status) : undefined;
  if (typeof echoed === 'string' && echoed !== status) {
    throw new EasyOrdersError('invalid_response', `EasyOrders responded with status "${echoed}" instead of "${status}"`, {
      ambiguous: true,
    });
  }
  return { httpStatus: result.status };
}

export function isEasyOrdersConfigured() {
  return getConfig().easyOrders.apiConfigured;
}
