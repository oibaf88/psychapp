# Psyche Deep — Configuration Setup Guide

This guide covers everything you need to configure for a working Render.com deployment,
including Google Cloud, Microsoft Azure, and Render environment variables.

---

## 1. Google Cloud Console — OAuth Setup

### Step-by-step

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and sign in.
2. Click the project dropdown at the top → **New Project** → give it a name (e.g. "Psyche Deep") → Create.
3. In the left menu go to **APIs & Services → Library**. Enable these three APIs one by one:
   - **Gmail API**
   - **Google Drive API**
   - **Google Calendar API**
4. Go to **APIs & Services → OAuth consent screen**.
   - User type: **External** (unless you have a Google Workspace org).
   - Fill in App name, user support email, developer email.
   - Scopes: click **Add or Remove Scopes** and add:
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/drive.readonly`
     - `https://www.googleapis.com/auth/calendar.readonly`
   - Test users: add your own Gmail address while the app is in "Testing" mode.
   - Save and Continue through all steps.
5. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Name: "Psyche Deep".
   - Authorized redirect URIs: add exactly this URI (replace with your real Render URL):
     ```
     https://YOUR-APP.onrender.com/api/oauth/callback/google
     ```
   - Click **Create**. Copy the **Client ID** and **Client Secret** — you will need them.

### Environment variables to add in Render

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | Client ID from step 5 |
| `GOOGLE_CLIENT_SECRET` | Client Secret from step 5 |
| `GOOGLE_REDIRECT_URI` | `https://YOUR-APP.onrender.com/api/oauth/callback/google` |

---

## 2. Microsoft Azure — OAuth App Registration

### Step-by-step

1. Go to [portal.azure.com](https://portal.azure.com/) and sign in with any Microsoft account.
2. Search for **Microsoft Entra ID** (formerly Azure Active Directory) in the top search bar and open it.
3. In the left menu click **App registrations → New registration**.
4. Fill in the registration form:
   - **Name**: Psyche Deep
   - **Supported account types** — choose based on your use case:
     - **"Personal Microsoft accounts only"** → for Outlook/Hotmail/Live personal accounts (use `MICROSOFT_TENANT=consumers`)
     - **"Accounts in any organizational directory and personal Microsoft accounts"** → for both personal and work accounts (use `MICROSOFT_TENANT=common`)
     - **"Accounts in this organizational directory only"** → for a single work/school tenant only (use your tenant GUID)
   - **Redirect URI**: Platform = **Web**, URI = `https://YOUR-APP.onrender.com/api/oauth/callback/microsoft`
5. Click **Register**. Note the **Application (client) ID** — this is your `MICROSOFT_CLIENT_ID`.
6. In the left menu click **Certificates & secrets → New client secret**.
   - Description: "psyche-deep-secret", Expires: 24 months.
   - Click Add. **Copy the Value immediately** (it won't be shown again). This is your `MICROSOFT_CLIENT_SECRET`.
7. In the left menu click **API permissions → Add a permission → Microsoft Graph → Delegated permissions**. Add all of these:
   - `openid`
   - `profile`
   - `email`
   - `offline_access`
   - `User.Read`
   - `Mail.Read`
   - `Files.Read.All`
   - `Calendars.Read`
8. Click **Grant admin consent for [your tenant]** if the button is visible (only needed for some scopes when you control the tenant).

### Critical: redirect URI must match exactly

The redirect URI in Azure must match character-for-character what the app sends.
You can verify the app's redirect URI by visiting:
```
https://YOUR-APP.onrender.com/api/debug/config
```
Look for `oauth.config.microsoft.redirect_uri` in the JSON response.

### Environment variables to add in Render

| Variable | Value |
|---|---|
| `MICROSOFT_TENANT` | `consumers` (personal), `common` (both), or tenant GUID |
| `MICROSOFT_CLIENT_ID` | Application (client) ID from step 5 |
| `MICROSOFT_CLIENT_SECRET` | Client secret Value from step 6 |
| `MICROSOFT_REDIRECT_URI` | `https://YOUR-APP.onrender.com/api/oauth/callback/microsoft` |

### Common Microsoft errors and fixes

| Error | Cause | Fix |
|---|---|---|
| "Token endpoint returned HTML" | Redirect URI mismatch or wrong account type | Check redirect URI matches exactly; check "Supported account types" |
| `AADSTS50011` | Redirect URI not registered in Azure | Add the exact URI in App registration → Authentication |
| `AADSTS700016` | Wrong client_id | Verify `MICROSOFT_CLIENT_ID` matches the Application ID in Azure |
| `AADSTS7000215` | Wrong client_secret | Regenerate client secret; copy the Value (not the Secret ID) |
| `AADSTS50020` | Personal account not supported | Change account type to include personal accounts or set `MICROSOFT_TENANT=consumers` |

---

## 3. Render.com — Environment Variables

Go to your Render service → **Environment** tab and add these variables:

### Required for all deployments

| Variable | Example / Notes |
|---|---|
| `PUBLIC_BASE_URL` | `https://psyche-deep-openai.onrender.com` — your full Render URL (no trailing slash). If you have a custom domain, use that. |
| `OAUTH_COOKIE_SECRET` | Long random string, e.g. generate with `openssl rand -base64 48`. Used to encrypt OAuth tokens stored in cookies. |

### OpenAI

| Variable | Notes |
|---|---|
| `OPENAI_API_KEY` | Your OpenAI API key. **Recommended**: use a Render Secret File named `OPENAI_API_SECRET` instead of an env var for better security. |
| `OPENAI_MODEL` | Default: `gpt-4.1-mini`. Change to `gpt-4.1` for higher quality. |

### Using Render Secret Files for OpenAI key (recommended)

1. In Render dashboard go to your service → **Secret Files**.
2. Create a file named exactly `OPENAI_API_SECRET`.
3. Content: your OpenAI API key (`sk-proj-...`).
4. Render mounts it at `/etc/secrets/OPENAI_API_SECRET` automatically.
5. Do NOT also set `OPENAI_API_KEY` as an env var — the Secret File takes precedence.

### Runtime options

| Variable | Default | Notes |
|---|---|---|
| `MCP_REQUIRE_APPROVAL` | `never` | Set to `auto` to require manual approval for each MCP tool call |
| `ALLOW_CUSTOM_OAUTH_SCOPES` | `false` | Set to `true` only if you need to override default OAuth scopes via `GOOGLE_SCOPES` or `MICROSOFT_SCOPES` |
| `OPENAI_STORE` | `false` | Set to `true` to enable OpenAI conversation storage |

### Variables to delete / avoid setting

These are NOT needed and may cause confusion if set:

- `GOOGLE_COOKIE_SECRET` — not used; the app uses one global `OAUTH_COOKIE_SECRET`
- `MICROSOFT_COOKIE_SECRET` — same as above
- `GOOGLE_SCOPES` — only read if `ALLOW_CUSTOM_OAUTH_SCOPES=true`
- `MICROSOFT_SCOPES` — only read if `ALLOW_CUSTOM_OAUTH_SCOPES=true`

---

## 4. How to Delete a Custom Subdomain on Render.com (Free Plan)

Render's free plan allows only **one custom domain per service**. To switch to a different subdomain:

### Steps to delete an existing custom domain

1. Go to [dashboard.render.com](https://dashboard.render.com/) and open your service.
2. Click the **Settings** tab.
3. Scroll down to the **Custom Domains** section.
4. Find the subdomain you want to remove. Click the **three-dot menu (⋯)** next to it.
5. Click **Delete** (or **Remove**).
6. Confirm the deletion.

### After deleting — clean up DNS

Log in to your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.) and delete the DNS records you created for the old subdomain (usually a CNAME record pointing to `your-service.onrender.com`).

### Add a new custom subdomain

1. In the same **Custom Domains** section, click **Add Custom Domain**.
2. Enter your new subdomain (e.g. `psyche.yourdomain.com`).
3. Render will show you a CNAME record to add to your DNS:
   - Type: `CNAME`
   - Name: `psyche` (just the subdomain part)
   - Value: `your-service.onrender.com`
4. Add this record at your registrar. DNS propagation can take a few minutes to 48 hours.
5. Render will automatically issue a TLS certificate once DNS verifies.

### Important: update your redirect URIs after changing domains

After switching to a new domain, update these env vars in Render and the corresponding settings in Google Cloud / Azure:

- `PUBLIC_BASE_URL` → new domain URL
- `GOOGLE_REDIRECT_URI` → `https://new-domain.com/api/oauth/callback/google`
- `MICROSOFT_REDIRECT_URI` → `https://new-domain.com/api/oauth/callback/microsoft`
- In Google Cloud Console: add the new URI to Authorized redirect URIs
- In Azure Portal: add the new URI in App registration → Authentication → Redirect URIs

---

## 5. Verify Everything is Working

After deploying with all env vars set, visit these diagnostic URLs:

- **`/api/health`** — shows OpenAI key status, OAuth config, and secret file detection
- **`/api/oauth/status`** — shows which OAuth providers are currently connected
- **`/api/debug/config`** — shows the exact redirect URIs the app will use (no secrets exposed)

Example check:
```
https://YOUR-APP.onrender.com/api/debug/config
```

Look at `oauth.config.google.redirect_uri` and `oauth.config.microsoft.redirect_uri` — these must match exactly what you registered in Google Cloud and Azure.
