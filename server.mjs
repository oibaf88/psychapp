import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
loadDotEnv(path.join(ROOT, '.env'));

const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 4173);
const OPENAI_URL = process.env.OPENAI_URL || 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
const SECRET_DIR = process.env.RENDER_SECRET_DIR || '/etc/secrets';
const OPENAI_SECRET_FILE_NAME = 'OPENAI_API_SECRET';
const OPENAI_SECRET_FILE_PATH = path.join(SECRET_DIR, OPENAI_SECRET_FILE_NAME);
const COOKIE_NAME = 'psychapp_oauth';
const STATE_COOKIE_NAME = 'psychapp_oauth_state';
const OAUTH_COOKIE_TTL_SECONDS = Number(process.env.OAUTH_COOKIE_TTL_SECONDS || 60 * 60 * 24 * 7);

const CONNECTOR_BY_LABEL = {
  gmail: 'connector_gmail',
  googlemail: 'connector_gmail',
  drive: 'connector_googledrive',
  google_drive: 'connector_googledrive',
  googledrive: 'connector_googledrive',
  calendar: 'connector_googlecalendar',
  google_calendar: 'connector_googlecalendar',
  m365: 'connector_outlookemail',
  microsoft365: 'connector_outlookemail',
  outlook: 'connector_outlookemail',
  outlook_email: 'connector_outlookemail',
  outlook_calendar: 'connector_outlookcalendar',
  teams: 'connector_microsoftteams',
  sharepoint: 'connector_sharepoint',
  onedrive: 'connector_sharepoint',
  one_drive: 'connector_sharepoint',
  dropbox: 'connector_dropbox'
};

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.readonly'
];

const MICROSOFT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Files.Read.All',
  'Calendars.Read',
  'Sites.Read.All',
  'Team.ReadBasic.All'
];

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
    authExtras: { access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent' }
  },
  microsoft: {
    id: 'microsoft',
    label: 'Microsoft',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientIdNames: ['MICROSOFT_CLIENT_ID', 'AZURE_CLIENT_ID', 'MS_CLIENT_ID'],
    clientSecretNames: ['MICROSOFT_CLIENT_SECRET', 'AZURE_CLIENT_SECRET', 'MS_CLIENT_SECRET'],
    redirectUriNames: ['MICROSOFT_REDIRECT_URI', 'AZURE_REDIRECT_URI', 'MS_REDIRECT_URI'],
    scopes: MICROSOFT_SCOPES,
    authExtras: { prompt: 'select_account' }
  }
};

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

function readSecretFile(filePath) {
  if (!filePath) return '';
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function normalizeSecret(raw, keyNames = []) {
  let text = String(raw || '').trim();
  if (!text) return '';
  if (text.startsWith('Bearer ')) text = text.slice(7).trim();
  for (const keyName of keyNames) {
    if (text.startsWith(`${keyName}=`)) text = text.slice(keyName.length + 1).trim();
    if (text.startsWith(`${keyName}:`)) text = text.slice(keyName.length + 1).trim();
  }
  return text.replace(/^["']|["']$/g, '').trim();
}

function safeSecretFiles() {
  try {
    if (!fs.existsSync(SECRET_DIR)) return [];
    return fs.readdirSync(SECRET_DIR).filter(name => !name.startsWith('.')).sort();
  } catch {
    return [];
  }
}

function findSecret(names) {
  for (const name of names) {
    const env = normalizeSecret(process.env[name], names);
    if (env) return { value: env, source: `env:${name}` };
  }
  for (const name of names) {
    const candidates = [
      path.join(SECRET_DIR, name),
      path.join(SECRET_DIR, name.toLowerCase()),
      path.join(SECRET_DIR, `${name}.txt`),
      path.join(SECRET_DIR, `${name.toLowerCase()}.txt`),
      path.join(ROOT, name),
      path.join(ROOT, name.toLowerCase())
    ];
    for (const filePath of candidates) {
      const file = normalizeSecret(readSecretFile(filePath), names);
      if (file) return { value: file, source: `file:${filePath}` };
    }
  }
  return { value: '', source: '' };
}

function getOpenAIKeyWithMeta() {
  return findSecret([
    'OPENAI_API_KEY',
    'OPENAI_API_SECRET',
    'OPENAI_KEY',
    'openai_api_key',
    'openai_api_secret',
    'openai_key'
  ]);
}

function getOpenAIKey() {
  return getOpenAIKeyWithMeta().value;
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

function sanitizeServerName(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function normalizeLabel(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function connectorForServer(srv) {
  if (srv?.connector_id) return srv.connector_id;
  const label = normalizeLabel(srv?.name || srv?.server_label || srv?.id || '');
  if (CONNECTOR_BY_LABEL[label]) return CONNECTOR_BY_LABEL[label];
  const url = String(srv?.url || srv?.server_url || '').toLowerCase();
  if (url.includes('gmail')) return 'connector_gmail';
  if (url.includes('drive') && url.includes('google')) return 'connector_googledrive';
  if (url.includes('calendar') && url.includes('google')) return 'connector_googlecalendar';
  if (url.includes('microsoft') || url.includes('outlook') || url.includes('m365')) return 'connector_outlookemail';
  if (url.includes('teams')) return 'connector_microsoftteams';
  if (url.includes('sharepoint') || url.includes('onedrive')) return 'connector_sharepoint';
  if (url.includes('dropbox')) return 'connector_dropbox';
  return '';
}

function providerForConnector(connectorId = '') {
  if (connectorId === 'connector_gmail' || connectorId === 'connector_googledrive' || connectorId === 'connector_googlecalendar') return 'google';
  if (connectorId === 'connector_outlookemail' || connectorId === 'connector_outlookcalendar' || connectorId === 'connector_microsoftteams' || connectorId === 'connector_sharepoint') return 'microsoft';
  return '';
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(val);
  }
  return out;
}

function isSecureRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = String(req.headers.host || '');
  return proto === 'https' || (!host.startsWith('localhost') && !host.startsWith('127.0.0.1'));
}

function cookieString(name, value, req, opts = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

function getCookieSecret() {
  const configured = findSecret(['OAUTH_COOKIE_SECRET', 'SESSION_SECRET', 'COOKIE_SECRET', 'PSYCHAPP_COOKIE_SECRET']);
  if (configured.value) return configured.value;
  const key = getOpenAIKey();
  if (key) return key;
  return 'dev-only-insecure-cookie-secret-change-me';
}

function cryptoKey() {
  return crypto.createHash('sha256').update(getCookieSecret()).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function randomUrlSafe(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cryptoKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [b64url(iv), b64url(tag), b64url(ciphertext)].join('.');
}

function decryptJson(token) {
  try {
    const [ivB64, tagB64, dataB64] = String(token || '').split('.');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', cryptoKey(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
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
  const cookies = parseCookies(req);
  const data = decryptJson(cookies[COOKIE_NAME]);
  if (!data || typeof data !== 'object') return { providers: {} };
  if (!data.providers || typeof data.providers !== 'object') data.providers = {};
  return data;
}

function writeOAuthStore(req, res, store) {
  const value = encryptJson({ ...store, updated_at: Date.now() });
  return cookieString(COOKIE_NAME, value, req, { maxAge: OAUTH_COOKIE_TTL_SECONDS });
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
  const store = readOAuthStore(req);
  const token = store.providers?.[provider];
  if (!token?.access_token) return '';
  if (token.expires_at && Date.now() > token.expires_at - 30_000) {
    // No silent refresh here. The next request will make the user reconnect.
    return '';
  }
  return token.access_token;
}

function oauthProviderConfig(providerName) {
  const provider = OAUTH_PROVIDERS[providerName];
  if (!provider) return { error: `Proveedor OAuth no soportado: ${providerName}` };
  const clientId = findSecret(provider.clientIdNames).value;
  const clientSecret = findSecret(provider.clientSecretNames).value;
  return { provider, clientId, clientSecret };
}

function absoluteBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (configured) return configured;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  const host = req.headers.host;
  return `${proto}://${host}`;
}

function redirectUriFor(req, providerName) {
  const provider = OAUTH_PROVIDERS[providerName];
  const configured = provider ? findSecret(provider.redirectUriNames).value : '';
  if (configured) return configured;
  return `${absoluteBaseUrl(req)}/api/oauth/callback/${providerName}`;
}

async function sha256Base64Url(text) {
  return crypto.createHash('sha256').update(text).digest('base64url');
}

async function handleOAuthStart(req, res, providerName) {
  const { provider, clientId } = oauthProviderConfig(providerName);
  if (!provider) return sendJson(res, 404, { error: { message: `Proveedor OAuth no soportado: ${providerName}` } });
  if (!clientId) {
    return sendJson(res, 500, {
      error: {
        message: `Falta ${provider.label} OAuth client id. Configura ${provider.clientIdNames[0]} en Render Environment.`,
        required: provider.clientIdNames
      }
    });
  }

  const reqUrl = new URL(req.url, absoluteBaseUrl(req));
  const target = normalizeLabel(reqUrl.searchParams.get('target') || providerName);
  const returnTo = reqUrl.searchParams.get('return_to') || '/';
  const state = randomUrlSafe(24);
  const verifier = randomUrlSafe(64);
  const challenge = await sha256Base64Url(verifier);
  const statePayload = { provider: providerName, target, return_to: returnTo, state, verifier, created_at: Date.now() };

  const auth = new URL(provider.authUrl);
  auth.searchParams.set('client_id', clientId);
  auth.searchParams.set('redirect_uri', redirectUriFor(req, providerName));
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', provider.scopes.join(' '));
  auth.searchParams.set('state', state);
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  for (const [key, value] of Object.entries(provider.authExtras || {})) auth.searchParams.set(key, value);

  const headers = { 'Set-Cookie': cookieString(STATE_COOKIE_NAME, signStatePayload(statePayload), req, { maxAge: 600 }) };
  return redirect(res, auth.toString(), headers);
}

async function handleOAuthCallback(req, res, providerName) {
  const { provider, clientId, clientSecret } = oauthProviderConfig(providerName);
  if (!provider) return sendJson(res, 404, { error: { message: `Proveedor OAuth no soportado: ${providerName}` } });

  const reqUrl = new URL(req.url, absoluteBaseUrl(req));
  const error = reqUrl.searchParams.get('error');
  if (error) {
    return sendHtml(res, 400, oauthResultHtml('OAuth denied', `Proveedor: ${provider.label}. Error: ${escapeHtml(error)}`, '/'));
  }

  const code = reqUrl.searchParams.get('code');
  const state = reqUrl.searchParams.get('state');
  const cookies = parseCookies(req);
  const statePayload = verifyStatePayload(cookies[STATE_COOKIE_NAME]);
  if (!code || !state || !statePayload || statePayload.state !== state || statePayload.provider !== providerName) {
    return sendHtml(res, 400, oauthResultHtml('OAuth state invalid', 'Reintenta la conexión desde la app.', '/'));
  }
  if (Date.now() - Number(statePayload.created_at || 0) > 10 * 60 * 1000) {
    return sendHtml(res, 400, oauthResultHtml('OAuth expired', 'La solicitud caducó. Reintenta la conexión.', '/'));
  }

  const params = new URLSearchParams();
  params.set('client_id', clientId);
  if (clientSecret) params.set('client_secret', clientSecret);
  params.set('code', code);
  params.set('redirect_uri', redirectUriFor(req, providerName));
  params.set('grant_type', 'authorization_code');
  params.set('code_verifier', statePayload.verifier);

  const tokenResponse = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const tokenText = await tokenResponse.text();
  let tokenJson;
  try { tokenJson = JSON.parse(tokenText); } catch { tokenJson = null; }
  if (!tokenResponse.ok) {
    return sendHtml(res, tokenResponse.status, oauthResultHtml('OAuth token exchange failed', escapeHtml(tokenJson?.error_description || tokenJson?.error || tokenText), '/'));
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
    writeOAuthStore(req, res, store),
    cookieString(STATE_COOKIE_NAME, '', req, { maxAge: 0 })
  ];
  const returnTo = statePayload.return_to || '/';
  return redirect(res, `${returnTo}${returnTo.includes('?') ? '&' : '?'}oauth=${providerName}_connected`, { 'Set-Cookie': headers });
}

function oauthResultHtml(title, message, returnTo = '/') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui;padding:2rem;line-height:1.5"><h1>${escapeHtml(title)}</h1><p>${message}</p><p><a href="${escapeHtml(returnTo)}">Volver a la app</a></p></body></html>`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

function handleOAuthStatus(req, res) {
  const store = readOAuthStore(req);
  return sendJson(res, 200, {
    ok: true,
    providers: {
      google: publicTokenMeta(store.providers?.google),
      microsoft: publicTokenMeta(store.providers?.microsoft)
    },
    connectors: connectorStatusFromStore(store),
    oauth_config: publicOAuthConfig(req)
  });
}

function connectorStatusFromStore(store) {
  const google = publicTokenMeta(store.providers?.google).connected;
  const microsoft = publicTokenMeta(store.providers?.microsoft).connected;
  return {
    gmail: { connected: google, provider: 'google', connector_id: 'connector_gmail' },
    drive: { connected: google, provider: 'google', connector_id: 'connector_googledrive' },
    google_calendar: { connected: google, provider: 'google', connector_id: 'connector_googlecalendar' },
    m365: { connected: microsoft, provider: 'microsoft', connector_id: 'connector_outlookemail' },
    outlook: { connected: microsoft, provider: 'microsoft', connector_id: 'connector_outlookemail' },
    outlook_calendar: { connected: microsoft, provider: 'microsoft', connector_id: 'connector_outlookcalendar' },
    teams: { connected: microsoft, provider: 'microsoft', connector_id: 'connector_microsoftteams' },
    sharepoint: { connected: microsoft, provider: 'microsoft', connector_id: 'connector_sharepoint' },
    onedrive: { connected: microsoft, provider: 'microsoft', connector_id: 'connector_sharepoint', note: 'OpenAI currently exposes SharePoint connector, not a separate OneDrive connector.' }
  };
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
  if (providerName && store.providers?.[providerName]) delete store.providers[providerName];
  if (!providerName) store.providers = {};
  return sendJson(res, 200, { ok: true, disconnected: providerName || 'all' }, { 'Set-Cookie': writeOAuthStore(req, res, store) });
}

function getOAuthTokenWithMeta(req, label, connectorId = '') {
  const provider = providerForConnector(connectorId);
  const accessToken = provider ? getProviderToken(req, provider) : '';
  if (accessToken) return { value: accessToken, source: `oauth-cookie:${provider}` };

  // Optional legacy fallback for local testing only. Set ALLOW_STATIC_OAUTH_TOKENS=true if you still want env/secret token fallback.
  if (process.env.ALLOW_STATIC_OAUTH_TOKENS === 'true') {
    const info = findSecret(tokenNamesFor(label, connectorId));
    if (info.value) return info;
  }
  return { value: '', source: '' };
}

function tokenNamesFor(label, connectorId = '') {
  const clean = sanitizeServerName(label);
  const connector = sanitizeServerName(String(connectorId || '').replace(/^connector_/, ''));
  const names = [
    `MCP_TOKEN_${clean}`,
    `MCP_AUTH_${clean}`,
    `${clean}_OAUTH_ACCESS_TOKEN`,
    `${clean}_ACCESS_TOKEN`,
    `${clean}_TOKEN`
  ];
  if (connector) names.push(`MCP_TOKEN_${connector}`, `${connector}_OAUTH_ACCESS_TOKEN`, `${connector}_ACCESS_TOKEN`, `${connector}_TOKEN`);
  return [...new Set(names)];
}

function extractOutputText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string') return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    if (item?.type === 'message') {
      for (const c of item.content || []) {
        if (typeof c.text === 'string') chunks.push(c.text);
        else if (typeof c.output_text === 'string') chunks.push(c.output_text);
      }
    }
  }
  return chunks.join('\n');
}

function normalizeMessages(messages = []) {
  return messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
  }));
}

function convertTools(req, legacyTools = [], mcpServers = []) {
  const tools = [];
  const wantsWeb = legacyTools.some(t => String(t?.type || '').includes('web_search') || t?.name === 'web_search');
  if (wantsWeb) tools.push({ type: 'web_search' });

  for (const srv of mcpServers) {
    if (!srv) continue;
    const label = String(srv.name || srv.server_label || srv.id || 'mcp').replace(/[^a-zA-Z0-9_-]/g, '_');
    const connectorId = connectorForServer(srv);
    const tokenInfo = getOAuthTokenWithMeta(req, label, connectorId);

    if (connectorId) {
      const provider = providerForConnector(connectorId);
      if (!tokenInfo.value) {
        throw Object.assign(new Error(`OAuth requerido para ${label}. Abre /api/oauth/start/${provider}?target=${encodeURIComponent(label)} y autoriza la cuenta.`), { status: 401, oauth_provider: provider, oauth_target: label });
      }
      tools.push({
        type: 'mcp',
        server_label: label,
        connector_id: connectorId,
        authorization: tokenInfo.value.startsWith('Bearer ') ? tokenInfo.value : `Bearer ${tokenInfo.value}`,
        require_approval: process.env.MCP_REQUIRE_APPROVAL || 'never'
      });
      continue;
    }

    const serverUrl = srv.url || srv.server_url;
    if (typeof serverUrl !== 'string' || !serverUrl.startsWith('https://')) continue;
    const tool = {
      type: 'mcp',
      server_label: label,
      server_url: serverUrl,
      require_approval: process.env.MCP_REQUIRE_APPROVAL || 'never'
    };
    if (tokenInfo.value) tool.authorization = tokenInfo.value.startsWith('Bearer ') ? tokenInfo.value : `Bearer ${tokenInfo.value}`;
    tools.push(tool);
  }
  return tools;
}

function toResponsesPayload(req, body) {
  const input = normalizeMessages(body.messages || []);
  if (input.length === 0 && typeof body.input === 'string') input.push({ role: 'user', content: body.input });
  const payload = {
    model: body.model || DEFAULT_MODEL,
    instructions: body.system || undefined,
    input,
    max_output_tokens: Number(body.max_tokens || body.max_output_tokens || 2000),
    store: process.env.OPENAI_STORE === 'true'
  };
  const tools = convertTools(req, body.tools || [], body.mcp_servers || []);
  if (tools.length) payload.tools = tools;
  if (body.temperature != null) payload.temperature = body.temperature;
  if (body.reasoning) payload.reasoning = body.reasoning;
  return payload;
}

function asAnthropicCompatible(openaiData) {
  return {
    content: [{ type: 'text', text: extractOutputText(openaiData) }],
    provider: 'openai',
    raw_id: openaiData?.id || null,
    raw_status: openaiData?.status || null
  };
}

function maybeMock(body) {
  if (process.env.MOCK_AI !== 'true') return null;
  const sys = String(body.system || '');
  if (sys.includes('computational psychologist')) {
    return { content: [{ type: 'text', text: JSON.stringify({ valence: 0, arousal: 45, stress: 45, cognitive_complexity: 65, social_connectivity: 40, assertiveness: 45, hedging: 35, formality: 40, msg_count: 0, avg_length: 0, peak_hour: 12, themes: ['demo'], biases_detected: [], regulatory_events: [], schema_activations: [], anomalies: [], locus_events: { internal: 1, external: 1 }, attachment_signals: { secure: 1, anxious: 1, avoidant: 1 } }) }] };
  }
  if (sys.includes('trigger patterns')) {
    return { content: [{ type: 'text', text: JSON.stringify({ triggers: [], cyclical_patterns: [], correlations: [], critical_periods: [], burnout_risk_factors: [], resilience_indicators: [] }) }] };
  }
  if (sys.includes('deep psychological profile')) {
    const trait = score => ({ score, ci_low: Math.max(0, score - 15), ci_high: Math.min(100, score + 15), confidence: 'low', evidence: ['Modo demo sin API real'], descriptors: ['demo'] });
    return { content: [{ type: 'text', text: JSON.stringify({ ocean: { openness: trait(65), conscientiousness: trait(50), extraversion: trait(40), agreeableness: trait(55), neuroticism: trait(55) }, cognitive_biases: [], defense_mechanisms: [], schemas: [], attachment_style: { primary: 'secure', secondary: 'unknown', evidence: ['demo'] }, regulatory_profile: { dominant_strategy: 'unknown', failure_conditions: [], recovery_patterns: [] }, locus_of_control: { overall: 'mixed', ratio: 0.5, domain_breakdown: {} }, cognitive_style: { mode: 'mixed', complexity_index: 50, need_for_cognition: 50, decision_style: 'unknown' }, communication_fingerprint: { unique_markers: [], linguistic_tell_signs: [] }, evolutionary_trajectory: { trend: 'stable', key_transitions: [], growth_domains: [] }, dark_triad_screening: { narcissism_indicators: 0, machiavellianism_indicators: 0, note: 'No evaluable en demo' }, predictive_levers: [], summary: 'Modo demo: conecta OPENAI_API_SECRET para análisis real.', preventive_recommendations: [] }) }] };
  }
  if (sys.includes('data extraction agent')) {
    return { content: [{ type: 'text', text: JSON.stringify({ items: [], total_found: 0, data_quality: 'none', sources_tried: [], notes: 'Modo demo sin búsqueda real' }) }] };
  }
  if (sys.includes('access to data sources')) {
    return { content: [{ type: 'text', text: JSON.stringify({ items: [], next_page_token: null, total_estimated: 0 }) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ emotional_reaction: { primary: 'no evaluable en demo', secondary: '', intensity: 0, duration_estimate: '—' }, cognitive_patterns_activated: [], likely_behaviors: [], regulatory_challenges: [], early_warning_signs: [], protective_factors: [], preventive_suggestions: ['Configura OPENAI_API_SECRET'], probability_distribution: [] }) }] };
}

async function handleMessages(req, res) {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    const mock = maybeMock(body);
    if (mock) return sendJson(res, 200, mock);

    const keyInfo = getOpenAIKeyWithMeta();
    const key = keyInfo.value;
    if (!key) {
      return sendJson(res, 500, {
        error: {
          message: `Falta clave OpenAI. Crea un Render Secret File llamado ${OPENAI_SECRET_FILE_NAME}. En Render se monta como ${OPENAI_SECRET_FILE_PATH}.`,
          diagnostic: publicDiagnostics(req)
        }
      });
    }

    const payload = toResponsesPayload(req, body);
    const upstream = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(payload)
    });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!upstream.ok) return sendJson(res, upstream.status, data || { error: { message: text || `HTTP ${upstream.status}` } });
    return sendJson(res, 200, asAnthropicCompatible(data));
  } catch (err) {
    const payload = { error: { message: err.message || 'Error interno' } };
    if (err.oauth_provider) {
      payload.error.oauth_provider = err.oauth_provider;
      payload.error.oauth_url = `/api/oauth/start/${err.oauth_provider}?target=${encodeURIComponent(err.oauth_target || err.oauth_provider)}`;
    }
    sendJson(res, err.status || 500, payload);
  }
}

function tokenPresenceSummary(req) {
  const labels = [
    ['gmail', 'connector_gmail'],
    ['drive', 'connector_googledrive'],
    ['google_calendar', 'connector_googlecalendar'],
    ['m365', 'connector_outlookemail'],
    ['outlook_calendar', 'connector_outlookcalendar'],
    ['teams', 'connector_microsoftteams'],
    ['sharepoint', 'connector_sharepoint'],
    ['onedrive', 'connector_sharepoint'],
    ['dropbox', 'connector_dropbox']
  ];
  return Object.fromEntries(labels.map(([label, connector]) => {
    const info = getOAuthTokenWithMeta(req, label, connector);
    return [label, { present: Boolean(info.value), source: info.source ? info.source.replace(/:.+$/, ':***') : '' }];
  }));
}

function publicDiagnostics(req = null) {
  const keyInfo = getOpenAIKeyWithMeta();
  return {
    ok: true,
    provider: 'openai',
    mock: process.env.MOCK_AI === 'true',
    node: process.version,
    apiKeyConfigured: Boolean(keyInfo.value),
    model: DEFAULT_MODEL,
    openai: {
      key_present: Boolean(keyInfo.value),
      key_source: keyInfo.source ? keyInfo.source.replace(/:.+$/, ':***') : '',
      expected_secret_file_name: OPENAI_SECRET_FILE_NAME,
      expected_secret_file_path: OPENAI_SECRET_FILE_PATH,
      model: DEFAULT_MODEL,
      url: OPENAI_URL,
      store: process.env.OPENAI_STORE === 'true'
    },
    secrets: { dir: SECRET_DIR, dir_exists: fs.existsSync(SECRET_DIR), files: safeSecretFiles() },
    oauth: req ? {
      status_url: '/api/oauth/status',
      start_google_url: '/api/oauth/start/google',
      start_microsoft_url: '/api/oauth/start/microsoft',
      providers: readOAuthStore(req).providers ? Object.fromEntries(Object.entries(readOAuthStore(req).providers).map(([k, v]) => [k, publicTokenMeta(v)])) : {},
      config: publicOAuthConfig(req)
    } : undefined,
    oauth_tokens: req ? tokenPresenceSummary(req) : {},
    notes: [
      'OpenAI API key stays server-side. Use a Render Secret File named OPENAI_API_SECRET.',
      'Gmail, Drive, Outlook, Teams and SharePoint/OneDrive use OAuth redirect flows. Do not store user OAuth tokens as Render secrets.',
      'OpenAI connector calls still require an OAuth access token on every request; this backend supplies it from the encrypted HttpOnly cookie.'
    ]
  };
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(DIST, urlPath));
  if (!filePath.startsWith(DIST)) return sendJson(res, 403, { error: { message: 'Forbidden' } });
  const target = fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : path.join(DIST, 'index.html');
  fs.readFile(target, (err, data) => {
    if (err) return sendJson(res, 404, { error: { message: 'No existe dist/. Ejecuta npm run build primero.' } });
    const cache = target.endsWith('index.html') || target.endsWith('service-worker.js') || target.endsWith('manifest.webmanifest') ? 'no-cache' : 'public, max-age=31536000, immutable';
    res.writeHead(200, { 'Content-Type': mime(target), 'Cache-Control': cache });
    res.end(data);
  });
}

function mime(file) {
  const ext = path.extname(file);
  return ({
    '.html':'text/html; charset=utf-8',
    '.js':'application/javascript; charset=utf-8',
    '.css':'text/css; charset=utf-8',
    '.json':'application/json; charset=utf-8',
    '.webmanifest':'application/manifest+json; charset=utf-8',
    '.svg':'image/svg+xml',
    '.png':'image/png',
    '.jpg':'image/jpeg',
    '.jpeg':'image/jpeg',
    '.woff':'font/woff',
    '.woff2':'font/woff2',
    '.ttf':'font/ttf'
  }[ext]) || 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (pathname === '/api/health') return sendJson(res, 200, publicDiagnostics(req));
  if (pathname === '/api/debug/config') return sendJson(res, 200, publicDiagnostics(req));
  if (pathname === '/api/oauth/status') return handleOAuthStatus(req, res);
  if (pathname === '/api/oauth/logout' && req.method === 'POST') return handleOAuthLogout(req, res);
  if (pathname.startsWith('/api/oauth/logout/') && req.method === 'POST') return handleOAuthLogout(req, res, pathname.split('/').pop());
  if (pathname.startsWith('/api/oauth/start/') && req.method === 'GET') return handleOAuthStart(req, res, pathname.split('/').pop()).catch(err => sendJson(res, err.status || 500, { error: { message: err.message } }));
  if (pathname.startsWith('/api/oauth/callback/') && req.method === 'GET') return handleOAuthCallback(req, res, pathname.split('/').pop()).catch(err => sendHtml(res, err.status || 500, oauthResultHtml('OAuth error', escapeHtml(err.message), '/')));
  if (pathname === '/api/messages' && req.method === 'POST') return handleMessages(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Psyche Deep running on http://0.0.0.0:${PORT}`);
});

