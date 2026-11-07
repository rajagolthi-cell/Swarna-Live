# Swarna Live

A private web app for keeping loan records: customers, their contact and identity details, loans (including pledged gold), and payments.

## Features

- **Login protected.** The first person to open the site creates the admin account. You can add more staff accounts under Settings.
- **Customers.** Name, father/husband name, phone and alternate phone, email, date of birth, address, and two ID proofs (Aadhaar, PAN, Voter ID, Driving Licence, Passport, Ration Card…). ID numbers are hidden (`••••••••1234`) unless you click **Show**.
- **Loans.** Amount, interest rate (% per month), loan date, due date, and pledged items: type, gold weight in grams, purity and a description. Each loan gets a number like `SL-2026-0001`.
- **Payments.** Record each payment with its date, mode (Cash/UPI/Bank/Cheque) and a note. Balances update straight away.
- **Dashboard.** Total amount lent out, interest due, total receivable, gold held, money collected this month, overdue loans and recent payments.
- **Search** customers by name, phone or ID number, and loans by customer, phone or loan number. You can filter loans by active, overdue or closed.
- **Uploads.** Attach photos or PDFs of ID proofs (Aadhaar front/back, PAN, customer photo) to a customer, and photos of the pledged gold to a loan.
- **Backup.** Settings → Download backup saves all records as a JSON file (uploaded files stay in storage).
- Works on phones, has a dark mode, and loan pages can be printed.

### How interest is worked out

Simple interest at the monthly rate, counted daily on the principal still owed (a month is 30 days). A payment pays off interest due first, then principal. Interest stops when a loan is closed.

Example: ₹10,000 at 2% per month for 30 days earns ₹200 interest.

## How it is built

| Part | On Cloudflare (swarnalive.com) | On your own computer |
|------|--------------------------------|----------------------|
| Code | Cloudflare Worker (`src/worker.js`) | Node.js (`server.js`) |
| Records database | **D1** database `swarna-live-db` | SQLite file `data/swarna.db` |
| Uploaded ID scans & gold photos | **R2** bucket `swarna-live-files` | Folder `data/files/` |
| Web pages | Workers Static Assets (`public/`) | Served by `server.js` |

Both use the same app code (`src/app.js`) and the same database tables (`migrations/`).

## Putting it on swarnalive.com (Cloudflare)

1. **Create an API token.** In the Cloudflare dashboard go to *My Profile → API Tokens → Create Token → Create Custom Token* and give it:
   - Account → **Workers Scripts** → Edit
   - Account → **D1** → Edit
   - Account → **Workers R2 Storage** → Edit
   - Account → **Account Settings** → Read
   - Zone → **Workers Routes** → Edit (Zone Resources: `swarnalive.com`)
   - Zone → **DNS** → Edit (Zone Resources: `swarnalive.com`)
   - Zone → **Zone** → Read
2. **Run the setup** (installs everything and deploys):
   ```bash
   npm install
   CLOUDFLARE_API_TOKEN=your-token npm run cf:setup
   ```
   This creates the D1 database and R2 bucket, creates the tables, deploys the Worker to `swarnalive.com` and `www.swarnalive.com`, and prints a **setup code**. Save it somewhere safe.
3. Open https://swarnalive.com, enter the setup code and create your admin account. The setup code works only once, for the very first account.

To publish later changes: `npm run cf:deploy`.

If `swarnalive.com` already has a DNS record (for example from a parking page), Cloudflare will refuse to attach the Worker. Delete the old `A`/`AAAA`/`CNAME` records for `swarnalive.com` and `www` under *DNS → Records*, then run the setup again.

**Backups on Cloudflare:** D1 keeps 30 days of automatic point-in-time history (*D1 → swarna-live-db → Time Travel*). You can also use *Settings → Download backup* in the app.

## Running it on your own computer

You need [Node.js](https://nodejs.org) version 22.5 or newer.

```bash
npm install
npm start
```

Then open http://127.0.0.1:3000 and create your admin account.

| Variable        | Default          | Meaning                                                     |
|-----------------|------------------|-------------------------------------------------------------|
| `PORT`          | `3000`           | Port to listen on                                           |
| `HOST`          | `127.0.0.1`      | Use `0.0.0.0` to let other devices on your network reach it |
| `SWARNA_DATA`   | `data`           | Folder for the database and uploaded files                  |
| `SETUP_CODE`    | none             | If set, creating the first account requires this code       |
| `COOKIE_SECURE` | off              | Set to `1` when the site is served over HTTPS               |

`npm run cf:dev` runs the Cloudflare version locally instead (needs a `.dev.vars` file containing `SETUP_CODE="any-code"`).

Run the tests with `npm test`.

## Keeping the data safe

This app stores personal and identity details, so:

- When running on your own computer, **back up the `data/` folder regularly**. If it is lost, the records are gone.
- The `data/` folder is in `.gitignore`. **Never commit the database or a backup file to GitHub.**
- On Cloudflare the site is always HTTPS. For extra protection you can put it behind **Cloudflare Access** (Zero Trust → Access → Applications) so only your staff's email addresses can even see the login page.
- Use strong passwords and give each staff member their own account.
- Check your local rules on storing ID numbers. In India, the Aadhaar rules limit storing full Aadhaar numbers, and many lenders keep only the last 4 digits or a masked copy.
