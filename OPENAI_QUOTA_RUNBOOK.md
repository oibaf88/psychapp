# OpenAI quota / billing errors

When PsychApp returns `openai_quota_exceeded`, Gmail/Drive OAuth may be working correctly. The failure is in the OpenAI API billing/quota layer.

## Meaning

OpenAI returned HTTP `429` with a quota/billing message such as:

> You exceeded your current quota, please check your plan and billing details.

This means the OpenAI project or organization behind `OPENAI_API_SECRET` / `OPENAI_API_KEY` has consumed available credits, reached its monthly spend cap, or is not enabled with enough billing capacity.

## What to check

1. Open the OpenAI dashboard for the same organization/project that owns the API key used in Render.
2. Check **Usage**.
3. Check **Limits / Billing / Monthly budget**.
4. Add credits, increase budget, or replace the Render secret with an API key from a project that has available quota.
5. Redeploy/restart the Render service.
6. Open `/api/health` and confirm:
   - `openai.key_present = true`
   - `openai.model` is the expected model
   - `mock = false` for real analysis

## Safe UI testing without spending credits

Set this Render environment variable temporarily:

```bash
MOCK_AI=true
```

This only smoke-tests the app/OAuth flow. It does not perform real psychological analysis and should be unset or set to `false` for production.

## Backend behavior

The server now classifies OpenAI upstream errors before returning them to the frontend:

- `openai_quota_exceeded`: quota, billing, credits, or monthly spend cap.
- `openai_rate_limited`: temporary request/token rate limit.
- `openai_auth_or_permission_error`: invalid key, wrong project, or no model permission.
- `openai_upstream_error`: temporary OpenAI 5xx error.

No API key, OAuth token, prompt body, email, or Drive content is returned in the diagnostic payload.
