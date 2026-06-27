# OpenAI quota / billing errors

When PsychApp returns `openai_quota_exceeded`, the failing budget is the OpenAI Platform budget. Render and Supabase do not generate this OpenAI quota error.

## Meaning

OpenAI returned HTTP `429` with a quota/billing message such as:

> You exceeded your current quota, please check your plan and billing details.

This is an OpenAI API billing/quota decision. It means the OpenAI organization/project/API key used for the request does not currently have enough usable quota for that request.

## Important distinction

Render only hosts the app and stores the OpenAI secret. Supabase stores app data. Neither Render nor Supabase is the budget being rejected by OpenAI.

If the OpenAI dashboard shows unused credit, but PsychApp still gets `openai_quota_exceeded`, check these OpenAI-only mismatch cases:

1. The credit is in one OpenAI organization, but the API key belongs to another OpenAI organization.
2. The credit is visible at account/organization level, but the OpenAI project used by this API key has a project monthly budget that is too low or already exhausted.
3. The key stored by the app is old, revoked, copied from a different OpenAI project, or has hidden whitespace/newline characters.
4. The credit purchase was recent and OpenAI billing propagation has not finished yet.
5. A previous overrun produced negative OpenAI credit balance, so the new prepaid credit was partially consumed immediately.

## What to check in OpenAI Platform

1. Select the OpenAI organization where the 5 EUR credit appears.
2. In that same organization, select the project intended for PsychApp.
3. Check the project Usage.
4. Check the project Limits / Billing / Monthly budget.
5. Create a fresh API key from that exact OpenAI project.
6. Replace the app secret with that fresh OpenAI key and restart the app so it reads the new key.
7. Open `/api/health` and confirm:
   - `openai.key_present = true`
   - `openai.model` is the expected model
   - `mock = false` for real analysis

## Web scraping note

The existing public profile workflow originally used OpenAI `web_search`, not a true independent scraper. OpenAI `web_search` is a hosted web search tool; it can fail or return little data when X/Instagram/login walls/anti-bot controls prevent useful public extraction.

A true scraper would need a server-side fetch/extraction endpoint or official exports/APIs. That is separate from the OpenAI quota error.

## Safe UI testing without spending credits

Set this app variable temporarily:

```bash
MOCK_AI=true
```

This only smoke-tests the app/OAuth flow. It does not perform real psychological analysis and should be unset or set to `false` for production.

## Backend behavior

The server classifies OpenAI upstream errors before returning them to the frontend:

- `openai_quota_exceeded`: OpenAI quota, billing, credits, or monthly spend cap.
- `openai_rate_limited`: temporary OpenAI request/token rate limit.
- `openai_auth_or_permission_error`: invalid OpenAI key, wrong OpenAI project, or no model permission.
- `openai_upstream_error`: temporary OpenAI 5xx error.

No API key, OAuth token, prompt body, email, Drive content, or Supabase data is returned in the diagnostic payload.
