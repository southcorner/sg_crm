'use strict';

/**
 * Session guard for the API. Anything under /api that is not in PUBLIC_PATHS
 * requires a logged-in session and gets a 401 otherwise (the client's fetch
 * wrapper turns a 401 into a redirect to /login).
 */

const PUBLIC_PATHS = new Set(['/health', '/auth/login', '/auth/me', '/auth/logout']);

function requireAuth(req, res, next) {
  // req.path here is relative to the /api mount point
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.session && req.session.adminId) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

module.exports = { requireAuth, PUBLIC_PATHS };
