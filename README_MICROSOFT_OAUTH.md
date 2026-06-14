# Microsoft OAuth setup for PsychApp

This guide configures Microsoft OAuth 2.0 for Outlook.com, Hotmail, Live, Microsoft personal mail, calendars, and OneDrive files through Microsoft Graph.

## What PsychApp implements

The backend exposes:

```text
GET  /api/oauth/start/microsoft
GET  /api/oauth/callback/microsoft
GET  /api/oauth/status
POST /api/oauth/logout/microsoft
GET  /api/debug/config
```

PsychApp is the OAuth client. Microsoft is the OAuth provider. PsychApp is not an OIDC provider and does not expose a metadata endpoint.

## Render variables

Use these names in Render:

```env
PUBLIC_BASE_URL=https://YOUR-APP.onrender.com
OAUTH_COOKIE_SECRET=GENERATE_A_LONG_RANDOM_STRING
MICROSOFT_CLIENT_ID=YOUR_APPLICATION_CLIENT_ID
MICROSOFT_CLIENT_SECRET=YOUR_CLIENT_SECRET_VALUE
MICROSOFT_REDIRECT_URI=https://YOUR-APP.onrender.com/api/oauth/callback/microsoft
MICROSOFT_TENANT=consumers
MICROSOFT_SCOPES=openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/Calendars.Read
MCP_REQUIRE_APPROVAL=never
```

Keep OpenAI separately as a Render Secret File:

```text
Filename: OPENAI_API_SECRET
Contents: sk-proj-...
Mounted path: /etc/secrets/OPENAI_API_SECRET
```

## Microsoft endpoints for personal accounts

Use `consumers` for Outlook.com / Hotmail / Live personal accounts:

```text
Authorization endpoint:
https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize

Token endpoint:
https://login.microsoftonline.com/consumers/oauth2/v2.0/token

OIDC metadata endpoint:
https://login.microsoftonline.com/consumers/v2.0/.well-known/openid-configuration
```

Do not put PsychApp URLs in the authorization endpoint or token endpoint fields.

## Redirect URI

Register this exact Web redirect URI in Microsoft Entra:

```text
https://YOUR-APP.onrender.com/api/oauth/callback/microsoft
```

Example:

```text
https://pyschapp.onrender.com/api/oauth/callback/microsoft
```

The value in Microsoft Entra must match `MICROSOFT_REDIRECT_URI` exactly.

## Microsoft Entra setup

1. Go to Microsoft Entra admin center.
2. Open `Applications` -> `App registrations` -> `New registration`.
3. Name the app, for example `PsychApp OAuth`.
4. For personal accounts, choose:

```text
Personal Microsoft accounts only
```

or, if you also want work/school accounts:

```text
Accounts in any organizational directory and personal Microsoft accounts
```

5. Add the Web redirect URI.
6. Register the app.
7. Copy `Application (client) ID` into Render as `MICROSOFT_CLIENT_ID`.
8. Create a client secret under `Certificates & secrets`.
9. Copy the secret **Value** into Render as `MICROSOFT_CLIENT_SECRET`.
10. Under `API permissions`, add Microsoft Graph delegated permissions:

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

## Scope string

For personal accounts, use this exact scope string when any external OAuth screen asks for scopes:

```text
openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/Calendars.Read
```

Do not start with Teams or SharePoint scopes. Add these only later for work/school Microsoft 365 accounts if you need them:

```text
https://graph.microsoft.com/Sites.Read.All
https://graph.microsoft.com/Team.ReadBasic.All
```

## Testing

After changing Render variables, run:

```text
Manual Deploy -> Clear build cache & deploy
```

Then open:

```text
https://YOUR-APP.onrender.com/api/debug/config
```

Check that Microsoft shows:

```text
microsoft_tenant: consumers
non-empty scopes
client_id_present: true
client_secret_present: true
```

Start OAuth:

```text
https://YOUR-APP.onrender.com/api/oauth/start/microsoft
```

After login, check:

```text
https://YOUR-APP.onrender.com/api/oauth/status
```

Expected:

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

## Common mistakes

### Empty or invalid scope

Use the full scope string above. Do not leave the scope field blank. Do not use Teams/SharePoint scopes until the personal flow works.

### Wrong endpoint

Wrong:

```text
Authorization URL = https://YOUR-APP.onrender.com/api/oauth/callback/microsoft
Token URL = https://YOUR-APP.onrender.com/api/oauth/callback/microsoft
```

Correct:

```text
Authorization URL = https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize
Token URL = https://login.microsoftonline.com/consumers/oauth2/v2.0/token
Redirect URI = https://YOUR-APP.onrender.com/api/oauth/callback/microsoft
```

### Redirect mismatch

The redirect URI in Microsoft Entra and in Render must be identical.
