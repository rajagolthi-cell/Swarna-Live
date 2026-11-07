# Deploying Swarna Live to www.swarnalive.com

These steps use your own computer with Node.js 22 and a Cloudflare account that already manages the `swarnalive.com` zone.

> **Verification note.** These commands match Wrangler 4.158 (bundled in this repo) and its configuration schema. Cloudflare's documentation site could not be opened while this was written, so the **dashboard menu names** below (Workers Builds, Custom domains, Time Travel) are from memory. Check them against the dashboard as you go.

Placeholders like `<PRODUCTION_D1_DATABASE_ID>` must be replaced with your real values. Never commit secrets.

---

## 1. Install dependencies

```bash
npm install
```

## 2. Sign Wrangler in to your Cloudflare account

```bash
npx wrangler login
```
```bash
npx wrangler whoami
```

`whoami` should show the account that owns `swarnalive.com`. If you have several accounts, add `"account_id": "<YOUR_ACCOUNT_ID>"` at the top of `wrangler.jsonc`.

## 3. Create the D1 databases (production and staging)

```bash
npx wrangler d1 create swarna-live-production --location apac
```
```bash
npx wrangler d1 create swarna-live-staging --location apac
```

Each command prints a `database_id`. Put them in `wrangler.jsonc`:
- top-level `d1_databases[0].database_id`: production
- `env.staging.d1_databases[0].database_id`: staging

Database IDs are not secret and can be committed.

## 4. Create the private R2 buckets

```bash
npx wrangler r2 bucket create swarna-live-photos-production --location apac
```
```bash
npx wrangler r2 bucket create swarna-live-photos-staging --location apac
```

New buckets are private. **Do not** enable the public `r2.dev` URL or attach a custom domain to these buckets. Photos are only served through the Worker after a permission check.

## 5. Queues (optional)

Swarna Live works without Queues: Google backups run right after each save, and a cron job every 10 minutes catches anything missed. To also use Cloudflare Queues (check that your plan includes Queues):

```bash
npx wrangler queues create swarna-live-sync-production
```
```bash
npx wrangler queues create swarna-live-sync-dlq-production
```

Then uncomment the `queues` block in `wrangler.jsonc`. Repeat with `-staging` names and an `env.staging.queues` block if you want queues in staging.

## 6. Bindings and secrets

The bindings (`DB`, `PHOTOS`, `ASSETS`, optional `SYNC_QUEUE`) are already in `wrangler.jsonc`. Generate random values for the secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Set each production secret (paste the value when asked):

```bash
npx wrangler secret put AUTH_PEPPER
```
```bash
npx wrangler secret put SETUP_TOKEN
```
```bash
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

Optional:

```bash
npx wrangler secret put PLATFORM_ADMIN_TOKEN
```
```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```
```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Repeat with `--env staging` for staging, using **different** values. Notes:
- `AUTH_PEPPER` is mixed into every password, PIN and recovery-code hash. **If you lose or change it, nobody can sign in.** Store a copy in a password manager.
- `TOKEN_ENCRYPTION_KEY` encrypts Google tokens. If you change it, the owner must reconnect Google.
- If secrets are added before the Worker's first deploy, Wrangler may say the Worker does not exist yet. Do step 11 first, then come back.

## 7. Apply database migrations

Local (your computer only):

```bash
npm run db:migrate:local
```

Staging and production (Cloudflare):

```bash
npm run db:migrate:staging
```
```bash
npm run db:migrate:production
```

## 8. Run locally

Create `.dev.vars` from `.dev.vars.example` and fill in random values, then:

```bash
npm run dev
```

Open http://localhost:8787. Local mode uses its own local D1 and R2 (in `.wrangler/`) and plain-HTTP cookies (`COOKIE_SECURE=false`). To start over, run `bash scripts/reset-local.sh`.

For faster frontend work, run `npm run dev:ui` in a second terminal and open http://localhost:5173. It forwards `/api` to `wrangler dev`.

## 9. Run tests

```bash
npm test
```
```bash
npm run typecheck
```

Optional browser walkthrough against a running `npm run dev` (needs Playwright installed separately):

```bash
BASE_URL=http://localhost:8787 SETUP_TOKEN=<your local token> node scripts/ui-check.mjs
```

## 10. Production build

```bash
npm run build
```

This type-checks everything and builds the React app into `dist/client`, which the Worker serves.

## 11. Deploy the Worker

**Before the first production deploy, check the domain.** `wrangler.jsonc` attaches the Worker as a Custom Domain to `www.swarnalive.com` and `swarnalive.com`. In the Cloudflare dashboard → `swarnalive.com` → DNS → Records, look for existing `A`, `AAAA` or `CNAME` records on `swarnalive.com` (`@`) and `www`:
- If they point at something you still use (an old website, a parking page), **stop** and decide first. Deploying will fail, or you will have to remove those records, and that replaces whatever is there now.
- If they are unused, delete them only after confirming nothing depends on them. MX/TXT records (email) are not affected.

Then deploy staging first:

```bash
npm run deploy:staging
```

Then production:

```bash
npm run deploy:production
```

## 12. Secure first-owner setup

1. Open https://www.swarnalive.com. With no business yet, it shows **Set up Swarna Live**.
2. Enter the `SETUP_TOKEN` value, the business name, your name, the owner email, a password (10+ characters) and a 6-digit PIN.
3. **Save the 10 recovery codes.** They are shown only once.
4. Set the gold and silver rates (Settings → Rates).
5. Remove the setup token so it can never be used again:
   ```bash
   npx wrangler secret delete SETUP_TOKEN
   ```

Setup also refuses to run once any business exists.

## 13. Connect GitHub to Workers Builds

1. Push this repository to GitHub (`main` = production).
2. Cloudflare dashboard → Workers & Pages → `swarna-live` → Settings → Build → **Connect** to the GitHub repo.
3. Build settings for the **production** Worker:
   - Production branch: `main`
   - Build command: `npm run build`
   - Deploy command: `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`
   - **Builds for non-production branches: turn OFF** (or set its command to `npm run build` only). The default non-production command uploads a preview *version of the production Worker*, which would use the **production** database and bucket.
4. Root directory: `/`. Node version comes from `.node-version` (22).

The build's API token needs permission to apply D1 migrations. If the migration step fails with an authentication error, remove `npx wrangler d1 migrations apply ...` from the deploy command and run step 7 by hand before merging.

## 14. Keep preview and production separate

- **Staging Worker** (`swarna-live-staging`): its own D1 database, its own R2 bucket, its own secrets, a `workers.dev` URL, and **no routes** on swarnalive.com.
- Create a second Worker connected to the same repo for staging (dashboard: Create → Import a repository). Use:
  - Branch: `staging`
  - Build command: `npm run build`
  - Deploy command: `npx wrangler d1 migrations apply DB --remote --env staging && npx wrangler deploy --env staging`
  - Non-production branch command (pull requests): `npx wrangler versions upload --env staging`
- Pull-request builds then only touch staging resources. Set `APP_ORIGIN` in `env.staging.vars` to the staging URL.
- The `.github/workflows/ci.yml` workflow runs type-checks, tests and the build on every push and pull request. It uses no Cloudflare credentials.

If Workers Builds says the Worker name does not match, check that the staging Worker is named exactly `swarna-live-staging`.

## 15. Connect swarnalive.com and www.swarnalive.com

`wrangler deploy` creates both custom domains from `routes` in `wrangler.jsonc`. Cloudflare creates the DNS records and the certificate. Check them in the dashboard → Workers & Pages → `swarna-live` → Settings → Domains & Routes.

## 16. HTTPS and the canonical hostname

- The canonical address is **https://www.swarnalive.com** (`APP_ORIGIN`). Requests to `swarnalive.com` are redirected to it with a 301 by the Worker (`REDIRECT_HOSTS`).
- In SSL/TLS settings, use **Full (strict)** and turn on **Always Use HTTPS**. The Worker sends `Strict-Transport-Security`.
- Sign-in cookies are `Secure`, `HttpOnly` and `__Host-` prefixed in production.

## 17. Google OAuth, Drive and Sheets

Follow [GOOGLE_SETUP.md](GOOGLE_SETUP.md). Then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (step 6) and redeploy.

## 18. Test the owner's backup destinations

1. Sign in as owner → Settings → Backups & Integrations → **Connect Google Account**.
2. **Create a backup folder for me** → paste a Google Sheets link → **Check links** → choose "Create a new worksheet" → tick the confirmation → **Save Destinations**.
3. **Test Connection**. All three checks should be green.
4. Save one test estimate. Within a minute, Settings → Backups should show it as Synced. Check that the photo is in Drive under `year/month` and the row is in the new worksheet.

## 19. Back up and restore

See [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

## Plan notes

- Password and PIN checks use PBKDF2 (100,000 rounds). This takes noticeably more CPU than a free-plan Worker's small CPU allowance per request. **Workers Paid is recommended.** On the free plan, sign-ins may fail with "exceeded CPU" errors. This was not measured on Cloudflare.
- Cron triggers, D1, R2 and Workers Builds are used. Queues are optional.
