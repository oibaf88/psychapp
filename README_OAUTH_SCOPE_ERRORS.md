# OAuth scope errors

This file documents OAuth errors where the provider or connector says that `scope` is missing from the credential.

## Canonical production URL

```text
https://psychapp.bfab.io
```

Canonical redirect URIs:

```text
Google:    https://psychapp.bfab.io/api/oauth/callback/google
Microsoft: https://psychapp.bfab.io/api/oauth/callback/microsoft
```

## Error: `scope is missing from the credential`

This usually means the OAuth credential definition was created without a `scope` field, or the field was left empty.

It is different from a missing access token. A credential can have a client ID and client secret and still be invalid if no scopes are declared.

## PsychApp backend status

PsychApp itself already sends a `scope` parameter when starting OAuth:

```js
// server.mjs
const auth = new URL(provider.authUrl);
auth.searchParams.set('scope', provider.scopes.join(' '));
```

So if this error appears inside an external credential setup screen, such as an OpenAI connector/custom credential screen, the missing field is normally in that external credential configuration, not in PsychApp's callback route.

## Microsoft personal accounts: recommended scope string

For Outlook.com, Hotmail, Live and personal Microsoft accounts, use this scope string:

```text
openid profile email offline_access User.Read Mail.Read Files.Read.All Calendars.Read
```

Use this in any field called:

```text
Scope
Scopes
OAuth scopes
Permission scopes
Credential scopes
```

Do not leave that field blank.

## Microsoft endpoint values

For personal Microsoft accounts:

```text
Authorization URL:
https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize

Token URL:
https://login.microsoftonline.com/consumers/oauth2/v2.0/token

OIDC metadata URL:
https://login.microsoftonline.com/consumers/v2.0/.well-known/openid-configuration

PsychApp redirect URI:
https://psychapp.bfab.io/api/oauth/callback/microsoft
```

## Microsoft Entra API permissions

In Microsoft Entra -> App registrations -> your app -> API permissions -> Microsoft Graph -> Delegated permissions, add:

```text
User.Read
Mail.Read
Files.Read.All
Calendars.Read
offline_access
openid
profile
email
```

Then save. For personal Microsoft accounts, user consent should normally be enough for these personal-compatible delegated permissions.

## Optional work/school scopes

For Microsoft 365 organizational accounts only, you may later add:

```text
Sites.Read.All
Team.ReadBasic.All
```

Do not add these first when debugging Outlook/Hotmail personal accounts. Start with the smaller personal-account scope set above.

## Google scope string

For Google OAuth credentials, use:

```text
openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/calendar.readonly
```

Google redirect URI:

```text
https://psychapp.bfab.io/api/oauth/callback/google
```

## Debugging PsychApp

Open:

```text
https://psychapp.bfab.io/api/debug/config
```

Check that OAuth config contains the scopes. Then start OAuth from PsychApp:

```text
https://psychapp.bfab.io/api/oauth/start/microsoft
```

After login:

```text
https://psychapp.bfab.io/api/oauth/status
```

The provider should show `connected: true` and a non-empty `scope` value.

## Common mistake

Do not put PsychApp's callback URL as the authorization URL or token URL.

Wrong:

```text
Authorization URL = https://psychapp.bfab.io/api/oauth/callback/microsoft
Token URL = https://psychapp.bfab.io/api/oauth/callback/microsoft
```

Correct:

```text
Authorization URL = https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize
Token URL = https://login.microsoftonline.com/consumers/oauth2/v2.0/token
Redirect URI = https://psychapp.bfab.io/api/oauth/callback/microsoft
```
