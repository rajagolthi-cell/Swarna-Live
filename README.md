# Swarna Live

Jewellery buyback estimates for gold and silver shops. Staff weigh the item, take a photo of the jewellery with the scale reading, and Swarna Live works out an estimated offer using the **rates the business enters by hand**. There are no live prices.

Runs entirely on **Cloudflare** (Workers, D1 database, private R2 photo storage). The code lives on **GitHub**. If the owner chooses, copies go to their own **Google Drive and Google Sheets**.

> Estimates are not payments. Swarna Live never records or processes money.

## What it does

- **Two-step sign-in.** First the owner's business email and password, then each person picks their profile and enters a 6-digit PIN. Profiles lock automatically when idle.
- **Roles.** Owner (everything), Admin (only what the owner allows), Employee (create quotes, see their own).
- **New Buyback.** Customer, metal and purity, weights, buyback %, and a **required photo** taken with the phone or iPad camera. A caption strip with the reference, weights, purity and IST time is added to the photo. The offer is calculated on the server; if a rate changed while the quote was being filled in, Swarna Live asks you to review the new offer before saving.
- **Transactions.** Search, date and status filters, page-by-page lists, detail with photo, printable estimate receipt, CSV export, full history of every change.
- **Settings.** Business details and logo, manual gold (24K) and silver (999) rates with history, default buyback % and staff limits, session and profile-lock times, recovery codes, Google backups.
- **Google backup (optional).** The owner connects a Google account. Each saved estimate's photo is copied to a Drive folder (year/month), and a row is written to a dedicated worksheet. Cloudflare stays the main record.
- **Several businesses.** Each business has its own owner, staff, rates, order numbers (`YY-NNNN`, restarting each year in IST), photos and Google connection.

## Quick start (local)

```bash
npm install
```
```bash
cp .dev.vars.example .dev.vars   # then put random values in it
```
```bash
npm run db:migrate:local
```
```bash
npm run dev                      # builds the app and serves http://localhost:8787
```

Open http://localhost:8787, enter the `SETUP_TOKEN` from `.dev.vars`, and create the owner.

```bash
npm test                         # 65 automated tests in the Workers runtime
```

## Documentation

| Guide | For |
|---|---|
| [docs/OWNER_GUIDE.md](docs/OWNER_GUIDE.md) | Shop owners and staff, in simple English |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Putting it on www.swarnalive.com, step by step |
| [docs/GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md) | Creating the Google OAuth client for Drive/Sheets backups |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it is built and why |
| [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) | Backing up and restoring the database and photos |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Adding more businesses, rotating secrets |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | When something goes wrong |

## Where things live

- **GitHub**: code only. Never commit `.dev.vars`, database exports or photos (they are in `.gitignore`).
- **Cloudflare**: all business records (D1) and photos/logos (private R2). Secrets are Cloudflare secrets.
- **Google** (optional): copies the owner chose to make.
