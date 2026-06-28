# PsychApp Integrated

PsychApp/Psyche Deep con frontend React y backend Node para:

- OpenAI Responses API con herramientas MCP remotas y conectores OAuth.
- OAuth real de Google y Microsoft con tokens cifrados en cookie HttpOnly.
- Scraping HTTP real de perfiles publicos mediante `/psychapp/api/scrape`.
- Analisis integrado mediante `/psychapp/api/analyze`.
- Persistencia opcional en Supabase con `supabase/migrations/202606280001_psychapp_runs.sql`.
- Despliegue Render preparado para servir la app bajo `/psychapp`.

## Desarrollo

```powershell
copy .env.example .env.local
npm install
npm run build
npm start
```

En este entorno de Codex se usa el Node incluido por la app si `node` no esta en el PATH.

## Variables principales

- `OPENAI_API_KEY`: clave de OpenAI server-side.
- `OPENAI_MODEL`: modelo para Responses API. Por defecto `gpt-5.5`.
- `APP_BASE_PATH`: `/psychapp`.
- `PUBLIC_BASE_URL`: `https://ondender.com/psychapp` en produccion.
- `OAUTH_COOKIE_SECRET`: secreto largo para cifrar cookies OAuth.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` si se quiere guardar cada analisis.

## OAuth callbacks

- Google: `/psychapp/api/oauth/callback/google`
- Microsoft: `/psychapp/api/oauth/callback/microsoft`

Con `PUBLIC_BASE_URL=https://ondender.com/psychapp`, las URLs completas son:

- `https://ondender.com/psychapp/api/oauth/callback/google`
- `https://ondender.com/psychapp/api/oauth/callback/microsoft`

## Render

`render.yaml` define un servicio web Node con healthcheck en `/psychapp/api/health`.
Para que `https://ondender.com/psychapp` funcione, el dominio debe resolver y enrutar ese path hacia el servicio Render.
