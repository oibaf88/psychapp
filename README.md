# PsychApp Integrated

PsychApp/Psyche Deep con frontend React y backend Node para:

- OpenAI Responses API con herramientas MCP remotas y conectores OAuth.
- OAuth real de Google y Microsoft con cookie de sesion pequena y tokens persistidos server-side cuando Supabase esta configurado.
- Scraping HTTP real de perfiles publicos mediante `/psychapp/api/scrape`.
- Analisis integrado mediante `/psychapp/api/analyze`.
- Informe no diagnostico de alerta temprana con `mental-health-early-warning-analysis`: consentimiento explicito, fuentes minimizadas, baseline, ventanas 24h/3d/7d/30d y plan preventivo.
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
- `PUBLIC_BASE_URL`: `https://psychapp.bfab.io` en produccion.
- `OAUTH_COOKIE_SECRET`: secreto largo para cifrar cookies OAuth.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` si se quiere guardar cada analisis.

## Alerta temprana no diagnostica

El modo por defecto del frontend es `early_warning_report`. Antes de llamar a `/psychapp/api/analyze`, la UI envia:

- `mental_health_early_warning.consent_confirmed`
- `mental_health_early_warning.allowed_sources`
- `mental_health_early_warning.baseline_days`
- `mental_health_early_warning.current_windows`

El backend rechaza analisis de datos personales o conectados sin consentimiento confirmado. En modo alerta temprana filtra conectores MCP segun fuentes autorizadas y pide a OpenAI una salida no diagnostica con nivel Low/Moderate/High/Acute, evidencia, limitaciones y acciones de las proximas 24 horas.

## OAuth callbacks

- Google: `/psychapp/api/oauth/callback/google`
- Microsoft: `/psychapp/api/oauth/callback/microsoft`

Con `PUBLIC_BASE_URL=https://psychapp.bfab.io`, las URLs completas son:

- `https://psychapp.bfab.io/api/oauth/callback/google`
- `https://psychapp.bfab.io/api/oauth/callback/microsoft`

## Render

`render.yaml` define un servicio web Node con healthcheck en `/psychapp/api/health`.
El endpoint verificado actual es `https://psychapp.bfab.io/psychapp/api/health`.
Para que `https://ondender.com/psychapp` funcione, el dominio debe resolver y enrutar ese path hacia el servicio Render.
