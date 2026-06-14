# PsychApp environment variables

This document is the source of truth for Render environment variables used by PsychApp.

## Important rule

Google and Microsoft variables are already namespaced. They do not overwrite each other.

Use one global OAuth cookie secret for all OAuth providers:

```env
OAUTH_COOKIE_SECRET=long_random_string
```

Do **not** create provider-specific cookie variables unless the backend code is changed. These are not used by the current backend:

```env
GOOGLE_COOKIE_SECRET=
MICROSOFT_COOKIE_SECRET=
MICROSOFT_COOKIE_ID=
GOOGLE_COOKIE_ID=
```

The backend stores all OAuth provider sessions in the same encrypted HttpOnly cookie named `psychapp_oauth`.

## Required runtime variables on Render

```env
NODE_VERSION=22.22.0
PORT=10000
PUBLIC_BASE_URL=https://YOUR-APP.onrender.com
OAUTH_COOKIE_SECRET=CHANGE_ME_LONG_RANDOM_STRING
MCP_REQUIRE_APPROVAL=never
```

`PUBLIC_BASE_URL` must not have a trailing slash.

Correct:

```env
PUBLIC_BASE_URL=https://pyschapp.onrender.com
```

Wrong:

```env
PUBLIC_BASE_URL=https://pyschapp.onrender.com/
```

## OpenAI

Recommended on Render: use a Secret File, not a normal env var.

Secret File:

```text
Filename: OPENAI_API_SECRET
Contents: sk-proj-...
Mounted path: /etc/secrets/OPENAI_API_SECRET
```

Accepted OpenAI env/secret names in the backend:

```env
OPENAI_API_KEY=
OPENAI_API_SECRET=
OPENAI_KEY=
openai_api_key=
openai_api_secret=
openai_key=
```

Normal model settings:

```env
OPENAI_MODEL=gpt-4.1-mini
OPENAI_STORE=false
```

## Google OAuth

Preferred names:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://YOUR-APP.onrender.com/api/oauth/callback/google
```

Accepted aliases:

```env
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=...
```

Optional scope override. Leave commented unless debugging:

```env
# GOOGLE_SCOPES=openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/calendar.readonly
```

Google redirect URI to register in Google Cloud Console:

```text
https://YOUR-APP.onrender.com/api/oauth/callback/google
```

## Microsoft OAuth

Preferred names:

```env
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_REDIRECT_URI=https://YOUR-APP.onrender.com/api/oauth/callback/microsoft
```

Accepted aliases:

```env
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
AZURE_REDIRECT_URI=...
MS_CLIENT_ID=...
MS_CLIENT_SECRET=...
MS_REDIRECT_URI=...
```

Do not mix Microsoft values into Google variables.

Microsoft redirect URI to register in Microsoft Entra:

```text
https://YOUR-APP.onrender.com/api/oauth/callback/microsoft
```

## Microsoft tenant and scopes

The backend now reads:

```env
MICROSOFT_TENANT=consumers
```

For personal Outlook/Hotmail/Live accounts, keep:

```env
MICROSOFT_TENANT=consumers
```

The backend default Microsoft scope set is personal-account safe and uses full Microsoft Graph scope names:

```env
MICROSOFT_SCOPES=openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/Calendars.Read
```

Do not add these while debugging personal accounts:

```text
https://graph.microsoft.com/Sites.Read.All
https://graph.microsoft.com/Team.ReadBasic.All
```

Add those only later for work/school Microsoft 365 accounts if you really need SharePoint or Teams.

## OAuth cookie secret generation

PowerShell:

```powershell
[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
```

Node:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the generated string into Render as:

```env
OAUTH_COOKIE_SECRET=generated_string_here
```

## Current expected Render variables

A complete minimal Render setup should look like:

```env
NODE_VERSION=22.22.0
PORT=10000
PUBLIC_BASE_URL=https://pyschapp.onrender.com
OAUTH_COOKIE_SECRET=generated_string_here
OPENAI_MODEL=gpt-4.1-mini
OPENAI_STORE=false
MCP_REQUIRE_APPROVAL=never
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://pyschapp.onrender.com/api/oauth/callback/google
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_REDIRECT_URI=https://pyschapp.onrender.com/api/oauth/callback/microsoft
MICROSOFT_TENANT=consumers
MICROSOFT_SCOPES=openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/Calendars.Read
```

Plus Render Secret File:

```text
OPENAI_API_SECRET
```
