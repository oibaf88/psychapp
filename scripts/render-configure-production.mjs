import { execFileSync } from 'node:child_process';

const apiKey = requiredEnv('RENDER_API_KEY');
const serviceId = process.env.RENDER_SERVICE_ID || await findServiceId();
const commitId = process.env.RENDER_COMMIT_ID || currentGitSha();

const envVars = {
  APP_BASE_PATH: process.env.APP_BASE_PATH || '/psychapp',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || 'https://psychapp.bfab.io',
  ALLOW_CUSTOM_OAUTH_SCOPES: process.env.ALLOW_CUSTOM_OAUTH_SCOPES || 'false',
  PSYCHAPP_MCP_PATH: process.env.PSYCHAPP_MCP_PATH || '/mcp',
  PSYCHAPP_MCP_PUBLIC_BASE_URL: process.env.PSYCHAPP_MCP_PUBLIC_BASE_URL || 'https://psychapp.bfab.io',
  SUPABASE_SERVICE_ROLE_KEY: requiredServiceRoleKey(),
  PSYCHAPP_MCP_OWNER_PIN: requiredEnv('PSYCHAPP_MCP_OWNER_PIN')
};

if (process.env.PSYCHAPP_MCP_OAUTH_SECRET) envVars.PSYCHAPP_MCP_OAUTH_SECRET = process.env.PSYCHAPP_MCP_OAUTH_SECRET;

for (const [key, value] of Object.entries(envVars)) {
  await render(`/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: { value }
  });
  console.log(`Set ${key}`);
}

const deployBody = { clearCache: 'do_not_clear' };
if (commitId) deployBody.commitId = commitId;
const deploy = await render(`/services/${serviceId}/deploys`, {
  method: 'POST',
  body: deployBody
});

console.log(`Triggered Render deploy for service ${serviceId}${commitId ? ` at ${commitId}` : ''}`);
if (deploy?.id) console.log(`Deploy id: ${deploy.id}`);

async function findServiceId() {
  const wanted = process.env.RENDER_SERVICE_NAME || 'psychapp';
  const services = await render('/services?limit=100');
  const items = Array.isArray(services) ? services : services?.services || services?.items || [];
  const match = items.find(item => {
    const service = item.service || item;
    return service?.id && service?.name === wanted;
  });
  if (!match) throw new Error(`Set RENDER_SERVICE_ID or make sure a Render service named ${wanted} exists in this workspace`);
  return (match.service || match).id;
}

async function render(path, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.render.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const message = typeof data === 'string' ? data : data?.message || data?.error || text;
    throw new Error(`Render API ${method} ${path} failed with ${response.status}: ${message}`);
  }
  return data;
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredServiceRoleKey() {
  const value = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  const role = jwtPayload(value)?.role;
  if (role !== 'service_role') throw new Error('SUPABASE_SERVICE_ROLE_KEY must be a Supabase service_role JWT, not anon/publishable');
  return value;
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

function currentGitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}
