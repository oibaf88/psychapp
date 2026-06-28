# PsychApp as a ChatGPT remote MCP server

PsychApp now exposes an authenticated remote MCP endpoint for ChatGPT / OpenAI Apps SDK.

## Connector URL

Use this URL when creating the connector in ChatGPT developer mode:

```text
https://psychapp.bfab.io/mcp
```

## Required public endpoints

The server exposes:

```text
POST /mcp
GET  /.well-known/oauth-protected-resource
GET  /.well-known/oauth-protected-resource/mcp
GET  /.well-known/oauth-authorization-server
GET  /.well-known/openid-configuration
POST /oauth/register
GET  /oauth/authorize
POST /oauth/authorize
POST /oauth/token
GET  /api/mcp/debug
```

## OAuth flow implemented

ChatGPT acts as the OAuth client. PsychApp acts as both:

- Resource server: `/mcp`, validates Bearer access tokens.
- Authorization server: `/oauth/authorize`, `/oauth/token`, `/oauth/register`.

The flow supports:

- OAuth authorization code flow.
- PKCE S256.
- Dynamic client registration.
- Refresh tokens.
- Protected resource metadata discovery.
- OAuth authorization server metadata discovery.
- `resource` parameter echoing.

## Render variables

Required / strongly recommended:

```env
PUBLIC_BASE_URL=https://psychapp.bfab.io
OAUTH_COOKIE_SECRET=long_random_string
PSYCHAPP_MCP_PATH=/mcp
PSYCHAPP_MCP_PUBLIC_BASE_URL=https://psychapp.bfab.io
PSYCHAPP_MCP_OWNER_PIN=your_private_pin
```

Optional but recommended:

```env
PSYCHAPP_MCP_OAUTH_SECRET=separate_long_random_string
PSYCHAPP_MCP_ALLOWED_REDIRECT_URIS=https://chatgpt.com/connector/oauth/YOUR_CALLBACK_ID
SUPABASE_URL=https://zzgavefdyzbukbrowzot.supabase.co
SUPABASE_SERVICE_ROLE_KEY=server_side_service_role_key
```

If `PSYCHAPP_MCP_ALLOWED_REDIRECT_URIS` is not set, PsychApp allows the default ChatGPT connector callback pattern:

```text
https://chatgpt.com/connector/oauth/*
https://chatgpt.com/connector_platform_oauth_redirect
```

## Supabase

The migration `psychapp_mcp_oauth_audit` has been applied to the existing `bfab.io` Supabase project. It creates:

```text
public.psychapp_mcp_oauth_audit
public.psychapp_analysis_snapshots
```

Both tables have RLS enabled and no public policies. They are meant for server-side service-role use only.

## How to connect in ChatGPT

1. Deploy PsychApp on Render.
2. Open:

```text
https://psychapp.bfab.io/api/mcp/debug
```

3. Confirm:

```text
mcp_endpoint: https://psychapp.bfab.io/mcp
owner_pin_configured: true
```

4. In ChatGPT: Settings → Apps & Connectors → Advanced settings → enable Developer mode.
5. Go to Settings → Connectors → Create.
6. Use connector URL:

```text
https://psychapp.bfab.io/mcp
```

7. During OAuth, enter `PSYCHAPP_MCP_OWNER_PIN` and authorize.
8. Refresh connector metadata if tools do not appear immediately.

## Tools currently exposed

```text
psychapp_status
psychapp_analyze_text_sample
psychapp_plan_data_sources
psychapp_record_analysis_snapshot
```

These tools are intentionally conservative. They do not expose Gmail, Drive or raw clinical data directly. Sensitive connectors should be added only after consent, audit, deletion and least-privilege policies are explicit.
