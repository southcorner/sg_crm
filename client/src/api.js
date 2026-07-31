/**
 * Fetch wrapper for the SG CRM API.
 *
 * - always sends the session cookie
 * - a 401 on anything other than the auth endpoints means the session died →
 *   bounce to /login (preserving where the user was)
 * - non-2xx responses throw an ApiError carrying the server's `error` message
 */

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function redirectToLogin() {
  const { pathname, search } = window.location;
  if (pathname === '/login') return;
  const next = encodeURIComponent(pathname + search);
  window.location.assign(`/login?next=${next}`);
}

async function request(path, { method = 'GET', body, headers, ...rest } = {}) {
  const url = path.startsWith('/api') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;

  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...rest,
  });

  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    redirectToLogin();
    throw new ApiError('unauthorized', 401, payload);
  }

  if (!res.ok) {
    const message = (payload && payload.error) || res.statusText || 'request failed';
    throw new ApiError(message, res.status, payload);
  }

  return payload;
}

export const api = {
  get: (path, opts) => request(path, { ...opts, method: 'GET' }),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body }),
  patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body }),
  del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
};

export const auth = {
  me: () => api.get('/auth/me'),
  login: (username, password) => api.post('/auth/login', { username, password }),
  logout: () => api.post('/auth/logout'),
};

export default api;
