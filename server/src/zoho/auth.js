'use strict';

/**
 * Zoho OAuth — India DC, "Self Client" flow.
 *
 * The admin creates a Self Client at https://api-console.zoho.in, generates a
 * grant code (valid ~10 minutes) for the ZohoBooks scopes and pastes it into
 * Settings → Zoho together with the client id/secret. We then:
 *
 *   1. exchange the grant code for a refresh token   (accounts.zoho.in)
 *   2. store client id / secret / refresh token in the `settings` table
 *      (.env ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET act as a fallback)
 *   3. fetch and store the organization id/name      (zohoapis.in/books/v3)
 *
 * Access tokens are never persisted — they live in an in-memory cache and are
 * refreshed ~5 minutes before their hour is up, or immediately on a 401.
 */

const config = require('../config');
const logger = require('../logger');
const { ZohoAuthError } = require('./client');

const ACCOUNTS_BASE = 'https://accounts.zoho.in';
const API_BASE = 'https://www.zohoapis.in/books/v3';
const TOKEN_URL = `${ACCOUNTS_BASE}/oauth/v2/token`;

// refresh a little before the usual 3600s expiry
const TOKEN_TTL_FALLBACK_MS = 55 * 60 * 1000;
const TOKEN_EARLY_REFRESH_MS = 5 * 60 * 1000;

const SETTING_KEYS = {
  clientId: 'zoho_client_id',
  clientSecret: 'zoho_client_secret',
  refreshToken: 'zoho_refresh_token',
  orgId: 'zoho_organization_id',
  orgName: 'zoho_organization_name',
  connectedAt: 'zoho_connected_at',
};

// injectable for tests
let fetchImpl = (...args) => globalThis.fetch(...args);
function setFetchImpl(fn) {
  fetchImpl = fn || ((...args) => globalThis.fetch(...args));
}

// in-memory access token cache
let tokenCache = { accessToken: null, expiresAt: 0, inflight: null };
function resetTokenCache() {
  tokenCache = { accessToken: null, expiresAt: 0, inflight: null };
}

function getCredentials() {
  return {
    clientId: config.getSetting(SETTING_KEYS.clientId, '') || config.ZOHO_CLIENT_ID || '',
    clientSecret:
      config.getSetting(SETTING_KEYS.clientSecret, '') || config.ZOHO_CLIENT_SECRET || '',
    refreshToken: config.getSetting(SETTING_KEYS.refreshToken, '') || '',
  };
}

function getOrgId() {
  return config.getSetting(SETTING_KEYS.orgId, '') || null;
}

function isConnected() {
  const { refreshToken } = getCredentials();
  return Boolean(refreshToken && getOrgId());
}

async function postForm(url, params) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });

  const text = typeof res.text === 'function' ? await res.text() : '';
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }

  // Zoho's token endpoint answers 200 with {"error": "..."} on failure
  if (!res.ok || (payload && payload.error)) {
    const msg = (payload && (payload.error_description || payload.error)) || `HTTP ${res.status}`;
    throw new ZohoAuthError(`Zoho OAuth failed: ${msg}`);
  }
  return payload;
}

/**
 * Exchange a Self Client grant code for a refresh token, persist the
 * credentials and fetch the organization. Returns the connection status.
 */
async function connect({ grantCode, clientId, clientSecret }) {
  const id = (clientId || '').trim() || getCredentials().clientId;
  const secret = (clientSecret || '').trim() || getCredentials().clientSecret;
  const code = (grantCode || '').trim();

  if (!id || !secret) throw new ZohoAuthError('client id and client secret are required');
  if (!code) throw new ZohoAuthError('grant code is required');

  const payload = await postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: id,
    client_secret: secret,
    code,
  });

  if (!payload.refresh_token) {
    throw new ZohoAuthError(
      'Zoho did not return a refresh token — the grant code may be expired or already used (they last 10 minutes and are single-use).'
    );
  }

  config.setSetting(SETTING_KEYS.clientId, id);
  config.setSetting(SETTING_KEYS.clientSecret, secret);
  config.setSetting(SETTING_KEYS.refreshToken, payload.refresh_token);
  config.setSetting(SETTING_KEYS.connectedAt, new Date().toISOString());

  const expiresInMs = (Number(payload.expires_in) || 3600) * 1000;
  tokenCache = {
    accessToken: payload.access_token || null,
    expiresAt: payload.access_token ? Date.now() + expiresInMs - TOKEN_EARLY_REFRESH_MS : 0,
    inflight: null,
  };

  const org = await fetchAndStoreOrganization();
  logger.info({ org: org && org.organization_id }, 'zoho connected');

  return getStatus();
}

/** Trade the stored refresh token for a fresh access token. */
async function refreshAccessToken() {
  const { clientId, clientSecret, refreshToken } = getCredentials();
  if (!refreshToken) throw new ZohoAuthError('Zoho is not connected — no refresh token stored');
  if (!clientId || !clientSecret) throw new ZohoAuthError('Zoho client id/secret are not configured');

  const payload = await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  if (!payload.access_token) throw new ZohoAuthError('Zoho did not return an access token');

  const ttlMs = (Number(payload.expires_in) || 3600) * 1000;
  tokenCache = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max(60_000, ttlMs - TOKEN_EARLY_REFRESH_MS),
    inflight: null,
  };
  logger.debug('zoho access token refreshed');
  return tokenCache.accessToken;
}

/**
 * Cached access token. `force: true` bypasses the cache (used after a 401).
 * Concurrent callers share a single in-flight refresh.
 */
async function getAccessToken({ force = false } = {}) {
  if (!force && tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }
  if (!force && tokenCache.inflight) return tokenCache.inflight;

  const p = refreshAccessToken().finally(() => {
    if (tokenCache.inflight === p) tokenCache.inflight = null;
  });
  tokenCache.inflight = p;
  return p;
}

/** GET /organizations and store the first (single-org setup). */
async function fetchAndStoreOrganization() {
  const token = await getAccessToken();
  const res = await fetchImpl(`${API_BASE}/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const text = typeof res.text === 'function' ? await res.text() : '';
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!res.ok) {
    throw new ZohoAuthError(
      `could not read organizations: ${(payload && payload.message) || `HTTP ${res.status}`}`
    );
  }

  const orgs = Array.isArray(payload.organizations) ? payload.organizations : [];
  if (!orgs.length) throw new ZohoAuthError('no Zoho Books organizations found for this account');

  const org = orgs.find((o) => o.is_default_org) || orgs[0];
  config.setSetting(SETTING_KEYS.orgId, String(org.organization_id));
  config.setSetting(SETTING_KEYS.orgName, org.name || '');
  return org;
}

/** Forget the stored credentials (used by the UI "disconnect" action). */
function disconnect() {
  for (const key of Object.values(SETTING_KEYS)) config.setSetting(key, '');
  resetTokenCache();
}

function todaysCallKey(date = new Date()) {
  return `zoho_api_calls_${date.toISOString().slice(0, 10)}`;
}

function getStatus() {
  const { clientId, refreshToken } = getCredentials();
  const budget = Number(config.getSetting('zoho_daily_call_budget', 2000)) || 2000;
  const used = Number(config.getSetting(todaysCallKey(), 0)) || 0;
  return {
    connected: Boolean(refreshToken && getOrgId()),
    hasCredentials: Boolean(clientId),
    clientIdMasked: clientId ? `${clientId.slice(0, 12)}…${clientId.slice(-4)}` : '',
    organizationId: getOrgId(),
    organizationName: config.getSetting(SETTING_KEYS.orgName, '') || '',
    connectedAt: config.getSetting(SETTING_KEYS.connectedAt, '') || null,
    accessTokenCached: Boolean(tokenCache.accessToken && Date.now() < tokenCache.expiresAt),
    apiCalls: { used, budget, remaining: Math.max(0, budget - used), date: todaysCallKey().slice(-10) },
  };
}

module.exports = {
  ACCOUNTS_BASE,
  API_BASE,
  TOKEN_URL,
  TOKEN_TTL_FALLBACK_MS,
  SETTING_KEYS,
  connect,
  disconnect,
  getAccessToken,
  refreshAccessToken,
  fetchAndStoreOrganization,
  getCredentials,
  getOrgId,
  isConnected,
  getStatus,
  setFetchImpl,
  resetTokenCache,
};
