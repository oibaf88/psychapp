import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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

const CONNECTOR_BY_LABEL = {
  gmail: 'connector_gmail',
  drive: 'connector_googledrive',
  m365: 'connector_outlookemail',
  outlook: 'connector_outlookemail',
  calendar: 'connector_googlecalendar',
  google_calendar: 'connector_googlecalendar',
  teams: 'connector_microsoftteams',
  sharepoint: 'connector_sharepoint',
  dropbox: 'connector_dropbox'
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
  return text.replace(/^['"]|['"]$/g, '').trim();
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
  return findSecret(['OPENAI_API_KEY', 'OPENAI_KEY', 'openai_api_key', 'openai_key']);
}

function getOpenAIKey() {
  return getOpenAIKeyWithMeta().value;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(status === 204 ? '' : JSON.stringify(payload));
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
  if (url.includes('drive')) return 'connector_googledrive';
  if (url.includes('calendar')) return 'connector_googlecalendar';
  if (url.includes('microsoft') || url.includes('outlook') || url.includes('m365')) return 'connector_outlookemail';
  if (url.includes('dropbox')) return 'connector_dropbox';
  return '';
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
  if (connector) {
    names.push(`MCP_TOKEN_${connector}`, `${connector}_OAUTH_ACCESS_TOKEN`, `${connector}_ACCESS_TOKEN`, `${connector}_TOKEN`);
  }
  if (connectorId === 'connector_gmail') names.push('GMAIL_OAUTH_ACCESS_TOKEN', 'GOOGLE_GMAIL_OAUTH_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN');
  if (connectorId === 'connector_googledrive') names.push('GOOGLE_DRIVE_OAUTH_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN');
  if (connectorId === 'connector_googlecalendar') names.push('GOOGLE_CALENDAR_OAUTH_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN');
  if (connectorId === 'connector_outlookemail') names.push('OUTLOOK_OAUTH_ACCESS_TOKEN', 'MICROSOFT_OAUTH_ACCESS_TOKEN', 'M365_OAUTH_ACCESS_TOKEN');
  return [...new Set(names)];
}

function getOAuthTokenWithMeta(label, connectorId = '') {
  return findSecret(tokenNamesFor(label, connectorId));
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

function convertTools(legacyTools = [], mcpServers = []) {
  const tools = [];
  const wantsWeb = legacyTools.some(t => String(t?.type || '').includes('web_search') || t?.name === 'web_search');
  if (wantsWeb) tools.push({ type: 'web_search' });

  for (const srv of mcpServers) {
    if (!srv) continue;
    const label = String(srv.name || srv.server_label || srv.id || 'mcp').replace(/[^a-zA-Z0-9_-]/g, '_');
    const connectorId = connectorForServer(srv);
    const tokenInfo = getOAuthTokenWithMeta(label, connectorId);

    if (connectorId) {
      const tool = {
        type: 'mcp',
        server_label: label,
        connector_id: connectorId,
        require_approval: process.env.MCP_REQUIRE_APPROVAL || 'never'
      };
      if (tokenInfo.value) tool.authorization = tokenInfo.value.startsWith('Bearer ') ? tokenInfo.value : `Bearer ${tokenInfo.value}`;
      tools.push(tool);
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

function toResponsesPayload(body) {
  const input = normalizeMessages(body.messages || []);
  if (input.length === 0 && typeof body.input === 'string') input.push({ role: 'user', content: body.input });
  const payload = {
    model: body.model || DEFAULT_MODEL,
    instructions: body.system || undefined,
    input,
    max_output_tokens: Number(body.max_tokens || body.max_output_tokens || 2000),
    store: process.env.OPENAI_STORE === 'true'
  };
  const tools = convertTools(body.tools || [], body.mcp_servers || []);
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
    return { content: [{ type: 'text', text: JSON.stringify({ ocean: { openness: trait(65), conscientiousness: trait(50), extraversion: trait(40), agreeableness: trait(55), neuroticism: trait(55) }, cognitive_biases: [], defense_mechanisms: [], schemas: [], attachment_style: { primary: 'secure', secondary: 'unknown', evidence: ['demo'] }, regulatory_profile: { dominant_strategy: 'unknown', failure_conditions: [], recovery_patterns: [] }, locus_of_control: { overall: 'mixed', ratio: 0.5, domain_breakdown: {} }, cognitive_style: { mode: 'mixed', complexity_index: 50, need_for_cognition: 50, decision_style: 'unknown' }, communication_fingerprint: { unique_markers: [], linguistic_tell_signs: [] }, evolutionary_trajectory: { trend: 'stable', key_transitions: [], growth_domains: [] }, dark_triad_screening: { narcissism_indicators: 0, machiavellianism_indicators: 0, note: 'No evaluable en demo' }, predictive_levers: [], summary: 'Modo demo: conecta OPENAI_API_KEY para análisis real.', preventive_recommendations: [] }) }] };
  }
  if (sys.includes('data extraction agent')) {
    return { content: [{ type: 'text', text: JSON.stringify({ items: [], total_found: 0, data_quality: 'none', sources_tried: [], notes: 'Modo demo sin búsqueda real' }) }] };
  }
  if (sys.includes('access to data sources')) {
    return { content: [{ type: 'text', text: JSON.stringify({ items: [], next_page_token: null, total_estimated: 0 }) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ emotional_reaction: { primary: 'no evaluable en demo', secondary: '', intensity: 0, duration_estimate: '—' }, cognitive_patterns_activated: [], likely_behaviors: [], regulatory_challenges: [], early_warning_signs: [], protective_factors: [], preventive_suggestions: ['Configura OPENAI_API_KEY'], probability_distribution: [] }) }] };
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
          message: 'Falta clave OpenAI. Configura OPENAI_API_KEY o crea un Render Secret File llamado openai_api_key con la clave dentro.',
          diagnostic: publicDiagnostics()
        }
      });
    }

    const payload = toResponsesPayload(body);
    const upstream = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify(payload)
    });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!upstream.ok) {
      return sendJson(res, upstream.status, data || { error: { message: text || `HTTP ${upstream.status}` } });
    }
    return sendJson(res, 200, asAnthropicCompatible(data));
  } catch (err) {
    sendJson(res, err.status || 500, { error: { message: err.message || 'Error interno' } });
  }
}

function tokenPresenceSummary() {
  const labels = [
    ['gmail', 'connector_gmail'],
    ['drive', 'connector_googledrive'],
    ['google_calendar', 'connector_googlecalendar'],
    ['m365', 'connector_outlookemail'],
    ['dropbox', 'connector_dropbox']
  ];
  return Object.fromEntries(labels.map(([label, connector]) => {
    const info = getOAuthTokenWithMeta(label, connector);
    return [label, { present: Boolean(info.value), source: info.source ? info.source.replace(/:.+$/, ':***') : '' }];
  }));
}

function publicDiagnostics() {
  const keyInfo = getOpenAIKeyWithMeta();
  return {
    ok: true,
    provider: 'openai',
    mock: process.env.MOCK_AI === 'true',
    node: process.version,
    openai: {
      key_present: Boolean(keyInfo.value),
      key_source: keyInfo.source ? keyInfo.source.replace(/:.+$/, ':***') : '',
      model: DEFAULT_MODEL,
      url: OPENAI_URL,
      store: process.env.OPENAI_STORE === 'true'
    },
    secrets: {
      dir: SECRET_DIR,
      dir_exists: fs.existsSync(SECRET_DIR),
      files: safeSecretFiles()
    },
    oauth_tokens: tokenPresenceSummary(),
    notes: [
      'Este endpoint no muestra valores secretos, solo presencia y nombres de archivo.',
      'Los conectores OpenAI requieren OAuth access tokens generados aparte; Render Secret Files solo los guarda.'
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
  if (pathname === '/api/health') return sendJson(res, 200, publicDiagnostics());
  if (pathname === '/api/debug/config') return sendJson(res, 200, publicDiagnostics());
  if (pathname === '/api/messages' && req.method === 'POST') return handleMessages(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Psyche Deep running on http://0.0.0.0:${PORT}`);
});
