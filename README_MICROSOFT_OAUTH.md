# OAuth JSON compatibility: Microsoft / Google callbacks

This app is an OAuth **client**, not an OAuth/OIDC provider.

Do **not** configure PsychApp as a credential validation endpoint, issuer URL, token endpoint, authorization endpoint, or OIDC metadata endpoint. If a validator calls PsychApp expecting provider JSON but receives `<html>`, it will fail with errors such as:

- `Credential Validation Unavailable`
- `unexpected response from your application: <`
- `Path "", line 0, position 0`

That means the caller expected JSON but received the PWA `index.html` or an HTML OAuth result page.

## Canonical production URL

PsychApp is currently hosted at:

```text
https://psychapp.bfab.io
```

Register these callback URLs exactly:

```text
Google:    https://psychapp.bfab.io/api/oauth/callback/google
Microsoft: https://psychapp.bfab.io/api/oauth/callback/microsoft
```

## Correct Microsoft endpoints

For personal Microsoft accounts such as Outlook.com, Hotmail, and Live:

```text
Tenant / Authority:
https://login.microsoftonline.com/consumers

Authorization endpoint:
https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize

Token endpoint:
https://login.microsoftonline.com/consumers/oauth2/v2.0/token

OpenID metadata:
https://login.microsoftonline.com/consumers/v2.0/.well-known/openid-configuration
```

## PsychApp redirect URI

Register this as the redirect URI / reply URL in Microsoft Entra:

```text
https://psychapp.bfab.io/api/oauth/callback/microsoft
```

Register this as the redirect URI in Google Cloud Console:

```text
https://psychapp.bfab.io/api/oauth/callback/google
```

## Render variables

```env
PUBLIC_BASE_URL=https://psychapp.bfab.io
OAUTH_COOKIE_SECRET=<long-random-string>
MICROSOFT_TENANT=consumers
MICROSOFT_CLIENT_ID=<application-client-id>
MICROSOFT_CLIENT_SECRET=<client-secret-value>
MICROSOFT_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/microsoft
ALLOW_CUSTOM_OAUTH_SCOPES=false
GOOGLE_CLIENT_ID=<google-client-id>
GOOGLE_CLIENT_SECRET=<google-client-secret>
GOOGLE_REDIRECT_URI=https://psychapp.bfab.io/api/oauth/callback/google
```

Do not set `MICROSOFT_SCOPES` or `GOOGLE_SCOPES` while debugging unless `ALLOW_CUSTOM_OAUTH_SCOPES=true`.

## JSON callback mode

The server accepts both `GET` and `POST` on:

```text
/api/oauth/callback/google
/api/oauth/callback/microsoft
```

It returns JSON instead of HTML if the request includes either:

```text
?json=1
```

or an HTTP header:

```text
Accept: application/json
```

Example:

```text
https://psychapp.bfab.io/api/oauth/callback/microsoft?json=1
```

## Important

Do not paste the authorization `code=` URL into chats or issue trackers. It is a temporary credential.
