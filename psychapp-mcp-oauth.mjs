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
      if (toolName === 'search') return toolContent(searchKnowledge(args));
      if (toolName === 'fetch') return toolContent(fetchKnowledge(args));
      if (toolName === 'psychapp_status') return toolContent(statusPayload(req, tokenPayload));
      if (toolName === 'psychapp_analyze_text_sample') return toolContent(analyzeTextSample(args));
      if (toolName === 'psychapp_plan_data_sources') return toolContent(planDataSources(args));
      if (toolName === 'psychapp_plan_early_warning_report') return toolContent(planEarlyWarningReport(args));
      if (toolName === 'psychapp_build_early_warning_report') return toolContent(buildEarlyWarningReport(args));
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
      skill_contract: {
        non_diagnostic: true,
        consent_required: true,
        baseline_days_minimum: 30,
        preferred_baseline_days: 90,
        current_windows: ['24h', '3d', '7d', '30d'],
        risk_flags: ['Low', 'Moderate', 'High', 'Acute']
      },
      privacy: 'Use explicit consent, source-specific permissions and metadata-minimized inputs for mental-health early warning analysis. Do not send raw sensitive clinical or personal data unless the user explicitly allows that source.'
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

  function planEarlyWarningReport(args = {}) {
    const allowedSourceCategories = [
      'calendar',
      'email_metadata',
      'email_text',
      'tasks',
      'notes',
      'chat_history',
      'uploaded_files',
      'public_profiles',
      'remote_mcp',
      'wearables',
      'sleep_logs',
      'location'
    ];
    const sources = Array.isArray(args.sources)
      ? args.sources.map(String).filter(source => allowedSourceCategories.includes(source))
      : ['calendar', 'email_metadata', 'tasks'];
    const baselineDays = Math.min(Math.max(Number.parseInt(args.baseline_days || 90, 10) || 90, 30), 365);
    return {
      ok: true,
      type: 'mental_health_early_warning_plan',
      non_diagnostic: true,
      consent_gate: {
        required: true,
        statement: 'Confirm explicit user consent before reading connected data; email text, notes, chat history, health/activity data and location require source-specific permission.'
      },
      recommended_payload: {
        analysis_mode: 'early_warning_report',
        mental_health_early_warning: {
          enabled: true,
          consent_confirmed: true,
          allowed_sources: sources,
          baseline_days: baselineDays,
          current_windows: ['24h', '3d', '7d', '30d']
        }
      },
      source_categories: allowedSourceCategories,
      output_sections: [
        'Consent status',
        'Data sources analyzed',
        'Time window',
        'Baseline window',
        'Overall risk flag',
        'Confidence',
        'Main changes detected',
        'Evidence chain',
        'Protective factors still present',
        'Possible vulnerability pattern',
        'Recommended next 24 hours',
        'When to escalate'
      ],
      safety: 'Risk flags are Low/Moderate/High/Acute behavioral flags, not diagnoses or crisis predictions.'
    };
  }

  function buildEarlyWarningReport(args = {}) {
    const consentConfirmed = args.consent_confirmed === true || args.consent_confirmed === 'true';
    if (!consentConfirmed) {
      return {
        ok: false,
        consent_required: true,
        report_markdown: consentRequestText(),
        structured_report: {
          consent_status: 'not_confirmed',
          overall_risk_flag: 'Unknown',
          confidence: 'Low',
          limitations: ['No connected or uploaded data should be analyzed before explicit consent.']
        }
      };
    }

    const sources = normalizeAllowedSourceList(args.sources || args.allowed_sources || ['calendar', 'email_metadata', 'tasks']);
    const baselineDays = Math.min(Math.max(Number.parseInt(args.baseline_days || 90, 10) || 90, 30), 365);
    const windows = normalizeCurrentWindows(args.current_windows);
    const aggregate = summarizeDailyMetrics(args.daily_metrics || args.metrics || null);
    const acute = args.acute_signals_present === true || args.acute_signals_present === 'true';
    const riskFlag = acute ? 'Acute' : aggregate.risk_flag;
    const confidence = aggregate.metric_count >= 4 ? 'Medium' : aggregate.metric_count >= 1 ? 'Low' : 'Low';
    const context = String(args.summary_context || args.context || '').slice(0, 1200);
    const report = renderEarlyWarningMarkdown({
      sources,
      baselineDays,
      windows,
      riskFlag,
      confidence,
      aggregate,
      context,
      acute
    });

    return {
      ok: true,
      type: 'mental_health_early_warning_report',
      non_diagnostic: true,
      consent_status: 'confirmed',
      report_markdown: report,
      structured_report: {
        data_sources_analyzed: sources,
        baseline_window_days: baselineDays,
        current_windows: windows,
        overall_risk_flag: riskFlag,
        confidence,
        metric_summary: aggregate,
        limitations: aggregate.limitations
      }
    };
  }

  function searchKnowledge(args = {}) {
    const query = String(args.query || '').toLowerCase().trim();
    const tokens = query.split(/\s+/).filter(Boolean);
    const results = KNOWLEDGE_DOCS
      .map(doc => {
        const haystack = [doc.title, doc.text, doc.keywords.join(' ')].join(' ').toLowerCase();
        const score = tokens.length
          ? tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0)
          : 1;
        return { ...doc, score };
      })
      .filter(doc => !tokens.length || doc.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(Number.parseInt(args.limit || 5, 10) || 5, 1), 10))
      .map(({ id, title, text, keywords }) => ({
        id,
        title,
        text: text.slice(0, 360),
        keywords
      }));
    return { ok: true, results };
  }

  function fetchKnowledge(args = {}) {
    const id = String(args.id || '').trim();
    const doc = KNOWLEDGE_DOCS.find(item => item.id === id);
    if (!doc) return { ok: false, error: `Unknown document id: ${id}`, available_ids: KNOWLEDGE_DOCS.map(item => item.id) };
    return {
      ok: true,
      id: doc.id,
      title: doc.title,
      text: doc.text,
      metadata: {
        non_diagnostic: true,
        consent_based: true,
        source: 'PsychApp MCP static knowledge'
      }
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

const GENERIC_OBJECT_SCHEMA = { type: 'object', additionalProperties: true };
const SECURITY_READ = [{ type: 'oauth2', scopes: ['psychapp:read'] }];
const SECURITY_ANALYZE = [{ type: 'oauth2', scopes: ['psychapp:analyze'] }];

function toolMeta(invoking, invoked, securitySchemes = SECURITY_READ) {
  return {
    securitySchemes,
    'openai/toolInvocation/invoking': invoking,
    'openai/toolInvocation/invoked': invoked
  };
}

const MCP_TOOLS = [
  {
    name: 'search',
    title: 'Search PsychApp guidance',
    description: 'Use this when you need to search PsychApp early-warning guidance, consent rules, report templates, connector setup, or OAuth permission notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'number', minimum: 1, maximum: 10 }
      },
      additionalProperties: false
    },
    outputSchema: GENERIC_OBJECT_SCHEMA,
    securitySchemes: SECURITY_READ,
    _meta: toolMeta('Searching PsychApp guidance', 'Searched PsychApp guidance'),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'fetch',
    title: 'Fetch PsychApp guidance',
    description: 'Use this when you need the full text for a PsychApp guidance item returned by search.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Document id returned by search.' }
      },
      additionalProperties: false
    },
    outputSchema: GENERIC_OBJECT_SCHEMA,
    securitySchemes: SECURITY_READ,
    _meta: toolMeta('Fetching PsychApp guidance', 'Fetched PsychApp guidance'),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'psychapp_status',
    title: 'PsychApp status',
    description: 'Inspect PsychApp MCP capabilities, privacy posture, configured storage and available tools. Use before other PsychApp tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: GENERIC_OBJECT_SCHEMA,
    securitySchemes: SECURITY_READ,
    _meta: toolMeta('Checking PsychApp status', 'Checked PsychApp status'),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
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
    outputSchema: GENERIC_OBJECT_SCHEMA,
    securitySchemes: SECURITY_ANALYZE,
    _meta: toolMeta('Analyzing text sample', 'Analyzed text sample', SECURITY_ANALYZE),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
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
    outputSchema: GENERIC_OBJECT_SCHEMA,
    securitySchemes: SECURITY_READ,
    _meta: toolMeta('Planning sources', 'Planned sources'),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'psychapp_plan_early_warning_report',
    title: 'Plan early warning report',
    description: 'Create a consent-based, non-diagnostic early-warning report plan with source categories, baseline window and comparison windows.',
    inputSchema: {
      type: 'object',
      properties: {
        baseline_days: { type: 'number', minimum: 30, maximum: 365 },
        sources: { type: 'array', items: { type: 'string' } }
      },
      additionalProperties: false
    },
    outputSchema: GENERIC_OBJECT_SCHEMA,
    securitySchemes: SECURITY_READ,
    _meta: toolMeta('Planning report', 'Planned report'),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'psychapp_build_early_warning_report',
    title: 'Build early warning report',
    description: 'Use this when you have explicit consent and aggregated daily behavioral metrics and need a non-diagnostic early-warning report with baseline comparison, risk flag, limitations, and next-24-hour steps.',
    inputSchema: {
      type: 'object',
      required: ['consent_confirmed'],
      properties: {
        consent_confirmed: { type: 'boolean' },
        sources: { type: 'array', items: { type: 'string' } },
        baseline_days: { type: 'number', minimum: 30, maximum: 365 },
        current_windows: { type: 'array', items: { type: 'string', enum: ['24h', '3d', '7d', '30d'] } },
        daily_metrics: {
          description: 'Aggregated daily metrics as an object of numeric arrays or an array of daily metric objects. Do not include raw private content.',
          oneOf: [
            { type: 'object', additionalProperties: { type: 'array', items: { type: 'number' } } },
            { type: 'array', items: { type: 'object', additionalProperties: true } }
          ]
        },
        summary_context: { type: 'string', description: 'Optional user-provided context, minimized and non-diagnostic.' },
        acute_signals_present: { type: 'boolean' }
      },
      additionalProperties: false
    },
    outputSchema: GENERIC_OBJECT_SCHEMA,
    securitySchemes: SECURITY_ANALYZE,
    _meta: toolMeta('Building early warning report', 'Built early warning report', SECURITY_ANALYZE),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
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
    outputSchema: GENERIC_OBJECT_SCHEMA,
    securitySchemes: SECURITY_ANALYZE,
    _meta: toolMeta('Recording snapshot', 'Recorded snapshot', SECURITY_ANALYZE),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];

const KNOWLEDGE_DOCS = [
  {
    id: 'early_warning_workflow',
    title: 'Mental health early-warning workflow',
    keywords: ['workflow', 'baseline', 'risk', 'early warning', 'alerta temprana'],
    text: [
      'PsychApp early-warning analysis is consent-based and non-diagnostic.',
      'Use only allowed source categories, prefer aggregate metrics, build a user-specific baseline of at least 30 days and preferably 90 days, and compare current 24h, 3d, 7d and 30d windows.',
      'Output must include risk flag Low, Moderate, High or Acute; confidence; evidence chain; limitations; protective factors; and next-24-hour prevention steps.',
      'Do not diagnose, claim certainty, or continue ordinary analysis during acute risk.'
    ].join('\n')
  },
  {
    id: 'consent_policy',
    title: 'Consent and minimization policy',
    keywords: ['consent', 'privacy', 'sources', 'minimization', 'oauth'],
    text: [
      'Before reading connected data, confirm explicit user consent.',
      'Calendar, email metadata and task metrics may be used when explicitly selected.',
      'Email text, notes, chat history, uploaded files, wearables, sleep logs and location require source-specific permission.',
      'Never analyze third parties without consent. Never expose raw private content when aggregate metrics are enough.'
    ].join('\n')
  },
  {
    id: 'report_template',
    title: 'Early-warning report template',
    keywords: ['template', 'report', 'markdown', 'risk flag'],
    text: [
      '## Mental Health Early Warning Report',
      '**Consent status:** Confirmed / Not confirmed',
      '**Data sources analyzed:**',
      '**Time window:**',
      '**Baseline window:**',
      '**Overall risk flag:** Low / Moderate / High / Acute',
      '**Confidence:** Low / Medium / High',
      '### Main changes detected',
      '### Evidence chain',
      '### Protective factors still present',
      '### Possible vulnerability pattern',
      '### Recommended next 24 hours',
      '### When to escalate'
    ].join('\n')
  },
  {
    id: 'connector_permissions',
    title: 'Google and Microsoft connector permissions',
    keywords: ['google', 'microsoft', 'oauth', 'gmail', 'calendar', 'teams'],
    text: [
      'Google defaults: openid, email, profile, Gmail read-only, Drive read-only and Calendar events read-only.',
      'Microsoft defaults: openid, profile, email, offline_access, User.Read, Mail.Read, Files.Read.All and Calendars.Read.',
      'Teams and SharePoint organization data require Microsoft 365 organizational accounts, admin consent, and explicit custom scopes.',
      'Reconnect providers after changing scopes because existing tokens do not automatically gain new permissions.'
    ].join('\n')
  }
];

function consentRequestText() {
  return [
    'I can analyze connected or uploaded behavioral data only with explicit consent.',
    'I would look for aggregated behavioral patterns such as routine disruption, isolation, sleep/rhythm proxies, task completion changes, and language tone.',
    'This is non-diagnostic and does not replace professional care.',
    'Please confirm consent and specify which sources may be used.'
  ].join(' ');
}

function normalizeAllowedSourceList(value) {
  const allowed = new Set([
    'calendar',
    'email_metadata',
    'email_text',
    'tasks',
    'notes',
    'chat_history',
    'uploaded_files',
    'public_profiles',
    'remote_mcp',
    'wearables',
    'sleep_logs',
    'location'
  ]);
  const items = Array.isArray(value) ? value : [];
  const out = items.map(String).filter(item => allowed.has(item));
  return out.length ? [...new Set(out)] : ['calendar', 'email_metadata', 'tasks'];
}

function normalizeCurrentWindows(value) {
  const allowed = new Set(['24h', '3d', '7d', '30d']);
  const items = Array.isArray(value) ? value.map(String).filter(item => allowed.has(item)) : [];
  return items.length ? [...new Set(items)] : ['24h', '3d', '7d', '30d'];
}

function normalizeMetricInput(raw) {
  if (!raw) return {};
  const out = {};
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue;
      for (const [key, value] of Object.entries(row)) {
        if (key === 'date') continue;
        const number = Number(value);
        if (!Number.isFinite(number)) continue;
        if (!out[key]) out[key] = [];
        out[key].push(number);
      }
    }
    return out;
  }
  if (typeof raw === 'object') {
    for (const [key, values] of Object.entries(raw)) {
      if (!Array.isArray(values)) continue;
      const series = values.map(Number).filter(Number.isFinite);
      if (series.length) out[key] = series;
    }
  }
  return out;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const avg = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function summarizeDailyMetrics(raw) {
  const metrics = normalizeMetricInput(raw);
  const metricSummaries = {};
  let strongDeviationCount = 0;
  let sensitiveDeviationCount = 0;
  const sensitive = new Set([
    'late_night_activity',
    'negative_language_score',
    'hopeless_language_score',
    'substance_reference_count',
    'missed_obligations',
    'distinct_contacts',
    'tasks_completed',
    'sleep_hours'
  ]);

  for (const [metric, series] of Object.entries(metrics)) {
    const clean = series.map(Number).filter(Number.isFinite);
    if (clean.length < 5) {
      metricSummaries[metric] = { n: clean.length, status: 'not_enough_data' };
      continue;
    }
    const splitIndex = Math.max(1, clean.length - Math.min(7, Math.ceil(clean.length / 4)));
    const baseline = clean.slice(0, splitIndex);
    const current = clean.slice(splitIndex);
    const baselineMean = average(baseline);
    const currentMean = average(current);
    const sd = standardDeviation(baseline);
    const z = sd ? (currentMean - baselineMean) / sd : 0;
    const percentChange = baselineMean ? ((currentMean - baselineMean) / Math.abs(baselineMean)) * 100 : 0;
    const strong = Math.abs(z) >= 2 || Math.abs(percentChange) >= 40;
    if (strong) {
      strongDeviationCount += 1;
      if (sensitive.has(metric)) sensitiveDeviationCount += 1;
    }
    metricSummaries[metric] = {
      n: clean.length,
      baseline_mean: Number(baselineMean.toFixed(3)),
      current_mean: Number(currentMean.toFixed(3)),
      z_score: Number(z.toFixed(3)),
      percent_change: Number(percentChange.toFixed(1)),
      strong_deviation: strong
    };
  }

  const metricCount = Object.keys(metricSummaries).length;
  const riskFlag = sensitiveDeviationCount >= 3 || strongDeviationCount >= 5
    ? 'High'
    : sensitiveDeviationCount >= 1 || strongDeviationCount >= 2
      ? 'Moderate'
      : 'Low';

  return {
    metric_count: metricCount,
    strong_deviation_count: strongDeviationCount,
    sensitive_deviation_count: sensitiveDeviationCount,
    risk_flag: metricCount ? riskFlag : 'Low',
    metrics: metricSummaries,
    limitations: metricCount
      ? ['Daily metrics are aggregate proxies, not direct clinical measurements.', 'Recent windows are inferred from the tail of the provided series.']
      : ['No numeric daily metrics were provided, so confidence is low and the report is a template-level summary.']
  };
}

function renderEarlyWarningMarkdown({ sources, baselineDays, windows, riskFlag, confidence, aggregate, context, acute }) {
  const changeLines = Object.entries(aggregate.metrics || {})
    .filter(([, summary]) => summary.strong_deviation)
    .slice(0, 5)
    .map(([metric, summary], index) => `${index + 1}. ${metric}: current mean ${summary.current_mean} vs baseline ${summary.baseline_mean} (z=${summary.z_score}, change=${summary.percent_change}%).`);
  const mainChanges = acute
    ? ['1. Possible acute danger signal was provided; ordinary analytics should stop.']
    : changeLines.length
      ? changeLines
      : ['1. No strong aggregate deviations were detected in the provided metrics, or no metrics were provided.'];
  const limitations = aggregate.limitations.map(item => `- ${item}`).join('\n');
  return [
    '## Mental Health Early Warning Report',
    '',
    '**Consent status:** Confirmed',
    `**Data sources analyzed:** ${sources.join(', ') || 'None'}`,
    `**Time window:** ${windows.join(', ')}`,
    `**Baseline window:** ${baselineDays} days requested`,
    `**Overall risk flag:** ${riskFlag}`,
    `**Confidence:** ${confidence}`,
    '',
    '### Main changes detected',
    '',
    ...mainChanges,
    '',
    '### Evidence chain',
    '',
    `- Baseline: ${baselineDays}-day user-specific baseline requested.`,
    `- Current pattern: compared using ${windows.join(', ')} windows where data supports it.`,
    `- Deviation: ${aggregate.strong_deviation_count} strong aggregate deviation(s), ${aggregate.sensitive_deviation_count} in sensitive early-warning metrics.`,
    `- Interpretation: ${riskFlag === 'Low' ? 'minor or insufficient deviations in the provided data.' : 'possible increased risk because multiple behavioral proxies changed from baseline.'}`,
    '- Limitations:',
    limitations,
    '',
    '### Protective factors still present',
    '',
    '1. Consent and source boundaries are explicit.',
    '2. The report uses aggregate proxies rather than raw private content when possible.',
    '3. The next steps are short and feasible rather than diagnostic.',
    '',
    '### Possible vulnerability pattern',
    '',
    context || 'Insufficient context for a specific vulnerability pattern. Treat this as a behavioral deviation screen, not a diagnosis.',
    '',
    '### Recommended next 24 hours',
    '',
    '1. Put one fixed routine anchor in the calendar for the next morning.',
    '2. Send one check-in message to a trusted person or support contact.',
    '3. Eat, hydrate, and avoid making major decisions while tired or activated.',
    '4. Avoid known triggers, substance-linked contacts, or high-risk places for 24 hours if relevant.',
    '5. Contact a clinician or support service if the risk flag feels personally accurate or escalates.',
    '',
    '### When to escalate',
    '',
    'Escalate if suicidal ideation appears, urges become hard to resist, sleep collapses, psychotic symptoms appear, severe intoxication or withdrawal appears, staying safe alone becomes difficult, essential obligations are missed, or clinical contact is lost.'
  ].join('\n');
}

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
