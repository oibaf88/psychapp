import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, 'server.mjs');
const legacyBootPath = path.join(__dirname, 'boot-server.mjs');
const patchedPath = path.join(__dirname, '.server.patched.mjs');

function loadLegacyPatchServerSource() {
  const legacy = fs.readFileSync(legacyBootPath, 'utf8');
  const start = legacy.indexOf('function patchServerSource(source)');
  const end = legacy.indexOf('\nconst source = fs.readFileSync(sourcePath,');
  if (start < 0 || end < 0 || end <= start) throw new Error('Cannot extract patchServerSource from boot-server.mjs');
  const fnSource = legacy.slice(start, end);
  return new Function(`${fnSource}\nreturn patchServerSource;`)();
}

function patchPsychAppMcp(code) {
  if (!code.includes("createPsychAppMcpOAuthHandler")) {
    const importMarker = "import { fileURLToPath } from 'node:url';";
    if (!code.includes(importMarker)) throw new Error('Cannot find node:url import marker in server.mjs');
    code = code.replace(
      importMarker,
      `${importMarker}\nimport { createPsychAppMcpOAuthHandler } from './psychapp-mcp-oauth.mjs';`
    );
  }

  if (!code.includes('const psychappMcpOAuthHandler = createPsychAppMcpOAuthHandler(')) {
    const serverMarker = 'const server = http.createServer((req, res) => {';
    const factory = `
const psychappMcpOAuthHandler = createPsychAppMcpOAuthHandler({
  sendJson,
  sendHtml,
  readBody,
  absoluteBaseUrl,
  publicDiagnostics,
  getOpenAIKeyWithMeta,
  getSupabaseKeyWithMeta
});
`;
    if (!code.includes(serverMarker)) throw new Error('Cannot find server creation marker in server.mjs');
    code = code.replace(serverMarker, `${factory}\n${serverMarker}`);
  }

  if (!code.includes('psychappMcpOAuthHandler(req, res, pathname)')) {
    const routeMarker = "const server = http.createServer((req, res) => {\n  if (req.method === 'OPTIONS') return sendJson(res, 204, {});\n  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;\n";
    const routePatch = `${routeMarker}  if (psychappMcpOAuthHandler(req, res, pathname)) return;\n`;
    if (!code.includes(routeMarker)) throw new Error('Cannot find main server pathname marker in server.mjs');
    code = code.replace(routeMarker, routePatch);
  }

  return code;
}

const legacyPatchServerSource = loadLegacyPatchServerSource();
const source = fs.readFileSync(sourcePath, 'utf8');
const patched = patchPsychAppMcp(legacyPatchServerSource(source));
fs.writeFileSync(patchedPath, patched, 'utf8');
await import(pathToFileURL(patchedPath).href);
