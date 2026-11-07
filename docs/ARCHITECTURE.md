# Architecture

```
Browser (React + Vite, same origin)
   │  HTTPS, HttpOnly session cookie + CSRF header
   ▼
Cloudflare Worker  ── src/worker/index.ts
   ├─ /api/*  → JSON API (router.ts, routes/*.ts)  — never returns HTML
   ├─ other   → static app (dist/client) with SPA fallback + security headers
   ├─ cron    → runMaintenance(): due sync jobs, abandoned-photo cleanup, pruning
   └─ queue   → optional SYNC_QUEUE consumer (job ids only)
        │
        ├─ D1  (DB)      businesses, staff, sessions, rates, quotes, audit, sync jobs
        ├─ R2  (PHOTOS)  b/<business>/photos/YYYY/MM/<id>.jpg, b/<business>/logo/<id>
        └─ Google APIs   Drive v3 + Sheets v4 with the owner's OAuth token
```

## Code map

| Path | What |
|---|---|
| `src/shared/calc.ts` | Buyback maths in integers (paise, milligrams, basis points). Used by browser preview and server. |
| `src/shared/time.ts` | IST helpers (Asia/Kolkata). |
| `src/shared/permissions.ts` | Roles, permissions, statuses. |
| `src/worker/context.ts` | Sessions, CSRF, staff unlock state, permission checks, rate limits, audit statements. |
| `src/worker/routes/*.ts` | API endpoints. |
| `src/worker/google/client.ts` | OAuth, Drive and Sheets HTTP calls; Google link parsing. |
| `src/worker/google/sync.ts` | Durable sync jobs. |
| `src/client/` | React app. |
| `migrations/` | D1 schema. |
| `test/` | Vitest tests running inside workerd with real local D1/R2 and a fake Google. |

## Key decisions

**Money and weights are integers.** Paise, milligrams, basis points; half-up rounding at each step: applicable rate = round(24K rate × karat / 24), assessed = round(net mg × rate / 1000), offer = round(assessed × bp / 10000). Purity is applied once, in `applicableRatePaise`. The browser shows a preview with the same code, but only the server's numbers are saved.

**Rates are versioned.** Every change inserts a `rate_versions` row. Quotes store `rate_version_id`, the 24K/999 base rate and the applied rate. A save is refused with `409 RATE_CHANGED` if the version the user saw is not the current one, or `409 OFFER_MISMATCH` if the offer they saw differs from the server's. The user reviews the new figures and saves again.

**Order numbers.** `order_counters(business_id, year)` is upserted and the quote inserted in the **same D1 batch** (a transaction), so numbers are unique per business per IST year with no gaps from failed saves. The format is `printf('%02d-%04d')`, which grows past 4 digits.

**Photos and the D1/R2 gap.** D1 and R2 do not share transactions, so the photo upload is a 3-step state machine: insert `photos(state='uploading')` → put to R2 → mark `pending`. The quote batch attaches the photo (`state='attached'`, and `quotes.photo_id` is `UNIQUE`). Cleanup deletes only `uploading`/`pending` rows older than 6 hours, with a conditional `DELETE … WHERE state IN (…) AND NOT EXISTS (quote)`, and removes the R2 object only if that delete succeeded. Attached photos are never touched. A quote is reported saved only after the batch commits.

**Duplicate submissions.** Each form has an idempotency key (UUID). `UNIQUE(business_id, idempotency_key)` makes a repeated or concurrent submit return the same quote.

**Two-level auth.** The business session (owner email + password) is an HttpOnly cookie, stored as a SHA-256 hash in `sessions`. A staff profile is "unlocked" on that session with a PIN. `staff.session_epoch` is copied into the session; disabling, PIN reset or "sign out everywhere" bumps the epoch, so that profile locks on every device. Idle profiles lock after `profile_lock_minutes`. Passwords, PINs and recovery codes are PBKDF2-SHA256 (100k) over an HMAC with the `AUTH_PEPPER` secret, so a leaked database cannot be brute-forced offline without the pepper. Sensitive owner actions need the password re-entered within 10 minutes (`reauth_at`).

**CSRF.** SameSite=Lax cookies + a per-session CSRF token in `X-CSRF-Token` on every change, plus a cross-origin `Origin` refusal. Pre-session endpoints accept only `application/json`. Lax (not Strict) is needed so the Google OAuth redirect back to `/api/google/callback` carries the cookie.

**Business isolation.** Every business-owned table has `business_id`, and every query filters by the session's business. R2 keys are prefixed `b/<business_id>/`. Sync jobs load the quote and connection by the job's `business_id`. Tests cover cross-business access to quotes, photos, staff and actions.

**Google sync.** Jobs (`sync_jobs`, one per quote per destination) are inserted in the same D1 transaction as the quote, so no save can be missed. They are run by (a) the request's `waitUntil` or a Queue message with just the job id, and (b) the cron every 10 minutes for anything due. A job is leased with a conditional update before running. Duplicates are prevented by the stored Drive file id + an `appProperties.swarnaRecord` tag (searched before uploading), and for Sheets by the immutable record-id column plus a per-business sheet lock. Retries use exponential backoff up to 8 attempts. Permission or not-found errors fail immediately for the owner to fix. `invalid_grant` marks the connection "reconnect required" and pauses jobs. Delivery is at-least-once with duplicate prevention, **not** exactly-once.

**Tokens.** Refresh and access tokens are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`, bound to the business id. They are never returned by the API, logged, or put in queue messages. OAuth uses `state` (single use, 10 minutes, bound to the session and owner profile) and PKCE S256.

**Same origin.** `run_worker_first: true`, so the Worker handles every request: `/api/*` is always JSON, unknown asset files are real 404s, everything else gets the SPA (direct navigation and refresh work). The Worker adds CSP, HSTS, frame and referrer headers, and redirects the bare domain to `www`.

## Environments

| | Worker | D1 | R2 | Domain |
|---|---|---|---|---|
| local | `swarna-live-local` (wrangler dev) | local file | local | localhost:8787 |
| staging | `swarna-live-staging` | `swarna-live-staging` | `swarna-live-photos-staging` | workers.dev |
| production | `swarna-live` | `swarna-live-production` | `swarna-live-photos-production` | www.swarnalive.com |

## Adding a migration

Create `migrations/0002_<name>.sql`. Never edit an applied migration. Run `npm run db:migrate:local`, test, then apply to staging and production (DEPLOYMENT.md step 7).
