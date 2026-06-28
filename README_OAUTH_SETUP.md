# PsychApp OAuth setup: Google, Gmail, Drive, Calendar, Outlook, Teams, OneDrive/SharePoint

This version uses real OAuth redirect flows and passes the resulting provider access token to OpenAI MCP connectors at request time.

## Canonical production URL

PsychApp is currently hosted at:

```text
https://psychapp.bfab.io
```

Canonical redirect URIs:

```text
Google:    https://psychapp.bfab.io/api/oauth/callback/google
Microsoft: https://psychapp.bfab.io/api/oauth/callback/microsoft
```

## Runtime design

- The OpenAI API key remains server-side. In Render, use a Secret File named `OPENAI_API_SECRET` mounted at `/etc/secrets/OPENAI_API_SECRET`.
- Google/Microsoft account access is not stored as Render secrets.
- The user clicks **Connect Google** or **Connect Microsoft** in the app.
- The backend redirects to Google/Microsoft consent.
- The callback exchanges the authorization code for OAuth tokens.
- Tokens are stored only in an encrypted HttpOnly cookie for that browser session/device.
- When the provider access token expires, `boot-server.mjs` now refreshes it automatically with the provider refresh token before calling OpenAI connectors.
- Every OpenAI connector request receives the fresh OAuth access token at request time.

## Why this is the correct OpenAI connector pattern

OpenAI's Responses API uses the `mcp` built-in tool type for connectors. For OpenAI-maintained connectors such as Google Workspace or Dropbox, the request must include both:

```json
{
  "type": "mcp",
  "server_label": "google_calendar",
  "connector_id": "connector_googlecalendar",
  "authorization": "<oauth access token>",
  "require_approval": "never"
}
```

PsychApp is therefore the OAuth client for Google/Microsoft and the OpenAI API caller. OpenAI is not the OAuth provider for Gmail/Drive; it receives the provider OAuth token only for the specific connector call.

## Required Render variables / secret files

### OpenAI

Recommended Render Secret File:

Filename:

```text
OPENAI_API_SECRET
```

Contents:

```text
sk-proj-...
```

Optional environment variables:

```env
OPENAI_MODEL=gpt-4.1-mini
OPENAI_STORE=false
PUBLIC_BASE_URL=https://psychapp.bfab.io
OAUTH_COOKIE_SECRET=generate-a-long-random-string
MCP_REQUIRE_APPROVAL=never
ALLOW_CUSTOM_OAUTH_SCOPES=false
```

### Google OAuth app

Create a Google OAuth **Web application** client and set authorized redirect URI:

```text
https://psychapp.bfab.io/api/oauth/callback/google
```

Render variables:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/google
```

Google scopes requested by the app:

```text
openid
email
profile
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/calendar.readonly
```

Google must be configured with a consent screen and the needed sensitive scopes. While testing, add your own Google account as a test user if the OAuth app is still in testing mode.

### Microsoft OAuth app

Create a Microsoft Entra app registration and set redirect URI:

```text
https://psychapp.bfab.io/api/oauth/callback/microsoft
```

Render variables:

```env
MICROSOFT_TENANT=consumers
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/microsoft
```

Microsoft scopes requested by the app for personal Outlook/Hotmail/Live accounts:

```text
openid
profile
email
offline_access
User.Read
Mail.Read
Files.Read.All
Calendars.Read
```

Do not add `Sites.Read.All` or `Team.ReadBasic.All` while debugging personal Microsoft accounts.

## New endpoints

```text
GET  /api/oauth/start/google
GET  /api/oauth/start/microsoft
GET  /api/oauth/callback/google
GET  /api/oauth/callback/microsoft
GET  /api/oauth/status
POST /api/oauth/logout
POST /api/oauth/logout/google
POST /api/oauth/logout/microsoft
GET  /api/debug/config
```

## Testing after deploy

Open:

```text
https://psychapp.bfab.io/api/debug/config
```

Expected:

- `openai.key_present: true`
- `oauth.config.google.client_id_present: true`
- `oauth.config.google.client_secret_present: true`
- `oauth.config.microsoft.client_id_present: true`, if using Microsoft
- `oauth.config.google.redirect_uri` equals `https://psychapp.bfab.io/api/oauth/callback/google`
- `oauth.config.microsoft.redirect_uri` equals `https://psychapp.bfab.io/api/oauth/callback/microsoft`

Then:

1. Open `https://psychapp.bfab.io`.
2. Press **Conectar Google**.
3. Grant Gmail, Drive and Calendar read-only consent.
4. Return to PsychApp.
5. Activate Gmail/Drive/Calendar and run the analysis.

If OpenAI returns `openai_quota_exceeded`, OAuth is not the failing layer. Fix billing/usage limits for the exact OpenAI project/API key mounted as `OPENAI_API_SECRET`.

## Supabase note

Supabase is not required for the current OAuth-token path. Storing Gmail/Drive/Calendar OAuth tokens in a database would increase the risk profile because this app handles highly sensitive mental-health-adjacent personal data. For now, the safer path is encrypted HttpOnly browser cookies plus server-side OpenAI calls. Supabase can be added later for user accounts, consent records, encrypted analysis snapshots and audit logs, but it should not be used as a raw OAuth token dump.
