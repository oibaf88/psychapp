const baseUrl = String(process.argv[2] || process.env.PSYCHAPP_PRODUCTION_BASE_URL || 'https://psychapp.bfab.io').replace(/\/$/, '');

const failures = [];
const warnings = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function scopesInclude(scopes, expected) {
  return Array.isArray(scopes) && scopes.includes(expected);
}

function scopesExclude(scopes, unexpected) {
  return !Array.isArray(scopes) || !scopes.includes(unexpected);
}

async function fetchJson(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  try {
    return { response, body: JSON.parse(text), text };
  } catch {
    return { response, body: null, text };
  }
}

function requirePresent(value, label) {
  if (!value) fail(`${label} is not present`);
}

async function verifyHealth() {
  const { response, body, text } = await fetchJson('/psychapp/api/health');
  if (response.status !== 200 || !body?.ok) {
    fail(`/psychapp/api/health returned ${response.status}: ${text.slice(0, 160)}`);
    return null;
  }

  requirePresent(body.mental_health, 'mental_health health block');
  if (body.mental_health?.skill !== 'mental-health-early-warning-analysis') {
    fail(`mental_health.skill is ${JSON.stringify(body.mental_health?.skill)}`);
  }
  if (body.mental_health?.output !== 'non_diagnostic_early_warning_report') {
    fail(`mental_health.output is ${JSON.stringify(body.mental_health?.output)}`);
  }
  if (body.oauth?.allow_custom_oauth_scopes !== false) {
    fail(`oauth.allow_custom_oauth_scopes should be false, got ${JSON.stringify(body.oauth?.allow_custom_oauth_scopes)}`);
  }

  const google = body.oauth?.config?.google || {};
  const microsoft = body.oauth?.config?.microsoft || {};
  requirePresent(google.client_id_present, 'Google OAuth client id');
  requirePresent(google.client_secret_present, 'Google OAuth client secret');
  requirePresent(microsoft.client_id_present, 'Microsoft OAuth client id');
  requirePresent(microsoft.client_secret_present, 'Microsoft OAuth client secret');
  requirePresent(body.openai?.key_present, 'OpenAI API key');

  const googleScopes = google.scopes || [];
  const microsoftScopes = microsoft.scopes || [];

  for (const scope of [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly'
  ]) {
    if (!scopesInclude(googleScopes, scope)) fail(`Google scope missing: ${scope}`);
  }
  for (const scope of [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar.events'
  ]) {
    if (!scopesExclude(googleScopes, scope)) fail(`Google production scope should not be present: ${scope}`);
  }

  for (const scope of ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Mail.Read', 'Files.Read.All', 'Calendars.Read']) {
    if (!scopesInclude(microsoftScopes, scope)) fail(`Microsoft scope missing: ${scope}`);
  }
  for (const scope of ['Sites.Read.All', 'Chat.Read', 'ChannelMessage.Read.All']) {
    if (!scopesExclude(microsoftScopes, scope)) fail(`Microsoft organization scope should not be present while custom scopes are disabled: ${scope}`);
  }

  if (body.supabase?.key_kind !== 'service_role') {
    fail(`Supabase must use SUPABASE_SERVICE_ROLE_KEY on Render; health reports ${JSON.stringify(body.supabase?.key_kind)}`);
  }

  return body;
}

async function verifyMcpDebug() {
  const { response, body, text } = await fetchJson('/api/mcp/debug');
  if (response.status !== 200 || !body?.ok) {
    fail(`/api/mcp/debug returned ${response.status}: ${text.slice(0, 160)}`);
    return;
  }
  if (body.mcp_endpoint !== `${baseUrl}/mcp`) {
    fail(`/api/mcp/debug mcp_endpoint is ${JSON.stringify(body.mcp_endpoint)}`);
  }
  if (body.owner_pin_configured !== true) {
    fail('PSYCHAPP_MCP_OWNER_PIN is not configured on Render');
  }
  if (body.supabase_audit_enabled !== true) {
    fail('MCP debug reports Supabase audit disabled');
  }
}

async function verifyWellKnown() {
  for (const pathname of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) {
    const { response, body, text } = await fetchJson(pathname);
    if (response.status !== 200 || !body) {
      fail(`${pathname} returned ${response.status}: ${text.slice(0, 160)}`);
    }
  }
}

async function verifyMcpAuthGate() {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  const text = await response.text();
  if (response.status !== 401) {
    fail(`/mcp without Bearer token should return 401, got ${response.status}: ${text.slice(0, 160)}`);
  }
  if (/<!doctype html>|<html/i.test(text)) {
    fail('/mcp returned the frontend HTML instead of the MCP auth gate');
  }
}

await verifyHealth();
await verifyMcpDebug();
await verifyWellKnown();
await verifyMcpAuthGate();

if (warnings.length) {
  console.warn('Warnings:');
  for (const message of warnings) console.warn(`- ${message}`);
}

if (failures.length) {
  console.error('Production readiness failed:');
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log(`Production readiness passed for ${baseUrl}`);
