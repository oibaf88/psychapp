import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, 'server.mjs');
// Keep the generated module in the repository root. server.mjs derives ROOT/DIST
// from import.meta.url, so putting the copy in a subdirectory would break static serving.
const patchedPath = path.join(__dirname, '.server.patched.mjs');

function patchServerSource(source) {
  let code = source;

  const helper = `
function publicOpenAIRequestMeta(payload = {}) {
  return {
    model: payload.model || DEFAULT_MODEL,
    max_output_tokens: payload.max_output_tokens || null,
    store: payload.store === true,
    tool_choice: payload.tool_choice || 'auto',
    tools: Array.isArray(payload.tools)
      ? payload.tools.map(tool => ({ type: tool?.type || '', connector_id: tool?.connector_id || '', server_label: tool?.server_label || '' }))
      : []
  };
}

function hasOpenAIWebSearch(payload = {}) {
  return Array.isArray(payload.tools) && payload.tools.some(tool => tool?.type === 'web_search');
}

function normalizeWebSearchText(value = '') {
  return String(value || '')
    .replace(/web_fetch/gi, 'web_search')
    .replace(/fetch each one/gi, 'inspect available public search results')
    .replace(/Scraping público/gi, 'Búsqueda web pública')
    .replace(/scraping/gi, 'búsqueda web pública');
}

function prepareWebSearchPayload(payload = {}) {
  if (!hasOpenAIWebSearch(payload)) return payload;
  payload.tool_choice = process.env.WEB_SEARCH_REQUIRED === 'false' ? 'auto' : 'required';
  payload.instructions = normalizeWebSearchText(payload.instructions || '');
  payload.instructions += '\n\nImplementation constraint: this app only provides the OpenAI hosted web_search tool. Use public web search results only. Always return strict JSON with this shape: {"items":[],"total_found":0,"data_quality":"none|poor|moderate|good","sources_tried":[],"notes":""}.';
  if (Array.isArray(payload.input)) {
    payload.input = payload.input.map(item => ({
      ...item,
      content: typeof item.content === 'string' ? normalizeWebSearchText(item.content) : item.content
    }));
  }
  payload.include = Array.from(new Set([...(Array.isArray(payload.include) ? payload.include : []), 'web_search_call.action.sources']));
  return payload;
}

function openAIErrorPayload(status, data, text = '', requestPayload = {}) {
  const err = data?.error && typeof data.error === 'object' ? data.error : {};
  const rawMessage = String(err.message || data?.message || text || \`HTTP \${status}\`).slice(0, 1200);
  const rawCode = String(err.code || err.type || '').toLowerCase();
  const combined = \`\${rawCode} \${rawMessage}\`.toLowerCase();
  const meta = publicOpenAIRequestMeta(requestPayload);

  if (status === 429 && /quota|billing|credit|monthly spend|insufficient_quota|current quota/.test(combined)) {
    return {
      error: {
        code: 'openai_quota_exceeded',
        message: 'Presupuesto o cuota insuficiente en OpenAI Platform para esta petición. Render solo aloja la app y Supabase no interviene en este error.',
        upstream_status: status,
        upstream_code: err.code || err.type || null,
        recoverable_by_retry: false,
        next_steps: [
          'Abre OpenAI Platform en la organización donde están los créditos.',
          'Verifica que la API key usada por la app pertenece a ese mismo proyecto OpenAI.',
          'Comprueba el monthly budget y usage del proyecto OpenAI.',
          'Crea una API key nueva en ese proyecto y sustituye el secreto usado por la app.',
          'Reinicia el servicio para que lea la nueva clave.'
        ],
        request: meta,
        upstream_message: rawMessage
      }
    };
  }

  if (status === 429) {
    return {
      error: {
        code: 'openai_rate_limited',
        message: 'Límite temporal de velocidad de OpenAI alcanzado. Reduce volumen/concurrencia o reintenta más tarde con backoff.',
        upstream_status: status,
        upstream_code: err.code || err.type || null,
        recoverable_by_retry: true,
        request: meta,
        upstream_message: rawMessage
      }
    };
  }

  if (status === 400 && hasOpenAIWebSearch(requestPayload)) {
    return {
      error: {
        code: 'openai_web_search_request_error',
        message: 'OpenAI rechazó la petición de búsqueda web. El backend normaliza la petición a web_search; revisa upstream_message para el motivo exacto.',
        upstream_status: status,
        upstream_code: err.code || err.type || null,
        recoverable_by_retry: false,
        request: meta,
        upstream_message: rawMessage
      }
    };
  }

  if (status === 401 || status === 403) {
    return {
      error: {
        code: 'openai_auth_or_permission_error',
        message: 'La clave OpenAI no es válida o no tiene permisos para este modelo/proyecto. Revisa la API key y el proyecto asociado dentro de OpenAI Platform.',
        upstream_status: status,
        upstream_code: err.code || err.type || null,
        recoverable_by_retry: false,
        request: meta,
        upstream_message: rawMessage
      }
    };
  }

  if (status >= 500) {
    return {
      error: {
        code: 'openai_upstream_error',
        message: 'OpenAI devolvió un error temporal de servidor. Reintenta más tarde; si persiste, revisa status.openai.com.',
        upstream_status: status,
        upstream_code: err.code || err.type || null,
        recoverable_by_retry: true,
        request: meta,
        upstream_message: rawMessage
      }
    };
  }

  return {
    error: {
      code: err.code || err.type || 'openai_api_error',
      message: rawMessage,
      upstream_status: status,
      upstream_code: err.code || err.type || null,
      recoverable_by_retry: false,
      request: meta
    }
  };
}

function oauthResponseHeaders(req) {
  return req?.__psychapp_oauth_set_cookie ? { 'Set-Cookie': req.__psychapp_oauth_set_cookie } : {};
}
`;

  if (!code.includes('function openAIErrorPayload(')) {
    const marker = `function maybeMock(body) {\n  if (process.env.MOCK_AI !== 'true') return null;\n  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, demo: true, message: 'MOCK_AI activo' }) }] };\n}\n`;
    if (!code.includes(marker)) throw new Error('Cannot find maybeMock marker in server.mjs');
    code = code.replace(marker, `${marker}${helper}`);
  } else if (!code.includes('function oauthResponseHeaders(')) {
    code = code.replace('function openAIErrorPayload(', `${helper}\nfunction openAIErrorPayload(`);
  }

  const oldTokenMetaBlock = `function getOAuthTokenWithMeta(req, label, connectorId = '') {
  const provider = providerForConnector(connectorId);
  const accessToken = provider ? getProviderToken(req, provider) : '';
  if (accessToken) return { value: accessToken, source: \`oauth-cookie:\${provider}\` };
  if (process.env.ALLOW_STATIC_OAUTH_TOKENS === 'true') {
    const info = findSecret(tokenNamesFor(label, connectorId));
    if (info.value) return info;
  }
  return { value: '', source: '' };
}
`;

  const refreshedTokenMetaBlock = `${oldTokenMetaBlock}
async function refreshProviderAccessToken(req, providerName, store) {
  const token = store?.providers?.[providerName];
  if (!token?.refresh_token) return null;

  const { provider, clientId, clientSecret } = oauthProviderConfig(providerName);
  if (!provider || !clientId) return null;

  const tokenParams = new URLSearchParams();
  tokenParams.set('client_id', clientId);
  if (clientSecret) tokenParams.set('client_secret', clientSecret);
  tokenParams.set('grant_type', 'refresh_token');
  tokenParams.set('refresh_token', token.refresh_token);

  let tokenResponse;
  try {
    tokenResponse = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: tokenParams.toString(),
      redirect: 'manual'
    });
  } catch {
    return null;
  }

  if (!tokenResponse.ok) return null;

  let tokenJson;
  try { tokenJson = await tokenResponse.json(); } catch { tokenJson = null; }
  if (!tokenJson?.access_token) return null;

  const expiresIn = Number(tokenJson.expires_in || 3600);
  store.providers[providerName] = {
    ...token,
    access_token: tokenJson.access_token,
    refresh_token: tokenJson.refresh_token || token.refresh_token,
    expires_at: Date.now() + expiresIn * 1000,
    scope: tokenJson.scope || token.scope || provider.scopes.join(' '),
    token_type: tokenJson.token_type || token.token_type || 'Bearer',
    updated_at: Date.now(),
    refreshed_at: Date.now()
  };

  req.__psychapp_oauth_set_cookie = writeOAuthStore(req, store);
  return store.providers[providerName];
}

async function getOAuthTokenWithMetaForConnector(req, label, connectorId = '') {
  const provider = providerForConnector(connectorId);
  if (provider) {
    const store = readOAuthStore(req);
    const token = store.providers?.[provider];
    if (token?.access_token && (!token.expires_at || Date.now() <= token.expires_at - 60000)) {
      return { value: token.access_token, source: \`oauth-cookie:\${provider}\` };
    }
    const refreshed = await refreshProviderAccessToken(req, provider, store);
    if (refreshed?.access_token) return { value: refreshed.access_token, source: \`oauth-cookie-refreshed:\${provider}\` };
  }

  if (process.env.ALLOW_STATIC_OAUTH_TOKENS === 'true') {
    const info = findSecret(tokenNamesFor(label, connectorId));
    if (info.value) return info;
  }
  return { value: '', source: '' };
}
`;

  if (!code.includes('async function getOAuthTokenWithMetaForConnector(')) {
    if (!code.includes(oldTokenMetaBlock)) throw new Error('Cannot find getOAuthTokenWithMeta block in server.mjs');
    code = code.replace(oldTokenMetaBlock, refreshedTokenMetaBlock);
  }

  const oldLine = "if (!upstream.ok) return sendJson(res, upstream.status, data || { error: { message: text || `HTTP ${upstream.status}` } });";
  const newLine = "if (!upstream.ok) return sendJson(res, upstream.status, openAIErrorPayload(upstream.status, data, text, payload), oauthResponseHeaders(req));";
  const alreadyPatchedOldErrorLine = "if (!upstream.ok) return sendJson(res, upstream.status, openAIErrorPayload(upstream.status, data, text, payload));";
  if (!code.includes(newLine)) {
    if (code.includes(alreadyPatchedOldErrorLine)) code = code.replace(alreadyPatchedOldErrorLine, newLine);
    else if (code.includes(oldLine)) code = code.replace(oldLine, newLine);
    else throw new Error('Cannot find OpenAI upstream error passthrough line in server.mjs');
  }

  const optionalWebSearchLine = "if (tools.length) payload.tools = tools;";
  const requiredWebSearchBlock = `if (tools.length) {
    payload.tools = tools;
    if (tools.some(tool => tool?.type === 'web_search') && process.env.WEB_SEARCH_REQUIRED !== 'false') payload.tool_choice = 'required';
  }`;
  if (!code.includes(requiredWebSearchBlock)) {
    if (!code.includes(optionalWebSearchLine)) throw new Error('Cannot find web search tools assignment in server.mjs');
    code = code.replace(optionalWebSearchLine, requiredWebSearchBlock);
  }

  const asyncPatches = [
    ["function convertTools(req, legacyTools = [], mcpServers = []) {", "async function convertTools(req, legacyTools = [], mcpServers = []) {"],
    ["const tokenInfo = getOAuthTokenWithMeta(req, label, connectorId);", "const tokenInfo = await getOAuthTokenWithMetaForConnector(req, label, connectorId);"],
    ["function toResponsesPayload(req, body) {", "async function toResponsesPayload(req, body) {"],
    ["const tools = convertTools(req, body.tools || [], body.mcp_servers || []);", "const tools = await convertTools(req, body.tools || [], body.mcp_servers || []);"],
    ["const payload = toResponsesPayload(req, body);", "const payload = prepareWebSearchPayload(await toResponsesPayload(req, body));"],
    ["return sendJson(res, 200, asAnthropicCompatible(data));", "return sendJson(res, 200, asAnthropicCompatible(data), oauthResponseHeaders(req));"]
  ];

  for (const [before, after] of asyncPatches) {
    if (!code.includes(after)) {
      if (!code.includes(before)) throw new Error(`Cannot find patch target in server.mjs: ${before}`);
      code = code.replace(before, after);
    }
  }

  return code;
}

const source = fs.readFileSync(sourcePath, 'utf8');
const patched = patchServerSource(source);
fs.writeFileSync(patchedPath, patched, 'utf8');
await import(pathToFileURL(patchedPath).href);
