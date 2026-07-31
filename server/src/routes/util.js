'use strict';

/**
 * Shared bits for the read routes: zod-parsed paging, a consistent error shape
 * and an async wrapper so route handlers can `await` without unhandled
 * rejections escaping Express 4.
 */

const { z } = require('zod');

const MAX_PER_PAGE = 200;

const pagingSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(MAX_PER_PAGE).default(50),
});

/** Parse ?page/?per_page → {page, perPage, limit, offset}. */
function parsePaging(query) {
  const { page, per_page: perPage } = pagingSchema.parse({
    page: query.page ?? 1,
    per_page: query.per_page ?? 50,
  });
  return { page, perPage, limit: perPage, offset: (page - 1) * perPage };
}

/** Build the standard list envelope. */
function listResponse(rows, total, paging) {
  return {
    rows,
    total,
    page: paging.page,
    perPage: paging.perPage,
    pages: Math.max(1, Math.ceil(total / paging.perPage)),
  };
}

/** Consistent 400 for zod failures, 500 otherwise. */
function sendError(res, err, fallbackStatus = 500) {
  if (err && err.name === 'ZodError') {
    return res.status(400).json({
      error: 'invalid request',
      details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    });
  }
  const status = err && err.status ? err.status : fallbackStatus;
  return res.status(status).json({ error: (err && err.message) || 'internal server error' });
}

/** Wrap an async handler so rejections become a JSON error instead of a hang. */
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      if (res.headersSent) return next(err);
      require('../logger').error({ err: err.message, path: req.originalUrl }, 'route failed');
      sendError(res, err);
    });
  };
}

/** Wrap a sync handler with the same error shape. */
function route(handler) {
  return (req, res, next) => {
    try {
      handler(req, res, next);
    } catch (err) {
      if (res.headersSent) return next(err);
      sendError(res, err);
    }
  };
}

/** Escape a value used inside a LIKE pattern. */
function likeTerm(value) {
  return `%${String(value).replace(/[%_]/g, (m) => `\\${m}`)}%`;
}

/** Whitelist a sort column; falls back to the first allowed column. */
function sortColumn(requested, allowed, fallback) {
  const key = String(requested || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(allowed, key) ? allowed[key] : fallback;
}

function sortDir(requested, fallback = 'DESC') {
  const dir = String(requested || '').toUpperCase();
  return dir === 'ASC' || dir === 'DESC' ? dir : fallback;
}

module.exports = {
  MAX_PER_PAGE,
  parsePaging,
  listResponse,
  sendError,
  asyncRoute,
  route,
  likeTerm,
  sortColumn,
  sortDir,
};
