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

function getOpenAIKey() {
  const direct = String(process.env.OPENAI_API_KEY || '').trim();
  if (direct) return direct;

  const candidates = [
    process.env.OPENAI_API_KEY_FILE,
    process.env.OPENAI_SECRET_FILE,
    '/etc/secrets/openai_api_key',
    '/etc/secrets/OPENAI_API_KEY',
    path.join(ROOT, 'openai_api_key'),
    path.join(ROOT, 'OPENAI_API_KEY')
  ].filter(Boolean);

  for (const filePath of candidates) {
    const value = readSecretFile(filePath);
    if (value) return value;
  }
  return '';
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
    if (!srv || typeof srv.url !== 'string' || !srv.url.startsWith('https://')) continue;
    const label = String(srv.name || srv.server_label || 'mcp').replace(/[^a-zA-Z0-9_-]/g, '_');
    const token = process.env[`MCP_TOKEN_${sanitizeServerName(label)}`] || process.env[`MCP_AUTH_${sanitizeServerName(label)}`];
    const tool = {
      type: 'mcp',
      server_label: label,
      server_url: srv.url,
      require_approval: process.env.MCP_REQUIRE_APPROVAL || 'never'
    };
    if (token) tool.authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
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

    const key = getOpenAIKey();
    if (!key) {
      return sendJson(res, 500, {
        error: { message: 'Falta clave OpenAI. Configura OPENAI_API_KEY o crea un Render Secret File llamado openai_api_key con la clave dentro.' }
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
  if (pathname === '/api/health') return sendJson(res, 200, { ok: true, provider: 'openai', mock: process.env.MOCK_AI === 'true', has_openai_key: Boolean(getOpenAIKey()) });
  if (pathname === '/api/messages' && req.method === 'POST') return handleMessages(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Psyche Deep listening on http://0.0.0.0:${PORT}`);
});
