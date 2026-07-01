import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createPsychAppMcpOAuthHandler } from './psychapp-mcp-oauth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

loadDotEnv(path.join(ROOT, '.env.local'));
loadDotEnv(path.join(ROOT, '.env'));

const DIST = path.join(ROOT, 'dist');
const PORT = positiveInt(process.env.PORT, 10000);
const APP_BASE_PATH = normalizeBasePath(process.env.APP_BASE_PATH || '/psychapp');
const OPENAI_URL = process.env.OPENAI_URL || 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const MAX_BODY_BYTES = positiveInt(process.env.MAX_BODY_BYTES, 60 * 1024 * 1024);
const SCRAPE_TIMEOUT_MS = positiveInt(process.env.SCRAPE_TIMEOUT_MS, 12000);
const SCRAPE_MAX_BYTES = positiveInt(process.env.SCRAPE_MAX_BYTES, 1600 * 1024);
const SCRAPE_MAX_LINKS = positiveInt(process.env.SCRAPE_MAX_LINKS, 80);
const SCRAPE_MAX_MEDIA = positiveInt(process.env.SCRAPE_MAX_MEDIA, 60);
const OPENAI_TIMEOUT_MS = positiveInt(process.env.OPENAI_TIMEOUT_MS, 90000);
const SUPABASE_TIMEOUT_MS = positiveInt(process.env.SUPABASE_TIMEOUT_MS, 3500);
const MAX_UPLOADED_IMAGES_FOR_VISION = positiveInt(process.env.MAX_UPLOADED_IMAGES_FOR_VISION, 8);
const MAX_SCRAPED_IMAGES_FOR_VISION = positiveInt(process.env.MAX_SCRAPED_IMAGES_FOR_VISION, 8);
const MAX_UPLOADED_DOCUMENTS_FOR_MODEL = positiveInt(process.env.MAX_UPLOADED_DOCUMENTS_FOR_MODEL, 8);
const OAUTH_COOKIE = 'psychapp_oauth';
const OAUTH_SESSION_COOKIE = 'psychapp_oauth_sid';
const STATE_COOKIE = 'psychapp_oauth_state';
const OAUTH_COOKIE_TTL_SECONDS = positiveInt(process.env.OAUTH_COOKIE_TTL_SECONDS, 60 * 60 * 24 * 7);
const MICROSOFT_TENANT = process.env.MICROSOFT_TENANT || 'common';
const ALLOW_CUSTOM_OAUTH_SCOPES = truthy(process.env.ALLOW_CUSTOM_OAUTH_SCOPES);

const CONNECTORS = {
  gmail: { provider: 'google', connector_id: 'connector_gmail', label: 'Gmail' },
  google_drive: { provider: 'google', connector_id: 'connector_googledrive', label: 'Google Drive' },
  google_calendar: { provider: 'google', connector_id: 'connector_googlecalendar', label: 'Google Calendar' },
  outlook: { provider: 'microsoft', connector_id: 'connector_outlookemail', label: 'Outlook Mail' },
  outlook_calendar: { provider: 'microsoft', connector_id: 'connector_outlookcalendar', label: 'Outlook Calendar' },
  sharepoint: { provider: 'microsoft', connector_id: 'connector_sharepoint', label: 'OneDrive / SharePoint' },
  teams: { provider: 'microsoft', connector_id: 'connector_microsoftteams', label: 'Microsoft Teams' }
};

const EARLY_WARNING_ANALYSIS_MODE = 'early_warning_report';
const MENTAL_HEALTH_SOURCE_LABELS = {
  calendar: 'calendar',
  email_metadata: 'email metadata',
  email_text: 'email text',
  tasks: 'tasks',
  notes: 'notes',
  chat_history: 'chat history',
  uploaded_files: 'uploaded files',
  public_profiles: 'public profiles',
  remote_mcp: 'remote MCP servers',
  wearables: 'wearables/activity data',
  sleep_logs: 'sleep logs',
  location: 'location'
};
const CONNECTOR_MENTAL_HEALTH_SOURCES = {
  gmail: ['email_text'],
  outlook: ['email_text'],
  google_calendar: ['calendar'],
  outlook_calendar: ['calendar'],
  google_drive: ['notes', 'uploaded_files'],
  sharepoint: ['notes', 'uploaded_files'],
  teams: ['chat_history']
};
const DEFAULT_EARLY_WARNING_WINDOWS = ['24h', '3d', '7d', '30d'];
const HIGH_RISK_METRICS = new Set([
  'late_night_activity',
  'negative_language_score',
  'substance_reference_count',
  'missed_obligations',
  'distinct_contacts',
  'tasks_completed'
]);

const GOOGLE_SCOPES = readScopes('GOOGLE_SCOPES', [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly'
]);

const MICROSOFT_SCOPES = readScopes('MICROSOFT_SCOPES', [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Files.Read.All',
  'Calendars.Read'
]);

const CONNECTOR_SCOPE_REQUIREMENTS = {
  gmail: ['userinfo.email', 'userinfo.profile', 'gmail.readonly'],
  google_drive: ['userinfo.email', 'userinfo.profile', 'drive.readonly'],
  google_calendar: ['userinfo.email', 'userinfo.profile', 'calendar.events.readonly'],
  outlook: ['User.Read', 'Mail.Read'],
  outlook_calendar: ['User.Read', 'Calendars.Read'],
  sharepoint: ['User.Read', 'Files.Read.All', 'Sites.Read.All'],
  teams: ['User.Read', 'Chat.Read', 'ChannelMessage.Read.All']
};

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

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function normalizeBasePath(value) {
  const clean = String(value || '').trim();
  if (!clean || clean === '/') return '';
  return `/${clean.replace(/^\/+|\/+$/g, '')}`;
}

function readScopes(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (raw && !ALLOW_CUSTOM_OAUTH_SCOPES) return fallback;
  if (!raw) return fallback;
  const scopes = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  return scopes.length ? scopes : fallback;
}

function scopeAliases(scope) {
  const value = String(scope || '').trim();
  if (!value) return [];
  const short = value
    .replace(/^https:\/\/www\.googleapis\.com\/auth\//i, '')
    .replace(/^https:\/\/graph\.microsoft\.com\//i, '')
    .replace(/^https:\/\/www\.googleapis\.com\/auth\/userinfo\./i, 'userinfo.');
  const aliases = new Set([value, short]);
  const addGoogleScope = name => {
    aliases.add(name);
    aliases.add(`https://www.googleapis.com/auth/${name}`);
  };

  if (value === 'email' || short === 'email') aliases.add('userinfo.email');
  if (value === 'profile' || short === 'profile') aliases.add('userinfo.profile');
  if (value === 'userinfo.email' || short === 'userinfo.email') {
    aliases.add('email');
    aliases.add('https://www.googleapis.com/auth/userinfo.email');
  }
  if (value === 'userinfo.profile' || short === 'userinfo.profile') {
    aliases.add('profile');
    aliases.add('https://www.googleapis.com/auth/userinfo.profile');
  }
  for (const googleScope of ['gmail.modify', 'gmail.readonly', 'gmail.metadata', 'drive.readonly', 'calendar.events', 'calendar.events.readonly', 'calendar.readonly']) {
    if (value === googleScope || short === googleScope) addGoogleScope(googleScope);
  }
  if (short === 'gmail.modify') {
    addGoogleScope('gmail.readonly');
    addGoogleScope('gmail.metadata');
  }
  if (short === 'gmail.readonly') addGoogleScope('gmail.metadata');
  if (short === 'calendar.events') addGoogleScope('calendar.events.readonly');
  if (short === 'calendar.readonly') addGoogleScope('calendar.events.readonly');
  if (short === 'drive') {
    addGoogleScope('drive.readonly');
  }
  for (const microsoftScope of ['User.Read', 'Mail.Read', 'Files.Read.All', 'Sites.Read.All', 'Calendars.Read', 'Chat.Read', 'ChannelMessage.Read.All']) {
    if (value === microsoftScope || short === microsoftScope) aliases.add(`https://graph.microsoft.com/${microsoftScope}`);
  }
  return [...aliases].flatMap(alias => [alias, alias.toLowerCase()]);
}

function scopeSet(scopeText) {
  const set = new Set();
  for (const scope of String(scopeText || '').split(/\s+/).filter(Boolean)) {
    for (const alias of scopeAliases(scope)) set.add(alias);
  }
  return set;
}

function missingScopes(scopeText, required = []) {
  const available = scopeSet(scopeText);
  return required.filter(scope => !scopeAliases(scope).some(alias => available.has(alias)));
}

function connectorScopeStatus(scopeText, providerName) {
  return Object.fromEntries(Object.entries(CONNECTORS)
    .filter(([, connector]) => connector.provider === providerName)
    .map(([id, connector]) => {
      const required = CONNECTOR_SCOPE_REQUIREMENTS[id] || [];
      const missing = missingScopes(scopeText, required);
      return [id, {
        label: connector.label,
        connector_id: connector.connector_id,
        required_scopes: required,
        missing_scopes: missing,
        ready: missing.length === 0
      }];
    }));
}

function normalizeOAuthAccessToken(value) {
  return String(value || '').replace(/^Bearer\s+/i, '').trim();
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

function getSupabaseKeyWithMeta() {
  const names = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'supabase_service_role_key',
    'SUPABASE_KEY',
    'supabase_key',
    'SUPABASE_ANON_KEY',
    'SUPABASE_PUBLISHABLE_KEY',
    'supabase_anon_key',
    'supabase_publishable_key'
  ];
  const found = names
    .map(name => findSecret([name]))
    .filter(info => info.value);
  return found.find(info => supabaseKeyKind(info.source, info.value) === 'service_role') || found[0] || { value: '', source: '' };
}

function supabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = getSupabaseKeyWithMeta();
  return { url, key };
}

function jwtPayload(value = '') {
  const parts = String(value || '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function supabaseKeyKind(source = '', value = '') {
  const role = String(jwtPayload(value)?.role || '').toLowerCase();
  if (role === 'service_role') return 'service_role';
  if (role === 'anon') return 'anon';
  const text = String(source || '').toLowerCase();
  if (text.includes('service_role')) return 'service_role';
  if (text.includes('anon')) return 'anon';
  if (text.includes('publishable')) return 'publishable';
  return source ? 'configured' : '';
}

function safeSource(source) {
  return source ? source.replace(/:.+$/, ':***') : '';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestOptions = { ...options };
  if (!requestOptions.signal) requestOptions.signal = controller.signal;
  try {
    return await fetch(url, requestOptions);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error(`Tiempo de espera agotado (${timeoutMs} ms).`), { status: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
  const cookieDomain = String(process.env.OAUTH_COOKIE_DOMAIN || '').trim();
  if (cookieDomain && cookieDomainMatches(req, cookieDomain)) parts.push(`Domain=${cookieDomain.replace(/^\./, '.')}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

function cookieDomainMatches(req, domain) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const clean = String(domain || '').replace(/^\./, '').toLowerCase();
  return Boolean(host && clean && (host === clean || host.endsWith(`.${clean}`)));
}

function validOAuthSessionId(value) {
  return /^[A-Za-z0-9_-]{32,160}$/.test(String(value || ''));
}

function oauthSessionIdFromRequest(req) {
  const value = parseCookies(req)[OAUTH_SESSION_COOKIE];
  return validOAuthSessionId(value) ? value : '';
}

function clearOAuthCookieHeaders(req) {
  return [
    cookieString(OAUTH_SESSION_COOKIE, '', req, { maxAge: 0 }),
    cookieString(OAUTH_COOKIE, '', req, { maxAge: 0 })
  ];
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

async function supabaseSessionRequest(pathSuffix, options = {}, sessionId = '') {
  const { url, key } = supabaseConfig();
  if (!url || !key.value) return { ok: false, skipped: true, reason: 'Supabase no configurado' };
  const headers = {
    apikey: key.value,
    Authorization: `Bearer ${key.value}`,
    Accept: 'application/json',
    ...(options.headers || {})
  };
  if (sessionId) headers['x-psychapp-session'] = sessionId;
  const response = await fetchWithTimeout(`${url}/rest/v1/psychapp_oauth_sessions${pathSuffix}`, {
    ...options,
    headers
  }, SUPABASE_TIMEOUT_MS);
  return { ok: response.ok, response };
}

async function readOAuthStoreAsync(req) {
  const sessionId = oauthSessionIdFromRequest(req);
  if (sessionId) {
    try {
      const result = await supabaseSessionRequest(
        `?session_id=eq.${encodeURIComponent(sessionId)}&select=token_store`,
        { method: 'GET' },
        sessionId
      );
      if (result.ok) {
        const rows = await result.response.json();
        const store = decryptJson(rows?.[0]?.token_store);
        if (store && typeof store === 'object') {
          if (!store.providers || typeof store.providers !== 'object') store.providers = {};
          return store;
        }
      }
    } catch (error) {
      console.warn('[oauth] Supabase session read failed:', error?.message || error);
    }
  }

  return readOAuthStore(req);
}

async function writeOAuthStoreAsync(req, store) {
  const sessionId = oauthSessionIdFromRequest(req) || randomUrlSafe(48);
  const payload = {
    session_id: sessionId,
    token_store: encryptJson({ ...store, updated_at: Date.now() }),
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + OAUTH_COOKIE_TTL_SECONDS * 1000).toISOString()
  };

  try {
    const result = await supabaseSessionRequest(
      '?on_conflict=session_id',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(payload)
      },
      sessionId
    );
    if (result.ok) {
      return [
        cookieString(OAUTH_SESSION_COOKIE, sessionId, req, { maxAge: OAUTH_COOKIE_TTL_SECONDS }),
        cookieString(OAUTH_COOKIE, '', req, { maxAge: 0 })
      ];
    }
    const text = result.response ? await result.response.text() : result.reason || '';
    console.warn('[oauth] Supabase session write failed:', text.slice(0, 400));
  } catch (error) {
    console.warn('[oauth] Supabase session write error:', error?.message || error);
  }

  return [
    writeOAuthStore(req, store),
    cookieString(OAUTH_SESSION_COOKIE, '', req, { maxAge: 0 })
  ];
}

async function clearOAuthStoreAsync(req) {
  const sessionId = oauthSessionIdFromRequest(req);
  if (sessionId) {
    try {
      await supabaseSessionRequest(`?session_id=eq.${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, sessionId);
    } catch (error) {
      console.warn('[oauth] Supabase session delete failed:', error?.message || error);
    }
  }
  return clearOAuthCookieHeaders(req);
}

function publicTokenMeta(token = {}, providerName = '') {
  if (!token?.access_token) return { connected: false };
  const expiresInSeconds = token.expires_at ? Math.max(0, Math.floor((token.expires_at - Date.now()) / 1000)) : null;
  const expired = expiresInSeconds != null && expiresInSeconds <= 30;
  const provider = OAUTH_PROVIDERS[providerName];
  const configuredScopes = provider?.scopes || [];
  return {
    connected: true,
    usable: !expired || Boolean(token.refresh_token),
    expired,
    can_refresh: Boolean(token.refresh_token),
    expires_at: token.expires_at || null,
    expires_in_seconds: expiresInSeconds,
    scope: token.scope || '',
    required_scopes: configuredScopes,
    missing_configured_scopes: missingScopes(token.scope || '', configuredScopes),
    connector_scope_status: providerName ? connectorScopeStatus(token.scope || '', providerName) : {}
  };
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
  const derived = requestBaseUrl(req);
  if (!configured) return derived;
  if (process.env.OAUTH_FORCE_PUBLIC_BASE_URL === 'true') return configured;
  try {
    const configuredUrl = new URL(configured);
    const derivedUrl = new URL(derived);
    const derivedHost = derivedUrl.host.toLowerCase();
    if (configuredUrl.host.toLowerCase() !== derivedHost && !derivedHost.endsWith('.onrender.com')) {
      return derived;
    }
  } catch {
    return derived;
  }
  return configured;
}

function requestBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}${APP_BASE_PATH}`;
}

function redirectUriFor(req, providerName) {
  const provider = OAUTH_PROVIDERS[providerName];
  const explicit = provider ? findSecret(provider.redirectUriNames).value : '';
  return explicit || `${absoluteBaseUrl(req)}/api/oauth/callback/${providerName}`;
}

function apiRouteFor(req, route) {
  const pathname = APP_BASE_PATH || new URL(absoluteBaseUrl(req)).pathname.replace(/\/$/, '');
  return `${pathname}${route}` || route;
}

function appReturnPath(req) {
  const fallback = `${APP_BASE_PATH || '/'}`;
  try {
    const referer = String(req.headers.referer || '');
    if (!referer) return fallback;
    const url = new URL(referer);
    const path = `${url.pathname}${url.search}`;
    if (!APP_BASE_PATH || path === APP_BASE_PATH || path.startsWith(`${APP_BASE_PATH}/`)) return path;
  } catch {
    // Use the app root when the browser did not send a parseable referrer.
  }
  return fallback;
}

function oauthStartUrl(req, providerName) {
  return `${apiRouteFor(req, `/api/oauth/start/${providerName}`)}?return_to=${encodeURIComponent(appReturnPath(req))}`;
}

async function sha256Base64Url(input) {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

async function handleOAuthStart(req, res, providerName) {
  const { provider, clientId } = oauthProviderConfig(providerName);
  if (!provider) return sendJson(res, 404, { error: { message: `Proveedor OAuth no soportado: ${providerName}` } });
  if (!clientId) {
    trackPsychappEvent(req, 'psychapp.oauth.error', {
      route: `/api/oauth/start/${providerName}`,
      provider: providerName,
      reason: 'missing_client_id',
      required: provider.clientIdNames
    });
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

  trackPsychappEvent(req, 'psychapp.oauth.start', {
    route: `/api/oauth/start/${providerName}`,
    provider: providerName,
    scopes: provider.scopes,
    client_id_present: true,
    client_secret_present: Boolean(oauthProviderConfig(providerName).clientSecret)
  });

  return redirect(res, auth.toString(), {
    'Set-Cookie': cookieString(STATE_COOKIE, signStatePayload(statePayload), req, { maxAge: 600 })
  });
}

async function handleOAuthCallback(req, res, providerName) {
  const { provider, clientId, clientSecret } = oauthProviderConfig(providerName);
  if (!provider) return sendJson(res, 404, { error: { message: `Proveedor OAuth no soportado: ${providerName}` } });

  const reqUrl = new URL(req.url, absoluteBaseUrl(req));
  const params = await callbackParams(req, reqUrl);
  const error = params.get('error');
  if (error) {
    trackPsychappEvent(req, 'psychapp.oauth.error', {
      route: `/api/oauth/callback/${providerName}`,
      provider: providerName,
      reason: error,
      message: params.get('error_description') || error
    });
    return oauthReply(req, res, 400, {
      ok: false,
      provider: providerName,
      error: { code: error, message: params.get('error_description') || error }
    }, 'OAuth cancelado', params.get('error_description') || error, APP_BASE_PATH || '/');
  }

  const code = params.get('code');
  const state = params.get('state');
  if (req.method === 'POST' && !code && !state) {
    return sendJson(res, 200, {
      ok: true,
      provider: providerName,
      status: 'oauth_callback_reachable',
      message: 'Callback OAuth alcanzable. El flujo real de OAuth debe empezar en /api/oauth/start/{provider} y volver aqui con code/state.',
      redirect_uri: redirectUriFor(req, providerName),
      method_received: req.method,
      client_id_present: Boolean(clientId),
      client_secret_present: Boolean(clientSecret),
      expected_flow: 'authorization_code_pkce'
    });
  }

  const statePayload = verifyStatePayload(parseCookies(req)[STATE_COOKIE]);
  if (!code || !state || !statePayload || statePayload.state !== state || statePayload.provider !== providerName) {
    trackPsychappEvent(req, 'psychapp.oauth.error', {
      route: `/api/oauth/callback/${providerName}`,
      provider: providerName,
      reason: 'invalid_state',
      code_present: Boolean(code),
      state_present: Boolean(state),
      state_cookie_present: Boolean(statePayload)
    });
    return oauthReply(req, res, 400, {
      ok: false,
      provider: providerName,
      error: { message: `OAuth state inválido. Reinicia desde ${APP_BASE_PATH}/api/oauth/start/${providerName}` }
    }, 'OAuth inválido', 'Reinicia la conexión desde la app.', APP_BASE_PATH || '/');
  }
  if (Date.now() - Number(statePayload.created_at || 0) > 10 * 60 * 1000) {
    trackPsychappEvent(req, 'psychapp.oauth.error', {
      route: `/api/oauth/callback/${providerName}`,
      provider: providerName,
      reason: 'expired_state'
    });
    return oauthReply(req, res, 400, {
      ok: false,
      provider: providerName,
      error: { message: 'OAuth caducado. Reinicia la conexión.' }
    }, 'OAuth caducado', 'Reinicia la conexión desde la app.', APP_BASE_PATH || '/');
  }

  const tokenParams = new URLSearchParams();
  tokenParams.set('client_id', clientId);
  if (clientSecret) tokenParams.set('client_secret', clientSecret);
  tokenParams.set('code', code);
  tokenParams.set('redirect_uri', redirectUriFor(req, providerName));
  tokenParams.set('grant_type', 'authorization_code');
  tokenParams.set('code_verifier', statePayload.verifier);
  if (provider.sendScopeInTokenRequest) tokenParams.set('scope', provider.scopes.join(' '));

  const tokenResponse = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: tokenParams.toString()
  });
  const tokenText = await tokenResponse.text();
  let tokenJson = null;
  try {
    tokenJson = JSON.parse(tokenText);
  } catch {
    // Handled below.
  }

  if (!tokenResponse.ok || !tokenJson?.access_token) {
    trackPsychappEvent(req, 'psychapp.oauth.error', {
      route: `/api/oauth/callback/${providerName}`,
      provider: providerName,
      reason: 'token_exchange_failed',
      status: tokenResponse.status,
      message: tokenJson?.error_description || tokenJson?.error || `HTTP ${tokenResponse.status}`
    });
    return oauthReply(req, res, tokenResponse.ok ? 502 : tokenResponse.status, {
      ok: false,
      provider: providerName,
      error: {
        message: tokenJson?.error_description || tokenJson?.error || `Token endpoint HTTP ${tokenResponse.status}`,
        non_json_preview: tokenJson ? undefined : tokenText.slice(0, 280)
      }
    }, 'OAuth falló', tokenJson?.error_description || tokenJson?.error || `HTTP ${tokenResponse.status}`, APP_BASE_PATH || '/');
  }

  const store = await readOAuthStoreAsync(req);
  const expiresIn = Number(tokenJson.expires_in || 3600);
  store.providers[providerName] = {
    access_token: normalizeOAuthAccessToken(tokenJson.access_token),
    refresh_token: tokenJson.refresh_token || store.providers?.[providerName]?.refresh_token || '',
    expires_at: Date.now() + expiresIn * 1000,
    scope: tokenJson.scope || provider.scopes.join(' '),
    token_type: tokenJson.token_type || 'Bearer',
    updated_at: Date.now()
  };

  trackPsychappEvent(req, 'psychapp.oauth.connected', {
    route: `/api/oauth/callback/${providerName}`,
    provider: providerName,
    scopes: String(store.providers[providerName].scope || '').split(/\s+/).filter(Boolean),
    expires_in_seconds: expiresIn,
    connector_scope_status: connectorScopeStatus(store.providers[providerName].scope || '', providerName)
  });

  const headers = [
    ...(await writeOAuthStoreAsync(req, store)),
    cookieString(STATE_COOKIE, '', req, { maxAge: 0 })
  ];
  return redirect(res, `${statePayload.return_to || APP_BASE_PATH || '/'}?oauth=${providerName}_connected`, {
    'Set-Cookie': headers
  });
}

async function callbackParams(req, reqUrl) {
  const params = new URLSearchParams(reqUrl.searchParams);
  if (req.method !== 'POST') return params;

  const raw = await readBody(req);
  if (!raw.trim()) return params;

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json')) {
    try {
      const json = JSON.parse(raw);
      for (const [key, value] of Object.entries(json || {})) {
        if (value != null && !params.has(key)) params.set(key, String(value));
      }
    } catch {
      params.set('error', 'invalid_json_callback_body');
      params.set('error_description', 'El callback POST recibio JSON invalido.');
    }
    return params;
  }

  const posted = new URLSearchParams(raw);
  for (const [key, value] of posted.entries()) {
    if (!params.has(key)) params.set(key, value);
  }
  return params;
}

function oauthReply(req, res, status, payload, title, message, returnTo) {
  const accept = String(req.headers.accept || '').toLowerCase();
  const wantsJson = accept.includes('application/json') || new URL(req.url, absoluteBaseUrl(req)).searchParams.get('json') === '1';
  if (wantsJson) return sendJson(res, status, payload);
  return sendHtml(res, status, resultHtml(title, message, returnTo));
}

function resultHtml(title, message, returnTo) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui;padding:2rem;line-height:1.5;background:#eef6ff;color:#10233f"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(returnTo)}">Volver a PsychApp</a></p></body></html>`;
}

async function handleOAuthStatus(req, res) {
  const store = await readOAuthStoreAsync(req);
  const providerStatus = {
    google: publicTokenMeta(store.providers?.google, 'google'),
    microsoft: publicTokenMeta(store.providers?.microsoft, 'microsoft')
  };
  return sendJson(res, 200, {
    ok: true,
    providers: providerStatus,
    connectors: Object.fromEntries(Object.entries(CONNECTORS).map(([id, connector]) => [
      id,
      {
        ...connector,
        connected: Boolean(providerStatus[connector.provider]?.connected),
        ready: Boolean(providerStatus[connector.provider]?.connector_scope_status?.[id]?.ready),
        required_scopes: CONNECTOR_SCOPE_REQUIREMENTS[id] || [],
        missing_scopes: providerStatus[connector.provider]?.connector_scope_status?.[id]?.missing_scopes || []
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
      auth_url: provider.authUrl,
      token_url: provider.tokenUrl,
      redirect_uri: redirectUriFor(req, id),
      scopes: provider.scopes
    }];
  }));
}

async function handleOAuthLogout(req, res, providerName = '') {
  const store = await readOAuthStoreAsync(req);
  if (providerName) delete store.providers?.[providerName];
  else store.providers = {};
  const providersLeft = Object.values(store.providers || {}).some(provider => provider?.access_token);
  const cookies = providersLeft ? await writeOAuthStoreAsync(req, store) : await clearOAuthStoreAsync(req);
  return sendJson(res, 200, { ok: true, disconnected: providerName || 'all' }, {
    'Set-Cookie': cookies
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
    const jsonText = text.slice(0, 30000);
    return {
      title: finalUrl,
      description: '',
      text: jsonText,
      links: [],
      media: [],
      topics: extractTopics(jsonText),
      hashtags: extractHashtags(jsonText),
      mentions: extractMentions(jsonText),
      stats: textStats(jsonText, [], []),
      json: safeJsonPreview(text)
    };
  }

  const title = firstMatch(text, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = metaContent(text, 'description') || metaProperty(text, 'og:description') || metaProperty(text, 'twitter:description');
  const keywords = splitKeywords(metaContent(text, 'keywords') || metaProperty(text, 'article:tag'));
  const author = metaContent(text, 'author') || metaProperty(text, 'article:author') || metaProperty(text, 'og:site_name');
  const publishedTime = metaProperty(text, 'article:published_time') || metaContent(text, 'date') || metaContent(text, 'pubdate');
  const modifiedTime = metaProperty(text, 'article:modified_time') || metaContent(text, 'last-modified');
  const language = firstMatch(text, /<html[^>]+lang=["']?([^"'\s>]+)/i) || metaProperty(text, 'og:locale');
  const cleanHtml = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  const body = firstMatch(cleanHtml, /<body[^>]*>([\s\S]*?)<\/body>/i) || cleanHtml;
  const visible = decodeEntities(body.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30000);
  const links = extractLinks(text, finalUrl);
  const media = extractMedia(text, finalUrl);
  const headings = extractHeadings(cleanHtml);
  const hashtags = extractHashtags(visible);
  const mentions = extractMentions(visible);
  const topics = mergeTopics(keywords, extractTopics([headings.join(' '), visible].join(' '))).slice(0, 28);

  return {
    title: decodeEntities(title || metaProperty(text, 'og:title') || finalUrl).trim(),
    description: decodeEntities(description || '').trim(),
    author: decodeEntities(author || '').trim(),
    published_time: decodeEntities(publishedTime || '').trim(),
    modified_time: decodeEntities(modifiedTime || '').trim(),
    language: decodeEntities(language || '').trim(),
    text: visible,
    headings,
    topics,
    hashtags,
    mentions,
    links,
    media,
    stats: textStats(visible, links, media),
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
  return metaBy(html, 'name', name);
}

function metaProperty(html, property) {
  return metaBy(html, 'property', property) || metaBy(html, 'name', property);
}

function metaBy(html, attrName, attrValue) {
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (htmlAttr(tag, attrName).toLowerCase() === String(attrValue || '').toLowerCase()) {
      return htmlAttr(tag, 'content');
    }
  }
  return '';
}

function htmlAttr(tag, attrName) {
  const escaped = String(attrName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(tag || '').match(new RegExp(`\\s${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decodeEntities(match?.[1] || match?.[2] || match?.[3] || '').trim();
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

function stripTags(value) {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function splitKeywords(value) {
  return String(value || '')
    .split(/[,;|]/)
    .map(item => decodeEntities(item).trim())
    .filter(Boolean)
    .slice(0, 24);
}

function extractHeadings(html) {
  const headings = [];
  const regex = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  for (const match of String(html || '').matchAll(regex)) {
    const text = stripTags(match[2]);
    if (text && text.length > 2) headings.push(text.slice(0, 220));
    if (headings.length >= 36) break;
  }
  return headings;
}

function extractHashtags(text) {
  return [...new Set([...String(text || '').matchAll(/(^|\s)#([\p{L}\p{N}_-]{2,60})/gu)].map(match => `#${match[2]}`))].slice(0, 48);
}

function extractMentions(text) {
  return [...new Set([...String(text || '').matchAll(/(^|\s)@([\p{L}\p{N}_\.-]{2,60})/gu)].map(match => `@${match[2]}`))].slice(0, 36);
}

const STOP_WORDS = new Set([
  'para', 'como', 'pero', 'porque', 'desde', 'sobre', 'entre', 'donde', 'cuando', 'todo', 'toda', 'todos', 'todas',
  'esta', 'este', 'estos', 'estas', 'esto', 'tambien', 'también', 'hacer', 'hace', 'cada', 'otro', 'otra', 'otros',
  'otras', 'muy', 'mas', 'más', 'menos', 'con', 'sin', 'por', 'una', 'uno', 'unos', 'unas', 'los', 'las', 'del',
  'que', 'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'you', 'are', 'was', 'were', 'have', 'has',
  'not', 'all', 'can', 'will', 'our', 'about', 'into', 'their', 'there', 'here', 'more', 'what', 'when', 'where'
]);

function extractTopics(text) {
  const counts = new Map();
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{3,}/gu) || [];
  for (const word of words) {
    const clean = word.normalize('NFKD').replace(/\p{Diacritic}/gu, '');
    if (STOP_WORDS.has(word) || STOP_WORDS.has(clean) || /^\d+$/.test(clean)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 24)
    .map(([word, count]) => ({ term: word, count }));
}

function mergeTopics(keywords, terms) {
  const out = [];
  const seen = new Set();
  for (const keyword of keywords || []) {
    const term = String(keyword || '').trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push({ term, source: 'meta' });
  }
  for (const item of terms || []) {
    const term = String(item?.term || item || '').trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(typeof item === 'object' ? item : { term });
  }
  return out;
}

function textStats(text, links, media) {
  const words = String(text || '').match(/[\p{L}\p{N}]+/gu) || [];
  return {
    characters: String(text || '').length,
    words: words.length,
    links: Array.isArray(links) ? links.length : 0,
    media: Array.isArray(media) ? media.length : 0
  };
}

function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(regex)) {
    if (links.length >= SCRAPE_MAX_LINKS) break;
    try {
      const tag = match[0].split('>')[0];
      const hrefRaw = htmlAttr(tag, 'href');
      if (!hrefRaw || hrefRaw.startsWith('#') || /^javascript:/i.test(hrefRaw)) continue;
      const href = new URL(hrefRaw, baseUrl).href;
      const text = stripTags(match[1]);
      const sameHost = new URL(href).host === new URL(baseUrl).host;
      links.push({ href, text: text.slice(0, 220), kind: sameHost ? 'internal' : 'external' });
    } catch {
      // Ignore invalid hrefs.
    }
  }
  return links;
}

function extractMedia(html, baseUrl) {
  const media = [];
  const regex = /<(img|video|source)\b[^>]*>/gi;
  for (const match of html.matchAll(regex)) {
    if (media.length >= SCRAPE_MAX_MEDIA) break;
    try {
      const tagName = match[1].toLowerCase();
      const tag = match[0];
      const srcRaw = htmlAttr(tag, 'src') || htmlAttr(tag, 'data-src') || htmlAttr(tag, 'poster') || firstSrcsetUrl(htmlAttr(tag, 'srcset'));
      if (!srcRaw || srcRaw.startsWith('data:')) continue;
      const src = new URL(srcRaw, baseUrl).href;
      const context = nearbyText(html, match.index || 0);
      media.push({
        type: tagName === 'img' ? 'image' : 'media',
        src,
        alt: htmlAttr(tag, 'alt'),
        title: htmlAttr(tag, 'title') || htmlAttr(tag, 'aria-label'),
        width: htmlAttr(tag, 'width'),
        height: htmlAttr(tag, 'height'),
        context
      });
    } catch {
      // Ignore invalid media URLs.
    }
  }
  const seen = new Set();
  return media.filter(item => {
    if (seen.has(item.src)) return false;
    seen.add(item.src);
    return true;
  });
}

function firstSrcsetUrl(value) {
  const first = String(value || '').split(',').map(item => item.trim()).filter(Boolean)[0] || '';
  return first.split(/\s+/)[0] || '';
}

function nearbyText(html, index) {
  const start = Math.max(0, Number(index || 0) - 450);
  const end = Math.min(String(html || '').length, Number(index || 0) + 650);
  return stripTags(String(html || '').slice(start, end)).slice(0, 260);
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

async function refreshProviderAccessToken(providerName, store) {
  const { provider, clientId, clientSecret } = oauthProviderConfig(providerName);
  const existing = store.providers?.[providerName];
  if (!provider || !clientId || !existing?.refresh_token) {
    return { accessToken: '', refreshed: false, reason: 'not_refreshable' };
  }

  const params = new URLSearchParams();
  params.set('client_id', clientId);
  if (clientSecret) params.set('client_secret', clientSecret);
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', existing.refresh_token);
  if (provider.sendScopeInTokenRequest) params.set('scope', provider.scopes.join(' '));

  const response = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString()
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Handled below.
  }

  if (!response.ok || !data?.access_token) {
    delete store.providers?.[providerName];
    return {
      accessToken: '',
      refreshed: true,
      reason: data?.error_description || data?.error || `refresh_http_${response.status}`
    };
  }

  const expiresIn = Number(data.expires_in || 3600);
  store.providers[providerName] = {
    ...existing,
    access_token: normalizeOAuthAccessToken(data.access_token),
    refresh_token: data.refresh_token || existing.refresh_token,
    expires_at: Date.now() + expiresIn * 1000,
    scope: data.scope || existing.scope || provider.scopes.join(' '),
    token_type: data.token_type || existing.token_type || 'Bearer',
    updated_at: Date.now()
  };

  return { accessToken: normalizeOAuthAccessToken(data.access_token), refreshed: true, reason: '' };
}

async function providerAccess(req, providerName, store) {
  const token = store.providers?.[providerName];
  if (!token?.access_token) return { accessToken: '', refreshed: false, reason: 'not_connected' };
  if (!token.expires_at || Date.now() <= token.expires_at - 30000) {
    return { accessToken: token.access_token, refreshed: false, reason: '' };
  }
  if (!token.refresh_token) return { accessToken: '', refreshed: false, reason: 'expired_without_refresh_token' };
  return refreshProviderAccessToken(providerName, store);
}

async function getMcpTools(req, body) {
  const tools = [];
  const store = await readOAuthStoreAsync(req);
  let refreshed = false;
  const providerCache = new Map();
  const selectedConnectorIds = effectiveConnectorIdsForBody(body);
  for (const id of selectedConnectorIds) {
    const connector = CONNECTORS[id];
    if (!connector) continue;
    if (!providerCache.has(connector.provider)) {
      providerCache.set(connector.provider, await providerAccess(req, connector.provider, store));
    }
    const tokenState = providerCache.get(connector.provider);
    refreshed = refreshed || Boolean(tokenState.refreshed);
    const token = tokenState.accessToken;
    if (!token) {
      const refreshedCookies = refreshed ? await writeOAuthStoreAsync(req, store) : [];
      throw Object.assign(new Error(`OAuth requerido para ${connector.label}`), {
        status: 401,
        oauth_provider: connector.provider,
        oauth_url: oauthStartUrl(req, connector.provider),
        oauth_reason: tokenState.reason,
        oauth_status: publicTokenMeta(store.providers?.[connector.provider], connector.provider),
        refreshed_cookies: refreshedCookies
      });
    }
    const scopeText = store.providers?.[connector.provider]?.scope || '';
    const requiredScopes = CONNECTOR_SCOPE_REQUIREMENTS[id] || [];
    const missing = missingScopes(scopeText, requiredScopes);
    if (missing.length) {
      throw Object.assign(new Error(`Faltan permisos de OAuth para ${connector.label}. Reconecta ${OAUTH_PROVIDERS[connector.provider]?.label || connector.provider}.`), {
        status: 401,
        oauth_provider: connector.provider,
        oauth_url: oauthStartUrl(req, connector.provider),
        oauth_reason: 'missing_scopes',
        oauth_status: publicTokenMeta(store.providers?.[connector.provider], connector.provider),
        diagnostic: {
          connector: id,
          connector_id: connector.connector_id,
          required_scopes: requiredScopes,
          missing_scopes: missing
        }
      });
    }
    tools.push({
      type: 'mcp',
      server_label: id,
      connector_id: connector.connector_id,
      authorization: normalizeOAuthAccessToken(token),
      require_approval: process.env.MCP_REQUIRE_APPROVAL || 'never'
    });
  }

  const remoteServers = remoteMcpServersForBody(body);
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
    if (server.authorization) tool.authorization = String(server.authorization).trim();
    tools.push(tool);
  }

  return {
    tools,
    refreshed_cookies: refreshed ? await writeOAuthStoreAsync(req, store) : []
  };
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

  const response = await fetchWithTimeout(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${keyInfo.value}`
    },
    body: JSON.stringify(payload)
  }, OPENAI_TIMEOUT_MS);
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

function selectedConnectorEntries(body = {}) {
  const selected = effectiveConnectorIdsForBody(body);
  return selected.map(id => [id, CONNECTORS[id]]).filter(([, connector]) => connector);
}

async function normalizeConnectorOAuthError(error, req, body = {}) {
  if (error?.oauth_provider || !selectedConnectorEntries(body).length) return error;
  const upstreamText = [
    error?.message,
    typeof error?.upstream === 'string' ? error.upstream : JSON.stringify(error?.upstream || {})
  ].join(' ');
  const looksLikeAuth = [401, 403].includes(Number(error?.status))
    || /\b(auth|oauth|token|credential|permission|scope|unauthori[sz]ed|forbidden|not authorized)\b/i.test(upstreamText);
  if (!looksLikeAuth) return error;

  const entries = selectedConnectorEntries(body);
  const mentioned = entries.find(([id, connector]) => upstreamText.includes(id) || upstreamText.includes(connector.connector_id));
  const [, connector] = mentioned || entries[0];
  const provider = connector.provider;
  const providerLabel = OAUTH_PROVIDERS[provider]?.label || provider;
  const store = await readOAuthStoreAsync(req);
  return Object.assign(new Error(`OpenAI no pudo usar los datos de ${connector.label}. Reconecta ${providerLabel} y acepta todos los permisos solicitados.`), {
    status: 401,
    oauth_provider: provider,
    oauth_url: oauthStartUrl(req, provider),
    oauth_reason: 'openai_connector_auth_failed',
    oauth_status: publicTokenMeta(store.providers?.[provider], provider),
    diagnostic: {
      connector: mentioned?.[0] || entries[0]?.[0],
      connector_id: connector.connector_id,
      openai_status: error?.status || null
    },
    upstream: error?.upstream
  });
}

function isImageFile(file = {}) {
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  return type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(name);
}

function isDocumentFile(file = {}) {
  if (isImageFile(file)) return false;
  return Boolean(file?.data_url || file?.file_data);
}

function isSupportedImageUrl(value) {
  const text = String(value || '').trim();
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(text) || /^https:\/\//i.test(text);
}

function isSupportedFileData(value) {
  const text = String(value || '').trim();
  return /^data:[^;]+;base64,/i.test(text) || /^https:\/\//i.test(text);
}

function compactScrapedProfiles(scraped = []) {
  return scraped.map(item => ({
    ok: Boolean(item.ok),
    url: item.url,
    final_url: item.final_url,
    status: item.status,
    title: item.title,
    description: item.description,
    author: item.author,
    published_time: item.published_time,
    modified_time: item.modified_time,
    language: item.language,
    headings: Array.isArray(item.headings) ? item.headings.slice(0, 24) : [],
    topics: Array.isArray(item.topics) ? item.topics.slice(0, 24) : [],
    hashtags: Array.isArray(item.hashtags) ? item.hashtags.slice(0, 32) : [],
    mentions: Array.isArray(item.mentions) ? item.mentions.slice(0, 24) : [],
    text: String(item.text || '').slice(0, 28000),
    links: Array.isArray(item.links) ? item.links.slice(0, 35) : [],
    media: Array.isArray(item.media) ? item.media.slice(0, 24) : [],
    stats: item.stats || {},
    error: item.error
  }));
}

function collectScrapedImages(scraped = []) {
  const images = [];
  const seen = new Set();
  for (const page of scraped) {
    for (const media of Array.isArray(page.media) ? page.media : []) {
      const src = typeof media === 'string' ? media : media?.src;
      if (!src || seen.has(src) || !/^https:\/\//i.test(src)) continue;
      seen.add(src);
      images.push({
        src,
        alt: typeof media === 'string' ? '' : media.alt || '',
        context: typeof media === 'string' ? '' : media.context || '',
        source_url: page.final_url || page.url || ''
      });
    }
  }
  return images;
}

function isEarlyWarningMode(body = {}) {
  return String(body.analysis_mode || '') === EARLY_WARNING_ANALYSIS_MODE
    || Boolean(body.mental_health_early_warning?.enabled);
}

function forceEarlyWarningAnalyzeBody(body = {}) {
  return {
    ...body,
    analysis_mode: EARLY_WARNING_ANALYSIS_MODE,
    mental_health_early_warning: {
      ...(body.mental_health_early_warning && typeof body.mental_health_early_warning === 'object'
        ? body.mental_health_early_warning
        : {}),
      enabled: true,
      purpose: 'non_diagnostic_early_warning'
    }
  };
}

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeCurrentWindows(value) {
  const raw = Array.isArray(value) ? value : DEFAULT_EARLY_WARNING_WINDOWS;
  const allowed = new Set(['24h', '3d', '7d', '30d']);
  const windows = raw.map(String).filter(item => allowed.has(item));
  return windows.length ? [...new Set(windows)] : DEFAULT_EARLY_WARNING_WINDOWS;
}

function normalizeAllowedSources(raw = {}) {
  const out = new Set();
  const sourceInput = raw.allowed_sources || raw.sources || raw.source_categories || [];
  if (Array.isArray(sourceInput)) {
    for (const item of sourceInput) {
      const key = String(item || '').trim();
      if (MENTAL_HEALTH_SOURCE_LABELS[key]) out.add(key);
    }
  } else if (sourceInput && typeof sourceInput === 'object') {
    for (const [key, enabled] of Object.entries(sourceInput)) {
      if (MENTAL_HEALTH_SOURCE_LABELS[key] && normalizeBoolean(enabled)) out.add(key);
    }
  }
  return [...out];
}

function normalizeMentalHealthOptions(body = {}) {
  const raw = body.mental_health_early_warning && typeof body.mental_health_early_warning === 'object'
    ? body.mental_health_early_warning
    : {};
  return {
    enabled: isEarlyWarningMode(body),
    consent_confirmed: normalizeBoolean(raw.consent_confirmed) || normalizeBoolean(body.consent_confirmed),
    allowed_sources: normalizeAllowedSources(raw),
    baseline_days: Math.min(Math.max(positiveInt(raw.baseline_days, 90), 30), 365),
    current_windows: normalizeCurrentWindows(raw.current_windows),
    purpose: String(raw.purpose || 'non_diagnostic_early_warning').slice(0, 120)
  };
}

function hasAnalysisData(body = {}) {
  return Boolean(
    String(body.central_text || body.case_text || '').trim()
    || String(body.notes || '').trim()
    || body.central_document
    || (Array.isArray(body.files) && body.files.length)
    || (Array.isArray(body.connector_ids) && body.connector_ids.length)
    || normalizeUrlList(body.profile_urls || []).length
    || (Array.isArray(body.remote_mcp_servers) && body.remote_mcp_servers.length)
    || (Array.isArray(body.mcp_servers) && body.mcp_servers.length)
  );
}

function requiresMentalHealthConsent(body = {}) {
  return isEarlyWarningMode(body) || hasAnalysisData(body);
}

function assertMentalHealthConsent(body = {}) {
  const options = normalizeMentalHealthOptions(body);
  if (requiresMentalHealthConsent(body) && !options.consent_confirmed) {
    throw Object.assign(new Error('Consentimiento explicito requerido antes de analizar datos personales o conectados.'), {
      status: 400,
      consent_required: true,
      diagnostic: {
        consent_status: 'not_confirmed',
        source_categories: Object.keys(MENTAL_HEALTH_SOURCE_LABELS)
      }
    });
  }
  const violations = dataSourceConsentViolations(body, options);
  if (violations.length) {
    throw Object.assign(new Error('Hay datos o conectores seleccionados sin permiso explicito de fuente.'), {
      status: 400,
      consent_required: true,
      diagnostic: {
        consent_status: options.consent_confirmed ? 'confirmed' : 'not_confirmed',
        allowed_sources: options.allowed_sources,
        source_consent_violations: violations
      }
    });
  }
  return options;
}

function sourceAllowed(options, source) {
  return new Set(options.allowed_sources || []).has(source);
}

function connectorAllowedForMentalHealth(id, options) {
  if (!options?.enabled) return true;
  const requiredSources = CONNECTOR_MENTAL_HEALTH_SOURCES[id] || [];
  if (!requiredSources.length) return false;
  return requiredSources.some(source => sourceAllowed(options, source));
}

function dataSourceConsentViolations(body = {}, options = normalizeMentalHealthOptions(body)) {
  if (!options.enabled) return [];
  const violations = [];
  const hasCentralText = Boolean(String(body.central_text || body.case_text || '').trim());
  const hasNotes = Boolean(String(body.notes || '').trim());
  const centralDocument = body.central_document && typeof body.central_document === 'object' ? body.central_document : null;
  const files = Array.isArray(body.files) ? body.files : [];
  const profileUrls = normalizeUrlList(body.profile_urls || []);
  const remoteServers = Array.isArray(body.remote_mcp_servers)
    ? body.remote_mcp_servers
    : Array.isArray(body.mcp_servers)
      ? body.mcp_servers
      : [];
  const selected = Array.isArray(body.connector_ids) ? body.connector_ids.filter(id => CONNECTORS[id]) : [];

  if (hasCentralText && !sourceAllowed(options, 'notes') && !sourceAllowed(options, 'uploaded_files')) {
    violations.push({
      source: 'notes',
      reason: 'central_text_present',
      message: 'El texto central requiere permiso explicito de Notas/Drive o Archivos.'
    });
  }
  if (hasNotes && !sourceAllowed(options, 'notes')) {
    violations.push({
      source: 'notes',
      reason: 'notes_present',
      message: 'Las notas requieren permiso explicito de Notas/Drive.'
    });
  }
  if ((centralDocument || files.length) && !sourceAllowed(options, 'uploaded_files')) {
    violations.push({
      source: 'uploaded_files',
      reason: 'files_present',
      message: 'Los documentos o archivos subidos requieren permiso explicito de Archivos.'
    });
  }
  if (profileUrls.length && !sourceAllowed(options, 'public_profiles')) {
    violations.push({
      source: 'public_profiles',
      reason: 'profile_urls_present',
      message: 'Los perfiles publicos requieren permiso explicito y no deben usarse para terceros sin consentimiento.'
    });
  }
  if (remoteServers.length && !sourceAllowed(options, 'remote_mcp')) {
    violations.push({
      source: 'remote_mcp',
      reason: 'remote_mcp_present',
      message: 'Los servidores MCP remotos requieren permiso explicito.'
    });
  }

  for (const id of selected) {
    const requiredSources = CONNECTOR_MENTAL_HEALTH_SOURCES[id] || [];
    if (!requiredSources.length || !requiredSources.some(source => sourceAllowed(options, source))) {
      violations.push({
        connector_id: id,
        connector_label: CONNECTORS[id]?.label || id,
        required_any_source: requiredSources,
        reason: 'connector_source_not_allowed',
        message: `${CONNECTORS[id]?.label || id} requiere habilitar al menos una fuente compatible: ${requiredSources.join(', ')}.`
      });
    }
  }

  return violations;
}

function effectiveConnectorIdsForBody(body = {}) {
  const selected = Array.isArray(body.connector_ids) ? body.connector_ids.filter(id => CONNECTORS[id]) : [];
  const options = normalizeMentalHealthOptions(body);
  if (!options.enabled) return selected;
  return selected.filter(id => connectorAllowedForMentalHealth(id, options));
}

function skippedConnectorIdsForBody(body = {}) {
  const selected = Array.isArray(body.connector_ids) ? body.connector_ids.filter(id => CONNECTORS[id]) : [];
  const effective = new Set(effectiveConnectorIdsForBody(body));
  return selected.filter(id => !effective.has(id));
}

function profileUrlsForBody(body = {}) {
  const urls = normalizeUrlList(body.profile_urls || []);
  const options = normalizeMentalHealthOptions(body);
  if (options.enabled && !sourceAllowed(options, 'public_profiles')) return [];
  return urls;
}

function remoteMcpServersForBody(body = {}) {
  const servers = Array.isArray(body.remote_mcp_servers)
    ? body.remote_mcp_servers
    : Array.isArray(body.mcp_servers)
      ? body.mcp_servers
      : [];
  const options = normalizeMentalHealthOptions(body);
  if (options.enabled && !sourceAllowed(options, 'remote_mcp')) return [];
  return servers;
}

function mentalHealthTextEvidenceAllowed(body = {}) {
  const options = normalizeMentalHealthOptions(body);
  if (!options.enabled) return true;
  return sourceAllowed(options, 'notes') || sourceAllowed(options, 'uploaded_files') || sourceAllowed(options, 'chat_history');
}

function normalizeDailyMetrics(raw) {
  const input = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? raw : null;
  if (!input) return null;
  const out = {};

  if (Array.isArray(input)) {
    for (const row of input) {
      if (!row || typeof row !== 'object') continue;
      for (const [key, value] of Object.entries(row)) {
        if (key === 'date') continue;
        const number = Number(value);
        if (!Number.isFinite(number)) continue;
        if (!out[key]) out[key] = [];
        out[key].push(number);
      }
    }
  } else {
    for (const [key, values] of Object.entries(input)) {
      if (!Array.isArray(values)) continue;
      const series = values.map(Number).filter(Number.isFinite);
      if (series.length) out[key] = series;
    }
  }

  return Object.keys(out).length ? out : null;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = (sortedValues.length - 1) * percentileValue;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedValues[lower];
  const weight = rank - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function zScoreSummary(series, threshold = 2) {
  if (series.length < 5) return { error: 'not_enough_data', n: series.length, minimum_required: 5 };
  const avg = mean(series);
  const sd = stdev(series);
  if (!sd) return { anomalies: {}, threshold, mean: avg, std: null, note: 'No variance detected.' };
  const anomalies = {};
  const recent_z_scores = {};
  series.forEach((value, index) => {
    const z = (value - avg) / sd;
    if (Math.abs(z) > threshold) anomalies[index] = value;
    if (index >= series.length - 14) recent_z_scores[index] = Number(z.toFixed(3));
  });
  return { anomalies, recent_z_scores, threshold, mean: Number(avg.toFixed(3)), std: Number(sd.toFixed(3)) };
}

function iqrSummary(series, multiplier = 1.5) {
  if (series.length < 5) return { error: 'not_enough_data', n: series.length, minimum_required: 5 };
  const sorted = [...series].sort((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  if (!iqr) return { anomalies: {}, bounds: { lower: q1, upper: q3 }, iqr: null, note: 'No IQR variability detected.' };
  const lower = q1 - multiplier * iqr;
  const upper = q3 + multiplier * iqr;
  const anomalies = {};
  series.forEach((value, index) => {
    if (value < lower || value > upper) anomalies[index] = value;
  });
  return {
    anomalies,
    bounds: { lower: Number(lower.toFixed(3)), upper: Number(upper.toFixed(3)) },
    iqr: Number(iqr.toFixed(3))
  };
}

function rollingSummary(series, window = 7, threshold = 2) {
  if (series.length < window + 3) return { error: 'not_enough_data', n: series.length, minimum_required: window + 3 };
  const anomalies = {};
  const recent_deviations = {};
  for (let index = window; index < series.length; index += 1) {
    const prior = series.slice(index - window, index);
    const sd = stdev(prior);
    if (!sd) continue;
    const z = (series[index] - mean(prior)) / sd;
    if (Math.abs(z) > threshold) anomalies[index] = series[index];
    if (index >= series.length - 14) recent_deviations[index] = Number(z.toFixed(3));
  }
  return { anomalies, recent_deviations, window, threshold };
}

function detectBehavioralAnomalies(metrics) {
  if (!metrics) return null;
  const metricResults = {};
  let anomalyCount = 0;
  let sensitiveAnomalyCount = 0;

  for (const [metric, series] of Object.entries(metrics)) {
    const clean = series.map(Number).filter(Number.isFinite);
    if (clean.length < 5) {
      metricResults[metric] = { error: 'not_enough_data', n: clean.length };
      continue;
    }
    const result = {
      z_score: zScoreSummary(clean),
      iqr: iqrSummary(clean),
      rolling: rollingSummary(clean)
    };
    const hasAnomaly = ['z_score', 'iqr', 'rolling'].some(method => Object.keys(result[method]?.anomalies || {}).length);
    if (hasAnomaly) {
      anomalyCount += 1;
      if (HIGH_RISK_METRICS.has(metric)) sensitiveAnomalyCount += 1;
    }
    metricResults[metric] = result;
  }

  const riskFlag = sensitiveAnomalyCount >= 3
    ? 'high'
    : sensitiveAnomalyCount >= 1 || anomalyCount >= 2
      ? 'moderate'
      : 'low';

  return {
    metrics: metricResults,
    summary: {
      risk_flag: riskFlag,
      anomaly_count: anomalyCount,
      sensitive_anomaly_count: sensitiveAnomalyCount,
      note: 'Behavioral risk flag only; not a diagnosis or prediction.'
    }
  };
}

function dailyMetricsFromBody(body = {}) {
  const raw = body.mental_health_early_warning?.daily_metrics || body.daily_metrics || null;
  return normalizeDailyMetrics(raw);
}

function buildMentalHealthContext(body = {}, scraped = []) {
  const options = normalizeMentalHealthOptions(body);
  const selected = Array.isArray(body.connector_ids) ? body.connector_ids.filter(id => CONNECTORS[id]) : [];
  const effective = effectiveConnectorIdsForBody(body);
  const skipped = skippedConnectorIdsForBody(body);
  const metricInput = dailyMetricsFromBody(body);
  return {
    skill: 'mental-health-early-warning-analysis',
    enabled: options.enabled,
    consent_status: options.consent_confirmed ? 'confirmed' : 'not_confirmed',
    purpose: options.purpose,
    non_diagnostic: true,
    allowed_sources: options.allowed_sources.map(source => ({
      id: source,
      label: MENTAL_HEALTH_SOURCE_LABELS[source] || source
    })),
    baseline_window_days: options.baseline_days,
    current_windows: options.current_windows,
    source_policy: {
      minimize_data: true,
      prefer_aggregates: true,
      email_text_allowed: sourceAllowed(options, 'email_text'),
      notes_text_allowed: sourceAllowed(options, 'notes'),
      chat_history_allowed: sourceAllowed(options, 'chat_history'),
      uploaded_files_allowed: sourceAllowed(options, 'uploaded_files'),
      public_profiles_allowed: sourceAllowed(options, 'public_profiles'),
      location_allowed: sourceAllowed(options, 'location'),
      wearables_allowed: sourceAllowed(options, 'wearables'),
      sleep_logs_allowed: sourceAllowed(options, 'sleep_logs')
    },
    connectors: {
      requested: selected,
      effective,
      skipped_due_to_consent: skipped,
      tool_use_rules: effective.map(id => ({
        id,
        label: CONNECTORS[id].label,
        allowed_source_categories: CONNECTOR_MENTAL_HEALTH_SOURCES[id] || [],
        raw_text_allowed: ['gmail', 'outlook'].includes(id)
          ? sourceAllowed(options, 'email_text')
          : id === 'teams'
            ? sourceAllowed(options, 'chat_history')
            : ['google_drive', 'sharepoint'].includes(id)
              ? sourceAllowed(options, 'notes') || sourceAllowed(options, 'uploaded_files')
              : false
      }))
    },
    public_profiles_used: profileUrlsForBody(body).length,
    scraped_count: Array.isArray(scraped) ? scraped.length : 0,
    deterministic_anomaly_summary: detectBehavioralAnomalies(metricInput)
  };
}

function mentalHealthInstructions(body = {}) {
  if (!isEarlyWarningMode(body)) {
    return [
      'PsychApp mental-health safety boundary:',
      '- Treat psychological outputs as non-diagnostic reflection support, not clinical care.',
      '- Do not claim certainty, make diagnoses, or predict relapse/crisis as fact.',
      '- Avoid employment, insurance, legal, or clinical-access decisions.',
      '- When using connected data, minimize private content and summarize aggregate patterns where possible.',
      '- If acute danger appears, stop ordinary analysis and give direct crisis guidance.'
    ].join('\n');
  }

  return [
    'MENTAL HEALTH EARLY WARNING ANALYSIS SKILL ACTIVE.',
    'Scope: consent-based, user-facing early warning analysis of behavioral deviations. This is not diagnosis, treatment, or a replacement for professional care.',
    'Hard boundaries: never diagnose mental disorders or substance-use relapse; never claim a definite relapse or crisis prediction; never analyze third parties without consent; never expose raw private content when aggregate metrics are enough.',
    'Consent and minimization: use only the source categories marked allowed in the JSON context. Prefer counts, timestamps, completion rates, contact diversity, routine proxies, and aggregated language signals. Email text, notes, chat history, wearables, sleep logs, and location require explicit source permission.',
    'Baseline: build a user-specific baseline from the requested historical window, preferring 90 days or longer when available and 30 days as the minimum. Compare current 24h, 3d, 7d, and 30d windows when possible.',
    'Methods: use rolling averages, z-scores, IQR outliers, and sequence patterns when numeric data supports it. Important patterns include routine disruption followed by isolation, isolation followed by task collapse, negative language plus late-night activity, substance references plus reduced routine, and missed appointments plus reduced social engagement.',
    'Risk flag rubric: Low means minor deviations; Moderate means meaningful sustained deviations; High means multiple convergent deviations involving sleep/routine, isolation, negative or hopeless language, substance cues, missed obligations, or loss of routine; Acute means imminent danger and must stop ordinary analytics.',
    'For Acute risk: encourage immediate human contact, emergency services if danger is imminent, clinical team contact if available, moving away from means/substances/hazards, and staying engaged. If the user is in Spain mention 112 for emergency danger and 024 for suicidal thoughts or crisis containment.',
    'Output in Spanish with this markdown structure: ## Mental Health Early Warning Report; Consent status; Data sources analyzed; Time window; Baseline window; Overall risk flag Low/Moderate/High/Acute; Confidence; Main changes detected; Evidence chain; Protective factors still present; Possible vulnerability pattern; Recommended next 24 hours; When to escalate.',
    'Use language such as possible increased risk, behavioral deviation, early warning signal, and risk flag. Avoid diagnosis, definite relapse, you are relapsing, or the model predicts.'
  ].join('\n');
}

function acuteRiskDetected(body = {}) {
  const text = [
    body.central_text,
    body.case_text,
    body.notes,
    body.input,
    body.prompt,
    ...(Array.isArray(body.messages) ? body.messages.map(message => message?.content || '') : []),
    ...(Array.isArray(body.files) ? body.files.map(file => file?.text || '') : [])
  ].join('\n').toLowerCase();
  if (!text.trim()) return false;
  return /\b(me voy a suicidar|quiero suicidarme|plan para suicid|me voy a matar|quiero matarme|no puedo mantenerme a salvo|no puedo estar a salvo|self[-\s]?harm plan|suicide plan|kill myself|cannot stay safe|overdose tonight|sobredosis hoy|violencia inminente)\b/i.test(text);
}

function acuteRiskGuidance(consentStatus = 'Not required for safety guidance') {
  return [
    '## Mental Health Early Warning Report',
    '',
    `**Consent status:** ${consentStatus}`,
    '**Overall risk flag:** Acute',
    '**Confidence:** Medium',
    '',
    'Hay una senal de posible peligro inmediato. No voy a continuar con analisis ordinario de datos.',
    '',
    '### Recommended next 24 hours',
    '',
    '1. Contacta ahora con una persona de confianza y dile que necesitas acompanamiento inmediato.',
    '2. Si hay peligro inminente, llama a emergencias. En Espana, llama al 112.',
    '3. Si aparecen pensamientos suicidas o necesitas contencion de crisis en Espana, llama al 024.',
    '4. Alejate de medios, sustancias u otros riesgos inmediatos mientras contactas con ayuda humana.',
    '5. Si tienes equipo clinico, contactalo ahora o acude a urgencias.',
    '',
    '### When to escalate',
    '',
    'Escala inmediatamente si no puedes mantenerte a salvo, hay un plan concreto, intoxicacion severa, abstinencia peligrosa, psicosis, violencia inminente o peligro medico.'
  ].join('\n');
}

function buildAnalysisPrompt(req, body, scraped, tools = []) {
  const files = Array.isArray(body.files) ? body.files : [];
  const includeTextEvidence = mentalHealthTextEvidenceAllowed(body);
  const notes = includeTextEvidence ? String(body.notes || '').trim() : '';
  const centralText = includeTextEvidence ? String(body.central_text || body.case_text || '').trim() : '';
  const centralDocument = body.central_document && typeof body.central_document === 'object' ? body.central_document : null;
  const analysisMode = String(body.analysis_mode || EARLY_WARNING_ANALYSIS_MODE);
  const selected = Array.isArray(body.connector_ids) ? body.connector_ids : [];
  const mentalHealthContext = buildMentalHealthContext(body, scraped);
  const allFiles = includeTextEvidence ? (centralDocument ? [centralDocument, ...files] : files) : [];
  const textFiles = allFiles.filter(file => !isImageFile(file) && !isDocumentFile(file));
  const imageFiles = allFiles.filter(isImageFile).slice(0, MAX_UPLOADED_IMAGES_FOR_VISION);
  const documentFiles = allFiles.filter(isDocumentFile).slice(0, MAX_UPLOADED_DOCUMENTS_FOR_MODEL);
  const fileSummaries = textFiles.slice(0, 12).map(file => ({
    name: String(file.name || 'archivo'),
    type: String(file.type || ''),
    size: Number(file.size || 0),
    role: file === centralDocument || String(file.kind || '').startsWith('central') ? 'central' : 'evidence',
    text: String(file.text || '').slice(0, file === centralDocument ? 60000 : 16000)
  }));
  const imageSummaries = imageFiles.map(file => ({
    name: String(file.name || 'imagen'),
    type: String(file.type || ''),
    size: Number(file.size || 0),
    has_inline_image: Boolean(file.data_url || file.url)
  }));
  const scrapedImages = collectScrapedImages(scraped).slice(0, MAX_SCRAPED_IMAGES_FOR_VISION);
  const content = [
    {
      type: 'input_text',
      text: JSON.stringify({
        task: isEarlyWarningMode(body)
          ? 'Crear un informe no diagnostico de alerta temprana de cambios conductuales con consentimiento, datos minimizados y recomendaciones preventivas.'
          : 'Analizar patrones personales a partir de fuentes conectadas, archivos exportados, imagenes subidas y perfiles publicos scrapeados.',
        analysis_mode: analysisMode,
        mental_health_early_warning: mentalHealthContext,
        central_text: centralText.slice(0, 90000),
        central_document: includeTextEvidence && centralDocument ? {
          name: String(centralDocument.name || ''),
          type: String(centralDocument.type || ''),
          size: Number(centralDocument.size || 0),
          kind: String(centralDocument.kind || ''),
          text_preview: includeTextEvidence ? String(centralDocument.text || '').slice(0, 30000) : '',
          attached_to_model: includeTextEvidence && Boolean(centralDocument.data_url || centralDocument.file_data)
        } : null,
        notes,
        selected_connectors: selected,
        effective_connectors: effectiveConnectorIdsForBody(body),
        skipped_connectors_due_to_consent: skippedConnectorIdsForBody(body),
        files: fileSummaries,
        attached_documents: documentFiles.map(file => ({
          name: String(file.name || 'documento'),
          type: String(file.type || ''),
          size: Number(file.size || 0),
          role: file === centralDocument || String(file.kind || '').startsWith('central') ? 'central' : 'evidence'
        })),
        uploaded_images: imageSummaries,
        scraped_public_images_sent_to_vision: scrapedImages.map(image => ({
          url: image.src,
          alt: image.alt,
          context: image.context,
          source_url: image.source_url
        })),
        scraped_profiles: sourceAllowed(normalizeMentalHealthOptions(body), 'public_profiles') || !isEarlyWarningMode(body)
          ? compactScrapedProfiles(scraped)
          : []
      }, null, 2)
    }
  ];

  for (const file of imageFiles) {
    const imageUrl = String(file.data_url || file.url || '').trim();
    if (isSupportedImageUrl(imageUrl)) content.push({ type: 'input_image', image_url: imageUrl });
  }
  for (const file of documentFiles) {
    const fileData = String(file.file_data || file.data_url || file.url || '').trim();
    if (isSupportedFileData(fileData)) {
      content.push({
        type: 'input_file',
        filename: String(file.name || 'documento'),
        file_data: fileData
      });
    }
  }
  for (const image of scrapedImages) {
    if (isSupportedImageUrl(image.src)) content.push({ type: 'input_image', image_url: image.src });
  }

  return {
    model: body.model || DEFAULT_MODEL,
    instructions: [
      mentalHealthInstructions(body),
      'Eres PsychApp, una herramienta de apoyo para reflexión psicológica estructurada.',
      'No diagnostiques ni sustituyas evaluacion clinica. Senala incertidumbre, limites, contraevidencia y riesgos. Si hay pocos datos, aun asi formula hipotesis utiles, pero graduadas por confianza.',
      'El documento central o texto pegado tiene maxima prioridad. Usa notas, adjuntos, conectores y scraping como evidencia auxiliar o contraste.',
      'Trabaja de forma rigurosa: distingue observaciones, inferencias, hipotesis clinicas, factores de personalidad, patrones temporales, factores de riesgo/proteccion y recomendaciones prudentes.',
      'Describe imagenes subidas y publicas sin identificar personas ni inferir atributos sensibles. Centrate en escena, objetos, actividad, texto visible, tono visual y limites de confianza.',
      'El scraping debe resumir temas tratados, relatos recurrentes, senales temporales, hashtags, enlaces relevantes, contenido visual y evidencias por URL; no te limites a contar posts o metadatos.',
      isEarlyWarningMode(body)
        ? 'Devuelve en espanol solo con la plantilla Mental Health Early Warning Report definida por el skill, sin secciones de personalidad ni formulacion clinica.'
        : 'Devuelve en espanol con secciones: resumen ejecutivo, fuentes usadas, evidencia central, temas y patrones, analisis de personalidad/formulacion, hipotesis con confianza, contraevidencias, preguntas clinicas utiles, proximos pasos y limites.'
    ].join('\n'),
    input: [
      {
        role: 'user',
        content
      }
    ],
    tools,
    max_output_tokens: positiveInt(body.max_output_tokens, 4500),
    store: process.env.OPENAI_STORE === 'true'
  };
}

function safeMetadataValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 700 ? `${value.slice(0, 700)}...` : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => safeMetadataValue(item, depth + 1));
  if (typeof value !== 'object') return String(value);
  if (depth >= 4) return '[truncated]';

  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 60)) {
    if (typeof item === 'function' || typeof item === 'undefined') continue;
    out[key] = safeMetadataValue(item, depth + 1);
  }
  return out;
}

function analysisRequestMeta(body = {}, scraped = []) {
  const files = Array.isArray(body.files) ? body.files : [];
  const selected = Array.isArray(body.connector_ids) ? body.connector_ids.filter(id => CONNECTORS[id]) : [];
  const effective = effectiveConnectorIdsForBody(body);
  const options = normalizeMentalHealthOptions(body);
  const profileUrls = profileUrlsForBody(body);
  const centralDocument = body.central_document && typeof body.central_document === 'object' ? body.central_document : null;
  const scrapedImages = collectScrapedImages(Array.isArray(scraped) ? scraped : []);
  return {
    analysis_mode: String(body.analysis_mode || EARLY_WARNING_ANALYSIS_MODE),
    connector_ids: selected,
    effective_connector_ids: effective,
    skipped_connector_ids: skippedConnectorIdsForBody(body),
    connector_count: effective.length,
    consent_required: requiresMentalHealthConsent(body),
    consent_confirmed: options.consent_confirmed,
    mental_health_early_warning: options.enabled,
    mental_health_allowed_sources: options.allowed_sources,
    baseline_days: options.baseline_days,
    current_windows: options.current_windows,
    notes_present: Boolean(String(body.notes || '').trim()),
    notes_chars: String(body.notes || '').length,
    central_text_present: Boolean(String(body.central_text || body.case_text || '').trim()),
    central_text_chars: String(body.central_text || body.case_text || '').length,
    central_document_present: Boolean(centralDocument),
    central_document_type: centralDocument ? String(centralDocument.type || '') : '',
    central_document_size: centralDocument ? Number(centralDocument.size || 0) : 0,
    file_count: files.length,
    image_file_count: files.filter(isImageFile).length,
    document_file_count: files.filter(isDocumentFile).length,
    text_file_count: files.filter(file => !isImageFile(file) && !isDocumentFile(file)).length,
    profile_url_count: profileUrls.length,
    profile_urls: profileUrls.slice(0, 12),
    scraped_count: Array.isArray(scraped) ? scraped.length : 0,
    scraped_ok_count: Array.isArray(scraped) ? scraped.filter(item => item?.ok).length : 0,
    scraped_image_count: scrapedImages.length
  };
}

function clientIdHash(req) {
  if (!req) return '';
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const basis = [
    forwarded,
    req.socket?.remoteAddress || '',
    req.headers['user-agent'] || '',
    process.env.PUBLIC_BASE_URL || APP_BASE_PATH || '/'
  ].join('|');
  if (!basis.replace(/\|/g, '').trim()) return '';
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 40);
}

async function supabaseInsert(table, row) {
  const allowedTables = new Set(['psychapp_runs', 'psychapp_mcp_oauth_audit']);
  if (!allowedTables.has(table)) return { ok: false, skipped: true, reason: 'Tabla Supabase no permitida' };

  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseKey = getSupabaseKeyWithMeta();
  if (!supabaseUrl || !supabaseKey.value) return { ok: false, skipped: true, reason: 'Supabase no configurado' };

  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey.value,
      Authorization: `Bearer ${supabaseKey.value}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(row)
  }, SUPABASE_TIMEOUT_MS);

  if (!response.ok) {
    const text = await response.text();
    return { ok: false, skipped: false, status: response.status, message: text.slice(0, 400) };
  }
  return { ok: true, skipped: false };
}

async function logPsychappEvent(req, eventType, metadata = {}) {
  try {
    const safeMetadata = safeMetadataValue({
      app_path: APP_BASE_PATH || '/',
      ...metadata
    }) || {};
    const result = await supabaseInsert('psychapp_mcp_oauth_audit', {
      event_type: eventType,
      subject: String(safeMetadata.subject || safeMetadata.analysis_mode || APP_BASE_PATH || '/').slice(0, 180),
      client_id_hash: clientIdHash(req),
      tool_name: Array.isArray(safeMetadata.connector_ids) ? safeMetadata.connector_ids.join(',').slice(0, 180) : String(safeMetadata.tool_name || '').slice(0, 180),
      resource: String(safeMetadata.resource || safeMetadata.route || APP_BASE_PATH || '/').slice(0, 300),
      scopes: Array.isArray(safeMetadata.scopes) ? safeMetadata.scopes.map(String).slice(0, 40) : null,
      metadata: safeMetadata
    });
    if (!result.ok && !result.skipped) {
      console.warn('[audit] Supabase insert failed:', result.status || '', result.message || result.reason || '');
    }
    return result;
  } catch (error) {
    console.warn('[audit] Supabase insert error:', error?.message || error);
    return { ok: false, skipped: false, message: error?.message || String(error) };
  }
}

function trackPsychappEvent(req, eventType, metadata = {}) {
  logPsychappEvent(req, eventType, metadata);
}

function analysisErrorMeta(error = {}) {
  return {
    status: Number(error.status || 500),
    message: String(error.message || 'Analysis error').slice(0, 500),
    oauth_provider: error.oauth_provider || '',
    oauth_reason: error.oauth_reason || '',
    oauth_diagnostic: error.diagnostic || null,
    consent_required: Boolean(error.consent_required),
    openai_error_code: error.upstream?.error?.code || '',
    openai_error_type: error.upstream?.error?.type || '',
    openai_status: error.upstream?.error?.status || error.upstream?.status || null
  };
}

async function handleAnalyze(req, res) {
  let body = {};
  const requestId = randomUrlSafe(10);
  try {
    body = forceEarlyWarningAnalyzeBody(await readJsonBody(req));
    if (acuteRiskDetected(body)) {
      const mentalHealthOptions = normalizeMentalHealthOptions(body);
      const output_text = acuteRiskGuidance(mentalHealthOptions.consent_confirmed ? 'Confirmed' : 'Not required for immediate safety guidance');
      await logPsychappEvent(req, 'psychapp.analyze.acute_guidance', {
        request_id: requestId,
        route: '/api/analyze',
        ...analysisRequestMeta(body, []),
        mental_health: {
          consent_status: mentalHealthOptions.consent_confirmed ? 'confirmed' : 'not_confirmed',
          early_warning: isEarlyWarningMode(body),
          acute_guidance: true
        }
      });
      return sendJson(res, 200, {
        ok: true,
        provider: 'psychapp-safety',
        model: 'deterministic-crisis-guidance',
        output_text,
        scraped: [],
        mental_health: buildMentalHealthContext(body, []),
        saved: { ok: false, skipped: true, reason: 'acute_guidance_not_stored' },
        raw_id: null,
        raw_status: 'acute_guidance'
      });
    }
    const mentalHealthOptions = assertMentalHealthConsent(body);
    const profileUrls = profileUrlsForBody(body);
    const scraped = [];
    for (const url of profileUrls.slice(0, 12)) scraped.push(await scrapeOne(url));
    await logPsychappEvent(req, 'psychapp.analyze.started', {
      request_id: requestId,
      route: '/api/analyze',
      ...analysisRequestMeta(body, scraped)
    });

    const mcp = await getMcpTools(req, body);
    const payload = buildAnalysisPrompt(req, body, scraped, mcp.tools);
    if (!payload.tools?.length) delete payload.tools;
    const openai = await callOpenAI(req, payload);
    const output_text = extractOutputText(openai);
    const save = await saveAnalysisRun({ req, body, scraped, openai, output_text });
    await logPsychappEvent(req, 'psychapp.analyze.completed', {
      request_id: requestId,
      route: '/api/analyze',
      ...analysisRequestMeta(body, scraped),
      model: payload.model,
      openai_id: openai.id || null,
      openai_status: openai.status || null,
      saved: save
    });

    return sendJson(res, 200, {
      ok: true,
      provider: 'openai',
      model: payload.model,
      output_text,
      scraped,
      mental_health: buildMentalHealthContext(body, scraped),
      saved: save,
      raw_id: openai.id || null,
      raw_status: openai.status || null
    }, mcp.refreshed_cookies?.length ? { 'Set-Cookie': mcp.refreshed_cookies } : {});
  } catch (error) {
    const normalizedError = await normalizeConnectorOAuthError(error, req, body);
    await logPsychappEvent(req, 'psychapp.analyze.error', {
      request_id: requestId,
      route: '/api/analyze',
      ...analysisRequestMeta(body, []),
      ...analysisErrorMeta(normalizedError),
      scopes: normalizedError.oauth_status?.required_scopes || []
    });
    const headers = normalizedError.refreshed_cookies?.length ? { 'Set-Cookie': normalizedError.refreshed_cookies } : {};
    return sendJson(res, normalizedError.status || 500, {
      ok: false,
      error: {
        message: normalizedError.message || 'Analysis error',
        oauth_provider: normalizedError.oauth_provider,
        oauth_url: normalizedError.oauth_url,
        oauth_reason: normalizedError.oauth_reason,
        oauth_status: normalizedError.oauth_status,
        consent_required: Boolean(normalizedError.consent_required),
        diagnostic: normalizedError.diagnostic,
        upstream: normalizedError.upstream
      }
    }, headers);
  }
}

async function handleMessages(req, res) {
  let body = {};
  try {
    body = await readJsonBody(req);
    if (acuteRiskDetected(body)) {
      return sendJson(res, 200, {
        content: [{ type: 'text', text: acuteRiskGuidance('Not required for immediate safety guidance') }],
        provider: 'psychapp-safety',
        raw_id: null,
        raw_status: 'acute_guidance'
      });
    }
    const mentalHealthOptions = requiresMentalHealthConsent(body) ? assertMentalHealthConsent(body) : normalizeMentalHealthOptions(body);
    const input = Array.isArray(body.messages)
      ? body.messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }))
      : [{ role: 'user', content: String(body.input || body.prompt || '') }];
    const instructions = [
      requiresMentalHealthConsent(body) || mentalHealthOptions.enabled ? mentalHealthInstructions(body) : '',
      body.system || ''
    ].filter(Boolean).join('\n\n');
    const payload = {
      model: body.model || DEFAULT_MODEL,
      instructions: instructions || undefined,
      input,
      tools: [],
      max_output_tokens: positiveInt(body.max_output_tokens || body.max_tokens, 1800),
      store: process.env.OPENAI_STORE === 'true'
    };
    const mcp = await getMcpTools(req, body);
    payload.tools = mcp.tools;
    if (!payload.tools.length) delete payload.tools;
    const openai = await callOpenAI(req, payload);
    return sendJson(res, 200, {
      content: [{ type: 'text', text: extractOutputText(openai) }],
      provider: 'openai',
      raw_id: openai.id || null,
      raw_status: openai.status || null
    }, mcp.refreshed_cookies?.length ? { 'Set-Cookie': mcp.refreshed_cookies } : {});
  } catch (error) {
    const normalizedError = await normalizeConnectorOAuthError(error, req, body);
    const headers = normalizedError.refreshed_cookies?.length ? { 'Set-Cookie': normalizedError.refreshed_cookies } : {};
    return sendJson(res, normalizedError.status || 500, {
      error: {
        message: normalizedError.message || 'OpenAI proxy error',
        oauth_provider: normalizedError.oauth_provider,
        oauth_url: normalizedError.oauth_url,
        oauth_reason: normalizedError.oauth_reason,
        oauth_status: normalizedError.oauth_status,
        consent_required: Boolean(normalizedError.consent_required),
        diagnostic: normalizedError.diagnostic,
        upstream: normalizedError.upstream
      }
    }, headers);
  }
}

async function saveAnalysisRun({ req, body, scraped, openai, output_text }) {
  const row = {
    app_path: APP_BASE_PATH || '/',
    request_meta: {
      notes_present: Boolean(body.notes),
      central_text_present: Boolean(body.central_text),
      central_document_present: Boolean(body.central_document),
      analysis_mode: body.analysis_mode || EARLY_WARNING_ANALYSIS_MODE,
      connector_ids: Array.isArray(body.connector_ids) ? body.connector_ids : [],
      effective_connector_ids: effectiveConnectorIdsForBody(body),
      skipped_connector_ids: skippedConnectorIdsForBody(body),
      consent_required: requiresMentalHealthConsent(body),
      consent_confirmed: normalizeMentalHealthOptions(body).consent_confirmed,
      mental_health_early_warning: isEarlyWarningMode(body),
      mental_health_allowed_sources: normalizeMentalHealthOptions(body).allowed_sources,
      file_count: Array.isArray(body.files) ? body.files.length : 0,
      image_file_count: Array.isArray(body.files) ? body.files.filter(isImageFile).length : 0,
      text_file_count: Array.isArray(body.files) ? body.files.filter(file => !isImageFile(file)).length : 0,
      profile_urls: profileUrlsForBody(body)
    },
    scraped,
    result: {
      output_text,
      openai_id: openai.id || null,
      openai_status: openai.status || null,
      model: body.model || DEFAULT_MODEL,
      scraped_topics: scraped.flatMap(item => Array.isArray(item.topics) ? item.topics : []).slice(0, 80),
      scraped_image_count: collectScrapedImages(scraped).length
    },
    user_agent: req.headers['user-agent'] || ''
  };

  return supabaseInsert('psychapp_runs', row);
}

function healthDiagnostics(req = null) {
  const keyInfo = getOpenAIKeyWithMeta();
  const supabaseKey = getSupabaseKeyWithMeta();
  return {
    ok: true,
    status: 'ready',
    app_base_path: APP_BASE_PATH || '/',
    public_base_url: req ? absoluteBaseUrl(req) : process.env.PUBLIC_BASE_URL || '',
    provider: 'openai',
    openai: {
      key_present: Boolean(keyInfo.value),
      model: DEFAULT_MODEL,
      timeout_ms: OPENAI_TIMEOUT_MS
    },
    mental_health: {
      skill: 'mental-health-early-warning-analysis',
      early_warning_mode: EARLY_WARNING_ANALYSIS_MODE,
      consent_gate: true,
      output: 'non_diagnostic_early_warning_report'
    },
    oauth: {
      cookie_secret_present: Boolean(findSecret(['OAUTH_COOKIE_SECRET', 'SESSION_SECRET', 'COOKIE_SECRET', 'PSYCHAPP_COOKIE_SECRET']).value),
      microsoft_tenant: MICROSOFT_TENANT,
      allow_custom_oauth_scopes: ALLOW_CUSTOM_OAUTH_SCOPES,
      config: req ? publicOAuthConfig(req) : {}
    },
    supabase: {
      configured: Boolean(process.env.SUPABASE_URL && supabaseKey.value),
      url_present: Boolean(process.env.SUPABASE_URL),
      key_present: Boolean(supabaseKey.value),
      key_kind: supabaseKeyKind(supabaseKey.source, supabaseKey.value),
      timeout_ms: SUPABASE_TIMEOUT_MS
    },
    node: process.version,
    uptime_seconds: Math.round(process.uptime())
  };
}

function publicDiagnostics(req = null) {
  const keyInfo = getOpenAIKeyWithMeta();
  const supabaseKey = getSupabaseKeyWithMeta();
  const store = req ? readOAuthStore(req) : { providers: {} };
  return {
    ok: true,
    app_base_path: APP_BASE_PATH || '/',
    public_base_url: req ? absoluteBaseUrl(req) : process.env.PUBLIC_BASE_URL || '',
    request_base_url: req ? requestBaseUrl(req) : '',
    configured_public_base_url: process.env.PUBLIC_BASE_URL || '',
    provider: 'openai',
    openai: {
      key_present: Boolean(keyInfo.value),
      key_source: safeSource(keyInfo.source),
      model: DEFAULT_MODEL,
      url: OPENAI_URL,
      store: process.env.OPENAI_STORE === 'true'
    },
    mental_health: {
      skill: 'mental-health-early-warning-analysis',
      early_warning_mode: EARLY_WARNING_ANALYSIS_MODE,
      source_categories: MENTAL_HEALTH_SOURCE_LABELS,
      consent_gate: true
    },
    oauth: {
      cookie_secret_present: Boolean(findSecret(['OAUTH_COOKIE_SECRET', 'SESSION_SECRET', 'COOKIE_SECRET', 'PSYCHAPP_COOKIE_SECRET']).value),
      microsoft_tenant: MICROSOFT_TENANT,
      allow_custom_oauth_scopes: ALLOW_CUSTOM_OAUTH_SCOPES,
      providers: {
        google: publicTokenMeta(store.providers?.google, 'google'),
        microsoft: publicTokenMeta(store.providers?.microsoft, 'microsoft')
      },
      config: req ? publicOAuthConfig(req) : {}
    },
    mcp_connectors: CONNECTORS,
    scraper: {
      timeout_ms: SCRAPE_TIMEOUT_MS,
      max_bytes: SCRAPE_MAX_BYTES,
      max_links: SCRAPE_MAX_LINKS,
      max_media: SCRAPE_MAX_MEDIA,
      max_uploaded_images_for_vision: MAX_UPLOADED_IMAGES_FOR_VISION,
      max_scraped_images_for_vision: MAX_SCRAPED_IMAGES_FOR_VISION,
      max_uploaded_documents_for_model: MAX_UPLOADED_DOCUMENTS_FOR_MODEL,
      blocks_private_hosts: true
    },
    supabase: {
      configured: Boolean(process.env.SUPABASE_URL && supabaseKey.value),
      url_present: Boolean(process.env.SUPABASE_URL),
      key_present: Boolean(supabaseKey.value),
      key_source: safeSource(supabaseKey.source),
      key_kind: supabaseKeyKind(supabaseKey.source, supabaseKey.value)
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

const psychAppMcpOAuth = createPsychAppMcpOAuthHandler({
  sendJson,
  sendHtml,
  readBody,
  absoluteBaseUrl,
  publicDiagnostics,
  getOpenAIKeyWithMeta,
  getSupabaseKeyWithMeta
});

function serveStatic(req, res, originalPathname, strippedPathname) {
  if (!APP_BASE_PATH && originalPathname === '/') return serveFile(res, path.join(DIST, 'index.html'));
  if (APP_BASE_PATH && originalPathname === '/') return serveFile(res, path.join(DIST, 'index.html'));

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

  if (psychAppMcpOAuth(req, res, pathname)) return;

  if (pathname === '/api/health') return sendJson(res, 200, healthDiagnostics(req));
  if (pathname === '/api/debug/config') return sendJson(res, 200, publicDiagnostics(req));
  if (pathname === '/api/oauth/status') return handleOAuthStatus(req, res).catch(error => sendJson(res, error.status || 500, { error: { message: error.message } }));
  if (pathname === '/api/oauth/logout') return req.method === 'POST'
    ? handleOAuthLogout(req, res).catch(error => sendJson(res, error.status || 500, { error: { message: error.message } }))
    : methodNotAllowed(res, 'POST');
  if (pathname.startsWith('/api/oauth/logout/')) return req.method === 'POST'
    ? handleOAuthLogout(req, res, pathname.split('/').pop()).catch(error => sendJson(res, error.status || 500, { error: { message: error.message } }))
    : methodNotAllowed(res, 'POST');
  if (pathname.startsWith('/api/oauth/start/')) return req.method === 'GET'
    ? handleOAuthStart(req, res, pathname.split('/').pop()).catch(error => sendJson(res, error.status || 500, { error: { message: error.message } }))
    : methodNotAllowed(res, 'GET');
  if (pathname.startsWith('/api/oauth/callback/')) return (req.method === 'GET' || req.method === 'POST')
    ? handleOAuthCallback(req, res, pathname.split('/').pop()).catch(error => sendJson(res, error.status || 500, { error: { message: error.message } }))
    : methodNotAllowed(res, 'GET,POST');
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
