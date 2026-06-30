# PsychApp connector and OAuth permissions checklist

This file is the operational checklist for the production setup at:

```text
https://psychapp.bfab.io
```

## 1. Render vs OpenAI connector

There is no separate Render-side connector to create between Render and OpenAI.

Render hosts the PsychApp Node server. ChatGPT/OpenAI connects to the public MCP endpoint exposed by that server:

```text
https://psychapp.bfab.io/mcp
```

Do not use the frontend path as the ChatGPT MCP URL:

```text
Wrong: https://psychapp.bfab.io/psychapp/mcp
Right: https://psychapp.bfab.io/mcp
```

Render must serve the latest `main` commit before ChatGPT can see the MCP tools.

Verify these URLs after deployment:

```text
https://psychapp.bfab.io/psychapp/api/health
https://psychapp.bfab.io/api/mcp/debug
https://psychapp.bfab.io/.well-known/oauth-protected-resource
https://psychapp.bfab.io/.well-known/oauth-authorization-server
```

Expected signs:

- `/psychapp/api/health` includes `mental_health`.
- `/api/mcp/debug` returns `ok: true` and `mcp_endpoint: https://psychapp.bfab.io/mcp`.
- `/mcp` returns `401 Unauthorized` without a Bearer token, not the React frontend.

## 2. Render environment variables

Required production values:

```env
PUBLIC_BASE_URL=https://psychapp.bfab.io
APP_BASE_PATH=/psychapp
OAUTH_COOKIE_SECRET=<long random string>
ALLOW_CUSTOM_OAUTH_SCOPES=false

PSYCHAPP_MCP_PATH=/mcp
PSYCHAPP_MCP_PUBLIC_BASE_URL=https://psychapp.bfab.io
PSYCHAPP_MCP_OWNER_PIN=<private owner pin>
PSYCHAPP_MCP_OAUTH_SECRET=<long random string>

GOOGLE_CLIENT_ID=<google web oauth client id>
GOOGLE_CLIENT_SECRET=<google client secret>
GOOGLE_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/google

MICROSOFT_TENANT=common
MICROSOFT_CLIENT_ID=<entra application client id>
MICROSOFT_CLIENT_SECRET=<entra client secret value>
MICROSOFT_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/microsoft
```

OpenAI should stay server-side as either `OPENAI_API_KEY` or a Render Secret File accepted by the backend. Do not expose it in the browser.

If `GOOGLE_SCOPES` or `MICROSOFT_SCOPES` are present while `ALLOW_CUSTOM_OAUTH_SCOPES=false`, the backend ignores them and uses the safe defaults below.

## 3. Google Cloud setup

Create an OAuth client:

- Application type: `Web application`.
- Authorized redirect URI: `https://psychapp.bfab.io/api/oauth/callback/google`.
- Enable the APIs you intend to use: Gmail API, Google Drive API, Google Calendar API.
- OAuth consent screen: add your account as a test user while the app is in testing mode.

Scopes used by the backend by default:

```text
openid
email
profile
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/calendar.events.readonly
```

If Google was previously connected with broader or different scopes, disconnect Google in PsychApp and connect again after deployment. Existing refresh tokens do not automatically gain newly requested scopes.

## 4. Microsoft Entra setup

Create an Entra app registration:

- Supported account types: use `Accounts in any organizational directory and personal Microsoft accounts` when `MICROSOFT_TENANT=common`.
- Platform: `Web`.
- Redirect URI: `https://psychapp.bfab.io/api/oauth/callback/microsoft`.
- Create a client secret and put the secret value, not the secret id, into `MICROSOFT_CLIENT_SECRET`.

Default delegated permissions for personal and basic work/school mail, files and calendar:

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

For Microsoft 365 organization-only data such as SharePoint sites and Teams chats/channels, add delegated Microsoft Graph permissions and grant admin consent:

```text
Sites.Read.All
Chat.Read
ChannelMessage.Read.All
```

Then set Render explicitly:

```env
ALLOW_CUSTOM_OAUTH_SCOPES=true
MICROSOFT_SCOPES="openid profile email offline_access User.Read Mail.Read Files.Read.All Calendars.Read Sites.Read.All Chat.Read ChannelMessage.Read.All"
```

Personal Microsoft accounts cannot provide all Teams/SharePoint organization data. If you are testing with Outlook.com, Hotmail, or Live, leave `ALLOW_CUSTOM_OAUTH_SCOPES=false` and use only the default scopes.

## 5. Reconnect after permission changes

After changing Google/Microsoft consent screen permissions, API enablement, redirect URIs, or Render scope variables:

1. Deploy the latest server.
2. In PsychApp, disconnect the affected provider.
3. Connect it again.
4. Open `/psychapp/api/oauth/status`.
5. Check `connectors.<id>.ready` and `missing_scopes`.

If a provider is connected but a connector is not ready, the token is valid but missing one or more required scopes.

## 6. Early-warning source consent behavior

`/psychapp/api/analyze` always runs as `early_warning_report`. The backend rejects selected data sources that are not explicitly allowed in `mental_health_early_warning.allowed_sources`.

Important source rules:

- Gmail and Outlook connectors require `email_text`, because the OpenAI connector can retrieve message content.
- Google Calendar and Outlook Calendar require `calendar`.
- Google Drive and OneDrive / SharePoint require `notes` or `uploaded_files`.
- Microsoft Teams requires `chat_history`.
- Public profile URLs require `public_profiles`.
- Uploaded documents require `uploaded_files`.
- Pasted notes or central text require `notes` or `uploaded_files`.

When a source is missing, the API returns `source_consent_violations` instead of silently skipping the source.
