# Psyche Deep Android PWA + OpenAI

Aplicación React/Vite convertida desde el JSX original a una PWA usable en Android 16 con backend Node conectado a OpenAI.

## URL de producción

```text
https://psychapp.bfab.io
```

Callbacks OAuth canónicas:

```text
Google:    https://psychapp.bfab.io/api/oauth/callback/google
Microsoft: https://psychapp.bfab.io/api/oauth/callback/microsoft
```

## Qué incluye

- Frontend React/Vite compilable.
- PWA instalable desde Chrome en Android 16.
- Backend Node en `server.mjs` que guarda la clave de OpenAI fuera del móvil/frontend.
- Adaptador compatible con la app original: el frontend sigue esperando `{content:[{type:"text", text:"..."}]}`.
- OpenAI Responses API usando `/v1/responses`.
- OAuth interactivo para Google y Microsoft.
- Conectores OpenAI/MCP para Gmail, Google Drive, Google Calendar, Outlook, Microsoft Calendar, Teams y SharePoint/OneDrive cuando el usuario autoriza OAuth.
- Modo demo sin API real con `MOCK_AI=true`.

## Documentación importante

- Google OAuth: ver `README_OAUTH_SETUP.md`.
- Microsoft OAuth / Outlook / Hotmail / Live / OneDrive: ver [`README_MICROSOFT_OAUTH.md`](./README_MICROSOFT_OAUTH.md).
- Variables de entorno: ver [`README_ENVIRONMENT_VARIABLES.md`](./README_ENVIRONMENT_VARIABLES.md) y [`.env.example`](./.env.example).

## Ejecución local en ordenador

```bash
npm install
cp .env.example .env
# edita .env y añade tus variables locales
npm run build
npm start
```

Abre:

```text
http://localhost:10000
```

## Uso en Android 16

Opción recomendada: desplegar el backend en Render/VPS y abrir la URL HTTPS en Chrome.

1. Sube este proyecto a GitHub.
2. En Render, crea un Web Service Node.
3. Build command:

```bash
npm install --no-audit --no-fund && npm run build
```

4. Start command:

```bash
node server.mjs
```

5. Variables mínimas de entorno en Render:

```text
NODE_VERSION=22.22.0
PORT=10000
PUBLIC_BASE_URL=https://psychapp.bfab.io
OAUTH_COOKIE_SECRET=una_cadena_larga_aleatoria
OPENAI_MODEL=gpt-4.1-mini
OPENAI_STORE=false
MCP_REQUIRE_APPROVAL=never
ALLOW_CUSTOM_OAUTH_SCOPES=false
```

6. OpenAI como Render Secret File:

```text
Filename: OPENAI_API_SECRET
Contents: sk-proj-...
Mounted path: /etc/secrets/OPENAI_API_SECRET
```

7. En Android 16: abre `https://psychapp.bfab.io` en Chrome → menú ⋮ → **Añadir a pantalla de inicio** / **Instalar app**.

## Variables OAuth principales

Google:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/google
```

Microsoft:

```env
MICROSOFT_TENANT=consumers
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/microsoft
```

Para Microsoft personal Outlook/Hotmail/Live, consulta `README_MICROSOFT_OAUTH.md`.

## Uso solo desde Android con Termux

También puedes ejecutarla localmente en el móvil:

```bash
pkg update
pkg install nodejs git unzip
cd psychapp
npm install
cp .env.example .env
nano .env
npm run build
npm start
```

Luego abre en Chrome:

```text
http://127.0.0.1:10000
```

## Seguridad

- No metas `OPENAI_API_KEY`, `OPENAI_API_SECRET`, `MICROSOFT_CLIENT_SECRET` ni `GOOGLE_CLIENT_SECRET` en React, `localStorage`, GitHub ni variables `VITE_*`.
- El backend usa `OPENAI_STORE=false` por defecto.
- OAuth de Google/Microsoft se hace por redirección interactiva; no guardes access tokens manuales en Render.
- Los tokens OAuth se guardan por usuario en cookie cifrada HttpOnly.
- Evita MCP de terceros no confiables: pueden recibir datos sensibles.

## Modo demo

```bash
MOCK_AI=true npm start
```

Permite comprobar UI, PWA y flujo sin gastar tokens ni usar API real.
