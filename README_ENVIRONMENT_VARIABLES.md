# PsychApp environment variables

This document is the source of truth for Render environment variables used by PsychApp.

## Canonical production URL

PsychApp is currently hosted at:

```text
https://psychapp.bfab.io
```

Canonical OAuth redirect URIs:

```text
Google:    https://psychapp.bfab.io/api/oauth/callback/google
Microsoft: https://psychapp.bfab.io/api/oauth/callback/microsoft
```

These URLs must be configured both in Render and in the corresponding Google / Microsoft OAuth app settings.

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

## Critical rule about scopes

Do **not** set `GOOGLE_SCOPES` or `MICROSOFT_SCOPES` in Render while debugging.

The backend uses safe built-in scopes. Custom scopes are ignored unless this is explicitly set:

```env
ALLOW_CUSTOM_OAUTH_SCOPES=true
```

Keep it unset or false:

```env
ALLOW_CUSTOM_OAUTH_SCOPES=false
```

This prevents accidental invalid scopes caused by putting token URLs, validation URLs, Graph URLs, or callback URLs into a scope field.

## Required runtime variables on Render

```env
NODE_VERSION=22.22.0
PORT=10000
PUBLIC_BASE_URL=https://psychapp.bfab.io
OAUTH_COOKIE_SECRET=CHANGE_ME_LONG_RANDOM_STRING
MCP_REQUIRE_APPROVAL=never
ALLOW_CUSTOM_OAUTH_SCOPES=false
```

`PUBLIC_BASE_URL` must not have a trailing slash.

Correct:

```env
PUBLIC_BASE_URL=https://psychapp.bfab.io
```

Wrong:

```env
PUBLIC_BASE_URL=https://psychapp.bfab.io/
```

## OpenAI

Recommended on Render: use a Secret File, not a normal env var.

Secret File:

```text
Filename: OPENAI_API_SECRET
Contents: sk-proj-...
Mounted path: /etc/secrets/OPENAI_API_SECRET
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
GOOGLE_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/google
```

Accepted aliases:

```env
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/google
```

Do not set `GOOGLE_SCOPES` unless `ALLOW_CUSTOM_OAUTH_SCOPES=true`.

Built-in Google scopes used by the backend:

```text
openid
email
profile
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/calendar.readonly
```

Google redirect URI to register in Google Cloud Console:

```text
https://psychapp.bfab.io/api/oauth/callback/google
```

## Microsoft OAuth

Preferred names:

```env
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/microsoft
MICROSOFT_TENANT=consumers
```

Accepted aliases:

```env
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
AZURE_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/microsoft
MS_CLIENT_ID=...
MS_CLIENT_SECRET=...
MS_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/microsoft
```

Do not mix Microsoft values into Google variables.

Microsoft redirect URI to register in Microsoft Entra:

```text
https://psychapp.bfab.io/api/oauth/callback/microsoft
```

For personal Outlook/Hotmail/Live accounts, keep:

```env
MICROSOFT_TENANT=consumers
```

Do not set `MICROSOFT_SCOPES` unless `ALLOW_CUSTOM_OAUTH_SCOPES=true`.

Built-in Microsoft scopes used by the backend:

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

Do not add SharePoint or Teams while debugging personal accounts:

```text
Sites.Read.All
Team.ReadBasic.All
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

## Current minimal Render variables

```env
NODE_VERSION=22.22.0
PORT=10000
PUBLIC_BASE_URL=https://psychapp.bfab.io
OAUTH_COOKIE_SECRET=generated_string_here
OPENAI_MODEL=gpt-4.1-mini
OPENAI_STORE=false
MCP_REQUIRE_APPROVAL=never
ALLOW_CUSTOM_OAUTH_SCOPES=false
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/google
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/microsoft
MICROSOFT_TENANT=consumers
```

Plus Render Secret File:

```text
OPENAI_API_SECRET
```

## Variables to remove from Render while debugging

Remove or leave unset:

```env
GOOGLE_SCOPES=
MICROSOFT_SCOPES=
GOOGLE_TOKEN_URL=
MICROSOFT_TOKEN_URL=
GOOGLE_VALIDATION_URL=
MICROSOFT_VALIDATION_URL=
GOOGLE_AUTHORIZATION_URL=
MICROSOFT_AUTHORIZATION_URL=
GOOGLE_COOKIE_SECRET=
MICROSOFT_COOKIE_SECRET=
```

The backend already knows the provider authorization and token endpoints. PsychApp is the OAuth client; Google and Microsoft are the OAuth providers.
