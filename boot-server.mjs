import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, 'server.mjs');
const runtimeDir = path.join(__dirname, '.runtime');
const patchedPath = path.join(runtimeDir, 'server.patched.mjs');

function patchServerSource(source) {
  let code = source;

  const helper = `
function publicOpenAIRequestMeta(payload = {}) {
  return {
    model: payload.model || DEFAULT_MODEL,
    max_output_tokens: payload.max_output_tokens || null,
    store: payload.store === true,
    tools: Array.isArray(payload.tools)
      ? payload.tools.map(tool => ({ type: tool?.type || '', connector_id: tool?.connector_id || '', server_label: tool?.server_label || '' }))
      : []
  };
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
        message: 'Cuota o presupuesto de OpenAI agotado. Gmail/Drive están conectando, pero el análisis no puede ejecutarse hasta que aumentes el límite mensual, añadas créditos o uses otra clave/proyecto con presupuesto disponible.',
        upstream_status: status,
        upstream_code: err.code || err.type || null,
        recoverable_by_retry: false,
        next_steps: [
          'Revisa Usage y Limits/Billing del proyecto OpenAI que corresponde a OPENAI_API_SECRET u OPENAI_API_KEY.',
          'Aumenta el monthly budget, compra créditos o cambia a una API key de un proyecto con saldo.',
          'Después redeploy/restart en Render y prueba /api/health para confirmar key_present=true y el modelo activo.',
          'Para probar la interfaz sin gastar créditos, activa temporalmente MOCK_AI=true.'
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

  if (status === 401 || status === 403) {
    return {
      error: {
        code: 'openai_auth_or_permission_error',
        message: 'La clave OpenAI no es válida o no tiene permisos para este modelo/proyecto. Revisa OPENAI_API_SECRET/OPENAI_API_KEY y el proyecto asociado.',
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
        message: 'OpenAI devolvió un error temporal de servidor. Reintenta más tarde; si persiste, revisa status.openai.com y los logs de Render.',
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
`;

  if (!code.includes('function openAIErrorPayload(')) {
    const marker = `function maybeMock(body) {\n  if (process.env.MOCK_AI !== 'true') return null;\n  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, demo: true, message: 'MOCK_AI activo' }) }] };\n}\n`;
    if (!code.includes(marker)) throw new Error('Cannot find maybeMock marker in server.mjs');
    code = code.replace(marker, `${marker}${helper}`);
  }

  const oldLine = "if (!upstream.ok) return sendJson(res, upstream.status, data || { error: { message: text || `HTTP ${upstream.status}` } });";
  const newLine = "if (!upstream.ok) return sendJson(res, upstream.status, openAIErrorPayload(upstream.status, data, text, payload));";
  if (!code.includes(newLine)) {
    if (!code.includes(oldLine)) throw new Error('Cannot find OpenAI upstream error passthrough line in server.mjs');
    code = code.replace(oldLine, newLine);
  }

  return code;
}

const source = fs.readFileSync(sourcePath, 'utf8');
const patched = patchServerSource(source);
fs.mkdirSync(runtimeDir, { recursive: true });
fs.writeFileSync(patchedPath, patched, 'utf8');
await import(pathToFileURL(patchedPath).href);
