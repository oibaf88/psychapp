# PsychApp OAuth setup: Google, Gmail, Drive, Calendar, Outlook, Teams, OneDrive/SharePoint

This version replaces stored provider access tokens with real OAuth redirect flows.

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
- The user clicks Connect Google or Connect Microsoft in the app.
- The backend redirects to Google/Microsoft consent.
- The callback exchanges the authorization code for OAuth tokens.
- Tokens are stored only in an encrypted HttpOnly cookie for that browser session/device.
- Every OpenAI connector request receives the OAuth access token at request time.

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

Create a Google OAuth Web application client and set authorized redirect URI:

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

## Testing

After deploy:

```text
https://psychapp.bfab.io/api/debug/config
```

Expected:

- `openai.key_present: true`
- `oauth.config.google.client_id_present: true`
- `oauth.config.microsoft.client_id_present: true`
- `oauth.config.google.redirect_uri` equals `https://psychapp.bfab.io/api/oauth/callback/google`
- `oauth.config.microsoft.redirect_uri` equals `https://psychapp.bfab.io/api/oauth/callback/microsoft`

Then open the app and use the Connect Google / Connect Microsoft buttons.
