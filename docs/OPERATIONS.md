# Operations (platform administrator)

## Adding another business

Additional businesses are created through an authenticated admin API. Nobody can create a business from the public website.

1. Set a long random admin token (once):
   ```bash
   npx wrangler secret put PLATFORM_ADMIN_TOKEN
   ```
   The API is disabled (404) unless this secret is set and at least 32 characters long. Failed attempts are rate-limited.
2. Create the business and a one-time invitation for its owner:
   ```bash
   curl -sS -X POST https://www.swarnalive.com/api/admin/businesses \
     -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" -H "Content-Type: application/json" \
     -d '{"name":"Another Jewellers","owner_email":"owner@another.example"}'
   ```
   The response contains `invite_url` (valid 7 days, works once). Send it to the owner privately. The token is after `#`, so it never reaches server logs.
3. The owner opens the link, sets their name, password and PIN, and saves their recovery codes.

Other admin calls (same `Authorization` header):

List businesses:
```bash
curl -sS https://www.swarnalive.com/api/admin/businesses -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN"
```

Disable a business (also signs everyone out):
```bash
curl -sS -X POST https://www.swarnalive.com/api/admin/businesses/<business_id>/disable -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN"
```

Enable it again:
```bash
curl -sS -X POST https://www.swarnalive.com/api/admin/businesses/<business_id>/enable -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN"
```

Remove the admin secret when you are not provisioning:
```bash
npx wrangler secret delete PLATFORM_ADMIN_TOKEN
```

## Rotating secrets

| Secret | Effect of changing it |
|---|---|
| `AUTH_PEPPER` | **All passwords, PINs and recovery codes stop working.** Only change it as part of a planned reset. |
| `TOKEN_ENCRYPTION_KEY` | Stored Google tokens cannot be decrypted. Owners must reconnect Google. |
| `GOOGLE_CLIENT_SECRET` | Rotate in Google Cloud, then update the secret. Existing refresh tokens keep working. |
| `SETUP_TOKEN` | Only used for the very first owner. Delete it after setup. |
| `PLATFORM_ADMIN_TOKEN` | Change any time. |

## Logs

Workers observability is enabled. The code never logs passwords, PINs, recovery codes, session tokens, Google tokens, customer details or photos. Unexpected errors log only the error type and message.

## Health check

`GET https://www.swarnalive.com/api/health` returns `{status, service, environment, database, time}`. It does not reveal secrets.
