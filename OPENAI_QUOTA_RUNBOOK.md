# OpenAI quota / billing errors

When PsychApp returns `openai_quota_exceeded`, Gmail/Drive OAuth and Supabase may be working correctly. The failure is in the OpenAI API billing/quota layer.

## Meaning

OpenAI returned HTTP `429` with a quota/billing message such as:

> You exceeded your current quota, please check your plan and billing details.

OpenAI documents this specific message as: the API project has hit its monthly usage limit, the account has consumed prepaid credits, or the organization/project budget is set too low.

## Important: credit can exist but still not be usable by this app

If the OpenAI dashboard shows unused credit, but Render/PsychApp still gets `openai_quota_exceeded`, check these exact mismatch cases:

1. The credit is in one OpenAI organization, but the API key in Render belongs to another organization.
2. The credit is visible at account/organization level, but the project used by this API key has a project monthly budget that is too low or already exhausted.
3. The key stored in Render is old, revoked, copied from a different project, or has hidden whitespace/newline characters.
4. The credit purchase was recent and OpenAI billing propagation has not finished yet. OpenAI says newly purchased prepaid credits can take a couple of minutes to reflect.
5. A previous overrun produced negative credit balance; OpenAI says delayed billing can deduct excess usage from the next credit purchase.

## What to check

1. In OpenAI Platform, select the organization where the 5 EUR credit appears.
2. In that same organization, select the project intended for PsychApp.
3. Create a fresh project API key from that project.
4. In Render, replace the current `OPENAI_API_SECRET` Secret File or `OPENAI_API_KEY` env var with that fresh key.
5. Check the project **Usage** and **Limits / Billing / Monthly budget**. Make sure the project budget is greater than 0 and not already reached.
6. Redeploy/restart the Render service.
7. Open `/api/health` and confirm:
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

No API key, OAuth token, prompt body, email, Drive content, or Supabase data is returned in the diagnostic payload.
