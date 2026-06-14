# Psyche Deep Android PWA + OpenAI

Aplicación React/Vite convertida desde el JSX original a una PWA usable en Android 16 con backend Node conectado a OpenAI.

## Qué incluye

- Frontend React/Vite compilable.
- PWA instalable desde Chrome en Android 16.
- Backend Node en `server.mjs` que guarda la `OPENAI_API_KEY` fuera del móvil/frontend.
- Adaptador compatible con la app original: el frontend sigue esperando `{content:[{type:"text", text:"..."}]}`.
- OpenAI Responses API usando `/v1/responses`.
- Web search usando `tools: [{ type: "web_search" }]` cuando la app lo pide.
- MCP remoto opcional usando tools tipo `mcp` si configuras tokens en `.env`.
- Modo demo sin API real con `MOCK_AI=true`.

## Ejecución local en ordenador

```bash
npm install
cp .env.example .env
# edita .env y añade OPENAI_API_KEY
npm run build
npm start
```

Abre:

```text
http://localhost:4173
```

## Uso en Android 16

Opción recomendada: desplegar el backend en Render/VPS y abrir la URL HTTPS en Chrome.

1. Sube este proyecto a GitHub.
2. En Render, crea un Web Service Node.
3. Build command:

```bash
npm install && npm run build
```

4. Start command:

```bash
npm start
```

5. Variables de entorno en Render:

```text
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4.1-mini
OPENAI_STORE=false
```

6. En Android 16: abre la URL HTTPS en Chrome → menú ⋮ → **Añadir a pantalla de inicio** / **Instalar app**.

## Uso solo desde Android con Termux

También puedes ejecutarla localmente en el móvil:

```bash
pkg update
pkg install nodejs git unzip
unzip psyche-deep-android-openai.zip
cd psyche-deep-android-openai
npm install
cp .env.example .env
nano .env
npm run build
npm start
```

Luego abre en Chrome:

```text
http://127.0.0.1:4173
```

## Conectores / MCP

El backend acepta servidores MCP remotos enviados desde el frontend y los transforma a herramientas OpenAI `mcp`. Puedes configurar tokens:

```text
MCP_TOKEN_GMAIL=Bearer_o_token_oauth
MCP_TOKEN_DRIVE=Bearer_o_token_oauth
MCP_TOKEN_M365=Bearer_o_token_oauth
MCP_TOKEN_ZAPIER=Bearer_o_token_oauth
MCP_REQUIRE_APPROVAL=never
```

Importante: los servidores MCP y los tokens deben ser reales y válidos. La app no inventa OAuth; solo deja preparado el puente seguro.

## Seguridad

- No metas `OPENAI_API_KEY` en React, `localStorage` ni variables `VITE_*`.
- El backend usa `OPENAI_STORE=false` por defecto.
- Evita MCP de terceros no confiables: pueden recibir datos sensibles.

## Modo demo

```bash
MOCK_AI=true npm start
```

Permite comprobar UI, PWA y flujo sin gastar tokens ni usar API real.

