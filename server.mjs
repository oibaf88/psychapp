import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

loadDotEnv(path.join(ROOT, '.env.local'));
loadDotEnv(path.join(ROOT, '.env'));

const DIST = path.join(ROOT, 'dist');
const PORT = positiveInt(process.env.PORT, 10000);
const APP_BASE_PATH = normalizeBasePath(process.env.APP_BASE_PATH || '/psychapp');
const OPENAI_URL = process.env.OPENAI_URL || 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const MAX_BODY_BYTES = positiveInt(process.env.MAX_BODY_BYTES, 20 * 1024 * 1024);
const SCRAPE_TIMEOUT_MS = positiveInt(process.env.SCRAPE_TIMEOUT_MS, 12000);
const SCRAPE_MAX_BYTES = positiveInt(process.env.SCRAPE_MAX_BYTES, 900 * 1024);
const OAUTH_COOKIE = 'psychapp_oauth';
const STATE_COOKIE = 'psychapp_oauth_state';
const OAUTH_COOKIE_TTL_SECONDS = positiveInt(process.env.OAUTH_COOKIE_TTL_SECONDS, 60 * 60 * 24 * 7);
const MICROSOFT_TENANT = process.env.MICROSOFT_TENANT || 'consumers';

const CONNECTORS = {
  gmail: { provider: 'google', connector_id: 'connector_gmail', label: 'Gmail' },
  google_drive: { provider: 'google', connector_id: 'connector_googledrive', label: 'Google Drive' },
  google_calendar: { provider: 'google', connector_id: 'connector_googlecalendar', label: 'Google Calendar' },
  outlook: { provider: 'microsoft', connector_id: 'connector_outlookemail', label: 'Outlook Mail' },
  outlook_calendar: { provider: 'microsoft', connector_id: 'connector_outlookcalendar', label: 'Outlook Calendar' },
  sharepoint: { provider: 'microsoft', connector_id: 'connector_sharepoint', label: 'OneDrive / SharePoint' },
  teams: { provider: 'microsoft', connector_id: 'connector_microsoftteams', label: 'Microsoft Teams' }
};

const GOOGLE_SCOPES = readScopes('GOOGLE_SCOPES', [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.readonly'
]);

const MICROSOFT_SCOPES = readScopes('MICROSOFT_SCOPES', [
  'openid',
  'profile',
  'email',
  'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Files.Read.All',
  'https://graph.microsoft.com/Calendars.Read'
]);

const OAUTH_PROVIDERS = {
  google: {
    id: 'google',
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientIdNames: ['GOOGLE_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_ID'],
    clientSecretNames: ['GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    redirectUriNames: ['GOOGLE_REDIRECT_URI', 'GOOGLE_OAUTH_REDIRECT_URI'],
    scopes: GOOGLE_SCOPES,
    authExtras: { access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent' },
    sendScopeInTokenRequest: false
  },
  microsoft: {
    id: 'microsoft',
    label: 'Microsoft',
    authUrl: `https://login.microsoftonline.com/${encodeURIComponent(MICROSOFT_TENANT)}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(MICROSOFT_TENANT)}/oauth2/v2.0/token`,
    clientIdNames: ['MICROSOFT_CLIENT_ID', 'AZURE_CLIENT_ID', 'MS_CLIENT_ID'],
    clientSecretNames: ['MICROSOFT_CLIENT_SECRET', 'AZURE_CLIENT_SECRET', 'MS_CLIENT_SECRET'],
    redirectUriNames: ['MICROSOFT_REDIRECT_URI', 'AZURE_REDIRECT_URI', 'MS_REDIRECT_URI'],
    scopes: MICROSOFT_SCOPES,
    authExtras: { prompt: 'select_account' },
    sendScopeInTokenRequest: true
  }
};

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBasePath(value) {
  const clean = String(value || '').trim();
  if (!clean || clean === '/') return '';
  return `/${clean.replace(/^\/+|\/+$/g, '')}`;
}

function readScopes(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const scopes = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  return scopes.length ? scopes : fallback;
}

function normalizeSecret(value, keyNames = []) {
  let text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('Bearer ')) text = text.slice(7).trim();
  for (const keyName of keyNames) {
    if (text.startsWith(`${keyName}=`)) text = text.slice(keyName.length + 1).trim();
    if (text.startsWith(`${keyName}:`)) text = text.slice(keyName.length + 1).trim();
  }
  return text.replace(/^["']|["']$/g, '').trim();
}

function findSecret(names) {
  for (const name of names) {
    const value = normalizeSecret(process.env[name], names);
    if (value) return { value, source: `env:${name}` };
  }

  const secretDirs = [
    process.env.RENDER_SECRET_DIR || '/etc/secrets',
    ROOT
  ];

  for (const dir of secretDirs) {
    for (const name of names) {
      const candidates = [
        path.join(dir, name),
        path.join(dir, name.toLowerCase()),
        path.join(dir, `${name}.txt`),
        path.join(dir, `${name.toLowerCase()}.txt`)
      ];
      for (const filePath of candidates) {
        try {
          if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
          const value = normalizeSecret(fs.readFileSync(filePath, 'utf8'), names);
          if (value) return { value, source: `file:${filePath}` };
        } catch {
          // Ignore unreadable secret files.
        }
      }
    }
  }
  return { value: '', source: '' };
}

function getOpenAIKeyWithMeta() {
  return findSecret(['OPENAI_API_KEY', 'OPENAI_API_SECRET', 'OPENAI_KEY', 'openai_api_key', 'openai_api_secret']);
}

function safeSource(source) {
  return source ? source.replace(/:.+$/, ':***') : '';
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    ...extraHeaders
  };
  res.writeHead(status, headers);
  res.end(status === 204 ? '' : JSON.stringify(payload));
}

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(html);
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...extraHeaders });
  res.end();
}

function methodNotAllowed(res, allowed) {
  return sendJson(res, 405, { error: { message: `Method not allowed. Use ${allowed}.` } }, { Allow: allowed });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request demasiado grande'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('JSON inválido'), { status: 400 });
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function isSecureRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = String(req.headers.host || '');
  return proto === 'https' || (!host.startsWith('localhost') && !host.startsWith('127.0.0.1'));
}

function cookieString(name, value, req, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isSecureRequest(req)) parts.push('Secure');
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

function cryptoKey() {
  const configured = findSecret(['OAUTH_COOKIE_SECRET', 'SESSION_SECRET', 'COOKIE_SECRET', 'PSYCHAPP_COOKIE_SECRET']).value;
  const fallback = getOpenAIKeyWithMeta().value || 'dev-only-psychapp-cookie-secret-change-me';
  return crypto.createHash('sha256').update(configured || fallback).digest();
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function randomUrlSafe(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cryptoKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [b64url(iv), b64url(tag), b64url(ciphertext)].join('.');
}

function decryptJson(token) {
  try {
    const [ivB64, tagB64, dataB64] = String(token || '').split('.');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', cryptoKey(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final()
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch {
    return null;
  }
}

function signStatePayload(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', cryptoKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyStatePayload(value) {
  try {
    const [body, sig] = String(value || '').split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', cryptoKey()).update(body).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function readOAuthStore(req) {
  const data = decryptJson(parseCookies(req)[OAUTH_COOKIE]);
  if (!data || typeof data !== 'object') return { providers: {} };
  if (!data.providers || typeof data.providers !== 'object') data.providers = {};
  return data;
}

function writeOAuthStore(req, store) {
  return cookieString(OAUTH_COOKIE, encryptJson({ ...store, updated_at: Date.now() }), req, {
    maxAge: OAUTH_COOKIE_TTL_SECONDS
  });
}

function publicTokenMeta(token = {}) {
  if (!token?.access_token) return { connected: false };
  return {
    connected: true,
    expires_at: token.expires_at || null,
    expires_in_seconds: token.expires_at ? Math.max(0, Math.floor((token.expires_at - Date.now()) / 1000)) : null,
    scope: token.scope || ''
  };
}

function getProviderToken(req, provider) {
  const token = readOAuthStore(req).providers?.[provider];
  if (!token?.access_token) return '';
  if (token.expires_at && Date.now() > token.expires_at - 30000) return '';
  return token.access_token;
}

function oauthProviderConfig(providerName) {
  const provider = OAUTH_PROVIDERS[providerName];
  if (!provider) return { error: `Proveedor OAuth no soportado: ${providerName}` };
  return {
    provider,
    clientId: findSecret(provider.clientIdNames).value,
    clientSecret: findSecret(provider.clientSecretNames).value
  };
}

function absoluteBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (configured) return configured;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}${APP_BASE_PATH}`;
}

function redirectUriFor(req, providerName) {
  const provider = OAUTH_PROVIDERS[providerName];
  const explicit = provider ? findSecret(provider.redirectUriNames).value : '';
  return explicit || `${absoluteBaseUrl(req)}/api/oauth/callback/${providerName}`;
}

async function sha256Base64Url(input) {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

async function handleOAuthStart(req, res, providerName) {
  const { provider, clientId } = oauthProviderConfig(providerName);
  if (!provider) return sendJson(res, 404, { error: { message: `Proveedor OAuth no soportado: ${providerName}` } });
  if (!clientId) {
    return sendJson(res, 500, {
      error: {
        message: `Falta ${provider.label} OAuth client id.`,
        required: provider.clientIdNames,
        redirect_uri: redirectUriFor(req, providerName)
      }
    });
  }

  const reqUrl = new URL(req.url, absoluteBaseUrl(req));
  const returnTo = reqUrl.searchParams.get('return_to') || `${APP_BASE_PATH || '/'}`;
  const state = randomUrlSafe(24);
  const verifier = randomUrlSafe(64);
  const challenge = await sha256Base64Url(verifier);
  const statePayload = { provider: providerName, state, verifier, return_to: returnTo, created_at: Date.now() };

  const auth = new URL(provider.authUrl);
  auth.searchParams.set('client_id', clientId);
  auth.searchParams.set('redirect_uri', redirectUriFor(req, providerName));
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', provider.scopes.join(' '));
  auth.searchParams.set('state', state);
  auth.searchParams.set('response_mode', 'query');
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  for (const [key, value] of Object.entries(provider.authExtras || {})) auth.searchParams.set(key, value);

  return redirect(res, auth.toString(), {
    'Set-Cookie': cookieString(STATE_COOKIE, signStatePayload(statePayload), req, { maxAge: 600 })
  });
}

async function handleOAuthCallback(req, res, providerName) {
  const { provider, clientId, clientSecret } = oauthProviderConfig(providerName);
  if (!provider) return sendJson(res, 404, { error: { message: `Proveedor OAuth no soportado: ${providerName}` } });

  const reqUrl = new URL(req.url, absoluteBaseUrl(req));
  const error = reqUrl.searchParams.get('error');
  if (error) {
    return oauthReply(req, res, 400, {
      ok: false,
      provider: providerName,
      error: { code: error, message: reqUrl.searchParams.get('error_description') || error }
    }, 'OAuth cancelado', reqUrl.searchParams.get('error_description') || error, APP_BASE_PATH || '/');
  }

  const code = reqUrl.searchParams.get('code');
  const state = reqUrl.searchParams.get('state');
  const statePayload = verifyStatePayload(parseCookies(req)[STATE_COOKIE]);
  if (!code || !state || !statePayload || statePayload.state !== state || statePayload.provider !== providerName) {
    return oauthReply(req, res, 400, {
      ok: false,
      provider: providerName,
      error: { message: `OAuth state inválido. Reinicia desde ${APP_BASE_PATH}/api/oauth/start/${providerName}` }
    }, 'OAuth inválido', 'Reinicia la conexión desde la app.', APP_BASE_PATH || '/');
  }
  if (Date.now() - Number(statePayload.created_at || 0) > 10 * 60 * 1000) {
    return oauthReply(req, res, 400, {
      ok: false,
      provider: providerName,
      error: { message: 'OAuth caducado. Reinicia la conexión.' }
    }, 'OAuth caducado', 'Reinicia la conexión desde la app.', APP_BASE_PATH || '/');
  }

  const params = new URLSearchParams();
  params.set('client_id', clientId);
  if (clientSecret) params.set('client_secret', clientSecret);
  params.set('code', code);
  params.set('redirect_uri', redirectUriFor(req, providerName));
  params.set('grant_type', 'authorization_code');
  params.set('code_verifier', statePayload.verifier);
  if (provider.sendScopeInTokenRequest) params.set('scope', provider.scopes.join(' '));

  const tokenResponse = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString()
  });
  const tokenText = await tokenResponse.text();
  let tokenJson = null;
  try {
    tokenJson = JSON.parse(tokenText);
  } catch {
    // Handled below.
  }

  if (!tokenResponse.ok || !tokenJson?.access_token) {
    return oauthReply(req, res, tokenResponse.ok ? 502 : tokenResponse.status, {
      ok: false,
      provider: providerName,
      error: {
        message: tokenJson?.error_description || tokenJson?.error || `Token endpoint HTTP ${tokenResponse.status}`,
        non_json_preview: tokenJson ? undefined : tokenText.slice(0, 280)
      }
    }, 'OAuth falló', tokenJson?.error_description || tokenJson?.error || `HTTP ${tokenResponse.status}`, APP_BASE_PATH || '/');
  }

  const store = readOAuthStore(req);
  const expiresIn = Number(tokenJson.expires_in || 3600);
  store.providers[providerName] = {
    access_token: tokenJson.access_token,
    refresh_token: tokenJson.refresh_token || store.providers?.[providerName]?.refresh_token || '',
    expires_at: Date.now() + expiresIn * 1000,
    scope: tokenJson.scope || provider.scopes.join(' '),
    token_type: tokenJson.token_type || 'Bearer',
    updated_at: Date.now()
  };

  const headers = [
    writeOAuthStore(req, store),
    cookieString(STATE_COOKIE, '', req, { maxAge: 0 })
  ];
  return redirect(res, `${statePayload.return_to || APP_BASE_PATH || '/'}?oauth=${providerName}_connected`, {
    'Set-Cookie': headers
  });
}

function oauthReply(req, res, status, payload, title, message, returnTo) {
  const accept = String(req.headers.accept || '').toLowerCase();
  if (accept.includes('application/json')) return sendJson(res, status, payload);
  return sendHtml(res, status, resultHtml(title, message, returnTo));
}

function resultHtml(title, message, returnTo) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui;padding:2rem;line-height:1.5;background:#f7f3ea;color:#15221f"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(returnTo)}">Volver a PsychApp</a></p></body></html>`;
}

function handleOAuthStatus(req, res) {
  const store = readOAuthStore(req);
  const providerStatus = {
    google: publicTokenMeta(store.providers?.google),
    microsoft: publicTokenMeta(store.providers?.microsoft)
  };
  return sendJson(res, 200, {
    ok: true,
    providers: providerStatus,
    connectors: Object.fromEntries(Object.entries(CONNECTORS).map(([id, connector]) => [
      id,
      {
        ...connector,
        connected: Boolean(providerStatus[connector.provider]?.connected)
      }
    ])),
    oauth_config: publicOAuthConfig(req)
  });
}

function publicOAuthConfig(req) {
  return Object.fromEntries(Object.entries(OAUTH_PROVIDERS).map(([id, provider]) => {
    const { clientId, clientSecret } = oauthProviderConfig(id);
    return [id, {
      client_id_present: Boolean(clientId),
      client_secret_present: Boolean(clientSecret),
      redirect_uri: redirectUriFor(req, id),
      scopes: provider.scopes
    }];
  }));
}

function handleOAuthLogout(req, res, providerName = '') {
  const store = readOAuthStore(req);
  if (providerName) delete store.providers?.[providerName];
  else store.providers = {};
  return sendJson(res, 200, { ok: true, disconnected: providerName || 'all' }, {
    'Set-Cookie': writeOAuthStore(req, store)
  });
}

function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  const ipType = net.isIP(host);
  if (!ipType) return false;
  if (ipType === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  const parts = host.split('.').map(Number);
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function validatePublicUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw Object.assign(new Error(`URL inválida: ${value}`), { status: 400 });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw Object.assign(new Error(`Solo se permiten URLs http/https: ${url.href}`), { status: 400 });
  }
  if (isBlockedHost(url.hostname)) {
    throw Object.assign(new Error(`Host no permitido para scraping: ${url.hostname}`), { status: 400 });
  }
  return url;
}

async function readLimitedText(response, maxBytes) {
  if (!response.body?.getReader) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      text += decoder.decode(value.slice(0, Math.max(0, value.byteLength - (total - maxBytes))), { stream: false });
      try { await reader.cancel(); } catch {}
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

async function scrapeOne(inputUrl) {
  const url = validatePublicUrl(inputUrl);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
  try {
    const response = await fetch(url.href, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'PsychAppScraper/2.0 (+https://ondender.com/psychapp)',
        Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5'
      }
    });
    const contentType = response.headers.get('content-type') || '';
    const raw = await readLimitedText(response, SCRAPE_MAX_BYTES);
    const extracted = extractPage(raw, contentType, response.url || url.href);
    return {
      ok: response.ok,
      url: url.href,
      final_url: response.url || url.href,
      status: response.status,
      content_type: contentType,
      fetched_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt,
      bytes_read: Buffer.byteLength(raw),
      ...extracted
    };
  } catch (error) {
    return {
      ok: false,
      url: url.href,
      status: 0,
      fetched_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt,
      error: error.name === 'AbortError' ? 'Scraping timeout' : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractPage(raw, contentType, finalUrl) {
  const text = String(raw || '');
  if (contentType.includes('application/json')) {
    return {
      title: finalUrl,
      description: '',
      text: text.slice(0, 12000),
      links: [],
      media: [],
      json: safeJsonPreview(text)
    };
  }

  const title = firstMatch(text, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = metaContent(text, 'description') || metaProperty(text, 'og:description') || metaProperty(text, 'twitter:description');
  const cleanHtml = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  const body = firstMatch(cleanHtml, /<body[^>]*>([\s\S]*?)<\/body>/i) || cleanHtml;
  const visible = decodeEntities(body.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18000);

  return {
    title: decodeEntities(title || metaProperty(text, 'og:title') || finalUrl).trim(),
    description: decodeEntities(description || '').trim(),
    text: visible,
    links: extractLinks(text, finalUrl),
    media: extractMedia(text, finalUrl),
    json_ld: extractJsonLd(text)
  };
}

function safeJsonPreview(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstMatch(text, regex) {
  const match = String(text || '').match(regex);
  return match ? match[1] : '';
}

function metaContent(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return firstMatch(html, new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'));
}

function metaProperty(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return firstMatch(html, new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'));
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(regex)) {
    if (links.length >= 40) break;
    try {
      const href = new URL(decodeEntities(match[1]), baseUrl).href;
      const text = decodeEntities(match[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      links.push({ href, text: text.slice(0, 180) });
    } catch {
      // Ignore invalid hrefs.
    }
  }
  return links;
}

function extractMedia(html, baseUrl) {
  const media = [];
  const regex = /<(?:img|video|source)\s+[^>]*(?:src|poster)=["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(regex)) {
    if (media.length >= 20) break;
    try {
      media.push(new URL(decodeEntities(match[1]), baseUrl).href);
    } catch {
      // Ignore invalid media URLs.
    }
  }
  return [...new Set(media)];
}

function extractJsonLd(html) {
  const blocks = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(regex)) {
    if (blocks.length >= 5) break;
    try {
      blocks.push(JSON.parse(match[1].trim()));
    } catch {
      blocks.push({ raw: match[1].trim().slice(0, 1000) });
    }
  }
  return blocks;
}

async function handleScrape(req, res) {
  try {
    const body = await readJsonBody(req);
    const urls = normalizeUrlList(body.urls || body.url || []);
    if (!urls.length) return sendJson(res, 400, { error: { message: 'Añade al menos una URL pública.' } });
    const results = [];
    for (const url of urls.slice(0, 12)) results.push(await scrapeOne(url));
    return sendJson(res, 200, { ok: true, results });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: { message: error.message || 'Scrape error' } });
  }
}

function normalizeUrlList(value) {
  const raw = Array.isArray(value) ? value : [value];
  return raw.map(item => typeof item === 'string' ? item : item?.url).map(s => String(s || '').trim()).filter(Boolean);
}

function getMcpTools(req, body) {
  const tools = [];
  const selectedConnectorIds = Array.isArray(body.connector_ids) ? body.connector_ids : [];
  for (const id of selectedConnectorIds) {
    const connector = CONNECTORS[id];
    if (!connector) continue;
    const token = getProviderToken(req, connector.provider);
    if (!token) {
      throw Object.assign(new Error(`OAuth requerido para ${connector.label}`), {
        status: 401,
        oauth_provider: connector.provider,
        oauth_url: `${APP_BASE_PATH}/api/oauth/start/${connector.provider}?return_to=${encodeURIComponent(APP_BASE_PATH || '/')}`
      });
    }
    tools.push({
      type: 'mcp',
      server_label: id,
      connector_id: connector.connector_id,
      authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
      require_approval: process.env.MCP_REQUIRE_APPROVAL || 'never'
    });
  }

  const remoteServers = Array.isArray(body.remote_mcp_servers) ? body.remote_mcp_servers : [];
  for (const server of remoteServers) {
    const serverUrl = String(server?.server_url || server?.url || '').trim();
    if (!serverUrl.startsWith('https://')) continue;
    const tool = {
      type: 'mcp',
      server_label: sanitizeServerLabel(server?.server_label || server?.name || 'remote_mcp'),
      server_url: serverUrl,
      require_approval: server?.require_approval || process.env.MCP_REQUIRE_APPROVAL || 'never'
    };
    if (Array.isArray(server.allowed_tools) && server.allowed_tools.length) tool.allowed_tools = server.allowed_tools.map(String);
    if (server.authorization) tool.authorization = String(server.authorization).startsWith('Bearer ') ? server.authorization : `Bearer ${server.authorization}`;
    tools.push(tool);
  }

  return tools;
}

function sanitizeServerLabel(value) {
  return String(value || 'mcp').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'mcp';
}

function extractOutputText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string') return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (typeof content.text === 'string') chunks.push(content.text);
      if (typeof content.output_text === 'string') chunks.push(content.output_text);
    }
  }
  return chunks.join('\n').trim();
}

async function callOpenAI(req, payload) {
  const keyInfo = getOpenAIKeyWithMeta();
  if (!keyInfo.value) {
    throw Object.assign(new Error('Falta OPENAI_API_KEY en el servidor.'), {
      status: 500,
      diagnostic: publicDiagnostics(req)
    });
  }

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${keyInfo.value}`
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Handled below.
  }
  if (!response.ok) {
    throw Object.assign(new Error(data?.error?.message || text || `OpenAI HTTP ${response.status}`), {
      status: response.status,
      upstream: data || { raw: text.slice(0, 800) }
    });
  }
  return data;
}

function buildAnalysisPrompt(req, body, scraped) {
  const files = Array.isArray(body.files) ? body.files : [];
  const notes = String(body.notes || '').trim();
  const selected = Array.isArray(body.connector_ids) ? body.connector_ids : [];
  const fileSummaries = files.slice(0, 12).map(file => ({
    name: String(file.name || 'archivo'),
    type: String(file.type || ''),
    size: Number(file.size || 0),
    text: String(file.text || '').slice(0, 12000)
  }));

  return {
    model: body.model || DEFAULT_MODEL,
    instructions: [
      'Eres PsychApp, una herramienta de apoyo para reflexión psicológica estructurada.',
      'No diagnostiques ni sustituyas evaluación clínica. Señala incertidumbre, límites y riesgos.',
      'Usa los datos conectados, archivos y scraping público como evidencia; separa observación, hipótesis y acciones prudentes.',
      'Devuelve el resultado en español con secciones: lectura global, patrones, señales temporales, hipótesis, preguntas útiles, próximos pasos y límites.'
    ].join('\n'),
    input: [
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Analizar patrones personales a partir de fuentes conectadas, archivos exportados y perfiles públicos scrapeados.',
          notes,
          selected_connectors: selected,
          files: fileSummaries,
          scraped_profiles: scraped
        }, null, 2)
      }
    ],
    tools: getMcpTools(req, body),
    max_output_tokens: positiveInt(body.max_output_tokens, 2500),
    store: process.env.OPENAI_STORE === 'true'
  };
}

async function handleAnalyze(req, res) {
  try {
    const body = await readJsonBody(req);
    const profileUrls = normalizeUrlList(body.profile_urls || []);
    const scraped = [];
    for (const url of profileUrls.slice(0, 12)) scraped.push(await scrapeOne(url));

    const payload = buildAnalysisPrompt(req, body, scraped);
    if (!payload.tools?.length) delete payload.tools;
    const openai = await callOpenAI(req, payload);
    const output_text = extractOutputText(openai);
    const save = await saveAnalysisRun({ req, body, scraped, openai, output_text });

    return sendJson(res, 200, {
      ok: true,
      provider: 'openai',
      model: payload.model,
      output_text,
      scraped,
      saved: save,
      raw_id: openai.id || null,
      raw_status: openai.status || null
    });
  } catch (error) {
    return sendJson(res, error.status || 500, {
      ok: false,
      error: {
        message: error.message || 'Analysis error',
        oauth_provider: error.oauth_provider,
        oauth_url: error.oauth_url,
        diagnostic: error.diagnostic,
        upstream: error.upstream
      }
    });
  }
}

async function handleMessages(req, res) {
  try {
    const body = await readJsonBody(req);
    const input = Array.isArray(body.messages)
      ? body.messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }))
      : [{ role: 'user', content: String(body.input || body.prompt || '') }];
    const payload = {
      model: body.model || DEFAULT_MODEL,
      instructions: body.system || undefined,
      input,
      tools: getMcpTools(req, body),
      max_output_tokens: positiveInt(body.max_output_tokens || body.max_tokens, 1800),
      store: process.env.OPENAI_STORE === 'true'
    };
    if (!payload.tools.length) delete payload.tools;
    const openai = await callOpenAI(req, payload);
    return sendJson(res, 200, {
      content: [{ type: 'text', text: extractOutputText(openai) }],
      provider: 'openai',
      raw_id: openai.id || null,
      raw_status: openai.status || null
    });
  } catch (error) {
    return sendJson(res, error.status || 500, {
      error: {
        message: error.message || 'OpenAI proxy error',
        oauth_provider: error.oauth_provider,
        oauth_url: error.oauth_url,
        diagnostic: error.diagnostic,
        upstream: error.upstream
      }
    });
  }
}

async function saveAnalysisRun({ req, body, scraped, openai, output_text }) {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = normalizeSecret(process.env.SUPABASE_SERVICE_ROLE_KEY, ['SUPABASE_SERVICE_ROLE_KEY']);
  if (!supabaseUrl || !serviceKey) return { ok: false, skipped: true, reason: 'Supabase no configurado' };

  const row = {
    app_path: APP_BASE_PATH || '/',
    request_meta: {
      notes_present: Boolean(body.notes),
      connector_ids: Array.isArray(body.connector_ids) ? body.connector_ids : [],
      file_count: Array.isArray(body.files) ? body.files.length : 0,
      profile_urls: normalizeUrlList(body.profile_urls || [])
    },
    scraped,
    result: {
      output_text,
      openai_id: openai.id || null,
      openai_status: openai.status || null,
      model: body.model || DEFAULT_MODEL
    },
    user_agent: req.headers['user-agent'] || ''
  };

  const response = await fetch(`${supabaseUrl}/rest/v1/psychapp_runs`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(row)
  });

  if (!response.ok) {
    const text = await response.text();
    return { ok: false, skipped: false, status: response.status, message: text.slice(0, 400) };
  }
  return { ok: true, skipped: false };
}

function publicDiagnostics(req = null) {
  const keyInfo = getOpenAIKeyWithMeta();
  const store = req ? readOAuthStore(req) : { providers: {} };
  return {
    ok: true,
    app_base_path: APP_BASE_PATH || '/',
    public_base_url: req ? absoluteBaseUrl(req) : process.env.PUBLIC_BASE_URL || '',
    provider: 'openai',
    openai: {
      key_present: Boolean(keyInfo.value),
      key_source: safeSource(keyInfo.source),
      model: DEFAULT_MODEL,
      url: OPENAI_URL,
      store: process.env.OPENAI_STORE === 'true'
    },
    oauth: {
      cookie_secret_present: Boolean(findSecret(['OAUTH_COOKIE_SECRET', 'SESSION_SECRET', 'COOKIE_SECRET', 'PSYCHAPP_COOKIE_SECRET']).value),
      microsoft_tenant: MICROSOFT_TENANT,
      providers: {
        google: publicTokenMeta(store.providers?.google),
        microsoft: publicTokenMeta(store.providers?.microsoft)
      },
      config: req ? publicOAuthConfig(req) : {}
    },
    mcp_connectors: CONNECTORS,
    scraper: {
      timeout_ms: SCRAPE_TIMEOUT_MS,
      max_bytes: SCRAPE_MAX_BYTES,
      blocks_private_hosts: true
    },
    supabase: {
      configured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    },
    node: process.version
  };
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function stripBase(pathname) {
  if (APP_BASE_PATH && (pathname === APP_BASE_PATH || pathname.startsWith(`${APP_BASE_PATH}/`))) {
    const stripped = pathname.slice(APP_BASE_PATH.length) || '/';
    return stripped.startsWith('/') ? stripped : `/${stripped}`;
  }
  return pathname;
}

function routePath(req) {
  const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  return { url, pathname: stripBase(url.pathname) };
}

function serveStatic(req, res, originalPathname, strippedPathname) {
  if (!APP_BASE_PATH && originalPathname === '/') return serveFile(res, path.join(DIST, 'index.html'));
  if (APP_BASE_PATH && originalPathname === '/') return redirect(res, `${APP_BASE_PATH}/`);

  let urlPath = decodeURIComponent(strippedPathname);
  if (urlPath === '/') urlPath = '/index.html';
  const requested = path.resolve(path.join(DIST, urlPath));
  const distRoot = path.resolve(DIST);
  if (!requested.startsWith(distRoot)) return sendJson(res, 403, { error: { message: 'Forbidden' } });
  const filePath = fs.existsSync(requested) && fs.statSync(requested).isFile() ? requested : path.join(DIST, 'index.html');
  return serveFile(res, filePath);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: { message: 'No existe dist/. Ejecuta npm run build primero.' } });
    const cache = filePath.endsWith('index.html') || filePath.endsWith('manifest.webmanifest')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable';
    res.writeHead(200, { 'Content-Type': mime(filePath), 'Cache-Control': cache });
    res.end(data);
  });
}

function mime(filePath) {
  const ext = path.extname(filePath);
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  }[ext]) || 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  const { url, pathname } = routePath(req);

  if (pathname === '/api/health' || pathname === '/api/debug/config') return sendJson(res, 200, publicDiagnostics(req));
  if (pathname === '/api/oauth/status') return handleOAuthStatus(req, res);
  if (pathname === '/api/oauth/logout') return req.method === 'POST' ? handleOAuthLogout(req, res) : methodNotAllowed(res, 'POST');
  if (pathname.startsWith('/api/oauth/logout/')) return req.method === 'POST' ? handleOAuthLogout(req, res, pathname.split('/').pop()) : methodNotAllowed(res, 'POST');
  if (pathname.startsWith('/api/oauth/start/')) return req.method === 'GET'
    ? handleOAuthStart(req, res, pathname.split('/').pop()).catch(error => sendJson(res, error.status || 500, { error: { message: error.message } }))
    : methodNotAllowed(res, 'GET');
  if (pathname.startsWith('/api/oauth/callback/')) return req.method === 'GET'
    ? handleOAuthCallback(req, res, pathname.split('/').pop()).catch(error => sendJson(res, error.status || 500, { error: { message: error.message } }))
    : methodNotAllowed(res, 'GET');
  if (pathname === '/api/scrape') return req.method === 'POST' ? handleScrape(req, res) : methodNotAllowed(res, 'POST');
  if (pathname === '/api/analyze') return req.method === 'POST' ? handleAnalyze(req, res) : methodNotAllowed(res, 'POST');
  if (pathname === '/api/messages') return req.method === 'POST' ? handleMessages(req, res) : methodNotAllowed(res, 'POST');
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: { message: `API route not found: ${pathname}` } });

  return serveStatic(req, res, url.pathname, pathname);
});

server.on('error', error => {
  console.error('[startup] PsychApp failed to bind:', error);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[startup] PsychApp running on http://0.0.0.0:${PORT}${APP_BASE_PATH || '/'}`);
  console.log(`[startup] OpenAI model: ${DEFAULT_MODEL}`);
});
