import crypto from 'node:crypto';

const DEFAULT_SCOPES = ['psychapp:read', 'psychapp:analyze'];
const MCP_PROTOCOL_VERSION = '2025-06-18';

export function createPsychAppMcpOAuthHandler(deps = {}) {
  const {
    sendJson = fallbackSendJson,
    sendHtml = fallbackSendHtml,
    readBody = fallbackReadBody,
    absoluteBaseUrl = fallbackBaseUrl,
    publicDiagnostics = () => ({}),
    getOpenAIKeyWithMeta = () => ({ value: '' })
  } = deps;

  const usedAuthorizationCodes = new Set();

  function handle(req, res, pathname) {
    const handled = isHandledPath(pathname);
    if (!handled) return false;
    run(req, res, pathname).catch(err => {
      const status = err.status || 500;
      sendJson(res, status, { error: { message: err.message || 'PsychApp MCP/OAuth error' } });
    });
    return true;
  }

  async function run(req, res, pathname) {
    if ((pathname === '/mcp' || pathname === mcpPath()) && req.method !== 'POST') {
      const bearer = verifyBearer(req);
      if (!bearer.ok) return unauthorized(req, res, bearer.scope || 'psychapp:read');
      return sendJson(res, 200, {
        ok: true,
        name: 'PsychApp MCP',
        endpoint: resourceUrl(req),
        protocol: MCP_PROTOCOL_VERSION,
        tools: MCP_TOOLS.map(t => t.name)
      });
    }

    if (pathname === '/mcp' || pathname === mcpPath()) {
      const bearer = verifyBearer(req);
      if (!bearer.ok) return unauthorized(req, res, bearer.scope || 'psychapp:read');
      return handleMcp(req, res, bearer.token);
    }

    if (pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp') {
      return protectedResourceMetadata(req, res);
    }

    if (pathname === '/.well-known/oauth-authorization-server' || pathname === '/.well-known/openid-configuration') {
      return authorizationServerMetadata(req, res);
    }

    if (pathname === '/oauth/register') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
      return dynamicClientRegistration(req, res);
    }

    if (pathname === '/oauth/authorize') {
      if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');
      return authorize(req, res);
    }

    if (pathname === '/oauth/token') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
      return token(req, res);
    }

    if (pathname === '/api/mcp/debug') {
      return sendJson(res, 200, publicMcpDiagnostics(req));
    }

    throw Object.assign(new Error('Unhandled PsychApp MCP/OAuth route'), { status: 404 });
  }

  function isHandledPath(pathname) {
    return pathname === '/mcp' ||
      pathname === mcpPath() ||
      pathname === '/.well-known/oauth-protected-resource' ||
      pathname === '/.well-known/oauth-protected-resource/mcp' ||
      pathname === '/.well-known/oauth-authorization-server' ||
      pathname === '/.well-known/openid-configuration' ||
      pathname === '/oauth/register' ||
      pathname === '/oauth/authorize' ||
      pathname === '/oauth/token' ||
      pathname === '/api/mcp/debug';
  }

  function mcpPath() {
    const value = String(process.env.PSYCHAPP_MCP_PATH || '/mcp').trim();
    return value.startsWith('/') ? value : `/${value}`;
  }

  function baseUrl(req) {
    return String(process.env.PSYCHAPP_MCP_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || absoluteBaseUrl(req)).replace(/\/$/, '');
  }

  function issuer(req) {
    return String(process.env.PSYCHAPP_OAUTH_ISSUER || baseUrl(req)).replace(/\/$/, '');
  }

  function resourceUrl(req) {
    return `${baseUrl(req)}${mcpPath()}`;
  }

  function scopeList() {
    const raw = String(process.env.PSYCHAPP_MCP_SCOPES || '').trim();
    if (!raw) return DEFAULT_SCOPES;
    return raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  }

  function secret() {
    return String(
      process.env.PSYCHAPP_MCP_OAUTH_SECRET ||
      process.env.OAUTH_COOKIE_SECRET ||
      process.env.SESSION_SECRET ||
      process.env.COOKIE_SECRET ||
      getOpenAIKeyWithMeta()?.value ||
      'dev-only-change-psychapp-mcp-oauth-secret'
    );
  }

  function hmac(data) {
    return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
  }

  function seal(payload, ttlSeconds) {
    const body = {
      ...payload,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      jti: crypto.randomBytes(16).toString('base64url')
    };
    const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    return `${encoded}.${hmac(encoded)}`;
  }

  function openSealed(value, expectedType = '') {
    try {
      const [body, sig] = String(value || '').split('.');
      if (!body || !sig) return null;
      const expected = hmac(body);
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (expectedType && payload.typ !== expectedType) return null;
      if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
      return payload;
    } catch {
      return null;
    }
  }

  function protectedResourceMetadata(req, res) {
    const resource = resourceUrl(req);
    return sendJson(res, 200, {
      resource,
      resource_name: 'PsychApp MCP',
      authorization_servers: [issuer(req)],
      scopes_supported: scopeList(),
      bearer_methods_supported: ['header'],
      resource_documentation: `${baseUrl(req)}/README_OAUTH_SETUP.md`,
      mcp_endpoint: resource
    });
  }

  function authorizationServerMetadata(req, res) {
    const authIssuer = issuer(req);
    return sendJson(res, 200, {
      issuer: authIssuer,
      authorization_endpoint: `${authIssuer}/oauth/authorize`,
      token_endpoint: `${authIssuer}/oauth/token`,
      registration_endpoint: `${authIssuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: scopeList(),
      resource_parameter_supported: true,
      client_id_metadata_document_supported: false,
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['none']
    });
  }

  async function dynamicClientRegistration(req, res) {
    const body = await readJsonOrForm(req);
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!redirectUris.length) return sendJson(res, 400, { error: 'invalid_redirect_uris', error_description: 'redirect_uris is required' });
    const invalid = redirectUris.find(uri => !isAllowedRedirectUri(uri));
    if (invalid) return sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: `Redirect URI not allowed: ${invalid}` });

    const requestedScopes = normalizeScopes(body.scope || scopeList().join(' '));
    const clientPayload = {
      typ: 'client',
      client_name: String(body.client_name || 'ChatGPT'),
      redirect_uris: redirectUris,
      scope: requestedScopes.join(' '),
      token_endpoint_auth_method: body.token_endpoint_auth_method || 'none'
    };
    const clientId = seal(clientPayload, 60 * 60 * 24 * 365);
    await audit('oauth_client_registered', { clientId, metadata: { redirect_uris: redirectUris, client_name: clientPayload.client_name } });
    return sendJson(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientPayload.client_name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: requestedScopes.join(' ')
    });
  }

  async function authorize(req, res) {
    const params = await readOAuthParams(req);
    const clientId = params.get('client_id') || '';
    const client = clientInfo(clientId);
    const redirectUri = params.get('redirect_uri') || '';
    const state = params.get('state') || '';
    const resource = params.get('resource') || resourceUrl(req);
    const scope = normalizeScopes(params.get('scope') || scopeList().join(' ')).join(' ');

    const validation = validateAuthorizeRequest(params, client, redirectUri, resource, req);
    if (!validation.ok) return sendHtml(res, validation.status || 400, consentErrorHtml(validation.message));

    const approved = params.get('approve') === '1';
    const denied = params.get('deny') === '1';
    if (denied) return redirectWithParams(res, redirectUri, { error: 'access_denied', state });

    const configuredPin = String(process.env.PSYCHAPP_MCP_OWNER_PIN || '').trim();
    if (!approved) {
      return sendHtml(res, 200, consentHtml({ req, params, client, redirectUri, resource, scope, pinRequired: Boolean(configuredPin), error: '' }));
    }

    if (configuredPin && params.get('owner_pin') !== configuredPin) {
      return sendHtml(res, 401, consentHtml({ req, params, client, redirectUri, resource, scope, pinRequired: true, error: 'PIN incorrecto.' }));
    }

    const code = seal({
      typ: 'code',
      sub: process.env.PSYCHAPP_OWNER_SUBJECT || 'owner',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: params.get('code_challenge'),
      code_challenge_method: params.get('code_challenge_method') || 'S256',
      resource,
      scope
    }, 300);

    await audit('oauth_authorized', { clientId, subject: process.env.PSYCHAPP_OWNER_SUBJECT || 'owner', resource, scopes: scope.split(/\s+/) });
    return redirectWithParams(res, redirectUri, { code, state, iss: issuer(req) });
  }

  function validateAuthorizeRequest(params, client, redirectUri, resource, req) {
    if (params.get('response_type') !== 'code') return { ok: false, message: 'response_type must be code' };
    if (!client) return { ok: false, message: 'Unknown or invalid OAuth client_id' };
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return { ok: false, message: 'redirect_uri is not registered for this client' };
    if (!isAllowedRedirectUri(redirectUri)) return { ok: false, message: 'redirect_uri is not allowed' };
    if (resource !== resourceUrl(req)) return { ok: false, message: `Invalid resource. Expected ${resourceUrl(req)}` };
    if (!params.get('code_challenge')) return { ok: false, message: 'PKCE code_challenge is required' };
    if ((params.get('code_challenge_method') || 'S256') !== 'S256') return { ok: false, message: 'Only PKCE S256 is supported' };
    return { ok: true };
  }

  async function token(req, res) {
    const params = await readOAuthParams(req);
    const basic = basicClientAuth(req);
    if (basic.client_id && !params.get('client_id')) params.set('client_id', basic.client_id);
    if (basic.client_secret && !params.get('client_secret')) params.set('client_secret', basic.client_secret);

    const grantType = params.get('grant_type');
    if (grantType === 'authorization_code') return authorizationCodeToken(req, res, params);
    if (grantType === 'refresh_token') return refreshToken(req, res, params);
    return sendJson(res, 400, { error: 'unsupported_grant_type', error_description: 'Use authorization_code or refresh_token' });
  }

  async function authorizationCodeToken(req, res, params) {
    const codeValue = params.get('code') || '';
    const code = openSealed(codeValue, 'code');
    if (!code) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'Authorization code is invalid or expired' });
    if (usedAuthorizationCodes.has(code.jti)) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'Authorization code already used' });

    const clientId = params.get('client_id') || code.client_id;
    if (clientId !== code.client_id) return sendJson(res, 400, { error: 'invalid_client', error_description: 'client_id does not match authorization code' });
    if ((params.get('redirect_uri') || '') !== code.redirect_uri) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri does not match authorization code' });
    if (!verifyPkce(params.get('code_verifier') || '', code.code_challenge)) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });

    usedAuthorizationCodes.add(code.jti);
    const out = issueTokens({ clientId, subject: code.sub, resource: code.resource, scope: code.scope });
    await audit('oauth_token_issued', { clientId, subject: code.sub, resource: code.resource, scopes: String(code.scope || '').split(/\s+/) });
    return sendJson(res, 200, out);
  }

  async function refreshToken(req, res, params) {
    const refresh = openSealed(params.get('refresh_token') || '', 'refresh');
    if (!refresh) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'refresh_token is invalid or expired' });
    const clientId = params.get('client_id') || refresh.client_id;
    if (clientId !== refresh.client_id) return sendJson(res, 400, { error: 'invalid_client', error_description: 'client_id does not match refresh_token' });
    const out = issueTokens({ clientId, subject: refresh.sub, resource: refresh.aud, scope: refresh.scope });
    await audit('oauth_token_refreshed', { clientId, subject: refresh.sub, resource: refresh.aud, scopes: String(refresh.scope || '').split(/\s+/) });
    return sendJson(res, 200, out);
  }

  function issueTokens({ clientId, subject, resource, scope }) {
    const accessTtl = Number(process.env.PSYCHAPP_MCP_ACCESS_TOKEN_TTL_SECONDS || 3600);
    const refreshTtl = Number(process.env.PSYCHAPP_MCP_REFRESH_TOKEN_TTL_SECONDS || 60 * 60 * 24 * 30);
    const accessToken = seal({ typ: 'access', sub: subject, client_id: clientId, aud: resource, scope }, accessTtl);
    const refreshTokenValue = seal({ typ: 'refresh', sub: subject, client_id: clientId, aud: resource, scope }, refreshTtl);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: accessTtl,
      refresh_token: refreshTokenValue,
      scope,
      resource
    };
  }

  function clientInfo(clientId) {
    const predefinedId = String(process.env.PSYCHAPP_MCP_CLIENT_ID || '').trim();
    if (predefinedId && clientId === predefinedId) {
      const redirectUris = String(process.env.PSYCHAPP_MCP_REDIRECT_URIS || '')
        .split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
      return { client_id: clientId, client_name: 'PsychApp predefined client', redirect_uris: redirectUris, scope: scopeList().join(' ') };
    }
    const decoded = openSealed(clientId, 'client');
    if (!decoded) return null;
    return { client_id: clientId, ...decoded };
  }

  function isAllowedRedirectUri(uri) {
    let parsed;
    try { parsed = new URL(uri); } catch { return false; }
    if (parsed.protocol !== 'https:') return false;

    const explicit = String(process.env.PSYCHAPP_MCP_ALLOWED_REDIRECT_URIS || '')
      .split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    if (explicit.length) return explicit.includes(uri);

    if (parsed.origin === 'https://chatgpt.com' && parsed.pathname.startsWith('/connector/oauth/')) return true;
    if (uri === 'https://chatgpt.com/connector_platform_oauth_redirect') return true;
    if (process.env.NODE_ENV !== 'production' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) return true;
    return false;
  }

  function verifyPkce(verifier, challenge) {
    if (!verifier || !challenge) return false;
    const actual = crypto.createHash('sha256').update(verifier).digest('base64url');
    try { return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(challenge)); } catch { return false; }
  }

  async function handleMcp(req, res, tokenPayload) {
    const raw = await readBody(req);
    let json;
    try { json = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error')); }
    const batch = Array.isArray(json) ? json : [json];
    const results = [];
    for (const item of batch) {
      const result = await handleJsonRpc(req, item, tokenPayload);
      if (result) results.push(result);
    }
    if (Array.isArray(json)) return sendJson(res, 200, results);
    if (!results.length) return sendJson(res, 202, { ok: true });
    return sendJson(res, 200, results[0]);
  }

  async function handleJsonRpc(req, msg, tokenPayload) {
    if (!msg || msg.jsonrpc !== '2.0' || !msg.method) return jsonRpcError(msg?.id || null, -32600, 'Invalid Request');
    const id = Object.prototype.hasOwnProperty.call(msg, 'id') ? msg.id : undefined;
    const reply = result => id === undefined ? null : ({ jsonrpc: '2.0', id, result });

    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: msg.params?.protocolVersion || MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'psychapp', title: 'PsychApp', version: '1.0.0' },
          instructions: 'PsychApp MCP provides read-only psychological-computational analysis utilities and setup guidance. Do not infer clinical diagnoses. Ask for user consent before processing sensitive personal data.'
        });
      case 'notifications/initialized':
        return null;
      case 'ping':
        return reply({ ok: true });
      case 'tools/list':
      case 'list_tools':
        return reply({ tools: MCP_TOOLS });
      case 'tools/call':
      case 'call_tool': {
        const toolName = msg.params?.name || msg.params?.tool || '';
        const args = msg.params?.arguments || msg.params?.args || {};
        const toolResult = await callTool(req, tokenPayload, toolName, args);
        return reply(toolResult);
      }
      case 'resources/list':
        return reply({ resources: [] });
      case 'prompts/list':
        return reply({ prompts: [] });
      default:
        return jsonRpcError(id ?? null, -32601, `Method not found: ${msg.method}`);
    }
  }

  async function callTool(req, tokenPayload, toolName, args) {
    await audit('mcp_tool_call', {
      clientId: tokenPayload.client_id,
      subject: tokenPayload.sub,
      resource: tokenPayload.aud,
      scopes: String(tokenPayload.scope || '').split(/\s+/),
      toolName,
      metadata: { arguments_keys: args && typeof args === 'object' ? Object.keys(args) : [] }
    });

    try {
      if (toolName === 'psychapp_status') return toolContent(statusPayload(req, tokenPayload));
      if (toolName === 'psychapp_analyze_text_sample') return toolContent(analyzeTextSample(args));
      if (toolName === 'psychapp_plan_data_sources') return toolContent(planDataSources(args));
      if (toolName === 'psychapp_record_analysis_snapshot') return toolContent(await recordSnapshot(tokenPayload, args));
      return toolContent({ ok: false, error: `Unknown tool: ${toolName}` }, true);
    } catch (err) {
      return toolContent({ ok: false, error: err.message || 'Tool failed' }, true);
    }
  }

  function statusPayload(req, tokenPayload) {
    const diagnostics = publicDiagnostics(req);
    return {
      ok: true,
      app: 'PsychApp',
      mcp_endpoint: resourceUrl(req),
      subject: tokenPayload.sub,
      scopes: String(tokenPayload.scope || '').split(/\s+/).filter(Boolean),
      tools: MCP_TOOLS.map(t => ({ name: t.name, description: t.description })),
      openai_backend_key_present: Boolean(diagnostics?.openai?.key_present),
      supabase_optional_audit_enabled: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      privacy: 'Do not send raw sensitive clinical or personal data unless the user explicitly requests analysis and understands that ChatGPT will call this external MCP server.'
    };
  }

  function analyzeTextSample(args = {}) {
    const text = String(args.text || '').slice(0, 12000);
    if (!text.trim()) throw new Error('text is required');
    const words = text.trim().split(/\s+/).filter(Boolean);
    const sentences = text.split(/[.!?¡¿]+/).map(s => s.trim()).filter(Boolean);
    const lower = text.toLowerCase();
    const markers = {
      first_person: countMatches(lower, /\b(yo|me|mí|mi|mine|i|me|my)\b/g),
      uncertainty: countMatches(lower, /\b(quizá|quizas|tal vez|puede|posible|maybe|perhaps|possibly)\b/g),
      urgency: countMatches(lower, /\b(urgente|ya|ahora|inmediato|crisis|urgent|now|asap)\b/g),
      negative_affect: countMatches(lower, /\b(miedo|culpa|vergüenza|ansiedad|triste|rabia|angustia|fear|guilt|shame|anxiety|sad|anger)\b/g),
      agency: countMatches(lower, /\b(puedo|voy a|decido|haré|plan|puedo hacer|i can|i will|plan)\b/g)
    };
    const flags = [];
    if (markers.urgency > 2) flags.push('high_urgency_language');
    if (markers.negative_affect > 2) flags.push('negative_affect_markers');
    if (markers.uncertainty > 2) flags.push('uncertainty_or_hedging');
    if (markers.agency > 1) flags.push('agency_language_present');
    return {
      ok: true,
      type: 'non_diagnostic_text_analysis',
      counts: { characters: text.length, words: words.length, sentences: sentences.length },
      markers,
      flags,
      summary: 'Heuristic linguistic analysis only. This is not a clinical diagnosis, risk assessment, or validated psychometric instrument.',
      suggested_next_step: 'Use this as a first-pass signal, then ask the user for context and consent before deeper psychological interpretation.'
    };
  }

  function planDataSources(args = {}) {
    const goal = String(args.goal || 'psychological-computational profile');
    const sources = Array.isArray(args.sources) ? args.sources.map(String) : ['Gmail', 'Google Drive', 'Calendar', 'WhatsApp exports'];
    return {
      ok: true,
      goal,
      recommended_sequence: [
        'Start with explicit user consent and a narrow question.',
        'Prefer exported text samples or metadata-minimized datasets before full account connectors.',
        'Separate ingestion, preprocessing, analysis and interpretation steps.',
        'Log which data classes were used and allow deletion/revocation.',
        'Avoid diagnostic claims unless validated clinical instruments and clinician review are present.'
      ],
      sources: sources.map(source => ({
        source,
        suggested_mode: /gmail|drive|calendar/i.test(source) ? 'OAuth connector or exported subset' : 'user-uploaded export',
        privacy_note: 'Use least-privilege and avoid raw secrets/tokens in prompts.'
      }))
    };
  }

  async function recordSnapshot(tokenPayload, args = {}) {
    const title = String(args.title || '').trim();
    if (!title) throw new Error('title is required');
    const payload = {
      owner_subject: tokenPayload.sub || 'owner',
      title: title.slice(0, 200),
      summary: String(args.summary || '').slice(0, 2000),
      source: 'mcp',
      payload: sanitizeJson(args.payload || args)
    };
    const stored = await supabaseInsert('psychapp_analysis_snapshots', payload);
    return {
      ok: true,
      persisted: Boolean(stored?.ok),
      storage: stored?.ok ? 'supabase' : 'none',
      note: stored?.ok ? 'Snapshot stored in Supabase.' : 'Snapshot validated but not persisted because SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are not configured on the server.',
      snapshot: stored?.data || payload
    };
  }

  async function audit(eventType, { clientId = '', subject = '', resource = '', scopes = [], toolName = '', metadata = {} } = {}) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;
    await supabaseInsert('psychapp_mcp_oauth_audit', {
      event_type: eventType,
      subject: subject || null,
      client_id_hash: clientId ? crypto.createHash('sha256').update(clientId).digest('hex') : null,
      tool_name: toolName || null,
      resource: resource || null,
      scopes: Array.isArray(scopes) ? scopes.filter(Boolean) : [],
      metadata: sanitizeJson(metadata)
    }).catch(() => null);
  }

  async function supabaseInsert(table, payload) {
    const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
    if (!url || !key) return { ok: false };
    const response = await fetch(`${url}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: response.ok, status: response.status, data };
  }

  function publicMcpDiagnostics(req) {
    return {
      ok: true,
      mcp_endpoint: resourceUrl(req),
      protected_resource_metadata: `${baseUrl(req)}/.well-known/oauth-protected-resource`,
      oauth_metadata: `${issuer(req)}/.well-known/oauth-authorization-server`,
      authorization_endpoint: `${issuer(req)}/oauth/authorize`,
      token_endpoint: `${issuer(req)}/oauth/token`,
      registration_endpoint: `${issuer(req)}/oauth/register`,
      scopes_supported: scopeList(),
      owner_pin_configured: Boolean(String(process.env.PSYCHAPP_MCP_OWNER_PIN || '').trim()),
      supabase_audit_enabled: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      allowed_redirect_policy: process.env.PSYCHAPP_MCP_ALLOWED_REDIRECT_URIS ? 'explicit_env_allowlist' : 'chatgpt_default_allowlist'
    };
  }

  function verifyBearer(req) {
    const auth = String(req.headers.authorization || '');
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return { ok: false, scope: 'psychapp:read' };
    const token = openSealed(match[1], 'access');
    if (!token) return { ok: false, scope: 'psychapp:read' };
    if (token.aud !== resourceUrl(req)) return { ok: false, scope: token.scope || 'psychapp:read' };
    return { ok: true, token };
  }

  function unauthorized(req, res, scope = 'psychapp:read') {
    return sendJson(res, 401, {
      error: 'unauthorized',
      error_description: 'Bearer access token required for PsychApp MCP.',
      resource_metadata: `${baseUrl(req)}/.well-known/oauth-protected-resource`
    }, {
      'WWW-Authenticate': `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource", scope="${scope}"`
    });
  }

  async function readOAuthParams(req) {
    const url = new URL(req.url, fallbackBaseUrl(req));
    const params = new URLSearchParams(url.searchParams);
    if (req.method === 'POST') {
      const body = await readBody(req);
      const ctype = String(req.headers['content-type'] || '').toLowerCase();
      if (ctype.includes('application/json')) {
        const json = JSON.parse(body || '{}');
        for (const [key, value] of Object.entries(json)) if (value != null) params.set(key, String(value));
      } else {
        const form = new URLSearchParams(body);
        for (const [key, value] of form.entries()) params.set(key, value);
      }
    }
    return params;
  }

  async function readJsonOrForm(req) {
    const body = await readBody(req);
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (ctype.includes('application/json')) return JSON.parse(body || '{}');
    return Object.fromEntries(new URLSearchParams(body).entries());
  }

  function basicClientAuth(req) {
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Basic ')) return {};
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx < 0) return {};
      return { client_id: decoded.slice(0, idx), client_secret: decoded.slice(idx + 1) };
    } catch { return {}; }
  }

  function redirectWithParams(res, redirectUri, params) {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) if (value != null && value !== '') url.searchParams.set(key, value);
    res.writeHead(302, { Location: url.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  function methodNotAllowed(res, allowed) {
    return sendJson(res, 405, { error: { message: `Method not allowed. Use: ${allowed}` } }, { Allow: allowed });
  }

  function consentHtml({ req, params, client, redirectUri, resource, scope, pinRequired, error }) {
    const hidden = [...params.entries()]
      .filter(([key]) => !['approve', 'deny', 'owner_pin'].includes(key))
      .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join('\n');
    const pinField = pinRequired
      ? `<label>PIN PsychApp<br><input name="owner_pin" type="password" required autocomplete="current-password" style="width:100%;padding:10px;margin-top:4px"></label>`
      : `<div class="warn">No hay PSYCHAPP_MCP_OWNER_PIN configurado. Para producción, configura un PIN o delega en un IdP real.</div>`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize PsychApp MCP</title><style>body{font-family:system-ui;margin:0;background:#111;color:#eee}main{max-width:680px;margin:0 auto;padding:32px 18px}.card{background:#1d1d1d;border:1px solid #333;border-radius:14px;padding:22px}button{padding:10px 14px;border-radius:8px;border:0;cursor:pointer}.ok{background:#4ade80;color:#07130a}.deny{background:#333;color:#eee}.warn{padding:10px;background:#3b2f12;border:1px solid #806220;border-radius:8px;margin:12px 0;color:#facc15}.err{padding:10px;background:#3b1212;border:1px solid #7f1d1d;border-radius:8px;margin:12px 0;color:#fecaca}code{word-break:break-all}</style></head><body><main><div class="card"><h1>Autorizar PsychApp MCP</h1><p><strong>${escapeHtml(client?.client_name || 'ChatGPT')}</strong> solicita conectar ChatGPT con PsychApp.</p>${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}<p><strong>Recurso:</strong><br><code>${escapeHtml(resource)}</code></p><p><strong>Permisos:</strong> ${escapeHtml(scope)}</p><p>Esto permitirá que ChatGPT liste y llame herramientas MCP de PsychApp. No concede acceso directo a Gmail/Drive salvo que una herramienta futura lo implemente explícitamente.</p><form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="approve" value="1">${pinField}<p style="display:flex;gap:10px;margin-top:18px"><button class="ok" type="submit">Autorizar</button><button class="deny" name="deny" value="1" formaction="/oauth/authorize">Denegar</button></p></form><p style="color:#aaa;font-size:13px">Redirect: <code>${escapeHtml(redirectUri)}</code></p></div></main></body></html>`;
  }

  function consentErrorHtml(message) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OAuth error</title></head><body style="font-family:system-ui;padding:2rem"><h1>PsychApp OAuth error</h1><p>${escapeHtml(message)}</p></body></html>`;
  }

  return handle;
}

const MCP_TOOLS = [
  {
    name: 'psychapp_status',
    title: 'PsychApp status',
    description: 'Inspect PsychApp MCP capabilities, privacy posture, configured storage and available tools. Use before other PsychApp tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'psychapp_analyze_text_sample',
    title: 'Analyze text sample',
    description: 'Run a non-diagnostic heuristic analysis of a user-provided text sample for linguistic markers relevant to a psychological-computational profile.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Text to analyze. Avoid unnecessary sensitive data.' },
        context: { type: 'string', description: 'Optional context supplied by the user.' },
        language: { type: 'string', description: 'Optional language code, e.g. es or en.' }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'psychapp_plan_data_sources',
    title: 'Plan PsychApp data sources',
    description: 'Create a privacy-aware ingestion and consent plan for psychological-computational analysis across sources such as Gmail, Drive, Calendar or exported chats.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        sources: { type: 'array', items: { type: 'string' } }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'psychapp_record_analysis_snapshot',
    title: 'Record analysis snapshot',
    description: 'Validate and optionally persist a PsychApp analysis snapshot if Supabase service credentials are configured on the server.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        payload: { type: 'object', additionalProperties: true }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }
];

function normalizeScopes(scopeValue) {
  const allowed = new Set(DEFAULT_SCOPES.concat(String(process.env.PSYCHAPP_MCP_SCOPES || '').split(/[\s,]+/).filter(Boolean)));
  const requested = String(scopeValue || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const filtered = requested.filter(scope => allowed.has(scope));
  return filtered.length ? [...new Set(filtered)] : DEFAULT_SCOPES;
}

function toolContent(obj, isError = false) {
  return {
    isError,
    structuredContent: obj,
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }]
  };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function countMatches(text, regex) {
  return (text.match(regex) || []).length;
}

function sanitizeJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fallbackBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  return `${proto}://${req.headers.host}`;
}

function fallbackSendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(status === 204 ? '' : JSON.stringify(payload));
}

function fallbackSendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(html);
}

function fallbackReadBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
