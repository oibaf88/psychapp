# Psyche Deep — Configuration Setup Guide

This guide covers the current production deployment at:

```text
https://psychapp.bfab.io
```

Canonical OAuth redirect URIs:

```text
Google:    https://psychapp.bfab.io/api/oauth/callback/google
Microsoft: https://psychapp.bfab.io/api/oauth/callback/microsoft
```

Use these exact URLs in Render, Google Cloud Console, and Microsoft Entra.

---

## 1. Google Cloud Console — OAuth Setup

### Step-by-step

1. Go to Google Cloud Console and sign in.
2. Click the project dropdown at the top → **New Project** → give it a name such as `PsychApp` → Create.
3. In the left menu go to **APIs & Services → Library**. Enable these APIs:
   - **Gmail API**
   - **Google Drive API**
   - **Google Calendar API**
4. Go to **APIs & Services → OAuth consent screen**.
   - User type: **External**, unless you have a Google Workspace org.
   - Fill in App name, user support email, developer email.
   - Scopes: click **Add or Remove Scopes** and add:
     - `openid`
     - `email`
     - `profile`
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/drive.readonly`
     - `https://www.googleapis.com/auth/calendar.events.readonly`
   - Test users: add your own Gmail address while the app is in Testing mode.
   - Save and continue through all steps.
5. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Name: `PsychApp`.
   - Authorized redirect URI: add exactly:

```text
https://psychapp.bfab.io/api/oauth/callback/google
```

6. Click **Create**. Copy the **Client ID** and **Client Secret**.

### Environment variables to add in Render

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/google
```

Do not set `GOOGLE_SCOPES` while debugging unless `ALLOW_CUSTOM_OAUTH_SCOPES=true`.

---

## 2. Microsoft Entra — OAuth App Registration

### Step-by-step

1. Go to Microsoft Entra admin center / Azure Portal and sign in with the Microsoft account you want to use.
2. Search for **Microsoft Entra ID** and open it.
3. In the left menu click **App registrations → New registration**.
4. Fill in the registration form:
   - **Name**: `PsychApp`
   - **Supported account types**:
     - Choose **Personal Microsoft accounts only** for Outlook/Hotmail/Live personal accounts.
     - Choose **Accounts in any organizational directory and personal Microsoft accounts** only if you also need work/school accounts.
   - **Redirect URI**:
     - Platform: **Web**
     - URI:

```text
https://psychapp.bfab.io/api/oauth/callback/microsoft
```

5. Click **Register**. Copy the **Application (client) ID**. This is `MICROSOFT_CLIENT_ID`.
6. In the left menu click **Certificates & secrets → New client secret**.
   - Description: `psychapp-secret`.
   - Copy the **Value** immediately. This is `MICROSOFT_CLIENT_SECRET`.
7. In the left menu click **API permissions → Add a permission → Microsoft Graph → Delegated permissions**. Add:
   - `openid`
   - `profile`
   - `email`
   - `offline_access`
   - `User.Read`
   - `Mail.Read`
   - `Files.Read.All`
   - `Calendars.Read`

Do not add `Sites.Read.All`, `Chat.Read`, or `ChannelMessage.Read.All` until the personal Outlook/Hotmail flow is stable. Use them only for Microsoft 365 organization accounts with tenant admin consent.

### Microsoft endpoints for personal accounts

```text
Tenant / Authority:
https://login.microsoftonline.com/consumers

Authorization endpoint:
https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize

Token endpoint:
https://login.microsoftonline.com/consumers/oauth2/v2.0/token

OIDC metadata:
https://login.microsoftonline.com/consumers/v2.0/.well-known/openid-configuration
```

### Environment variables to add in Render

```env
MICROSOFT_TENANT=common
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/microsoft
```

Do not set `MICROSOFT_SCOPES` while debugging unless `ALLOW_CUSTOM_OAUTH_SCOPES=true`.

---

## 3. Render.com — Environment Variables

Go to your Render service → **Environment** tab and use this minimal set:

```env
NODE_VERSION=22.22.0
PORT=10000
PUBLIC_BASE_URL=https://psychapp.bfab.io
OAUTH_COOKIE_SECRET=generated_long_random_string
OPENAI_MODEL=gpt-4.1-mini
OPENAI_STORE=false
MCP_REQUIRE_APPROVAL=never
ALLOW_CUSTOM_OAUTH_SCOPES=false
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/google
MICROSOFT_TENANT=common
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/microsoft
```

### OpenAI Secret File

Recommended:

1. In Render dashboard, go to your service → **Secret Files**.
2. Create a file named exactly:

```text
OPENAI_API_SECRET
```

3. Content: your OpenAI API key.
4. Render mounts it at:

```text
/etc/secrets/OPENAI_API_SECRET
```

Do not also set `OPENAI_API_KEY` unless you deliberately prefer a normal environment variable.

### OAuth cookie secret

Generate one with PowerShell:

```powershell
[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
```

Put it in Render as:

```env
OAUTH_COOKIE_SECRET=generated_value_here
```

### Variables to delete / avoid setting

These are not needed and can break OAuth if set incorrectly:

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

---

## 4. Custom domain checklist

For the current domain, make sure DNS points `psychapp.bfab.io` to the Render service and that Render has issued TLS.

After changing domains, update all three places:

```text
Render PUBLIC_BASE_URL=https://psychapp.bfab.io
Google redirect URI=https://psychapp.bfab.io/api/oauth/callback/google
Microsoft redirect URI=https://psychapp.bfab.io/api/oauth/callback/microsoft
```

---

## 5. Verify Everything is Working

After deploying with all env vars set, visit:

```text
https://psychapp.bfab.io/api/health
https://psychapp.bfab.io/api/debug/config
https://psychapp.bfab.io/api/oauth/status
```

Check:

- `openai.key_present` is `true`.
- `oauth.config.google.redirect_uri` is `https://psychapp.bfab.io/api/oauth/callback/google`.
- `oauth.config.microsoft.redirect_uri` is `https://psychapp.bfab.io/api/oauth/callback/microsoft`.
- `oauth.config.microsoft.auth_url` uses `consumers` for personal Microsoft accounts.

Then test:

```text
https://psychapp.bfab.io/api/oauth/start/google
https://psychapp.bfab.io/api/oauth/start/microsoft
```
