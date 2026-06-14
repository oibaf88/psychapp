# Microsoft OAuth setup for PsychApp

This guide configures Microsoft OAuth 2.0 for Outlook/Hotmail/Live mail, calendars, OneDrive files through Microsoft Graph, and optionally Microsoft 365 work/school services.

## What this app already implements

The backend exposes these routes:

```text
GET /api/oauth/start/microsoft
GET /api/oauth/callback/microsoft
GET /api/oauth/status
POST /api/oauth/logout/microsoft
GET /api/debug/config
```

The Microsoft provider is configured in `server.mjs` with these environment variable names:

```env
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_REDIRECT_URI=https://YOUR-APP.onrender.com/api/oauth/callback/microsoft
```

Aliases also accepted by the backend:

```env
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
AZURE_REDIRECT_URI=...
MS_CLIENT_ID=...
MS_CLIENT_SECRET=...
MS_REDIRECT_URI=...
```

## Important: PsychApp is the OAuth client, not the OAuth provider

Do **not** configure PsychApp as an OpenID Connect provider, identity provider, credential validation endpoint, token issuer, or metadata endpoint.

PsychApp does not expose an OAuth discovery document such as:

```text
/.well-known/openid-configuration
```

and it does not expose a token endpoint such as:

```text
/oauth/token
```

Microsoft is the OAuth provider. PsychApp is only the web application that receives the OAuth redirect callback.

The only PsychApp URL that Microsoft Entra should usually know is the redirect URI:

```text
https://YOUR-APP.onrender.com/api/oauth/callback/microsoft
```

Provider endpoints are Microsoft-owned:

```text
Authorization endpoint:
https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize

Token endpoint:
https://login.microsoftonline.com/consumers/oauth2/v2.0/token

OIDC metadata endpoint:
https://login.microsoftonline.com/consumers/v2.0/.well-known/openid-configuration
```

If a Microsoft/OpenAI/custom connector screen asks for a credential validation URL, issuer URL, metadata URL, token URL, or authorization URL, do not use your PsychApp root URL. Use the Microsoft URLs above, or leave that field unused if you are configuring a normal Microsoft Entra App Registration.

## Recommended for personal Microsoft accounts

For Outlook.com, Hotmail, Live, Xbox or other personal Microsoft accounts, create the app registration with one of these account types:

```text
Personal Microsoft accounts only
```

or, if you also want work/school accounts:

```text
Accounts in any organizational directory and personal Microsoft accounts
```

The Microsoft identity platform supports tenant values `common`, `organizations`, `consumers`, and tenant IDs. For personal-only flows, `consumers` is the strictest option. The current backend uses `common`, which allows personal accounts if the app registration supports them. If you want to force personal-only sign-in, change Microsoft auth/token URLs in `server.mjs` from `/common/` to `/consumers/`.

## Redirect URI

In Microsoft Entra admin center, add this exact Web redirect URI:

```text
https://YOUR-APP.onrender.com/api/oauth/callback/microsoft
```

Example:

```text
https://pyschapp.onrender.com/api/oauth/callback/microsoft
```

The redirect URI must exactly match the value used by the backend. If you set `MICROSOFT_REDIRECT_URI`, use the same string in Microsoft Entra.

## Render environment variables

In Render -> your Web Service -> Environment, add:

```env
PUBLIC_BASE_URL=https://YOUR-APP.onrender.com
OAUTH_COOKIE_SECRET=GENERATE_A_LONG_RANDOM_STRING
MICROSOFT_CLIENT_ID=YOUR_APPLICATION_CLIENT_ID
MICROSOFT_CLIENT_SECRET=YOUR_CLIENT_SECRET_VALUE
MICROSOFT_REDIRECT_URI=https://YOUR-APP.onrender.com/api/oauth/callback/microsoft
MCP_REQUIRE_APPROVAL=never
```

Keep OpenAI separately as a Render Secret File:

```text
Filename: OPENAI_API_SECRET
Contents: sk-proj-...
Mounted path: /etc/secrets/OPENAI_API_SECRET
```

## Microsoft Graph delegated permissions

For personal Outlook/Hotmail/Live support, use these delegated Graph permissions:

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

Optional for work/school Microsoft 365, SharePoint and Teams:

```text
Sites.Read.All
Team.ReadBasic.All
```

Notes:

- `Mail.Read` delegated allows the app to read the signed-in user's mailbox and is available for personal Microsoft accounts.
- `Files.Read.All` delegated allows the app to read files the signed-in user can access and is available for personal Microsoft accounts.
- `Calendars.Read` delegated allows the app to read events in user calendars and is available for personal Microsoft accounts.
- `offline_access` is needed so Microsoft can issue a refresh token.

## Step-by-step Microsoft Entra setup

1. Go to Microsoft Entra admin center.
2. Open `Applications` -> `App registrations` -> `New registration`.
3. Name it, for example:

```text
PsychApp OAuth
```

4. Under `Supported account types`, choose one:

```text
Personal Microsoft accounts only
```

or:

```text
Accounts in any organizational directory and personal Microsoft accounts
```

5. Under `Redirect URI`, choose:

```text
Platform: Web
Redirect URI: https://YOUR-APP.onrender.com/api/oauth/callback/microsoft
```

6. Click `Register`.
7. Copy `Application (client) ID` into Render as `MICROSOFT_CLIENT_ID`.
8. Go to `Certificates & secrets` -> `Client secrets` -> `New client secret`.
9. Copy the secret **Value**, not the Secret ID, into Render as `MICROSOFT_CLIENT_SECRET`.
10. Go to `API permissions` -> `Add a permission` -> `Microsoft Graph` -> `Delegated permissions`.
11. Add:

```text
User.Read
Mail.Read
Files.Read.All
Calendars.Read
offline_access
openid
profile
email
```

12. Save. If you are using an organizational tenant and some permissions require admin consent, grant admin consent. For personal Microsoft accounts, user consent should normally be enough for the personal-compatible delegated permissions above.
13. In Render, click `Manual Deploy` -> `Clear build cache & deploy`.

## Testing

Open:

```text
https://YOUR-APP.onrender.com/api/debug/config
```

You want to see Microsoft configured, without exposing secrets.

Then open:

```text
https://YOUR-APP.onrender.com/api/oauth/start/microsoft
```

After signing in and accepting permissions, check:

```text
https://YOUR-APP.onrender.com/api/oauth/status
```

Expected result:

```json
{
  "ok": true,
  "providers": {
    "microsoft": {
      "connected": true
    }
  }
}
```

## Common errors

### Credential Validation Unavailable / unexpected response: `<. Path "", line 0, position 0.`

This means a validator expected JSON, but received HTML. HTML responses usually start with `<`, for example `<!doctype html>`.

Most likely causes:

1. You entered `https://YOUR-APP.onrender.com` as a metadata, token, issuer, or credential validation endpoint.
2. You entered `https://YOUR-APP.onrender.com/api/oauth/callback/microsoft` in a place that expects a JSON endpoint.
3. You are configuring a custom identity provider/OIDC provider instead of a normal Microsoft Entra App Registration.
4. Your app was down and Render returned an HTML error page.

Correct model:

```text
Microsoft authorization endpoint:
https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize

Microsoft token endpoint:
https://login.microsoftonline.com/consumers/oauth2/v2.0/token

Microsoft metadata endpoint:
https://login.microsoftonline.com/consumers/v2.0/.well-known/openid-configuration

PsychApp redirect URI:
https://YOUR-APP.onrender.com/api/oauth/callback/microsoft
```

Do not use PsychApp as the credential validation URL.

### AADSTS50011 redirect URI mismatch

The redirect URI in Microsoft Entra does not exactly match the callback URI used by the app.

Fix both sides:

```env
MICROSOFT_REDIRECT_URI=https://YOUR-APP.onrender.com/api/oauth/callback/microsoft
PUBLIC_BASE_URL=https://YOUR-APP.onrender.com
```

And in Microsoft Entra use the same redirect URI.

### Personal account cannot sign in

Usually caused by the wrong supported account type.

Fix: in app registration, choose `Personal Microsoft accounts only` or `Accounts in any organizational directory and personal Microsoft accounts`.

### invalid_client

Usually caused by copying the Secret ID instead of the secret Value.

Fix: create a new client secret and copy the Value immediately.

### No refresh token

Usually caused by missing `offline_access`.

Fix: ensure `offline_access` is included in scopes/API permissions.

## Security

Do not put Microsoft client secrets in React, localStorage, GitHub, or `VITE_*` variables. Store them only in Render environment variables or secret files. OAuth access/refresh tokens are stored per-user in encrypted HttpOnly cookies by the backend.
