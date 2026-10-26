/**
 * Small fetch wrapper for the Solita API.
 *  - Cookies carry the session (HttpOnly; never readable from JS).
 *  - Every unsafe request sends the CSRF token in X-CSRF-Token.
 *  - Errors are thrown as ApiError with the server's Arabic message.
 *
 * VITE_API_BASE_URL is only needed if the API is hosted on a different origin;
 * by default the frontend calls /api on its own origin.
 */

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
let csrfToken = null;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function readCsrfCookie() {
  const match = document.cookie.match(/(?:^|;\s*)(?:__Host-)?solita_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function setCsrfToken(token) {
  if (token) csrfToken = token;
}

async function ensureCsrf() {
  csrfToken = readCsrfCookie() || csrfToken;
  if (csrfToken) return csrfToken;
  const res = await fetch(`${BASE_URL}/api/auth/csrf`, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  csrfToken = data.csrfToken || readCsrfCookie();
  return csrfToken;
}

const listeners = new Set();
/** Subscribe to 401 responses (session expired). */
export function onUnauthorized(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function apiRequest(method, path, { body, query, retryCsrf = true } = {}) {
  const url = new URL(`${BASE_URL}/api${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  const headers = { Accept: 'application/json' };
  const unsafe = !['GET', 'HEAD'].includes(method);
  if (unsafe) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = await ensureCsrf();
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      body: unsafe ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.');
  }

  const data = await res.json().catch(() => null);
  if (res.ok) return data;

  const error = data?.error || {};
  if (res.status === 403 && error.code === 'CSRF_INVALID' && retryCsrf) {
    csrfToken = null;
    await fetch(`${BASE_URL}/api/auth/csrf`, { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => setCsrfToken(d.csrfToken))
      .catch(() => {});
    return apiRequest(method, path, { body, query, retryCsrf: false });
  }
  if (res.status === 401 && !path.startsWith('/auth/login')) listeners.forEach((fn) => fn());
  throw new ApiError(res.status, error.code || 'ERROR', error.message || 'حدث خطأ غير متوقع', error.details);
}

export const api = {
  get: (path, query) => apiRequest('GET', path, { query }),
  post: (path, body) => apiRequest('POST', path, { body }),
  patch: (path, body) => apiRequest('PATCH', path, { body }),
};
